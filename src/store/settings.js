import { reactive } from 'vue'
import { getSettings, saveSettings } from '../services/storage'

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
  backupKeep: 20 // 每本书最多保留的备份份数
}

export const settings = reactive({
  ...defaultSettings,
  loaded: false
})

// 上述七个键是后加的。load() 用 Object.assign 合并，旧记录缺的键会自动补齐默认值，
// 因此不需要任何迁移代码——这一点由冒烟测试的 settingsBackfill 断言钉死。
export function useSettings() {
  async function load() {
    const s = await getSettings()
    if (s) Object.assign(settings, defaultSettings, s)
    settings.loaded = true
  }
  async function persist() {
    const { loaded, ...rest } = settings
    await saveSettings({ ...rest })
  }
  return { settings, load, persist }
}
