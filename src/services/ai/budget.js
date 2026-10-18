/**
 * 生成前的预算估算与超限决策。全部纯函数，无 I/O。
 *
 * 三条原则：
 *
 * 1. **只估算，不拦截**。真正扣多少钱由服务商决定，这里给的是一个量级正确的
 *    提示。所以预算是「事先说清楚要花多少」，而不是「保证不超」。
 * 2. **未知价格不编造金额**。价目表里没有这个模型时（`findPrice` 命中 `'*'`），
 *    金额是 null 而不是 0 —— 0 会让用户以为这次免费。此时若用户设了预算，
 *    仍然要求确认，并明确写「价格未知」。
 * 3. **每日已花费按本地自然日算**。跨时区的服务器账单与这里对不上是正常的，
 *    界面上要标「本机估算」。
 */

import { estimateTokens, findPrice, computeCost } from './tokenUsage.js'

/** 本地自然日的零点时间戳。 */
export function dayStart(now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 今天已经花了多少。
 *
 * `complete` 为 false 表示今天有调用没有价格（`priced:false`），此时合计只能
 * 当**下限**看 —— 不能拿它去和每日预算比较后宣称「还没超」。
 */
export function spentOnDay(runs, now = Date.now()) {
  const start = dayStart(now)
  const end = start + 24 * 60 * 60 * 1000
  let total = 0
  let count = 0
  let unpriced = 0
  let currency = 'CNY'
  for (const r of runs || []) {
    const at = Number(r?.createdAt) || 0
    if (at < start || at >= end) continue
    count++
    if (r.priced === false) {
      unpriced++
      continue
    }
    total += Number(r.cost) || 0
    if (r.currency) currency = r.currency
  }
  return { total, count, unpriced, complete: unpriced === 0, currency, start, end }
}

/**
 * 估算一次调用的规模与金额。
 *
 * 输入 token 可以显式传入（编排器已经算过上下文的总量），也可以传原文让这里
 * 用启发式估算。输出按 `maxTokens` 预留 —— 模型实际可能写得少，但预算要按
 * 「写满」来提示，否则用户设了 0.5 元上限却看到一次 3 元的账单。
 */
export function estimateCall({ settings, inputTokens, inputText, outputTokens, model } = {}) {
  const inTok =
    inputTokens != null ? Math.max(0, Number(inputTokens) || 0) : estimateTokens(inputText)
  const outTok =
    outputTokens != null
      ? Math.max(0, Number(outputTokens) || 0)
      : Math.max(0, Number(settings?.maxTokens) || 0)
  const price = findPrice(settings?.pricing, model || settings?.model)
  const cost = computeCost(inTok, outTok, price)
  // 命中的是 '*' 兜底（单价 0）时，金额必须报 null 而不是 0 —— 见本文件开头第 2 条。
  const priced = !!price && price.match !== '*'
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
    cost: priced && cost ? cost.total : null,
    currency: cost?.currency || 'CNY',
    // 命中的是具体条目还是 '*' 兜底。兜底意味着价格未知，不是免费。
    priced,
    priceMatch: price?.match || ''
  }
}

/**
 * 判断一次调用是否触及预算。
 *
 * 返回值：
 *   hit      是否需要让用户停下来看一眼
 *   level    'per-call' | 'daily' | 'both' | 'unknown' | ''
 *   action   'warn'（只提示）| 'confirm'（必须明确点「继续」）
 *   unknown  价格未知（金额无法估算）
 *
 * 「价格未知 + 用户设了预算」也算 hit：用户设预算的意图就是「别让我不知不觉
 * 花太多」，而价格未知恰恰是最容易不知不觉的情形。但不能给出假金额。
 */
export function checkBudget({ estimate, settings, spentToday } = {}) {
  const action = settings?.budgetAction === 'confirm' ? 'confirm' : 'warn'
  const perCallLimit = Math.max(0, Number(settings?.budgetPerCall) || 0)
  const dailyLimit = Math.max(0, Number(settings?.budgetDaily) || 0)
  const hasLimit = perCallLimit > 0 || dailyLimit > 0
  const cost = estimate?.cost
  const unknown = cost == null

  if (!hasLimit) {
    return { hit: false, level: '', action, unknown, perCallLimit, dailyLimit, projected: null }
  }
  if (unknown) {
    return {
      hit: true,
      level: 'unknown',
      action,
      unknown: true,
      perCallLimit,
      dailyLimit,
      projected: null
    }
  }

  const overCall = perCallLimit > 0 && cost > perCallLimit
  const spent = Number(spentToday?.total) || 0
  const projected = spent + Number(cost || 0)
  const overDay = dailyLimit > 0 && projected > dailyLimit
  // 今天的合计本身不完整（有未定价调用）时，不能断言「没超」；
  // 但也不能断言「超了」。这里按未超处理，由界面另行提示合计不完整。
  const dayUnknown = dailyLimit > 0 && spentToday && spentToday.complete === false

  const level = overCall && overDay ? 'both' : overCall ? 'per-call' : overDay ? 'daily' : ''
  return {
    hit: !!level || dayUnknown,
    level: dayUnknown && !level ? 'unknown' : level,
    action,
    unknown: false,
    perCallLimit,
    dailyLimit,
    projected
  }
}
