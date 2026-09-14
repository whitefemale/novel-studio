// OpenAI 兼容大模型客户端：支持 SSE 流式输出。
// 桌面端（Electron）走主进程 IPC 代理（规避 CORS）；浏览器 / Android WebView 直连。

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

/** 解析一行 SSE 数据，返回增量文本；无法解析时返回空串 */
export function parseSseLine(line) {
  const s = (line || '').trim()
  if (!s.startsWith('data:')) return ''
  const data = s.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const json = JSON.parse(data)
    const content = json.choices?.[0]?.delta?.content
    return typeof content === 'string' ? content : ''
  } catch {
    // 某些兼容端点可能返回非标准行，忽略
    return ''
  }
}

// ---------------------------------------------------------------------------
// 桌面端 IPC 事件中枢：模块级只注册一次监听，按 requestId 分发。
// （经实测，在 chatStream 函数体内逐次注册 onDone/onError 无法可靠收到事件，
//   而模块级一次性注册稳定可靠，故采用本方案。）
// ---------------------------------------------------------------------------
const ipcHub = {
  delta: new Map(),
  done: new Map(),
  aborted: new Map(),
  error: new Map()
}
let hubReady = false

function hubCleanup(id) {
  ipcHub.delta.delete(id)
  ipcHub.done.delete(id)
  ipcHub.aborted.delete(id)
  ipcHub.error.delete(id)
}

function ensureIpcHub() {
  if (hubReady || !window.electronAPI?.isDesktop) return
  hubReady = true
  window.electronAPI.onDelta(({ requestId, line }) => {
    const t = parseSseLine(line)
    if (t) ipcHub.delta.get(requestId)?.(t)
  })
  window.electronAPI.onDone((id) => {
    const cb = ipcHub.done.get(id)
    if (cb) {
      hubCleanup(id)
      cb()
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
      cb(payload.message || '请求失败')
    }
  })
}

// 渲染进程加载即注册（模块作用域）
if (typeof window !== 'undefined') ensureIpcHub()

/**
 * 发起流式对话。
 * @param {object} opts
 * @param {object} opts.settings    { baseUrl, apiKey, model, temperature, maxTokens }
 * @param {Array}  opts.messages    [{role:'system'|'user'|'assistant', content}]
 * @param {object} opts.callbacks   { onDelta(text), onDone(), onError(msg), onAborted() }
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

  // 桌面端：经 Electron 主进程代理
  if (window.electronAPI?.isDesktop && !forceBrowser) {
    const requestId = genRequestId()
    ensureIpcHub()
    ipcHub.delta.set(requestId, (t) => callbacks.onDelta?.(t))
    ipcHub.done.set(requestId, () => callbacks.onDone?.())
    ipcHub.aborted.set(requestId, () => callbacks.onAborted?.())
    ipcHub.error.set(requestId, (msg) => callbacks.onError?.(msg))
    window.electronAPI.chatCompletions({ requestId, url, headers, body })
    return { abort: () => window.electronAPI.abortChat(requestId) }
  }

  // 浏览器 / Android WebView：直连
  const controller = new AbortController()
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
        throw new Error(`HTTP ${res.status}：${t.slice(0, 300)}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          const t = parseSseLine(line)
          if (t) callbacks.onDelta?.(t)
        }
      }
      callbacks.onDone?.()
    } catch (err) {
      if (err.name === 'AbortError') {
        callbacks.onAborted?.()
      } else {
        callbacks.onError?.(err.message || '请求失败')
      }
    }
  })()

  return { abort: () => controller.abort() }
}
