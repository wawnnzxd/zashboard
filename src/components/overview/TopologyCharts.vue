<template>
  <div class="base-container p-4">
    <Teleport
      to="body"
      :disabled="!isFullScreen"
    >
      <!-- custom-background / custom-blur 必须与 App.vue 的守卫保持一致:没有背景图时
           alpha 规则只是把元素混成同色不透明底、模糊的是一片纯色,视觉产出为零,
           却让里面每个 .card/.base-container/.table thead 都被提升为独立合成层逐帧快照 -->
      <div
        :class="
          isFullScreen
            ? [
                'bg-base-100 fixed inset-0 z-[9999] flex h-screen w-screen flex-col p-4',
                backgroundImage && 'custom-background bg-cover bg-center',
                backgroundImage && blurIntensity > 0 ? 'custom-blur' : '',
              ]
            : undefined
        "
        :style="
          isFullScreen
            ? [
                backgroundImage,
                {
                  '--dashboard-alpha': `${dashboardTransparent}%`,
                  '--blur-px': `${blurIntensity}px`,
                },
              ]
            : undefined
        "
      >
        <div class="flex items-center justify-between gap-2">
          <div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">
            {{ $t('connectionTopology') }}
          </div>
          <div class="flex items-center gap-1">
            <label
              class="text-base-content/60 flex cursor-pointer items-center gap-2 text-xs"
              :title="t('applyConnectionFilter')"
            >
              <span class="hidden sm:inline">{{ $t('applyConnectionFilter') }}</span>
              <input
                v-model="topologyApplyConnectionFilter"
                type="checkbox"
                class="toggle"
                :aria-label="t('applyConnectionFilter')"
              />
            </label>
            <button
              class="btn btn-ghost btn-sm btn-square"
              :aria-label="t(isManuallyPaused ? 'topologyResume' : 'topologyPause')"
              :title="t(isManuallyPaused ? 'topologyResume' : 'topologyPause')"
              :aria-pressed="isManuallyPaused"
              @click="isManuallyPaused = !isManuallyPaused"
            >
              <PlayIcon
                v-if="isManuallyPaused"
                class="h-4 w-4"
              />
              <PauseIcon
                v-else
                class="h-4 w-4"
              />
            </button>
            <button
              class="btn btn-ghost btn-sm btn-square"
              :aria-label="t(isFullScreen ? 'topologyCollapse' : 'topologyExpand')"
              :title="t(isFullScreen ? 'topologyCollapse' : 'topologyExpand')"
              :aria-pressed="isFullScreen"
              @click="isFullScreen = !isFullScreen"
            >
              <ArrowsPointingInIcon
                v-if="isFullScreen"
                class="h-4 w-4"
              />
              <ArrowsPointingOutIcon
                v-else
                class="h-4 w-4"
              />
            </button>
          </div>
        </div>
        <div
          class="bg-base-200/30 relative w-full overflow-hidden rounded-xl"
          :class="isFullScreen ? 'mt-2 min-h-0 flex-1' : 'mt-4 h-96'"
          data-page-swipe-ignore
          @mousemove.stop
        >
          <div
            class="relative"
            :class="isFullScreen ? 'bg-base-100' : 'h-full w-full'"
            :style="chartSurfaceStyle"
          >
            <div
              ref="chartRef"
              class="h-full w-full"
            />
            <div
              v-if="isEmpty"
              class="text-base-content/50 absolute inset-0 flex items-center justify-center"
            >
              {{ t('noData') }}
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { escapeChartHtml } from '@/components/charts/chartTooltip'
import { useChartTheme, useEChart, type EChartOption } from '@/composables/useEChart'
import { getConnectionChains, getConnectionRule, getConnectionSourceIP } from '@/helper'
import { backgroundImage } from '@/helper/indexeddb'
import { getIPLabelFromMap } from '@/helper/sourceip'
import { isMiddleScreen } from '@/helper/utils'
import { activeConnections, filteredActiveConnections } from '@/store/connections'
import {
  blurIntensity,
  dashboardTransparent,
  topologyApplyConnectionFilter,
} from '@/store/settings'
import {
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  PauseIcon,
  PlayIcon,
} from '@heroicons/vue/24/outline'
import { useDocumentVisibility, useElementVisibility, useWindowSize } from '@vueuse/core'
import type { CSSProperties } from 'vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { buildTopologyData, type TopologyData } from './topology'

const { t } = useI18n()
const chartRef = ref<HTMLElement>()
const isFullScreen = ref(false)
const isManuallyPaused = ref(false)
const isTooltipVisible = ref(false)
const { width: windowWidth, height: windowHeight } = useWindowSize()
const { colors, fontFamily } = useChartTheme(chartRef)

const isPaused = computed(() => isManuallyPaused.value || isTooltipVisible.value)
// useEChart 的门控只挡住 setOption,挡不住上游 computed 求值;这里在组件侧复述一遍
// 同样的可见性条件,让派生数据本身也能停下来(useEChart 目前没把 hidden 暴露出来)
const chartVisible = useElementVisibility(chartRef)
const documentVisibility = useDocumentVisibility()
const frozen = computed(
  () => isPaused.value || !chartVisible.value || documentVisibility.value !== 'visible',
)
const shouldRotate = computed(
  () => isFullScreen.value && isMiddleScreen.value && windowHeight.value > windowWidth.value,
)

const chartSurfaceStyle = computed<CSSProperties>(() => {
  if (!isFullScreen.value) return {}

  const style: CSSProperties = {
    height: '100%',
    width: '100%',
  }

  // 同上:没有背景图时模糊的是纯色,而显式的 backdrop-filter(哪怕 blur(0px))
  // 一样会强制建合成层 —— 只有真有图且真要模糊时才下发
  if (backgroundImage.value && blurIntensity.value > 0) {
    style.backdropFilter = `blur(${blurIntensity.value}px)`
  }

  if (!shouldRotate.value) return style

  return {
    ...style,
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: '100vh',
    height: '100vw',
    marginTop: '-50vw',
    marginLeft: '-50vh',
    transform: 'rotate(90deg)',
  }
})

// 连接快照每秒换新引用,但拓扑(节点/链路/连接数)多数拍并不变:
// 结构相同则沿用上一份引用,下游 options 不重算、sankey 不做全量销毁重建
const isSameTopology = (a: TopologyData, b: TopologyData) =>
  a.nodes.length === b.nodes.length &&
  a.links.length === b.links.length &&
  a.nodes.every((node, i) => node.name === b.nodes[i].name && node.layer === b.nodes[i].layer) &&
  a.links.every(
    (link, i) =>
      link.source === b.links[i].source &&
      link.target === b.links[i].target &&
      link.value === b.links[i].value,
  )

// 画布定格(暂停/悬停 tooltip)或根本看不见时,拓扑必须跟着定格 —— 这不只是省算力:
// topology.ts 按 layer+name 全量重编号,node.id 会整体漂移,echarts 手里那份旧 link 的
// source/target 就会指到另一个节点(边 tooltip 显示错名字),isEmpty 也会翻真、
// 把「无数据」文案盖在仍然画着的桑基图上。冻结后这两份真相天然对齐。
// 形状上关键的一点:提前 return 时**不读** activeConnections,整条连接流被摘出依赖图,
// 是真正的零工作;而 frozen 自己是依赖,门一开必然重算 —— 「恢复补一拍」不需要任何记账。
const topologyData = computed<TopologyData>((prev) => {
  if (prev && frozen.value) return prev

  const next = buildTopologyData(
    (topologyApplyConnectionFilter.value
      ? filteredActiveConnections.value
      : activeConnections.value
    ).map((connection) => ({
      source: getIPLabelFromMap(getConnectionSourceIP(connection)),
      rule: getConnectionRule(connection),
      chains: getConnectionChains(connection),
    })),
    {
      sourceIPAddress: t('sourceIPAddress'),
      ruleMatch: t('ruleMatch'),
      proxyChainEntry: t('proxyChainEntry'),
      proxyChainExit: t('proxyChainExit'),
      unknown: t('unknown'),
    },
  )

  return prev && isSameTopology(prev, next) ? prev : next
})
const isEmpty = computed(() => topologyData.value.nodes.length === 0)

const options = computed<EChartOption>(() => ({
  backgroundColor: 'transparent',
  textStyle: {
    fontFamily: fontFamily.value || 'inherit',
    color: colors.baseContent,
  },
  tooltip: {
    trigger: 'item',
    triggerOn: 'mousemove',
    backgroundColor: colors.base70,
    borderColor: colors.baseContent30,
    textStyle: {
      color: colors.baseContent,
    },
    formatter: (params: unknown) => {
      const { dataType, data } = params as {
        dataType: 'node' | 'edge'
        data: {
          name: string
          nodeType?: string
          source: number
          target: number
          value: number
          originalValue?: number
        }
      }

      if (dataType === 'node') {
        return `${escapeChartHtml(data.name)}<br/>${escapeChartHtml(t('nodeType'))}: ${escapeChartHtml(
          data.nodeType || t('unknown'),
        )}`
      }

      if (dataType === 'edge') {
        const sourceNode = topologyData.value.nodes.find((node) => node.id === data.source)
        const targetNode = topologyData.value.nodes.find((node) => node.id === data.target)
        const count = data.originalValue ?? data.value

        if (sourceNode && targetNode) {
          return `${escapeChartHtml(sourceNode.name)} → ${escapeChartHtml(
            targetNode.name,
          )}<br/>${escapeChartHtml(t('connectionCount'))}: ${escapeChartHtml(count)}`
        }

        return `${escapeChartHtml(t('connectionCount'))}: ${escapeChartHtml(count)}`
      }

      return ''
    },
  },
  series: [
    {
      id: 'sankey',
      type: 'sankey',
      layout: 'none',
      data: topologyData.value.nodes,
      links: topologyData.value.links,
      emphasis: {
        focus: 'trajectory',
      },
      lineStyle: {
        color: 'gradient',
        curveness: 0.5,
      },
      itemStyle: {
        borderWidth: 0,
      },
      label: {
        color: colors.baseContent,
        fontSize: isMiddleScreen.value ? 10 : 12,
        formatter: (params: { name: string }) => {
          const maxLength = isFullScreen.value ? 45 : isMiddleScreen.value ? 20 : 30
          return params.name.length > maxLength
            ? `${params.name.substring(0, maxLength)}...`
            : params.name
        },
      },
      nodeGap: 4,
      nodeWidth: 15,
      nodeAlign: 'left',
      animation: true,
      animationDuration: 1000,
      animationEasing: 'cubicOut',
      animationDelay: (index: number) => index * 50,
    },
  ],
}))

const { resize } = useEChart(chartRef, options, {
  paused: isPaused,
  isEmpty,
  onInit: (chart) => {
    const showTooltip = () => {
      isTooltipVisible.value = true
    }
    const hideTooltip = () => {
      isTooltipVisible.value = false
    }

    chart.on('showTip', showTooltip)
    chart.on('hideTip', hideTooltip)

    return () => {
      chart.off('showTip', showTooltip)
      chart.off('hideTip', hideTooltip)
    }
  },
})

watch([isFullScreen, shouldRotate, windowWidth, windowHeight], () => {
  nextTick(resize)
})
</script>
