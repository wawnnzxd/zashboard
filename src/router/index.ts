import { resolvePageTransition } from '@/composables/pageTransition'
import { ROUTE_NAME } from '@/constant'
import { i18n } from '@/i18n'
import { language } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import HomePage from '@/views/HomePage.vue'
// 默认路由同步保证首屏;其余页面全部懒加载(原先 8 页只有 Tools 懒,
// echarts/tanstack/设置组件全被塞进单体 entry)
import ProxiesPage from '@/views/ProxiesPage.vue'
import SetupPage from '@/views/SetupPage.vue'
import { useTitle } from '@vueuse/core'
import { watch } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'

const childrenRouter = [
  {
    path: 'proxies',
    name: ROUTE_NAME.proxies,
    component: ProxiesPage,
  },
  {
    path: 'overview',
    name: ROUTE_NAME.overview,
    component: () => import('@/views/OverviewPage.vue'),
  },
  {
    path: 'connections',
    name: ROUTE_NAME.connections,
    component: () => import('@/views/ConnectionsPage.vue'),
  },
  {
    path: 'logs',
    name: ROUTE_NAME.logs,
    component: () => import('@/views/LogsPage.vue'),
  },
  {
    path: 'rules',
    name: ROUTE_NAME.rules,
    component: () => import('@/views/RulesPage.vue'),
  },
  {
    path: 'settings',
    name: ROUTE_NAME.settings,
    component: () => import('@/views/SettingsPage.vue'),
  },
]

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: ROUTE_NAME.proxies,
      component: HomePage,
      children: childrenRouter,
    },
    {
      path: '/setup',
      name: ROUTE_NAME.setup,
      component: SetupPage,
    },
    {
      path: '/:catchAll(.*)',
      redirect: ROUTE_NAME.proxies,
    },
  ],
})

const title = useTitle('Desire')
const setTitleByName = (name: string | symbol | undefined) => {
  if (typeof name === 'string' && activeBackend.value) {
    const backend = activeBackend.value
    const prefix = backend.label || `${backend.host}:${backend.port}`
    title.value = `${prefix} | ${i18n.global.t(name)}`
  } else {
    title.value = 'Desire'
  }
}

router.beforeEach((to, from) => {
  resolvePageTransition(to, from)

  if (!activeBackend.value && to.name !== ROUTE_NAME.setup) {
    router.push({ name: ROUTE_NAME.setup })
    return
  }
})

router.afterEach((to) => {
  setTitleByName(to.name)
})

watch([language, activeBackend], () => {
  setTimeout(() => {
    setTitleByName(router.currentRoute.value.name)
  })
})

export default router
