<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBooks } from './store/books'
import { useSettings } from './store/settings'
import { toasts } from './store/toast'
import { initNativeUI, registerBackButton } from './services/native'
import { startAutoBackup, stopAutoBackup } from './services/backup'
import BookShelf from './components/BookShelf.vue'
import WritingView from './components/WritingView.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ExportModal from './components/ExportModal.vue'

const { store, init, openBook, closeBook } = useBooks()
const { load, settings } = useSettings()

const view = ref('shelf') // 'shelf' | 'writing'
const showSettings = ref(false)
const showExport = ref(false)
const writingRef = ref(null)

onMounted(async () => {
  await Promise.all([init(), load()])
  initNativeUI()
  registerBackButton(handleBack)
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
 */
function handleBack() {
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
