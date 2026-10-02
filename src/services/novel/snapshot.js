import * as db from '../storage'
import { SCHEMA_VERSION } from '../migration'

/**
 * 全量快照：整库导出成一个 .json，以及从 .json 合并回来。
 *
 * 它有两重身份，这是刻意的：
 *
 * 1. **对用户**：整库备份——换机、重装、怕丢稿，一键导出/恢复。
 * 2. **对第二阶段**：设备间同步的协议本体。手机与电脑之间传的就是这个对象，
 *    差别只在传输方式（局域网 HTTP vs 存成文件）。所以这里定的合并规则
 *    就是将来同步的合并规则，**本轮必须测到**——否则第二阶段要连规则一起重做。
 *
 * 合并规则是「逐记录后写覆盖 + 墓碑判死」，三条：
 *   - 同一条记录（同 id）两边都有 → `updatedAt` 大的赢，相等时保留本地；
 *   - 删除不靠「记录不见了」表示，而靠墓碑。**墓碑新于记录 → 删除生效；
 *     墓碑旧于记录 → 记录活着**（那说明删掉之后又被编辑过，等于复活）；
 *   - 墓碑本身按「同一条只保留最早的删除时刻」合并，与 storage.addTombstone
 *     的策略一致——删除时刻一旦确定就不该被刷新。
 *
 * 为什么不用「整库替换」实现恢复：那会让「我在手机上刚写的一章，被一个三天前的
 * 电脑备份覆盖掉」变成一个静默的数据丢失。合并只会让人有得有失，不会让已有的
 * 东西凭空消失，前提是**用户能在确认步骤里看到会发生什么**（见 diffSnapshots）。
 */

export const SNAPSHOT_FORMAT = 'novel-studio-snapshot'
/**
 * 快照自身的格式版本，与 SCHEMA_VERSION（领域模型版本）是两件事：
 * 一个是「这个文件长什么样」，一个是「里面的记录有哪些字段」。分开之后，
 * 新增实体集合不必改文件格式，改文件格式也不必假装迁移了领域模型。
 */
export const SNAPSHOT_VERSION = 1

/** 快照里逐书保存的集合。与 storage.COLLECTIONS 同源，只是排除了 tombstones（单独处理）。 */
const DATA_COLLECTIONS = db.COLLECTIONS.filter((n) => n !== 'tombstones')

/** 空快照。恢复的目标结构，也是合并的零元。 */
export function emptySnapshot(exportedAt = 0) {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    books: [],
    data: {},
    bookTombstones: []
  }
}

/** 纯组装。I/O 由 collectSnapshot 负责，这里只为可确定性单测。 */
export function buildSnapshot(
  { books = [], data = {}, bookTombstones = [] } = {},
  exportedAt = Date.now()
) {
  const out = emptySnapshot(exportedAt)
  out.books = [...books]
  out.data = {}
  for (const [bookId, sets] of Object.entries(data)) {
    out.data[bookId] = { tombstones: [], ...sets }
  }
  out.bookTombstones = [...bookTombstones]
  return out
}

// ---------------- 合并（纯函数） ----------------

const tstamp = (r) => Number(r?.updatedAt ?? r?.createdAt ?? 0) || 0

/**
 * 同 id 逐记录合并。**相等时保留本地**：两边时间戳一样说明要么是同一条记录被分别
 * 传播过，要么时钟粗到同一毫秒，此时任选一方都不比另一方更对，而「本地优先」
 * 至少保证重复恢复同一个文件不会让本机数据来回抖动。
 */
export function mergeRecords(local = [], remote = []) {
  const byId = new Map()
  for (const r of local || []) if (r && r.id) byId.set(r.id, r)
  for (const r of remote || []) {
    if (!r || !r.id) continue
    const cur = byId.get(r.id)
    if (!cur || tstamp(r) > tstamp(cur)) byId.set(r.id, r)
  }
  return [...byId.values()]
}

/** 墓碑合并：同 (type,id) 只留最早的删除时刻。 */
export function mergeTombstones(local = [], remote = []) {
  const map = new Map()
  for (const t of [...(local || []), ...(remote || [])]) {
    if (!t || !t.id) continue
    const k = `${t.type || ''}:${t.id}`
    const cur = map.get(k)
    if (!cur || Number(t.deletedAt) < Number(cur.deletedAt)) map.set(k, t)
  }
  return [...map.values()]
}

/**
 * 墓碑判死：删得比最后一次编辑晚，记录才算真的没了。
 *
 * 注意判据是「墓碑 >= 记录」，用 `>=` 而非 `>`：删除与编辑落在同一毫秒时，
 * 把记录留下会让「删了又冒出来」变成用户能看到的 bug，而把记录删掉最多是
 * 丢掉一次同毫秒的编辑——两个方向都不完美，选危害小的那个。
 */
export function applyTombstones(records = [], tombstones = []) {
  if (!tombstones.length) return records || []
  const dead = new Map()
  for (const t of tombstones) {
    if (!t || !t.id) continue
    const prev = dead.get(t.id)
    if (prev == null || Number(t.deletedAt) > prev) dead.set(t.id, Number(t.deletedAt))
  }
  return (records || []).filter((r) => {
    if (!r || !r.id) return false
    const d = dead.get(r.id)
    return d == null || d < tstamp(r)
  })
}

/**
 * 合并两个快照。**纯函数**，不改动入参。
 *
 * 单向（本地 ← 远端）与双向对称是同一份代码：合并结果对两边都成立，
 * 于是「恢复备份」与第二阶段的「设备合并」用的是同一条路径。
 */
export function mergeSnapshot(local, remote) {
  const a = local || emptySnapshot()
  const b = remote || emptySnapshot()
  const out = emptySnapshot(Math.max(Number(a.exportedAt) || 0, Number(b.exportedAt) || 0))

  const bookTombs = mergeTombstones(a.bookTombstones, b.bookTombstones)
  const mergedBooks = mergeRecords(a.books, b.books)
  out.bookTombstones = bookTombs
  // 整书墓碑与逐书墓碑同一条规则：删得比书的最后修改晚，这本书才算没了
  out.books = applyTombstones(mergedBooks, bookTombs)

  // 被整书墓碑删掉的书，它的 per-book 数据一并不带进结果 ——
  // 留着的话恢复之后会「书没了但人物还在」，而那些人永远没有入口可以删。
  const alive = new Set(out.books.map((x) => x.id))
  const gone = new Set(mergedBooks.filter((x) => !alive.has(x.id)).map((x) => x.id))

  const ids = new Set([...Object.keys(a.data || {}), ...Object.keys(b.data || {})])
  for (const bookId of ids) {
    if (gone.has(bookId)) continue
    const la = (a.data || {})[bookId] || {}
    const lb = (b.data || {})[bookId] || {}
    const merged = {}
    // 章节与设定不在 COLLECTIONS 里，但同样要过合并 —— 它们恰恰是数据的主体
    for (const name of ['chapters', 'outlines', ...DATA_COLLECTIONS]) {
      merged[name] = mergeRecords(la[name], lb[name])
    }
    const tombs = mergeTombstones(la.tombstones, lb.tombstones)
    merged.tombstones = tombs
    for (const name of ['chapters', 'outlines', ...DATA_COLLECTIONS]) {
      merged[name] = applyTombstones(merged[name], tombs)
    }
    out.data[bookId] = merged
  }
  return out
}

// ---------------- 只读统计（纯函数） ----------------

/** 快照内容概览：给「确认恢复」那一步显示「这个文件里有什么」。 */
export function snapshotStats(snap) {
  const s = {
    books: (snap?.books || []).length,
    chapters: 0,
    outlines: 0,
    entities: 0,
    tombstones: (snap?.bookTombstones || []).length,
    exportedAt: snap?.exportedAt || 0,
    version: snap?.version || 0
  }
  for (const sets of Object.values(snap?.data || {})) {
    s.chapters += (sets.chapters || []).length
    s.outlines += (sets.outlines || []).length
    for (const name of DATA_COLLECTIONS) {
      // 记账记录与章节版本都不算「设定」，混进总数只会误导：一个 500 章的小说
      // 攒下几千条版本，会让「这份备份有 3200 条设定」这种说法完全失真。
      if (name === 'generationRuns' || name === 'chapterVersions') continue
      s.entities += (sets[name] || []).length
    }
    s.tombstones += (sets.tombstones || []).length
  }
  return s
}

const countRecords = (snap) => {
  const m = new Map()
  for (const b of snap?.books || []) m.set(`books:${b.id}`, b)
  for (const [bookId, sets] of Object.entries(snap?.data || {})) {
    for (const name of ['chapters', 'outlines', ...DATA_COLLECTIONS]) {
      for (const r of sets[name] || []) m.set(`${bookId}:${name}:${r.id}`, r)
    }
  }
  return m
}

/**
 * 「恢复后会发生什么」。**这不是锦上添花**：恢复是唯一一个会改到用户真实数据、
 * 且可能覆盖掉他刚写的东西的操作。只给一句「确定要恢复吗？」等于让他闭着眼点确定，
 * 而这里能如实说出「新增 N、覆盖 M、删除 K」。
 *
 * 删除也必须报：远端墓碑会删掉本地记录，报喜不报忧的确认框是在骗人。
 */
export function diffSnapshots(before, after) {
  const a = countRecords(before)
  const b = countRecords(after)
  let added = 0
  let updated = 0
  let removed = 0
  for (const [k, rec] of b) {
    const old = a.get(k)
    if (!old) added++
    else if (tstamp(rec) !== tstamp(old) || JSON.stringify(rec) !== JSON.stringify(old)) updated++
  }
  for (const k of a.keys()) if (!b.has(k)) removed++
  return { added, updated, removed }
}

// ---------------- 序列化 ----------------

export function toSnapshotJson(snap) {
  return JSON.stringify(snap, null, 2)
}

/**
 * 把一个来路不明的对象校验并规范成快照。
 *
 * 两个入口共用它：`parseSnapshotJson`（用户选的文件，先 JSON.parse）与
 * 局域网同步（对面设备发来的请求体，已经是对象）。**合成一份是有意的**——
 * 同步与恢复备份传的是同一个协议，校验规则分成两份必然会分叉，
 * 而分叉的表现是「手机上同步得进来、存成文件反而读不了」这类怪事。
 *
 * 报错必须是**能照着做**的话，而不是 `Unexpected token < in JSON at position 0`：
 * 用户会选错文件的场景非常真实（挑了导出的正文 .txt、挑了别的软件的 json），
 * 而此刻他能看到的只有这条消息。
 */
export function normalizeSnapshot(obj) {
  if (!obj || typeof obj !== 'object' || obj.format !== SNAPSHOT_FORMAT) {
    throw new Error('这不是 Novel Studio 的全量备份文件。')
  }
  if (Number(obj.version) > SNAPSHOT_VERSION) {
    throw new Error(
      `备份文件的版本（v${obj.version}）高于当前软件支持的版本（v${SNAPSHOT_VERSION}），请先升级软件。`
    )
  }
  return {
    format: SNAPSHOT_FORMAT,
    version: Number(obj.version) || 1,
    schemaVersion: Number(obj.schemaVersion) || 0,
    exportedAt: Number(obj.exportedAt) || 0,
    books: Array.isArray(obj.books) ? obj.books : [],
    data: obj.data && typeof obj.data === 'object' ? obj.data : {},
    bookTombstones: Array.isArray(obj.bookTombstones) ? obj.bookTombstones : []
  }
}

/** 解析用户选的文件。 */
export function parseSnapshotJson(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    throw new Error('这个文件不是有效的 JSON。请选择由本软件「全量备份」导出的 .json 文件。')
  }
  return normalizeSnapshot(obj)
}

// ---------------- I/O ----------------

/**
 * 读出整库。
 *
 * 逐书读所有集合：书的 id 取「书列表 ∪ 整书墓碑」的并集——只列书列表的话，
 * 一台已经把某本书删掉的设备导出的快照里不会有这本书的墓碑，另一台就永远
 * 不知道它被删了，那本书会在同步时反复复活。
 */
export async function collectSnapshot() {
  const books = await db.getBooks()
  const bookTombstones = await db.getBookTombstones()
  const ids = new Set([...books.map((b) => b.id), ...bookTombstones.map((t) => t.id)])
  const data = {}
  for (const bookId of ids) {
    const sets = {
      chapters: await db.getChapters(bookId),
      outlines: await db.getOutlines(bookId),
      tombstones: await db.getTombstones(bookId)
    }
    for (const name of DATA_COLLECTIONS) sets[name] = await db.coll[name].getAll(bookId)
    data[bookId] = sets
  }
  return buildSnapshot({ books, data, bookTombstones })
}

/**
 * 应用一个快照：与**当前库**合并后写回，返回 { stats, before, after }。
 *
 * 写回一律走 storage 的公开写函数（saveXxx / coll.saveAll），于是 toPlain 与
 * serialize 这两条结构性保证自动生效——这里若自己 `set(key, obj)` 就会绕过
 * 写队列，与正在进行的自动保存互相覆盖。
 *
 * 被整书墓碑删掉的书走 db.deleteBook：它顺带清掉这本书的全部键。
 * 只从 books 数组里摘掉的话，那些键会变成永远读不到也删不掉的幽灵数据。
 */
export async function applySnapshot(remote, { now = Date.now() } = {}) {
  const before = await collectSnapshot()
  const after = mergeSnapshot(before, remote)

  const keep = new Set(after.books.map((b) => b.id))
  const beforeIds = new Set(before.books.map((b) => b.id))
  for (const id of beforeIds) {
    if (!keep.has(id)) await db.deleteBook(id)
  }
  await db.saveBooks(after.books)

  for (const [bookId, sets] of Object.entries(after.data)) {
    if (!keep.has(bookId)) continue
    await db.saveChapters(bookId, sets.chapters || [])
    await db.saveOutlines(bookId, sets.outlines || [])
    for (const name of DATA_COLLECTIONS) {
      await db.coll[name].saveAll(bookId, sets[name] || [])
    }
    await db.coll.tombstones.saveAll(bookId, sets.tombstones || [])
  }

  const meta = await db.getMeta()
  await db.saveMeta({ ...(meta || {}), schemaVersion: SCHEMA_VERSION, updatedAt: now })

  return { stats: diffSnapshots(before, after), before, after }
}

/** 备份文件名：`NovelStudio-全量备份-YYYYMMDD-HHmm.json` */
export function buildSnapshotName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const d = date
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `NovelStudio-全量备份-${stamp}.json`
}
