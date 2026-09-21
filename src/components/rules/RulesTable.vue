<template>
  <VirtualTable
    v-if="rulesTabShow === RULE_TAB_TYPE.PROVIDER"
    key="rule-providers"
    :data="renderRulesProvider"
    :columns="providerColumns"
    sorting-key="config/rule-providers-table-sorting"
    :estimate-size="providerRowEstimateSize"
  />
  <VirtualTable
    v-else
    key="rules"
    :data="renderRules"
    :columns="ruleColumns"
    :column-visibility="ruleColumnVisibility"
    sorting-key="config/rules-table-sorting"
    :estimate-size="rulesRowEstimateSize"
    :row-class="ruleRowClass"
    @row-click="handlerRuleClick"
  />
  <DialogWrapper
    v-model="groupDialogVisible"
    :title="groupDialogTitle"
  >
    <div
      v-if="selectedRule"
      class="flex flex-col gap-2"
    >
      <ProxyChainPath
        :proxy="selectedRule.proxy"
        :selected="selectedGroup"
        :show-now-node="displayNowNodeInRule"
        :show-latency="displayLatencyInRule"
        @update:selected="selectedGroup = $event"
      />
      <ProxyGroup
        :name="selectedGroup"
        :force-open="true"
        class="transparent-collapse"
      />
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import { renderRules, renderRulesProvider, rulesFilter, rulesTabShow } from '@/store/rules'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import HighlightText from '@/components/common/HighlightText.vue'
import ProxyChainPath from '@/components/common/ProxyChainPath.vue'
import VirtualTable from '@/components/common/VirtualTable.vue'
import ProxyGroup from '@/components/proxies/ProxyGroup.vue'
import { proxyGroupList } from '@/assembly/proxies'
import { fetchRules, rules, updateRuleProvider } from '@/assembly/rules'
import { useRuleHitTooltip } from '@/composables/use-rule-hit-tooltip'
import {
  EMPTY_CELL,
  formatRuleHitCount,
  getRuleSize,
  isRuleDisabled,
  isUpdateableRuleSet,
  toggleRuleDisabledWithSideEffects,
} from '@/helper/rules'
import { RULE_TAB_TYPE, TABLE_SIZE } from '@/constant'
import { notifyRequestError } from '@/helper/request-error'
import { fromNow } from '@/helper/utils'
import { displayLatencyInRule, displayNowNodeInRule, tableSize } from '@/store/settings'
import type { Rule, RuleProvider } from '@/types'
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import type { ColumnDef } from '@tanstack/vue-table'
import dayjs from 'dayjs'
import { computed, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { showRuleHitTip } = useRuleHitTooltip()

// 传给 VirtualTable 的行高必须 >= 本表最高的一行(见该组件 estimateSize 的说明)。
// 下面的数字是拿本仓库的 daisyUI 和这两张表真实的单元格 DOM 在 Chrome 里量出来的,
// 不是估的:table-sm(尺寸=大,单元格上下 padding 共 16)下,规则表每一行都有策略组列的
// ProxyChainPath(内容 28px)→ 44;规则集表最高的是操作列的 btn-xs(24px)→ 40。
// 原本两张表都写 36,规则表每滚过一行就错 8px(内容比滚动条快 22%)。
// table-xs(尺寸=小,padding 共 8)下两者分别是 36 / 32,都不超过行内 height 垫出来的 36,
// 统一用 36 —— 两档都写死高值只会白白拉高紧凑档的行距。
const rulesRowEstimateSize = computed(() => (tableSize.value === TABLE_SIZE.LARGE ? 44 : 36))
const providerRowEstimateSize = computed(() => (tableSize.value === TABLE_SIZE.LARGE ? 40 : 36))

// 规则序号按配置顺序算一次,免得每行都去 rules 里 indexOf
const ruleIndexMap = computed(() => {
  const map = new Map<Rule, number>()

  rules.value.forEach((rule, index) => map.set(rule, index + 1))

  return map
})

const hasRuleExtra = computed(() => rules.value.some((rule) => rule.extra))
const ruleColumnVisibility = computed(() => ({
  hitMiss: hasRuleExtra.value,
}))

const updatingProviders = ref<string[]>([])
const togglingRules = ref<string[]>([])

const isRuleSelectable = (rule: Rule) =>
  proxyGroupList.value.includes(rule.proxy) && !isRuleDisabled(rule)

const selectedRule = ref<Rule | null>(null)
const selectedGroup = ref('')
const groupDialogVisible = ref(false)
const groupDialogTitle = computed(() => {
  const rule = selectedRule.value

  if (!rule) {
    return ''
  }

  return rule.payload ? `${rule.type}: ${rule.payload}` : rule.type
})

const ruleRowClass = (rule: Rule) => (isRuleSelectable(rule) ? 'cursor-pointer' : undefined)

const handlerRuleClick = (rule: Rule) => {
  if (!isRuleSelectable(rule)) return

  selectedRule.value = rule
  selectedGroup.value = rule.proxy
  groupDialogVisible.value = true
}

const updateProviderHandler = async (name: string) => {
  if (updatingProviders.value.includes(name)) return

  updatingProviders.value.push(name)
  try {
    await updateRuleProvider(name)
    await fetchRules()
  } catch (e) {
    notifyRequestError(e)
  } finally {
    updatingProviders.value = updatingProviders.value.filter((item) => item !== name)
  }
}

const toggleRuleHandler = async (rule: Rule) => {
  const key = `${rule.type}-${rule.payload}`

  if (togglingRules.value.includes(key)) return

  togglingRules.value.push(key)
  try {
    await toggleRuleDisabledWithSideEffects(rule)
  } catch (e) {
    notifyRequestError(e)
  } finally {
    togglingRules.value = togglingRules.value.filter((item) => item !== key)
  }
}

const updateButton = (name: string, onClick: () => void) =>
  h(
    'button',
    {
      class: `btn btn-circle btn-ghost btn-xs ${updatingProviders.value.includes(name) ? 'animate-spin' : ''}`,
      onClick: (e: MouseEvent) => {
        e.stopPropagation()
        onClick()
      },
    },
    [h(ArrowPathIcon, { class: 'h-3.5 w-3.5 opacity-60' })],
  )

const ruleColumns: ColumnDef<Rule>[] = [
  {
    header: '#',
    id: 'index',
    accessorFn: (rule) => ruleIndexMap.value.get(rule) ?? 0,
    cell: ({ row }) =>
      h(
        'span',
        { class: 'tabular-nums opacity-50' },
        String(ruleIndexMap.value.get(row.original) ?? ''),
      ),
    meta: { cellClass: 'w-12 text-right', headerClass: 'text-right' },
  },
  {
    header: () => t('type'),
    id: 'type',
    accessorFn: (rule) => rule.type,
    cell: ({ row }) => h(HighlightText, { text: row.original.type, filter: rulesFilter.value }),
    meta: { cellClass: 'w-40' },
  },
  {
    header: () => t('content'),
    id: 'payload',
    accessorFn: (rule) => rule.payload,
    cell: ({ row }) =>
      row.original.payload
        ? h(HighlightText, { text: row.original.payload, filter: rulesFilter.value })
        : h('span', { class: 'opacity-40' }, EMPTY_CELL),
  },
  {
    header: () => t('proxyGroup'),
    id: 'proxy',
    accessorFn: (rule) => rule.proxy,
    cell: ({ row }) =>
      h(ProxyChainPath, {
        proxy: row.original.proxy,
        collapsed: true,
        interactive: false,
        showNowNode: displayNowNodeInRule.value,
        showLatency: displayLatencyInRule.value,
        filter: rulesFilter.value,
      }),
  },
  {
    header: () => t('ruleCount'),
    id: 'size',
    accessorFn: (rule) => {
      const size = getRuleSize(rule)

      return typeof size === 'number' && size !== -1 ? size : ''
    },
    cell: ({ getValue }) => {
      const size = getValue<number | ''>()

      return size === ''
        ? h('span', { class: 'opacity-40' }, EMPTY_CELL)
        : h('span', { class: 'tabular-nums' }, size.toLocaleString())
    },
    meta: { cellClass: 'w-24 text-right', headerClass: 'text-right' },
  },
  {
    header: () => t('hitMissCount'),
    id: 'hitMiss',
    accessorFn: (rule) => rule.extra?.hitCount ?? 0,
    cell: ({ row }) => {
      const extra = row.original.extra

      return h(
        'span',
        {
          class: 'grid grid-cols-[1fr_auto_1fr] items-baseline tabular-nums',
          onMouseenter: (e: MouseEvent) => showRuleHitTip(e, row.original),
        },
        [
          h(
            'span',
            { class: extra?.hitCount ? 'text-right' : 'text-right opacity-40' },
            formatRuleHitCount(extra?.hitCount),
          ),
          h('span', { class: 'mx-1 opacity-30' }, '/'),
          h(
            'span',
            { class: extra?.missCount ? 'text-left opacity-60' : 'text-left opacity-40' },
            formatRuleHitCount(extra?.missCount),
          ),
        ],
      )
    },
    meta: { cellClass: 'w-36', headerClass: 'text-center', noCellTitle: true },
  },
  {
    header: () => t('statusLabel'),
    id: 'status',
    enableSorting: false,
    cell: ({ row }) => {
      const rule = row.original

      if (!rule.uuid && !rule.extra) {
        return null
      }

      return h('input', {
        type: 'checkbox',
        class: 'toggle toggle-sm',
        checked: !isRuleDisabled(rule),
        onClick: (e: MouseEvent) => e.stopPropagation(),
        onChange: () => toggleRuleHandler(rule),
      })
    },
    meta: { cellClass: 'w-20' },
  },
  {
    header: () => t('actions'),
    id: 'actions',
    enableSorting: false,
    cell: ({ row }) =>
      isUpdateableRuleSet(row.original)
        ? updateButton(row.original.payload, () => updateProviderHandler(row.original.payload))
        : null,
    meta: { cellClass: 'w-20' },
  },
]

// 序号按列表算一次,免得每行 indexOf 全表线性扫
const providerIndexMap = computed(
  () => new Map(renderRulesProvider.value.map((provider, index) => [provider, index + 1])),
)

const providerColumns: ColumnDef<RuleProvider>[] = [
  {
    header: '#',
    id: 'index',
    accessorFn: (provider) => providerIndexMap.value.get(provider) ?? 0,
    cell: ({ getValue }) =>
      h('span', { class: 'tabular-nums opacity-50' }, String(getValue() ?? '')),
    meta: { cellClass: 'w-12 text-right', headerClass: 'text-right' },
  },
  {
    header: () => t('name'),
    id: 'name',
    accessorFn: (provider) => provider.name,
    cell: ({ row }) => h(HighlightText, { text: row.original.name, filter: rulesFilter.value }),
  },
  {
    header: () => t('ruleCount'),
    id: 'ruleCount',
    accessorFn: (provider) => provider.ruleCount,
    cell: ({ getValue }) =>
      h('span', { class: 'tabular-nums' }, (getValue<number>() ?? 0).toLocaleString()),
    meta: { cellClass: 'w-24 text-right', headerClass: 'text-right' },
  },
  {
    header: () => t('behavior'),
    id: 'behavior',
    accessorFn: (provider) => provider.behavior,
    cell: ({ row }) => h(HighlightText, { text: row.original.behavior, filter: rulesFilter.value }),
    meta: { cellClass: 'w-40' },
  },
  {
    header: () => t('vehicleType'),
    id: 'vehicleType',
    accessorFn: (provider) => provider.vehicleType,
    cell: ({ row }) =>
      h(HighlightText, { text: row.original.vehicleType, filter: rulesFilter.value }),
    meta: { cellClass: 'w-32' },
  },
  {
    header: () => t('updated'),
    id: 'updatedAt',
    accessorFn: (provider) => fromNow(provider.updatedAt),
    sortingFn: (prev, next) =>
      dayjs(prev.original.updatedAt).valueOf() - dayjs(next.original.updatedAt).valueOf(),
    cell: ({ getValue }) => h('span', {}, String(getValue() ?? '')),
    meta: { cellClass: 'w-40' },
  },
  {
    header: () => t('actions'),
    id: 'actions',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.vehicleType === 'Inline'
        ? null
        : updateButton(row.original.name, () => updateProviderHandler(row.original.name)),
    meta: { cellClass: 'w-20' },
  },
]
</script>
