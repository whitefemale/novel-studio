/**
 * token 估算与成本计算。全部纯函数，无 I/O，无状态。
 *
 * 两条原则，都写在代码里以免后来者改错方向：
 *
 * 1. **价格不是权威值。** 公开资料里各家的价格互相矛盾且随版本调整（同一家的
 *    缓存命中价、峰谷价、各代模型价差都不是一个数），把任何一个数字硬编码成
 *    「官方价格」都会在用户的账单上变成错误结论。所以这里只提供一份**种子**
 *    价目表，用户在设置里可改，界面上标注「请以官方定价页为准」。
 *
 * 2. **估算用量必须标出来。** 端点不返回 usage（或用户关掉了 stream_usage）
 *    时由这里的 estimateTokens 兜底，结果一律带 usageSource: 'estimated'，
 *    界面上显示为「估」。把估算值当真实用量展示是误导。
 */

/**
 * 种子价目表。
 *
 * match 是模型名前缀，最长的匹配优先，'*' 为兜底。单位：元 / 百万 token。
 * 这些数字**仅供开工时有个还行的默认值**，不是官方定价。
 */
export const DEFAULT_PRICING = [
  { match: 'deepseek-chat', label: 'DeepSeek Chat', inputPerM: 2, outputPerM: 8, currency: 'CNY' },
  {
    match: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    inputPerM: 4,
    outputPerM: 16,
    currency: 'CNY'
  },
  { match: '*', label: '其它模型（兜底）', inputPerM: 0, outputPerM: 0, currency: 'CNY' }
]

/**
 * 补齐价目表条目。
 *
 * 为什么必须有这个函数：settings.load() 用的是 Object.assign 浅合并，数组会被
 * 整体替换。用户库里存着旧版价目表时，**以后给默认条目新增的字段在他们那里是缺的**，
 * 而缺字段的表现是「金额算成 0」这种不报错的错。
 *
 * 恒返回新数组（不与 DEFAULT_PRICING 共享引用），否则用户在设置里改价目会
 * 污染模块级常量、影响后续每一次 load。
 */
export function normalizePricing(list) {
  const src = Array.isArray(list) && list.length ? list : DEFAULT_PRICING
  const out = []
  for (const e of src) {
    if (!e || typeof e !== 'object' || !e.match) continue
    const def = DEFAULT_PRICING.find((d) => d.match === e.match) || {}
    // 「字段缺失」与「字段是 0」必须分开处理：缺失才回填默认值，
    // 显式写 0（用户想把这个模型当免费）要尊重。
    const num = (v, fallback) => (v == null ? fallback : Number(v) || 0)
    out.push({
      match: String(e.match),
      label: e.label || def.label || String(e.match),
      inputPerM: num(e.inputPerM, def.inputPerM ?? 0),
      outputPerM: num(e.outputPerM, def.outputPerM ?? 0),
      currency: e.currency || def.currency || 'CNY'
    })
  }
  // 兜底条目必须存在，否则用户自定义成只剩一条具体模型时，
  // 换个模型就完全算不出金额（且没有任何提示）
  if (!out.some((e) => e.match === '*')) {
    const star = DEFAULT_PRICING.find((d) => d.match === '*')
    out.push({ ...star })
  }
  return out
}

/** 按模型名取价目：最长前缀优先，'*' 兜底。取不到返回 null。 */
export function findPrice(pricing, model) {
  const list = normalizePricing(pricing)
  const m = String(model || '')
  let best = null
  for (const e of list) {
    if (e.match === '*') continue
    if (m.startsWith(e.match) && (!best || e.match.length > best.match.length)) best = e
  }
  return best || list.find((e) => e.match === '*') || null
}

/**
 * 启发式 token 估算。
 *
 * 项目里没有 tokenizer，也不该为它引依赖 —— 每个模型的分词器都不同，
 * 装一个等于装错一半，而打包体积是实打实的（见 CLAUDE.md 的 asar 条目数约定）。
 * 这里按「CJK 字符 1 token、其它字符 4 字符 1 token」估，与实际用量同量级，
 * 足以支撑「这一章大概花了多少」和「上下文预算够不够」两个用途。
 */
export function estimateTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  let cjk = 0
  let total = 0
  for (const ch of s) {
    total++
    if (isWideChar(ch.codePointAt(0))) cjk++
  }
  return Math.max(1, cjk + Math.ceil((total - cjk) / 4))
}

/**
 * 宽字符（CJK / 兼容表意 / 全角）判定。
 *
 * 估算与「按预算截断」两处共用同一个阈值 —— 分开写迟早会分叉成
 * 「估算说放得下、截断却多切了 30%」这种查不出来的偏差。
 */
export function isWideChar(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首扩展 ~ 统一表意文字
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0xff00 && cp <= 0xffef) // 全角标点与字母
  )
}

/**
 * 把文本裁到不超过 budget 个估算 token，返回裁后的字符串。
 *
 * keep='tail' 时保留尾部（正文/摘要：越近越重要），否则保留头部（规则/设定：
 * 开头就是要义）。按码点推进而不是按 UTF-16 码元，避免把代理对切成半个字符
 * ——那会产出无法渲染的孤立代理。
 */
export function cutToTokens(text, budget, keep = 'head') {
  const s = String(text || '')
  if (!s || budget <= 0) return ''
  if (estimateTokens(s) <= budget) return s
  let cjk = 0
  let other = 0
  let cut = 0
  const n = s.length
  if (keep === 'tail') {
    let i = n
    while (i > 0) {
      const cp = s.codePointAt(i - 1)
      const len = cp > 0xffff ? 2 : 1
      if (isWideChar(cp)) cjk++
      else other++
      if (cjk + Math.ceil(other / 4) > budget) break
      i -= len
      cut = i
    }
    return s.slice(cut)
  }
  let i = 0
  while (i < n) {
    const cp = s.codePointAt(i)
    const len = cp > 0xffff ? 2 : 1
    if (isWideChar(cp)) cjk++
    else other++
    if (cjk + Math.ceil(other / 4) > budget) break
    i += len
    cut = i
  }
  return s.slice(0, cut)
}

/**
 * 成本计算。取不到价目返回 null（而不是 0）—— 「不知道多少钱」与「不花钱」
 * 是两件事，前者不该在界面上显示成 ¥0。
 */
export function computeCost(inputTokens, outputTokens, price) {
  if (!price) return null
  const inPerM = Number(price.inputPerM) || 0
  const outPerM = Number(price.outputPerM) || 0
  const inputCost = ((Number(inputTokens) || 0) / 1e6) * inPerM
  const outputCost = ((Number(outputTokens) || 0) / 1e6) * outPerM
  return {
    inputCost,
    outputCost,
    total: inputCost + outputCost,
    currency: price.currency || 'CNY'
  }
}

/** 从 baseUrl 提取服务商标识（hostname）。仅用于生成记录与展示，不参与逻辑。 */
export function providerFromUrl(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname
  } catch {
    return ''
  }
}

/** 1000 → 1k，1500 → 1.5k。面板窄，四位以上的数字读起来费劲。 */
export function formatTokens(n) {
  const v = Number(n) || 0
  if (v >= 1000) {
    const k = v / 1000
    return (k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'k'
  }
  return String(v)
}

const CURRENCY_SIGN = { CNY: '¥', USD: '$', EUR: '€' }

/** 金额展示。小额保留 4 位，否则 3 位 —— 一章通常是几厘钱，四舍五入到分等于显示 0。 */
export function formatCost(cost) {
  if (!cost) return ''
  const sign = CURRENCY_SIGN[cost.currency] || ''
  const v = Number(cost.total) || 0
  if (v === 0) return `${sign}0`
  if (v < 0.01) return `${sign}${v.toFixed(4)}`
  if (v < 1) return `${sign}${v.toFixed(3)}`
  return `${sign}${v.toFixed(2)}`
}
