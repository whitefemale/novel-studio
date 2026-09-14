const { app, BrowserWindow, ipcMain, net, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

let mainWindow = null
// 活跃请求表：requestId -> AbortController
const activeRequests = new Map()

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

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 冒烟测试模式：SMOKE_TEST=1 npx electron . → 加载完成后打印挂载状态并退出
  if (process.env.SMOKE_TEST) {
    startSseMockServer()
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
      } catch (err) {
        console.error('SMOKE_DIR_ERROR', err && err.message)
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
      } catch {
        // 清理失败不影响测试结论
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
function startSseMockServer() {
  const server = http.createServer((req, res) => {
    console.log('SSE_MOCK_REQ ' + req.method + ' ' + req.url)
    const sendSse = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })
      const deltas = ['你好', '，世', '界！']
      let i = 0
      const timer = setInterval(() => {
        if (i < deltas.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i++] } }] })}\n\n`)
        } else {
          res.write('data: [DONE]\n\n')
          clearInterval(timer)
          res.end()
        }
      }, 30)
    }
    if (req.url.includes('/v1/chat/completions')) {
      // 带 CORS 头：浏览器直连路径可用
      res.setHeader('Access-Control-Allow-Origin', '*')
      sendSse()
    } else if (req.url.includes('/v1-nocors/chat/completions')) {
      // 不带 CORS 头：浏览器直连会被拦截（用于区分浏览器/IPC 路径）
      sendSse()
    } else if (req.url.includes('/error/chat/completions')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock 500' } }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
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
ipcMain.handle('llm:chat', async (event, { requestId, url, headers, body }) => {
  const controller = new AbortController()
  activeRequests.set(requestId, controller)

  const webContents = event.sender
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`)
    }

    // 始终以 SSE 行流处理（body.stream 恒为 true）
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        webContents.send('llm:delta', { requestId, line })
      }
    }
    webContents.send('llm:done', requestId)
    return { ok: true }
  } catch (err) {
    if (err.name === 'AbortError') {
      webContents.send('llm:aborted', requestId)
      return { ok: false, aborted: true }
    }
    const msg = String((err && err.message) || err)
    console.log('MAIN_SEND_ERR ' + requestId + ' ' + msg)
    webContents.send('llm:error', { requestId, message: msg })
    return { ok: false }
  } finally {
    activeRequests.delete(requestId)
  }
})

ipcMain.on('llm:abort', (_event, requestId) => {
  const c = activeRequests.get(requestId)
  if (c) c.abort()
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
