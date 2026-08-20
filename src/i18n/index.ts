import { LANG } from '@/constant'
import { language } from '@/store/settings'
import { watch } from 'vue'
import { createI18n } from 'vue-i18n'
import en, { type LANG_MESSAGE } from './en'
import zh from './zh'

// 四份语言包原本全部静态引入,合计 111KB 明文躺在 entry 里,对任一用户都有 3/4 是死重量。
// en 是 fallbackLocale,必须始终同步在场;zh 是本分支的主用语言,静态保留换来中文用户
// 首帧零额外往返。剩下的 ru(38KB)+ zh-tw(24KB)拆成懒 chunk。
const lazyMessages: Partial<Record<LANG, () => Promise<{ default: LANG_MESSAGE }>>> = {
  [LANG.ZH_TW]: () => import('./zh-tw'),
  [LANG.RU_RU]: () => import('./ru'),
}

// 声明成完整的 Record 是刻意的:懒的那两份在切到它们之前一定已由 ensureMessages 补齐,
// 对外(locale 的取值域、setLocaleMessage 的键)四种语言始终可用。
const messages = {
  [LANG.EN_US]: en,
  [LANG.ZH_CN]: zh,
} as Record<LANG, LANG_MESSAGE>

export const i18n = createI18n({
  legacy: false,
  locale: language.value,
  fallbackLocale: LANG.EN_US,
  messages,
})

// 「切到某语言之前它的词条一定已经在场」这条不变量吃进本模块:写 language 的地方
// (设置页下拉、将来任何新入口)都不必知道有懒加载这回事。
// 同一语言的并发切换只发一次请求。
// 返回的 promise 永不 reject:加载失败时该语言的缺失键自动回退到 en 继续渲染,
// 而不是让下面的顶层 await 把整个入口模块拖成 rejected(那就是白屏)。
// 失败同时丢掉记录,下次切换可重试 —— 否则一次网络抖动会把该语言永久钉死。
const pendingMessages = new Map<LANG, Promise<void>>()
const ensureMessages = (lang: LANG): Promise<void> => {
  const load = lazyMessages[lang]

  if (!load) return Promise.resolve()

  let pending = pendingMessages.get(lang)

  if (!pending) {
    pending = load().then(
      ({ default: resource }) => {
        i18n.global.setLocaleMessage(lang, resource)
      },
      () => {
        pendingMessages.delete(lang)
      },
    )
    pendingMessages.set(lang, pending)
  }

  return pending
}

// 顶层 await:懒语言的用户在挂载前先把词条补齐,首帧不会闪一次英文回退。
// en / zh 用户根本走不到网络(loader 不存在,直接 resolve),只多一个微任务。
await ensureMessages(language.value)

// language 是唯一真相,locale 只是它的投影。快速连切时「提交前再比一次」丢弃过期结果,
// 避免先发后到的旧语言覆盖新语言。
watch(language, async (lang) => {
  await ensureMessages(lang)

  if (language.value !== lang) return

  i18n.global.locale.value = lang
})
