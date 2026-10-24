import {
  EMBEDDING_DIM,
  EMBEDDING_VERSION,
  applyIdf,
  buildIdf,
  cosineSimilarity,
  embedText
} from './hashEmbedding.js'

/**
 * 在全书分块里做字面相似检索。
 *
 * 打分 = 查询向量与分块向量（都乘上**本次查询现算的 IDF**）的余弦相似度。
 * 三条刻意的约束：
 *
 * 1. **IDF 每次查询现算**，不在索引时烘进向量。否则新增一章之后，新块的
 *    权重空间与旧块不同，余弦算的是两个坐标系里的夹角 —— 分数看着正常、
 *    排序却是错的，而且没有任何报错。
 * 2. **同一章最多取 N 块**。不限制的话，一章里反复出现主角名字的十来个块
 *    会把 topK 全部占满，别的章节一条也进不来。
 * 3. **输出完全确定**：同分时按章节顺序、块序号、id 排序。界面与测试都
 *    依赖这一点；用 `Array.sort` 的默认比较在相等时会依赖引擎实现。
 */

export const RAG_TOP_K = 6
export const RAG_MIN_SCORE = 0.18
export const RAG_MAX_PER_CHAPTER = 2

function normalizeVector(v) {
  if (!v || typeof v !== 'object') return null
  if (!v.counts || typeof v.counts !== 'object') return null
  return { dims: Number(v.dims) || EMBEDDING_DIM, counts: v.counts }
}

/**
 * 检索。
 *
 * @param {object} opts
 * @param {string} opts.query 查询文本
 * @param {Array} opts.chunks 当前书的全部 ragChunks
 * @param {number} opts.topK 最多返回几块
 * @param {number} opts.minScore 低于此分数丢弃
 * @param {Array<string>} opts.excludeChapterIds 不参与检索的章节（当前章、已在最近正文里的章）
 * @param {number} opts.maxPerChapter 同一章最多几块
 */
export function searchRag({
  query = '',
  chunks = [],
  topK = RAG_TOP_K,
  minScore = RAG_MIN_SCORE,
  excludeChapterIds = [],
  maxPerChapter = RAG_MAX_PER_CHAPTER
} = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const pool = (chunks || []).filter((c) => c && String(c.text || '').trim())
  if (!pool.length) return []

  const excluded = new Set(excludeChapterIds || [])
  const candidates = pool
    .filter((c) => !excluded.has(c.chapterId))
    .map((c) => ({ chunk: c, vector: normalizeVector(c.vector) || embedText(c.text) }))
  if (!candidates.length) return []

  const dims = candidates[0].vector.dims || EMBEDDING_DIM
  const idf = buildIdf(
    candidates.map((c) => c.vector),
    dims
  )
  const queryVector = applyIdf(embedText(q, dims), idf, dims)

  const scored = []
  for (const { chunk, vector } of candidates) {
    const score = cosineSimilarity(queryVector, applyIdf(vector, idf, dims))
    if (!Number.isFinite(score) || score <= 0) continue
    if (score < Number(minScore)) continue
    scored.push({
      id: String(chunk.id || ''),
      chapterId: String(chunk.chapterId || ''),
      chapterTitle: String(chunk.chapterTitle || ''),
      chapterOrder: Number(chunk.chapterOrder) || 0,
      chunkIndex: Number(chunk.chunkIndex) || 0,
      start: Number(chunk.start) || 0,
      end: Number(chunk.end) || 0,
      text: String(chunk.text || ''),
      embeddingVersion: String(chunk.embeddingVersion || EMBEDDING_VERSION),
      score
    })
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.chapterOrder - b.chapterOrder ||
      a.chunkIndex - b.chunkIndex ||
      a.id.localeCompare(b.id)
  )

  const k = Math.max(1, Math.min(50, Math.round(Number(topK) || RAG_TOP_K)))
  const perChapter = Math.max(1, Math.round(Number(maxPerChapter) || RAG_MAX_PER_CHAPTER))
  const used = new Map()
  const out = []
  for (const hit of scored) {
    const n = used.get(hit.chapterId) || 0
    if (n >= perChapter) continue
    used.set(hit.chapterId, n + 1)
    out.push(hit)
    if (out.length >= k) break
  }
  return out
}
