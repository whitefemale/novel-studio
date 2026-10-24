import { coll } from '../storage.js'
import { normalizeRagSettings } from '../settingsExtras.js'
import { ensureBookIndex } from './indexer.js'
import { searchRag } from './search.js'

/**
 * 把检索接到写作链路上。
 *
 * 这一层只负责三件事：拼查询、决定排除哪些章、把异常吞成空结果。
 * 检索**永远不该阻断写作** —— 它是一层锦上添花的上下文；因为索引损坏或
 * 向量算错就让用户点不动「生成」，是把可选功能做成了单点故障。
 */

/** 拼查询文本。纯函数：输入相同则查询相同，方便单测。 */
export function buildRagQueryText(input = {}) {
  const parts = []
  const inst = String(input.instruction || '').trim()
  if (inst) parts.push(inst)

  const ch = input.chapter
  if (ch) {
    if (ch.title) parts.push(`标题：${ch.title}`)
    for (const key of [
      'purpose',
      'summary',
      'coreConflict',
      'openingState',
      'mustEvents',
      'stateChanges',
      'endingHook',
      'continuity'
    ]) {
      const v = String(ch[key] ?? '').trim()
      if (v) parts.push(v)
    }
    const content = String(ch.content || '').trim()
    if (content) parts.push(content.slice(-800))
  }

  // 「生成新一章」没有当前章，此时大纲是唯一能说明「这一章要写什么」的东西。
  if (!ch && input.action === 'chapter') {
    const outlines = Array.isArray(input.outlines) ? input.outlines : []
    for (const o of outlines) {
      if (o?.type !== 'outline') continue
      const text = `${o.title || ''}\n${String(o.content || '')}`.trim()
      if (text) parts.push(text.slice(-800))
    }
  }

  const query = parts.filter(Boolean).join('\n').trim()
  return query.length > 2000 ? query.slice(-2000) : query
}

/**
 * 哪些章节不参与检索。
 *
 * 当前章当然要排除（正在写它，不需要「召回它自己」）。紧邻的几章也排除：
 * 它们的尾部已经通过「最近正文」层原样进入提示词，再召回一遍既浪费预算，
 * 又会让同一段文字在提示词里出现两次。窗口与 contextChapters 保持一致。
 */
export function ragExcludeChapterIds(chapters = [], currentChapterId = '', window = 3) {
  const sorted = [...chapters].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
  const idx = sorted.findIndex((c) => c.id === currentChapterId)
  const ids = new Set()
  if (currentChapterId) ids.add(currentChapterId)
  if (idx > 0) {
    const n = Math.max(0, Number(window) || 0)
    for (const c of sorted.slice(Math.max(0, idx - n), idx)) ids.add(c.id)
  }
  return [...ids]
}

/**
 * 检索当前书里与本章相关的历史片段。
 *
 * 返回 `[]` 表示：开关关着 / 没有查询 / 没有可用历史。调用方不需要区分 ——
 * 空数组就是「这一层不加」。
 */
export async function retrieveRagContext(input = {}, settings = {}) {
  const rag = normalizeRagSettings(settings?.rag ?? settings)
  if (!rag.enabled) return []
  const bookId = input.bookId
  const chapters = input.chapters || []
  if (!bookId || !chapters.length) return []

  const query = buildRagQueryText(input)
  if (!query) return []

  try {
    await ensureBookIndex(bookId, chapters, rag)
    const chunks = await coll.ragChunks.getAll(bookId)
    if (!chunks.length) return []

    const window = Math.max(0, Number(settings?.contextChapters ?? 3) || 3)
    const excludeChapterIds = ragExcludeChapterIds(chapters, input.chapter?.id || '', window)
    const hits = searchRag({
      query,
      chunks,
      topK: rag.topK,
      minScore: rag.minScore,
      excludeChapterIds
    })

    // 索引里的标题/顺序是建索引那一刻的；章节可能刚改过标题或被移动。
    // 展示与提示词都用**当前**数据，避免「第 3 章」出现在标题已经改成
    // 「第 5 章」之后。
    const byId = new Map(chapters.map((c) => [c.id, c]))
    return hits.map((h) => {
      const c = byId.get(h.chapterId)
      return {
        ...h,
        chapterTitle: c?.title || h.chapterTitle,
        chapterOrder: Number(c?.order) || h.chapterOrder
      }
    })
  } catch (e) {
    console.warn('[rag] 检索失败，本次不注入历史片段', e)
    return []
  }
}
