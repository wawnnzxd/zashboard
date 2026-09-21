<template>
  <TimeSeriesChart
    :title="$t('connections')"
    :data="chartsData"
    :label-formatter="labelFormatter"
    :tooltip-formatter="tooltipFormatter"
    :y-axis-floor="100"
    :window-seconds="timeSaved"
  />
</template>

<script setup lang="ts">
import { connectionsHistory, timeSaved } from '@/assembly/overview'
import { formatTimeSeriesTooltipParam } from '@/components/charts/chart-tooltip'
import type { ChartTooltipParam } from '@/components/charts/chart-types'
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
      name: t('connections'),
      data: connectionsHistory.value,
    },
  ]
})

const labelFormatter = (value: number) => String(value)
const tooltipFormatter = (value: ChartTooltipParam[]) => {
  return value.map((item) => formatTimeSeriesTooltipParam(item, String)).join('\n')
}
</script>
