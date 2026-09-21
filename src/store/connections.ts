import {
  activeConnections,
  closedConnections,
  getConnectionVisibleSearchValues,
  isPaused,
} from '@/assembly/connections'
import { useStorage } from '@/composables/use-storage'
import {
  CONNECTION_SEARCHABLE_KEYS,
  CONNECTION_TAB_TYPE,
  SORT_DIRECTION,
  SORT_TYPE,
  isConnectionGroupableKey,
  type ConnectionGroupableKey,
} from '@/constant'
import {
  getChainsStringFromConnection,
  getConnectionDownload,
  getConnectionRule,
  getConnectionSourceIP,
  getConnectionStart,
  getConnectionUpload,
  getHostFromConnection,
  getInboundUserFromConnection,
  getNetworkTypeFromConnection,
} from '@/helper'
import { toSearchRegex } from '@/helper/search'
import type { Connection } from '@/types'
import { computed, ref, shallowRef, watch } from 'vue'
import {
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

export const connectionCardGroupKey = useStorage<ConnectionGroupableKey | null>(
  'config/connection-card-group-key',
  null,
)

if (
  connectionCardGroupKey.value !== null &&
  !isConnectionGroupableKey(connectionCardGroupKey.value)
) {
  connectionCardGroupKey.value = null
}

export const quickFilterRegex = useStorage<string>('config/quick-filter-regex', 'direct|dns-out')
export const quickFilterEnabled = useStorage<boolean>('config/quick-filter-enabled', false)
export const connectionFilter = ref('')
export const searchHiddenColumns = useStorage<boolean>('config/search-hidden-columns', false)
export const sourceIPFilter = ref<string[] | null>(null)

// 暂停 = 显示层的一张快照,不是数据管道上的闸门。
//
// 上游把 `if (isPaused) return` 卡在 WS 的 watch 最上游(assembly/connections),于是
// activeConnections 的不变量变成了「这可能是任意时刻的旧快照」,而这条知识扩散到了五个互不相干
// 的消费者:暂停期间关闭的连接**永久丢失**(closed 是一次性增量,既不进已关闭列表也不进历史库);
// 代理页每个组头的实时速率静默冻结;概览页连接数折线以暂停瞬间的值画出一条**假的水平直线**
// (看起来完全正常,最具误导性)。
//
// 我们这里源头永远最新,只有「连接页看到的那份列表」被冻住:frozen 一存就是同一时刻的
// active + closed,所以「全部」tab 下两个数组不相交是结构保证,而不是靠人推理。
const frozenConnections = shallowRef<{ active: Connection[]; closed: Connection[] } | null>(null)

// sync:initConnections 复位 isPaused 的同一刻就要把旧后端的快照放掉,不能等到下一次 flush
watch(
  isPaused,
  (paused) => {
    frozenConnections.value = paused
      ? { active: activeConnections.value, closed: closedConnections.value }
      : null
  },
  { flush: 'sync' },
)

const displayedActive = computed(() => frozenConnections.value?.active ?? activeConnections.value)
const displayedClosed = computed(() => frozenConnections.value?.closed ?? closedConnections.value)

const isDesc = computed(() => {
  return connectionSortDirection.value === SORT_DIRECTION.DESC
})

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

// 与列表同源(冻结时用冻结的那份):否则暂停期间新关闭的连接会让画面上某一行
// 突然被判成「已关闭」而淡化,与冻结语义矛盾。
const closedConnectionIds = computed(() => new Set(displayedClosed.value.map((conn) => conn.id)))

export const isClosedConnection = (connection: Connection) =>
  closedConnectionIds.value.has(connection.id)

const filterConnections = (items: readonly Connection[]) => {
  const searchRegex = toSearchRegex(connectionFilter.value)
  const hideRegex = quickFilterEnabled.value ? toSearchRegex(quickFilterRegex.value) : null
  const sourceIPs = sourceIPFilter.value
  const needSearchValues = Boolean(searchRegex || hideRegex)
  const displayOptions = {
    mode: isConnectionCard.value ? ('card' as const) : ('table' as const),
    proxyChainDirection: proxyChainDirection.value,
    showFullProxyChain: showFullProxyChain.value,
  }
  const visibleKeys = isConnectionCard.value
    ? connectionCardLines.value.flat()
    : connectionTableColumns.value
  const searchKeys = searchHiddenColumns.value ? CONNECTION_SEARCHABLE_KEYS : visibleKeys

  return items.filter((conn) => {
    if (sourceIPs !== null && sourceIPs.every((i) => i !== getConnectionSourceIP(conn))) {
      return false
    }

    if (!needSearchValues) {
      return true
    }

    const allValues = hideRegex
      ? getConnectionVisibleSearchValues(conn, CONNECTION_SEARCHABLE_KEYS, displayOptions)
      : null

    if (allValues && hideRegex?.testAny(allValues)) {
      return false
    }

    if (searchRegex) {
      return searchRegex.testAny(
        searchKeys === CONNECTION_SEARCHABLE_KEYS && allValues
          ? allValues
          : getConnectionVisibleSearchValues(conn, searchKeys, displayOptions),
      )
    }

    return true
  })
}

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
