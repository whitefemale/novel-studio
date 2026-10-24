import { splitPlanTerms, matchesTerm } from './planCheck.js'
import { ACTIVE_FORESHADOW_STATUS, CHAPTER_PLAN_FIELDS } from './schemas.js'

/**
 * 生成正文之前的施工卡校验：**确定性、零成本、不调用模型**。
 *
 * 与 planCheck.js 的分工：
 * - planCheck 回答「已经写出来的正文有没有按计划走」（事后）；
 * - 这里回答「这份计划本身会不会踩已有的硬设定」（事前）。
 *
 * 七条规则全部只做字面匹配。它们宁可漏报也不误报：一个总在喊狼来了的检查，
 * 用户第三次就会直接忽略它。每条 issue 都必须带 `evidence`（从候选计划里
 * 摘出的原文片段），界面据此指回具体位置，而不是给一句无法核实的判断。
 *
 * 纯函数、无 I/O：夹具可以直接喂内存对象，不碰 IndexedDB。
 */

export const PLAN_VALIDATION_VERSION = 1

/** 规则分类。界面用它做分组与标签，别在组件里另写一份中文映射。 */
export const PLAN_ISSUE_CATEGORIES = [
  { value: 'dead-character', label: '死亡人物出场' },
  { value: 'destroyed-faction', label: '覆灭势力出场' },
  { value: 'future-event', label: '提前使用未发生的事件' },
  { value: 'core-rule', label: '改写核心世界规则' },
  { value: 'foreshadow-spoiler', label: '提前揭示伏笔' },
  { value: 'required-beats', label: '偏离卷/篇必发节拍' },
  { value: 'repetition', label: '与近期章节重复' }
]

export const PLAN_ISSUE_LABELS = Object.fromEntries(
  PLAN_ISSUE_CATEGORIES.map((c) => [c.value, c.label])
)

/** 默认与最近 3 章比对；阈值 0.6 是「同一件事换了几个字」的量级。 */
export const DEFAULT_REPETITION_WINDOW = 3
export const REPETITION_THRESHOLD = 0.6

/**
 * 会被当作「情节」扫描的施工卡字段。
 *
 * **刻意不含 forbidden / acceptance / continuity**：那三个字段本来就会写
 * 「某某不得出场」「已死之人不能再说话」，把它们算成「出场」会制造大量误报。
 * 这条取舍写在代码里，免得后来者「顺手补全」而后把误报带回来。
 */
const NARRATIVE_FIELDS = [
  'openingState',
  'coreConflict',
  'mustEvents',
  'threads',
  'stateChanges',
  'worldReveals',
  'foreshadowActions',
  'endingHook'
]

/** 规则 4 只关心这两处：它们才是在「说明世界变成了什么样」。 */
const RULE_FIELDS = ['worldReveals', 'stateChanges']

function text(v) {
  return String(v ?? '')
}

function norm(s) {
  return text(s).replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 把名称与别名统一成候选词表；空串与纯空白不算。 */
function namesOf(entity) {
  const out = []
  const add = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) add(x)
      return
    }
    for (const part of text(v).split(/[，,、;；\n\r]+/)) {
      const s = part.trim()
      if (s) out.push(s)
    }
  }
  add(entity?.name ?? entity?.title)
  add(entity?.aliases)
  return [...new Set(out)]
}

/**
 * 把 AI 草案 / 表单整理成一份完整的候选计划。
 *
 * 草案缺字段时沿用章节里现有的值：界面上「草稿 + 尚未改动的字段」才是用户
 * 真正会保存下去的那份计划，只校验 AI 返回的那几个键会放过合并后才出现的冲突。
 */
export function normalizePlanCandidate(raw, chapter = null) {
  const out = {}
  for (const f of CHAPTER_PLAN_FIELDS) {
    const v = raw && Object.prototype.hasOwnProperty.call(raw, f.key) ? raw[f.key] : chapter?.[f.key]
    out[f.key] = f.type === 'number' ? Number(v) || 0 : text(v)
  }
  out.povCharacterId = text(raw?.povCharacterId ?? chapter?.povCharacterId ?? '')
  out.id = text(raw?.id ?? chapter?.id ?? '')
  out.order = Number(raw?.order ?? chapter?.order) || 0
  out.title = text(raw?.title ?? chapter?.title ?? '')
  return out
}

/** 在若干字段里找某个词第一次出现的位置，返回字段名与带上下文的证据。 */
function findMention(plan, terms, fields = NARRATIVE_FIELDS) {
  for (const field of fields) {
    const body = text(plan?.[field])
    if (!body) continue
    for (const term of terms) {
      const at = body.indexOf(term)
      if (at < 0) continue
      const start = Math.max(0, at - 24)
      const end = Math.min(body.length, at + term.length + 24)
      return {
        field,
        term,
        evidence: `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
      }
    }
  }
  return null
}

/** 章节 id → order。查不到（被删了）返回 null，所有「未来」判断都跳过。 */
function orderMap(chapters = []) {
  const m = new Map()
  for (const c of chapters || []) if (c?.id) m.set(c.id, Number(c.order) || 0)
  return m
}

/** 字符二元组集合。中文没有空格，二元组是最省事又稳定的相似度单位。 */
function bigrams(s) {
  const t = norm(s)
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Dice 系数：2|A∩B| / (|A|+|B|)。 */
export function bigramDice(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

function planNarrativeText(plan) {
  return NARRATIVE_FIELDS.map((f) => text(plan?.[f])).filter(Boolean).join('\n')
}

/**
 * 校验一份施工卡。
 *
 * @param {object} args
 * @param {object} args.plan       候选计划（AI 草案或表单）
 * @param {object} args.chapter    当前章节（提供 order / arcId / id）
 * @param {object} args.book       书（全书规划，目前只做展示，不参与判定）
 * @param {Array}  args.chapters   全部章节，用于「未来章节」判定
 * @param {object} args.memory     记忆层 `{characters, factions, worldRules, events, foreshadowing, ...}`
 * @param {object} args.structure  剧情骨架 `{volumes, arcs, scenes}`
 * @param {object} args.options    `{blockHigh, repetitionWindow, enabled}`
 * @returns {{ok:boolean, blocking:boolean, issues:Array, stats:object, version:number}}
 */
export function validatePlan({
  plan = {},
  chapter = null,
  book = null,
  chapters = [],
  memory = {},
  structure = {},
  options = {}
} = {}) {
  const candidate = normalizePlanCandidate(plan, chapter)
  const currentOrder = Number(candidate.order) || 0
  const orders = orderMap(chapters)
  const issues = []
  const push = (category, severity, field, message, evidence, relatedIds = []) => {
    const key = relatedIds[0] || field || category
    issues.push({
      id: `pv:${candidate.id || '?'}:${category}:${key}`,
      category,
      severity,
      field,
      message,
      evidence: text(evidence),
      relatedIds,
      // 作者永远可以否决自己的校验器：这不是拦截，是提醒。
      overridable: true
    })
  }

  const narrative = planNarrativeText(candidate)

  // 1) 已死人物出场。空计划不报：没有计划时不该有任何「出场」。
  if (narrative.trim()) {
    for (const ch of memory?.characters || []) {
      if (ch?.status !== 'dead') continue
      const names = namesOf(ch)
      if (!names.length) continue
      const hit = findMention(candidate, names)
      if (!hit) continue
      push(
        'dead-character',
        'high',
        hit.field,
        `人物「${names[0]}」在记忆里已死亡，计划中仍安排其出场`,
        hit.evidence,
        [ch.id].filter(Boolean)
      )
    }
  }

  // 视角人物本身就是死者：即使整章只用「他」来写，这也是硬伤。
  const pov = (memory?.characters || []).find((c) => c?.id === candidate.povCharacterId)
  if (pov && pov.status === 'dead') {
    push(
      'dead-character',
      'high',
      'povCharacterId',
      `视角人物「${namesOf(pov)[0] || '未命名'}」在记忆里已死亡，不能作为本章视角`,
      namesOf(pov)[0] || '',
      [pov.id]
    )
  }

  // 2) 覆灭势力的名字出现在计划里。
  if (narrative.trim()) {
    for (const f of memory?.factions || []) {
      if (f?.status !== 'destroyed') continue
      const names = namesOf(f)
      if (!names.length) continue
      const hit = findMention(candidate, names)
      if (!hit) continue
      push(
        'destroyed-faction',
        'high',
        hit.field,
        `势力「${names[0]}」已覆灭，计划中仍让其活动`,
        hit.evidence,
        [f.id].filter(Boolean)
      )
    }
  }

  // 3) 提前引用「尚未发生」的事件。事件挂在后面的章节上，计划里却已经在写它。
  if (narrative.trim()) {
    for (const ev of memory?.events || []) {
      const evOrder = orders.get(ev?.chapterId)
      if (evOrder == null || !currentOrder || evOrder <= currentOrder) continue
      const names = namesOf(ev)
      if (!names.length) continue
      const hit = findMention(candidate, names)
      if (!hit) continue
      push(
        'future-event',
        'high',
        hit.field,
        `事件「${names[0]}」计划发生在第 ${evOrder} 章，早于本章（第 ${currentOrder} 章）`,
        hit.evidence,
        [ev.id].filter(Boolean)
      )
    }
  }

  // 4) 核心世界规则被改写。只认「核心不可变」或高优先级规则，且只看
  //    worldReveals / stateChanges —— 在别的字段里提到规则名通常只是引用它。
  if (text(candidate.worldReveals).trim() || text(candidate.stateChanges).trim()) {
    for (const rule of memory?.worldRules || []) {
      const core = rule?.coreImmutable === true || Number(rule?.priority) >= 80
      if (!core) continue
      const names = namesOf(rule)
      if (!names.length) continue
      const hit = findMention(candidate, names, RULE_FIELDS)
      if (!hit) continue
      push(
        'core-rule',
        'high',
        hit.field,
        `核心世界规则「${names[0]}」被改写或推翻；核心规则默认不可变`,
        hit.evidence,
        [rule.id].filter(Boolean)
      )
    }
  }

  // 5) 伏笔提前揭示：预期回收章在当前章之后，计划却已经写出来了。
  if (narrative.trim()) {
    for (const fs of memory?.foreshadowing || []) {
      if (!ACTIVE_FORESHADOW_STATUS.includes(fs?.status)) continue
      const revealOrder = orders.get(fs?.expectedRevealChapterId)
      if (revealOrder == null || !currentOrder || revealOrder <= currentOrder) continue
      const names = namesOf(fs)
      if (!names.length) continue
      const hit = findMention(candidate, names)
      if (!hit) continue
      push(
        'foreshadow-spoiler',
        'high',
        hit.field,
        `伏笔「${names[0]}」预计在第 ${revealOrder} 章揭示，早于本章（第 ${currentOrder} 章）`,
        hit.evidence,
        [fs.id].filter(Boolean)
      )
    }
  }

  // 6) 偏离当前卷 / 篇的必发节拍：有一处有要求，却一条都没命中。
  const arcs = structure?.arcs || []
  const volumes = structure?.volumes || []
  const arc = arcs.find((a) => a?.id === chapter?.arcId) || null
  const volume = volumes.find((v) => v?.id === (arc?.volumeId || book?.currentVolumeId)) || null
  const beatSources = [arc, volume].filter(Boolean)
  const storyText = planNarrativeText(candidate)
  for (const src of beatSources) {
    const beats = splitPlanTerms(src?.requiredBeats)
    if (!beats.length) continue
    if (beats.some((b) => matchesTerm(storyText, b))) continue
    push(
      'required-beats',
      'medium',
      'mustEvents',
      `${src === arc ? '篇' : '卷'}「${src.title || '未命名'}」的必发节拍在本章计划里一条都没出现`,
      beats.slice(0, 2).join('；'),
      [src.id].filter(Boolean)
    )
  }

  // 7) 与最近 N 章重复。只在两边都有足够长的文本时比较：两三个字的碰撞
  //    算出来的 Dice 没有意义，只会制造噪音。
  const windowSize = Math.max(0, Number(options?.repetitionWindow ?? DEFAULT_REPETITION_WINDOW))
  if (windowSize > 0) {
    const current = [candidate.coreConflict, candidate.mustEvents].map(text).join('\n')
    if (norm(current).length >= 8) {
      const recent = (chapters || [])
        .filter((c) => c && c.id !== candidate.id)
        .filter((c) => (Number(c.order) || 0) > 0 && (Number(c.order) || 0) < currentOrder)
        .sort((a, b) => (Number(b.order) || 0) - (Number(a.order) || 0))
        .slice(0, windowSize)
      for (const c of recent) {
        const prior = [c.purpose, c.summary].map(text).join('\n')
        if (norm(prior).length < 8) continue
        const score = bigramDice(current, prior)
        if (score < REPETITION_THRESHOLD) continue
        push(
          'repetition',
          'medium',
          'coreConflict',
          `本章的核心冲突 / 必发事件与第 ${c.order} 章「${c.title || ''}」高度相似（${Math.round(
            score * 100
          )}%）`,
          text(c.purpose || c.summary).slice(0, 80),
          [c.id].filter(Boolean)
        )
        break // 一条就够：同一份计划重复报三次不会让人更愿意改
      }
    }
  }

  const validation = {
    ok: issues.length === 0,
    blocking: false,
    issues,
    version: PLAN_VALIDATION_VERSION,
    stats: {
      total: issues.length,
      high: issues.filter((i) => i.severity === 'high').length,
      medium: issues.filter((i) => i.severity === 'medium').length,
      low: issues.filter((i) => i.severity === 'low').length,
      categories: [...new Set(issues.map((i) => i.category))],
      planCharacters: norm(narrative).length,
      checked: PLAN_ISSUE_CATEGORIES.map((c) => c.value)
    }
  }
  validation.blocking = shouldBlockPlan(validation, {
    blockHigh: options?.blockHigh !== false
  })
  return validation
}

/**
 * 是否应当阻断「自动采用 AI 草案 / 队列自动继续」。
 *
 * **只影响自动化路径，永远不阻断用户手工编辑**：作者有权偏离自己的设定，
 * 界面上必须能显式「仍然采用」。所有 high 问题都标了 overridable。
 */
export function shouldBlockPlan(validation, { blockHigh = true } = {}) {
  if (!validation || !blockHigh) return false
  return (validation.issues || []).some(
    (i) => i.severity === 'high' && i.overridable !== false
  )
}

/** 章节上只存摘要：完整报告随正文版本变化而失效，摘要记录「当时是哪份判断」。 */
export function validationSummary(validation, at = 0, { overridden = false } = {}) {
  if (!validation) return null
  return {
    version: validation.version || PLAN_VALIDATION_VERSION,
    at: Number(at) || 0,
    blocking: !!validation.blocking,
    overridden: !!overridden,
    high: (validation.issues || []).filter((i) => i.severity === 'high').length,
    issueIds: (validation.issues || []).map((i) => i.id)
  }
}
