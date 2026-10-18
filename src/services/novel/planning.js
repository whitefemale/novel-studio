import { CHAPTER_PLAN_FIELDS } from './schemas.js'
import { fnv1a32 } from './snapshot.js'
import { matchesTerm } from './planCheck.js'

/**
 * 施工卡的「锁定节点」与 AI 计划提案。
 *
 * AI 可以建议本章怎么排，但**作者锁定的节拍不得被它悄悄改掉**。这里的做法是：
 *   1. AI 只能产出施工卡字段的草稿；
 *   2. 若草稿没有保留全部锁定节点，就生成一条 `planProposals` 记录等作者确认，
 *      界面不得直接把草稿写进章节；
 *   3. 提案 id 由章节 + 草稿内容决定，重复点击「AI 生成计划」不会堆出几十条一样的提案。
 *
 * 纯函数部分集中在这里，落库由界面调用 coll.planProposals 完成。
 */

export const PLAN_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected']

/** 锁定节点按行拆分（一行一条），保留作者原文。 */
export function splitLockedBeats(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * AI 草稿没有保留的锁定节点。
 *
 * 判据是「草稿的某个施工卡字段里提到了这条节点」：锁定节点是作者写的一句话，
 * 不要求 AI 逐字复述，但至少要有对应的文字落点。空的锁定节点列表永远不触发。
 */
export function missingLockedBeats(proposed, lockedBeats) {
  const beats = splitLockedBeats(lockedBeats)
  if (!beats.length) return []
  const candidateText = CHAPTER_PLAN_FIELDS.map((f) => String(proposed?.[f.key] ?? '')).join('\n')
  return beats.filter((beat) => !matchesTerm(candidateText, beat))
}

/** 只保留施工卡认识字段的草稿，避免模型顺手塞进 id/status 之类。 */
export function normalizePlanDraft(raw) {
  const out = {}
  for (const f of CHAPTER_PLAN_FIELDS) {
    const v = raw?.[f.key]
    if (v == null) continue
    out[f.key] = f.type === 'number' ? Number(v) || 0 : String(v).trim()
  }
  return out
}

/**
 * 由 AI 草稿构造提案。返回 null 表示不需要人工确认。
 *
 * `previous` 也存下来：提案被拒绝时，用户至少能看到「当时原本是什么」；
 * 抽屉里只显示提案内容而不显示它要覆盖什么，等于让人盲签。
 */
export function buildPlanProposal({
  bookId = '',
  chapterId = '',
  current = {},
  proposed = {},
  reportRunId = '',
  now = Date.now()
} = {}) {
  const lockedBeats = splitLockedBeats(current.lockedBeats)
  if (!lockedBeats.length) return null
  // 传原始文本而不是已经拆好的数组：missingLockedBeats 自己会拆。
  // 传数组的话 String([a, b]) 会把两条节点用逗号粘成一条，于是「缺哪几条」
  // 变成一条拼起来的假节点，既对不上原文也误导用户。
  const missing = missingLockedBeats(proposed, current.lockedBeats)
  if (!missing.length) return null

  const fields = normalizePlanDraft(proposed)
  const id = `pp_${fnv1a32([bookId, chapterId, JSON.stringify(fields)].join('|'))}`
  return {
    id,
    bookId,
    chapterId,
    status: 'pending',
    lockedBeats,
    missingBeats: missing,
    proposed: fields,
    previous: Object.fromEntries(CHAPTER_PLAN_FIELDS.map((f) => [f.key, current?.[f.key] ?? ''])),
    reportRunId: reportRunId || '',
    createdAt: now,
    updatedAt: now
  }
}

/** 把提案里的草稿合进章节 patch（接受提案时用），仍不包含 lockedBeats 本身。 */
export function proposalPatch(proposal) {
  return normalizePlanDraft(proposal?.proposed || {})
}
