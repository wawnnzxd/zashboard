<template>
  <div
    class="relative w-full overflow-hidden"
    :class="xAxisMode === 'seconds' ? 'h-36' : 'h-28'"
    data-page-swipe-ignore
  >
    <div
      ref="chartRef"
      class="h-full w-full"
    />
    <button
      v-if="showPauseButton"
      class="btn btn-ghost btn-xs absolute right-1 bottom-0"
      @click="isPaused = !isPaused"
    >
      <component
        :is="isPaused ? PlayCircleIcon : PauseCircleIcon"
        class="h-4 w-4"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
import { echarts, useChartTheme, useEChart, type EChartOption } from '@/composables/useEChart'
import { PauseCircleIcon, PlayCircleIcon } from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import type { ChartSeries, ChartTooltipParam } from './chartTypes'
import { getChartPointValue } from './chartTypes'

const props = withDefaults(
  defineProps<{
    data: ChartSeries[]
    labelFormatter: (value: number) => string
    tooltipFormatter: (value: ChartTooltipParam[]) => string
    yAxisFloor?: number
    xAxisMode?: 'time' | 'seconds'
    windowSeconds?: number
    showPauseButton?: boolean
  }>(),
  {
    xAxisMode: 'time',
    windowSeconds: 20,
    showPauseButton: true,
  },
)

const chartRef = ref<HTMLElement>()
const isPaused = ref(false)
const { colors, fontFamily } = useChartTheme(chartRef)

// 静态骨架只随系列名集合变化;data 数组每拍换新引用,用 prev 保持返回值引用稳定,
// 避免把整份静态 option 拖回每秒重算(那会退化成每拍全量 setOption)
const seriesNames = computed<string[]>((prev) => {
  const names = props.data.map((item) => item.name)

  if (prev && prev.length === names.length && names.every((name, index) => name === prev[index])) {
    return prev
  }
  return names
})

// 布局/样式/渐变等静态骨架:仅初始化与主题/字体/系列结构变化时下发
const options = computed<EChartOption>(() => {
  const isSeconds = props.xAxisMode === 'seconds'

  return {
    animationDurationUpdate: 1000,
    animationEasingUpdate: 'linear',
    legend: {
      bottom: 0,
      data: seriesNames.value,
      textStyle: {
        color: colors.text,
        fontFamily: fontFamily.value,
        fontSize: 10,
      },
    },
    grid: isSeconds
      ? { left: 8, top: 15, right: 8, bottom: 40, containLabel: true }
      : { left: 50, top: 15, right: 8, bottom: 25 },
    tooltip: {
      show: true,
      trigger: 'axis',
      backgroundColor: colors.surface,
      borderColor: colors.surface,
      borderRadius: 8,
      confine: true,
      padding: [0, 3],
      textStyle: {
        color: colors.text,
        fontFamily: fontFamily.value,
        fontSize: 11,
      },
      formatter: props.tooltipFormatter,
    },
    xAxis: isSeconds
      ? {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: {
            show: true,
            color: colors.text,
            fontFamily: fontFamily.value,
            fontSize: 10,
            formatter: (value: number) => (value < 0 ? '' : `${Math.round(value)} s`),
          },
        }
      : {
          type: 'time',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
        },
    yAxis: {
      type: 'value',
      splitNumber: 4,
      min: 0,
      max:
        props.yAxisFloor === undefined
          ? undefined
          : (value: { max: number }) => Math.max(value.max, props.yAxisFloor!),
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: {
        show: true,
        lineStyle: {
          type: 'dashed',
          color: colors.grid,
        },
      },
      axisLabel: {
        formatter: props.labelFormatter,
        color: colors.text,
        fontFamily: fontFamily.value,
        fontSize: 10,
        ...(isSeconds ? {} : { align: 'left', padding: [0, 0, 0, -35] }),
      },
    },
    // 骨架按稳定的系列名构建,不读 props.data:后者每拍换引用,骨架会跟着全量重建。
    series: seriesNames.value.map((name, index) => {
      const isLast = index === seriesNames.value.length - 1
      const lineColor = isLast ? colors.seriesPrimary : colors.seriesSecondary
      const areaColor = isLast ? colors.seriesPrimaryMuted : colors.seriesSecondaryMuted

      return {
        name,
        type: 'line',
        symbol: 'none',
        smooth: true,
        color: lineColor,
        emphasis: { disabled: true },
        lineStyle: { width: 1 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: lineColor },
            { offset: 1, color: areaColor },
          ]),
        },
      }
    }),
  }
})

// 每拍只推各系列数据与轴时间窗;时间窗锚定最新数据点,保证最新点钉在右缘,
// 缓冲点落在左缘外被 clip 裁掉
const dataOptions = computed<EChartOption>(() => {
  const isSeconds = props.xAxisMode === 'seconds'
  const lastPoint = props.data[0]?.data.at(-1)
  const latest = lastPoint ? getChartPointValue(lastPoint)[0] : isSeconds ? 0 : Date.now()

  return {
    xAxis: isSeconds
      ? { min: latest - props.windowSeconds, max: latest }
      : { min: latest - (props.windowSeconds - 1) * 1000, max: latest - 1000 },
    series: props.data.map((item) => ({ data: item.data })),
  }
})

useEChart(chartRef, options, { paused: isPaused, dataOptions })
</script>
