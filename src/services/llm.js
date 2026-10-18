// OpenAI 兼容大模型客户端：支持 SSE 流式输出。
// 桌面端（Electron）走主进程 IPC 代理（规避 CORS）；浏览器 / Android WebView 直连。
//
// 错误一律以**对象**交给调用方（成功路径见 request.js 的可靠封装）：
//   { category, status, retryable, retryAfterMs, message, action, detail }
// 字符串形式的旧契约已移除 —— 调用方只需要一处 `onError(info)`。

import { classifyError } from './ai/errors.js'

let reqSeq = 0
function genRequestId() {
  reqSeq += 1
  return `req_${Date.now()}_${reqSeq}`
}

/** 规范化 chat/completions 接口地址 */
export function buildChatUrl(baseUrl) {
  let u = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!u) u = 'https://api.deepseek.com'
  if (!/\/chat\/completions$/.test(u)) u += '/chat/completions'
  return u
}

/** 取出 `data:` 行的 JSON 负载；非 SSE 行、`[DONE]`、解析失败一律返回 null */
function parseSseJson(line) {
  const s = (line || '').trim()
  if (!s.startsWith('data:')) return null
  const data = s.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    // 某些兼容端点可能返回非标准行，忽略
    return null
  }
}

function contentOf(json) {
  const content = json?.choices?.[0]?.delta?.content
  return typeof content === 'string' ? content : ''
}

/** 解析一行 SSE 数据，返回增量文本；无法解析时返回空串 */
export function parseSseLine(line) {
  return contentOf(parseSseJson(line))
}

/**
 * 解析一行 SSE 里的用量信息，没有则返回 null。
 *
 * **必须独立于 `choices` 判断**，这是这个功能最常见的实现错误：
 *
 *   - DeepSeek 把 `usage` 挂在**最后一个内容块**上 —— `choices` 有一个元素、
 *     `delta` 是空的、`finish_reason` 非空。凡是「只在有 content 时才看 usage」
 *     或「只挑 delta.content 非空的行」的写法，取到的永远是 0。
 *   - OpenAI / vLLM / Kimi 那类发的是**独立的一个 usage 块**，`choices` 是空数组。
 *     凡是「先看 choices[0] 存在与否」的写法，这一整块会被直接跳过。
 *
 * 两种形状都要认，所以这里只看顶层 `usage`。
 *
 * 另一个坑：OpenAI 在**每一个**非末尾块上都带 `"usage": null`，
 * 所以必须判「不是对象就返回 null」，不能只判字段在不在 ——
 * 否则每个块都会推一次 0，最后一刻的真实用量反而被覆盖掉。
 */
export function parseSseUsage(line) {
  return usageOf(parseSseJson(line))
}

function usageOf(json) {
  const u = json?.usage
  if (!u || typeof u !== 'object') return null
  const input = u.prompt_tokens ?? u.input_tokens
  const output = u.completion_tokens ?? u.output_tokens
  if (input == null && output == null) return null
  return {
    inputTokens: Number(input) || 0,
    outputTokens: Number(output) || 0,
    totalTokens: Number(u.total_tokens) || (Number(input) || 0) + (Number(output) || 0),
    // 缓存命中量一并留下：它不参与本轮的计价（价目表里没有缓存价这一档），
    // 但它是服务商返回的原始信息，解析层丢掉就再也找不回来了。
    cachedTokens:
      Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens) || 0
  }
}

/**
 * 一次解析，同时取出增量文本与用量。
 *
 * 流式路径上每一行都跑它，故只 JSON.parse 一次 —— 分别调 parseSseLine 与
 * parseSseUsage 会让每个块被解析两遍。两个导出函数本身保留，
 * 因为它们各自被单独断言过，且是模块的公开契约。
 */
export function parseSseChunk(line) {
  const json = parseSseJson(line)
  return {
    text: contentOf(json),
    usage: usageOf(json),
    finishReason: finishReasonOf(json),
    error: errorOf(json)
  }
}

/** 结束原因：'stop' 正常结束，'length'/'max_tokens' 表示被长度上限截断。 */
function finishReasonOf(json) {
  const r = json?.choices?.[0]?.finish_reason
  return typeof r === 'string' ? r : ''
}

/**
 * 流内错误块：`data: {"error": {"message": "...", "type": "..."}}`。
 * 有的兼容端点在 HTTP 200 的流里发这个（限流、余额不足都可能这样），
 * 不识别的话会表现为「生成突然结束、正文为空、没有任何提示」。
 */
function errorOf(json) {
  const e = json?.error
  if (!e) return null
  if (typeof e === 'string') return { message: e }
  return {
    message: String(e.message || e.type || '服务端返回错误'),
    code: String(e.code || ''),
    type: String(e.type || '')
  }
}

// ---------------------------------------------------------------------------
// 桌面端 IPC 事件中枢：模块级只注册一次监听，按 requestId 分发。
// （经实测，在 chatStream 函数体内逐次注册 onDone/onError 无法可靠收到事件，
//   而模块级一次性注册稳定可靠，故采用本方案。）
// ---------------------------------------------------------------------------
const ipcHub = {
  delta: new Map(),
  usage: new Map(),
  done: new Map(),
  aborted: new Map(),
  error: new Map(),
  // 结束原因在 delta 行里，但 onDone 事件本身不带负载；在这里中转一次，
  // 让 onDone({ finishReason }) 的契约在两条传输路径上完全一致。
  finish: new Map()
}
let hubReady = false

function hubCleanup(id) {
  ipcHub.delta.delete(id)
  ipcHub.usage.delete(id)
  ipcHub.done.delete(id)
  ipcHub.aborted.delete(id)
  ipcHub.error.delete(id)
  ipcHub.finish.delete(id)
}

function ensureIpcHub() {
  if (hubReady || !window.electronAPI?.isDesktop) return
  hubReady = true
  window.electronAPI.onDelta(({ requestId, line }) => {
    // 同一行里文本与用量各取各的：DeepSeek 把 usage 挂在最后一个**内容块**上
    // （该块 delta 为空），独立 usage 块则反过来没有文本。任何「有文本才处理
    // 用量」的写法都会漏掉前者。
    const { text, usage, finishReason, error } = parseSseChunk(line)
    if (finishReason) ipcHub.finish.set(requestId, finishReason)
    if (error) {
      // 流内错误是终止错误：先收尾，后续行不再分发
      const cb = ipcHub.error.get(requestId)
      hubCleanup(requestId)
      cb?.(error)
      return
    }
    if (usage) ipcHub.usage.get(requestId)?.(usage)
    if (text) ipcHub.delta.get(requestId)?.(text)
  })
  window.electronAPI.onDone((id) => {
    const cb = ipcHub.done.get(id)
    if (cb) {
      const finishReason = ipcHub.finish.get(id) || ''
      hubCleanup(id)
      cb({ finishReason })
    }
  })
  window.electronAPI.onAborted((id) => {
    const cb = ipcHub.aborted.get(id)
    if (cb) {
      hubCleanup(id)
      cb()
    }
  })
  window.electronAPI.onError((payload) => {
    const id = payload && payload.requestId
    if (!id) return
    const cb = ipcHub.error.get(id)
    if (cb) {
      hubCleanup(id)
      cb(payload)
    }
  })
}

// 渲染进程加载即注册（模块作用域）
if (typeof window !== 'undefined') ensureIpcHub()

/** 空闲超时秒数：每次收到数据重置；0 表示关闭。默认 60 秒。 */
export function idleTimeoutSecOf(settings) {
  const n = Number(settings?.requestIdleTimeoutSec)
  if (!Number.isFinite(n) || n < 0) return 60
  return n
}

/**
 * 发起流式对话（底层实现；需要重试/退避请用 ai/request.js 的 chatStreamReliable）。
 *
 * @param {object} opts
 * @param {object} opts.settings    { baseUrl, apiKey, model, temperature, maxTokens, requestIdleTimeoutSec }
 * @param {Array}  opts.messages    [{role:'system'|'user'|'assistant', content}]
 * @param {object} opts.callbacks   { onDelta(text), onUsage(usage), onDone({finishReason}),
 *                                    onError(info), onAborted() }
 * @param {boolean} [opts.forceBrowser]  测试用：强制走浏览器直连路径
 * @returns {{ abort: Function }}
 */
export function chatStream({ settings, messages, callbacks = {}, forceBrowser = false }) {
  const url = buildChatUrl(settings.baseUrl)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey || ''}`
  }
  const body = {
    model: settings.model || 'deepseek-chat',
    messages,
    temperature: Number(settings.temperature ?? 1.0),
    max_tokens: Number(settings.maxTokens ?? 4096),
    stream: true
  }
  // 让服务端在流末尾附一个 usage 块。少数兼容端点不认这个字段会直接 400，
  // 所以留了 settings.streamUsage 开关（默认开）。
  if (settings.streamUsage !== false) body.stream_options = { include_usage: true }

  const idleSec = idleTimeoutSecOf(settings)

  // 桌面端：经 Electron 主进程代理
  if (window.electronAPI?.isDesktop && !forceBrowser) {
    const requestId = genRequestId()
    ensureIpcHub()
    let settled = false
    let idleTimer = null

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
    const timeoutInfo = () =>
      classifyError({ category: 'timeout', message: '空闲超时：服务端长时间没有返回数据' })

    const emitTimeout = () => {
      if (settled) return
      settled = true
      clearIdle()
      hubCleanup(requestId)
      callbacks.onError?.(timeoutInfo())
      try {
        window.electronAPI.abortChat(requestId)
      } catch {
        // 主进程已经收尾，忽略
      }
    }
    const armIdle = () => {
      clearIdle()
      if (idleSec <= 0) return
      idleTimer = setTimeout(emitTimeout, idleSec * 1000)
    }
    const finish = (cb, payload) => {
      if (settled) return
      settled = true
      clearIdle()
      cb?.(payload)
    }

    ipcHub.delta.set(requestId, (t) => {
      armIdle()
      if (!settled) callbacks.onDelta?.(t)
    })
    ipcHub.usage.set(requestId, (u) => {
      armIdle()
      if (!settled) callbacks.onUsage?.(u)
    })
    ipcHub.done.set(requestId, (payload) => finish(callbacks.onDone, payload || { finishReason: '' }))
    ipcHub.aborted.set(requestId, () => finish(callbacks.onAborted))
    ipcHub.error.set(requestId, (payload) => {
      if (settled) return
      settled = true
      clearIdle()
      callbacks.onError?.(classifyError(payload))
    })

    armIdle()
    Promise.resolve(window.electronAPI.chatCompletions({ requestId, url, headers, body })).catch(
      (err) => {
        if (settled) return
        settled = true
        clearIdle()
        hubCleanup(requestId)
        callbacks.onError?.(classifyError(err))
      }
    )
    return {
      abort: () => {
        clearIdle()
        try {
          window.electronAPI.abortChat(requestId)
        } catch {
          // 忽略
        }
      }
    }
  }

  // 浏览器 / Android WebView：直连
  const controller = new AbortController()
  let settled = false
  let idleTimer = null
  let finishReason = ''

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const emitError = (err) => {
    if (settled) return
    settled = true
    clearIdle()
    callbacks.onError?.(classifyError(err))
  }
  const armIdle = () => {
    clearIdle()
    if (idleSec <= 0) return
    idleTimer = setTimeout(() => {
      if (settled) return
      emitError({ category: 'timeout', message: '空闲超时：服务端长时间没有返回数据' })
      try {
        controller.abort()
      } catch {
        // 忽略
      }
    }, idleSec * 1000)
  }

  armIdle()
  ;(async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const t = await res.text()
        const err = new Error(`HTTP ${res.status}: ${t.slice(0, 800)}`)
        err.status = res.status
        const retryAfter = res.headers?.get?.('retry-after')
        if (retryAfter) err.retryAfter = retryAfter
        throw err
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      /** 返回 true 表示这一行是终止错误，外层循环应停止。 */
      const consume = (line) => {
        const chunk = parseSseChunk(line)
        if (chunk.finishReason) finishReason = chunk.finishReason
        if (chunk.error) {
          emitError(chunk.error)
          try {
            controller.abort()
          } catch {
            // 忽略
          }
          return true
        }
        if (chunk.usage) callbacks.onUsage?.(chunk.usage)
        if (chunk.text) callbacks.onDelta?.(chunk.text)
        return false
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        buffer += decoder.decode(value, { stream: true })
        let nl
        let stop = false
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (consume(line)) {
            stop = true
            break
          }
        }
        if (stop || settled) break
      }
      // 尾行兜底：流若在最后一个事件后没有换行就结束，上面那层 while 会把它
      // 留在 buffer 里丢掉。以前丢了只是少几个字，现在 usage 就在末尾那一块里，
      // 丢掉的表现是「这一章永远显示估算用量」——不报错、也看不出来。
      if (!settled && buffer.trim()) consume(buffer)
      if (!settled) {
        settled = true
        clearIdle()
        callbacks.onDone?.({ finishReason })
      }
    } catch (err) {
      if (settled) return
      if (err.name === 'AbortError') {
        settled = true
        clearIdle()
        callbacks.onAborted?.()
      } else {
        emitError(err)
      }
    }
  })()

  return {
    abort: () => {
      try {
        controller.abort()
      } catch {
        // 忽略
      }
    }
  }
}
