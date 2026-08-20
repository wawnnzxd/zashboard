import { i18n } from '@/i18n'
import { type Ref } from 'vue'

const t = i18n.global.t

// 一条 toast 的全部时间轴由 animation 这一个对象承载:进度条视觉、剩余时间、暂停态、
// 到期回调本来就是同一件事,原先用 timer/startTime/remainingTime/isPaused 四个字段
// 分别记账,任何一处错位都会表现成「进度条不重启 / 定格空条 / hover 保活失效 /
// 常驻 toast 被 hover 后杀掉」。animation 为 null 表示常驻(timeout 0),
// 于是所有暂停/续播都天然 no-op,不需要再为常驻条目写特判。
// hovered 是唯一还需要自己记的事实 —— 指针在不在这条 toast 上,只有 DOM 事件知道。
type Toast = {
  key: string
  alert: HTMLElement
  progressBar: HTMLElement
  animation: Animation | null
  hovered: boolean
}

const alertMap = new Map<string, Toast>()
let toastRef: Ref<HTMLElement> | null = null

export const initNotification = (toast: Ref<HTMLElement>) => {
  toastRef = toast
}

const closeAlert = (toast: Toast) => {
  toast.animation?.cancel()
  // 置空 + 按身份删表:关闭后可能还有一个已入队、来不及取消的 finish 事件,
  // 也可能同 key 的下一条 toast 已经建好了,两道判定保证它谁都误伤不到。
  toast.animation = null
  if (alertMap.get(toast.key) === toast) {
    alertMap.delete(toast.key)
  }
  toast.alert.remove()
}

// 重新开始这条 toast 的时间轴。同 key 复用时也走这里:旧动画 cancel 掉、建一条新的,
// 于是「同一个元素 + 同一段 CSS 动画声明不会重启」(CSS Animations 规范)这个坑不存在。
// 时长 / 缓动 / keyframes 与原 CSS 动画完全一致:linear,width 100% → 0%,duration = timeout。
const restartProgress = (toast: Toast, timeout: number) => {
  toast.animation?.cancel()
  // 上一轮动画是 forwards,会把计算值定格在 width:0% 盖住初始 inline 宽度;
  // 常驻分支(timeout 0)同样要复位,否则批量测速的进度 toast 全程是条空条。
  toast.progressBar.style.width = '100%'

  if (timeout === 0) {
    toast.animation = null
    return
  }

  const animation = toast.progressBar.animate([{ width: '100%' }, { width: '0%' }], {
    duration: timeout,
    easing: 'linear',
    fill: 'forwards',
  })

  animation.addEventListener('finish', () => {
    // 期间若被同 key 更新换成了新动画,这条到期通知已经不作数。
    if (toast.animation === animation) {
      closeAlert(toast)
    }
  })

  // 指针已经压在这条 toast 上时,新时间轴直接以暂停态开始,hover 保活不会被更新冲掉。
  if (toast.hovered) {
    animation.pause()
  }

  toast.animation = animation
}

const setHovered = (alertKey: string, hovered: boolean) => {
  const toast = alertMap.get(alertKey)

  if (!toast) return

  toast.hovered = hovered

  if (hovered) {
    toast.animation?.pause()
  } else if (toast.animation?.playState === 'paused') {
    // 只续播确实被自己暂停过的动画:对已经跑完的动画调 play() 会把它倒回起点重播。
    toast.animation.play()
  }
}

const setAlert = (
  alert: HTMLElement,
  content: string,
  params: Record<string, string>,
  type: string,
  alertKey: string,
): HTMLElement => {
  alert.className = `alert flex p-2 pr-5 relative ${type}`

  const contentDiv = document.createElement('div')
  contentDiv.className = 'break-all whitespace-pre-wrap'
  contentDiv.innerHTML = t(content, params)

  const closeButton = document.createElement('button')
  closeButton.className = 'absolute top-0 right-0 btn btn-xs btn-circle btn-ghost'
  closeButton.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3 h-3">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  `
  closeButton.addEventListener('click', () => {
    const toast = alertMap.get(alertKey)

    if (toast) {
      closeAlert(toast)
    } else {
      alert.remove()
    }
  })

  const progressContainer = document.createElement('div')
  progressContainer.className =
    'absolute -bottom-2 left-1 right-1 h-1 bg-transparent rounded-lg overflow-hidden'

  const progressBar = document.createElement('div')
  progressBar.className = 'h-full bg-primary/30 transition-all duration-100 ease-linear'
  progressBar.style.width = '100%'

  progressContainer.appendChild(progressBar)

  alert.innerHTML = ''
  alert.appendChild(contentDiv)
  alert.appendChild(closeButton)
  alert.appendChild(progressContainer)

  alert.addEventListener('mouseenter', () => setHovered(alertKey, true))
  alert.addEventListener('mouseleave', () => setHovered(alertKey, false))

  return progressBar
}

// 同 key 更新只改类名与文本:原实现每次重建 innerHTML 并重复挂 mouseenter/mouseleave,
// 一次组测速会在同一元素上累积上千个监听器。
const updateAlert = (
  alert: HTMLElement,
  content: string,
  params: Record<string, string>,
  type: string,
) => {
  alert.className = `alert flex p-2 pr-5 relative ${type}`
  const contentDiv = alert.firstElementChild as HTMLElement | null

  if (contentDiv) {
    contentDiv.textContent = t(content, params)
  }
}

export const showNotification = ({
  content,
  params = {},
  key,
  type = 'alert-warning',
  timeout = 3000,
}: {
  content: string
  params?: Record<string, string>
  key?: string
  type?: 'alert-warning' | 'alert-success' | 'alert-error' | 'alert-info' | ''
  timeout?: number
}) => {
  const alertKey = key || content
  const existing = alertMap.get(alertKey)

  if (existing) {
    updateAlert(existing.alert, content, params, type)
    restartProgress(existing, timeout)
    return
  }

  const alert = document.createElement('div')
  const progressBar = setAlert(alert, content, params, type, alertKey)
  const toast: Toast = { key: alertKey, alert, progressBar, animation: null, hovered: false }

  // 先入表再起动画:finish 回调与 hover 回调都要能按 key 找到这条 toast。
  alertMap.set(alertKey, toast)
  toastRef?.value?.insertBefore(alert, toastRef?.value?.firstChild)
  restartProgress(toast, timeout)
}
