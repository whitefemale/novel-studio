import { coll } from '../storage.js'
import { contentHashOf } from '../novel/reviewIssues.js'
import { normalizeRagSettings } from '../settingsExtras.js'
import { chunkChapter } from './chunking.js'
import { EMBEDDING_VERSION, embedText } from './hashEmbedding.js'

/**
 * 章节检索索引（`ragChunks:{bookId}`）。
 *
 * 三条设计决定：
 *
 * 1. **懒构建，不在 persistChapter 上挂钩子。** persistChapter 是自动保存的落点，
 *    每 1.5 秒就可能写一次；在那里同步分块+向量化会让打字变卡，而且会和同步的
 *    整组回写抢同一个 IndexedDB 键。索引只在「生成前」与「检索页打开时」确保最新。
 * 2. **靠内容哈希判断是否过期。** 章节可能被自动保存、版本回滚、局域网同步或
 *    WebDAV 合并改写 —— 它们都不会通知索引。每次比对 `contentHash` 就够了；
 *    多算一次哈希远比挂一堆钩子可靠。
 * 3. **整组回写，不写墓碑。** 索引是**可再生的派生数据**，不是用户内容。
 *    写墓碑会让它随快照传播（但它本来就不进快照），还会让 tombstone 表膨胀；
 *    直接 `saveAll` 一份完整列表最简单，也天然幂等。
 *
 * 所有写入都走 `coll.ragChunks`（serialize + toPlain + !bookId 守卫）。
 */

export const RAG_COLLECTION = 'ragChunks'

export function ragChunkId(chapterId, chunkIndex) {
  return `rag_${chapterId}_${chunkIndex}`
}

function emptyStatus(bookId = '') {
  return {
    bookId,
    version: EMBEDDING_VERSION,
    changed: false,
    chapters: 0,
    contentChapters: 0,
    indexedChapters: 0,
    builtChapters: 0,
    removedChapters: 0,
    chunkCount: 0,
    totalChars: 0,
    coverage: 0,
    builtAt: 0
  }
}

function chapterText(ch) {
  return String(ch?.content ?? '')
}

/**
 * 建立/更新一本书的检索索引。
 *
 * @returns 状态对象。`changed=false` 表示一个字节都没写库 —— 每次生成前都会
 *   调用它，绝大多数时候应当零写入。
 */
export async function ensureBookIndex(bookId, chapters = [], settings = {}, { force = false, now = 0 } = {}) {
  if (!bookId) return emptyStatus('')
  const rag = normalizeRagSettings(settings?.rag ?? settings)
  const at = Number(now) || Date.now()

  const all = [...(chapters || [])].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
  const existing = await coll.ragChunks.getAll(bookId)
  const byChapter = new Map()
  for (const rec of existing) {
    if (!rec || !rec.chapterId) continue
    if (!byChapter.has(rec.chapterId)) byChapter.set(rec.chapterId, [])
    byChapter.get(rec.chapterId).push(rec)
  }

  const desired = []
  let indexedChapters = 0
  let builtChapters = 0
  let totalChars = 0
  const seen = new Set()

  for (const ch of all) {
    const content = chapterText(ch)
    if (!content.trim()) continue
    // 同名重复 id 只认第一份，避免同一章生成两套 id 相同的块
    if (!ch.id || seen.has(ch.id)) continue
    seen.add(ch.id)

    const hash = contentHashOf(content)
    const old = byChapter.get(ch.id) || []
    const unchanged =
      !force &&
      old.length > 0 &&
      old.every(
        (r) =>
          r.contentHash === hash &&
          r.embeddingVersion === EMBEDDING_VERSION &&
          Number(r.chunkChars) === rag.chunkChars &&
          Number(r.overlapChars) === rag.overlapChars
      )

    if (unchanged) {
      for (const r of old) {
        desired.push(r)
        totalChars += String(r.text || '').length
      }
      indexedChapters++
      continue
    }

    const chunks = chunkChapter(ch, {
      targetChars: rag.chunkChars,
      overlapChars: rag.overlapChars
    })
    if (!chunks.length) continue
    builtChapters++
    indexedChapters++
    chunks.forEach((c, i) => {
      desired.push({
        id: ragChunkId(ch.id, i),
        bookId,
        chapterId: ch.id,
        chapterOrder: Number(ch.order) || 0,
        chapterTitle: String(ch.title || ''),
        chunkIndex: i,
        text: c.text,
        start: c.start,
        end: c.end,
        contentHash: hash,
        embeddingVersion: EMBEDDING_VERSION,
        chunkChars: rag.chunkChars,
        overlapChars: rag.overlapChars,
        vector: embedText(c.text),
        updatedAt: at
      })
      totalChars += c.text.length
    })
  }

  const desiredIds = new Set(desired.map((r) => r.id))
  const removedChapters = [...byChapter.keys()].filter((id) => !seen.has(id)).length
  const orphanRecords = existing.filter((r) => !desiredIds.has(r.id)).length
  const changed = force || builtChapters > 0 || removedChapters > 0 || orphanRecords > 0

  if (changed) await coll.ragChunks.saveAll(bookId, desired)

  const contentChapters = all.filter((c) => chapterText(c).trim()).length
  return {
    bookId,
    version: EMBEDDING_VERSION,
    changed,
    chapters: all.length,
    contentChapters,
    indexedChapters,
    builtChapters,
    removedChapters,
    chunkCount: desired.length,
    totalChars,
    coverage: contentChapters ? indexedChapters / contentChapters : 0,
    builtAt: changed ? at : Number(existing[0]?.updatedAt) || 0
  }
}

/**
 * 只读状态：用于检索页展示覆盖率与「有多少章已过期」。
 *
 * 与 ensureBookIndex 的区别是**绝不写库** —— 打开一个面板不该改数据。
 */
export async function getRagIndexStatus(bookId, chapters = []) {
  if (!bookId) return { ...emptyStatus(''), staleChapters: 0, missingChapters: 0, orphanChapters: 0 }
  const all = chapters || []
  const existing = await coll.ragChunks.getAll(bookId)
  const byChapter = new Map()
  for (const rec of existing) {
    if (!rec || !rec.chapterId) continue
    if (!byChapter.has(rec.chapterId)) byChapter.set(rec.chapterId, [])
    byChapter.get(rec.chapterId).push(rec)
  }

  let contentChapters = 0
  let indexedChapters = 0
  let staleChapters = 0
  let missingChapters = 0
  let totalChars = 0
  for (const ch of all) {
    const content = chapterText(ch)
    if (!content.trim()) continue
    contentChapters++
    const group = byChapter.get(ch.id) || []
    if (!group.length) {
      missingChapters++
      continue
    }
    indexedChapters++
    totalChars += group.reduce((a, r) => a + String(r.text || '').length, 0)
    const hash = contentHashOf(content)
    if (group.some((r) => r.contentHash !== hash || r.embeddingVersion !== EMBEDDING_VERSION)) {
      staleChapters++
    }
  }
  const ids = new Set(all.map((c) => c.id))
  const orphanChapters = [...byChapter.keys()].filter((id) => !ids.has(id)).length
  return {
    ...emptyStatus(bookId),
    chapters: all.length,
    contentChapters,
    indexedChapters,
    chunkCount: existing.length,
    totalChars,
    coverage: contentChapters ? indexedChapters / contentChapters : 0,
    builtAt: Number(existing[0]?.updatedAt) || 0,
    staleChapters,
    missingChapters,
    orphanChapters
  }
}

/** 清空一本书的索引。返回删掉的块数。 */
export async function clearBookIndex(bookId) {
  if (!bookId) return { cleared: 0 }
  const existing = await coll.ragChunks.getAll(bookId)
  await coll.ragChunks.saveAll(bookId, [])
  return { cleared: existing.length }
}
