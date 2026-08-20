// Clash REST 后端的 config 组装:拉取 /configs、PATCH /configs,写入门面状态。
import { getConfigsAPI, patchConfigsAPI } from '@/api/clash'
import { createSessionResource } from '@/assembly/sessionResource'
import { configs } from './index'

// 代际守卫 / 去重 / 新鲜度 / 错误吸收统一由 SessionResource 承担:
// 这里只负责「解析 → 返回提交闭包」,旧后端的慢响应不可能落进新会话。
const configsResource = createSessionResource(async (signal) => {
  const { data } = await getConfigsAPI({ signal })

  return () => {
    configs.value = data
  }
})

export const fetchConfigs = (options?: { maxAge?: number }) => configsResource.fetch(options)

export const updateConfigs = async (cfg: Record<string, string | boolean | object | number>) => {
  await patchConfigsAPI(cfg)
  // PATCH 不回传完整配置,必须回读;invalidate 保证这次回读不会被新鲜度窗口吞掉。
  configsResource.invalidate()
  await configsResource.fetch()
}
