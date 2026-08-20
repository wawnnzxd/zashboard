import { customBackgroundURL } from '@/store/settings'
import dayjs from 'dayjs'
import { computed, ref, watch } from 'vue'

/**
 * 一个 key-value 持久层的完整契约(调用方不需要再自己包 try/catch):
 *
 * - **不抛。** 写(put/clear)返回 `true` = 已提交落库,`false` = 只留在内存;
 *   读有两个入口:`get` 把失败折叠成「没有这条数据」(undefined),适合背景图这类
 *   两者行为相同的场景;`getOutcome` 把「读不出来」与「确实没有」分开,供必须区分的
 *   调用方使用 —— 连接历史就属于后者,把读失败当成空表会导致空聚合覆盖磁盘上的真实历史。
 *   持久化坏掉从来不是调用方的错误路径,而是「这一份数据只活在本会话」这一个降级事实。
 * - **写对内存缓存同步生效**:cacheMap 在第一个 await 之前就更新,所以调用方
 *   紧接着改 ref 触发的 watch(pre-flush 微任务)一定读得到新值。晚一拍写缓存
 *   就是「换背景图后仍显示上一张」的根因,这个顺序是实现的不变量,不是调用约定。
 * - **失败时缓存回滚**:落库失败会把该 key 退回写入前的值,于是「缓存 == 库」重新成立。
 *   唯一的领先窗口是「事务已排队、尚未提交」这段时间 —— 期望的语义正是如此。
 * - **库根本打不开**(隐私模式 / 站点数据被禁 / 损坏)时整个实例降级为纯内存:
 *   只记一条日志,之后所有调用直接短路,不会每次都重开事务再刷一遍日志。
 */
const useIndexedDB = (dbKey: string) => {
  const cacheMap = new Map<string, string>()
  const openDatabase = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbKey, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(dbKey)) {
          db.createObjectStore(dbKey, { keyPath: 'key' })
        }
      }
      // 不做启动即全库预载(多后端历史会常驻数 MB~数十 MB 内存);
      // get 时按 key 惰性读 + 会话内缓存。
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  // 打不开就在这里把失败吸收掉(顺带消除模块加载期的 unhandled rejection):
  // 之后 db 恒为 undefined,所有操作短路成「纯内存」,不必让每个调用方各记一遍这件事。
  const dbPromise = openDatabase().catch((error) => {
    console.error(`IndexedDB "${dbKey}" unavailable, falling back to memory only:`, error)
    return undefined
  })

  type TransactionOutcome<T> = { ok: true; result: T } | { ok: false }

  // 按**事务**生命周期结算,而不是按 request:IDBRequest 成功只代表请求进了队列,
  // 提交阶段(配额超限、存储被回收、versionchange 打断)仍可能 abort。
  // 只有 oncomplete 才等于「真的落库了」,这是上面那条契约唯一的实现依据。
  const runTransaction = async <T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<TransactionOutcome<T>> => {
    const db = await dbPromise

    if (!db) {
      return { ok: false }
    }

    try {
      const result = await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(dbKey, mode)
        const request = operation(transaction.objectStore(dbKey))

        // request 级错误信息更精确(QuotaExceededError 等),保留它作为拒绝原因;
        // 它不 preventDefault 时还会冒泡去 abort 事务,两条路径拒绝同一个 Promise 无害。
        request.onerror = () => reject(request.error)
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error)
        transaction.oncomplete = () => resolve(request.result)
      })

      return { ok: true, result }
    } catch (error) {
      console.error(`IndexedDB "${dbKey}" transaction failed:`, error)
      return { ok: false }
    }
  }

  const put = (key: string, value: string) => {
    const previous = cacheMap.get(key)

    cacheMap.set(key, value)

    return runTransaction('readwrite', (store) => store.put({ key, value })).then(({ ok }) => {
      // 只在缓存里还是本次写入的值时才回滚 —— 期间若有更新的写入覆盖了它,
      // 回滚就成了把新值抹掉。
      if (!ok && cacheMap.get(key) === value) {
        if (previous === undefined) {
          cacheMap.delete(key)
        } else {
          cacheMap.set(key, previous)
        }
      }
      return ok
    })
  }

  // 区分「没有这条数据」与「读不出来」:两者对背景图是一回事(都当没有),
  // 但对连接历史是天壤之别 —— 读失败时若当成「没有历史」,本会话的空表会在
  // 30 秒后被 flush 回磁盘,把真实历史永久抹掉。所以读失败必须能被上层看见。
  const getOutcome = async (key: string): Promise<TransactionOutcome<string | undefined>> => {
    if (cacheMap.has(key)) {
      return { ok: true, result: cacheMap.get(key) }
    }
    const outcome = await runTransaction<{ key: string; value: string } | undefined>(
      'readonly',
      (store) => store.get(key) as IDBRequest<{ key: string; value: string } | undefined>,
    )

    if (!outcome.ok) {
      return { ok: false }
    }
    if (outcome.result === undefined) {
      return { ok: true, result: undefined }
    }
    cacheMap.set(key, outcome.result.value)
    return { ok: true, result: outcome.result.value }
  }

  const get = async (key: string) => {
    const outcome = await getOutcome(key)

    return outcome.ok ? outcome.result : undefined
  }

  const clear = () => {
    const previous = new Map(cacheMap)

    cacheMap.clear()

    return runTransaction('readwrite', (store) => store.clear()).then(({ ok }) => {
      if (!ok) {
        // 同 put 的回滚原则:清空之后才写进来的键更新,不能被旧值盖回去。
        for (const [key, value] of previous) {
          if (!cacheMap.has(key)) {
            cacheMap.set(key, value)
          }
        }
      }
      return ok
    })
  }

  return {
    put,
    get,
    getOutcome,
    clear,
  }
}

const backgroundDB = useIndexedDB('base64')
const backgroundImageKey = 'background-image'

// 返回 false = 图片只存在于本会话内存里(刷新后会丢),调用方据此给用户反馈。
export const saveBase64ToIndexedDB = (val: string) => backgroundDB.put(backgroundImageKey, val)
export const getBase64FromIndexedDB = () => backgroundDB.get(backgroundImageKey)
export const deleteBase64FromIndexedDB = () => backgroundDB.clear()
export const LOCAL_IMAGE = 'local-image'

const date = dayjs().format('YYYY-MM-DD')
const backgroundInDB = ref('')
const getBackgroundInDB = async () => {
  backgroundInDB.value = (await getBase64FromIndexedDB()) || ''
}

watch(
  () => customBackgroundURL.value,
  () => {
    if (customBackgroundURL.value.includes(LOCAL_IMAGE)) {
      getBackgroundInDB()
    }
  },
  {
    immediate: true,
  },
)

export const backgroundImage = computed(() => {
  if (!customBackgroundURL.value) {
    return ''
  }

  if (customBackgroundURL.value.includes(LOCAL_IMAGE)) {
    return `background-image: url('${backgroundInDB.value}');`
  }

  const querySeparator = customBackgroundURL.value.includes('?') ? '&' : '?'
  return `background-image: url('${customBackgroundURL.value}${querySeparator}v=${date}');`
})

export interface ConnectionHistoryData {
  key: string
  download: number
  upload: number
  count: number
}

export enum ConnectionHistoryType {
  SourceIP = 'sourceIP',
  Destination = 'destination',
  Process = 'process',
  Outbound = 'outbound',
  ProxyGroup = 'proxyGroup',
}

const connectionHistoryDB = useIndexedDB('connection-history')

// 返回 false = 这一份聚合没落盘(库不可用或配额满),由调用方决定重试还是转纯内存会话。
export const saveConnectionHistoryToIndexedDB = async (
  uuid: string,
  aggregationType: ConnectionHistoryType,
  data: ConnectionHistoryData[],
) => {
  const jsonData = JSON.stringify(data)
  return connectionHistoryDB.put(`${uuid}-${aggregationType}`, jsonData)
}

// 返回 null = **读不出来**(事务失败/库打不开),与「确实没有历史」的空数组严格区分:
// 调用方必须据此进入只读降级,否则本会话的空聚合会在下一次落盘时覆盖掉磁盘上的真实历史。
// 解析失败按「这条坏了」当空数组处理 —— 那条记录本来就没救了,重写它是正确的。
export const getConnectionHistoryFromIndexedDB = async (
  uuid: string,
  aggregationType: ConnectionHistoryType,
): Promise<ConnectionHistoryData[] | null> => {
  const outcome = await connectionHistoryDB.getOutcome(`${uuid}-${aggregationType}`)

  if (!outcome.ok) {
    return null
  }
  if (!outcome.result) {
    return []
  }
  try {
    return JSON.parse(outcome.result) as ConnectionHistoryData[]
  } catch {
    return []
  }
}

export const clearConnectionHistoryFromIndexedDB = async () => {
  return connectionHistoryDB.clear()
}
