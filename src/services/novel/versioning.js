import * as db from '../storage'
import { genId } from '../ids'
import { countWords } from '../wordCount'

/**
 * 章节版本：正文的历史副本，用于回滚与「误删救回」。
 *
 * 存在的理由很具体：AI 生成会把整章正文覆盖掉，而覆盖是**不可逆**的——用户点
 * 「插入到正文」之后，如果发现这一版还不如原来那版，旧正文已经没有任何存档了。
 * 版本记录就是那个存档。
 *
 * 三条设计约束，都不是随意的：
 *
 * 1. **不在 persistChapter 上挂钩子**。它是自动保存的落点（1.5 秒防抖一次），
 *    在那里存版本等于每写一段存一版，库里会堆满几乎没有差异的记录。四个触发点
 *    显式调用，语义清楚，数量可控。
 * 2. **版本记录是不可变的**。没有 updatedAt，合并不必比较「哪个更新」——它只
 *    回答「当时是什么」。snapshot 的 mergeRecords 时间戳回退到 createdAt
 *    （snapshot.js 的 tstamp），刚好覆盖这种形状。
 * 3. **裁剪不写墓碑**。裁剪是本地整理，不是用户删除。写墓碑会让它传播到另一台
 *    设备、把对方**故意**保留的更多版本也删掉，而且墓碑表会无限膨胀。代价是
 *    另一台设备下次同步可能把多出来的版本送回来 —— 无害，版本不可变，多留几版
 *    不是数据丢失。
 *
 * 规格书 03 给的记录形状没有 bookId，但规格书 05 要求「新增实体必须有 bookId」。
 * 采纳 05：没有 bookId 就用不了 coll 工厂的 per-book 键，也进不了快照。
 * chapterTitle 同理是补的——章节会被删掉，而删掉之后版本面板还得能说清这是哪一章。
 */

/** 每个章节默认保留的版本数。可由设置里的 versionKeep 覆盖。 */
export const DEFAULT_VERSION_KEEP = 10

/** 来源。文案直接给界面用，避免每个组件各写一份中文。 */
export const VERSION_SOURCES = {
  ai: 'AI 覆盖前',
  manual: '手动存档',
  rollback: '回滚前',
  delete: '删除前'
}

export function sourceLabel(source) {
  return VERSION_SOURCES[source] || source || '未知'
}

/** 纯组装。I/O 在 captureVersion，这里只为可确定性单测。 */
export function buildVersion({
  bookId,
  chapterId,
  chapterTitle = '',
  content = '',
  source = 'manual',
  generationRunId = null,
  createdAt = Date.now()
}) {
  const text = String(content ?? '')
  return {
    id: genId(),
    bookId,
    chapterId,
    chapterTitle,
    content: text,
    wordCount: countWords(text).total,
    source,
    generationRunId: generationRunId || null,
    createdAt
  }
}

/**
 * 按章裁剪：每章最多留下最新的 keep 条。**纯函数**，返回新数组。
 *
 * 时间戳相同时按 id 兜底排序，让结果是确定的 —— 不确定的话，同一份数据两次裁剪
 * 可能留下不同的那几条，而裁剪结果会随下一次同步传到另一台设备上，表现为
 * 「我没删过的那一版不见了」。
 *
 * 返回**保持入参顺序**：裁剪结果要参与快照比较，顺序变化会让 diffSnapshots
 * 把没变过的记录也报成「有更新」。
 */
export function pruneVersions(list = [], keep = DEFAULT_VERSION_KEEP) {
  const n = Math.max(1, Number(keep) || DEFAULT_VERSION_KEEP)
  const byChapter = new Map()
  for (const v of list) {
    if (!v || !v.id) continue
    const k = v.chapterId || ''
    if (!byChapter.has(k)) byChapter.set(k, [])
    byChapter.get(k).push(v)
  }
  const keepIds = new Set()
  for (const arr of byChapter.values()) {
    if (arr.length <= n) {
      for (const v of arr) keepIds.add(v.id)
      continue
    }
    const newest = [...arr].sort(
      (a, b) =>
        (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) ||
        String(b.id).localeCompare(String(a.id))
    )
    for (const v of newest.slice(0, n)) keepIds.add(v.id)
  }
  return list.filter((v) => v && keepIds.has(v.id))
}

/**
 * 存一版当前正文。
 *
 * 空正文直接不存：存一版空的没有回滚价值，而「AI 覆盖一个空章节」恰恰是最常见的
 * 情形（新章刚建、正文还是空的），不拦住的话版本列表会被空的「删除前」塞满。
 *
 * 返回落库的记录，或 null（没有正文 / 缺 id）。
 */
export async function captureVersion({
  bookId,
  chapterId,
  chapterTitle = '',
  content = '',
  source = 'manual',
  generationRunId = null,
  keep = DEFAULT_VERSION_KEEP,
  createdAt
}) {
  if (!bookId || !chapterId) return null
  if (!String(content ?? '').trim()) return null
  const rec = buildVersion({
    bookId,
    chapterId,
    chapterTitle,
    content,
    source,
    generationRunId,
    createdAt
  })
  // update 把「追加 + 裁剪」放进同一次 serialize，两次并发捕获不会互相裁掉对方。
  await db.coll.chapterVersions.update(bookId, (list) => pruneVersions([...list, rec], keep))
  return rec
}

/**
 * 最新的在前。**纯函数**，UI 与 listVersions 共用同一份排序。
 *
 * 合并成一份是刻意的：排序规则写在两处，用户早晚会看到「控制台里是这个顺序、
 * 编辑器里是另一个顺序」——而两个列表看的是同一批数据。
 */
export function sortVersions(list = []) {
  return [...list].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
}

/** 读这本书的全部版本，最新的在前。 */
export async function listVersions(bookId) {
  return sortVersions(await db.coll.chapterVersions.getAll(bookId))
}

/**
 * 按章分组。**纯函数**。
 *
 * 分组里带 `alive`：章节可能已经被删了，而「删除前」那一版正是误删救回的唯一入口，
 * 所以这些孤儿版本不能丢，界面上单独一组。
 *
 * 排序：活着的章节按它们在书里的顺序（章号），孤儿章节排在后面按最近一版的时间。
 */
export function groupVersions(list = [], { chapters = [] } = {}) {
  const order = new Map()
  const titles = new Map()
  chapters.forEach((c, i) => {
    order.set(c.id, typeof c.order === 'number' ? c.order : i + 1)
    titles.set(c.id, c.title || '')
  })

  const groups = new Map()
  for (const v of list) {
    if (!v || !v.chapterId) continue
    if (!groups.has(v.chapterId)) groups.set(v.chapterId, [])
    groups.get(v.chapterId).push(v)
  }

  const out = []
  for (const [chapterId, versions] of groups) {
    const alive = order.has(chapterId)
    out.push({
      chapterId,
      // 章节被删之后就只剩版本自己记着的那个标题了
      chapterTitle: titles.get(chapterId) || versions[0].chapterTitle || '已删除的章节',
      order: alive ? order.get(chapterId) : null,
      alive,
      versions: [...versions].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    })
  }

  out.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1
    if (a.alive && b.alive) return a.order - b.order
    const at = Number(a.versions[0]?.createdAt) || 0
    const bt = Number(b.versions[0]?.createdAt) || 0
    return bt - at
  })
  return out
}

/**
 * 版本与当前正文的字数差，给「比现在少 1,204 字」这种提示用。**纯函数**。
 * 没有当前正文（例如章节已删）时 delta 为 null，界面据此不显示差值。
 */
export function versionDelta(version, chapterContent) {
  const before = countWords(version?.content).total
  if (chapterContent == null) return { before, after: null, delta: null }
  const after = countWords(chapterContent).total
  return { before, after, delta: after - before }
}

/** 删除某一章的全部版本。回滚与裁剪都不用它；留给「确认不要这些历史」这类显式动作。 */
export async function removeVersionsForChapter(bookId, chapterId) {
  if (!bookId || !chapterId) return []
  return db.coll.chapterVersions.update(bookId, (list) =>
    list.filter((v) => v.chapterId !== chapterId)
  )
}
