// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import { chatStream } from '../llm.js'
import { classifyError, shouldRetry, computeBackoff } from './errors.js'

/**
 * 可靠的流式请求封装。
 *
 * 直接调 `chatStream` 的路径没有任何容错：一次瞬时断网、一次 429、一次
 * 服务端 502 都会让整章生成失败。但「无脑重试」在这里比不重试更危险 ——
 * 每一次重试都是一次真实计费调用。所以规则刻意收得很紧：
 *
 * 1. **只在还没收到任何正文时重试**。收到一个字之后就绝不自动重发：
 *    重试会再次计费，而且两段生成的接缝既不连贯，用户也无法分辨。
 * 2. **只重试瞬时故障**：network / timeout / 429 / 5xx，最多 2 次。
 *    401/403/400/404 是配置或权限问题，重试一百次也一样。
 * 3. **每次重试都明说**：`onRetry` 把「第几次、等多久、为什么」交给界面，
 *    不让它在后台悄悄发生。
 * 4. **停顿超时算失败**：服务端接了连接却不再发数据，比直接报错更难察觉。
 *    空闲计时器在每次收到数据时重置。
 * 5. **截断不是成功**：`finish_reason === 'length'` 时正文保留，但走
 *    `onTruncated`，由调用方标成「被截断」而不是「已完成」。
 */

export const DEFAULT_IDLE_TIMEOUT_SEC = 60
export const DEFAULT_MAX_RETRIES = 2

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeFinishReason(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  return String(payload.finishReason || payload.finish_reason || '')
}

/** 截断判定：OpenAI 系是 length，部分兼容端点写 max_tokens。 */
export function isTruncatedFinishReason(reason) {
  return reason === 'length' || reason === 'max_tokens'
}

/**
 * @param {object} opts
 * @param {object} opts.settings  传给 chatStream 的设置
 * @param {Array}  opts.messages
 * @param {object} opts.callbacks { onDelta, onUsage, onDone({finishReason}),
 *                                 onError(info), onAborted(), onRetry({attempt,delayMs,category}),
 *                                 onTruncated(info) }
 * @param {Function} [opts.chat]   底层实现，测试时注入
 * @param {number} [opts.maxRetries=2]
 * @param {number} [opts.idleTimeoutSec=60]  0 表示关闭
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.random]
 * @returns {{ abort: Function, promise: Promise<object>, attempts: Function }}
 */
export function chatStreamReliable({
  settings,
  messages,
  callbacks = {},
  chat = chatStream,
  maxRetries = DEFAULT_MAX_RETRIES,
  idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC,
  sleep = defaultSleep,
  random = Math.random
} = {}) {
  let text = ''
  let attemptsStarted = 0
  let finished = false
  let userAborted = false
  let timedOut = false
  let attemptSettled = false
  let current = null
  let idleTimer = null
  let retryTimer = null
  let resolveDone = null

  const promise = new Promise((resolve) => {
    resolveDone = resolve
  })

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function armIdle() {
    clearIdle()
    const sec = Number(idleTimeoutSec) || 0
    if (sec <= 0 || finished) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (finished || attemptSettled) return
      timedOut = true
      try {
        current?.abort?.()
      } catch {
        // 底层已经结束：直接按超时收尾
        handleFailure({ category: 'timeout', message: '空闲超时' })
      }
    }, sec * 1000)
  }

  function resolveOnce(result) {
    if (finished) return
    finished = true
    clearIdle()
    clearRetryTimer()
    resolveDone(result)
  }

  function finishAborted() {
    if (finished) return
    callbacks.onAborted?.()
    resolveOnce({ ok: false, aborted: true, attempts: attemptsStarted, text, finishReason: '' })
  }

  function finishSuccess(finishReason, payload) {
    if (finished) return
    if (isTruncatedFinishReason(finishReason)) {
      const info = classifyError(
        {
          category: 'truncated',
          message: `输出达到上限被截断（finish_reason=${finishReason}）`
        }
      )
      if (callbacks.onTruncated) {
        callbacks.onTruncated({ ...info, finishReason, textLength: text.length })
      } else {
        // 没有专门的处理器时也绝不能静默当成功：退回到错误通道，
        // 让调用方至少看到一次提示。正文本身仍由 onDelta 保留在调用方。
        callbacks.onError?.({ ...info, finishReason, textLength: text.length })
      }
      resolveOnce({
        ok: true,
        aborted: false,
        truncated: true,
        attempts: attemptsStarted,
        text,
        finishReason
      })
      return
    }
    callbacks.onDone?.({ finishReason, ...(payload || {}) })
    resolveOnce({ ok: true, aborted: false, truncated: false, attempts: attemptsStarted, text, finishReason })
  }

  function handleFailure(err) {
    if (finished) return
    if (userAborted) {
      finishAborted()
      return
    }
    let info
    if (timedOut) {
      info = classifyError({
        category: 'timeout',
        message: '空闲超时：服务端长时间没有返回数据'
      })
    } else {
      info = classifyError(err)
    }
    if (info.category === 'aborted') {
      finishAborted()
      return
    }

    const retriesUsed = Math.max(0, attemptsStarted - 1)
    if (
      shouldRetry(info, {
        attempt: retriesUsed,
        maxRetries,
        hasText: text.length > 0,
        aborted: userAborted
      })
    ) {
      const delayMs = computeBackoff(retriesUsed, { retryAfterMs: info.retryAfterMs, random })
      callbacks.onRetry?.({
        attempt: retriesUsed + 1,
        delayMs,
        category: info.category,
        message: info.message,
        retryAfterMs: info.retryAfterMs
      })
      const wait = Number(delayMs) > 0 ? sleep(delayMs) : Promise.resolve()
      Promise.resolve(wait)
        .then(() => {
          if (finished) return
          if (userAborted) {
            finishAborted()
            return
          }
          start()
        })
        .catch(() => {
          if (finished) return
          callbacks.onError?.(info)
          resolveOnce({
            ok: false,
            aborted: false,
            attempts: attemptsStarted,
            text,
            finishReason: '',
            error: info
          })
        })
      return
    }

    let finalInfo = info
    if (text.length > 0 && info.retryable) {
      finalInfo = {
        ...info,
        message: `${info.message} 已收到的 ${text.length} 字内容已保留；不会自动重试（会再次计费），可手动重新生成。`
      }
    }
    callbacks.onError?.(finalInfo)
    resolveOnce({
      ok: false,
      aborted: false,
      attempts: attemptsStarted,
      text,
      finishReason: '',
      error: finalInfo
    })
  }

  function start() {
    if (finished) return
    attemptsStarted += 1
    attemptSettled = false
    timedOut = false
    armIdle()
    let handle = null
    try {
      handle = chat({
        settings,
        messages,
        callbacks: {
          onDelta(t) {
            if (finished || attemptSettled) return
            armIdle()
            text += String(t || '')
            callbacks.onDelta?.(t)
          },
          onUsage(u) {
            if (finished || attemptSettled) return
            armIdle()
            callbacks.onUsage?.(u)
          },
          onDone(payload) {
            if (finished || attemptSettled) return
            attemptSettled = true
            clearIdle()
            finishSuccess(normalizeFinishReason(payload), payload)
          },
          onAborted() {
            if (finished || attemptSettled) return
            attemptSettled = true
            clearIdle()
            if (timedOut) {
              // 我们自己掐断的空闲超时：走错误通道，让调用方看到「超时」而不是
              // 「用户取消」（有正文时同样不重试，由 handleFailure 统一判定）。
              handleFailure({ category: 'timeout', message: '空闲超时' })
            } else {
              // 用户点了停止，或底层传输被系统/网络掐断。**一律不重试**：
              // 中止的那一刻服务端可能已经生成并计费，重发只会重复扣费；
              // 而且用户按下停止时最不该发生的事就是「它又偷偷跑了一次」。
              // 已收到的草稿仍保留在 text 里，调用方据此提示「可手动重新生成」。
              finishAborted()
            }
          },
          onError(err) {
            if (finished || attemptSettled) return
            attemptSettled = true
            clearIdle()
            handleFailure(err)
          }
        }
      })
    } catch (err) {
      attemptSettled = true
      clearIdle()
      handleFailure(err)
      return
    }
    if (handle && typeof handle.abort === 'function') current = handle
    else if (handle && handle.controller) current = handle
  }

  function abort() {
    if (finished) return
    userAborted = true
    clearIdle()
    clearRetryTimer()
    if (attemptSettled || !current) {
      // 正在退避等待、或底层从未真正开始：直接收尾
      finishAborted()
      return
    }
    try {
      current.abort?.()
    } catch {
      finishAborted()
    }
  }

  start()

  return {
    abort,
    promise,
    attempts: () => attemptsStarted
  }
}
