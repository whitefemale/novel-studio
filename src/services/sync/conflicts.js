// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import { fnv1a32 } from '../novel/snapshot.js'

/**
 * 同步冲突：两台设备在**同一章**上各自改过正文时，不静默丢弃任何一边。
 *
 * 为什么只对 chapters 做冲突检测：正文是唯一**不可再生**的内容。人物状态、地点、
 * 事件这些实体错了还能从正文里重新提取；一段被覆盖掉的正文则永远回不来。实体继续
 * 走「updatedAt 大的赢 + 墓碑判死」，这是第一阶段就定好的规则，不在这里另起一套。
 *
 * 判定需要一条**基线**：上一次同步之后两边各章是什么样子。没有基线就无法区分
 * 「另一端改了这一章」和「两端本来就是不同版本」——首次同步时不报冲突，只建基线。
 * 只有双方都在基线之后改过、且正文不同，才算冲突。
 *
 * 解决方式是**保留本地章为主章，把远端版本另存为冲突副本**：
 *   - 主章保持不动，用户熟悉的章节顺序与当前写作位置不受影响；
 *   - 副本用确定性 id（章 id + 远端设备 id + 远端时间戳的哈希），重复同步/重试
 *     不会每来一次就多一份；
 *   - 副本记录同时写一条 syncConflicts，随合并结果传给对端，于是两台设备都看得见。
 *
 * 本模块全部是纯函数，没有 I/O。
 */

export const CONFLICT_TITLE_PREFIX = '【冲突副本】'
export const CONFLICT_ID_PREFIX = 'conflict_'
export const CONFLICT_RECORD_PREFIX = 'sync_'
export const CONFLICTS_COLLECTION = 'syncConflicts'

const tstamp = (r) => Number(r?.updatedAt ?? r?.createdAt ?? 0) || 0
const asText = (v) => String(v == null ? '' : v)

/** 冲突副本的确定性 id。同一章、同一设备、同一时间戳永远得到同一个 id。 */
export function conflictCopyId(chapterId, remoteDeviceId, remoteUpdatedAt) {
  return (
    CONFLICT_ID_PREFIX +
    fnv1a32(`${chapterId}|${remoteDeviceId || 'unknown'}|${Number(remoteUpdatedAt) || 0}`)
  )
}

export function conflictRecordId(chapterId, remoteDeviceId, remoteUpdatedAt) {
  return (
    CONFLICT_RECORD_PREFIX +
    fnv1a32(`sync|${chapterId}|${remoteDeviceId || 'unknown'}|${Number(remoteUpdatedAt) || 0}`)
  )
}

/** 这条章节是不是同步留下的冲突副本（冲突副本之间不再互相判冲突）。 */
export function isConflictCopy(chapter) {
  return !!chapter && (String(chapter.id || '').startsWith(CONFLICT_ID_PREFIX) || !!chapter.conflictOf)
}

/**
 * 基线里某一章的时间戳。基线结构：
 * `{ deviceId, chapters: { [chapterId]: updatedAt }, updatedAt }`
 */
export function baselineTime(baseline, chapterId) {
  const v = baseline?.chapters?.[chapterId]
  return Number.isFinite(Number(v)) ? Number(v) : null
}

/** 由一组章节生成基线快照。 */
export function makeChapterBaseline(chapters = []) {
  const map = {}
  for (const c of chapters || []) {
    if (!c || !c.id) continue
    map[c.id] = tstamp(c)
  }
  return map
}

/**
 * 检测同章冲突。**纯函数**，不写库。
 *
 * @returns 冲突数组：{ chapterId, bookId, local, remote, copyId, recordId, localUpdatedAt, remoteUpdatedAt }
 */
export function detectChapterConflicts({
  localChapters = [],
  remoteChapters = [],
  baseline = null,
  remoteDeviceId = '',
  conflictCopies = true
}) {
  if (!conflictCopies || !baseline) return []
  const localById = new Map((localChapters || []).filter((c) => c?.id).map((c) => [c.id, c]))
  const conflicts = []
  for (const remote of remoteChapters || []) {
    if (!remote || !remote.id || isConflictCopy(remote)) continue
    const local = localById.get(remote.id)
    if (!local || isConflictCopy(local)) continue
    if (asText(local.content) === asText(remote.content)) continue
    const base = baselineTime(baseline, remote.id)
    // 没有基线 = 首次同步；不报冲突，只建基线（否则第一次同步就会给每一对
    // 「两端本来就不一样」的章节新建副本，那是一场噪声灾难）。
    if (base == null) continue
    // 只有**双方都在基线之后改过**才是真正的并发修改。若一方没动，正常 LWW
    // 就是对的，没必要打扰用户。
    if (tstamp(local) <= base || tstamp(remote) <= base) continue
    conflicts.push({
      chapterId: remote.id,
      bookId: remote.bookId || local.bookId || '',
      local,
      remote,
      copyId: conflictCopyId(remote.id, remoteDeviceId, tstamp(remote)),
      recordId: conflictRecordId(remote.id, remoteDeviceId, tstamp(remote)),
      localUpdatedAt: tstamp(local),
      remoteUpdatedAt: tstamp(remote),
      remoteDeviceId: String(remoteDeviceId || 'unknown')
    })
  }
  return conflicts
}

const clone = (v) => JSON.parse(JSON.stringify(v))

/** 一本书里章节的最大 order。 */
function maxOrder(chapters = []) {
  return (chapters || []).reduce((m, c) => Math.max(m, Number(c?.order) || 0), 0)
}

/**
 * 把冲突解决结果写进「准备发给合并器的远端快照」。
 *
 * 具体做两件事：
 *   1. 从远端快照里**移走**同 id 的那一章 —— 于是合并时本地版本原地保留为主章；
 *   2. 把远端正文作为冲突副本章加进去，并加一条 syncConflicts 记录。
 *
 * 返回 `{ snapshot, conflicts }`，不改入参。`snapshot` 的头部会在后续
 * `mergeSnapshot` / `applySnapshot` 里重新补齐。
 */
export function applyConflictCopies(remoteSnapshot, conflicts = [], { now = Date.now() } = {}) {
  const out = clone(remoteSnapshot || {})
  if (!out.data || typeof out.data !== 'object') out.data = {}
  if (!conflicts.length) return { snapshot: out, conflicts: [] }

  const resolved = []
  for (const c of conflicts) {
    const bookId = c.bookId || c.remote?.bookId
    if (!bookId) continue
    const sets = out.data[bookId] || (out.data[bookId] = { tombstones: [] })
    const chapters = Array.isArray(sets.chapters) ? sets.chapters : (sets.chapters = [])
    const idx = chapters.findIndex((x) => x.id === c.chapterId)
    const remote = idx >= 0 ? chapters[idx] : c.remote
    // 远端版本可能本来就不在快照里（例如被另一条墓碑判死）：那就没有可保留的
    // 正文，不制造空副本，也不报冲突。
    if (!remote || !asText(remote.content)) continue
    if (idx >= 0) chapters.splice(idx, 1)

    const existingCopies = (out.data[bookId]?.chapters || []).filter(isConflictCopy)
    const order = Math.max(maxOrder(chapters), maxOrder(existingCopies), maxOrder(c.local ? [c.local] : [])) + 1
    const copy = {
      id: c.copyId,
      bookId,
      title: `${CONFLICT_TITLE_PREFIX}${remote.title || '未命名章节'}`,
      content: asText(remote.content),
      order,
      // 用远端自己的时间戳而不是 now：同一份远端快照重放时副本内容与时间戳
      // 都不变，合并结果稳定（这是幂等性的另一半，确定性 id 只是一半）。
      createdAt: c.remoteUpdatedAt || now,
      updatedAt: c.remoteUpdatedAt || now,
      conflictOf: c.chapterId,
      conflictDeviceId: c.remoteDeviceId || 'unknown',
      // 章节的可选元数据一并带过去，副本仍然是一章「完整」的正文
      ...(remote.summary ? { summary: remote.summary } : {}),
      ...(remote.arcId ? { arcId: remote.arcId } : {}),
      ...(remote.timelineStart ? { timelineStart: remote.timelineStart } : {}),
      ...(remote.timelineEnd ? { timelineEnd: remote.timelineEnd } : {})
    }
    chapters.push(copy)

    const record = {
      id: c.recordId,
      bookId,
      chapterId: c.chapterId,
      chapterTitle: remote.title || c.local?.title || '',
      copyChapterId: c.copyId,
      localUpdatedAt: c.localUpdatedAt,
      remoteUpdatedAt: c.remoteUpdatedAt,
      remoteDeviceId: c.remoteDeviceId || 'unknown',
      // 内容哈希而不是时间戳：解决冲突时主章的时间戳会被抬高，用它判断
      // 「解决后又改过没有」会永远为真。内容才是有意义的那件事。
      localHash: fnv1a32(asText(c.local?.content)),
      copyHash: fnv1a32(asText(remote.content)),
      status: 'open',
      createdAt: c.remoteUpdatedAt || now,
      updatedAt: now
    }
    const records = Array.isArray(sets[CONFLICTS_COLLECTION])
      ? sets[CONFLICTS_COLLECTION]
      : (sets[CONFLICTS_COLLECTION] = [])
    const ridx = records.findIndex((r) => r.id === record.id)
    if (ridx >= 0) records[ridx] = record
    else records.push(record)

    resolved.push({ ...c, copyChapter: copy, conflictRecord: record })
  }
  return { snapshot: out, conflicts: resolved }
}

/**
 * 一次同步成功后更新对端基线。
 *
 * 基线取**合并结果**里各章的 updatedAt：合并结果就是双方此刻看到的东西，
 * 用它当下一轮的「上次同步时」最准确。
 */
export function updatePeerBaseline(peers, deviceId, chapters, { now = Date.now() } = {}) {
  const key = String(deviceId || '').trim() || 'unknown'
  const next = { ...(peers || {}) }
  next[key] = {
    deviceId: key,
    chapters: makeChapterBaseline(chapters),
    updatedAt: now
  }
  return next
}

/**
 * 冲突是否仍然需要处理：主章或副本在解决之后又被改过，就不该再显示「已解决」。
 * 纯函数，供 SyncPanel 判断。
 */
export function isConflictStale(conflict, chapters = []) {
  if (!conflict) return true
  const main = (chapters || []).find((c) => c.id === conflict.chapterId)
  const copy = (chapters || []).find((c) => c.id === conflict.copyChapterId)
  if (!main || !copy) return true
  return (
    fnv1a32(asText(main.content)) !== conflict.localHash ||
    fnv1a32(asText(copy.content)) !== conflict.copyHash
  )
}
