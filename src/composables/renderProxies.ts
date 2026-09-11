import { latencyMapOf, proxyMap, proxyProviederList, type LatencyMap } from '@/assembly/proxies'
import { NOT_CONNECTED, PROXY_SORT_TYPE } from '@/constant'
import { isProxyGroup } from '@/helper'
import {
  hideUnavailableProxies,
  proxyGroupFilterMap,
  proxySortType,
  useSmartGroupSort,
} from '@/store/settings'
import { smartOrderMap } from '@/store/smart'
import { computed, type ComputedRef } from 'vue'
import { isProxyNodeSearchMode, matchProxySearchKeyword, proxySearchKeyword } from './proxySearch'

export type ProxiesProviderSection = {
  providerName: string
  proxies: string[]
}

// provider 索引只随 provider 列表变化重建:fallback 的双层 find 是 O(providers×节点) 每节点
const providerNameIndex = computed(() => {
  const map = new Map<string, string>()

  for (const provider of proxyProviederList.value) {
    for (const node of provider.proxies) {
      if (!map.has(node.name)) {
        map.set(node.name, provider.name)
      }
    }
  }

  return map
})

export const groupProxiesByProviderName = (proxies: string[]): ProxiesProviderSection[] => {
  const proxiesOfProvider: Record<string, string[]> = {}
  const providerKeys: string[] = []

  for (const proxy of proxies) {
    const proxyNode = proxyMap.value[proxy]
    const providerName = proxyNode?.['provider-name'] || (providerNameIndex.value.get(proxy) ?? '')

    if (proxiesOfProvider[providerName]) {
      proxiesOfProvider[providerName].push(proxy)
    } else {
      if (providerName === '') {
        providerKeys.unshift('')
      } else {
        providerKeys.push(providerName)
      }

      proxiesOfProvider[providerName] = [proxy]
    }
  }

  return providerKeys.map((providerName) => ({
    providerName,
    proxies: proxiesOfProvider[providerName],
  }))
}

const isSameList = (prev: string[], next: string[]) =>
  prev.length === next.length && prev.every((name, index) => name === next[index])

// 延迟一律取自 assembly 的全局延迟表(按测速 url 分桶),这里只负责筛选与排序。
export function useRenderProxyList(proxies: ComputedRef<string[]>, groupName?: string) {
  const latencyMap = latencyMapOf(groupName)

  // 内容级 memo:测速潮里延迟表每 200ms 作废一次,过滤/排序每次都产出新数组,
  // 而结果往往逐字相同。内容没变就复用旧引用 —— 下游 computed 的 hasChanged 直接短路,
  // 虚拟列表也不必为一个「看起来变了」的数组重新对账。真变了(按延迟排序顺序变化)照常换引用。
  let prevList: string[] = []
  const renderProxies = computed(() => {
    const filtered = filterProxies(proxies.value, groupName, latencyMap.value)
    const list = sortProxies(filtered, groupName, latencyMap.value)

    if (!isSameList(prevList, list)) {
      prevList = list
    }

    return prevList
  })

  const proxiesCount = computed(() => {
    const latencies = latencyMap.value
    let available = 0

    for (const proxy of renderProxies.value) {
      if ((latencies.get(proxy) ?? NOT_CONNECTED) !== NOT_CONNECTED) {
        available++
      }
    }

    return `${available}/${proxies.value.length}`
  })

  return { renderProxies, proxiesCount }
}

const filterProxies = (
  proxies: string[],
  groupName: string | undefined,
  latencyMap: LatencyMap,
) => {
  let result = proxies

  if (hideUnavailableProxies.value) {
    result = result.filter(
      (name) => isProxyGroup(name) || (latencyMap.get(name) ?? NOT_CONNECTED) > NOT_CONNECTED,
    )
  }

  if (isProxyNodeSearchMode.value && proxySearchKeyword.value) {
    const keyword = proxySearchKeyword.value
    result = result.filter((name) => matchProxySearchKeyword(name, keyword))
  }

  const groupKeyword = groupName ? proxyGroupFilterMap.value[groupName] : ''
  if (groupKeyword) {
    result = result.filter((name) => matchProxySearchKeyword(name, groupKeyword))
  }

  return result
}

const sortProxies = (proxies: string[], groupName: string | undefined, latencyMap: LatencyMap) => {
  if (groupName && useSmartGroupSort.value && smartOrderMap.value[groupName]) {
    return sortBySmartOrder(proxies, smartOrderMap.value[groupName])
  }

  if (proxySortType.value === PROXY_SORT_TYPE.DEFAULT) {
    return proxies
  }

  const groups: string[] = []
  const nodes: string[] = []
  proxies.forEach((proxy) => {
    ;(isProxyGroup(proxy) ? groups : nodes).push(proxy)
  })

  const sortFunc = getSortFunc(proxySortType.value, latencyMap)
  return groups.concat(nodes.sort(sortFunc))
}

const sortBySmartOrder = (proxies: string[], orderMap: Record<string, number>) => {
  return [...proxies].sort((a, b) => {
    const ia = orderMap[a] ?? Number.MAX_SAFE_INTEGER
    const ib = orderMap[b] ?? Number.MAX_SAFE_INTEGER
    return ia - ib
  })
}

const getSortFunc = (sortType: PROXY_SORT_TYPE, latencyMap: LatencyMap) => {
  const latencyFor = (name: string) => {
    const latency = latencyMap.get(name) ?? NOT_CONNECTED

    return latency === NOT_CONNECTED ? Infinity : latency
  }
  switch (sortType) {
    case PROXY_SORT_TYPE.NAME_ASC:
      return (a: string, b: string) => a.localeCompare(b)
    case PROXY_SORT_TYPE.NAME_DESC:
      return (a: string, b: string) => b.localeCompare(a)
    case PROXY_SORT_TYPE.LATENCY_ASC:
      return (a: string, b: string) => latencyFor(a) - latencyFor(b)
    case PROXY_SORT_TYPE.LATENCY_DESC:
      return (a: string, b: string) => latencyFor(b) - latencyFor(a)
    default:
      return undefined
  }
}
