/**
 * 节奏 / 人物 / 伏笔 / 完成度统计。纯函数，无 I/O，不读时间。
 *
 * 几条刻意写死的口径（界面上也要显示，见 StatsPanel）：
 *   - 字数用与编辑器相同的 `countWords`（去掉空白后的字符数）；章节上有
 *     `wordCount` 字段时优先用它，避免每次打开控制台重算全书正文。
 *   - 平均字数只除以**已写章节**。把空章算进分母会让人以为书越写越短。
 *   - 「出场」= 事件涉及 + 场景涉及 + 最近出场章节，三者取并集；同一章重复
 *     出现只算一次。
 *   - 伏笔回收率 = (已揭示 + 已收束) / 全部，废弃的伏笔仍留在分母里 ——
 *     废弃也是作者的决定，把它悄悄剔除会让回收率虚高。
 *   - 事件密度按每 10 章一段统计，不是按故事内时间 —— 结构化数据里没有可靠的
 *     故事时钟，按章节序是唯一不会撒谎的坐标。
 *
 * 所有数字都是**本机数据的描述**，不代表文学质量，界面文案必须写「仅供参考」。
 */

import { countWords } from '../wordCount.js'
import { ACTIVE_FORESHADOW_STATUS } from './schemas.js'

export const DENSITY_BUCKET = 10

const orderOf = (c) => (Number.isFinite(Number(c?.order)) ? Number(c.order) : 0)
const hasContent = (c) => String(c?.content || '').trim().length > 0

function chapterWords(c) {
  if (!hasContent(c)) return 0
  const stored = Number(c.wordCount)
  if (Number.isFinite(stored) && stored > 0) return stored
  return countWords(c.content).total
}

function median(nums) {
  if (!nums.length) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function progressOf(list) {
  const total = list.length
  const written = list.filter(hasContent).length
  return { total, written, progress: total ? written / total : 0 }
}

export function buildStats({ chapters, memory, structure } = {}) {
  const list = [...(chapters || [])].sort((a, b) => orderOf(a) - orderOf(b))
  const mem = memory || {}
  const struct = structure || {}
  const events = mem.events || []
  const scenes = struct.scenes || []
  const arcs = struct.arcs || []
  const volumes = struct.volumes || []
  const characters = mem.characters || []
  const foreshadowing = mem.foreshadowing || []

  const byId = new Map(list.map((c) => [c.id, c]))
  const orderById = (id) => (byId.has(id) ? orderOf(byId.get(id)) : null)

  // ---- 章节与字数 ----
  const written = list.filter(hasContent)
  const words = list.reduce((n, c) => n + chapterWords(c), 0)
  const chapterWordCounts = written.map(chapterWords)
  const targetWords = list.reduce((n, c) => n + (Number(c.targetWords) || 0), 0)
  let longest = null
  for (const c of written) {
    const w = chapterWords(c)
    if (!longest || w > longest.words) longest = { id: c.id, title: c.title || '', words: w }
  }
  const chapterStats = {
    total: list.length,
    written: written.length,
    empty: list.length - written.length,
    words,
    avgWords: written.length ? words / written.length : 0,
    medianWords: median(chapterWordCounts),
    targetWords,
    targetProgress: targetWords > 0 ? Math.min(2, words / targetWords) : 0,
    longest
  }

  // ---- 卷 / 篇完成度 ----
  const arcStats = arcs.map((a) => {
    const assigned = list.filter((c) => c.arcId === a.id)
    return {
      id: a.id,
      title: a.title || '未命名篇',
      volumeId: a.volumeId || '',
      status: a.status || '',
      ...progressOf(assigned),
      words: assigned.reduce((n, c) => n + chapterWords(c), 0)
    }
  })
  const volumeStats = volumes.map((v) => {
    const ownArcs = arcs.filter((a) => a.volumeId === v.id).map((a) => a.id)
    const assigned = list.filter((c) => ownArcs.includes(c.arcId))
    return {
      id: v.id,
      title: v.title || '未命名卷',
      status: v.status || '',
      arcs: ownArcs.length,
      ...progressOf(assigned),
      words: assigned.reduce((n, c) => n + chapterWords(c), 0)
    }
  })

  // ---- 主线 / 支线推进 ----
  const marked = list.filter((c) => /主线/.test(String(c.threads || '')))
  const lastMainOrder = marked.length ? orderOf(marked[marked.length - 1]) : null
  const lastOrder = list.length ? orderOf(list[list.length - 1]) : null
  const mainGap =
    lastMainOrder == null || lastOrder == null
      ? null
      : list.filter((c) => orderOf(c) > lastMainOrder).length
  // 支线：每篇最后一次被某章挂上（arcId）之后过了几章。只列进行中的篇。
  const threadArcs = arcStats
    .filter((a) => a.status === 'active')
    .map((a) => {
      const assigned = list.filter((c) => c.arcId === a.id)
      const last = assigned.length ? orderOf(assigned[assigned.length - 1]) : null
      return {
        id: a.id,
        title: a.title,
        lastOrder: last,
        gap: last == null ? null : list.filter((c) => orderOf(c) > last).length
      }
    })

  // ---- 人物出场 ----
  const eventChapters = new Map()
  for (const e of events) {
    if (!e.chapterId) continue
    for (const cid of e.characterIds || []) {
      if (!eventChapters.has(cid)) eventChapters.set(cid, new Set())
      eventChapters.get(cid).add(e.chapterId)
    }
  }
  const sceneChapters = new Map()
  for (const s of scenes) {
    if (!s.chapterId) continue
    for (const cid of s.characterIds || []) {
      if (!sceneChapters.has(cid)) sceneChapters.set(cid, new Set())
      sceneChapters.get(cid).add(s.chapterId)
    }
  }
  const characterRows = characters.map((p) => {
    const chapterSet = new Set([
      ...(eventChapters.get(p.id) || []),
      ...(sceneChapters.get(p.id) || [])
    ])
    if (p.lastUpdatedChapterId) chapterSet.add(p.lastUpdatedChapterId)
    const orders = [...chapterSet].map(orderById).filter((n) => n != null)
    const last = orders.length ? Math.max(...orders) : null
    return {
      id: p.id,
      name: p.name || '未命名',
      status: p.status || '',
      events: (eventChapters.get(p.id) || new Set()).size,
      scenes: (sceneChapters.get(p.id) || new Set()).size,
      chapters: chapterSet.size,
      lastOrder: last,
      gap: last == null || lastOrder == null ? null : list.filter((c) => orderOf(c) > last).length
    }
  })
  characterRows.sort(
    (a, b) =>
      (b.chapters - a.chapters) ||
      (b.lastOrder ?? -1) - (a.lastOrder ?? -1) ||
      a.name.localeCompare(b.name, 'zh')
  )
  const characterStats = {
    tracked: characterRows.length,
    appeared: characterRows.filter((r) => r.chapters > 0).length,
    never: characterRows.filter((r) => r.chapters === 0).length,
    rows: characterRows
  }

  // ---- 伏笔 ----
  const activeForeshadow = foreshadowing.filter((f) =>
    ACTIVE_FORESHADOW_STATUS.includes(f.status)
  )
  const revealed = foreshadowing.filter((f) => f.status === 'revealed').length
  const resolved = foreshadowing.filter((f) => f.status === 'resolved').length
  const abandoned = foreshadowing.filter((f) => f.status === 'abandoned').length
  const overdue = activeForeshadow
    .filter((f) => {
      const target = byId.get(f.expectedRevealChapterId)
      return target && hasContent(target)
    })
    .map((f) => ({
      id: f.id,
      title: f.title || '未命名伏笔',
      expectedOrder: orderOf(byId.get(f.expectedRevealChapterId))
    }))
    .sort((a, b) => a.expectedOrder - b.expectedOrder)
  const foreshadowStats = {
    total: foreshadowing.length,
    active: activeForeshadow.length,
    revealed,
    resolved,
    abandoned,
    rate: foreshadowing.length ? (revealed + resolved) / foreshadowing.length : 0,
    overdue
  }

  // ---- 事件密度 ----
  const buckets = []
  for (let i = 0; i < list.length; i += DENSITY_BUCKET) {
    const slice = list.slice(i, i + DENSITY_BUCKET)
    const from = orderOf(slice[0])
    const to = orderOf(slice[slice.length - 1])
    const ids = new Set(slice.map((c) => c.id))
    const ev = events.reduce((ax, e) => ax + (ids.has(e.chapterId) ? 1 : 0), 0)
    const sc = scenes.reduce((ax, s) => ax + (ids.has(s.chapterId) ? 1 : 0), 0)
    const w = slice.reduce((n, c) => n + chapterWords(c), 0)
    buckets.push({
      from,
      to,
      chapters: slice.length,
      words: w,
      events: ev,
      scenes: sc,
      perThousandWords: w > 0 ? (ev / w) * 1000 : 0
    })
  }
  const density = {
    bucketSize: DENSITY_BUCKET,
    buckets,
    meanEvents: buckets.length
      ? buckets.reduce((n, b) => n + b.events, 0) / buckets.length
      : 0
  }

  return {
    chapters: chapterStats,
    volumes: volumeStats,
    arcs: arcStats,
    threads: { mainLastOrder: lastMainOrder, mainGap, arcs: threadArcs },
    characters: characterStats,
    foreshadowing: foreshadowStats,
    density,
    scenes: {
      total: scenes.length,
      written: scenes.filter((s) => s.status === 'written').length,
      cut: scenes.filter((s) => s.status === 'cut').length
    },
    events: { total: events.length },
    note: '数字是本机数据的描述，不是文学质量评价；字数去掉空白后统计，平均只算已写章节。'
  }
}
