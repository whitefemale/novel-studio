import { reactive } from 'vue'
import { coll } from '../services/storage'
import { genId } from '../services/ids'
import { computeCost, findPrice, estimateTokens, formatTokens, formatCost } from '../services/ai/tokenUsage'
import { settings } from './settings'
import { store as books } from './books'

/**
 * 生成记录（generationRuns）：每一次 AI 调用一条。
 *
 * 按**每一次调用**记而不是按章记，理由有三个：
 *   - 编排器是多阶段的（写正文 / 提取记忆 / 审校各一次调用），分阶段记才能
 *     回答「钱花在哪一步」；
 *   - 中止与失败也要留痕，否则用户会看到总账对不上；
 *   - 「本章合计」只是按 chapterId 的聚合，用 computed 就能得到，
 *     反过来把合并后的数字存下来就再也拆不开了。
 */
export const generationStore = reactive({
  runs: [],
  loaded: false,
  /**
   * 是否正在生成。
   *
   * 真相来源在 AiPanel，但**必须放在这里**：局域网同步要能回答「现在能不能合并」，
   * 而合并与流式写入会抢同一个键（saveChapters 是整组回写），撞上就是静默丢稿。
   * 让 AiPanel 把自己的局部 ref 换成这个字段的 computed 访问器，状态就只有一份，
   * 同步层不必去问组件 —— service 反向依赖组件正是本项目一直避免的。
   */
  running: false
})

/**
 * 聚合若干条生成记录。纯函数，供 UI 与测试共用。
 *
 * estimated 只要有一条是估算的就算 true —— 合计里混进了估算值就必须标出来，
 * 不能因为大多数是真实值就把它当精确数展示。
 */
export function aggregateRuns(runs) {
  const out = {
    count: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    currency: 'CNY',
    estimated: false,
    unpriced: 0
  }
  for (const r of runs || []) {
    out.count++
    out.inputTokens += Number(r.inputTokens) || 0
    out.outputTokens += Number(r.outputTokens) || 0
    out.cost += Number(r.cost) || 0
    if (r.currency) out.currency = r.currency
    if (r.usageSource === 'estimated') out.estimated = true
    if (r.priced === false) out.unpriced++
  }
  out.totalTokens = out.inputTokens + out.outputTokens
  return out
}

/** 一行摘要，AI 面板与控制台共用，避免两处各写一套格式化。 */
export function describeRun(run) {
  if (!run) return ''
  const parts = [
    `${formatTokens(run.inputTokens)} 输入 + ${formatTokens(run.outputTokens)} 输出`,
    `${formatTokens(run.inputTokens + run.outputTokens)} tokens`
  ]
  // 没配价格的模型如实说「未配置价格」，不能显示 ¥0 —— 「不知道多少钱」
  // 与「不花钱」是两件事，后者会让用户以为这次调用是免费的。
  if (run.priced === false) parts.push('未配置价格')
  else parts.push(formatCost({ total: run.cost, currency: run.currency }))
  const tail = run.usageSource === 'estimated' ? '（估）' : ''
  return parts.join(' · ') + tail
}

export function useGeneration() {
  async function loadForBook(bookId) {
    if (!bookId) {
      generationStore.runs = []
      generationStore.loaded = false
      return
    }
    generationStore.runs = await coll.generationRuns.getAll(bookId)
    generationStore.loaded = true
  }

  function clear() {
    generationStore.runs = []
    generationStore.loaded = false
  }

  /**
   * 删除一条生成记录。
   *
   * 走集合工厂的 remove（写墓碑）而不是 saveAll 整组替换：与其余实体保持同一种
   * 删除表示，第二阶段的同步才有统一的一条路径可走。
   */
  async function removeRun(id) {
    const bookId = books.bookId
    if (!bookId || !id) return []
    generationStore.runs = await coll.generationRuns.remove(bookId, id)
    return generationStore.runs
  }

  /**
   * 记一条生成。
   *
   * 用量优先取端点返回的真实值（inputTokens / outputTokens）；没有时按传入的
   * 原文估算，并把 usageSource 标成 'estimated' —— 这个标记会一路传到界面上
   * 显示成「估」，不能省。
   *
   * `priced` 记录「这条用的是具体模型的价目，还是 '*' 兜底」：兜底条目的
   * 单价是 0，算出来的金额也必然是 0，而那个 0 的意思其实是「不知道」。
   * 把这两者混为一谈，用户会看到一章「花费 ¥0」并以为真的免费。
   */
  async function recordRun(input = {}) {
    const bookId = input.bookId || books.bookId
    if (!bookId) return null
    const now = Date.now()
    const hasRealUsage = input.inputTokens != null || input.outputTokens != null
    const inputTokens = hasRealUsage ? Number(input.inputTokens) || 0 : estimateTokens(input.inputText)
    const outputTokens = hasRealUsage ? Number(input.outputTokens) || 0 : estimateTokens(input.outputText)
    const price = findPrice(settings.pricing, input.model || settings.model)
    const cost = computeCost(inputTokens, outputTokens, price)
    const item = {
      id: input.id || genId(),
      bookId,
      chapterId: input.chapterId || null,
      action: input.action || '',
      stage: input.stage || '',
      provider: input.provider || '',
      model: input.model || settings.model || '',
      inputTokens,
      outputTokens,
      cost: cost ? cost.total : 0,
      currency: cost ? cost.currency : 'CNY',
      priced: !!price && price.match !== '*',
      usageSource: hasRealUsage ? 'provider' : 'estimated',
      durationMs: Number(input.durationMs) || 0,
      status: input.status || 'done',
      createdAt: now,
      updatedAt: now
    }
    generationStore.runs = await coll.generationRuns.upsert(bookId, item)
    return item
  }

  return { store: generationStore, loadForBook, clear, recordRun, removeRun, aggregate: aggregateRuns }
}
