import { reactive, computed } from 'vue'
import * as db from '../services/storage'

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

export const BOOK_COLORS = [
  'linear-gradient(135deg,#6d8bff,#4f6ef2)',
  'linear-gradient(135deg,#ff9a8b,#ff6a88)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)',
  'linear-gradient(135deg,#a18cd1,#fbc2eb)',
  'linear-gradient(135deg,#fccb90,#d57eeb)'
]

export const store = reactive({
  books: [],
  bookId: null,
  book: null,
  chapters: [],
  chapterId: null,
  outlines: [],
  loaded: false
})

export const currentChapter = computed(() =>
  store.chapters.find((c) => c.id === store.chapterId) || null
)

export function useBooks() {
  async function init() {
    if (store.loaded) return
    store.books = await db.getBooks()
    store.loaded = true
  }

  async function openBook(id) {
    store.bookId = id
    store.book = store.books.find((b) => b.id === id) || null
    store.chapters = await db.getChapters(id)
    store.outlines = await db.getOutlines(id)
    store.chapterId = store.chapters.length ? store.chapters[0].id : null
  }

  function closeBook() {
    store.bookId = null
    store.book = null
    store.chapters = []
    store.chapterId = null
    store.outlines = []
  }

  // ---------- 书 ----------
  async function createBook({ title, intro = '' }) {
    const now = Date.now()
    const book = {
      id: genId(),
      title: title || '未命名小说',
      intro,
      coverColor: BOOK_COLORS[store.books.length % BOOK_COLORS.length],
      createdAt: now,
      updatedAt: now
    }
    store.books = await db.upsertBook(book)
    await openBook(book.id)
    return book
  }

  async function updateBook(partial) {
    if (!store.book) return
    Object.assign(store.book, partial, { updatedAt: Date.now() })
    store.books = await db.upsertBook(store.book)
  }

  /**
   * 按 id 更新书，不要求这本书正处于打开状态。
   * 书库里的重命名/改封面必须走这条——打开着的可能完全是另一本书。
   */
  async function updateBookById(id, partial) {
    const b = store.books.find((x) => x.id === id)
    if (!b) return null
    Object.assign(b, partial, { updatedAt: Date.now() })
    store.books = await db.upsertBook(b)
    return b
  }

  async function removeBook(id) {
    await db.deleteBook(id)
    store.books = store.books.filter((b) => b.id !== id)
    if (store.bookId === id) closeBook()
  }

  // ---------- 章节 ----------
  function selectChapter(id) {
    if (store.chapters.find((c) => c.id === id)) store.chapterId = id
  }

  /**
   * 建章并写入正文。
   *
   * 建章是「读章节数组 → 追加 → 整数组写回」，因此调用方必须先确保上一章的
   * 最后几笔已经落盘，否则写回的数组会漏掉它们（见 WritingView 的 flush 编排）。
   */
  async function addChapterWithContent(content = '', title = '') {
    const order = store.chapters.length + 1
    const chapter = {
      id: genId(),
      bookId: store.bookId,
      title: title || `新章节 ${order}`,
      content,
      order,
      updatedAt: Date.now()
    }
    store.chapters = await db.upsertChapter(store.bookId, chapter)
    store.chapterId = chapter.id
    return chapter
  }

  async function addChapter() {
    return addChapterWithContent('')
  }

  async function renameChapter(id, title) {
    const c = store.chapters.find((x) => x.id === id)
    if (!c) return
    c.title = title
    c.updatedAt = Date.now()
    store.chapters = await db.upsertChapter(store.bookId, c)
  }

  /** 仅更新内存中的正文（编辑器防抖保存时调用 persistChapter） */
  function setChapterContent(id, content) {
    const c = store.chapters.find((x) => x.id === id)
    if (c) c.content = content
  }

  async function persistChapter(id) {
    const c = store.chapters.find((x) => x.id === id)
    if (!c) return
    c.updatedAt = Date.now()
    store.chapters = await db.upsertChapter(store.bookId, c)
    if (store.book) {
      store.book.updatedAt = Date.now()
      store.books = await db.upsertBook(store.book)
    }
  }

  async function removeChapter(id) {
    store.chapters = await db.deleteChapter(store.bookId, id)
    if (store.chapterId === id) {
      store.chapterId = store.chapters.length ? store.chapters[0].id : null
    }
  }

  async function moveChapter(id, dir) {
    const idx = store.chapters.findIndex((c) => c.id === id)
    const target = idx + dir
    if (idx < 0 || target < 0 || target >= store.chapters.length) return
    const list = [...store.chapters]
    ;[list[idx], list[target]] = [list[target], list[idx]]
    list.forEach((c, i) => (c.order = i + 1))
    store.chapters = list
    await db.saveChapters(store.bookId, list)
  }

  // ---------- 设定 ----------
  async function addOutline({ type, title, content = '' }) {
    const outline = {
      id: genId(),
      bookId: store.bookId,
      type, // 'outline' | 'character' | 'world'
      title,
      content,
      updatedAt: Date.now()
    }
    store.outlines = await db.upsertOutline(store.bookId, outline)
    return outline
  }

  async function updateOutline(id, partial) {
    const o = store.outlines.find((x) => x.id === id)
    if (!o) return
    Object.assign(o, partial, { updatedAt: Date.now() })
    store.outlines = await db.upsertOutline(store.bookId, o)
  }

  async function removeOutline(id) {
    store.outlines = await db.deleteOutline(store.bookId, id)
  }

  return {
    store,
    currentChapter,
    init,
    openBook,
    closeBook,
    createBook,
    updateBook,
    updateBookById,
    removeBook,
    selectChapter,
    addChapter,
    addChapterWithContent,
    renameChapter,
    setChapterContent,
    persistChapter,
    removeChapter,
    moveChapter,
    addOutline,
    updateOutline,
    removeOutline
  }
}
