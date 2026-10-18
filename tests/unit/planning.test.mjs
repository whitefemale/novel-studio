import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitLockedBeats,
  missingLockedBeats,
  normalizePlanDraft,
  buildPlanProposal,
  proposalPatch
} from '../../src/services/novel/planning.js'

/**
 * 锁定节点与 AI 计划提案。
 *
 * 最重要的不变量：**AI 草稿触碰锁定节点时只能生成提案，不能直接变成章节数据**。
 * 提案 id 必须确定性，否则重复点「生成计划」会堆出一串一模一样的待办。
 */

test('splitLockedBeats 一行一条，忽略空行与首尾空格', () => {
  assert.deepEqual(splitLockedBeats(' 林昭必须活下来 \n\n 密道要被发现\n'), [
    '林昭必须活下来',
    '密道要被发现'
  ])
  assert.deepEqual(splitLockedBeats(''), [])
})

test('missingLockedBeats：草稿任一施工卡字段提到节点就算保留', () => {
  // 短节点要求原文出现（这是刻意的「宁可漏报」）；长节点允许按逗号分段命中
  const draft = {
    mustEvents: '林昭必须活下来，密道要被发现',
    endingHook: '苏九终于背叛了林昭'
  }
  assert.deepEqual(missingLockedBeats(draft, '林昭必须活下来\n密道要被发现'), [])
  assert.deepEqual(missingLockedBeats(draft, '林昭必须活下来\n苏九必须背叛'), ['苏九必须背叛'])
  assert.deepEqual(missingLockedBeats({}, ''), [])
})

test('normalizePlanDraft 只保留施工卡字段，数字字段转数字', () => {
  const out = normalizePlanDraft({
    coreConflict: '  夺回灵石 ',
    targetWords: '1800',
    id: 'evil',
    planStatus: 'confirmed',
    unknown: 'x'
  })
  assert.equal(out.coreConflict, '夺回灵石')
  assert.equal(out.targetWords, 1800)
  assert.equal('id' in out, false)
  assert.equal('planStatus' in out, false)
  assert.equal('unknown' in out, false)
})

test('没有锁定节点或全部保留时不产生提案', () => {
  assert.equal(
    buildPlanProposal({
      bookId: 'b',
      chapterId: 'c',
      current: { lockedBeats: '' },
      proposed: { coreConflict: '随便' }
    }),
    null
  )
  assert.equal(
    buildPlanProposal({
      bookId: 'b',
      chapterId: 'c',
      current: { lockedBeats: '林昭活下来' },
      proposed: { endingHook: '林昭活下来了' }
    }),
    null
  )
})

test('触碰锁定节点时生成提案，id 确定、previous 完整可回看', () => {
  const args = {
    bookId: 'b1',
    chapterId: 'c1',
    current: {
      lockedBeats: '林昭活下来\n密道被发现',
      coreConflict: '旧冲突',
      targetWords: 1200
    },
    proposed: { coreConflict: '新冲突', targetWords: 1500 },
    reportRunId: 'run1',
    now: 1000
  }
  const p = buildPlanProposal(args)
  assert.ok(p)
  assert.equal(p.status, 'pending')
  assert.deepEqual(p.missingBeats, ['林昭活下来', '密道被发现'])
  assert.deepEqual(p.lockedBeats, ['林昭活下来', '密道被发现'])
  assert.equal(p.proposed.coreConflict, '新冲突')
  assert.equal(p.previous.coreConflict, '旧冲突')
  assert.equal(p.reportRunId, 'run1')

  const p2 = buildPlanProposal({ ...args, now: 2000 })
  assert.equal(p.id, p2.id, '同样的内容必须得到同一个 id')
  const p3 = buildPlanProposal({
    ...args,
    proposed: { coreConflict: '另一个新冲突' }
  })
  assert.notEqual(p.id, p3.id, '内容变了 id 才能变')

  // 提案里的草稿合进章节时仍然不带 lockedBeats 本身
  const patch = proposalPatch(p)
  assert.equal(patch.coreConflict, '新冲突')
  assert.equal('lockedBeats' in patch, false)
})
