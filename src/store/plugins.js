import { reactive } from 'vue'
import { isDesktop } from '../services/platform'
import { normalizePluginList } from '../services/plugins/manifest'
import {
  activePlugins,
  pluginContextFragments,
  pluginTemplates,
  collectKeywordHints,
  runPluginRules
} from '../services/plugins/hooks'
import { useSettings } from './settings'

/**
 * 插件清单的运行时状态（模块级 reactive 单例，与其余 store 一致）。
 *
 * 清单本身**不落 IndexedDB**：真相是 `userData/plugins/*.json` 那几个文件。
 * 这里只持有「这次启动读到了什么」，改文件后点「重新读取」即可。
 * 用户的选择（关掉哪些插件、全局开关、上下文预算）在 settings.plugins 里。
 *
 * 只有桌面端能读插件目录；浏览器 / Android 上 `load()` 直接标记为空，
 * 界面显示「仅桌面端可用」，不假装支持。
 */
export const pluginState = reactive({
  manifests: [],
  errors: [],
  dir: '',
  skipped: 0,
  loading: false,
  loaded: false,
  /** 非桌面端为真：界面据此显示提示，而不是显示一个永远为空的列表 */
  unsupported: false
})

function settingsOf() {
  return useSettings().settings
}

function disabledIdsOf() {
  return settingsOf().plugins?.disabledIds || []
}

function pluginsEnabled() {
  return settingsOf().plugins?.enabled !== false
}

/**
 * 读插件目录。失败不抛异常——插件用不了不应该让设置面板炸掉。
 * 主进程返回的 `files` 里坏文件带 `error`，`normalizePluginList` 会把它们
 * 变成逐文件的错误列表，坏插件不影响其他插件。
 */
export async function loadPlugins() {
  if (pluginState.loading) return { ok: false, code: 'EBUSY', message: '正在读取插件目录' }
  if (!isDesktop() || !window.electronAPI?.pluginsList) {
    pluginState.unsupported = true
    pluginState.loaded = true
    pluginState.manifests = []
    pluginState.errors = []
    return { ok: false, code: 'unsupported', message: '插件仅在桌面端可用' }
  }
  pluginState.loading = true
  try {
    const res = await window.electronAPI.pluginsList()
    if (!res || res.ok === false) {
      pluginState.unsupported = false
      pluginState.loaded = true
      pluginState.manifests = []
      pluginState.errors = [{ file: '', message: res?.message || '读取插件目录失败' }]
      return { ok: false, code: res?.code || 'ELIST', message: res?.message || '读取插件目录失败' }
    }
    const { manifests, errors } = normalizePluginList(res.files)
    pluginState.manifests = manifests
    pluginState.errors = errors
    pluginState.dir = String(res.dir || '')
    pluginState.skipped = Number(res.skipped) || 0
    pluginState.unsupported = false
    pluginState.loaded = true
    return { ok: true, manifests: manifests.length, errors: errors.length }
  } catch (e) {
    pluginState.loaded = true
    pluginState.manifests = []
    pluginState.errors = [{ file: '', message: String((e && e.message) || e) }]
    return { ok: false, code: 'ELIST', message: '读取插件目录失败' }
  } finally {
    pluginState.loading = false
  }
}

/** 当前启用的插件（全局开关 + 用户黑名单都已过滤）。 */
export function enabledPlugins() {
  if (!pluginsEnabled()) return []
  return activePlugins(pluginState.manifests, disabledIdsOf())
}

export function pluginFragmentItems() {
  if (!pluginsEnabled()) return []
  return pluginContextFragments(pluginState.manifests, {
    disabledIds: disabledIdsOf(),
    budgetTokens: settingsOf().plugins?.contextBudget ?? 400
  })
}

export function pluginTemplateItems() {
  if (!pluginsEnabled()) return []
  return pluginTemplates(pluginState.manifests, { disabledIds: disabledIdsOf() })
}

export function pluginIssues(chapters, selectedChapter = null) {
  if (!pluginsEnabled()) return []
  return runPluginRules({
    manifests: pluginState.manifests,
    chapters,
    selectedChapter,
    disabledIds: disabledIdsOf()
  })
}

export function pluginHints(text) {
  if (!pluginsEnabled()) return []
  return collectKeywordHints(pluginState.manifests, text, { disabledIds: disabledIdsOf() })
}

/** 打开插件目录。桌面端才有；不暴露任意路径。 */
export async function openPluginFolder() {
  if (!isDesktop() || !window.electronAPI?.pluginsOpenFolder) {
    return { ok: false, code: 'unsupported', message: '插件仅在桌面端可用' }
  }
  return window.electronAPI.pluginsOpenFolder()
}

export function usePlugins() {
  return {
    store: pluginState,
    load: loadPlugins,
    enabled: enabledPlugins,
    fragments: pluginFragmentItems,
    templates: pluginTemplateItems,
    issues: pluginIssues,
    hints: pluginHints,
    openFolder: openPluginFolder
  }
}
