const http = require('http')
const crypto = require('crypto')

/**
 * 冒烟测试用的内存 WebDAV 服务器（**只在 SMOKE_TEST 下启动**）。
 *
 * 为什么要真的开一个 HTTP 服务：WebDAV 请求走的是 `webdav:request` IPC →
 * 主进程 `davRequest` → `net.fetch`。如果直接把 `davRequest` 换成假函数，
 * 被跳过的恰好是「认证头有没有带上、路径拼得对不对、ETag 条件请求有没有发」
 * 这些真正容易错的环节。一个几十行的内存服务器能把这些全部覆盖到。
 *
 * 支持：PROPFIND（目录列举）、MKCOL、GET、HEAD、PUT（含 If-Match/ETag）、
 * Basic 认证。不做 LOCK / PROPPATCH / DELETE —— 同步流程一个都用不到。
 */
function startSmokeWebdav(options = {}) {
  const root = String(options.root || '/dav')
  const files = new Map() // path -> { body: Buffer, etag }
  const dirs = new Set([root])
  const state = {
    requests: [],
    puts: 0,
    conflicts: 0,
    authSeen: '',
    lastBodyLength: 0
  }

  function etagOf(body) {
    return '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"'
  }

  function decodePath(url) {
    try {
      return decodeURIComponent(new URL(url, 'http://local').pathname)
    } catch {
      return ''
    }
  }

  function encodeHref(p) {
    return p
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      ...headers
    })
    res.end(body == null ? '' : body)
  }

  function collect(req, limit, done) {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > limit) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', () => done(Buffer.alloc(0)))
  }

  const server = http.createServer((req, res) => {
    const path = decodePath(req.url)
    const method = String(req.method || '').toUpperCase()
    const auth = String(req.headers.authorization || '')
    state.requests.push({ method, path })
    if (auth) state.authSeen = auth
    // 测试要确认「密码确实以 Basic 形式发出去了」；这里只校验形状，不校验内容
    if (!/^Basic [A-Za-z0-9+/=]+$/.test(auth)) {
      send(res, 401, 'auth required', { 'www-authenticate': 'Basic realm="smoke"' })
      return
    }

    const isDir = path.endsWith('/')
    if (method === 'PROPFIND') {
      if (isDir) {
        if (!dirs.has(path.replace(/\/+$/, '') || '/')) {
          send(res, 404, 'not found')
          return
        }
        const prefix = path
        const entries = [
          path,
          ...[...files.keys()].filter((p) => p.startsWith(prefix))
        ]
        const xml =
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<d:multistatus xmlns:d="DAV:">' +
          entries
            .map((p) => `<d:response><d:href>${encodeHref(p)}</d:href></d:response>`)
            .join('') +
          '</d:multistatus>'
        send(res, 207, xml, { 'content-type': 'application/xml; charset=utf-8' })
        return
      }
      const file = files.get(path)
      if (!file) {
        send(res, 404, 'not found')
        return
      }
      const xml =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<d:multistatus xmlns:d="DAV:">' +
        `<d:response><d:href>${encodeHref(path)}</d:href></d:response>` +
        '</d:multistatus>'
      send(res, 207, xml, {
        'content-type': 'application/xml; charset=utf-8',
        etag: file.etag
      })
      return
    }

    if (method === 'MKCOL') {
      if (!isDir) {
        send(res, 405, 'collection only')
        return
      }
      const clean = path.replace(/\/+$/, '')
      if (dirs.has(clean)) {
        send(res, 405, 'already exists')
        return
      }
      // 逐级创建父目录
      const segs = clean.split('/').filter(Boolean)
      let cur = ''
      for (const s of segs) {
        cur += '/' + s
        dirs.add(cur)
      }
      send(res, 201, '')
      return
    }

    if (method === 'PUT') {
      collect(req, 64 * 1024 * 1024, (buf) => {
        const parent = path.slice(0, path.lastIndexOf('/') + 1)
        if (!dirs.has(parent.replace(/\/+$/, '') || '/')) {
          send(res, 409, 'no parent')
          return
        }
        const ifMatch = String(req.headers['if-match'] || '')
        const existing = files.get(path)
        if (ifMatch) {
          const current = existing ? existing.etag : ''
          if (!current || (ifMatch !== '*' && ifMatch !== current)) {
            state.conflicts++
            send(res, 412, 'precondition failed', existing ? { etag: current } : {})
            return
          }
        }
        const created = !existing
        const etag = etagOf(buf)
        files.set(path, { body: buf, etag })
        state.puts++
        state.lastBodyLength = buf.length
        send(res, created ? 201 : 204, '', { etag })
      })
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      const file = files.get(path)
      if (!file) {
        send(res, 404, 'not found')
        return
      }
      if (method === 'HEAD') {
        send(res, 200, '', { etag: file.etag, 'content-length': String(file.body.length) })
      } else {
        send(res, 200, file.body, {
          etag: file.etag,
          'content-type': 'application/json; charset=utf-8'
        })
      }
      return
    }

    send(res, 405, 'method not allowed')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        root,
        state,
        /** 直接写一份文件（模拟另一台设备已经上传过快照） */
        seed(path, obj) {
          const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8')
          files.set(path, { body, etag: etagOf(body) })
        },
        read(path) {
          return files.get(path) || null
        },
        getFileCount() {
          return files.size
        },
        close: () =>
          new Promise((r) => {
            server.close(() => r())
          })
      })
    })
  })
}

module.exports = { startSmokeWebdav }
