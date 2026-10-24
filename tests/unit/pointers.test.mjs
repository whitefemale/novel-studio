import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOK_POINTER_FIELDS,
  BOOK_POINTER_STAMP,
  resolvePointerChapter,
  derivePointers,
  pickChapterAfterDelete,
  pointersEqual,
  pointerPatch
} from '../../src/services/novel/pointers.js'

const chapters = [
  { id: 'c1', order: 1 },
  { id: 'c2', order: 2 },
  { id: 'c3', order: 3 }
]
const arcs = [
  { id: 'a1', volumeId: 'v1' },
  { id: 'a2', volumeId: 'v2' }
]

test('按 id 找回上次读的章节，找不到/空 id 返回 null', () => {
  assert.equal(resolvePointerChapter(chapters, 'c2').id, 'c2')
  assert.equal(resolvePointerChapter(chapters, 'gone'), null)
  assert.equal(resolvePointerChapter(chapters, ''), null)
  assert.equal(resolvePointerChapter(null, 'c1'), null)
})

test('由章节的 arcId 推导篇与卷', () => {
  const p = derivePointers({ id: 'c2', arcId: 'a2' }, { arcs })
  assert.deepEqual(p, { currentChapterId: 'c2', currentArcId: 'a2', currentVolumeId: 'v2' })
})

test('打开书时才用 previous 回退；主动切章传 null 会清空篇/卷', () => {
  const previous = { currentChapterId: 'c1', currentArcId: 'a1', currentVolumeId: 'v1' }
  const reopened = derivePointers({ id: 'c9' }, { arcs, previous })
  assert.deepEqual(reopened, { currentChapterId: 'c9', currentArcId: 'a1', currentVolumeId: 'v1' })
  // 篇还在库里但卷字段丢了：保留 previous 的卷
  const stillHasArc = derivePointers({ id: 'c9' }, { arcs, previous })
  assert.equal(stillHasArc.currentVolumeId, 'v1')
  // 主动切章：不传 previous
  assert.deepEqual(derivePointers({ id: 'c3' }, { arcs }), {
    currentChapterId: 'c3',
    currentArcId: null,
    currentVolumeId: null
  })
  // 没有当前章（空书）时三个指针都是 null
  assert.deepEqual(derivePointers(null, { arcs }), {
    currentChapterId: null,
    currentArcId: null,
    currentVolumeId: null
  })
})

test('删章回退：原位置 → 前一章 → null，删最后一章不跳回第一章', () => {
  assert.equal(pickChapterAfterDelete(chapters, 'c2').id, 'c3')
  assert.equal(pickChapterAfterDelete(chapters, 'c3').id, 'c2')
  assert.equal(pickChapterAfterDelete(chapters, 'c1').id, 'c2')
  assert.equal(pickChapterAfterDelete([{ id: 'only' }], 'only'), null)
  assert.equal(pickChapterAfterDelete([], 'x'), null)
  // 列表里没有它：退回第一章，不抛错
  assert.equal(pickChapterAfterDelete(chapters, 'nope').id, 'c1')
})

test('比较只看三个指针字段，时间戳不参与', () => {
  const a = { currentChapterId: 'c1', currentArcId: null, currentVolumeId: null, [BOOK_POINTER_STAMP]: 1 }
  const b = { currentChapterId: 'c1', currentArcId: null, currentVolumeId: null, [BOOK_POINTER_STAMP]: 99 }
  assert.equal(pointersEqual(a, b), true)
  assert.equal(pointersEqual(a, { ...b, currentChapterId: 'c2' }), false)
  assert.equal(pointersEqual(undefined, b), false)
})

test('patch 只含四个字段，时间戳原样保留', () => {
  const p = pointerPatch({ currentChapterId: 'c2', currentArcId: 'a1' }, 123)
  assert.deepEqual(Object.keys(p).sort(), [...BOOK_POINTER_FIELDS, BOOK_POINTER_STAMP].sort())
  assert.equal(p.currentVolumeId, null)
  assert.equal(p[BOOK_POINTER_STAMP], 123)
  assert.equal(pointerPatch(null, 0)[BOOK_POINTER_STAMP], 0)
})
