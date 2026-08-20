/// <reference lib="webworker" />

import { Buffer } from 'buffer'
import type { CityResponse, Reader as MMDBReader } from 'mmdb-lib'
import { CITY_ZH } from './cityNames.zh'
import {
  DBIP_CITY_URL,
  DBIP_STORED_BYTES,
  type EarthLocation,
  type GeoDatabaseError,
  type GeoWorkerRequest,
  type GeoWorkerResponse,
} from './types'

declare const self: DedicatedWorkerGlobalScope

if (!(globalThis as { Buffer?: unknown }).Buffer) {
  ;(globalThis as { Buffer?: unknown }).Buffer = Buffer
}

const DATABASE_NAME = 'zashboard-earth-geoip'
const DATABASE_STORE = 'city-database'
const DATABASE_KEY = 'dbip-city-lite'
const REFRESH_META_KEY = 'dbip-city-lite:refresh-meta'
const DATABASE_TTL = 30 * 24 * 60 * 60 * 1000
// 缓存过期后的后台刷新至少间隔这么久再试:失败(断网/CDN 抽风)不能每次进概览页都从零重下 61.7MB
const REFRESH_RETRY_INTERVAL = 6 * 60 * 60 * 1000
const STORAGE_HEADROOM = 16 * 1024 * 1024

interface CachedDatabase {
  blob: Blob
  storedAt: number
}

interface RefreshMeta {
  attemptedAt: number
}

class WorkerError extends Error {
  constructor(readonly code: GeoDatabaseError) {
    super(code)
  }
}

let reader: MMDBReader<CityResponse> | null = null
let downloadController: AbortController | null = null

const post = (message: GeoWorkerResponse) => self.postMessage(message)

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATABASE_STORE)) {
        request.result.createObjectStore(DATABASE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const readCachedDatabase = async (): Promise<CachedDatabase | undefined> => {
  const database = await openDatabase()

  return new Promise<CachedDatabase | undefined>((resolve, reject) => {
    // Reading all records also finds caches written by older builds whose key
    // included the package version. The next refresh migrates to DATABASE_KEY.
    const request = database
      .transaction(DATABASE_STORE, 'readonly')
      .objectStore(DATABASE_STORE)
      .getAll()

    request.onsuccess = () => {
      const cached = (request.result as Partial<CachedDatabase>[])
        .filter((record): record is CachedDatabase => record?.blob instanceof Blob)
        .sort((left, right) => (right.storedAt || 0) - (left.storedAt || 0))[0]

      resolve(cached)
    }
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

const writeCachedDatabase = async (value: CachedDatabase) => {
  const database = await openDatabase()

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DATABASE_STORE, 'readwrite')
    const store = transaction.objectStore(DATABASE_STORE)

    store.clear()
    store.put(value, DATABASE_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  }).finally(() => database.close())
}

const deleteCachedDatabase = async () => {
  const database = await openDatabase()

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DATABASE_STORE, 'readwrite')

    transaction.objectStore(DATABASE_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  }).finally(() => database.close())
}

const readRefreshMeta = async (): Promise<RefreshMeta | undefined> => {
  const database = await openDatabase()

  return new Promise<RefreshMeta | undefined>((resolve, reject) => {
    const request = database
      .transaction(DATABASE_STORE, 'readonly')
      .objectStore(DATABASE_STORE)
      .get(REFRESH_META_KEY)

    request.onsuccess = () => resolve(request.result as RefreshMeta | undefined)
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

const writeRefreshMeta = async (value: RefreshMeta) => {
  const database = await openDatabase()

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DATABASE_STORE, 'readwrite')

    transaction.objectStore(DATABASE_STORE).put(value, REFRESH_META_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  }).finally(() => database.close())
}

const createReader = async (blob: Blob) => {
  const databaseBuffer = await blob.arrayBuffer()
  const { Reader } = await import('mmdb-lib')
  const nextReader = new Reader<CityResponse>(Buffer.from(databaseBuffer))

  if (!nextReader.metadata.databaseType || nextReader.metadata.nodeCount <= 0) {
    throw new WorkerError('invalid')
  }

  return nextReader
}

const init = async () => {
  post({ type: 'status', status: 'checking' })

  try {
    const cached = await readCachedDatabase()

    if (!cached) {
      post({ type: 'status', status: 'idle' })
      return
    }

    post({ type: 'status', status: 'loading-cache' })

    try {
      reader = await createReader(cached.blob)
      post({ type: 'status', status: 'ready' })

      if (!Number.isFinite(cached.storedAt) || Date.now() - cached.storedAt > DATABASE_TTL) {
        void refreshInBackground()
      }
    } catch (error) {
      reader = null
      // 只有真正解析出"库损坏"才删缓存;arrayBuffer 内存不足 / 读取失败这类瞬时错误
      // 若也删掉 130MB 缓存,就等于逼用户再下一次 61.7MB
      if (error instanceof WorkerError && error.code === 'invalid') {
        await deleteCachedDatabase().catch(() => {})
        post({ type: 'status', status: 'idle', recoveredCorruptCache: true })
      } else {
        post({ type: 'status', status: 'error', error: 'unknown' })
      }
    }
  } catch {
    post({ type: 'status', status: 'error', error: 'storage' })
  }
}

// 过期缓存的后台刷新:6 小时内只尝试一次,避免网络不好时每次进概览页都白下一段
const refreshInBackground = async () => {
  try {
    const meta = await readRefreshMeta()

    if (meta && Date.now() - meta.attemptedAt < REFRESH_RETRY_INTERVAL) return
    await writeRefreshMeta({ attemptedAt: Date.now() })
  } catch {
    // 元数据读写失败不阻断刷新本身
  }
  void download(true)
}

const ensureStorageSpace = async () => {
  try {
    const estimate = await navigator.storage?.estimate()

    if (estimate?.quota != null && estimate.usage != null) {
      const available = estimate.quota - estimate.usage

      if (available < DBIP_STORED_BYTES + STORAGE_HEADROOM) {
        throw new WorkerError('space')
      }
    }
  } catch (error) {
    if (error instanceof WorkerError) throw error
    // Some embedded browsers expose StorageManager but reject estimate(). In
    // that case IndexedDB remains the authoritative quota check.
  }
}

const download = async (background = false) => {
  if (downloadController) return

  if (typeof DecompressionStream === 'undefined') {
    if (!background) post({ type: 'status', status: 'error', error: 'unsupported' })
    return
  }

  try {
    await ensureStorageSpace()
  } catch (error) {
    if (!background) {
      post({
        type: 'status',
        status: 'error',
        error: error instanceof WorkerError ? error.code : 'space',
      })
    }
    return
  }

  const controller = new AbortController()
  downloadController = controller
  post({ type: 'activity', downloading: true })

  if (!background) {
    reader = null
    post({ type: 'status', status: 'downloading', received: 0 })
  }

  try {
    // ⚠️ 硬编码地址,与设置里的 GeoIP 库地址完全脱钩(详见 types.ts 里 DBIP_CITY_URL 的说明)。
    // 要打通得让宿主把地址随请求传进来,Worker 侧不该自己去读设置(它拿不到 store)。
    const response = await fetch(DBIP_CITY_URL, { signal: controller.signal })

    if (!response.ok || !response.body) {
      throw new WorkerError('network')
    }

    const total = Number(response.headers.get('content-length')) || undefined
    let received = 0
    // 进度按 ≥1MB 或 ≥200ms 节流:61.7MB 按 16-64KB 一段到达就是数千条消息,
    // 每条都在主线程触发一次响应式更新 + 两次 prettyBytes + DOM 写
    let lastPostedBytes = 0
    let lastPostedAt = 0
    const progressStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, streamController) {
        received += chunk.byteLength
        if (!background) {
          const now = Date.now()

          if (received - lastPostedBytes >= 1024 * 1024 || now - lastPostedAt >= 200) {
            lastPostedBytes = received
            lastPostedAt = now
            post({ type: 'status', status: 'downloading', received, total })
          }
        }
        streamController.enqueue(chunk)
      },
    })
    let decompressed: ReadableStream<Uint8Array>

    try {
      const decompressionStream = new DecompressionStream(
        'gzip',
      ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
      decompressed = response.body.pipeThrough(progressStream).pipeThrough(decompressionStream)
    } catch {
      throw new WorkerError('decompress')
    }

    let blob: Blob

    try {
      blob = await new Response(decompressed).blob()
    } catch (error) {
      if (controller.signal.aborted) throw error
      throw new WorkerError('decompress')
    }

    if (controller.signal.aborted) return

    const nextReader = await createReader(blob)

    try {
      await writeCachedDatabase({
        blob,
        storedAt: Date.now(),
      })
    } catch {
      throw new WorkerError('storage')
    }

    reader = nextReader
    post({ type: 'status', status: 'ready' })
  } catch (error) {
    if (!background) {
      if (controller.signal.aborted) {
        post({ type: 'status', status: 'idle' })
      } else {
        post({
          type: 'status',
          status: 'error',
          error: error instanceof WorkerError ? error.code : 'network',
        })
      }
    }
  } finally {
    if (downloadController === controller) {
      downloadController = null
    }
    post({ type: 'activity', downloading: false })
  }
}

const localizedName = (names: unknown, locale: string) => {
  if (!names || typeof names !== 'object') return ''

  const values = names as Record<string, string | undefined>
  const language = locale.toLowerCase()

  if (language.startsWith('zh')) return values['zh-CN'] ?? values.zh ?? values.en ?? ''
  if (language.startsWith('ru')) return values.ru ?? values.en ?? ''
  return values[locale] ?? values[language.split('-')[0]] ?? values.en ?? ''
}

const cityDisplayName = (name: string) =>
  name.replace(/\s*(?:(?:\([^()]*\)|（[^（）]*）)\s*)+$/u, '').trim()

// ─── 名字本地化 ───
// DB-IP City Lite 的 names 实际只有 en 一种语言,localizedName 的多语言分支
// 在这份库上永远落回英文。所以:
//   国家 —— 走 Intl.DisplayNames:区域名全集内建于 JS 引擎,四种界面语言
//           (含 zh-TW 繁体、ru 俄文)全覆盖,零词典成本;mmdb 名只作兜底。
//   城市 —— 引擎没有城市名数据,走静态词典(cityNames.zh.ts,只进本 worker chunk);
//           词典只有中文,其余语言维持库里的名字。查不到原样显示英文,
//           一个错的中文名比英文名更糟。

let regionNames: Intl.DisplayNames | null = null
let regionNamesLocale = ''

const countryName = (isoCode: string | undefined, names: unknown, locale: string) => {
  if (isoCode) {
    try {
      if (!regionNames || regionNamesLocale !== locale) {
        regionNames = new Intl.DisplayNames([locale], { type: 'region' })
        regionNamesLocale = locale
      }

      const display = regionNames.of(isoCode.toUpperCase())

      // of() 对未知代码返回入参本身,那不是名字,落回 mmdb
      if (display && display !== isoCode.toUpperCase()) return display
    } catch {
      // 引擎不认这个 locale / 不支持 DisplayNames:落回 mmdb 的名字
    }
  }

  return localizedName(names, locale)
}

const cityName = (names: unknown, locale: string) => {
  const name = cityDisplayName(localizedName(names, locale))

  // 中文界面(简繁都算)查词典:键是英文,命中即中文;
  // 若某天库真带上了 zh 名,name 已是中文、词典必然未命中,自动让位
  if (name && locale.toLowerCase().startsWith('zh')) {
    const direct = CITY_ZH[name]

    if (direct) return direct

    // DB-IP 给东京都区部的名字是「Shibuya City」这种行政后缀形态,剥掉回查;
    // 真名含 City 的城市(Kansas City / Quezon City…)已在上面直查命中,到不了这里
    if (name.endsWith(' City')) {
      return CITY_ZH[name.slice(0, -' City'.length)] ?? name
    }

    return name
  }

  return name
}

const lookup = (id: number, ips: string[], locale: string) => {
  const locations: Record<string, EarthLocation | null> = {}

  for (const ip of ips) {
    try {
      const match = reader?.get(ip)
      const latitude = match?.location?.latitude
      const longitude = match?.location?.longitude

      locations[ip] =
        latitude == null || longitude == null
          ? null
          : {
              ip,
              latitude,
              longitude,
              city: cityName(match?.city?.names, locale),
              country: countryName(match?.country?.iso_code, match?.country?.names, locale),
            }
    } catch {
      locations[ip] = null
    }
  }

  post({ type: 'lookup', id, locations })
}

self.onmessage = ({ data }: MessageEvent<GeoWorkerRequest>) => {
  switch (data.type) {
    case 'init':
      void init()
      break
    case 'download':
      void download()
      break
    case 'cancel':
      downloadController?.abort()
      break
    case 'lookup':
      lookup(data.id, data.ips, data.locale)
      break
  }
}
