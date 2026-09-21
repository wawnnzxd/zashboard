import type { IPInfo } from '@/api/geoip'
import { LANG } from '@/constant'
import { geoIPChunkStore, type GeoIPFileManifest } from '@/helper/geoip-chunk-store'
import { AsyncMMDBReader } from '@/helper/mmdb'
import { geoipASNDatabaseURL, geoipCountryDatabaseURL, language } from '@/store/settings'
import { watchDebounced } from '@vueuse/core'
import * as ipaddr from 'ipaddr.js'
import type { AsnResponse, CountryResponse } from 'mmdb-lib'
import { shallowRef } from 'vue'

const GEOIP_DATABASE_TTL = 30 * 24 * 60 * 60 * 1000

type GeoIPResponse = CountryResponse | AsnResponse

const openReader = <T extends GeoIPResponse>(key: string, manifest: GeoIPFileManifest) =>
  AsyncMMDBReader.open<T>(geoIPChunkStore.createSource(key, manifest))

const loadReader = async (url: string): Promise<AsyncMMDBReader<GeoIPResponse>> => {
  let cached = await geoIPChunkStore.getManifest(url).catch(() => undefined)
  let staleReader: AsyncMMDBReader<GeoIPResponse> | undefined

  if (cached) {
    try {
      staleReader = await openReader<GeoIPResponse>(url, cached)

      if (Date.now() - cached.updatedAt <= GEOIP_DATABASE_TTL) return staleReader
    } catch {
      await geoIPChunkStore.invalidate(url, cached.generation).catch(() => {})
      cached = undefined
    }
  }

  try {
    const response = await fetch(url)

    if (!response.ok || !response.body) {
      throw new Error(`Failed to stream GeoIP database: ${response.status}`)
    }

    const staged = await geoIPChunkStore.stageStream(url, response.body)
    let nextReader: AsyncMMDBReader<GeoIPResponse>

    try {
      nextReader = await openReader<GeoIPResponse>(url, staged)
      await geoIPChunkStore.activate(url, staged, { retainPrevious: true })
    } catch (error) {
      await geoIPChunkStore.discard(url, staged.generation).catch(() => {})
      throw error
    }

    return nextReader
  } catch (error) {
    if (staleReader) return staleReader
    throw error
  }
}

const GEOIP_READER_CACHE_MAX = 2
const readerCache = new Map<string, Promise<AsyncMMDBReader<GeoIPResponse>>>()

const getReader = <T extends GeoIPResponse>(url: string): Promise<AsyncMMDBReader<T>> => {
  const cached = readerCache.get(url)

  if (cached) {
    readerCache.delete(url)
    readerCache.set(url, cached)

    return cached as Promise<AsyncMMDBReader<T>>
  }

  const reader = loadReader(url).catch((error) => {
    readerCache.delete(url)
    throw error
  })

  readerCache.set(url, reader)

  while (readerCache.size > GEOIP_READER_CACHE_MAX) {
    const oldest = readerCache.keys().next().value

    if (oldest === undefined) {
      break
    }

    readerCache.delete(oldest)
  }

  return reader as Promise<AsyncMMDBReader<T>>
}

const localizedName = (names?: { en: string; 'zh-CN'?: string }): string => {
  if (!names) {
    return ''
  }

  const preferChinese = language.value === LANG.ZH_CN || language.value === LANG.ZH_TW

  return preferChinese ? (names['zh-CN'] ?? names.en) : names.en
}

const lookup = async <T extends GeoIPResponse>(url: string, ip: string): Promise<T | null> => {
  const reader = await getReader<T>(url)

  try {
    return await reader.get(ip)
  } catch {
    return null
  }
}

const getGeoIPInfo = async (ip: string): Promise<IPInfo> => {
  const [country, asn] = await Promise.all([
    lookup<CountryResponse>(geoipCountryDatabaseURL.value, ip),
    lookup<AsnResponse>(geoipASNDatabaseURL.value, ip),
  ])

  return {
    ip,
    country: localizedName(country?.country?.names) || (country?.country?.iso_code ?? ''),
    region: '',
    city: '',
    asn: asn?.autonomous_system_number?.toString() ?? '',
    organization: asn?.autonomous_system_organization ?? '',
    latitude: null,
    longitude: null,
  }
}

const EMPTY_GEOIP_INFO: IPInfo = {
  ip: '',
  country: '',
  region: '',
  city: '',
  asn: '',
  organization: '',
  latitude: null,
  longitude: null,
}

const GEOIP_INFO_CACHE_MAX = 4096
// 刻意不用 reactive(Map):渲染热路径(表格单元格)每拍逐 IP 读缓存,响应式 Map 会给
// 每个键建立依赖、任何一次回填触发整表重算。改为普通 Map + 版本号:读方依赖
// geoCacheVersion 这一个信号,回填时 +1,渲染层按帧节流地整体刷新一次。
const geoInfoCache = new Map<string, IPInfo>()
const geoInfoPending = new Set<string>()
export const geoCacheVersion = shallowRef(0)

// ipaddr.isValid 走异常驱动的完整解析,连接页每拍对同批 IP 反复调用太贵;
// 无效串(域名/空值)在一次会话里高度重复,缓存判定结果。
const invalidIPs = new Set<string>()
const isCachedValidIP = (ip: string) => {
  if (geoInfoCache.has(ip) || geoInfoPending.has(ip)) return true
  if (invalidIPs.has(ip)) return false
  if (ipaddr.isValid(ip)) return true
  if (invalidIPs.size < 4096) invalidIPs.add(ip)
  return false
}

export const getConnectionGeoIPInfoSync = (ip: string): IPInfo => {
  // 读一次版本号建立唯一的响应式依赖(见上方 geoInfoCache 的说明)
  void geoCacheVersion.value
  if (!ip || !isCachedValidIP(ip)) {
    return EMPTY_GEOIP_INFO
  }

  const cached = geoInfoCache.get(ip)

  if (cached) {
    return cached
  }

  if (!geoInfoPending.has(ip)) {
    geoInfoPending.add(ip)
    getGeoIPInfo(ip)
      .then((info) => {
        geoInfoCache.set(ip, info)
        geoCacheVersion.value++

        // Evict oldest entries beyond the cap (FIFO; safe here since this runs
        // in a microtask, not during a render read of the cache).
        while (geoInfoCache.size > GEOIP_INFO_CACHE_MAX) {
          const oldest = geoInfoCache.keys().next().value

          if (oldest === undefined) {
            break
          }

          geoInfoCache.delete(oldest)
        }
      })
      .catch(() => {})
      .finally(() => geoInfoPending.delete(ip))
  }

  return EMPTY_GEOIP_INFO
}

watchDebounced(
  [geoipCountryDatabaseURL, geoipASNDatabaseURL],
  () => {
    readerCache.clear()
    geoInfoCache.clear()
    geoInfoPending.clear()
    invalidIPs.clear()
    geoCacheVersion.value++
  },
  { debounce: 800 },
)
