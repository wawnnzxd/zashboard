<template>
  <div
    class="bg-base-200/50 h-full w-full items-center justify-center overflow-auto sm:flex"
    @keydown.enter="handleSubmit(form)"
  >
    <div class="absolute top-4 right-4 max-sm:hidden">
      <DashboardSettings />
    </div>
    <div class="absolute right-4 bottom-4 max-sm:hidden">
      <LanguageSelect />
    </div>
    <div
      class="border-base-border bg-base-100 mx-auto flex w-96 max-w-[90%] flex-col gap-3 rounded-xl border px-6 py-5 shadow-none max-sm:my-4"
    >
      <h1 class="mb-1 text-lg">{{ $t('setup') }}</h1>

      <div class="flex flex-col gap-1">
        <label class="text-sm">{{ $t('backendType') }}</label>
        <div class="join w-full">
          <button
            class="btn btn-sm join-item flex-1"
            :class="form.type === 'clash' ? 'btn-primary' : 'border-base-border border'"
            @click="form.type = 'clash'"
          >
            {{ $t('clashApi') }}
          </button>
          <button
            class="btn btn-sm join-item flex-1"
            :class="form.type === 'singbox' ? 'btn-primary' : 'border-base-border border'"
            @click="form.type = 'singbox'"
          >
            {{ $t('singboxApi') }}
          </button>
        </div>
      </div>

      <div class="flex gap-2">
        <div class="flex w-24 flex-none flex-col gap-1">
          <label class="text-sm">{{ $t('protocol') }}</label>
          <select
            class="select select-sm w-full"
            v-model="form.protocol"
          >
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="text-sm">{{ $t('host') }}</label>
          <TextInput
            class="w-full"
            name="username"
            autocomplete="username"
            v-model="form.host"
          />
        </div>
        <div class="flex w-20 flex-none flex-col gap-1">
          <label class="text-sm">{{ $t('port') }}</label>
          <TextInput
            class="w-full"
            v-model="form.port"
          />
        </div>
      </div>

      <div class="flex gap-2">
        <div
          v-if="form.type === 'clash'"
          class="flex min-w-0 flex-1 flex-col gap-1"
        >
          <label class="flex items-center gap-1 text-sm">
            <span class="truncate">{{ $t('secondaryPath') }} ({{ $t('optional') }})</span>
            <span
              class="tooltip flex-none"
              :data-tip="$t('secondaryPathTip')"
            >
              <QuestionMarkCircleIcon class="h-4 w-4" />
            </span>
          </label>
          <TextInput
            class="w-full"
            v-model="form.secondaryPath"
          />
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <label class="truncate text-sm">{{ $t('label') }}</label>
          <TextInput
            class="w-full"
            v-model="form.label"
          />
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm">{{ $t('password') }}</label>
        <input
          type="password"
          class="input input-sm w-full"
          v-model="form.password"
        />
      </div>

      <button
        class="btn btn-primary btn-sm w-full"
        @click="handleSubmit(form)"
      >
        {{ $t('submit') }}
      </button>

      <template v-if="backendList.length">
        <div class="text-base-content/50 mt-2 text-xs">{{ $t('backend') }}</div>
        <!-- 尺寸/滚动留在这层外壳上:Draggable 是懒 chunk,到达前它只渲染成注释占位,
             高度类若留在 Draggable 上,列表区会先塌成 0 高再弹开,带动下方的
             LanguageSelect 位移。外壳先把高度定死,chunk 到达前后布局逐像素一致。 -->
        <div class="-mr-2 flex max-h-48 flex-1 flex-col overflow-y-auto pr-2">
          <Draggable
            class="flex flex-col gap-1"
            v-model="backendList"
            group="list"
            handle=".drag-handle"
            :animation="150"
            :item-key="'uuid'"
          >
            <template #item="{ element }">
              <div
                :key="element.uuid"
                class="group hover:bg-base-200 flex items-center gap-1 rounded-lg pr-1 transition-colors"
              >
                <ChevronUpDownIcon
                  class="drag-handle text-base-content/30 ml-1 h-4 w-4 flex-none cursor-grab"
                />
                <button
                  class="min-w-0 flex-1 truncate py-1.5 text-left text-sm"
                  @click="selectBackend(element.uuid)"
                >
                  {{ getLabelFromBackend(element) }}
                </button>
                <button
                  class="btn btn-circle btn-ghost btn-xs text-base-content/40 hover:text-base-content opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  @click="editBackend(element)"
                >
                  <PencilIcon class="h-4 w-4" />
                </button>
                <button
                  class="btn btn-circle btn-ghost btn-xs text-base-content/40 hover:text-error opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  @click="removeBackend(element.uuid)"
                >
                  <TrashIcon class="h-4 w-4" />
                </button>
              </div>
            </template>
          </Draggable>
        </div>
      </template>

      <div class="mt-4 sm:hidden">
        <LanguageSelect />
      </div>
      <div class="absolute top-2 right-2 sm:hidden">
        <DashboardSettings />
      </div>
    </div>

    <EditBackendModal
      v-model="showEditModal"
      :default-backend-uuid="editingBackendUuid"
    />
  </div>
</template>

<script setup lang="ts">
import { isBackendAvailable, isSingboxChannelAvailable } from '@/assembly/backend'
import DashboardSettings from '@/components/common/DashboardSettings.vue'
import TextInput from '@/components/common/TextInput.vue'
import EditBackendModal from '@/components/settings/backend/EditBackendModal.vue'
import LanguageSelect from '@/components/settings/general/LanguageSelect.vue'
import { ROUTE_NAME } from '@/constant'
import { syncSettingsFromCore } from '@/helper/autoImportSettings'
import { showNotification } from '@/helper/notification'
import { getBackendFromUrl, getLabelFromBackend } from '@/helper/utils'
import router from '@/router'
import { activeUuid, addBackend, backendList, removeBackend } from '@/store/setup'
import type { Backend, BackendType } from '@/types'
import {
  ChevronUpDownIcon,
  PencilIcon,
  QuestionMarkCircleIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { defineAsyncComponent, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

// vuedraggable(CJS,还拖着 sortablejs 与 Vue 完整版/模板编译器)只有这一处后端
// 排序用到,而已配好后端的用户永远不会再进 /setup。SetupPage 本身是同步路由,
// 静态引入等于把这条边整个拉回首屏 entry,抵消 ProxiesPage 已做的异步化。
const Draggable = defineAsyncComponent(() => import('vuedraggable'))

const { t } = useI18n()

const form = reactive({
  type: 'clash' as BackendType,
  protocol: 'http',
  host: '127.0.0.1',
  port: '9090',
  secondaryPath: '',
  password: '',
  label: '',
})

const showEditModal = ref(false)
const editingBackendUuid = ref('')
const isManualSetupRoute = () => router.currentRoute.value.query.setupMode === 'manual'
const isEditBackendRoute = () => typeof router.currentRoute.value.query.editBackend === 'string'

watch(
  () => router.currentRoute.value.query.editBackend,
  (backendUuid) => {
    if (backendUuid && typeof backendUuid === 'string') {
      editingBackendUuid.value = backendUuid
      showEditModal.value = true
      router.replace({ query: {} })
    }
  },
  { immediate: true },
)

const selectBackend = (uuid: string) => {
  activeUuid.value = uuid
  router.push({ name: ROUTE_NAME.proxies })
}

const editBackend = (backend: Backend) => {
  editingBackendUuid.value = backend.uuid
  showEditModal.value = true
}

type SetupForm = Omit<Backend, 'uuid'>

const finishLogin = async () => {
  try {
    const synced = await syncSettingsFromCore()
    if (synced) return
  } catch (error) {
    console.error('Failed to sync settings after login:', error)
  }
  router.push({ name: ROUTE_NAME.proxies })
}

const handleSubmit = async (setupForm: SetupForm, quiet = false) => {
  const { protocol, host, port } = setupForm

  if (!protocol || !host || !port) {
    if (!quiet) alert('Please fill in all the fields.')
    return
  }

  if (
    window.location.protocol === 'https:' &&
    protocol === 'http' &&
    !['::1', '0.0.0.0', '127.0.0.1', 'localhost'].includes(host) &&
    !quiet
  ) {
    showNotification({ content: 'protocolTips' })
  }

  const candidate: Backend = { uuid: '', ...setupForm }

  try {
    if (setupForm.type === 'singbox') {
      if (!(await isSingboxChannelAvailable(candidate, 10000))) {
        if (!quiet) alert(t('singboxConnectionFailed'))
        return
      }
    } else {
      if (!(await isBackendAvailable(candidate, 10000))) {
        if (!quiet) alert(t('backendConnectionFailed'))
        return
      }
    }

    addBackend(setupForm)
    await finishLogin()
  } catch (error) {
    if (!quiet) alert(error)
  }
}

const backend = isManualSetupRoute() || isEditBackendRoute() ? null : getBackendFromUrl()

if (backend) {
  handleSubmit(backend)
} else if (backendList.value.length === 0) {
  handleSubmit(form, true)
}
</script>
