// 显式带 .js：Node 原生 ESM（tests/unit）加载。
import { chatStreamReliable } from './request.js'
import { settingsForStage, modelForStage } from './models.js'
import { estimateTokens } from './tokenUsage.js'

/**
 * 服务商预设与 Provider 抽象。
 *
 * 本项目的所有请求都走 **OpenAI 兼容的 `/chat/completions`**，各家的差别只在
 * 默认地址、模型名，以及「是否必须给 API Key」。所以「多服务商支持」并不意味着
 * 多套协议，而是一张预设表 + 一个统一的调用面：
 *
 *   const p = createProvider({ settings, stage: 'write' })
 *   p.chatStream({ messages, callbacks })   // 带重试/超时/截断
 *   p.chat({ messages })                    // 收集成完整文本
 *
 * 三条刻意的约束：
 *
 * 1. **只有一份 active 凭据**（baseUrl + apiKey + model）。切换服务商只填预设，
 *    不会清空也不覆盖用户已经输入的 Key——见 settings 面板的「填入预设」按钮。
 *    每服务商独立 Key 需要一套密钥槽与迁移，收益远小于风险（会把「我的 Key
 *    到底在用哪个」变成一件需要猜的事）。
 * 2. **providerId 只是展示与预设来源**，请求永远以 settings 里的 baseUrl/model
 *    为准。于是用户把地址改成任意兼容端点时，功能不会因为「预设里没有」而失效。
 * 3. **不引入任何 SDK / tokenizer**：countTokens 用既有的字符估算。
 */

export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresKey: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    requiresKey: true
  },
  {
    id: 'kimi',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-latest', 'moonshot-v1-8k'],
    requiresKey: true
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-flash'],
    requiresKey: true
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max'],
    requiresKey: true
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    requiresKey: true
  },
  {
    id: 'ollama',
    label: '本机 Ollama',
    // Ollama 的 OpenAI 兼容层；Key 可留空（它默认不校验）。
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.1', 'qwen2.5'],
    requiresKey: false
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    requiresKey: true
  }
]

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]))

/** 比较地址时忽略协议大小写、尾部斜杠与已包含的 `/chat/completions`。 */
export function normalizeProviderBaseUrl(baseUrl) {
  let u = String(baseUrl ?? '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
  u = u.replace(/\/chat\/completions$/, '')
  return u.replace(/\/+$/, '')
}

export function getProviderPreset(id) {
  return PRESET_BY_ID.get(String(id || '')) || null
}

/**
 * 按地址推断服务商。预设地址前缀匹配（`api.openai.com/v1` 匹配
 * `api.openai.com/v1/...`），匹配不上就是「自定义」。
 */
export function inferProviderId(baseUrl) {
  const u = normalizeProviderBaseUrl(baseUrl)
  if (!u) return 'custom'
  for (const p of PROVIDER_PRESETS) {
    if (!p.baseUrl) continue
    const b = normalizeProviderBaseUrl(p.baseUrl)
    if (u === b || u.startsWith(`${b}/`)) return p.id
  }
  // 用户可能填了不带 /v1 的 Ollama 地址
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(u)) return 'ollama'
  return 'custom'
}

/** 把存储里可能缺失/过期的 providerId 规范成认识的值。 */
export function normalizeProviderId(providerId, baseUrl) {
  const id = String(providerId ?? '').trim()
  if (PRESET_BY_ID.has(id)) return id
  return inferProviderId(baseUrl)
}

/**
 * 设置加载后的服务商规范化。
 *
 * **不改 baseUrl / model**：它们才是请求的真实来源，凭「预设变了」去改用户的
 * 地址等于悄悄换服务商。这里只在 providerId 缺失或不认识时补一个可用于展示的值。
 */
export function normalizeProviderSettings(raw) {
  return {
    providerId: normalizeProviderId(raw?.providerId, raw?.baseUrl)
  }
}

export function providerLabel(id) {
  return getProviderPreset(id)?.label || '自定义（OpenAI 兼容）'
}

/**
 * 当前配置是否是「刚切到某预设、但地址还是上一个服务商的」。
 * 设置面板用它提示「点一下填入预设地址」。纯展示用，不影响请求。
 */
export function isPresetApplied(settings) {
  const preset = getProviderPreset(settings?.providerId)
  if (!preset || !preset.baseUrl) return true
  return normalizeProviderBaseUrl(settings?.baseUrl) === normalizeProviderBaseUrl(preset.baseUrl)
}

/**
 * 构造一个 Provider 实例。
 *
 * @param {object} opts
 * @param {object} opts.settings   全局设置（只用 baseUrl/apiKey/model/models/温度等）
 * @param {string} [opts.stage]    任务阶段，用于挑选模型（write/extract/review/plan/outline）
 * @param {Function} [opts.chat]   底层传输实现，测试注入
 * @param {Function} [opts.estimator] token 估算，默认字符估算
 * @returns {object} { id, label, baseUrl, requiresKey, hasKey, modelFor, chatStream, chat, countTokens }
 */
export function createProvider({
  settings = {},
  stage = '',
  chat,
  estimator = estimateTokens
} = {}) {
  const id = normalizeProviderId(settings.providerId, settings.baseUrl)
  const preset = getProviderPreset(id)
  const requiresKey = preset ? preset.requiresKey !== false : true
  // 阶段模型在这一层就定死：编排器记录「实际用了哪个模型」时读这里，
  // 而不是再自己算一遍（两处各算一次就会在某个阶段出现不一致）。
  const stageSettings = stage ? settingsForStage(settings, stage) : settings
  const model = modelForStage(settings, stage)

  function chatStream(opts = {}) {
    const { messages, callbacks = {}, ...rest } = opts
    return chatStreamReliable({
      settings: stageSettings,
      messages,
      callbacks,
      ...(chat ? { chat } : {}),
      ...rest
    })
  }

  /**
   * 收集式调用：把流拼成完整文本。返回 `{ abort, promise }`，
   * promise 解析为 `{ ok, text, usage, error, aborted, truncated, finishReason }`。
   *
   * 注意 **onDelta 仍会逐字转发**：调用方可以边收集边显示（AI 面板就是这么用的）。
   */
  function chatCall(opts = {}) {
    const { messages, callbacks = {}, ...rest } = opts
    let usage = null
    const handle = chatStreamReliable({
      settings: stageSettings,
      messages,
      callbacks: {
        ...callbacks,
        onUsage(u) {
          usage = u
          callbacks.onUsage?.(u)
        }
      },
      ...(chat ? { chat } : {}),
      ...rest
    })
    const promise = handle.promise.then((res) => ({
      ok: !!res.ok,
      text: res.text || '',
      usage,
      error: res.error || null,
      aborted: !!res.aborted,
      truncated: !!res.truncated,
      finishReason: res.finishReason || '',
      attempts: res.attempts || 0
    }))
    return { abort: handle.abort, promise, attempts: handle.attempts }
  }

  return {
    id,
    label: providerLabel(id),
    baseUrl: settings.baseUrl || '',
    requiresKey,
    hasKey: !requiresKey || !!String(settings.apiKey || '').trim(),
    model,
    modelFor: (s) => modelForStage(settings, s),
    settings: stageSettings,
    chatStream,
    chat: chatCall,
    countTokens: (text) => Number(estimator(String(text ?? ''))) || 0
  }
}
