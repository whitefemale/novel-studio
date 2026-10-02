import { reactive } from 'vue'
import { getSettings, saveSettings } from '../services/storage'
import { DEFAULT_PRICING, normalizePricing } from '../services/ai/tokenUsage'

export { DEFAULT_PRICING }

// 全局唯一设置实例（跨组件共享）
export const defaultSettings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.0,
  maxTokens: 4096,
  includeOutline: true, // 生成时是否携带大纲
  includeCharacters: true, // 是否携带人物设定
  includeWorld: true, // 是否携带世界观
  contextChapters: 3, // 续写时携带最近 N 章作为上下文

  // ---- 保存与导出（仅桌面端生效；移动端导出走系统分享面板）----
  saveDir: '', // 小说保存目录（绝对路径）；'' 表示未设置
  exportMode: 'direct', // 'direct' 直接写入 saveDir | 'ask' 每次弹保存框
  perBookFolder: true, // 在 saveDir 下按书名建子文件夹
  openFolderAfterExport: false, // 导出后在资源管理器中定位文件
  autoBackup: false, // 定时自动备份整本
  backupInterval: 10, // 自动备份间隔（分钟）
  backupKeep: 20, // 每本书最多保留的备份份数

  // ---- V2：小说控制台 / 记忆 / 用量统计 ----
  showUsage: true, // AI 面板显示本次 token 与金额
  streamUsage: true, // 请求带 stream_options.include_usage（少数兼容端点不认，故可关）
  // 可编辑价目表；仅供估算，见 tokenUsage.js 的说明。
  // 这里拷一份而不是直接引用 DEFAULT_PRICING：浅合并意味着 settings 与 defaultSettings
  // 会共享同一个数组，改价目时若原地改对象就会污染模块级常量。
  pricing: DEFAULT_PRICING.map((e) => ({ ...e })),
  contextBudget: 6000, // Context Builder 的 token 预算
  autoExtractMemory: true, // 写完自动提取记忆（「写 + 提取」档）
  reviewHighRisk: true, // 高风险记忆变更进审阅队列等确认
  versionKeep: 10, // 每章最多保留多少个历史版本（裁剪不写墓碑，见 versioning.js）

  // ---- 局域网同步 ----
  // 电脑端两个键只在 Electron 有意义；手机端只用到下面两个。
  syncPort: 8787, // 电脑端监听端口（被占用时主进程会向后试，实际端口以界面显示为准）
  // 默认关闭是**安全默认**：不开就不会有任何监听。开了之后每次启动电脑端会自动监听，
  // 所以这是一个用户明确表示「我知道这会在局域网上开一个端口」的开关。
  syncAutoStart: false,
  syncUrl: '', // 手机端：电脑地址，如 192.168.1.5:8787
  syncCode: '' // 手机端：电脑上显示的 6 位配对码
}

export const settings = reactive({
  ...defaultSettings,
  loaded: false
})

// 保存与导出那七个键是后加的。load() 用 Object.assign 合并，旧记录缺的键会自动
// 补齐默认值，因此不需要任何迁移代码——这一点由冒烟测试的 settingsBackfill 断言钉死。
//
// 但 Object.assign 是**浅合并**，对 V2 的 pricing 不成立：它是一个数组，
// 存储里的旧数组会整体顶掉默认值，于是「以后给默认条目新增的字段」在老用户那里
// 永远补不上，表现为金额静默算成 0。故 load() 里单独跑一次 normalizePricing
// （它恒返回新数组，顺带避免用户改价目污染 DEFAULT_PRICING 这个模块级常量）。
export function useSettings() {
  async function load() {
    const s = await getSettings()
    if (s) Object.assign(settings, defaultSettings, s)
    settings.pricing = normalizePricing(s ? s.pricing : null)
    settings.loaded = true
  }
  async function persist() {
    const { loaded, ...rest } = settings
    await saveSettings({ ...rest })
  }
  return { settings, load, persist }
}
