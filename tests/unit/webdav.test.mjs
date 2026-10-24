import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  DAV_MAX_BYTES,
  DAV_SNAPSHOT_SUFFIX,
  describeDavStatus,
  describeWebdavState,
  headerValue,
  isEtagConflict,
  normalizeDeviceFileId,
  normalizeEtag,
  normalizeRemoteDir,
  parseDavBase,
  parseDavHrefs,
  remoteDirPath,
  remoteFilePath,
  shouldRetryDavStatus,
  snapshotFilesFromHrefs,
  snapshotPath
} from '../../src/services/sync/webdavConfig.js'

const require = createRequire(import.meta.url)
const {
  buildDavUrl,
  davRequest,
  ensureCollection,
  joinRemotePath,
  normalizeRemoteDir: mainNormalizeRemoteDir
} = require('../../electron/webdav.js')

// ---------------------------------------------------------------------------
// 配置规范化
// ---------------------------------------------------------------------------

test('WebDAV：只接受完整的 http/https 根地址', () => {
  const ok = parseDavBase('https://dav.example.com/dav/')
  assert.equal(ok.ok, true)
  assert.equal(ok.base, 'https://dav.example.com/dav')
  assert.equal(ok.origin, 'https://dav.example.com')
  assert.equal(ok.path, '/dav')
  assert.equal(ok.https, true)

  assert.equal(parseDavBase('http://192.168.1.2:5005/').ok, true)
  for (const bad of [
    '',
    'dav.example.com/dav',
    'ftp://dav.example.com',
    'file:///C:/dav',
    'https://user:pass@dav.example.com/dav',
    'https://dav.example.com/dav?x=1',
    'https://dav.example.com/dav#x'
  ]) {
    assert.equal(parseDavBase(bad).ok, false, bad)
  }
})

test('WebDAV：远程目录去斜杠、拒绝穿越，默认 novel-studio', () => {
  assert.equal(normalizeRemoteDir('  /a/b/  '), 'a/b')
  assert.equal(normalizeRemoteDir('a//b'), 'a/b')
  assert.equal(normalizeRemoteDir('a\\b'), 'a/b')
  assert.equal(normalizeRemoteDir(''), 'novel-studio')
  assert.equal(normalizeRemoteDir('../../etc'), 'novel-studio')
  assert.equal(normalizeRemoteDir('a/./b'), 'novel-studio')
  assert.equal(mainNormalizeRemoteDir('../../etc'), 'novel-studio')
})

test('WebDAV：设备文件名只接受安全字符，不「清洗」成别的 id', () => {
  assert.equal(normalizeDeviceFileId('abc-123_X'), 'abc-123_X')
  assert.equal(normalizeDeviceFileId('../evil'), '')
  assert.equal(normalizeDeviceFileId('设备一'), '')
  assert.equal(normalizeDeviceFileId(''), '')
  assert.equal(normalizeDeviceFileId('a'.repeat(65)), '')
})

test('WebDAV：远程路径按段编码，目录/文件/快照三种拼法一致', () => {
  assert.equal(remoteDirPath('novel studio'), '/novel%20studio/')
  assert.equal(remoteFilePath('novel studio', '设备一.json'), '/novel%20studio/%E8%AE%BE%E5%A4%87%E4%B8%80.json')
  assert.equal(snapshotPath('novel-studio', 'dev1'), '/novel-studio/dev1.json')
  assert.equal(snapshotPath('novel-studio', '../evil'), '')
  assert.equal(joinRemotePath('a/b'), '/a/b/')
})

test('WebDAV：从 PROPFIND href 里挑出对端快照，跳过自己与目录', () => {
  const hrefs = [
    '/dav/novel-studio/',
    '/dav/novel-studio/me.json',
    '/dav/novel-studio/peer2.json',
    '/dav/novel-studio/peer1.json',
    '/dav/novel-studio/notes.txt',
    '/dav/novel-studio/peer1.json'
  ]
  assert.deepEqual(snapshotFilesFromHrefs(hrefs, { ownDeviceId: 'me' }), [
    'peer1.json',
    'peer2.json'
  ])
  assert.ok(DAV_SNAPSHOT_SUFFIX === '.json')
})

test('WebDAV：解析 href 支持命名空间前缀、实体与绝对 URL', () => {
  const xml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/a&amp;b/x.json</d:href></d:response>
      <D:response><D:href>https://host/dav/y%20z.json</D:href></D:response>
      <response><href>/dav/plain.json</href></response>
      <d:response><d:href>/dav/a&amp;b/x.json</d:href></d:response>
    </d:multistatus>`
  assert.deepEqual(parseDavHrefs(xml), ['/dav/a&b/x.json', '/dav/y z.json', '/dav/plain.json'])
  assert.deepEqual(parseDavHrefs(''), [])
})

test('WebDAV：响应头大小写不敏感，ETag 去空白', () => {
  assert.equal(headerValue({ Etag: '"abc"' }, 'etag'), '"abc"')
  assert.equal(headerValue({ 'If-Match': 'x' }, 'if-match'), 'x')
  assert.equal(headerValue(null, 'etag'), '')
  assert.equal(normalizeEtag('  "v1"  '), '"v1"')
  assert.equal(normalizeEtag(undefined), '')
})

test('WebDAV：状态码分类与重试集合', () => {
  assert.equal(describeDavStatus(200), '')
  assert.match(describeDavStatus(401), /用户名与密码/)
  assert.match(describeDavStatus(403), /用户名与密码/)
  assert.match(describeDavStatus(404), /目录不存在/)
  assert.match(describeDavStatus(412), /重新合并/)
  assert.match(describeDavStatus(507), /空间不足/)

  assert.equal(isEtagConflict(412), true)
  assert.equal(isEtagConflict(409), false)
  for (const s of [408, 409, 412, 429, 500, 503]) assert.equal(shouldRetryDavStatus(s), true, String(s))
  for (const s of [200, 400, 401, 403, 404]) assert.equal(shouldRetryDavStatus(s), false, String(s))
})

test('WebDAV：状态文案从 lastStatus 推导，未知状态回退 idle', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  const idle = describeWebdavState({ lastStatus: 'nope', lastSyncAt: 0 }, now)
  assert.equal(idle.status, 'idle')
  assert.equal(idle.when, '从未同步')
  const ok = describeWebdavState(
    { lastStatus: 'ok', lastSyncAt: now - 5 * 60000, lastError: '' },
    now
  )
  assert.equal(ok.label, '同步成功')
  assert.equal(ok.when, '5 分钟前')
  const err = describeWebdavState({ lastStatus: 'error', lastError: 'x' }, now)
  assert.equal(err.label, '同步失败')
  assert.equal(err.error, 'x')
})

// ---------------------------------------------------------------------------
// 主进程信任边界（buildDavUrl / davRequest / ensureCollection）
// ---------------------------------------------------------------------------

test('主进程：路径不得越出 baseUrl，编码穿越与绝对地址都被拒绝', () => {
  const base = 'https://dav.example.com/dav'
  const ok = buildDavUrl(base, '/novel-studio/dev1.json')
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://dav.example.com/dav/novel-studio/dev1.json')

  for (const bad of [
    '/../evil.json',
    '/novel-studio/%2e%2e/evil.json',
    '/novel-studio/%2E%2E%2Fevil.json',
    '//evil.example.com/x',
    'https://evil.example.com/x',
    '/a/../../b',
    '/a?x=1',
    '/a#b',
    '/a\\b',
    '',
    'novel-studio/dev1.json'
  ]) {
    assert.equal(buildDavUrl(base, bad).ok, false, bad)
  }
  // baseUrl 本身非法（ftp / 带凭据 / 带查询串）
  assert.equal(buildDavUrl('ftp://dav.example.com/dav', '/a').ok, false)
  assert.equal(buildDavUrl('https://u:p@dav.example.com/dav', '/a').ok, false)
  assert.equal(buildDavUrl('https://dav.example.com/dav?x=1', '/a').ok, false)
})

function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const r = handler(url, init)
    return {
      status: r.status,
      headers: {
        forEach(cb) {
          for (const [k, v] of Object.entries(r.headers || {})) cb(v, k)
        }
      },
      arrayBuffer: async () => Buffer.from(r.body || '', 'utf8')
    }
  }
  fn.calls = calls
  return fn
}

test('主进程：方法白名单、Basic 认证、3xx 拒绝、请求体上限', async () => {
  let seen = null
  const fetch = fakeFetch((url, init) => {
    seen = { url, init }
    return { status: 201, headers: { etag: '"e1"' }, body: '' }
  })
  const ok = await davRequest(
    {
      baseUrl: 'https://dav.example.com/dav',
      path: '/x.json',
      method: 'PUT',
      username: 'u',
      password: 'p',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    },
    { netFetch: fetch }
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 201)
  assert.equal(headerValue(ok.headers, 'etag'), '"e1"')
  assert.equal(seen.init.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'))
  assert.equal(seen.init.headers['content-type'], 'application/json')
  assert.equal(seen.init.redirect, 'manual')
  // Electron `net.fetch` 走 Chromium 的 Fetch，传 Node Buffer 会 ERR_INVALID_ARGUMENT；
  // 必须是普通 Uint8Array。content-length 由 fetch 自己算，不能手写。
  assert.equal(Buffer.isBuffer(seen.init.body), false)
  assert.equal(seen.init.body instanceof Uint8Array, true)
  assert.equal(seen.init.headers['content-length'], undefined)

  // 不允许的方法
  const badMethod = await davRequest(
    { baseUrl: 'https://dav.example.com/dav', path: '/x', method: 'DELETE' },
    { netFetch: fetch }
  )
  assert.equal(badMethod.code, 'EINVAL')

  // 3xx 不跟随，也不把 Authorization 带去别的主机
  const redirect = await davRequest(
    { baseUrl: 'https://dav.example.com/dav', path: '/x', method: 'GET' },
    { netFetch: fakeFetch(() => ({ status: 302, headers: { location: 'https://evil/' } })) }
  )
  assert.equal(redirect.ok, false)
  assert.equal(redirect.code, 'EREDIRECT')

  // 未列入白名单的请求头被丢掉（防止渲染层顺手塞 Authorization）
  let headersSeen = null
  await davRequest(
    {
      baseUrl: 'https://dav.example.com/dav',
      path: '/x',
      method: 'GET',
      headers: { authorization: 'Basic attacker', 'x-evil': '1', Depth: '1' }
    },
    {
      netFetch: fakeFetch((url, init) => {
        headersSeen = init.headers
        return { status: 200, body: '' }
      })
    }
  )
  assert.equal(headersSeen.authorization, undefined)
  assert.equal(headersSeen['x-evil'], undefined)
  assert.equal(headersSeen.depth, '1')

  // 超过上限的请求体不发出去
  const huge = await davRequest(
    {
      baseUrl: 'https://dav.example.com/dav',
      path: '/x',
      method: 'PUT',
      body: Buffer.alloc(DAV_MAX_BYTES + 1)
    },
    { netFetch: fetch }
  )
  assert.equal(huge.code, 'ETOOLARGE')
})

test('主进程：网络错误与超时不带出底层正文', async () => {
  const net = await davRequest(
    { baseUrl: 'https://dav.example.com/dav', path: '/x', method: 'GET' },
    {
      netFetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND dav.example.com --Authorization: Basic secret')
      }
    }
  )
  assert.equal(net.ok, false)
  assert.equal(net.code, 'ENETWORK')
  assert.ok(!net.message.includes('secret'))
  assert.ok(!net.message.includes('ENOTFOUND'))

  const abort = await davRequest(
    { baseUrl: 'https://dav.example.com/dav', path: '/x', method: 'GET', timeoutSec: 0.01 },
    {
      netFetch: (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    }
  )
  assert.equal(abort.code, 'ETIMEOUT')
})

test('主进程：逐级建目录，405 = 已存在也算成功', async () => {
  const seen = []
  const fetch = fakeFetch((url) => {
    seen.push(url)
    return seen.length === 1 ? { status: 405 } : { status: 201 }
  })
  const res = await ensureCollection(
    {
      baseUrl: 'https://dav.example.com/dav',
      remoteDir: 'a/b',
      username: 'u',
      password: 'p'
    },
    { netFetch: fetch }
  )
  assert.equal(res.ok, true)
  assert.equal(seen.length, 2)
  assert.match(seen[0], /\/dav\/a\/$/)
  assert.match(seen[1], /\/dav\/a\/b\/$/)

  const fail = await ensureCollection(
    { baseUrl: 'https://dav.example.com/dav', remoteDir: 'a' },
    { netFetch: fakeFetch(() => ({ status: 401 })) }
  )
  assert.equal(fail.ok, false)
  assert.equal(fail.code, 'EMKCOL')
})
