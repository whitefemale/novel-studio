// 自动保存调度器：把「防抖 + 冲刷」从编辑器组件里抽出，
// 一是让切换章节/离开页面时的落盘顺序有一处明确的实现，
// 二是让它成为可被冒烟测试直接驱动的纯逻辑。
//
// 关键不变量：待保存的目标 id 在 schedule() 时捕获，而不是在定时器触发时再去读
// 「当前章节」。旧实现（Editor.vue 的 saveNow 里 `const c = currentChapter.value`）
// 在触发时刻解析目标，用户在 1.5 秒防抖窗口内切换章节时，
// 最后一笔改动会被写到新章节上，原标题的内容直接丢失。

/**
 * @param {object} opts
 * @param {(id:any)=>Promise<void>} opts.persist  真正落盘的动作
 * @param {number} [opts.delay]                   防抖毫秒数
 * @param {(id:any)=>void} [opts.onSaved]         落盘完成回调
 */
export function createAutosaver({ persist, delay = 1500, onSaved } = {}) {
  let timer = null
  let pendingId = null

  async function run() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const id = pendingId
    // 必须在第一个 await 之前摘除：否则飞行中的落盘会顺手吃掉新排队的 id
    pendingId = null
    if (id == null) return
    await persist(id)
    onSaved?.(id)
  }

  /** 排队一次保存；同一时刻只保留最后一次的目标 */
  function schedule(id) {
    if (id == null) return
    pendingId = id
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delay)
  }

  /** 立即落盘（若有排队的目标）；返回 Promise 以便调用方 await 顺序 */
  function flush() {
    return run()
  }

  /** 丢弃排队中的保存（不落盘） */
  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingId = null
  }

  return { schedule, flush, cancel }
}
