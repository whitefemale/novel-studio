import { estimateTokens } from '../ai/tokenUsage.js'
import { TEMPLATE_PLACEHOLDERS, pluginDisplayName } from './manifest.js'

/**
 * 插件四个 hook 的执行逻辑（纯函数）。
 *
 * 四条共同纪律：
 *
 * 1. **不执行任何插件代码**。这里的输入是已校验的 JSON；规则只被编译成
 *    正则表达式，片段与模板只当字符串处理。
 * 2. **输入有上限**。正文截到 20 万字再匹配、每章最多报 20 条、每类结果
 *    都有数量上限——ReDoS 无法根除，能做的只有把单次代价框住。
 * 3. **插件问题只进「检查报告」，不阻断写作**。与内置一致性规则同级别：
 *    列出来、让用户自己判断。
 * 4. **关键词提示不自动进提示词**。它是一条给人看的提醒，不是上下文。
 */

/**
 * 被用户关掉的插件不做任何事。`disabledIds` 是设置里的黑名单；
 * 全局开关 `settings.plugins.enabled` 由调用方先行判断（store 里做）。
 */
export function activePlugins(manifests, disabledIds = []) {
  const off = new Set(Array.isArray(disabledIds) ? disabledIds : [])
  return (Array.isArray(manifests) ? manifests : []).filter((p) => p && !off.has(p.id))
}

/**
 * 插件提供的固定上下文片段 → Context Builder 的层条目。
 *
 * 预算从 `settings.plugins.contextBudget` 来。放不下的**整条跳过**而不是截断：
 * 一条被拦腰截断的写作要求比没有更危险，模型会把半句话当完整规则执行。
 */
export function pluginContextFragments(manifests, options = {}) {
  const disabledIds = options.disabledIds || []
  const limit = Math.max(0, Number(options.budgetTokens) || 0)
  if (!limit) return []
  const items = []
  let left = limit
  for (const plugin of activePlugins(manifests, disabledIds)) {
    const pluginName = pluginDisplayName(plugin)
    for (const frag of plugin.hooks?.contextFragments || []) {
      const text = String(frag.text || '').trim()
      if (!text) continue
      const tokens = estimateTokens(text)
      if (tokens > left) continue
      items.push({
        name: frag.title || pluginName,
        text,
        source: `插件「${pluginName}」`,
        reason: 'plugin'
      })
      left -= tokens
    }
  }
  return items
}

/**
 * 单条规则的匹配。**只做字面正则匹配**，不理解语义。
 * 命中数在 999 处封顶：再多的数量对用户没有意义，而正则本身可能很慢。
 */
function matchRule(rule, input) {
  const flags = rule.flags.includes('g') ? rule.flags : rule.flags + 'g'
  let re
  try {
    re = new RegExp(rule.pattern, flags)
  } catch {
    return { hits: 0, snippet: '' }
  }
  let hits = 0
  let snippet = ''
  try {
    for (const m of input.matchAll(re)) {
      hits++
      if (!snippet) {
        const at = Number(m.index) || 0
        snippet = input.slice(Math.max(0, at - 20), Math.min(input.length, at + 60)).trim()
      }
      if (hits >= 999) break
    }
  } catch {
    // 极少数正则在某些输入上会抛错；一条规则坏掉不该让整份报告消失
    return { hits: 0, snippet: '' }
  }
  return { hits, snippet }
}

/**
 * 跑插件规则，返回与内置一致性规则同构的问题对象。
 *
 * `selectedChapter` 有值时只查这一章（一致性面板里选中的章），否则查全部。
 * 每章最多 `MAX_ISSUES_PER_CHAPTER` 条，避免一个宽泛规则把整本报告淹没。
 */
export function runPluginRules(options = {}) {
  const {
    manifests = [],
    chapters = [],
    selectedChapter = null,
    disabledIds = []
  } = options
  const active = activePlugins(manifests, disabledIds)
  if (!active.length) return []

  const scoped = selectedChapter ? [selectedChapter] : chapters || []
  const MAX_ISSUES_PER_CHAPTER = 20
  const MAX_SCAN_CHARS = 200000
  const issues = []

  for (const ch of scoped) {
    if (!ch) continue
    const raw = `${ch.title || ''}\n${ch.content || ''}`
    const input = raw.slice(0, MAX_SCAN_CHARS)
    if (!input.trim()) continue
    let count = 0
    for (const plugin of active) {
      if (count >= MAX_ISSUES_PER_CHAPTER) break
      const pluginName = pluginDisplayName(plugin)
      for (const rule of plugin.hooks?.rules || []) {
        if (count >= MAX_ISSUES_PER_CHAPTER) break
        const { hits, snippet } = matchRule(rule, input)
        if (!hits) continue
        count++
        const where = ch.title ? `第${ch.order}章《${ch.title}》` : `第${ch.order}章`
        issues.push({
          id: `plugin:${plugin.id}:${rule.id}:${ch.id}`,
          rule: `plugin:${plugin.id}:${rule.id}`,
          severity: rule.severity,
          source: 'plugin',
          pluginId: plugin.id,
          pluginName,
          chapterId: ch.id,
          title: `${pluginName} · ${rule.title}`,
          detail:
            `插件规则在${where}命中 ${hits}${hits >= 999 ? '+' : ''} 处。` +
            (rule.message ? `${rule.message}` : '') +
            (snippet ? ` 例：「${snippet}」` : '')
        })
      }
    }
  }
  return issues
}

/**
 * 关键词提示：给用户看的一条提醒，**不进入提示词**。
 *
 * 关键词按字面包含判断。返回至多 10 条，且同一条 hint 只出现一次。
 */
export function collectKeywordHints(manifests, text, options = {}) {
  const disabledIds = options.disabledIds || []
  const limit = Math.max(0, Number(options.limit) || 10)
  const input = String(text || '').slice(0, 200000)
  if (!input.trim() || !limit) return []
  const out = []
  const seen = new Set()
  for (const plugin of activePlugins(manifests, disabledIds)) {
    const pluginName = pluginDisplayName(plugin)
    for (const item of plugin.hooks?.keywordHints || []) {
      const matched = (item.keywords || []).filter((k) => k && input.includes(k))
      if (!matched.length) continue
      if (seen.has(item.hint)) continue
      seen.add(item.hint)
      out.push({
        pluginId: plugin.id,
        pluginName,
        title: item.title || pluginName,
        hint: item.hint,
        matched
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

function formatDate(date) {
  if (date == null) return ''
  if (typeof date === 'string') return date
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 导出模板里的章节文本：与 buildTxt 的章节标题格式保持一致。 */
export function renderTemplateChapters(chapters) {
  return (chapters || [])
    .map((c) => {
      if (!c) return ''
      const title = c.title ? `第${c.order}章 ${c.title}` : `第${c.order}章`
      const body = String(c.content || '')
      return body ? `${title}\n\n${body}` : title
    })
    .filter(Boolean)
    .join('\n\n')
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

/**
 * 渲染导出模板。**未知占位符原样保留**——用户写错了 `{{titel}}` 时，
 * 导出的文件里会明明白白留着这 7 个字符，而不是被静默替换成空串。
 */
export function renderExportTemplate(template, data = {}) {
  const chapters = data.chapters || []
  const values = {
    bookTitle: String(data.book?.title || '未命名'),
    intro: String(data.book?.intro || ''),
    chapters: renderTemplateChapters(chapters),
    chapterCount: String(chapters.length),
    date: formatDate(data.date)
  }
  return String(template || '').replace(PLACEHOLDER_RE, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m
  )
}

/** 列出模板里的未知占位符（给「检查模板」用，不阻断导出）。 */
export function validateTemplatePlaceholders(template) {
  const unknown = []
  for (const m of String(template || '').matchAll(PLACEHOLDER_RE)) {
    if (!TEMPLATE_PLACEHOLDERS.includes(m[1]) && !unknown.includes(m[1])) unknown.push(m[1])
  }
  return { ok: unknown.length === 0, unknown }
}

/** 所有启用插件提供的导出模板，供 ExportModal 的下拉框使用。 */
export function pluginTemplates(manifests, options = {}) {
  const disabledIds = options.disabledIds || []
  const out = []
  for (const plugin of activePlugins(manifests, disabledIds)) {
    const pluginName = pluginDisplayName(plugin)
    for (const tpl of plugin.hooks?.exportTemplates || []) {
      out.push({
        key: `${plugin.id}:${tpl.id}`,
        pluginId: plugin.id,
        pluginName,
        id: tpl.id,
        name: `${pluginName} · ${tpl.name}`,
        ext: tpl.ext,
        template: tpl.template
      })
    }
  }
  return out
}

/** 供界面显示「这个插件会做什么」的一句话摘要。 */
export function describePluginHooks(plugin) {
  const h = plugin?.hooks || {}
  const parts = []
  const n = (arr) => (Array.isArray(arr) ? arr.length : 0)
  if (n(h.contextFragments)) parts.push(`${n(h.contextFragments)} 段上下文`)
  if (n(h.rules)) parts.push(`${n(h.rules)} 条规则`)
  if (n(h.exportTemplates)) parts.push(`${n(h.exportTemplates)} 个导出模板`)
  if (n(h.keywordHints)) parts.push(`${n(h.keywordHints)} 条关键词提示`)
  return parts.length ? parts.join(' · ') : '没有可用的 hook'
}
