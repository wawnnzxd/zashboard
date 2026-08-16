import { isMiddleScreen } from '@/helper/utils'
import { emoji, font, theme } from '@/store/settings'
import { useDocumentVisibility, useElementSize, useElementVisibility } from '@vueuse/core'
import { BarChart, LineChart, SankeyChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { debounce } from 'lodash-es'
import type { ComputedRef, Ref } from 'vue'
import { nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'

echarts.use([
  BarChart,
  LineChart,
  SankeyChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

export type EChart = echarts.ECharts
export type EChartOption = echarts.EChartsCoreOption

type ChartElementRef = Ref<HTMLElement | null | undefined>

export interface ChartTheme {
  primary30: string
  primary60: string
  info30: string
  info60: string
  baseContent10: string
  baseContent30: string
  baseContent60: string
  baseContent: string
  base70: string
}

const createThemeProbe = () => {
  const probe = document.createElement('span')
  probe.className =
    'border-b-primary/30 border-t-primary/60 border-l-info/30 border-r-info/60 text-base-content/10 bg-base-100/70 outline-base-content/30 decoration-base-content/60 caret-base-content'

  Object.assign(probe.style, {
    position: 'absolute',
    width: '0',
    height: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    visibility: 'hidden',
  })

  return probe
}

export const useChartTheme = (chartRef: ChartElementRef) => {
  const colors = reactive<ChartTheme>({
    primary30: '',
    primary60: '',
    info30: '',
    info60: '',
    baseContent10: '',
    baseContent30: '',
    baseContent60: '',
    baseContent: '',
    base70: '',
  })
  const fontFamily = ref('')
  let probe: HTMLSpanElement | null = null

  const update = () => {
    if (!probe) return

    const style = getComputedStyle(probe)
    colors.primary30 = style.borderBottomColor
    colors.primary60 = style.borderTopColor
    colors.info30 = style.borderLeftColor
    colors.info60 = style.borderRightColor
    colors.baseContent10 = style.color
    colors.baseContent30 = style.outlineColor
    colors.baseContent60 = style.textDecorationColor
    colors.baseContent = style.caretColor
    colors.base70 = style.backgroundColor
    fontFamily.value = style.fontFamily
  }

  onMounted(() => {
    const host = chartRef.value?.closest('#app-content') ?? chartRef.value?.parentElement
    if (!host) return

    probe = createThemeProbe()
    host.appendChild(probe)
    update()
  })

  watch([theme, font, emoji], () => nextTick(update))

  onUnmounted(() => {
    probe?.remove()
    probe = null
  })

  return { colors, fontFamily }
}

interface UseEChartOptions {
  paused?: Readonly<Ref<boolean>>
  isEmpty?: Readonly<Ref<boolean>>
  onInit?: (chart: EChart) => void | (() => void)
  // 秒级更新走这条数据通道(仅 series data / 轴时间窗),与 options 静态骨架分离:
  // 骨架只在主题/字体/系列结构变化时才全量下发,免去每拍重建整棵 option 树再全量 merge
  dataOptions?: ComputedRef<EChartOption>
}

export const useEChart = (
  chartRef: ChartElementRef,
  options: ComputedRef<EChartOption>,
  { paused, isEmpty, onInit, dataOptions }: UseEChartOptions = {},
) => {
  const chart = shallowRef<EChart>()
  const { width, height } = useElementSize(chartRef)
  let removeInitListeners: (() => void) | undefined
  let touchTarget: HTMLElement | null = null

  // 图表滚出视口或整页退到后台时暂停下发,回到可见补一拍最新值 ——
  // 数据流与 store 照常更新,只是不对看不见的画布做 setOption + 重绘
  const chartVisible = useElementVisibility(chartRef)
  const documentVisibility = useDocumentVisibility()
  const hidden = () => !chartVisible.value || documentVisibility.value !== 'visible'
  let pendingRender = false
  let pendingData = false

  const render = () => {
    if (!chart.value || paused?.value) return
    if (hidden()) {
      pendingRender = true
      return
    }
    pendingRender = false

    if (isEmpty?.value) {
      chart.value.clear()
      return
    }

    chart.value.setOption(options.value)
    if (dataOptions) {
      // 骨架全量下发(setOption 默认 merge)后补上当前数据,避免清空/重建后短暂无数据
      chart.value.setOption(dataOptions.value)
      pendingData = false
    }
  }

  const renderData = () => {
    if (!chart.value || !dataOptions || paused?.value) return
    if (isEmpty?.value) return
    if (hidden()) {
      pendingData = true
      return
    }
    pendingData = false
    chart.value.setOption(dataOptions.value, { lazyUpdate: true })
  }

  const resize = debounce(() => chart.value?.resize(), 100)

  const removeTouchListener = () => {
    touchTarget?.removeEventListener('touchend', hideTooltip)
    touchTarget = null
  }

  const hideTooltip = () => {
    chart.value?.dispatchAction({ type: 'hideTip' })
  }

  const syncTouchListener = () => {
    removeTouchListener()
    if (!isMiddleScreen.value || !chartRef.value) return

    touchTarget = chartRef.value
    touchTarget.addEventListener('touchend', hideTooltip)
  }

  watch(options, render)
  if (dataOptions) {
    watch(dataOptions, renderData)
  }
  watch([chartVisible, documentVisibility], () => {
    if (hidden()) return
    if (pendingRender) render()
    else if (pendingData) renderData()
  })
  watch([width, height], resize)
  watch(isMiddleScreen, syncTouchListener)
  if (paused) {
    watch(paused, (value) => {
      if (!value) render()
    })
  }
  if (isEmpty) {
    watch(isEmpty, render)
  }

  onMounted(() => {
    if (!chartRef.value) return

    chart.value = echarts.init(chartRef.value)
    removeInitListeners = onInit?.(chart.value) || undefined
    syncTouchListener()
    render()
  })

  onUnmounted(() => {
    resize.cancel()
    removeTouchListener()
    removeInitListeners?.()
    chart.value?.dispose()
    chart.value = undefined
  })

  return {
    chart,
    render,
    resize: () => {
      resize.cancel()
      chart.value?.resize()
    },
  }
}

export { echarts }
