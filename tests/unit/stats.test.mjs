import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStats, DENSITY_BUCKET } from '../../src/services/novel/stats.js'

/**
 * 统计口径。这些数字会被界面直接展示成「完成度 67%」「已 12 章未出场」，
 * 算错不会报错，只会让作者对着一个假数字调整写作计划。
 *
 * 刻意钉住的口径：
 *   - 平均字数只除以已写章节（空章不进分母）；
 *   - 「出场」同一章只算一次（事件 + 场景 + 最近出场章取并集）；
 *   - 废弃伏笔仍留在回收率的分母里；
 *   - 逾期 = 预计揭示章已写完，状态仍是 planted / developing。
 */

function fixture() {
  return {
    chapters: [
      { id: 'c1', order: 1, title: '起点', content: '第一章正文', arcId: 'a1', threads: '主线、暗线', targetWords: 100 },
      { id: 'c2', order: 2, title: '空章', content: '', arcId: 'a1' },
      { id: 'c3', order: 3, title: '转折', content: '第三章的正文内容', arcId: 'a2', threads: '支线' },
      { id: 'c4', order: 4, title: '未写', content: '' }
    ],
    structure: {
      volumes: [{ id: 'v1', title: '第一卷', order: 1 }],
      arcs: [
        { id: 'a1', title: '开篇', volumeId: 'v1', status: 'active' },
        { id: 'a2', title: '转折', volumeId: 'v1', status: 'active' }
      ],
      scenes: [{ id: 's1', chapterId: 'c1', characterIds: ['p1', 'p2'], status: 'written' }]
    },
    memory: {
      characters: [
        { id: 'p1', name: '林昭' },
        { id: 'p2', name: '苏九' },
        { id: 'p3', name: '从未登场' }
      ],
      events: [
        { id: 'e1', chapterId: 'c1', title: '相遇', characterIds: ['p1'], locationId: 'loc1' },
        { id: 'e2', chapterId: 'c1', title: '再相遇', characterIds: ['p1'] },
        { id: 'e3', chapterId: 'c3', title: '决裂', characterIds: ['p2'] }
      ],
      foreshadowing: [
        { id: 'f1', title: '玉佩', status: 'planted', expectedRevealChapterId: 'c1' },
        { id: 'f2', title: '旧信', status: 'revealed' },
        { id: 'f3', title: '身世', status: 'resolved' },
        { id: 'f4', title: '弃用', status: 'abandoned' }
      ]
    }
  }
}

test('章节完成度：只算有正文的章，平均只除以已写章节', () => {
  const s = buildStats(fixture())
  assert.equal(s.chapters.total, 4)
  assert.equal(s.chapters.written, 2)
  assert.equal(s.chapters.empty, 2)
  assert.equal(s.chapters.words, 5 + 8)
  assert.equal(s.chapters.avgWords, 6.5)
  assert.equal(s.chapters.targetWords, 100)
  assert.ok(Math.abs(s.chapters.targetProgress - 0.13) < 1e-9)
  assert.equal(s.chapters.longest.id, 'c3')
})

test('卷/篇完成度按章节上的 arcId 归属', () => {
  const s = buildStats(fixture())
  assert.equal(s.volumes.length, 1)
  assert.equal(s.volumes[0].total, 3)
  assert.equal(s.volumes[0].written, 2)
  assert.ok(Math.abs(s.volumes[0].progress - 2 / 3) < 1e-9)
  assert.equal(s.volumes[0].arcs, 2)

  const a1 = s.arcs.find((a) => a.id === 'a1')
  assert.equal(a1.total, 2)
  assert.equal(a1.written, 1)
  assert.equal(a1.words, 5)
})

test('主线推进：记录最后一次主线章节与之后又写了多少章', () => {
  const s = buildStats(fixture())
  assert.equal(s.threads.mainLastOrder, 1)
  assert.equal(s.threads.mainGap, 3)
  const a1 = s.threads.arcs.find((a) => a.id === 'a1')
  assert.equal(a1.lastOrder, 2)
  assert.equal(a1.gap, 2)
})

test('人物出场：同章去重，事件/场景/最近出场章取并集', () => {
  const s = buildStats(fixture())
  assert.equal(s.characters.tracked, 3)
  assert.equal(s.characters.appeared, 2)
  assert.equal(s.characters.never, 1)

  const p1 = s.characters.rows.find((r) => r.id === 'p1')
  assert.equal(p1.chapters, 1, 'c1 有两个事件，仍然只算一章')
  assert.equal(p1.events, 1)
  assert.equal(p1.scenes, 1)
  assert.equal(p1.gap, 3)

  const p2 = s.characters.rows.find((r) => r.id === 'p2')
  assert.equal(p2.chapters, 2)
  assert.equal(p2.gap, 1)

  const p3 = s.characters.rows.find((r) => r.id === 'p3')
  assert.equal(p3.chapters, 0)
  assert.equal(p3.gap, null)
})

test('伏笔：废弃仍在分母里；预计揭示章已写完且未回收 → 逾期', () => {
  const s = buildStats(fixture())
  assert.equal(s.foreshadowing.total, 4)
  assert.equal(s.foreshadowing.active, 1)
  assert.equal(s.foreshadowing.abandoned, 1)
  assert.ok(Math.abs(s.foreshadowing.rate - 0.5) < 1e-9)
  assert.equal(s.foreshadowing.overdue.length, 1)
  assert.equal(s.foreshadowing.overdue[0].id, 'f1')
  assert.equal(s.foreshadowing.overdue[0].expectedOrder, 1)
})

test('事件密度按每 10 章一段，空章节也占位置', () => {
  const s = buildStats(fixture())
  assert.equal(DENSITY_BUCKET, 10)
  assert.equal(s.density.buckets.length, 1)
  const b = s.density.buckets[0]
  assert.equal(b.from, 1)
  assert.equal(b.to, 4)
  assert.equal(b.chapters, 4)
  assert.equal(b.events, 3)
  assert.equal(b.scenes, 1)
  assert.equal(b.words, 13)
  assert.ok(Math.abs(b.perThousandWords - (3 / 13) * 1000) < 1e-9)
})

test('空输入不抛错，返回全零结构', () => {
  const s = buildStats({})
  assert.equal(s.chapters.total, 0)
  assert.equal(s.chapters.avgWords, 0)
  assert.equal(s.volumes.length, 0)
  assert.equal(s.density.buckets.length, 0)
  assert.equal(s.characters.rows.length, 0)
  assert.equal(s.foreshadowing.rate, 0)
})
