// GeoIP Worker 的模块级宿主:跨路由切换复用同一个 Worker。
//
// 概览页没有 KeepAlive,每次进入都会重新挂载地球仪卡片。若 Worker 跟着卡片走,
// 每次进页都要从 IndexedDB 重读 130MB 的城市库并重建 mmdb Reader,离开时又把
// 正在进行的下载(用户主动的 61.7MB / 缓存过期后的后台刷新)一并杀掉 —— 网络一般时
// 用户可能永远等不到一次完整下载。这里把 Worker 生命周期与卡片解耦:
//   - 首个卡片挂载时创建并 init,后来的卡片直接复用,并回放最近一次状态;
//   - 最后一个卡片卸载后延迟回收(留出"离开又回来"的窗口);下载进行中绝不回收。
import type { GeoWorkerRequest, GeoWorkerResponse } from './types'

type Listener = (message: GeoWorkerResponse) => void

// 最后一个消费者离开后保留 Worker 的时长(内存里驻留一份 130MB 城市库)
const IDLE_TERMINATE_DELAY = 5 * 60 * 1000

let worker: Worker | null = null
let downloading = false
let lastStatus: Extract<GeoWorkerResponse, { type: 'status' }> | null = null
let terminateTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<Listener>()

const cancelTerminate = () => {
  if (terminateTimer) {
    clearTimeout(terminateTimer)
    terminateTimer = null
  }
}

const terminate = () => {
  cancelTerminate()
  worker?.terminate()
  worker = null
  downloading = false
  lastStatus = null
}

const scheduleTerminate = () => {
  cancelTerminate()
  if (!worker || listeners.size > 0) return
  terminateTimer = setTimeout(() => {
    terminateTimer = null
    if (listeners.size > 0) return
    // 下载中不回收:等下载结束的 activity 消息再重新排期
    if (downloading) return
    terminate()
  }, IDLE_TERMINATE_DELAY)
}

const handleMessage = ({ data }: MessageEvent<GeoWorkerResponse>) => {
  if (data.type === 'activity') {
    downloading = data.downloading
    if (!downloading && listeners.size === 0) scheduleTerminate()
    return
  }
  if (data.type === 'status') {
    // 下载进度不做"最近状态"回放的锚点意义不大,但保留最新一条即可
    lastStatus = data
  }
  for (const listener of listeners) listener(data)
}

const ensureWorker = () => {
  if (worker) return worker
  worker = new Worker(new URL('./geoip.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', handleMessage)
  worker.postMessage({ type: 'init' } satisfies GeoWorkerRequest)
  return worker
}

export const acquireGeoWorker = (listener: Listener) => {
  cancelTerminate()
  const created = !worker
  ensureWorker()
  listeners.add(listener)
  // 复用已有 Worker 时回放最近状态,新卡片才不会卡在 checking
  if (!created && lastStatus) listener(lastStatus)
}

export const releaseGeoWorker = (listener: Listener) => {
  listeners.delete(listener)
  if (listeners.size === 0) scheduleTerminate()
}

export const postGeoWorker = (message: GeoWorkerRequest) => {
  worker?.postMessage(message)
}
