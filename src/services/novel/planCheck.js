import { countWords } from '../wordCount.js'
import { CHAPTER_PLAN_FIELDS } from './schemas.js'

/**
 * 施工卡完成度检查：**确定性、零成本、不调用 AI**。
 *
 * 这是「施工卡」相对于「大纲」的价值所在 —— 设定了必须发生的事件、禁止内容和
 * 验收标准之后，代码可以在正文生成完的瞬间回答「这一章按计划写了吗」。
 * 它不判断文学质量，也不假装能判断：关键词命中只说明「这层意思出现过」，
 * 所以每条结果的文案都带「仅供参考」。
 *
 * 纯函数，输入正文与章节对象，输出 issue 列表。
 */

const WORD_TOLERANCE = 0.2

/** 把多行 / 逗号分隔的条目拆成独立短语。 */
export function splitPlanTerms(text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  return s
    .split(/[\n\r]+|[，,、；;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, '')
}

/**
 * 关键词是否出现在正文里。
 *
 * 长条目（一句完整的要求）不要求逐字出现 —— 正文不会照抄规划句。退一步：
 * 条目里用逗号分隔的每一段都命中才算命中；没有分隔时只要求原文包含该条目。
 * 这是刻意的「宁可漏报」：误报会让用户不再看这份检查。
 */
export function matchesTerm(content, term) {
  const c = norm(content)
  const t = norm(term)
  if (!c || !t) return false
  if (c.includes(t)) return true
  if (t.length <= 6) return false
  const parts = String(term)
    .split(/[，,、；;]/)
    .map(norm)
    .filter((x) => x.length >= 2)
  if (parts.length < 2) return false
  return parts.every((p) => c.includes(p))
}

/** 施工卡里有值的字段数 / 总字段数。给界面显示「填了几项」。 */
export function planCompleteness(chapter) {
  const fields = CHAPTER_PLAN_FIELDS
  const filled = fields.filter((f) => {
    const v = chapter?.[f.key]
    return f.type === 'number' ? Number(v) > 0 : String(v ?? '').trim() !== ''
  }).length
  return { filled, total: fields.length, ratio: fields.length ? filled / fields.length : 0 }
}

/**
 * 检查一章正文与它的施工卡。
 *
 * @returns {{ ok: boolean, issues: Array, stats: object }}
 *   issues[].field 指向施工卡字段，界面据此高亮；severity 只有 high / low 两档
 *   （这不是审校，中档严重度没有行动差异）。
 */
export function checkChapterPlan(chapter, content = chapter?.content, { characters = [] } = {}) {
  const issues = []
  const text = String(content ?? '')
  const words = countWords(text).total
  const target = Number(chapter?.targetWords) || 0
  const push = (field, severity, message) =>
    issues.push({ id: `plan:${chapter?.id || '?'}:${field}`, field, severity, message })

  if (target > 0 && text.trim()) {
    const deviation = (words - target) / target
    if (Math.abs(deviation) > WORD_TOLERANCE * 2.5) {
      push(
        'targetWords',
        'high',
        `目标 ${target} 字，实际 ${words} 字（${deviation > 0 ? '超出' : '不足'} ${Math.round(Math.abs(deviation) * 100)}%）`
      )
    } else if (Math.abs(deviation) > WORD_TOLERANCE) {
      push(
        'targetWords',
        'low',
        `目标 ${target} 字，实际 ${words} 字（偏差 ${Math.round(Math.abs(deviation) * 100)}%）`
      )
    }
  }

  // 空正文不产生任何内容类问题：这一章可能只是还没写，报「没按计划写」是噪音。
  // 施工卡本身填没填，由 planCompleteness 单独回答。
  if (text.trim()) {
    // 禁止内容优先报：它一旦出现就是硬伤，不该被「必须事件没写」的噪音淹没。
    for (const term of splitPlanTerms(chapter?.forbidden)) {
      if (matchesTerm(text, term)) {
        push('forbidden', 'high', `禁止内容出现了：「${term}」`)
      }
    }

    for (const term of splitPlanTerms(chapter?.mustEvents)) {
      if (!matchesTerm(text, term)) {
        push('mustEvents', 'low', `必须发生的事件没有找到对应文字：「${term}」（关键词匹配，仅供参考）`)
      }
    }

    for (const term of splitPlanTerms(chapter?.acceptance)) {
      if (!matchesTerm(text, term)) {
        push('acceptance', 'low', `验收标准没有命中：「${term}」（关键词匹配，仅供参考）`)
      }
    }
  }

  // 视角人物只在正文明确提到名字时才检查：很多章节用「他」写满一整章，
  // 按名字不在正文里报错会制造大量误报。
  const pov = characters.find((c) => c.id === chapter?.povCharacterId)
  const povName = String(pov?.name || '').trim()
  if (povName && text.trim() && !text.includes(povName)) {
    push('povCharacterId', 'low', `视角人物「${povName}」的名字没有出现在正文里，请确认视角没有跑偏`)
  }

  // 空正文不产生问题：这一章可能只是还没写，报「没按计划写」是噪音。
  return {
    ok: issues.length === 0,
    issues,
    stats: {
      words,
      target,
      deviation: target > 0 ? (words - target) / target : null,
      checkedFields: ['targetWords', 'forbidden', 'mustEvents', 'acceptance'].filter((k) =>
        String(chapter?.[k] ?? '').trim()
      ),
      planCompleteness: planCompleteness(chapter)
    }
  }
}
