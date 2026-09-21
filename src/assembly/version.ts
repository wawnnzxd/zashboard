import HonkLogo from '@/assets/images/honk.svg'
import MetacubexLogo from '@/assets/images/metacubex.jpg'
import { MIHOMO, MIHOMO_CHANNEL } from '@/constant'
import { fetchWithLocalCache } from '@/helper/cache'
import { getRequestErrorMessage } from '@/helper/request-error'
import { autoUpgradeCore, autoUpgradeDashboard, checkUpgradeCore } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import type { Backend } from '@/types'
import { computed, nextTick, ref } from 'vue'
import { can, core, Core, resetCore } from './backend'
import { driver } from './driver'

export const version = ref()
export const isCoreUpdateAvailable = ref(false)
export const isUIUpdateAvailable = ref(false)
export const zashboardVersion = ref(__APP_VERSION__)

export type BackendProbe = {
  uuid: string
  status: 'probing' | 'connected' | 'failed'
  latency: number
  message: string
}

export const backendProbe = ref<BackendProbe | undefined>()

const detectCore = (versionString: string): Core => {
  if (!versionString) return Core.Unknown
  if (/\bhonk\b/i.test(versionString)) return Core.Honk
  return Core.Mihomo
}

export const coreBrand = computed(() => {
  switch (core.value) {
    case Core.Honk:
      return { logo: HonkLogo, url: 'https://github.com/Glassyiris/honk' }
    default:
      return {
        logo: MetacubexLogo,
        url: MIHOMO_CHANNEL[mihomo.value?.[0] ?? MIHOMO.Meta].url,
      }
  }
})

export const mihomo = computed<[MIHOMO, string] | undefined>(() => {
  if (core.value !== Core.Mihomo) return undefined

  const match = /(alpha-smart|alpha|beta|meta)-?(\w+)/.exec(version.value)
  switch (match?.[1]) {
    case 'alpha':
      return [MIHOMO.Alpha, match[2] ?? version.value]
    case 'alpha-smart':
      return [MIHOMO.Smart, match[2] ?? version.value]
    case 'meta':
      return [MIHOMO.Meta, match[2] ?? version.value]
    default:
      return [MIHOMO.Meta, version.value]
  }
})

export const restartCore = () => driver().system.restartCore()

export const upgradeCore = (channel: 'release' | 'alpha' | 'auto') =>
  driver().system.upgradeCore(channel)

export const upgradeUI = () => driver().system.upgradeUI()

const probeBackendVersion = async (backend: Backend) => {
  const startAt = Date.now()
  let versionString: string

  try {
    versionString = await driver().system.fetchVersion()
  } catch (e) {
    if (activeBackend.value?.uuid === backend.uuid) {
      backendProbe.value = {
        uuid: backend.uuid,
        status: 'failed',
        latency: 0,
        message: getRequestErrorMessage(e),
      }
    }
    throw e
  }

  if (activeBackend.value?.uuid !== backend.uuid) return

  version.value = versionString
  core.value = detectCore(version.value)
  backendProbe.value = {
    uuid: backend.uuid,
    status: 'connected',
    latency: Date.now() - startAt,
    message: '',
  }
  if (!can('coreUpdateCheck') || !checkUpgradeCore.value || backend.disableUpgradeCore) return

  isCoreUpdateAvailable.value = await fetchIsCoreUpdateAvailable()

  // 上面这次「有没有新版本」的判断要走一趟 GitHub,GFW 下十几秒也可能。
  // 期间用户切了后端的话,结论属于上一个后端,却会把 POST /upgrade 打在新后端上 ——
  // 代价是把一个本来好好的内核重启掉,所以升级前必须再复核一次身份。
  if (activeBackend.value?.uuid !== backend.uuid) return

  if (isCoreUpdateAvailable.value && autoUpgradeCore.value) {
    upgradeCore('auto').catch(() => {})
  }
}

let probe: Promise<void> = Promise.resolve()

export const coreReady = async () => {
  await nextTick()
  await probe
}

export const probeActiveBackend = () => {
  const backend = activeBackend.value

  resetCore()
  version.value = ''
  isCoreUpdateAvailable.value = false
  backendProbe.value = backend
    ? { uuid: backend.uuid, status: 'probing', latency: 0, message: '' }
    : undefined

  probe = backend ? probeBackendVersion(backend).catch(() => {}) : Promise.resolve()
  return probe
}

const fetchIsCoreUpdateAvailable = async () => {
  const versionNumber = mihomo.value?.[1] ?? version.value
  const { assets } = await fetchWithLocalCache<{ assets: { name: string }[] }>(
    MIHOMO_CHANNEL[mihomo.value?.[0] ?? MIHOMO.Meta].check_update_url,
    versionNumber,
  )

  return !assets.some(({ name }) => name.includes(versionNumber))
}

export const checkUIUpdate = async () => {
  const { tag_name } = await fetchWithLocalCache<{ tag_name: string }>(
    'https://api.github.com/repos/wawnnzxd/zashboard/releases/latest',
    zashboardVersion.value,
  )

  isUIUpdateAvailable.value = Boolean(tag_name && tag_name !== `v${zashboardVersion.value}`)

  if (isUIUpdateAvailable.value && autoUpgradeDashboard.value) {
    upgradeUI().catch(() => {})
  }
}
