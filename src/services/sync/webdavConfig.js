/**
 * WebDAV 同步的配置与协议分类（纯函数，无 I/O）。
 *
 * 这些规则在渲染层出现**只是为了尽早给用户一句能照着改的提示**；
 * 真正的信任边界在 `electron/webdav.js`：地址、方法、路径、体积都在主进程
 * 再校验一遍。渲染层的校验结果永远不能当成已校验（同导出路径的做法）。
 */

/** 允许的方法白名单。只做「同步一个 JSON 文件」需要的最小集合。 */
export const DAV_METHODS = ['PROPFIND', 'MKCOL', 'GET', 'HEAD', 'PUT']

/** 单个快照文件上限，与局域网同步一致。 */
export const DAV_MAX_BYTES = 64 * 1024 * 1024

/** 远程快照文件名。deviceId 只允许安全字符，文件名就是 `${deviceId}.json`。 */
export const DAV_SNAPSHOT_SUFFIX = '.json'

const SAFE_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

const BAD_URL = '请填写完整地址：以 http:// 或 https:// 开头，例如 https://dav.example.com/dav'

/**
 * 解析用户填的 WebDAV 根地址。
 *
 * 返回 `{ ok, base, origin, path, https, message }`：
 *   - `base`   去掉末尾斜杠的完整地址（拼路径用）
 *   - `origin` http(s)://host:port（主进程用它做同源检查）
 *   - `path`   服务器上的根路径（通常是 `/dav`）
 */
export function parseDavBase(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, message: BAD_URL }
  if (!/^https?:\/\//i.test(raw)) return { ok: false, message: BAD_URL }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, message: BAD_URL }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: BAD_URL }
  if (!u.hostname) return { ok: false, message: BAD_URL }
  // 不接收查询串/锚点：它们在不同服务器上的含义完全不同，拼进路径只会得到 404。
  if (u.search || u.hash) {
    return { ok: false, message: '地址里不要带 ? 查询串或 # 锚点，只填 WebDAV 根地址' }
  }
  if (u.username || u.password) {
    return { ok: false, message: '不要把用户名密码写进地址，请分别填在下面两栏' }
  }
  const path = u.pathname.replace(/\/+$/, '')
  return {
    ok: true,
    base: u.origin + path,
    origin: u.origin,
    path,
    https: u.protocol === 'https:',
    message: ''
  }
}

/** 远程目录规范化：去首尾斜杠、反斜杠转正斜杠、拒绝 `.` / `..` 段。 */
export function normalizeRemoteDir(input) {
  let s = String(input ?? '').trim().replace(/\\/g, '/')
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (!s) return 'novel-studio'
  if (s.split('/').some((seg) => seg === '.' || seg === '..')) return 'novel-studio'
  return s
}

/** deviceId 是文件名的一部分，非法字符直接拒绝（不「清洗成别的 id」）。 */
export function normalizeDeviceFileId(deviceId) {
  const s = String(deviceId ?? '').trim()
  return SAFE_DEVICE_ID.test(s) ? s : ''
}

/** 远程目录本身（相对挂载根），以 `/` 结尾。PROPFIND / MKCOL 用它。 */
export function remoteDirPath(remoteDir) {
  const dir = normalizeRemoteDir(remoteDir)
  return '/' + dir.split('/').map((s) => encodeURIComponent(s)).join('/') + '/'
}

/** 目录里的某个文件名（已由调用方校验过名字）。 */
export function remoteFilePath(remoteDir, fileName) {
  return remoteDirPath(remoteDir) + encodeURIComponent(String(fileName || ''))
}

/**
 * 拼远程快照路径（相对挂载根的绝对路径）。
 * 每一段单独编码，避免目录名里的 `#` / `?` 被当成 URL 结构。
 */
export function snapshotPath(remoteDir, deviceId) {
  const dir = normalizeRemoteDir(remoteDir)
  const id = normalizeDeviceFileId(deviceId)
  if (!id) return ''
  const segs = [...dir.split('/'), `${id}${DAV_SNAPSHOT_SUFFIX}`]
  return '/' + segs.map((s) => encodeURIComponent(s)).join('/')
}

/** 列出响应里的快照文件名（排除目录本身与非 .json）。 */
export function snapshotFilesFromHrefs(hrefs, { ownDeviceId = '' } = {}) {
  const own = `${ownDeviceId}${DAV_SNAPSHOT_SUFFIX}`
  return (Array.isArray(hrefs) ? hrefs : [])
    .map((h) => String(h || '').split('/').filter(Boolean).pop() || '')
    .map((name) => {
      try {
        return decodeURIComponent(name)
      } catch {
        return name
      }
    })
    .filter((name) => name.endsWith(DAV_SNAPSHOT_SUFFIX) && name !== own)
    .filter((name, i, arr) => arr.indexOf(name) === i)
    .sort((a, b) => a.localeCompare(b))
}

const XML_ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

function decodeXmlEntities(s) {
  return String(s).replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => XML_ENTITY[m] || m)
}

/**
 * 解析 PROPFIND 响应里的 href。
 *
 * 正则而不是 XML 解析器：响应可能没有命名空间前缀（`<href>`）或用了大写
 * `D:`，而引入一个 XML 依赖只为取几个字符串并不值得。这里只取 href 的
 * **路径**，服务器返回绝对 URL 时也能用。
 */
export function parseDavHrefs(xml) {
  const text = String(xml ?? '')
  const out = []
  const re = /<(?:[A-Za-z0-9]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href\s*>/gi
  let m
  while ((m = re.exec(text))) {
    let href = decodeXmlEntities(m[1].trim())
    if (!href) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
      try {
        href = new URL(href).pathname
      } catch {
        continue
      }
    }
    try {
      href = decodeURIComponent(href)
    } catch {
      // 保留原样：分裂的百分号编码不值得我们整条丢弃
    }
    if (!out.includes(href)) out.push(href)
    if (out.length >= 500) break // 防御性上限：再多的文件也不该拖垮界面
  }
  return out
}

/** 大小写不敏感地读一个响应头（主进程返回的是普通对象）。 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  const target = String(name || '').toLowerCase()
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) {
      const v = headers[k]
      return v == null ? '' : String(v)
    }
  }
  return ''
}

/** ETag 统一成可回传的形式（去掉弱校验前缀 `W/` 不影响 If-Match 的常规用法）。 */
export function normalizeEtag(value) {
  return String(value ?? '').trim()
}

export function isEtagConflict(status) {
  return Number(status) === 412
}

/** 上传时值得重试的状态：先决条件失败 / 冲突 / 服务端临时故障。 */
export function shouldRetryDavStatus(status) {
  const n = Number(status) || 0
  return n === 408 || n === 409 || n === 412 || n === 429 || (n >= 500 && n <= 599)
}

/**
 * 把 HTTP 状态翻译成用户能看懂的一句话。
 * 401/403 必须明确指向凭据，而不是笼统的「同步失败」。
 */
export function describeDavStatus(status) {
  const n = Number(status) || 0
  if (n >= 200 && n < 300) return ''
  if (n === 401 || n === 403) return 'WebDAV 拒绝访问：请检查用户名与密码'
  if (n === 404) return '远程目录不存在（可点「测试连接」自动创建）'
  if (n === 405) return '服务器不支持这个操作（请确认填的是 WebDAV 地址）'
  if (n === 409) return '远程文件冲突，请稍后重试'
  if (n === 412) return '远程文件已被其他设备改动，正在重新合并'
  if (n === 413) return '快照文件超过服务器允许的大小'
  if (n === 423) return '远程文件被服务器锁定（LOCK），请稍后重试'
  if (n === 507) return 'WebDAV 服务器空间不足'
  if (n >= 300 && n < 400) return '服务器要求跳转，请把地址改成跳转后的最终地址'
  if (n >= 500) return `WebDAV 服务器出错（${n}），请稍后重试`
  return `WebDAV 返回 ${n}`
}

/** 同步状态文案。UI 与单测共用，避免两处各写一份枚举。 */
export const WEBDAV_STATUS_LABELS = {
  idle: '尚未同步',
  busy: '同步中',
  ok: '同步成功',
  error: '同步失败',
  skipped: '已跳过'
}

export function describeWebdavState(webdav, now = Date.now()) {
  const s = webdav && typeof webdav === 'object' ? webdav : {}
  const last = Number(s.lastSyncAt) || 0
  const status = WEBDAV_STATUS_LABELS[s.lastStatus] ? s.lastStatus : 'idle'
  let when = '从未同步'
  if (last) {
    const mins = Math.max(0, Math.round((Number(now) - last) / 60000))
    when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
  }
  return {
    status,
    label: WEBDAV_STATUS_LABELS[status],
    when,
    error: String(s.lastError || '')
  }
}
