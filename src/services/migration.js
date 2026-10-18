// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import * as db from './storage.js'
import { genId } from './ids.js'

/**
 * V1 → V2 迁移。
 *
 * 四条原则，每一条都是刻意的：
 *
 * 1. **非破坏。** 只往新集合里写实体，并在旧设定行上**追加一个字段**。
 *    旧行的 title / content / type 一字不改 —— 用户手写的设定是真实数据，
 *    任何「顺手整理一下」的转换都可能丢掉他没打算丢掉的东西。
 *
 * 2. **幂等。** 已迁移的源行带 migratedTo，再跑一次产出 0 条候选。
 *    否则重复点「一键升级」会造出一堆同名人物。
 *
 * 3. **只增不减、只转换有明确对应关系的。** 人物设定与世界规则各自有 1:1 的
 *    V2 实体，可以安全映射；而「故事大纲」是一整段自由文本，映射成卷/篇必然
 *    丢信息又猜错结构，故**不自动转换**，由用户在控制台里手建卷与篇。
 *
 * 4. **不静默执行。** 迁移由用户在控制台里点按钮触发，不在应用启动时跑。
 *    不开控制台的 V1 用户因此保持 100% 旧行为 —— 这正是「老用户零行为变化」
 *    这个承诺的落实方式。
 */

export const SCHEMA_VERSION = 3

/**
 * 标题规范化，用于跨来源比对两个名字是不是同一个人/同一条规则。
 * 去空白 + 转小写：旧设定里「林 昭」与 V2 实体里的「林昭」应当视为同一个。
 */
export function normalizeTitle(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * 生成迁移候选。**纯函数**，不写库，可确定性单测。
 *
 * 返回 { candidates, stats }。每条候选：
 *   { kind: 'characters'|'worldRules', sourceId, data }
 */
export function planMigration({ outlines = [], characters = [], worldRules = [] } = {}) {
  const known = {
    characters: new Set(characters.map((c) => normalizeTitle(c.name))),
    worldRules: new Set(worldRules.map((r) => normalizeTitle(r.title)))
  }
  const candidates = []
  let skippedMigrated = 0
  let skippedDuplicate = 0
  let unconvertible = 0

  for (const o of outlines || []) {
    // 只有人物与世界观有 1:1 的 V2 对应实体；故事大纲不转换
    const kind = o.type === 'character' ? 'characters' : o.type === 'world' ? 'worldRules' : null
    if (!kind) {
      unconvertible++
      continue
    }
    if (Array.isArray(o.migratedTo) && o.migratedTo.length) {
      skippedMigrated++
      continue
    }
    const norm = normalizeTitle(o.title)
    // 已经有同名实体就别再造一个 —— 无论那个实体是上一轮迁移建的，
    // 还是用户在控制台里手建的
    if (norm && known[kind].has(norm)) {
      skippedDuplicate++
      continue
    }
    candidates.push({
      kind,
      sourceId: o.id,
      data:
        kind === 'characters'
          ? {
              name: o.title || '未命名人物',
              // 旧设定只有一段自由文本，落到 background（「背景」）是最不丢信息的
              // 位置：identity（身份）是一句短标签，硬塞长文本会误导后续提示词
              identity: '',
              background: o.content || '',
              status: 'alive'
            }
          : {
              category: 'world',
              title: o.title || '未命名规则',
              rule: o.content || '',
              priority: 50
            }
    })
    // 同一批候选里也不允许重名
    if (norm) known[kind].add(norm)
  }

  return {
    candidates,
    stats: {
      total: (outlines || []).length,
      candidates: candidates.length,
      skippedMigrated,
      skippedDuplicate,
      unconvertible
    }
  }
}

/** 读当前书的旧设定与已有实体，算出候选。控制台打开时调用。 */
export async function planMigrationForBook(bookId) {
  if (!bookId) return planMigration({})
  const [outlines, characters, worldRules] = await Promise.all([
    db.getOutlines(bookId),
    db.coll.characters.getAll(bookId),
    db.coll.worldRules.getAll(bookId)
  ])
  return planMigration({ outlines, characters, worldRules })
}

/**
 * 落库迁移。
 *
 * 顺序上先建新实体、再给源行打 migratedTo：中途失败时最多是「实体建好了但源行
 * 还没标记」，此时源行仍带着 migratedTo 为空 —— 下次规划会按「同名已存在」跳过，
 * 所以重复执行仍然是安全的（这是两道幂等护栏的第二道）。
 *
 * 已知且可接受的局限：本函数直接改库，而 useBooks 内存里那份 outlines 副本不会
 * 跟着变。用户随后在侧栏编辑这条旧设定时，updateOutline 的「读-改-写」会把内存
 * 副本整体写回，migratedTo 因此丢失。丢失本身无害 —— planMigration 的第二道
 * 护栏（规范化标题比对）照样会挡下重复迁移。
 */
export async function applyMigration(bookId, candidates = []) {
  if (!bookId) return { migrated: 0, created: [], failed: [] }
  const now = Date.now()
  // 每一轮都重新读旧设定：同一批候选里可能有多条指向同一源行，
  // 用过期副本写回会把前一条刚追加的 migratedTo 覆盖掉。
  const bySource = new Map((await db.getOutlines(bookId)).map((o) => [o.id, o]))
  const created = []
  const failed = []

  for (const cand of candidates) {
    if (!db.COLLECTIONS.includes(cand.kind)) {
      failed.push({ sourceId: cand?.sourceId, kind: cand?.kind, message: '不支持的实体类型' })
      continue
    }
    try {
      const item = { ...cand.data, id: genId(), bookId, createdAt: now, updatedAt: now }
      await db.coll[cand.kind].upsert(bookId, item)
      created.push({ kind: cand.kind, id: item.id, sourceId: cand.sourceId })

      const src = bySource.get(cand.sourceId)
      if (src) {
        // 只追加这一个字段。title / content / type 一律不动。
        src.migratedTo = [...(src.migratedTo || []), item.id]
        src.updatedAt = now
        await db.upsertOutline(bookId, src)
        bySource.set(src.id, src)
      }
    } catch (err) {
      // 单条失败不中止整批：已经成功的那些是真实数据，回滚它们反而更危险。
      // 失败项原样报出去，用户可以再点一次「一键升级」——幂等护栏保证不会重复。
      failed.push({ sourceId: cand?.sourceId, kind: cand?.kind, message: err?.message || String(err) })
    }
  }
  return { migrated: created.length, created, failed }
}

/**
 * 记录 schemaVersion 与迁移报告。
 *
 * 这一轮升到 3 只是**标记**：V3 的新字段全部可选、没有任何数据必须重写，
 * 所以 `automatic` 为 true 且 `changes` 为 0。真正的数据迁移（V1→V2 旧设定
 * 转实体）仍然只在用户点按钮时跑，报告记在 applyMigration 的调用方。
 *
 * 报告保留最近 20 条，避免 meta 随版本迭代无限膨胀。
 */
export async function ensureSchemaVersion() {
  const meta = await db.getMeta()
  if (meta && meta.schemaVersion === SCHEMA_VERSION) return meta
  const now = Date.now()
  const from = Number(meta?.schemaVersion) || 0
  const report = {
    from,
    to: SCHEMA_VERSION,
    at: now,
    automatic: true,
    changes: 0,
    note: from === 0 ? '首次记录数据版本' : '仅记录版本标记，未改写任何记录'
  }
  const migrations = [...(Array.isArray(meta?.migrations) ? meta.migrations : []), report].slice(-20)
  const next = {
    ...(meta || {}),
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    migrations
  }
  await db.saveMeta(next)
  return next
}

/** 追加一条迁移报告（手动迁移用）。返回写入后的 meta。 */
export async function recordMigrationReport(report) {
  const meta = (await db.getMeta()) || {}
  const migrations = [
    ...(Array.isArray(meta.migrations) ? meta.migrations : []),
    { at: Date.now(), automatic: false, ...report }
  ].slice(-20)
  const next = { ...meta, migrations, updatedAt: Date.now() }
  await db.saveMeta(next)
  return next
}
