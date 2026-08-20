<script setup lang="ts">
import { useCalculateMaxProxies } from '@/composables/proxiesScroll'
import { handlerProxySelect } from '@/assembly/proxies'
import { computed } from 'vue'
import ProxyNodeCard from './ProxyNodeCard.vue'
import ProxyNodeGrid from './ProxyNodeGrid.vue'

const props = defineProps<{
  name: string
  now?: string
  renderProxies: string[]
}>()

// 第一个实参必须是 getter:传数字等于只喂一个挂载时的快照,组内节点数变化后
// canLoadMore 恒为 false,无限滚动从此停摆(搜索后清空关键字必现)。
const { maxProxies } = useCalculateMaxProxies(
  () => props.renderProxies.length,
  props.renderProxies.indexOf(props.now ?? ''),
)
const proxies = computed(() => props.renderProxies.slice(0, maxProxies.value))
</script>

<template>
  <ProxyNodeGrid>
    <ProxyNodeCard
      v-for="node in proxies"
      :key="node"
      :name="node"
      :group-name="name"
      :active="node === now"
      @click.stop="handlerProxySelect(name, node)"
    />
  </ProxyNodeGrid>
</template>
