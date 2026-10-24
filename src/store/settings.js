import { reactive } from 'vue'
import { getSettings, saveSettings } from '../services/storage.js'
import { DEFAULT_PRICING, normalizePricing } from '../services/ai/tokenUsage.js'
import { defaultTaskModels, normalizeTaskModels } from '../services/ai/models.js'
import { normalizeProviderSettings } from '../services/ai/providers.js'
import { isDesktop } from '../services/platform.js'
import {
  defaultPlanValidation,
  normalizePlanValidation,
  defaultRagSettings,
  normalizeRagSettings,
  defaultWebdavSettings,
  normalizeWebdavSettings,
  defaultPluginSettings,
  normalizePluginSettings
} from '../services/settingsExtras.js'
import {
  secureStorageAvailable,
  readSecureApiKey,
  writeSecureApiKey,
  deleteSecureApiKey,
  readSecureWebdavPassword,
  writeSecureWebdavPassword,
  deleteSecureWebdavPassword
} from '../services/secret.js'

export { DEFAULT_PRICING }

// 全局唯一设置实例（跨组件共享）
export const defaultSettings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  // 按任务分工的模型。空串 = 回退到上面的 model，所以默认值下行为与旧版一致。
  // 必须走 normalizeTaskModels 补齐：浅合并会让存储里旧的 models 对象整体顶掉它。
  models: defaultTaskModels(),
  temperature: 1.0,
  maxTokens: 4096,
  includeOutline: true, // 生成时是否携带大纲
  includeCharacters: true, // 是否携带人物设定
  includeWorld: true, // 是否携带世界观
  includeStyle: true, // 是否携带当前启用的文风档案
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
  autoApplyLowRisk: true, // 低风险记忆变更直接入库；关闭后连低风险也要过审阅
  versionKeep: 10, // 每章最多保留多少个历史版本（裁剪不写墓碑，见 versioning.js）

  // ---- 预算（0 = 不限制）。金额均为本机估算，不是服务商账单 ----
  budgetPerCall: 0, // 单次调用上限（元）
  budgetDaily: 0, // 每日累计上限（元）
  budgetAction: 'warn', // 'warn' 只提示 | 'confirm' 必须点「继续」

  // ---- 请求稳定性 ----
  // 空闲超时：连上了但服务端不再发数据。每次收到数据重置，0 表示关闭。
  requestIdleTimeoutSec: 60,
  maxRetries: 2, // 仅在还没收到正文时对 network/timeout/429/5xx 重试

  // ---- API Key 安全存储（运行时状态，不持久化）----
  // secureKeyAvailable 为 true 时，桌面端把 Key 交给主进程 safeStorage，
  // IndexedDB 里不再保留明文。浏览器/Android 恒为 false，退回明文并如实提示。
  secureKeyAvailable: false,
  secureKeyError: '',

  // ---- 局域网同步 ----
  // 电脑端两个键只在 Electron 有意义；手机端只用到下面两个。
  syncPort: 8787, // 电脑端监听端口（被占用时主进程会向后试，实际端口以界面显示为准）
  // 默认关闭是**安全默认**：不开就不会有任何监听。开了之后每次启动电脑端会自动监听，
  // 所以这是一个用户明确表示「我知道这会在局域网上开一个端口」的开关。
  syncAutoStart: false,
  syncUrl: '', // 手机端：电脑地址，如 192.168.1.5:8787
  syncCode: '', // 手机端：电脑上显示的 6 位配对码
  // 同一章在两台设备上都被改过时，为远端版本保留一份「冲突副本」。
  // 默认开：正文是唯一不可再生的内容，覆盖掉就永远回不来。
  syncConflictCopies: true,

  // ---- V4：服务商与设备 ----
  // providerId 只用于预设填充与界面展示；**真正的凭据永远是 baseUrl + model**，
  // 所以它缺失或不认识预设都不影响请求。见 services/ai/providers.js。
  providerId: 'deepseek',
  // 设备显示名（同步面板、快照头、章节「最后修改人」用）。
  // 空串时由 deviceId 派生「设备 xxxx」——每台设备都得有个可辨认的称呼。
  deviceName: '',

  // ---- V4：生成前计划校验 ----
  planValidation: defaultPlanValidation(),

  // ---- V4：本地检索（RAG，默认关） ----
  rag: defaultRagSettings(),

  // ---- V4：WebDAV 同步（密码不在设置里，只在主进程 safeStorage） ----
  webdav: defaultWebdavSettings(),

  // ---- V4：声明式插件（仅桌面端读取 userData/plugins/*.json） ----
  plugins: defaultPluginSettings(),

  // 运行时状态：WebDAV 密码是否已存在于安全存储。**不持久化**
  webdavPasswordSet: false
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
    // 与 pricing 同一个理由：浅合并会让旧的 models 对象整体顶掉默认值，
    // 以后新增一个阶段键时老用户那边就缺字段。恒返回新对象，也避免编辑
    // settings.models 时改到模块级的 defaultSettings。
    settings.models = normalizeTaskModels(s ? s.models : null)
    // 同一类浅合并坑：下面四个都是对象/数组，旧记录里的值会整体顶掉默认值，
    // 以后给默认条目加字段时老用户就缺字段。恒返回新对象。
    settings.planValidation = normalizePlanValidation(s ? s.planValidation : null)
    settings.rag = normalizeRagSettings(s ? s.rag : null)
    settings.webdav = normalizeWebdavSettings(s ? s.webdav : null)
    settings.plugins = normalizePluginSettings(s ? s.plugins : null)
    // providerId 只影响展示与「填入预设」；baseUrl/model 原样保留（见 providers.js）。
    settings.providerId = normalizeProviderSettings({
      providerId: s?.providerId,
      baseUrl: s?.baseUrl
    }).providerId

    // 桌面端优先读 safeStorage。旧版本把 apiKey 明文存在 IndexedDB 里，
    // 这里的迁移顺序是**先写成功、再清明文**：反过来一旦加密写失败，
    // 用户的 Key 就没了。
    settings.secureKeyAvailable = false
    settings.secureKeyError = ''
    if (secureStorageAvailable()) {
      const res = await readSecureApiKey()
      if (res.ok) {
        settings.secureKeyAvailable = true
        const legacy = String(s?.apiKey || '')
        if (res.value) {
          settings.apiKey = res.value
          // 安全存储里已有 Key，且旧明文还在：安全存储是权威，清掉明文副本
          if (legacy) await persist()
        } else if (legacy) {
          const written = await writeSecureApiKey(legacy)
          if (written.ok) {
            settings.apiKey = legacy
            await persist() // 此时 persist 不再写 apiKey 字段
          } else {
            // 加密不可用/写失败：保留明文，绝不丢 Key；并把实情告诉界面
            settings.secureKeyAvailable = false
            settings.secureKeyError = written.message || '安全存储写入失败'
            settings.apiKey = legacy
          }
        } else {
          settings.apiKey = ''
        }
      } else {
        // 解密失败（换了系统账户等）或系统不支持：保留旧明文（如果有）
        settings.secureKeyAvailable = false
        settings.secureKeyError = res.message || ''
        settings.apiKey = String(s?.apiKey || '')
      }
    }
    // WebDAV 密码只问「有没有」、绝不读进 settings：
    // 读进来就等于在内存里多一份长期留存的明文，而密码的唯一用途是
    // 主进程发请求时自己从 safeStorage 取。桌面端之外恒为 false。
    settings.webdavPasswordSet = false
    if (secureStorageAvailable()) {
      const res = await readSecureWebdavPassword()
      settings.webdavPasswordSet = !!(res.ok && String(res.value || ''))
    }

    settings.loaded = true
  }

  /**
   * 持久化设置。
   *
   * 桌面端且安全存储可用时**不把 apiKey 写进 IndexedDB**；密钥的落盘由
   * persistApiKey 走主进程 safeStorage。浏览器/Android 保持旧行为（明文），
   * 这是平台能力差异，不是遗漏。
   */
  async function persist() {
    // loaded / secureKey* / webdavPasswordSet 都是运行时状态，不进 IndexedDB。
    // WebDAV 密码本身从不放在 settings 上：它只在输入框与主进程 safeStorage 里。
    const { loaded, secureKeyAvailable, secureKeyError, webdavPasswordSet, ...rest } = settings
    const payload = { ...rest }
    if (isDesktop() && settings.secureKeyAvailable) delete payload.apiKey
    await saveSettings(payload)
  }

  /**
   * 保存 API Key 到正确的存储位置。
   * 返回 `{ ok, secure, code?, message? }`；失败时调用方应提示用户。
   */
  async function persistApiKey() {
    if (isDesktop() && settings.secureKeyAvailable) {
      const res = await writeSecureApiKey(settings.apiKey)
      if (!res.ok) {
        // 退回明文存储，但仍然要让用户看见「没有加密成功」。
        // 此时 secureKeyAvailable 已置 false，persist() 会把明文写回去 ——
        // 宁可明文保存，也不能让刚输入的 Key 静默丢失。
        settings.secureKeyAvailable = false
        settings.secureKeyError = res.message || '安全存储写入失败'
        await persist()
        return { ...res, secure: false }
      }
      await persist()
      return { ok: true, secure: true }
    }
    await persist()
    return { ok: true, secure: false }
  }

  /** 删除 API Key（安全存储与 IndexedDB 两侧都清）。 */
  async function clearApiKey() {
    settings.apiKey = ''
    if (isDesktop() && settings.secureKeyAvailable) await deleteSecureApiKey()
    await persist()
    return { ok: true }
  }

  /**
   * 保存 WebDAV 密码（仅安全存储；**没有明文回退**）。
   * 返回 `{ ok, code?, message? }`。空串等同删除。
   */
  async function persistWebdavPassword(password) {
    if (!isDesktop() || !settings.secureKeyAvailable) {
      return {
        ok: false,
        code: 'unsupported',
        message: '当前平台没有系统安全存储，WebDAV 同步仅在桌面端可用'
      }
    }
    const res = password
      ? await writeSecureWebdavPassword(String(password))
      : await deleteSecureWebdavPassword()
    if (!res.ok) return res
    settings.webdavPasswordSet = !!password
    return { ok: true }
  }

  /** 清除 WebDAV 密码（safeStorage 与内存标记两侧都清）。 */
  async function clearWebdavPassword() {
    if (isDesktop() && settings.secureKeyAvailable) await deleteSecureWebdavPassword()
    settings.webdavPasswordSet = false
    return { ok: true }
  }

  return {
    settings,
    load,
    persist,
    persistApiKey,
    clearApiKey,
    persistWebdavPassword,
    clearWebdavPassword
  }
}
