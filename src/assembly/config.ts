import type { Config, DNSQuery } from '@/types'
import { ref } from 'vue'
import { driver } from './driver'
import { createSessionResource } from './session-resource'

export const defaultConfig: Config = {
  port: 0,
  'socks-port': 0,
  'redir-port': 0,
  'tproxy-port': 0,
  'mixed-port': 0,
  'allow-lan': false,
  'bind-address': '',
  mode: '',
  'mode-list': [],
  modes: [],
  'log-level': '',
  ipv6: false,
  tun: {
    enable: false,
    stack: '',
  },
}

export const configs = ref<Config>({ ...defaultConfig })

// 代际守卫 / 去重 / 新鲜度 / 错误吸收统一由 SessionResource 承担:
// 这里只负责「解析 → 返回提交闭包」,旧后端的慢响应不可能落进新会话。
const configsResource = createSessionResource(async (signal) => {
  const data = await driver().config.fetch(signal)

  return () => {
    configs.value = data
  }
})

export const fetchConfigs = (options?: { maxAge?: number }) => configsResource.fetch(options)

export const updateConfigs = async (cfg: Record<string, string | boolean | object | number>) => {
  await driver().config.patch(cfg)
  // PATCH 不回传完整配置,必须回读;invalidate 保证这次回读不会搭上写入之前发出的在途请求。
  configsResource.invalidate()
  await configsResource.fetch()
}

export const reloadConfigs = () => driver().config.reload()

export const loadConfigs = (config: { path?: string; payload?: string }, force?: boolean) =>
  driver().config.load(config, force)

export const updateGeoData = () => driver().config.updateGeoData()

export const flushFakeIP = () => driver().config.flushFakeIP()

export const flushDNSCache = () => driver().config.flushDNSCache()

export const queryDNS = (params: { name: string; type: string }): Promise<DNSQuery> =>
  driver().config.queryDNS(params)
