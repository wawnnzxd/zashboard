import { proxyGroupList, proxyMap } from '@/assembly/proxies'
import { FOLDER_MODE, FOLDER_MODE_AUTO_THRESHOLD } from '@/constant'
import { proxyFolderMode } from '@/store/settings'
import { useStorage } from '@vueuse/core'
import { v4 as uuid } from 'uuid'
import { computed, watch } from 'vue'

export const VIRTUAL_ALL = '__all__'
export const VIRTUAL_UNCAT = '__uncat__'

export const BUILTIN_STRATEGY_ID = 'builtin-strategy'
export const BUILTIN_NODES_ID = 'builtin-nodes'

export type FolderRule =
  | { type: 'auto'; value: 'nodeOnly' | 'hasGroup' }
  | { type: 'regex'; pattern: string }
  | { type: 'excludeRegex'; pattern: string }

export interface Folder {
  id: string
  name: string
  icon?: string
  order: number
  rules: FolderRule[]
  manualIncludes: string[]
}

interface FolderState {
  folders: Folder[]
  activeId: string
  seeded: boolean
}

const defaultState = (): FolderState => ({
  folders: [],
  activeId: VIRTUAL_ALL,
  seeded: false,
})

export const folderState = useStorage<FolderState>(
  'config/proxy-folders',
  defaultState(),
  localStorage,
  {
    mergeDefaults: true,
  },
)

const seedDefaultFolders = () => {
  if (folderState.value.seeded) return
  folderState.value.folders = [
    {
      id: BUILTIN_STRATEGY_ID,
      name: 'folder_builtin_strategy',
      order: 0,
      rules: [{ type: 'auto', value: 'hasGroup' }],
      manualIncludes: [],
    },
    {
      id: BUILTIN_NODES_ID,
      name: 'folder_builtin_nodes',
      order: 1,
      rules: [{ type: 'auto', value: 'nodeOnly' }],
      manualIncludes: [],
    },
  ]
  folderState.value.seeded = true
}

seedDefaultFolders()

export const folders = computed({
  get: () => folderState.value.folders,
  set: (v) => {
    folderState.value.folders = v
  },
})

export const activeFolderId = computed({
  get: () => folderState.value.activeId,
  set: (v) => {
    folderState.value.activeId = v
  },
})

// 组名集合提成 computed:matchRule 是「每个组 × 每个文件夹 × 每条规则」调用的,原来
// isNodeOnly 每次调用都重建一次全量 Set,整体是 O(组数² × 文件夹数)。文件夹模式在
// 组数 > FOLDER_MODE_AUTO_THRESHOLD 时才自动开启 —— 恰好只对大配置生效,正是这个
// 复杂度最疼的场合。挂在 computed 上后随 proxyGroupList 一起失效,语义不变。
const proxyGroupNameSet = computed(() => new Set(proxyGroupList.value))

const isNodeOnly = (groupName: string) => {
  const g = proxyMap.value[groupName]
  if (!g?.all || g.all.length === 0) return false
  const groupSet = proxyGroupNameSet.value
  return !g.all.some((member) => groupSet.has(member))
}

// 正则按「规则对象」缓存,而不是按 pattern 字符串开一张全局表:规则对象来自
// folderState(useStorage 的响应式对象),生命周期就是这条规则本身,WeakMap 随它一起
// 回收;编辑规则输入框时逐字符产生的中间 pattern 不会永久堆在内存里。同时记下编译时
// 用的 pattern,用户就地改写规则后缓存自动作废,调用方不需要记得手动失效。
const compiledRuleRegex = new WeakMap<FolderRule, { pattern: string; regex: RegExp | null }>()

const getRuleRegex = (rule: Extract<FolderRule, { pattern: string }>): RegExp | null => {
  const cached = compiledRuleRegex.get(rule)
  if (cached && cached.pattern === rule.pattern) return cached.regex

  let regex: RegExp | null = null
  try {
    regex = new RegExp(rule.pattern)
  } catch {
    regex = null
  }
  compiledRuleRegex.set(rule, { pattern: rule.pattern, regex })
  return regex
}

const matchRule = (groupName: string, rule: FolderRule): boolean => {
  if (rule.type === 'auto') {
    return rule.value === 'nodeOnly' ? isNodeOnly(groupName) : !isNodeOnly(groupName)
  }
  if (rule.type === 'regex' || rule.type === 'excludeRegex') {
    if (!rule.pattern) return false
    return getRuleRegex(rule)?.test(groupName) ?? false
  }
  return false
}

// 单趟扫描代替两次 filter:这个函数同样是「每个组 × 每个文件夹」调用,原实现每次调用
// 都要为 includes / excludes 各建一个临时数组。返回语义逐字保持:没有任何 include 命中
// 就不属于该文件夹,命中之后再被任意 excludeRegex 否掉。
const folderRuleMatch = (groupName: string, rules: FolderRule[]): boolean => {
  let included = false

  for (const rule of rules) {
    if (rule.type === 'excludeRegex') {
      if (matchRule(groupName, rule)) return false
    } else if (!included && matchRule(groupName, rule)) {
      included = true
    }
  }

  return included
}

const sortedFolders = computed(() =>
  [...folderState.value.folders].sort((a, b) => a.order - b.order),
)

export const groupMatchesFolderRule = (groupName: string, folderId: string): boolean => {
  const f = folderState.value.folders.find((x) => x.id === folderId)
  if (!f) return false
  return folderRuleMatch(groupName, f.rules)
}

export const foldersOfGroup = (groupName: string): string[] => {
  const result: string[] = []
  for (const f of sortedFolders.value) {
    const manual = f.manualIncludes.includes(groupName)
    const ruled = folderRuleMatch(groupName, f.rules)
    if (manual || ruled) result.push(f.id)
  }
  return result
}

export const groupsByFolder = computed(() => {
  const map = new Map<string, string[]>()
  for (const name of proxyGroupList.value) {
    const ids = foldersOfGroup(name)
    if (ids.length === 0) {
      const list = map.get(VIRTUAL_UNCAT) ?? []
      list.push(name)
      map.set(VIRTUAL_UNCAT, list)
      continue
    }
    for (const id of ids) {
      const list = map.get(id) ?? []
      list.push(name)
      map.set(id, list)
    }
  }
  return map
})

export const groupsInActiveFolder = computed<Set<string> | null>(() => {
  const id = folderState.value.activeId
  if (id === VIRTUAL_ALL) return null
  const list = groupsByFolder.value.get(id) ?? []
  return new Set(list)
})

export const folderCount = (id: string) => groupsByFolder.value.get(id)?.length ?? 0

export const isProxyFolderModeActive = computed(() => {
  switch (proxyFolderMode.value) {
    case FOLDER_MODE.ON:
      return true
    case FOLDER_MODE.OFF:
      return false
    default:
      return proxyGroupList.value.length > FOLDER_MODE_AUTO_THRESHOLD
  }
})

watch(
  proxyGroupList,
  (list) => {
    if (!list.length) return
    const id = folderState.value.activeId
    if (id === VIRTUAL_ALL || id === VIRTUAL_UNCAT) return
    if (!folderState.value.folders.some((f) => f.id === id)) {
      folderState.value.activeId = VIRTUAL_ALL
    }
  },
  { immediate: true },
)

export const createFolder = (name: string): Folder => {
  const folder: Folder = {
    id: uuid(),
    name,
    order: folderState.value.folders.length,
    rules: [],
    manualIncludes: [],
  }
  folderState.value.folders.push(folder)
  return folder
}

export const removeFolder = (id: string) => {
  folderState.value.folders = folderState.value.folders.filter((f) => f.id !== id)
  if (folderState.value.activeId === id) folderState.value.activeId = VIRTUAL_ALL
}

export const updateFolder = (id: string, patch: Partial<Omit<Folder, 'id'>>) => {
  const f = folderState.value.folders.find((x) => x.id === id)
  if (!f) return
  Object.assign(f, patch)
}

export const reorderFolders = (ids: string[]) => {
  const map = new Map(folderState.value.folders.map((f) => [f.id, f]))
  const next: Folder[] = []
  ids.forEach((id, idx) => {
    const f = map.get(id)
    if (f) {
      f.order = idx
      next.push(f)
      map.delete(id)
    }
  })
  for (const f of map.values()) {
    f.order = next.length
    next.push(f)
  }
  folderState.value.folders = next
}

export const addGroupToFolder = (groupName: string, folderId: string) => {
  const f = folderState.value.folders.find((x) => x.id === folderId)
  if (!f) return
  if (!f.manualIncludes.includes(groupName)) f.manualIncludes.push(groupName)
}

export const removeManualInclude = (groupName: string, folderId: string) => {
  const f = folderState.value.folders.find((x) => x.id === folderId)
  if (!f) return
  f.manualIncludes = f.manualIncludes.filter((n) => n !== groupName)
}

export const folderManagerOpen = useStorage('cache/folder-manager-open', false, sessionStorage)
