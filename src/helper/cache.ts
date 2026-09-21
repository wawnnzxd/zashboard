// 10 分钟(上游是 1 小时):发版后面板下一次整页加载就能看到升级提示,不用干等一小时。
// GitHub 未认证限流 60 次/时/IP,UI + 内核两条检查按此节流合计 ~12 次/时,余量充足。
const CACHE_DURATION = 1000 * 60 * 10

interface CacheEntry<T> {
  timestamp: number
  version: string
  data: T
}

export const fetchWithLocalCache = async <T>(url: string, version: string): Promise<T> => {
  const cacheKey = 'cache/' + url
  const cacheRaw = localStorage.getItem(cacheKey)

  if (cacheRaw) {
    try {
      const cache: CacheEntry<T> = JSON.parse(cacheRaw)
      const now = Date.now()

      if (now - cache.timestamp < CACHE_DURATION && cache.version === version) {
        return cache.data
      } else {
        localStorage.removeItem(cacheKey)
      }
    } catch (e) {
      console.warn('Failed to parse cache for', url, e)
    }
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const data: T = await response.json()

  localStorage.setItem(
    cacheKey,
    JSON.stringify({ timestamp: Date.now(), version, data } satisfies CacheEntry<T>),
  )

  return data
}
