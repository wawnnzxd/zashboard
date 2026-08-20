// 公网 IP 的单一真相。
//
// 概览页「网络信息」卡与地球仪都要用本机公网 IP,原本各自发请求、各自往同一对共享 ref 里写,
// 于是同时出现三个问题:
//   1. 首屏对同一个接口发两次请求(卡片先发,地球仪 400ms 后发现共享值还没落地,自己再发一次);
//   2. **两处打码规则不一致** —— 地球仪写回的「打码版」是 `1.2.*.*`,而卡片在隐私开关关闭时
//      显示的正是这个字段,于是公网 IP 的前两段被暴露在本该完全打码的视图里;
//   3. 地球仪硬编码 ip.sb,而卡片那一行的标题是用户在设置里选的 IPInfoAPI,两者可能来自不同供应商。
//
// 收进一个模块后,消费者只需要 fetchPublicIP()/awaitPublicIP(),不需要知道单飞、打码规则或供应商选择。
// 特别是 awaitPublicIP:它**自己会在需要时发起请求**,所以地球仪不再依赖「网络信息」卡是否存在、
// 是否开了自动检测、是否失败过 —— 原实现在这三种情况下都会白等满 2.5 秒才放弃。
import { getIPFromIpipnetAPI, getIPInfo } from '@/api/geoip'
import { i18n } from '@/i18n'
import * as ipaddr from 'ipaddr.js'
import { ref } from 'vue'

export type PublicIPSource = 'china' | 'global'

export type PublicIPInfo = {
  /** 隐私开关关闭时显示:地址部分一律完全打码 */
  ip: string[]
  /** 隐私开关打开时显示:真实地址 */
  ipWithPrivacy: string[]
}

// 打码只有这一种写法。任何「保留前几段」的变体都会在隐私视图里泄露信息。
const MASKED_IP = '***.***.***.***'

export const ipForChina = ref<PublicIPInfo>({ ip: [], ipWithPrivacy: [] })
export const ipForGlobal = ref<PublicIPInfo>({ ip: [], ipWithPrivacy: [] })

export const isValidPublicIP = (value: string) => Boolean(value) && ipaddr.isValid(value)

const statusInfo = (key: string): PublicIPInfo => ({
  ip: [i18n.global.t(key), ''],
  ipWithPrivacy: [i18n.global.t(key), ''],
})

const currentIP = (source: PublicIPSource) =>
  (source === 'global' ? ipForGlobal.value : ipForChina.value).ipWithPrivacy.find(
    isValidPublicIP,
  ) ?? ''

let inflight: Promise<void> | null = null

const run = async () => {
  ipForChina.value = statusInfo('getting')
  ipForGlobal.value = statusInfo('getting')

  // 两个源互不依赖,一个失败不应该拖累另一个
  await Promise.allSettled([
    getIPInfo()
      .then((res) => {
        const label = `${res.country} ${res.organization}`.trim()

        ipForGlobal.value = { ipWithPrivacy: [label, res.ip], ip: [label, MASKED_IP] }
      })
      .catch(() => {
        ipForGlobal.value = statusInfo('testFailed')
      }),
    getIPFromIpipnetAPI()
      .then((res) => {
        const label = res.data.location.join(' ')

        ipForChina.value = {
          ipWithPrivacy: [label, res.data.ip],
          ip: [`${res.data.location[0]} ** ** **`, MASKED_IP],
        }
      })
      .catch(() => {
        ipForChina.value = statusInfo('testFailed')
      }),
  ])
}

/** 取一次公网 IP。已有在途请求时直接并入;已经拿到有效结果时默认不重复请求(force 可强制刷新)。 */
export const fetchPublicIP = (options?: { force?: boolean }) => {
  if (inflight) {
    return inflight
  }
  if (!options?.force && (currentIP('china') || currentIP('global'))) {
    return Promise.resolve()
  }

  inflight = run().finally(() => {
    inflight = null
  })

  return inflight
}

/** 等到指定源有可用 IP 为止;没有人取过就自己取。失败返回空串,调用方据此显示错误态。 */
export const awaitPublicIP = async (source: PublicIPSource) => {
  const cached = currentIP(source)

  if (cached) {
    return cached
  }
  await fetchPublicIP()

  return currentIP(source)
}
