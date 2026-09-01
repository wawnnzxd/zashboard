// Clash WS 后端的连接流、断连动作,以及「原始 Clash 连接数据 → view 字段」的访问器。
import { createClashWebSocket, disconnectAllClashAPI, disconnectClashByIdAPI } from '@/api/clash'
import { proxyMap } from '@/assembly/proxies'
import { PROXY_TYPE } from '@/constant'
import type { ClashConnectionRawMessage, Connection } from '@/types'
import { head } from 'lodash-es'
import { shallowRef, watch } from 'vue'
import {
  createGetConnectionDisplayValue,
  createGetConnectionVisibleSearchValues,
  type ConnectionAccessor,
  type ConnectionsSnapshot,
} from './accessor'

export const disconnectByIdAPI = disconnectClashByIdAPI

export const disconnectAllAPI = disconnectAllClashAPI

// 一拍能被当作速率基准的间隔区间。上界:超过它说明 WS 断过一段(ReconnectingWebSocket 重连
// 复用同一个 handler,previousMap 跨重连存活,差值会是整段断线的累计字节);下界:标签页被冻结
// 后恢复,排队的消息会在几毫秒内连着送达,此时到达间隔根本不是快照之间的真实时距,拿它做除数
// 反而会把尖刺放大。两侧越界都记为「本拍无有效时间基准」,速率归零 —— 与「首次连接首拍为 0」
// 的既有语义一致,也好过把几分钟的平均值伪装成瞬时速率。下一拍即自愈。
const SPEED_INTERVAL_MIN_MS = 200
const SPEED_INTERVAL_MAX_MS = 3000

// Clash WS 每拍推送活跃连接全量快照。瞬时速率与已关闭连接需与上一拍 diff 求得 —— 这是 clash
// 协议固有的内部细节,在此完成,对外只暴露统一的 ConnectionsSnapshot。
//
// 量纲约定(ConnectionsSnapshot 的一部分):产出的 downloadSpeed/uploadSpeed 单位是**字节/秒**,
// 不是「相邻两拍的字节差」。全部下游(表格 DlSpeed 列、chainTrafficMap 喂代理组头、速率排序键、
// 地球仪流光强度)本来就按「/s」解释这两个字段,而推送节拍只在理想情况下正好是 1 秒。把「除以
// 本拍真实间隔」吃进这里,下游既不必知道、也无从知道节拍,契约才是自洽的。
export const fetchConnectionsAPI = () => {
  const ws = createClashWebSocket<{
    connections: ClashConnectionRawMessage[]
    downloadTotal: number
    uploadTotal: number
    memory: number
  }>('connections')

  const data = shallowRef<ConnectionsSnapshot>()
  let previousMap = new Map<string, Connection>()
  // 上一拍的到达时刻,必须与 previousMap 同为闭包变量(提到模块级会让多后端 / 重建流互相串扰)。
  // 用 performance.now() 而不是 Date.now():它单调递增,不会被系统对时拨动,而合盖休眠期间照常
  // 推进 —— 正是「断线缺口」需要量的东西。
  let lastMessageAt = 0

  const unwatch = watch(ws.data, (raw) => {
    if (!raw) return

    const now = performance.now()
    const elapsed = lastMessageAt === 0 ? 0 : now - lastMessageAt

    lastMessageAt = now

    // 0 表示本拍没有可信的时间基准(首拍 / 重连缺口 / 冻结后追帧),下面据此把速率归零;
    // 非 0 时它就是除数,恒 >= SPEED_INTERVAL_MIN_MS / 1000,不会产生 Infinity 或 NaN。
    const intervalSeconds =
      elapsed >= SPEED_INTERVAL_MIN_MS && elapsed <= SPEED_INTERVAL_MAX_MS ? elapsed / 1000 : 0

    const currentMap = new Map<string, Connection>()
    const active = (raw.connections ?? []).map((conn) => {
      const connection = conn as Connection
      const pre = previousMap.get(connection.id)

      if (!pre || intervalSeconds === 0) {
        connection.downloadSpeed = 0
        connection.uploadSpeed = 0
      } else {
        connection.downloadSpeed =
          (asClash(connection).download - asClash(pre).download) / intervalSeconds
        connection.uploadSpeed =
          (asClash(connection).upload - asClash(pre).upload) / intervalSeconds
      }

      previousMap.delete(connection.id)
      currentMap.set(connection.id, connection)
      return connection
    })

    // 上一拍存在、这一拍消失的连接即新关闭。速率归零(已经断了,留着上一拍的瞬时值会让「已关闭」
    // 列表永久显示 3.2 MB/s 这种定格值,ALL tab 按速率排序时死连接还会被顶到活跃连接前面),
    // 必须克隆而非就地改写:这些对象正是上一拍 activeConnections 数组里的成员,就地归零会把暂停
    // 期间冻结的那批行悄悄改掉,任何后续重渲染都会露馅。
    const closed = Array.from(previousMap.values(), (conn) => ({
      ...conn,
      downloadSpeed: 0,
      uploadSpeed: 0,
    }))
    previousMap = currentMap

    data.value = {
      active,
      closed,
      downloadTotal: raw.downloadTotal,
      uploadTotal: raw.uploadTotal,
    }
  })

  return {
    data,
    close: () => {
      unwatch()
      ws.close()
    },
  }
}

const getFinalProxyType = (c: ClashConnectionRawMessage) =>
  proxyMap.value[head(c.chains) || '']?.type.toLowerCase()

const asClash = (connection: Connection) => connection as ClashConnectionRawMessage

const getNetwork = (c: ClashConnectionRawMessage) => {
  const { destinationPort, sniffHost, network } = c.metadata

  if ((destinationPort === '443' || sniffHost) && network === 'udp') {
    return 'quic'
  }

  return network
}

const getHostname = (c: ClashConnectionRawMessage) =>
  c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP

export const connectionAccessor: ConnectionAccessor = {
  chains: (connection) => asClash(connection).chains,
  download: (connection) => asClash(connection).download,
  upload: (connection) => asClash(connection).upload,
  start: (connection) => asClash(connection).start,
  rule: (connection) => {
    const clash = asClash(connection)

    return clash.rulePayload ? `${clash.rule}: ${clash.rulePayload}` : clash.rule
  },
  rulePayload: (connection) => asClash(connection).rulePayload,
  sourceIP: (connection) => asClash(connection).metadata.sourceIP,
  sourcePort: (connection) => asClash(connection).metadata.sourcePort,
  network: (connection) => getNetwork(asClash(connection)),
  networkType: (connection) => {
    const clash = asClash(connection)

    return `${clash.metadata.type} | ${getNetwork(clash)}`
  },
  hostname: (connection) => getHostname(asClash(connection)),
  host: (connection) => {
    const clash = asClash(connection)
    const host = getHostname(clash)

    if (host.includes(':')) {
      return `[${host}]:${clash.metadata.destinationPort}`
    }
    return `${host}:${clash.metadata.destinationPort}`
  },
  process: (connection) => {
    const { metadata } = asClash(connection)

    return metadata.process || metadata.processPath?.replace(/^.*[/\\](.*)$/, '$1') || '-'
  },
  destination: (connection) => {
    const clash = asClash(connection)
    if (getFinalProxyType(clash) === PROXY_TYPE.Direct && clash.metadata.remoteDestination) {
      return clash.metadata.remoteDestination
    }

    return clash.metadata.destinationIP || clash.metadata.host
  },
  inboundUser: (connection) => {
    const { metadata } = asClash(connection)

    return metadata.inboundUser || metadata.inboundName || metadata.inboundPort || '-'
  },
  sniffHost: (connection) => asClash(connection).metadata.sniffHost,
  remoteAddress: (connection) => asClash(connection).metadata.remoteDestination,
  smartBlock: (connection) => asClash(connection).metadata.smartBlock,
  isDirect: (connection) => getFinalProxyType(asClash(connection)) === PROXY_TYPE.Direct,
}

export const getConnectionDisplayValue = createGetConnectionDisplayValue(connectionAccessor)

export const getConnectionVisibleSearchValues =
  createGetConnectionVisibleSearchValues(connectionAccessor)
