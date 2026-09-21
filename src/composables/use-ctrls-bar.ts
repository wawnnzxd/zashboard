import { isMiddleScreen } from '@/helper/utils'
import { useCurrentElement, useElementSize } from '@vueuse/core'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

export function useCtrlsBar(width: MaybeRefOrGetter<number> = 720) {
  const element = useCurrentElement()
  const { width: ctrlsBarWidth } = useElementSize(element)
  // useElementSize 首帧宽度为 0(挂载后 watch 会把它复位),此时按屏幕宽度先猜:
  // 否则桌面端每个控制栏都先按窄屏双行渲染,ResizeObserver 送达真实宽度后再重排成
  // 单行 —— 多一轮 layout+render,且触发 "ResizeObserver loop" 告警
  const isLargeCtrlsBar = computed(() => {
    return ctrlsBarWidth.value ? ctrlsBarWidth.value > toValue(width) : !isMiddleScreen.value
  })

  return {
    isLargeCtrlsBar,
  }
}
