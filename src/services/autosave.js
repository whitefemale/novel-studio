// 自动保存调度器：把「防抖 + 冲刷 + 失败重试」从编辑器组件里抽出，
// 一是让切换章节/离开页面时的落盘顺序有一处明确的实现，
// 二是让它成为可被单元测试直接驱动的纯逻辑。
//
// 关键不变量：待保存的目标 id 在 schedule() 时捕获，而不是在定时器触发时再去读
// 「当前章节」。旧实现（Editor.vue 的 saveNow 里 `const c = currentChapter.value`）
// 在触发时刻解析目标，用户在 1.5 秒防抖窗口内切换章节时，
// 最后一笔改动会被写到新章节上，原标题的内容直接丢失。
//
// 2026 升级（规范 P0）：保存不再只有「保存中 / 已保存」两态。写入可能失败
// （磁盘满、浏览器清理、IndexedDB 被锁），失败必须**可见**，并且自动重试。
// 状态机：idle → dirty → saving → saved | failed
//          failed →（用户点重试 / 新输入）→ saving

/** 保存状态。UI 只认这五个值。 */
export const SAVE_STATES = ['idle', 'dirty', 'saving', 'saved', 'failed']

export const DEFAULT_RETRY_DELAYS = [800, 1600, 3200]

/**
 * @param {object} opts
 * @param {(id:any)=>Promise<void>} opts.persist      真正落盘的动作
 * @param {number} [opts.delay]                       防抖毫秒数
 * @param {(id:any)=>void} [opts.onSaved]             落盘完成回调
 * @param {(state:string, meta:object)=>void} [opts.onState] 状态变化回调
 * @param {(err:Error, meta:object)=>void} [opts.onError]    最终失败回调（重试耗尽才触发）
 * @param {number[]} [opts.retryDelays]               重试间隔（默认 3 次）
 * @param {(ms:number)=>Promise<void>} [opts.sleep]   注入 sleep 以便单测不真等待
 */
export function createAutosaver({
  persist,
  delay = 1500,
  onSaved,
  onState,
  onError,
  retryDelays = DEFAULT_RETRY_DELAYS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let timer = null
  let pendingId = null
  let lastFailedId = null
  let state = 'idle'
  let lastStateId = null
  // 每次 schedule / cancel / retry 都递增。一次落盘（含其全部重试）持有启动时的
  // 值；中途有新输入时旧的那一轮立刻作废，避免「重试把新状态盖回 saved」。
  let epoch = 0
  let running = null

  function emitState(next, meta = {}) {
    state = next
    try {
      onState?.(next, meta)
    } catch {
      // 状态回调是界面代码；它抛错不该让保存本身失败
    }
  }

  async function doRun() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const id = pendingId
    // 必须在第一个 await 之前摘除：否则飞行中的落盘会顺手吃掉新排队的 id
    pendingId = null
    if (id == null) return { ok: true, skipped: true }

    const myEpoch = epoch
    emitState('saving', { id, attempt: 0 })
    let lastErr = null

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await persist(id)
        // 落盘期间用户又敲了新内容（或切了章），这一轮就不再代表当前状态。
        // 写本身是成功的，只是「已保存」这个标签已经过期了。
        if (myEpoch === epoch) {
          lastFailedId = null
          emitState('saved', { id, attempt })
          try {
            onSaved?.(id)
          } catch {
            // 同上：界面回调失败不影响落盘结论
          }
          return { ok: true, id, attempt }
        }
        return { ok: true, id, attempt, superseded: true }
      } catch (err) {
        lastErr = err
        if (myEpoch !== epoch) return { ok: false, id, error: err, superseded: true }
        if (attempt >= retryDelays.length) break
        const wait = Number(retryDelays[attempt]) || 0
        emitState('saving', {
          id,
          attempt: attempt + 1,
          retrying: true,
          delayMs: wait,
          message: String((err && err.message) || err)
        })
        await sleep(wait)
        // sleep 期间被新输入/取消打断
        if (myEpoch !== epoch) return { ok: false, id, error: err, superseded: true }
      }
    }

    lastFailedId = id
    emitState('failed', {
      id,
      attempt: retryDelays.length,
      message: String((lastErr && lastErr.message) || lastErr || '保存失败')
    })
    try {
      onError?.(lastErr, { id, attempt: retryDelays.length })
    } catch {
      // 忽略界面回调错误
    }
    return { ok: false, id, error: lastErr }
  }

  /**
   * 立即落盘（若有排队的目标）；返回 Promise 以便调用方 await 顺序。
   *
   * 若已有一轮在飞行（包括正在重试等待），先把那一轮等完，再处理新排队的 id。
   * 不从外部并发发起第二次 persist —— 同一个 key 有两个写者时，即便 storage
   * 的 serialize 能保证不互相覆盖，状态机也会互相打断。
   */
  function run() {
    if (running) {
      return running.then(() => (pendingId != null ? run() : { ok: true, skipped: true }))
    }
    running = doRun().finally(() => {
      running = null
    })
    return running
  }

  /** 排队一次保存；同一时刻只保留最后一次的目标 */
  function schedule(id) {
    if (id == null) return
    pendingId = id
    lastFailedId = null
    epoch += 1
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delay)
    if (state !== 'dirty' || lastStateId !== id) {
      lastStateId = id
      emitState('dirty', { id })
    }
  }

  /** 立即落盘（若有排队的目标）。返回 {ok,id,error?} */
  function flush() {
    return run()
  }

  /** 丢弃排队中的保存（不落盘），并让飞行中的重试就此停手。 */
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingId = null
    lastFailedId = null
    epoch += 1
    if (state !== 'idle') emitState('idle', {})
  }

  /**
   * 重试最后一次失败的保存。
   *
   * 只重跑同一个 persist(id)，不引入第二个写者；也不会把失败的章节内容
   * 改写到别的章节上 —— id 仍是失败时捕获的那一个。
   */
  function retry() {
    if (lastFailedId == null) return Promise.resolve({ ok: true, skipped: true })
    const id = lastFailedId
    pendingId = id
    lastFailedId = null
    epoch += 1
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return run()
  }

  return {
    schedule,
    flush,
    cancel,
    retry,
    getState: () => state,
    getPendingId: () => pendingId,
    getFailedId: () => lastFailedId
  }
}
