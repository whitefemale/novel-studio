import { genId } from '../ids.js'

/**
 * 持久化写作队列的**纯逻辑**（状态、迁移、恢复、摘要）。
 *
 * 为什么不把状态放在组件里：队列要能跨重启存活、要能暂停、失败要停在原地，
 * 而组件随时会被卸载（切书、返回书库、窄屏切标签）。条目本身落 IndexedDB
 * （`generationQueue:{bookId}`），暂停标记落根键 `generationQueueState`——
 * 两者都是**设备本地态**，不进快照：同一批章节在另一台设备上再生成一遍毫无意义。
 *
 * 这个文件不碰 IndexedDB、不碰 store，夹具可以直接喂内存对象。
 */

/**
 * 条目状态。
 *
 * 刻意**没有 per-item 的 `paused`**：暂停是整台设备上的一个开关（根键），
 * 若每个条目也存一份，暂停时要逐个改、继续时要逐个查，两边一旦不同步就会出现
 * 「队列明明暂停了，某个条目却还在跑」。暂停的真相只有 `queueStore.paused` 一个。
 */
export const QUEUE_STATUSES = [
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '生成中' },
  { value: 'interrupted', label: '已中断' },
  { value: 'blocked', label: '已阻塞' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' }
]

export const QUEUE_STATUS_LABELS = Object.fromEntries(
  QUEUE_STATUSES.map((s) => [s.value, s.label])
)

/** 会继续占用这一章的状态：同一章不允许重复入队。 */
export const QUEUE_ACTIVE_STATUSES = ['queued', 'running']

/** 用户可以直接重试的状态。 */
export const QUEUE_RETRYABLE_STATUSES = ['interrupted', 'failed', 'canceled', 'blocked']

/** 生成结果最多保存多少字符。超过部分丢弃，界面会提示。 */
export const MAX_RESULT_CHARS = 200000

/**
 * 允许的状态迁移。显式列出来而不是「随便设」，因为一次错误的迁移就会让条目
 * 永远卡在 `running`（用户看到进度条一直转，重启后才变成 interrupted）。
 */
const TRANSITIONS = {
  queued: ['running', 'canceled', 'blocked'],
  running: ['done', 'failed', 'canceled', 'interrupted'],
  interrupted: ['queued', 'canceled'],
  failed: ['queued', 'canceled'],
  blocked: ['queued', 'canceled'],
  canceled: ['queued'],
  done: []
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to)
}

export function isTerminalStatus(status) {
  return status === 'done' || status === 'failed' || status === 'canceled'
}

/** 结果文本截断。按 Array.from 计数，避免把代理对切成半个字符。 */
export function capResultText(text, limit = MAX_RESULT_CHARS) {
  const s = String(text ?? '')
  if (s.length <= limit) return s
  const chars = Array.from(s)
  if (chars.length <= limit) return s
  return chars.slice(0, limit).join('')
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null
  // 字数按**实际留下的文本**算：按原文本算会让界面显示「20 万字」而库里只有
  // 上限那么多，用户拿这个数字去对账单时会对不上。
  const text = capResultText(result.text)
  return {
    text,
    runId: String(result.runId || ''),
    usage: result.usage || null,
    truncated: !!result.truncated,
    chapterMeta: result.chapterMeta || null,
    chars: Array.from(text).length,
    appliedAt: Number(result.appliedAt) || 0,
    appliedMode: String(result.appliedMode || '')
  }
}

/**
 * 建一条排队中的条目。
 *
 * `id` 与 `now` 可注入，测试才能得到确定的结果；生产调用交给 genId / Date.now。
 */
export function createQueueItem({
  id = '',
  bookId = '',
  chapterId = '',
  kind = 'continue',
  action = 'continue',
  title = '',
  order = 0,
  now = 0
} = {}) {
  const at = Number(now) || 0
  return {
    id: id || genId(),
    bookId: String(bookId || ''),
    chapterId: String(chapterId || ''),
    kind: kind === 'newChapter' ? 'newChapter' : 'continue',
    action: String(action || 'continue'),
    title: String(title || ''),
    status: 'queued',
    order: Number(order) || 0,
    attempts: 0,
    taskId: '',
    result: null,
    error: '',
    createdAt: at,
    updatedAt: at
  }
}

/** 读取旧记录 / 快照时的兜底。未知状态一律降级成 failed，不让它卡在 running。 */
export function normalizeQueueItem(raw, now = 0) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const known = QUEUE_STATUSES.some((s) => s.value === src.status)
  const at = Number(now) || 0
  return {
    id: String(src.id || ''),
    bookId: String(src.bookId || ''),
    chapterId: String(src.chapterId || ''),
    kind: src.kind === 'newChapter' ? 'newChapter' : 'continue',
    action: String(src.action || 'continue'),
    title: String(src.title || ''),
    status: known ? src.status : 'failed',
    order: Number(src.order) || 0,
    attempts: Number(src.attempts) || 0,
    taskId: String(src.taskId || ''),
    result: normalizeResult(src.result),
    error: String(src.error || ''),
    createdAt: Number(src.createdAt) || at,
    updatedAt: Number(src.updatedAt) || at
  }
}

/** 稳定排序：先按 order，再按创建时间，最后按 id。同输入同输出。 */
export function sortQueueItems(items = []) {
  return [...items].sort(
    (a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0) ||
      (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) ||
      String(a.id).localeCompare(String(b.id))
  )
}

/**
 * 迁移一条记录。返回**新对象**；非法迁移返回 null（调用方必须处理，不能装作成功）。
 */
export function transitionQueueItem(item, status, patch = {}) {
  if (!item || !canTransition(item.status, status)) return null
  const next = { ...item, ...patch, status }
  if (patch.result !== undefined) next.result = normalizeResult(patch.result)
  next.updatedAt = Number(patch.updatedAt) || Date.now()
  return next
}

/**
 * 下一条可跑的任务。
 *
 * `chapterExists` 由调用方注入：章节可能已经被删掉，而条目还躺在队列里。
 * 让这个函数去做「章节还在不在」的判断，会让它被迫 import store。
 */
export function nextRunnable(
  items = [],
  { paused = false, bookId = null, chapterExists = null, includeMissing = false } = {}
) {
  if (paused) return null
  const list = sortQueueItems(items).filter((it) => it.status === 'queued')
  for (const it of list) {
    if (bookId && it.bookId !== bookId) continue
    if (!includeMissing && !it.chapterId) continue
    if (!includeMissing && chapterExists && !chapterExists(it.chapterId)) continue
    return it
  }
  return null
}

/**
 * 重启恢复：上次进程死掉时还在 `running` 的条目一律标成 `interrupted`。
 *
 * **不自动重跑**。重跑会产生一次新的真实计费调用，而用户根本不知道上次是
 * 生成到一半崩了还是服务端已经收钱；只有他点「重试」才算授权。
 */
export function recoverQueueItems(items = [], { activeIds = [], now = 0 } = {}) {
  const at = Number(now) || 0
  let changed = false
  const active = new Set(activeIds || [])
  const next = (items || []).map((raw) => {
    const item = normalizeQueueItem(raw, at)
    if (item.status !== 'running' || active.has(item.id)) return item
    changed = true
    return {
      ...item,
      status: 'interrupted',
      error: '上次运行被中断（未自动重跑）',
      updatedAt: at
    }
  })
  return { items: next, changed }
}

/** 各状态计数。界面上的徽标与摘要共用它，避免两处各数一遍。 */
export function queueSummary(items = []) {
  const out = { total: 0, queued: 0, running: 0, interrupted: 0, blocked: 0, done: 0, failed: 0, canceled: 0, pending: 0 }
  for (const it of items || []) {
    const s = it && it.status
    out.total++
    if (s in out) out[s]++
  }
  out.pending = out.queued + out.running
  return out
}

/** 一条条目的界面标题：优先作者写的标题，其次章节标题，最后用状态兜底。 */
export function queueItemTitle(item, chapter = null) {
  return String(item?.title || chapter?.title || item?.chapterId || '未命名')
}

/** 结果是否还能被应用（失败/中断时保留的已完成文本也算）。 */
export function hasUsableResult(item) {
  if (!item?.result) return false
  if (item.result.appliedAt) return false
  return String(item.result.text || '').trim().length > 0
}

/**
 * 每日预算检查。返回 `{ over, spent }`。
 *
 * 与 AiPanel 的预检分工不同：这里是**事后**核对（每次调用后金额才有真实值），
 * 只在 `budgetDaily > 0` 时生效。未定价调用让合计不完整，此时**不**据此暂停队列：
 * 拿一个不完整的数字去拦人，比不拦更糟。
 */
export function queueBudgetExceeded(spentToday, settings) {
  const limit = Number(settings?.budgetDaily) || 0
  const total = Number(spentToday?.total) || 0
  if (!limit) return { over: false, spent: total }
  if (spentToday?.complete === false) return { over: false, spent: total }
  return { over: total > limit, spent: total }
}
