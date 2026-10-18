import test from 'node:test'
import assert from 'node:assert/strict'
import { chatStreamReliable, isTruncatedFinishReason } from '../../src/services/ai/request.js'

/**
 * 假 chat：按步骤依次产出事件。每个步骤：
 *   { text, usage, error, donePayload, throw, silent, abortStream }
 * silent 表示永不回应（用于空闲超时），abort 时回调 onAborted；
 * abortStream 表示底层自己不打招呼就断了（用户没有点停止）。
 */
function makeChat(steps) {
  const calls = []
  const chat = (opts) => {
    const index = Math.min(calls.length, steps.length - 1)
    const step = steps[index] || {}
    calls.push({ opts, step })
    let aborted = false
    const cb = opts.callbacks
    const handle = {
      abort: () => {
        if (aborted) return
        aborted = true
        cb.onAborted?.()
      }
    }
    queueMicrotask(() => {
      if (aborted || step.silent) return
      if (step.text) cb.onDelta?.(step.text)
      if (step.usage) cb.onUsage?.(step.usage)
      if (step.abortStream) cb.onAborted?.()
      else if (step.error) cb.onError?.(step.error)
      else if (step.throw) cb.onError?.(step.throw)
      else cb.onDone?.(step.donePayload || {})
    })
    return handle
  }
  chat.calls = calls
  return chat
}

function run(chat, overrides = {}) {
  const events = {
    deltas: [],
    done: [],
    errors: [],
    retries: [],
    truncated: [],
    aborted: 0
  }
  const sleeps = []
  const handle = chatStreamReliable({
    settings: { baseUrl: 'https://x', apiKey: 'k' },
    messages: [{ role: 'user', content: 'hi' }],
    chat,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    ...overrides,
    callbacks: {
      onDelta: (t) => events.deltas.push(t),
      onDone: (p) => events.done.push(p),
      onError: (e) => events.errors.push(e),
      onRetry: (r) => events.retries.push(r),
      onTruncated: (t) => events.truncated.push(t),
      onAborted: () => (events.aborted += 1)
    }
  })
  return { handle, events, sleeps }
}

test('一次成功：onDone 带 finishReason，attempts=1', async () => {
  const chat = makeChat([{ text: '你好', donePayload: { finishReason: 'stop' } }])
  const { handle, events } = run(chat)
  const res = await handle.promise
  assert.equal(res.ok, true)
  assert.equal(res.truncated, false)
  assert.equal(res.attempts, 1)
  assert.equal(res.text, '你好')
  assert.deepEqual(events.done, [{ finishReason: 'stop' }])
  assert.equal(events.errors.length, 0)
})

test('5xx：没收到正文时退避重试一次后成功', async () => {
  const chat = makeChat([
    { error: { status: 500, message: 'HTTP 500' } },
    { text: '重试成功', donePayload: { finishReason: 'stop' } }
  ])
  const { handle, events, sleeps } = run(chat)
  const res = await handle.promise
  assert.equal(res.ok, true)
  assert.equal(res.attempts, 2)
  assert.equal(res.text, '重试成功')
  assert.equal(events.retries.length, 1)
  assert.equal(events.retries[0].attempt, 1)
  assert.equal(events.retries[0].category, 'server')
  assert.equal(events.retries[0].delayMs, 1000)
  assert.deepEqual(sleeps, [1000])
})

test('收到正文后失败：不自动重试，保留部分内容并明说', async () => {
  const chat = makeChat([{ text: '半截正文', error: { status: 500, message: 'HTTP 500' } }])
  const { handle, events } = run(chat)
  const res = await handle.promise
  assert.equal(res.ok, false)
  assert.equal(res.attempts, 1)
  assert.equal(res.text, '半截正文')
  assert.equal(events.retries.length, 0)
  assert.equal(events.errors.length, 1)
  assert.ok(events.errors[0].message.includes('已保留'))
  assert.ok(events.errors[0].message.includes('再次计费'))
})

test('401/400 不重试', async () => {
  for (const status of [401, 400, 403, 404]) {
    const chat = makeChat([{ error: { status, message: `HTTP ${status}` } }])
    const { handle, events } = run(chat)
    const res = await handle.promise
    assert.equal(res.attempts, 1, `status ${status}`)
    assert.equal(events.retries.length, 0, `status ${status}`)
    assert.equal(events.errors[0].status, status)
  }
})

test('最多重试两次：连续三次 5xx 后报错', async () => {
  const chat = makeChat([{ error: { status: 503 } }])
  const { handle, events, sleeps } = run(chat)
  const res = await handle.promise
  assert.equal(res.attempts, 3)
  assert.equal(events.retries.length, 2)
  assert.equal(events.retries[1].attempt, 2)
  assert.equal(events.retries[1].delayMs, 2000)
  assert.deepEqual(sleeps, [1000, 2000])
  assert.equal(events.errors.length, 1)
  assert.equal(events.errors[0].category, 'server')
})

test('429 尊重 Retry-After', async () => {
  const chat = makeChat([
    { error: { status: 429, retryAfter: '7' } },
    { text: 'ok', donePayload: { finishReason: 'stop' } }
  ])
  const { handle, events, sleeps } = run(chat)
  const res = await handle.promise
  assert.equal(res.ok, true)
  assert.equal(events.retries[0].category, 'rate-limit')
  assert.equal(events.retries[0].retryAfterMs, 7000)
  assert.deepEqual(sleeps, [7000])
})

test('用户中止：立即收尾，不重试', async () => {
  const chat = makeChat([{ silent: true }])
  const { handle, events } = run(chat)
  await Promise.resolve()
  handle.abort()
  const res = await handle.promise
  assert.equal(res.aborted, true)
  assert.equal(events.aborted, 1)
  assert.equal(events.retries.length, 0)
})

test('底层自己中止（非用户操作）：按中止收尾，绝不偷偷重试', async () => {
  const chat = makeChat([{ text: '半截草稿', abortStream: true }, { text: '不该发生' }])
  const { handle, events } = run(chat)
  const res = await handle.promise
  assert.equal(res.aborted, true)
  assert.equal(res.ok, false)
  assert.equal(res.text, '半截草稿')
  assert.equal(res.attempts, 1)
  assert.equal(chat.calls.length, 1)
  assert.equal(events.retries.length, 0)
  assert.equal(events.aborted, 1)
  assert.equal(events.errors.length, 0)
})

test('空闲超时：以 timeout 分类报错，而不是当作「已完成」', async () => {
  const chat = makeChat([{ silent: true }])
  const { handle, events } = run(chat, { idleTimeoutSec: 0.02, maxRetries: 0 })
  const res = await handle.promise
  assert.equal(res.ok, false)
  assert.equal(events.errors.length, 1)
  assert.equal(events.errors[0].category, 'timeout')
  assert.equal(res.aborted, false)
})

test('截断：保留正文、走 onTruncated，不调用 onDone', async () => {
  const chat = makeChat([{ text: '写到一半', donePayload: { finishReason: 'length' } }])
  const { handle, events } = run(chat)
  const res = await handle.promise
  assert.equal(res.ok, true)
  assert.equal(res.truncated, true)
  assert.equal(res.text, '写到一半')
  assert.equal(events.done.length, 0)
  assert.equal(events.truncated.length, 1)
  assert.equal(events.truncated[0].finishReason, 'length')
  assert.equal(events.truncated[0].category, 'truncated')
})

test('没有任何 onTruncated 处理器时也不静默当成功（退回 onError）', async () => {
  const chat = makeChat([{ text: '一半', donePayload: { finishReason: 'max_tokens' } }])
  const errors = []
  const handle = chatStreamReliable({
    settings: {},
    messages: [],
    chat,
    sleep: async () => {},
    callbacks: { onError: (e) => errors.push(e) }
  })
  const res = await handle.promise
  assert.equal(res.truncated, true)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].category, 'truncated')
})

test('每次重试用相同 settings / messages（不是新构造的请求）', async () => {
  const chat = makeChat([{ error: { status: 500 } }, { text: 'ok' }])
  const { handle } = run(chat)
  await handle.promise
  assert.equal(chat.calls.length, 2)
  assert.equal(chat.calls[0].opts.settings, chat.calls[1].opts.settings)
  assert.equal(chat.calls[0].opts.messages, chat.calls[1].opts.messages)
})

test('isTruncatedFinishReason 只认 length / max_tokens', () => {
  assert.equal(isTruncatedFinishReason('length'), true)
  assert.equal(isTruncatedFinishReason('max_tokens'), true)
  assert.equal(isTruncatedFinishReason('stop'), false)
  assert.equal(isTruncatedFinishReason(''), false)
})
