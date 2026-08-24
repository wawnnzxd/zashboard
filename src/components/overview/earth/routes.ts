import { connectionAccessor } from '@/assembly/connections'
import type { Connection } from '@/types'
import * as ipaddr from 'ipaddr.js'
import type { EarthHostTraffic, EarthLocation, EarthLocationHint, EarthRoute } from './types'

type LocatedCoordinates = { latitude: number; longitude: number }

interface RouteCandidate {
  destinationIP: string
  upload: number
  download: number
  host: string
  downloaded: number
}

// 只由 IP 字面量可能用到的字符组成(十六进制位、'.'、':',外加 RFC 4007 的 %zone)。
// 目的地经常是域名,而 ipaddr.parse 对域名要抛两个带栈 Error 才返回失败 ——
// 这道守卫让绝大多数域名在进 parse 之前就出局。注意它只是廉价的前置否定:
// 通过守卫的字符串仍然交给 ipaddr 判定,所以不会放松任何合法性要求。
const IP_LITERAL_CHARS = /^[0-9a-fA-F.:]+(?:%[0-9a-zA-Z]+)?$/

const normalizeIP = (value: string) => {
  if (!IP_LITERAL_CHARS.test(value)) return null

  try {
    return ipaddr.parse(value).toNormalizedString()
  } catch {
    return null
  }
}

/** Splits IP, IP:port and bracketed IPv6 without interpreting a domain as an IP. */
const parseDestination = (rawValue: string) => {
  const value = rawValue.trim()

  if (!value) return null

  // 整串先试是必须的:'2001:db8::1' 只有整串才能解析,先按最后一个冒号切会把它切坏。
  const bareIP = normalizeIP(value)

  if (bareIP) return bareIP

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')

    if (closingBracket > 1) return normalizeIP(value.slice(1, closingBracket))
  }

  const lastColon = value.lastIndexOf(':')

  if (lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1))) {
    return normalizeIP(value.slice(0, lastColon))
  }

  return null
}

// 后端每秒推一次全量连接快照,同一条连接的 destination 字符串每秒原样再来一遍,
// 而解析是纯字符串函数 —— 结果只取决于入参,可以永久记忆。不缓存的话 2000 条连接
// 每秒要重跑一遍多趟正则解析(实测全域名 24.8ms/秒)。失败结果(null)同样要缓存,
// 因为域名恰恰是最贵的那一类输入。
//
// 上限用 FIFO 兜住:目的地字符串集合会随连接 churn 无界增长,不能让它变成内存泄漏。
const DESTINATION_CACHE_LIMIT = 4096
const destinationCache = new Map<string, string | null>()

const destinationIP = (rawValue: string) => {
  const cached = destinationCache.get(rawValue)

  // 用 undefined 而不是真值判断,否则缓存下来的 null(域名)每次都会重算
  if (cached !== undefined) return cached

  const value = parseDestination(rawValue)

  if (destinationCache.size >= DESTINATION_CACHE_LIMIT) {
    const oldest = destinationCache.keys().next().value

    if (oldest !== undefined) destinationCache.delete(oldest)
  }
  destinationCache.set(rawValue, value)

  return value
}

const extractCandidates = (connections: readonly Connection[]): RouteCandidate[] => {
  const accessor = connectionAccessor()
  const candidates: RouteCandidate[] = []

  for (const connection of connections) {
    const destination = destinationIP(accessor.destination(connection))

    if (!destination) continue

    const rawHost = accessor.hostname(connection).trim().replace(/\.$/, '')

    candidates.push({
      destinationIP: destination,
      upload: Math.max(0, connection.uploadSpeed),
      download: Math.max(0, connection.downloadSpeed),
      host: rawHost || destination,
      downloaded: Math.max(0, accessor.download(connection)),
    })
  }

  return candidates
}

const coordinateKey = ({ latitude, longitude }: EarthLocation) =>
  `${latitude.toFixed(4)},${longitude.toFixed(4)}`

const TOP_HOST_LIMIT = 5

/** 一条路由的聚合中间态:hosts 按主机名累加,只在最后折成 topHosts。 */
interface RouteAccumulator {
  route: EarthRoute
  hosts: Map<string, number>
}

const topHosts = (hosts: Map<string, number>): EarthHostTraffic[] =>
  [...hosts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, TOP_HOST_LIMIT)
    .map(([host, downloaded]) => ({ host, downloaded }))

const hasValidCoordinates = (
  location: Pick<EarthLocationHint, 'latitude' | 'longitude'> | EarthLocation | null,
): location is (EarthLocationHint | EarthLocation) & LocatedCoordinates =>
  location !== null &&
  location.latitude !== null &&
  location.longitude !== null &&
  Number.isFinite(location.latitude) &&
  Number.isFinite(location.longitude) &&
  location.latitude >= -90 &&
  location.latitude <= 90 &&
  location.longitude >= -180 &&
  location.longitude <= 180

const resolveOrigin = (
  ip: string,
  local: EarthLocation | null | undefined,
  preferred?: EarthLocationHint | null,
): EarthLocation | null => {
  let latitude: number
  let longitude: number

  if (preferred && hasValidCoordinates(preferred)) {
    latitude = preferred.latitude
    longitude = preferred.longitude
  } else if (local && hasValidCoordinates(local)) {
    latitude = local.latitude
    longitude = local.longitude
  } else {
    return null
  }

  return {
    ip,
    latitude,
    longitude,
    city: preferred?.city.trim() || local?.city || '',
    country: local?.country || preferred?.country.trim() || '',
  }
}

export const buildEarthRoutes = async (
  connections: readonly Connection[],
  originIP: string,
  locale: string,
  lookup: (ips: string[], locale: string) => Promise<Record<string, EarthLocation | null>>,
  preferredOrigin?: EarthLocationHint | null,
) => {
  const normalizedOrigin = normalizeIP(originIP)

  if (!normalizedOrigin) return { routes: [] as EarthRoute[], origin: null }

  const candidates = extractCandidates(connections)
  const ips = new Set<string>([normalizedOrigin])

  for (const candidate of candidates) ips.add(candidate.destinationIP)

  const locations = await lookup([...ips], locale)
  const origin = resolveOrigin(normalizedOrigin, locations[normalizedOrigin], preferredOrigin)

  if (!origin) return { routes: [] as EarthRoute[], origin: null }

  const aggregated = new Map<string, RouteAccumulator>()
  // origin 在整个调用里恒定,它那半个 key 没必要每条连接重算一次
  const originKey = `origin:${coordinateKey(origin)}`
  // destination 半个 key 只由 IP 决定,可在本次调用内记忆。
  // 必须是 per-call 的:locations 会随语言切换/库更新而变,提到模块级就会读到陈旧坐标。
  const destinationKeys = new Map<string, string>()

  for (const candidate of candidates) {
    const destination = locations[candidate.destinationIP]

    if (!destination) continue

    let destinationKey = destinationKeys.get(candidate.destinationIP)

    if (destinationKey === undefined) {
      destinationKey = `destination:${coordinateKey(destination)}`
      destinationKeys.set(candidate.destinationIP, destinationKey)
    }

    const key = `${originKey}>${destinationKey}`
    let entry = aggregated.get(key)

    if (entry) {
      entry.route.connections += 1
      entry.route.upload += candidate.upload
      entry.route.download += candidate.download
    } else {
      // path 只在新建路由时构造:2000 条连接常态聚成几十条路由,
      // 放在判重之前的话约 97% 的迭代刚展开完两个对象就当场变垃圾
      entry = {
        route: {
          key,
          path: [
            { ...origin, role: 'origin' },
            { ...destination, role: 'destination' },
          ],
          connections: 1,
          upload: candidate.upload,
          download: candidate.download,
          topHosts: [],
        },
        hosts: new Map(),
      }
      aggregated.set(key, entry)
    }

    // 按主机名累加,而不是把每条连接各记一行:同一个 CDN 域名常年 6-8 条并发,
    // 逐条记会让浮层里出现最多 5 行同名主机,而且排序键变成"单连接最大值"而非主机总量。
    // candidate.host 恒为真(extractCandidates 里有 `|| destination` 兜底)。
    entry.hosts.set(candidate.host, (entry.hosts.get(candidate.host) ?? 0) + candidate.downloaded)
  }

  const routes = [...aggregated.values()].map(({ route, hosts }) => {
    route.topHosts = topHosts(hosts)

    return route
  })

  return { routes, origin }
}
