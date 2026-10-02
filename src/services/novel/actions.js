/**
 * 动作清单：AI 面板的模式按钮与控制台的「上下文预览」共用这一份。
 *
 * 两处各写一份的话，加一个动作时预览器会悄悄少一个选项 —— 而它少的那一个
 * 恰好是用户想排查的那个（「生成章节怎么没有预览？」），且没有任何报错。
 */
export const ACTIONS = [
  { key: 'continue', label: '续写' },
  { key: 'expand', label: '扩写' },
  { key: 'rewrite', label: '改写' },
  { key: 'chapter', label: '生成章节' },
  { key: 'outline', label: '生成大纲' }
]

/**
 * 走编排器的动作。
 *
 * 只有这两个进编排器，因为它们要更新记忆、要按章计费。扩写 / 改写 / 生成大纲
 * 保持旧路径是刻意的：规格书明确要求扩写与改写不得改动人物设定、世界规则、
 * 时间线与伏笔，它们本就不该触发记忆提取。
 */
export const WORKFLOW_ACTIONS = ['continue', 'chapter']
