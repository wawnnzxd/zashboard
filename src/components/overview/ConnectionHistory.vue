<template>
  <div class="flex w-full flex-col">
    <div class="base-container w-full rounded-b-none!">
      <!-- Header -->
      <div
        class="flex items-center justify-between p-4 max-sm:flex-col max-sm:items-start max-sm:gap-2"
      >
        <div
          class="text-base-content/60 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase"
        >
          {{ $t('totalConnections') }}
          <button
            class="btn btn-ghost btn-xs btn-circle"
            @click="showClearDialog = true"
          >
            <TrashIcon class="h-3.5 w-3.5" />
          </button>
          <QuestionMarkCircleIcon
            class="h-3.5 w-3.5 cursor-pointer"
            @mouseenter="showTip($event, totalConnectionsTip)"
          />
        </div>
        <!-- v-memo: avoid re-rendering the selects on every connection poll (flicker on firefox) -->
        <div
          v-memo="[aggregationType, autoCleanupInterval, locale]"
          class="flex items-center gap-2 max-sm:flex-col max-sm:items-start"
        >
          <div class="flex items-center gap-2">
            <span class="text-base-content/60 text-xs">{{ $t('aggregateBy') }}</span>
            <SelectInput
              v-model="aggregationType"
              class="select select-bordered select-sm w-32"
              :options="[
                { value: ConnectionHistoryType.SourceIP, label: $t('aggregateBySourceIP') },
                {
                  value: ConnectionHistoryType.Destination,
                  label: $t('aggregateByDestination'),
                },
                { value: ConnectionHistoryType.Process, label: $t('aggregateByProcess') },
                { value: ConnectionHistoryType.Outbound, label: $t('aggregateByOutbound') },
                { value: ConnectionHistoryType.ProxyGroup, label: $t('aggregateByProxyGroup') },
              ]"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="text-base-content/60 text-xs">{{ $t('autoCleanupInterval') }}</span>
            <SelectInput
              v-model="autoCleanupInterval"
              class="select select-bordered select-sm w-28"
              :options="[
                { value: AutoCleanupInterval.Never, label: $t('autoCleanupIntervalNever') },
                { value: AutoCleanupInterval.Week, label: $t('autoCleanupIntervalWeek') },
                { value: AutoCleanupInterval.Month, label: $t('autoCleanupIntervalMonth') },
                { value: AutoCleanupInterval.Quarter, label: $t('autoCleanupIntervalQuarter') },
              ]"
            />
          </div>
        </div>
      </div>
      <!-- Stats grid -->
      <div class="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-5">
        <div class="bg-base-200/30 flex flex-col gap-1.5 rounded-xl p-4">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ aggregateSourceLabel }}
          </div>
          <div class="text-2xl font-extralight tabular-nums">{{ aggregateSourceCount }}</div>
        </div>
        <div class="bg-base-200/30 flex flex-col gap-1.5 rounded-xl p-4">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ t('totalTraffic') }}
          </div>
          <div class="text-2xl font-extralight tabular-nums">
            {{ prettyBytesHelper(totalStats.download + totalStats.upload) }}
          </div>
        </div>
        <div class="bg-base-200/30 flex flex-col gap-1.5 rounded-xl p-4">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ t('download') }}
          </div>
          <div class="text-2xl font-extralight tabular-nums">
            {{ prettyBytesHelper(totalStats.download) }}
          </div>
        </div>
        <div class="bg-base-200/30 flex flex-col gap-1.5 rounded-xl p-4">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ t('upload') }}
          </div>
          <div class="text-2xl font-extralight tabular-nums">
            {{ prettyBytesHelper(totalStats.upload) }}
          </div>
        </div>
        <div class="bg-base-200/30 flex flex-col gap-1.5 rounded-xl p-4">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ t('connectionCount') }}
          </div>
          <div class="text-2xl font-extralight tabular-nums">{{ totalStats.count }}</div>
        </div>
      </div>
    </div>
    <!-- VirtualTable 自带独立的 base-container，与上方统计区域保持同级透明层 -->
    <div class="h-96">
      <VirtualTable
        class="m-0! rounded-t-none!"
        :data="aggregatedData"
        :columns="columns"
        sorting-key="cache/connection-history-sorting"
        :initial-sorting="[{ id: 'download', desc: true }]"
        :estimate-size="36"
      />
    </div>
    <DialogWrapper
      v-model="showClearDialog"
      :title="$t('clearConnectionHistory')"
    >
      <div class="flex flex-col gap-4 p-2">
        <p class="text-sm">
          {{ $t('clearConnectionHistoryConfirm') }}
        </p>
        <div class="flex justify-end gap-2">
          <button
            class="btn btn-sm"
            @click="showClearDialog = false"
          >
            {{ $t('cancel') }}
          </button>
          <button
            class="btn btn-error btn-sm"
            @click="handleClearHistory"
          >
            {{ $t('confirm') }}
          </button>
        </div>
      </div>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import { ConnectionHistoryType } from '@/helper/indexeddb'
import SelectInput from '@/components/common/SelectInput.vue'
import { showNotification } from '@/helper/notification'
import { getIPLabelFromMap } from '@/helper/sourceip'
import { useStorage } from '@/helper/storage'
import { useTooltip } from '@/helper/tooltip'
import { prettyBytesHelper } from '@/helper/utils'
import VirtualTable from '@/components/common/VirtualTable.vue'
import {
  AutoCleanupInterval,
  aggregateConnections,
  aggregatedDataMap,
  autoCleanupInterval,
  clearConnectionHistory,
  historyStartTime,
  mergeAggregatedData,
} from '@/store/connHistory'
import { activeConnections } from '@/store/connections'
import { refThrottled } from '@vueuse/core'
import { QuestionMarkCircleIcon, TrashIcon } from '@heroicons/vue/24/outline'
import type { ColumnDef } from '@tanstack/vue-table'
import dayjs from 'dayjs'
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DialogWrapper from '../common/DialogWrapper.vue'
import ProxyName from '../proxies/ProxyName.vue'

const { t, locale } = useI18n()
const { showTip } = useTooltip()

interface ConnectionHistoryData {
  key: string
  download: number
  upload: number
  count: number
}

const aggregationType = useStorage<ConnectionHistoryType>(
  'cache/connection-history-aggregation-type',
  ConnectionHistoryType.SourceIP,
)
const historicalData = computed(() => aggregatedDataMap.value[aggregationType.value])
// 活跃连接以 3s 节流参与聚合:该表数据秒级抖动无意义,却每拍带动全量聚合 + merge + 表格重排
const throttledActiveConnections = refThrottled(activeConnections, 3000)

const aggregatedData = computed<ConnectionHistoryData[]>(() => {
  const currentData = aggregateConnections(throttledActiveConnections.value, aggregationType.value)

  return mergeAggregatedData(historicalData.value, currentData)
})

const totalStats = computed(() => {
  return aggregatedData.value.reduce(
    (acc, item) => {
      acc.download += item.download
      acc.upload += item.upload
      acc.count += item.count
      return acc
    },
    { download: 0, upload: 0, count: 0 },
  )
})

const aggregateSourceCount = computed(() => aggregatedData.value.length)

const aggregateSourceLabel = computed(() => {
  if (aggregationType.value === ConnectionHistoryType.SourceIP) {
    return t('sourceIP')
  } else if (aggregationType.value === ConnectionHistoryType.Destination) {
    return t('host')
  } else if (aggregationType.value === ConnectionHistoryType.Process) {
    return t('process')
  } else if (aggregationType.value === ConnectionHistoryType.ProxyGroup) {
    return t('proxyGroup')
  } else {
    return t('outbound')
  }
})

const columns = computed<ColumnDef<ConnectionHistoryData>[]>(() => {
  const keyColumn: ColumnDef<ConnectionHistoryData> = {
    header: () => aggregateSourceLabel.value,
    id: 'key',
    accessorFn: (row) => row.key,
    cell: ({ row }) => {
      if (aggregationType.value === ConnectionHistoryType.SourceIP) {
        return getIPLabelFromMap(row.original.key)
      } else if (aggregationType.value === ConnectionHistoryType.Destination) {
        return row.original.key
      } else if (aggregationType.value === ConnectionHistoryType.Process) {
        return row.original.key
      } else {
        return h(ProxyName, { name: row.original.key })
      }
    },
  }

  return [
    keyColumn,
    {
      header: () => t('download'),
      id: 'download',
      accessorFn: (row) => row.download,
      cell: ({ row }) => prettyBytesHelper(row.original.download),
      sortingFn: (prev, next) => prev.original.download - next.original.download,
      sortDescFirst: true,
    },
    {
      header: () => t('upload'),
      id: 'upload',
      accessorFn: (row) => row.upload,
      cell: ({ row }) => prettyBytesHelper(row.original.upload),
      sortingFn: (prev, next) => prev.original.upload - next.original.upload,
      sortDescFirst: true,
    },
    {
      header: () => t('totalTraffic'),
      id: 'total',
      accessorFn: (row) => row.download + row.upload,
      cell: ({ row }) => prettyBytesHelper(row.original.download + row.original.upload),
      sortingFn: (prev, next) =>
        prev.original.download +
        prev.original.upload -
        (next.original.download + next.original.upload),
      sortDescFirst: true,
    },
    {
      header: () => t('connectionCount'),
      id: 'count',
      accessorFn: (row) => row.count,
      cell: ({ row }) => row.original.count.toString(),
      sortingFn: (prev, next) => prev.original.count - next.original.count,
      sortDescFirst: true,
    },
  ]
})

const showClearDialog = ref(false)
const totalConnectionsTip = computed(() => {
  const dayjsTime = dayjs(historyStartTime.value)

  return t('totalConnectionsTip', {
    statsStartTime: `${dayjsTime.format('YYYY-MM-DD HH:mm')} (${dayjsTime.fromNow()})`,
  })
})
const handleClearHistory = async () => {
  try {
    await clearConnectionHistory()
    historyStartTime.value = Date.now()
    showClearDialog.value = false
    showNotification({
      content: t('clearConnectionHistorySuccess'),
      type: 'alert-success',
    })
  } catch (error) {
    console.error('Failed to clear connection history:', error)
    showNotification({
      content: `${t('saveFailed')}: ${error}`,
      type: 'alert-error',
    })
  }
}
</script>
