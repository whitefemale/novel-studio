import { ENTITY_SCHEMAS, entityTitle, ACTIVE_FORESHADOW_STATUS } from './schemas'

/**
 * 时间线：把散落在各集合里的事件与伏笔摊到同一条轴上。
 *
 * **纯函数、无 I/O**，两个理由：
 *   1. 排序与「哪里断了链」必须能被确定性验证 —— 这两件事出错的样子都是
 *      「界面上看起来是对的」，只有断言抓得住；
 *   2. 它与一致性检查共用同一次扫描（见下），而一致性检查是「打开控制台即算」
 *      的常开功能，不能有 I/O。
 *
 * ## 为什么 warnings 就是一致性规则 #1
 *
 * 「事件指向一个已被删掉的人物」这类断链，在两处的说法其实是同一件事：
 * 时间线上它是「这条引用画不出来」，一致性报告里它是「high 级问题」。
 * 各写一份实现的话，两边早晚会给出不同的答案（一边报一边不报），而用户
 * 只能信其中一份。所以这里算一次，一致性检查直接拿来用。
 *
 * ## 排序的轴
 *
 * 默认按**章节顺序**排，而不是故事内时间字符串：`timelineStart/End` 与事件
 * 的 `time` 都是自由文本（「第七天夜里」「二月初七」），字符串比较给不出
 * 正确的先后，而章节顺序是作者亲手排的、永远可用。故事内时间只作同一章内
 * 的次级排序键。要按时间排的话有 `sortBy: 'time'` 这个切换。
 */

export const TIMELINE_SORTS = [
  { value: 'chapter', label: '按章节顺序' },
  { value: 'time', label: '按故事内时间' }
]

export const TIMELINE_KINDS = {
  event: '事件',
  plant: '埋下伏笔',
  reveal: '预计回收'
}

/**
 * 从 schema 推出全部引用型字段。
 *
 * 刻意不手写一张清单：schemas.js 已经是实体字段的唯一定义处，再抄一份的话，
 * 新加一个 ref 字段就会出现「表格里能选、时间线上看不见断链」这种漏洞，
 * 而且没有任何报错提示它存在。
 */
export function refFields(schemas = ENTITY_SCHEMAS) {
  const out = []
  for (const [type, schema] of Object.entries(schemas)) {
    for (const f of schema.fields || []) {
      if (f.type !== 'ref' && f.type !== 'refs') continue
      out.push({ type, field: f.key, ref: f.ref, label: f.label, many: f.type === 'refs' })
    }
  }
  return out
}

/** 上面那个推导的结果是常量，算一次就够 */
const REF_FIELDS = refFields()

const titleOf = (type, rec) =>
  entityTitle(type === 'chapters' ? { titleKey: 'title' } : ENTITY_SCHEMAS[type] || {}, rec)

/**
 * 逐条检查引用型字段有没有指向不存在（或已被删掉）的记录。
 *
 * 返回的每一条都带够定位信息：**哪个实体的哪个字段**指向**哪个不存在的 id**。
 * 只说「有 3 处断链」的报告是没法用的 —— 用户没有任何办法找到它们。
 */
export function findBrokenRefs(data = {}, { schemas = ENTITY_SCHEMAS } = {}) {
  const issues = []
  const has = (coll, id) => {
    if (!id) return true // 空引用不是断链，是「还没填」
    const list = coll === 'chapters' ? data.chapters || [] : data[coll] || []
    return list.some((r) => r.id === id)
  }

  for (const meta of REF_FIELDS) {
    for (const rec of data[meta.type] || []) {
      if (!rec || !rec.id) continue
      const raw = rec[meta.field]
      const ids = meta.many ? (Array.isArray(raw) ? raw : raw ? [raw] : []) : raw ? [raw] : []
      for (const id of ids) {
        if (has(meta.ref, id)) continue
        const collLabel = meta.ref === 'chapters' ? '章节' : ENTITY_SCHEMAS[meta.ref]?.label || meta.ref
        issues.push({
          id: `${meta.type}:${rec.id}:${meta.field}:${id}`,
          sourceType: meta.type,
          sourceId: rec.id,
          sourceTitle: titleOf(meta.type, rec) || '未命名',
          field: meta.field,
          fieldLabel: meta.label,
          targetType: meta.ref,
          targetId: id,
          message:
            `${ENTITY_SCHEMAS[meta.type]?.label || meta.type}「${titleOf(meta.type, rec) || '未命名'}」` +
            `的${meta.label}指向一条已不存在的${collLabel}（${id}）`
        })
      }
    }
  }
  return issues
}

/**
 * 伏笔是否「逾期未回收」：说好要回收的那一章已经写完了，伏笔却还挂着。
 *
 * 判据用**章节的 status**而不是「章号小于当前章」：作者可能故意把回收点放在
 * 后面几章，而「已完成」是一个明确的、作者自己按过的开关。
 *
 * 导出来给一致性报告用 —— 两处必须给出同一个答案，否则会出现「轴上标着逾期、
 * 报告里说没问题」这种局面，而用户只能信其中一个。
 */
export function overdueForeshadow(f, revealChapter) {
  if (!ACTIVE_FORESHADOW_STATUS.includes(f?.status)) return false
  return revealChapter?.status === 'done'
}

/** 章节 id → 章号（1 起）。找不到返回 null，由调用方决定怎么表现「章节没了」。 */
function chapterIndex(chapters = []) {
  const map = new Map()
  chapters.forEach((c, i) => map.set(c.id, typeof c.order === 'number' ? c.order : i + 1))
  return map
}

/**
 * 解析一条记录上的全部引用，供节点详情显示「涉及谁、在哪」。
 * 指向已删除记录的引用会带 `ok: false`，界面上据此标红而不是直接不显示 ——
 * 不显示的话用户根本不知道这里断过。
 */
function resolveRefs(rec, type, data, refList = REF_FIELDS) {
  const out = []
  for (const meta of refList) {
    if (meta.type !== type) continue
    const raw = rec?.[meta.field]
    const ids = meta.many ? (Array.isArray(raw) ? raw : raw ? [raw] : []) : raw ? [raw] : []
    for (const id of ids) {
      const list = meta.ref === 'chapters' ? data.chapters || [] : data[meta.ref] || []
      const hit = list.find((r) => r.id === id)
      out.push({
        field: meta.field,
        fieldLabel: meta.label,
        type: meta.ref,
        id,
        name: hit ? titleOf(meta.ref, hit) : '（已删除）',
        ok: !!hit
      })
    }
  }
  return out
}

/**
 * 构造时间线。
 *
 * `chapters` 必须有 order；`events` / `foreshadowing` 是活记录（墓碑已在存储层
 * 过滤掉）。其余集合用来解析引用的显示名。
 */
export function buildTimeline({
  chapters = [],
  events = [],
  foreshadowing = [],
  locations = [],
  characters = [],
  factions = [],
  worldRules = [],
  volumes = [],
  arcs = [],
  sortBy = 'chapter'
} = {}) {
  const data = { chapters, events, foreshadowing, locations, characters, factions, worldRules, volumes, arcs }
  const order = chapterIndex(chapters)
  const byId = new Map(chapters.map((c) => [c.id, c]))

  const nodes = []

  for (const e of events) {
    if (!e || !e.id) continue
    // 没有 chapterId 的事件仍然要上轴：它只是「还没归到某一章」，
    // 藏起来会让用户以为事件丢了。它排在所有有章节的节点之后。
    const o = e.chapterId ? order.get(e.chapterId) : null
    nodes.push({
      id: `event:${e.id}`,
      kind: 'event',
      entityId: e.id,
      chapterId: e.chapterId || '',
      chapterOrder: o ?? null,
      chapterTitle: byId.get(e.chapterId)?.title || '',
      orphan: !!e.chapterId && o == null,
      time: String(e.time || ''),
      title: e.title || '未命名事件',
      detail: e.description || '',
      extra: e.consequences || '',
      refs: resolveRefs(e, 'events', data)
    })
  }

  for (const f of foreshadowing) {
    if (!f || !f.id) continue
    const plantOrder = f.firstChapterId ? order.get(f.firstChapterId) : null
    const revealOrder = f.expectedRevealChapterId ? order.get(f.expectedRevealChapterId) : null
    const revealChapter = byId.get(f.expectedRevealChapterId)
    const overdue = overdueForeshadow(f, revealChapter)

    if (f.firstChapterId || !f.expectedRevealChapterId) {
      nodes.push({
        id: `plant:${f.id}`,
        kind: 'plant',
        entityId: f.id,
        chapterId: f.firstChapterId || '',
        chapterOrder: plantOrder ?? null,
        chapterTitle: byId.get(f.firstChapterId)?.title || '',
        orphan: !!f.firstChapterId && plantOrder == null,
        time: '',
        title: f.title || '未命名伏笔',
        detail: f.content || '',
        extra: f.revealMeaning || '',
        status: f.status || '',
        overdue,
        refs: resolveRefs(f, 'foreshadowing', data)
      })
    }
    if (f.expectedRevealChapterId) {
      nodes.push({
        id: `reveal:${f.id}`,
        kind: 'reveal',
        entityId: f.id,
        chapterId: f.expectedRevealChapterId,
        chapterOrder: revealOrder ?? null,
        chapterTitle: revealChapter?.title || '',
        orphan: revealOrder == null,
        time: '',
        title: f.title || '未命名伏笔',
        detail: f.revealMeaning || f.content || '',
        extra: '',
        status: f.status || '',
        overdue,
        refs: resolveRefs(f, 'foreshadowing', data)
      })
    }
  }

  const cmp = (a, b) => {
    if (sortBy === 'time') {
      // 没填「故事内时间」的排在最后：它们的位置无从判断，混在中间会把
      // 真正有时间标记的那几条顺序也带乱
      const aEmpty = !a.time
      const bEmpty = !b.time
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1
      const c = String(a.time).localeCompare(String(b.time), 'zh-Hans-CN')
      if (c) return c
    }
    // 没有章节归属的节点（含章节已删除的）排在最后：它们的位置本来就不确定，
    // 插在中间只会让「这一章到底发生了什么」变得可疑。
    const ao = a.chapterOrder ?? Number.MAX_SAFE_INTEGER
    const bo = b.chapterOrder ?? Number.MAX_SAFE_INTEGER
    if (ao !== bo) return ao - bo
    const c = String(a.time || '').localeCompare(String(b.time || ''), 'zh-Hans-CN')
    // id 兜底：没有它，同一位置的两条节点两次渲染可能换顺序
    return c || String(a.id).localeCompare(String(b.id))
  }
  nodes.sort(cmp)

  const warnings = findBrokenRefs(data)
  const orphans = nodes.filter((n) => n.orphan)
  const overdueNodes = nodes.filter((n) => n.overdue)

  return {
    nodes,
    warnings,
    counts: {
      events: nodes.filter((n) => n.kind === 'event').length,
      foreshadowing: foreshadowing.length,
      orphan: orphans.length,
      overdue: overdueNodes.length,
      warnings: warnings.length
    }
  }
}
