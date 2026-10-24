/**
 * 队列执行器：**全局串行**，一次只跑一项。
 *
 * 它是纯逻辑 + 注入：不 import store、不碰 IndexedDB、不认识章节。
 * 真正的队列状态与落库在 `store/writingQueue.js`，本文件只负责
 * 「取下一条 → 冲刷 → 跑 → 报结果 → 决定要不要继续」这一条循环。
 *
 * 为什么必须串行：两章同时生成会各自走一次 `saveChapters` 式的整组回写，
 * 与自动保存、记忆提取抢同一个键；而且界面上只有一个「生成中」状态，
 * 并行会让用户完全看不出钱花在哪一章。
 *
 * 为什么 `setRunning(true)` 要放在 `finally` 之前就设好：局域网同步靠
 * `generationStore.running` 判断「现在能不能整组合并」。队列跑着的时候
 * 若这个标记还是 false，手机一发同步就会把正在写的章节整组覆盖掉。
 */
export function createQueueRunner({
  getNext,
  runItem,
  flush = async () => {},
  setRunning = () => {},
  onItemStart = async () => {},
  onItemEnd = async () => false,
  onError = () => {}
} = {}) {
  let activePromise = null
  let stopping = false

  function isRunning() {
    return !!activePromise
  }

  /**
   * 开始执行。重复调用返回同一个 Promise（不会开出第二条循环）。
   *
   * `onItemEnd` 返回 true 表示「停下来」：失败、被取消、每日预算用尽、
   * 或者用户切了书 —— 这些情况继续跑下一条都会让用户莫名其妙地花钱。
   */
  function start() {
    if (activePromise) return activePromise
    stopping = false
    activePromise = (async () => {
      setRunning(true)
      try {
        for (;;) {
          if (stopping) break
          let item = null
          try {
            item = await getNext()
          } catch (e) {
            onError(e)
            break
          }
          if (!item) break

          // 每项开始前冲刷编辑器：入队可能发生在「正在写」的时刻，
          // 防抖窗口里的正文还没落库。不冲刷的话，生成用的是旧章节，
          // 而用户的最后一笔会在之后被整组回写覆盖（见 CLAUDE.md 坑 #9）。
          try {
            await flush()
          } catch (e) {
            // 冲刷失败不是拒绝执行的理由：正文丢了比生成失败更糟，
            // 但生成仍然可以基于库里的版本进行。
            onError(e)
          }

          let result
          try {
            result = await runItem(item)
          } catch (e) {
            result = { status: 'failed', error: String((e && e.message) || e || '未知错误') }
          }

          let stop = false
          try {
            stop = !!(await onItemEnd(item, result || {}))
          } catch (e) {
            onError(e)
            stop = true
          }
          if (stop) break
        }
      } finally {
        setRunning(false)
        activePromise = null
      }
    })()
    return activePromise
  }

  /** 让当前项跑完，之后不再启动下一项。不中止正在进行的请求。 */
  function stop() {
    stopping = true
  }

  return { start, stop, isRunning }
}
