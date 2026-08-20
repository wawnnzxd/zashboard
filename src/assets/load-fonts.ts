import { FONTS } from '@/constant'
import { font } from '@/store/settings'
import { watch } from 'vue'

export const loadFonts = () => {
  if (__FONT__ === 'cdn') {
    const createLink = (href: string) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.media = 'print'
      link.onload = () => {
        link.media = 'all'
      }
      document.head.appendChild(link)
    }

    createLink('https://unpkg.com/subsetted-fonts@latest/MiSans-VF/MiSans-VF.css')
    createLink('https://unpkg.com/subsetted-fonts@latest/SarasaUiSC-Regular/SarasaUiSC-Regular.css')
    createLink('https://unpkg.com/subsetted-fonts@latest/PingFangSC-Regular/PingFangSC-Regular.css')
    createLink('https://unpkg.com/@fontsource/fira-sans')
  } else if (__FONT__ === 'misans') {
    import('subsetted-fonts/MiSans-VF/MiSans-VF.css')
  } else if (__FONT__ === 'sarasa') {
    import('subsetted-fonts/SarasaUiSC-Regular/SarasaUiSC-Regular.css')
  } else if (__FONT__ === 'pingfang') {
    import('subsetted-fonts/PingFangSC-Regular/PingFangSC-Regular.css')
  } else if (__FONT__ === 'firasans') {
    import('@fontsource/fira-sans/index.css')
  } else if (__FONT__ === 'none') {
    // System UI fonts only; nothing bundled.
  } else {
    // 'all' (default): every font is bundled, but only the one in effect is loaded.
    // 原先四份 CSS 一起拉,三份未选家族约 320KB 明文、约 270 条无用 @font-face,
    // 纯粹是下载 + CSSOM 构建的浪费(同一时刻只可能有一个家族生效:font 是单值,
    // App.vue 也只挂一个 font-* class)。
    // 映射表写在分支内部,才能随其它 __FONT__ 取值一起被摇掉 —— 放到模块顶层会让
    // FONT=misans 这类单家族构建重新把四份 CSS 都拉进产物。
    const bundledFontCSS: Record<FONTS, () => Promise<unknown>> = {
      [FONTS.MI_SANS]: () => import('subsetted-fonts/MiSans-VF/MiSans-VF.css'),
      [FONTS.SARASA_UI]: () => import('subsetted-fonts/SarasaUiSC-Regular/SarasaUiSC-Regular.css'),
      [FONTS.PING_FANG]: () => import('subsetted-fonts/PingFangSC-Regular/PingFangSC-Regular.css'),
      [FONTS.FIRA_SANS]: () => import('@fontsource/fira-sans/index.css'),
      // 系统字体不需要任何 @font-face。
      [FONTS.SYSTEM_UI]: () => Promise.resolve(),
    }

    // 用 watch 而不是读一次:让「当前家族的 @font-face 一定在场」这条不变量留在本模块,
    // 调用方不必在切字体时记得再调一次。import() 有模块缓存,来回切不会重复请求;
    // 首次切到某家族时该份 CSS 才动态加载,会有一次 FOUT。
    watch(font, (value) => void bundledFontCSS[value](), { immediate: true })
  }
}
