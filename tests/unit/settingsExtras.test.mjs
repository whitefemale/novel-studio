import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultPlanValidation,
  normalizePlanValidation,
  defaultRagSettings,
  normalizeRagSettings,
  defaultWebdavSettings,
  normalizeWebdavSettings,
  normalizeRemoteDirInput,
  defaultPluginSettings,
  normalizePluginSettings,
  deriveDeviceName
} from '../../src/services/settingsExtras.js'

test('计划校验默认值与缺字段回填', () => {
  assert.deepEqual(normalizePlanValidation(null), defaultPlanValidation())
  assert.equal(normalizePlanValidation({}).enabled, true)
  // 显式 false 必须保留：默认值只填「没有」，不能覆盖用户的选择
  assert.equal(normalizePlanValidation({ enabled: false }).enabled, false)
  assert.equal(normalizePlanValidation({ repetitionWindow: 99 }).repetitionWindow, 10)
  assert.equal(normalizePlanValidation({ repetitionWindow: 0 }).repetitionWindow, 1)
})

test('RAG 默认关闭，且重叠长度永远不会大于分块长度', () => {
  const d = normalizeRagSettings(null)
  assert.equal(d.enabled, false)
  assert.deepEqual(d, defaultRagSettings())
  const r = normalizeRagSettings({ enabled: true, chunkChars: 200, overlapChars: 500 })
  assert.equal(r.enabled, true)
  assert.ok(r.overlapChars < r.chunkChars)
  assert.equal(normalizeRagSettings({ topK: 0 }).topK, 1)
  assert.equal(normalizeRagSettings({ minScore: 9 }).minScore, 1)
})

test('WebDAV 默认关闭，规范化状态与目录', () => {
  assert.deepEqual(normalizeWebdavSettings(null), defaultWebdavSettings())
  assert.equal(normalizeWebdavSettings({ lastStatus: 'weird' }).lastStatus, 'idle')
  assert.equal(normalizeWebdavSettings({ enabled: true }).enabled, true)
  assert.equal(normalizeWebdavSettings({ intervalSec: 1 }).intervalSec, 30)
  assert.equal(normalizeWebdavSettings({ url: '  https://a/b  ' }).url, 'https://a/b')
})

test('远程目录输入规范化：去斜杠、拒绝穿越、空值回默认', () => {
  assert.equal(normalizeRemoteDirInput(''), 'novel-studio')
  assert.equal(normalizeRemoteDirInput('/books/'), 'books')
  assert.equal(normalizeRemoteDirInput('a\\\\b'), 'a/b')
  assert.equal(normalizeRemoteDirInput('a//b'), 'a/b')
  // 越界输入不报错但必须落到安全的默认目录：真正的拒绝在主进程
  assert.equal(normalizeRemoteDirInput('../etc'), 'novel-studio')
  assert.equal(normalizeRemoteDirInput('a/../b'), 'novel-studio')
})

test('插件设置：去重、上限、预算', () => {
  const d = normalizePluginSettings(null)
  assert.deepEqual(d, defaultPluginSettings())
  assert.equal(normalizePluginSettings({ enabled: false }).enabled, false)
  assert.deepEqual(normalizePluginSettings({ disabledIds: ['a', 'a', 3, ''] }).disabledIds, ['a'])
  assert.equal(normalizePluginSettings({ contextBudget: -5 }).contextBudget, 0)
})

test('设备名：优先用用户填的，空时由 deviceId 派生且稳定', () => {
  assert.equal(deriveDeviceName('书房电脑', 'dev_x'), '书房电脑')
  assert.equal(deriveDeviceName('  ', 'dev_abcd1234'), '设备 1234')
  assert.equal(deriveDeviceName('', ''), '设备 ????')
  assert.equal(deriveDeviceName('x'.repeat(100), 'd').length, 40)
})
