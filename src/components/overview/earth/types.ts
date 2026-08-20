// The unversioned CDN URL follows the latest published DB-IP City Lite package;
// the worker refreshes its browser cache by TTL.
//
// ⚠️ 已知脱钩:设置里的 geoipCountryDatabaseURL / geoipASNDatabaseURL 只驱动 api/geoip.ts
// (连接页的国家/ASN 查询),地球仪 Worker 用的是这里硬编码的城市库地址,两者互不相干。
// 用户改了 GeoIP 库地址后,连接页换库、地球仪不换,两处显示的国家可能不一致且无法解释。
// 打通需要把库地址随 'init' / 'download' 请求传进 Worker(GeoWorkerRequest 加字段)、
// 由 geoWorkerHost 从 settings 读取并在地址变化时让 IndexedDB 缓存失效 —— 那是城市库,
// 与现有两个设置项(国家库/ASN 库)语义不同,应新增独立设置项而非复用。
export const DBIP_CITY_URL = 'https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz'
export const DBIP_COMPRESSED_BYTES = 61_700_000
export const DBIP_STORED_BYTES = 130_200_000

export type EarthOriginSource = 'global' | 'china'

export type EarthEndpointRole = 'origin' | 'destination'

export interface EarthLocation {
  ip: string
  latitude: number
  longitude: number
  city: string
  country: string
}

export interface EarthHostTraffic {
  host: string
  downloaded: number
}

export interface EarthRoute {
  key: string
  path: Array<EarthLocation & { role: EarthEndpointRole }>
  connections: number
  upload: number
  download: number
  topHosts: EarthHostTraffic[]
}

export interface EarthEndpointInfo {
  city: string
  country: string
  role: EarthEndpointRole
  connections: number
  topHosts: EarthHostTraffic[]
}

export type GeoDatabaseStatus =
  'checking' | 'idle' | 'loading-cache' | 'downloading' | 'ready' | 'error'

export type GeoDatabaseError =
  'space' | 'network' | 'decompress' | 'invalid' | 'storage' | 'unsupported' | 'unknown'

export type GeoWorkerRequest =
  | { type: 'init' }
  | { type: 'download' }
  | { type: 'cancel' }
  | { type: 'lookup'; id: number; ips: string[]; locale: string }

export type GeoWorkerResponse =
  | {
      type: 'status'
      status: GeoDatabaseStatus
      received?: number
      total?: number
      error?: GeoDatabaseError
      recoveredCorruptCache?: boolean
    }
  | { type: 'lookup'; id: number; locations: Record<string, EarthLocation | null> }
  // 前台/后台下载的起止(宿主据此在下载期间不回收 Worker)
  | { type: 'activity'; downloading: boolean }
