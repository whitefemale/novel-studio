<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBooks } from './store/books'
import { useSettings } from './store/settings'
import { toasts, toast } from './store/toast'
import { useCollections } from './store/novel'
import { useGeneration } from './store/generation'
import { initNativeUI, registerBackButton, registerAppStateChange } from './services/native'
import { startAutoBackup, stopAutoBackup } from './services/backup'
import { isDesktop } from './services/platform'
import { setUiHooks, startSyncServer } from './services/sync'
import { setQueueUiHooks } from './store/writingQueue'
import { syncWithWebdav, webdavState } from './services/sync/webdav'
import { ensureSchemaVersion } from './services/migration'
import { usePlugins } from './store/plugins'
import BookShelf from './components/BookShelf.vue'
import WritingView from './components/WritingView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ExportModal from './components/ExportModal.vue'
import NovelConsole from './components/NovelConsole.vue'
import SearchModal from './components/SearchModal.vue'

const { store, init, openBook, closeBook } = useBooks()
const { load, settings } = useSettings()
const cols = useCollections()
const gen = useGeneration()
const plugins = usePlugins()

const view = ref('shelf') // 'shelf' | 'writing'
const showSettings = ref(false)
const showExport = ref(false)
const showConsole = ref(false)
const showSearch = ref(false)
// 控制台打开时落在哪个标签。搜索里点中一个实体时传它的集合名，
// 平时从顶栏打开则固定回「剧情」——不记住上一次看过的标签是刻意的：
// 用户点「控制台」的意图通常是查主线，而不是接着看上次的生成历史。
const consoleTab = ref('story')
const writingRef = ref(null)

/**
 * 把编辑器防抖窗口里的正文立即落库。
 *
 * 即发即忘：页面正在离开时没有地方 await；storage 的写队列会在后台把它走完，
 * 而 persistChapter 在第一个 await 前已经捕获了目标 id（见 autosave.js）。
 */
function flushEditor() {
  try {
    const p = writingRef.value?.flush()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    // 离开路径上不能抛
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') flushEditor()
}

function onPageHide() {
  flushEditor()
}

function onBeforeUnload() {
  flushEditor()
}

function onWindowBlur() {
  if (view.value === 'writing') flushEditor()
}

// ---------------------------------------------------------------------------
// WebDAV 自动同步
//
// 三条约束，缺一条都会让「自动」变成打扰：
//   1. 只在桌面端、且用户显式打开 enabled + autoSync 时运行；
//   2. 生成中直接跳过（同步会整组回写章节，与流式写入抢同一个键）；
//   3. 同一个错误只弹一次 toast —— 服务器挂掉时每 5 分钟弹一次，
//      用户很快就会把整个提示都忽略掉。
// ---------------------------------------------------------------------------
let webdavTimer = null
let webdavFirstTimer = null
let webdavErrorShown = ''

function stopWebdavAutoSync() {
  if (webdavTimer) {
    clearInterval(webdavTimer)
    webdavTimer = null
  }
  if (webdavFirstTimer) {
    clearTimeout(webdavFirstTimer)
    webdavFirstTimer = null
  }
}

async function runWebdavAutoSync() {
  if (!isDesktop() || webdavState.working) return
  if (!settings.webdav?.enabled || !settings.webdav?.autoSync) return
  if (gen.store.running) return
  const res = await syncWithWebdav()
  if (res.skipped) return
  if (!res.ok) {
    const msg = res.message || '自动同步失败'
    if (msg !== webdavErrorShown) {
      webdavErrorShown = msg
      toast(`WebDAV 自动同步失败：${msg}`, 'error')
    }
  } else {
    webdavErrorShown = ''
  }
}

function configureWebdavAutoSync() {
  stopWebdavAutoSync()
  if (!isDesktop() || !settings.webdav?.enabled || !settings.webdav?.autoSync) return
  const secs = Math.max(60, Number(settings.webdav.intervalSec) || 300)
  webdavTimer = setInterval(() => {
    void runWebdavAutoSync()
  }, secs * 1000)
  // 启动后 10 秒补一次：否则刚打开软件时要等满一个间隔才看到另一台设备的改动
  webdavFirstTimer = setTimeout(() => {
    void runWebdavAutoSync()
  }, 10 * 1000)
}

onMounted(async () => {
  await Promise.all([init(), load()])
  // 只记录版本标记，不改写任何笔记/设定（V1→V2 的内容迁移仍由用户手动触发）。
  // 冒烟测试与真实用户都会走到这里，meta 因此不再依赖某个功能被打开过。
  await ensureSchemaVersion()
  // 插件清单不落库，真相是插件目录里的文件；启动读一次，改文件后可在设置里「重新读取」。
  // 失败不阻断启动——插件用不了只是少一层能力，绝不该让书打不开。
  if (isDesktop()) void plugins.load()
  initNativeUI()
  registerBackButton(handleBack)
  registerAppStateChange((active) => {
    if (!active) flushEditor()
  })
  // 页面生命周期兜底：切后台、关页、失焦时把防抖窗口里的正文落库。
  // visibilitychange 是移动端最可靠的一路；pagehide 覆盖前进/后退缓存；
  // blur 覆盖桌面端切到别的窗口。
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('blur', onWindowBlur)
  // Electron 关窗前主进程会发一次 app:before-close，等渲染层冲刷完再放行。
  // 没有这一条，点右上角 ✕ 时最后 1.5 秒内的输入会丢。
  if (isDesktop() && window.electronAPI?.onBeforeClose) {
    window.electronAPI.onBeforeClose(async () => {
      try {
        await writingRef.value?.flush()
      } catch {
        // 保存失败时仍然放行关闭：主进程有 2 秒兜底，且编辑器里已有失败提示
      }
      try {
        await window.electronAPI.closeReady()
      } catch {
        // 窗口可能已经被关掉了
      }
    })
  }
  // 同步层要能冲刷编辑器、并在合并后让编辑器重读正文。钩子在这里注入而不是
  // 让 sync.js 去 import 组件 —— 那条反向依赖会把服务层和界面绑死。
  setUiHooks({
    flush: () => writingRef.value?.flush(),
    reloadEditor: () => writingRef.value?.reloadEditor()
  })
  // 写作队列同样需要这两件事：每章开始前冲刷编辑器（生成要基于最新正文），
  // 插入草稿后让编辑器重读。队列住在 store 里、跑在面板关掉之后，所以钩子必须
  // 在 App 这一层注入 —— 面板卸载时再注入就晚了。
  setQueueUiHooks({
    flush: () => writingRef.value?.flush(),
    reloadEditor: () => writingRef.value?.reloadEditor()
  })
  // 同步服务默认关闭（见 settings.js 的 syncAutoStart）。用户主动打开过才会
  // 在这里自动监听，所以「本软件从不悄悄占用端口」这条依然成立。
  if (isDesktop() && settings.syncAutoStart) startSyncServer(settings.syncPort)
  configureWebdavAutoSync()
})

// 定时器与生命周期监听只在 App 这一层启停；组件里裸跑 setInterval 会在热更新时叠层
onBeforeUnmount(() => {
  stopAutoBackup()
  stopWebdavAutoSync()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('blur', onWindowBlur)
})

function handleOpenBook(id) {
  openBook(id)
  view.value = 'writing'
}

/**
 * 返回书库。
 *
 * 必须先冲刷编辑器里挂起的改动，再 closeBook() —— 顺序反了会引入一个新的丢稿：
 * closeBook() 立刻把 store.bookId 置空，而 Vue 卸载 WritingView 发生在这之后，
 * 编辑器 onBeforeUnmount 里的冲刷会读到 bookId === null，最后一笔就写到了
 * `chapters:null` 这个垃圾键上。
 */
async function handleBackToShelf() {
  await writingRef.value?.flush()
  closeBook()
  view.value = 'shelf'
}

function openExport() {
  if (!store.book) return
  showExport.value = true
}

/**
 * Android 硬件返回键 / 返回手势的分级处理。
 * 返回 true 表示已消化，返回 false 则由原生层退出应用。
 *
 * 控制台必须排在**最前**：它是全屏弹窗，打开时盖住了设置与导出。
 * 若排在后面，用户在控制台里按返回键会先把看不见的某个弹窗关掉，
 * 而眼前这一层纹丝不动 —— 表现为「返回键坏了」。
 */
function handleBack() {
  if (showSearch.value) {
    showSearch.value = false
    return true
  }
  if (showConsole.value) {
    showConsole.value = false
    return true
  }
  if (showSettings.value) {
    showSettings.value = false
    return true
  }
  if (showExport.value) {
    showExport.value = false
    return true
  }
  if (view.value === 'writing') {
    if (writingRef.value?.handleBack()) return true
    handleBackToShelf()
    return true
  }
  return false
}

/** 控制台需要一个已打开的书才有意义（迁移、记忆、生成记录都是按书隔离的） */
function openConsole() {
  if (!store.bookId) return
  consoleTab.value = 'story'
  showConsole.value = true
}

/** 搜索里点中一个结构化实体：直接落到它的集合标签 */
function openConsoleAt(collection) {
  if (!store.bookId) return
  showSearch.value = false
  consoleTab.value = collection || 'story'
  showConsole.value = true
}

function openSearch() {
  if (!store.bookId) return
  showSearch.value = true
}

/**
 * 控制台里改了正文（接受 AI 修订、把旧版复制为草稿）之后，让编辑器重读 store。
 * 编辑器只在 chapterId 变化时同步正文，同章内被外部改写它一概不理会。
 */
function reloadEditorAfterConsole() {
  writingRef.value?.reloadEditor()
}

/**
 * 关书时清掉 V2 的两族内存副本。
 *
 * 不清的后果不是崩溃，而是**串书**：关掉 A 书后 memory.store 里还留着 A 的人物，
 * 接着打开 B 书（哪怕只是瞥一眼控制台）就会看到别人的角色列表。载入本身是幂等的
 * （loadForBook 整体替换），但两份数据之间那一小段窗口足够让人做出错误判断。
 */
watch(
  () => store.bookId,
  (id) => {
    if (id) return
    cols.memory.clear()
    cols.structure.clear()
    gen.clear()
  }
)

// 自动备份随设置与当前书变化启停（startAutoBackup 内部会先停后起，重复调用安全）
watch(
  () => [settings.autoBackup, settings.backupInterval, settings.saveDir, store.bookId],
  () => startAutoBackup()
)

// WebDAV 自动同步的开关/间隔改了立即生效，不必重启
watch(
  () => [
    settings.webdav?.enabled,
    settings.webdav?.autoSync,
    settings.webdav?.intervalSec
  ],
  () => configureWebdavAutoSync()
)
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="logo">
        <span class="dot">✍</span>
        <span>Novel Studio</span>
      </div>

      <span v-if="view === 'writing' && store.book" class="book-title">
        《{{ store.book.title }}》
      </span>

      <div class="spacer"></div>

      <button class="btn ghost sm" @click="showSettings = true">⚙ 设置</button>

      <template v-if="view === 'writing'">
        <button class="btn sm" @click="openSearch">搜索</button>
        <button class="btn sm" @click="openConsole">控制台</button>
        <button class="btn sm" @click="openExport">导出</button>
        <button class="btn sm" @click="handleBackToShelf">返回书库</button>
      </template>
    </header>

    <main class="content">
      <BookShelf v-if="view === 'shelf'" @open="handleOpenBook" />
      <WritingView v-else ref="writingRef" />
    </main>

    <!-- 设置 -->
    <SettingsPanel v-if="showSettings" @close="showSettings = false" />

    <!-- 导出 -->
    <ExportModal v-if="showExport" @close="showExport = false" />

    <!-- 小说控制台（V2 记忆层与剧情骨架） -->
    <NovelConsole
      v-if="showConsole"
      :initial-tab="consoleTab"
      @close="showConsole = false"
      @content-changed="reloadEditorAfterConsole"
    />

    <!-- 全书搜索（当前书的正文 / 设定 / 结构化实体） -->
    <SearchModal
      v-if="showSearch"
      @close="showSearch = false"
      @open-console="openConsoleAt"
    />

    <!-- Toast -->
    <div class="toast-wrap">
      <div v-for="t in toasts.items" :key="t.id" class="toast" :class="t.type">
        {{ t.msg }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
