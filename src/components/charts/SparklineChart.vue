<template>
  <div
    class="relative h-full w-full overflow-hidden"
    data-page-swipe-ignore
  >
    <div
      ref="chartRef"
      class="h-full w-full"
    />
  </div>
</template>

<script setup lang="ts">
import { echarts, useChartTheme, useEChart, type EChartOption } from '@/composables/useEChart'
import { computed, ref } from 'vue'
import type { ChartPoint, ChartTooltipParam } from './chartTypes'
import { getChartPointValue } from './chartTypes'

const props = withDefaults(
  defineProps<{
    data: ChartPoint[]
    yAxisFloor?: number
    color?: 'primary' | 'info'
    name?: string
    windowSeconds?: number
    labelFormatter?: (value: number) => string
    tooltipFormatter?: (value: ChartTooltipParam[]) => string
  }>(),
  {
    yAxisFloor: 1,
    color: 'primary',
    windowSeconds: 60,
  },
)

const chartRef = ref<HTMLElement>()
const { colors, fontFamily } = useChartTheme(chartRef)

// 静态骨架:仅初始化与主题/字体变化时下发;每拍数据走下方 dataOptions
const options = computed<EChartOption>(() => {
  const lineColor = props.color === 'info' ? colors.info60 : colors.primary60
  const areaColor = props.color === 'info' ? colors.info30 : colors.primary30

  return {
    animationDurationUpdate: 1000,
    animationEasingUpdate: 'linear',
    grid: { left: 0, top: 0, right: props.labelFormatter ? 30 : 0, bottom: 0 },
    tooltip: props.tooltipFormatter
      ? {
          show: true,
          trigger: 'axis',
          backgroundColor: colors.base70,
          borderColor: colors.base70,
          confine: true,
          padding: [0, 5],
          textStyle: {
            color: colors.baseContent,
            fontFamily: fontFamily.value,
            fontSize: 11,
          },
          formatter: props.tooltipFormatter,
        }
      : { show: false },
    xAxis: {
      type: 'time',
      show: false,
    },
    yAxis: {
      type: 'value',
      show: true,
      position: 'right',
      splitNumber: 2,
      min: 0,
      max: (value: { max: number }) => Math.max(value.max, props.yAxisFloor),
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: props.labelFormatter
        ? {
            show: true,
            inside: false,
            fontSize: 9,
            color: colors.baseContent60,
            fontFamily: fontFamily.value,
            margin: 4,
            formatter: (value: number) => (value === 0 ? '' : props.labelFormatter!(value)),
          }
        : { show: false },
    },
    series: [
      {
        type: 'line',
        name: props.name,
        symbol: 'none',
        smooth: true,
        lineStyle: { width: 1.5 },
        color: lineColor,
        emphasis: { disabled: true },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: lineColor },
            { offset: 1, color: areaColor },
          ]),
        },
      },
    ],
  }
})

// 每拍只推数据与时间窗;时间窗锚定最新数据点,保证最新点钉在右缘,
// 缓冲点落在左缘外被 clip 裁掉
const dataOptions = computed<EChartOption>(() => {
  const latestPoint = props.data.at(-1)
  const latest = latestPoint ? getChartPointValue(latestPoint)[0] : Date.now()

  return {
    xAxis: {
      min: latest - (props.windowSeconds - 1) * 1000,
      max: latest - 1000,
    },
    series: [{ data: props.data }],
  }
})

useEChart(chartRef, options, { dataOptions })
</script>
