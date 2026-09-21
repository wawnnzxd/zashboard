import {
  activeConnections,
  connectionAccessor,
  disconnectConnections,
} from '@/assembly/connections'
import { driver } from '@/assembly/driver'
import { createSessionResource } from '@/assembly/session-resource'
import { GLOBAL, IPV6_TEST_URL, NOT_CONNECTED, PROXY_TYPE } from '@/constant'
import { notifyRequestError } from '@/helper/request-error'
import { automaticDisconnection, iconReflectList, IPv6test } from '@/store/settings'

import type { Proxy } from '@/types'
import { last } from 'lodash-es'
import { initSmartWeights } from './smart'
import {
  IPv6Map,
  mergeProxyMap,
  proxyGroupList,
  proxyMap,
  proxyProviederList,
  setProxyNode,
  setProxyNodeFields,
} from './state'

const getIPv6FromExtra = (proxy: Proxy) => {
  const ipv6History = proxy.extra?.[IPV6_TEST_URL]?.history

  return (last(ipv6History)?.delay ?? NOT_CONNECTED) > NOT_CONNECTED
}

// 解析阶段:只做网络与纯计算,把所有写入收进返回的提交闭包。
// 代际比对由 SessionResource 统一做一次 —— 上游在这里靠 `fetchTime !== nowTime` 自守,
// 那道守卫只挡得住「同一个后端上后发先至」,挡不住「旧后端的响应回填新会话」;
// 而一旦有了 in-flight 去重它又恒为 false(第二个调用者拿到的是同一个 promise,根本不会重设 fetchTime)。
const resolveProxies = async (signal: AbortSignal) => {
  const { proxies, providers } = await driver().proxies.fetch(signal)

  const sortIndex = proxies[GLOBAL]?.all ?? []
  const allProviderProxies: Record<string, Proxy> = {}

  for (const provider of providers) {
    for (const proxy of provider.proxies) {
      proxy['provider-name'] ||= provider.name
      allProviderProxies[proxy.name] = proxy
    }
  }

  const next: Record<string, Proxy> = {
    ...allProviderProxies,
    ...proxies,
  }

  let includesSmartGroup = false
  const ipv6Names: string[] = []

  // 图标回填/IPv6/smart 收集都在合并前的新对象上完成,保证 merge 的内容比较有效。
  // IPv6Map 是共享状态,它的写入属于提交阶段 —— 留在这里会让一份被判定为过期、
  // 整份丢弃的响应仍然在 IPv6Map 上留下痕迹。
  Object.entries(next).forEach(([name, proxy]) => {
    const iconReflect = iconReflectList.value.find((icon) => icon.name === name)

    if (iconReflect) {
      proxy.icon = iconReflect.icon
    }
    if (IPv6test.value && getIPv6FromExtra(proxy)) {
      ipv6Names.push(name)
    }

    if (proxy.type.toLowerCase() === PROXY_TYPE.Smart) {
      includesSmartGroup = true
    }
  })

  const nextGroupList = Object.values(proxies)
    .filter((proxy) => proxy.all?.length && proxy.name !== GLOBAL)
    .sort((prev, next) => {
      const prevIndex = sortIndex.indexOf(prev.name)
      const nextIndex = sortIndex.indexOf(next.name)

      if (prevIndex === -1 && nextIndex === -1) {
        return 0
      }
      if (prevIndex === -1) {
        return 1
      }
      if (nextIndex === -1) {
        return -1
      }
      return prevIndex - nextIndex
    })
    .map((proxy) => proxy.name)

  return () => {
    for (const name of ipv6Names) {
      IPv6Map.value[name] = true
    }
    mergeProxyMap(next)
    proxyGroupList.value = nextGroupList
    proxyProviederList.value = providers

    if (includesSmartGroup) {
      initSmartWeights()
    }
  }
}

// in-flight 去重 + 代际守卫 + 新鲜度窗口:启动双拉、导航重拉、回前台重拉共用同一入口,
// 不再并发发出多份 MB 级全量请求,也不会让上一个后端的响应回填到新会话里。
const proxiesResource = createSessionResource(resolveProxies)

export const fetchProxies = (options?: { maxAge?: number }) => proxiesResource.fetch(options)

/** 写操作(更新订阅、健康检查、批量测速等)之后调用:让下一次 fetchProxies 必然真发。 */
export const invalidateProxies = () => proxiesResource.invalidate()

// 单点刷新的响应必须真的是这个代理:GET /proxies/:name 在不实现该端点的后端
// (mock、部分 fork 核)上会 404 或回一个别的 JSON,原样写进 proxyMap 会把这条记录
// 换成没有 type 的残缺对象,依赖 type 的渲染(ProxyGroupNow 等)当场抛错、整张卡被卸载。
const isProxyRecord = (name: string, data: unknown): data is Proxy =>
  !!data &&
  typeof data === 'object' &&
  (data as Proxy).name === name &&
  typeof (data as Proxy).type === 'string'

// 点选后只刷新该组(GET /proxies/{name},1-2KB):上游每次点选 fire-and-forget
// 全量重拉 /proxies + /providers/proxies(千节点 0.5~3MB)。
const refreshSingleProxy = async (name: string) => {
  try {
    const data = await driver().proxies.fetchOne(name)

    if (!isProxyRecord(name, data)) return

    const oldNode = proxyMap.value[name]

    if (!oldNode || JSON.stringify(oldNode) !== JSON.stringify(data)) {
      setProxyNode(name, data)
    }
  } catch {
    // 忽略,下一次全量刷新自然对齐
  }
}

// 切换节点只会由用户点击触发,且调用点都是模板里的 @click(没有 catch 的落点),
// 所以在这里兜住:失败弹提示,否则 UI 会停在旧选择上一声不吭。
export const handlerProxySelect = async (proxyGroupName: string, proxyName: string) => {
  try {
    const proxyGroup = proxyMap.value[proxyGroupName]

    if (!proxyGroup || proxyGroup.type.toLowerCase() === PROXY_TYPE.LoadBalance) return
    if (proxyGroup.now === proxyName) {
      // 面板认为「已选中」不等于内核真的还停在这个节点(url-test / fallback 会自己换):
      // 先对一下表,必须从 proxyMap 重新取 —— 上面捕获的 proxyGroup 是刷新前的旧对象,读它恒真。
      await refreshSingleProxy(proxyGroupName)
      if (proxyMap.value[proxyGroupName]?.now === proxyName) return
    }

    await driver().proxies.select(proxyGroupName, proxyName)
    setProxyNodeFields(proxyGroupName, { now: proxyName })

    if (automaticDisconnection.value) {
      const accessor = connectionAccessor()
      const matching = activeConnections.value.filter((c) =>
        accessor.chains(c).includes(proxyGroupName),
      )

      // 切换节点的顺带动作,失败不该盖掉「已切换」这件主事;
      // 并发上限在 disconnectConnections 内 —— 命中几千条连接的组不能一次把请求全甩出去。
      disconnectConnections(matching, activeConnections.value.length)
    }
    refreshSingleProxy(proxyGroupName)
  } catch (e) {
    notifyRequestError(e)
  }
}

// 订阅更新 / 健康检查都会改写节点表,是写操作:写完让代理资源失效,紧随其后的
// fetchProxies() 才不会搭上「写入之前就发出」的那份在途请求、拿回旧的节点与延迟。
export const updateProxyProvider = async (name: string) => {
  await driver().proxies.updateProvider(name)
  invalidateProxies()
}

export const proxyProviderHealthCheck = async (name: string) => {
  await driver().proxies.healthCheckProvider(name)
  invalidateProxies()
}

export const fetchSmartWeights = () => driver().proxies.fetchSmartWeights()

export const flushSmartGroupWeights = () => driver().proxies.flushSmartWeights()
