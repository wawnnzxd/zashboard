<template>
  <div
    class="grid min-w-0 gap-2"
    :style="`grid-template-columns: repeat(auto-fill, minmax(min(${minProxyCardWidth}px, 100%), 1fr));`"
  >
    <TransitionGroup name="proxy-node">
      <slot />
    </TransitionGroup>
  </div>
</template>

<script lang="ts" setup>
/*
 * 按延迟排序时测速会让节点整体重排,没有 FLIP 的话卡片是瞬移的,用户会跟丢刚点过的那张。
 *
 * 两个约束:
 * 1. 根节点必须是单个真实 <div>。调用方 ProxiesContent 用 useCurrentElement() 量宽度算
 *    maxProxies,根是组件/Fragment 时 $el 拿不到 Element,ResizeObserver 会直接抛错。
 *    注意 template 顶层的 HTML 注释在 dev 构建里会被保留,同样会让组件变成多根。
 *    所以 TransitionGroup 不带 tag(渲染成 Fragment),注释也只写在这里。
 * 2. 过渡类作用在插槽子元素(ProxyNodeCard 根)上,带的是调用方的 scope id,
 *    所以 .proxy-node-* 定义在全局 motion.css 里而不是这里的 scoped block。
 *
 * 使用代价(调用方必须知道):TransitionGroup 会给每个 keyed 子 vnode 打 transition 标记,
 * 而 shouldUpdateComponent 在判 patchFlag 之前就先 `if (nextVNode.transition) return true`,
 * 所以这里的卡片 props 再稳定也挡不住重渲染 —— 只要父级重渲一次,视野内每张卡片都会完整重跑。
 * 因此喂进插槽的列表在内容没变时必须保持引用不变(见 composables/renderProxies 的内容级 memo)。
 */
import { minProxyCardWidth } from '@/store/settings'
</script>
