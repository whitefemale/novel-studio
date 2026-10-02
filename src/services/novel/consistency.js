import { ENTITY_SCHEMAS } from './schemas'
import { findBrokenRefs, overdueForeshadow } from './timeline'
import { normalizeTitle } from '../migration'

/**
 * 一致性检查的**规则部分**：确定性、零成本、打开控制台即算。
 *
 * 这是本项目对「AI 深检」的一处刻意分工：能由代码判定的事情绝不交给模型 ——
 * 规则判据是确定的、瞬时的、免费的，而且**可以断言「干净数据必须 0 条」**；
 * 模型只负责规则说不清的那部分（文风前后不一、语气突变、暗示与回收的力度是否
 * 相称）。两者共用同一张报告，但费用边界清清楚楚：规则那一半永远 ¥0。
 *
 * ## 误报比漏报更贵
 *
 * 一条会指着正常数据报警的规则，用户看两次就再也不看整张报告了 —— 那时它连
 * 「漏报」的价值都没了。所以下面每条规则的判据都刻意取窄，宁可放过也不冤枉：
 *
 *   - 断链：**空引用不算断链**（那是「还没填」，不是「填错了」）；
 *   - 已退场人物仍出场：必须有 `lastUpdatedChapterId` 当锚点才判，否则刚死掉
 *     的那个人在他自己死的那一章里就会被报出来；
 *   - 时间倒挂：只比**同一个单位**的时间写法（「1月」vs「2月」可比，
 *     「三年前」vs「1月」不可比 —— 序章插叙是正常写法）；
 *   - 人物久未出场：已死亡/失踪的不算「陈旧」，他们本来就不该再更新。
 *
 * ## 纯函数、无 I/O
 *
 * 与 Context Builder 同理：判据要能被确定性验证，且它跑在控制台打开的路径上。
 */

/** 规则清单。驱动报告的分组标题、徽标与设置项，也是「检查了什么」的唯一说明处。 */
export const CONSISTENCY_RULES = [
  {
    id: 'brokenRefs',
    label: '断链引用',
    severity: 'high',
    hint: '某条设定指向了一条已经不存在（或已被删掉）的记录'
  },
  {
    id: 'deadCharacterAppears',
    label: '已退场人物仍出场',
    severity: 'high',
    hint: '人物已标为死亡 / 失踪，但更靠后的事件里还有他'
  },
  {
    id: 'timelineInverted',
    label: '故事内时间倒挂',
    severity: 'medium',
    hint: '两章的「故事内时间」写法一致，先后却与章号相反'
  },
  {
    id: 'overdueForeshadow',
    label: '伏笔逾期未回收',
    severity: 'medium',
    hint: '说好回收的那一章已经写完，伏笔却还停在「已埋下 / 发展中」'
  },
  {
    id: 'duplicateEvent',
    label: '重复事件',
    severity: 'low',
    hint: '同一章里有两条同名事件'
  },
  {
    id: 'missingSummary',
    label: '章节缺摘要',
    severity: 'low',
    hint: '正文写好了却没有梗概 —— 写到后面时这一章等于没发生过'
  },
  {
    id: 'staleCharacter',
    label: '人物久未出场',
    severity: 'low',
    hint: '超过 30 章没有更新过的人物，注入的记忆可能已经过时'
  }
]

const RULE_BY_ID = Object.fromEntries(CONSISTENCY_RULES.map((r) => [r.id, r]))

/** 多久没更新算「陈旧」 */
export const STALE_CHAPTERS = 30

const SEVERITY_LABELS = { high: '高', medium: '中', low: '低' }
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 }

export function severityLabel(s) {
  return SEVERITY_LABELS[s] || s
}

export function severityRank(s) {
  return SEVERITY_ORDER[s] ?? 3
}

/** 出场方式已经结束的人物。他们再出现在新事件里就是矛盾。 */
const RETIRED_STATUS = ['dead', 'missing']

// ---------------------------------------------------------------------------
// 「故事内时间」的可比化
// ---------------------------------------------------------------------------

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }

/** 中文数字 → 数。只处理万以内的常见写法（十 / 十五 / 二十三），够用且可预期。 */
function cnToNumber(s) {
  let total = 0
  let section = 0
  let num = 0
  for (const c of s) {
    if (CN_DIGITS[c] != null) {
      num = CN_DIGITS[c]
      continue
    }
    if (CN_UNITS[c]) {
      section += (num || 1) * CN_UNITS[c]
      num = 0
      continue
    }
    if (c === '万') {
      total += (section + num) * 10000
      section = 0
      num = 0
      continue
    }
    return NaN
  }
  return total + section + num
}

const isNumChar = (c) =>
  (c >= '0' && c <= '9') || c === '两' || CN_DIGITS[c] != null || !!CN_UNITS[c]

/**
 * 把自由文本的「故事内时间」切成 `{ n, unit }`，切不出来返回 null。
 *
 * n 是字符串里**第一段**数字（含中文数字），unit 是紧跟其后的那段非数字字符：
 * `'1月'` → `{n:1, unit:'月'}`，`'第七天夜里'` → `{n:7, unit:'天夜里'}`，
 * `'三年前'` → `{n:3, unit:'年前'}`。
 *
 * 之所以要连单位一起取出来，是因为调用方只在**两边的 unit 相同**时才敢比较。
 * 只比数字的话，「序章：三年前」与「第一章：1月」会被判成倒挂 —— 而那是
 * 完全正常的插叙写法。这条保守到近乎无用，但它换来的东西更值钱：
 * 用户会相信这张报告上出现的每一条。
 */
export function timeKey(text) {
  const s = String(text || '')
  let i = 0
  while (i < s.length && !isNumChar(s[i])) i++
  if (i >= s.length) return null
  let j = i
  while (j < s.length && isNumChar(s[j])) j++
  const raw = s.slice(i, j)
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : cnToNumber(raw)
  if (!Number.isFinite(n)) return null
  let k = j
  while (k < s.length && !isNumChar(s[k]) && /\S/.test(s[k])) k++
  return { n, unit: s.slice(j, k), at: i }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 跑全部规则检查。
 *
 * @param {object}   opt
 * @param {Array}    opt.chapters    章节（要 order、timelineStart、summary、content）
 * @param {object}   opt.memory      记忆层各集合（characters / events / foreshadowing …）
 * @param {object}   opt.structure   剧情结构各集合（volumes / arcs）
 * @param {Array}    opt.tombstones  墓碑，用来在断链消息里补上「什么时候删的」
 * @returns {{issues: Array, stats: object}}
 */
export function runRuleChecks({ chapters = [], memory = {}, structure = {}, tombstones = [] } = {}) {
  const data = { chapters, ...memory, ...structure }
  const chaptersArr = chapters || []
  const events = data.events || []
  const characters = data.characters || []
  const foreshadowing = data.foreshadowing || []

  const byChapterId = new Map(chaptersArr.map((c) => [c.id, c]))
  const orderOf = new Map(chaptersArr.map((c) => [c.id, c.order ?? 0]))
  const deletedAtOf = new Map((tombstones || []).map((t) => [t.id, t.deletedAt]))

  const issues = []
  const push = (rule, fields) => issues.push({ rule, severity: RULE_BY_ID[rule].severity, ...fields })

  // --- 规则 1：断链引用 -----------------------------------------------------
  // 与时间线上的虚线标记是**同一份实现**（timeline.js 的 findBrokenRefs）。
  // 各算一份的话，早晚出现「轴上画着断链、报告里说没问题」这种局面，
  // 而用户只能信其中一个。
  for (const w of findBrokenRefs(data)) {
    push('brokenRefs', {
      id: `brokenRefs:${w.id}`,
      title: `${w.sourceTitle} · ${w.fieldLabel}指向已不存在的记录`,
      detail: w.message,
      entityType: w.sourceType,
      entityId: w.sourceId,
      chapterId: '',
      // 有墓碑就带上删除时刻，界面显示成「已于 … 删除」——
      // 「不见了」和「被你删了」对排查是两件事
      deletedAt: deletedAtOf.get(w.targetId) ?? null
    })
  }

  // --- 规则 2：已退场人物仍出场 ---------------------------------------------
  for (const ch of characters) {
    if (!RETIRED_STATUS.includes(ch.status)) continue
    // `lastUpdatedChapterId` 是唯一的锚点：没有它，「其后」无从谈起。
    // 退而用「他出现的第一个事件」当锚点是不行的 —— 刚死掉的那个人在他自己
    // 死的那一章里还全是戏，那样写会在每个人物身上立刻误报。
    const anchor = orderOf.get(ch.lastUpdatedChapterId)
    if (anchor == null) continue
    for (const ev of events) {
      if (!(ev.characterIds || []).includes(ch.id)) continue
      const o = orderOf.get(ev.chapterId)
      if (o == null || o <= anchor) continue
      push('deadCharacterAppears', {
        id: `deadCharacterAppears:${ch.id}:${ev.id}`,
        title: `「${ch.name || '未命名'}」已退场，却出现在更靠后的事件里`,
        detail:
          `人物状态是「${ch.status === 'dead' ? '死亡' : '失踪'}」，最后一次更新在第${anchor}章；` +
          `事件「${ev.title || '未命名'}」在第${o}章，仍然把他列为涉及人物。`,
        entityType: 'characters',
        entityId: ch.id,
        chapterId: ev.chapterId
      })
    }
  }

  // --- 规则 3：故事内时间倒挂 -----------------------------------------------
  const sorted = [...chaptersArr].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const ka = timeKey(prev.timelineStart)
    const kb = timeKey(cur.timelineStart)
    // unit 不同就不比。这一步是这条规则**不误报**的全部原因，别删。
    if (!ka || !kb || ka.unit !== kb.unit) continue
    if (kb.n >= ka.n) continue
    push('timelineInverted', {
      id: `timelineInverted:${cur.id}`,
      title: `第${cur.order}章的故事内时间早于第${prev.order}章`,
      detail:
        `第${prev.order}章「${prev.timelineStart}」在前、第${cur.order}章「${cur.timelineStart}」在后，` +
        `时间却是往回走的。若这是有意的倒叙 / 插叙，忽略即可。`,
      entityType: 'chapters',
      entityId: cur.id,
      chapterId: cur.id
    })
  }

  // --- 规则 4：伏笔逾期未回收 -----------------------------------------------
  for (const f of foreshadowing) {
    const reveal = byChapterId.get(f.expectedRevealChapterId)
    if (!overdueForeshadow(f, reveal)) continue
    push('overdueForeshadow', {
      id: `overdueForeshadow:${f.id}`,
      title: `「${f.title || '未命名'}」说好回收的章节已经写完，却还没回收`,
      detail:
        `预计揭示于第${reveal.order}章（该章状态已是「已完成」），伏笔仍停在` +
        `「${f.status === 'planted' ? '已埋下' : '发展中'}」。要么回收它，要么把预计揭示章改到后面。`,
      entityType: 'foreshadowing',
      entityId: f.id,
      chapterId: reveal.id
    })
  }

  // --- 规则 5：重复事件 -----------------------------------------------------
  // 没有章节的事件也一起分组（键是空串）：AI 提取两遍、两条都还没归章，
  // 是真实会发生的重复，而且正是用户最难自己发现的那种。
  const eventGroups = new Map()
  for (const ev of events) {
    const title = normalizeTitle(ev.title)
    if (!title) continue
    const key = `${ev.chapterId || ''}|${title}`
    if (!eventGroups.has(key)) eventGroups.set(key, [])
    eventGroups.get(key).push(ev)
  }
  for (const group of eventGroups.values()) {
    if (group.length < 2) continue
    const first = group[0]
    const where = first.chapterId ? `第${orderOf.get(first.chapterId)}章` : '未归入章节的事件'
    push('duplicateEvent', {
      id: `duplicateEvent:${group.map((e) => e.id).join(':')}`,
      title: `「${first.title}」重复了 ${group.length} 次`,
      detail: `${where}里有 ${group.length} 条同名事件。多半是记忆提取跑了两遍，删掉多余的即可。`,
      entityType: 'events',
      entityId: first.id,
      chapterId: first.chapterId || ''
    })
  }

  // --- 规则 6：章节缺摘要 ---------------------------------------------------
  for (const c of chaptersArr) {
    if (!String(c.content || '').trim()) continue
    if (String(c.summary || '').trim()) continue
    push('missingSummary', {
      id: `missingSummary:${c.id}`,
      title: `第${c.order}章「${c.title || ''}」缺梗概`,
      detail: '这一章已有正文但没有 summary。写后续章节时它不会进入「近期章节摘要」层，等于没发生过。',
      entityType: 'chapters',
      entityId: c.id,
      chapterId: c.id
    })
  }

  // --- 规则 7：人物久未出场 -------------------------------------------------
  const maxOrder = chaptersArr.reduce((m, c) => Math.max(m, c.order ?? 0), 0)
  for (const ch of characters) {
    // 已退场的人物本来就该停在原地，把他们算成「陈旧」是纯噪音
    if (RETIRED_STATUS.includes(ch.status)) continue
    const anchor = orderOf.get(ch.lastUpdatedChapterId)
    if (anchor == null) continue
    if (maxOrder - anchor <= STALE_CHAPTERS) continue
    push('staleCharacter', {
      id: `staleCharacter:${ch.id}`,
      title: `「${ch.name || '未命名'}」已经 ${maxOrder - anchor} 章没有更新`,
      detail: `最后一次更新在第${anchor}章。若他还在故事里，补一下他的现状；若已经退场，把状态改成死亡 / 失踪。`,
      entityType: 'characters',
      entityId: ch.id,
      chapterId: ch.lastUpdatedChapterId
    })
  }

  // 高严重度的排前面，同级别内保持规则清单的顺序（稳定，不会两次渲染两个样）
  const ruleIndex = new Map(CONSISTENCY_RULES.map((r, i) => [r.id, i]))
  issues.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || ruleIndex.get(a.rule) - ruleIndex.get(b.rule)
  )

  const bySeverity = { high: 0, medium: 0, low: 0 }
  const byRule = {}
  for (const r of CONSISTENCY_RULES) byRule[r.id] = 0
  for (const it of issues) {
    bySeverity[it.severity]++
    byRule[it.rule]++
  }

  return {
    issues,
    stats: {
      total: issues.length,
      bySeverity,
      byRule,
      chapters: chaptersArr.length,
      entities: Object.keys(ENTITY_SCHEMAS).reduce((n, k) => n + (data[k] || []).length, 0)
    }
  }
}
