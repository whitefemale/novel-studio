import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeStyleProfile,
  renderStyleProfile,
  styleProfileText,
  describeStyleProfile
} from '../../src/services/novel/style.js'

/**
 * 文风档案的注入文本。守三件事：
 *   - 空字段不产生空标题（浪费预算、误导模型）；
 *   - 样本只取前 300 字（它是腔调示例，不是续写素材）；
 *   - 关掉 includeStyle 时一个字都不进提示词。
 */

test('activeStyleProfile：优先 active，否则回退第一条，忽略空标题', () => {
  const list = [
    { title: '', pov: 'first' },
    { title: '冷峻', pov: 'third-limited' },
    { title: '轻快', pov: 'first', active: true }
  ]
  assert.equal(activeStyleProfile(list).title, '轻快')
  assert.equal(activeStyleProfile([{ title: '只有一份' }]).title, '只有一份')
  assert.equal(activeStyleProfile([]), null)
  assert.equal(activeStyleProfile(null), null)
})

test('renderStyleProfile：空字段不写，已知选项翻译成中文标签', () => {
  const text = renderStyleProfile({
    title: '冷峻克制',
    pov: 'third-limited',
    tense: 'past',
    sentenceRhythm: '短句为主',
    dialogueRatio: '',
    vocabulary: '',
    bannedExpressions: '',
    characterVoices: '',
    sample: ''
  })
  assert.match(text, /文风档案：冷峻克制/)
  assert.match(text, /叙事视角：第三人称限知/)
  assert.match(text, /时态：过去时/)
  assert.match(text, /句式节奏：短句为主/)
  assert.doesNotMatch(text, /对白比例/)
  assert.doesNotMatch(text, /禁用表达/)
  assert.doesNotMatch(text, /腔调样本/)
})

test('renderStyleProfile：样本只保留前 300 字并标注用途', () => {
  const sample = '雨'.repeat(500)
  const text = renderStyleProfile({ title: 'x', sample })
  assert.match(text, /只学语气与节奏/)
  assert.ok(text.includes(sample.slice(0, 300)))
  assert.ok(!text.includes(sample.slice(0, 301)), '第 301 字起不应进入提示词')
  assert.ok(text.endsWith('…'))
})

test('styleProfileText：includeStyle 关闭返回空串', () => {
  const list = [{ title: '冷峻', pov: 'first' }]
  assert.equal(styleProfileText(list, false), '')
  assert.match(styleProfileText(list, true), /第一人称/)
})

test('describeStyleProfile：列表摘要只写已知项', () => {
  assert.equal(describeStyleProfile(null), '')
  assert.equal(
    describeStyleProfile({ pov: 'first', tense: 'present', active: true }),
    '第一人称 · 现在时 · 当前启用'
  )
  assert.equal(describeStyleProfile({}), '')
})
