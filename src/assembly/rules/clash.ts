// Clash REST 后端的 rules 组装:拉取 /rules 与 /providers/rules,写入门面状态。
import { fetchRuleProvidersAPI, fetchRulesAPI } from '@/api/clash'
import { createSessionResource } from '@/assembly/sessionResource'
import { ruleProviderList, rules } from './index'

// 原实现有代际守卫、却没有按会话区分的去重键:切后端时新后端借用了旧后端的在途 promise,
// 而那份响应又被守卫正确判为过期丢弃 —— 结果新后端的规则一次都拉不到,只有 RulesPage 重新挂载才自愈。
// SessionResource 把「去重」与「代际」绑在同一个 epoch 上,两者不可能再各说各话。
const rulesResource = createSessionResource(async (signal) => {
  // 并行(原实现串行两请求白付一个 RTT)
  const [{ data: ruleData }, { data: providerData }] = await Promise.all([
    fetchRulesAPI({ signal }),
    fetchRuleProvidersAPI({ signal }),
  ])

  const nextRules = ruleData.rules.map((rule) => {
    const proxy = rule.proxy
    const proxyName = proxy.startsWith('route(') ? proxy.substring(6, proxy.length - 1) : proxy

    return {
      ...rule,
      proxy: proxyName,
    }
  })
  const nextProviders = Object.values(providerData.providers)

  return () => {
    rules.value = nextRules
    ruleProviderList.value = nextProviders
  }
})

export const fetchRules = (options?: { maxAge?: number }) => rulesResource.fetch(options)

/** 规则集更新等写操作之后调用:让下一次 fetchRules 必然真发,而不被新鲜度窗口吞掉。 */
export const invalidateRules = () => rulesResource.invalidate()
