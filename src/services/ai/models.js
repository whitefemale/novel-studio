/**
 * 按任务分工的模型选择。
 *
 * 为什么要分开：写正文与提取记忆对模型的要求完全不同。写正文看重文笔与长文
 * 连贯性，提取记忆看重严格输出 JSON；审校看重长上下文里的一致性判断。把它们
 * 钉在同一个模型名上，用户只能在「写得好但提取贵」与「便宜但提取总解析失败」
 * 之间二选一。这里让每个阶段各配一个，留空则回退到「模型名」那一栏 ——
 * 回退是默认值，所以老用户不做任何配置时行为一字不变。
 *
 * `outline` 不在编排器的阶段列表里（扩写/改写/大纲走旧路径），但它同样是一次
 * 独立用途的调用，所以一并提供配置项。
 */

export const TASK_MODEL_KEYS = ['write', 'extract', 'review', 'plan', 'outline']

export const TASK_MODEL_LABELS = {
  write: '写正文',
  extract: '提取记忆',
  review: '审校 / 修复',
  plan: '生成计划',
  outline: '大纲 / 扩写 / 改写'
}

/** 默认全空 = 全部回退到 settings.model。 */
export function defaultTaskModels() {
  const out = {}
  for (const key of TASK_MODEL_KEYS) out[key] = ''
  return out
}

/**
 * 补齐按阶段模型表。
 *
 * settings.load() 是浅合并：存储里旧对象的 `models` 会整体顶掉默认值。不补齐的话，
 * 以后新增一个阶段时老用户那边永远是 undefined，模型回退看起来「正常」，
 * 但设置面板会渲染出一个没有 v-model 目标的输入框。
 */
export function normalizeTaskModels(raw) {
  const out = defaultTaskModels()
  if (raw && typeof raw === 'object') {
    for (const key of TASK_MODEL_KEYS) {
      if (raw[key] != null) out[key] = String(raw[key]).trim()
    }
  }
  return out
}

/**
 * 某个阶段实际使用的模型名。
 *
 * `fix`（定向修复）复用 `review` 的配置：它们都属于「审校」这一类工作，
 * 用户不应该为了修一条问题再配第三个模型。
 */
export function modelForStage(settings, stage) {
  const key = stage === 'fix' ? 'review' : stage
  const specific = settings?.models?.[key]
  const model = String(specific || settings?.model || '').trim()
  return model
}

/**
 * 把一个阶段的模型注入 settings 对象。
 *
 * 不改原对象：settings 是模块级 reactive 单例，原地改会把「这一阶段用的模型」
 * 变成全局设置，后续阶段与界面会一起被污染。没有差异时直接返回原对象，
 * 避免为每一次调用制造无谓的浅拷贝。
 */
export function settingsForStage(settings, stage) {
  const model = modelForStage(settings, stage)
  if (!model || model === settings?.model) return settings
  return { ...settings, model }
}
