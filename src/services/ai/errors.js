// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。

/**
 * 错误分类、可读文案、密钥脱敏、重试决策。
 *
 * 这一层是纯函数，不碰网络也不碰窗口。它的存在有两个理由：
 *
 * 1. **给用户一句能行动的话。** 「HTTP 401: {"error":{"message":"Authentication
 *    Fails"}}」对用户毫无帮助；「API Key 无效或已过期，请到设置里检查」才是。
 * 2. **在错误进入日志/界面/生成记录之前就把密钥抹掉。** 服务端偶尔会把
 *    请求头回显在错误体里，而本项目一个不可破坏的约束是 API Key 永不出现在
 *    日志、错误报告、导出文件里。脱敏做在这里，所有调用方自动受益。
 *
 * 分类是**保守**的：拿不准一律归 unknown 且不重试。对一次真实计费的调用，
 * 「多试两次」远比「少试两次」危险 —— 重试可能重复扣费。
 */

export const ERROR_CATEGORIES = [
  'network',
  'auth',
  'bad-request',
  'not-found',
  'timeout',
  'rate-limit',
  'server',
  'truncated',
  'parse',
  'aborted',
  'background',
  'unknown'
]

/** 允许自动重试的分类。其余一律不重试。 */
export const RETRYABLE_CATEGORIES = ['network', 'timeout', 'rate-limit', 'server']

/** 各分类的默认文案与建议动作。detail 会另附在字段里，不拼进这句话。 */
const CATEGORY_TEXT = {
  network: {
    message: '网络连接失败，请求没有到达服务端。',
    action: '请检查网络、代理与接口地址；浏览器/手机直连时还要确认服务端允许跨域（CORS）。'
  },
  auth: {
    message: 'API Key 无效、已过期，或没有访问该模型的权限。',
    action: '请到「设置」检查 API Key 与模型名。'
  },
  'bad-request': {
    message: '服务端拒绝了这次请求。',
    action: '请检查模型名、max_tokens 等参数；有的兼容端点不支持 stream_options.include_usage，可在设置里关掉「统计用量」。'
  },
  'not-found': {
    message: '接口地址不存在（404）。',
    action: '请检查「设置」里的接口地址是否填错，例如是否少了 /v1。'
  },
  timeout: {
    message: '请求超时：服务端长时间没有返回任何数据。',
    action: '请检查网络/代理后重试；网络不稳定时可以先缩短生成长度。'
  },
  'rate-limit': {
    message: '请求被限流，或账户余额不足（429）。',
    action: '请稍后再试，并检查账户余额。'
  },
  server: {
    message: '服务端返回了错误（5xx）。',
    action: '这通常与服务商有关，稍后重试即可。'
  },
  truncated: {
    message: '输出达到长度上限被截断。',
    action: '已保留收到的全部内容，可以调高「最大输出」后重新生成剩余部分。'
  },
  parse: {
    message: '服务端返回的内容无法解析。',
    action: '可能是兼容端点返回了非标准格式；可重试一次，或换用官方接口。'
  },
  aborted: {
    message: '请求已取消。',
    action: ''
  },
  background: {
    message: '应用切到后台后请求被系统暂停。',
    action: '回到前台后可手动重新生成；已收到的草稿会保留。'
  },
  unknown: {
    message: '请求失败。',
    action: '可以重试一次；若持续失败，请检查接口地址与模型配置。'
  }
}

/**
 * 把文本里的密钥抹掉。**所有**向外的错误路径都应该先过它。
 *
 * 覆盖的形状：`sk-xxx`、`Bearer xxx`、`Authorization: xxx`、
 * `api_key=xxx` / `"apiKey": "xxx"` / URL 查询参数。宁可比实际需要多抹一点：
 * 一段被抹掉的调试信息远好过一条泄露出去的 Key。
 */
export function redactSecrets(text) {
  let s = String(text == null ? '' : text)
  if (!s) return ''
  s = s.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{6,}/g, 'sk-[redacted]')
  s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
  s = s.replace(
    /((?:authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token)\s*["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]{3,})/gi,
    '$1[redacted]'
  )
  s = s.replace(/([?&](?:api_?key|apikey|key|access_token|token)=)[^&\s]+/gi, '$1[redacted]')
  return s
}

/** 截断错误详情，避免把一整页 HTML 错误页塞进界面与生成记录。 */
function clip(text, max = 300) {
  const s = redactSecrets(text).trim()
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function isAbortName(err) {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'ABORT_ERR' ||
    err?.code === 'EABORTED' ||
    err?.code === 'ABORTED'
  )
}

function extractStatus(input, message) {
  const direct = Number(input?.status ?? input?.statusCode)
  if (Number.isFinite(direct) && direct >= 100 && direct <= 599) return direct
  const m = message.match(/\bHTTP\s+(\d{3})\b/i) || message.match(/\bstatus(?:\s+code)?\s*[:=]\s*(\d{3})\b/i)
  if (m) {
    const n = Number(m[1])
    if (n >= 100 && n <= 599) return n
  }
  return 0
}

function statusCategory(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not-found'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate-limit'
  if (status >= 500 && status <= 599) return 'server'
  if (status >= 400 && status <= 499) return 'bad-request'
  return ''
}

/** 把 Retry-After（秒数或 HTTP 日期）转成毫秒；无效返回 0。 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return 0
  const raw = String(value).trim()
  if (!raw) return 0
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const ms = Number(raw) * 1000
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, at - now)
}

/**
 * 分类一个错误。
 *
 * 入参可以是 Error、已经分类过的对象、字符串或 SSE 里的 error 负载。
 * 返回 `{ category, status, retryable, retryAfterMs, message, action, detail, rawMessage }`。
 * 幂等：把返回值再传进来不会丢失字段。
 */
export function classifyError(input, { now = Date.now(), retryAfterMs } = {}) {
  const obj = input && typeof input === 'object' ? input : {}
  const rawMessage = String(
    typeof input === 'string' ? input : obj.rawMessage || obj.message || obj.error_description || ''
  )
  const detail = clip(rawMessage)

  // 已经是分类结果的（带合法 category）直接沿用，只补齐缺的字段
  const preCategory = ERROR_CATEGORIES.includes(obj.category) ? obj.category : ''
  const status = extractStatus(obj, rawMessage)
  let category = preCategory

  if (!category) {
    const code = String(obj.code || '').toUpperCase()
    const lower = rawMessage.toLowerCase()
    if (isAbortName(obj) || /aborted|已取消|用户中止/.test(lower)) {
      category = 'aborted'
    } else if (code === 'BACKGROUND' || /后台.*暂停|background.*suspend/.test(lower)) {
      category = 'background'
    } else if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || /空闲超时|idle timeout|timed out|timeout/.test(lower)) {
      category = 'timeout'
    } else if (obj.name === 'SyntaxError' || code === 'EPARSE' || /无法解析|parse error|invalid json/.test(lower)) {
      category = 'parse'
    } else if (/截断|truncated|finish_reason.*length/.test(lower)) {
      category = 'truncated'
    } else if (status) {
      category = statusCategory(status) || 'unknown'
    } else if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ENETUNREACH' ||
      code === 'ERR_NETWORK' ||
      /network|failed to fetch|load failed|fetch failed|cors|internet|connection|econn|socket hang up/.test(lower)
    ) {
      category = 'network'
    } else {
      category = 'unknown'
    }
  }

  const textInfo = CATEGORY_TEXT[category] || CATEGORY_TEXT.unknown
  const incomingRetryAfter =
    retryAfterMs != null
      ? retryAfterMs
      : obj.retryAfterMs != null
        ? obj.retryAfterMs
        : parseRetryAfter(obj.headers?.['retry-after'] ?? obj.retryAfter, now)
  const retryAfter = Math.max(0, Number(incomingRetryAfter) || 0)

  return {
    category,
    status: status || 0,
    retryable: RETRYABLE_CATEGORIES.includes(category),
    retryAfterMs: retryAfter,
    message: textInfo.message,
    action: textInfo.action,
    detail,
    // 连「原文」也存脱敏后的版本：这个对象会被传给界面、生成记录与测试钩子，
    // 任何一个出口都不应该带着密钥。诊断需要的上下文 detail 里仍然有。
    rawMessage: detail
  }
}

/**
 * 是否重试。
 *
 * **已收到任何正文时不重试**，这是硬约束：重试会重新计费，而且两次生成的
 * 开头拼在一起既不连贯、也无法让用户分辨。此时应保留部分内容并让用户决定。
 */
export function shouldRetry(
  info,
  { attempt = 0, maxRetries = 2, hasText = false, aborted = false } = {}
) {
  if (!info || aborted) return false
  if (info.category === 'aborted' || info.category === 'truncated') return false
  if (hasText) return false
  if (!info.retryable) return false
  return Number(attempt) < Math.max(0, Number(maxRetries) || 0)
}

/**
 * 第 attempt 次重试前要等多久（attempt 从 0 开始）。
 *
 * 指数退避 1s / 2s / 4s …，带 ±20% 抖动（避免多台设备同时重试打在同一秒）；
 * 服务端给了 Retry-After 就听它的（上限 60s）。返回值非负整数。
 */
export function computeBackoff(
  attempt,
  { retryAfterMs = 0, baseMs = 1000, maxMs = 60000, random = Math.random } = {}
) {
  const n = Math.max(0, Number(attempt) || 0)
  if (retryAfterMs > 0) {
    return Math.min(Math.max(0, Number(retryAfterMs) || 0), maxMs)
  }
  const raw = baseMs * Math.pow(2, n)
  const jitter = 0.8 + (Number(random()) || 0) * 0.4
  return Math.min(Math.round(raw * jitter), maxMs)
}

/**
 * 一行给用户看的错误文案。`detail` 单独放，因为它可能很长且包含服务端原文。
 */
export function describeError(info, { includeDetail = true } = {}) {
  if (!info) return '请求失败。'
  const parts = [info.message]
  if (info.action) parts.push(info.action)
  if (includeDetail && info.detail) parts.push(`详情：${info.detail}`)
  return parts.filter(Boolean).join(' ')
}
