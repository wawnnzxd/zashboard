import {
  disconnectByIdAPI,
  fetchConnectionsAPI,
  getConnectionVisibleSearchValues,
} from '@/assembly/connections'
import { CONNECTION_TAB_TYPE, SORT_DIRECTION, SORT_TYPE } from '@/constant'
import {
  getChainsStringFromConnection,
  getConnectionChains,
  getConnectionDownload,
  getConnectionNetwork,
  getConnectionRule,
  getConnectionSourceIP,
  getConnectionStart,
  getConnectionUpload,
  getHostFromConnection,
  getInboundUserFromConnection,
  getNetworkTypeFromConnection,
} from '@/helper'
import { toSearchRegex } from '@/helper/search'
import { useStorage } from '@/helper/storage'
import type { Connection } from '@/types'
import { watchOnce } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, ref, shallowRef, watch } from 'vue'
import { initAggregatedDataMap, saveConnectionHistory } from './connHistory'
import {
  autoDisconnectIdleUDP,
  autoDisconnectIdleUDPTime,
  connectionCardLines,
  connectionTableColumns,
  isConnectionCard,
  proxyChainDirection,
  showFullProxyChain,
} from './settings'

export const connectionTabShow = ref(CONNECTION_TAB_TYPE.ACTIVE)
export const connectionSortType = useStorage<SORT_TYPE>(
  'config/connection-sort-type',
  SORT_TYPE.HOST,
)
export const connectionSortDirection = useStorage<SORT_DIRECTION>(
  'config/connection-sort-direction',
  SORT_DIRECTION.ASC,
)

export const quickFilterRegex = useStorage<string>('config/quick-filter-regex', 'direct|dns-out')
export const quickFilterEnabled = useStorage<boolean>('config/quick-filter-enabled', false)
export const connectionFilter = ref('')
export const sourceIPFilter = ref<string[] | null>(null)

// 每拍整体换引用、元素不可变的管道:深 ref 会为每拍数千个一次性对象建 Proxy 与依赖记录,
// shallowRef 才是与该数据流语义吻合的粒度。
export const activeConnections = shallowRef<Connection[]>([])
export const closedConnections = shallowRef<Connection[]>([])
export const isPaused = ref(false)

// 暂停 = 显示层的一张快照,不是数据管道上的闸门。
//
// 原实现把 `if (isPaused) return` 卡在 WS 的 watch 最上游,于是 activeConnections 的不变量
// 变成了「这可能是任意时刻的旧快照」,而这条知识扩散到了五个互不相干的消费者:
// 暂停期间关闭的连接**永久丢失**(closed 是一次性增量,既不进已关闭列表也不进历史库);
// 代理页每个组头的实时速率静默冻结;概览页连接数折线以暂停瞬间的值画出一条**假的水平直线**
// (看起来完全正常,最具误导性)。
//
// 现在源头永远最新,只有「连接页看到的那份列表」被冻住:frozen 一存就是同一时刻的 active + closed,
// 所以「全部」tab 下两个数组不相交是结构保证,而不是靠人推理。
const frozenConnections = shallowRef<{ active: Connection[]; closed: Connection[] } | null>(null)

watch(isPaused, (paused) => {
  frozenConnections.value = paused
    ? { active: activeConnections.value, closed: closedConnections.value }
    : null
})

const displayedActive = computed(() => frozenConnections.value?.active ?? activeConnections.value)
const displayedClosed = computed(() => frozenConnections.value?.closed ?? closedConnections.value)

// 内核自启动的上/下行总量。clash 随连接 WS 消息携带,在下方快照 watch 写入;
export const downloadTotal = ref(0)
export const uploadTotal = ref(0)

let cancel: (() => void) | undefined

export const initConnections = () => {
  stopConnections()
  // 暂停是「这一次浏览」的状态,不是跨会话的偏好:切后端/编辑后端/401 重登后若不复位,
  // 新会话的每一拍都会被旧的暂停态挡在门外,连接页永远空列表、用户以为新后端挂了。
  isPaused.value = false
  frozenConnections.value = null
  initAggregatedDataMap()
  // active(已带瞬时速率)与 closed(本拍新关闭增量)均由各后端 assembly 算好,store 只消费。
  const ws = fetchConnectionsAPI()
  const unwatch = watch(ws.data, (snapshot) => {
    if (!snapshot) return

    if (snapshot.downloadTotal != null && snapshot.uploadTotal != null) {
      downloadTotal.value = snapshot.downloadTotal
      uploadTotal.value = snapshot.uploadTotal
    }

    // 注意:这里**不再**判 isPaused —— 冻结发生在下方的显示层。
    // 源头是唯一不能跳过的地方:它承载 closed 增量与历史归集,跳过就是永久数据丢失。
    activeConnections.value = snapshot.active

    if (snapshot.closed.length > 0) {
      closedConnections.value = closedConnections.value.concat(snapshot.closed).slice(-500)
      saveConnectionHistory(snapshot.closed)
    }
  })

  let unwatchIdleUDP: (() => void) | undefined

  if (autoDisconnectIdleUDP.value) {
    unwatchIdleUDP = watchOnce(activeConnections, () => {
      activeConnections.value
        .filter((conn) => getConnectionNetwork(conn) !== 'tcp')
        .forEach((conn) => {
          const now = dayjs()
          const start = dayjs(getConnectionStart(conn))

          if (now.diff(start, 'minute') > autoDisconnectIdleUDPTime.value) {
            // 后台自动清理,不是用户点的,失败不打扰
            disconnectByIdAPI(conn.id).catch(() => {})
          }
        })
    })
  }

  cancel = () => {
    unwatch()
    // watchOnce 若一直没触发就会滞留到下一个会话:上一个后端武装的「一次性空闲 UDP 清理」
    // 会在新后端的首拍触发,对新后端的连接成批发 DELETE。连切 N 次就有 N 个同拍触发。
    unwatchIdleUDP?.()
    ws.close()
  }
}

// 结束连接流并丢弃数据。两件事必须一起做:展示层的字段访问器按「当前后端」路由
// (assembly/connections),连接原始形状由 clash 实现决定。
// 上一个后端的连接只要活过后端切换的那一帧,就会被新后端的访问器读取 —— 取到
// undefined 后渲染函数直接抛错,表格的 vnode 树就此损坏,之后新后端的数据正常
// 流入也不再重绘,只能刷新页面。所以清空要与切换同步发生,不能等新流建起来。
export const stopConnections = () => {
  cancel?.()
  cancel = undefined
  activeConnections.value = []
  closedConnections.value = []
  downloadTotal.value = 0
  uploadTotal.value = 0
}

const isDesc = computed(() => {
  return connectionSortDirection.value === SORT_DIRECTION.DESC
})

// 排序键提取器:每条连接每拍只算一次键,替代在 O(N log N) 次比较里反复构串/建 dayjs。
const sortKeyFunctionMap: Record<SORT_TYPE, (connection: Connection) => string | number> = {
  [SORT_TYPE.HOST]: getHostFromConnection,
  [SORT_TYPE.RULE]: getConnectionRule,
  [SORT_TYPE.CHAINS]: getChainsStringFromConnection,
  [SORT_TYPE.DOWNLOAD]: getConnectionDownload,
  [SORT_TYPE.DOWNLOAD_SPEED]: (connection) => connection.downloadSpeed,
  [SORT_TYPE.UPLOAD]: getConnectionUpload,
  [SORT_TYPE.UPLOAD_SPEED]: (connection) => connection.uploadSpeed,
  [SORT_TYPE.SOURCE_IP]: getConnectionSourceIP,
  [SORT_TYPE.TYPE]: getNetworkTypeFromConnection,
  [SORT_TYPE.CONNECT_TIME]: (connection) => {
    // clash 的 start 是 ISO 串
    const start = getConnectionStart(connection)

    if (typeof start === 'number') {
      return start
    }
    const parsed = Date.parse(start)

    return Number.isNaN(parsed) ? 0 : parsed
  },
  [SORT_TYPE.INBOUND_USER]: getInboundUserFromConnection,
}

// 连接页看到的那份列表:走显示层(暂停时是冻结快照,否则就是最新值)。
// 组头速率、概览曲线等其余消费者直接读 activeConnections,因此不受暂停影响。
export const connections = computed(() => {
  switch (connectionTabShow.value) {
    case CONNECTION_TAB_TYPE.ACTIVE:
      return displayedActive.value
    case CONNECTION_TAB_TYPE.CLOSED:
      return displayedClosed.value
    // 全部:两个数组天然不相交(closed 是「上一拍存在、这一拍消失」的连接),无需去重;
    // 冻结时两者取自同一时刻,不相交因此是结构保证而非人工推理。
    default:
      return displayedClosed.value.concat(displayedActive.value)
  }
})

// 各代理组/节点的实时速率聚合:每拍一次 O(连接数×链长) 构建,消费方 O(1) 查表 ——
// 替代每个组头各自每秒全量过滤 activeConnections(几十组 × 每秒几十万次数组操作)。
export const chainTrafficMap = computed(() => {
  const map = new Map<string, { download: number; upload: number }>()

  for (const conn of activeConnections.value) {
    for (const name of getConnectionChains(conn)) {
      let entry = map.get(name)

      if (!entry) {
        entry = { download: 0, upload: 0 }
        map.set(name, entry)
      }
      entry.download += conn.downloadSpeed
      entry.upload += conn.uploadSpeed
    }
  }

  return map
})

// 与列表同源(冻结时用冻结的那份):否则暂停期间新关闭的连接会让画面上某一行
// 突然被判成「已关闭」而淡化,与冻结语义矛盾。
const closedConnectionIds = computed(() => new Set(displayedClosed.value.map((conn) => conn.id)))

// 「已关闭」与「全部」两个 tab 下都用它判定单条连接是否已断,以决定关闭按钮与淡化样式。
export const isClosedConnection = (connection: Connection) =>
  closedConnectionIds.value.has(connection.id)

const filterConnections = (items: readonly Connection[]) => {
  const searchRegex = toSearchRegex(connectionFilter.value)
  const hideRegex = quickFilterEnabled.value ? toSearchRegex(quickFilterRegex.value) : null
  const sourceIPs = sourceIPFilter.value
  // 无正则过滤时跳过搜索串构建:那是每拍每连接十余次字符串/dayjs 分配的大头
  const needSearchValues = Boolean(searchRegex || hideRegex)
  const displayOptions = {
    mode: isConnectionCard.value ? ('card' as const) : ('table' as const),
    proxyChainDirection: proxyChainDirection.value,
    showFullProxyChain: showFullProxyChain.value,
  }
  const visibleKeys = isConnectionCard.value
    ? connectionCardLines.value.flat()
    : connectionTableColumns.value

  return items.filter((conn) => {
    if (sourceIPs !== null && sourceIPs.every((i) => i !== getConnectionSourceIP(conn))) {
      return false
    }

    if (!needSearchValues) {
      return true
    }

    const visibleValues = getConnectionVisibleSearchValues(conn, visibleKeys, displayOptions)

    if (hideRegex?.testAny(visibleValues)) {
      return false
    }

    if (searchRegex) {
      return searchRegex.testAny(visibleValues)
    }

    return true
  })
}

// Overview visualizations only represent live traffic, but should still honor the same filters as
// the connections view. Keep this separate from `renderConnections`, whose source depends on the
// selected active/closed/all tab.
export const filteredActiveConnections = computed(() => filterConnections(activeConnections.value))

export const renderConnections = computed(() => {
  const filtered = filterConnections(connections.value)

  const sortType = isConnectionCard.value ? connectionSortType.value : SORT_TYPE.HOST
  const getSortKey = sortKeyFunctionMap[sortType]
  const desc = isConnectionCard.value && isDesc.value
  const decorated: [string | number, string, Connection][] = filtered.map((conn) => [
    getSortKey(conn),
    conn.id,
    conn,
  ])

  decorated.sort((x, y) => {
    // desc 连同 id tie-break 一起反转,与原比较器语义一致
    const a = desc ? y : x
    const b = desc ? x : y
    const keyA = a[0]
    const keyB = b[0]
    let result = 0

    if (typeof keyA === 'number') {
      result = keyA - (keyB as number)
    } else if (keyA < (keyB as string)) {
      result = -1
    } else if (keyA > (keyB as string)) {
      result = 1
    }

    if (result === 0) {
      result = a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
    }

    return result
  })

  return decorated.map((item) => item[2])
})
