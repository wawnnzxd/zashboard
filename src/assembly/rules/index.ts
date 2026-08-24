// 组装层 · rules 门面。持有 rules / ruleProviderList 统一状态与渲染派生,拉取转交 clash 实现。
import {
  toggleRuleDisabledAPI,
  toggleRuleDisabledRefindAPI,
  updateRuleProviderAPI as updateRuleProviderRawAPI,
} from '@/api/clash'
import { RULE_TAB_TYPE } from '@/constant'
import { toSearchRegex } from '@/helper/search'
import type { Rule, RuleProvider } from '@/types'
import { computed, ref } from 'vue'
import * as clash from './clash'

export const rulesFilter = ref('')
export const rulesTabShow = ref(RULE_TAB_TYPE.RULES)

export const rules = ref<Rule[]>([])
export const ruleProviderList = ref<RuleProvider[]>([])

export const renderRules = computed(() => {
  const searchRegex = toSearchRegex(rulesFilter.value)

  if (!searchRegex) {
    return rules.value
  }

  return rules.value.filter((rule) => {
    return searchRegex.testAny([rule.type, rule.payload, rule.proxy])
  })
})

export const renderRulesProvider = computed(() => {
  const searchRegex = toSearchRegex(rulesFilter.value)

  if (!searchRegex) {
    return ruleProviderList.value
  }

  return ruleProviderList.value.filter((ruleProvider) => {
    return searchRegex.testAny([ruleProvider.name, ruleProvider.behavior, ruleProvider.vehicleType])
  })
})

export const fetchRules = (options?: { maxAge?: number }) => clash.fetchRules(options)

/** 写操作之后调用:放弃在途结果并清掉新鲜度,保证下一次 fetchRules 拿到的是写入之后的数据。 */
export const invalidateRules = () => clash.invalidateRules()

// 规则启用切换有两套端点:带稳定 uuid 的规则走 PUT /rules/{uuid},
// mihomo 按索引批量切换(PATCH /rules/disable)。用哪套由响应数据自己决定 ——
// rule.uuid 是确定信息,比版本字符串嗅探可靠,故不走能力表。
export const toggleRuleDisabled = (rule: Rule, disabled: boolean) =>
  rule.uuid
    ? toggleRuleDisabledRefindAPI(rule.uuid)
    : toggleRuleDisabledAPI({ [rule.index]: disabled })

// 写成功后就地更新这一条规则的启用态。原实现是「切开关 → 重拉全部规则 + 全部 provider」:
// 内核并不回传新规则表,这次回读纯粹是为了翻一个 bool,而在它的飞行窗口(局域网百毫秒级)内
// 点第二条规则,第二条的写入会被第一条的回读结果打回原位 —— 用户看到开关自己弹回去。
// 启用态有两种载体(带 uuid 的规则放在 extra 里,mihomo 直接在 rule 上),写入必须与 isRuleDisabled 的读取一致,
// 所以放在持有状态的门面里而不是各调用点自己拼。
export const setRuleDisabled = (rule: Rule, disabled: boolean) => {
  const index = rules.value.indexOf(rule)

  if (index === -1) {
    return
  }

  const next = rules.value.slice()

  next[index] = rule.extra ? { ...rule, extra: { ...rule.extra, disabled } } : { ...rule, disabled }
  rules.value = next
}

// 规则集更新动作(Clash 专属),经 rules 域门面暴露给 view。
// 这里刻意包一层而不是裸转发:更新规则集会改变 ruleCount,是一次写操作,
// 写完必须让规则资源失效,否则紧随其后的回读可能搭上「写入之前就发出」的那份在途请求,
// 拿回旧的条目数。把失效放在写入口里,四个调用点都不需要记得这件事。
export const updateRuleProviderAPI = async (name: string) => {
  await updateRuleProviderRawAPI(name)
  await invalidateRules()
}
