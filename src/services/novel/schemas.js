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

/** 场景状态。场景是「章 → 场景」的最小施工单位，不参与记忆提取。 */
export const SCENE_STATUS = [
  { value: 'planned', label: '计划中' },
  { value: 'written', label: '已写' },
  { value: 'cut', label: '已删' }
]

/**
 * 全书规划。存在 `books.plan` 上，而不是另建一个集合：
 * 每本书只有一份，跟着书走天然具备生命周期，也无须一张永远只有一行的表。
 *
 * 字段全部由作者填写，`inject` 语义见下面的 renderBookPlan。
 */
export const BOOK_PLAN_FIELDS = [
  { key: 'premise', label: '核心命题', type: 'textarea' },
  { key: 'theme', label: '主题', type: 'textarea' },
  { key: 'mainConflict', label: '主线冲突', type: 'textarea' },
  { key: 'coreMystery', label: '核心悬念', type: 'textarea' },
  { key: 'finalGoal', label: '最终目标', type: 'textarea' },
  { key: 'hardRules', label: '不可违背的硬约束', type: 'textarea' },
  { key: 'endingConstraint', label: '结局约束', type: 'textarea' }
]

/**
 * 章节施工卡。与「大纲」的区别：大纲是给人看的规划，施工卡是**给 AI 的硬约束**。
 *
 * 这些字段直接落在 chapters 上（全部可选），不新开集合：它们与章节同生共死，
 * 整数组写回的既有路径已经覆盖它们，而新集合要额外处理删章级联与排序。
 */
export const CHAPTER_PLAN_FIELDS = [
  { key: 'povCharacterId', label: '视角人物', type: 'ref', ref: 'characters' },
  { key: 'openingState', label: '开场状态', type: 'textarea' },
  { key: 'coreConflict', label: '核心冲突', type: 'textarea' },
  { key: 'mustEvents', label: '必须发生的事件', type: 'textarea' },
  { key: 'threads', label: '涉及的线索（「主线」表示推进主线）', type: 'text' },
  { key: 'stateChanges', label: '必须发生的状态变化', type: 'textarea' },
  { key: 'worldReveals', label: '揭示的世界信息', type: 'textarea' },
  { key: 'foreshadowActions', label: '伏笔动作', type: 'textarea' },
  { key: 'forbidden', label: '禁止出现的内容', type: 'textarea' },
  { key: 'endingHook', label: '结尾钩子', type: 'textarea' },
  { key: 'continuity', label: '连续性要求', type: 'textarea' },
  { key: 'acceptance', label: '验收标准', type: 'textarea' },
  { key: 'targetWords', label: '目标字数', type: 'number' }
]

export const CHAPTER_PLAN_STATUS = [
  { value: 'none', label: '未填写' },
  { value: 'draft', label: '临时计划' },
  { value: 'confirmed', label: '已确认' }
]

/** 施工卡里由 AI 可以建议、但不得直接覆盖的锁定节点（自由多行文本）。 */
export const LOCKED_BEATS_FIELD = {
  key: 'lockedBeats',
  label: '锁定节点（每行一条，AI 不得擅自改动）',
  type: 'textarea'
}

/** 章节施工卡 + 锁定节点，一并给表单与 AI 计划预览使用。 */
export const ALL_CHAPTER_PLAN_FIELDS = [...CHAPTER_PLAN_FIELDS, LOCKED_BEATS_FIELD]

/** 叙事视角。Context Builder 把它压缩成一行「视角：第三人称限知」注入。 */
export const STYLE_POV = [
  { value: 'first', label: '第一人称' },
  { value: 'third-limited', label: '第三人称限知' },
  { value: 'third-omniscient', label: '第三人称全知' },
  { value: 'mixed', label: '混合视角（按章切换）' }
]

/** 叙事时态。中文网文里时态差异不像英文明显，但「过去/现在」会影响叙述口吻。 */
export const STYLE_TENSE = [
  { value: 'past', label: '过去时' },
  { value: 'present', label: '现在时' }
]

/**
 * 文风档案的字段。
 *
 * 文风与人物/世界观是不同的东西：它是**跨章稳定**的表达层，不该被记忆提取
 * 从某一章正文里反推。所以单独一个集合、由作者手写，并且 Context Builder
 * 只注入压缩后的一小段（见 style.js），不整段塞样本。
 */
export const STYLE_PROFILE_FIELDS = [
  { key: 'title', label: '档案名', type: 'text', required: true },
  { key: 'active', label: '启用为当前文风', type: 'checkbox' },
  { key: 'pov', label: '叙事视角', type: 'select', options: STYLE_POV },
  { key: 'tense', label: '时态', type: 'select', options: STYLE_TENSE },
  { key: 'sentenceRhythm', label: '句式节奏', type: 'textarea' },
  { key: 'dialogueRatio', label: '对白比例', type: 'text' },
  { key: 'vocabulary', label: '词汇倾向', type: 'textarea' },
  { key: 'bannedExpressions', label: '禁用表达（每行一条）', type: 'textarea' },
  { key: 'characterVoices', label: '人物语气（每人一行）', type: 'textarea' },
  { key: 'sample', label: '样本片段（注入时只取前 300 字）', type: 'textarea' }
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

/**
 * 事实层级：这条记忆是「世界真的如此」，还是某个角色的认知/传闻/推测。
 *
 * 长篇小说最典型的一类矛盾不是数据错误，而是**把角色认知当成作者事实**注入
 * 提示词：角色 A 以为 B 死了，于是 AI 在下一章让 B 真的死了。分开标注之后，
 * Context Builder 会给非事实层加前缀（见 contextBuilder 的 FACT_PREFIX），
 * 模型能看到「这是传闻」而不是把它当成硬设定。
 */
export const FACT_LAYERS = [
  { value: 'author-fact', label: '作者事实' },
  { value: 'character-belief', label: '角色认知' },
  { value: 'rumor', label: '传闻' },
  { value: 'speculation', label: '推测' }
]

export const FACT_LAYER_LABELS = Object.fromEntries(FACT_LAYERS.map((x) => [x.value, x.label]))

/** 不是作者事实的层级。注入时要加标签，避免被当成硬设定。 */
export const NON_FACT_LAYERS = ['character-belief', 'rumor', 'speculation']

/** 记忆的确认状态。pending/rejected/deprecated 不作为作者事实注入。 */
export const CONFIRM_STATUSES = [
  { value: 'confirmed', label: '已确认' },
  { value: 'pending', label: '待确认' },
  { value: 'rejected', label: '已否决' },
  { value: 'deprecated', label: '已弃用' }
]

/** 不参与提示词注入的确认状态 */
export const NON_INJECTABLE_CONFIRM = ['pending', 'rejected', 'deprecated']

/**
 * 记忆实体的公共元数据字段。
 *
 * 三个标志都不是可有可无的：
 *   - `inject:false` —— 证据原文很长，而且它不是「写下一章需要知道的事」；
 *   - `extract:false` —— 这些是流程写入的，不让 AI 有机会改；
 *     唯一的例外是 `evidence`：`extract:true` 显式请求 AI 给出原文短句。
 *   - `meta:true` —— 界面在表单里把它们收在「元数据」里，不与正文设定混排。
 */
const MEMORY_META_FIELDS = [
  { key: 'sourceChapterId', label: '来源章节', type: 'ref', ref: 'chapters', extract: false, meta: true },
  {
    key: 'evidence',
    label: '原文依据',
    type: 'textarea',
    inject: false,
    extract: true,
    meta: true
  },
  {
    key: 'factLayer',
    label: '事实层级',
    type: 'select',
    options: FACT_LAYERS,
    inject: false,
    extract: false,
    meta: true
  },
  { key: 'confidence', label: '置信度（0~1）', type: 'number', inject: false, extract: false, meta: true },
  {
    key: 'confirmStatus',
    label: '确认状态',
    type: 'select',
    options: CONFIRM_STATUSES,
    inject: false,
    extract: false,
    meta: true
  },
  { key: 'coreImmutable', label: '核心不可变', type: 'checkbox', inject: false, extract: false, meta: true },
  { key: 'changeReason', label: '变更原因', type: 'textarea', inject: false, extract: false, meta: true },
  { key: 'lastChangeId', label: '最近变更', type: 'text', inject: false, extract: false, meta: true }
]

export const ENTITY_SCHEMAS = {
  volumes: {
    label: '卷',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '卷名', type: 'text', required: true, inject: true },
      { key: 'order', label: '序号', type: 'number' },
      { key: 'theme', label: '本卷主题', type: 'textarea', inject: true },
      { key: 'goal', label: '本卷目标', type: 'textarea', inject: true },
      { key: 'conflict', label: '本卷核心冲突', type: 'textarea', inject: true },
      { key: 'startState', label: '开场状态', type: 'textarea', inject: true },
      { key: 'stakes', label: '赌注 / 代价', type: 'textarea', inject: true },
      { key: 'turningPoint', label: '关键转折', type: 'textarea', inject: true },
      { key: 'requiredBeats', label: '必须发生的情节（每行一条）', type: 'textarea', inject: true },
      { key: 'forbiddenBeats', label: '禁止发生的情节（每行一条）', type: 'textarea', inject: true },
      { key: 'characterArcs', label: '人物弧线安排', type: 'textarea' },
      { key: 'foreshadowPlan', label: '伏笔安排', type: 'textarea' },
      { key: 'summary', label: '内容概要', type: 'textarea', inject: true },
      { key: 'ending', label: '本卷结局', type: 'textarea' },
      { key: 'nextVolumePush', label: '向下一卷的推动', type: 'textarea' },
      { key: 'status', label: '状态', type: 'select', options: STORY_STATUS }
    ]
  },

  arcs: {
    label: '篇',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '篇名', type: 'text', required: true, inject: true },
      // 修复卷层断链：没有它，上下文只能靠 `book.currentVolumeId` 猜当前卷。
      { key: 'volumeId', label: '所属卷', type: 'ref', ref: 'volumes', inject: true },
      { key: 'order', label: '序号', type: 'number' },
      { key: 'goal', label: '本篇目标', type: 'textarea', inject: true },
      { key: 'conflict', label: '本篇核心冲突', type: 'textarea', inject: true },
      { key: 'requiredBeats', label: '必须发生的情节（每行一条）', type: 'textarea', inject: true },
      { key: 'forbiddenBeats', label: '禁止发生的情节（每行一条）', type: 'textarea', inject: true },
      { key: 'summary', label: '内容概要', type: 'textarea', inject: true },
      { key: 'climax', label: '高潮', type: 'textarea' },
      { key: 'resolution', label: '收束方式', type: 'textarea' },
      { key: 'status', label: '状态', type: 'select', options: STORY_STATUS }
    ]
  },

  scenes: {
    label: '场景',
    titleKey: 'title',
    fields: [
      { key: 'title', label: '场景名', type: 'text', required: true, inject: true },
      { key: 'chapterId', label: '所属章节', type: 'ref', ref: 'chapters' },
      { key: 'order', label: '章内序号', type: 'number' },
      { key: 'povCharacterId', label: '视角人物', type: 'ref', ref: 'characters', inject: true },
      { key: 'locationId', label: '发生地点', type: 'ref', ref: 'locations', inject: true },
      { key: 'characterIds', label: '出场人物', type: 'refs', ref: 'characters', inject: true },
      { key: 'purpose', label: '场景目的', type: 'textarea', inject: true },
      { key: 'conflict', label: '场景冲突', type: 'textarea', inject: true },
      { key: 'outcome', label: '结果 / 状态变化', type: 'textarea', inject: true },
      { key: 'summary', label: '内容概要', type: 'textarea', inject: true },
      { key: 'status', label: '状态', type: 'select', options: SCENE_STATUS }
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
      { key: 'lastUpdatedChapterId', label: '最近出场章节', type: 'ref', ref: 'chapters' },
      ...MEMORY_META_FIELDS
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
      { key: 'parentId', label: '上级地点', type: 'ref', ref: 'locations' },
      ...MEMORY_META_FIELDS
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
      { key: 'enemies', label: '敌对', type: 'tags' },
      ...MEMORY_META_FIELDS
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
      { key: 'exceptions', label: '例外情况', type: 'textarea', inject: true },
      ...MEMORY_META_FIELDS
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
      { key: 'consequences', label: '后果 / 影响', type: 'textarea', inject: true },
      ...MEMORY_META_FIELDS
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
      { key: 'revealMeaning', label: '揭示后的含义', type: 'textarea' },
      ...MEMORY_META_FIELDS
    ]
  },

  styleProfiles: {
    label: '文风',
    titleKey: 'title',
    fields: STYLE_PROFILE_FIELDS
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
  if (field.type === 'checkbox') return value ? '是' : ''
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

/** 全书规划是否为空（空的时候不注入，省预算也省得让模型看见一堆空标题）。 */
export function isBookPlanEmpty(plan) {
  return !BOOK_PLAN_FIELDS.some((f) => String(plan?.[f.key] ?? '').trim())
}

/** 把 `books.plan` 渲染成给 AI 的层文本。空字段不写。 */
export function renderBookPlan(plan) {
  if (!plan) return ''
  const parts = []
  for (const f of BOOK_PLAN_FIELDS) {
    const v = String(plan[f.key] ?? '').trim()
    if (v) parts.push(`${f.label}：${v}`)
  }
  return parts.join('\n')
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
  return (schema?.fields || []).filter((f) => {
    // 显式声明优先于默认规则：evidence 的 inject 是 false（它不写进提示词），
    // 但它恰恰要从正文里提取，所以单独标 extract:true；元数据则标 extract:false。
    if (f.extract === false) return false
    if (f.extract === true) return true
    return f.type !== 'ref' && f.type !== 'refs' && f.inject
  })
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
