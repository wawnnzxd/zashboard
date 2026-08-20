import { ENDPOINT_RADIUS, toEarthVector } from './earthMath'
import type { EarthRenderEndpoint, EarthRenderSnapshot } from './rendererTypes'
import type { EarthHostTraffic, EarthRoute } from './types'

const TOP_HOST_LIMIT = 5

// 两条路由并到同一个端点时,同名主机必须按主机名累加而不是各占一行 —— 浏览器对同一个
// CDN 域名常年 6-8 条并发,直接 flat + 排序会让同一个域名重复出现,且每行只带其中一条
// 连接的下载量,排序也变成按「单条连接最大值」而非主机总量。与 routes.ts 的 topHosts 同形
const mergeTopHosts = (...groups: readonly EarthHostTraffic[][]): EarthHostTraffic[] => {
  const totals = new Map<string, number>()

  for (const group of groups) {
    for (const { host, downloaded } of group) {
      totals.set(host, (totals.get(host) ?? 0) + downloaded)
    }
  }

  return [...totals]
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_HOST_LIMIT)
    .map(([host, downloaded]) => ({ host, downloaded }))
}

export const createEarthRenderSnapshot = (incomingRoutes: readonly EarthRoute[]) => {
  // 只做一层浅拷贝(sort 是就地的,且入参声明为 readonly,不能排调用方的数组)。
  // 路由对象本身每拍都是 buildEarthRoutes 新建的,快照的消费者(routeLayer / endpointLayer /
  // 悬停浮层)全都只读;endpointLayer 另有自己的 cloneEndpoint 做隔离,再深拷贝一遍纯属浪费。
  // 比较用码位序而非 localeCompare:这里只要一个稳定的顺序,不面向人阅读
  const routes = [...incomingRoutes].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  )
  const signature = routes.map(({ key }) => key).join('|')
  const endpoints = new Map<string, EarthRenderEndpoint>()

  for (const route of routes) {
    for (const point of route.path) {
      const key = `${point.role}:${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`
      const existing = endpoints.get(key)

      if (existing) {
        existing.connections += route.connections
        if (point.role === 'destination') {
          existing.topHosts = mergeTopHosts(existing.topHosts, route.topHosts)
        }
      } else {
        endpoints.set(key, {
          key,
          city: point.city,
          country: point.country,
          role: point.role,
          connections: route.connections,
          topHosts: point.role === 'destination' ? [...route.topHosts] : [],
          position: toEarthVector(point).multiplyScalar(ENDPOINT_RADIUS),
        })
      }
    }
  }

  return {
    signature,
    routes,
    endpoints: [...endpoints.values()],
  } satisfies EarthRenderSnapshot
}
