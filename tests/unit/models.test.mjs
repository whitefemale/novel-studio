import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_MODEL_KEYS,
  defaultTaskModels,
  normalizeTaskModels,
  modelForStage,
  settingsForStage
} from '../../src/services/ai/models.js'

/**
 * 按任务分模型。守两件事：
 *   1. 留空必须回退到通用模型（老用户零行为变化）；
 *   2. settingsForStage 不得修改传入的 settings 对象（它是模块级 reactive 单例）。
 */

test('defaultTaskModels 每次返回新对象，全部为空', () => {
  const a = defaultTaskModels()
  const b = defaultTaskModels()
  assert.notEqual(a, b)
  assert.deepEqual(Object.keys(a).sort(), [...TASK_MODEL_KEYS].sort())
  for (const k of TASK_MODEL_KEYS) assert.equal(a[k], '')
})

test('normalizeTaskModels 补齐缺失键并去掉首尾空白', () => {
  const out = normalizeTaskModels({ write: '  a ', extract: null, nope: 'x' })
  assert.equal(out.write, 'a')
  assert.equal(out.extract, '')
  assert.equal(out.review, '')
  // 未知键不被带进来
  assert.equal(out.nope, undefined)
  assert.notEqual(normalizeTaskModels(null), null)
})

test('modelForStage：专用模型优先，否则回退通用模型；fix 复用 review', () => {
  const s = { model: 'general', models: { write: 'writer', review: 'reviewer' } }
  assert.equal(modelForStage(s, 'write'), 'writer')
  assert.equal(modelForStage(s, 'extract'), 'general')
  assert.equal(modelForStage(s, 'fix'), 'reviewer')
  assert.equal(modelForStage({ model: 'g' }, 'write'), 'g')
  assert.equal(modelForStage({}, 'write'), '')
})

test('settingsForStage 不改原对象；无差异时返回原对象', () => {
  const s = { model: 'general', models: { write: 'writer' } }
  const next = settingsForStage(s, 'write')
  assert.notEqual(next, s)
  assert.equal(next.model, 'writer')
  assert.equal(s.model, 'general', '原 settings 必须保持不变')

  assert.equal(settingsForStage(s, 'extract'), s)
})
