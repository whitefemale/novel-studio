/**
 * 人物关系图：全部由既有集合**派生**，不新开集合、不写库、不进快照。
 *
 * 这个模块只有纯函数，因为关系图最容易变成「看起来对但没法验证」的东西：
 * 布局带随机数、边重复合并规则模糊、悬空引用悄悄画一条线到 (0,0)。
 * 这里的每一条都做成确定性的，同输入永远同输出，单测与冒烟才能钉住它。
 *
 * 边界：
 *   - 只画**已知记录之间**的关系。引用指向已删除的记录时直接丢弃那条边，
 *     绝不凭名字猜一个新节点出来 —— 那会让删除过的人物在图上复活。
 *   - 人物自由文本关系（characters.relationships）只解析「一行里恰好出现
 *     两个已知人物名 + 它们之间有明确分隔符」的行。宁可漏画，不可乱画：
 *     一句「林昭想起苏九曾说过……」如果被画成一条边，用户就再也不敢信这张图。
 */

/** 节点种类。颜色写在这里而不是 CSS 里，因为 SVG 的 fill 需要真实值。 */
export const GRAPH_NODE_KINDS = [
  { key: 'character', label: '人物', color: '#2b6cb0' },
  { key: 'faction', label: '势力', color: '#805ad5' },
  { key: 'location', label: '地点', color: '#2f855a' }
]

/**
 * 边的种类。
 *
 * `weight` 同时是排序依据与线宽系数：首领关系永远比「同场一次」更值得画粗。
 * `dashed` 表示推断出来的、可信度较低的边（自由文本关系、同场、敌对）。
 */
export const GRAPH_EDGE_KINDS = [
  { key: 'leader', label: '首领', weight: 3, dashed: false },
  { key: 'member', label: '所属', weight: 2, dashed: false },
  { key: 'ally', label: '盟友', weight: 2, dashed: false },
  { key: 'enemy', label: '敌对', weight: 2, dashed: true },
  { key: 'cooccur', label: '同场', weight: 1, dashed: false },
  { key: 'relation', label: '人物关系', weight: 1, dashed: true },
  { key: 'foreshadow', label: '伏笔同涉', weight: 1, dashed: true },
  { key: 'located', label: '所在', weight: 1, dashed: true }
]

export const GRAPH_EDGE_KIND_MAP = Object.fromEntries(GRAPH_EDGE_KINDS.map((k) => [k.key, k]))

/** 画布上限。超出时截断并在界面上如实说明，不静默丢弃。 */
export const GRAPH_LIMITS = {
  maxNodes: 80,
  maxEdges: 400,
  maxLabelChars: 24,
  maxRelationLineChars: 80
}

/** 关系文本里被认可的分隔符。没有它们就不成「关系」，只是叙述。 */
const RELATION_SEPARATORS = /[-—–~～→＞>:：,，、/|与和及跟同是乃为]/

/** 归一化名称：去空白、转小写。势力盟友/敌对用名称字符串引用，只能这么比。 */
export function normalizeGraphName(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase()
}

function labelOf(kind, record) {
  const raw =
    kind === 'character'
      ? record.name
      : kind === 'faction'
        ? record.name
        : record.name || record.title
  const text = String(raw ?? '').trim() || '未命名'
  return text.length > GRAPH_LIMITS.maxLabelChars
    ? text.slice(0, GRAPH_LIMITS.maxLabelChars) + '…'
    : text
}

const KIND_ORDER = { character: 0, faction: 1, location: 2 }

/**
 * 从人物自由文本里解析关系边。
 *
 * 返回 `[{ sourceId, targetId, label }]`，sourceId/targetId 都是人物记录的 id。
 * 解析规则刻意保守，三条同时满足才算：
 *   1. 该行恰好出现**两个不同**的已知人物（姓名或别名）；
 *   2. 两次出现之间有一个明确的分隔符（`—`、`与`、`是`、`：` 等）；
 *   3. 行本身不超过 80 字（更长的句子几乎一定是叙述而不是关系条目）。
 *
 * 同一个名字既是 A 的姓名又是 B 的别名时，按「更长者优先」避免把「林昭」
 * 匹配进「林昭然」里；已经占用的字符区间不会被第二个名字重复占用。
 */
export function parseRelationshipText(text, characters = []) {
  const lines = String(text ?? '').split(/\r?\n/)
  const entries = []
  for (const c of Array.isArray(characters) ? characters : []) {
    if (!c || !c.id) continue
    for (const raw of [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]) {
      const name = String(raw ?? '').trim()
      if (name) entries.push({ id: c.id, name })
    }
  }
  // 长名字优先，避免子串误命中
  entries.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name, 'zh-CN'))

  const out = []
  const seen = new Set()
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.length > GRAPH_LIMITS.maxRelationLineChars) continue
    const used = []
    const hits = []
    for (const entry of entries) {
      let from = 0
      for (;;) {
        const at = line.indexOf(entry.name, from)
        if (at < 0) break
        const end = at + entry.name.length
        const overlaps = used.some((u) => at < u.end && end > u.start)
        if (!overlaps) {
          used.push({ start: at, end })
          hits.push({ id: entry.id, start: at, end })
        }
        from = at + 1
      }
    }
    hits.sort((a, b) => a.start - b.start)
    // 同一个人被姓名与别名各命中一次时只算一次
    const unique = []
    for (const h of hits) {
      if (!unique.some((u) => u.id === h.id)) unique.push(h)
    }
    if (unique.length !== 2) continue
    const between = line.slice(unique[0].end, unique[1].start).trim()
    if (!between || between.length > 16 || !RELATION_SEPARATORS.test(between)) continue
    const key = [unique[0].id, unique[1].id].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      sourceId: unique[0].id,
      targetId: unique[1].id,
      label: line.length > GRAPH_LIMITS.maxLabelChars
        ? line.slice(0, GRAPH_LIMITS.maxLabelChars) + '…'
        : line
    })
  }
  return out
}

function edgeKey(kind, a, b) {
  // 首领/所属/所在是有方向的；其余关系是无向的，反向重复必须合并
  if (kind === 'leader' || kind === 'member' || kind === 'located') return `${kind}|${a}|${b}`
  return `${kind}|${[a, b].sort().join('|')}`
}

/**
 * 由既有集合构建关系图。
 *
 * 节点：人物 + 势力（默认不含地点，可在界面上切换）。
 * 边：势力首领、人物所属、势力盟友/敌对、事件同场（次数即权重）、
 *     人物自由文本关系、伏笔同涉，以及（可选）人物/事件与地点的「所在」。
 *
 * 合并规则：同一种关系在同一对节点之间只留一条边，权重相加、标签取第一条。
 * 悬空引用（指向不存在的记录）直接丢弃 —— 见文件头的说明。
 */
export function buildRelationshipGraph({
  characters = [],
  factions = [],
  locations = [],
  events = [],
  foreshadowing = [],
  options = {}
} = {}) {
  const maxNodes = Math.max(1, Number(options.maxNodes) || GRAPH_LIMITS.maxNodes)
  const maxEdges = Math.max(1, Number(options.maxEdges) || GRAPH_LIMITS.maxEdges)
  const includeLocations = !!options.includeLocations
  const includeForeshadow = !!options.includeForeshadow
  const includeTextRelations = options.includeTextRelations !== false

  const nodes = new Map() // nodeKey -> node
  const charNodes = new Map() // record id -> nodeKey
  const factionNodes = new Map()
  const locationNodes = new Map()

  const addNode = (kind, record, extra = {}) => {
    if (!record || !record.id) return null
    const key = `${kind}:${record.id}`
    if (nodes.has(key)) return key
    const node = {
      id: key,
      refId: record.id,
      kind,
      label: labelOf(kind, record),
      status: String(record.status ?? ''),
      group: '',
      ...extra
    }
    nodes.set(key, node)
    if (kind === 'character') charNodes.set(record.id, key)
    if (kind === 'faction') factionNodes.set(record.id, key)
    if (kind === 'location') locationNodes.set(record.id, key)
    return key
  }

  for (const c of Array.isArray(characters) ? characters : []) {
    addNode('character', c, { group: String(c?.currentFactionId ?? '') })
  }
  for (const f of Array.isArray(factions) ? factions : []) {
    addNode('faction', f, { group: String(f?.id ?? '') })
  }
  if (includeLocations) {
    for (const l of Array.isArray(locations) ? locations : []) addNode('location', l)
  }

  const rawEdges = []
  const pushEdge = (kind, a, b, extra = {}) => {
    if (!a || !b || a === b) return
    const meta = GRAPH_EDGE_KIND_MAP[kind]
    if (!meta) return
    rawEdges.push({
      kind,
      source: a,
      target: b,
      weight: Number(extra.weight) || meta.weight,
      label: String(extra.label ?? meta.label),
      dashed: extra.dashed ?? meta.dashed
    })
  }

  // 势力首领 / 人物所属
  for (const f of Array.isArray(factions) ? factions : []) {
    const fKey = factionNodes.get(f?.id)
    if (!fKey) continue
    for (const cid of Array.isArray(f.leaders) ? f.leaders : []) {
      const cKey = charNodes.get(cid)
      if (cKey) pushEdge('leader', fKey, cKey)
    }
  }
  for (const c of Array.isArray(characters) ? characters : []) {
    const cKey = charNodes.get(c?.id)
    const fKey = factionNodes.get(c?.currentFactionId)
    if (cKey && fKey) pushEdge('member', cKey, fKey)
  }

  // 势力盟友 / 敌对：leaders 是 ref，allies/enemies 是名称标签，只能按名称解析
  const factionByName = new Map()
  for (const f of Array.isArray(factions) ? factions : []) {
    const n = normalizeGraphName(f?.name)
    if (n && !factionByName.has(n)) factionByName.set(n, f)
  }
  for (const f of Array.isArray(factions) ? factions : []) {
    const aKey = factionNodes.get(f?.id)
    if (!aKey) continue
    for (const [field, kind] of [
      ['allies', 'ally'],
      ['enemies', 'enemy']
    ]) {
      for (const tag of Array.isArray(f[field]) ? f[field] : []) {
        const target = factionByName.get(normalizeGraphName(tag))
        const bKey = target ? factionNodes.get(target.id) : null
        if (bKey && bKey !== aKey) pushEdge(kind, aKey, bKey)
      }
    }
  }

  // 事件同场：同一事件里出现的人物两两相连，权重 = 共同出现次数
  const cooccur = new Map()
  for (const ev of Array.isArray(events) ? events : []) {
    const ids = [...new Set((Array.isArray(ev?.characterIds) ? ev.characterIds : []).filter(Boolean))]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = charNodes.get(ids[i])
        const b = charNodes.get(ids[j])
        if (!a || !b) continue
        const key = [a, b].sort().join('|')
        cooccur.set(key, (cooccur.get(key) || 0) + 1)
      }
    }
    if (includeLocations) {
      const locKey = locationNodes.get(ev?.locationId)
      if (locKey) {
        for (const cid of ids) {
          const cKey = charNodes.get(cid)
          if (cKey) pushEdge('located', cKey, locKey)
        }
      }
    }
  }
  for (const [key, count] of cooccur) {
    const [a, b] = key.split('|')
    pushEdge('cooccur', a, b, { weight: count, label: `同场 ${count} 次` })
  }

  // 伏笔同涉（默认关闭：它会把「同一条伏笔提到过的两个人」连起来，噪声偏大）
  if (includeForeshadow) {
    for (const fs of Array.isArray(foreshadowing) ? foreshadowing : []) {
      const ids = [...new Set((Array.isArray(fs?.relatedCharacterIds) ? fs.relatedCharacterIds : []).filter(Boolean))]
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = charNodes.get(ids[i])
          const b = charNodes.get(ids[j])
          if (a && b) pushEdge('foreshadow', a, b)
        }
      }
    }
  }

  // 人物所在地点
  if (includeLocations) {
    for (const c of Array.isArray(characters) ? characters : []) {
      const cKey = charNodes.get(c?.id)
      const lKey = locationNodes.get(c?.currentLocationId)
      if (cKey && lKey) pushEdge('located', cKey, lKey)
    }
  }

  // 人物自由文本关系
  if (includeTextRelations) {
    for (const c of Array.isArray(characters) ? characters : []) {
      const parsed = parseRelationshipText(c?.relationships, characters)
      for (const rel of parsed) {
        const a = charNodes.get(rel.sourceId)
        const b = charNodes.get(rel.targetId)
        if (a && b) pushEdge('relation', a, b, { label: rel.label, weight: 1 })
      }
    }
  }

  // 合并重复边
  const merged = new Map()
  for (const e of rawEdges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue // 悬空引用
    const key = edgeKey(e.kind, e.source, e.target)
    const prev = merged.get(key)
    if (prev) {
      prev.weight += e.weight
      prev.count = (prev.count || 1) + 1
    } else {
      merged.set(key, {
        id: key,
        source: e.source,
        target: e.target,
        kind: e.kind,
        label: e.label,
        weight: e.weight,
        dashed: e.dashed,
        count: 1
      })
    }
  }

  // 先按原始度数选节点，避免截断把高连接度的人物丢掉
  const degreeOf = new Map()
  for (const e of merged.values()) {
    degreeOf.set(e.source, (degreeOf.get(e.source) || 0) + 1)
    degreeOf.set(e.target, (degreeOf.get(e.target) || 0) + 1)
  }
  const allNodes = [...nodes.values()].map((n) => ({ ...n, degree: degreeOf.get(n.id) || 0 }))
  allNodes.sort(
    (a, b) =>
      b.degree - a.degree ||
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      a.label.localeCompare(b.label, 'zh-CN') ||
      a.id.localeCompare(b.id)
  )
  const keptNodes = allNodes.slice(0, maxNodes)
  const keptIds = new Set(keptNodes.map((n) => n.id))
  const droppedNodes = allNodes.length - keptNodes.length

  const allEdges = [...merged.values()]
    .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        (GRAPH_EDGE_KIND_MAP[a.kind]?.weight || 0) - (GRAPH_EDGE_KIND_MAP[b.kind]?.weight || 0) ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target)
    )
  const keptEdges = allEdges.slice(0, maxEdges)
  const droppedEdges = allEdges.length - keptEdges.length

  // 截断之后的真实度数
  const finalDegree = new Map()
  for (const e of keptEdges) {
    finalDegree.set(e.source, (finalDegree.get(e.source) || 0) + 1)
    finalDegree.set(e.target, (finalDegree.get(e.target) || 0) + 1)
  }
  for (const n of keptNodes) n.degree = finalDegree.get(n.id) || 0

  const byKind = (k) => keptNodes.filter((n) => n.kind === k).length
  return {
    nodes: keptNodes,
    edges: keptEdges,
    stats: {
      nodes: keptNodes.length,
      edges: keptEdges.length,
      characters: byKind('character'),
      factions: byKind('faction'),
      locations: byKind('location'),
      droppedNodes,
      droppedEdges
    },
    truncated: droppedNodes > 0 || droppedEdges > 0,
    includeLocations,
    includeForeshadow
  }
}

function nodeRadius(node) {
  const base = node.kind === 'faction' ? 9 : 6
  return base + Math.min(9, Math.sqrt(Math.max(0, node.degree || 0)) * 3)
}

/**
 * 布局：按集团分组排在一圈上。
 *
 * 「按势力分组」不是画一个以势力为中心的气泡图 —— 那需要力导向迭代，
 * 迭代次数一多就既慢又难验证。把同一势力的人物排在一起、围绕圆周依次展开，
 * 已经能让「这个势力的人聚在一段弧上」这一眼看得出来，而且**完全确定性**。
 *
 * 分组顺序、组内顺序都来自稳定排序（度数降序 → 名称 → id），
 * 同输入必得同坐标，单测可直接 deepEqual。
 */
export function layoutRelationshipGraph(graph, { width = 860, height = 540, padding = 56 } = {}) {
  const w = Math.max(240, Number(width) || 860)
  const h = Math.max(200, Number(height) || 540)
  const pad = Math.max(8, Math.min(Number(padding) || 56, Math.min(w, h) / 3))
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []

  const groups = new Map()
  for (const n of nodes) {
    const key = n.kind === 'location' ? 'zz:location' : n.group || `${n.kind}:solo`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }
  const ordered = []
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const list = groups.get(key)
    list.sort(
      (a, b) =>
        b.degree - a.degree ||
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
        a.label.localeCompare(b.label, 'zh-CN') ||
        a.id.localeCompare(b.id)
    )
    ordered.push(...list)
  }

  const cx = w / 2
  const cy = h / 2
  const radius = Math.max(30, Math.min(w, h) / 2 - pad)
  const n = ordered.length
  const placed = ordered.map((node, i) => {
    const angle = n <= 1 ? -Math.PI / 2 : -Math.PI / 2 + (i * 2 * Math.PI) / n
    const r = nodeRadius(node)
    return {
      ...node,
      x: n <= 1 ? cx : Math.round((cx + radius * Math.cos(angle)) * 10) / 10,
      y: n <= 1 ? cy : Math.round((cy + radius * Math.sin(angle)) * 10) / 10,
      r,
      angle: Math.round(angle * 10000) / 10000
    }
  })
  const byId = new Map(placed.map((p) => [p.id, p]))
  const placedEdges = edges
    .map((e) => {
      const a = byId.get(e.source)
      const b = byId.get(e.target)
      if (!a || !b) return null
      return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y, sourceNode: a, targetNode: b }
    })
    .filter(Boolean)

  return { width: w, height: h, center: { x: cx, y: cy }, radius, nodes: placed, edges: placedEdges }
}
