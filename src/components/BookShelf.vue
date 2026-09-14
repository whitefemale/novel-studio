<script setup>
import { ref, computed } from 'vue'
import { useBooks, BOOK_COLORS } from '../store/books'
import { toast } from '../store/toast'

const emit = defineEmits(['open'])
const { store, createBook, removeBook, updateBookById } = useBooks()

const showCreate = ref(false)
const newTitle = ref('')
const newIntro = ref('')
const confirmDeleteId = ref(null)

// 编辑弹窗。存 id 而不是对象引用：列表重排后引用可能已经失效。
const editingId = ref(null)
const editForm = ref({ title: '', intro: '', coverColor: '' })

const keyword = ref('')
const sortBy = ref('updated') // 'updated' | 'created' | 'title'

/**
 * 列表渲染走这份 computed，store.books 的原始顺序保持不动
 * （新建时 unshift，books.js 依赖它来循环取封面配色）。
 */
const filteredBooks = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  let list = store.books
  if (kw) {
    list = list.filter(
      (b) =>
        (b.title || '').toLowerCase().includes(kw) ||
        (b.intro || '').toLowerCase().includes(kw)
    )
  }
  const arr = [...list]
  if (sortBy.value === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'))
  } else if (sortBy.value === 'created') {
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  } else {
    arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  return arr
})

function openCreate() {
  newTitle.value = ''
  newIntro.value = ''
  showCreate.value = true
}

async function submitCreate() {
  if (!newTitle.value.trim()) {
    toast('请填写书名', 'error')
    return
  }
  await createBook({ title: newTitle.value.trim(), intro: newIntro.value.trim() })
  showCreate.value = false
  toast('已创建小说', 'success')
  emit('open', store.book.id)
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function onDelete(book) {
  if (!book) return
  await removeBook(book.id)
  confirmDeleteId.value = null
  toast('已删除', 'success')
}

function openEdit(book) {
  editingId.value = book.id
  editForm.value = {
    title: book.title || '',
    intro: book.intro || '',
    coverColor: book.coverColor || BOOK_COLORS[0]
  }
}

async function saveEdit() {
  if (!editingId.value) return
  if (!editForm.value.title.trim()) {
    toast('请填写书名', 'error')
    return
  }
  // 必须按 id 更新：打开的可能是完全另一本书
  await updateBookById(editingId.value, {
    title: editForm.value.title.trim(),
    intro: editForm.value.intro,
    coverColor: editForm.value.coverColor
  })
  editingId.value = null
  toast('已保存', 'success')
}
</script>

<template>
  <div class="shelf">
    <div class="shelf-head">
      <h2>我的小说</h2>
      <div class="shelf-tools">
        <input
          v-if="store.books.length"
          v-model="keyword"
          class="input search-input"
          placeholder="搜索书名或简介…"
          aria-label="搜索小说"
        />
        <select
          v-if="store.books.length"
          v-model="sortBy"
          class="select sort-select"
          aria-label="排序方式"
        >
          <option value="updated">最近更新</option>
          <option value="created">创建时间</option>
          <option value="title">书名</option>
        </select>
        <button class="btn primary" @click="openCreate">＋ 新建小说</button>
      </div>
    </div>

    <div v-if="filteredBooks.length" class="shelf-grid">
      <div
        v-for="book in filteredBooks"
        :key="book.id"
        class="book-card"
        @click="emit('open', book.id)"
      >
        <div class="cover" :style="{ background: book.coverColor }">
          <span class="cover-title">{{ (book.title || '未命名').slice(0, 4) }}</span>
        </div>
        <div class="meta">
          <div class="title-row">
            <span class="title">{{ book.title }}</span>
            <span class="card-ops">
              <button
                class="btn ghost sm edit-btn"
                title="编辑"
                aria-label="编辑小说"
                @click.stop="openEdit(book)"
              >
                ✎
              </button>
              <button
                class="btn ghost sm danger del-btn"
                title="删除"
                aria-label="删除小说"
                @click.stop="confirmDeleteId = book.id"
              >
                ✕
              </button>
            </span>
          </div>
          <p class="intro">{{ book.intro || '暂无简介' }}</p>
          <p class="time">{{ fmtTime(book.updatedAt) }} 更新</p>
        </div>
      </div>
    </div>

    <div v-else-if="store.books.length" class="empty">
      <div class="icon">🔍</div>
      <h3>没有匹配的小说</h3>
      <p>试试换个关键词。</p>
      <button class="btn" @click="keyword = ''">清除搜索</button>
    </div>

    <div v-else class="empty">
      <div class="icon">📖</div>
      <h3>还没有小说</h3>
      <p>点击「新建小说」，然后让 AI 帮你生成大纲、续写章节，开始创作之旅。</p>
      <button class="btn primary" @click="openCreate">＋ 新建第一本小说</button>
    </div>

    <!-- 新建弹窗 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-header">
          <h3>新建小说</h3>
          <button class="btn ghost sm" aria-label="关闭" @click="showCreate = false">✕</button>
        </div>
        <div class="modal-body">
          <label class="label">书名</label>
          <input
            v-model="newTitle"
            class="input"
            placeholder="例如：剑与星辰"
            @keydown.enter="submitCreate"
          />
          <div style="height: 14px"></div>
          <label class="label">一句话简介 / 创意点（可选）</label>
          <textarea
            v-model="newIntro"
            class="textarea"
            rows="3"
            placeholder="例如：一个穿越到修真世界的现代程序员，用代码改写整个修炼体系……"
          ></textarea>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showCreate = false">取消</button>
          <button class="btn primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（替代已失效的 window.prompt 重命名） -->
    <div v-if="editingId" class="modal-mask" @click.self="editingId = null">
      <div class="modal">
        <div class="modal-header">
          <h3>编辑小说</h3>
          <button class="btn ghost sm" aria-label="关闭" @click="editingId = null">✕</button>
        </div>
        <div class="modal-body">
          <label class="label">书名</label>
          <input v-model="editForm.title" class="input" @keydown.enter="saveEdit" />
          <div style="height: 14px"></div>
          <label class="label">一句话简介</label>
          <textarea v-model="editForm.intro" class="textarea" rows="3"></textarea>
          <div style="height: 14px"></div>
          <label class="label">封面配色</label>
          <div class="swatches">
            <button
              v-for="c in BOOK_COLORS"
              :key="c"
              class="swatch"
              :class="{ active: editForm.coverColor === c }"
              :style="{ background: c }"
              aria-label="选择封面配色"
              @click="editForm.coverColor = c"
            ></button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="editingId = null">取消</button>
          <button class="btn primary" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="confirmDeleteId" class="modal-mask" @click.self="confirmDeleteId = null">
      <div class="modal">
        <div class="modal-header">
          <h3>删除小说</h3>
        </div>
        <div class="modal-body">
          <p style="margin: 0">
            删除后将同时清除该书所有章节与设定，且不可恢复。确定删除《{{
              store.books.find((b) => b.id === confirmDeleteId)?.title
            }}》吗？
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="confirmDeleteId = null">取消</button>
          <button
            class="btn danger"
            @click="onDelete(store.books.find((b) => b.id === confirmDeleteId))"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shelf {
  height: 100%;
  overflow: auto;
  padding: 26px 32px 40px;
}
.shelf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.shelf-head h2 {
  margin: 0;
  font-size: 18px;
}
.shelf-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.search-input {
  width: 200px;
}
.sort-select {
  width: auto;
}
.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 16px;
}
.book-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
  cursor: pointer;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}
.cover {
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover-title {
  color: #fff;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}
.meta {
  padding: 12px 14px 14px;
}
.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.title {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.edit-btn,
.del-btn {
  flex-shrink: 0;
  opacity: 0;
}
.intro {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 34px;
}
.time {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.swatches {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.swatch {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 2px solid transparent;
}
.swatch.active {
  border-color: var(--text);
}

/*
 * 纯装饰性的 hover 只在真有指针的设备上启用。
 * 触屏上 hover 会「粘住」：点一下卡片，阴影和位移就卡在那里不还原。
 */
@media (hover: hover) {
  .book-card:hover {
    box-shadow: var(--shadow);
    transform: translateY(-2px);
  }
  .book-card:hover .edit-btn,
  .book-card:hover .del-btn {
    opacity: 1;
  }
}

/*
 * 触屏设备没有 hover，两个按钮会永远 opacity:0 —— 等于删书和编辑
 * 在手机/平板上完全不可达。这里改为常显，并放大点击目标。
 */
@media (hover: none) {
  .edit-btn,
  .del-btn {
    opacity: 1;
    min-width: 40px;
    min-height: 40px;
  }
  .search-input {
    width: 100%;
  }
}
</style>
