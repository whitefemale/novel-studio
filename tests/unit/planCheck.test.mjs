import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitPlanTerms,
  matchesTerm,
  planCompleteness,
  checkChapterPlan
} from '../../src/services/novel/planCheck.js'

/**
 * 施工卡自检是零成本、可复现的那一半；这里要钉住的核心是**不误报**：
 * 空正文不报「没按计划写」，关键词匹配对短词与长句的判据要稳定。
 */

test('splitPlanTerms 按换行与中文标点拆条', () => {
  assert.deepEqual(splitPlanTerms('林昭受伤\n苏九登场，发现密道、夺回灵石'), [
    '林昭受伤',
    '苏九登场',
    '发现密道',
    '夺回灵石'
  ])
  assert.deepEqual(splitPlanTerms(''), [])
})

test('matchesTerm：短词必须原文包含，长句允许分段命中', () => {
  assert.equal(matchesTerm('林昭推门而入', '林昭'), true)
  assert.equal(matchesTerm('林昭推门而入', '苏九'), false)
  // 长句：每一小段都出现才算命中
  const content = '苏九登场，他带着林昭发现密道。'
  assert.equal(matchesTerm(content, '苏九登场，发现密道'), true)
  assert.equal(matchesTerm(content, '苏九登场，夺回灵石'), false)
})

test('空正文不产生任何内容类问题', () => {
  const res = checkChapterPlan(
    {
      id: 'c1',
      content: '',
      targetWords: 2000,
      mustEvents: '必须大战一场',
      acceptance: '结尾留下悬念',
      forbidden: '不许死人'
    },
    ''
  )
  assert.equal(res.ok, true)
  assert.equal(res.issues.length, 0)
  assert.equal(res.stats.words, 0)
})

test('目标字数偏差分级：20% 内不报，超出到 50% 是 low，再大是 high', () => {
  const target = 100
  const ok = checkChapterPlan({ id: 'c', targetWords: target }, '字'.repeat(110))
  assert.equal(ok.issues.filter((i) => i.field === 'targetWords').length, 0)

  const low = checkChapterPlan({ id: 'c', targetWords: target }, '字'.repeat(130))
  const lowIssue = low.issues.find((i) => i.field === 'targetWords')
  assert.equal(lowIssue.severity, 'low')

  const high = checkChapterPlan({ id: 'c', targetWords: target }, '字'.repeat(190))
  const highIssue = high.issues.find((i) => i.field === 'targetWords')
  assert.equal(highIssue.severity, 'high')
})

test('禁止内容优先报 high；必须事件与验收标准缺失报 low', () => {
  const res = checkChapterPlan(
    {
      id: 'c',
      mustEvents: '林昭受伤',
      acceptance: '结尾出现密道',
      forbidden: '苏九死亡'
    },
    '苏九死亡了，林昭在城里闲逛。'
  )
  assert.equal(res.ok, false)
  const forbidden = res.issues.find((i) => i.field === 'forbidden')
  assert.equal(forbidden.severity, 'high')
  assert.ok(res.issues.find((i) => i.field === 'mustEvents')?.severity === 'low')
  assert.ok(res.issues.find((i) => i.field === 'acceptance')?.severity === 'low')
})

test('必须事件命中就不报；视角人物只在名字确实不在正文时提示', () => {
  const chapter = {
    id: 'c',
    mustEvents: '林昭受伤',
    povCharacterId: 'p1'
  }
  const hit = checkChapterPlan(chapter, '林昭受伤了。', {
    characters: [{ id: 'p1', name: '林昭' }]
  })
  assert.equal(hit.issues.length, 0)

  const miss = checkChapterPlan({ ...chapter, mustEvents: '' }, '他走进药庐。', {
    characters: [{ id: 'p1', name: '林昭' }]
  })
  const pov = miss.issues.find((i) => i.field === 'povCharacterId')
  assert.equal(pov.severity, 'low')

  // 没有匹配到人物记录时不判视角：空名字会把每一章都报成问题
  const unknown = checkChapterPlan({ ...chapter, mustEvents: '' }, '他走进药庐。', {
    characters: []
  })
  assert.equal(unknown.issues.length, 0)
})

test('planCompleteness 统计有值字段（数字 0 算未填）', () => {
  const c = planCompleteness({ openingState: '雨夜', targetWords: 0, mustEvents: '   ' })
  assert.equal(c.filled, 1)
  assert.equal(c.total > 0, true)
  assert.ok(c.ratio > 0 && c.ratio < 1)
})
