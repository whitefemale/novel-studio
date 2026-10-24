import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_VALIDATION_VERSION,
  normalizePlanCandidate,
  validatePlan,
  shouldBlockPlan,
  validationSummary,
  bigramDice
} from '../../src/services/novel/planValidate.js'

const chapters = [
  { id: 'c1', order: 1, title: '第一章', purpose: '主角醒来', summary: '雨夜醒来' },
  { id: 'c2', order: 2, title: '第二章', purpose: '初见师父', summary: '拜师' },
  {
    id: 'c3',
    order: 3,
    title: '第三章',
    purpose: '主角与师父在雨中决裂',
    summary: '雨夜的争执让两人分道扬镳'
  },
  { id: 'c4', order: 4, title: '第四章', purpose: '独自上路', summary: '踏上旅程' },
  { id: 'c5', order: 5, title: '第五章', purpose: '抵达山门', summary: '抵达' },
  { id: 'c6', order: 6, title: '第六章', purpose: '', summary: '' },
  { id: 'c8', order: 8, title: '第八章', purpose: '', summary: '' }
]

const chapter = { id: 'c5', order: 5, title: '第五章', arcId: 'a1' }

const memory = {
  characters: [
    { id: 'su', name: '苏九', aliases: ['九爷'], status: 'dead' },
    { id: 'lin', name: '林舟', aliases: [], status: 'alive' }
  ],
  factions: [{ id: 'f1', name: '血河宗', status: 'destroyed' }],
  events: [{ id: 'e1', title: '宗门覆灭', chapterId: 'c6' }],
  worldRules: [
    { id: 'w1', title: '灵气不可逆', coreImmutable: true, priority: 100 },
    { id: 'w2', title: '日升月落', coreImmutable: false, priority: 10 }
  ],
  foreshadowing: [
    { id: 'fs1', title: '断剑秘密', status: 'planted', expectedRevealChapterId: 'c8' }
  ],
  locations: [],
  scenes: []
}

const structure = {
  arcs: [{ id: 'a1', title: '破局', volumeId: 'v1', requiredBeats: '主角拜入师门' }],
  volumes: [{ id: 'v1', title: '第一卷', requiredBeats: '' }],
  scenes: []
}

function run(plan, extra = {}) {
  return validatePlan({ plan, chapter, chapters, memory, structure, ...extra })
}

test('死亡人物出场：high，证据指回原文，字段可定位', () => {
  const v = run({ mustEvents: '苏九在酒馆里出现，与林舟对饮' })
  const it = v.issues.find((x) => x.category === 'dead-character')
  assert.ok(it)
  assert.equal(it.severity, 'high')
  assert.equal(it.field, 'mustEvents')
  assert.ok(it.evidence.includes('苏九'))
  assert.deepEqual(it.relatedIds, ['su'])
  assert.equal(it.overridable, true)
  assert.equal(v.blocking, true)
})

test('视角人物是死者：即使正文只写「他」也报 high', () => {
  const v = run({ povCharacterId: 'su', mustEvents: '他与林舟对饮' })
  const it = v.issues.find((x) => x.field === 'povCharacterId')
  assert.ok(it)
  assert.equal(it.category, 'dead-character')
  assert.equal(v.blocking, true)
})

test('禁止字段里提到死者不算出场（宁可漏报）', () => {
  const v = run({ forbidden: '苏九不得出场', coreConflict: '林舟独自赶路' })
  assert.equal(v.issues.filter((x) => x.category === 'dead-character').length, 0)
})

test('覆灭势力出现在计划里', () => {
  const v = run({ threads: '血河宗残部追来' })
  assert.ok(v.issues.some((x) => x.category === 'destroyed-faction' && x.severity === 'high'))
})

test('提前引用未来章节的事件', () => {
  const v = run({ mustEvents: '宗门覆灭的真相被揭开' })
  const it = v.issues.find((x) => x.category === 'future-event')
  assert.ok(it)
  assert.equal(it.severity, 'high')
  assert.ok(it.message.includes('第 6 章'))
})

test('核心世界规则只在 worldReveals / stateChanges 里被判改写', () => {
  const bad = run({ worldReveals: '灵气不可逆的规律被打破，死者可以复生' })
  assert.ok(bad.issues.some((x) => x.category === 'core-rule'))
  // 只是提到规则名（别的字段）不算改写
  const ok = run({ coreConflict: '众人讨论灵气不可逆这件事', worldReveals: '' })
  assert.equal(ok.issues.filter((x) => x.category === 'core-rule').length, 0)
  // 非核心规则不触发
  const soft = run({ worldReveals: '日升月落的节奏被打乱' })
  assert.equal(soft.issues.filter((x) => x.category === 'core-rule').length, 0)
})

test('伏笔提前揭示', () => {
  const v = run({ threads: '断剑秘密浮出水面' })
  const it = v.issues.find((x) => x.category === 'foreshadow-spoiler')
  assert.ok(it)
  assert.equal(it.severity, 'high')
  assert.ok(it.message.includes('第 8 章'))
})

test('偏离篇的必发节拍：一条都没命中时 medium，命中则不报', () => {
  const miss = run({ mustEvents: '主角独自赶路' })
  const it = miss.issues.find((x) => x.category === 'required-beats')
  assert.ok(it)
  assert.equal(it.severity, 'medium')
  assert.equal(miss.blocking, false)

  const hit = run({ mustEvents: '主角拜入师门，成为内门弟子' })
  assert.equal(hit.issues.filter((x) => x.category === 'required-beats').length, 0)
})

test('与近期章节重复：Dice ≥ 0.6 时 medium，且只报一条', () => {
  const v = run({ coreConflict: '主角与师父在雨中决裂', mustEvents: '' })
  const reps = v.issues.filter((x) => x.category === 'repetition')
  assert.equal(reps.length, 1)
  assert.equal(reps[0].severity, 'medium')
  assert.ok(reps[0].message.includes('第 3 章'))
})

test('干净计划 0 条；空计划也是 0 条', () => {
  const clean = validatePlan({
    plan: {
      povCharacterId: 'lin',
      mustEvents: '林舟在山门前等待',
      coreConflict: '山门迟迟不开',
      worldReveals: '',
      stateChanges: ''
    },
    chapter,
    chapters,
    memory,
    structure: { arcs: [], volumes: [], scenes: [] }
  })
  assert.equal(clean.issues.length, 0)
  assert.equal(clean.ok, true)
  assert.equal(clean.blocking, false)

  // 空计划：连「必发节拍没出现」也不该报 —— 没有计划时谈不上偏离。
  const empty = run({}, { structure: { arcs: [], volumes: [], scenes: [] } })
  assert.equal(empty.issues.length, 0)
  assert.equal(empty.ok, true)

  // 有必发节拍、计划却是空的：这是真正的「没按骨架排」，报 medium 合理。
  const noBeats = run({})
  assert.ok(noBeats.issues.some((x) => x.category === 'required-beats'))
})

test('normalizePlanCandidate：草案缺字段时沿用章节现值，数字强制成 0', () => {
  const c = { id: 'c5', order: 5, title: '第五章', coreConflict: '旧冲突', targetWords: 1200, povCharacterId: 'lin' }
  const p = normalizePlanCandidate({ mustEvents: '新事件', targetWords: '' }, c)
  assert.equal(p.coreConflict, '旧冲突')
  assert.equal(p.mustEvents, '新事件')
  assert.equal(p.targetWords, 0)
  assert.equal(p.povCharacterId, 'lin')
  assert.equal(p.id, 'c5')
})

test('blockHigh=false 时仍有问题但不阻断', () => {
  const v = run({ mustEvents: '苏九出现' }, { options: { blockHigh: false } })
  assert.ok(v.issues.length > 0)
  assert.equal(v.blocking, false)
  assert.equal(shouldBlockPlan(v, { blockHigh: true }), true)
  assert.equal(shouldBlockPlan(v, { blockHigh: false }), false)
  assert.equal(shouldBlockPlan(null), false)
})

test('章节摘要只存判断与问题 id，不存完整报告', () => {
  const v = run({ mustEvents: '苏九出现' })
  const sum = validationSummary(v, 123, { overridden: true })
  assert.equal(sum.version, PLAN_VALIDATION_VERSION)
  assert.equal(sum.at, 123)
  assert.equal(sum.blocking, true)
  assert.equal(sum.overridden, true)
  assert.equal(sum.high, v.stats.high)
  assert.deepEqual(sum.issueIds, v.issues.map((i) => i.id))
  assert.equal(validationSummary(null), null)
})

test('bigramDice：同文为 1，完全无关为 0，短文本不炸', () => {
  assert.equal(bigramDice('雨中决裂', '雨中决裂'), 1)
  assert.equal(bigramDice('雨中决裂', '山门等待'), 0)
  assert.equal(bigramDice('', '雨中决裂'), 0)
})
