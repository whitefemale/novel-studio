import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  inferProviderId,
  normalizeProviderId,
  normalizeProviderSettings,
  normalizeProviderBaseUrl,
  isPresetApplied,
  createProvider,
  providerLabel
} from '../../src/services/ai/providers.js'

test('预设表形状完整，id 唯一，且有自定义与 Ollama', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of PROVIDER_PRESETS) {
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0)
    assert.ok(Array.isArray(p.models))
    assert.equal(typeof p.requiresKey, 'boolean')
  }
  assert.ok(getProviderPreset('ollama').requiresKey === false)
  assert.ok(getProviderPreset('custom'))
  assert.equal(getProviderPreset('nope'), null)
})

test('地址推断：忽略大小写、尾斜杠与 chat/completions 后缀', () => {
  assert.equal(inferProviderId('https://api.deepseek.com'), 'deepseek')
  assert.equal(inferProviderId('https://api.deepseek.com/'), 'deepseek')
  assert.equal(inferProviderId('https://API.DeepSeek.com/chat/completions'), 'deepseek')
  assert.equal(inferProviderId('https://api.openai.com/v1'), 'openai')
  assert.equal(inferProviderId('https://api.openai.com/v1/chat/completions'), 'openai')
  assert.equal(inferProviderId('http://localhost:11434'), 'ollama')
  assert.equal(inferProviderId('http://localhost:11434'), 'ollama')
  assert.equal(inferProviderId('https://my-own.example.com/v1'), 'custom')
  assert.equal(inferProviderId(''), 'custom')
  assert.equal(normalizeProviderBaseUrl(' https://A.com/v1/ '), 'https://a.com/v1')
})

test('providerId 规范化：认识的保留，不认识/空的按地址推断', () => {
  assert.equal(normalizeProviderId('ollama', 'https://api.deepseek.com'), 'ollama')
  assert.equal(normalizeProviderId('', 'https://api.deepseek.com'), 'deepseek')
  assert.equal(normalizeProviderId('weird', 'https://my.example/v1'), 'custom')
  assert.equal(normalizeProviderSettings({ baseUrl: 'https://api.moonshot.cn/v1' }).providerId, 'kimi')
  assert.equal(normalizeProviderSettings({ providerId: 'glm' }).providerId, 'glm')
})

test('预设未填入时给出提示，填入后视为一致', () => {
  assert.equal(isPresetApplied({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com' }), true)
  assert.equal(
    isPresetApplied({ providerId: 'deepseek', baseUrl: 'https://api.openai.com/v1' }),
    false
  )
  // 自定义没有预设地址，永远视为一致
  assert.equal(isPresetApplied({ providerId: 'custom', baseUrl: 'https://x/y' }), true)
  assert.equal(providerLabel('nope'), '自定义（OpenAI 兼容）')
})

test('Provider 不覆盖 Key：Ollama 允许空 Key，其余缺 Key 时如实报告', () => {
  const ds = createProvider({ settings: { providerId: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com' } })
  assert.equal(ds.id, 'deepseek')
  assert.equal(ds.requiresKey, true)
  assert.equal(ds.hasKey, false)
  const dsWithKey = createProvider({
    settings: { providerId: 'deepseek', apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' }
  })
  assert.equal(dsWithKey.hasKey, true)
  const ol = createProvider({ settings: { providerId: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' } })
  assert.equal(ol.requiresKey, false)
  assert.equal(ol.hasKey, true)
})

test('阶段模型在这里定死，编排器不必再算一遍', () => {
  const p = createProvider({
    settings: {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      models: { write: 'deepseek-reasoner', extract: '' }
    },
    stage: 'write'
  })
  assert.equal(p.model, 'deepseek-reasoner')
  // 阶段设置是浅拷贝，原对象不被改
  assert.equal(p.settings.model, 'deepseek-reasoner')
  assert.equal(p.modelFor('extract'), 'deepseek-chat')
})

function fakeChat({ chunks = ['你', '好'], usage = { inputTokens: 1, outputTokens: 2 }, fail = false, failWith } = {}) {
  return ({ callbacks }) => {
    setTimeout(() => {
      if (fail) {
        callbacks.onError(failWith || { category: 'network', message: '断网' })
        return
      }
      for (const c of chunks) callbacks.onDelta(c)
      callbacks.onUsage(usage)
      callbacks.onDone({ finishReason: 'stop' })
    }, 0)
    return { abort() {} }
  }
}

test('chat 把流收集成完整文本，并保留 usage 与 delta 转发', async () => {
  const seen = []
  const p = createProvider({
    settings: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
    stage: 'write',
    chat: fakeChat({ chunks: ['一', '段', '正文'] })
  })
  const res = await p.chat({
    messages: [{ role: 'user', content: 'x' }],
    callbacks: { onDelta: (t) => seen.push(t) }
  }).promise
  assert.equal(res.ok, true)
  assert.equal(res.text, '一段正文')
  assert.equal(res.usage.outputTokens, 2)
  assert.deepEqual(seen, ['一', '段', '正文'])
  assert.equal(p.countTokens('你好世界'), 4)
})

test('chat 失败时错误对象原样透传，不吞成空成功', async () => {
  const p = createProvider({
    settings: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
    stage: 'write',
    chat: fakeChat({ fail: true, failWith: { category: 'auth', message: '401' } })
  })
  const res = await p.chat({ messages: [], maxRetries: 0 }).promise
  assert.equal(res.ok, false)
  assert.equal(res.error.category, 'auth')
  assert.equal(res.text, '')
})
