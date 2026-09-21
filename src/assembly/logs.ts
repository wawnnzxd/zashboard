import { useStorage } from '@/composables/use-storage'
import { LOG_LEVEL } from '@/constant'
import { logRetentionLimit, sourceIPLabelList } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import type { Log, LogWithSeq } from '@/types'
import dayjs from 'dayjs'
import { throttle } from 'lodash-es'
import { computed, ref, shallowRef, watch } from 'vue'
import { can, core, Core } from './backend'
import { driver } from './driver'

export const logs = shallowRef<LogWithSeq[]>([])
export const isPaused = ref(false)
export const logLevel = useStorage<string>('config/log-level', LOG_LEVEL.Info)

export const supportedLogLevels = computed(() => {
  const levels = [LOG_LEVEL.Debug, LOG_LEVEL.Info, LOG_LEVEL.Warning, LOG_LEVEL.Error]

  if (can('traceLogLevel')) levels.unshift(LOG_LEVEL.Trace)
  if (can('silentLogLevel')) levels.push(LOG_LEVEL.Silent)

  return levels
})

watch(supportedLogLevels, (levels) => {
  if (!activeBackend.value || core.value === Core.Unknown) return
  if (levels.includes(logLevel.value as LOG_LEVEL)) return

  logLevel.value = LOG_LEVEL.Info
  if (cancel) initLogs()
})

// source-ip 标签替换规则。第三项 keyLower 供大小写不敏感的 includes 快筛,
// 免去每条日志把全部全局正则都跑一遍。
const createSourceIPMatchers = () => {
  const matchers: [RegExp, string, string][] = []

  for (const { key, label, scope } of sourceIPLabelList.value) {
    if (scope && !scope.includes(activeBackend.value?.uuid as string)) continue
    if (key.startsWith('/')) continue

    if (key.includes(':')) {
      matchers.push([new RegExp(`${key}]:`, 'ig'), `${key}] (${label}) :`, key.toLowerCase()])
    } else {
      matchers.push([new RegExp(`${key}:`, 'ig'), `${key} (${label}) :`, key.toLowerCase()])
    }
  }

  return matchers
}

let cancel: (() => void) | undefined

export const initLogs = () => {
  stopLogs()
  // 暂停是「这一次浏览」的状态,不跨会话:切后端后若不复位,新会话的日志会被旧的暂停态
  // 一直挡在门外,日志页永远空白。
  isPaused.value = false

  let seq = 1
  let pending: LogWithSeq[] = []
  let matchers = createSourceIPMatchers()

  const flush = throttle(() => {
    // 空批直接退出。暂停期间内核照样推日志,每条都被丢弃却仍调一次 flush;
    // 照旧 concat+slice 会产出内容逐字相同、引用却是新的数组,而下游全按引用 memo
    // (LogsPage 的正则过滤、tanstack 的 core/sorted rowModel),
    // 于是每 500ms 白重跑一遍上千行的过滤与行模型重建。
    if (!pending.length) return

    // 批内 push(O(1))+ flush 时一次 reverse,保持「最新在前」;逐条 unshift 单批是 O(k²)
    logs.value = pending.reverse().concat(logs.value).slice(0, logRetentionLimit.value)
    pending = []
  }, 500)

  // 秒级时间串缓存:高频日志下每条 dayjs().format 是纯浪费
  let lastSecond = 0
  let lastTimeText = ''
  const currentTimeText = () => {
    const second = Math.floor(Date.now() / 1000)

    if (second !== lastSecond) {
      lastSecond = second
      lastTimeText = dayjs().format('HH:mm:ss')
    }
    return lastTimeText
  }

  const stopWatch = watch(
    () => [sourceIPLabelList.value, activeBackend.value],
    () => (matchers = createSourceIPMatchers()),
    { deep: true },
  )

  const subscription = driver().logs.subscribe(logLevel.value, (batch: Log[]) => {
    for (const data of batch) {
      if (isPaused.value) {
        seq++
        continue
      }

      let payload = data.payload

      if (matchers.length) {
        const payloadLower = payload.toLowerCase()

        for (const [regex, label, keyLower] of matchers) {
          if (payloadLower.includes(keyLower)) {
            payload = payload.replace(regex, label)
          }
        }
      }

      pending.push({
        ...data,
        payload,
        time: currentTimeText(),
        seq: seq++,
      })
    }

    flush()
  })

  cancel = () => {
    stopWatch()
    flush.cancel()
    subscription.close()
  }
}

export const stopLogs = () => {
  cancel?.()
  cancel = undefined
  logs.value = []
}
