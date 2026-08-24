<template>
  <div
    :class="
      isLogTable
        ? 'relative flex size-full flex-col overflow-hidden'
        : 'relative size-full overflow-x-hidden'
    "
    :style="isLogTable ? padding : undefined"
  >
    <template v-if="isLogTable">
      <LogsCtrl />
      <LogsTable :logs="renderLogs" />
    </template>
    <VirtualScroller
      v-else
      :data="renderLogs"
      :size="44"
      :get-item-key="logItemKey"
      :min-alive-key="minAliveLogSeq"
    >
      <template v-slot:before>
        <LogsCtrl />
      </template>
      <template v-slot="{ item }: { item: LogWithSeq }">
        <LogsCard :log="item" />
      </template>
    </VirtualScroller>
  </div>
</template>

<script setup lang="ts">
import VirtualScroller from '@/components/common/VirtualScroller.vue'
import LogsCtrl from '@/components/controls/LogsCtrl.tsx'
import LogsCard from '@/components/logs/LogsCard.vue'
import LogsTable from '@/components/logs/LogsTable.vue'
import { usePaddingForViews } from '@/composables/paddingViews'
import { LIST_DISPLAY_STYLE } from '@/constant'
import { toSearchRegex } from '@/helper/search'
import { logFilter, logFilterEnabled, logFilterRegex, logTypeFilter, logs } from '@/store/logs'
import { logDisplayStyle } from '@/store/settings'
import type { LogWithSeq } from '@/types'
import { computed } from 'vue'

const isLogTable = computed(() => logDisplayStyle.value === LIST_DISPLAY_STYLE.TABLE)
const { padding } = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})

const renderLogs = computed(() => {
  let renderLogs = logs.value
  const searchRegex = toSearchRegex(logFilter.value)

  if (logFilter.value || logTypeFilter.value) {
    renderLogs = logs.value.filter((log) => {
      if (searchRegex && !searchRegex.testAny([log.payload, log.time, log.type])) {
        return false
      }

      if (
        logTypeFilter.value &&
        !(log.payload.includes(logTypeFilter.value) || log.type === logTypeFilter.value)
      ) {
        return false
      }

      return true
    })
  }

  if (logFilterEnabled.value && logFilterRegex.value) {
    const hideRegex = toSearchRegex(logFilterRegex.value)

    if (hideRegex) {
      renderLogs = renderLogs.filter((log) => {
        return !hideRegex.testAny([log.payload, log.time, log.type])
      })
    }
  }

  return renderLogs
})

// 以 seq 作虚拟行身份键:日志头部插入时 index 键会让全部可见行错位重渲染,
// seq 稳定后未变行 props 恒等,每次 flush 只渲染新增行
// 尺寸缓存的存活下界必须取自**未过滤**的 logs:用 renderLogs(已过滤)会把仍在缓冲区、
// 只是当前被过滤掉的行的测量值一并删掉,清空过滤词那一瞬间整屏行高跳变。
// logs 是最新在前,所以最小 seq 在数组末尾。
const minAliveLogSeq = computed(() => logs.value[logs.value.length - 1]?.seq)

const logItemKey = (index: number) => renderLogs.value[index]?.seq ?? index
</script>
