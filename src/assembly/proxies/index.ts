// 组装层 · proxies 门面。
// 持有代理的「视图状态」与纯读取 helper,拉取转交 clash 实现。
import { can } from '@/assembly/backend'
import { NOT_CONNECTED, PROXY_TAB_TYPE, PROXY_TYPE, TEST_URL } from '@/constant'
import { notifyRequestError } from '@/helper/requestError'
import { useStorage } from '@/helper/storage'
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
import * as clash from './clash'

export const proxiesFilter = ref('')
export const proxiesTabShow = ref(PROXY_TAB_TYPE.PROXIES)

// 整体替换 + 节点对象不可变的写入模式(见 clash.ts 的 mergeProxyMap/setProxyNode):
// shallowRef 免去为几百个节点对象建深代理;未变节点保持引用稳定,下游组件不重渲染。
export const proxyGroupList = shallowRef<string[]>([])
export const proxyMap = shallowRef<Record<string, Proxy>>({})
export const IPv6Map = useStorage<Record<string, boolean>>('cache/ipv6-map', {})
export const hiddenGroupMap = useStorage<Record<string, boolean>>('config/hidden-group-map', {})
export const proxyProviederList = shallowRef<ProxyProvider[]>([])

export type LatencyMap = Map<string, number>

// 批量测速进行中的计数(组测速/全量测速)。LatencyTag 据此在测速潮里跳过 CountUp 动画。
export const batchTestingCount = ref(0)
export const isBatchLatencyTesting = computed(() => batchTestingCount.value > 0)

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
// props 恒等、子树更新被 Vue 跳过 —— 两种后端的"整棵替换→全页重渲染"共用根治点。
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

/*
 * 全局延迟表。
 *
 * 单看一个节点的延迟并不便宜:要顺着 now 链一路走到真正出网的那个节点,独立延迟测试下
 * 还要按组的测速 url 分桶。过去这件事由每张组卡片各做各的,150 个组就把同一批节点
 * 重复解析上百遍,还只能自己用。
 *
 * 这里改成按测速 url 建一张覆盖 proxyMap 的全量表:一趟 O(节点数) 建好,卡片、排序、
 * 筛选、预览、可用计数全部 O(1) 查表,口径也只剩一个。
 *
 * 依赖是自动的 —— 建表时读到了每个节点的 history 与 now,任何一次测速写入或选择变更
 * 都会让表整体作废、下次读取时重算。
 *
 * 缓存按 url 存,url 集合就是「默认测速地址 + 各组自定义地址」,数量有限;没人读的表
 * (比如切了后端之后不再用到的 url)只是留着不算,不必回收。
 */
const DEFAULT_TEST_URL_BUCKET = ''

const latencyMapCache = new Map<string, ComputedRef<LatencyMap>>()

// getHistoryByName 会顺手把缺失的 extra 桶补出来,那是个写操作,不能放进 computed。
// 建表用这个只读版本,语义与之相同:extra 存在就只认对应 url 的桶,否则回到 now 链末端。
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

// 表是全局的,但第一次用到它的往往是某张卡片的 setup。不放进独立 scope 的话,
// 这个 computed 会被那张卡片的 scope 收走,卡片一卸载它就被 stop,从此每次读都重算全表。
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

// 独立延迟测试关掉时全站共用一张表,开着时每个测速 url 一张
const getTestUrlBucket = (groupName?: string) => {
  if (groupName && independentLatencyTest.value && can('independentLatency')) {
    return getTestUrl(groupName)
  }

  return DEFAULT_TEST_URL_BUCKET
}

/*
 * 供「一次要读一批节点延迟」的地方使用(筛选、排序、预览、计数):
 * 拿到表本身,循环里就不必每个节点重新判一遍该查哪张表。
 */
export const latencyMapOf = (groupName?: MaybeRefOrGetter<string | undefined>) =>
  computed(() => getLatencyMap(getTestUrlBucket(toValue(groupName))).value)

export const getLatencyByName = (proxyName: string, groupName?: string) => {
  return getLatencyMap(getTestUrlBucket(groupName)).value.get(proxyName) ?? NOT_CONNECTED
}

// 读路径上一次都不能写:往节点对象里补一个后端没有的 extra 空桶,会让 mergeProxyMap 的
// JSON 判等必然不等 → 整张 proxyMap 换引用 → 所有组重算重渲染 → 下一帧再补桶,形成自持环。
// 结构补齐属于 clash.ts 的测速写路径。空历史返回共享常量而不是新建 [],是因为这函数在每轮
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

// ---------- 转交 clash 实现的组装动作 ----------

export const fetchProxies = (options?: { maxAge?: number }) => clash.fetchProxies(options)

// 切换节点只会由用户点击触发,且调用点都是模板里的 @click(没有 catch 的落点),
// 所以在门面里兜住:失败弹提示,否则 UI 会停在旧选择上一声不吭。
export const handlerProxySelect = async (proxyGroupName: string, proxyName: string) => {
  try {
    return await clash.handlerProxySelect(proxyGroupName, proxyName)
  } catch (e) {
    notifyRequestError(e)
  }
}

export const proxyLatencyTest = (proxyName: string, url?: string, timeout?: number) =>
  clash.proxyLatencyTest(proxyName, url, timeout)

export const proxyGroupLatencyTest = (proxyGroupName: string) =>
  clash.proxyGroupLatencyTest(proxyGroupName)

export const allProxiesLatencyTest = () => clash.allProxiesLatencyTest()

// 代理集 / smart 权重动作(Clash 专属),经 proxies 域门面暴露给 view 与 store/smart。
export {
  fetchSmartGroupWeightsAPI,
  fetchSmartWeightsAPI,
  flushSmartGroupWeightsAPI,
  proxyProviderHealthCheckAPI,
  updateProxyProviderAPI,
} from '@/api/clash'
