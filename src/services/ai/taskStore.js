// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import { coll } from '../storage.js'
import { genId } from '../ids.js'

/**
 * 生成任务与流式草稿。
 *
 * 这一层的存在理由只有一个：**流式生成的正文在完成前只存在于内存里**。
 * 一次几万字的长章生成要跑好几分钟，期间关窗、崩溃、Android 被系统杀后台，
 * 已经收到的内容就全部消失，而服务端那一次调用照样计费。把增量草稿每隔
 * 1.5 秒或 800 字落一次库，最坏情况只损失最后不到两秒的输出。
 *
 * 三条设计约束：
 *
 * 1. **设备本地，不进快照/同步。** 它描述「这台机器上一次没跑完的调用」，
 *    同步到另一台设备毫无意义，草稿内容也是易失的。storage.js 的 COLLECTIONS
 *    收录它（于是 serialize / toPlain / 守卫 / 级联删除全由工厂保证），
 *    snapshot.js 的 DATA_COLLECTIONS 再把它排除。
 * 2. **running 永不裁剪。** 裁剪只针对已结束的任务，否则正在跑的那条草稿
 *    可能被自己触发的清理删掉。
 * 3. **纯函数与 I/O 分开。** 状态转换、可恢复判定、裁剪、节流决策都是纯函数，
 *    放在本文件上半部分，可直接用 node:test 覆盖；下半部分才碰 IndexedDB。
 */

export const TASK_STATUSES = ['running', 'done', 'aborted', 'error', 'truncated', 'interrupted']

/** 可恢复的状态：中断（崩溃/被杀）与出错。用户主动中止的不再打扰。 */
export const RECOVERABLE_STATUSES = ['interrupted', 'error']

/** 草稿落库的节流口径：任一条件满足就写。 */
export const DRAFT_INTERVAL_MS = 1500
export const DRAFT_CHARS = 800

/** 单条草稿的最大保留字符数。超长章节也只保留末尾这段用于恢复。 */
export const MAX_DRAFT_CHARS = 200000

export const TASK_STATUS_LABELS = {
  running: '生成中',
  done: '已完成',
  aborted: '已停止',
  error: '已出错',
  truncated: '被截断',
  interrupted: '已中断'
}

// ---------------- 纯函数 ----------------

/** 创建一条任务记录（不落库）。 */
export function createTaskRecord(
  { bookId = '', chapterId = '', action = '', stages = [], model = '', promptVersion = '' } = {},
  { id = genId(), now = Date.now() } = {}
) {
  return {
    id,
    bookId,
    chapterId,
    action,
    stages: Array.isArray(stages) ? [...stages] : [],
    model,
    promptVersion,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    outputText: '',
    lastError: '',
    abortedByUser: false,
    finishReason: ''
  }
}

/** 追加草稿并截到上限。返回新对象，不改入参。 */
export function appendDraft(task, text, { now = Date.now(), max = MAX_DRAFT_CHARS } = {}) {
  const next = String(text || '')
  if (!next) return task
  let outputText = String(task?.outputText || '') + next
  if (outputText.length > max) outputText = outputText.slice(-max)
  return { ...task, outputText, updatedAt: now }
}

/** 更新任务状态。status 非法时抛错——静默忽略会让任务永远停在 running。 */
export function settleTaskRecord(
  task,
  {
    status,
    outputText,
    error = '',
    finishReason = '',
    abortedByUser = false,
    now = Date.now()
  } = {}
) {
  if (!TASK_STATUSES.includes(status)) throw new Error(`未知的任务状态：${status}`)
  return {
    ...task,
    status,
    outputText: outputText == null ? String(task?.outputText || '') : String(outputText),
    lastError: error ? String(error) : '',
    finishReason: finishReason || '',
    abortedByUser: abortedByUser === true,
    updatedAt: now
  }
}

/**
 * 是否该把草稿落库。
 *
 * `lastFlushAt` / `lastFlushLength` 是**上一次真正写库时**的值，不是上一次调用的值；
 * 用后者会让每来一个字就重置窗口，节流永远不触发。
 */
export function shouldFlushDraft({
  text = '',
  lastFlushAt = 0,
  lastFlushLength = 0,
  now = Date.now(),
  intervalMs = DRAFT_INTERVAL_MS,
  chars = DRAFT_CHARS
} = {}) {
  const len = String(text || '').length
  if (len <= 0) return false
  if (len - Number(lastFlushLength || 0) >= chars) return true
  return now - Number(lastFlushAt || 0) >= intervalMs
}

/**
 * 把本次启动时仍标记为 running 的任务改成 interrupted。
 *
 * `activeTaskId` 是当前界面正在跑的那条——它当然也是 running，
 * 但它没断，不能标。返回新数组与变化条数（变化为 0 时调用方可以跳过写库）。
 */
export function markRunningInterrupted(tasks = [], { activeTaskId = null, now = Date.now() } = {}) {
  let changed = 0
  const next = (tasks || []).map((t) => {
    if (!t || t.status !== 'running' || t.id === activeTaskId) return t
    changed++
    return {
      ...t,
      status: 'interrupted',
      lastError: t.lastError || '生成在完成前中断（应用关闭、崩溃或系统回收）',
      updatedAt: now
    }
  })
  return { tasks: next, changed }
}

/** 可恢复判定：状态可恢复且有实际内容。 */
export function isRecoverable(task) {
  return !!task && RECOVERABLE_STATUSES.includes(task.status) && String(task.outputText || '').trim().length > 0
}

/**
 * 选出最新一条可恢复任务。
 * 排序依据是 updatedAt（中断标记刚刷过，反映的是中断时刻），同值时用 startedAt。
 */
export function pickRecoverable(tasks = []) {
  const list = (tasks || []).filter(isRecoverable)
  if (!list.length) return null
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.startedAt || 0) - (a.startedAt || 0))
  return list[0]
}

/**
 * 裁剪：running 永不删除，其余按 updatedAt 从新到旧保留 keep 条。
 * 返回新数组；调用方负责 saveAll 整组回写。
 */
export function pruneTasks(tasks = [], keep = 20) {
  const limit = Math.max(1, Number(keep) || 20)
  const alive = (tasks || []).filter((t) => t && t.status === 'running')
  const settled = (tasks || [])
    .filter((t) => t && t.status !== 'running')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
  return [...settled, ...alive]
}

export function taskSummary(task) {
  if (!task) return ''
  const chars = String(task.outputText || '').length
  const label = TASK_STATUS_LABELS[task.status] || task.status
  return `${label} · 已保留 ${chars} 字`
}

// ---------------- I/O ----------------

/** 读一本书的全部任务（按开始时间从新到旧）。 */
export async function loadTasks(bookId) {
  if (!bookId) return []
  const list = await coll.generationTasks.getAll(bookId)
  return [...list].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
}

/** 新建并落库。 */
export async function startTask(bookId, meta = {}) {
  if (!bookId) return null
  const task = createTaskRecord({ ...meta, bookId })
  await coll.generationTasks.upsert(bookId, task)
  return task
}

async function writeTask(bookId, task) {
  if (!bookId || !task) return task
  await coll.generationTasks.upsert(bookId, task)
  return task
}

/** 写草稿（节流由调用方用 shouldFlushDraft 判断）。 */
export function saveDraft(bookId, task) {
  return writeTask(bookId, task)
}

/** 结束任务。 */
export function finishTask(bookId, task, patch = {}) {
  return writeTask(bookId, settleTaskRecord(task, patch))
}

/** 丢弃一条任务（恢复条上的「丢弃」）。 */
export async function discardTask(bookId, taskId) {
  if (!bookId || !taskId) return []
  return coll.generationTasks.remove(bookId, taskId)
}

/**
 * 打开书时调用：把上次遗留的 running 标成 interrupted，裁剪旧任务。
 * 返回 { tasks, recoverable, changed }。
 */
export async function settleOnOpen(bookId, { activeTaskId = null, keep = 20 } = {}) {
  if (!bookId) return { tasks: [], recoverable: null, changed: false }
  const tasks = await loadTasks(bookId)
  const marked = markRunningInterrupted(tasks, { activeTaskId })
  let next = marked.tasks
  const pruned = pruneTasks(next, keep)
  const changed = marked.changed > 0 || pruned.length !== next.length
  if (changed) {
    await coll.generationTasks.saveAll(bookId, pruned)
    next = pruned
  }
  return { tasks: next, recoverable: pickRecoverable(next), changed }
}
