import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFLICT_TITLE_PREFIX,
  CONFLICT_ID_PREFIX,
  CONFLICT_RECORD_PREFIX,
  CONFLICTS_COLLECTION,
  conflictCopyId,
  conflictRecordId,
  isConflictCopy,
  baselineTime,
  makeChapterBaseline,
  detectChapterConflicts,
  applyConflictCopies,
  updatePeerBaseline,
  isConflictStale
} from '../../src/services/sync/conflicts.js'
import { fnv1a32 } from '../../src/services/novel/snapshot.js'

/**
 * 同步冲突判定的单元测试。
 *
 * 这里钉的每一条都对应一次**真实的数据丢失风险**：
 *   - 首次同步不能报冲突（否则每一对本来就不一样的章都会被复制一份）；
 *   - 只有双方都在基线之后改过才算并发修改（一方没动时 LWW 是对的）；
 *   - 副本 id 必须确定（重试/重复提交不能每次多一份）；
 *   - 合并结果必须保留双方正文，且远端那份带与主章无关的确定性身份。
 */

const localChapter = (over = {}) => ({
  id: 'c1',
  bookId: 'b1',
  title: '第一章',
  content: '本地版本正文',
  order: 1,
  updatedAt: 200,
  ...over
})

const remoteChapter = (over = {}) => ({
  id: 'c1',
  bookId: 'b1',
  title: '第一章',
  content: '远端版本正文',
  order: 1,
  updatedAt: 300,
  ...over
})

const baseline = (updatedAt = 100) => ({ chapters: { c1: updatedAt } })

test('双方都在基线之后改过且正文不同 → 判为冲突', () => {
  const conflicts = detectChapterConflicts({
    localChapters: [localChapter()],
    remoteChapters: [remoteChapter()],
    baseline: baseline(),
    remoteDeviceId: 'devB'
  })
  assert.equal(conflicts.length, 1)
  const c = conflicts[0]
  assert.equal(c.chapterId, 'c1')
  assert.equal(c.bookId, 'b1')
  assert.equal(c.local.content, '本地版本正文')
  assert.equal(c.remote.content, '远端版本正文')
  assert.equal(c.remoteDeviceId, 'devB')
  assert.equal(c.localUpdatedAt, 200)
  assert.equal(c.remoteUpdatedAt, 300)
})

test('首次同步（没有基线）不报冲突，只建基线', () => {
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter()],
      remoteChapters: [remoteChapter()],
      baseline: null,
      remoteDeviceId: 'devB'
    }),
    []
  )
  // 有基线但没有这一章 = 这一章是同步之后新出现的，同样不算并发修改
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter()],
      remoteChapters: [remoteChapter()],
      baseline: { chapters: {} },
      remoteDeviceId: 'devB'
    }),
    []
  )
})

test('只有一方在基线之后改过 → 不报冲突（LWW 是正确的）', () => {
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter({ updatedAt: 50 })],
      remoteChapters: [remoteChapter({ updatedAt: 300 })],
      baseline: baseline(),
      remoteDeviceId: 'devB'
    }),
    []
  )
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter({ updatedAt: 300 })],
      remoteChapters: [remoteChapter({ updatedAt: 50 })],
      baseline: baseline(),
      remoteDeviceId: 'devB'
    }),
    []
  )
})

test('正文相同 → 不是冲突；本机没有这一章 → 不是冲突', () => {
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter({ content: '一样' })],
      remoteChapters: [remoteChapter({ content: '一样' })],
      baseline: baseline(),
      remoteDeviceId: 'devB'
    }),
    []
  )
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [],
      remoteChapters: [remoteChapter()],
      baseline: baseline(),
      remoteDeviceId: 'devB'
    }),
    []
  )
})

test('关闭冲突副本开关 → 一律不报冲突', () => {
  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter()],
      remoteChapters: [remoteChapter()],
      baseline: baseline(),
      remoteDeviceId: 'devB',
      conflictCopies: false
    }),
    []
  )
})

test('冲突副本不参与冲突判定（副本之间不会互相繁殖）', () => {
  const copy = remoteChapter({
    id: `${CONFLICT_ID_PREFIX}abc`,
    content: '副本正文',
    updatedAt: 400
  })
  assert.ok(isConflictCopy(copy))
  assert.ok(isConflictCopy({ id: 'x', conflictOf: 'c1' }))
  assert.ok(!isConflictCopy(localChapter()))

  assert.deepEqual(
    detectChapterConflicts({
      localChapters: [localChapter()],
      remoteChapters: [copy],
      baseline: baseline(),
      remoteDeviceId: 'devB'
    }),
    []
  )
})

test('副本 id / 记录 id 是确定性的，且随远端设备与时间戳变化', () => {
  const a = conflictCopyId('c1', 'devB', 300)
  const b = conflictCopyId('c1', 'devB', 300)
  assert.equal(a, b)
  assert.ok(a.startsWith(CONFLICT_ID_PREFIX))
  assert.notEqual(a, conflictCopyId('c1', 'devB', 301))
  assert.notEqual(a, conflictCopyId('c1', 'devC', 300))
  assert.notEqual(a, conflictCopyId('c2', 'devB', 300))

  const r = conflictRecordId('c1', 'devB', 300)
  assert.ok(r.startsWith(CONFLICT_RECORD_PREFIX))
  assert.equal(r, conflictRecordId('c1', 'devB', 300))
})

test('基线工具函数：缺省值、时间戳回退、peer 更新', () => {
  assert.equal(baselineTime({ chapters: { c1: 12 } }, 'c1'), 12)
  assert.equal(baselineTime({ chapters: { c1: 'bad' } }, 'c1'), null)
  assert.equal(baselineTime(null, 'c1'), null)

  const map = makeChapterBaseline([
    { id: 'c1', updatedAt: 10 },
    { id: 'c2', createdAt: 7 },
    { id: '' },
    null
  ])
  assert.deepEqual(map, { c1: 10, c2: 7 })

  const peers = updatePeerBaseline({}, 'devB', [{ id: 'c1', updatedAt: 99 }], { now: 1234 })
  assert.deepEqual(peers.devB.chapters, { c1: 99 })
  assert.equal(peers.devB.updatedAt, 1234)
  // 不改原对象
  const original = { old: { chapters: {} } }
  const next = updatePeerBaseline(original, 'devB', [], { now: 1 })
  assert.deepEqual(original, { old: { chapters: {} } })
  assert.ok(next.old && next.devB)
})

test('冲突副本落进远端快照：主章被移走、副本保留远端正文、记录为 open', () => {
  const conflicts = detectChapterConflicts({
    localChapters: [localChapter()],
    remoteChapters: [remoteChapter()],
    baseline: baseline(),
    remoteDeviceId: 'devB'
  })
  const snapshot = {
    data: { b1: { chapters: [remoteChapter()], tombstones: [] } }
  }
  const { snapshot: patched, conflicts: resolved } = applyConflictCopies(snapshot, conflicts, {
    now: 9999
  })

  assert.equal(resolved.length, 1)
  const chapters = patched.data.b1.chapters
  assert.equal(chapters.length, 1, '主章 id 已被移走，只剩冲突副本')
  const copy = chapters[0]
  assert.equal(copy.id, conflicts[0].copyId)
  assert.equal(copy.title, `${CONFLICT_TITLE_PREFIX}第一章`)
  assert.equal(copy.content, '远端版本正文', '远端正文一个字都不能丢')
  assert.equal(copy.order, 2, '副本排在当前最大 order 之后')
  assert.equal(copy.conflictOf, 'c1')
  assert.equal(copy.conflictDeviceId, 'devB')
  assert.equal(copy.updatedAt, 300, '副本沿用远端时间戳，重放时结果稳定')

  const records = patched.data.b1[CONFLICTS_COLLECTION]
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'open')
  assert.equal(records[0].chapterId, 'c1')
  assert.equal(records[0].copyChapterId, copy.id)
  assert.equal(records[0].id, conflicts[0].recordId)

  // 原快照不被修改
  assert.equal(snapshot.data.b1.chapters.length, 1)
  assert.equal(snapshot.data.b1.chapters[0].id, 'c1')
})

test('同一份远端快照重放 → 结果逐字相同（幂等）', () => {
  const conflicts = detectChapterConflicts({
    localChapters: [localChapter()],
    remoteChapters: [remoteChapter()],
    baseline: baseline(),
    remoteDeviceId: 'devB'
  })
  const snapshot = { data: { b1: { chapters: [remoteChapter()], tombstones: [] } } }
  const one = applyConflictCopies(snapshot, conflicts, { now: 9999 })
  const two = applyConflictCopies(snapshot, conflicts, { now: 9999 })
  assert.deepEqual(one.snapshot, two.snapshot)
  assert.deepEqual(one.conflicts, two.conflicts)
  // 副本只有一份，不会每同步一次就多一份
  assert.equal(one.snapshot.data.b1.chapters.length, 1)
  assert.equal(one.snapshot.data.b1[CONFLICTS_COLLECTION].length, 1)
})

test('远端正文为空 → 不制造空副本，也不报冲突', () => {
  const conflict = {
    chapterId: 'c1',
    bookId: 'b1',
    local: localChapter(),
    remote: remoteChapter({ content: '' }),
    copyId: conflictCopyId('c1', 'devB', 300),
    recordId: conflictRecordId('c1', 'devB', 300),
    localUpdatedAt: 200,
    remoteUpdatedAt: 300,
    remoteDeviceId: 'devB'
  }
  const snapshot = { data: { b1: { chapters: [], tombstones: [] } } }
  const { snapshot: patched, conflicts } = applyConflictCopies(snapshot, [conflict])
  assert.deepEqual(conflicts, [])
  assert.deepEqual(patched.data.b1.chapters, [])
})

test('冲突是否过期按**内容**判断，而不是时间戳', () => {
  const record = {
    chapterId: 'c1',
    copyChapterId: `${CONFLICT_ID_PREFIX}x`,
    localHash: 0,
    copyHash: 0
  }
  // 用真实函数算一次哈希，避免把测试绑到 fnv1a32 的具体数值上
  const main = localChapter()
  const copy = remoteChapter({ id: `${CONFLICT_ID_PREFIX}x`, content: '副本正文' })
  record.localHash = fnv1a32(main.content)
  record.copyHash = fnv1a32(copy.content)
  assert.equal(isConflictStale(record, [main, copy]), false)
  // 主章被改过 → 过期
  assert.equal(isConflictStale(record, [{ ...main, content: '又改了' }, copy]), true)
  // 副本被改过 → 过期
  assert.equal(isConflictStale(record, [main, { ...copy, content: '副本也改了' }]), true)
  // 副本被删 → 过期
  assert.equal(isConflictStale(record, [main]), true)
  assert.equal(isConflictStale(null, [main, copy]), true)
})
