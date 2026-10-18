import { ENTITY_SCHEMAS, entityTitle } from './schemas.js'

/**
 * 检索与相关性排序。**全部是纯函数**，不碰 IndexedDB，也不引入全文/向量服务。
 *
 * 为什么需要它：Context Builder 早先只用「名字是否出现在焦点文本里」做布尔判断，
 * 结果是「被提到的人物排前面、没被提到的排后面」两档。这在章数一多时不够用——
 * 一个名字在一章里出现五次和出现一次，对「这一章在写谁」的权重显然不同。
 * 这里把判断升级成可解释的分数，同时保持确定性：同样的输入永远得到同样的顺序。
 *
 * 三条边界：
 *   - 不读库、不缓存：调用方传入内存里的数组；
 *   - 不做模糊/同义词匹配：中文人名里的单字命中噪声太大（「王」）；
 *   - 搜索结果带片段，但片段由字符串切片产生，不生成任何 HTML。
 */

const text = (v) => String(v == null ? '' : v)

/** 一条实体的全部可匹配名称：主标题 + 别名 */
export function entityNames(entity) {
  if (!entity) return []
  const names = [entity.name, entity.title]
  if (Array.isArray(entity.aliases)) names.push(...entity.aliases)
  return [...new Set(names.map((x) => text(x).trim()).filter((x) => x.length > 1))]
}

/**
 * 相关性打分。
 *
 * 名字越长命中越有分量（「林昭」远比特指性低于「王」），多次出现按次数累加、
 * 但设上限，避免一个反复出现的人名把整层预算吃光。单字名不参与匹配。
 */
export function relevanceOf(entity, focus) {
  const f = text(focus)
  if (!f || !entity) return 0
  let score = 0
  for (const name of entityNames(entity)) {
    let idx = 0
    let hits = 0
    while (hits < 5) {
      const at = f.indexOf(name, idx)
      if (at < 0) break
      hits++
      idx = at + name.length
    }
    if (hits) score += hits * Math.min(6, name.length)
  }
  return score
}

/**
 * 按相关性排序，返回包装对象（不改入参）。
 * `reason` 只有两档：'focus'（被提到）与 'available'（未被提到但仍被注入）。
 */
export function rankEntities(list, focus) {
  return (list || [])
    .map((entity) => {
      const score = relevanceOf(entity, focus)
      return { entity, score, reason: score > 0 ? 'focus' : 'available' }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 事件相关度：除了标题被提到，事件还能通过**参与人物 / 发生地点 / 势力**
 * 与当前焦点关联。这是「A 回到药庐」能带出「三年前在药庐发生的那件事」的原因，
 * 纯名字匹配做不到这一层。
 */
export function eventRelevance(event, focus, ids = {}) {
  if (!event) return 0
  let score = relevanceOf(event, focus)
  const has = (set, id) => !!(id && set && set.has(id))
  if (has(ids.locations, event.locationId)) score += 4
  for (const id of event.characterIds || []) if (has(ids.characters, id)) score += 3
  for (const id of event.factionIds || []) if (has(ids.factions, id)) score += 2
  return score
}

/** 从一组实体里取出被焦点提到的 id 集合 */
export function mentionedIds(list, focus) {
  const out = new Set()
  for (const e of list || []) {
    if (e?.id && relevanceOf(e, focus) > 0) out.add(e.id)
  }
  return out
}

/** 把文本裁剪成命中片段（前后各留一些上下文），用于搜索结果展示 */
export function snippetAround(source, query, radius = 40) {
  const s = text(source)
  const q = text(query).trim()
  if (!q) return s.slice(0, radius * 2)
  const at = s.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return s.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(s.length, at + q.length + radius)
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`
}

const ENTITY_KIND_LABEL = {
  characters: '人物',
  locations: '地点',
  factions: '势力',
  worldRules: '规则',
  events: '事件',
  foreshadowing: '伏笔',
  volumes: '卷',
  arcs: '篇'
}

/**
 * 全书搜索：章节、旧设定、结构化实体。
 *
 * 返回 `[{ kind, kindLabel, id, title, snippet, collection, chapterId }]`，
 * `kind` 是 'chapter' | 'outline' | 集合名。按命中位置排序（标题命中优先），
 * 同分时保持输入顺序，因此结果是确定的。
 */
export function searchBook(
  { query, chapters = [], outlines = [], memory = {}, structure = {} },
  { limit = 50 } = {}
) {
  const q = text(query).trim()
  if (!q) return []
  const needle = q.toLowerCase()
  const hits = []

  for (const c of chapters || []) {
    const title = text(c.title)
    const content = text(c.content)
    const inTitle = title.toLowerCase().includes(needle)
    const at = content.toLowerCase().indexOf(needle)
    if (!inTitle && at < 0) continue
    hits.push({
      kind: 'chapter',
      kindLabel: '章节',
      id: c.id,
      chapterId: c.id,
      collection: 'chapters',
      title: title || `第${c.order}章`,
      snippet: inTitle ? snippetAround(content, q) : snippetAround(content, q),
      score: inTitle ? 2 : 1
    })
  }

  for (const o of outlines || []) {
    const title = text(o.title)
    const content = text(o.content)
    const inTitle = title.toLowerCase().includes(needle)
    if (!inTitle && !content.toLowerCase().includes(needle)) continue
    hits.push({
      kind: 'outline',
      kindLabel: '设定',
      id: o.id,
      chapterId: null,
      collection: 'outlines',
      title: title || '未命名设定',
      snippet: snippetAround(content, q),
      score: inTitle ? 2 : 1
    })
  }

  for (const [collection, list] of Object.entries({ ...structure, ...memory })) {
    const schema = ENTITY_SCHEMAS[collection]
    if (!schema || !Array.isArray(list)) continue
    for (const e of list) {
      const title = entityTitle(schema, e)
      const inTitle = title.toLowerCase().includes(needle)
      const fields = Object.entries(e)
        .filter(([k]) => !['id', 'bookId', 'createdAt', 'updatedAt'].includes(k))
        .map(([, v]) => (Array.isArray(v) ? v.join('、') : text(v)))
      const blob = fields.join('\n')
      if (!inTitle && !blob.toLowerCase().includes(needle)) continue
      hits.push({
        kind: collection,
        kindLabel: ENTITY_KIND_LABEL[collection] || schema.label,
        id: e.id,
        chapterId: e.chapterId || e.sourceChapterId || null,
        collection,
        title,
        snippet: snippetAround(blob, q),
        score: inTitle ? 2 : 1
      })
    }
  }

  return hits
    .map((h, i) => ({ ...h, _i: i }))
    .sort((a, b) => b.score - a.score || a._i - b._i)
    .slice(0, Math.max(1, Number(limit) || 50))
    .map(({ _i, ...rest }) => rest)
}

/**
 * 反向查找：给定一个人物 / 地点 / 势力 / 事件，它出现在哪些事件、伏笔与章节里。
 *
 * 这是「这条设定到底影响过什么」的答案。先做内存索引（调用方传当前书的全部
 * 数据），不引入倒排索引——一本书的数据量在几千条记录这个量级，
 * 现算一次比维护一个可能过期的索引更可靠。
 */
export function relatedEntities({ type, id, memory = {}, chapters = [] }) {
  const out = { events: [], foreshadowing: [], chapters: [] }
  if (!type || !id) return out

  const entity =
    (memory[type] || []).find((e) => e.id === id) ||
    (type === 'events' ? null : (memory.events || []).find((e) => e.id === id))
  const names = entityNames(entity || {})
  const includesId = (list, value) => Array.isArray(list) && list.includes(value)

  if (type === 'characters' || type === 'factions') {
    const key = type === 'characters' ? 'characterIds' : 'factionIds'
    for (const ev of memory.events || []) if (includesId(ev[key], id)) out.events.push(ev)
    if (type === 'characters') {
      for (const f of memory.foreshadowing || []) {
        if (includesId(f.relatedCharacterIds, id)) out.foreshadowing.push(f)
      }
    }
  } else if (type === 'locations') {
    for (const ev of memory.events || []) if (ev.locationId === id) out.events.push(ev)
  } else if (type === 'events') {
    for (const f of memory.foreshadowing || []) {
      if (includesId(f.relatedEventIds, id)) out.foreshadowing.push(f)
    }
  }

  // 章节关联：名字出现在正文里。只收前 50 章，避免把整库正文扫一遍的结果
  // 全塞进界面；正文里出现名字并不等于「这条设定被使用」，所以它排在最后。
  if (names.length) {
    let n = 0
    for (const c of chapters || []) {
      const content = text(c.content)
      if (names.some((name) => content.includes(name))) {
        out.chapters.push(c)
        if (++n >= 50) break
      }
    }
  }
  return out
}
