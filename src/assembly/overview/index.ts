// 组装层 · overview 门面。memory / traffic 统计流按后端类型路由,统一返回 { data, close } 流。
import { Channel, channel } from '@/assembly/backend'
import * as clash from './clash'

// sing-box 实现(连同 gRPC 栈 ~130KB)按需加载,clash 用户不再买单。
// 访问器是同步热路径,故用「init 前预载 + 同步委派」而非逐调用动态 import。
let singboxModule: typeof import('./singbox') | null = null

export const preloadOverviewBackend = async () => {
  if (channel.value === Channel.Singbox && !singboxModule) {
    singboxModule = await import('./singbox')
  }
}

const backend = () => {
  if (channel.value !== Channel.Singbox) {
    return clash
  }
  if (!singboxModule) {
    throw new Error('sing-box overview backend not preloaded')
  }
  return singboxModule
}

export const fetchMemoryAPI = <T>() => backend().fetchMemoryAPI<T>()

export const fetchTrafficAPI = <T>() => backend().fetchTrafficAPI<T>()
