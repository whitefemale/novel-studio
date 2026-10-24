import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBEDDING_DIM,
  EMBEDDING_VERSION,
  embeddingTokens,
  embedText,
  buildIdf,
  applyIdf,
  cosineSimilarity
} from '../../src/services/rag/hashEmbedding.js'
import { chunkChapter } from '../../src/services/rag/chunking.js'
import { searchRag } from '../../src/services/rag/search.js'
import {
  buildRagQueryText,
  ragExcludeChapterIds
} from '../../src/services/rag/context.js'

test('embeddingTokens：中文单字 + 双字、拉丁词，标点不参与', () => {
  const tokens = embeddingTokens('林昭，在药庐杀敌 2024 ok a')
  assert.ok(tokens.includes('c:林'))
  assert.ok(tokens.includes('b:林昭'))
  assert.ok(tokens.includes('c:昭'))
  assert.ok(tokens.includes('b:药庐'))
  assert.ok(tokens.includes('w:2024'))
  assert.ok(tokens.includes('w:ok'))
  // 单个字母信息量太低，不产生 token
  assert.ok(!tokens.includes('w:a'))
  // 中文标点/空格不产生 token
  assert.ok(!tokens.some((t) => t.includes('，')))
  // 同一段文本分词结果恒定
  assert.deepEqual(embeddingTokens('林昭在药庐'), embeddingTokens('林昭在药庐'))
})

test('embedText：维度固定、稀疏计数、确定性', () => {
  const v = embedText('林昭在药庐')
  assert.equal(v.dims, EMBEDDING_DIM)
  const keys = Object.keys(v.counts)
  assert.ok(keys.length > 0 && keys.length <= EMBEDDING_DIM * 2)
  for (const k of keys) {
    assert.ok(Number(k) >= 0 && Number(k) < EMBEDDING_DIM)
    assert.ok(v.counts[k] >= 1)
  }
  assert.deepEqual(v, embedText('林昭在药庐'))
  assert.deepEqual(embedText(''), { dims: EMBEDDING_DIM, counts: {} })
})

test('TF-IDF 余弦：相关内容显著高于无关内容，且完全确定性', () => {
  const a = embedText('林昭在药庐与苏九对峙，剑拔弩张。')
  const b = embedText('林昭走进药庐，看见苏九正在煎药。')
  const c = embedText('赛博朋克飞船的引擎过载了，警报响彻舱室。')
  const idf = buildIdf([a, b, c])
  const va = applyIdf(a, idf)
  const vb = applyIdf(b, idf)
  const vc = applyIdf(c, idf)
  const related = cosineSimilarity(va, vb)
  const unrelated = cosineSimilarity(va, vc)
  assert.ok(related > unrelated)
  assert.ok(related > 0.2)
  assert.ok(cosineSimilarity(va, va) > 0.999)
  // 空向量返回 0，而不是 NaN —— NaN 会污染排序
  assert.equal(cosineSimilarity({ dims: 8, counts: {} }, va), 0)
  assert.equal(cosineSimilarity(null, va), 0)
  // IDF 只由传入的全部向量决定，同输入同输出
  const idf2 = buildIdf([a, b, c])
  assert.deepEqual([...idf], [...idf2])
})

test('chunkChapter：偏移可回切原文、整句重叠、空章不产块', () => {
  const content =
    '第一段。这里有林昭与药庐的故事。\n\n' +
    '第二段：' + '他走进药庐，看见苏九正在煎药。'.repeat(20)
  const chunks = chunkChapter({ content }, { targetChars: 120, overlapChars: 40 })
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    assert.equal(content.slice(c.start, c.end).trim(), c.text)
    assert.ok(c.text.length > 0)
  }
  // 相邻块有重叠：后一块的起点在前一块内部
  assert.ok(chunks[1].start < chunks[0].end)
  // 每块不超过目标长度（硬切与整句装填都受它约束）
  for (const c of chunks) assert.ok(c.text.length <= 120)
  // 空章节 / 纯空白
  assert.deepEqual(chunkChapter({ content: '' }), [])
  assert.deepEqual(chunkChapter({ content: '   \n\n  ' }), [])
  // maxChunks 是硬上限
  const capped = chunkChapter({ content: '句子。'.repeat(500) }, { targetChars: 50, maxChunks: 3 })
  assert.equal(capped.length, 3)
})

test('chunkChapter：没有标点的超长段落也能切开且不切坏代理对', () => {
  const content = '😀'.repeat(600)
  const chunks = chunkChapter({ content }, { targetChars: 100, overlapChars: 0 })
  assert.ok(chunks.length >= 6)
  for (const c of chunks) {
    assert.equal(content.slice(c.start, c.end).trim(), c.text)
    // 每个 emoji 都是完整的两码元代理对
    assert.equal(c.text.length % 2, 0)
    // 块首不能是孤立低代理项（0xDC00–0xDFFF）
    const head = c.text.charCodeAt(0)
    assert.ok(head < 0xdc00 || head > 0xdfff)
  }
})

function makeChunks() {
  const rows = [
    ['c1', 1, 0, '林昭在药庐与苏九对峙，剑拔弩张。'],
    ['c1', 1, 1, '药庐外下着雨，林昭握紧了剑。'],
    ['c2', 2, 0, '苏九在药庐煎药，想起三年前的旧事。'],
    ['c3', 3, 0, '飞船引擎过载，警报响彻整个舱室。'],
    ['c4', 4, 0, '林昭独自走进空无一人的药庐。']
  ]
  return rows.map(([chapterId, chapterOrder, chunkIndex, text], i) => ({
    id: `r${i}`,
    chapterId,
    chapterOrder,
    chapterTitle: '第' + chapterOrder + '章',
    chunkIndex,
    text,
    vector: embedText(text)
  }))
}

test('searchRag：排除指定章、每章上限、分数过滤与确定性排序', () => {
  const chunks = makeChunks()
  const hits = searchRag({ query: '林昭 药庐 苏九', chunks, topK: 10, minScore: 0.01 })
  assert.ok(hits.length > 0)
  // 同一章最多 2 块
  const per = new Map()
  for (const h of hits) per.set(h.chapterId, (per.get(h.chapterId) || 0) + 1)
  for (const n of per.values()) assert.ok(n <= 2)
  // 分数降序
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score)
  // 排除当前章
  const excluded = searchRag({
    query: '林昭 药庐 苏九',
    chunks,
    topK: 10,
    minScore: 0.01,
    excludeChapterIds: ['c1', 'c2']
  })
  assert.ok(excluded.every((h) => h.chapterId !== 'c1' && h.chapterId !== 'c2'))
  // 同样的输入两次结果完全一致
  assert.deepEqual(
    searchRag({ query: '林昭 药庐 苏九', chunks, topK: 3, minScore: 0 }).map((h) => h.id),
    searchRag({ query: '林昭 药庐 苏九', chunks, topK: 3, minScore: 0 }).map((h) => h.id)
  )
  // 空查询 / 空库 / 分数门槛过高
  assert.deepEqual(searchRag({ query: '', chunks }), [])
  assert.deepEqual(searchRag({ query: '林昭', chunks: [] }), [])
  assert.deepEqual(searchRag({ query: '林昭 药庐', chunks, minScore: 0.999 }), [])
})

test('searchRag：topK 是硬上限，缺向量的块会现算', () => {
  const chunks = makeChunks().map((c) => ({ ...c, vector: undefined }))
  const hits = searchRag({ query: '林昭 药庐 苏九', chunks, topK: 2, minScore: 0 })
  assert.equal(hits.length, 2)
})

test('buildRagQueryText：优先本次要求与施工卡，不含无关集合', () => {
  const q = buildRagQueryText({
    action: 'continue',
    instruction: '让林昭发现药庐里的密道',
    chapter: {
      title: '雨夜',
      purpose: '揭开旧案',
      mustEvents: '林昭找到账本',
      content: '林昭推开木门。'.repeat(200)
    }
  })
  assert.ok(q.includes('让林昭发现药庐里的密道'))
  assert.ok(q.includes('揭开旧案'))
  assert.ok(q.includes('林昭找到账本'))
  assert.ok(!q.includes('人物设定'))
  // 超长时有上限
  assert.ok(buildRagQueryText({ instruction: '很长'.repeat(5000) }).length <= 2000)
  // 「生成新一章」没有当前章时用大纲
  const q2 = buildRagQueryText({
    action: 'chapter',
    outlines: [{ type: 'outline', title: '第一卷', content: '林昭出山，卷入药庐旧案。' }]
  })
  assert.ok(q2.includes('药庐旧案'))
})

test('ragExcludeChapterIds：当前章 + 最近 N 章（与最近正文窗口一致）', () => {
  const chapters = [
    { id: 'a', order: 1 },
    { id: 'b', order: 2 },
    { id: 'c', order: 3 },
    { id: 'd', order: 4 }
  ]
  assert.deepEqual(ragExcludeChapterIds(chapters, 'd', 2).sort(), ['b', 'c', 'd'])
  assert.deepEqual(ragExcludeChapterIds(chapters, 'a', 3), ['a'])
  assert.deepEqual(ragExcludeChapterIds(chapters, '', 2), [])
})

test('EMBEDDING_VERSION 是索引过期判断的一部分', () => {
  assert.equal(EMBEDDING_VERSION, 'hash-v1')
})
