<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBooks } from './store/books'
import { useSettings } from './store/settings'
import { toasts } from './store/toast'
import { useCollections } from './store/novel'
import { useGeneration } from './store/generation'
import { initNativeUI, registerBackButton } from './services/native'
import { startAutoBackup, stopAutoBackup } from './services/backup'
import { isDesktop } from './services/platform'
import { setUiHooks, startSyncServer } from './services/sync'
import BookShelf from './components/BookShelf.vue'
import WritingView from './components/WritingView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ExportModal from './components/ExportModal.vue'
import NovelConsole from './components/NovelConsole.vue'

const { store, init, openBook, closeBook } = useBooks()
const { load, settings } = useSettings()
const cols = useCollections()
const gen = useGeneration()

const view = ref('shelf') // 'shelf' | 'writing'
const showSettings = ref(false)
const showExport = ref(false)
const showConsole = ref(false)
const writingRef = ref(null)

onMounted(async () => {
  await Promise.all([init(), load()])
  initNativeUI()
  registerBackButton(handleBack)
  // 同步层要能冲刷编辑器、并在合并后让编辑器重读正文。钩子在这里注入而不是
  // 让 sync.js 去 import 组件 —— 那条反向依赖会把服务层和界面绑死。
  setUiHooks({
    flush: () => writingRef.value?.flush(),
    reloadEditor: () => writingRef.value?.reloadEditor()
  })
  // 同步服务默认关闭（见 settings.js 的 syncAutoStart）。用户主动打开过才会
  // 在这里自动监听，所以「本软件从不悄悄占用端口」这条依然成立。
  if (isDesktop() && settings.syncAutoStart) startSyncServer(settings.syncPort)
})

// 定时器只在 App 这一层启停；组件里裸跑 setInterval 会在热更新时叠层
onBeforeUnmount(stopAutoBackup)

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
  showConsole.value = true
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
    <NovelConsole v-if="showConsole" @close="showConsole = false" />

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
