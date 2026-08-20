import { gatedComputed, useVisibilityGate } from '@/composables/gatedComputed'
import { isMiddleScreen } from '@/helper/utils'
import { emoji, font, theme } from '@/store/settings'
import { useElementSize } from '@vueuse/core'
import { BarChart, LineChart, SankeyChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { debounce } from 'lodash-es'
import type { ComputedRef, Ref } from 'vue'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'

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
  // 可见性门。组件若自己也要用它(例如按同一扇门冻结上游数据),就建一次传进来 ——
  // 各建各的等于同一个元素上挂两个 IntersectionObserver,两份真相还得靠人推理是否一致。
  hidden?: ComputedRef<boolean>
}

export const useEChart = (
  chartRef: ChartElementRef,
  options: ComputedRef<EChartOption>,
  { paused, isEmpty, onInit, dataOptions, hidden }: UseEChartOptions = {},
) => {
  const chart = shallowRef<EChart>()
  const { width, height } = useElementSize(chartRef)
  let removeInitListeners: (() => void) | undefined
  let touchTarget: HTMLElement | null = null

  // 图表滚出视口、整页退到后台、或用户按了暂停时,关掉这道门。
  // 门关着时 gatedComputed 不读上游 —— option 树与数据通道**根本不重算**(此前是照常算完
  // 再在 render 里早退,每秒白算一整棵 option);门本身是依赖,开门必然重算,
  // 所以「恢复时补一拍」不需要任何 pending 标志来记账。
  const hiddenGate = hidden ?? useVisibilityGate(chartRef)
  const closed = computed(() => hiddenGate.value || Boolean(paused?.value))
  const gatedOptions = gatedComputed(closed, () => options.value)
  const gatedData = dataOptions ? gatedComputed(closed, () => dataOptions.value) : undefined

  const render = () => {
    if (!chart.value || closed.value) return

    if (isEmpty?.value) {
      chart.value.clear()
      return
    }

    chart.value.setOption(gatedOptions.value)
    if (gatedData) {
      // 骨架全量下发(setOption 默认 merge)后补上当前数据,避免清空/重建后短暂无数据
      chart.value.setOption(gatedData.value)
    }
  }

  const renderData = () => {
    if (!chart.value || !gatedData || closed.value || isEmpty?.value) return

    chart.value.setOption(gatedData.value, { lazyUpdate: true })
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

  watch(gatedOptions, render)
  if (gatedData) {
    watch(gatedData, renderData)
  }
  // 开门即补一拍:render 是幂等的,门关期间上游有没有变过都不必区分
  // (变过的话上面那两个 watch 也会因为引用变化而触发,重复一次 setOption 无副作用)。
  watch(closed, (isClosed) => {
    if (!isClosed) render()
  })
  watch([width, height], resize)
  watch(isMiddleScreen, syncTouchListener)
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
