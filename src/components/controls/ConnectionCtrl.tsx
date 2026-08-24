import { disconnectConnections } from '@/assembly/connections'
import { useCtrlsBar } from '@/composables/useCtrlsBar'
import {
  CONNECTION_TAB_TYPE,
  ROUTE_NAME,
  SETTINGS_MENU_KEY,
  SORT_DIRECTION,
  SORT_TYPE,
} from '@/constant'
import { useTooltip } from '@/helper/tooltip'
import {
  activeConnections,
  connectionFilter,
  connectionSortDirection,
  connectionSortType,
  connectionTabShow,
  isClosedConnection,
  isPaused,
  quickFilterEnabled,
  quickFilterRegex,
  renderConnections,
} from '@/store/connections'
import { isConnectionCard } from '@/store/settings'
import {
  BarsArrowDownIcon,
  BarsArrowUpIcon,
  LinkIcon,
  LinkSlashIcon,
  PauseIcon,
  PlayIcon,
  QuestionMarkCircleIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { defineComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import CtrlsBar from '../common/CtrlsBar.vue'
import DialogWrapper from '../common/DialogWrapper.vue'
import SelectInput from '../common/SelectInput.vue'
import TextInput from '../common/TextInput.vue'
import ConnectionCardSettings from '../settings/connections/ConnectionCardSettings.vue'
import TableSettings from '../settings/connections/TableSettings.vue'
import ConnectionTabs from './ConnectionTabs.vue'
import SourceIPFilter from './SourceIPFilter.vue'

const handlerClickCloseAll = () => {
  // 「已关闭」的连接不能参与:一来对它们下手毫无意义,二来 disconnectConnections 用
  // 「目标条数 == 活跃连接总数」判定能否走批量端点 DELETE /connections,一旦把已关闭条目
  // 算进目标集,「已关闭」tab 下两个数会恰好相等,于是点这颗按钮变成断开全部活跃连接。
  const targets = renderConnections.value.filter((conn) => !isClosedConnection(conn))

  // 第二个实参的语义是「活跃连接总数」,只能用 activeConnections。connections 是随 tab
  // 变化的列表(CLOSED 返回已关闭、ALL 返回两者拼接),拿它当总数就是上面那个错配的来源。
  disconnectConnections(targets, activeConnections.value.length)
}

export default defineComponent({
  name: 'ConnectionCtrl',
  components: {
    TextInput,
    ConnectionTabs,
    SourceIPFilter,
  },
  setup() {
    const { t } = useI18n()
    const router = useRouter()
    const settingsModel = ref(false)
    const { showTip, updateTip } = useTooltip()
    const { isLargeCtrlsBar } = useCtrlsBar(() => (isConnectionCard.value ? 860 : 720))

    return () => {
      const sortForCards = (
        <div class={`join flex-1 ${isLargeCtrlsBar.value ? 'min-w-46' : ''}`}>
          <SelectInput
            class="join-item select select-sm flex-1"
            modelValue={connectionSortType.value}
            onUpdate:modelValue={(value) => (connectionSortType.value = value as SORT_TYPE)}
            options={(Object.values(SORT_TYPE) as string[]).map((value) => ({
              value,
              label: t(value) || value,
            }))}
          />
          <button
            class="btn join-item btn-sm"
            onClick={() => {
              connectionSortDirection.value =
                connectionSortDirection.value === SORT_DIRECTION.ASC
                  ? SORT_DIRECTION.DESC
                  : SORT_DIRECTION.ASC
            }}
          >
            {connectionSortDirection.value === SORT_DIRECTION.ASC ? (
              <BarsArrowUpIcon class="h-4 w-4" />
            ) : (
              <BarsArrowDownIcon class="h-4 w-4" />
            )}
          </button>
        </div>
      )

      const settingsModal = (
        <>
          <button
            class="btn btn-circle btn-sm"
            onClick={() => (settingsModel.value = true)}
          >
            <WrenchScrewdriverIcon class="h-4 w-4" />
          </button>
          <DialogWrapper
            v-model={settingsModel.value}
            title={t('connectionSettings')}
          >
            <div class="flex flex-col gap-3 text-sm">
              <div class="settings-grid">
                <div class="setting-item">
                  <div class="setting-item-label shrink-0!">{t('hideConnectionRegex')}</div>
                  <TextInput
                    class="w-32 max-w-64 flex-1"
                    v-model={quickFilterRegex.value}
                  />
                </div>
                <div class="setting-item">
                  <div class="setting-item-label flex items-center gap-2">
                    <span>{t('hideConnection')}</span>
                    <div
                      onMouseenter={(e) =>
                        showTip(e, t('hideConnectionTip'), {
                          appendTo: 'parent',
                        })
                      }
                    >
                      <QuestionMarkCircleIcon class="h-4 w-4" />
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    class="toggle"
                    v-model={quickFilterEnabled.value}
                  />
                </div>
                {isConnectionCard.value ? <ConnectionCardSettings /> : <TableSettings />}
              </div>
              <button
                class="btn btn-block"
                onClick={() => {
                  settingsModel.value = false
                  router.push({
                    name: ROUTE_NAME.settings,
                    query: { section: SETTINGS_MENU_KEY.connections },
                  })
                }}
              >
                {t('moreSettings')}
              </button>
            </div>
          </DialogWrapper>
        </>
      )

      const searchInput = (
        <TextInput
          v-model={connectionFilter.value}
          placeholder={`${t('search')} | Regex`}
          clearable={true}
          debounce={200}
          class={isLargeCtrlsBar.value ? 'w-32 max-w-80 flex-1' : 'join-item min-w-0 flex-1'}
        />
      )

      const buttons = (
        <>
          <button
            class="btn btn-circle btn-sm"
            onClick={() => {
              quickFilterEnabled.value = !quickFilterEnabled.value
              updateTip(quickFilterEnabled.value ? t('showConnection') : t('hideConnection'))
            }}
            onMouseenter={(e) =>
              showTip(e, quickFilterEnabled.value ? t('showConnection') : t('hideConnection'), {
                appendTo: 'parent',
              })
            }
          >
            {quickFilterEnabled.value ? (
              <LinkSlashIcon class="h-4 w-4" />
            ) : (
              <LinkIcon class="h-4 w-4" />
            )}
          </button>
          <button
            class="btn btn-circle btn-sm"
            onClick={() => {
              isPaused.value = !isPaused.value
            }}
          >
            {isPaused.value ? <PlayIcon class="h-4 w-4" /> : <PauseIcon class="h-4 w-4" />}
          </button>
          {/* 「已关闭」tab 下没有任何可断的目标,置灰而不是移除 —— 移除会让控制栏少一颗按钮、
              切 tab 时整条栏重新排版。这也与单条连接在该 tab 下不给关闭按钮的既有设计一致。 */}
          <button
            class="btn btn-circle btn-sm"
            disabled={connectionTabShow.value === CONNECTION_TAB_TYPE.CLOSED}
            onClick={handlerClickCloseAll}
          >
            <XMarkIcon class="h-4 w-4" />
          </button>
        </>
      )

      const content = !isLargeCtrlsBar.value ? (
        <div class="flex flex-wrap items-center gap-2 p-2">
          <div class="flex w-full items-center justify-between gap-2">
            <ConnectionTabs />
            {!isConnectionCard.value && (
              <div class="flex items-center gap-1">
                {settingsModal}
                {buttons}
              </div>
            )}
          </div>
          {isConnectionCard.value && (
            <div class="flex w-full items-center gap-2">
              {sortForCards}
              {settingsModal}
              {buttons}
            </div>
          )}
          <div class="join w-full">
            <SourceIPFilter class="join-item w-40" />
            {searchInput}
          </div>
        </div>
      ) : (
        <div class="flex items-center gap-2 p-2">
          <ConnectionTabs />
          {isConnectionCard.value && sortForCards}
          <SourceIPFilter class="w-40" />
          <div class="flex flex-1">{searchInput}</div>
          {settingsModal}
          {buttons}
        </div>
      )

      return <CtrlsBar>{content}</CtrlsBar>
    }
  },
})
