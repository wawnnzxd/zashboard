<template>
  <TimeSeriesChart
    :title="$t('traffic')"
    :data="chartsData"
    :label-formatter="labelFormatter"
    :tooltip-formatter="tooltipFormatter"
    :y-axis-floor="60 * 1000"
    :window-seconds="timeSaved"
  />
</template>

<script setup lang="ts">
import { downloadSpeedHistory, timeSaved, uploadSpeedHistory } from '@/assembly/overview'
import { formatHistoryTooltipParam } from '@/components/charts/chart-tooltip'
import type { ChartTooltipParam } from '@/components/charts/chart-types'
import { prettyBytesHelper } from '@/helper/utils'
import { computed, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

// echarts 经「侧栏常驻图表」同步链进 entry(573KB raw):组件层异步化才能把它切出去
const TimeSeriesChart = defineAsyncComponent(
  () => import('@/components/charts/TimeSeriesChart.vue'),
)

const { t } = useI18n()
const chartsData = computed(() => {
  return [
    {
      name: t('ulSpeed'),
      data: uploadSpeedHistory.value,
    },
    {
      name: t('dlSpeed'),
      data: downloadSpeedHistory.value,
    },
  ]
})

const labelFormatter = (value: number) => {
  return `${prettyBytesHelper(value, {
    maximumFractionDigits: 0,
    binary: false,
  })}/s`
}
const tooltipFormatter = (value: ChartTooltipParam[]) => {
  return value
    .map((item) => formatHistoryTooltipParam(item, { binary: false, suffix: '/s' }))
    .join('')
}
</script>
