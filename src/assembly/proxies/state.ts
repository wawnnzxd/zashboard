import { can } from '@/assembly/backend'
import { useStorage } from '@/composables/use-storage'
import { NOT_CONNECTED, PROXY_TYPE, TEST_URL } from '@/constant'
import { groupTestUrls, independentLatencyTest, speedtestUrl } from '@/store/settings'
import type { Proxy, ProxyProvider } from '@/types'
import { last } from 'lodash-es'
import {
  computed,
  effectScope,
  ref,
  shallowRef,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue'

// 整体替换 + 节点对象不可变的写入模式(见下方 mergeProxyMap / setProxyNode):
// shallowRef 免去为几百个节点对象建深代理;未变节点保持引用稳定,下游组件不重渲染。
// ⚠️ 由此得到的约束:任何写入都必须换引用。就地改 `proxyMap.value[name].xxx = …` 或往
// history 里 push 都不会触发任何更新 —— 写入一律走 setProxyNode / setProxyNodeFields / mergeProxyMap。
export const proxyGroupList = shallowRef<string[]>([])
export const proxyMap = shallowRef<Record<string, Proxy>>({})
export const IPv6Map = useStorage<Record<string, boolean>>('cache/ipv6-map', {})
export const proxyProviederList = shallowRef<ProxyProvider[]>([])

export type LatencyMap = Map<string, number>

// 批量测速进行中的计数(组测速/全量测速)。LatencyTag 据此在测速潮里跳过 CountUp 动画。
export const batchTestingCount = ref(0)
export const isBatchLatencyTesting = computed(() => batchTestingCount.value > 0)

// 单节点/单组的不可变更新:换外层引用触发 shallowRef,未涉及的节点保持引用稳定。
export const setProxyNode = (name: string, node: Proxy) => {
  proxyMap.value = { ...proxyMap.value, [name]: node }
}

export const setProxyNodeFields = (name: string, fields: Partial<Proxy>) => {
  const node = proxyMap.value[name]

  if (!node) {
    return
  }
  setProxyNode(name, { ...node, ...fields })
}

// 判等用的序列化结果按「对象身份」缓存,不按 name:所有写路径(setProxyNode /
// setProxyNodeFields / flushLatencies / refreshSingleProxy)都是 `{ ...node }` 造新对象,
// 新对象天然 miss、旧对象随 GC 一起带走缓存项 —— 缓存自失效,没有任何写入点需要「记得」invalidate。
// 按 name 缓存则要求每个写入点手工 delete,漏一处就是「该更新的不更新」。
const nodeJsonCache = new WeakMap<Proxy, string>()

const jsonOfNode = (node: Proxy) => {
  let json = nodeJsonCache.get(node)

  if (json === undefined) {
    json = JSON.stringify(node)
    nodeJsonCache.set(node, json)
  }

  return json
}

// 按 name diff 合并进 proxyMap:内容未变的节点复用旧对象引用,订阅节点的组件
// props 恒等、子树更新被 Vue 跳过 —— 「整棵替换 → 全页重渲染」的根治点。
export const mergeProxyMap = (next: Record<string, Proxy>) => {
  const prev = proxyMap.value
  const nextKeys = Object.keys(next)
  let changed = Object.keys(prev).length !== nextKeys.length
  const merged: Record<string, Proxy> = {}

  for (const name of nextKeys) {
    const oldNode = prev[name]
    const nextNode = next[name]

    if (oldNode && jsonOfNode(oldNode) === jsonOfNode(nextNode)) {
      merged[name] = oldNode
    } else {
      merged[name] = nextNode
      changed = true
    }
  }

  if (changed) {
    proxyMap.value = merged
  }
}

export const speedtestUrlWithDefault = computed(() => {
  return speedtestUrl.value || TEST_URL
})

export const getTestUrl = (groupName?: string) => {
  if (!groupName || !independentLatencyTest.value) {
    return speedtestUrlWithDefault.value
  }

  const groupTestUrl = groupTestUrls.value.find((item) => item.name === groupName)

  if (groupTestUrl) {
    return groupTestUrl.url
  }

  const proxyNode =
    proxyMap.value[groupName] || proxyProviederList.value.find((p) => p.name === groupName)

  return proxyNode?.testUrl || speedtestUrlWithDefault.value
}

export const getLatencyFromHistory = (history?: Proxy['history']) => {
  return last(history)?.delay ?? NOT_CONNECTED
}

const DEFAULT_TEST_URL_BUCKET = ''

const latencyMapCache = new Map<string, ComputedRef<LatencyMap>>()

const readHistory = (proxyName: string, testUrl: string) => {
  const proxyNode = proxyMap.value[proxyName]

  if (testUrl !== DEFAULT_TEST_URL_BUCKET) {
    if (!proxyNode) {
      return undefined
    }

    if (proxyNode.extra) {
      return proxyNode.extra[testUrl]?.history
    }
  }

  return proxyMap.value[getNowProxyNodeName(proxyName)]?.history
}

const latencyScope = effectScope(true)

const getLatencyMap = (testUrl: string) => {
  let latencyMap = latencyMapCache.get(testUrl)

  if (!latencyMap) {
    latencyMap = latencyScope.run(() =>
      computed(() => {
        const result: LatencyMap = new Map()

        for (const name of Object.keys(proxyMap.value)) {
          result.set(name, getLatencyFromHistory(readHistory(name, testUrl)))
        }

        return result
      }),
    )!
    latencyMapCache.set(testUrl, latencyMap)
  }

  return latencyMap
}

const getTestUrlBucket = (groupName?: string) => {
  if (groupName && independentLatencyTest.value && can('independentLatency')) {
    return getTestUrl(groupName)
  }

  return DEFAULT_TEST_URL_BUCKET
}

export const latencyMapOf = (groupName?: MaybeRefOrGetter<string | undefined>) =>
  computed(() => getLatencyMap(getTestUrlBucket(toValue(groupName))).value)

export const getLatencyByName = (proxyName: string, groupName?: string) => {
  return getLatencyMap(getTestUrlBucket(groupName)).value.get(proxyName) ?? NOT_CONNECTED
}

// 读路径上一次都不能写:往节点对象里补一个后端没有的 extra 空桶,会让 mergeProxyMap 的
// JSON 判等必然不等 → 整张 proxyMap 换引用 → 所有组重算重渲染 → 下一帧再补桶,形成自持环。
// 结构补齐属于 latency.ts 的测速写路径。空历史返回共享常量而不是新建 [],是因为这函数在每轮
// 渲染里按节点数被调到,N 次即抛数组分配没有意义;不导出以免外部拿去 push。
const EMPTY_HISTORY: Proxy['history'] = []

export const getHistoryByName = (proxyName: string, groupName?: string) => {
  if (groupName && independentLatencyTest.value && can('independentLatency')) {
    const proxyNode = proxyMap.value[proxyName]
    const url = getTestUrl(groupName)

    if (!proxyNode) {
      return []
    }

    // 不下发 extra 的内核走链路终端节点的 history
    if (!proxyNode.extra) {
      const nowNode = proxyMap.value[getNowProxyNodeName(proxyName)]

      return nowNode?.history
    }

    return proxyNode.extra[url]?.history ?? EMPTY_HISTORY
  }

  const nowNode = proxyMap.value[getNowProxyNodeName(proxyName)]

  return nowNode?.history
}

export const getIPv6ByName = (proxyName: string) => {
  return IPv6Map.value[getNowProxyNodeName(proxyName)]
}

export const getNowProxyNodeName = (name: string) => {
  let node = proxyMap.value[name]

  if (!name || !node) {
    return name
  }

  while (node.now && node.now !== node.name) {
    const nextNode = proxyMap.value[node.now]

    if (!nextNode) {
      return node.name
    }

    node = nextNode
  }

  return node.name
}

export const getProxyGroupChains = (name: string) => {
  let proxyNode = proxyMap.value[name]

  if (!proxyNode) {
    return []
  }

  const result = [name]

  while (
    proxyNode.now &&
    proxyNode.now !== proxyNode.name &&
    proxyGroupList.value.includes(proxyNode.now)
  ) {
    result.push(proxyNode.now)
    proxyNode = proxyMap.value[proxyNode.now]
  }
  return result
}

export const hasSmartGroup = computed(() => {
  return Object.values(proxyMap.value).some(
    (proxy) => proxy.type.toLowerCase() === PROXY_TYPE.Smart,
  )
})

const untestableProxyTypes = new Set([PROXY_TYPE.Reject, PROXY_TYPE.RejectDrop, PROXY_TYPE.Block])

export const isLatencyTestable = (name: string) => {
  const type = proxyMap.value[name]?.type.toLowerCase() as PROXY_TYPE | undefined

  return !type || !untestableProxyTypes.has(type)
}

export const getProviderNameByProxy = (proxyName: string) => {
  const hinted = proxyMap.value[proxyName]?.['provider-name']

  if (hinted) {
    return proxyProviederList.value.some((provider) => provider.name === hinted) ? hinted : ''
  }

  return (
    proxyProviederList.value.find((provider) =>
      provider.proxies.some((proxy) => proxy.name === proxyName),
    )?.name ?? ''
  )
}
