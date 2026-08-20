// 会话资源:把「拉取 → 提交」这条链上四件反复被写错的事收进一个模块。
//
// proxies / rules / configs 三处 REST 资源此前各自实现了这套逻辑的一部分,而且各漏掉不同的一半:
//   - proxies:有 in-flight 去重、没有代际守卫 —— 切后端时新后端借用旧后端的在途请求(自己一次都不发),
//     旧后端的慢响应还会回填进新会话;而它内部那道 `fetchTime` 守卫在有了去重之后恒为 false,是死代码。
//   - rules:有代际守卫、没有去重键 —— 新后端既借用了旧请求、旧响应又被守卫正确丢弃,于是新后端的规则永远拿不到。
//   - configs:有代际守卫、没有新鲜度窗口。
// 三者还共有两个错误:`lastDoneAt` 写在 finally 里(失败也算「刚拉过」,吞掉之后整个新鲜窗口内的合法补拉),
// 以及没有任何一处能被「换后端」打断。
//
// 这类不变量靠每个实现者在每个 await 后逐点记忆必然写漏(三处写对了两处半就是三个 bug),所以收进这里。
// 调用者需要知道的全部事实只有四个方法,不需要知道代际、去重键、新鲜度窗口或错误通道:
//   fetch()        —— 读。去重 + 可选新鲜度窗口。**永不 reject**(错误已由 api/http.ts 的拦截器统一提示)
//   fetchOrThrow() —— 少数需要自己接错误的调用点(例如按钮要按成败切状态)
//   invalidate()   —— 写后失效。写方一定知道自己写了什么,读方什么都不用知道
//   reset()        —— 换会话。代际 +1,在途结果整份作废,并 abort 尚未落地的请求
//
// `load` 必须把**解析**与**提交**分开:解析阶段做网络与计算,返回一个提交闭包。
// 代际比对只在本模块做一次 —— 调用者不可能漏写守卫,写对是靠结构而不是靠人记得。

/** 解析阶段的产物:一个把结果写进门面状态的闭包。只有代际仍然有效时才会被调用。 */
type Commit = () => void

type Load = (signal: AbortSignal) => Promise<Commit>

export interface SessionResource {
  fetch: (options?: { maxAge?: number }) => Promise<void>
  fetchOrThrow: (options?: { maxAge?: number }) => Promise<void>
  invalidate: () => void
  reset: () => void
}

// 新建的资源自动登记,`resetSessionResources()` 一次全收 ——
// 新增一个资源默认就是安全的,而不是「新增时必须记得去 backendSession 里加一行 reset」。
const registry = new Set<SessionResource>()

export const createSessionResource = (load: Load): SessionResource => {
  let epoch = 0
  let inflight: Promise<void> | null = null
  let inflightEpoch = -1
  let controller: AbortController | null = null
  // 只在提交成功后写:失败不应该让接下来的新鲜窗口把合法补拉也吞掉
  let lastCommitAt = 0

  const run = async () => {
    const token = epoch
    const ac = new AbortController()

    controller = ac
    try {
      const commit = await load(ac.signal)

      // 会话已换代:这份结果属于上一个后端,整份丢弃(而不是部分写入造成新旧混合)
      if (token !== epoch) {
        return
      }
      commit()
      lastCommitAt = Date.now()
    } finally {
      if (controller === ac) {
        controller = null
      }
    }
  }

  const start = (options?: { maxAge?: number }) => {
    // 同代际的在途请求可以复用;跨代际的绝不复用(这正是 proxies 的原 bug)
    if (inflight && inflightEpoch === epoch) {
      return inflight
    }
    if (options?.maxAge && lastCommitAt > 0 && Date.now() - lastCommitAt < options.maxAge) {
      return Promise.resolve()
    }

    const task = run().finally(() => {
      // 必须判身份:旧代际的任务落地时不能踩掉新代际已经挂上的句柄
      if (inflight === task) {
        inflight = null
        inflightEpoch = -1
      }
    })

    inflight = task
    inflightEpoch = epoch

    return task
  }

  const resource: SessionResource = {
    fetch: (options) => start(options).catch(() => {}),
    fetchOrThrow: (options) => start(options),
    // 世界变了(我们刚写过):在途的那份答案是「写入之前发出的」,不能再算数 ——
    // 只清新鲜度是不够的,还必须放弃在途句柄与它的提交权,否则下一次 fetch 会搭上那份陈旧请求。
    // 不 abort:那份请求可能马上就回来,让它自然结束比中断更省事(反正结果已经不会被采用)。
    invalidate: () => {
      epoch += 1
      lastCommitAt = 0
      inflight = null
      inflightEpoch = -1
    },
    // 换会话:在途结果对新后端毫无价值,直接 abort 释放连接。
    reset: () => {
      epoch += 1
      lastCommitAt = 0
      inflight = null
      inflightEpoch = -1
      controller?.abort()
      controller = null
    },
  }

  registry.add(resource)

  return resource
}

/** 换后端 / 登出 / 编辑当前后端地址时调用一次,所有会话资源同时换代。 */
export const resetSessionResources = () => {
  for (const resource of registry) {
    resource.reset()
  }
}
