const { app, BrowserWindow, ipcMain, net, dialog, shell, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const os = require('os')
const crypto = require('crypto')
const { davRequest, ensureCollection } = require('./webdav')

let mainWindow = null
// 活跃请求表：requestId -> AbortController
const activeRequests = new Map()

// ---------------------------------------------------------------------------
// 关窗前的保存握手
//
// 渲染层的自动保存有 1.5 秒防抖窗口。用户点 ✕ 时，最后那几笔可能还没落库。
// 直接关窗等于静默丢稿，所以主进程先拦下第一个 close：
//   1. 发 app:before-close 给渲染层；
//   2. 渲染层 await 编辑器的 flush() 后调 app:close-ready；
//   3. 主进程放行真正的关闭；2 秒没等到也兜底关闭（不能因为渲染层卡死让窗口关不掉）。
//
// before-quit 也要走同一条路 —— Alt+F4 / 系统关机只会触发它，不经过 close。
// ---------------------------------------------------------------------------
let allowClose = false
let closing = false
let closeTimer = null

function beginGracefulClose() {
  if (process.env.SMOKE_TEST) {
    allowClose = true
    return
  }
  if (closing) return
  closing = true
  if (!mainWindow || mainWindow.isDestroyed()) {
    finishClose()
    return
  }
  try {
    mainWindow.webContents.send('app:before-close')
  } catch {
    finishClose()
    return
  }
  closeTimer = setTimeout(finishClose, 2000)
}

function finishClose() {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  allowClose = true
  closing = false
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  else app.quit()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#ffffff',
    title: 'Novel Studio · 自动写小说',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染进程只允许本地资源与脚本，LLM 请求一律走主进程代理（规避 CORS）
      webSecurity: true
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 第一个 close 拦下来，等渲染层把挂起的正文落库（见文件顶部 beginGracefulClose）
  mainWindow.on('close', (e) => {
    if (allowClose) return
    e.preventDefault()
    beginGracefulClose()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 冒烟测试模式：SMOKE_TEST=1 npx electron . → 加载完成后打印挂载状态并退出
  if (process.env.SMOKE_TEST) {
    startSseMockServer()
    const { startSmokeWebdav } = require('./smokeWebdav')
    smokeWebdav = null
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 1) console.log('RENDERER_CONSOLE', message)
    })
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const mount = await mainWindow.webContents.executeJavaScript(
          `(() => ({ appChildren: document.querySelector('#app')?.children.length, hasTopbar: !!document.querySelector('.topbar'), title: document.title }))()`
        )
        console.log('SMOKE_MOUNT ' + JSON.stringify(mount))
      } catch (err) {
        console.error('SMOKE_EVAL_ERROR', err && err.message)
      }
      // 渲染进程没有 node:path，算不出临时目录，由主进程建好并注入
      try {
        fs.rmSync(SMOKE_DIR, { recursive: true, force: true })
        fs.mkdirSync(SMOKE_DIR, { recursive: true })
        await mainWindow.webContents.executeJavaScript(
          `window.__nsSmokeDir = ${JSON.stringify(SMOKE_DIR)}; true`
        )
        // 冒烟用的插件目录：一个合法插件 + 一个坏 JSON + 一个清单不合法的文件。
        // 只有在这一段里才用临时目录，正常启动读的是 userData/plugins。
        const smokePlugins = path.join(SMOKE_DIR, 'plugins')
        fs.mkdirSync(smokePlugins, { recursive: true })
        fs.writeFileSync(
          path.join(smokePlugins, 'smoke-plugin.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              id: 'smoke-plugin',
              name: '冒烟插件',
              version: '1.0.0',
              description: '只用于自动化测试的声明式插件',
              hooks: {
                contextFragments: [
                  { title: '冒烟上下文', text: '这是一段来自声明式插件的写作要求：每章至少出现一次雨声。' }
                ],
                rules: [
                  {
                    id: 'taboo-word',
                    title: '禁用词',
                    severity: 'medium',
                    pattern: '禁词',
                    message: '正文里出现了禁用词。'
                  }
                ],
                exportTemplates: [
                  {
                    id: 'simple',
                    name: '极简模板',
                    ext: 'txt',
                    template: '《{{bookTitle}}》\n共 {{chapterCount}} 章\n\n{{chapters}}\n\n导出于 {{date}}'
                  }
                ],
                keywordHints: [{ keywords: ['雨声'], hint: '别忘了让雨声贯穿本章。' }]
              }
            },
            null,
            2
          ),
          'utf8'
        )
        fs.writeFileSync(path.join(smokePlugins, 'broken.json'), '{ this is not json', 'utf8')
        fs.writeFileSync(
          path.join(smokePlugins, 'bad-manifest.json'),
          JSON.stringify({ schemaVersion: 1, id: 'Bad ID!', hooks: {} }),
          'utf8'
        )
        await mainWindow.webContents.executeJavaScript(
          `window.__nsSmokePluginsDir = ${JSON.stringify(smokePlugins)}; true`
        )
      } catch (err) {
        console.error('SMOKE_DIR_ERROR', err && err.message)
      }
      // WebDAV mock：真实 HTTP 服务，走完整 IPC → net.fetch 链路。
      // 只把 baseUrl 注入渲染层，凭据不注入（测试用固定假密码）。
      try {
        smokeWebdav = await startSmokeWebdav({ root: '/dav' })
        const baseUrl = `http://127.0.0.1:${smokeWebdav.port}/dav`
        await mainWindow.webContents.executeJavaScript(
          `window.__nsSmokeWebdav = ${JSON.stringify({ baseUrl, port: smokeWebdav.port })}; true`
        )
      } catch (err) {
        smokeWebdav = null
        console.error('SMOKE_WEBDAV_ERROR', err && err.message)
        await mainWindow.webContents.executeJavaScript(
          `window.__nsSmokeWebdav = null; true`
        ).catch(() => {})
      }
      // 运行功能级自动化测试
      try {
        const testSrc = fs
          .readFileSync(path.join(__dirname, '..', 'tests', 'smoke-inject.js'), 'utf8')
          .replaceAll('__PORT__', String(SSE_MOCK_PORT))
        const result = await mainWindow.webContents.executeJavaScript(testSrc)
        console.log('SMOKE_DETAIL ' + JSON.stringify(result))
      } catch (err) {
        console.error('SMOKE_TEST_ERROR', err && err.message)
      }
      try {
        fs.rmSync(SMOKE_DIR, { recursive: true, force: true })
        // 冒烟用的临时安全存储目录（见 secureKeyFile）：里面只是一个假 Key
        fs.rmSync(path.join(os.tmpdir(), 'novel-studio-smoke-secure'), {
          recursive: true,
          force: true
        })
      } catch {
        // 清理失败不影响测试结论
      }
      // 测试若中途失败，同步服务可能还挂着监听。app.exit 不会走 before-quit，
      // 所以这里显式关一次——留着就等于本机多一个没人在管的端口。
      stopSyncServer()
      if (smokeWebdav) {
        try {
          await smokeWebdav.close()
        } catch {
          // 关不掉也不影响结论
        }
        smokeWebdav = null
      }
      app.exit(0)
    })
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('SMOKE_FAIL', code, desc)
      app.exit(1)
    })
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 冒烟测试用 SSE mock 服务器（仅 SMOKE_TEST 模式启动）
const SSE_MOCK_PORT = 18765
// 冒烟测试用于验证「写入保存地址」的临时目录（仅 SMOKE_TEST 模式使用）
const SMOKE_DIR = path.join(app.getPath('temp'), 'novel-studio-smoke')
// 冒烟用的内存 WebDAV 服务器（仅 SMOKE_TEST 模式启动，退出前显式关闭）
let smokeWebdav = null
function startSseMockServer() {
  // /flaky 的计数器：第一次 500、之后成功。每次启动 mock 都从 0 开始，
  // 否则同一进程里重跑第二轮测试会看到「第一次就成功」，重试路径形同虚设。
  let flakyHits = 0
  const server = http.createServer((req, res) => {
    console.log('SSE_MOCK_REQ ' + req.method + ' ' + req.url)
    let raw = ''
    req.on('data', (c) => (raw += c))
    // req / res 都必须显式传进去：route 是这个回调的**兄弟**函数，不是它的
    // 嵌套函数，所以 route 里既拿不到 req 也拿不到 res。写成闭包引用会抛
    // ReferenceError，而它发生在 http 服务器的回调里（不是请求处理器内部），
    // 表现是「请求到达了、但永远没有响应」，没有任何报错指向这里。
    req.on('end', () => route(req, res, wantUsage(raw)))
  })

  // 只有请求里带了 stream_options.include_usage，才在流末尾补用量块 ——
  // 真实服务端就是这么做的。于是「关掉 streamUsage 开关」这条路径也能被验证到，
  // 而不是只验证「开关存在」。开关是给不认这个字段、会直接 400 的兼容端点用的。
  function wantUsage(raw) {
    try {
      return JSON.parse(raw || '{}')?.stream_options?.include_usage === true
    } catch {
      return false
    }
  }

  function route(req, res, allowUsage) {
    // usageShape 决定要不要补一个用量块、以及补成哪种形状。两种形状都必须钉住，
    // 因为它们对解析器的要求是相反的（见 llm.js 的 parseSseUsage）。
    const sendSse = (usageShape) => {
      if (!allowUsage) usageShape = null
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })
      const deltas = ['你好', '，世', '界！']
      let i = 0
      const timer = setInterval(() => {
        if (i < deltas.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i++] } }] })}\n\n`)
        } else if (usageShape === 'deepseek') {
          // DeepSeek 形状：usage 挂在最后一个**内容块**上 —— delta 为空、
          // finish_reason 非空。按「有文本才看 usage」写的解析器在这里永远取 0。
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, prompt_cache_hit_tokens: 100 }
            })}\n\n`
          )
          usageShape = null
        } else if (usageShape === 'openai') {
          // OpenAI / vLLM / Kimi 形状：独立的 usage 块，choices 是**空数组**。
          // 按 choices[0] 判断存在性的解析器会整块跳过。
          res.write(
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 777, completion_tokens: 88, total_tokens: 865 }
            })}\n\n`
          )
          usageShape = null
        } else {
          res.write('data: [DONE]\n\n')
          clearInterval(timer)
          res.end()
        }
      }, 30)
    }
    if (req.url.includes('/v1/chat/completions')) {
      // 带 CORS 头：浏览器直连路径可用。补 DeepSeek 形状的用量块。
      res.setHeader('Access-Control-Allow-Origin', '*')
      sendSse('deepseek')
    } else if (req.url.includes('/usage/chat/completions')) {
      // 带 CORS 头 + OpenAI 形状的用量块：供浏览器直连路径验证 usage 解析
      res.setHeader('Access-Control-Allow-Origin', '*')
      sendSse('openai')
    } else if (req.url.includes('/v1-nocors/chat/completions')) {
      // 不带 CORS 头：浏览器直连会被拦截（用于区分浏览器/IPC 路径）
      sendSse(null)
    } else if (req.url.includes('/error/chat/completions')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock 500' } }))
    } else if (req.url.includes('/auth/chat/completions')) {
      // 401 + 一个假密钥：用来验证错误详情会被脱敏，且 401 不重试
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid key sk-smoke-leak-123456' } }))
    } else if (req.url.includes('/flaky/chat/completions')) {
      // 第一次 500，第二次成功：验证「没收到正文时自动重试」
      res.setHeader('Access-Control-Allow-Origin', '*')
      flakyHits += 1
      if (flakyHits === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Retry-After': '1' })
        res.end(JSON.stringify({ error: { message: 'mock flaky 500' } }))
      } else {
        sendSse('deepseek')
      }
    } else if (req.url.includes('/truncated/chat/completions')) {
      // finish_reason=length：正文保留，但必须走截断分支而不是「完成」
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '前半段正文' } }] })}\n\n`)
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    } else if (req.url.includes('/stream-error/chat/completions')) {
      // HTTP 200 的流内错误块：不识别就会表现为「生成突然结束、没有提示」
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ error: { message: '余额不足（流内错误）' } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  }

  server.listen(SSE_MOCK_PORT, '127.0.0.1', () => {
    console.log('SSE_MOCK up on ' + SSE_MOCK_PORT)
  })
  return server
}

// ---------------------------------------------------------------------------
// IPC：LLM 流式代理
// 渲染进程（浏览器/Capacitor）会优先直连；在 Electron 中由于 CORS 限制，
// 通过 window.electronAPI.chatCompletions() 转发到这里，用主进程 net 发起请求。
// 服务端 SSE 行经 webContents.send('llm:delta', line) 增量回传，实现流式显示。
// ---------------------------------------------------------------------------
/** HTTP 状态码 → 初步错误分类；渲染层会再跑一次 classifyError 补齐文案。 */
function llmCategoryForStatus(status) {
  const n = Number(status) || 0
  if (n === 401 || n === 403) return 'auth'
  if (n === 404) return 'not-found'
  if (n === 408) return 'timeout'
  if (n === 429) return 'rate-limit'
  if (n >= 500 && n <= 599) return 'server'
  if (n >= 400 && n <= 499) return 'bad-request'
  return ''
}

ipcMain.handle('llm:chat', async (event, { requestId, url, headers, body, idleTimeoutSec } = {}) => {
  const controller = new AbortController()
  activeRequests.set(requestId, controller)

  const webContents = event.sender
  const idleSec = Math.max(0, Number(idleTimeoutSec ?? 60) || 0)
  let idleTimer = null
  let timedOut = false

  // 空闲超时：连上了但服务端不再发数据，比直接报错更难察觉。每次读到数据重置。
  // 0 表示关闭（极端情况下由渲染层的可靠封装兜底）。
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdle = () => {
    clearIdle()
    if (idleSec <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      timedOut = true
      controller.abort()
    }, idleSec * 1000)
  }

  armIdle()
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    armIdle()

    if (!res.ok) {
      const text = await res.text()
      const status = res.status
      const retryAfter = res.headers.get('retry-after') || ''
      clearIdle()
      // 错误体可能回显请求头，故只发给渲染层做脱敏与展示，绝不在这里写日志。
      webContents.send('llm:error', {
        requestId,
        message: `HTTP ${status}: ${String(text || '').slice(0, 800)}`,
        status,
        retryAfter,
        category: llmCategoryForStatus(status)
      })
      return { ok: false, status }
    }

    // 始终以 SSE 行流处理（body.stream 恒为 true）
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      armIdle()
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        webContents.send('llm:delta', { requestId, line })
      }
    }
    clearIdle()
    webContents.send('llm:done', requestId)
    return { ok: true }
  } catch (err) {
    clearIdle()
    if (err.name === 'AbortError') {
      if (timedOut) {
        webContents.send('llm:error', {
          requestId,
          message: '空闲超时：服务端长时间没有返回数据',
          category: 'timeout',
          status: 0
        })
        return { ok: false, timedOut: true }
      }
      webContents.send('llm:aborted', requestId)
      return { ok: false, aborted: true }
    }
    const status = Number(err && (err.status || err.statusCode)) || 0
    // 只记 requestId / 状态码。错误正文可能回显 Authorization 头，主进程日志
    // 不打印它 —— 「API Key 不进入任何日志」这条约束在这里落实。
    console.log('MAIN_SEND_ERR ' + requestId + ' status=' + status)
    webContents.send('llm:error', {
      requestId,
      message: String((err && err.message) || err),
      status,
      category: status ? llmCategoryForStatus(status) : 'network'
    })
    return { ok: false }
  } finally {
    clearIdle()
    activeRequests.delete(requestId)
  }
})

ipcMain.on('llm:abort', (_event, requestId) => {
  const c = activeRequests.get(requestId)
  if (c) c.abort()
})

// ---------------------------------------------------------------------------
// API Key 安全存储（Electron safeStorage）
//
// 三条硬约束：
//
// 1. **密钥只以密文落盘**，位置是 `userData/secure/api-key.bin`，不进 IndexedDB、
//    不进快照、不进日志。`safeStorage` 在 Windows 上用 DPAPI 加密，密钥绑定当前
//    系统账户。
// 2. **不可用时明确返回 unsupported**，由渲染层回退为明文存储并如实告知用户。
//    绝不「假装加密了」—— 那比明文更危险。
// 3. **本文件的任何日志都不含密钥、不含密文、不含解密错误正文**。IPC 返回的
//    message 也只是一句通用描述。
// ---------------------------------------------------------------------------
// 命名槽：每个槽一个密文文件。**未知槽一律 EINVAL**，不悄悄落到 apiKey 上——
// 那会把用户的 WebDAV 密码写进 API Key 的文件里，且双方都会以为自己是对的。
const SECRET_FILES = {
  apiKey: 'api-key.bin',
  webdavPassword: 'webdav-password.bin'
}

function secureKeyFile(slot) {
  // 冒烟测试用临时目录：测试会写入/删除假密钥，绝不能碰开发者真实账户下
  // 的那份密文（那会把用户自己的 API Key 覆盖掉）。
  const base = process.env.SMOKE_TEST
    ? path.join(os.tmpdir(), 'novel-studio-smoke-secure')
    : path.join(app.getPath('userData'), 'secure')
  return path.join(base, SECRET_FILES[slot])
}

const isSecretSlot = (slot) => Object.prototype.hasOwnProperty.call(SECRET_FILES, slot)

ipcMain.handle('secret:set', async (_event, { value, slot = 'apiKey' } = {}) => {
  if (!isSecretSlot(slot)) return { ok: false, code: 'EINVAL', message: '未知的密钥槽' }
  const key = typeof value === 'string' ? value : ''
  if (!key) return { ok: false, code: 'EINVAL', message: '密钥为空' }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, code: 'unsupported', message: '系统安全存储不可用' }
  }
  try {
    const file = secureKeyFile(slot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 })
    return { ok: true }
  } catch {
    // 不把底层错误正文带出去：它可能包含路径，也可能包含部分数据。
    return { ok: false, code: 'EWRITE', message: '安全存储写入失败' }
  }
})

/** 读取一个槽的明文。只给 `secret:get` 与 `webdav:request` 用。 */
function readSecretValue(slot) {
  if (!isSecretSlot(slot)) return { ok: false, code: 'EINVAL', message: '未知的密钥槽' }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, code: 'unsupported', message: '系统安全存储不可用' }
  }
  const file = secureKeyFile(slot)
  try {
    if (!fs.existsSync(file)) return { ok: true, value: '' }
    const buf = fs.readFileSync(file)
    return { ok: true, value: safeStorage.decryptString(buf) }
  } catch {
    return { ok: false, code: 'EDECRYPT', message: '无法解密已保存的密钥（可能换了系统账户）' }
  }
}

ipcMain.handle('secret:get', async (_event, { slot = 'apiKey' } = {}) => readSecretValue(slot))

ipcMain.handle('secret:delete', async (_event, { slot = 'apiKey' } = {}) => {
  if (!isSecretSlot(slot)) return { ok: false, code: 'EINVAL', message: '未知的密钥槽' }
  try {
    const file = secureKeyFile(slot)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return { ok: true }
  } catch {
    return { ok: false, code: 'EDELETE', message: '删除安全存储失败' }
  }
})

// ---------------------------------------------------------------------------
// WebDAV 请求代理（仅桌面端）
//
// 渲染层发起的每一个请求都从这里出去，原因有三个：
//   1. CORS：多数 WebDAV 服务器不给浏览器的预检发头，直接从渲染层发必然失败；
//   2. 凭据：Basic 认证的密码只能从 safeStorage 读，不能长期留在渲染层内存；
//   3. 边界：方法白名单、路径穿越、同源、重定向、体积上限统一在
//      `electron/webdav.js` 里把关，渲染层的校验只算提示。
//
// **不在任何日志里打印密码、Authorization 头或响应正文。** 返回给渲染层的
// 错误只有一句能照着做的话与一个错误码。
// ---------------------------------------------------------------------------
async function resolveWebdavPassword(payload) {
  // 允许一次性传入（用户刚在输入框里敲了密码、还没点保存就点了「测试连接」）。
  // 它只在这一次调用的参数里出现，不写任何地方。
  if (typeof payload?.password === 'string' && payload.password) {
    return { ok: true, password: payload.password }
  }
  const res = readSecretValue('webdavPassword')
  if (!res.ok) return { ok: false, code: 'ESECRET', message: res.message }
  return { ok: true, password: res.value }
}

ipcMain.handle('webdav:request', async (_event, payload = {}) => {
  const secret = await resolveWebdavPassword(payload)
  if (!secret.ok) return secret
  return davRequest(
    {
      baseUrl: payload.baseUrl,
      path: payload.path,
      method: payload.method,
      headers: payload.headers,
      body: payload.body,
      username: payload.username,
      password: secret.password,
      timeoutSec: payload.timeoutSec
    },
    { netFetch: net.fetch }
  )
})

ipcMain.handle('webdav:ensureDir', async (_event, payload = {}) => {
  const secret = await resolveWebdavPassword(payload)
  if (!secret.ok) return secret
  return ensureCollection(
    {
      baseUrl: payload.baseUrl,
      remoteDir: payload.remoteDir,
      username: payload.username,
      password: secret.password,
      timeoutSec: payload.timeoutSec
    },
    { netFetch: net.fetch }
  )
})

// ---------------------------------------------------------------------------
// 声明式插件（仅桌面端）
//
// 插件是 `userData/plugins/*.json` 里的**纯数据**。主进程只做三件事：
// 列目录、按上限读文件、打开目录。**不执行任何插件代码**，也不把插件目录
// 之外的任何路径交给渲染层。
//
// 冒烟测试用 `%TEMP%\novel-studio-smoke\plugins`，绝不去读开发机上真实的
// userData，否则测试结果会取决于开发者恰好装了什么插件。
// ---------------------------------------------------------------------------
const PLUGIN_MAX_FILES = 100
const PLUGIN_MAX_BYTES = 256 * 1024

function pluginsDirPath() {
  if (process.env.SMOKE_TEST) return path.join(SMOKE_DIR, 'plugins')
  return path.join(app.getPath('userData'), 'plugins')
}

ipcMain.handle('plugins:list', async () => {
  const dir = pluginsDirPath()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, code: 'EDIR', message: '无法创建插件目录', dir }
  }
  let names = []
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => String(n).toLowerCase().endsWith('.json'))
      .sort()
  } catch {
    return { ok: false, code: 'EDIR', message: '无法读取插件目录', dir }
  }
  const skipped = Math.max(0, names.length - PLUGIN_MAX_FILES)
  const files = []
  for (const name of names.slice(0, PLUGIN_MAX_FILES)) {
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue
      if (st.size > PLUGIN_MAX_BYTES) {
        files.push({ name, error: `文件超过 ${Math.round(PLUGIN_MAX_BYTES / 1024)}KB` })
        continue
      }
      const text = fs.readFileSync(full, 'utf8')
      let json
      try {
        json = JSON.parse(text)
      } catch {
        // 不把解析器的原始报错带出去：它可能包含文件片段
        files.push({ name, error: '不是有效的 JSON' })
        continue
      }
      files.push({ name, json })
    } catch {
      files.push({ name, error: '读取失败' })
    }
  }
  return { ok: true, dir, files, skipped }
})

ipcMain.handle('plugins:openFolder', async () => {
  const dir = pluginsDirPath()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) return { ok: false, code: 'EOPEN', message: '无法打开插件目录', dir }
    return { ok: true, dir }
  } catch {
    return { ok: false, code: 'EOPEN', message: '无法打开插件目录', dir }
  }
})

// ---------------------------------------------------------------------------
// 本地文件写入：安全边界
//
// 渲染层传来的文件名与子目录一律视为不可信输入——导出请求可能来自即发即忘、
// 无法向上报错的路径，渲染层的净化结果不能被当成已校验。这里有一份与
// src/services/export.js 同名同算法的独立实现，是真正的信任边界。
//
// 两条策略不对称是有意的，不要「统一」它们：
//   · 子目录越界 → 拒绝（能明确报错，且越界没有任何正当用途）
//   · 文件名越界 → 改写（把 `../../evil.txt` 变成留在目录内的普通名字，
//                        用户的导出仍然成功，不会因为书名里带个斜杠就整单失败）
// ---------------------------------------------------------------------------
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** 去掉控制字符（含 DEL）。按码点过滤，避免把裸控制字节写进源码 */
function stripControlChars(s) {
  let out = ''
  for (const ch of s) {
    const n = ch.codePointAt(0)
    if (n < 32 || n === 127) continue
    out += ch
  }
  return out
}

function safeFileName(name, fallback = '小说') {
  let s = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_')
  s = stripControlChars(s)
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  if (!s) return fallback
  if (WINDOWS_RESERVED.test(s)) s = '_' + s
  if (s.length > 80) s = s.slice(0, 80).trim()
  return s || fallback
}

/** 逐段校验相对子目录；任一段非法即整体拒绝（返回 null） */
function safeSubDirSegments(subDir) {
  if (!subDir) return []
  const parts = String(subDir).split(/[\\/]+/).filter(Boolean)
  const out = []
  for (const p of parts) {
    if (p === '.' || p === '..') return null
    const clean = safeFileName(p, '')
    if (!clean) return null
    out.push(clean)
  }
  return out
}

/**
 * 解析并校验落盘目录。
 * 最后一步的包含性断言与逐段校验是冗余的，但它是我们真正要守的不变量——
 * 冗余在这里是特性，不是重复。
 * @returns {{ok:true, root:string, targetDir:string, fileName:string} | {ok:false, code:string, message:string}}
 */
function resolveTarget(dir, subDir, fileName) {
  if (typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, code: 'EINVALID_DIR', message: '保存地址为空' }
  }
  if (!path.isAbsolute(dir)) {
    return { ok: false, code: 'EINVALID_DIR', message: '保存地址必须是绝对路径' }
  }
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    return { ok: false, code: 'ENOENT', message: `保存地址不存在：${dir}` }
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'EINVALID_DIR', message: '保存地址不是文件夹' }
  }
  const segments = safeSubDirSegments(subDir)
  if (segments === null) {
    return { ok: false, code: 'EINVALID_SUBDIR', message: '子目录名非法' }
  }
  const root = path.resolve(dir)
  const targetDir = path.resolve(root, ...segments)
  if (targetDir !== root && !targetDir.startsWith(root + path.sep)) {
    return { ok: false, code: 'EINVALID_SUBDIR', message: '子目录越界' }
  }
  return { ok: true, root, targetDir, fileName: safeFileName(fileName) }
}

/** 同名冲突时依次尝试 `a (1).txt`、`a (2).txt`…；100 次仍冲突则回落时间戳 */
function resolveCollision(targetDir, fileName) {
  const ext = path.extname(fileName)
  const base = fileName.slice(0, fileName.length - ext.length)
  let candidate = fileName
  for (let i = 1; i <= 100; i++) {
    if (!fs.existsSync(path.join(targetDir, candidate))) return candidate
    candidate = `${base} (${i})${ext}`
  }
  return `${base} (${Date.now()})${ext}`
}

function mapFsError(err) {
  const code = (err && err.code) || 'EUNKNOWN'
  const messages = {
    ENOENT: '保存地址不存在',
    EACCES: '没有写入权限',
    EPERM: '系统拒绝了写入操作',
    EROFS: '目标磁盘为只读',
    ENOSPC: '磁盘空间不足'
  }
  return { ok: false, code, message: messages[code] || String((err && err.message) || err) }
}

// ---------------------------------------------------------------------------
// IPC：导出文件（弹保存框）
// 只做最小扩展以保持返回契约不变（{canceled} 是 UI 结果，不是 I/O 结果，
// 因此不并入 writeToDir 那套 {ok,filePath,bytes,code}）。
// ---------------------------------------------------------------------------
function buildFilters(ext) {
  const txt = { name: '文本文件', extensions: ['txt'] }
  const md = { name: 'Markdown', extensions: ['md'] }
  const all = { name: '所有文件', extensions: ['*'] }
  // 让当前选择的格式排在最前，避免无论选什么都默认存成 .txt
  return ext === 'md' ? [md, txt, all] : [txt, md, all]
}

ipcMain.handle('export:saveFile', async (_event, { defaultName, content, ext, defaultDir } = {}) => {
  const name = safeFileName(defaultName)
  // defaultPath 支持完整路径，于是「保存框也记住上次目录」是免费的
  const defaultPath =
    typeof defaultDir === 'string' && defaultDir && path.isAbsolute(defaultDir)
      ? path.join(defaultDir, name)
      : name
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出小说',
    defaultPath,
    filters: buildFilters(ext)
  })
  if (canceled || !filePath) return { canceled: true }
  fs.writeFileSync(filePath, typeof content === 'string' ? content : String(content ?? ''), 'utf8')
  return { canceled: false, filePath }
})

// ---------------------------------------------------------------------------
// IPC：目录选择 / 直写目录 / 列目录 / 删文件 / 打开文件夹
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:chooseDirectory', async (_event, { defaultPath } = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择小说保存地址',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths.length) return { canceled: true }
  return { canceled: false, dir: res.filePaths[0] }
})

ipcMain.handle('export:writeToDir', async (_event, { dir, subDir, fileName, content } = {}) => {
  const t = resolveTarget(dir, subDir, fileName)
  if (!t.ok) return t
  try {
    fs.mkdirSync(t.targetDir, { recursive: true })
    const finalName = resolveCollision(t.targetDir, t.fileName)
    const filePath = path.join(t.targetDir, finalName)
    const data = typeof content === 'string' ? content : String(content ?? '')
    fs.writeFileSync(filePath, data, 'utf8')
    // 回传字节数：让渲染层/冒烟测试能证明载荷完整穿过了 IPC，而不是只看到「成功」
    return { ok: true, filePath, bytes: Buffer.byteLength(data, 'utf8') }
  } catch (err) {
    return mapFsError(err)
  }
})

ipcMain.handle('fs:listFiles', async (_event, { dir, subDir } = {}) => {
  const t = resolveTarget(dir, subDir, 'x')
  if (!t.ok) return t
  try {
    const files = fs
      .readdirSync(t.targetDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
    return { ok: true, files }
  } catch (err) {
    // 目录还不存在等价于「没有文件」，不必当成错误
    if (err && err.code === 'ENOENT') return { ok: true, files: [] }
    return mapFsError(err)
  }
})

ipcMain.handle('fs:deleteFiles', async (_event, { dir, subDir, fileNames } = {}) => {
  const t = resolveTarget(dir, subDir, 'x')
  if (!t.ok) return t
  const list = Array.isArray(fileNames) ? fileNames : []
  let deleted = 0
  for (const name of list) {
    const safe = safeFileName(name, '')
    if (!safe) continue
    const full = path.resolve(t.targetDir, safe)
    // 纵深防御：safeFileName 已消除分隔符，这里再确认一次没有越出目标目录
    if (!full.startsWith(t.targetDir + path.sep)) continue
    try {
      fs.unlinkSync(full)
      deleted += 1
    } catch {
      // 单个文件删不掉（被占用等）不应影响其余
    }
  }
  return { ok: true, deleted }
})

ipcMain.handle('shell:openFolder', async (_event, { dir, filePath } = {}) => {
  if (typeof filePath === 'string' && filePath) {
    shell.showItemInFolder(filePath)
    return { ok: true }
  }
  if (typeof dir === 'string' && dir) {
    const err = await shell.openPath(dir)
    return err ? { ok: false, message: err } : { ok: true }
  }
  return { ok: false, message: '缺少路径' }
})

// ---------------------------------------------------------------------------
// 局域网同步：电脑侧是一个只认两条路径的 HTTP 服务器
//
// 手机没有服务端，所以只能由手机发起：一次 `POST /sync` 带上自己的全量快照，
// 电脑合并后把**合并结果**作为响应体回给它，两边就此收敛。刻意做成单次往返
// 而不是「先拉后推」——两个请求之间任一侧再写入都会丢更新，一次往返把窗口
// 压到一个请求之内。
//
// 三条贯穿整个设计的边界：
//   1. **默认不监听**。只有用户在设置里开了服务才有端口，关掉即无监听。
//   2. **配对码只在主进程内存里**，每次启动服务重新生成。不落盘、不进设置、
//      不进日志——它是一次会话的凭据，不是一项配置。
//   3. **服务器不认识文件系统**。只认 `/hello` 与 `/sync` 两条**精确**路径，
//      不接受任何路径参数，其余一律 404。数据在渲染进程的 IndexedDB 里，
//      主进程读不到，所以请求转交渲染层处理再取回结果
//      （`sync:incoming` 推下去、`sync:respond` 收回来，方向与 llm:* 同构）。
// ---------------------------------------------------------------------------

const SYNC_DEFAULT_PORT = 8787
/** 端口被占时向后试的次数。报「端口被占」不如直接换一个，用户不必自己去关程序。 */
const SYNC_PORT_TRIES = 10
const SYNC_MAX_BODY = 64 * 1024 * 1024
/** 渲染层应答的超时。它只做「合并 + 回写」，正常几十毫秒；20 秒是给慢磁盘留的余量。 */
const SYNC_RESPOND_TIMEOUT = 20000
/** 同一来源连续错这么多次就冷却一段时间。见 bumpFail 的注释。 */
const SYNC_MAX_FAILS = 10
const SYNC_LOCK_MS = 60000

let syncServer = null
let syncPort = 0
let syncCode = ''
/** 渲染层报上来的版本信息（SNAPSHOT_VERSION / SCHEMA_VERSION），只用于 /hello */
let syncHello = null
let syncLast = null
let syncSeq = 0
/** requestId -> { resolve, timer }：挂在飞行中的 HTTP 请求 */
const syncPending = new Map()
/** 来源 IP -> { count, until }：配对码连错计数与冷却截止时刻 */
const syncFails = new Map()

function newSyncCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

/**
 * 本机可用的局域网地址，全部列出。
 *
 * **不猜**哪个是对的：Windows 上 VPN / WSL / VirtualBox 的虚拟网卡很常见，
 * 猜错的代价是用户拿着一个连不上的地址反复重试，而列出来的代价只是多看一眼。
 * 只把私有网段排前面（手机在同一局域网里，能连上的一定是那几张网卡）。
 */
function syncAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      // Node 18 起 family 是 'IPv4' 字符串，更早是数字 4 —— 两种都认
      if (String(ni.family) !== 'IPv4' && ni.family !== 4) continue
      if (ni.internal || !ni.address) continue
      out.push({ name, address: ni.address, url: `http://${ni.address}:${syncPort}` })
    }
  }
  const rank = (a) =>
    a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3
  out.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address))
  return out
}

/**
 * 服务状态。`sync:start` 与 `sync:status` 共用这一份——两者返回同一件事：
 * 「现在服务在不在、在哪个端口、码是什么、地址有哪些」。start 在已运行时
 * 直接回它，于是重复点「开启」是幂等的，而不会换掉一个用户已经抄进手机的码。
 */
function syncStatusPayload() {
  return {
    ok: true,
    running: !!syncServer,
    port: syncPort,
    code: syncCode,
    addresses: syncAddresses(),
    last: syncLast
  }
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onOk)
      reject(err)
    }
    const onOk = () => {
      server.removeListener('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onOk)
    // 绑 0.0.0.0 而不是 127.0.0.1：手机要从局域网连进来
    server.listen(port, '0.0.0.0')
  })
}

async function startSyncServer({ port, hello } = {}) {
  if (syncServer) return syncStatusPayload()
  // 版本号由渲染层报上来，而不是在这里写死：SNAPSHOT_VERSION / SCHEMA_VERSION 的
  // 唯一事实来源在 src/，主进程复制一份迟早会与它分叉。
  syncHello = hello && typeof hello === 'object' ? hello : null
  syncCode = newSyncCode()
  syncFails.clear()
  syncLast = null

  const want =
    Number.isInteger(port) && port >= 0 && port <= 65535 ? port : SYNC_DEFAULT_PORT
  let lastErr = null
  for (let i = 0; i <= SYNC_PORT_TRIES; i++) {
    // 每次尝试都用新的 server：listen 失败后的实例不该被复用
    const server = http.createServer(handleSyncRequest)
    try {
      const got = await listenOn(server, want === 0 ? 0 : want + i)
      syncServer = server
      syncPort = got
      return syncStatusPayload()
    } catch (err) {
      lastErr = err
      try {
        server.close()
      } catch {
        // 关不掉也没有句柄泄漏可言：这个实例从未监听成功
      }
      // 只有「端口被占」值得向后试；EACCES 之类换端口也好不了
      if (err.code !== 'EADDRINUSE') break
    }
  }
  return {
    ok: false,
    code: (lastErr && lastErr.code) || 'EUNKNOWN',
    message:
      want === 0
        ? `无法监听端口：${(lastErr && lastErr.message) || '未知错误'}`
        : `端口 ${want}~${want + SYNC_PORT_TRIES} 都被占用，请在设置里换一个`
  }
}

function stopSyncServer() {
  // 挂在飞行中的请求先放掉，否则它们要等到超时才回 503，
  // 而那时监听已经关了，客户端只会看到连接被重置
  for (const [, p] of syncPending) {
    clearTimeout(p.timer)
    p.resolve(null)
  }
  syncPending.clear()
  syncFails.clear()
  const server = syncServer
  syncServer = null
  syncPort = 0
  syncCode = ''
  syncHello = null
  if (!server) return { ok: true }
  return new Promise((resolve) => {
    // keep-alive 连接会让 close() 一直等着，先把它们断掉；
    // 不然「停止同步」之后端口还占着，再启动会一次就撞上 EADDRINUSE
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close(() => resolve({ ok: true }))
    // 监听句柄不参与 Electron 的进程存活判定，unref 只是不让它成为退出障碍
    server.unref()
  })
}

function syncCors(res) {
  // Android WebView 的 origin 是 https://localhost，与 http://192.168.x.x 跨源，
  // 而且请求自带 X-Pair-Code 这个非简单头 —— 预检是**必然**发生的，不是可选项。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pair-Code')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Max-Age', '600')
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * 体太大：先回 413 再断开。
 *
 * 立刻 `req.destroy()` 会把响应连同连接一起掐掉，客户端只能看到「连接被重置」，
 * 而它此刻需要的是一个明确的「太大了」。所以顺序是：停止接收（pause 让 TCP
 * 背压生效，那 64MB 的后续不必再读进内存）→ 回 413 → 响应写完再 destroy。
 */
function rejectTooLarge(req, res) {
  req.pause()
  sendJson(res, 413, { error: 'too-large', message: '同步数据超过 64 MB，无法接收' })
  res.on('finish', () => req.destroy())
}

function codeMatches(input) {
  const given = Buffer.from(String(input == null ? '' : input), 'utf8')
  const want = Buffer.from(syncCode, 'utf8')
  if (!syncCode || given.length !== want.length) return false
  return crypto.timingSafeEqual(given, want)
}

/**
 * 记一次配对码错误。
 *
 * 6 位码只有一百万种可能，而 `Access-Control-Allow-Origin: *` 意味着**用户访问的
 * 任意网页**都能对这个端口发请求并读到响应（区分 401 与 200 就够了）。所以
 * 「猜不出来」不能只靠位数，冷却是一条必要的防线：连错 10 次锁一分钟，把
 * 穷举的成本抬到没意义。锁上之后正确码也一并拒绝——否则它就不是锁。
 * 用户自己的逃生口是「换一个配对码」，那里会清掉计数。
 */
function bumpFail(addr) {
  const rec = syncFails.get(addr) || { count: 0, until: 0 }
  rec.count += 1
  if (rec.count >= SYNC_MAX_FAILS) {
    rec.until = Date.now() + SYNC_LOCK_MS
    rec.count = 0
  }
  syncFails.set(addr, rec)
}

function handleSyncRequest(req, res) {
  syncCors(res)
  if (req.method === 'OPTIONS') {
    // 预检：不碰数据、不查码，直接放行。它本来就只是问「我能不能发那个头」。
    res.writeHead(204)
    res.end()
    return
  }

  // 精确比对 pathname，而不是 req.url.includes(...) 那种子串匹配：
  // `/hello/../sync` 之类的路径不该命中任何一条路由。服务器没有路径参数，
  // 也就不认识任何文件系统。
  let pathname = ''
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname
  } catch {
    pathname = ''
  }

  // /hello 无鉴权、不含任何数据，专供手机端「测试连接」区分
  // 「地址不通」与「码不对」两种失败。它能给的只有版本号。
  if (pathname === '/hello' && req.method === 'GET') {
    sendJson(res, 200, {
      app: 'Novel Studio',
      version: app.getVersion(),
      protocol: 'novel-studio-sync',
      ...(syncHello || {})
    })
    return
  }

  if (pathname === '/sync' && req.method === 'POST') {
    handleSyncPost(req, res)
    return
  }

  sendJson(res, 404, { error: 'not-found', message: '只支持 GET /hello 与 POST /sync' })
}

function handleSyncPost(req, res) {
  const addr = (req.socket && req.socket.remoteAddress) || 'unknown'

  const rec = syncFails.get(addr)
  if (rec && rec.until > Date.now()) {
    const wait = Math.ceil((rec.until - Date.now()) / 1000)
    sendJson(res, 401, {
      error: 'locked',
      message: `配对码错误次数过多，请 ${wait} 秒后重试，或在电脑上点「换一个配对码」`
    })
    return
  }

  if (!codeMatches(req.headers['x-pair-code'])) {
    bumpFail(addr)
    sendJson(res, 401, { error: 'bad-code', message: '配对码不正确' })
    return
  }
  syncFails.delete(addr)

  // 声明了长度就先看一眼，能省掉把 64MB 读进来再发现它太大的整段开销
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > SYNC_MAX_BODY) {
    rejectTooLarge(req, res)
    return
  }

  const chunks = []
  let size = 0
  let tooLarge = false
  let done = false
  req.on('data', (c) => {
    if (tooLarge) return
    chunks.push(c)
    size += c.length
    if (size > SYNC_MAX_BODY) {
      // chunked 传输没有 content-length，只能边读边数
      tooLarge = true
      rejectTooLarge(req, res)
    }
  })
  req.on('error', () => {
    done = true
  })
  req.on('end', async () => {
    if (tooLarge || done) return
    try {
      await finishSyncPost(req, res, chunks, addr)
    } catch (err) {
      // 这是 http 服务器的回调：在这里抛出去就是一次未捕获异常，会带崩主进程。
      // 手机那头只会看到连接断开，而没有任何东西指向这里。
      console.log('SYNC_POST_ERR ' + String((err && err.message) || err))
      try {
        sendJson(res, 500, { error: 'internal', message: '电脑端处理失败' })
      } catch {
        // 响应已经开始写了就只能放弃，至少不能让主进程倒下
      }
    }
  })
}

/** 体收全之后的处理：解析 → 转交渲染层 → 把结果写成 HTTP 响应 */
async function finishSyncPost(req, res, chunks, addr) {
  let remote
  try {
    remote = JSON.parse(chunks.length ? Buffer.concat(chunks).toString('utf8') : '{}')
  } catch {
    sendJson(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' })
    return
  }
  // 形状检查只做到「像不像一个快照」这一层：格式版本与字段的权威校验在
  // 渲染层的 mergeSnapshot / parseSnapshotJson 里，主进程不复制那份知识。
  if (!remote || typeof remote !== 'object' || !Array.isArray(remote.books)) {
    sendJson(res, 400, { error: 'bad-snapshot', message: '请求体不是 Novel Studio 快照' })
    return
  }

  const requestId = `sync-${++syncSeq}`
  const answer = await askRenderer(requestId, remote, addr)
  if (!answer) {
    sendJson(res, 503, { error: 'no-renderer', message: '电脑端界面未响应，请稍后重试' })
    return
  }
  if (answer.busy) {
    sendJson(res, 409, { error: 'busy', message: '电脑正在生成正文，请等这一章写完再同步' })
    return
  }
  if (!answer.ok) {
    sendJson(res, 500, { error: 'apply-failed', message: answer.message || '合并失败' })
    return
  }
  // 只有真正落库成功才记「上次同步」——失败也记的话，界面会拿着一次失败的
  // 尝试当成「同步过了」展示给用户
  syncLast = { at: Date.now(), addr, stats: answer.stats || null }
  // 回给手机的是**合并结果**（applySnapshot 的 after），不是「成功」两个字：
  // 手机拿到它就地应用，两边就此收敛，无需第二次往返
  sendJson(res, 200, answer.snapshot || {})
}

/** 把请求转交渲染层。渲染层读得到 IndexedDB，主进程读不到，这是唯一的路。 */
function askRenderer(requestId, remote, addr) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      syncPending.delete(requestId)
      resolve(null)
    }, SYNC_RESPOND_TIMEOUT)
    syncPending.set(requestId, { resolve, timer })
    mainWindow.webContents.send('sync:incoming', { requestId, remote, remoteAddr: addr })
  })
}

ipcMain.handle('sync:start', async (_event, payload = {}) => startSyncServer(payload))

ipcMain.handle('sync:stop', async () => stopSyncServer())

ipcMain.handle('sync:status', async () => syncStatusPayload())

ipcMain.handle('sync:rotateCode', async () => {
  if (!syncServer) return { ok: false, code: 'ENOTRUNNING', message: '同步服务未开启' }
  syncCode = newSyncCode()
  // 换码同时解锁：这是被冷却挡住的用户唯一的自助出口
  syncFails.clear()
  return { ok: true, code: syncCode }
})

ipcMain.handle(
  'sync:respond',
  (_event, { requestId, ok, snapshot, stats, busy, message } = {}) => {
    const p = syncPending.get(requestId)
    // 已经超时了：这一份答案来晚了，HTTP 那头早已收到 503。
    // 返回 ESTALE 而不是静默丢弃，是为了让渲染层知道它的劳动没被采纳。
    if (!p) return { ok: false, code: 'ESTALE' }
    syncPending.delete(requestId)
    clearTimeout(p.timer)
    p.resolve({ ok: ok !== false, snapshot, stats, busy: !!busy, message })
    return { ok: true }
  }
)

// 渲染层冲刷完毕，放行真正的关闭
ipcMain.on('app:close-ready', () => {
  finishClose()
})

// 长驻的监听句柄必须显式关闭：当前退出路径只有 window-all-closed，
// 不加这一条，服务开着时退出会留下一个没人在管的端口。
//
// 同时把「退出」也接进保存握手：Alt+F4、系统关机只触发 before-quit，
// 不经过窗口的 close 事件。第一次先拦下来，冲刷完再由 finishClose 放行。
app.on('before-quit', (e) => {
  stopSyncServer()
  if (!allowClose) {
    e.preventDefault()
    beginGracefulClose()
  }
})
