import { getLatencyByName, proxyMap, proxyProviederList } from '@/assembly/proxies'
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

type LatencyMap = Map<string, number>

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

export function useRenderProxyList(proxies: ComputedRef<string[]>, groupName?: string) {
  // 卡片挂在 <TransitionGroup> 下,而 shouldUpdateComponent 的第一条实质判断就是
  // `if (nextVNode.dirs || nextVNode.transition) return true`(排在 patchFlag 之前),
  // 所以只要这个数组换引用,视野内每张卡片都会完整重渲染 —— props 再稳也拦不住。
  // 排序/过滤路径每次都 filter/concat/sort 出新数组,测速潮里每 200ms 换一次 proxyMap,
  // 结果却逐字相同。逐项 O(N) 比较远比一次全组重渲染便宜:内容没变就复用旧引用,
  // 上游 computed 的 hasChanged 直接短路,下游一个都不会被触发。
  // 内容真变了(按延迟排序顺序变化)照常产出新数组,FLIP 过渡不受影响。
  let prevList: string[] = []
  const result = computed(() => {
    const { list, latencyMap } = getRenderProxies(proxies.value, groupName)

    if (!isSameList(prevList, list)) {
      prevList = list
    }

    return { list: prevList, latencyMap }
  })

  const renderProxies = computed(() => result.value.list)

  // 延迟在 getRenderProxies 里已经按整组算过一遍(每个 name 都要沿 now 链走 map),
  // 复用同一份 latencyMap,不再为了数个数把整条链路重走一次。
  const proxiesCount = computed(() => {
    const { list, latencyMap } = result.value
    let available = 0

    for (const name of list) {
      if (latencyMap.get(name) !== NOT_CONNECTED) {
        available++
      }
    }

    return `${available}/${proxies.value.length}`
  })

  return { renderProxies, proxiesCount }
}

const getRenderProxies = (proxies: string[], groupName: string | undefined) => {
  const latencyMap: LatencyMap = new Map(
    proxies.map((name) => [name, getLatencyByName(name, groupName)]),
  )
  const filtered = filterProxies(proxies, groupName, latencyMap)

  return { list: sortProxies(filtered, groupName, latencyMap), latencyMap }
}

const filterProxies = (
  proxies: string[],
  groupName: string | undefined,
  latencyMap: LatencyMap,
) => {
  let result = proxies

  if (hideUnavailableProxies.value) {
    result = result.filter((name) => isProxyGroup(name) || latencyMap.get(name)! > NOT_CONNECTED)
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
    const latency = latencyMap.get(name)!
    return latency === 0 ? Infinity : latency
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
