import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONSISTENCY_RULES,
  MAIN_THREAD_STALLED,
  SUBPLOT_STALLED,
  DENSITY_WINDOW,
  NO_CHANGE_MIN,
  runRuleChecks
} from '../../src/services/novel/consistency.js'

/**
 * 第二阶段新增的五条剧情健康规则。
 *
 * 这一组最重要的断言不是「坏数据能报出来」，而是**干净数据必须 0 条**：
 * 一个总在报警的检查，用户看两次就不再看了。所有新规则的判据都刻意取窄，
 * 每个用例都只制造一处问题，顺带证明它们不会互相串味。
 */

let seq = 0
const uid = (p) => `${p}${++seq}`

function chapter(over = {}) {
  return {
    id: uid('ch'),
    order: 1,
    title: '章节',
    content: '雨夜里，林昭推开了药庐的门。',
    summary: '林昭来到药庐。',
    ...over
  }
}

function chapters(n, over = {}) {
  return Array.from({ length: n }, (_, i) => chapter({ order: i + 1, title: `第${i + 1}章`, ...over }))
}

const rulesOf = (res) => res.issues.map((i) => i.rule)

test('干净数据必须 0 条，且 12 条规则全部在 stats.byRule 里（含 0）', () => {
  const list = [
    chapter({ order: 1, purpose: '离开故乡' }),
    chapter({ order: 2, purpose: '在城里落脚' }),
    chapter({ order: 3, purpose: '发现密道' })
  ]
  const res = runRuleChecks({ chapters: list, memory: {}, structure: {} })
  assert.deepEqual(res.issues, [])
  assert.equal(res.stats.total, 0)
  assert.equal(CONSISTENCY_RULES.length, 12)
  for (const r of CONSISTENCY_RULES) assert.equal(res.stats.byRule[r.id], 0)
})

test('主线停滞：至少两处「主线」标记后，超过阈值仍无推进', () => {
  const list = chapters(12, { threads: '' })
  list[0].threads = '主线：夺回灵石'
  list[1].threads = '主线：夺回灵石'
  const lastMain = 2
  const gap = list.length - lastMain
  assert.ok(gap > MAIN_THREAD_STALLED, '夹具必须落在阈值之外')

  const res = runRuleChecks({ chapters: list })
  assert.deepEqual(rulesOf(res), ['mainThreadStalled'])
  const issue = res.issues[0]
  assert.equal(issue.severity, 'medium')
  assert.match(issue.title, new RegExp(String(gap)))
})

test('主线停滞不误报：只有一处标记、或空章还没写', () => {
  const oneMark = chapters(12)
  oneMark[0].threads = '主线：夺回灵石'
  assert.equal(runRuleChecks({ chapters: oneMark }).issues.length, 0)

  // 后面全是刚建好的空章：进度停在最后一章有正文的地方，不往前算
  const withEmpty = chapters(3)
  withEmpty[0].threads = '主线'
  withEmpty[1].threads = '主线'
  withEmpty.push(chapter({ order: 4, content: '', summary: '' }))
  withEmpty.push(chapter({ order: 5, content: '', summary: '' }))
  assert.equal(runRuleChecks({ chapters: withEmpty }).issues.length, 0)
})

test('关键人物过度密集：最近 10 章里有 8 章出场才报', () => {
  const list = chapters(DENSITY_WINDOW)
  const characters = [{ id: 'p1', name: '林昭' }]
  const events = list.slice(0, 8).map((c, i) => ({
    id: uid('ev'),
    title: `事件${i}`,
    chapterId: c.id,
    characterIds: ['p1']
  }))

  const res = runRuleChecks({ chapters: list, memory: { characters, events } })
  assert.deepEqual(rulesOf(res), ['keyCharacterOverdense'])
  assert.equal(res.issues[0].severity, 'low')
  assert.match(res.issues[0].title, /林昭/)

  // 7 章出场（低于 70% + 1）不报；窗口不满 10 章也不报
  const seven = events.slice(0, 7)
  assert.equal(runRuleChecks({ chapters: list, memory: { characters, events: seven } }).issues.length, 0)
  // 窗口不满时只给它窗口内的事件（否则那些事件会指向被裁掉的章节 → 断链）
  const short = runRuleChecks({ chapters: list.slice(0, 6), memory: { characters, events: events.slice(0, 6) } })
  assert.equal(short.issues.length, 0)
})

test('支线长期无进展：只判「进行中」且已挂过章节的篇', () => {
  const list = chapters(12)
  list[0].arcId = 'arc1'
  const structure = { arcs: [{ id: 'arc1', title: '药庐疑云', status: 'active' }] }
  const gap = 12 - 1
  assert.ok(gap > SUBPLOT_STALLED)

  const res = runRuleChecks({ chapters: list, structure })
  assert.deepEqual(rulesOf(res), ['subplotStalled'])
  assert.equal(res.issues[0].entityId, 'arc1')

  // 已完成 / 废弃的篇不算停滞；从未挂过章节的篇也不算（只是还没开始写）
  assert.equal(
    runRuleChecks({ chapters: list, structure: { arcs: [{ ...structure.arcs[0], status: 'done' }] } }).issues.length,
    0
  )
  const orphanArc = { arcs: [{ id: 'arc2', title: '未开写', status: 'active' }] }
  assert.equal(runRuleChecks({ chapters: list, structure: orphanArc }).issues.length, 0)
})

test('相邻章节目标重复：规范化后相同且至少 4 字才报', () => {
  const list = [
    chapter({ order: 1, purpose: '林昭进入药庐寻找线索。' }),
    chapter({ order: 2, purpose: '林昭进入药庐，寻找线索！' }),
    chapter({ order: 3, purpose: '彻底不同的目标' })
  ]
  const res = runRuleChecks({ chapters: list })
  assert.deepEqual(rulesOf(res), ['duplicatePurpose'])
  assert.equal(res.issues[0].chapterId, list[1].id)

  // 过短（多半只是「推进」这种占位）不报；不相邻不报
  const short = runRuleChecks({
    chapters: [chapter({ order: 1, purpose: '推进' }), chapter({ order: 2, purpose: '推进' })]
  })
  assert.equal(short.issues.length, 0)
  const apart = runRuleChecks({
    chapters: [
      chapter({ order: 1, purpose: '林昭进入药庐寻找线索' }),
      chapter({ order: 2, purpose: '中间插一段别的事' }),
      chapter({ order: 3, purpose: '林昭进入药庐寻找线索' })
    ]
  })
  assert.equal(apart.issues.length, 0)
})

test('连续章节没有有效变化：只判已确认、有内容施工卡的连续章节', () => {
  const list = [
    chapter({ order: 1, planStatus: 'confirmed', coreConflict: '寻找密道' }),
    chapter({ order: 2, planStatus: 'confirmed', coreConflict: '进入密道' })
  ]
  assert.ok(list.length >= NO_CHANGE_MIN)
  const res = runRuleChecks({ chapters: list })
  assert.deepEqual(rulesOf(res), ['noChangeStretch'])
  assert.equal(res.issues[0].severity, 'low')

  // 有事件 / 伏笔动作 / 状态变化任一即算有效变化
  const withEvent = runRuleChecks({
    chapters: list,
    memory: { events: [{ id: 'e1', title: '找到密道', chapterId: list[0].id }] }
  })
  assert.equal(withEvent.issues.length, 0)
  const withState = [
    chapter({ order: 1, planStatus: 'confirmed', coreConflict: '寻找密道', stateChanges: '林昭受伤' }),
    chapter({ order: 2, planStatus: 'confirmed', coreConflict: '进入密道' })
  ]
  assert.equal(runRuleChecks({ chapters: withState }).issues.length, 0)

  // 临时计划（未确认）或完全没填施工卡的旧章节不判
  const draft = [
    chapter({ order: 1, planStatus: 'draft', coreConflict: '寻找密道' }),
    chapter({ order: 2, planStatus: 'draft', coreConflict: '进入密道' })
  ]
  assert.equal(runRuleChecks({ chapters: draft }).issues.length, 0)
  assert.equal(runRuleChecks({ chapters: [chapter({ order: 1 }), chapter({ order: 2 })] }).issues.length, 0)
})

test('单章停顿不报：两章才构成「连续」', () => {
  const one = chapter({ order: 1, planStatus: 'confirmed', coreConflict: '寻找密道' })
  const before = chapter({ order: 0, purpose: '前情' })
  const after = chapter({ order: 2, purpose: '后续' })
  const res = runRuleChecks({ chapters: [before, one, after] })
  assert.equal(res.issues.length, 0)
})
