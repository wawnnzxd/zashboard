// 组装层 · 后端会话。
//
// 一次会话 = 面板为某个后端建立起来的整套运行时状态:内核探测 + 首屏数据 +
// 三条常驻流(connections / logs / traffic)。切后端、改当前后端的连接参数、
// 用户手动重连,本质都是「结束旧会话、开一条新的」,所以共用 startBackendSession ——
// 重连不需要额外的响应式开关,再调一次就是了。
import { activeBackend } from '@/store/setup'
import { watch } from 'vue'
import { can } from './backend'
import { fetchConfigs } from './config'
import { initConnections, stopConnections } from './connections'
import { fetchDaeRuntime } from './dae'
import { driver } from './driver'
import { initLogs, stopLogs } from './logs'
import { initSatistic, stopSatistic } from './overview'
import { fetchProxies } from './proxies'
import { fetchRules } from './rules'
import { resetSessionResources } from './session-resource'
import { probeActiveBackend } from './version'

const EVENT_DEBOUNCE = 400

let events: { close: () => void } | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined

const scheduleRefresh = () => {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    fetchProxies().catch(() => {})
    fetchRules().catch(() => {})
    fetchConfigs().catch(() => {})
  }, EVENT_DEBOUNCE)
}

const stopEvents = () => {
  clearTimeout(refreshTimer)
  refreshTimer = undefined
  events?.close()
  events = undefined
}

const initEvents = () => {
  stopEvents()

  const subscribe = driver().events?.subscribe

  if (!subscribe || !can('backendEvents')) return

  events = subscribe((kind) => {
    if (kind === 'generation.changed') scheduleRefresh()
  })
}

export const startBackendSession = async () => {
  // 探测默认不 await:连通性提示要的正是「正在连接」这个中间态,数据流也不必等它。
  // 例外是 dae —— 它的能力表(事件流、运行时面板等)由探测顺带拉回,见下方。
  const probing = probeActiveBackend()
  // REST 资源(proxies / rules / configs)整体换代:在途请求作废并 abort、新鲜度清零。
  // 没有这一步时,新后端会借用旧后端的在途请求(自己一次都不发),
  // 旧后端的慢响应还可能回填进新会话。
  resetSessionResources()
  // 三条常驻流连同各自的数据在这里同步丢掉:上一个后端的连接/日志/统计只要活过
  // 切换的那一帧,就会安静地冒充新后端的数据。
  stopConnections()
  stopLogs()
  stopSatistic()
  stopEvents()
  driver().reset?.()

  // 后端被清空(登出 / 401 / 新增后端)时就停在这:常驻流上面已经关掉,
  // 否则它们会以无主状态留在 Setup 页继续运行并无限重连。
  if (!activeBackend.value) return

  // dae 的能力表要等探测拉回来,事件流等功能才知道开不开;mihomo 的能力只看内核类型,不等。
  if (activeBackend.value.type === 'dae') {
    const backend = activeBackend.value
    await probing.catch(() => {})
    // 等的这段时间里又切了后端:新的一轮会话已经开始,这一轮作废。
    if (activeBackend.value !== backend) return
  }

  fetchConfigs()
  fetchProxies()
  fetchRules()
  initConnections()
  initLogs()
  initSatistic()
  initEvents()

  if (activeBackend.value.type === 'dae') {
    fetchDaeRuntime().catch(() => {})
  }
}

// 会话跟着 activeBackend 走:换后端要重建,把当前后端的地址 / 密码改掉同样要重建。
watch(activeBackend, startBackendSession, { immediate: true })
