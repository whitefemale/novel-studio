import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRisk,
  diffMemoryCandidates,
  applyChange,
  undoMemoryChange,
  commitChanges
} from '../../src/services/ai/orchestrator.js'
import { coll } from '../../src/services/storage.js'

/**
 * 记忆变更：证据、变更日志、可撤销条件、核心不可变。
 *
 * applyChange / undoMemoryChange 是**会写库**的函数，但写库全部经 `coll` 工厂。
 * 这里把用到的集合替换成内存实现 —— 既不需要 IndexedDB，也不需要浏览器 ——
 * 从而能直接验证「日志里到底记了什么」「什么情况下撤销必须拒绝」。
 * 这比只测纯函数更有价值：撤销吃掉了用户后续编辑，是这一类功能最严重的缺陷。
 */

const fakes = {}
const originals = {}
const COLLECTIONS = ['characters', 'worldRules', 'events', 'reviewQueue', 'memoryChangeLog']

function fakeCollection() {
  let list = []
  return {
    __list: () => list,
    __seed(items) {
      list = structuredClone(items)
    },
    async getAll() {
      return structuredClone(list)
    },
    async upsert(bookId, item) {
      const idx = list.findIndex((x) => x.id === item.id)
      if (idx >= 0) list[idx] = structuredClone(item)
      else list.push(structuredClone(item))
      return structuredClone(list)
    },
    async remove(bookId, id) {
      list = list.filter((x) => x.id !== id)
      return structuredClone(list)
    },
    async saveAll(bookId, items) {
      list = structuredClone(items)
      return structuredClone(list)
    }
  }
}

function installFakes() {
  for (const name of COLLECTIONS) {
    originals[name] = coll[name]
    fakes[name] = fakeCollection()
    coll[name] = fakes[name]
  }
}

function resetFakes() {
  for (const name of COLLECTIONS) fakes[name].__seed([])
}

installFakes()
after(() => {
  for (const name of COLLECTIONS) coll[name] = originals[name]
})

test('diffMemoryCandidates：证据、来源章节、事实层级与确认状态随新建一起带入', () => {
  const changes = diffMemoryCandidates(
    { characters: [] },
    {
      characters: [
        {
          name: '林昭',
          identity: '药童',
          evidence: '林昭推门而入，身上还带着药味。'
        }
      ]
    },
    { chapterId: 'c9' }
  )
  assert.equal(changes.length, 1)
  const c = changes[0]
  assert.equal(c.op, 'create')
  assert.equal(c.entity, 'characters')
  assert.equal(c.chapterId, 'c9')
  assert.equal(c.evidence, '林昭推门而入，身上还带着药味。')
  assert.equal(c.data.evidence, '林昭推门而入，身上还带着药味。')
  assert.equal(c.data.sourceChapterId, 'c9')
  assert.equal(c.data.factLayer, 'author-fact')
  assert.equal(c.data.confirmStatus, 'confirmed')
  // evidence 不作为普通字段参与后续逐字段比对
  assert.equal(changes[0].field, null)
  assert.equal(c.risk, 'low')
})

test('diffMemoryCandidates：更新携带证据；核心不可变把任意改动升级为高风险', () => {
  const current = {
    characters: [
      { id: 'p1', name: '林昭', status: 'alive', coreImmutable: true },
      { id: 'p2', name: '苏九', status: 'alive', coreImmutable: false }
    ]
  }
  const changes = diffMemoryCandidates(
    current,
    {
      characters: [
        { id: 'p1', name: '林昭', status: 'alive', identity: '城主', evidence: '众人跪拜。' },
        { id: 'p2', name: '苏九', status: 'alive', identity: '掌柜', evidence: '苏九笑了。' }
      ]
    },
    { chapterId: 'c9' }
  )
  const locked = changes.find((c) => c.id === 'p1')
  const normal = changes.find((c) => c.id === 'p2')
  assert.equal(locked.coreImmutable, true)
  assert.equal(locked.risk, 'high', '核心不可变实体的普通字段改动也必须人工确认')
  assert.equal(locked.evidence, '众人跪拜。')
  assert.equal(normal.coreImmutable, false)
  assert.equal(normal.risk, 'low')
  assert.equal(normal.evidence, '苏九笑了。')
})

test('classifyRisk：死亡/失踪/境界/世界规则/势力覆灭都是高风险', () => {
  assert.equal(classifyRisk({ entity: 'worldRules', field: 'rule' }), 'high')
  assert.equal(classifyRisk({ entity: 'characters', field: 'status', from: 'alive', to: 'dead' }), 'high')
  assert.equal(classifyRisk({ entity: 'characters', field: 'status', from: 'alive', to: 'missing' }), 'high')
  assert.equal(classifyRisk({ entity: 'characters', field: 'currentPower', from: '一层', to: '二层' }), 'high')
  assert.equal(
    classifyRisk({ entity: 'factions', field: 'status', from: 'active', to: 'destroyed' }),
    'high'
  )
  assert.equal(classifyRisk({ entity: 'characters', field: 'identity', from: 'a', to: 'b' }), 'low')
})

test('applyChange（新建）：写元数据与一条可撤销的变更日志', async () => {
  resetFakes()
  const item = await applyChange('b1', {
    entity: 'characters',
    op: 'create',
    title: '林昭',
    data: { name: '林昭', status: 'alive', identity: '药童' },
    evidence: '林昭推门而入。',
    chapterId: 'c1',
    risk: 'low'
  })

  assert.ok(item && item.id)
  const saved = fakes.characters.__list()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].sourceChapterId, 'c1')
  assert.equal(saved[0].evidence, '林昭推门而入。')
  assert.equal(saved[0].factLayer, 'author-fact')
  assert.equal(saved[0].confirmStatus, 'confirmed')
  assert.equal(saved[0].confidence, 0.8)
  assert.equal(saved[0].lastChangeId, item.lastChangeId)

  const logs = fakes.memoryChangeLog.__list()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].op, 'create')
  assert.equal(logs[0].source, 'auto')
  assert.equal(logs[0].chapterId, 'c1')
  assert.equal(logs[0].evidence, '林昭推门而入。')
  assert.deepEqual(logs[0].after, { name: '林昭', status: 'alive', identity: '药童' })
})

test('撤销新建：删掉实体、标记原日志、并留下一条反向日志', async () => {
  resetFakes()
  await applyChange('b1', {
    entity: 'characters',
    op: 'create',
    title: '林昭',
    data: { name: '林昭' },
    evidence: '林昭推门而入。'
  })
  const log = fakes.memoryChangeLog.__list()[0]
  const res = await undoMemoryChange('b1', log.id)
  assert.equal(res.ok, true)
  assert.equal(fakes.characters.__list().length, 0)

  const logs = fakes.memoryChangeLog.__list()
  assert.equal(logs.length, 2)
  assert.equal(logs.find((x) => x.id === log.id).undone, true)
  const reverse = logs.find((x) => x.id !== log.id)
  assert.equal(reverse.op, 'delete')
  assert.equal(reverse.source, 'undo')
  assert.equal(reverse.undoOf, log.id)

  // 同一条日志不能撤销两次
  const again = await undoMemoryChange('b1', log.id)
  assert.equal(again.ok, false)
  assert.match(again.message, /已经撤销/)
})

test('撤销更新：当前值仍是那次写入的值时恢复 before，并写反向日志', async () => {
  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive', coreImmutable: false }])
  await applyChange('b1', {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    title: '林昭',
    field: 'status',
    from: 'alive',
    to: 'dead',
    data: { status: 'dead' },
    evidence: '林昭倒在血泊里。',
    risk: 'high'
  })
  assert.equal(fakes.characters.__list()[0].status, 'dead')
  const log = fakes.memoryChangeLog.__list()[0]
  assert.deepEqual(log.before, { status: 'alive' })
  assert.deepEqual(log.after, { status: 'dead' })
  assert.equal(log.risk, 'high')
  assert.equal(log.evidence, '林昭倒在血泊里。')

  const res = await undoMemoryChange('b1', log.id)
  assert.equal(res.ok, true)
  assert.equal(fakes.characters.__list()[0].status, 'alive')
  const reverse = fakes.memoryChangeLog.__list().find((x) => x.op === 'undo')
  assert.deepEqual(reverse.before, { status: 'dead' })
  assert.deepEqual(reverse.after, { status: 'alive' })
})

test('撤销更新：之后又被改过 → 拒绝，且绝不覆盖后续编辑', async () => {
  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive' }])
  await applyChange('b1', {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    field: 'status',
    from: 'alive',
    to: 'dead',
    data: { status: 'dead' }
  })
  const log = fakes.memoryChangeLog.__list()[0]

  // 模拟用户随后在控制台里把状态改成「失踪」
  const list = fakes.characters.__list()
  list[0] = { ...list[0], status: 'missing' }

  const res = await undoMemoryChange('b1', log.id)
  assert.equal(res.ok, false)
  assert.match(res.message, /后续修改/)
  assert.equal(fakes.characters.__list()[0].status, 'missing', '用户自己的编辑必须原样保留')
  assert.equal(fakes.memoryChangeLog.__list().find((x) => x.id === log.id).undone, undefined)
})

test('撤销：实体已被删除时明确失败，不制造一条假日志', async () => {
  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive' }])
  await applyChange('b1', {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    field: 'status',
    from: 'alive',
    to: 'dead',
    data: { status: 'dead' }
  })
  const log = fakes.memoryChangeLog.__list()[0]
  fakes.characters.__seed([])
  const res = await undoMemoryChange('b1', log.id)
  assert.equal(res.ok, false)
  assert.match(res.message, /不存在/)
  assert.equal(fakes.memoryChangeLog.__list().length, 1)
})

test('commitChanges：高风险进队列、低风险直接入库；两个开关都能改变去向', async () => {
  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive' }])
  const low = {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    title: '林昭',
    field: 'identity',
    from: '药童',
    to: '药师',
    data: { identity: '药师' }
  }
  const high = {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    title: '林昭',
    field: 'status',
    from: 'alive',
    to: 'dead',
    data: { status: 'dead' },
    risk: 'high'
  }

  const first = await commitChanges('b1', [low, high], { reviewHighRisk: true, autoApplyLowRisk: true })
  assert.equal(first.applied.length, 1)
  assert.equal(first.queued.length, 1)
  assert.equal(first.queued[0].to, 'dead')
  assert.equal(first.queued[0].status, 'pending')
  assert.equal(fakes.characters.__list()[0].identity, '药师')
  assert.equal(fakes.characters.__list()[0].status, 'alive', '高风险管理项在确认前不得落库')
  assert.equal(fakes.reviewQueue.__list().length, 1)

  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive' }])
  const second = await commitChanges('b1', [low], { autoApplyLowRisk: false })
  assert.equal(second.applied.length, 0)
  assert.equal(second.queued.length, 1)
  assert.equal(fakes.characters.__list()[0].identity, undefined, '关掉自动入库后低风险也不得写库')

  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive' }])
  const third = await commitChanges('b1', [high], { reviewHighRisk: false })
  assert.equal(third.queued.length, 0)
  assert.equal(third.applied.length, 1)
  assert.equal(fakes.characters.__list()[0].status, 'dead')
})

test('commitChanges：coreImmutable 的普通字段改按高风险排队', async () => {
  resetFakes()
  fakes.characters.__seed([{ id: 'p1', name: '林昭', status: 'alive', coreImmutable: true }])
  const change = {
    entity: 'characters',
    id: 'p1',
    op: 'update',
    title: '林昭',
    field: 'identity',
    from: '药童',
    to: '城主',
    data: { identity: '城主' },
    coreImmutable: true
  }
  const res = await commitChanges('b1', [change], { reviewHighRisk: true })
  assert.equal(res.applied.length, 0)
  assert.equal(res.queued.length, 1)
  assert.equal(res.queued[0].risk, 'high')
  assert.equal(res.queued[0].coreImmutable, true)
  assert.equal(fakes.characters.__list()[0].identity, undefined)
})
