/**
 * V2 领域实体的字段定义。**一份 schema 驱动三件事**，这是本轮最省工作量的设计：
 *
 *   1. 控制台的表单 / 表格渲染 —— 一个 EntityTable.vue 配 schema 就能服务八个实体，
 *      不必为每个人物/地点/势力各写一个组件，也不会出现「人物能改别名、势力忘了」
 *      这种不一致；
 *   2. Context Builder 的层文本生成 —— 见 renderEntity；
 *   3. 记忆提取的结构化约束 —— 见 extractionSpec。
 *
 * 三者共用一份定义，意味着加一个字段只需要改这里。
 *
 * 字段属性：
 *   key       存储的键名
 *   label     界面上显示的中文名
 *   type      'text' | 'textarea' | 'select' | 'number' | 'ref' | 'tags' | 'refs'
 *   options   select 的候选项
 *   ref       引用的集合名（'chapters' 指向章节，其余指向 COLLECTIONS）
 *   inject    是否写进给 AI 的层文本。默认 false —— 显式声明比隐式规则可靠，
 *             免得「人物外貌」这种与当前剧情无关的长文本悄悄吃掉预算
 *   required  新建时必填
 */

const CHARACTER_STATUS = [
  { value: 'alive', label: '存活' },
  { value: 'dead', label: '死亡' },
  { value: 'missing', label: '失踪' },
  { value: 'unknown', label: '未知' }
]

const FACTION_STATUS = [
  { value: 'active', label: '活跃' },
  { value: 'declining', label: '衰落' },
  { value: 'destroyed', label: '覆灭' },
  { value: 'hidden', label: '隐世' }
]

const STORY_STATUS = [
  { value: 'planned', label: '规划中' },
  { value: 'active', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'abandoned', label: '已废弃' }
]

/** 伏笔状态。Context Builder 只注入 planted / developing 两种。 */
export const FORESHADOW_STATUS = [
  { value: 'planted', label: '已埋下' },
  { value: 'developing', label: '发展中' },
  { value: 'revealed', label: '已揭示' },
  { value: 'resolved', label: '已收束' },
  { value: 'abandoned', label: '已废弃' }
]

/** 会被注入提示词的伏笔状态 */
export const ACTIVE_FORESHADOW_STATUS = ['planted', 'developing']

export const ENTITY_SCHEMAS = {
  volumes: {
    label: '卷',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '卷名', type: 'text', required: true, inject: true },
      { key: 'order', label: '序号', type: 'number' },
      { key: 'goal', label: '本卷目标', type: 'textarea', inject: true },
      { key: 'conflict', label: '本卷核心冲突', type: 'textarea', inject: true },
      { key: 'summary', label: '内容概要', type: 'textarea', inject: true },
      { key: 'ending', label: '本卷结局', type: 'textarea' },
      { key: 'status', label: '状态', type: 'select', options: STORY_STATUS }
    ]
  },

  arcs: {
    label: '篇',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '篇名', type: 'text', required: true, inject: true },
      { key: 'order', label: '序号', type: 'number' },
      { key: 'goal', label: '本篇目标', type: 'textarea', inject: true },
      { key: 'conflict', label: '本篇核心冲突', type: 'textarea', inject: true },
      { key: 'summary', label: '内容概要', type: 'textarea', inject: true },
      { key: 'climax', label: '高潮', type: 'textarea' },
      { key: 'resolution', label: '收束方式', type: 'textarea' },
      { key: 'status', label: '状态', type: 'select', options: STORY_STATUS }
    ]
  },

  characters: {
    label: '人物',
    titleKey: 'name',
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true, inject: true },
      { key: 'aliases', label: '别名', type: 'tags' },
      { key: 'identity', label: '身份', type: 'text', inject: true },
      { key: 'currentPower', label: '当前境界', type: 'text', inject: true },
      { key: 'status', label: '状态', type: 'select', options: CHARACTER_STATUS, inject: true },
      { key: 'currentLocationId', label: '所在地点', type: 'ref', ref: 'locations', inject: true },
      { key: 'currentFactionId', label: '所属势力', type: 'ref', ref: 'factions', inject: true },
      { key: 'goals', label: '当前目标', type: 'textarea', inject: true },
      { key: 'personality', label: '性格', type: 'textarea', inject: true },
      { key: 'relationships', label: '人物关系', type: 'textarea', inject: true },
      { key: 'secrets', label: '秘密', type: 'textarea', inject: true },
      { key: 'background', label: '背景', type: 'textarea' },
      { key: 'appearance', label: '外貌', type: 'textarea' },
      { key: 'arc', label: '人物弧光', type: 'textarea' },
      { key: 'lastUpdatedChapterId', label: '最近出场章节', type: 'ref', ref: 'chapters' }
    ]
  },

  locations: {
    label: '地点',
    titleKey: 'name',
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, inject: true },
      { key: 'description', label: '描述', type: 'textarea', inject: true },
      { key: 'currentState', label: '当前状态', type: 'text', inject: true },
      { key: 'rules', label: '此地规则', type: 'textarea', inject: true },
      { key: 'parentId', label: '上级地点', type: 'ref', ref: 'locations' }
    ]
  },

  factions: {
    label: '势力',
    titleKey: 'name',
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, inject: true },
      { key: 'status', label: '状态', type: 'select', options: FACTION_STATUS, inject: true },
      { key: 'description', label: '描述', type: 'textarea', inject: true },
      { key: 'goals', label: '目标', type: 'textarea', inject: true },
      { key: 'resources', label: '资源 / 底蕴', type: 'textarea' },
      { key: 'leaders', label: '首领', type: 'refs', ref: 'characters', inject: true },
      { key: 'allies', label: '盟友', type: 'tags' },
      { key: 'enemies', label: '敌对', type: 'tags' }
    ]
  },

  worldRules: {
    label: '世界规则',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '规则名', type: 'text', required: true, inject: true },
      { key: 'category', label: '分类', type: 'text' },
      { key: 'rule', label: '规则内容', type: 'textarea', required: true, inject: true },
      { key: 'priority', label: '优先级', type: 'number' },
      { key: 'exceptions', label: '例外情况', type: 'textarea', inject: true }
    ]
  },

  events: {
    label: '事件',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '事件', type: 'text', required: true, inject: true },
      { key: 'chapterId', label: '发生章节', type: 'ref', ref: 'chapters' },
      { key: 'time', label: '故事内时间', type: 'text', inject: true },
      { key: 'description', label: '经过', type: 'textarea', inject: true },
      { key: 'locationId', label: '发生地点', type: 'ref', ref: 'locations', inject: true },
      { key: 'characterIds', label: '涉及人物', type: 'refs', ref: 'characters', inject: true },
      { key: 'factionIds', label: '涉及势力', type: 'refs', ref: 'factions' },
      { key: 'consequences', label: '后果 / 影响', type: 'textarea', inject: true }
    ]
  },

  foreshadowing: {
    label: '伏笔',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '伏笔', type: 'text', required: true, inject: true },
      { key: 'content', label: '内容', type: 'textarea', required: true, inject: true },
      { key: 'status', label: '状态', type: 'select', options: FORESHADOW_STATUS, inject: true },
      { key: 'firstChapterId', label: '埋下于', type: 'ref', ref: 'chapters', inject: true },
      { key: 'expectedRevealChapterId', label: '预计揭示于', type: 'ref', ref: 'chapters' },
      { key: 'relatedCharacterIds', label: '相关人物', type: 'refs', ref: 'characters' },
      { key: 'relatedEventIds', label: '相关事件', type: 'refs', ref: 'events' },
      { key: 'revealMeaning', label: '揭示后的含义', type: 'textarea' }
    ]
  }
}

/** 需要出现在给 AI 的层文本里的字段 */
export function injectableFields(schema) {
  return (schema?.fields || []).filter((f) => f.inject)
}

/** 取一条记录的标题（列表、层文本、审计都用它） */
export function entityTitle(schema, entity) {
  if (!entity) return ''
  return String(entity[schema?.titleKey || 'name'] || entity.title || entity.name || '未命名')
}

function displayValue(field, value, resolveRef) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return ''
  if (field.type === 'select') {
    const opt = (field.options || []).find((o) => o.value === value)
    return opt ? opt.label : String(value)
  }
  if (field.type === 'ref') return resolveRef ? resolveRef(field.ref, value) : String(value)
  if (field.type === 'refs') {
    const list = Array.isArray(value) ? value : [value]
    return list.map((v) => (resolveRef ? resolveRef(field.ref, v) : String(v))).filter(Boolean).join('、')
  }
  if (field.type === 'tags') return (Array.isArray(value) ? value : [value]).join('、')
  return String(value)
}

/**
 * 把一条实体渲染成一行给 AI 看的文本。
 *
 * 只写 inject 字段，且只写有值的 —— 空字段写成「目标：」既浪费预算又会让模型
 * 以为这个人物的目标是空的。
 */
export function renderEntity(schema, entity, resolveRef) {
  if (!schema || !entity) return ''
  const parts = []
  for (const f of injectableFields(schema)) {
    const v = displayValue(f, entity[f.key], resolveRef)
    if (!v) continue
    // 标题字段本身不进「键：值」列表，它已经在行首了
    if (f.key === schema.titleKey) continue
    parts.push(`${f.label}：${v}`)
  }
  const head = entityTitle(schema, entity)
  return parts.length ? `${head} —— ${parts.join('；')}` : head
}

/** 记忆提取默认覆盖的实体。卷与篇是作者自己的规划，不由 AI 从正文里反推。 */
export const EXTRACTION_ENTITIES = [
  'characters',
  'locations',
  'factions',
  'events',
  'foreshadowing',
  'worldRules'
]

/** 新建实体时的兜底默认值，避免 AI 少给一个字段就出现没有状态的半成品记录 */
export const CREATE_DEFAULTS = {
  characters: { status: 'alive' },
  factions: { status: 'active' },
  foreshadowing: { status: 'planted' },
  worldRules: { priority: 50 }
}

/**
 * 记忆提取允许 AI 触碰的字段。
 *
 * 两条排除都是刻意的：
 *
 * 1. **引用型字段**（所在地点、涉及人物）要的是 id，AI 只会编出不存在的 id；
 *    这类字段留给用户在控制台里选。
 * 2. **`inject` 为假的字段**（人物背景、外貌、人物弧光）是作者写下的稳定事实，
 *    不是从某一章正文里能读出来的东西。让 AI 有机会改它们，等于让它用一段
 *    即兴猜测覆盖掉作者辛苦写的人物小传 —— 而且覆盖之后界面上看不出异常。
 */
export function extractionFields(schema) {
  return (schema?.fields || []).filter((f) => f.type !== 'ref' && f.type !== 'refs' && f.inject)
}

/** 记忆提取要 AI 返回的 JSON 形状说明，由同一份 schema 生成。 */
export function extractionSpec(keys = EXTRACTION_ENTITIES) {
  const spec = {}
  for (const k of keys) {
    const schema = ENTITY_SCHEMAS[k]
    if (!schema) continue
    spec[k] = extractionFields(schema).map(
      (f) => `${f.key}(${f.label}${f.type === 'select' ? '：' + (f.options || []).map((o) => o.value).join('|') : ''})`
    )
  }
  return spec
}
