import test from 'node:test'
import assert from 'node:assert/strict'
import {
  contentHashOf,
  normalizeReviewIssue,
  flattenReviewReport,
  isIssueStale,
  stateMap
} from '../../src/services/novel/reviewIssues.js'

/**
 * 审校问题的身份与过期判定。
 *
 * 问题 id 必须由「章节 + 正文指纹 + 类别 + 标题 + 原文引用」确定：
 * 它既是 Vue 的 key，也是用户标过「已忽略」之后、下次深检还能对上的依据。
 * 正文指纹同时决定旧结论何时该显示为「报告已过期」。
 */

test('contentHashOf 对同一文本稳定、对不同文本不同', () => {
  assert.equal(contentHashOf('同一段正文'), contentHashOf('同一段正文'))
  assert.notEqual(contentHashOf('同一段正文'), contentHashOf('同一段正文。'))
  assert.equal(typeof contentHashOf(''), 'string')
  assert.match(contentHashOf(''), /^[0-9a-f]{8}$/)
})

test('normalizeReviewIssue 兼容新契约字段并给出确定性 id', () => {
  const raw = {
    category: 'continuity',
    severity: 'high',
    title: '时间线冲突',
    quote: '三年前那场大火',
    location: '第 3 段',
    explanation: '与第 2 章矛盾',
    evidence: '第 2 章说大火发生在一月',
    falsePositiveHint: '可能是角色记错',
    suggestion: '改成两年前'
  }
  const a = normalizeReviewIssue(raw, { chapterId: 'c1', content: '正文', index: 0 })
  const b = normalizeReviewIssue(raw, { chapterId: 'c1', content: '正文', index: 1 })
  assert.equal(a.id, b.id, 'index 不参与 id：重新排序不应改变问题身份')
  assert.equal(a.category, 'continuity')
  assert.equal(a.categoryLabel, '情节衔接')
  assert.equal(a.severity, 'high')
  assert.equal(a.evidence, '第 2 章说大火发生在一月')
  assert.equal(a.falsePositiveHint, '可能是角色记错')
  assert.equal(a.contentHash, contentHashOf('正文'))

  const otherChapter = normalizeReviewIssue(raw, { chapterId: 'c2', content: '正文' })
  assert.notEqual(a.id, otherChapter.id)
  const otherText = normalizeReviewIssue(raw, { chapterId: 'c1', content: '正文！' })
  assert.notEqual(a.id, otherText.id)
})

test('未知类别与严重度有安全的默认值', () => {
  const it = normalizeReviewIssue({ title: '某事', severity: 'catastrophic', category: '???' })
  assert.equal(it.category, 'other')
  assert.equal(it.severity, 'medium')
})

test('flattenReviewReport 支持新单一 issues 与旧三数组，并去重', () => {
  const dup = { title: '重复', quote: '同一句', category: 'style' }
  const report = {
    issues: [dup, { title: '新问题', category: 'setting' }],
    styleIssues: [dup],
    continuityIssues: [{ title: '旧问题' }]
  }
  const items = flattenReviewReport(report, { chapterId: 'c1', content: '正文' })
  assert.equal(items.length, 3)
  assert.deepEqual(
    items.map((i) => i.category).sort(),
    ['continuity', 'setting', 'style']
  )
  const legacyOnly = flattenReviewReport({ continuityIssues: [{ title: '仅旧格式' }] })
  assert.equal(legacyOnly.length, 1)
  assert.equal(legacyOnly[0].category, 'continuity')
  assert.deepEqual(flattenReviewReport(null), [])
})

test('isIssueStale：正文指纹不同即过期；没有状态也算过期', () => {
  const hash = contentHashOf('原来的正文')
  assert.equal(isIssueStale({ contentHash: hash }, '原来的正文'), false)
  assert.equal(isIssueStale({ contentHash: hash }, '改过的正文'), true)
  assert.equal(isIssueStale(null, '任何正文'), true)
})

test('stateMap 以问题 id 建索引，忽略缺 id 的记录', () => {
  const m = stateMap([{ id: 'a', status: 'ignored' }, null, { status: 'open' }])
  assert.equal(m.size, 1)
  assert.equal(m.get('a').status, 'ignored')
})
