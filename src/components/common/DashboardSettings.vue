<template>
  <button
    class="btn btn-sm"
    @click="dashboardSettingsDialogShow = true"
  >
    <Cog6ToothIcon
      v-if="iconOnly"
      class="h-4 w-4"
    />
    <template v-else>{{ $t('dashboardSettings') }}</template>
  </button>
  <DialogWrapper
    v-model="dashboardSettingsDialogShow"
    :title="$t('dashboardSettings')"
  >
    <template #title-right>
      <button
        class="btn btn-xs absolute top-2 right-10"
        @click="handlerClickResetSettings"
      >
        {{ $t('resetSettings') }}
      </button>
    </template>
    <template v-if="showSyncSettings">
      <div class="settings-section-label">
        {{ $t('dashboardSettingsCore') }}
      </div>
      <div class="settings-grid">
        <div class="setting-item">
          <div class="setting-item-label">
            {{ $t('uploadSettings') }}
          </div>
          <button
            :class="twMerge('btn btn-sm', isStorageSubmitting ? 'btn-disabled' : '')"
            :disabled="isStorageSubmitting"
            @click="handlerClickUploadSettings"
          >
            <ArrowUpTrayIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="setting-item">
          <div class="setting-item-label">
            {{ $t('syncSettings') }}
          </div>
          <button
            :class="twMerge('btn btn-sm', isStorageSubmitting ? 'btn-disabled' : '')"
            :disabled="isStorageSubmitting"
            @click="handlerClickSyncSettings"
          >
            <ArrowPathIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="setting-item">
          <div class="setting-item-label">
            {{ $t('deleteUploadedSettings') }}
          </div>
          <button
            :class="
              twMerge('btn btn-sm btn-error btn-soft', isStorageSubmitting ? 'btn-disabled' : '')
            "
            :disabled="isStorageSubmitting"
            @click="handlerClickDeleteUploadedSettings"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="setting-item">
          <div class="setting-item-label">
            {{ $t('autoSyncSettings') }}
          </div>
          <input
            v-model="autoSyncSettings"
            type="checkbox"
            class="toggle"
          />
        </div>
        <div
          v-if="autoSyncSettings || skipSyncSettingsConfirm"
          class="setting-item"
        >
          <div class="setting-item-label">
            {{ $t('confirmBeforeOverride') }}
          </div>
          <input
            v-model="skipSyncSettingsConfirm"
            type="checkbox"
            class="toggle"
            :true-value="false"
            :false-value="true"
          />
        </div>
      </div>
    </template>

    <div class="settings-section-label">
      {{ $t('dashboardSettingsJsonFile') }}
    </div>
    <div class="settings-grid">
      <div class="setting-item">
        <div class="setting-item-label">
          {{ $t('exportSettings') }}
        </div>
        <button
          class="btn btn-sm"
          @click="exportSettings"
        >
          <ArrowDownCircleIcon class="h-4 w-4" />
        </button>
      </div>
      <div class="setting-item">
        <div class="setting-item-label">
          {{ $t('importFromFile') }}
        </div>
        <button
          class="btn btn-sm"
          @click="importSettingsFromFile"
        >
          <ArrowUpCircleIcon class="h-4 w-4" />
        </button>
      </div>
    </div>

    <div class="settings-section-label">
      {{ $t('dashboardSettingsUrl') }}
    </div>
    <div class="settings-grid">
      <div class="setting-item max-sm:flex-col max-sm:items-start! max-sm:py-3">
        <div class="setting-item-label shrink-0!">
          {{ $t('importFromUrl') }}
        </div>
        <div class="flex items-center gap-2 max-sm:flex-wrap">
          <div class="join flex-1">
            <TextInput
              v-model="importSettingsUrl"
              class="join-item max-w-none flex-1"
            />
            <button
              class="btn btn-sm join-item"
              @click="importSettingsFromUrlHandler()"
            >
              <ArrowDownTrayIcon class="h-4 w-4" />
            </button>
          </div>
          <QuestionMarkCircleIcon
            v-if="importSettingsUrl === DEFAULT_SETTINGS_URL"
            class="h-4 w-4 shrink-0"
            @mouseenter="
              showTip($event, $t('importFromBackendTip'), {
                appendTo: 'parent',
              })
            "
          />
          <button
            v-else
            class="btn btn-sm"
            @click="importSettingsUrl = DEFAULT_SETTINGS_URL"
          >
            {{ $t('reset') }}
          </button>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-label flex items-center gap-2">
          {{ $t('autoImportFromUrl') }}
          <QuestionMarkCircleIcon
            class="h-4 w-4 cursor-pointer"
            @mouseenter="
              showTip($event, $t('autoImportFromUrlTip'), {
                appendTo: 'parent',
              })
            "
          />
        </div>
        <input
          v-model="autoImportSettings"
          type="checkbox"
          class="toggle"
        />
      </div>
      <div
        v-if="autoImportSettings || skipImportSettingsConfirm"
        class="setting-item"
      >
        <div class="setting-item-label">
          {{ $t('confirmBeforeOverride') }}
        </div>
        <input
          v-model="skipImportSettingsConfirm"
          type="checkbox"
          class="toggle"
          :true-value="false"
          :false-value="true"
        />
      </div>
    </div>
    <input
      ref="inputRef"
      type="file"
      accept=".json"
      class="hidden"
      @change="handlerJsonUpload"
    />
  </DialogWrapper>
</template>

<script setup lang="ts">
import { deleteStorageAPI, setStorageAPI } from '@/assembly/storage'
import { can } from '@/assembly/backend'
import {
  autoImportSettings,
  autoSyncSettings,
  DEFAULT_SETTINGS_URL,
  importSettingsFromUrl,
  importSettingsUrl,
  skipImportSettingsConfirm,
  skipSyncSettingsConfirm,
  syncSettingsFromCore,
} from '@/helper/autoImportSettings'
import { LOCAL_IMAGE } from '@/helper/indexeddb'
import { dismissNotification, notifyActionPending, showNotification } from '@/helper/notification'
import { notifyRequestError } from '@/helper/requestError'
import { useTooltip } from '@/helper/tooltip'
import {
  applyDashboardSettingsToStorage,
  exportSettings,
  getDashboardSettingsFromStorage,
  resetSettings,
} from '@/helper/utils'
import { customBackgroundURL } from '@/store/settings'
import {
  ArrowDownCircleIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpCircleIcon,
  ArrowUpTrayIcon,
  Cog6ToothIcon,
  QuestionMarkCircleIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { twMerge } from 'tailwind-merge'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DialogWrapper from './DialogWrapper.vue'
import TextInput from './TextInput.vue'

withDefaults(
  defineProps<{
    /** 仅显示图标的触发按钮，用于左侧已有文字标签的设置行 */
    iconOnly?: boolean
  }>(),
  { iconOnly: false },
)

const inputRef = ref<HTMLInputElement>()
const dashboardSettingsDialogShow = ref(false)
const isStorageSubmitting = ref(false)
const showSyncSettings = computed(() => can('syncSettings'))

const { showTip } = useTooltip()
const { t } = useI18n()

const handlerClickResetSettings = () => {
  if (!window.confirm(t('resetSettingsConfirm'))) return
  dashboardSettingsDialogShow.value = false
  resetSettings()
}

const handlerJsonUpload = () => {
  const file = inputRef.value?.files?.[0]
  // 取消选择时不该弹「正在导入」，所以提示放在拿到文件之后
  if (!file) return

  const failed = (reason: unknown) => {
    console.error('Failed to import settings from file:', reason)
    showNotification({
      content: 'importFileFailed',
      params: { file: file.name },
      type: 'alert-error',
    })
    // 不清空的话，失败后再选同一个文件不会触发 change 事件，用户看到的是「重试也没反应」
    if (inputRef.value) inputRef.value.value = ''
  }

  showNotification({
    content: 'importing',
  })

  const reader = new FileReader()

  // FileReader 是原生 DOM 回调，抛出的错误不经 Vue 的错误兜底，不自己接住就是一条静默失败
  reader.onload = () => {
    let settings: unknown

    try {
      settings = JSON.parse(reader.result as string)
    } catch (error) {
      failed(error)
      return
    }

    // 合法 JSON ≠ 合法设置：null / 数组 / 误选的内核配置都会「导入成功」却一个键都没写
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      failed(new Error(`unexpected settings shape in ${file.name}`))
      return
    }

    applyDashboardSettingsToStorage(settings as Record<string, unknown>)
    // 成功路径紧接 reload，input 随页面一起丢弃，无需清空
    location.reload()
  }
  reader.onerror = () => failed(reader.error)

  reader.readAsText(file)
}

const importSettingsFromFile = () => {
  inputRef.value?.click()
}
const importSettingsFromUrlHandler = async () => {
  dashboardSettingsDialogShow.value = false
  await importSettingsFromUrl({ force: true })
}

const handlerClickUploadSettings = async () => {
  if (isStorageSubmitting.value) return

  isStorageSubmitting.value = true
  // 弹窗一关按钮就没了,结果回来之前得有条提示顶着。
  const notifyKey = notifyActionPending('uploadSettings')
  try {
    dashboardSettingsDialogShow.value = false
    const settings = getDashboardSettingsFromStorage()
    const iconLength = JSON.stringify(settings['config/icon-reflect-list'] || []).length
    const isIconReflectListRemoved = iconLength > 800 * 1024

    if (customBackgroundURL.value.includes(LOCAL_IMAGE)) {
      delete settings['config/custom-background-image']
    }

    if (isIconReflectListRemoved) {
      delete settings['config/icon-reflect-list']
    }

    await setStorageAPI(settings)
    showNotification({
      key: notifyKey,
      content: 'uploadSettingsSuccess',
      type: 'alert-success',
    })
    if (isIconReflectListRemoved) {
      showNotification({
        content: 'uploadSettingsIconReflectListRemoved',
        type: 'alert-warning',
      })
    }
  } catch (e) {
    notifyRequestError(e, notifyKey)
  } finally {
    isStorageSubmitting.value = false
  }
}

const handlerClickSyncSettings = async () => {
  if (isStorageSubmitting.value) return

  isStorageSubmitting.value = true
  const notifyKey = notifyActionPending('syncSettings')
  try {
    dashboardSettingsDialogShow.value = false
    await syncSettingsFromCore({
      force: true,
      notify: true,
    })
    // 同步自己会弹成功提示(或因无变化/用户取消而什么都不做),这里只负责收掉「执行中」。
    dismissNotification(notifyKey)
  } catch (e) {
    notifyRequestError(e, notifyKey)
  } finally {
    isStorageSubmitting.value = false
  }
}

const handlerClickDeleteUploadedSettings = async () => {
  if (isStorageSubmitting.value) return
  if (!window.confirm(t('deleteUploadedSettingsConfirm'))) return

  isStorageSubmitting.value = true
  const notifyKey = notifyActionPending('deleteUploadedSettings')
  try {
    await deleteStorageAPI()
    dashboardSettingsDialogShow.value = false
    showNotification({
      key: notifyKey,
      content: 'deleteUploadedSettingsSuccess',
      type: 'alert-success',
    })
  } catch (e) {
    notifyRequestError(e, notifyKey)
  } finally {
    isStorageSubmitting.value = false
  }
}

// 用户刚打开「自动同步」开关,等同于一次手动同步,失败要说明原因。
watch(autoSyncSettings, async (value, oldValue) => {
  if (!value || oldValue || isStorageSubmitting.value) return

  isStorageSubmitting.value = true
  try {
    dashboardSettingsDialogShow.value = false
    await syncSettingsFromCore()
  } catch (e) {
    notifyRequestError(e)
  } finally {
    isStorageSubmitting.value = false
  }
})
</script>
