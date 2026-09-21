import { proxyMap, proxyProviederList } from '@/assembly/proxies'
import { computed } from 'vue'

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
