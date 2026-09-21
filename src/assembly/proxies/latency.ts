import { can } from '@/assembly/backend'
import { driver } from '@/assembly/driver'
import { IPV6_TEST_URL, NOT_CONNECTED, PROXY_TYPE, SPEEDTEST_MODE } from '@/constant'
import { isProxyGroup } from '@/helper'
import { showNotification } from '@/helper/notification'
import { notifyRequestError } from '@/helper/request-error'
import { i18n } from '@/i18n'
import { independentLatencyTest, IPv6test, speedtestMode, speedtestTimeout } from '@/store/settings'
import pLimit from 'p-limit'
import { invalidateProxies } from './actions'
import {
  batchTestingCount,
  getNowProxyNodeName,
  getProviderNameByProxy,
  getTestUrl,
  IPv6Map,
  isLatencyTestable,
  proxyGroupList,
  proxyMap,
  speedtestUrlWithDefault,
} from './state'

// provider 节点走 provider 作用域的 healthcheck 端点,避免节点不在
// 全局 /proxies 映射(或同名冲突)导致测速失败
const testNodeLatency = (proxyName: string, url: string, timeout: number) => {
  const providerName = getProviderNameByProxy(proxyName)

  if (providerName) {
    return driver().proxies.testProviderNode(providerName, proxyName, url, timeout)
  }

  return driver().proxies.testNode(proxyName, url, timeout)
}

const latencyTestForSingle = async (proxyName: string, url: string, timeout: number) => {
  const now = getNowProxyNodeName(proxyName)

  if (IPv6test.value) {
    try {
      IPv6Map.value[now] = (await testNodeLatency(now, IPV6_TEST_URL, 2000)) > NOT_CONNECTED
    } catch {
      IPv6Map.value[now] = false
    }
  }

  return await testNodeLatency(independentLatencyTest.value ? proxyName : now, url, timeout)
}

const getNameForNotification = (name: string, url: string) => {
  if (independentLatencyTest.value) {
    return `${name}\n@${url}`
  }

  return name
}

// 测速结果先进非响应式缓冲,200ms 批量 flush 成一次不可变 map 更新:
// 并发 5 的测速流下,每个结果到达都各自换一次 proxyMap 会级联全部相关组 O(N) 重算(整轮 O(N²))。
// 写入必须是不可变的 —— proxyMap 是 shallowRef,往 history 里就地 push 不会触发任何更新
// (上游的 setHistory 就是 getHistoryByName(...).push,在这里行不通,而且读路径现在会返回共享的空数组)。
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
      // 非独立模式:写入链路解析后的终端节点
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

export const proxyLatencyTest = async (
  proxyName: string,
  url = speedtestUrlWithDefault.value,
  timeout = speedtestTimeout.value,
) => {
  // 测速失败就是「这个节点不通」,用统一的 testFailedTip 说明,比抛出 HTTP 报文有用。
  // 内核的写响应已经把延迟给了我们,不需要再花一次全量 /proxies + /providers/proxies 往返
  // 去问同一个问题(上游在 finally 里回读)。回读除了浪费,还打开一整类竞态:in-flight 去重
  // 会让这次回读搭上「写入之前就发出」的那份请求,于是延迟不更新、紧接着按旧数据统计出的
  // 成功/失败数还会报出并不存在的失败。
  // 'sync' 是因为调用方(ProxyNodeCard)在 await 返回后立刻要量卡片坐标做滚动定位。
  try {
    const delay = await latencyTestForSingle(proxyName, url, timeout)

    setHistory(proxyName, delay, url, 'sync')
  } catch {
    setHistory(proxyName, NOT_CONNECTED, url, 'sync')

    showNotification({
      content: 'testFailedTip',
      params: {
        name: getNameForNotification(proxyName, url),
      },
      type: 'alert-error',
    })
  }
}

const TIP_KEY = 'testLatencyOneByOneWithTip'
const limiter = pLimit(5)

// tipName 只用于提示文案(可能是 i18n 的「全部」);延迟落哪个桶由 url 决定,
// 调用方按组算好后传进来(独立延迟测试下就是该组的 test-url)。
const testLatencyOneByOneWithTip = async (
  tipName: string,
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
          // 批量测速里单个节点失败是常态,只计数,不逐个弹提示,末尾汇总成一条。
          try {
            const delay = await latencyTestForSingle(
              name,
              url,
              Math.min(2000, speedtestTimeout.value),
            )

            setHistory(name, delay, url)
          } catch {
            testFailed++
            setHistory(name, NOT_CONNECTED, url)
          } finally {
            testDone++
            showNotification({
              content: 'testFinishedTip',
              key: TIP_KEY + tipName,
              params: {
                name: getNameForNotification(tipName, url),
                total: total.toString(),
                number: testDone.toString(),
              },
              type: 'alert-info',
              timeout: 0,
            })
          }
        }),
      ),
    )
  } finally {
    batchTestingCount.value--
  }

  // 这一轮的乐观写入用的就是内核返回的权威延迟,不必再全量回读一次;只把缓存标记为失效,
  // 让下一次真正需要 /proxies 的读自然拿到新的(直接 await fetchProxies() 会被 in-flight
  // 去重搭上「写入之前就发出」的那份请求,反而用旧数据盖掉刚测出来的结果)。
  invalidateProxies()

  showNotification({
    content: 'testFinishedResultTip',
    key: TIP_KEY + tipName,
    params: {
      name: getNameForNotification(tipName, url),
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
      // 测速前的准备动作,失败也照常往下测
      driver()
        .proxies.clearFixed(proxyGroupName)
        .catch(() => {})
    }
    return testLatencyOneByOneWithTip(proxyGroupName, all, url)
  }

  const timeout = Math.max(5000, speedtestTimeout.value)
  let latencyResult: Record<string, number> = {}

  batchTestingCount.value++
  try {
    if (IPv6test.value) {
      try {
        const ipv6LatencyResult = await driver().proxies.testGroup(
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
    // /group/{n}/delay 返回的就是 Record<节点名, 延迟>,逐条本地写入即可,
    // 既不需要全量回读,统计也直接用这份权威结果算(回读版会把「写入前发出的那份响应」当成结果,
    // 于是明明测通了却报一堆失败)。
    latencyResult = await driver().proxies.testGroup(proxyGroupName, url, timeout)

    for (const name of all) {
      setHistory(name, latencyResult[name] ?? NOT_CONNECTED, url)
    }
  } catch (e) {
    // 整组测速请求本身失败(而不是某个节点不通):统一走请求错误提示,不再往下报「全失败」
    notifyRequestError(e)
    return
  } finally {
    batchTestingCount.value--
    invalidateProxies()
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

  const proxyNode = Object.keys(proxyMap.value).filter(
    (proxy) => !isProxyGroup(proxy) && isLatencyTestable(proxy),
  )

  return testLatencyOneByOneWithTip(i18n.global.t('all'), proxyNode)
}
