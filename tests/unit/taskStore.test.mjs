import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_STATUSES,
  createTaskRecord,
  appendDraft,
  settleTaskRecord,
  shouldFlushDraft,
  markRunningInterrupted,
  isRecoverable,
  pickRecoverable,
  pruneTasks,
  taskSummary,
  MAX_DRAFT_CHARS
} from '../../src/services/ai/taskStore.js'

test('任务创建：running、空草稿、时间戳一致', () => {
  const t = createTaskRecord(
    { bookId: 'b1', chapterId: 'c1', action: 'continue', stages: ['write'], model: 'm' },
    { id: 't1', now: 10 }
  )
  assert.equal(t.id, 't1')
  assert.equal(t.status, 'running')
  assert.equal(t.outputText, '')
  assert.equal(t.startedAt, 10)
  assert.equal(t.updatedAt, 10)
  assert.deepEqual(t.stages, ['write'])
})

test('appendDraft 不改入参，超长只保留尾部', () => {
  const base = createTaskRecord({ bookId: 'b1' }, { id: 't', now: 1 })
  const next = appendDraft(base, 'abc', { now: 2, max: 5 })
  assert.equal(base.outputText, '')
  assert.equal(next.outputText, 'abc')
  assert.equal(next.updatedAt, 2)

  const long = appendDraft({ ...base, outputText: '12345' }, '67890', { now: 3, max: 6 })
  assert.equal(long.outputText, '567890')
  assert.equal(long.updatedAt, 3)
})

test('MAX_DRAFT_CHARS 是有界值（不随章节无限增长）', () => {
  assert.ok(Number.isFinite(MAX_DRAFT_CHARS) && MAX_DRAFT_CHARS > 0)
})

test('settleTaskRecord 拒绝未知状态（静默忽略会让任务永远卡在 running）', () => {
  const t = createTaskRecord({ bookId: 'b1' }, { id: 't', now: 1 })
  assert.throws(() => settleTaskRecord(t, { status: 'wat' }), /未知的任务状态/)
  for (const s of TASK_STATUSES) {
    assert.equal(settleTaskRecord(t, { status: s }).status, s)
  }
})

test('结束任务写入错误原因与中止标记', () => {
  const t = createTaskRecord({ bookId: 'b1' }, { id: 't', now: 1 })
  const done = settleTaskRecord(t, {
    status: 'error',
    outputText: '半截正文',
    error: '连接中断',
    finishReason: '',
    now: 9
  })
  assert.equal(done.status, 'error')
  assert.equal(done.outputText, '半截正文')
  assert.equal(done.lastError, '连接中断')
  assert.equal(done.updatedAt, 9)

  const stopped = settleTaskRecord(t, { status: 'aborted', abortedByUser: true })
  assert.equal(stopped.abortedByUser, true)
})

test('草稿节流：800 字或 1.5 秒，任一满足即写', () => {
  // 第一次有内容就写（lastFlushAt 为 0，生产环境里 now 是 epoch 时间戳）
  assert.equal(shouldFlushDraft({ text: 'a', lastFlushAt: 0, lastFlushLength: 0, now: 100000 }), true)
  // 刚写过、字不够 → 不写
  assert.equal(
    shouldFlushDraft({ text: 'a'.repeat(10), lastFlushAt: 1000, lastFlushLength: 10, now: 1200 }),
    false
  )
  // 字数增量够了 → 写
  assert.equal(
    shouldFlushDraft({ text: 'a'.repeat(810), lastFlushAt: 1000, lastFlushLength: 10, now: 1200 }),
    true
  )
  // 时间窗口到了 → 写
  assert.equal(
    shouldFlushDraft({ text: 'a'.repeat(11), lastFlushAt: 1000, lastFlushLength: 10, now: 2500 }),
    true
  )
  assert.equal(shouldFlushDraft({ text: '', lastFlushAt: 0, lastFlushLength: 0, now: 9999 }), false)
})

test('打开书时只把「不是本会话活跃任务」的 running 标成 interrupted', () => {
  const tasks = [
    { id: 'a', status: 'running', outputText: 'x', updatedAt: 1 },
    { id: 'b', status: 'running', outputText: 'y', updatedAt: 1 },
    { id: 'c', status: 'done', outputText: 'z', updatedAt: 1 }
  ]
  const res = markRunningInterrupted(tasks, { activeTaskId: 'a', now: 50 })
  assert.equal(res.changed, 1)
  assert.equal(res.tasks[0].status, 'running')
  assert.equal(res.tasks[1].status, 'interrupted')
  assert.equal(res.tasks[1].updatedAt, 50)
  assert.equal(res.tasks[2].status, 'done')
  // 原数组不被修改
  assert.equal(tasks[1].status, 'running')
})

test('可恢复判定：只有中断/出错且有内容', () => {
  assert.equal(isRecoverable({ status: 'interrupted', outputText: ' x ' }), true)
  assert.equal(isRecoverable({ status: 'error', outputText: 'x' }), true)
  assert.equal(isRecoverable({ status: 'aborted', outputText: 'x' }), false)
  assert.equal(isRecoverable({ status: 'interrupted', outputText: '   ' }), false)
  assert.equal(isRecoverable(null), false)
})

test('pickRecoverable 选最新一条，忽略空草稿与已结束任务', () => {
  const picked = pickRecoverable([
    { id: 'old', status: 'interrupted', outputText: 'a', updatedAt: 10, startedAt: 1 },
    { id: 'new', status: 'error', outputText: 'b', updatedAt: 30, startedAt: 2 },
    { id: 'empty', status: 'interrupted', outputText: '', updatedAt: 99, startedAt: 3 },
    { id: 'done', status: 'done', outputText: 'c', updatedAt: 100, startedAt: 4 }
  ])
  assert.equal(picked.id, 'new')
  assert.equal(pickRecoverable([]), null)
})

test('裁剪：running 永不删，其余只保留最近 keep 条', () => {
  const tasks = [
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `s${i}`,
      status: 'done',
      updatedAt: i,
      startedAt: i
    })),
    { id: 'r1', status: 'running', updatedAt: 0, startedAt: 0 },
    { id: 'r2', status: 'running', updatedAt: 0, startedAt: 0 }
  ]
  const kept = pruneTasks(tasks, 20)
  assert.equal(kept.filter((t) => t.status === 'running').length, 2)
  assert.equal(kept.filter((t) => t.status !== 'running').length, 20)
  // 保留的是 updatedAt 最大的那 20 条：5..24
  assert.ok(kept.some((t) => t.id === 's24'))
  assert.ok(!kept.some((t) => t.id === 's4'))
})

test('taskSummary 给恢复条一个如实的文案', () => {
  assert.equal(
    taskSummary({ status: 'interrupted', outputText: '一二三' }),
    '已中断 · 已保留 3 字'
  )
})
