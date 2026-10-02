import { get, set, del, keys, createStore } from 'idb-keyval'

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
  // 先落整书墓碑，再删数据 —— 与 per-record 墓碑同一个理由（见 makeCollection）。
  // 第二阶段同步时，设备 B 需要凭它知道「这本书在设备 A 上被删了」。
  await addBookTombstone(bookId)
  await serialize(KEY_BOOKS, async () => {
    const books = await getBooks()
    await writeBooks(books.filter((b) => b.id !== bookId))
  })
  // 上面两行是 V1 就有的写法，保持逐字不动；下面补 V2 集合的级联。
  await del(chaptersKey(bookId), store)
  await del(outlinesKey(bookId), store)
  for (const name of COLLECTIONS) await del(collKey(name, bookId), store)
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
    const target = chapters.find((c) => c.id === chapterId)
    // 先记墓碑再删（理由见 makeCollection.remove 的注释）。只在确实存在时记：
    // 给一条不存在的记录记墓碑，会在同步时误删另一台设备上刚建、还没同步过来的
    // 同 id 记录 —— 概率极低，但方向是错的。
    if (target) await addTombstone(bookId, 'chapters', chapterId)
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
    if (outlines.some((o) => o.id === outlineId)) {
      await addTombstone(bookId, 'outlines', outlineId)
    }
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

// ---------------------------------------------------------------------------
// V2：通用 per-book 集合
//
// V2 要加十余个按书隔离的集合（人物、地点、势力、世界规则、时间线、伏笔……）。
// 逐个照抄上面那三段 outline 代码会失控，更糟的是容易漏掉 serialize —— 而漏掉
// serialize 意味着并发写互相覆盖（见文件顶部写队列那段注释），这种缺陷不报错，
// 只是静默丢数据。故用工厂把三件事固化成结构性保证，而不是「记得加」的约定：
//   serialize(collKey(...)) + toPlain() + !bookId 守卫
//
// 既有的 chapters / outlines 函数**不迁移**到这套工厂：它们的排序与重编号行为
// 被 48 项冒烟断言钉着，重写只有风险没有收益。这份重复是有意的。
// ---------------------------------------------------------------------------

/** 所有 V2 per-book 集合名。deleteBook 按这份清单级联删键。 */
export const COLLECTIONS = [
  'volumes',
  'arcs',
  'characters',
  'locations',
  'factions',
  'worldRules',
  'events',
  'foreshadowing',
  'generationRuns',
  'reviewQueue',
  // 章节版本（正文的历史副本）。它在这里而不在 chapters 里，是因为它必须能
  // **按章追加、按章裁剪**，而 chapters 是整数组键、被一堆断言钉着行为。
  // 放进这份清单的收益是结构性的：serialize / toPlain / !bookId 守卫由工厂保证，
  // deleteBook 的级联删键自动覆盖它，snapshot.js 的 DATA_COLLECTIONS 由这里派生
  // 因而版本自动进全量备份与设备同步 —— 三处都不用各自记得加一遍。
  'chapterVersions',
  'tombstones'
]

export const collKey = (name, bookId) => `${name}:${bookId}`

async function readTombstones(bookId) {
  return (await get(collKey('tombstones', bookId), store)) || []
}

/**
 * 记一条墓碑。
 *
 * 删除的表示方式全库只有这一种：**不给记录加 deleted 标记**。给记录加标记的
 * 代价是每个列表渲染都要记得过滤，漏一处就会把已经删掉的人物显示出来；
 * 而独立一张 `tombstones:{bookId}` 表里记 { id, type, deletedAt }，getAll 天然
 * 只返回活记录，渲染层零改动。
 *
 * 它同时覆盖 chapters / outlines 这两个走整数组硬删除的老集合（见 deleteChapter /
 * deleteOutline）。这一条不是锦上添花：章节恰恰是用户删得最多的东西，缺了它的
 * 话，第二阶段设备同步里「删掉的章节在手机上复活」会是最刺眼也最难查的缺陷。
 */
export async function addTombstone(bookId, type, id, deletedAt = Date.now()) {
  if (!bookId || !id) return warnNoBook()
  return serialize(collKey('tombstones', bookId), async () => {
    const list = await readTombstones(bookId)
    // 同一条记录重复记墓碑时保留**最早**的时间戳：删除时刻一旦确定就不该被刷新，
    // 否则同步时旧墓碑会看起来比新记录还新，把记录又删一次。
    if (!list.some((t) => t.type === type && t.id === id)) list.push({ id, type, deletedAt })
    await set(collKey('tombstones', bookId), toPlain(list), store)
    return list
  })
}

export async function getTombstones(bookId) {
  if (!bookId) return []
  return readTombstones(bookId)
}

function makeCollection(name) {
  const key = (bookId) => collKey(name, bookId)
  const read = async (bookId) => (await get(key(bookId), store)) || []

  async function getAll(bookId) {
    if (!bookId) return []
    return read(bookId)
  }

  /** 整组回写。快照恢复与迁移用；调用方负责传完整列表。 */
  async function saveAll(bookId, list) {
    if (!bookId) return warnNoBook()
    return serialize(key(bookId), async () => {
      await set(key(bookId), toPlain(list), store)
      return list
    })
  }

  async function upsert(bookId, item) {
    if (!bookId) {
      warnNoBook()
      return []
    }
    return serialize(key(bookId), async () => {
      const list = await read(bookId)
      const idx = list.findIndex((r) => r.id === item.id)
      if (idx >= 0) list[idx] = item
      else list.push(item)
      // 卷 / 篇这类有显式次序的集合按 order 排；其余保持插入序
      if (list.some((r) => typeof r.order === 'number')) list.sort((a, b) => a.order - b.order)
      await set(key(bookId), toPlain(list), store)
      return list
    })
  }

  /**
   * 原子地读-改-写一次：`fn(当前列表)` 返回新列表。
   *
   * 有些改动不是「加一条」或「换一条」，而是对**整个列表**做一次计算——例如章节
   * 版本的按章裁剪。用 getAll + saveAll 拼在外面会有一个真实存在的竞态：两次
   * 捕获并发时，后一次裁剪的依据是过期快照，会把前一次刚存下的那一版裁掉。
   * 放进 serialize 里就没有这个窗口。
   *
   * 约束：**fn 内不得调用任何写同一个 key 的存储函数**（同 key 嵌套会自锁，
   * 见 CLAUDE.md 坑 #8）。
   */
  async function update(bookId, fn) {
    if (!bookId) {
      warnNoBook()
      return []
    }
    return serialize(key(bookId), async () => {
      const next = fn((await read(bookId)) || [])
      await set(key(bookId), toPlain(next), store)
      return next
    })
  }

  /**
   * 删除。顺序是刻意的：**先落墓碑，再从数组里摘掉记录**。
   *
   * 两个键的写入不是原子的（serialize 按 key 排队，跨键没有事务），所以必须
   * 选一个失败方向。墓碑成功而删除失败，只留下一条「删一条已不存在的记录」的
   * 多余墓碑，同步时无害；反过来的失败则让删掉的记录没有任何删除痕迹，
   * 下次同步就会在另一台设备上复活。
   */
  async function remove(bookId, id) {
    if (!bookId) {
      warnNoBook()
      return []
    }
    await addTombstone(bookId, name, id)
    return serialize(key(bookId), async () => {
      const rest = (await read(bookId)).filter((r) => r.id !== id)
      await set(key(bookId), toPlain(rest), store)
      return rest
    })
  }

  return { name, key, getAll, saveAll, upsert, update, remove }
}

/** 按名字取集合：coll.characters.upsert(bookId, {…}) */
export const coll = Object.fromEntries(COLLECTIONS.map((n) => [n, makeCollection(n)]))

// ---------- 库级元数据 ----------

const KEY_META = 'meta'

/**
 * 库级元数据（schemaVersion 等）。
 *
 * 刻意不放进 settings：settings.load() 会把缺失的键回填成默认值，
 * 一个被回填出来的 schemaVersion 是恒假的，而它恰恰要用来判断要不要升级。
 */
export async function getMeta() {
  return (await get(KEY_META, store)) || null
}

export async function saveMeta(meta) {
  return serialize(KEY_META, async () => {
    await set(KEY_META, toPlain(meta), store)
    return meta
  })
}

// ---------- 整书墓碑 ----------

const KEY_BOOK_TOMBSTONES = 'bookTombstones'

/** 整书删除的墓碑。全局键而非 per-book —— 书都没了，没有 bookId 可挂。 */
export async function addBookTombstone(bookId, deletedAt = Date.now()) {
  if (!bookId) return warnNoBook()
  return serialize(KEY_BOOK_TOMBSTONES, async () => {
    const list = (await get(KEY_BOOK_TOMBSTONES, store)) || []
    if (!list.some((t) => t.id === bookId)) list.push({ id: bookId, type: 'books', deletedAt })
    await set(KEY_BOOK_TOMBSTONES, toPlain(list), store)
    return list
  })
}

export async function getBookTombstones() {
  return (await get(KEY_BOOK_TOMBSTONES, store)) || []
}

/** 列出库里所有原始键。rawGet 需要逐个键名，这里给全量（快照与测试用）。 */
export async function listRawKeys() {
  return (await keys(store)) || []
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
