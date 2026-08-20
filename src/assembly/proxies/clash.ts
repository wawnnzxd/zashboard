// Clash REST/WS 后端的代理「组装逻辑」:从 /proxies、/providers/proxies 拉取并
// 组装视图状态,以及选择/测速等动作。写入门面 index.ts 的共享状态。
import {
  deleteFixedProxyAPI,
  fetchProxiesAPI,
  fetchProxyGroupLatencyAPI,
  fetchProxyLatencyAPI,
  fetchProxyProviderAPI,
  fetchProxyProviderLatencyAPI,
  fetchSingleProxyAPI,
  selectProxyAPI,
} from '@/api/clash'
import { can } from '@/assembly/backend'
import { disconnectConnections } from '@/assembly/connections'
import { createSessionResource } from '@/assembly/sessionResource'
import { GLOBAL, IPV6_TEST_URL, NOT_CONNECTED, PROXY_TYPE, SPEEDTEST_MODE } from '@/constant'
import { getConnectionChains, isProxyGroup } from '@/helper'
import { showNotification } from '@/helper/notification'
import { activeConnections } from '@/store/connections'
import {
  automaticDisconnection,
  iconReflectList,
  independentLatencyTest,
  IPv6test,
  speedtestMode,
  speedtestTimeout,
} from '@/store/settings'
import { initSmartWeights } from '@/store/smart'
import type { Proxy } from '@/types'
import { last } from 'lodash-es'
import pLimit from 'p-limit'
import {
  batchTestingCount,
  getNowProxyNodeName,
  getTestUrl,
  IPv6Map,
  mergeProxyMap,
  proxyGroupList,
  proxyMap,
  proxyProviederList,
  speedtestUrlWithDefault,
} from './index'

// 单节点/单组的不可变更新:换外层引用触发 shallowRef,未涉及的节点保持引用稳定。
const setProxyNode = (name: string, node: Proxy) => {
  proxyMap.value = { ...proxyMap.value, [name]: node }
}

const setProxyNodeFields = (name: string, fields: Partial<Proxy>) => {
  const node = proxyMap.value[name]

  if (!node) {
    return
  }
  setProxyNode(name, { ...node, ...fields })
}

// 解析阶段:只做网络与纯计算,把所有写入收进返回的提交闭包。
// 代际比对由 SessionResource 统一做一次 —— 原实现在这里靠 `fetchTime !== nowTime` 自守,
// 而它在有了 in-flight 去重之后恒为 false(第二个调用者拿到的是同一个 promise,根本不会重设 fetchTime),
// 是一道死掉的守卫;真正需要的「旧后端响应不得回填新会话」当时完全没有。
const resolveProxies = async (signal: AbortSignal) => {
  const [proxyRes, providerRes] = await Promise.all([
    fetchProxiesAPI({ signal }),
    fetchProxyProviderAPI({ signal }),
  ])
  const proxyData = proxyRes.data
  const providerData = providerRes.data

  const sortIndex = proxyData.proxies[GLOBAL]?.all ?? []
  const allProviderProxies: Record<string, Proxy> = {}
  const providers = Object.values(providerData.providers).filter(
    (provider) => provider.name !== 'default' && provider.vehicleType !== 'Compatible',
  )

  for (const provider of providers) {
    for (const proxy of provider.proxies) {
      proxy['provider-name'] ||= provider.name
      allProviderProxies[proxy.name] = proxy
    }
  }

  const next: Record<string, Proxy> = {
    ...allProviderProxies,
    ...proxyData.proxies,
  }

  const smartGroups: string[] = []
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
      smartGroups.push(name)
    }
  })

  const nextGroupList = Object.values(proxyData.proxies)
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
      // 都在 sortIndex 中，按索引排序
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

    if (smartGroups.length > 0) {
      initSmartWeights(smartGroups)
    }
  }
}

// in-flight 去重 + 代际守卫 + 新鲜度窗口:启动双拉、导航重拉、回前台重拉共用同一入口,
// 不再并发发出多份 MB 级全量请求,也不会让上一个后端的响应回填到新会话里。
const proxiesResource = createSessionResource(resolveProxies)

export const fetchProxies = (options?: { maxAge?: number }) => proxiesResource.fetch(options)

/** 写操作(更新订阅、切换节点等)之后调用:让下一次 fetchProxies 必然真发。 */
export const invalidateProxies = () => proxiesResource.invalidate()

// 点选后只刷新该组(GET /proxies/{name},1-2KB):原实现每次点选 fire-and-forget
// 全量重拉 /proxies + /providers/proxies(千节点 0.5~3MB),且"已选中"分支读的是
// 重拉前捕获的旧对象引用,判断恒真、重拉结果从未被使用。
const refreshSingleProxy = async (name: string) => {
  try {
    const { data } = await fetchSingleProxyAPI(name)
    const oldNode = proxyMap.value[name]

    if (!oldNode || JSON.stringify(oldNode) !== JSON.stringify(data)) {
      setProxyNode(name, data)
    }
  } catch {
    // 忽略,下一次全量刷新自然对齐
  }
}

export const handlerProxySelect = async (proxyGroupName: string, proxyName: string) => {
  const proxyGroup = proxyMap.value[proxyGroupName]

  if (!proxyGroup || proxyGroup.type.toLowerCase() === PROXY_TYPE.LoadBalance) return
  if (proxyGroup.now === proxyName) {
    await refreshSingleProxy(proxyGroupName)
    if (proxyMap.value[proxyGroupName]?.now === proxyName) return
  }

  await selectProxyAPI(proxyGroupName, proxyName)
  setProxyNodeFields(proxyGroupName, { now: proxyName })

  if (automaticDisconnection.value) {
    const matching = activeConnections.value.filter((c) =>
      getConnectionChains(c).includes(proxyGroupName),
    )

    disconnectConnections(matching, activeConnections.value.length)
  }
  refreshSingleProxy(proxyGroupName)
}

const getProviderNameByProxy = (proxyName: string) => {
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

// provider 节点走 provider 作用域的 healthcheck 端点,避免节点不在
// 全局 /proxies 映射(或同名冲突)导致测速失败
const fetchNodeLatency = (proxyName: string, url: string, timeout: number) => {
  const providerName = getProviderNameByProxy(proxyName)

  if (providerName) {
    return fetchProxyProviderLatencyAPI(providerName, proxyName, url, timeout)
  }

  return fetchProxyLatencyAPI(proxyName, url, timeout)
}

const latencyTestForSingle = async (proxyName: string, url: string, timeout: number) => {
  const now = getNowProxyNodeName(proxyName)

  if (IPv6test.value) {
    try {
      const { data: ipv6LatencyResult } = await fetchNodeLatency(now, IPV6_TEST_URL, 2000)

      IPv6Map.value[now] = ipv6LatencyResult.delay > NOT_CONNECTED
    } catch {
      IPv6Map.value[now] = false
    }
  }

  return await fetchNodeLatency(independentLatencyTest.value ? proxyName : now, url, timeout)
}

const getNameForNotification = (name: string, url: string) => {
  if (independentLatencyTest.value) {
    return `${name}\n@${url}`
  }

  return name
}

export const proxyLatencyTest = async (
  proxyName: string,
  url = speedtestUrlWithDefault.value,
  timeout = speedtestTimeout.value,
) => {
  const res = await latencyTestForSingle(proxyName, url, timeout)

  // 内核的写响应已经把延迟给了我们,不需要再花一次全量 /proxies + /providers/proxies 往返去问同一个问题。
  // 回读除了浪费,还打开了一整类竞态:in-flight 去重会让这次回读搭上「写入之前就发出」的那份请求,
  // 于是延迟不更新、紧接着按旧数据统计出的成功/失败数还会报出并不存在的失败。
  // 'sync' 是因为调用方(ProxyNodeCard)在 await 返回后立刻要量卡片坐标做滚动定位。
  setHistory(proxyName, res.status === 200 ? res.data.delay : NOT_CONNECTED, url, 'sync')

  if (res.status !== 200) {
    showNotification({
      content: 'testFailedTip',
      params: {
        name: getNameForNotification(proxyName, url),
      },
      type: 'alert-error',
    })
  }
}

// 测速结果先进非响应式缓冲,200ms 批量 flush 成一次不可变 map 更新:
// 并发 5 的测速流下,原先每个结果到达都级联全部相关组 O(N) 重算(整轮 O(N²))。
type PendingLatency = { name: string; url: string; delay: number }
let pendingLatencies: PendingLatency[] = []
let latencyFlushTimer: ReturnType<typeof setTimeout> | null = null

const flushLatencies = () => {
  latencyFlushTimer = null
  if (!pendingLatencies.length) {
    return
  }
  const batch = pendingLatencies

  pendingLatencies = []

  const next = { ...proxyMap.value }
  const time = new Date().toISOString()
  let touched = false

  for (const { name, url, delay } of batch) {
    const entry = { time, delay }

    if (independentLatencyTest.value && can('independentLatency')) {
      const node = next[name]

      if (!node) continue
      const bucket = node.extra?.[url] ?? { history: [], alive: true }

      next[name] = {
        ...node,
        extra: {
          ...(node.extra ?? {}),
          [url]: { ...bucket, history: [...(bucket.history ?? []), entry] },
        },
      }
      touched = true
    } else {
      // 非独立模式与原实现一致:写入链路解析后的终端节点
      const targetName = getNowProxyNodeName(name)
      const node = next[targetName]

      if (!node) continue
      next[targetName] = { ...node, history: [...(node.history ?? []), entry] }
      touched = true
    }
  }

  if (touched) {
    proxyMap.value = next
  }
}

// flush 策略是接口的一部分,而不是隐含时序:调用方若在 await 返回后立刻要量坐标
// (ProxyNodeCard 测速完要把卡片滚到视野中央),就必须拿到 'sync';
// 批量测速那种一轮几十上百条的场景用默认的 'batched',避免每条结果都级联全组重算。
const setHistory = (
  proxyName: string,
  delay: number,
  url: string,
  flush: 'sync' | 'batched' = 'batched',
) => {
  pendingLatencies.push({ name: proxyName, url, delay })

  if (flush === 'sync') {
    if (latencyFlushTimer) {
      clearTimeout(latencyFlushTimer)
    }
    flushLatencies()
    return
  }

  if (!latencyFlushTimer) {
    latencyFlushTimer = setTimeout(flushLatencies, 200)
  }
}

const TIP_KEY = 'testLatencyOneByOneWithTip'
const limiter = pLimit(5)
const untestableProxyTypes = new Set([PROXY_TYPE.Reject, PROXY_TYPE.RejectDrop, PROXY_TYPE.Block])
const isLatencyTestable = (name: string) => {
  const type = proxyMap.value[name]?.type.toLowerCase() as PROXY_TYPE | undefined

  return !type || !untestableProxyTypes.has(type)
}

const testLatencyOneByOneWithTip = async (
  proxyGroupName: string,
  nodes: string[],
  url = speedtestUrlWithDefault.value,
) => {
  const total = nodes.length
  let testDone = 0
  let testFailed = 0

  batchTestingCount.value++
  try {
    await Promise.allSettled(
      nodes.map((name) =>
        limiter(async () => {
          const res = await latencyTestForSingle(name, url, Math.min(2000, speedtestTimeout.value))

          if (res.status !== 200) {
            testFailed++
            setHistory(name, NOT_CONNECTED, url)
          } else {
            setHistory(name, res.data.delay, url)
          }
          testDone++
          showNotification({
            content: 'testFinishedTip',
            key: TIP_KEY + proxyGroupName,
            params: {
              name: getNameForNotification(proxyGroupName, url),
              total: total.toString(),
              number: testDone.toString(),
            },
            type: 'alert-info',
            timeout: 0,
          })
        }),
      ),
    )
  } finally {
    batchTestingCount.value--
  }
  showNotification({
    content: 'testFinishedResultTip',
    key: TIP_KEY + proxyGroupName,
    params: {
      name: getNameForNotification(proxyGroupName, url),
      total: total.toString(),
      success: `${total - testFailed}`,
      failed: `${testFailed}`,
    },
    type: testFailed ? 'alert-warning' : 'alert-success',
    timeout: 3000,
  })
}

export const proxyGroupLatencyTest = async (proxyGroupName: string) => {
  const proxyNode = proxyMap.value[proxyGroupName]
  const all = (proxyNode.all ?? []).filter(isLatencyTestable)
  const url = getTestUrl(proxyGroupName)

  if (
    speedtestMode.value === SPEEDTEST_MODE.DASHBOARD &&
    [PROXY_TYPE.Selector, PROXY_TYPE.LoadBalance, PROXY_TYPE.Smart].includes(
      proxyNode.type.toLowerCase() as PROXY_TYPE,
    )
  ) {
    if (proxyNode.fixed) {
      deleteFixedProxyAPI(proxyGroupName)
    }
    return testLatencyOneByOneWithTip(proxyGroupName, all, url)
  }

  const timeout = Math.max(5000, speedtestTimeout.value)
  let latencyResult: Record<string, number> = {}

  batchTestingCount.value++
  try {
    if (IPv6test.value) {
      try {
        const { data: ipv6LatencyResult } = await fetchProxyGroupLatencyAPI(
          proxyGroupName,
          IPV6_TEST_URL,
          timeout,
        )

        all?.forEach((name) => {
          IPv6Map.value[getNowProxyNodeName(name)] = ipv6LatencyResult[name] > NOT_CONNECTED
        })
      } catch {
        all?.forEach((name) => {
          IPv6Map.value[getNowProxyNodeName(name)] = false
        })
      }
    }
    // 同上:/group/{n}/delay 返回的就是 Record<节点名, 延迟>,逐条本地写入即可,
    // 既不需要全量回读,统计也直接用这份权威结果算(回读版会把「写入前发出的那份响应」当成结果,
    // 于是明明测通了却报一堆失败)。
    const { data } = await fetchProxyGroupLatencyAPI(proxyGroupName, url, timeout)

    latencyResult = data
    for (const name of all) {
      setHistory(name, latencyResult[name] ?? NOT_CONNECTED, url)
    }
  } finally {
    batchTestingCount.value--
  }

  const total = all.length
  const testFailed = all.filter((name) => !(latencyResult[name] > NOT_CONNECTED)).length

  showNotification({
    content: 'testFinishedResultTip',
    key: TIP_KEY + proxyGroupName,
    params: {
      name: getNameForNotification(proxyGroupName, url),
      total: total.toString(),
      success: `${total - testFailed}`,
      failed: `${testFailed}`,
    },
    type: testFailed ? 'alert-warning' : 'alert-success',
    timeout: 3000,
  })
}

export const allProxiesLatencyTest = async () => {
  if (independentLatencyTest.value) {
    const limit = pLimit(3)

    return await Promise.all(
      proxyGroupList.value.map((proxyGroupName) =>
        limit(async () => {
          await proxyGroupLatencyTest(proxyGroupName)
        }),
      ),
    )
  }

  const proxyNode = Object.keys(proxyMap.value).filter((proxy) => !isProxyGroup(proxy))

  return testLatencyOneByOneWithTip('all', proxyNode)
}

const getIPv6FromExtra = (proxy: Proxy) => {
  const ipv6History = proxy.extra?.[IPV6_TEST_URL]?.history

  return (last(ipv6History)?.delay ?? NOT_CONNECTED) > NOT_CONNECTED
}
