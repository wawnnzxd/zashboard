// 「关着门就不算」的派生值。
//
// 面板里有好几处需要「不可见时跳过、恢复时补一拍」:图表离屏、拓扑图暂停、卡片滚出视口。
// 各处原本都手写一套 pending 标志(算不算过、恢复时要不要补),而**恢复补一拍**恰恰是最容易漏的那半 ——
// 漏了的表现是「切回来画面卡在旧数据上,直到下一拍才恢复」。
//
// 这里换一个形状:门关着时**提前 return 上一次的值、根本不读上游**,于是上游被摘出依赖图,
// 是真正的零工作(而不是「照常算完再丢弃」);而门本身是依赖,开门必然重算 ——
// 「恢复补一拍」由响应式系统负责,不需要任何调用者记账。
import { useDocumentVisibility, useElementVisibility } from '@vueuse/core'
import { computed, type ComputedRef, type Ref } from 'vue'

/**
 * 「这块东西现在看不见」的门:元素滚出视口,或整个标签页退到后台。
 *
 * 做成可传递的值而不是各自新建,是因为同一个元素上重复调用意味着重复的 IntersectionObserver,
 * 而两份真相是否一致就只能靠人去推理回调顺序。谁需要就把同一个门传下去。
 */
export const useVisibilityGate = (
  el: Ref<HTMLElement | null | undefined>,
): ComputedRef<boolean> => {
  const visible = useElementVisibility(el)
  const documentVisibility = useDocumentVisibility()

  return computed(() => !visible.value || documentVisibility.value !== 'visible')
}

export const gatedComputed = <T>(
  closed: Ref<boolean> | ComputedRef<boolean>,
  compute: (previous?: T) => T,
): ComputedRef<T> =>
  computed<T>((previous) => {
    // previous 为 undefined 时必须真算一次:否则首次求值拿不到任何值。
    if (closed.value && previous !== undefined) {
      return previous
    }

    return compute(previous)
  })
