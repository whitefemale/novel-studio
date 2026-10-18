import test from 'node:test'
import assert from 'node:assert/strict'
import { dayStart, spentOnDay, estimateCall, checkBudget } from '../../src/services/ai/budget.js'
import { DEFAULT_PRICING } from '../../src/services/ai/tokenUsage.js'

/**
 * 预算估算。最重要的断言是「价格未知不能算成 0 元」——
 * 把未知当免费，用户设的预算就形同虚设，而且界面上看不出任何异常。
 */

const NOW = new Date(2026, 9, 18, 15, 30, 0).getTime() // 本地时间 2026-10-18 15:30

test('dayStart 返回本地自然日零点', () => {
  const start = dayStart(NOW)
  const d = new Date(start)
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 0)
  assert.equal(d.getSeconds(), 0)
  assert.equal(d.getMilliseconds(), 0)
  assert.ok(start <= NOW)
  assert.ok(NOW - start < 24 * 60 * 60 * 1000)
})

test('spentOnDay 只统计当天，未定价记录让 complete 为 false', () => {
  const runs = [
    { createdAt: NOW, cost: 1.2, priced: true },
    { createdAt: NOW - 60_000, cost: 0.3, priced: true },
    { createdAt: NOW, cost: 0, priced: false }, // 价格未知
    { createdAt: NOW - 48 * 60 * 60 * 1000, cost: 99, priced: true } // 前天
  ]
  const res = spentOnDay(runs, NOW)
  assert.equal(res.count, 3)
  assert.equal(res.unpriced, 1)
  assert.equal(res.complete, false)
  assert.ok(Math.abs(res.total - 1.5) < 1e-9)
  assert.equal(res.currency, 'CNY')
})

test('estimateCall：已知模型按价目表算，未知模型价格是 null 而不是 0', () => {
  const settings = { model: 'deepseek-chat', maxTokens: 1000, pricing: DEFAULT_PRICING }
  const known = estimateCall({ settings, inputTokens: 1_000_000 })
  assert.equal(known.priced, true)
  // deepseek-chat 种子价：输入 2 元/M，输出 8 元/M（1000 tokens = 0.008）
  assert.ok(Math.abs(known.cost - (2 + 0.008)) < 1e-9)
  assert.equal(known.outputTokens, 1000)

  const unknown = estimateCall({ settings: { ...settings, model: 'some-unknown-model' } })
  assert.equal(unknown.priced, false)
  assert.equal(unknown.cost, null, '未知价格必须是 null，绝不能是 0')
})

test('checkBudget：没设上限就不拦；设了上限才按单次/每日判断', () => {
  const noLimit = checkBudget({
    estimate: { cost: 100 },
    settings: { budgetPerCall: 0, budgetDaily: 0 },
    spentToday: { total: 0, complete: true }
  })
  assert.equal(noLimit.hit, false)

  const perCall = checkBudget({
    estimate: { cost: 5 },
    settings: { budgetPerCall: 1, budgetDaily: 0 },
    spentToday: { total: 0, complete: true }
  })
  assert.equal(perCall.hit, true)
  assert.equal(perCall.level, 'per-call')

  const daily = checkBudget({
    estimate: { cost: 0.5 },
    settings: { budgetPerCall: 0, budgetDaily: 1 },
    spentToday: { total: 0.8, complete: true }
  })
  assert.equal(daily.hit, true)
  assert.equal(daily.level, 'daily')

  const both = checkBudget({
    estimate: { cost: 5 },
    settings: { budgetPerCall: 1, budgetDaily: 2, budgetAction: 'confirm' },
    spentToday: { total: 1, complete: true }
  })
  assert.equal(both.level, 'both')
  assert.equal(both.action, 'confirm')
})

test('checkBudget：价格未知但设了预算 → hit 且 level=unknown，不编造金额', () => {
  const res = checkBudget({
    estimate: { cost: null },
    settings: { budgetPerCall: 1, budgetDaily: 0 },
    spentToday: { total: 0, complete: true }
  })
  assert.equal(res.hit, true)
  assert.equal(res.level, 'unknown')
  assert.equal(res.unknown, true)
  assert.equal(res.projected, null)
})

test('checkBudget：当天有未定价调用时不能断言「没超」', () => {
  const res = checkBudget({
    estimate: { cost: 0.1 },
    settings: { budgetPerCall: 0, budgetDaily: 10 },
    spentToday: { total: 0, complete: false }
  })
  assert.equal(res.hit, true)
  assert.equal(res.level, 'unknown')
})
