import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyError,
  redactSecrets,
  parseRetryAfter,
  shouldRetry,
  computeBackoff,
  describeError,
  ERROR_CATEGORIES
} from '../../src/services/ai/errors.js'

test('HTTP 状态码分类', () => {
  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [400, 'bad-request'],
    [404, 'not-found'],
    [408, 'timeout'],
    [429, 'rate-limit'],
    [500, 'server'],
    [502, 'server'],
    [418, 'bad-request']
  ]
  for (const [status, category] of cases) {
    const info = classifyError({ status, message: `HTTP ${status}` })
    assert.equal(info.category, category, `status ${status}`)
    assert.equal(info.status, status)
  }
})

test('能从错误消息里认出状态码（兼容端点常只给一句话）', () => {
  const info = classifyError('HTTP 429: rate limited')
  assert.equal(info.category, 'rate-limit')
  assert.equal(info.status, 429)
})

test('网络 / 超时 / 中止 / 解析错误分类', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')).category, 'network')
  assert.equal(classifyError({ code: 'ECONNREFUSED' }).category, 'network')
  assert.equal(classifyError({ name: 'AbortError' }).category, 'aborted')
  assert.equal(classifyError({ code: 'ETIMEDOUT' }).category, 'timeout')
  assert.equal(classifyError('空闲超时：服务端长时间没有返回数据').category, 'timeout')
  assert.equal(classifyError({ name: 'SyntaxError', message: 'Unexpected token' }).category, 'parse')
  // 拿不准的分类不重试
  assert.equal(classifyError('莫名其妙').category, 'unknown')
  assert.equal(classifyError('莫名其妙').retryable, false)
})

test('显式 category 会被保留（主进程/可靠封装已经分好类）', () => {
  const info = classifyError({ category: 'rate-limit', message: '任意文本', retryAfter: '7' })
  assert.equal(info.category, 'rate-limit')
  assert.equal(info.retryAfterMs, 7000)
  // 幂等：把返回值再传回去不丢字段
  const again = classifyError(info)
  assert.equal(again.category, 'rate-limit')
  assert.equal(again.status, info.status)
})

test('错误详情脱敏：sk- / Bearer / Authorization / 查询参数', () => {
  const raw =
    'key=sk-live-ABCDEFGH123456 Bearer abcdefghijklmn "Authorization": "Bearer xyz123456" ' +
    'api_key=plain-secret&access_token=tok123'
  const out = redactSecrets(raw)
  assert.ok(!out.includes('sk-live-ABCDEFGH123456'))
  assert.ok(!out.includes('abcdefghijklmn'))
  assert.ok(!out.includes('plain-secret'))
  assert.ok(!out.includes('tok123'))
  assert.ok(out.includes('[redacted]'))
})

test('分类结果的 detail 已经脱敏（密钥不进入界面/日志）', () => {
  const info = classifyError({
    status: 401,
    message: 'HTTP 401: {"error":"invalid key sk-secret-123456789"}'
  })
  assert.equal(info.category, 'auth')
  assert.ok(!info.detail.includes('sk-secret-123456789'))
  // rawMessage 也必须是脱敏版本：这个对象会流进界面与生成记录
  assert.ok(!info.rawMessage.includes('sk-secret-123456789'))
  assert.ok(describeError(info).includes('API Key'))
  assert.ok(!describeError(info).includes('sk-secret-123456789'))
})

test('Retry-After：秒数与 HTTP 日期', () => {
  assert.equal(parseRetryAfter('3'), 3000)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter('not-a-date'), 0)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000)
})

test('重试决策：只重试瞬时故障，且收到正文后永不重试', () => {
  const server = classifyError({ status: 500 })
  assert.equal(shouldRetry(server, { attempt: 0 }), true)
  assert.equal(shouldRetry(server, { attempt: 1 }), true)
  assert.equal(shouldRetry(server, { attempt: 2 }), false)
  assert.equal(shouldRetry(server, { attempt: 0, hasText: true }), false)
  assert.equal(shouldRetry(server, { attempt: 0, aborted: true }), false)
  assert.equal(shouldRetry(classifyError({ status: 401 }), { attempt: 0 }), false)
  assert.equal(shouldRetry(classifyError({ status: 400 }), { attempt: 0 }), false)
  assert.equal(shouldRetry(classifyError({ status: 429 }), { attempt: 0 }), true)
})

test('退避：指数增长、±20% 抖动、Retry-After 优先', () => {
  assert.equal(computeBackoff(0, { random: () => 0.5 }), 1000)
  assert.equal(computeBackoff(1, { random: () => 0.5 }), 2000)
  assert.equal(computeBackoff(2, { random: () => 0.5 }), 4000)
  assert.equal(computeBackoff(0, { random: () => 0 }), 800)
  assert.equal(computeBackoff(0, { random: () => 1 }), 1200)
  assert.equal(computeBackoff(3, { retryAfterMs: 1234, random: () => 0.5 }), 1234)
  // 上限
  assert.equal(computeBackoff(20, { random: () => 1, maxMs: 10000 }), 10000)
})

test('可读文案区分「不知道多少钱」之外的两类：可行动 vs 只有详情', () => {
  const auth = classifyError({ status: 401 })
  assert.ok(auth.action.includes('设置'))
  const network = classifyError(new TypeError('Failed to fetch'))
  assert.ok(network.action.includes('网络'))
  assert.equal(describeError(auth, { includeDetail: false }).includes('详情'), false)
})

test('ERROR_CATEGORIES 覆盖分类器会产出的所有值', () => {
  const all = [
    classifyError({ status: 401 }),
    classifyError({ status: 400 }),
    classifyError({ status: 404 }),
    classifyError({ status: 408 }),
    classifyError({ status: 429 }),
    classifyError({ status: 500 }),
    classifyError(new TypeError('Failed to fetch')),
    classifyError({ name: 'AbortError' }),
    classifyError({ category: 'truncated', message: '截断' }),
    classifyError('莫名其妙')
  ]
  for (const info of all) assert.ok(ERROR_CATEGORIES.includes(info.category), info.category)
})
