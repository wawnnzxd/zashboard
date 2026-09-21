import { activeConnections, disconnectConnections } from '@/assembly/connections'
import { ruleProviderList, setRuleDisabled, toggleRuleDisabled } from '@/assembly/rules'
import { getConnectionRulePayload } from '@/helper'
import { disconnectOnRuleDisable } from '@/store/settings'
import type { Rule } from '@/types'
import { computed } from 'vue'

export const isRuleDisabled = (rule: Rule) => {
  if (rule.extra) {
    return rule.extra.disabled
  }

  return rule.disabled
}

// provider 按名字查表:表格/卡片每行都要查,find 是 O(P) 线性扫
const ruleProviderByName = computed(
  () => new Map(ruleProviderList.value.map((provider) => [provider.name, provider])),
)

// RuleSet 的条目数要去 provider 里取,普通规则用自带的 size。
export const getRuleSize = (rule: Rule) => {
  if (rule.type === 'RuleSet') {
    return ruleProviderByName.value.get(rule.payload)?.ruleCount
  }

  return rule.size
}

export const isUpdateableRuleSet = (rule: Rule) => {
  if (rule.type !== 'RuleSet') {
    return false
  }

  const provider = ruleProviderByName.value.get(rule.payload)

  if (!provider) {
    return false
  }

  return provider.vehicleType !== 'Inline'
}

export const toggleRuleDisabledWithSideEffects = async (rule: Rule) => {
  const willBeDisabled = !isRuleDisabled(rule)

  await toggleRuleDisabled(rule, willBeDisabled)
  // 写成功即状态确定,就地更新;不再重拉数千条规则去问服务器同一个问题
  // (回读的飞行窗口内点第二条,还会被第一条的回读结果打回原位)。
  setRuleDisabled(rule, willBeDisabled)

  if (willBeDisabled && disconnectOnRuleDisable.value) {
    const matchingConnections = activeConnections.value.filter((conn) => {
      const ruleTypeMatches = conn.rule === rule.type
      const rulePayloadMatches = getConnectionRulePayload(conn) === (rule.payload || '')

      return ruleTypeMatches && rulePayloadMatches
    })

    // 顺带动作,失败不打扰;并发上限在 disconnectConnections 内
    await disconnectConnections(matchingConnections, activeConnections.value.length)
  }
}

export const EMPTY_CELL = '—'

export const formatRuleHitCount = (count: number | undefined) =>
  count ? count.toLocaleString() : EMPTY_CELL
