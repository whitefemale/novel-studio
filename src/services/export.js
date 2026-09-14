// 导出 TXT / Markdown。
// 四条落盘路径：桌面端直写目录 / 桌面端弹保存框 / 浏览器下载 / 原生分享面板。
import { isDesktop, isNative } from './platform'
import { shareTextFile } from './native'

/** 生成整本 TXT 文本 */
export function buildTxt(book, chapters) {
  const parts = []
  parts.push(book.title || '未命名小说')
  parts.push('')
  const sorted = [...chapters].sort((a, b) => a.order - b.order)
  for (const c of sorted) {
    parts.push(`第${c.order}章 ${c.title || '未命名章节'}`)
    parts.push('')
    parts.push(c.content || '')
    parts.push('')
    parts.push('')
  }
  return parts.join('\n')
}

/** 生成整本 Markdown 文本 */
export function buildMarkdown(book, chapters) {
  const parts = []
  parts.push(`# ${book.title || '未命名小说'}`)
  parts.push('')
  const sorted = [...chapters].sort((a, b) => a.order - b.order)
  for (const c of sorted) {
    parts.push(`## ${c.title || `第${c.order}章`}`)
    parts.push('')
    parts.push(c.content || '')
    parts.push('')
  }
  return parts.join('\n')
}

/** 生成单章纯文本 */
export function buildChapterText(chapter) {
  return `${chapter.title || '未命名章节'}\n\n${chapter.content || ''}`
}

/** 生成单章 Markdown（标题缺失时不再输出 `# undefined`） */
export function buildChapterMarkdown(chapter) {
  const title = chapter?.title || `第${chapter?.order ?? 1}章`
  return `# ${title}\n\n${chapter?.content || ''}`
}

// ---------------------------------------------------------------------------
// 文件名净化
// 注意：这一份只用于「预览与建议文件名」。真正的信任边界在 Electron 主进程，
// 那里有一份算法一致的独立实现——因为导出请求可能来自即发即忘、无法报错的
// 路径，渲染层的净化结果不能被当作可信输入。
// 与主进程的约定：子目录名一律拒绝、文件名一律改写。
// ---------------------------------------------------------------------------
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 去掉控制字符（含 DEL）。按码点过滤而非正则字面量，避免把裸控制字节写进源码 */
function stripControlChars(s) {
  let out = ''
  for (const ch of s) {
    const n = ch.codePointAt(0)
    if (n < 32 || n === 127) continue
    out += ch
  }
  return out
}

export function sanitizeFileName(name, fallback = '小说') {
  // 路径分隔符与 Windows 非法字符
  let s = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_')
  // 控制字符、首尾空白、首尾点（以点结尾的文件名在 Windows 上无法创建）
  s = stripControlChars(s)
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  if (!s) return fallback
  // Windows 保留设备名：加前缀而非拒绝，保证用户内容不丢
  if (WINDOWS_RESERVED.test(s)) s = '_' + s
  const MAX = 80
  if (s.length > MAX) s = s.slice(0, MAX).trim()
  return s || fallback
}

/** 备份文件名：`书名-YYYYMMDD-HHmm.txt` */
export function buildBackupName(book, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const d = date
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${sanitizeFileName(book?.title)}-${stamp}.txt`
}

/** 浏览器兜底：Blob + 合成 <a download> 点击 */
function downloadInBrowser(fileName, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return { canceled: false, platform: 'web' }
}

/**
 * 保存导出内容。
 *
 * @param {object}  o
 * @param {string}  o.fileName          建议文件名（含扩展名）
 * @param {string}  o.content           正文
 * @param {string} [o.ext]              扩展名，用于桌面保存框的过滤器排序
 * @param {object} [o.target]           桌面端直写目标 `{ dir, subDir }`；缺省则弹保存框
 * @param {boolean}[o.reveal]           写入后在资源管理器中定位文件
 * @returns {Promise<object>}
 *   桌面直写   → `{ ok, filePath, bytes }` 或 `{ ok:false, code, message }`
 *   桌面保存框 → `{ canceled }` 或 `{ canceled:false, filePath }`
 *   原生       → `{ canceled:false, filePath, platform:'android' }`
 *   浏览器     → `{ canceled:false, platform:'web' }`
 */
export async function saveToDisk({
  fileName,
  content,
  ext = 'txt',
  target = null,
  reveal = false
} = {}) {
  const name = sanitizeFileName(fileName)

  if (isDesktop()) {
    // 直写模式：保存地址已配置。失败时不在函数内部静默回落——
    // 由调用方提示一次「保存地址不可用，改为另存为？」，避免一次点击弹两个对话框。
    if (target && target.dir) {
      const res = await window.electronAPI.writeToDir({
        dir: target.dir,
        subDir: target.subDir || '',
        fileName: name,
        content
      })
      if (res?.ok && reveal) {
        // 即发即忘：打开文件夹失败绝不能把一次成功的导出变成错误提示
        Promise.resolve(window.electronAPI.openFolder({ filePath: res.filePath })).catch(() => {})
      }
      return res
    }
    return await window.electronAPI.saveFile({
      defaultName: name,
      content,
      ext,
      defaultDir: target?.dir || ''
    })
  }

  if (isNative()) {
    return await shareTextFile(name, content)
  }

  return downloadInBrowser(name, content)
}

/**
 * 导出的落盘目标：`<saveDir>/<书名>/`（perBookFolder 关闭时直接落在 saveDir）。
 * 返回的 subDir 是「相对路径」，可含多层，由主进程逐段校验后再拼接。
 */
export function buildExportTarget(settings, book) {
  const dir = settings?.saveDir || ''
  if (!dir) return null
  const subDir = settings?.perBookFolder ? sanitizeFileName(book?.title) : ''
  return { dir, subDir }
}

/** 备份的落盘目标：`<saveDir>/<书名>/备份/` */
export function buildBackupTarget(settings, book) {
  const base = buildExportTarget(settings, book)
  if (!base) return null
  return { dir: base.dir, subDir: [base.subDir, '备份'].filter(Boolean).join('/') }
}

/**
 * 从备份文件名列表中挑出超出保留份数、应当删除的那些。
 * 文件名内嵌 YYYYMMDD-HHmm，字典序即时间序，无需解析日期。
 * @param {string[]} fileNames
 * @param {number}   keep
 * @returns {string[]}
 */
export function pickStaleBackups(fileNames, keep) {
  const n = Number(keep)
  if (!Array.isArray(fileNames) || !Number.isFinite(n) || n <= 0) return []
  const sorted = [...fileNames].sort().reverse()
  return sorted.slice(n)
}
