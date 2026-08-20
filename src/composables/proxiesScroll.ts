import { PROXY_CARD_SIZE } from '@/constant'
import { findScrollableParent, isMiddleScreen } from '@/helper/utils'
import { minProxyCardWidth, proxyCardSize } from '@/store/settings'
import { useCurrentElement, useElementSize, useInfiniteScroll } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

// totalProxies 收 ref/getter 而不是数字:列表长度会随搜索、过滤、测速结果变化,
// 而 ProxiesContent 挂在没有 key 的 <Component :is>(展开期间不会重挂载),
// 收快照就等于把容量上限永久钉在挂载那一刻 —— 列表变长后 canLoadMore 恒 false,
// 尾部节点再也滚不出来。activeIndex 只喂初值,快照即可。
export const useCalculateMaxProxies = (
  totalProxies: MaybeRefOrGetter<number>,
  activeIndex: number,
) => {
  const el = useCurrentElement()
  const { width, height } = useElementSize(el)
  // 首帧 useElementSize 为 0:按视口宽度先估一版容量,避免先渲染最少 24 张、
  // ResizeObserver 到达后再扩容重渲染(多一轮布局 + RO loop 告警)
  const initMaxProxies = computed(() => {
    const measured =
      width.value || (isMiddleScreen.value ? window.innerWidth : window.innerWidth / 2)

    return (
      Math.max(Math.floor(measured / minProxyCardWidth.value), 2) *
      (proxyCardSize.value === PROXY_CARD_SIZE.LARGE ? 9 : 12)
    )
  })
  const maxProxies = ref(Math.max(24, activeIndex + 12))

  // findScrollableParent 认的是「当场就溢出」的祖先(scrollHeight > clientHeight),
  // 内容还不够高时返回 null。只在挂载后查一次的话,这个实例的无限滚动会终身失效,
  // 所以跟着自身高度变化重查(只有内容变高才可能让父级溢出),命中一次即固定。
  const scrollEl = ref<HTMLElement | null>(null)
  const resolveScrollEl = () => {
    if (!scrollEl.value) {
      scrollEl.value = findScrollableParent((el.value ?? null) as HTMLElement | null)
    }
  }

  // 注册必须留在 setup 作用域里:useInfiniteScroll 的三处清理(useScroll 的两个
  // useEventListener、useElementVisibility 的 IntersectionObserver、内部 watch 的
  // tryOnUnmounted)都依赖当前 effect scope / 组件实例,放进 nextTick 微任务后会全部静默失效,
  // 组件卸载时没有任何一处 disconnect/removeEventListener 被执行。
  // 元素改用 ref 喂进去(内部走 toValue + unrefElement),setup 期为 null 不会炸。
  useInfiniteScroll(
    scrollEl,
    () => {
      maxProxies.value = Math.min(maxProxies.value + initMaxProxies.value, toValue(totalProxies))
    },
    {
      distance: 100,
      canLoadMore: () => {
        return maxProxies.value < toValue(totalProxies)
      },
    },
  )

  onMounted(() => {
    watch(
      initMaxProxies,
      () => {
        maxProxies.value = Math.max(maxProxies.value, initMaxProxies.value)
      },
      { immediate: true },
    )

    watch(height, resolveScrollEl, { flush: 'post' })
    nextTick(resolveScrollEl)
  })

  return {
    maxProxies,
  }
}
