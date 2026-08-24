import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { execSync } from 'child_process'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { version } from './package.json' with { type: 'json' }

const getGitCommitId = (): string => {
  try {
    const commitMessage = execSync('git log -1 --pretty=%B', { encoding: 'utf8' }).trim()

    if (commitMessage.includes('chore(main): release')) {
      return ''
    }

    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch (error) {
    console.warn('无法获取git commit ID:', error)
    return ''
  }
}

// Selects which fonts get bundled. One of:
//   all (default) | cdn | firasans | misans | pingfang | sarasa | none
// See src/assets/load-fonts.ts for what each value loads.
const font = process.env.FONT || 'all'

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __COMMIT_ID__: JSON.stringify(getGitCommitId()),
    __FONT__: JSON.stringify(font),
  },
  base: './',
  plugins: [
    vue(),
    vueJsx(),
    VitePWA({
      // prompt 模式:autoUpdate 的 skipWaiting 会热替换 SW 并清掉旧 precache,
      // 常开数天的面板里未加载过的懒 chunk 会因引用旧 hash 直接加载失败;
      // 改为页面内横幅提示用户刷新(见 App.vue)。
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon-dark.svg'],
      workbox: {
        // The globe is lazy-loaded, but its local textures and bundled attribution must
        // remain available after the first PWA install/update for offline cache reuse.
        // 不含 woff2:FONT=all 打进 282 个 unicode-range 子集(7.5MB),而运行时只可能
        // 命中一个家族的十几个子集 + 一个 emoji 字体,precache 却是无条件全量下载。
        // 字体改走下面的 CacheFirst 运行时缓存 —— 用到哪个存哪个,离线完整度只差
        // 「从未在线加载过的字重」。(在 globPatterns 里不列,比在 globIgnores 里
        // 反选更干净:globIgnores 保持「排除懒加载 chunk」这一单一语义。)
        // 也不含 md:只有 public/THIRD_PARTY_NOTICES.md,离线预取它没有意义。
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,jpg}'],
        // 主 chunk 仍留着抬高的上限:离 Workbox 的 2 MiB 默认值不算远,
        // 别让它某次小幅增长就悄悄掉出 precache(离线即失效)。
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // background.jpg 只在 earthVisualMode === 'space' 时才被采样,而默认是
        // 'flat',默认配置下这 220KB 100% 用不到(其余三张贴图保留,扁平模式就要用)。
        globIgnores: ['**/background-*.jpg'],
        runtimeCaching: [
          {
            // 星空背景不进 precache,但切到 space 模式后要能离线复用:globeLayer 是
            // Promise.all 一起等四张贴图的,缺一张整个地球仪就起不来。
            urlPattern: /assets\/background-[^/]*\.jpg$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'earth-textures',
              expiration: {
                maxEntries: 4,
                maxAgeSeconds: 60 * 60 * 24 * 365,
                purgeOnQuotaError: true,
              },
            },
          },
          {
            // 字体不再 precache,改为用到才存。不设 maxEntries:单个家族就有近百个
            // unicode-range 子集,设小了会 LRU 反复淘汰-重下(在线白费流量、离线直接掉字体);
            // URL 带内容 hash 不会变质,用 maxAge + 配额兜底即可。
            urlPattern: /assets\/[^/]+\.woff2?$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 365,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
      manifest: {
        name: 'Desire',
        short_name: 'Desire',
        description: 'Desire - a clash/mihomo dashboard',
        theme_color: '#000000',
        icons: [
          {
            src: './pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: './pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: './pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: './pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // 稳定的 vendor 分层:业务改一行不再让用户重下整个单体 entry。
        // 只钉共享大件与强隔离件(three 只被地球仪这个懒消费方引用,
        // 命名 chunk 不会被别的入口拉下来),其余交给 rollup 按使用点自动分。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
          if (id.includes('/three/') || id.includes('/three@')) return 'three'
          if (id.includes('vue-i18n') || id.includes('@intlify')) return 'i18n'
          // vuedraggable 是 CJS,它的 require('vue') 走 node 的 require 条件,解析到
          // vue 完整版(vue/index.js → dist/vue.cjs.prod.js),而完整版无条件带上
          // @vue/compiler-dom。全 app 没有任何运行时模板编译,这份编译器却被下面的
          // vue-stack 规则钉成 entry 的静态依赖,等于每次冷启动都 modulepreload
          // 约 82KB min 的死代码。单独成 chunk 后它只被 vuedraggable 引用,随后者
          // 一起退到懒加载路径。注意 vue 完整版必须和编译器同组:只挪编译器的话,
          // 留在 vue-stack 里的 vue.cjs.prod.js 仍会静态 import 它,preload 照旧。
          if (/node_modules\/(@vue\/compiler-|vue\/(index\.js|dist\/vue\.cjs))/.test(id)) {
            return 'vue-compiler'
          }
          if (
            id.includes('/@vue/') ||
            id.includes('/vue/') ||
            id.includes('vue-router') ||
            id.includes('@vueuse')
          ) {
            return 'vue-stack'
          }
          if (
            id.includes('lodash') ||
            id.includes('axios') ||
            id.includes('dayjs') ||
            id.includes('@heroicons') ||
            id.includes('tailwind-merge')
          ) {
            return 'vendor-core'
          }
          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // mmdb-lib imports Node's `net`; back it with a tiny browser shim.
      net: fileURLToPath(new URL('./src/helper/netShim.ts', import.meta.url)),
    },
  },
})
