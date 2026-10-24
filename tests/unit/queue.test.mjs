import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUEUE_ACTIVE_STATUSES,
  QUEUE_RETRYABLE_STATUSES,
  MAX_RESULT_CHARS,
  canTransition,
  isTerminalStatus,
  capResultText,
  createQueueItem,
  normalizeQueueItem,
  sortQueueItems,
  transitionQueueItem,
  nextRunnable,
  recoverQueueItems,
  queueSummary,
  queueItemTitle,
  hasUsableResult,
  queueBudgetExceeded
} from '../../src/services/ai/queue.js'
import { createQueueRunner } from '../../src/services/ai/queueRunner.js'

function item(over = {}) {
  return createQueueItem({ id: 'i1', bookId: 'b1', chapterId: 'c1', title: '第一章', now: 1000, ...over })
}

test('createQueueItem：默认 queued、计次为 0、可注入 id 与时间', () => {
  const it = item()
  assert.equal(it.status, 'queued')
  assert.equal(it.attempts, 0)
  assert.equal(it.createdAt, 1000)
  assert.equal(it.updatedAt, 1000)
  assert.equal(it.result, null)
  assert.equal(it.error, '')
  assert.ok(QUEUE_ACTIVE_STATUSES.includes(it.status))
})

test('状态迁移：合法与非法都显式，done 是终点', () => {
  assert.equal(canTransition('queued', 'running'), true)
  assert.equal(canTransition('running', 'done'), true)
  assert.equal(canTransition('failed', 'queued'), true)
  assert.equal(canTransition('interrupted', 'queued'), true)
  assert.equal(canTransition('canceled', 'queued'), true)
  assert.equal(canTransition('blocked', 'queued'), true)
  assert.equal(canTransition('done', 'queued'), false)
  assert.equal(canTransition('queued', 'done'), false)
  assert.equal(canTransition('running', 'blocked'), false)
  assert.equal(isTerminalStatus('done'), true)
  assert.equal(isTerminalStatus('failed'), true)
  assert.equal(isTerminalStatus('canceled'), true)
  assert.equal(isTerminalStatus('running'), false)
})

test('transitionQueueItem：非法迁移返回 null（不能装作成功）', () => {
  const it = item()
  assert.equal(transitionQueueItem(it, 'done'), null)
  const running = transitionQueueItem(it, 'running', { updatedAt: 2000 })
  assert.equal(running.status, 'running')
  assert.equal(running.updatedAt, 2000)
  const done = transitionQueueItem(running, 'done', {
    result: { text: '正文', runId: 'r1', usage: { cost: 1 } }
  })
  assert.equal(done.status, 'done')
  assert.equal(done.result.text, '正文')
  assert.equal(done.result.chars, 2)
  // 原对象不被修改
  assert.equal(running.status, 'running')
})

test('capResultText：按码点截断，不切坏代理对', () => {
  assert.equal(capResultText('短文本'), '短文本')
  assert.equal(capResultText('abcdef', 3), 'abc')
  const emoji = '😀😀😀'
  const cut = capResultText(emoji, 2)
  assert.equal(Array.from(cut).length, 2)
  assert.equal(cut, '😀😀')
  assert.equal(capResultText('x'.repeat(MAX_RESULT_CHARS + 10)).length, MAX_RESULT_CHARS)
  assert.equal(capResultText(null), '')
})

test('normalizeQueueItem：未知状态降级为 failed，不让人卡在 running', () => {
  const bad = normalizeQueueItem({ id: 'x', status: 'weird', bookId: 'b' }, 5)
  assert.equal(bad.status, 'failed')
  assert.equal(bad.createdAt, 5)
  assert.equal(bad.result, null)
  const withResult = normalizeQueueItem({
    id: 'y',
    status: 'done',
    result: { text: 'a'.repeat(MAX_RESULT_CHARS + 5), appliedAt: 9 }
  })
  assert.equal(withResult.result.chars, MAX_RESULT_CHARS)
  assert.equal(withResult.result.appliedAt, 9)
  assert.equal(normalizeQueueItem({ id: 'z', kind: 'newChapter' }).kind, 'newChapter')
})

test('sortQueueItems：按 order → createdAt → id 稳定排序', () => {
  const list = [
    item({ id: 'b', order: 2 }),
    item({ id: 'a', order: 1 }),
    item({ id: 'c', order: 2, createdAt: 999 })
  ]
  assert.deepEqual(sortQueueItems(list).map((x) => x.id), ['a', 'b', 'c'])
})

test('nextRunnable：暂停/书不匹配/章节已删都不返回', () => {
  const list = [
    { ...item({ id: 'a', order: 1 }), status: 'done' },
    item({ id: 'b', order: 2 })
  ]
  assert.equal(nextRunnable(list, { paused: true }), null)
  assert.equal(nextRunnable(list, { bookId: 'b2' }), null)
  assert.equal(nextRunnable(list, { chapterExists: () => false }), null)
  assert.equal(nextRunnable(list, { chapterExists: () => true }).id, 'b')
  assert.equal(nextRunnable([{ ...item({ id: 'c' }), chapterId: '' }], {}), null)
});

test('recoverQueueItems：running 转 interrupted，绝不自动重跑，且幂等', () => {
  const raw = [
    { ...item({ id: 'a' }), status: 'running' },
    item({ id: 'b' })
  ]
  const first = recoverQueueItems(raw, { now: 5000 })
  assert.equal(first.changed, true)
  assert.equal(first.items[0].status, 'interrupted')
  assert.ok(first.items[0].error.includes('未自动重跑'))
  assert.equal(first.items[0].updatedAt, 5000)
  assert.equal(first.items[1].status, 'queued')
  // 第二次不再改动 —— 否则每次打开书都像出了事
  const second = recoverQueueItems(first.items, { now: 6000 })
  assert.equal(second.changed, false)
  assert.equal(second.items[0].status, 'interrupted')
  // 本会话仍然活跃的条目不能被打断
  const active = recoverQueueItems(raw, { activeIds: ['a'], now: 5000 })
  assert.equal(active.changed, false)
  assert.equal(active.items[0].status, 'running')
})

test('queueSummary / queueItemTitle / hasUsableResult', () => {
  const list = [
    item({ id: 'a' }),
    { ...item({ id: 'b' }), status: 'running' },
    { ...item({ id: 'c' }), status: 'done', result: { text: '正文', chars: 2 } },
    { ...item({ id: 'd' }), status: 'failed', result: { text: '半章', chars: 2 } }
  ]
  const s = queueSummary(list)
  assert.equal(s.total, 4)
  assert.equal(s.pending, 2)
  assert.equal(s.done, 1)
  assert.equal(s.failed, 1)
  assert.equal(queueItemTitle(list[0], { title: '章标题' }), '第一章')
  assert.equal(queueItemTitle({}, { title: '章标题' }), '章标题')
  assert.equal(hasUsableResult(list[2]), true)
  assert.equal(hasUsableResult(list[3]), true)
  assert.equal(hasUsableResult({ result: { text: 'x', appliedAt: 1 } }), false)
  assert.equal(hasUsableResult({ result: { text: '   ' } }), false)
  assert.equal(QUEUE_RETRYABLE_STATUSES.includes('failed'), true)
})

test('queueBudgetExceeded：未定价导致合计不完整时不据此停队列', () => {
  assert.deepEqual(queueBudgetExceeded({ total: 99 }, { budgetDaily: 0 }), {
    over: false,
    spent: 99
  })
  assert.equal(queueBudgetExceeded({ total: 5, complete: true }, { budgetDaily: 3 }).over, true)
  assert.equal(queueBudgetExceeded({ total: 5, complete: false }, { budgetDaily: 3 }).over, false)
})

test('queueRunner：严格串行，一项跑完才拿下一项', async () => {
  const calls = []
  let running = null
  const queue = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' }
  ]
  let i = 0
  const runner = createQueueRunner({
    getNext: async () => queue[i++] || null,
    runItem: async (it) => {
      calls.push('start:' + it.id)
      await new Promise((r) => setTimeout(r, 5))
      calls.push('end:' + it.id)
      return { status: 'done' }
    },
    flush: async () => calls.push('flush'),
    setRunning: (v) => {
      running = v
    },
    onItemEnd: async () => false
  })
  await runner.start()
  assert.deepEqual(calls, [
    'flush',
    'start:a',
    'end:a',
    'flush',
    'start:b',
    'end:b',
    'flush',
    'start:c',
    'end:c'
  ])
  assert.equal(running, false)
  assert.equal(runner.isRunning(), false)
})

test('queueRunner：重复 start 不开第二条循环', async () => {
  let runs = 0
  const runner = createQueueRunner({
    getNext: async () => {
      if (runs >= 2) return null
      runs++
      return { id: String(runs) }
    },
    runItem: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { status: 'done' }
    }
  })
  const p1 = runner.start()
  const p2 = runner.start()
  assert.equal(p1, p2)
  await p1
  assert.equal(runs, 2)
})

test('queueRunner：失败即停，后续条目不会被执行', async () => {
  const queue = [{ id: 'a' }, { id: 'b' }]
  let i = 0
  const seen = []
  const runner = createQueueRunner({
    getNext: async () => queue[i++] || null,
    runItem: async (it) => {
      seen.push(it.id)
      return { status: 'failed', error: 'Key 无效' }
    },
    onItemEnd: async (_it, res) => res.status === 'failed'
  })
  await runner.start()
  assert.deepEqual(seen, ['a'])
  assert.equal(i, 1)
})

test('queueRunner：runItem 抛错也走 onItemEnd，并转成 failed', async () => {
  const results = []
  let running = null
  const runner = createQueueRunner({
    getNext: (() => {
      let n = 0
      return async () => (n++ === 0 ? { id: 'a' } : null)
    })(),
    runItem: async () => {
      throw new Error('网络炸了')
    },
    setRunning: (v) => {
      running = v
    },
    onItemEnd: async (_it, res) => {
      results.push(res)
      return false
    }
  })
  await runner.start()
  assert.equal(results[0].status, 'failed')
  assert.ok(results[0].error.includes('网络炸了'))
  assert.equal(running, false)
})

test('queueRunner：stop 让当前项跑完，但不再启动下一项', async () => {
  const queue = [{ id: 'a' }, { id: 'b' }]
  let i = 0
  const seen = []
  let runner = null
  runner = createQueueRunner({
    getNext: async () => queue[i++] || null,
    runItem: async (it) => {
      seen.push(it.id)
      if (it.id === 'a') runner.stop()
      return { status: 'done' }
    },
    onItemEnd: async () => false
  })
  await runner.start()
  assert.deepEqual(seen, ['a'])
})

test('queueRunner：flush 抛错不阻断生成，但会报给 onError', async () => {
  const errors = []
  let n = 0
  const runner = createQueueRunner({
    getNext: async () => (n++ === 0 ? { id: 'a' } : null),
    runItem: async () => ({ status: 'done' }),
    flush: async () => {
      throw new Error('flush 失败')
    },
    onError: (e) => errors.push(String(e && e.message))
  })
  await runner.start()
  assert.deepEqual(errors, ['flush 失败'])
})
