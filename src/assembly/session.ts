// 组装层 · 后端会话。
//
// 一次会话 = 面板为某个后端建立起来的整套运行时状态:内核探测 + 首屏数据 +
// 三条常驻流(connections / logs / traffic)。切后端、改当前后端的连接参数、
// 用户手动重连,本质都是「结束旧会话、开一条新的」,所以共用 startBackendSession ——
// 重连不需要额外的响应式开关,再调一次就是了。
import { activeBackend } from '@/store/setup'
import { watch } from 'vue'
import { fetchConfigs } from './config'
import { initConnections, stopConnections } from './connections'
import { initLogs, stopLogs } from './logs'
import { initSatistic, stopSatistic } from './overview'
import { fetchProxies } from './proxies'
import { fetchRules } from './rules'
import { resetSessionResources } from './session-resource'
import { probeActiveBackend } from './version'

export const startBackendSession = () => {
  // 探测不 await:连通性提示要的正是「正在连接」这个中间态,数据流也不必等它。
  probeActiveBackend()
  // REST 资源(proxies / rules / configs)整体换代:在途请求作废并 abort、新鲜度清零。
  // 没有这一步时,新后端会借用旧后端的在途请求(自己一次都不发),
  // 旧后端的慢响应还可能回填进新会话。
  resetSessionResources()
  // 三条常驻流连同各自的数据在这里同步丢掉:上一个后端的连接/日志/统计只要活过
  // 切换的那一帧,就会安静地冒充新后端的数据。
  stopConnections()
  stopLogs()
  stopSatistic()

  // 后端被清空(登出 / 401 / 新增后端)时就停在这:常驻流上面已经关掉,
  // 否则它们会以无主状态留在 Setup 页继续运行并无限重连。
  if (!activeBackend.value) return

  fetchConfigs()
  fetchProxies()
  fetchRules()
  initConnections()
  initLogs()
  initSatistic()
}

// 会话跟着 activeBackend 走:换后端要重建,把当前后端的地址 / 密码改掉同样要重建。
watch(activeBackend, startBackendSession, { immediate: true })
