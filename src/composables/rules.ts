// 规则行为共用逻辑,卡片视图与表格视图都走这里,避免两套实现跑偏。
import { disconnectConnections } from '@/assembly/connections'
import { ruleProviderList, setRuleDisabled, toggleRuleDisabled } from '@/assembly/rules'
import { getConnectionRulePayload } from '@/helper'
import { activeConnections } from '@/store/connections'
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
  setRuleDisabled(rule, willBeDisabled)

  if (willBeDisabled && disconnectOnRuleDisable.value) {
    const matchingConnections = activeConnections.value.filter((conn) => {
      const ruleTypeMatches = conn.rule === rule.type
      const rulePayloadMatches = getConnectionRulePayload(conn) === (rule.payload || '')

      return ruleTypeMatches && rulePayloadMatches
    })

    // 顺带动作,失败不该盖掉「规则已禁用」这件主事;并发上限在 disconnectConnections 内,
    // 命中几千条的规则不能一次把几千个请求全甩给后端。
    await disconnectConnections(matchingConnections, activeConnections.value.length)
  }
}
