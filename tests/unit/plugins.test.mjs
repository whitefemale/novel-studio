import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLUGIN_SCHEMA_VERSION,
  PLUGIN_LIMITS,
  TEMPLATE_PLACEHOLDERS,
  validatePluginManifest,
  normalizePluginList,
  pluginDisplayName,
  pluginHookCounts
} from '../../src/services/plugins/manifest.js'
import {
  activePlugins,
  pluginContextFragments,
  runPluginRules,
  collectKeywordHints,
  renderTemplateChapters,
  renderExportTemplate,
  validateTemplatePlaceholders,
  pluginTemplates,
  describePluginHooks
} from '../../src/services/plugins/hooks.js'

// ---------------- 测试用清单 ----------------

function raw(over = {}) {
  return {
    schemaVersion: PLUGIN_SCHEMA_VERSION,
    id: 'demo-plugin',
    name: '演示插件',
    version: '1.0.0',
    description: '测试用',
    author: 'tester',
    hooks: {},
    ...over
  }
}

function validated(over = {}) {
  const res = validatePluginManifest(raw(over))
  assert.equal(res.ok, true, `清单应当合法：${res.errors.join('；')}`)
  return res.manifest
}

const FRAG = { title: '写作要求', text: '每章至少出现一次雨声。' }
const RULE = { id: 'forbid-word', title: '禁词', pattern: '禁词', severity: 'high' }
const TPL = { id: 'simple', name: '简版', ext: 'txt', template: '《{{bookTitle}}》共 {{chapterCount}} 章' }
const HINT = { title: '雨', keywords: ['雨声'], hint: '记得处理雨的感官细节' }

// ---------------- manifest 校验 ----------------

test('合法清单被规范化，四个 hook 都拿到数组', () => {
  const m = validated({
    hooks: {
      contextFragments: [FRAG],
      rules: [RULE],
      exportTemplates: [TPL],
      keywordHints: [HINT]
    }
  })
  assert.equal(m.id, 'demo-plugin')
  assert.equal(m.schemaVersion, PLUGIN_SCHEMA_VERSION)
  assert.equal(m.hooks.contextFragments.length, 1)
  assert.equal(m.hooks.rules.length, 1)
  assert.equal(m.hooks.exportTemplates.length, 1)
  assert.equal(m.hooks.keywordHints.length, 1)
  // 规范化后的副本不得保留未知字段
  assert.deepEqual(pluginHookCounts(m), { fragments: 1, rules: 1, templates: 1, hints: 1 })
})

test('缺少 hooks 时补成四个空数组，而不是 undefined', () => {
  const m = validated()
  assert.deepEqual(m.hooks, {
    contextFragments: [],
    rules: [],
    exportTemplates: [],
    keywordHints: []
  })
  assert.equal(describePluginHooks(m), '没有可用的 hook')
})

test('id 必须是小写安全标识', () => {
  for (const id of ['Bad ID', '大写', '', '-leading', 'a'.repeat(65)]) {
    const res = validatePluginManifest(raw({ id }))
    assert.equal(res.ok, false, `id=${JSON.stringify(id)} 应当被拒`)
  }
  assert.equal(validatePluginManifest(raw({ id: 'a' })).ok, true)
  assert.equal(validatePluginManifest(raw({ id: 'a_b-c9' })).ok, true)
})

test('schemaVersion 不匹配时拒绝', () => {
  const res = validatePluginManifest(raw({ schemaVersion: 99 }))
  assert.equal(res.ok, false)
  assert.match(res.errors.join('；'), /schemaVersion/)
  // 缺省视为当前版本，方便手写插件
  assert.equal(validatePluginManifest(raw({ schemaVersion: undefined })).ok, true)
})

test('非对象输入直接拒绝', () => {
  for (const v of [null, [], 'x', 3]) {
    const res = validatePluginManifest(v)
    assert.equal(res.ok, false)
  }
})

test('规则 flags 只允许 gimsuy，重复字符去重', () => {
  const res = validatePluginManifest(
    raw({ hooks: { rules: [{ ...RULE, flags: 'u' }] } })
  )
  assert.equal(res.ok, true)
  const bad = validatePluginManifest(
    raw({ hooks: { rules: [{ ...RULE, flags: 'gx' }] } })
  )
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('；'), /flags/)
})

test('无法编译、或能匹配空字符串的正则被拒', () => {
  const broken = validatePluginManifest(
    raw({ hooks: { rules: [{ ...RULE, pattern: '(unclosed' }] } })
  )
  assert.equal(broken.ok, false)

  for (const pattern of ['', 'a*', '(?:)']) {
    const res = validatePluginManifest(raw({ hooks: { rules: [{ ...RULE, pattern }] } }))
    assert.equal(res.ok, false, `pattern=${JSON.stringify(pattern)} 会匹配空串，应当被拒`)
  }
})

test('规则 id 重复与模板 id 重复被拒', () => {
  const dup = validatePluginManifest(
    raw({ hooks: { rules: [RULE, { ...RULE, pattern: '别的词' }] } })
  )
  assert.equal(dup.ok, false)
  assert.match(dup.errors.join('；'), /重复/)

  const dupTpl = validatePluginManifest(
    raw({ hooks: { exportTemplates: [TPL, { ...TPL, name: '另一个' }] } })
  )
  assert.equal(dupTpl.ok, false)
})

test('数量上限：片段 50 / 规则 100 / 模板 20 / 提示 100', () => {
  const manyFrag = Array.from({ length: PLUGIN_LIMITS.maxFragments + 1 }, () => FRAG)
  assert.equal(validatePluginManifest(raw({ hooks: { contextFragments: manyFrag } })).ok, false)

  const manyRules = Array.from({ length: PLUGIN_LIMITS.maxRules + 1 }, (_, i) => ({
    ...RULE,
    id: `r${i}`
  }))
  assert.equal(validatePluginManifest(raw({ hooks: { rules: manyRules } })).ok, false)

  const manyTpl = Array.from({ length: PLUGIN_LIMITS.maxTemplates + 1 }, (_, i) => ({
    ...TPL,
    id: `t${i}`
  }))
  assert.equal(validatePluginManifest(raw({ hooks: { exportTemplates: manyTpl } })).ok, false)

  const manyHints = Array.from({ length: PLUGIN_LIMITS.maxHints + 1 }, () => HINT)
  assert.equal(validatePluginManifest(raw({ hooks: { keywordHints: manyHints } })).ok, false)
})

test('片段正文/规则模式/模板正文都有长度上限', () => {
  const longFrag = validatePluginManifest(
    raw({
      hooks: { contextFragments: [{ text: '字'.repeat(PLUGIN_LIMITS.maxFragmentChars + 1) }] }
    })
  )
  assert.equal(longFrag.ok, false)

  const longPattern = validatePluginManifest(
    raw({ hooks: { rules: [{ ...RULE, pattern: 'a'.repeat(PLUGIN_LIMITS.maxPatternChars + 1) }] } })
  )
  assert.equal(longPattern.ok, false)

  const longTpl = validatePluginManifest(
    raw({
      hooks: {
        exportTemplates: [{ ...TPL, template: 'a'.repeat(PLUGIN_LIMITS.maxTemplateChars + 1) }]
      }
    })
  )
  assert.equal(longTpl.ok, false)
})

test('关键词提示会去重、丢空词、截断到上限，且至少要有一个词', () => {
  const m = validated({
    hooks: {
      keywordHints: [{ hint: '提示', keywords: ['雨声', '雨声', '  ', '雪', 'x'.repeat(41)] }]
    }
  })
  assert.deepEqual(m.hooks.keywordHints[0].keywords, ['雨声', '雪'])

  const empty = validatePluginManifest(
    raw({ hooks: { keywordHints: [{ hint: '提示', keywords: [] }] } })
  )
  assert.equal(empty.ok, false)
})

test('导出模板扩展名只接受 md，其余回落到 txt', () => {
  const m = validated({
    hooks: {
      exportTemplates: [
        { ...TPL, id: 'a', ext: 'MD' },
        { ...TPL, id: 'b', ext: 'exe' }
      ]
    }
  })
  assert.equal(m.hooks.exportTemplates[0].ext, 'md')
  assert.equal(m.hooks.exportTemplates[1].ext, 'txt')
})

test('pluginDisplayName 在缺 name 时回落到 id', () => {
  assert.equal(pluginDisplayName({ id: 'x' }), 'x')
  assert.equal(pluginDisplayName({ id: 'x', name: '  ' }), 'x')
  assert.equal(pluginDisplayName(null), '未命名插件')
})

// ---------------- 文件清单归一化 ----------------

test('normalizePluginList 隔离坏文件，重复 id 保留第一个', () => {
  const { manifests, errors } = normalizePluginList([
    { name: 'a.json', json: raw() },
    { name: 'broken.json', error: '不是合法 JSON' },
    { name: 'dup.json', json: raw({ id: 'demo-plugin' }) },
    { name: 'bad.json', json: raw({ id: 'Bad ID!' }) }
  ])
  assert.equal(manifests.length, 1)
  assert.equal(manifests[0].id, 'demo-plugin')
  assert.equal(errors.length, 3)
  assert.ok(errors.some((e) => e.file === 'broken.json'))
  assert.ok(errors.some((e) => /重复/.test(e.message)))
})

test('normalizePluginList 对非数组输入返回空结果而不是抛错', () => {
  assert.deepEqual(normalizePluginList(null), { manifests: [], errors: [] })
})

// ---------------- hooks ----------------

test('activePlugins 过滤黑名单；disabledIds 非数组时当作空', () => {
  const a = validated({ id: 'a' })
  const b = validated({ id: 'b' })
  assert.deepEqual(
    activePlugins([a, b], ['b']).map((p) => p.id),
    ['a']
  )
  assert.equal(activePlugins([a], null).length, 1)
})

test('上下文片段：预算放不下的整条跳过，绝不截断', () => {
  const p = validated({
    hooks: {
      contextFragments: [
        { title: '短', text: '短片段' },
        { title: '长', text: '长'.repeat(4000) }
      ]
    }
  })
  const items = pluginContextFragments([p], { budgetTokens: 50 })
  assert.equal(items.length, 1)
  assert.equal(items[0].name, '短')
  assert.equal(items[0].text, '短片段')
  assert.ok(items[0].source.includes('演示插件'))
})

test('上下文片段：预算为 0 / 插件被关掉时不返回任何内容', () => {
  const p = validated({ hooks: { contextFragments: [FRAG] } })
  assert.deepEqual(pluginContextFragments([p], { budgetTokens: 0 }), [])
  assert.deepEqual(pluginContextFragments([p], { budgetTokens: 1000, disabledIds: ['demo-plugin'] }), [])
})

test('上下文片段：多条按顺序消耗预算，放不下的后续条目仍可尝试更小的', () => {
  const p = validated({
    hooks: {
      contextFragments: [
        { title: 'a', text: 'a' },
        { title: 'b', text: 'b'.repeat(3000) },
        { title: 'c', text: 'c' }
      ]
    }
  })
  const items = pluginContextFragments([p], { budgetTokens: 40 })
  assert.deepEqual(items.map((i) => i.name), ['a', 'c'])
})

test('插件规则产出与内置一致性规则同构的问题对象', () => {
  const p = validated({ hooks: { rules: [RULE] } })
  const chapters = [
    { id: 'c1', order: 1, title: '初见', content: '这里有禁词，还有另一个禁词。' },
    { id: 'c2', order: 2, title: '无事', content: '干净的正文。' }
  ]
  const issues = runPluginRules({ manifests: [p], chapters })
  assert.equal(issues.length, 1)
  const it = issues[0]
  assert.equal(it.rule, 'plugin:demo-plugin:forbid-word')
  assert.equal(it.source, 'plugin')
  assert.equal(it.severity, 'high')
  assert.equal(it.chapterId, 'c1')
  assert.match(it.title, /演示插件/)
  assert.match(it.detail, /命中 2 处/)
})

test('没有插件时规则检查返回空数组（干净数据仍为 0 条）', () => {
  assert.deepEqual(runPluginRules({ manifests: [], chapters: [{ id: 'c', order: 1, content: '禁词' }] }), [])
})

test('每章最多 20 条插件问题', () => {
  const rules = Array.from({ length: 30 }, (_, i) => ({
    ...RULE,
    id: `r${i}`,
    pattern: `词${i}`
  }))
  const p = validated({ hooks: { rules } })
  const content = rules.map((r) => r.pattern).join('，')
  const issues = runPluginRules({ manifests: [p], chapters: [{ id: 'c', order: 1, content }] })
  assert.equal(issues.length, 20)
})

test('selectedChapter 有值时只扫这一章', () => {
  const p = validated({ hooks: { rules: [RULE] } })
  const chapters = [
    { id: 'c1', order: 1, content: '禁词' },
    { id: 'c2', order: 2, content: '禁词' }
  ]
  const issues = runPluginRules({ manifests: [p], chapters, selectedChapter: chapters[1] })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].chapterId, 'c2')
})

test('命中数在 999 处封顶', () => {
  const p = validated({ hooks: { rules: [RULE] } })
  const issues = runPluginRules({
    manifests: [p],
    chapters: [{ id: 'c', order: 1, content: '禁词'.repeat(2000) }]
  })
  assert.equal(issues.length, 1)
  assert.match(issues[0].detail, /命中 999\+ 处/)
})

test('关键词提示：命中即返回，同一条 hint 不重复，最多 10 条', () => {
  const p = validated({
    hooks: {
      keywordHints: [
        { title: '雨', keywords: ['雨声'], hint: '空气湿度' },
        { title: '重复', keywords: ['雨声'], hint: '空气湿度' },
        { title: '雪', keywords: ['雪'], hint: '积雪' }
      ]
    }
  })
  const out = collectKeywordHints([p], '窗外传来雨声，雪还没有化。')
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((o) => o.hint), ['空气湿度', '积雪'])
  assert.deepEqual(out[0].matched, ['雨声'])
})

test('关键词提示：空白正文或被关掉的插件返回空', () => {
  const p = validated({ hooks: { keywordHints: [HINT] } })
  assert.deepEqual(collectKeywordHints([p], '   '), [])
  assert.deepEqual(collectKeywordHints([p], '雨声', { disabledIds: ['demo-plugin'] }), [])
})

// ---------------- 导出模板 ----------------

test('renderTemplateChapters 与 buildTxt 的章节标题格式一致', () => {
  const text = renderTemplateChapters([
    { order: 1, title: '初见', content: '正文一' },
    { order: 2, title: '', content: '' }
  ])
  assert.equal(text, '第1章 初见\n\n正文一\n\n第2章')
})

test('renderExportTemplate 替换全部已知占位符', () => {
  const out = renderExportTemplate(
    '《{{bookTitle}}》\n{{intro}}\n共 {{chapterCount}} 章\n{{chapters}}\n{{date}}',
    {
      book: { title: '测试书', intro: '简介' },
      chapters: [{ order: 1, title: '章一', content: '正文' }],
      date: new Date(2026, 9, 24)
    }
  )
  assert.match(out, /《测试书》/)
  assert.match(out, /简介/)
  assert.match(out, /共 1 章/)
  assert.match(out, /第1章 章一\n\n正文/)
  assert.match(out, /2026-10-24/)
})

test('renderExportTemplate 保留未知占位符原样', () => {
  const out = renderExportTemplate('{{bookTitle}} / {{titel}} / {{ 中文 }}', {
    book: { title: '书' }
  })
  assert.equal(out, '书 / {{titel}} / {{ 中文 }}')
})

test('renderExportTemplate 对缺失书名回落到「未命名」，对空模板返回空串', () => {
  assert.equal(renderExportTemplate('{{bookTitle}}', {}), '未命名')
  assert.equal(renderExportTemplate('', {}), '')
  assert.equal(renderExportTemplate(null, {}), '')
})

test('validateTemplatePlaceholders 列出未知占位符且去重', () => {
  const ok = validateTemplatePlaceholders('{{bookTitle}} {{chapters}}')
  assert.deepEqual(ok, { ok: true, unknown: [] })
  const bad = validateTemplatePlaceholders('{{bookTitle}} {{titel}} {{titel}} {{x}}')
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.unknown, ['titel', 'x'])
  // 占位符清单必须与渲染器认识的一致
  assert.ok(TEMPLATE_PLACEHOLDERS.includes('bookTitle'))
})

test('pluginTemplates 给出稳定的 key 与完整名称，并遵守黑名单', () => {
  const p = validated({ hooks: { exportTemplates: [TPL] } })
  const list = pluginTemplates([p])
  assert.equal(list.length, 1)
  assert.equal(list[0].key, 'demo-plugin:simple')
  assert.equal(list[0].name, '演示插件 · 简版')
  assert.equal(list[0].ext, 'txt')
  assert.deepEqual(pluginTemplates([p], { disabledIds: ['demo-plugin'] }), [])
})

test('describePluginHooks 汇总非空 hook 数量', () => {
  const p = validated({
    hooks: { contextFragments: [FRAG], rules: [RULE] }
  })
  assert.equal(describePluginHooks(p), '1 段上下文 · 1 条规则')
})
