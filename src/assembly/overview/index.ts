// 组装层 · overview 门面。memory / traffic 统计流转交 clash 实现,统一返回 { data, close } 流。
import * as clash from './clash'

export const fetchMemoryAPI = <T>() => clash.fetchMemoryAPI<T>()

export const fetchTrafficAPI = <T>() => clash.fetchTrafficAPI<T>()
