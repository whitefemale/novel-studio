/**
 * 声明式插件的清单校验（纯函数）。
 *
 * 插件是用户（或第三方）放在 `userData/plugins/*.json` 的**纯数据**。
 * 本项目**绝不执行插件代码**：没有 `eval`、没有 `Function`、没有模块加载，
 * 也没有网络 / 密钥 / 文件系统能力。插件能做的事只有四件，全部由这里的
 * 四个 hook 预先限定：
 *
 *   contextFragments —— 一段固定文字，进提示词（受 token 预算约束）
 *   rules            —— 一条正则，在正文里找问题（只做字面匹配）
 *   exportTemplates  —— 一个带占位符的导出模板
 *   keywordHints     —— 关键词提示（只显示给用户，不自动注入）
 *
 * 校验刻意严格：id 必须安全、数量与长度都有上限、正则必须能预编译且
 * 不能匹配空字符串。清单不合法时**整个插件不加载**，并给出具体原因；
 * 一个坏插件不影响其他插件。
 */

export const PLUGIN_SCHEMA_VERSION = 1

export const PLUGIN_LIMITS = {
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxFragments: 50,
  maxRules: 100,
  maxTemplates: 20,
  maxHints: 100,
  maxFragmentChars: 4000,
  maxPatternChars: 500,
  maxTemplateChars: 100000,
  maxNameChars: 80,
  maxDescriptionChars: 500,
  maxMessageChars: 500,
  maxHintChars: 500,
  maxKeywordsPerHint: 20,
  maxKeywordChars: 40
}

export const HOOK_KEYS = ['contextFragments', 'rules', 'exportTemplates', 'keywordHints']
export const RULE_SEVERITIES = ['low', 'medium', 'high']
export const RULE_FLAGS_ALLOWED = 'gimsuy'
export const TEMPLATE_PLACEHOLDERS = ['bookTitle', 'intro', 'chapters', 'chapterCount', 'date']

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/
const RULE_ID_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const text = (v) => (typeof v === 'string' ? v : '')
const trim = (v) => text(v).trim()

function readFlags(v) {
  const raw = trim(v)
  if (!raw) return 'g'
  let out = ''
  for (const ch of raw) {
    if (!RULE_FLAGS_ALLOWED.includes(ch)) return null
    if (!out.includes(ch)) out += ch
  }
  return out
}

/** 预编译一次正则；拿不到就说明这条规则不可用。 */
function compileRule(pattern, flags) {
  try {
    // 能匹配空字符串的规则会在一段正文里命中成千上万次，计数毫无意义，
    // 也很容易把界面刷满。一律拒收。
    const m = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g').exec('')
    if (m && m[0] === '') return null
    return true
  } catch {
    return false
  }
}

/**
 * 校验并规范化一个插件清单。
 *
 * @returns {{ok: boolean, manifest: object|null, errors: string[], file: string}}
 *   `ok` 为真时 `manifest` 是**规范化后的副本**：数组一定存在、字段一定
 *   是字符串。调用方不必再做防御性读取。
 */
export function validatePluginManifest(raw, options = {}) {
  const file = trim(options.file)
  const errors = []
  const fail = (msg) => errors.push(msg)

  if (!isObj(raw)) {
    return { ok: false, manifest: null, errors: ['插件文件必须是一个 JSON 对象'], file }
  }

  const schemaVersion = raw.schemaVersion == null ? PLUGIN_SCHEMA_VERSION : Number(raw.schemaVersion)
  if (schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    fail(`不支持的插件 schemaVersion：${raw.schemaVersion}（本版本只认 ${PLUGIN_SCHEMA_VERSION}）`)
  }

  const id = trim(raw.id)
  if (!PLUGIN_ID_RE.test(id)) {
    fail('插件 id 必须是 1–64 位小写字母、数字、连字符或下划线，且以字母或数字开头')
  }

  const name = trim(raw.name) || id
  if (name.length > PLUGIN_LIMITS.maxNameChars) {
    fail(`插件名称不能超过 ${PLUGIN_LIMITS.maxNameChars} 个字符`)
  }
  const description = trim(raw.description)
  if (description.length > PLUGIN_LIMITS.maxDescriptionChars) {
    fail(`插件描述不能超过 ${PLUGIN_LIMITS.maxDescriptionChars} 个字符`)
  }

  const hooksIn = isObj(raw.hooks) ? raw.hooks : {}
  if (raw.hooks != null && !isObj(raw.hooks)) fail('hooks 必须是一个对象')

  // ---- contextFragments ----
  const fragments = []
  const fragIn = hooksIn.contextFragments
  if (fragIn != null && !Array.isArray(fragIn)) fail('hooks.contextFragments 必须是数组')
  if (Array.isArray(fragIn)) {
    if (fragIn.length > PLUGIN_LIMITS.maxFragments) {
      fail(`上下文片段最多 ${PLUGIN_LIMITS.maxFragments} 条`)
    }
    fragIn.slice(0, PLUGIN_LIMITS.maxFragments).forEach((f, i) => {
      if (!isObj(f)) {
        fail(`contextFragments[${i}] 必须是对象`)
        return
      }
      const body = trim(f.text)
      if (!body) {
        fail(`contextFragments[${i}].text 不能为空`)
        return
      }
      if (body.length > PLUGIN_LIMITS.maxFragmentChars) {
        fail(`contextFragments[${i}].text 不能超过 ${PLUGIN_LIMITS.maxFragmentChars} 个字符`)
        return
      }
      fragments.push({ title: trim(f.title).slice(0, PLUGIN_LIMITS.maxNameChars), text: body })
    })
  }

  // ---- rules ----
  const rules = []
  const ruleIn = hooksIn.rules
  if (ruleIn != null && !Array.isArray(ruleIn)) fail('hooks.rules 必须是数组')
  if (Array.isArray(ruleIn)) {
    if (ruleIn.length > PLUGIN_LIMITS.maxRules) fail(`规则最多 ${PLUGIN_LIMITS.maxRules} 条`)
    const seen = new Set()
    ruleIn.slice(0, PLUGIN_LIMITS.maxRules).forEach((r, i) => {
      if (!isObj(r)) {
        fail(`rules[${i}] 必须是对象`)
        return
      }
      const ruleId = trim(r.id)
      if (!RULE_ID_RE.test(ruleId)) {
        fail(`rules[${i}].id 必须是 1–32 位小写字母、数字、连字符或下划线`)
        return
      }
      if (seen.has(ruleId)) {
        fail(`rules[${i}].id 重复：${ruleId}`)
        return
      }
      const pattern = text(r.pattern)
      if (!pattern.trim()) {
        fail(`rules[${i}].pattern 不能为空`)
        return
      }
      if (pattern.length > PLUGIN_LIMITS.maxPatternChars) {
        fail(`rules[${i}].pattern 不能超过 ${PLUGIN_LIMITS.maxPatternChars} 个字符`)
        return
      }
      const flags = readFlags(r.flags)
      if (flags === null) {
        fail(`rules[${i}].flags 只允许 ${RULE_FLAGS_ALLOWED}`)
        return
      }
      if (!compileRule(pattern, flags)) {
        fail(`rules[${i}] 的正则无法编译，或会匹配空字符串`)
        return
      }
      const severity = RULE_SEVERITIES.includes(r.severity) ? r.severity : 'medium'
      const title = trim(r.title) || ruleId
      const message = trim(r.message)
      if (title.length > PLUGIN_LIMITS.maxNameChars) {
        fail(`rules[${i}].title 不能超过 ${PLUGIN_LIMITS.maxNameChars} 个字符`)
        return
      }
      if (message.length > PLUGIN_LIMITS.maxMessageChars) {
        fail(`rules[${i}].message 不能超过 ${PLUGIN_LIMITS.maxMessageChars} 个字符`)
        return
      }
      seen.add(ruleId)
      rules.push({ id: ruleId, title, pattern, flags, severity, message })
    })
  }

  // ---- exportTemplates ----
  const templates = []
  const tplIn = hooksIn.exportTemplates
  if (tplIn != null && !Array.isArray(tplIn)) fail('hooks.exportTemplates 必须是数组')
  if (Array.isArray(tplIn)) {
    if (tplIn.length > PLUGIN_LIMITS.maxTemplates) {
      fail(`导出模板最多 ${PLUGIN_LIMITS.maxTemplates} 条`)
    }
    const seen = new Set()
    tplIn.slice(0, PLUGIN_LIMITS.maxTemplates).forEach((t, i) => {
      if (!isObj(t)) {
        fail(`exportTemplates[${i}] 必须是对象`)
        return
      }
      const tplId = trim(t.id)
      if (!RULE_ID_RE.test(tplId)) {
        fail(`exportTemplates[${i}].id 必须是 1–32 位小写字母、数字、连字符或下划线`)
        return
      }
      if (seen.has(tplId)) {
        fail(`exportTemplates[${i}].id 重复：${tplId}`)
        return
      }
      const body = text(t.template)
      if (!body.trim()) {
        fail(`exportTemplates[${i}].template 不能为空`)
        return
      }
      if (body.length > PLUGIN_LIMITS.maxTemplateChars) {
        fail(`exportTemplates[${i}].template 不能超过 ${PLUGIN_LIMITS.maxTemplateChars} 个字符`)
        return
      }
      const ext = trim(t.ext).toLowerCase() === 'md' ? 'md' : 'txt'
      seen.add(tplId)
      templates.push({
        id: tplId,
        name: trim(t.name) || tplId,
        ext,
        template: body
      })
    })
  }

  // ---- keywordHints ----
  const hints = []
  const hintIn = hooksIn.keywordHints
  if (hintIn != null && !Array.isArray(hintIn)) fail('hooks.keywordHints 必须是数组')
  if (Array.isArray(hintIn)) {
    if (hintIn.length > PLUGIN_LIMITS.maxHints) {
      fail(`关键词提示最多 ${PLUGIN_LIMITS.maxHints} 条`)
    }
    hintIn.slice(0, PLUGIN_LIMITS.maxHints).forEach((h, i) => {
      if (!isObj(h)) {
        fail(`keywordHints[${i}] 必须是对象`)
        return
      }
      const hint = trim(h.hint)
      if (!hint) {
        fail(`keywordHints[${i}].hint 不能为空`)
        return
      }
      if (hint.length > PLUGIN_LIMITS.maxHintChars) {
        fail(`keywordHints[${i}].hint 不能超过 ${PLUGIN_LIMITS.maxHintChars} 个字符`)
        return
      }
      const keywordsIn = Array.isArray(h.keywords) ? h.keywords : []
      const keywords = [
        ...new Set(
          keywordsIn
            .map((k) => trim(k))
            .filter(Boolean)
            .filter((k) => k.length <= PLUGIN_LIMITS.maxKeywordChars)
        )
      ].slice(0, PLUGIN_LIMITS.maxKeywordsPerHint)
      if (!keywords.length) {
        fail(`keywordHints[${i}].keywords 至少需要一个不超过 ${PLUGIN_LIMITS.maxKeywordChars} 字的词`)
        return
      }
      hints.push({ title: trim(h.title).slice(0, PLUGIN_LIMITS.maxNameChars), keywords, hint })
    })
  }

  if (errors.length) return { ok: false, manifest: null, errors, file }

  return {
    ok: true,
    file,
    errors: [],
    manifest: {
      schemaVersion: PLUGIN_SCHEMA_VERSION,
      id,
      name,
      version: trim(raw.version).slice(0, 40),
      description,
      author: trim(raw.author).slice(0, 80),
      hooks: {
        contextFragments: fragments,
        rules,
        exportTemplates: templates,
        keywordHints: hints
      }
    }
  }
}

/**
 * 把主进程读到的文件列表规范化成「可用插件 + 逐个文件的错误」。
 * 坏文件只影响它自己；id 重复时保留先出现的那个（文件名排序后的第一个），
 * 后面的报错，而不是让两个同名插件互相覆盖。
 */
export function normalizePluginList(files) {
  const manifests = []
  const errors = []
  const seen = new Set()
  for (const f of Array.isArray(files) ? files : []) {
    const file = trim(f?.name) || '(未命名)'
    if (f?.error) {
      errors.push({ file, message: String(f.error) })
      continue
    }
    const res = validatePluginManifest(f?.json, { file })
    if (!res.ok) {
      errors.push({ file, message: res.errors.join('；') })
      continue
    }
    if (seen.has(res.manifest.id)) {
      errors.push({ file, message: `插件 id 与前面的文件重复：${res.manifest.id}` })
      continue
    }
    seen.add(res.manifest.id)
    manifests.push(res.manifest)
  }
  return { manifests, errors }
}

export function pluginDisplayName(plugin) {
  return trim(plugin?.name) || trim(plugin?.id) || '未命名插件'
}

export function pluginHookCounts(plugin) {
  const h = plugin?.hooks || {}
  return {
    fragments: (h.contextFragments || []).length,
    rules: (h.rules || []).length,
    templates: (h.exportTemplates || []).length,
    hints: (h.keywordHints || []).length
  }
}
