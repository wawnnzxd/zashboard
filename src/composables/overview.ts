import { ref } from 'vue'

// 公网 IP 状态已迁到 composables/publicIP.ts:它同时承担取数、单飞与打码,
// 放在这里只有状态、没有行为时,两个消费者各写各的就写出了打码规则不一致的隐私问题。

// 每个目标保存多次测速的结果(ms;0 表示该次失败),用于概览页柱状图展示。
export const baiduLatency = ref<number[]>([])
export const githubLatency = ref<number[]>([])
export const youtubeLatency = ref<number[]>([])
export const cloudflareLatency = ref<number[]>([])
