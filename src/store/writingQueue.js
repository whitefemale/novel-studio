import { reactive } from 'vue'
import { coll, getQueueState, saveQueueState } from '../services/storage'
import { genId } from '../services/ids'
import { useBooks, store as bookStore } from './books'
import { useSettings } from './settings'
import { useGeneration, generationStore } from './generation'
import { useNovelMemory } from './novelMemory'
import { useStoryStructure } from './storyStructure'
import { usePlugins } from './plugins'
import { runChapterWorkflow } from '../services/ai/orchestrator'
import { retrieveRagContext } from '../services/rag/context'
import { spentOnDay } from '../services/ai/budget'
import {
  QUEUE_ACTIVE_STATUSES,
  QUEUE_RETRYABLE_STATUSES,
  capResultText,
  createQueueItem,
  nextRunnable,
  normalizeQueueItem,
  queueBudgetExceeded,
  queueSummary,
  recoverQueueItems,
  sortQueueItems,
  transitionQueueItem
} from '../services/ai/queue'
import { createQueueRunner } from '../services/ai/queueRunner'

/**
 * 持久化写作队列（模块级 reactive 单例）。
 *
 * 三条不可动摇的语义：
 *
 * 1. **只生成草稿，绝不自动改正文**。跑完是 `done`，正文一个字都没动；
 *    用户在面板里点「插入」「另存新章」才写库。自动写正文意味着用户关掉面板后
 *    还可能有一批章节被静默覆盖，而正文是唯一不可再生的内容。
 * 2. **只跑 write 阶段**，不自动提取记忆。提取是基于「正文已经落在某一章上」
 *    的事实推导，而队列结果此刻还没落到任何章节；先提取会产生一批指向未入库
 *    正文的人物状态与时间线。
 * 3. **失败就停**。任何一条失败都会暂停队列并保留已收到的部分文本 ——
 *    继续跑只会让同一个错误（Key 过期、余额不足）重复扣费。
 */
export const queueStore = reactive({
  items: [],
  bookId: null,
  loaded: false,
  paused: false,
  running: false,
  activeId: '',
  lastError: ''
})

// WritingView 提供：把编辑器防抖窗口里的正文先落库、以及插入后重读正文。
let queueUi = { flush: async () => {}, reloadEditor: () => {} }

export function setQueueUiHooks(hooks = {}) {
  queueUi = {
    flush: typeof hooks.flush === 'function' ? hooks.flush : async () => {},
    reloadEditor: typeof hooks.reloadEditor === 'function' ? hooks.reloadEditor : () => {}
  }
}

let sessionBookId = null
let cancelRequestedId = ''
let activeAbort = null
/** 冒烟测试可注入假的 runItem；生产始终走 defaultRunItem。 */
let runItemImpl = null

function findItem(id) {
  return queueStore.items.find((x) => x.id === id) || null
}

async function saveItem(item) {
  if (!item || !item.bookId) return null
  const list = await coll.generationQueue.upsert(item.bookId, item)
  if (queueStore.bookId === item.bookId) {
    queueStore.items = sortQueueItems(list)
  }
  return item
}

async function refreshItems(bookId) {
  const list = await coll.generationQueue.getAll(bookId)
  queueStore.items = sortQueueItems(list.map((x) => normalizeQueueItem(x, Date.now())))
  return queueStore.items
}

/**
 * 把「章节已不存在」的排队项标成 blocked。
 *
 * 只在 `books.store` 确实载着这本书的章节时判断：队列 store 可能先于
 * `openBook` 被调用（例如控制台初始化），此时 chapters 是空的，照此判断会把
 * 每一条都误标成 blocked。
 */
function markMissingChapters(items) {
  if (bookStore.bookId !== queueStore.bookId) return { items, changed: false }
  if (!bookStore.chapters.length) return { items, changed: false }
  const ids = new Set(bookStore.chapters.map((c) => c.id))
  let changed = false
  const next = items.map((it) => {
    if (it.status !== 'queued' || !it.chapterId || ids.has(it.chapterId)) return it
    changed = true
    return {
      ...it,
      status: 'blocked',
      error: '章节已被删除，请重新选择章节',
      updatedAt: Date.now()
    }
  })
  return { items: next, changed }
}

/**
 * 打开书时载入队列。
 *
 * 上次进程死掉时留下的 `running` 条目一律标成 `interrupted` 并**暂停队列**：
 * 用户必须自己按「继续/重试」，因为重跑是一次真实计费，不能由重启替他决定。
 */
async function loadForBook(bookId) {
  queueStore.bookId = bookId || null
  queueStore.lastError = ''
  if (!bookId) {
    queueStore.items = []
    queueStore.loaded = false
    return []
  }
  const raw = await coll.generationQueue.getAll(bookId)
  const activeIds = queueStore.activeId ? [queueStore.activeId] : []
  const recovered = recoverQueueItems(raw, { activeIds, now: Date.now() })
  // 章节可能已经在另一台设备上被删掉、或用户自己删了。留着 `queued` 会让队列
  // 看起来在跑却永远不动（nextRunnable 会跳过它），所以落成 blocked 并由界面显示。
  const { items, changed: missingChanged } = markMissingChapters(recovered.items)
  const changed = recovered.changed || missingChanged
  const state = await getQueueState()
  queueStore.paused = !!state.paused
  if (changed) {
    queueStore.paused = true
    await saveQueueState({ paused: true })
    for (const it of items) {
      const before = raw.find((r) => r.id === it.id)
      if (before && before.status !== it.status) {
        await coll.generationQueue.upsert(bookId, it)
      }
    }
  }
  queueStore.items = sortQueueItems(items)
  queueStore.loaded = true
  return queueStore.items
}

/** 当前书里某一章是否已经排在队列里（含正在生成的那一条）。 */
function activeItemFor(chapterId) {
  return (
    queueStore.items.find(
      (x) => x.chapterId === chapterId && QUEUE_ACTIVE_STATUSES.includes(x.status)
    ) || null
  )
}

async function enqueue({ chapterId, title = '', kind = 'continue', action = 'continue' } = {}) {
  const b = useBooks()
  const bookId = b.store.bookId
  if (!bookId) return { ok: false, error: '请先打开一本书' }
  const chapter = b.store.chapters.find((c) => c.id === chapterId)
  if (!chapter) return { ok: false, error: '章节不存在' }
  const existing = activeItemFor(chapter.id)
  if (existing) return { ok: false, error: '这一章已经在队列里', existing: true }

  if (queueStore.bookId !== bookId || !queueStore.loaded) await loadForBook(bookId)
  const baseOrder = queueStore.items.reduce((m, it) => Math.max(m, Number(it.order) || 0), 0)
  const item = createQueueItem({
    id: genId(),
    bookId,
    chapterId: chapter.id,
    kind,
    action,
    title: title || chapter.title || '',
    order: baseOrder + 1,
    now: Date.now()
  })
  await saveItem(item)
  return { ok: true, item }
}

/** 批量入队。已在队列中的章节自动跳过；写库走一次 update，避免 N 次整组回写。 */
async function enqueueMany(chapters = []) {
  const b = useBooks()
  const bookId = b.store.bookId
  if (!bookId) return { ok: false, added: 0, error: '请先打开一本书' }
  if (queueStore.bookId !== bookId || !queueStore.loaded) await loadForBook(bookId)

  const seen = new Set(
    queueStore.items.filter((x) => QUEUE_ACTIVE_STATUSES.includes(x.status)).map((x) => x.chapterId)
  )
  const picked = []
  for (const c of chapters || []) {
    if (!c || !c.id || seen.has(c.id)) continue
    // 同一批里重复传同一个 id 也只入队一次
    seen.add(c.id)
    picked.push(c)
  }
  if (!picked.length) return { ok: false, added: 0, error: '没有可入队的章节（可能都已在队列里）' }

  const baseOrder = queueStore.items.reduce((m, it) => Math.max(m, Number(it.order) || 0), 0)
  const now = Date.now()
  const additions = picked.map((c, i) =>
    createQueueItem({
      id: genId(),
      bookId,
      chapterId: c.id,
      title: c.title || '',
      order: baseOrder + i + 1,
      now
    })
  )
  const next = await coll.generationQueue.update(bookId, (list) =>
    sortQueueItems([...list, ...additions])
  )
  queueStore.items = sortQueueItems(next)
  return { ok: true, added: additions.length }
}

/**
 * 默认的单项执行：只跑 `['write']`，不写正文、不提取记忆。
 *
 * `onControl` 是**同步**回调，与 AiPanel 同一个理由：等 workflow 返回再拿
 * 中止句柄，生成早就结束了，「取消」按钮等于摆设。
 */
async function defaultRunItem(item) {
  const b = useBooks()
  const s = useSettings()
  const gen = useGeneration()
  const memory = useNovelMemory()
  const structure = useStoryStructure()
  const plugins = usePlugins()
  const bookId = b.store.bookId
  const chapter = b.store.chapters.find((c) => c.id === item.chapterId)

  if (!chapter) return { status: 'failed', error: '章节已被删除' }
  if (!String(s.settings.apiKey || '').trim()) {
    return { status: 'failed', error: '未配置 API Key' }
  }
  if (!memory.store.loaded) await memory.loadForBook(bookId)
  if (!structure.store.loaded) await structure.loadForBook(bookId)

  const input = {
    book: b.store.book,
    bookId,
    chapter,
    chapters: b.store.chapters,
    outlines: b.store.outlines,
    memory: memory.store,
    structure: structure.store,
    styleProfiles: structure.store.styleProfiles || [],
    settings: s.settings,
    action: item.action || 'continue',
    taskId: item.taskId || ''
  }
  // 队列与手动续写走同一条提示词装配路径：检索开着时同样注入历史片段。
  // 失败返回 []，不会让整条队列因为索引问题停摆。
  input.ragPassages = await retrieveRagContext(input, s.settings)
  // 插件片段同样是「调用方先算好」：队列与手动生成必须看到同一份提示词上下文，
  // 否则同一章从队列跑和手动跑会得到两套规则。
  input.pluginFragments = plugins.fragments()

  activeAbort = null
  const wf = await runChapterWorkflow({
    input,
    settings: s.settings,
    // **只有写正文**。提取要等用户把这段文字落到某一章之后单独跑。
    stages: ['write'],
    recordRun: gen.recordRun,
    callbacks: {
      onControl: (h) => {
        activeAbort = h.abort
      }
    }
  })
  activeAbort = null

  const text = capResultText(wf.output)
  const usage = (wf.records || []).reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + (Number(r.inputTokens) || 0),
      outputTokens: acc.outputTokens + (Number(r.outputTokens) || 0),
      cost: acc.cost + (Number(r.cost) || 0)
    }),
    { inputTokens: 0, outputTokens: 0, cost: 0 }
  )
  const result = {
    text,
    runId: wf.run?.id || '',
    usage,
    truncated: !!wf.truncated,
    chapterMeta: wf.chapterMeta || null
  }
  const writeStage = (wf.run?.stages || []).find((x) => x.id === 'write')

  if (cancelRequestedId === item.id) {
    cancelRequestedId = ''
    return { status: 'canceled', result }
  }
  if (wf.truncated || writeStage?.status === 'truncated') {
    // 截断不算完整成功，但**保留已收到的正文**：用户可能就想要这半章。
    return { status: 'failed', error: wf.truncatedMessage || '输出达到上限被截断', result }
  }
  if (writeStage?.status === 'error') {
    return { status: 'failed', error: writeStage.error || wf.error || '生成失败', result: text ? result : null }
  }
  if (wf.run?.status === 'aborted' || writeStage?.status === 'aborted') {
    return { status: 'canceled', result }
  }
  if (!text.trim()) return { status: 'failed', error: '模型没有返回正文' }
  return { status: 'done', result }
}

function setRunning(v) {
  queueStore.running = !!v
  // 局域网同步与 AI 面板都以它为准：队列运行期间整组合并必须被拒绝（409）。
  generationStore.running = !!v
}

const runner = createQueueRunner({
  getNext: async () => {
    if (!sessionBookId || queueStore.paused) return null
    // 生成中切了书：当前项跑完就停，不再启动旧书里的下一条。
    if (bookStore.bookId !== sessionBookId) return null
    const next = nextRunnable(queueStore.items, {
      paused: false,
      bookId: sessionBookId,
      chapterExists: (id) => bookStore.chapters.some((c) => c.id === id)
    })
    return next || null
  },
  runItem: (item) => (runItemImpl || defaultRunItem)(item),
  flush: () => queueUi.flush(),
  setRunning,
  onItemStart: async (item) => {
    const cur = findItem(item.id)
    if (!cur) return
    queueStore.activeId = item.id
    const next = transitionQueueItem(cur, 'running', {
      attempts: (Number(cur.attempts) || 0) + 1,
      error: '',
      updatedAt: Date.now()
    })
    if (next) await saveItem(next)
  },
  onItemEnd: async (item, res) => {
    const cur = findItem(item.id)
    queueStore.activeId = ''
    if (!cur) return false

    const status =
      res.status === 'done' ? 'done' : res.status === 'canceled' ? 'canceled' : 'failed'
    const patch = {
      error: res.error || '',
      result: res.result || cur.result || null,
      updatedAt: Date.now()
    }
    // 当前条目一定是 running（onItemStart 刚写过）。若因为并发没了，这里仍要
    // 落一个明确的失败状态，绝不能让它停在「生成中」。
    const next =
      transitionQueueItem({ ...cur, status: 'running' }, status, patch) || {
        ...cur,
        status: 'failed',
        error: res.error || '状态迁移失败',
        updatedAt: Date.now()
      }
    await saveItem(next)

    if (status === 'canceled') return true
    if (status === 'failed') {
      queueStore.paused = true
      queueStore.lastError = res.error || '生成失败，队列已暂停'
      await saveQueueState({ paused: true })
      return true
    }

    // 成功之后核对当日花费。钱是生成之后才知道的，所以这是**事后**刹车：
    // 超过上限就暂停，别让下一条继续花。
    const check = queueBudgetExceeded(spentOnDay(generationStore.runs, Date.now()), useSettings().settings)
    if (check.over) {
      queueStore.paused = true
      queueStore.lastError = `本书今日已花费约 ${check.spent.toFixed(2)} 元，超过每日上限，队列已暂停`
      await saveQueueState({ paused: true })
      return true
    }
    return false
  },
  onError: (e) => {
    queueStore.lastError = String((e && e.message) || e || '队列执行出错')
  }
})

/**
 * 开始（或继续）队列。
 *
 * `options.runItem` 只给测试用：冒烟测试要验证「串行、失败即停、不自动写正文」，
 * 不能真的打网络。
 */
async function start(options = {}) {
  const b = useBooks()
  const bookId = b.store.bookId
  if (!bookId) return { ok: false, error: '请先打开一本书' }
  if (queueStore.running) return { ok: true, already: true }
  if (generationStore.running) {
    queueStore.lastError = '正在生成中，请先停止当前生成再开始队列'
    return { ok: false, error: queueStore.lastError }
  }
  if (queueStore.bookId !== bookId || !queueStore.loaded) await loadForBook(bookId)
  if (!queueStore.items.some((x) => x.status === 'queued')) {
    queueStore.lastError = '队列里没有待生成的章节'
    return { ok: false, error: queueStore.lastError }
  }

  runItemImpl = typeof options.runItem === 'function' ? options.runItem : null
  sessionBookId = bookId
  cancelRequestedId = ''
  queueStore.lastError = ''
  queueStore.paused = false
  await saveQueueState({ paused: false })
  // 不 await：面板要立刻回到可交互状态，进度通过 reactive 状态反映。
  runner.start()
  return { ok: true }
}

/** 暂停：当前项**跑完**，之后不再启动下一项。不会中止已经在飞的请求。 */
async function pause() {
  queueStore.paused = true
  runner.stop()
  await saveQueueState({ paused: true })
}

async function resume() {
  return start()
}

/**
 * 取消一条。
 *
 * - 排队/中断/失败：直接标成 canceled；
 * - 生成中：调用中止句柄，请求结束后由 onItemEnd 记成 canceled。
 */
async function cancel(id) {
  const cur = findItem(id)
  if (!cur) return { ok: false, error: '条目不存在' }
  if (cur.status === 'running') {
    cancelRequestedId = id
    activeAbort?.()
    return { ok: true, aborting: true }
  }
  if (cur.status === 'canceled') return { ok: true }
  if (!QUEUE_RETRYABLE_STATUSES.includes(cur.status) && cur.status !== 'queued') {
    return { ok: false, error: '这个状态不能取消' }
  }
  const next = transitionQueueItem(cur, 'canceled', { updatedAt: Date.now() })
  if (!next) return { ok: false, error: '这个状态不能取消' }
  await saveItem(next)
  return { ok: true }
}

/** 重试：失败/中断/取消 → 重新排队。上一轮的部分正文不再保留（会重新生成）。 */
async function retry(id) {
  const cur = findItem(id)
  if (!cur) return { ok: false, error: '条目不存在' }
  if (!QUEUE_RETRYABLE_STATUSES.includes(cur.status)) {
    return { ok: false, error: '只有失败/中断/取消的条目可以重试' }
  }
  const next = transitionQueueItem(cur, 'queued', {
    error: '',
    result: null,
    updatedAt: Date.now()
  })
  if (!next) return { ok: false, error: '无法重新排队' }
  await saveItem(next)
  queueStore.paused = false
  await saveQueueState({ paused: false })
  return { ok: true }
}

function markApplied(item, mode, extra = {}) {
  const result = item.result
    ? {
        ...item.result,
        // 应用之后正文已经进了章节/新章，队列里再留一份 20 万字的副本没有意义。
        text: '',
        appliedAt: Date.now(),
        appliedMode: mode
      }
    : null
  return { ...item, ...extra, result, updatedAt: Date.now() }
}

/**
 * 应用一条已经生成好的草稿。
 *
 * mode:
 *   'insert'    追加到条目对应的章节末尾（先存版本，可回滚）
 *   'new'       另存为新章节
 *   'discard'   丢弃（只清掉草稿文本，保留一条记录）
 *
 * 只有用户显式点按钮才会走到这里 —— 队列自己永远不会改正文。
 */
async function applyResult(id, { mode = 'insert' } = {}) {
  const item = findItem(id)
  if (!item) return { ok: false, error: '条目不存在' }
  if (!item.result || !String(item.result.text || '').trim()) {
    return { ok: false, error: '这一条没有可用的正文' }
  }
  if (item.result.appliedAt) return { ok: false, error: '已经处理过了' }

  if (mode === 'discard') {
    await saveItem(markApplied(item, 'discard'))
    return { ok: true, discarded: true }
  }

  const b = useBooks()
  const s = useSettings()
  const text = item.result.text
  const meta = item.result.chapterMeta || {}
  await queueUi.flush()

  let chapterId = item.chapterId
  if (mode === 'new') {
    const created = await b.addChapterWithContent(text, item.title || 'AI 续写', meta)
    chapterId = created?.id || ''
  } else {
    const chapter = b.store.chapters.find((c) => c.id === item.chapterId)
    if (!chapter) return { ok: false, error: '章节已被删除，请改用「另存新章」' }
    // 先存当前正文再写回：这一步让「插入」可撤销，与 AI 面板插入正文同一条路径。
    await b.captureChapterVersion(chapter.id, {
      source: 'ai',
      generationRunId: item.result.runId || null
    })
    const base = String(chapter.content || '')
    const merged = base.trim() ? `${base.replace(/\s+$/, '')}\n\n${text}` : text
    b.setChapterContent(chapter.id, merged)
    await b.persistChapter(chapter.id)
    if (meta.summary || meta.timelineEnd) await b.updateChapter(chapter.id, meta)
    chapterId = chapter.id
  }

  await saveItem(markApplied(item, mode, { chapterId }))
  if (chapterId && bookStore.chapterId === chapterId) queueUi.reloadEditor()

  // 可选：应用之后单独跑一次提取。这是**真实计费**的调用，所以只在应用时发生，
  // 且没有 Key 时直接跳过（否则队列会为了一个必然失败的请求写一条错误记录）。
  let extracted = false
  if (chapterId && String(s.settings.apiKey || '').trim() && s.settings.autoExtractMemory !== false) {
    extracted = await extractAfterApply(chapterId)
  }
  return { ok: true, chapterId, extracted }
}

/**
 * 正文落到章节之后，单独跑一次记忆提取。
 *
 * 与编排器的差别只有一处：这里的 `chapter` 已经是**写入了正文之后的**章节，
 * 所以 `action: 'continue'` 会让 stageExtract 把整章正文交给模型（而不是只有
 * 内存里的 output）。提取失败不算应用失败 —— 正文已经安全落库了。
 */
async function extractAfterApply(chapterId) {
  const b = useBooks()
  const s = useSettings()
  const gen = useGeneration()
  const memory = useNovelMemory()
  const structure = useStoryStructure()
  const bookId = b.store.bookId
  const chapter = b.store.chapters.find((c) => c.id === chapterId)
  if (!bookId || !chapter) return false
  try {
    if (!memory.store.loaded) await memory.loadForBook(bookId)
    if (!structure.store.loaded) await structure.loadForBook(bookId)
    const wf = await runChapterWorkflow({
      input: {
        book: b.store.book,
        bookId,
        chapter,
        chapters: b.store.chapters,
        outlines: b.store.outlines,
        memory: memory.store,
        structure: structure.store,
        styleProfiles: structure.store.styleProfiles || [],
        settings: s.settings,
        action: 'continue'
      },
      settings: s.settings,
      stages: ['extract'],
      recordRun: gen.recordRun
    })
    if (wf.chapterMeta) await b.updateChapter(chapterId, wf.chapterMeta)
    if (wf.applied?.length || wf.queued?.length) await memory.loadForBook(bookId)
    return !wf.error
  } catch (e) {
    console.error('[queue] 应用后的记忆提取失败', e)
    return false
  }
}

/** 删除一条记录（只允许非运行中的）。走 update 而不是 remove：队列是本地态，
 * 不该因为一次清理就往同步墓碑表里写东西。 */
async function removeItem(id) {
  const cur = findItem(id)
  if (!cur || cur.status === 'running') return { ok: false, error: '生成中的条目不能删除' }
  const bookId = queueStore.bookId
  if (!bookId) return { ok: false, error: '请先打开一本书' }
  const next = await coll.generationQueue.update(bookId, (list) => list.filter((x) => x.id !== id))
  queueStore.items = sortQueueItems(next)
  return { ok: true }
}

/** 清除所有已结束且没有待处理内容的条目。 */
async function clearFinished() {
  const bookId = queueStore.bookId
  if (!bookId) return { ok: false, error: '请先打开一本书' }
  const next = await coll.generationQueue.update(bookId, (list) =>
    list.filter((x) => x.status !== 'done' && x.status !== 'canceled')
  )
  queueStore.items = sortQueueItems(next)
  return { ok: true }
}

function summary() {
  return queueSummary(queueStore.items)
}

export function useWritingQueue() {
  return {
    store: queueStore,
    loadForBook,
    enqueue,
    enqueueMany,
    start,
    pause,
    resume,
    cancel,
    retry,
    applyResult,
    removeItem,
    clearFinished,
    summary
  }
}

// 供冒烟测试直接引用的纯入口（避免组件未挂载时拿不到模块状态）。
export { runner }
