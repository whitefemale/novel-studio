// 显式带 .js：Node 内置测试按原生 ESM 加载这些模块，扩展名省略只有 Vite 能解析。
import * as db from '../storage.js'
import { SCHEMA_VERSION } from '../migration.js'
import { genId } from '../ids.js'
import { APP_VERSION } from '../../version.js'
import { BOOK_POINTER_FIELDS, BOOK_POINTER_STAMP } from './pointers.js'

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

/**
 * **设备本地态集合**：进 storage.COLLECTIONS（于是获得工厂保证与级联删除），
 * 但绝不进快照。三者的共同点是「描述的是这台机器此刻的中间状态」：
 *
 * - `generationTasks`：流式草稿/崩溃恢复。草稿带着几万字正文，且「这台电脑上
 *   没跑完的调用」同步到手机上毫无意义；
 * - `generationQueue`：排队等待生成的写作任务。同步过去会让同一批章节在两端
 *   各生成一遍、各花一次钱；
 * - `ragChunks`：检索分块与向量。向量由本机算法生成，换机后自动重建即可，
 *   进快照只会膨胀体积。
 *
 * **新增本地态集合时同时改这里与 storage.js 的注释**：漏掉一处，它就会开始
 * 随每次同步传播，而且没有任何报错。
 */
export const LOCAL_ONLY_COLLECTIONS = ['generationTasks', 'generationQueue', 'ragChunks']
const LOCAL_ONLY = new Set(LOCAL_ONLY_COLLECTIONS)

/**
 * 快照里逐书保存的集合。与 storage.COLLECTIONS 同源，排除墓碑（单独处理）
 * 与设备本地态（见上）。
 */
const DATA_COLLECTIONS = db.COLLECTIONS.filter(
  (n) => n !== 'tombstones' && !LOCAL_ONLY.has(n)
)

/** 空快照。恢复的目标结构，也是合并的零元。 */
export function emptySnapshot(exportedAt = 0) {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    appVersion: '',
    deviceId: '',
    // 设备显示名：只用于界面上说「上次同步来自哪台设备」。它是**可选**头字段，
    // 不参与校验和（校验和只覆盖 books / data / bookTombstones）。
    deviceName: '',
    books: [],
    data: {},
    bookTombstones: []
  }
}

// ---------------- 校验和（纯函数） ----------------

/**
 * 稳定序列化：对象键递归排序后再 JSON.stringify。
 *
 * 不能直接对对象 JSON.stringify：同一份数据经过不同的组装路径（读库、合并、
 * 解析文件）时键顺序可能不同，校验和会因此变成「文件刚导出就校验失败」。
 * 数组保持原序 —— 顺序本身就是数据的一部分。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

/** FNV-1a 32 位。同步、无依赖、跨平台一致；用于发现截断/手改，不做安全用途。 */
export function fnv1a32(str) {
  let h = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 快照内容校验和。
 *
 * 只覆盖**数据本体**（books / data / bookTombstones），不覆盖 exportedAt 与
 * appVersion 这类头字段：它们是否变化与内容是否损坏无关，纳入进去会让
 * 「同一份数据换个导出时间」也校验失败。
 */
export function snapshotChecksum(snap) {
  return fnv1a32(
    stableStringify({
      books: snap?.books || [],
      data: snap?.data || {},
      bookTombstones: snap?.bookTombstones || []
    })
  )
}

/** 快照内容计数。用于确认框里让用户看懂「这个文件里到底有多少东西」。 */
export function snapshotCounts(snap) {
  const collections = {}
  let chapters = 0
  let outlines = 0
  let records = 0
  for (const sets of Object.values(snap?.data || {})) {
    chapters += (sets?.chapters || []).length
    outlines += (sets?.outlines || []).length
    for (const name of DATA_COLLECTIONS) {
      const n = (sets?.[name] || []).length
      if (n) collections[name] = (collections[name] || 0) + n
      records += n
    }
    records += (sets?.tombstones || []).length
  }
  return {
    books: (snap?.books || []).length,
    chapters,
    outlines,
    collections,
    records,
    tombstones:
      (snap?.bookTombstones || []).length +
      Object.values(snap?.data || {}).reduce((n, s) => n + (s?.tombstones || []).length, 0)
  }
}

/**
 * 给快照补齐版本/计数/校验和。
 *
 * 头部字段全部**可选**：SNAPSHOT_VERSION 保持 1，旧版本软件读到多出来的字段
 * 会直接忽略，新软件读到没有 checksum 的旧备份则跳过校验（只提示）。
 */
export function finalizeSnapshot(snap) {
  const out = {
    ...emptySnapshot(Number(snap?.exportedAt) || 0),
    ...snap,
    format: SNAPSHOT_FORMAT,
    version: Number(snap?.version) || SNAPSHOT_VERSION
  }
  out.appVersion = snap?.appVersion || APP_VERSION
  // 设备标识是同步冲突检测的「谁改的」那一半。它是**可选头字段**：
  // 旧备份没有它照样能恢复；旧软件读到它直接忽略。校验和不覆盖头字段。
  out.deviceId = typeof snap?.deviceId === 'string' ? snap.deviceId : ''
  out.deviceName = typeof snap?.deviceName === 'string' ? snap.deviceName : ''
  out.counts = snapshotCounts(out)
  out.checksum = snapshotChecksum(out)
  return out
}

/** 纯组装。I/O 由 collectSnapshot 负责，这里只为可确定性单测。 */
export function buildSnapshot(
  {
    books = [],
    data = {},
    bookTombstones = [],
    appVersion = APP_VERSION,
    deviceId = '',
    deviceName = ''
  } = {},
  exportedAt = Date.now()
) {
  const out = emptySnapshot(exportedAt)
  out.appVersion = appVersion
  out.deviceId = deviceId
  out.deviceName = deviceName
  out.books = [...books]
  out.data = {}
  // 新集合自动进快照，但墓碑与设备本地态除外（见 LOCAL_ONLY_COLLECTIONS）
  for (const [bookId, sets] of Object.entries(data)) {
    const clean = {}
    for (const [name, list] of Object.entries(sets || {})) {
      if (!LOCAL_ONLY.has(name)) clean[name] = list
    }
    out.data[bookId] = { tombstones: [], ...clean }
  }
  out.bookTombstones = [...bookTombstones]
  return finalizeSnapshot(out)
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

/**
 * 书籍指针的字段与合并规则见 pointers.js；这里只消费它们。
 *
 * 指针写入频率远高于书的本体（每次切章都改），所以用独立的
 * `currentPointerUpdatedAt` 合并，而不是跟着书的 `updatedAt` 走。
 */
export { BOOK_POINTER_FIELDS, BOOK_POINTER_STAMP }

/**
 * 合并书籍记录：书本体按 `updatedAt` 后写覆盖，指针按指针时间戳单独选择。
 *
 * 相等时保留本地（与 mergeRecords 同一护栏）：重复合并同一份文件不该让
 * 本机指针来回抖动。两侧都没有指针时间戳（旧版本记录）时不写这个字段，
 * 免得给老数据平白多出一个 0。
 */
export function mergeBookRecords(
  local = [],
  remote = [],
  {
    pointerFields = BOOK_POINTER_FIELDS,
    pointerStamp = BOOK_POINTER_STAMP
  } = {}
) {
  const byId = new Map()
  for (const b of local || []) if (b && b.id) byId.set(b.id, b)
  for (const b of remote || []) {
    if (!b || !b.id) continue
    const cur = byId.get(b.id)
    if (!cur) {
      byId.set(b.id, b)
      continue
    }
    const base = tstamp(b) > tstamp(cur) ? { ...b } : { ...cur }
    const localStamp = Number(cur?.[pointerStamp]) || 0
    const remoteStamp = Number(b?.[pointerStamp]) || 0
    if (localStamp || remoteStamp) {
      const source = remoteStamp > localStamp ? b : cur
      for (const f of pointerFields) base[f] = source?.[f] ?? null
      base[pointerStamp] = Math.max(localStamp, remoteStamp)
    }
    byId.set(b.id, base)
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
  // 书籍不能走 mergeRecords：当前章节/卷/篇指针需要按自己的时间戳合并。
  const mergedBooks = mergeBookRecords(a.books, b.books)
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
  // 合并结果代表「本机的数据」，所以它带上本机的 deviceId；对端拿到后
  // 就知道这条基线属于谁。
  out.deviceId = a.deviceId || b.deviceId || ''
  out.deviceName = a.deviceName || b.deviceName || ''
  // 合并结果也补齐头字段：它会被同步响应原样发给对端，也会作为「恢复后」
  // 快照参与下一轮 diff。没有 checksum 的文件不能算一份合格的快照。
  return finalizeSnapshot(out)
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
  const schemaVersion = Number(obj.schemaVersion) || 0
  // 备份允许来自更老的 schema（新字段全部可选），但拒绝更高版本：
  // 让旧软件去「半懂不懂」地合并新字段，正是静默丢数据的来源。
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `备份文件的数据版本（v${schemaVersion}）高于当前软件支持的版本（v${SCHEMA_VERSION}），请先升级软件。`
    )
  }
  const snap = {
    format: SNAPSHOT_FORMAT,
    version: Number(obj.version) || 1,
    schemaVersion,
    exportedAt: Number(obj.exportedAt) || 0,
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : '',
    deviceId: typeof obj.deviceId === 'string' ? obj.deviceId : '',
    deviceName: typeof obj.deviceName === 'string' ? obj.deviceName : '',
    counts: obj.counts && typeof obj.counts === 'object' ? obj.counts : null,
    checksum: typeof obj.checksum === 'string' ? obj.checksum : '',
    books: Array.isArray(obj.books) ? obj.books : [],
    data: obj.data && typeof obj.data === 'object' ? obj.data : {},
    bookTombstones: Array.isArray(obj.bookTombstones) ? obj.bookTombstones : []
  }
  // 没有 checksum 的是旧版本软件导出的备份，照常接受；有的必须通过校验。
  // 这一条挡的是「文件被截断/手改/网盘同步冲突」——它们往往仍是合法 JSON，
  // 只在恢复时才发现少了一半章节，那时已经写进库了。
  if (snap.checksum) {
    const actual = snapshotChecksum(snap)
    if (actual !== String(snap.checksum).toLowerCase()) {
      throw new Error(
        '备份文件校验失败：内容与导出时不一致（可能被截断、被修改，或复制过程出错）。为避免写入损坏数据，本次未做任何改动。'
      )
    }
  }
  return snap
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

// ---------------- 作为副本导入 ----------------

/** 可能指向本书记录 id 的字段。导入时必须一起重映射，否则副本内部的关联会断。 */
const REF_FIELDS = [
  'arcId',
  'volumeId',
  'chapterId',
  'firstChapterId',
  'expectedRevealChapterId',
  'sourceChapterId',
  'lastUpdatedChapterId',
  'entityId',
  'generationRunId',
  'reportRunId',
  'chapterVersionId'
]
const REF_ARRAY_FIELDS = ['characterIds', 'locationIds', 'factionIds', 'threadIds']

const cloneJson = (v) => JSON.parse(JSON.stringify(v))

/**
 * 把一份快照克隆成「全新的书」：每本书、每条记录都换新 id，内部引用一起重映射，
 * 书名追加「（导入副本）」。
 *
 * 这是恢复时「作为副本导入」选项的实现。它解决的是合并模式解决不了的场景：
 * 用户只想看看旧备份里那一版写了什么，并不想让它和当前正文比较时间戳。
 * 合并模式在同 id 时必有一方胜出，而副本模式**不产生任何同名记录**，两本
 * 书并存、互不覆盖。
 *
 * 墓碑不复制：副本是新书，复制墓碑等于新书一出生就被判死。
 *
 * `newId` 可注入，单元测试用它得到确定性结果；生产环境默认 genId。
 */
export function cloneSnapshotAsNewBooks(snap, { newId = genId, now = Date.now() } = {}) {
  const src = normalizeSnapshot(snap)
  const out = emptySnapshot(now)
  out.schemaVersion = src.schemaVersion
  out.books = []
  out.data = {}
  out.bookTombstones = []

  // 第一遍：为**所有**记录分配新 id，才能正确处理跨集合引用
  // （章节 → 篇、事件 → 章节、版本 → 章节、审阅项 → 实体）。
  const idMap = new Map()
  const bookMap = new Map()
  const takeId = (old) => {
    if (old == null || old === '') return old
    if (!idMap.has(old)) idMap.set(old, newId())
    return idMap.get(old)
  }
  for (const book of src.books || []) {
    if (!book || !book.id) continue
    bookMap.set(book.id, takeId(book.id))
    const sets = src.data?.[book.id] || {}
    for (const rec of sets.chapters || []) if (rec?.id) takeId(rec.id)
    for (const rec of sets.outlines || []) if (rec?.id) takeId(rec.id)
    for (const name of DATA_COLLECTIONS) {
      for (const rec of sets[name] || []) if (rec?.id) takeId(rec.id)
    }
  }

  const remapRecord = (rec, bookId) => {
    const copy = cloneJson(rec)
    copy.id = takeId(rec.id)
    copy.bookId = bookId
    for (const f of REF_FIELDS) {
      if (typeof copy[f] === 'string' && idMap.has(copy[f])) copy[f] = idMap.get(copy[f])
    }
    for (const f of REF_ARRAY_FIELDS) {
      if (Array.isArray(copy[f])) copy[f] = copy[f].map((x) => idMap.get(x) || x)
    }
    if (Array.isArray(copy.migratedTo)) {
      copy.migratedTo = copy.migratedTo.map((x) => idMap.get(x) || x)
    }
    return copy
  }

  // 第二遍：真正克隆
  for (const book of src.books || []) {
    if (!book || !book.id) continue
    const newBookId = bookMap.get(book.id)
    const sets = src.data?.[book.id] || {}
    const bookCopy = cloneJson(book)
    bookCopy.id = newBookId
    bookCopy.title = `${book.title || '未命名小说'}（导入副本）`
    bookCopy.createdAt = now
    bookCopy.updatedAt = now
    // 副本里的章节都换了新 id，指针必须跟着重映射，否则会指向原书的章节。
    for (const f of BOOK_POINTER_FIELDS) {
      bookCopy[f] = idMap.get(bookCopy[f]) || null
    }
    bookCopy[BOOK_POINTER_STAMP] = now
    out.books.push(bookCopy)

    const dataCopy = { tombstones: [] }
    for (const name of ['chapters', 'outlines', ...DATA_COLLECTIONS]) {
      dataCopy[name] = (sets[name] || []).filter((r) => r && r.id).map((r) => remapRecord(r, newBookId))
    }
    out.data[newBookId] = dataCopy
  }
  return finalizeSnapshot(out)
}

// ---------------- I/O ----------------

/**
 * 读出整库。
 *
 * 逐书读所有集合：书的 id 取「书列表 ∪ 整书墓碑」的并集——只列书列表的话，
 * 一台已经把某本书删掉的设备导出的快照里不会有这本书的墓碑，另一台就永远
 * 不知道它被删了，那本书会在同步时反复复活。
 */
export async function collectSnapshot({ deviceName = '' } = {}) {
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
  return buildSnapshot({
    books,
    data,
    bookTombstones,
    deviceId: await db.getDeviceId(),
    deviceName
  })
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

  try {
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
  } catch (err) {
    // 写回是逐键进行的，IndexedDB 没有跨键事务。空间不足时**可能已经写了一部分**，
    // 所以这里绝不能对用户说「原数据未改动」——那是谎话，会让人放心地不再检查。
    // 调用方（BackupModal / 同步）已经在写库之前存了恢复前快照（见 preRestoreSnapshot）。
    const quota = isQuotaError(err)
    const wrapped = new Error(
      quota
        ? '存储空间不足，恢复没有完成。部分数据可能已经被写入；恢复前的快照已自动保留，请先导出备份、清理磁盘空间后再试。'
        : `恢复没有完成：${err?.message || err}`
    )
    wrapped.code = quota ? 'EQUOTA' : 'EAPPLYSNAPSHOT'
    wrapped.cause = err
    wrapped.partial = true
    throw wrapped
  }

  return { stats: diffSnapshots(before, after), before, after }
}

/** 判断 IndexedDB 的空间不足错误。各浏览器给的名字/码不一致，两种都认。 */
export function isQuotaError(err) {
  if (!err) return false
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  )
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
