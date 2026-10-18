<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { searchBook } from '../services/novel/retrieval'
import OutlinePanel from './OutlinePanel.vue'

/**
 * 全书搜索：当前书的正文、旧设定（大纲/人物/世界观）与结构化实体。
 *
 * 为什么是弹窗而不是第四栏：窄屏已经是「同一时刻只显示一栏」，再加一栏
 * 在手机上无处安放；搜索是临时动作，用完就关，弹窗的语义正好。
 *
 * 三类结果的「跳转」刻意不同：
 *   - 章节 → 直接切到那一章；
 *   - 旧设定 → 就地打开设定编辑弹窗（它在侧栏里，控制台不管这一层）；
 *   - 结构化实体 → 打开控制台的对应标签。
 * 统一成「都跳到章节」会让人在找一个人物时莫名其妙地换章。
 *
 * 搜索本身是纯函数 searchBook（见 retrieval.js），组件只负责输入、防抖与
 * 键盘导航；结果片段用 v-for + <mark> 渲染，**不使用 v-html**。
 */
const emit = defineEmits(['close', 'open-console'])

const { store, selectChapter } = useBooks()
const cols = useCollections()

const q = ref('')
const results = ref([])
const active = ref(0)
const inputRef = ref(null)
const editingOutline = ref(null)
let timer = null

const kindClass = {
  chapter: 'k-chapter',
  outline: 'k-outline'
}

/**
 * 集合名 → 控制台标签键。两者并不总是一致（第二阶段踩过的同一个坑）：
 * `events` 的标签叫「时间线」，`scenes`/`volumes`/`arcs` 没有自己的标签、
 * 都在「剧情」里。直接把集合名当 initialTab 传过去会静默回落到第一页，
 * 用户只看到控制台打开了、但不是他点的那条。
 */
const TAB_FOR_COLLECTION = {
  events: 'timeline',
  scenes: 'story',
  volumes: 'story',
  arcs: 'story'
}

function orderOf(chapterId) {
  const c = store.chapters.find((x) => x.id === chapterId)
  return c ? c.order : null
}

function run() {
  const query = q.value.trim()
  if (!query) {
    results.value = []
    active.value = 0
    return
  }
  const hits = searchBook(
    {
      query,
      chapters: store.chapters,
      outlines: store.outlines,
      memory: cols.memory.store,
      structure: cols.structure.store
    },
    { limit: 80 }
  )
  results.value = hits.map((h) => ({
    ...h,
    displayTitle: h.kind === 'chapter' ? `第${orderOf(h.id) ?? '?'}章 · ${h.title}` : h.title,
    chapterOrder: h.chapterId ? orderOf(h.chapterId) : null
  }))
  active.value = 0
}

watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(run, 160)
})

function move(delta) {
  if (!results.value.length) return
  const n = results.value.length
  active.value = (active.value + delta + n) % n
}

function pick(hit) {
  if (!hit) return
  if (hit.kind === 'chapter') {
    selectChapter(hit.id)
    emit('close')
    return
  }
  if (hit.kind === 'outline') {
    const outline = store.outlines.find((o) => o.id === hit.id)
    if (outline) editingOutline.value = outline
    return
  }
  emit('open-console', TAB_FOR_COLLECTION[hit.collection] || hit.collection)
}

function gotoChapter(hit, e) {
  e.stopPropagation()
  if (!hit.chapterId) return
  selectChapter(hit.chapterId)
  emit('close')
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    pick(results.value[active.value])
  }
}

/** 把片段按命中词切开，模板里用 <mark> 标出；输入来自本地文本，不生成 HTML */
function parts(snippet) {
  const query = q.value.trim()
  const s = String(snippet || '')
  if (!query) return [{ hit: false, text: s }]
  const needle = query.toLowerCase()
  const lower = s.toLowerCase()
  const out = []
  let i = 0
  // 上限防止极端输入（如单字符查询）产生上千个片段节点
  while (out.length < 40) {
    const at = lower.indexOf(needle, i)
    if (at < 0) break
    if (at > i) out.push({ hit: false, text: s.slice(i, at) })
    out.push({ hit: true, text: s.slice(at, at + needle.length) })
    i = at + needle.length
  }
  if (i < s.length) out.push({ hit: false, text: s.slice(i) })
  return out
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await nextTick()
  inputRef.value?.focus()
  if (store.bookId) {
    await cols.loadForBook(store.bookId)
    if (q.value.trim()) run()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(timer)
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal search-modal">
      <div class="modal-header">
        <h3>搜索《{{ store.book?.title || '当前书' }}》</h3>
        <button class="btn ghost sm" aria-label="关闭搜索" @click="emit('close')">✕</button>
      </div>

      <div class="search-head">
        <input
          ref="inputRef"
          v-model="q"
          class="input"
          type="search"
          placeholder="搜索章节正文、设定与人物、地点、事件…"
          aria-label="搜索关键词"
          autocomplete="off"
        />
        <p class="hint">
          仅搜索当前这本书的本地数据。↑ ↓ 选择，Enter 打开，Esc 关闭。
        </p>
      </div>

      <div class="search-results" role="listbox" aria-label="搜索结果">
        <button
          v-for="(hit, i) in results"
          :key="`${hit.kind}:${hit.id}`"
          class="hit"
          :class="{ active: i === active }"
          role="option"
          :aria-selected="i === active"
          @mouseenter="active = i"
          @click="pick(hit)"
        >
          <span class="hit-main">
            <span class="hit-tags">
              <span class="chip" :class="kindClass[hit.kind]">{{ hit.kindLabel }}</span>
              <span v-if="hit.chapterOrder" class="hit-order">第 {{ hit.chapterOrder }} 章</span>
            </span>
            <span class="hit-title">{{ hit.displayTitle }}</span>
            <span class="hit-snippet">
              <template v-for="(p, j) in parts(hit.snippet)" :key="j">
                <mark v-if="p.hit">{{ p.text }}</mark>
                <template v-else>{{ p.text }}</template>
              </template>
            </span>
          </span>
          <span
            v-if="hit.kind !== 'chapter' && hit.chapterId"
            class="hit-goto"
            role="button"
            tabindex="0"
            title="定位到所属章节"
            @click="gotoChapter(hit, $event)"
            @keydown.enter.prevent="gotoChapter(hit, $event)"
          >
            定位章节
          </span>
        </button>

        <p v-if="q.trim() && !results.length" class="empty">
          没有找到包含「{{ q.trim() }}」的章节、设定或实体。
        </p>
        <p v-else-if="!q.trim()" class="empty">
          输入关键词开始搜索。章节正文、故事大纲、人物、地点、势力、规则、事件、
          伏笔、卷、篇与文风档案都在搜索范围内。
        </p>
        <p v-if="results.length >= 80" class="hint">
          结果较多，只显示前 80 条。换一个更具体的关键词能缩小范围。
        </p>
      </div>

      <!-- 旧设定就地编辑：它属于侧栏的「设定」层，控制台里没有它的位置 -->
      <OutlinePanel
        v-if="editingOutline"
        :outline="editingOutline"
        @close="editingOutline = null"
      />
    </div>
  </div>
</template>

<style scoped>
.modal.search-modal {
  max-width: 720px;
  width: calc(100vw - 32px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.search-head {
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--border);
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
}
.search-results {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.hit {
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  text-align: left;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  color: var(--text);
}
.hit:hover,
.hit.active {
  background: var(--accent-soft);
}
.hit-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hit-tags {
  display: flex;
  align-items: center;
  gap: 6px;
}
.chip {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-2);
}
.chip.k-chapter {
  background: var(--accent-soft);
  color: var(--accent);
}
.chip.k-outline {
  background: var(--warn-soft);
  color: var(--warn);
}
.hit-order {
  font-size: 11px;
  color: var(--text-3);
}
.hit-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hit-snippet {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.hit-snippet mark {
  background: var(--warn-soft);
  color: var(--text);
  border-radius: 2px;
  padding: 0 1px;
}
.hit-goto {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--accent);
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
}
.hit-goto:hover {
  border-color: var(--accent);
}
.empty {
  margin: 0;
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.8;
}
</style>
