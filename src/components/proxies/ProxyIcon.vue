<template>
  <div
    v-if="isDom"
    :class="['inline-block', fill || 'fill-primary']"
    :style="style"
    v-html="pureDom"
  />
  <img
    v-else
    class="inline-block"
    :style="style"
    :src="icon"
  />
</template>

<script lang="ts">
const DOM_STARTS_WITH = 'data:image/svg+xml,'

/*
 * 同一个图标在一页里会重复出现几十次(整组节点常常共用一个),而 sanitize 是要解析一遍
 * DOM 的。按原始字符串缓存,展开一个大组时只在第一张卡片上真跑一次。
 * dompurify(29KB)按需加载:仅配置了 SVG 图标时才需要,用 URL 图标的用户永远不下载它。
 */
const sanitizedCache = new Map<string, string>()

let purifier: Promise<(typeof import('dompurify'))['default']> | null = null
const loadPurifier = () => (purifier ??= import('dompurify').then((m) => m.default))

const sanitizeIcon = async (raw: string) => {
  const DOMPurify = await loadPurifier()
  const pure = DOMPurify.sanitize(raw)

  sanitizedCache.set(raw, pure)

  return pure
}
</script>

<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'

const props = withDefaults(
  defineProps<{
    icon: string
    fill?: string
    size?: number
    margin?: number
  }>(),
  {
    size: 16,
    margin: 4,
  },
)

const style = computed(() => {
  return {
    width: `${props.size}px`,
    height: `${props.size}px`,
    marginRight: `${props.margin}px`,
  }
})
const isDom = computed(() => {
  return props.icon.startsWith(DOM_STARTS_WITH)
})

const pureDom = ref('')

// 命中缓存走同步路径(不闪空);首次出现的图标才等一次动态加载,回来时图标没换才写入
watchEffect(() => {
  if (!isDom.value) {
    pureDom.value = ''
    return
  }

  const raw = props.icon.slice(DOM_STARTS_WITH.length)
  const cached = sanitizedCache.get(raw)

  if (cached !== undefined) {
    pureDom.value = cached
    return
  }

  const icon = props.icon

  void sanitizeIcon(raw).then((pure) => {
    if (props.icon === icon) pureDom.value = pure
  })
})
</script>
