<template>
  <div
    ref="parentRef"
    class="flex h-full w-full flex-col overflow-y-auto"
  >
    <slot name="before" />
    <div
      :style="{
        height: `${totalSize}px`,
      }"
      class="relative w-full shrink-0"
      v-if="data.length > 0"
    >
      <div
        :class="['absolute top-3 right-3 left-3', contentClass]"
        :style="{
          transform: `translateY(${virtualRows[0]?.start ?? 0}px)`,
        }"
      >
        <!--
          每条自成一张卡片、靠间距分隔。间距做在被测量的行容器的 padding 上，不能用
          margin 或 flex gap——虚拟滚动按 getBoundingClientRect 累加行高，两者都不计入，
          totalSize 会和实际布局对不上。
        -->
        <div
          v-for="row in virtualRows"
          :key="row.key.toString()"
          :data-index="row.index"
          :ref="(ref) => measureElement(ref as Element | null)"
          class="pb-2"
        >
          <div class="base-container">
            <slot
              :item="data[row.index]"
              :index="row.index"
            />
          </div>
        </div>
      </div>
    </div>
    <div
      v-else
      class="base-container m-3 flex-row p-3 text-sm"
      :style="{ marginTop: `${paddingTop + 12}px`, marginBottom: `${paddingBottom}px` }"
    >
      {{ $t('noData') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePaddingForViews } from '@/composables/paddingViews'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, nextTick, ref } from 'vue'

const { paddingTop, paddingBottom } = usePaddingForViews({
  offsetTop: 0,
  offsetBottom: 0,
})
const parentRef = ref<HTMLElement | null>(null)
const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any[]
    size?: number
    overscan?: number
    contentClass?: string
    // 行身份键(如日志 seq):头部插入型列表必须传,否则 index 键使全部可见行随平移重渲染
    getItemKey?: (item: unknown, index: number) => string | number
    // 已经永久离开数据源的行的上界(数值 key):小于它的测量值可以安全丢弃。
    // 必须取自**未过滤**的数据源 —— 用过滤后的 data 推这个界,会把「还在缓冲区、
    // 只是当前被过滤掉」的行的测量值一并删掉,清空过滤词那一瞬这些行全部回落到
    // 估计值、可见跳动。不传就完全不修剪(等于现状)。
    minAliveKey?: number
  }>(),
  {
    data: () => [],
    size: 64,
    overscan: 8,
    contentClass: '',
    getItemKey: undefined,
    minAliveKey: undefined,
  },
)

const virutalOptions = computed(() => {
  return {
    count: props.data.length,
    getScrollElement: () => parentRef.value,
    estimateSize: () => props.size,
    overscan: props.overscan,
    paddingStart: paddingTop.value,
    paddingEnd: paddingBottom.value + 24,
    ...(props.getItemKey
      ? { getItemKey: (index: number) => props.getItemKey!(props.data[index], index) }
      : {}),
  }
})

const rowVirtualizer = useVirtualizer(virutalOptions)
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())
// virtual-core 的 itemSizeCache 按 getItemKey 存,库里没有任何删除路径:日志用 seq 做键,
// 会话内只增不减。阈值取「上次修剪后又长了 PRUNE_SLACK 条」而不是按 data.length 取倍数 ——
// 开着过滤词时 data.length 可能只剩几条,倍数阈值会让每次 flush 都全量扫一遍缓存。
const PRUNE_SLACK = 512
let sizeCacheCeiling = PRUNE_SLACK
const pruneSizeCache = () => {
  const minAliveKey = props.minAliveKey

  if (minAliveKey === undefined) {
    return
  }

  const cache = rowVirtualizer.value.itemSizeCache

  if (cache.size <= sizeCacheCeiling) {
    return
  }

  for (const key of cache.keys()) {
    if (typeof key === 'number' && key < minAliveKey) {
      cache.delete(key)
    }
  }
  sizeCacheCeiling = cache.size + PRUNE_SLACK
}

const measureElement = (el: Element | null) => {
  if (!el) {
    return
  }

  // 延到 nextTick 是等本帧样式落定再量;但那一刻元素可能已经被卸载,
  // 而 virtual-core 对已卸载元素量到的是 offsetHeight = 0,并且会把 0 写进 itemSizeCache ——
  // 同一个 key 再次挂载时直接读到缓存里的 0,行塌陷且手动测量路径没有自愈机会。
  nextTick(() => {
    if (!el.isConnected) {
      return
    }

    rowVirtualizer.value.measureElement(el)
    pruneSizeCache()
  })

  return undefined
}
</script>
