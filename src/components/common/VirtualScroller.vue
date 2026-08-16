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
    getItemKey?: (index: number) => string | number
  }>(),
  {
    data: () => [],
    size: 64,
    overscan: 8,
    contentClass: '',
    getItemKey: undefined,
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
    ...(props.getItemKey ? { getItemKey: props.getItemKey } : {}),
  }
})

const rowVirtualizer = useVirtualizer(virutalOptions)
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalSize = computed(() => rowVirtualizer.value.getTotalSize())
const measureElement = (el: Element | null) => {
  if (!el) {
    return
  }

  nextTick(() => {
    rowVirtualizer.value.measureElement(el)
  })

  return undefined
}
</script>
