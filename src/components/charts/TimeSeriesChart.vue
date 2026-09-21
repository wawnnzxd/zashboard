<template>
  <div
    class="flex flex-col overflow-hidden"
    data-page-swipe-ignore
  >
    <div class="flex min-w-0 items-center gap-2 px-3 pt-2 pb-0.5">
      <span class="text-base-content/70 min-w-0 flex-1 truncate text-[11px] leading-4 font-medium">
        {{ title }}
      </span>
      <span
        v-if="legend.length"
        class="text-base-content/70 flex min-w-0 items-center gap-2.5 text-[10px] leading-4"
      >
        <span
          v-for="item in legend"
          :key="item.name"
          class="flex min-w-0 items-center gap-1 truncate"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :style="{ backgroundColor: item.color }"
          />
          {{ item.name }}
        </span>
      </span>
      <button
        v-if="showPauseButton"
        class="sidebar-chart-pause text-base-content/45 flex size-4 flex-none items-center justify-center rounded transition-opacity duration-150 outline-none"
        :aria-pressed="isPaused"
        :aria-label="title"
        @click="isPaused = !isPaused"
      >
        <component
          :is="isPaused ? PlayCircleIcon : PauseCircleIcon"
          class="size-3.5"
        />
      </button>
    </div>
    <div
      ref="chartRef"
      class="min-h-0 w-full flex-1"
    />
  </div>
</template>

<script setup lang="ts">
import { echarts, useChartTheme, useEChart, type EChartOption } from '@/composables/use-echart'
import { PauseCircleIcon, PlayCircleIcon } from '@heroicons/vue/24/outline'
import { computed, ref } from 'vue'
import type { ChartSeries, ChartTooltipParam } from './chart-types'
import { getChartPointValue } from './chart-types'

const props = withDefaults(
  defineProps<{
    title: string
    data: ChartSeries[]
    labelFormatter: (value: number) => string
    tooltipFormatter: (value: ChartTooltipParam[]) => string
    yAxisFloor?: number
    windowSeconds?: number
    showPauseButton?: boolean
  }>(),
  {
    windowSeconds: 20,
    showPauseButton: true,
  },
)

const chartRef = ref<HTMLElement>()
const isPaused = ref(false)
const { colors, fontFamily } = useChartTheme(chartRef)

// 静态骨架只随系列名集合变化;data 数组每拍换新引用,用 prev 保持返回值引用稳定,
// 避免把整份静态 option(以及头部的图例)拖回每秒重算 —— 那会退化成每拍全量 setOption。
const seriesNames = computed<string[]>((prev) => {
  const names = props.data.map((item) => item.name)

  if (prev && prev.length === names.length && names.every((name, index) => name === prev[index])) {
    return prev
  }
  return names
})

// 最后一条是主角,用主色;其余用次色。图例的点要和线条同色,所以这条规则得共用。
// 按稳定的系列名数,不读 props.data:后者每拍换引用。
const colorOf = (index: number) =>
  index === seriesNames.value.length - 1
    ? { line: colors.seriesPrimary, area: colors.seriesPrimaryMuted }
    : { line: colors.seriesSecondary, area: colors.seriesSecondaryMuted }

const legend = computed(() =>
  seriesNames.value.length > 1
    ? seriesNames.value.map((name, index) => ({ name, color: colorOf(index).line }))
    : [],
)

// 布局/样式/渐变等静态骨架:仅初始化与主题/字体/系列结构变化时下发
const options = computed<EChartOption>(() => ({
  animationDurationUpdate: 1000,
  animationEasingUpdate: 'linear',
  // 头部已经占掉了标题的位置,四周只留够刻度文字的量,让走势铺满剩下的地方。
  grid: { left: 42, top: 12, right: 10, bottom: 8 },
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
  xAxis: {
    type: 'time',
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { show: false },
  },
  yAxis: {
    type: 'value',
    // 只切三段:侧边栏这点高度里,再多几条线和几个数字就只剩噪声了。
    splitNumber: 3,
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
      // 底部那个 0 是废话,藏掉;其余刻度右对齐贴着轴,左边留一条窄槽就够。
      showMinLabel: false,
      align: 'right',
      margin: 8,
      formatter: props.labelFormatter,
      color: colors.textMuted,
      fontFamily: fontFamily.value,
      fontSize: 9,
    },
  },
  series: seriesNames.value.map((name, index) => {
    const { line: lineColor, area: areaColor } = colorOf(index)

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
}))

// 每拍只推各系列数据与轴时间窗;时间窗锚定最新数据点,保证最新点钉在右缘,
// 缓冲点落在左缘外被 clip 裁掉
const dataOptions = computed<EChartOption>(() => {
  const lastPoint = props.data[0]?.data.at(-1)
  const latest = lastPoint ? getChartPointValue(lastPoint)[0] : Date.now()

  return {
    xAxis: { min: latest - (props.windowSeconds - 1) * 1000, max: latest - 1000 },
    series: props.data.map((item) => ({ data: item.data })),
  }
})

useEChart(chartRef, options, { paused: isPaused, dataOptions })
</script>

<style scoped>
@media (hover: hover) {
  .sidebar-chart-pause {
    opacity: 0;
  }

  .sidebar-chart-row:hover .sidebar-chart-pause {
    opacity: 1;
  }

  .sidebar-chart-pause:hover {
    color: var(--color-base-content);
  }
}

.sidebar-chart-pause:focus-visible,
.sidebar-chart-pause[aria-pressed='true'] {
  opacity: 1;
}
</style>
