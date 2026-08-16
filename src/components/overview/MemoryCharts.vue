<template>
  <TimeSeriesChart
    :data="chartsData"
    :label-formatter="labelFormatter"
    :tooltip-formatter="tooltipFormatter"
    :y-axis-floor="100 * 1024 * 1024"
    :window-seconds="timeSaved"
  />
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'

// echarts 经「侧栏常驻图表」同步链进 entry(573KB raw):组件层异步化才能把它切出去
const TimeSeriesChart = defineAsyncComponent(
  () => import('@/components/charts/TimeSeriesChart.vue'),
)
import { formatHistoryTooltipParam } from '@/components/charts/chartTooltip'
import type { ChartTooltipParam } from '@/components/charts/chartTypes'
import { prettyBytesHelper } from '@/helper/utils'
import { memoryHistory, timeSaved } from '@/store/overview'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const chartsData = computed(() => {
  return [
    {
      name: t('memoryUsage'),
      data: memoryHistory.value,
    },
  ]
})

const labelFormatter = (value: number) => {
  return `${prettyBytesHelper(value, {
    maximumFractionDigits: 0,
    binary: true,
  })}`
}
const tooltipFormatter = (value: ChartTooltipParam[]) => {
  return value.map((item) => formatHistoryTooltipParam(item, { binary: true })).join('')
}
</script>
