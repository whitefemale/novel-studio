/**
 * 文风档案 → 提示词的一小层。
 *
 * 文风最难「说清楚」：写「文笔优美」没有信息量，而给一段三千字的样本又会把
 * 上下文预算吃掉一大半，且模型容易逐句模仿样本里的具体情节。折中做法是
 * **结构化描述 + 极短的样本节选**，全部压成十几行，并让它以较高优先级注入。
 *
 * 纯函数，无 I/O。
 */

import { STYLE_POV, STYLE_TENSE } from './schemas.js'

/** 各字段注入时的最大长度。样本刻意只取 300 字：它是「腔调示例」，不是正文续写素材。 */
const LIMITS = {
  sentenceRhythm: 160,
  dialogueRatio: 80,
  vocabulary: 160,
  bannedExpressions: 200,
  characterVoices: 240,
  sample: 300
}

function clip(text, limit) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  return s.length <= limit ? s : `${s.slice(0, limit)}…`
}

function optionLabel(options, value) {
  if (!value) return ''
  const hit = (options || []).find((o) => o.value === value)
  return hit ? hit.label : String(value)
}

/**
 * 当前启用的文风档案。
 *
 * 有且只有一个 `active` 时用它；用户忘了勾时回退到第一条 —— 建了一份档案
 * 却完全不起作用，比「用了错的那份」更难发现。列表为空时返回 null。
 */
export function activeStyleProfile(list) {
  const arr = (list || []).filter((p) => p && String(p.title ?? '').trim())
  if (!arr.length) return null
  return arr.find((p) => p.active) || arr[0]
}

/**
 * 把一份文风档案渲染成注入文本。空字段一律不写 —— 「禁止表达：」这种空标题
 * 只会浪费预算，还会让模型以为确实有一条空白禁令。
 */
export function renderStyleProfile(profile) {
  if (!profile) return ''
  const parts = []
  const title = String(profile.title || '').trim()
  if (title) parts.push(`文风档案：${title}`)

  const pov = optionLabel(STYLE_POV, profile.pov)
  const tense = optionLabel(STYLE_TENSE, profile.tense)
  if (pov) parts.push(`叙事视角：${pov}`)
  if (tense) parts.push(`时态：${tense}`)

  const fields = [
    ['sentenceRhythm', '句式节奏'],
    ['dialogueRatio', '对白比例'],
    ['vocabulary', '词汇倾向'],
    ['bannedExpressions', '禁用表达'],
    ['characterVoices', '人物语气']
  ]
  for (const [key, label] of fields) {
    const v = clip(profile[key], LIMITS[key])
    if (v) parts.push(`${label}：${v}`)
  }
  const sample = clip(profile.sample, LIMITS.sample)
  if (sample) parts.push(`腔调样本（只学语气与节奏，不要照搬内容）：\n${sample}`)

  // 只有标题时也算有内容：用户可能正在一步步补全，至少让模型知道这份档案存在。
  return parts.join('\n')
}

/**
 * Context Builder 用的入口：按开关取当前档案的注入文本。
 * `includeStyle` 关闭时返回空串，与人物/大纲/世界观三个开关语义一致。
 */
export function styleProfileText(list, enabled = true) {
  if (enabled === false) return ''
  return renderStyleProfile(activeStyleProfile(list))
}

/** 档案的简要说明，列表与统计面板共用。 */
export function describeStyleProfile(profile) {
  if (!profile) return ''
  const bits = []
  const pov = optionLabel(STYLE_POV, profile.pov)
  if (pov) bits.push(pov)
  const tense = optionLabel(STYLE_TENSE, profile.tense)
  if (tense) bits.push(tense)
  if (profile.active) bits.push('当前启用')
  return bits.join(' · ')
}
