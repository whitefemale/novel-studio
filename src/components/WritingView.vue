<script setup>
import { ref, watch } from 'vue'
import Sidebar from './Sidebar.vue'
import Editor from './Editor.vue'
import AiPanel from './AiPanel.vue'
import { useBooks } from '../store/books'
import { isNarrowLayout } from '../services/platform'

const { store, addChapterWithContent } = useBooks()

const editorRef = ref(null)
const selectionText = ref('')
// 窄屏下三栏改成「同一时刻只显示一栏」，底部标签切换。
// 选标签栏而不是抽屉/手势：无需引入组件库，不与 textarea 的选中手势冲突，
// 而且能和 Android 返回键天然配合（见 handleBack）。
const mobilePane = ref('editor')

function onSelectionChange(text) {
  selectionText.value = text || ''
}

function showEditor() {
  mobilePane.value = 'editor'
}

function handleAppend(text) {
  editorRef.value?.appendText(text)
  showEditor()
}

function handleReplace(text) {
  editorRef.value?.replaceSelection(text)
  showEditor()
}

/**
 * AI 生成整章后「存为新章节」。
 *
 * 必须先 flush 上一章挂起的改动：建章是「读章节数组 → 追加 → 整数组写回」，
 * 若上一章的最后一笔还只在内存里，写回的数组会把它漏掉。
 * 正文并进建章动作一次完成，而不是「先建空章、再插入正文」——后者在
 * 插入落到旧章节上时会串写。
 */
async function handleSaveAsNew(text) {
  await editorRef.value?.flush()
  await addChapterWithContent(text)
  showEditor()
}

// 手机上点选章节后自动回到正文，省掉一次多余点击
watch(
  () => store.chapterId,
  () => {
    if (isNarrowLayout()) showEditor()
  }
)

/** Android 返回键分级：消化了返回 true，未消化交给上层/退出应用 */
function handleBack() {
  if (!isNarrowLayout()) return false
  if (mobilePane.value === 'ai') {
    showEditor()
    return true
  }
  if (mobilePane.value === 'editor') {
    mobilePane.value = 'sidebar'
    return true
  }
  return false
}

/** 把编辑器里挂起的改动立即落盘 */
function flush() {
  return editorRef.value?.flush()
}

defineExpose({ flush, handleBack })
</script>

<template>
  <div class="writing" :data-pane="mobilePane">
    <Sidebar class="pane pane-sidebar" />
    <div class="editor-wrap pane pane-editor">
      <Editor ref="editorRef" @selection-change="onSelectionChange" />
    </div>
    <AiPanel
      class="pane pane-ai"
      :selection-text="selectionText"
      @append="handleAppend"
      @replace="handleReplace"
      @save-as-new="handleSaveAsNew"
    />

    <nav class="mobile-tabs">
      <button class="mtab" :class="{ active: mobilePane === 'sidebar' }" @click="mobilePane = 'sidebar'">
        章节
      </button>
      <button class="mtab" :class="{ active: mobilePane === 'editor' }" @click="mobilePane = 'editor'">
        正文
      </button>
      <button class="mtab" :class="{ active: mobilePane === 'ai' }" @click="mobilePane = 'ai'">
        AI
      </button>
    </nav>
  </div>
</template>

<style scoped>
.writing {
  height: 100%;
  display: flex;
  min-width: 0;
}
.editor-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.mobile-tabs {
  display: none;
}

/*
 * 窄屏：三栏纵向堆叠是行不通的 —— .sidebar(248px) 与 .ai-panel(320px) 是固定宽度，
 * 在 390px 的手机上侧栏会撑满并高过视口，把编辑器整个挤出屏幕。
 * 因此改为同一时刻只渲染一栏、占满全宽，用底部标签切换。
 */
@media (max-width: 860px) {
  .writing {
    flex-direction: column;
  }
  .writing .pane {
    display: none;
  }
  .writing[data-pane='sidebar'] .pane-sidebar,
  .writing[data-pane='editor'] .pane-editor,
  .writing[data-pane='ai'] .pane-ai {
    display: flex;
    flex: 1;
    width: 100%;
    min-height: 0;
  }
  .editor-wrap {
    border-left: none;
    border-right: none;
  }
  .mobile-tabs {
    display: flex;
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--bg);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .mtab {
    flex: 1;
    padding: 13px 0;
    font-size: 13px;
    color: var(--text-2);
  }
  .mtab.active {
    color: var(--accent);
    font-weight: 600;
  }
}
</style>
