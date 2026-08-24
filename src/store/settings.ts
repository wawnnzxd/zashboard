import { DEFAULT_SETTINGS_MENU_ORDER } from '@/config/settingsItems'
import {
  ALL_THEME,
  CONNECTION_DISPLAY_STYLE,
  CONNECTIONS_TABLE_ACCESSOR_KEY,
  DETAILED_CARD_STYLE,
  EMOJIS,
  FOLDER_MODE,
  FONTS,
  GEOIP_ASN_DATABASE_URL,
  GEOIP_COUNTRY_DATABASE_URL,
  GLOBAL,
  IP_INFO_API,
  IS_APPLE_DEVICE,
  LANG,
  LIST_DISPLAY_STYLE,
  OVERVIEW_CARD,
  PROXY_CARD_SIZE,
  PROXY_CHAIN_DIRECTION,
  PROXY_PREVIEW_TYPE,
  PROXY_SEARCH_MODE,
  PROXY_SORT_TYPE,
  SETTINGS_MENU_KEY,
  SPEEDTEST_MODE,
  TABLE_SIZE,
  TABLE_WIDTH_MODE,
  TEST_URL,
  type THEME,
} from '@/constant'
import { useStorage } from '@/helper/storage'
import { getMinCardWidth, isMiddleScreen, isPreferredDark } from '@/helper/utils'
import type { SourceIPLabel } from '@/types'
import { computed } from 'vue'

/**
 * 顺序类设置的持久化边界：内置清单是唯一真相，localStorage 只负责记住用户排的序。
 * 把三件本来要在每个调用点各记一遍的事一次吃进实现：
 * ① 默认值一律走工厂函数 —— 直接传数组时 useStorage 会把模块级常量本体交给 ref，
 *    组件里的就地写（splice / item.visible = x）会永久改坏常量，且首装时
 *    `data.value === rawInit` 让「恢复默认」类赋值被 Object.is 短路掉，按钮变死的；
 * ② 内置清单里有、存量顺序里没有的项自动补齐 —— 否则上游新增一个卡片/设置大类，
 *    老用户那边就永久消失（全球连接卡当初就是踩了这个才补的补丁）；
 * ③ 内置清单里已经没有的陈旧项自动剔除 —— 否则拖拽排序 UI 会拿到渲染不出来的空条目。
 */
const useOrderedStorage = <T>(
  key: string,
  createDefaults: () => T[],
  identify: (item: T) => string,
  // 新出现的项落在哪里，默认追加到末尾；返回 -1（没找到锚点）同样按追加处理
  placeMissing: (order: T[], item: T) => number = (order) => order.length,
) => {
  const order = useStorage<T[]>(key, createDefaults)
  const defaults = createDefaults()
  const validIds = new Set(defaults.map(identify))
  const kept = order.value.filter((item) => validIds.has(identify(item)))
  const keptIds = new Set(kept.map(identify))
  const missing = defaults.filter((item) => !keptIds.has(identify(item)))

  // 对得上账就一个字节都不写：无条件赋值会让每次冷启动都白跑一次序列化 + StorageEvent 广播
  if (missing.length > 0 || kept.length !== order.value.length) {
    for (const item of missing) {
      const index = placeMissing(kept, item)
      kept.splice(index < 0 ? kept.length : index, 0, item)
    }
    order.value = kept
  }

  return order
}

const migrateLegacyStorageKey = (legacyKey: string, nextKey: string) => {
  if (typeof window === 'undefined') {
    return
  }

  const legacyValue = localStorage.getItem(legacyKey)
  const nextValue = localStorage.getItem(nextKey)

  if (legacyValue !== null && nextValue === null) {
    localStorage.setItem(nextKey, legacyValue)
  }
  localStorage.removeItem(legacyKey)
}

migrateLegacyStorageKey('config/show-seleted-for-now-node', 'config/show-selected-for-now-node')
migrateLegacyStorageKey('config/use-connecticon-card', 'config/use-connection-card')
migrateLegacyStorageKey('config/connecticon-table-size', 'config/connection-table-size')
migrateLegacyStorageKey('config/ipv6-map', 'cache/ipv6-map')
migrateLegacyStorageKey('config/collapse-group-map', 'cache/collapse-group-map')
migrateLegacyStorageKey('config/log-search-history', 'cache/log-search-history')

const migrateLegacyConnectionDisplayStyle = () => {
  if (typeof window === 'undefined') {
    return
  }

  const nextKey = 'config/connection-display-style'
  const nextValue = localStorage.getItem(nextKey)
  const legacyKey = 'config/use-connection-card'

  if (nextValue !== null) {
    return
  }

  const legacyValue = localStorage.getItem(legacyKey)

  if (legacyValue === 'true' || legacyValue === 'false') {
    localStorage.setItem(
      nextKey,
      legacyValue === 'true' ? CONNECTION_DISPLAY_STYLE.CARD : CONNECTION_DISPLAY_STYLE.TABLE,
    )
  }

  localStorage.removeItem(legacyKey)
}

migrateLegacyConnectionDisplayStyle()

const migrateIPAPISettings = () => {
  if (typeof window === 'undefined') {
    return
  }

  const globalAPI = localStorage.getItem('config/geoip-info-api')
  const secondaryKey = 'config/ip-check-secondary-api'

  if (
    localStorage.getItem(secondaryKey) === null &&
    globalAPI !== IP_INFO_API.IPIP &&
    Object.values(IP_INFO_API).includes(globalAPI as IP_INFO_API)
  ) {
    localStorage.setItem(secondaryKey, globalAPI as string)
  }

  const legacyEarthKey = 'config/earth-origin-source'
  const earthKey = 'config/earth-ip-info-api'
  const legacyEarthSource = localStorage.getItem(legacyEarthKey)

  if (localStorage.getItem(earthKey) === null) {
    if (legacyEarthSource === 'china') {
      localStorage.setItem(earthKey, IP_INFO_API.IPIP)
    } else if (legacyEarthSource === 'global') {
      localStorage.setItem(earthKey, IP_INFO_API.IPSB)
    }
  }

  localStorage.removeItem(legacyEarthKey)
}

migrateIPAPISettings()

// global
export const defaultTheme = useStorage<string>('config/default-theme', 'desire')
export const darkTheme = useStorage<string>('config/dark-theme', 'desire-dark')
export const autoTheme = useStorage<boolean>('config/auto-theme', true)
export const theme = computed(() => {
  if (autoTheme.value && isPreferredDark.value) {
    return darkTheme.value
  }
  return defaultTheme.value
})
export const customThemes = useStorage<THEME[]>('config/custom-themes', [])

const replaceLegacyTheme = (theme: string, defaultTheme: string) => {
  const legacyThemeReplacements: Record<string, string> = {
    'dark-apple': 'dark',
    lofi: 'light',
    wireframe: 'light',
    black: 'dark-neutral',
    business: 'dark-neutral',
  }

  if (theme in legacyThemeReplacements) {
    return legacyThemeReplacements[theme]
  }
  if ([...ALL_THEME, ...customThemes.value.map((theme) => theme.name)].includes(theme)) {
    return theme
  }
  return defaultTheme
}

// 仅在确实需要迁移时才写回:useStorage 现在是 writeDefaults:false,没写过就读代码里的
// 默认值 —— 无脑写回等于把「当下的默认主题」钉死进老用户的 localStorage,
// 以后我们再换默认主题(desire → 下一版)对他们就不生效了。
const migratedDefaultTheme = replaceLegacyTheme(defaultTheme.value, 'desire')
if (migratedDefaultTheme !== defaultTheme.value) {
  defaultTheme.value = migratedDefaultTheme
}
const migratedDarkTheme = replaceLegacyTheme(darkTheme.value, 'desire-dark')
if (migratedDarkTheme !== darkTheme.value) {
  darkTheme.value = migratedDarkTheme
}

export const language = useStorage<LANG>(
  'config/language',
  Object.values(LANG).includes(navigator.language as LANG)
    ? (navigator.language as LANG)
    : LANG.EN_US,
)
export const isSidebarCollapsedConfig = useStorage('config/is-sidebar-collapsed', true)
export const isSidebarCollapsed = computed({
  get: () => {
    if (isMiddleScreen.value) {
      return true
    }

    return isSidebarCollapsedConfig.value
  },
  set: (value) => {
    isSidebarCollapsedConfig.value = value
  },
})
const fontConfig = useStorage<FONTS>('config/font', FONTS.MI_SANS)
export const font = computed({
  get: () => {
    const mode = import.meta.env.MODE
    if (Object.values(FONTS).includes(mode as FONTS)) {
      return mode as FONTS
    }
    return fontConfig.value
  },
  set: (val) => {
    fontConfig.value = val
  },
})
export const emoji = useStorage<EMOJIS>(
  'config/emoji',
  IS_APPLE_DEVICE ? EMOJIS.TWEMOJI : EMOJIS.NOTO_COLOR_EMOJI,
)
export const customBackgroundURL = useStorage('config/custom-background-image', '')
export const dashboardTransparent = useStorage('config/dashboard-transparent', 90)
export const autoUpgradeDashboard = useStorage('config/auto-upgrade', false)
export const checkUpgradeCore = useStorage('config/check-upgrade-core', true)
export const autoUpgradeCore = useStorage('config/auto-upgrade-core', false)
export const swipeInPages = useStorage('config/swipe-in-pages', true)
export const swipeInTabs = useStorage('config/swipe-in-tabs', false)
export const disablePullToRefresh = useStorage('config/disable-pull-to-refresh', true)
export const displayAllFeatures = useStorage('config/display-all-features', false)
export const blurIntensity = useStorage('config/blur-intensity', 10)
export const scrollAnimationEffect = useStorage('config/scroll-animation-effect', true)
export const IPInfoAPI = useStorage<IP_INFO_API>('config/geoip-info-api', IP_INFO_API.IPSB)
if (IPInfoAPI.value === IP_INFO_API.IPIP) {
  IPInfoAPI.value = IP_INFO_API.IPSB
}
export const geoipCountryDatabaseURL = useStorage(
  'config/geoip-country-database-url',
  GEOIP_COUNTRY_DATABASE_URL,
)
export const geoipASNDatabaseURL = useStorage(
  'config/geoip-asn-database-url',
  GEOIP_ASN_DATABASE_URL,
)
export const autoDisconnectIdleUDP = useStorage('config/auto-disconnect-idle-udp', false)
export const autoDisconnectIdleUDPTime = useStorage('config/auto-disconnect-idle-udp-time', 300)
export const keyboardShortcuts = useStorage<Record<string, string>>('config/keyboard-shortcuts', {})

// overview
export const splitOverviewPage = useStorage('config/split-overview-page', false)
export const autoIPCheck = useStorage('config/auto-ip-check', true)
export const ipCheckPrimaryAPI = useStorage<IP_INFO_API>(
  'config/ip-check-primary-api',
  IP_INFO_API.IPIP,
)
export const ipCheckSecondaryAPI = useStorage<IP_INFO_API>(
  'config/ip-check-secondary-api',
  IP_INFO_API.IPSB,
)
export const autoConnectionCheck = useStorage('config/auto-connection-check', true)
export const showStatisticsWhenSidebarCollapsed = useStorage(
  'config/show-statistics-when-sidebar-collapsed',
  true,
)
export const numberOfChartsInSidebar = useStorage<1 | 2 | 3>(
  'config/number-of-charts-in-sidebar',
  2,
)
const defaultOverviewCardOrder: { card: OVERVIEW_CARD; visible: boolean }[] = [
  {
    card: OVERVIEW_CARD.ChartsCard,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.NetworkCard,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.EarthGlobeCard,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.TopologyCharts,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.ProviderTrafficOverview,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.ConnectionHistory,
    visible: true,
  },
  {
    card: OVERVIEW_CARD.RuleHitCountCard,
    visible: true,
  },
]

// 存量配置首次补入全球连接时放在连接拓扑前；其他缺失卡片追加到末尾，
// 已有全球连接的自定义顺序不改。克隆/补齐/剔除都由 useOrderedStorage 负责。
export const overviewCardOrder = useOrderedStorage(
  'config/overview-card-order',
  () => defaultOverviewCardOrder.map((item) => ({ ...item })),
  (item) => item.card,
  (order, item) =>
    item.card === OVERVIEW_CARD.EarthGlobeCard
      ? order.findIndex(({ card }) => card === OVERVIEW_CARD.TopologyCharts)
      : order.length,
)

export const earthIPInfoAPI = useStorage<IP_INFO_API>('config/earth-ip-info-api', IP_INFO_API.IPIP)
export const earthVisualMode = useStorage<'flat' | 'space'>('config/earth-visual-mode', 'flat')
export const topologyApplyConnectionFilter = useStorage(
  'config/topology-apply-connection-filter',
  true,
)

// proxies
export const collapseGroupMap = useStorage<Record<string, boolean>>('cache/collapse-group-map', {})
export const proxyGroupFilterMap = useStorage<Record<string, string>>(
  'cache/proxy-group-filter-map',
  {},
)
export const displayFinalOutbound = useStorage('config/show-selected-for-now-node', false)
export const twoColumnProxyGroup = useStorage('config/two-columns', true)
export const proxyFolderMode = useStorage<FOLDER_MODE>(
  'config/proxy-folder-mode-setting',
  FOLDER_MODE.AUTO,
)

export const speedtestUrl = useStorage<string>('config/speedtest-url', TEST_URL)
export const independentLatencyTest = useStorage('config/independent-latency-test', false)
export const speedtestTimeout = useStorage<number>('config/speedtest-timeout', 5000)
export const speedtestMode = useStorage<SPEEDTEST_MODE>(
  'config/speedtest-mode',
  SPEEDTEST_MODE.DASHBOARD,
)
export const proxySearchMode = useStorage<PROXY_SEARCH_MODE>(
  'config/proxy-search-mode',
  PROXY_SEARCH_MODE.GROUP,
)
export const proxyProviderSearchMode = useStorage<PROXY_SEARCH_MODE>(
  'config/proxy-provider-search-mode',
  PROXY_SEARCH_MODE.GLOBAL,
)
export const proxySortType = useStorage<PROXY_SORT_TYPE>(
  'config/proxy-sort-type',
  PROXY_SORT_TYPE.DEFAULT,
)
export const automaticDisconnection = useStorage('config/automatic-disconnection', true)
export const truncateProxyName = useStorage('config/truncate-proxy-name', true)
export const disableProxiesPageTextSelect = useStorage(
  'config/disable-proxies-page-text-select',
  true,
)
export const proxyPreviewType = useStorage('config/proxy-preview-type', PROXY_PREVIEW_TYPE.AUTO)
export const hideUnavailableProxies = useStorage('config/hide-unavailable-proxies', false)
export const lowLatency = useStorage('config/low-latency', 400)
export const mediumLatency = useStorage('config/medium-latency', 800)
export const IPv6test = useStorage('config/ipv6-test', false)
export const proxyCardSize = useStorage<PROXY_CARD_SIZE>(
  'config/proxy-card-size',
  PROXY_CARD_SIZE.LARGE,
)
export const minProxyCardWidth = useStorage<number>(
  'config/min-proxy-card-width',
  getMinCardWidth(proxyCardSize.value),
)
export const manageHiddenGroup = useStorage('config/manage-hidden-group-mode', false)

export const displayGlobalByMode = useStorage('config/display-global-by-mode', false)
export const customGlobalNode = useStorage('config/custom-global-node-name', GLOBAL)

export const proxyGroupIconSize = useStorage('config/proxy-group-icon-size', 24)
export const proxyGroupIconMargin = useStorage('config/proxy-group-icon-margin', 6)
export const iconReflectList = useStorage<
  {
    icon: string
    name: string
    uuid: string
  }[]
>('config/icon-reflect-list', [])
export const groupProxiesByProvider = useStorage('config/group-proxies-by-provider', false)
export const useSmartGroupSort = useStorage('config/use-smart-group-sort', false)
export const groupTestUrls = useStorage<
  {
    name: string
    url: string
    uuid: string
  }[]
>('config/group-test-urls', [])

// connections
export const connectionDisplayStyle = useStorage<CONNECTION_DISPLAY_STYLE>(
  'config/connection-display-style',
  CONNECTION_DISPLAY_STYLE.AUTO,
)
export const isConnectionCard = computed(() => {
  if (connectionDisplayStyle.value === CONNECTION_DISPLAY_STYLE.CARD) {
    return true
  }
  if (connectionDisplayStyle.value === CONNECTION_DISPLAY_STYLE.TABLE) {
    return false
  }
  return isMiddleScreen.value
})
export const proxyChainDirection = useStorage(
  'config/proxy-chain-direction',
  PROXY_CHAIN_DIRECTION.NORMAL,
)
export const showFullProxyChain = useStorage('config/show-full-proxy-chain', true)
export const tableSize = useStorage<TABLE_SIZE>('config/connection-table-size', TABLE_SIZE.LARGE)
export const tableWidthMode = useStorage('config/table-width-mode', TABLE_WIDTH_MODE.AUTO)
export const connectionTableColumns = useStorage<CONNECTIONS_TABLE_ACCESSOR_KEY[]>(
  'config/connection-table-columns',
  [
    CONNECTIONS_TABLE_ACCESSOR_KEY.Close,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Host,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Type,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Rule,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Chains,
    CONNECTIONS_TABLE_ACCESSOR_KEY.DlSpeed,
    CONNECTIONS_TABLE_ACCESSOR_KEY.UlSpeed,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Download,
    CONNECTIONS_TABLE_ACCESSOR_KEY.Upload,
    CONNECTIONS_TABLE_ACCESSOR_KEY.ConnectTime,
  ],
)
// 卡片行是用户自由编排的二维数组，没有「内置清单」可对账，但同样需要克隆边界：
// 直接传常量本体会让组件里的 splice / push 改坏 DETAILED_CARD_STYLE 本身
export const connectionCardLines = useStorage<CONNECTIONS_TABLE_ACCESSOR_KEY[][]>(
  'config/connection-card-lines',
  () => DETAILED_CARD_STYLE.map((line) => [...line]),
)

export const sourceIPLabelList = useStorage<SourceIPLabel[]>('config/source-ip-label-list', [])
export const resolveClientHostname = useStorage('config/resolve-client-hostname', false)

// rules
export const displayNowNodeInRule = useStorage('config/display-now-node-in-rule', true)
export const displayLatencyInRule = useStorage('config/display-latency-in-rule', true)
export const disconnectOnRuleDisable = useStorage('config/disconnect-on-rule-disable', true)
export const ruleDisplayStyle = useStorage<LIST_DISPLAY_STYLE>(
  'config/rule-display-style',
  LIST_DISPLAY_STYLE.CARD,
)

// logs
export const logRetentionLimit = useStorage<number>('config/log-retention-limit', 1000)
export const logDisplayStyle = useStorage<LIST_DISPLAY_STYLE>(
  'config/log-display-style',
  LIST_DISPLAY_STYLE.CARD,
)
export const logSearchHistory = useStorage<string[]>('cache/log-search-history', [])

// settings visibility
// 使用扁平结构，key 格式为 "大设置项.小设置项" 或 "大设置项"（仅大设置项）
// 默认所有项都可见，只有隐藏的项才会记录在此对象中
export const hiddenSettingsItems = useStorage<Record<string, boolean>>(
  'config/hidden-settings-items',
  {},
)

// settings menu order
// 存储设置菜单项的顺序
export const settingsMenuOrder = useOrderedStorage<SETTINGS_MENU_KEY>(
  'config/settings-menu-order',
  () => [...DEFAULT_SETTINGS_MENU_ORDER],
  (key) => key,
)
