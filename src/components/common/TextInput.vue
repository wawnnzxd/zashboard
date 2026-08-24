<template>
  <label
    ref="anchorRef"
    :class="['input input-sm', { 'pe-1': clearable }]"
  >
    <input
      v-model="localValue"
      ref="inputRef"
      type="text"
      :class="inputClass"
      :placeholder="placeholder || ''"
      :name="name || ''"
      :autocomplete="autocomplete || ''"
      :role="menus?.length ? 'combobox' : undefined"
      :aria-expanded="menus?.length ? isMenuOpen : undefined"
      :aria-controls="menus?.length ? listboxId : undefined"
      :aria-activedescendant="
        isMenuOpen && activeMenuIndex >= 0 ? optionId(activeMenuIndex) : undefined
      "
      aria-autocomplete="list"
      @click="toggleMenu"
      @keydown="handleInputKeydown"
      @input="handleInput"
      @change="emits('change', localValue)"
    />
    <button
      v-if="clearable"
      type="button"
      class="btn btn-ghost btn-circle btn-xs h-5 min-h-5 w-5 shrink-0 p-0"
      @click="clearInput"
    >
      <XMarkIcon class="h-3 w-3" />
    </button>

    <Teleport
      v-if="isMounted"
      to="#app-content"
    >
      <Transition name="floating-menu">
        <div
          v-if="isMenuOpen"
          :id="listboxId"
          ref="menuRef"
          role="listbox"
          class="floating-menu-panel"
          :style="panelStyle"
        >
          <div
            v-for="(item, index) in menus"
            :id="optionId(index)"
            :key="item"
            role="option"
            :aria-selected="localValue === item"
            class="floating-menu-option"
            :class="[
              index === activeMenuIndex ? 'bg-base-200' : '',
              localValue === item ? 'text-primary font-medium' : '',
            ]"
            @pointermove="activeMenuIndex = index"
            @pointerdown.prevent
            @click="selectMenuItem(item)"
          >
            <span class="min-w-0 flex-1 truncate">{{ item }}</span>
            <CheckIcon
              v-if="localValue === item"
              class="ml-2 h-4 w-4 flex-none"
            />
            <button
              v-if="menusDeleteable"
              type="button"
              class="btn btn-ghost btn-circle btn-xs ml-2 h-5 min-h-5 w-5 flex-none p-0"
              :aria-label="`${$t('delete')}: ${item}`"
              @pointerdown.prevent
              @click.stop="deleteMenuItem(item)"
            >
              <XMarkIcon class="h-3 w-3" />
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </label>
</template>

<script lang="ts" setup>
import { useFloatingMenu } from '@/composables/floatingMenu'
import { useDebounceFn } from '@vueuse/core'
import { CheckIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { nextTick, onMounted, ref, useId, watch } from 'vue'

const emits = defineEmits<{
  (e: 'input', value: string): void
  (e: 'change', value: string): void
  (e: 'update:menus', value: string[]): void
}>()

const props = defineProps<{
  placeholder?: string
  name?: string
  autocomplete?: string
  clearable?: boolean
  inputClass?: string
  menus?: string[]
  menusDeleteable?: boolean
  // 输入防抖(ms):过滤框每 keystroke 会触发下游全量重算,搜索类输入应传 ~200
  debounce?: number
}>()

const inputValue = defineModel<string>()
// DOM 绑本地值,向外提交可选防抖:combobox 的高亮/选中判断也读本地值,
// 这样打字时下拉的即时反馈不受防抖影响,只有「下游重算」被推迟。
// 外部写入(清空 / 切后端 / 恢复历史)立即同步回本地。
const localValue = ref(inputValue.value ?? '')
const commit = (value: string) => {
  inputValue.value = value
}
const debouncedCommit = props.debounce ? useDebounceFn(commit, props.debounce) : commit

watch(localValue, (value) => debouncedCommit(value))
watch(inputValue, (value) => {
  if ((value ?? '') !== localValue.value) {
    localValue.value = value ?? ''
  }
})
const anchorRef = ref<HTMLElement>()
const inputRef = ref<HTMLInputElement>()
const menuRef = ref<HTMLDivElement>()
const isMounted = ref(false)
const isMenuOpen = ref(false)
const activeMenuIndex = ref(-1)
const id = useId().replace(/[^\w-]/g, '')
const listboxId = `text-input-listbox-${id}`
const { close, panelStyle, remeasure } = useFloatingMenu(anchorRef, menuRef, isMenuOpen, {
  maximumHeight: 256,
})

const optionId = (index: number) => `${listboxId}-option-${index}`

const openMenu = () => {
  if (!props.menus?.length || isMenuOpen.value) return
  const selectedIndex = props.menus.indexOf(localValue.value)
  activeMenuIndex.value = selectedIndex >= 0 ? selectedIndex : 0
  isMenuOpen.value = true
  nextTick(() => {
    menuRef.value
      ?.querySelector<HTMLElement>(`#${optionId(activeMenuIndex.value)}`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

const toggleMenu = () => (isMenuOpen.value ? close() : openMenu())

const moveActive = (direction: 1 | -1) => {
  const length = props.menus?.length ?? 0
  if (!length) return
  activeMenuIndex.value = (activeMenuIndex.value + direction + length) % length
  nextTick(() => {
    menuRef.value
      ?.querySelector<HTMLElement>(`#${optionId(activeMenuIndex.value)}`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

const selectMenuItem = (item: string) => {
  // 点选与清空是明确的一次性动作,不该等防抖窗口 —— 两处都同时写本地与模型
  localValue.value = item
  commit(item)
  close()
  inputRef.value?.focus()
}

const deleteMenuItem = (item: string) => {
  const nextMenus = (props.menus ?? []).filter((menu) => menu !== item)
  emits('update:menus', nextMenus)
  if (!nextMenus.length) {
    close()
    return
  }
  activeMenuIndex.value = Math.min(activeMenuIndex.value, nextMenus.length - 1)
  remeasure()
}

const handleInputKeydown = (event: KeyboardEvent) => {
  if (!props.menus?.length) return

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      if (isMenuOpen.value) moveActive(1)
      else openMenu()
      break
    case 'ArrowUp':
      event.preventDefault()
      if (isMenuOpen.value) moveActive(-1)
      else openMenu()
      break
    case 'Enter': {
      if (!isMenuOpen.value) return
      const item = props.menus?.[activeMenuIndex.value]
      if (!item) return
      event.preventDefault()
      event.stopPropagation()
      selectMenuItem(item)
      break
    }
    case 'Escape':
      if (!isMenuOpen.value) return
      event.preventDefault()
      event.stopPropagation()
      close()
      break
    case 'Tab':
      close()
  }
}

const handleInput = () => {
  emits('input', localValue.value)
  close()
}

const clearInput = () => {
  localValue.value = ''
  commit('')
  close()
}

watch(
  () => props.menus,
  (menus) => {
    if (!menus?.length) close()
    else if (isMenuOpen.value) remeasure()
  },
  { deep: true },
)

onMounted(() => (isMounted.value = true))
</script>
