import type { Rule, RuleProvider } from '@/types'
import { ref } from 'vue'
import { driver } from './driver'
import { createSessionResource } from './session-resource'

export const rules = ref<Rule[]>([])
export const ruleProviderList = ref<RuleProvider[]>([])

// 代际守卫 / 去重 / 新鲜度 / 错误吸收统一由 SessionResource 承担。
// 「去重」与「代际」必须绑在同一个 epoch 上:只有守卫、没有按会话区分的去重键时,切后端后新后端
// 会借用旧后端的在途 promise,而那份响应又被守卫正确判为过期丢弃 —— 结果新后端的规则一次都拉不到。
const rulesResource = createSessionResource(async (signal) => {
  const payload = await driver().rules.fetch(signal)

  return () => {
    rules.value = payload.rules
    ruleProviderList.value = payload.providers
  }
})

export const fetchRules = (options?: { maxAge?: number }) => rulesResource.fetch(options)

/** 写操作之后调用:放弃在途结果并清掉新鲜度,保证下一次 fetchRules 拿到的是写入之后的数据。 */
export const invalidateRules = () => rulesResource.invalidate()

export const toggleRuleDisabled = (rule: Rule, disabled: boolean) =>
  driver().rules.toggleDisabled(rule, disabled)

// 写成功后就地更新这一条规则的启用态。上游是「切开关 → 重拉全部规则 + 全部 provider」:
// 内核并不回传新规则表,这次回读纯粹是为了翻一个 bool,而在它的飞行窗口(局域网百毫秒级)内
// 点第二条规则,第二条的写入会被第一条的回读结果打回原位 —— 用户看到开关自己弹回去。
// 启用态有两种载体(带 uuid 的规则放在 extra 里,mihomo 直接在 rule 上),写入必须与
// helper/rules 的 isRuleDisabled 读取一致,所以放在持有状态的这里而不是各调用点自己拼。
export const setRuleDisabled = (rule: Rule, disabled: boolean) => {
  const index = rules.value.indexOf(rule)

  if (index === -1) {
    return
  }

  const next = rules.value.slice()

  next[index] = rule.extra ? { ...rule, extra: { ...rule.extra, disabled } } : { ...rule, disabled }
  rules.value = next
}

// 更新规则集会改变 ruleCount,是一次写操作:写完必须让规则资源失效,否则紧随其后的回读
// 可能搭上「写入之前就发出」的那份在途请求,拿回旧的条目数。把失效放在写入口里,
// 各个调用点都不需要记得这件事。
export const updateRuleProvider = async (name: string) => {
  await driver().rules.updateProvider(name)
  invalidateRules()
}
