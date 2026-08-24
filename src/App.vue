<script setup lang="ts">
// 后端会话(内核探测 + 首屏数据 + 常驻流)自己跟着 activeBackend 走,
// 这里只需保证模块被加载,不依赖任何页面挂载。
import './assembly/session'
import { computed, onMounted, ref, type Ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import BackendConnectionError from './components/common/BackendConnectionError.vue'
import BackendSwitchToast from './components/common/BackendSwitchToast.vue'
import BackendManager from './components/settings/backend/BackendManager.vue'
import UpdateConfigModal from './components/settings/backend/UpdateConfigModal.vue'
import UpgradeCoreModal from './components/settings/backend/UpgradeCoreModal.vue'
import { useAppearanceVars } from './composables/useAppearanceVars'
import { showUpdateConfigModal, showUpgradeCoreModal } from './composables/backendActions'
import ConfirmDialogHost from './components/common/ConfirmDialogHost.vue'
import { registerSW } from 'virtual:pwa-register'
import { useKeyboard } from './composables/keyboard'
import { EMOJIS, FONTS } from './constant'
import {
  autoImportSettings,
  autoSyncSettings,
  importSettingsFromUrl,
  syncSettingsFromCore,
} from './helper/autoImportSettings'
import { backgroundImage } from './helper/indexeddb'
import { initNotification } from './helper/notification'
import { getBackendFromUrl, isPreferredDark } from './helper/utils'
import { disablePullToRefresh, emoji, font, theme } from './store/settings'
import { backendList, setActiveBackend } from './store/setup'
import type { Backend } from './types'

const app = ref<HTMLElement>()
const toast = ref<HTMLElement>()

initNotification(toast as Ref<HTMLElement>)

// 字体类名映射表
const FONT_CLASS_MAP = {
  [EMOJIS.TWEMOJI]: {
    [FONTS.MI_SANS]: 'font-MiSans-Twemoji',
    [FONTS.SARASA_UI]: 'font-SarasaUI-Twemoji',
    [FONTS.PING_FANG]: 'font-PingFang-Twemoji',
    [FONTS.FIRA_SANS]: 'font-FiraSans-Twemoji',
    [FONTS.SYSTEM_UI]: 'font-SystemUI-Twemoji',
  },
  [EMOJIS.NOTO_COLOR_EMOJI]: {
    [FONTS.MI_SANS]: 'font-MiSans-NotoEmoji',
    [FONTS.SARASA_UI]: 'font-SarasaUI-NotoEmoji',
    [FONTS.PING_FANG]: 'font-PingFang-NotoEmoji',
    [FONTS.FIRA_SANS]: 'font-FiraSans-NotoEmoji',
    [FONTS.SYSTEM_UI]: 'font-SystemUI-NotoEmoji',
  },
} as const

const fontClassName = computed(() => {
  return (
    FONT_CLASS_MAP[emoji.value]?.[font.value] || FONT_CLASS_MAP[EMOJIS.TWEMOJI][FONTS.SYSTEM_UI]
  )
})

const setThemeColor = () => {
  if (!app.value) return

  const themeColor = getComputedStyle(app.value!).getPropertyValue('background-color').trim()
  const metaThemeColor = document.querySelector('meta[name="theme-color"]')
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', themeColor)
  }
}

watch(isPreferredDark, setThemeColor)
watch(
  theme,
  () => {
    document.body.setAttribute('data-theme', theme.value)
    setThemeColor()
  },
  {
    immediate: true,
  },
)

// iOS bounces the whole page when a vertical drag has nowhere left to scroll:
// either it's over a non-scrollable area (so the drag pans the layout viewport),
// or it's inside a scroll container already at its top/bottom edge and the
// leftover scroll chains up to the document. Classic iOS scroll-lock: find the
// nearest vertically-scrollable ancestor and only let the drag through while
// that element can still move in the drag direction; otherwise cancel it so
// nothing reaches the page.
let touchStartX = 0
let touchStartY = 0

// 手势级缓存:滚动容器在一次手势内不变,原实现每个 touchmove(60-120 次/秒)
// 都沿祖先链逐层 getComputedStyle + 布局读,拖动期间几乎每事件强制样式重算
let gestureScrollable: HTMLElement | null | undefined

const onTouchStart = (event: TouchEvent) => {
  touchStartX = event.touches[0].clientX
  touchStartY = event.touches[0].clientY
  gestureScrollable = undefined
}

const findScrollableY = (target: EventTarget | null) => {
  let el = target as HTMLElement | null
  while (el && el !== document.body && el !== document.documentElement) {
    const { overflowY } = getComputedStyle(el)
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el
    }
    el = el.parentElement
  }
  return null
}

const onTouchMove = (event: TouchEvent) => {
  if (event.touches.length > 1) return

  const deltaX = event.touches[0].clientX - touchStartX
  const deltaY = event.touches[0].clientY - touchStartY
  // Leave horizontal gestures (e.g. swiping a horizontally-scrollable table) be.
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return

  if (gestureScrollable === undefined) {
    gestureScrollable = findScrollableY(event.target)
  }
  const el = gestureScrollable
  if (!el) {
    event.preventDefault()
    return
  }

  const atTop = el.scrollTop <= 0
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
  // deltaY > 0 means dragging downward (revealing content above).
  if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
    event.preventDefault()
  }
}

// 无触摸能力的设备不挂 non-passive 监听(它会让合成器每个滚动帧同步等主线程)
const supportsTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0

watch(
  disablePullToRefresh,
  () => {
    const body = document.body
    if (disablePullToRefresh.value && supportsTouch) {
      body.style.overscrollBehavior = 'none'
      body.style.overflow = 'hidden'
      document.addEventListener('touchstart', onTouchStart, { passive: true })
      document.addEventListener('touchmove', onTouchMove, { passive: false })
    } else {
      body.style.overscrollBehavior = ''
      body.style.overflow = ''
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
    }
  },
  {
    immediate: true,
  },
)

const isSameBackend = (b1: Omit<Backend, 'uuid' | 'type'>, b2: Omit<Backend, 'uuid' | 'type'>) => {
  return (
    b1.host === b2.host &&
    b1.port === b2.port &&
    b1.password === b2.password &&
    b1.protocol === b2.protocol &&
    b1.secondaryPath === b2.secondaryPath &&
    b1.disableUpgradeCore === b2.disableUpgradeCore &&
    b1.disableTunMode === b2.disableTunMode
  )
}

const autoSwitchToURLBackendIfExists = () => {
  const backend = getBackendFromUrl()

  if (backend) {
    for (const b of backendList.value) {
      if (isSameBackend(b, backend)) {
        setActiveBackend(b.uuid)
        return
      }
    }
  }
}

autoSwitchToURLBackendIfExists()

onMounted(async () => {
  setThemeColor()

  if (autoImportSettings.value) {
    try {
      // 返回 true = 已写入 localStorage 并调了 reload，此时再跑自动同步等于二次覆盖 + 二次刷新；
      // 其余返回 false 的路径(网络失败/HTTP 失败/JSON 失败/hash 未变/用户取消)都应当继续走自动同步
      const imported = await importSettingsFromUrl()
      if (imported) return
    } catch (error) {
      // importSettingsFromUrl 已把导入失败吃进实现，这里兜的是它之外的意外抛出
      //（例如 localStorage 写满）—— 无论如何都不能让导入失败连坐掉下面的自动同步
      console.error('Failed to auto-import settings from URL:', error)
    }
  }

  if (autoSyncSettings.value) {
    try {
      await syncSettingsFromCore()
    } catch (e) {
      console.error('Failed to auto-sync settings on app load:', e)
    }
  }
})

// PWA prompt 模式:新版本就绪时出横幅让用户主动刷新(autoUpdate 的热替换会让
// 常开面板的未加载懒 chunk 因旧 hash 失效)
const needRefresh = ref(false)
const updateServiceWorker = registerSW({
  onNeedRefresh() {
    needRefresh.value = true
  },
})

// 外观两个滑杆改由 useAppearanceVars 发布到 documentElement 上:
// 原先挂在 #app-content 的内联变量传不进 Teleport 到 body 的拓扑图全屏层,
// 且 blur 强度为 0 时它直接给 none —— 与我们原来那个 custom-blur 类同效
// (blur(0px) 一样白付一个合成层),但少一个类名开关。
useAppearanceVars()
useKeyboard()
</script>

<template>
  <div
    ref="app"
    id="app-content"
    :class="[
      'bg-base-100 flex w-screen overflow-hidden',
      fontClassName,
      backgroundImage && 'custom-background bg-cover bg-center',
    ]"
    :style="[backgroundImage, { height: 'var(--app-height, 100dvh)' }]"
  >
    <RouterView />
    <BackendSwitchToast />
    <BackendConnectionError />
    <BackendManager />
    <!-- 后端维护动作的弹窗:侧边栏菜单和设置页都会拉起,挂在这里两处入口才都有效。 -->
    <UpgradeCoreModal v-model="showUpgradeCoreModal" />
    <UpdateConfigModal v-model="showUpdateConfigModal" />
    <!--
      确认弹窗排在所有弹窗之后:它们都 teleport 到 #app-content 且同一层 z-index,
      谁后插进 DOM 谁在上面。升级内核的确认是从弹窗里拉起的,排前面就会被压在底下。
    -->
    <ConfirmDialogHost />
    <div
      ref="toast"
      class="app-toast-region"
    />
    <button
      v-if="needRefresh"
      class="btn btn-primary btn-sm fixed bottom-4 left-1/2 z-[100001] -translate-x-1/2 shadow-lg"
      @click="updateServiceWorker(true)"
    >
      {{ $t('refreshToUpdate') }}
    </button>
  </div>
</template>
