// sing-box 后端不支持 rules 列表,清空门面状态。
import { ruleProviderList, rules } from './index'

// 两个适配器必须满足同一个接口(含可选参数与失效入口),否则门面的调用点就要按后端类型分叉。
// 这里不消费 maxAge:清空是幂等的纯本地操作,没有可缓存的东西。
export const fetchRules = async (options?: { maxAge?: number }) => {
  void options
  rules.value = []
  ruleProviderList.value = []
}

export const invalidateRules = () => {
  // sing-box 通道没有可缓存的规则数据,失效是空操作。
}
