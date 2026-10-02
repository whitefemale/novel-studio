import { reactive, computed } from 'vue'
import * as db from '../services/storage'
import { genId } from '../services/ids'
import { countWords } from '../services/wordCount'
import { captureVersion, sortVersions } from '../services/novel/versioning'
import { settings } from './settings'

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
  // 章节版本（正文的历史副本）。它是 per-book 的领域状态，所以放在这里而不是
  // 另起一个单例：控制台的标签徽标与版本面板看的是同一批数据，各自的副本一定会
  // 分叉；放在 store 上还能让「打开书 / 关书」这两处顺手把它带上，不必每个用到
  // 它的组件自己记得载入与清空。
  versions: [],
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
    store.versions = sortVersions(await db.coll.chapterVersions.getAll(id))
    store.chapterId = store.chapters.length ? store.chapters[0].id : null
  }

  function closeBook() {
    store.bookId = null
    store.book = null
    store.chapters = []
    store.chapterId = null
    store.outlines = []
    store.versions = []
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
  async function addChapterWithContent(content = '', title = '', extra = {}) {
    const order = store.chapters.length + 1
    // 编排器提取出的 summary / timelineEnd 从 extra 进来。身份与位置字段一律由本函数
    // 说了算：建章时被覆盖 id/order，新章节会挤掉别人或落到另一本书里，而且现象是
    // 「某章莫名消失」，不会有人想到是这里。
    const meta = { ...extra }
    for (const k of ['id', 'bookId', 'content', 'order', 'createdAt', 'updatedAt']) delete meta[k]
    const chapter = {
      id: genId(),
      bookId: store.bookId,
      title: title || `新章节 ${order}`,
      content,
      order,
      // V2 字段：都在建章时给默认值，这样 Context Builder 不必到处判 undefined，
      // 旧章节读出来缺这些字段时同样是 undefined，两处口径一致。
      arcId: null, // 所属篇；卷通过篇间接关联
      summary: '', // 本章摘要，写完后由编排器回填，供后续章节当上下文
      purpose: '', // 本章要完成什么（与「大纲」的区别：这是写给 AI 的硬约束）
      status: 'draft', // 'draft' | 'done'
      timelineStart: '', // 故事内时间，纯文本，如「第三天清晨」
      timelineEnd: '',
      wordCount: countWords(content).total,
      ...meta, // 见上：只有 summary / timelineEnd 这类元数据能从这里进来
      updatedAt: Date.now()
    }
    store.chapters = await db.upsertChapter(store.bookId, chapter)
    store.chapterId = chapter.id
    return chapter
  }

  async function addChapter() {
    return addChapterWithContent('')
  }

  /**
   * 更新章节的**元数据**：摘要、本章目标、状态、故事内时间。
   *
   * 正文不从这里改 —— 正文一律走 setChapterContent + persistChapter。
   * 两条路都能写 content 的话，自动保存的「待保存 id」与正文的真相来源就对不上了，
   * 而且这里的整数组写回会盖掉编辑器里还没落盘的那几笔（CLAUDE.md 坑 #8）。
   */
  async function updateChapter(id, partial) {
    const c = store.chapters.find((x) => x.id === id)
    if (!c || !store.bookId) return null
    // 拷一份再删：不能就地改调用方传进来的对象
    const patch = { ...partial }
    for (const k of ['content', 'id', 'bookId', 'order']) delete patch[k]
    Object.assign(c, patch, { updatedAt: Date.now() })
    store.chapters = await db.upsertChapter(store.bookId, c)
    return c
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
    // 字数与正文一起落盘。放在这里而不是编辑器里：编辑器的字数只是屏幕上的数字，
    // 落了库才能在书库/章节列表里排序与筛选，也让旧的章节在下次保存时补上这个字段。
    c.wordCount = countWords(c.content).total
    store.chapters = await db.upsertChapter(store.bookId, c)
    if (store.book) {
      store.book.updatedAt = Date.now()
      store.books = await db.upsertBook(store.book)
    }
  }

  // ---------- 章节版本 ----------

  /** 重新从库里读回版本列表。同步合并之后也要跑一次，否则界面还是旧的。 */
  async function loadVersions() {
    if (!store.bookId) {
      store.versions = []
      return store.versions
    }
    store.versions = sortVersions(await db.coll.chapterVersions.getAll(store.bookId))
    return store.versions
  }

  /**
   * 给某章的**当前正文**存一版历史。
   *
   * 调用者必须在正文被改动**之前**调用它 —— 传进来的是此刻 store 里的内容，
   * 而 store 里的正文是同步改的（编辑器与 AI 面板都走 setChapterContent），
   * 晚一步拿到的就已经是被覆盖后的新正文了，那样存下来的版本毫无价值。
   *
   * 顺带刷新版本列表：裁剪可能在这次写入里发生（超过 versionKeep 时最旧的被丢掉），
   * 而界面上的徽标与列表都读 store.versions，不刷就会显示一条已经不存在的版本。
   */
  async function captureChapterVersion(id, { source = 'manual', generationRunId = null } = {}) {
    const c = store.chapters.find((x) => x.id === id)
    if (!c || !store.bookId) return null
    const rec = await captureVersion({
      bookId: store.bookId,
      chapterId: c.id,
      chapterTitle: c.title,
      content: c.content,
      source,
      generationRunId,
      keep: settings.versionKeep
    })
    if (rec) await loadVersions()
    return rec
  }

  /**
   * 回滚到某一版。
   *
   * 两件事是这条路径的全部要点：
   * - **先把当前正文存一版**（source: 'rollback'）。不存的话回滚不可撤销 ——
   *   用户点错一次就再也回不到刚才那一版，而「刚才那一版」往往是他刚写完的。
   * - **走 persistChapter 而不是 updateChapter**：updateChapter 明确不收 content，
   *   正文的真相来源只有 setChapterContent + persistChapter 这一条（见它的注释）。
   *
   * 章节已被删除的版本（来自「删除前」那一版）没有可回滚的目标，改为恢复成新章节。
   */
  async function restoreChapterVersion(version) {
    if (!version || !store.bookId) return null
    const c = store.chapters.find((x) => x.id === version.chapterId)
    if (!c) {
      return addChapterWithContent(version.content || '', version.chapterTitle || '')
    }
    await captureChapterVersion(c.id, { source: 'rollback' })
    c.content = version.content || ''
    c.wordCount = countWords(c.content).total
    await persistChapter(c.id)
    await loadVersions()
    return c
  }

  async function removeChapter(id) {
    // 删章前存一版。章节走的是硬删除（数组里直接没了），版本是**误删救回的唯一入口**；
    // 这条比 AI 覆盖那条更有价值 —— 覆盖至少还有个新版本，删除什么都不剩。
    await captureChapterVersion(id, { source: 'delete' })
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
    updateChapter,
    renameChapter,
    setChapterContent,
    persistChapter,
    loadVersions,
    captureChapterVersion,
    restoreChapterVersion,
    removeChapter,
    moveChapter,
    addOutline,
    updateOutline,
    removeOutline
  }
}
