/**
 * V4 新增设置项的默认值与规范化（纯函数）。
 *
 * 为什么单独一个文件：`settings.load()` 是**浅合并**，数组与对象类型的设置
 * 会被存储里的旧值整体顶掉（坑见 CLAUDE.md「数据模型 → settings」）。
 * `pricing` 与 `models` 已经因此各有一个 normalize，这里把余下的对象型设置
 * 集中到一处，既方便单测，也免得在 settings.js 里堆一长串 if。
 *
 * 所有 normalize 都**恒返回新对象**：调用方可能把它们直接放进 reactive 的
 * settings，原地改默认值常量会让「恢复默认」失效。
 */

const num = (v, fallback, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)

// ---------------- 计划校验 ----------------

export function defaultPlanValidation() {
  return { enabled: true, blockHigh: true, repetitionWindow: 3 }
}

export function normalizePlanValidation(v) {
  const d = defaultPlanValidation()
  const s = v && typeof v === 'object' ? v : {}
  return {
    enabled: s.enabled !== false,
    blockHigh: s.blockHigh !== false,
    repetitionWindow: Math.round(num(s.repetitionWindow, d.repetitionWindow, 1, 10))
  }
}

// ---------------- 本地检索（RAG） ----------------

export function defaultRagSettings() {
  return {
    enabled: false, // 默认关：开启会改变提示词，不能悄悄发生
    topK: 6,
    minScore: 0.18,
    budget: 800, // 相关片段层的 token 预算
    chunkChars: 500,
    overlapChars: 80
  }
}

export function normalizeRagSettings(v) {
  const d = defaultRagSettings()
  const s = v && typeof v === 'object' ? v : {}
  return {
    enabled: s.enabled === true,
    topK: Math.round(num(s.topK, d.topK, 1, 20)),
    minScore: num(s.minScore, d.minScore, 0, 1),
    budget: Math.round(num(s.budget, d.budget, 0, 4000)),
    chunkChars: Math.round(num(s.chunkChars, d.chunkChars, 200, 2000)),
    // 重叠必须小于分块长度，否则滑窗永远前进不了
    overlapChars: Math.round(
      num(s.overlapChars, d.overlapChars, 0, Math.max(0, Math.round(num(s.chunkChars, d.chunkChars, 200, 2000)) - 50))
    )
  }
}

// ---------------- WebDAV 同步 ----------------

export function defaultWebdavSettings() {
  return {
    enabled: false,
    url: '', // 形如 https://dav.example.com/dav
    username: '',
    remoteDir: 'novel-studio', // 快照文件放在这个远程目录下
    autoSync: false,
    intervalSec: 300,
    conflictCopies: true,
    timeoutSec: 30,
    // 以下四个是上次同步的结果，属于「展示用状态」，不值得每次改动都重设
    lastSyncAt: 0,
    lastStatus: 'idle', // 'idle' | 'ok' | 'error' | 'busy'
    lastError: '',
    lastEtag: '' // 本机快照文件上一次上传后服务器给的 ETag
  }
}

export function normalizeWebdavSettings(v) {
  const d = defaultWebdavSettings()
  const s = v && typeof v === 'object' ? v : {}
  const status = ['idle', 'ok', 'error', 'busy'].includes(s.lastStatus) ? s.lastStatus : d.lastStatus
  return {
    enabled: s.enabled === true,
    url: str(s.url, d.url).trim(),
    username: str(s.username, d.username).trim(),
    remoteDir: normalizeRemoteDirInput(s.remoteDir),
    autoSync: s.autoSync === true,
    intervalSec: Math.round(num(s.intervalSec, d.intervalSec, 30, 86400)),
    conflictCopies: s.conflictCopies !== false,
    timeoutSec: Math.round(num(s.timeoutSec, d.timeoutSec, 5, 120)),
    lastSyncAt: num(s.lastSyncAt, 0, 0, Number.MAX_SAFE_INTEGER),
    lastStatus: status,
    lastError: str(s.lastError, ''),
    lastEtag: str(s.lastEtag, '')
  }
}

/**
 * 远程目录规范化。与主进程的 normalizeRemoteDir 保持一致的**输入侧**规则：
 * 去掉首尾斜杠、反斜杠转正斜杠、拒绝 `..` 段。真正的信任边界在主进程，
 * 这里只负责把明显错误的输入在界面上及时提示出来。
 */
export function normalizeRemoteDirInput(v) {
  let s = str(v, '').trim().replace(/\\/g, '/')
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (!s) return 'novel-studio'
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) return 'novel-studio'
  return s
}

// ---------------- 声明式插件 ----------------

export function defaultPluginSettings() {
  return {
    enabled: true,
    disabledIds: [], // 用户关掉的插件 id
    contextBudget: 400 // 插件上下文碎片这一层的 token 预算
  }
}

export function normalizePluginSettings(v) {
  const d = defaultPluginSettings()
  const s = v && typeof v === 'object' ? v : {}
  const ids = Array.isArray(s.disabledIds) ? s.disabledIds : []
  return {
    enabled: s.enabled !== false,
    disabledIds: [...new Set(ids.filter((x) => typeof x === 'string' && x))].slice(0, 200),
    contextBudget: Math.round(num(s.contextBudget, d.contextBudget, 0, 4000))
  }
}

// ---------------- 设备名 ----------------

/** 设备显示名。空名由 deviceId 派生，保证每台设备在界面上都有一个可辨认的称呼。 */
export function deriveDeviceName(deviceName, deviceId) {
  const name = str(deviceName, '').trim()
  if (name) return name.slice(0, 40)
  const id = str(deviceId, '')
  const tail = id.replace(/[^a-zA-Z0-9]/g, '').slice(-4) || '????'
  return `设备 ${tail}`
}
