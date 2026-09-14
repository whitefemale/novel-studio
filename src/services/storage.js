import { get, set, del, createStore } from 'idb-keyval'

// 独立的 IndexedDB 库，与浏览器默认库隔离，避免与其它站点数据混用
const store = createStore('novel-studio-db', 'novel-store')

const KEY_BOOKS = 'books'
const KEY_SETTINGS = 'settings'
const chaptersKey = (bookId) => `chapters:${bookId}`
const outlinesKey = (bookId) => `outlines:${bookId}`

// Vue reactive 代理对象无法被 IndexedDB 结构化克隆，写入前统一转纯 JSON
function toPlain(v) {
  return JSON.parse(JSON.stringify(v))
}

// ---------------------------------------------------------------------------
// 写队列：把「读 → 改 → 写」按 key 串行化。
// 同一本书的章节正文至少有两条并发写路径——自动保存，以及建章 / 移动章节
// 这类整数组回写。若两者交叠，后完成的一方会拿自己那份陈旧快照整体覆盖，
// 前者的改动就没了。串行化后这个竞态从「靠记得 await 的约定」变成结构性安全。
// ---------------------------------------------------------------------------
const writeChains = new Map()

function serialize(key, fn) {
  const prev = writeChains.get(key) || Promise.resolve()
  // 前一个任务失败不应阻断后续写入，故 onRejected 也接同一个 fn
  const next = prev.then(fn, fn)
  // 队列尾部始终是「已消化」的 Promise，避免未处理的 rejection 挂在链上
  writeChains.set(key, next.then(() => {}, () => {}))
  return next
}

// ---------------------------------------------------------------------------
// 作用域守卫：bookId 为空说明书已经关闭。
// 编辑器在 onBeforeUnmount 里做的最后冲刷是即发即忘、无法向上报错的路径，
// 若此时 store.bookId 已被清空，写入会落到 `chapters:null` 这类垃圾键上，
// 既污染数据库又静默丢掉最后一笔正文。读返回空、写仅告警，是唯一可靠的兜底。
// ---------------------------------------------------------------------------
function warnNoBook() {
  console.warn('[storage] 缺少 bookId，已忽略本次操作')
}

// ---------- 书籍 ----------
export async function getBooks() {
  return (await get(KEY_BOOKS, store)) || []
}

async function writeBooks(books) {
  await set(KEY_BOOKS, toPlain(books), store)
}

export async function saveBooks(books) {
  return serialize(KEY_BOOKS, () => writeBooks(books))
}

export async function upsertBook(book) {
  return serialize(KEY_BOOKS, async () => {
    const books = await getBooks()
    const idx = books.findIndex((b) => b.id === book.id)
    if (idx >= 0) books[idx] = book
    else books.unshift(book)
    await writeBooks(books)
    return books
  })
}

export async function deleteBook(bookId) {
  if (!bookId) return warnNoBook()
  await serialize(KEY_BOOKS, async () => {
    const books = await getBooks()
    await writeBooks(books.filter((b) => b.id !== bookId))
  })
  await del(chaptersKey(bookId), store)
  await del(outlinesKey(bookId), store)
}

// ---------- 章节 ----------
export async function getChapters(bookId) {
  if (!bookId) return []
  return (await get(chaptersKey(bookId), store)) || []
}

async function writeChapters(bookId, chapters) {
  await set(chaptersKey(bookId), toPlain(chapters), store)
}

export async function saveChapters(bookId, chapters) {
  if (!bookId) return warnNoBook()
  return serialize(chaptersKey(bookId), () => writeChapters(bookId, chapters))
}

export async function upsertChapter(bookId, chapter) {
  if (!bookId) {
    warnNoBook()
    return []
  }
  return serialize(chaptersKey(bookId), async () => {
    const chapters = await getChapters(bookId)
    const idx = chapters.findIndex((c) => c.id === chapter.id)
    if (idx >= 0) chapters[idx] = chapter
    else chapters.push(chapter)
    chapters.sort((a, b) => a.order - b.order)
    await writeChapters(bookId, chapters)
    return chapters
  })
}

export async function deleteChapter(bookId, chapterId) {
  if (!bookId) {
    warnNoBook()
    return []
  }
  return serialize(chaptersKey(bookId), async () => {
    const chapters = await getChapters(bookId)
    const rest = chapters.filter((c) => c.id !== chapterId)
    // 重排 order
    rest.forEach((c, i) => (c.order = i + 1))
    await writeChapters(bookId, rest)
    return rest
  })
}

// ---------- 设定（大纲/人物/世界观） ----------
export async function getOutlines(bookId) {
  if (!bookId) return []
  return (await get(outlinesKey(bookId), store)) || []
}

async function writeOutlines(bookId, outlines) {
  await set(outlinesKey(bookId), toPlain(outlines), store)
}

export async function saveOutlines(bookId, outlines) {
  if (!bookId) return warnNoBook()
  return serialize(outlinesKey(bookId), () => writeOutlines(bookId, outlines))
}

export async function upsertOutline(bookId, outline) {
  if (!bookId) {
    warnNoBook()
    return []
  }
  return serialize(outlinesKey(bookId), async () => {
    const outlines = await getOutlines(bookId)
    const idx = outlines.findIndex((o) => o.id === outline.id)
    if (idx >= 0) outlines[idx] = outline
    else outlines.push(outline)
    await writeOutlines(bookId, outlines)
    return outlines
  })
}

export async function deleteOutline(bookId, outlineId) {
  if (!bookId) {
    warnNoBook()
    return []
  }
  return serialize(outlinesKey(bookId), async () => {
    const outlines = await getOutlines(bookId)
    const rest = outlines.filter((o) => o.id !== outlineId)
    await writeOutlines(bookId, rest)
    return rest
  })
}

// ---------- 设置 ----------
export async function getSettings() {
  return (await get(KEY_SETTINGS, store)) || null
}
export async function saveSettings(settings) {
  await set(KEY_SETTINGS, toPlain(settings), store)
}

// ---------- 维护 ----------
// 下面两个函数绕过 bookId 守卫，直接操作原始键，仅供冒烟测试使用。
// 有了它们，测试才能判断「某个键到底存不存在」——走 getChapters(null) 是
// 判断不出来的：守卫让它恒返回 []，键不存在时也是 []，断言会恒真。

/** 读取一个原始键；键不存在返回 undefined（不是 []，以便与空数组区分） */
export async function rawGet(key) {
  return await get(key, store)
}

/** 直接删除一个原始键。用于清理早期缺陷留下的 `chapters:null` 脏数据 */
export async function rawDelete(key) {
  await del(key, store)
}
