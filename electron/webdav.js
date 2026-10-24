/**
 * WebDAV 传输（主进程）。
 *
 * 为什么放在主进程：渲染进程在 `webSecurity: true` 下受 CORS 约束，而大多数
 * WebDAV 服务器不会为浏览器预检发 CORS 头；同时 Basic 认证要求我们能带着
 * 凭据发请求——凭据只能出现在主进程加密存储与这一次请求的头里。
 *
 * 这里是**真正的信任边界**，渲染层的 `webdavConfig.js` 只负责早提示：
 *   · 方法白名单（PROPFIND / MKCOL / GET / HEAD / PUT），不暴露 PROPPATCH、
 *     LOCK、DELETE 这些同步用不到、误用代价却很大的方法；
 *   · 路径必须是相对挂载根的绝对路径，拒绝 `..`、`. `、查询串、锚点；
 *   · 最终 URL 必须与用户填的 baseUrl 同源、且仍在 baseUrl 的路径之下；
 *   · 请求体与响应体都有 64MB 上限；
 *   · `redirect: 'manual'`，3xx 一律拒绝——跟随跳转会把 Authorization 头
 *     带去另一个主机，这是凭据泄漏的经典路径。
 *
 * **本文件的任何日志都不含密码、Authorization 头或完整响应正文。**
 */

const DAV_METHODS = new Set(['PROPFIND', 'MKCOL', 'GET', 'HEAD', 'PUT'])
const DAV_MAX_BYTES = 64 * 1024 * 1024
const DAV_ALLOWED_HEADERS = new Set([
  'depth',
  'if-match',
  'if-none-match',
  'content-type',
  'overwrite',
  'accept'
])

function parseBase(baseUrl) {
  const raw = String(baseUrl || '').trim()
  if (!raw) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  if (u.search || u.hash || u.username || u.password) return null
  const basePath = u.pathname.replace(/\/+$/, '')
  return { origin: u.origin, basePath }
}

function safeDecode(seg) {
  try {
    return decodeURIComponent(seg)
  } catch {
    return null
  }
}

/**
 * 校验并拼出一个可发请求的 URL。
 *
 * `path` 是渲染层拼好的、已按段编码的相对路径（如
 * `/novel-studio/abc123.json`）。我们在**解码后**的段上做检查，因此
 * `%2e%2e` 这类编码穿越也拦得住。
 */
function buildDavUrl(baseUrl, path) {
  const base = parseBase(baseUrl)
  if (!base) return { ok: false, message: 'WebDAV 地址无效（只支持 http/https 根地址）' }
  let p = String(path || '').trim()
  if (!p.startsWith('/')) return { ok: false, message: 'WebDAV 路径必须是以 / 开头的相对路径' }
  if (p.includes('?') || p.includes('#')) return { ok: false, message: 'WebDAV 路径不能带查询串或锚点' }
  // 控制字符（含 NUL）会让不同层对同一个字符串产生不同理解
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return { ok: false, message: 'WebDAV 路径含非法字符' }
  }
  if (p.includes('\\') || p.includes('//')) {
    return { ok: false, message: 'WebDAV 路径含非法字符' }
  }
  for (const seg of p.split('/')) {
    if (!seg) continue
    const decoded = safeDecode(seg)
    if (decoded === null) return { ok: false, message: 'WebDAV 路径编码非法' }
    if (decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) {
      return { ok: false, message: 'WebDAV 路径不得越出远程目录' }
    }
  }
  let full
  try {
    full = new URL(base.origin + base.basePath + p)
  } catch {
    return { ok: false, message: 'WebDAV 地址无效' }
  }
  if (full.origin !== base.origin) {
    return { ok: false, message: 'WebDAV 地址必须与配置的根地址同源' }
  }
  if (full.search || full.hash) return { ok: false, message: 'WebDAV 路径不能带查询串或锚点' }
  if (!(full.pathname === base.basePath || full.pathname.startsWith(base.basePath + '/'))) {
    return { ok: false, message: 'WebDAV 路径不得越出远程目录' }
  }
  return { ok: true, url: full.toString(), origin: base.origin }
}

function sanitizeHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [k, v] of Object.entries(headers)) {
    const name = String(k || '').toLowerCase()
    if (!DAV_ALLOWED_HEADERS.has(name)) continue
    if (v == null) continue
    const value = String(v)
    // 头里出现换行等于头注入，直接丢
    if (/[\r\n]/.test(value)) continue
    out[name] = value
  }
  return out
}

/** 规范化远程目录（与渲染层同名函数同规则；主进程不信任渲染层的结果）。 */
function normalizeRemoteDir(input) {
  let s = String(input || '').trim().replace(/\\/g, '/')
  s = s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (!s) return 'novel-studio'
  if (s.split('/').some((seg) => seg === '.' || seg === '..')) return 'novel-studio'
  return s
}

/** 目录路径（用于 MKCOL / PROPFIND），每段单独编码。 */
function joinRemotePath(remoteDir) {
  const dir = normalizeRemoteDir(remoteDir)
  return '/' + dir.split('/').map((s) => encodeURIComponent(s)).join('/') + '/'
}

function headersToObject(headers) {
  const out = {}
  if (!headers || typeof headers.forEach !== 'function') return out
  headers.forEach((value, key) => {
    out[String(key).toLowerCase()] = String(value)
  })
  return out
}

/**
 * 发一次 WebDAV 请求。
 *
 * 返回 `{ ok, status, headers, body }`，HTTP 非 2xx **不抛异常**：状态码是
 * 协议的一部分（404 表示「目录还没建」、412 表示「别人刚改过」），由渲染层
 * 分类处理。只有网络层失败才返回 `{ ok:false, code, message }`。
 */
async function davRequest(options = {}, deps = {}) {
  const {
    baseUrl,
    path,
    method = 'PROPFIND',
    headers,
    body = null,
    username = '',
    password = '',
    timeoutSec = 30
  } = options
  const netFetch = deps.netFetch
  const upper = String(method || '').toUpperCase()
  if (!DAV_METHODS.has(upper)) {
    return { ok: false, code: 'EINVAL', message: '不支持的 WebDAV 方法' }
  }
  const built = buildDavUrl(baseUrl, path)
  if (!built.ok) return { ok: false, code: 'EINVAL', message: built.message }

  let payload = null
  if (body != null && upper !== 'GET' && upper !== 'HEAD') {
    // 必须是 Uint8Array 而不是 Node 的 Buffer：Electron `net.fetch` 走的是
    // Chromium 的 Fetch 实现，传 Buffer 会被判成 ERR_INVALID_ARGUMENT
    // （`instanceof Uint8Array` 为真也不行，内部有独立的参数校验）。
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
    if (buf.byteLength > DAV_MAX_BYTES) {
      return { ok: false, code: 'ETOOLARGE', message: '快照超过 64MB，无法上传' }
    }
    payload = new Uint8Array(buf)
  }

  const finalHeaders = sanitizeHeaders(headers)
  if (username || password) {
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
    finalHeaders.authorization = `Basic ${token}`
  }

  const controller = new AbortController()
  let timer = null
  const secs = Number(timeoutSec) > 0 ? Number(timeoutSec) : 30
  timer = setTimeout(() => controller.abort(), secs * 1000)
  try {
    const res = await netFetch(built.url, {
      method: upper,
      headers: finalHeaders,
      body: payload || undefined,
      redirect: 'manual',
      signal: controller.signal
    })
    const status = Number(res.status) || 0
    // 3xx 不放行：跟随跳转会把 Authorization 带去别的主机
    if (status >= 300 && status < 400) {
      return {
        ok: false,
        code: 'EREDIRECT',
        status,
        message: '服务器要求跳转，请把地址改成跳转后的最终地址'
      }
    }
    let text = ''
    if (upper !== 'HEAD') {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > DAV_MAX_BYTES) {
        return { ok: false, code: 'ETOOLARGE', status, message: 'WebDAV 响应超过 64MB' }
      }
      text = buf.toString('utf8')
    }
    return { ok: true, status, headers: headersToObject(res.headers), body: text }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, code: 'ETIMEOUT', message: `WebDAV 请求超时（${secs} 秒）` }
    }
    // 不把底层 message 带出去：它可能包含完整 URL；证书/网络错误对用户来说
    // 能做的事是一样的
    return {
      ok: false,
      code: 'ENETWORK',
      message: '无法连接 WebDAV 服务器（请检查地址、网络与证书）'
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 从 PROPFIND 响应里取 href（只取路径字符串，不做 XML 语义解析）。 */
function parsePropfindHrefs(xml) {
  const text = String(xml || '')
  const out = []
  const re = /<(?:[A-Za-z0-9]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href\s*>/gi
  let m
  while ((m = re.exec(text))) {
    let href = m[1].trim()
    if (!href) continue
    href = href
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
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
      // 保留原样
    }
    if (!out.includes(href)) out.push(href)
    if (out.length >= 500) break
  }
  return out
}

/**
 * 逐级创建远程目录。201 = 新建、405 = 已存在，两者都算成功。
 * 返回最后一步的 `{ ok, status, message }`；失败即停，不继续往深处建。
 */
async function ensureCollection({ baseUrl, remoteDir, username, password, timeoutSec }, deps) {
  const dir = normalizeRemoteDir(remoteDir)
  const segs = dir.split('/').filter(Boolean)
  let built = ''
  for (const seg of segs) {
    built += '/' + encodeURIComponent(seg)
    const res = await davRequest(
      { baseUrl, path: built + '/', method: 'MKCOL', username, password, timeoutSec },
      deps
    )
    if (!res.ok) return res
    if (res.status === 201 || res.status === 200 || res.status === 405) {
      continue
    }
    // 409 = 父目录不存在（理论上不会，因为我们是逐级建的）；其余状态原样上报
    return {
      ok: false,
      code: 'EMKCOL',
      status: res.status,
      message: `创建远程目录失败（HTTP ${res.status}）`
    }
  }
  return { ok: true, status: 201 }
}

module.exports = {
  DAV_METHODS,
  DAV_MAX_BYTES,
  buildDavUrl,
  normalizeRemoteDir,
  joinRemotePath,
  davRequest,
  parsePropfindHrefs,
  ensureCollection
}
