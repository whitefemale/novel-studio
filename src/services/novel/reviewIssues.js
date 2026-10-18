import * as db from '../storage.js'
import { fnv1a32 } from './snapshot.js'

/**
 * 审校问题的生命周期。
 *
 * 完整报告**仍然不落库**：它针对的是某一版正文，正文一改就过期。但用户对每条
 * 问题做出的决定（接受 / 忽略 / 已修复 / 复核失败）是有价值的，必须保留 ——
 * 否则每次重新深检，用户都得把同样的问题再判一遍。
 *
 * 因此这里只落「状态」：`reviewIssueStates:{bookId}` 里每条记录带
 * `chapterId + contentHash`。正文一变，hash 不匹配，旧状态自动显示为「报告已过期」，
 * 而不是把旧结论当成仍然有效。
 */

export const REVIEW_ISSUE_STATUSES = [
  { value: 'open', label: '待处理' },
  { value: 'accepted', label: '已接受' },
  { value: 'ignored', label: '已忽略' },
  { value: 'fixed', label: '已修复' },
  { value: 'recheck-failed', label: '复核未通过' }
]

export const REVIEW_STATUS_LABELS = Object.fromEntries(
  REVIEW_ISSUE_STATUSES.map((s) => [s.value, s.label])
)

export const REVIEW_CATEGORIES = [
  { value: 'setting', label: '与设定冲突' },
  { value: 'continuity', label: '情节衔接' },
  { value: 'style', label: '文风表达' },
  { value: 'other', label: '其他' }
]

export const REVIEW_CATEGORY_LABELS = Object.fromEntries(
  REVIEW_CATEGORIES.map((c) => [c.value, c.label])
)

const KIND_TO_CATEGORY = {
  issues: 'setting',
  setting: 'setting',
  continuityIssues: 'continuity',
  continuity: 'continuity',
  styleIssues: 'style',
  style: 'style'
}

export function contentHashOf(text) {
  return fnv1a32(String(text ?? ''))
}

function normalizeSeverity(v) {
  return ['high', 'medium', 'low'].includes(v) ? v : 'medium'
}

/**
 * 单条问题规范化。
 *
 * `id` 是**确定性**的：同一章、同一版正文、同一类问题、同一句原文，永远得到同一个
 * id。这让「问题状态」能在多次深检之间对上，也让重复渲染时 Vue 的 key 稳定。
 */
export function normalizeReviewIssue(raw, { kind = 'issues', chapterId = '', content = '', index = 0 } = {}) {
  // 模型给了类别但类别不认识 → 'other'；只有这样才回退到数组来源。
  // 反过来（未知类别悄悄当「与设定冲突」）会把一条文风意见显示成设定冲突，
  // 而用户没有办法看出这是猜的。
  const rawCategory = String(raw?.category ?? '').trim()
  const category = rawCategory
    ? KIND_TO_CATEGORY[rawCategory] || 'other'
    : KIND_TO_CATEGORY[kind] || 'other'
  const title = String(raw?.title || raw?.message || raw?.issue || raw?.label || '未命名问题').trim()
  const quote = String(raw?.quote || raw?.evidence || '').trim()
  const location = String(raw?.location || raw?.position || '').trim()
  const explanation = String(raw?.explanation || raw?.detail || raw?.description || '').trim()
  const evidence = String(raw?.evidence || raw?.quote || '').trim()
  const falsePositiveHint = String(raw?.falsePositiveHint || raw?.falsePositive || '').trim()
  const suggestion = String(raw?.suggestion || raw?.fix || raw?.advice || '').trim()
  const contentHash = contentHashOf(content)
  const id = `ri_${fnv1a32([chapterId, contentHash, category, title, quote].join('|'))}`
  return {
    id,
    kind,
    category,
    categoryLabel: REVIEW_CATEGORY_LABELS[category],
    severity: normalizeSeverity(raw?.severity),
    title,
    quote,
    location,
    explanation,
    evidence,
    falsePositiveHint,
    suggestion,
    chapterId,
    contentHash,
    index
  }
}

/**
 * 把报告压平成可渲染、可落状态的问题列表。
 * 兼容新契约（单一 `issues`，每条带 category）与旧契约（三个数组）。
 */
export function flattenReviewReport(report, { chapterId = '', content = '' } = {}) {
  if (!report || typeof report !== 'object') return []
  const groups = []
  if (Array.isArray(report.issues)) groups.push(['issues', report.issues])
  if (Array.isArray(report.continuityIssues)) groups.push(['continuityIssues', report.continuityIssues])
  if (Array.isArray(report.styleIssues)) groups.push(['styleIssues', report.styleIssues])

  const seen = new Set()
  const out = []
  for (const [kind, list] of groups) {
    list.forEach((raw, i) => {
      const issue = normalizeReviewIssue(raw, { kind, chapterId, content, index: i })
      if (seen.has(issue.id)) return
      seen.add(issue.id)
      out.push(issue)
    })
  }
  return out
}

/**
 * 状态是否已过期（正文已不是审校时那一版）。
 *
 * 两侧都是 fnv1a32 的十六进制字符串，**不能 `Number()` 一下再比**：
 * `Number('0a1b2c3d')` 是 NaN，那会让每一条问题都恒过期。
 */
export function isIssueStale(state, currentContent) {
  if (!state) return true
  return String(state.contentHash ?? '') !== contentHashOf(currentContent)
}

export function stateMap(states = []) {
  return new Map((states || []).filter((s) => s && s.id).map((s) => [s.id, s]))
}

/**
 * 把一批问题登记成 `open` 状态。
 *
 * **只补缺失的**：同一条问题重复深检时，不能把用户已经标成「已忽略」的状态
 * 重置回「待处理」—— 那会让「忽略」变成一个每次检查都白点的按钮。
 * 返回落库后的完整列表。
 */
export async function saveIssueStates(bookId, issues = [], { reportRunId = '' } = {}) {
  if (!bookId) return []
  const incoming = (issues || []).filter((i) => i && i.id)
  if (!incoming.length) return db.coll.reviewIssueStates.getAll(bookId)
  const list = await db.coll.reviewIssueStates.getAll(bookId)
  const byId = new Map(list.map((s) => [s.id, s]))
  let changed = false
  for (const issue of incoming) {
    if (byId.has(issue.id)) continue
    byId.set(issue.id, {
      id: issue.id,
      bookId,
      chapterId: issue.chapterId || '',
      contentHash: issue.contentHash,
      category: issue.category,
      severity: issue.severity,
      status: 'open',
      reportRunId: reportRunId || '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    changed = true
  }
  if (!changed) return list
  return db.coll.reviewIssueStates.saveAll(bookId, [...byId.values()])
}

/** 更新一条问题的状态。`state` 可以是问题对象，也可以是已落库的状态记录。 */
export async function setIssueStatus(bookId, state, status, { reportRunId = '' } = {}) {
  if (!bookId || !state?.id || !REVIEW_STATUS_LABELS[status]) return null
  const list = await db.coll.reviewIssueStates.getAll(bookId)
  const byId = new Map(list.map((s) => [s.id, s]))
  const prev = byId.get(state.id) || {}
  const rec = {
    ...prev,
    id: state.id,
    bookId,
    chapterId: state.chapterId || prev.chapterId || '',
    contentHash: state.contentHash ?? prev.contentHash,
    category: state.category || prev.category || 'other',
    severity: state.severity || prev.severity || 'medium',
    status,
    reportRunId: reportRunId || prev.reportRunId || '',
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now()
  }
  byId.set(state.id, rec)
  await db.coll.reviewIssueStates.saveAll(bookId, [...byId.values()])
  return rec
}

/** 某章的问题状态（按更新时间倒序），给「最近处理过什么」用。 */
export async function listIssueStates(bookId, chapterId = '') {
  const list = await db.coll.reviewIssueStates.getAll(bookId)
  return list
    .filter((s) => !chapterId || s.chapterId === chapterId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}
