'use strict'

/**
 * 用 Electron 真实渲染生成 README 截图。
 *
 * 为什么不用浏览器自动化：这个项目的界面依赖 `window.electronAPI`
 * （平台判定、保存地址、同步面板），而且截图必须证明「桌面版长这样」。
 * 只有真的跑起 Electron 才算数。
 *
 * 安全边界（三条，缺一条就不运行）：
 *   1. **userData 必须指向临时目录**，且目录名以 `novel-studio-shots-` 开头。
 *      在 app.whenReady 之前设置，晚了就会碰到真实数据库。
 *   2. **演示数据里没有 API Key**（`apiKey` 固定为空串），截图前再断言一次。
 *   3. 页面文本里不得出现 `sk-` 形态的字符串。
 *
 * 用法：`npm run screenshots`（会先 build）。
 * 产物：docs/*.png，固定 1440×900。脚本结束删除临时目录。
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeFixtureData } = require('./screenshot-fixtures.cjs')

const ROOT = path.join(__dirname, '..')
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html')
const DOCS_DIR = path.join(ROOT, 'docs')
const WIDTH = 1440
const HEIGHT = 900
const SHOTS = [
  ['shelf.png', '书库'],
  ['editor.png', '编辑器'],
  ['story-console.png', '控制台 · 剧情'],
  ['memory.png', '控制台 · 人物'],
  ['timeline.png', '控制台 · 时间线'],
  ['foreshadowing.png', '控制台 · 伏笔'],
  ['ai-workflow.png', '控制台 · 上下文预览']
]

if (!fs.existsSync(DIST_INDEX)) {
  console.error('[shots] 找不到 dist/index.html。请先运行 npm run build。')
  process.exit(1)
}
fs.mkdirSync(DOCS_DIR, { recursive: true })

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-studio-shots-'))
const tempName = path.basename(tempDir)
if (!tempName.startsWith('novel-studio-shots-')) {
  console.error('[shots] 临时目录名不符合预期，拒绝继续：', tempName)
  process.exit(1)
}

// **必须在 whenReady 之前**：默认的 userData 是真实用户数据目录，
// 一旦应用先启动一次，就会在真实库里创建/读取数据。
app.setPath('userData', tempDir)
app.setPath('sessionData', tempDir)
try {
  app.setPath('logs', path.join(tempDir, 'logs'))
} catch {
  // 旧版本没有 logs 这个路径名；不影响截图
}
app.disableHardwareAcceleration()

/**
 * 这个脚本自己创建窗口，**没有加载 `electron/main.js`**，所以 preload 里
 * 声明的通道在主进程一侧全部没有处理函数。渲染层启动时会读安全存储、
 * 读插件目录，没有 handler 就会往控制台喷一堆 "No handler registered"。
 *
 * 这里只注册「不产生副作用」的空桩：不读文件、不联网、不碰真实用户数据。
 * 任何被调用到会真的改系统状态的通道（导出、打开文件夹、同步）都回一个
 * 明确的错误，宁可截图失败也不让脚本偷偷做出动作。
 */
function registerStubIpc() {
  const noop = () => ({ ok: false, code: 'unsupported', message: '截图环境不提供此能力' })
  ipcMain.handle('secret:get', noop)
  ipcMain.handle('secret:set', () => ({ ok: true }))
  ipcMain.handle('secret:delete', () => ({ ok: true }))
  ipcMain.handle('plugins:list', () => ({ ok: true, dir: '', files: [] }))
  ipcMain.handle('plugins:openFolder', noop)
  ipcMain.handle('sync:status', () => ({ running: false, port: 0 }))
  ipcMain.handle('sync:start', noop)
  ipcMain.handle('sync:stop', () => ({ ok: true }))
  ipcMain.handle('sync:rotateCode', noop)
  ipcMain.handle('sync:respond', () => ({ ok: true }))
  ipcMain.handle('webdav:request', noop)
  ipcMain.handle('webdav:ensureDir', noop)
  ipcMain.handle('fs:listFiles', () => ({ ok: true, files: [] }))
  ipcMain.handle('fs:deleteFiles', () => ({ ok: true, deleted: 0 }))
  ipcMain.handle('llm:chat', noop)
  ipcMain.handle('export:writeToDir', noop)
  ipcMain.handle('export:saveFile', () => ({ canceled: true }))
  ipcMain.handle('dialog:chooseDirectory', () => ({ canceled: true }))
  ipcMain.handle('shell:openFolder', noop)
  ipcMain.handle('app:close-ready', () => ({ ok: true }))
}

let win = null
const results = []

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function evalJs(code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(expr, label, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const ok = await evalJs(`Boolean(${expr})`).catch(() => false)
    if (ok) return true
    await delay(120)
  }
  throw new Error(`等待超时：${label} (${expr})`)
}

async function injectFixtures() {
  const fx = makeFixtureData()
  const payload = JSON.stringify(fx)
  const src = `(async () => {
    const fx = ${payload};
    const db = window.__ns.db;
    const s = window.__ns.useSettings();
    await s.load();
    await db.saveBooks(fx.books);
    for (const book of fx.books) {
      await db.saveChapters(book.id, fx.chapters[book.id] || []);
      await db.saveOutlines(book.id, fx.outlines.filter((o) => o.bookId === book.id));
      const cols = fx.collections[book.id] || {};
      for (const [name, rows] of Object.entries(cols)) {
        if (db.coll[name]) await db.coll[name].saveAll(book.id, rows);
      }
    }
    // 演示设置：没有 API Key，也不启用任何同步/插件副作用
    s.settings.apiKey = '';
    s.settings.providerId = 'deepseek';
    s.settings.baseUrl = 'https://api.deepseek.com';
    s.settings.model = 'deepseek-chat';
    s.settings.deviceName = '演示设备';
    s.settings.showUsage = true;
    // 演示用的预算：默认 6000 减去输出预留后只剩一千多 token，
    // 上下文预览会一大片「已丢弃」，看起来像软件坏了。给一个真实可用的配置。
    s.settings.contextBudget = 12000;
    s.settings.maxTokens = 3000;
    s.settings.contextChapters = 3;
    s.settings.rag = { ...s.settings.rag, enabled: true };
    s.settings.plugins = { ...s.settings.plugins, enabled: true, disabledIds: [] };
    s.settings.webdav = { ...s.settings.webdav, enabled: false };
    s.settings.syncAutoStart = false;
    await s.persist();
    return {
      books: fx.books.length,
      chapters: Object.values(fx.chapters).reduce((a, c) => a + c.length, 0),
      apiKey: s.settings.apiKey
    };
  })()`
  const res = await evalJs(src)
  if (res.apiKey !== '') throw new Error('演示数据写入了非空 API Key')
  return res
}

async function assertNoSecrets(stage) {
  const info = await evalJs(`(() => {
    const s = window.__ns.useSettings().settings;
    const text = document.body.innerText || '';
    return {
      apiKey: s.apiKey || '',
      webdavPasswordSet: !!s.webdavPasswordSet,
      hasSkText: /sk-[A-Za-z0-9_-]{8,}/.test(text),
      hasPasswordText: /password\\s*[:=]\\s*\\S+/i.test(text)
    };
  })()`)
  if (info.apiKey) throw new Error(`[${stage}] 截图环境里出现了 API Key`)
  if (info.webdavPasswordSet) throw new Error(`[${stage}] 截图环境里出现了 WebDAV 密码`)
  if (info.hasSkText) throw new Error(`[${stage}] 页面文本里出现了 sk- 形态的字符串`)
  return info
}

/**
 * `capturePage()` 在窗口尚未完成首帧绘制 / 被完全遮挡时会返回 0×0 的空图。
 * 这不是「页面坏了」，所以重试几次；一直拿不到才报错并带上诊断信息。
 */
async function grabPage() {
  for (let i = 0; i < 12; i++) {
    const image = await win.webContents.capturePage()
    const size = image.getSize()
    if (size.width > 0 && size.height > 0) return image
    win.webContents.invalidate()
    win.moveTop()
    await delay(250)
  }
  const [w, h] = win.getContentSize()
  throw new Error(
    `capturePage 连续返回 0×0（visible=${win.isVisible()} content=${w}×${h}）`
  )
}

async function shot(name) {
  await delay(350)
  const image = await grabPage()
  const size = image.getSize()
  if (size.width < 1000 || size.height < 600) {
    throw new Error(`截图尺寸异常：${size.width}×${size.height}`)
  }
  // 显示器缩放（125% / 150%）会让 capturePage 返回更大的位图；
  // 统一压回 1440×900，README 里的排版才不会忽大忽小。
  const finalImage =
    size.width === WIDTH && size.height === HEIGHT
      ? image
      : image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' })
  const png = finalImage.toPNG()
  if (png.length < 20 * 1024) {
    throw new Error(`截图 ${name} 只有 ${png.length} 字节，界面可能没渲染出来`)
  }
  fs.writeFileSync(path.join(DOCS_DIR, name), png)
  results.push({
    name,
    bytes: png.length,
    width: finalImage.getSize().width,
    height: finalImage.getSize().height
  })
  console.log(`[shots] ${name}  ${finalImage.getSize().width}×${finalImage.getSize().height}  ${(png.length / 1024).toFixed(1)}KB`)
}

async function clickByText(selector, text) {
  // 控制台标签的文字后面还跟着徽标数字（「人物4」），所以用前缀匹配。
  const ok = await evalJs(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => (e.textContent || '').trim().startsWith(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`)
  if (!ok) throw new Error(`找不到可点击元素：${selector} 「${text}」`)
  await delay(300)
}

async function run() {
  registerStubIpc()
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: true,
    backgroundColor: '#ffffff',
    title: 'Novel Studio · 截图',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  win.setMenuBarVisibility(false)

  await win.loadFile(DIST_INDEX)
  // 后台窗口可能被节流、甚至不绘制首帧，capturePage 就会返回 0×0。
  win.webContents.setBackgroundThrottling(false)
  win.show()
  win.focus()
  await waitFor('window.__ns && document.querySelector(".shelf")', '应用挂载')

  const injected = await injectFixtures()
  console.log('[shots] 演示数据：', injected)

  // 重载让 store 从刚写好的临时库重新读取
  win.webContents.reload()
  await waitFor('window.__ns && document.querySelector(".shelf .book-card")', '书库渲染')

  await assertNoSecrets('书库')
  await shot('shelf.png')

  // 打开第一本书（按 updatedAt 排序，《雾港灯书》在最前）
  await evalJs('document.querySelector(".shelf .book-card").click(); true')
  await waitFor('document.querySelector(".writing .editor") && document.querySelector(".ai-panel")', '写作视图')
  await delay(500)
  await assertNoSecrets('编辑器')
  await shot('editor.png')

  await clickByText('.topbar .btn', '控制台')
  await waitFor('document.querySelector(".modal.console")', '控制台弹窗')
  // 控制台打开时会异步载入集合与生成记录
  await delay(700)
  await assertNoSecrets('控制台')
  await shot('story-console.png')

  await clickByText('.modal.console .ctab', '人物')
  await shot('memory.png')

  await clickByText('.modal.console .ctab', '时间线')
  await shot('timeline.png')

  await clickByText('.modal.console .ctab', '伏笔')
  await shot('foreshadowing.png')

  await clickByText('.modal.console .ctab', '上下文与迁移')
  await delay(300)
  await shot('ai-workflow.png')

  const expected = SHOTS.map(([name]) => name)
  const produced = results.map((r) => r.name)
  if (expected.some((n) => !produced.includes(n))) {
    throw new Error(`缺少截图：${expected.filter((n) => !produced.includes(n)).join('、')}`)
  }

  console.log('SHOTS_DETAIL ' + JSON.stringify({ ok: true, dir: DOCS_DIR, files: results }))
}

async function cleanupTemp() {
  // sessionData 里的缓存文件在窗口销毁后还会被 Electron 短暂持有
  // （Windows 上是 EPERM），所以重试几次再放弃。删不掉只是留个临时目录，
  // 不该让一次成功的截图被判成失败。
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === 4) {
        console.error(`[shots] 临时目录清理失败（可手动删除）：${tempDir}`)
        console.error('         ', err && err.message)
        return
      }
      await delay(300)
    }
  }
}

app.whenReady().then(async () => {
  let code = 0
  try {
    await run()
  } catch (err) {
    console.error('SHOTS_ERROR', (err && err.stack) || err)
    code = 1
  }
  // 先清理再退出：app.exit() 会立刻终止进程，放在它后面的 finally 不保证执行。
  try {
    if (win && !win.isDestroyed()) win.destroy()
  } catch {
    // 退出路径上不再抛
  }
  await cleanupTemp()
  app.exit(code)
})
