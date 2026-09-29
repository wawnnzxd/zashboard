<script setup lang="ts">
import './assembly/session'
import './store/conn-history'
import { computed, defineAsyncComponent, onMounted, ref, type Ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import BackendConnectionError from './components/common/BackendConnectionError.vue'
import BackendSwitchToast from './components/common/BackendSwitchToast.vue'
import BackendManager from './components/settings/backend/BackendManager.vue'
import UpdateConfigModal from './components/settings/backend/UpdateConfigModal.vue'
import UpgradeCoreModal from './components/settings/backend/UpgradeCoreModal.vue'
import { useAppearanceVars } from './composables/use-appearance-vars'
import { useOverscrollLock } from './composables/use-overscroll-lock'
import { useThemeColor } from './composables/use-theme-color'
import {
  showDaeConfigModal,
  showUpdateConfigModal,
  showUpgradeCoreModal,
} from '@/helper/backend-actions'
import ConfirmDialogHost from './components/common/ConfirmDialogHost.vue'
import { registerSW } from 'virtual:pwa-register'
import { useKeyboard } from './composables/use-keyboard'
import { EMOJIS, FONTS } from './constant'
import {
  autoImportSettings,
  autoSyncSettings,
  importSettingsFromUrl,
  syncSettingsFromCore,
} from './helper/auto-import-settings'
import { backgroundImage } from './helper/indexeddb'
import { initNotification } from './helper/notification'
import { getBackendFromUrl } from './helper/utils'
import { emoji, font, theme } from './store/settings'
import { activeBackend, backendList, setActiveBackend } from './store/setup'
import type { Backend } from './types'

// dae 专用的配置弹窗:只有当前后端是 dae 才挂载,并单独成块 —— 本 fork 只接 mihomo,
// 静态引入会把整套 dae 配置面板带进首屏。
const DaeConfigModal = defineAsyncComponent(
  () => import('./components/settings/backend/DaeConfigModal.vue'),
)

const app = ref<HTMLElement>()
const toast = ref<HTMLElement>()

initNotification(toast as Ref<HTMLElement>)

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

const { setThemeColor } = useThemeColor(app)

useOverscrollLock()

watch(
  theme,
  () => {
    document.documentElement.setAttribute('data-theme', theme.value)
    setThemeColor()
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
    <div
      aria-hidden="true"
      class="status-bar-tint"
    />
    <RouterView />
    <BackendSwitchToast />
    <BackendConnectionError />
    <BackendManager />
    <UpgradeCoreModal v-model="showUpgradeCoreModal" />
    <UpdateConfigModal v-model="showUpdateConfigModal" />
    <DaeConfigModal
      v-if="activeBackend?.type === 'dae'"
      v-model="showDaeConfigModal"
    />
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

<style>
.status-bar-tint {
  display: none;
}

@supports (-webkit-touch-callout: none) {
  .status-bar-tint {
    position: fixed;
    top: 0;
    right: 0;
    left: 0;
    z-index: 2147483647;
    display: block;
    height: 12px;
    background-color: var(--status-bar-tint, var(--color-base-100));
    opacity: 0.12;
    pointer-events: none;
  }
}

.app-toast-region {
  position: fixed;
  top: calc(0.75rem + env(safe-area-inset-top, 0px));
  right: calc(0.75rem + env(safe-area-inset-right, 0px));
  z-index: 100000;
  display: flex;
  width: min(24rem, calc(100vw - 1.5rem));
  flex-direction: column;
  gap: 0.625rem;
  pointer-events: none;
}

@media (min-width: 768px) {
  .app-toast-region {
    top: calc(2.75rem + env(safe-area-inset-top, 0px));
    right: calc(1rem + env(safe-area-inset-right, 0px));
  }
}

.app-toast {
  --toast-accent: var(--color-primary);
  grid-template-columns: 0.25rem 1.75rem minmax(0, 1fr) 1.5rem;
  animation: appToastIn 0.22s cubic-bezier(0.32, 0.72, 0, 1) both;
}

.app-toast[data-toast-type='success'] {
  --toast-accent: var(--color-success);
}

.app-toast[data-toast-type='error'] {
  --toast-accent: var(--color-error);
}

.app-toast[data-toast-type='warning'] {
  --toast-accent: var(--color-warning);
}

.app-toast[data-toast-type='info'] {
  --toast-accent: var(--color-info);
}

.app-toast.is-leaving {
  pointer-events: none;
  animation: appToastOut 0.16s ease-in both;
}

.app-toast__content {
  min-width: 0;
  padding-top: 0.2rem;
  color: var(--color-base-content);
  font-size: 0.875rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@keyframes appToastIn {
  from {
    opacity: 0;
    transform: translateX(0.75rem) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
}

@keyframes appToastOut {
  from {
    opacity: 1;
    transform: translateX(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateX(0.5rem) scale(0.98);
  }
}

@keyframes progressBar {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-toast,
  .app-toast.is-leaving {
    animation-duration: 0.01ms;
  }
}
</style>
