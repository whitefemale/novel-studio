import { reactive } from 'vue'
import * as db from './storage'
import { isDesktop } from './platform'
import {
  collectSnapshot,
  applySnapshot,
  normalizeSnapshot,
  toSnapshotJson,
  SNAPSHOT_VERSION
} from './novel/snapshot'
import { SCHEMA_VERSION } from './migration'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { useGeneration } from '../store/generation'
import { defaultSettings } from '../store/settings'

/**
 * 局域网同步 · 渲染层。
 *
 * 电脑侧有两副身份，都在这一个文件里：
 *
 * 1. **服务端**。主进程的 HTTP 服务器读不到 IndexedDB（数据在渲染进程），
 *    所以有设备来同步时它把请求推下来（`sync:incoming`），这里合并完再
 *    把结果交回去（`sync:respond`）。方向与既有的 llm:* 同构。
 * 2. **客户端**（手机 / 浏览器）。手机没有服务端，所以由它发起：
 *    `POST /sync` 带上自己的快照，拿回对方合并后的结果就地应用。
 *
 * 关于「为什么不直接让主进程读库」：主进程没有 IndexedDB，也没有 Vue 的
 * reactive 状态。让它绕过渲染层去开一个 LevelDB 之类的副本，等于引入第二个
 * 数据真相来源 —— 那正是同步里最难修的一类 bug 的来源。
 *
 * 传输协议本体（合并规则、墓碑判死）在 `novel/snapshot.js`，**不在这里重写**：
 * 同步与「恢复全量备份」传的是同一个对象，规则只能有一份。
 */

/** 电脑端的接收上限，与 electron/main.js 的 SYNC_MAX_BODY 一致。 */
export const SYNC_MAX_BYTES = 64 * 1024 * 1024

/**
 * 界面钩子由 App.vue 注入。
 *
 * sync.js 不 import 任何组件 —— service → 组件 的反向依赖会让打包出现循环、
 * 也让这个模块无法在测试里单独驱动。注入是这里唯一需要的耦合方向。
 */
let ui = { flush: async () => {}, reloadEditor: () => {} }
export function setUiHooks(hooks = {}) {
  ui = { ...ui, ...hooks }
}

/** 同步状态。SyncPanel 直接读它，自身不持有任何副本。 */
export const syncState = reactive({
  /** 正在处理一次远端请求（合并中） */
  merging: false,
  /** 客户端在跑一次「测试连接 / 立即同步」 */
  working: false,
  lastIncoming: null, // { diff, at, remoteAddr }
  lastOutgoing: null // { diff, at }
})

// ---------------------------------------------------------------------------
// 服务端：把远端快照合并进本机
// ---------------------------------------------------------------------------

/**
 * 处理一份远端快照，返回给主进程（它会把这些字段写成 HTTP 响应）。
 *
 * **顺序是硬约束，四条都不能换**：
 *
 * 1. 正在生成 → 直接拒绝。合并是 `saveChapters` 整组回写，与流式写入抢同一个
 *    键，撞上就是一次静默丢稿。先挡住，代价只是让对面稍后重试。
 * 2. `flush()` —— 把编辑器防抖窗口里的正文先落库。不做这一步，用户刚敲的那
 *    几百字会被随后写回的整个章节数组**覆盖掉**，而且他看不到任何提示。
 * 3. `applySnapshot` —— 只写库，**完全不碰 store**。
 * 4. `reloadAfterSync` + `reloadEditor` —— 把内存态与屏幕上的正文重新对齐。
 *    漏掉这步的表现为「同步完了界面还是旧的，重启才变」。
 */
export async function handleIncomingSnapshot(remote, { remoteAddr = '' } = {}) {
  const gen = useGeneration()
  if (gen.store.running) {
    // 409 由主进程翻译，这里只负责说清楚原因
    return { ok: false, busy: true, message: '电脑正在生成正文' }
  }

  let snap
  try {
    snap = normalizeSnapshot(remote)
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) }
  }

  syncState.merging = true
  try {
    await ui.flush()
    const { stats, after } = await applySnapshot(snap)
    await reloadAfterSync()
    ui.reloadEditor()
    syncState.lastIncoming = { diff: stats, at: Date.now(), remoteAddr }
    // 回给对面的是**合并结果**，不是「成功」两个字：它拿到就地应用，两边就此
    // 收敛，不需要第二次往返（两次往返之间任一侧再写入都会丢更新）。
    return { ok: true, snapshot: after, stats }
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) }
  } finally {
    syncState.merging = false
  }
}

/**
 * 把内存态重新对齐到库里。
 *
 * 两处不走现成函数，都是刻意的：
 * - **不用 `init()`**：它有 `loaded` 守卫，第二次调用直接返回，书库列表还是旧的；
 * - **不用 `openBook()` 的默认行为**：它会把 `chapterId` 重置成第一章。用户正在
 *   写第 12 章时被同步打断，正文突然跳到第 1 章，是比"界面没刷新"更糟的表现。
 */
export async function reloadAfterSync() {
  const b = useBooks()
  const cols = useCollections()
  const gen = useGeneration()

  b.store.books = await db.getBooks()
  if (!b.store.bookId) return { bookId: null }

  const openId = b.store.bookId
  const keepChapterId = b.store.chapterId
  if (!b.store.books.some((x) => x.id === openId)) {
    // 这本书被远端的整书墓碑删掉了。只清 store 不动库 —— 库那一步
    // applySnapshot 已经做过了（它走 db.deleteBook 级联清键）。
    b.closeBook()
    cols.memory.clear()
    cols.structure.clear()
    gen.clear()
    return { bookId: null, closed: true }
  }

  await b.openBook(openId)
  if (keepChapterId && b.store.chapters.some((c) => c.id === keepChapterId)) {
    b.store.chapterId = keepChapterId
  }
  await Promise.all([cols.loadForBook(openId), gen.loadForBook(openId)])
  return { bookId: openId }
}

// ---------------------------------------------------------------------------
// 客户端：手机 / 浏览器主动连电脑
// ---------------------------------------------------------------------------

/**
 * 把用户填的地址规范成可以拼路径的 origin。
 * 允许只填 `192.168.1.5`（补默认端口），也允许带 `http://` 前缀。
 * 认不出的返回空串，由调用方给一句能照着改的提示。
 */
export function normalizeSyncUrl(input) {
  let s = String(input == null ? '' : input).trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // 已经带了协议头（file:// ftp:// …）→ 只认 http/https。
    // **不能先补 `http://` 再判**：那样 `file:///C:/Windows` 会被解析成主机名
    // `file`，得到一个语法完全合法、实则毫无意义的 `http://file:8787`，
    // 用户只会看到「连不上」，而他填的明明是一个「地址」。这条 if 与下面
    // `u.protocol` 那一条是两道不同的关卡：这里挡住的是**带协议头但协议不对**，
    // 那里挡的是解析之后仍不是 http/https 的漏网者。
    if (!/^https?:\/\//i.test(s)) return ''
  } else {
    // 用户照抄电脑上显示的那一行（`192.168.1.5:8787`），本来就不带协议头
    s = 'http://' + s
  }
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (!u.hostname) return ''
    if (!u.port) u.port = String(defaultSettings.syncPort)
    return u.origin
  } catch {
    return ''
  }
}

const BAD_URL = '电脑地址填得不对。照抄电脑上显示的那一行，例如 192.168.1.5:8787'

/** 「测试连接」。走 /hello：它无鉴权、不含任何数据，所以能区分「地址不通」与「码不对」。 */
export async function testConnection(rawUrl) {
  const base = normalizeSyncUrl(rawUrl)
  if (!base) return { ok: false, message: BAD_URL }
  try {
    const res = await fetch(base + '/hello', { method: 'GET' })
    if (!res.ok) return { ok: false, base, message: `电脑端返回 ${res.status}` }
    const info = await res.json()
    // 端口上可能是别的东西 —— 说清楚比让用户对着「配对码不正确」发呆强
    if (info?.protocol !== 'novel-studio-sync') {
      return { ok: false, base, message: '这个地址上不是 Novel Studio' }
    }
    if (Number(info.snapshotVersion) > SNAPSHOT_VERSION) {
      return {
        ok: false,
        base,
        info,
        message: `电脑端的软件版本比本机新（同步协议 v${info.snapshotVersion} > v${SNAPSHOT_VERSION}），请先升级本机`
      }
    }
    return { ok: true, base, info }
  } catch {
    return {
      ok: false,
      base,
      message: '连不上。请确认电脑开着同步服务、两台设备在同一个 Wi-Fi，并检查电脑的防火墙'
    }
  }
}

/**
 * 推一次快照并应用对方返回的合并结果 —— 一次往返，两侧收敛。
 *
 * 关于体积：**必须在本机先量**。超限时电脑端会直接断掉连接，客户端只能看到
 * 一个笼统的网络错误，分不清是「数据太大」还是「Wi-Fi 掉了」。这个判断只有
 * 本机做得出来（它才知道自己要发多少），所以由它做。
 */
export async function pushSnapshot(rawUrl, code, { snapshot } = {}) {
  const base = normalizeSyncUrl(rawUrl)
  if (!base) return { ok: false, message: BAD_URL }
  const pair = String(code == null ? '' : code).trim()
  if (!/^\d{6}$/.test(pair)) {
    return { ok: false, message: '配对码是电脑上显示的 6 位数字' }
  }

  // 先把编辑器里挂起的正文落库，再读快照 —— 反了就会把上一次自动保存之后的
  // 几百字留在家门口发不出去
  await ui.flush()

  const snap = snapshot || (await collectSnapshot())
  const text = toSnapshotJson(snap)
  // 中文字符是 3 字节，`text.length` 是 UTF-16 单元数，两者不是一回事：
  // 按 length 判断会让一份 60 MB 的中文快照看起来只有 20 MB 而直接发出去
  const bytes = new Blob([text]).size
  if (bytes > SYNC_MAX_BYTES) {
    return {
      ok: false,
      message: `本机数据有 ${Math.round(bytes / 1048576)} MB，超过电脑端 64 MB 的接收上限。请改用「全量备份」手工搬一次。`
    }
  }

  syncState.working = true
  try {
    let res
    try {
      res = await fetch(base + '/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pair-Code': pair },
        body: text
      })
    } catch {
      return { ok: false, message: '连接中断。请确认两台设备在同一个 Wi-Fi；若数据接近 64 MB，也可能被电脑端拒绝了' }
    }

    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (res.status === 401) {
      return { ok: false, code: 'bad-code', message: body?.message || '配对码不正确' }
    }
    if (res.status === 409) {
      return { ok: false, code: 'busy', message: body?.message || '电脑正在生成正文，请等这一章写完再同步' }
    }
    if (!res.ok) {
      return { ok: false, code: body?.error || `http-${res.status}`, message: body?.message || `电脑端返回 ${res.status}` }
    }

    // 响应体是对方合并后的**全量结果**。就地应用它：本机已有的记录因为时间戳
    // 相同而保留本地（mergeRecords 的平局规则），对方多出来的则补进来 ——
    // 这就是「收敛」，不需要再算一次差集。
    const merged = normalizeSnapshot(body)
    const applied = await applySnapshot(merged)
    await reloadAfterSync()
    ui.reloadEditor()
    syncState.lastOutgoing = { diff: applied.stats, at: Date.now() }
    return { ok: true, diff: applied.stats }
  } finally {
    syncState.working = false
  }
}

// ---------------------------------------------------------------------------
// 电脑端服务控制（IPC 薄封装）
// ---------------------------------------------------------------------------

const noDesktop = () => ({ ok: false, message: '只有电脑端可以开启同步服务' })

export async function startSyncServer(port) {
  if (!isDesktop()) return noDesktop()
  // 版本号由渲染层报给主进程，而不是让它自己写一份 —— SCHEMA_VERSION /
  // SNAPSHOT_VERSION 的唯一事实来源在 src/，复制一份迟早会分叉
  return window.electronAPI.syncStart({
    port: Number(port) || defaultSettings.syncPort,
    hello: { snapshotVersion: SNAPSHOT_VERSION, schemaVersion: SCHEMA_VERSION }
  })
}

export async function stopSyncServer() {
  if (!isDesktop()) return noDesktop()
  return window.electronAPI.syncStop()
}

export async function rotateSyncCode() {
  if (!isDesktop()) return noDesktop()
  return window.electronAPI.syncRotateCode()
}

export async function syncStatus() {
  if (!isDesktop()) return { ok: true, running: false, port: 0, code: '', addresses: [], last: null }
  return window.electronAPI.syncStatus()
}

// ---------------------------------------------------------------------------
// 事件中枢：模块加载时注册一次
// ---------------------------------------------------------------------------

let hubReady = false

/**
 * 注册主进程推下来的同步请求。
 *
 * **必须在模块加载时注册一次**，不能放进每次调用的函数体里 —— 这是 CLAUDE.md
 * 坑 #2 的铁律（当初 llm.js 逐次注册 onDone/onError 收不到事件，排查了很久）。
 * 同一条规律在同步通道上一模一样地成立。
 */
function ensureSyncHub() {
  if (hubReady) return
  if (typeof window === 'undefined' || !window.electronAPI?.onSyncIncoming) return
  hubReady = true
  window.electronAPI.onSyncIncoming(async (payload = {}) => {
    const { requestId, remote, remoteAddr } = payload
    let answer
    try {
      answer = await handleIncomingSnapshot(remote, { remoteAddr })
    } catch (e) {
      // 这是主进程推下来的事件回调：在这里抛出去没人接，手机那头只会看到
      // 一个没有下文的连接。必须把它变成一条明确的失败应答。
      answer = { ok: false, message: String((e && e.message) || e) }
    }
    // 拿到 ESTALE 说明主进程已经按超时回了 503，这次劳动没被采纳。
    // 不是错误，也不值得打扰用户，直接丢弃。
    await window.electronAPI.syncRespond({ requestId, ...answer })
  })
}

ensureSyncHub()
