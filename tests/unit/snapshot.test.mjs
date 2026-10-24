import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSnapshot,
  mergeSnapshot,
  normalizeSnapshot,
  stableStringify,
  fnv1a32,
  snapshotChecksum,
  snapshotCounts,
  finalizeSnapshot,
  cloneSnapshotAsNewBooks,
  emptySnapshot,
  SNAPSHOT_FORMAT,
  LOCAL_ONLY_COLLECTIONS
} from '../../src/services/novel/snapshot.js'

function sample() {
  return buildSnapshot(
    {
      books: [{ id: 'b1', title: '旧书', intro: '', createdAt: 1, updatedAt: 2 }],
      bookTombstones: [{ id: 'gone', type: 'books', deletedAt: 5 }],
      data: {
        b1: {
          chapters: [
            { id: 'c1', bookId: 'b1', title: '第一章', content: '正文', order: 1, updatedAt: 3 },
            { id: 'c2', bookId: 'b1', title: '第二章', content: '继续', order: 2, updatedAt: 4 }
          ],
          outlines: [{ id: 'o1', bookId: 'b1', type: 'outline', title: '大纲', content: 'x', updatedAt: 3 }],
          arcs: [
            { id: 'a1', bookId: 'b1', title: '篇一', volumeId: 'v1', updatedAt: 3 },
            { id: 'a2', bookId: 'b1', title: '篇二', volumeId: 'v1', updatedAt: 3 }
          ],
          volumes: [{ id: 'v1', bookId: 'b1', title: '卷一', updatedAt: 3 }],
          characters: [
            { id: 'p1', bookId: 'b1', name: '林昭', lastUpdatedChapterId: 'c2', updatedAt: 3 }
          ],
          events: [
            {
              id: 'e1',
              bookId: 'b1',
              title: '相遇',
              chapterId: 'c1',
              characterIds: ['p1'],
              locationIds: [],
              updatedAt: 3
            }
          ],
          foreshadowing: [
            {
              id: 'f1',
              bookId: 'b1',
              title: '旧伤',
              firstChapterId: 'c1',
              expectedRevealChapterId: 'c2',
              updatedAt: 3
            }
          ],
          tombstones: [{ id: 'x1', type: 'characters', deletedAt: 4 }]
        }
      }
    },
    1000
  )
}

test('稳定序列化对键顺序不敏感，但数组顺序保持', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3, 4] } }), stableStringify({ a: { c: [3, 4], d: 2 }, b: 1 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
  assert.equal(fnv1a32('abc'), fnv1a32('abc'))
  assert.match(fnv1a32('abc'), /^[0-9a-f]{8}$/)
})

test('快照头包含版本、应用版本、计数与校验和', () => {
  const snap = sample()
  assert.equal(snap.format, SNAPSHOT_FORMAT)
  assert.equal(snap.appVersion, 'dev') // 单测里没有 Vite 注入
  assert.equal(snap.counts.books, 1)
  assert.equal(snap.counts.chapters, 2)
  assert.equal(snap.counts.collections.arcs, 2)
  assert.equal(snap.counts.tombstones, 2) // 1 本书墓碑 + 1 条记录墓碑
  assert.equal(snap.checksum, snapshotChecksum(snap))
})

test('校验和只覆盖数据本体：换导出时间仍然通过', () => {
  const a = sample()
  const b = finalizeSnapshot({ ...a, exportedAt: 999999, appVersion: '9.9.9' })
  assert.equal(a.checksum, b.checksum)
  assert.notEqual(a.exportedAt, b.exportedAt)
})

test('篡改任何正文都会让 normalizeSnapshot 拒绝，且什么都不改', () => {
  const snap = structuredClone(sample())
  snap.data.b1.chapters[0].content = '被改过的正文'
  assert.throws(() => normalizeSnapshot(snap), /校验失败/)
})

test('没有 checksum 的旧备份照常接受', () => {
  const old = structuredClone(sample())
  delete old.checksum
  delete old.counts
  delete old.appVersion
  const out = normalizeSnapshot(old)
  assert.equal(out.checksum, '')
  assert.equal(out.books.length, 1)
})

test('拒绝来自更高数据版本的备份（不做半懂合并）', () => {
  const snap = sample()
  snap.schemaVersion = 999
  snap.checksum = snapshotChecksum(snap) // 先让它过校验，确保报错来自版本判断
  assert.throws(() => normalizeSnapshot(snap), /数据版本/)
})

test('拒绝更高快照格式版本', () => {
  const snap = sample()
  snap.version = 99
  assert.throws(() => normalizeSnapshot(snap), /备份文件的版本/)
})

test('作为副本导入：所有 id 换新、内部引用跟着重映射、书名加后缀', () => {
  let n = 0
  const clone = cloneSnapshotAsNewBooks(sample(), { newId: () => `n${++n}`, now: 5000 })

  assert.equal(clone.books.length, 1)
  const nb = clone.books[0]
  assert.notEqual(nb.id, 'b1')
  assert.equal(nb.title, '旧书（导入副本）')
  assert.equal(nb.createdAt, 5000)

  const sets = clone.data[nb.id]
  assert.ok(sets)
  const chapIds = sets.chapters.map((c) => c.id)
  assert.ok(chapIds.every((id) => !['c1', 'c2'].includes(id)))
  // 记录上的 bookId 必须指向新书
  for (const list of Object.values(sets)) {
    for (const rec of list) assert.equal(rec.bookId, nb.id)
  }

  const arc = sets.arcs[0]
  const vol = sets.volumes[0]
  assert.notEqual(vol.id, 'v1')
  assert.equal(arc.volumeId, vol.id, '篇 → 卷的引用要指向克隆出的新卷')

  const ev = sets.events[0]
  const person = sets.characters[0]
  assert.equal(ev.chapterId, sets.chapters[0].id)
  assert.deepEqual(ev.characterIds, [person.id])
  assert.equal(person.lastUpdatedChapterId, sets.chapters[1].id)

  const fs = sets.foreshadowing[0]
  assert.equal(fs.firstChapterId, sets.chapters[0].id)
  assert.equal(fs.expectedRevealChapterId, sets.chapters[1].id)
})

test('作为副本导入不复制墓碑（新书不该一出生就被判死）', () => {
  const clone = cloneSnapshotAsNewBooks(sample(), { newId: (() => { let i = 0; return () => `i${++i}` })(), now: 1 })
  assert.deepEqual(clone.bookTombstones, [])
  for (const sets of Object.values(clone.data)) assert.deepEqual(sets.tombstones, [])
})

test('副本与合并互不干扰：克隆出的书 id 不与原书重叠', () => {
  const src = sample()
  const clone = cloneSnapshotAsNewBooks(src, { newId: (() => { let i = 0; return () => `z${++i}` })(), now: 1 })
  const merged = mergeSnapshot(src, clone)
  assert.equal(merged.books.length, 2)
  assert.notEqual(merged.books[0].id, merged.books[1].id)
})

test('计数口径覆盖章、大纲、集合与墓碑', () => {
  const c = snapshotCounts(sample())
  assert.deepEqual(
    {
      books: c.books,
      chapters: c.chapters,
      outlines: c.outlines,
      records: c.records
    },
    { books: 1, chapters: 2, outlines: 1, records: 6 + 1 } // 6 个集合记录 + 1 条 tombstone
  )
})

test('emptySnapshot 是合法的空快照并被 finalize 补齐', () => {
  const e = finalizeSnapshot(emptySnapshot(123))
  assert.equal(e.exportedAt, 123)
  assert.equal(e.counts.books, 0)
  assert.equal(typeof e.checksum, 'string')
  assert.doesNotThrow(() => normalizeSnapshot(e))
})

// ---------------- V4：本地态集合与书籍指针 ----------------

test('设备本地态集合不进快照（队列、RAG 分块、生成任务）', () => {
  const snap = buildSnapshot({
    books: [{ id: 'b1', title: '书', createdAt: 1, updatedAt: 1 }],
    data: {
      b1: {
        chapters: [],
        outlines: [],
        generationTasks: [{ id: 't1', updatedAt: 1 }],
        generationQueue: [{ id: 'q1', updatedAt: 1 }],
        ragChunks: [{ id: 'r1', updatedAt: 1 }],
        characters: [{ id: 'p1', updatedAt: 1 }]
      }
    }
  })
  const sets = snap.data.b1
  assert.equal(sets.generationTasks, undefined)
  assert.equal(sets.generationQueue, undefined)
  assert.equal(sets.ragChunks, undefined)
  assert.equal(sets.characters.length, 1)
  // 计数也不能把它们算进去
  assert.equal(snapshotCounts(snap).records, 1)
})

test('快照头透传设备名，且设备名不进校验和', () => {
  const a = buildSnapshot({ books: [], deviceId: 'd1', deviceName: '书房电脑' })
  assert.equal(a.deviceName, '书房电脑')
  const b = { ...a, deviceName: '另一台' }
  assert.equal(snapshotChecksum(a), snapshotChecksum(b))
  assert.equal(normalizeSnapshot(a).deviceName, '书房电脑')
})

test('书籍指针按自己的时间戳合并，不跟着 updatedAt 走', () => {
  const local = [
    {
      id: 'b1',
      title: '书名',
      updatedAt: 100, // 书本体更旧
      currentChapterId: 'c-local',
      currentPointerUpdatedAt: 900 // 但指针更新
    }
  ]
  const remote = [
    {
      id: 'b1',
      title: '新书名',
      updatedAt: 500, // 书本体更新
      currentChapterId: 'c-remote',
      currentPointerUpdatedAt: 200
    }
  ]
  const merged = mergeSnapshot(buildSnapshot({ books: local }), buildSnapshot({ books: remote }))
  assert.equal(merged.books.length, 1)
  assert.equal(merged.books[0].title, '新书名', '书本体按 updatedAt 取远端')
  assert.equal(merged.books[0].currentChapterId, 'c-local', '指针按指针时间戳取本地')
  assert.equal(merged.books[0].currentPointerUpdatedAt, 900)
})

test('指针时间戳相等时保留本地；两侧都没有时不凭空加字段', () => {
  const local = [{ id: 'b1', updatedAt: 100, currentChapterId: 'c1', currentPointerUpdatedAt: 50 }]
  const remote = [{ id: 'b1', updatedAt: 100, currentChapterId: 'c2', currentPointerUpdatedAt: 50 }]
  const merged = mergeSnapshot(buildSnapshot({ books: local }), buildSnapshot({ books: remote }))
  assert.equal(merged.books[0].currentChapterId, 'c1')

  const oldLocal = [{ id: 'b2', title: '旧记录', updatedAt: 10 }]
  const bumped = mergeSnapshot(buildSnapshot({ books: oldLocal }), buildSnapshot({ books: [] }))
  assert.equal('currentPointerUpdatedAt' in bumped.books[0], false)
})

test('作为副本导入时指针重映射到新章节', () => {
  const src = buildSnapshot({
    books: [
      {
        id: 'b1',
        title: '书',
        updatedAt: 1,
        currentChapterId: 'c1',
        currentPointerUpdatedAt: 1
      }
    ],
    data: { b1: { chapters: [{ id: 'c1', bookId: 'b1', order: 1, content: 'x', updatedAt: 1 }] } }
  })
  let i = 0
  const clone = cloneSnapshotAsNewBooks(src, { newId: () => `n${++i}`, now: 2 })
  const book = clone.books[0]
  const chap = clone.data[book.id].chapters[0]
  assert.equal(book.currentChapterId, chap.id)
  assert.notEqual(book.currentChapterId, 'c1')
})
