<script setup>
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { useBooks } from '../store/books'
import { toast } from '../store/toast'
import { createAutosaver } from '../services/autosave'

const emit = defineEmits(['selection-change'])
const { store, currentChapter, setChapterContent, persistChapter } = useBooks()

const text = ref('')
const preview = ref(false)
const ta = ref(null)
const saved = ref(true)
let lastSel = { start: 0, end: 0 }

// 查找/替换的状态必须在下面的 watch 之前声明：那个 watcher 是 immediate 的，
// 回调会在 setup 期间同步执行并重置 findCursor，此时若 const 还没初始化，
// 就会抛 TDZ 的 ReferenceError。
// Vue 会把这个错误吞掉并 console.error（渲染照常继续、组件照常挂载），
// 所以症状不是白屏，而是「控制台里一条报错 + 该回调后半段被静默跳过」——
// 正因为不白屏，它才特别容易被漏掉。冒烟测试的 uiNoSwallowedErrors 专门盯这类问题。
const findOpen = ref(false)
const findInput = ref(null)
const findText = ref('')
const replaceWith = ref('')
const findCursor = ref(-1)

// 待保存的目标章节在 schedule() 时捕获，而不是在定时器触发时再去读「当前章节」——
// 否则在 1.5 秒防抖窗口内切换章节，最后一笔改动会被写到新章节上，
// 原标题的内容则直接丢失。
const saver = createAutosaver({
  persist: (id) => persistChapter(id),
  delay: 1500,
  onSaved: (id) => {
    if (currentChapter.value?.id === id) saved.value = true
  }
})

// 切换章节时载入正文
watch(
  () => currentChapter.value?.id,
  (newId, oldId) => {
    // 先把上一章挂起的改动落盘。这里刻意不 await：落盘逻辑在第一个 await 之前
    // 就已摘除 pendingId，留在飞行中是安全的（storage 的写队列会保证顺序）；
    // await 反而会让正文切换慢一个 IndexedDB 往返，并闪出上一章的内容。
    if (oldId) saver.flush()
    text.value = currentChapter.value?.content ?? ''
    // 选区必须跟着章节一起重置，否则切章后立刻点「替换选中」
    // 会拿着上一章的偏移量去改新章
    lastSel = { start: 0, end: 0 }
    findCursor.value = -1
    saved.value = true
  },
  { immediate: true }
)

// 字数统计：中文字符 + 其它字符
const wordCount = computed(() => {
  const s = text.value.replace(/\s/g, '')
  const cjk = (s.match(/[一-龥]/g) || []).length
  return { cjk, other: s.length - cjk, total: s.length }
})

// ---------------------------------------------------------------------------
// 正文变更的统一入口：改内存 → 标脏 → 排队落盘
// ---------------------------------------------------------------------------
function applyText(next) {
  const id = currentChapter.value?.id
  if (!id) {
    toast('请先选择一个章节', 'error')
    return false
  }
  text.value = next
  setChapterContent(id, next)
  saved.value = false
  saver.schedule(id)
  return true
}

function onInput() {
  const id = currentChapter.value?.id
  if (!id) return
  setChapterContent(id, text.value)
  saved.value = false
  saver.schedule(id)
}

async function manualSave() {
  const id = currentChapter.value?.id
  if (!id) return
  await saver.flush()
  await persistChapter(id)
  saved.value = true
  toast('已保存', 'success')
}

function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    manualSave()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openFind()
  }
}

// 选区追踪 → 供 AI 扩写/改写使用
function onSelection() {
  const el = ta.value
  if (!el) return
  lastSel = { start: el.selectionStart, end: el.selectionEnd }
  emit('selection-change', text.value.slice(el.selectionStart, el.selectionEnd))
}

// ---- 供 AI 面板调用的公开方法 ----
function appendText(t) {
  if (!t) return
  if (!applyText(text.value + (text.value && !text.value.endsWith('\n') ? '\n\n' : '') + t)) return
  nextTick(() => {
    const len = text.value.length
    ta.value?.focus()
    ta.value?.setSelectionRange(len, len)
  })
}

function replaceSelection(t) {
  if (!t) return
  const start = Math.min(Math.max(lastSel.start, 0), text.value.length)
  const end = Math.min(Math.max(lastSel.end, lastSel.start), text.value.length)
  if (start === end) {
    appendText(t)
    return
  }
  if (!applyText(text.value.slice(0, start) + t + text.value.slice(end))) return
  nextTick(() => {
    ta.value?.focus()
    ta.value?.setSelectionRange(start, start + t.length)
  })
}

// ---------------------------------------------------------------------------
// 查找 / 替换（纯字面量匹配，不做正则）
// 中文正文里正则的收益有限，却要额外处理转义与非法正则，不如保持可预期。
// 状态声明见文件顶部（必须在 immediate watcher 之前）。
// ---------------------------------------------------------------------------
const matches = computed(() => {
  const q = findText.value
  if (!q) return []
  const out = []
  let i = text.value.indexOf(q)
  while (i >= 0) {
    out.push(i)
    i = text.value.indexOf(q, i + q.length)
  }
  return out
})

function openFind() {
  findOpen.value = true
  nextTick(() => findInput.value?.focus())
}

function closeFind() {
  findOpen.value = false
  findCursor.value = -1
}

function highlight(pos) {
  const el = ta.value
  if (!el) return
  el.focus()
  el.setSelectionRange(pos, pos + findText.value.length)
  lastSel = { start: pos, end: pos + findText.value.length }
  emit('selection-change', findText.value)
}

function findNext(dir = 1) {
  const list = matches.value
  if (!list.length) {
    toast('未找到匹配内容', 'error')
    return
  }
  const n = list.length
  findCursor.value = (((findCursor.value + dir) % n) + n) % n
  highlight(list[findCursor.value])
}

function replaceOne() {
  const q = findText.value
  if (!q) return
  const { start, end } = lastSel
  // 当前选区不是要找的内容时，先跳过去，而不是盲改别处
  if (end - start !== q.length || text.value.slice(start, end) !== q) {
    findNext(1)
    return
  }
  if (!applyText(text.value.slice(0, start) + replaceWith.value + text.value.slice(end))) return
  const pos = start + replaceWith.value.length
  nextTick(() => {
    ta.value?.focus()
    ta.value?.setSelectionRange(pos, pos)
    const list = matches.value
    const idx = list.findIndex((p) => p >= pos)
    if (idx >= 0) {
      findCursor.value = idx
      highlight(list[idx])
    } else {
      lastSel = { start: pos, end: pos }
      findCursor.value = -1
    }
  })
  toast('已替换', 'success')
}

function replaceAll() {
  const q = findText.value
  if (!q) return
  const count = matches.value.length
  if (!count) {
    toast('未找到匹配内容', 'error')
    return
  }
  if (!applyText(text.value.split(q).join(replaceWith.value))) return
  findCursor.value = -1
  toast(`已替换 ${count} 处`, 'success')
}

const previewHtml = computed(() => {
  try {
    return marked.parse(text.value || '', { breaks: true })
  } catch {
    return ''
  }
})

/** 把挂起的改动立即落盘；供 WritingView 在切章/返回书库前编排 */
function flush() {
  return saver.flush()
}

defineExpose({ appendText, replaceSelection, flush })

onBeforeUnmount(() => {
  // 兜底：正常路径上 WritingView 已经先 flush 过了。
  // 即便这里晚于 closeBook（bookId 已清空），storage 的作用域守卫也会拦住写入。
  saver.flush()
})
</script>

<template>
  <div class="editor">
    <div class="editor-head">
      <div class="chap-title" :title="currentChapter?.title">
        {{ currentChapter ? `第${currentChapter.order}章 · ${currentChapter.title}` : '未选择章节' }}
      </div>
      <div class="editor-ops">
        <span class="wcount">
          字数 {{ wordCount.total }}（中文 {{ wordCount.cjk }}）
        </span>
        <span class="save-state" :class="{ ok: saved }">
          {{ saved ? '已保存' : '保存中…' }}
        </span>
        <button class="btn sm" :class="{ primary: findOpen }" @click="findOpen ? closeFind() : openFind()">
          查找
        </button>
        <button class="btn sm" :class="{ primary: preview }" @click="preview = !preview">
          {{ preview ? '编辑' : '预览' }}
        </button>
        <button class="btn sm" @click="manualSave">保存</button>
      </div>
    </div>

    <div v-if="findOpen" class="find-bar">
      <input
        ref="findInput"
        v-model="findText"
        class="input find-input"
        placeholder="查找…"
        @keydown.enter.prevent="findNext(1)"
        @keydown.esc="closeFind"
      />
      <input
        v-model="replaceWith"
        class="input find-input"
        placeholder="替换为…"
        @keydown.enter.prevent="replaceOne"
        @keydown.esc="closeFind"
      />
      <span class="find-count">{{ findText ? `${matches.length} 处` : '' }}</span>
      <button class="btn sm" :disabled="!matches.length" @click="findNext(-1)">上一个</button>
      <button class="btn sm" :disabled="!matches.length" @click="findNext(1)">下一个</button>
      <button class="btn sm" :disabled="!matches.length" @click="replaceOne">替换</button>
      <button class="btn sm" :disabled="!matches.length" @click="replaceAll">全部替换</button>
      <button class="btn ghost sm" @click="closeFind">✕</button>
    </div>

    <div v-if="!currentChapter" class="empty">
      <div class="icon">📖</div>
      <h3>打开或新建一个章节开始写作</h3>
    </div>

    <textarea
      v-else-if="!preview"
      ref="ta"
      v-model="text"
      class="editor-ta"
      spellcheck="false"
      placeholder="开始写作，或在右侧用 AI 续写、扩写、改写……（Ctrl/Cmd + S 手动保存，Ctrl/Cmd + F 查找）"
      @input="onInput"
      @keydown="onKeydown"
      @select="onSelection"
      @click="onSelection"
      @keyup="onSelection"
      @scroll="onSelection"
    ></textarea>

    <div v-else-if="preview" class="preview" v-html="previewHtml"></div>
  </div>
</template>

<style scoped>
.editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.chap-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.wcount {
  font-size: 12px;
  color: var(--text-3);
}
.save-state {
  font-size: 12px;
  color: var(--text-3);
}
.save-state.ok {
  color: var(--success);
}
.find-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-muted);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.find-input {
  width: 150px;
  padding: 5px 10px;
  font-size: 12px;
}
.find-count {
  font-size: 12px;
  color: var(--text-3);
  min-width: 44px;
}
.editor-ta {
  flex: 1;
  width: 100%;
  border: none;
  resize: none;
  padding: 20px 26px;
  font-size: 15px;
  line-height: 1.9;
  background: var(--bg);
  color: var(--text);
}
.editor-ta:focus {
  outline: none;
}
.editor-ta::placeholder {
  color: #c2c7d0;
}
.preview {
  flex: 1;
  overflow: auto;
  padding: 20px 26px;
  font-size: 15px;
  line-height: 1.9;
  background: var(--bg);
}
.preview :deep(h1),
.preview :deep(h2),
.preview :deep(h3) {
  margin: 1em 0 0.5em;
  line-height: 1.4;
}
.preview :deep(p) {
  margin: 0.7em 0;
}
.preview :deep(blockquote) {
  border-left: 3px solid var(--accent);
  margin: 0.8em 0;
  padding: 2px 12px;
  color: var(--text-2);
  background: var(--bg-muted);
  border-radius: 0 8px 8px 0;
}
.preview :deep(code) {
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 13px;
}
.preview :deep(pre) {
  background: var(--bg-muted);
  padding: 12px;
  border-radius: var(--radius-sm);
  overflow: auto;
}
.preview :deep(pre code) {
  background: none;
  padding: 0;
}
</style>
