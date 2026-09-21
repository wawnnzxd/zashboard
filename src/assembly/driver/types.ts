import type { ProbeResult } from '@/helper/connectivity'
import type {
  Backend,
  BackendType,
  Config,
  Connection,
  ConnectionRawMessage,
  DNSQuery,
  HonkStats,
  Log,
  NodeRank,
  Proxy,
  ProxyProvider,
  Rule,
  RuleProvider,
} from '@/types'
import type { ShallowRef } from 'vue'

export interface Stream<T> {
  data: ShallowRef<T | undefined>
  close: () => void
}

export interface Subscription {
  close: () => void
}

export interface ProxiesPayload {
  proxies: Record<string, Proxy>
  providers: ProxyProvider[]
}

export interface RulesPayload {
  rules: Rule[]
  providers: RuleProvider[]
}

export interface ConnectionsPayload {
  connections: ConnectionRawMessage[]
  downloadTotal?: number
  uploadTotal?: number
}

export interface TrafficSample {
  down: number
  up: number
  downTotal?: number
  upTotal?: number
}

export interface MemorySample {
  inuse: number
}

export interface ConnectionAccessor {
  chains(connection: Connection): string[]
  download(connection: Connection): number
  upload(connection: Connection): number
  start(connection: Connection): string | number
  rule(connection: Connection): string
  rulePayload(connection: Connection): string
  sourceIP(connection: Connection): string
  sourcePort(connection: Connection): string
  network(connection: Connection): string
  networkType(connection: Connection): string
  hostname(connection: Connection): string
  host(connection: Connection): string
  process(connection: Connection): string
  destination(connection: Connection): string
  inboundUser(connection: Connection): string
  sniffHost(connection: Connection): string
  remoteAddress(connection: Connection): string
  isDirect(connection: Connection): boolean
  smartBlock(connection: Connection): string | undefined
}

export interface SystemDriver {
  probe(backend: Backend, timeout: number, signal?: AbortSignal): Promise<ProbeResult>
  fetchVersion(): Promise<string>
  upgradeCore(channel: 'release' | 'alpha' | 'auto'): Promise<void>
  restartCore(): Promise<void>
  upgradeUI(): Promise<void>
  getStorage(): Promise<Record<string, unknown>>
  setStorage(value: Record<string, string>): Promise<void>
  deleteStorage(): Promise<void>
}

export interface MetricsDriver {
  traffic(): Stream<TrafficSample>
  memory(): Stream<MemorySample>
  fetchRuntimeStats(): Promise<HonkStats>
}

// fetch 的 signal 由 assembly 的 SessionResource 传入:换后端时真正 abort 在途请求、释放并发槽
// (旧后端不可达时请求会挂 30-75 秒)。不传就是不可中断的普通读。
export interface ProxiesDriver {
  fetch(signal?: AbortSignal): Promise<ProxiesPayload>
  /** 只读一条代理 / 代理组记录(点选节点后的单点刷新,1-2KB,对比全量 /proxies 的 MB 级)。 */
  fetchOne(name: string): Promise<Proxy>
  select(group: string, name: string): Promise<void>
  clearFixed(group: string): Promise<void>
  testNode(name: string, url: string, timeout: number): Promise<number>
  testProviderNode(provider: string, name: string, url: string, timeout: number): Promise<number>
  testGroup(group: string, url: string, timeout: number): Promise<Record<string, number>>
  updateProvider(name: string): Promise<void>
  healthCheckProvider(name: string): Promise<void>
  fetchSmartWeights(): Promise<Record<string, NodeRank[]>>
  flushSmartWeights(): Promise<void>
}

export interface RulesDriver {
  fetch(signal?: AbortSignal): Promise<RulesPayload>
  updateProvider(name: string): Promise<void>
  toggleDisabled(rule: Rule, disabled: boolean): Promise<void>
}

export interface ConfigDriver {
  fetch(signal?: AbortSignal): Promise<Config>
  patch(config: Record<string, string | boolean | object | number>): Promise<void>
  reload(): Promise<void>
  load(config: { path?: string; payload?: string }, force?: boolean): Promise<void>
  updateGeoData(): Promise<void>
  flushFakeIP(): Promise<void>
  flushDNSCache(): Promise<void>
  queryDNS(params: { name: string; type: string }): Promise<DNSQuery>
}

export interface LogsDriver {
  subscribe(level: string, onBatch: (logs: Log[]) => void): Subscription
}

export interface ConnectionsDriver {
  accessor: ConnectionAccessor
  subscribe(): Stream<ConnectionsPayload>
  disconnect(id: string): Promise<void>
  disconnectAll(): Promise<void>
  block(id: string): Promise<void>
}

export interface Driver {
  type: BackendType
  system: SystemDriver
  metrics: MetricsDriver
  proxies: ProxiesDriver
  rules: RulesDriver
  config: ConfigDriver
  logs: LogsDriver
  connections: ConnectionsDriver
}
