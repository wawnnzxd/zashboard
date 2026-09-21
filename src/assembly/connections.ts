import { getConnectionGeoIPInfoSync } from '@/api/connection-geoip'
import { CONNECTIONS_TABLE_ACCESSOR_KEY, PROXY_CHAIN_DIRECTION } from '@/constant'
import { getIPLabelFromMap } from '@/helper/source-ip'
import { fromNow, prettyBytesHelper } from '@/helper/utils'
import { autoDisconnectIdleUDP, autoDisconnectIdleUDPTime } from '@/store/settings'
import type { Connection } from '@/types'
import { watchOnce } from '@vueuse/core'
import dayjs from 'dayjs'
import * as ipaddr from 'ipaddr.js'
import pLimit from 'p-limit'
import { ref, shallowRef, watch } from 'vue'
import { driver, type ConnectionAccessor } from './driver'

export type ConnectionDisplayOptions = {
  mode: 'card' | 'table'
  proxyChainDirection: PROXY_CHAIN_DIRECTION | string
  showFullProxyChain: boolean
}

// 每拍整体换引用、元素不可变的管道:深 ref 会为每拍数千个一次性对象建 Proxy 与依赖记录,
// shallowRef 才是与该数据流语义吻合的粒度。
//
// 速率量纲(管道契约的一部分):downloadSpeed / uploadSpeed 单位是**字节/秒**,不是
// 「相邻两拍的字节差」。全部下游(表格 DlSpeed 列、proxyGroupTraffic 喂代理组头、速率排序键、
// 地球仪流光强度)本来就按「/s」解释这两个字段,而推送节拍只在理想情况下正好是 1 秒。
// 已关闭条目速率恒为 0,否则「全部」tab 按速率排序会把死连接顶到活跃连接前面。
export const activeConnections = shallowRef<Connection[]>([])
export const closedConnections = shallowRef<Connection[]>([])
// 本拍新关闭的连接(增量),store/conn-history 订阅它落历史库。
export const closedBatch = shallowRef<Connection[]>([])
// 内核自启动的上/下行总量,随连接 WS 消息携带。
export const downloadTotal = ref(0)
export const uploadTotal = ref(0)
// 暂停 = 显示层的一张快照(见 store/connections 的 frozenConnections),不是这条管道上的闸门。
export const isPaused = ref(false)

export const connectionAccessor = (): ConnectionAccessor => driver().connections.accessor

export const disconnectById = (id: string) => driver().connections.disconnect(id)

export const disconnectAll = () => driver().connections.disconnectAll()

export const blockConnectionById = (id: string) => driver().connections.block(id)

const disconnectLimiter = pLimit(12)

// 批量断开的统一入口:匹配集即全量时直接走批量端点;否则并发池限流 ——
// 逐条无限流的断开(自动断开/禁用规则/关闭全部)一次可瞬发上千请求,
// 把同源 HTTP/1.1 六并发队列塞死数秒。失败不上抛:这些都是顺带动作。
export const disconnectConnections = async (conns: Connection[], totalActive?: number) => {
  if (!conns.length) {
    return
  }

  if (totalActive !== undefined && totalActive > 0 && conns.length === totalActive) {
    await disconnectAll().catch(() => {})
    return
  }

  await Promise.allSettled(
    conns.map((conn) =>
      disconnectLimiter(async () => {
        await disconnectById(conn.id)
      }),
    ),
  )
}

// 一拍能被当作速率基准的间隔区间。上界:超过它说明 WS 断过一段(ReconnectingWebSocket 重连
// 复用同一个 handler,previousMap 跨重连存活,差值会是整段断线的累计字节);下界:标签页被冻结
// 后恢复,排队的消息会在几毫秒内连着送达,此时到达间隔根本不是快照之间的真实时距,拿它做除数
// 反而会把尖刺放大。两侧越界都记为「本拍无有效时间基准」,速率归零 —— 与「首次连接首拍为 0」
// 的既有语义一致,也好过把几分钟的平均值伪装成瞬时速率。下一拍即自愈。
const SPEED_INTERVAL_MIN_MS = 200
const SPEED_INTERVAL_MAX_MS = 3000

let cancel: (() => void) | undefined

export const initConnections = () => {
  stopConnections()
  // 暂停是「这一次浏览」的状态,不是跨会话的偏好:切后端/编辑后端/401 重登后若不复位,
  // 新会话的连接页会一直停在旧后端冻结下来的那张快照上,用户以为新后端挂了。
  isPaused.value = false

  const accessor = connectionAccessor()
  const source = driver().connections.subscribe()
  let previousMap = new Map<string, Connection>()
  // 上一拍的到达时刻,必须与 previousMap 同为闭包变量(提到模块级会让重建流互相串扰)。
  // 用 performance.now() 而不是 Date.now():它单调递增,不会被系统对时拨动,而合盖休眠期间照常
  // 推进 —— 正是「断线缺口」需要量的东西。
  let lastMessageAt = 0

  const unwatch = watch(source.data, (payload) => {
    if (!payload) return

    if (payload.downloadTotal != null && payload.uploadTotal != null) {
      downloadTotal.value = payload.downloadTotal
      uploadTotal.value = payload.uploadTotal
    }

    const now = performance.now()
    const elapsed = lastMessageAt === 0 ? 0 : now - lastMessageAt

    lastMessageAt = now

    // 0 表示本拍没有可信的时间基准(首拍 / 重连缺口 / 冻结后追帧),下面据此把速率归零;
    // 非 0 时它就是除数,恒 >= SPEED_INTERVAL_MIN_MS / 1000,不会产生 Infinity 或 NaN。
    const intervalSeconds =
      elapsed >= SPEED_INTERVAL_MIN_MS && elapsed <= SPEED_INTERVAL_MAX_MS ? elapsed / 1000 : 0

    const currentMap = new Map<string, Connection>()
    const active = payload.connections.map((raw) => {
      const connection = raw as Connection
      const previous = previousMap.get(connection.id)

      if (!previous || intervalSeconds === 0) {
        connection.downloadSpeed = 0
        connection.uploadSpeed = 0
      } else {
        connection.downloadSpeed =
          (accessor.download(connection) - accessor.download(previous)) / intervalSeconds
        connection.uploadSpeed =
          (accessor.upload(connection) - accessor.upload(previous)) / intervalSeconds
      }

      previousMap.delete(connection.id)
      currentMap.set(connection.id, connection)
      return connection
    })

    // 上一拍存在、这一拍消失的连接即新关闭。速率归零(已经断了,留着上一拍的瞬时值会让「已关闭」
    // 列表永久显示 3.2 MB/s 这种定格值),必须克隆而非就地改写:这些对象正是上一拍
    // activeConnections 数组里的成员,就地归零会把暂停期间冻结的那批行悄悄改掉。
    const closed = Array.from(previousMap.values(), (conn) => ({
      ...conn,
      downloadSpeed: 0,
      uploadSpeed: 0,
    }))
    previousMap = currentMap

    // 注意:这里**不判** isPaused(上游在此处 `if (isPaused.value) return`)。
    // 源头是唯一不能跳过的地方:它承载 closed 增量与历史归集,跳过就是永久数据丢失 ——
    // 暂停期间关闭的连接既不进已关闭列表也不进历史库,代理组头的实时速率静默冻结,
    // 概览页连接数折线以暂停瞬间的值画出一条假的水平直线。冻结发生在显示层。
    activeConnections.value = active

    if (closed.length > 0) {
      closedConnections.value = closedConnections.value.concat(closed).slice(-500)
      closedBatch.value = closed
    }
  })

  let unwatchIdleUDP: (() => void) | undefined

  if (autoDisconnectIdleUDP.value) {
    unwatchIdleUDP = watchOnce(activeConnections, () => {
      activeConnections.value
        .filter((conn) => accessor.network(conn) !== 'tcp')
        .forEach((conn) => {
          const now = dayjs()
          const start = dayjs(accessor.start(conn))

          if (now.diff(start, 'minute') > autoDisconnectIdleUDPTime.value) {
            // 后台自动清理,不是用户点的,失败不打扰
            disconnectById(conn.id).catch(() => {})
          }
        })
    })
  }

  cancel = () => {
    unwatch()
    // watchOnce 若一直没触发就会滞留到下一个会话:上一个后端武装的「一次性空闲 UDP 清理」
    // 会在新后端的首拍触发,对新后端的连接成批发 DELETE。连切 N 次就有 N 个同拍触发。
    unwatchIdleUDP?.()
    source.close()
  }
}

// 结束连接流并丢弃数据。两件事必须一起做:上一个后端的连接只要活过后端切换的
// 那一帧,就会冒充新后端的数据留在表格里。所以清空要与切换同步发生,不能等新流建起来。
export const stopConnections = () => {
  cancel?.()
  cancel = undefined
  activeConnections.value = []
  closedConnections.value = []
  closedBatch.value = []
  downloadTotal.value = 0
  uploadTotal.value = 0
}

const getDestinationType = (destination: string) => {
  if (ipaddr.IPv4.isIPv4(destination)) {
    return 'IPv4'
  } else if (ipaddr.IPv6.isIPv6(destination)) {
    return 'IPv6'
  } else {
    return 'FQDN'
  }
}

const getVisibleChains = (connection: Connection, options: ConnectionDisplayOptions) => {
  let chains = connectionAccessor().chains(connection)

  if ((options.mode === 'card' || !options.showFullProxyChain) && chains.length > 2) {
    chains = [chains[0], chains[chains.length - 1]]
  }

  return options.proxyChainDirection === PROXY_CHAIN_DIRECTION.REVERSE
    ? chains
    : [...chains].reverse()
}

export const getConnectionDisplayValue = (
  connection: Connection,
  key: CONNECTIONS_TABLE_ACCESSOR_KEY,
  options: ConnectionDisplayOptions,
) => {
  const accessor = connectionAccessor()

  switch (key) {
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Type:
      return accessor.networkType(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Process:
      return accessor.process(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Host:
      return accessor.host(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Rule:
      return accessor.rule(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Chains:
      return getVisibleChains(connection, options).join(' → ')
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Outbound:
      return accessor.chains(connection)[0] || ''
    case CONNECTIONS_TABLE_ACCESSOR_KEY.DlSpeed:
      return `${prettyBytesHelper(connection.downloadSpeed)}/s`
    case CONNECTIONS_TABLE_ACCESSOR_KEY.UlSpeed:
      return `${prettyBytesHelper(connection.uploadSpeed)}/s`
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Download:
      return prettyBytesHelper(accessor.download(connection))
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Upload:
      return prettyBytesHelper(accessor.upload(connection))
    case CONNECTIONS_TABLE_ACCESSOR_KEY.ConnectTime:
      return fromNow(accessor.start(connection))
    case CONNECTIONS_TABLE_ACCESSOR_KEY.SourceIP:
      return getIPLabelFromMap(accessor.sourceIP(connection))
    case CONNECTIONS_TABLE_ACCESSOR_KEY.SourcePort:
      return accessor.sourcePort(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.SniffHost:
      return accessor.sniffHost(connection) || '-'
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Destination:
      return accessor.destination(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.DestinationType:
      return getDestinationType(accessor.destination(connection))
    case CONNECTIONS_TABLE_ACCESSOR_KEY.GeoIP: {
      const { country, organization } = getConnectionGeoIPInfoSync(accessor.destination(connection))

      return [country, organization].filter(Boolean).join(' / ')
    }
    case CONNECTIONS_TABLE_ACCESSOR_KEY.RemoteAddress:
      return accessor.remoteAddress(connection) || '-'
    case CONNECTIONS_TABLE_ACCESSOR_KEY.InboundUser:
      return accessor.inboundUser(connection)
    case CONNECTIONS_TABLE_ACCESSOR_KEY.Close:
      return ''
  }
}

const searchableKeysCache = new WeakMap<
  CONNECTIONS_TABLE_ACCESSOR_KEY[],
  CONNECTIONS_TABLE_ACCESSOR_KEY[]
>()

export const getConnectionVisibleSearchValues = (
  connection: Connection,
  keys: CONNECTIONS_TABLE_ACCESSOR_KEY[],
  options: ConnectionDisplayOptions,
) => {
  let visibleKeys = searchableKeysCache.get(keys)

  if (!visibleKeys) {
    visibleKeys = keys.filter((key) => key !== CONNECTIONS_TABLE_ACCESSOR_KEY.Close)
    searchableKeysCache.set(keys, visibleKeys)
  }

  return visibleKeys.map((key) => getConnectionDisplayValue(connection, key, options))
}
