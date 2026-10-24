import { chatStream } from '../llm.js'
import { createProvider } from './providers.js'
import { describeError } from './errors.js'
import { messagesFromContext } from '../prompts.js'
import { buildContext, PROMPT_VERSION } from '../novel/contextBuilder.js'
import {
  ENTITY_SCHEMAS,
  entityTitle,
  extractionFields,
  extractionSpec,
  EXTRACTION_ENTITIES,
  CREATE_DEFAULTS,
  CHAPTER_PLAN_FIELDS
} from '../novel/schemas.js'
import { validatePlan, shouldBlockPlan } from '../novel/planValidate.js'
import { normalizeTitle } from '../migration.js'
import { coll } from '../storage.js'
import { genId } from '../ids.js'
import { providerFromUrl } from './tokenUsage.js'
import { modelForStage } from './models.js'

/**
 * AI 编排器：把「写一章」拆成可独立中止、可单独重试的阶段。
 *
 * 为什么要有它，而不是继续在组件里直接调 chatStream：写完一章之后还有一件事
 * 必须做 —— 把这一章里确定发生的事实（谁死了、谁升境了、埋了什么伏笔）提取出来
 * 存进记忆。这件事必须发生在**紧接着写完之后**（此时模型还记得正文），
 * 而且它自己也是一次 AI 调用（要计费、要能中止、要能单独重试）。
 * 组件里塞不下这套状态机，故抽成服务。
 *
 * 三条不变量：
 *
 * 1. **只有 commitMemory 会写库。** 写正文与提取都只产出数据。于是用户在
 *    中途中止、或提取失败，都不会留下半提交的记忆。
 * 2. **必经 Context Builder。** 本模块自己拼的提示词只有「提取」那一段，
 *    写正文的提示词一律来自 buildContext —— 规格书要求组件不得自己拼 prompt。
 * 3. **AI 不能直接改记忆。** 提取结果先变成「变更清单」，再按风险分级：
 *    低风险直接落库，高风险进审阅队列等用户确认。模型在正文里写死一个角色，
 *    不该等于数据库里那个角色自动死了。
 *
 * 另外，本模块**不 import 任何 store**：它是服务层，靠调用方注入 `recordRun`
 * 与 `onCommitted` 来落库与刷新内存。这样它能被纯逻辑测试驱动，
 * 也不会和 store 形成循环依赖。
 */

export const STAGE_LABELS = {
  write: '写正文',
  extract: '提取记忆',
  review: '一致性审校',
  plan: '生成计划',
  fix: '定向修复'
}

/** 默认档：写正文 + 提取记忆。审校**刻意不在这里**，见下。 */
export const DEFAULT_STAGES = ['write', 'extract']

/**
 * 一致性审校的提示词与输出契约（规格书 §9.2）。
 *
 * 每条问题必须自带 `quote`（正文原句）与 `location`，这样界面既能定位，
 * 又能让定向修复只改该改的地方。`falsePositiveHint` 是模型主动说明「什么情况下
 * 这条可能不算问题」——它降低误报对用户的伤害，也让用户更容易做判断。
 *
 * 审校**不在 DEFAULT_STAGES 里**，这一点是刻意的：它是唯一一个「用户不点就
 * 不花钱」的 AI 阶段。写正文与提取记忆是每章都要跑的，审校不是 —— 把它塞进
 * 默认档，等于替用户决定「每写一章都多付一次钱」，而这种花费在界面上只会
 * 表现为「账户余额掉得比预想快」。
 */
export function buildReviewTask(text) {
  return [
    '请审校下面这一章的正文与上述设定是否一致，逐条列出问题，不要客套话，不要重复正文。',
    '只输出 JSON，不要解释，不要 Markdown 代码围栏。格式：',
    '{"issues":[{"category":"setting|continuity|style","severity":"high|medium|low",' +
      '"title":"","quote":"","location":"","explanation":"","evidence":"",' +
      '"falsePositiveHint":"","suggestion":""}],"severity":"high|medium|low"}',
    'category：setting=与人物/世界/设定冲突，continuity=前后情节接不上，style=文风与表达。',
    'quote 必须是从正文中逐字摘出的原句（不超过 80 字）；location 写段落或大致位置；',
    'explanation 说明为什么这是问题；evidence 引用与之冲突的已有设定；',
    'falsePositiveHint 说明什么情况下它可能不算问题；suggestion 给出最小改法。',
    'severity 是整章的总体严重度。没有问题时 issues 返回空数组。',
    '',
    '【待审校正文】',
    String(text || '')
  ].join('\n')
}

/**
 * 生成章节施工卡的提示词。
 *
 * 输出只包含施工卡字段，**不包含 lockedBeats**：锁定节点是作者的领地，
 * 模型连建议权都没有（要改只能走 planProposals 提案）。返回的是草稿，
 * 由界面预览、用户确认后才写进章节。
 */
export function buildPlanTask(chapter) {
  const skeleton = CHAPTER_PLAN_FIELDS.map((f) => {
    const v = f.type === 'number' ? 1500 : ''
    return `"${f.key}": ${f.type === 'number' ? v : `"${f.label}${f.type === 'ref' ? '（填已有 id，不确定就留空）' : ''}"`}`
  }).join(', ')
  const locked = String(chapter?.lockedBeats || '').trim()
  return [
    `请为第 ${chapter?.order ?? '?'} 章「${chapter?.title || '未命名'}」生成一份施工卡草案。`,
    '施工卡是给写作模型的硬约束，不是文学评论：要具体、可检查、每行一条。',
    '必须与上述设定、全书规划、当前卷 / 篇的必发与禁发节拍保持一致。',
    locked
      ? `以下节点已被作者锁定，草案必须原样保留其含义，不得删改或绕开：\n${locked}`
      : '作者没有锁定节点。',
    '只输出 JSON，不要解释，不要 Markdown 代码围栏。格式：',
    `{${skeleton}}`,
    'mustEvents / stateChanges / forbidden / acceptance 用换行分隔多条；targetWords 给整数。',
    '',
    chapter?.content ? `【本章已写正文（如有）】\n${String(chapter.content).slice(-6000)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 定向修复的提示词。
 *
 * 输入是「一条审校问题 + 整章正文」，输出是**整章修订稿**而不是片段：
 * 片段定位依赖偏移量，模型给错一个字符就会改到别处；整章返回虽然费 token，
 * 但界面可以用 diff 预览，用户接受前原文一个字都不会动。
 */
export function buildFixTask(issue, text) {
  return [
    '请只针对下面这一条审校问题修订整章正文。',
    '要求：1) 保留章名、情节主线与所有未被该问题涉及的段落，尽量逐字保留；',
    '2) 不要新增与问题无关的内容；3) 不要输出解释，不要 Markdown 代码围栏。',
    '',
    '【审校问题】',
    `类别：${issue?.categoryLabel || issue?.category || '未分类'}`,
    `严重度：${issue?.severity || 'medium'}`,
    `问题：${issue?.title || ''}`,
    issue?.quote ? `原文：${issue.quote}` : '',
    issue?.explanation ? `说明：${issue.explanation}` : '',
    issue?.suggestion ? `建议改法：${issue.suggestion}` : '',
    '',
    '只输出 JSON，格式：',
    '{"revised":"修订后的完整章节正文","explanation":"一句话说明改了什么"}',
    '',
    '【整章正文】',
    String(text || '')
  ]
    .filter((x) => x !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------
// 结构化 JSON 提取
// ---------------------------------------------------------------------------

/**
 * 从模型输出里抠出第一个完整的 JSON 对象或数组。失败返回 null。
 *
 * **字符串字面量感知**是关键：不能用「找第一个 { 配最后一个 }」这种写法，
 * 也不能用正则 —— 正文里出现花括号（`他想起那句「{此处应有伏笔}」`）、
 * 或某段文字里带引号，都会让朴素方案切出一个语法错误的片段，
 * 而失败的样子是「记忆静默地什么都没提取到」，最难查。
 *
 * 所以这里逐字符扫描，维护三样东西：是否在字符串内、转义状态、括号深度。
 * 顺便也就解决了 Markdown 代码围栏与前后夹带的散文 —— 扫描从第一个
 * `{`/`[` 开始，围栏与散文自然落在它前面。
 */
export function extractJson(raw) {
  const s = String(raw || '')
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{' || c === '[') {
      start = i
      break
    }
  }
  if (start < 0) return null

  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escaped = false

  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1))
        } catch {
          // 括号配平了但 JSON 本身有语法错误（模型写了个尾逗号之类）。
          // 不再向后找第二个候选：那样更容易把两段不相干的内容拼在一起。
          return null
        }
      }
    }
  }
  // 扫到结尾都没配平 —— 多半是被 max_tokens 截断了
  return null
}

// ---------------------------------------------------------------------------
// 风险分级
// ---------------------------------------------------------------------------

/**
 * 把一条变更判成 'high' / 'low'。
 *
 * 判成高风险的都不是「改错了很难改回来」，而是**改错了用户看不出来**：
 * 一个人物死了、一个势力覆灭了、一条世界规则被推翻，这些会静默改变后续
 * 每一章的生成前提。低风险项（改个身份描述、加个地点）错了用户一眼能看见，
 * 直接入库反而省事。
 *
 * `currentPower` 方向无法可靠判断（「筑基三层」到「练气九层」谁高谁低，
 * 文本里没有全局顺序）—— 所以任何境界变化都按高风险处理。宁可多让用户
 * 点一次确认，也不能让境界倒退被静默写进去。
 */
export function classifyRisk(change) {
  if (!change) return 'low'
  const { entity, field, from, to } = change
  if (entity === 'worldRules') return 'high'
  if (entity === 'characters' && field === 'status') {
    const involved = [from, to]
    if (involved.some((v) => v === 'dead' || v === 'missing')) return 'high'
  }
  if (entity === 'characters' && field === 'currentPower') return 'high'
  if (entity === 'factions' && field === 'status' && (to === 'destroyed' || from === 'destroyed')) {
    return 'high'
  }
  return 'low'
}

/** 高风险变更的一句话说明，进审阅队列给用户看 */
export function riskReason(change) {
  const { entity, field, from, to } = change
  const label = (v) => {
    const f = extractionFields(ENTITY_SCHEMAS[entity] || {}).find((x) => x.key === field)
    const opt = (f?.options || []).find((o) => o.value === v)
    return opt ? opt.label : String(v ?? '')
  }
  if (entity === 'worldRules') return change.op === 'create' ? '新增世界规则' : '修改世界规则'
  if (entity === 'characters' && field === 'status') {
    return `人物状态：${label(from) || '未设置'} → ${label(to)}`
  }
  if (entity === 'characters' && field === 'currentPower') {
    return `人物境界：${from || '未设置'} → ${to}`
  }
  if (entity === 'factions' && field === 'status') {
    return `势力状态：${label(from) || '未设置'} → ${label(to)}`
  }
  return `${field}：${from ?? ''} → ${to}`
}

// ---------------------------------------------------------------------------
// 提取结果的规范化与比对
// ---------------------------------------------------------------------------

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])

/**
 * 把 AI 给的一条记录按 schema 规范化。
 *
 * 三件事都是为了防止「看起来能用、实际是垃圾」的数据入库：
 *   - 只保留 schema 认可的字段（模型很爱多给几个自创字段）；
 *   - select 值按 value 或 label 归一，两个都不匹配就丢掉这个字段
 *     （模型常说「死亡」而不是 'dead'，放进去界面上的下拉框会变成空的）；
 *   - 空值一律不保留，绝不能让模型用空字符串把已有内容擦掉。
 */
export function normalizeExtractedItem(entity, item) {
  const schema = ENTITY_SCHEMAS[entity]
  if (!schema || !item || typeof item !== 'object') return null
  const out = {}
  for (const f of extractionFields(schema)) {
    const raw = item[f.key]
    if (raw == null || raw === '') continue
    if (f.type === 'tags') {
      const arr = asArray(raw).map((x) => String(x).trim()).filter(Boolean)
      if (arr.length) out[f.key] = arr
      continue
    }
    if (f.type === 'number') {
      const n = Number(raw)
      if (Number.isFinite(n)) out[f.key] = n
      continue
    }
    if (f.type === 'select') {
      const v = String(raw).trim()
      const opt =
        (f.options || []).find((o) => o.value === v) ||
        (f.options || []).find((o) => o.label === v)
      if (opt) out[f.key] = opt.value
      continue
    }
    const v = String(raw).trim()
    if (v) out[f.key] = v
  }
  return Object.keys(out).length ? out : null
}

function titleOf(entity, item) {
  const schema = ENTITY_SCHEMAS[entity]
  if (!schema || !item) return ''
  return String(item[schema.titleKey] || item.name || item.title || '').trim()
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(asArray(a)) === JSON.stringify(asArray(b))
  }
  return String(a ?? '') === String(b ?? '')
}

/**
 * 把 AI 提取出的记录与当前记忆比对，产出变更清单。**纯函数**。
 *
 * 匹配已有实体先按 id、再按规范化标题 —— 只按 id 的话，模型少填一个 id
 * 就会把「林昭」重新建一遍，于是同一个人物在库里有了两份、各自带一半的状态，
 * 后续提示词里会出现两条互相矛盾的人物行。
 *
 * 没有匹配上的一律视为新建（op:'create'），这也是「AI 只能新增与更新、
 * 不能删除」的体现：删除必须由用户在控制台里做，模型没有这个能力。
 */
export function diffMemoryCandidates(current = {}, extracted = {}, { chapterId = null } = {}) {
  const changes = []
  for (const entity of EXTRACTION_ENTITIES) {
    const items = asArray(extracted[entity])
    if (!items.length) continue
    const schema = ENTITY_SCHEMAS[entity]
    const list = current[entity] || []
    for (const rawItem of items) {
      const item = normalizeExtractedItem(entity, rawItem)
      if (!item) continue
      // evidence 是「这条设定出自正文哪句话」，由 AI 单独给出。它不作为
      // 普通字段参与逐字段比对，而是附加在变更上、由 applyChange 写进元数据，
      // 这样审阅队列里能直接展示依据。
      const evidence = String(item.evidence || rawItem?.evidence || '').trim()
      delete item.evidence
      const name = titleOf(entity, { ...rawItem, ...item }) || titleOf(entity, rawItem)
      let hit = null
      if (rawItem && typeof rawItem === 'object' && rawItem.id) {
        hit = list.find((e) => e.id === rawItem.id) || null
      }
      if (!hit && name) {
        const norm = normalizeTitle(name)
        hit = list.find((e) => normalizeTitle(titleOf(entity, e)) === norm) || null
      }

      if (!hit) {
        const data = { ...(CREATE_DEFAULTS[entity] || {}), ...item }
        if (!titleOf(entity, data)) continue // 连名字都没有的记录没法用
        // 章节归属由我们写，不由模型写：事件发生在本章、伏笔埋在本章，
        // 这是调用方掌握的事实。而 chapterId 是引用型字段，提取提示词里
        // 本就要求模型别碰 id —— 这两件事必须一致。
        // 没有它，时间线（按章节窗口取事件）与「埋下于」会永远为空。
        if (chapterId) {
          if (entity === 'events') data.chapterId = chapterId
          if (entity === 'foreshadowing' && data.status === 'planted') {
            data.firstChapterId = chapterId
          }
        }
        if (evidence) data.evidence = evidence
        if (chapterId) data.sourceChapterId = chapterId
        data.factLayer = 'author-fact'
        data.confirmStatus = 'confirmed'
        changes.push({
          entity,
          id: null,
          op: 'create',
          title: titleOf(entity, data),
          field: null,
          from: null,
          to: null,
          data,
          chapterId: chapterId || null,
          evidence,
          coreImmutable: false
        })
        continue
      }

      const coreImmutable = !!hit.coreImmutable
      for (const [field, to] of Object.entries(item)) {
        if (field === schema.titleKey) continue // 标题字段不参与比对，它只是匹配用
        const from = hit[field]
        if (sameValue(from, to)) continue
        changes.push({
          entity,
          id: hit.id,
          op: 'update',
          title: titleOf(entity, hit) || name,
          field,
          from: from ?? null,
          to,
          data: { [field]: to },
          chapterId: chapterId || null,
          evidence,
          coreImmutable
        })
      }
    }
  }
  return changes.map((c) => ({
    ...c,
    // 核心不可变实体的任何改动都升级为高风险，与 classifyRisk 的领域规则叠加，
    // 而不是替换它 —— 「核心不可变」是用户加的锁，不是另一套风险算法。
    risk: c.coreImmutable ? 'high' : c.risk || classifyRisk(c)
  }))
}

/** 变更的一条人读描述，审阅队列与生成历史共用 */
export function describeChange(change) {
  if (!change) return ''
  if (change.op === 'create') {
    return `新增${ENTITY_SCHEMAS[change.entity]?.label || change.entity}：${change.title}`
  }
  return `${change.title} · ${riskReason(change)}`
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

/**
 * 写一条记忆变更日志。失败只告警、不中断 —— 变更本身已经落库，
 * 为了一条日志把「已生效」变成「报错」会让界面与库不一致。
 */
async function logMemoryChange(bookId, entry) {
  try {
    const now = Date.now()
    const record = { id: genId(), bookId, createdAt: now, updatedAt: now, ...entry }
    await coll.memoryChangeLog.upsert(bookId, record)
    return record
  } catch (e) {
    console.warn('[memory] 变更日志写入失败', e)
    return null
  }
}

/**
 * 应用一条变更。
 *
 * 更新走「读当前记录 → 合并 → 写回」，而不是直接写 change.data 里那份快照：
 * 从提取到用户点「通过」之间可能隔了很久，期间用户可能在控制台里改过这个人物，
 * 直接覆盖会把他的修改吃掉。
 *
 * 同时补上事实元数据并写一条 memoryChangeLog：
 *   - `sourceChapterId` / `evidence` 回答「这条设定是从哪句话来的」——
 *     没有它们，用户看到一条错误的人物状态时根本无从核对；
 *   - `factLayer` 默认 author-fact（AI 从正文提取的确定事实），
 *     角色认知/传闻由用户在控制台里改；
 *   - `lastChangeId` 让「这一条是被哪次提取改的」可追，也是撤销的入口。
 */
export async function applyChange(bookId, change, { source = 'auto' } = {}) {
  if (!bookId || !change) return null
  if (!coll[change.entity]) return null
  const now = Date.now()
  const logId = genId()

  if (change.op === 'create') {
    const item = {
      ...change.data,
      id: genId(),
      bookId,
      sourceChapterId: change.chapterId || change.data?.sourceChapterId || '',
      evidence: change.evidence || change.data?.evidence || '',
      factLayer: change.data?.factLayer || 'author-fact',
      confirmStatus: 'confirmed',
      confidence: Number.isFinite(Number(change.data?.confidence))
        ? Number(change.data.confidence)
        : 0.8,
      lastChangeId: logId,
      createdAt: now,
      updatedAt: now
    }
    await coll[change.entity].upsert(bookId, item)
    await logMemoryChange(bookId, {
      id: logId,
      entity: change.entity,
      entityId: item.id,
      op: 'create',
      field: null,
      title: change.title || entityTitle(ENTITY_SCHEMAS[change.entity], item),
      before: null,
      after: { ...(change.data || {}) },
      risk: change.risk || 'low',
      source,
      chapterId: change.chapterId || null,
      evidence: change.evidence || '',
      changeReason: change.reason || ''
    })
    return item
  }

  const list = await coll[change.entity].getAll(bookId)
  const cur = list.find((e) => e.id === change.id)
  if (!cur) return null
  const before = {}
  for (const key of Object.keys(change.data || {})) before[key] = cur[key] ?? null
  const item = {
    ...cur,
    ...change.data,
    sourceChapterId: change.chapterId || cur.sourceChapterId || '',
    evidence: change.evidence || cur.evidence || '',
    factLayer: change.data?.factLayer || cur.factLayer || 'author-fact',
    confirmStatus: 'confirmed',
    confidence: Number.isFinite(Number(change.data?.confidence))
      ? Number(change.data.confidence)
      : Number(cur.confidence) || 0.8,
    changeReason: change.reason || cur.changeReason || '',
    lastChangeId: logId,
    updatedAt: now
  }
  await coll[change.entity].upsert(bookId, item)
  await logMemoryChange(bookId, {
    id: logId,
    entity: change.entity,
    entityId: item.id,
    op: change.op || 'update',
    field: change.field || null,
    title: change.title || entityTitle(ENTITY_SCHEMAS[change.entity], item),
    before,
    after: { ...(change.data || {}) },
    risk: change.risk || 'low',
    source,
    chapterId: change.chapterId || null,
    evidence: change.evidence || '',
    changeReason: change.reason || ''
  })
  return item
}

/**
 * 撤销一条记忆变更。
 *
 * **只在当前值仍等于「那次变更写入的值」时才允许**：否则撤销会覆盖掉之后
 * 用户自己做的修改 —— 而撤销按钮在界面上看起来只是一个「后悔」，
 * 没人会预期它把自己的后续编辑一起吃掉。
 *
 * 撤销本身也写一条反向日志，于是「撤销的撤销」也能在日志里被看见，
 * 而不是让历史凭空少一段。
 */
export async function undoMemoryChange(bookId, logId) {
  if (!bookId || !logId) return { ok: false, message: '参数不完整' }
  const logs = await coll.memoryChangeLog.getAll(bookId)
  const log = logs.find((x) => x.id === logId)
  if (!log) return { ok: false, message: '变更记录不存在' }
  if (log.undone) return { ok: false, message: '这条变更已经撤销过了' }
  if (!coll[log.entity]) return { ok: false, message: '未知的实体类型' }

  const list = await coll[log.entity].getAll(bookId)
  const cur = list.find((e) => e.id === log.entityId)

  if (log.op === 'create') {
    if (!cur) return { ok: false, message: '记录已经不存在了' }
    await coll[log.entity].remove(bookId, log.entityId)
    await logMemoryChange(bookId, {
      entity: log.entity,
      entityId: log.entityId,
      op: 'delete',
      field: null,
      title: log.title,
      before: log.after || null,
      after: null,
      risk: log.risk,
      source: 'undo',
      chapterId: log.chapterId || null,
      undoOf: log.id,
      changeReason: `撤销：新增${ENTITY_SCHEMAS[log.entity]?.label || log.entity}`
    })
    await coll.memoryChangeLog.upsert(bookId, { ...log, undone: true, undoneAt: Date.now(), updatedAt: Date.now() })
    return { ok: true, message: `已撤销新增：${log.title}` }
  }

  if (!cur) return { ok: false, message: '记录已经不存在了（可能已被删除）' }
  for (const [field, val] of Object.entries(log.after || {})) {
    if (!sameValue(cur[field], val)) {
      return {
        ok: false,
        message: '这条变更之后记录又被修改过，撤销会覆盖后续修改，已取消'
      }
    }
  }
  const reverseId = genId()
  const restored = {
    ...cur,
    ...(log.before || {}),
    lastChangeId: reverseId,
    updatedAt: Date.now()
  }
  await coll[log.entity].upsert(bookId, restored)
  await logMemoryChange(bookId, {
    id: reverseId,
    entity: log.entity,
    entityId: log.entityId,
    op: 'undo',
    field: log.field,
    title: log.title,
    before: log.after || null,
    after: log.before || null,
    risk: log.risk,
    source: 'undo',
    chapterId: log.chapterId || null,
    undoOf: log.id,
    changeReason: '撤销一次记忆变更'
  })
  await coll.memoryChangeLog.upsert(bookId, { ...log, undone: true, undoneAt: Date.now(), updatedAt: Date.now() })
  return { ok: true, message: `已撤销：${log.title}` }
}

/**
 * 提交一批变更：低风险直接落库，高风险进审阅队列（reviewHighRisk 打开时）。
 *
 * 返回 { applied, queued }，调用方据此提示用户「有 N 条待确认」。
 */
export async function commitChanges(
  bookId,
  changes = [],
  { reviewHighRisk = true, autoApplyLowRisk = true, chapterId = null } = {}
) {
  const applied = []
  const queued = []
  for (const change of changes) {
    // 核心不可变实体的任何字段改动都按高风险处理：它是作者钉死的人设/规则，
    // 一旦被 AI 顺手改掉，后续每一章都会建立在错误前提上。
    const highRisk = change.risk === 'high' || change.coreImmutable === true
    const mustReview = highRisk && reviewHighRisk
    // 关掉「低风险自动入库」后，低风险项也进队列。默认开 = 保持旧行为。
    const lowRiskQueued = !highRisk && autoApplyLowRisk === false
    if (mustReview || lowRiskQueued) {
      const now = Date.now()
      const item = {
        id: genId(),
        bookId,
        chapterId: change.chapterId || chapterId,
        entity: change.entity,
        entityId: change.id,
        op: change.op,
        title: change.title,
        field: change.field,
        from: change.from,
        to: change.to,
        data: change.data,
        risk: highRisk ? 'high' : change.risk || 'low',
        coreImmutable: change.coreImmutable === true,
        evidence: change.evidence || '',
        reason: riskReason(change),
        status: 'pending',
        createdAt: now,
        updatedAt: now
      }
      await coll.reviewQueue.upsert(bookId, item)
      queued.push(item)
    } else {
      const item = await applyChange(bookId, change, {
        source: change.coreImmutable ? 'auto-core' : 'auto'
      })
      if (item) applied.push(item)
    }
  }
  return { applied, queued }
}

// ---------------------------------------------------------------------------
// 提取提示词
// ---------------------------------------------------------------------------

/** 已存在实体的清单，带 id，供模型按 id 引用而不是重新造一个 */
function existingLines(memory = {}) {
  const lines = []
  for (const entity of EXTRACTION_ENTITIES) {
    const list = memory[entity] || []
    if (!list.length) continue
    const schema = ENTITY_SCHEMAS[entity]
    const label = schema?.label || entity
    lines.push(
      `【已有${label}】` +
        list
          .map((e) => {
            const bits = []
            if (e.status) bits.push(`状态=${e.status}`)
            if (e.currentPower) bits.push(`境界=${e.currentPower}`)
            return `id=${e.id} ${entityTitle(schema, e)}${bits.length ? `（${bits.join('，')}）` : ''}`
          })
          .join('；')
    )
  }
  return lines.join('\n')
}

/** 由 schema 生成的输出骨架，让模型不必猜字段名 */
function outputSkeleton() {
  const spec = extractionSpec()
  const lines = ['{', '  "summary": "本章梗概，120 字以内，第三人称，只写发生了什么",', '  "timelineEnd": "本章结束时的故事内时间，无法判断就留空",']
  const keys = Object.keys(spec)
  keys.forEach((k, ki) => {
    const fields = [
      '"id": "更新已有记录时填它的 id，新记录留空"',
      '"evidence": "支撑这条记录的正文原句（必填）"'
    ]
    for (const f of extractionFields(ENTITY_SCHEMAS[k])) {
      const opts = f.type === 'select' ? (f.options || []).map((o) => o.value).join('|') : ''
      fields.push(`"${f.key}": "${f.label}${opts ? `，取值 ${opts}` : ''}"`)
    }
    lines.push(`  "${k}": [ { ${fields.join(', ')} } ]${ki === keys.length - 1 ? '' : ','}`)
  })
  lines.push('}')
  return lines.join('\n')
}

export function buildExtractionMessages({ book, chapter, text, memory }) {
  const system = [
    '你是长篇小说设定库的管理员。你的唯一任务是从刚写好的章节正文里，提取出**确定发生**的设定事实。',
    '严格遵守：',
    '1. 只记录正文里明确写出的事实。推测、伏笔式的暗示、以及「可能会发生」的内容一律不记录。',
    '2. 已有记录请填它对应的 id；只有确实没见过的人/地/势力/事件/伏笔才新建。',
    '3. 不要修改你无法从正文中确认的字段。没提到就整个字段省略，**绝不要填空字符串**——空值会被视为「把它清空」。',
    '4. 本章没有产生任何设定变化时，各数组留空。不要为了凑数而编造。',
    '5. 只输出一个 JSON 对象，不要输出解释文字，不要用 Markdown 代码围栏。',
    '6. 每一条记录都必须带 `evidence` 字段：从本章正文中摘一句能支撑这条设定的原文（不超过 60 字），不要改写、不要编造。没有原文依据就不要记录这一条。'
  ].join('\n')

  const user = [
    `以下是小说《${book?.title || '未命名'}》第 ${chapter?.order ?? '?'} 章的正文，请提取其中的设定事实。`,
    existingLines(memory),
    '【本章正文】',
    String(text || '').slice(-12000),
    '【输出格式】（照这个结构，字段名与取值必须完全按此）',
    outputSkeleton()
  ]
    .filter(Boolean)
    .join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

// ---------------------------------------------------------------------------
// 工作流
// ---------------------------------------------------------------------------

function makeRun({ bookId, chapterId, action, stages }) {
  return {
    id: genId(),
    bookId,
    chapterId,
    action,
    status: 'running',
    stages: stages.map((id) => ({ id, label: STAGE_LABELS[id] || id, status: 'pending', error: '' })),
    startedAt: Date.now(),
    finishedAt: null,
    abort: null
  }
}

/**
 * 跑一次「写本章」的工作流。
 *
 * 参数里的 `chat` 与 `recordRun` 都是注入的：前者让测试能用假流替换真实网络，
 * 后者让本模块不必 import store（服务层不碰 store，是这个项目的既有分层）。
 * `callbacks` 有四个：
 *   - `onDelta(text)`  只有写正文阶段会产文本
 *   - `onStage({stage, status, record})`  阶段开始（status:'start'）与计费落库
 *     之后（status:'done'，带 record）各回调一次，供界面显示「正在提取记忆…」
 *   - `onControl({abort, run})`  **同步**回调，用户点「停止」全靠它
 *
 *
 * 返回 { run, output, context, changes, records, applied, queued, error, abort, retry }。
 * `abort()` 中止**当前阶段**；`retry()` 从第一个未完成的阶段接着跑，
 * 于是「正文写好了、提取失败」不必重花一次钱重写正文。
 */
export async function runChapterWorkflow({
  input,
  settings,
  stages = DEFAULT_STAGES,
  callbacks = {},
  chat = chatStream,
  recordRun = null
}) {
  const bookId = input?.book?.id || input?.bookId || null
  const chapter = input?.chapter || null
  const ctx = buildContext(input)
  const run = makeRun({ bookId, chapterId: chapter?.id, action: input?.action, stages })

  /**
   * 生成记录的上下文摘要。**不存整段提示词之外的推导**，只存
   * 「用了多少 token、哪些层被丢弃、来源是什么」——它回答的是
   * 「这次生成凭什么这么写」，而不是把整库数据再抄一份进历史。
   */
  function contextSummary(c) {
    const layers = c?.metadata?.layers || []
    return {
      promptVersion: PROMPT_VERSION,
      tokens: c?.metadata?.totalTokens || 0,
      budget: c?.metadata?.budget || 0,
      outputReserve: c?.metadata?.outputReserve || 0,
      overBudget: !!c?.metadata?.overBudget,
      dropped: c?.metadata?.droppedLayers || [],
      truncated: c?.metadata?.truncatedLayers || [],
      layers: layers.map((l) => ({
        id: l.id,
        label: l.label,
        tokens: l.tokens,
        items: l.items,
        dropped: !!l.dropped,
        truncated: !!l.truncated
      })),
      sources: layers
        .flatMap((l) => l.itemsDetail || [])
        .map((it) => it.source)
        .filter(Boolean)
        .slice(0, 200)
    }
  }

  const writeSummary = contextSummary(ctx)
  const runParams = {
    temperature: settings?.temperature,
    maxTokens: settings?.maxTokens,
    streamUsage: settings?.streamUsage !== false
  }

  let output = ''
  let extractRaw = ''
  let reviewRaw = ''
  let reviewReport = null
  let planRaw = ''
  let planDraft = null
  let planValidation = null
  let planBlocked = false
  let fixRaw = ''
  let fixDraft = null
  let chapterMeta = null
  let changes = []
  let applied = []
  let queued = []
  let error = ''
  let aborted = false
  let truncated = false
  let truncatedMessage = ''
  // 每个阶段的计费记录。一次跑两阶段，界面上要能同时看到合计与分项，
  // 所以这里攒成一个数组交给调用方，而不是只回传最后一个。
  const records = []

  const stageOf = (id) => run.stages.find((s) => s.id === id)

  /** 记一条并同步给调用方。记账失败不能拖垮生成（正文已经在界面上了）。 */
  async function record(params, stage) {
    if (!recordRun || !bookId) return null
    try {
      // taskId 由调用方（AiPanel）注入，一次工作流的所有阶段共用它，
      // 于是「这一章花了多少钱」与「那次中断留下的草稿」能对上。
      // promptVersion / params / contextSummary 是「可复现」的三件套：
      // 同一个提示词版本 + 同一组参数 + 同一份上下文摘要，出了回归时能定位
      // 到底是模型变了、参数变了，还是上下文被裁掉了。
      const rec = await recordRun({
        ...params,
        taskId: input?.taskId || '',
        promptVersion: params.promptVersion || PROMPT_VERSION,
        params: params.params || runParams,
        contextSummary: params.contextSummary || writeSummary
      })
      if (rec) {
        records.push(rec)
        callbacks.onStage?.({ stage, status: 'done', record: rec })
      }
      return rec
    } catch (e) {
      console.error('[usage] 生成记录落库失败', e)
      return null
    }
  }

  /**
   * 跑一次流式调用，返回 `{ text, usage, error, errorInfo, aborted, truncated,
   * finishReason, attempts }`。
   *
   * 所有阶段都走 `chatStreamReliable`：瞬时故障（断网 / 空闲超时 / 429 / 5xx）
   * 会自动重试最多两次，但**只在还没收到正文时**；每次重试都经 `onRetry`
   * 告知界面。401/400 之类的配置错误不重试，直接报出来。
   *
   * 截断（finish_reason=length）**保留正文**但不算成功：阶段状态是 'truncated'，
   * 后续阶段不再继续 —— 拿半章去提取记忆会得到半章的事实。
   */
  function streamOnce({ messages, onDelta, onRetry, stageId }) {
    // 每个阶段各自取模型：写正文可以配一个文笔好的，提取记忆配一个严格输出 JSON
    // 的，审校配一个长上下文强的。留空时 `settingsForStage` 原样返回 settings，
    // 所以未配置的用户行为与旧版逐字一致。
    //
    // 统一经 Provider 发出请求：预设与展示在 providers.js，重试/超时/截断在
    // request.js —— 这里只剩阶段状态机。注入的 `chat` 继续透传（测试依赖它）。
    const provider = createProvider({ settings, stage: stageId, ...(chat ? { chat } : {}) })
    return new Promise((resolve) => {
      let text = ''
      let usage = null
      let done = false
      const finish = (o) => {
        if (done) return
        done = true
        run.abort = null
        resolve({ text, usage, ...o })
      }
      const handle = provider.chatStream({
        messages,
        maxRetries: settings?.maxRetries,
        idleTimeoutSec: settings?.requestIdleTimeoutSec,
        callbacks: {
          onDelta: (t) => {
            text += t
            onDelta?.(t)
          },
          onUsage: (u) => {
            usage = u
          },
          onDone: (payload) => finish({ finishReason: payload?.finishReason || '' }),
          onTruncated: (info) =>
            finish({
              truncated: true,
              error: describeError(info, { includeDetail: false }),
              errorInfo: info,
              finishReason: info?.finishReason || 'length'
            }),
          onAborted: () => finish({ aborted: true }),
          onError: (err) => {
            const info = typeof err === 'string' ? { message: err, category: 'unknown' } : err || {}
            finish({
              error: describeError(info, { includeDetail: false }) || '请求失败',
              errorInfo: info
            })
          },
          onRetry: (r) => onRetry?.(r)
        }
      })
      run.abort = handle.abort
    })
  }

  async function stageWrite() {
    const st = stageOf('write')
    st.status = 'running'
    callbacks.onStage?.({ stage: 'write', status: 'start' })
    const startedAt = Date.now()
    const messages = messagesFromContext(ctx)
    const promptText = messages.map((m) => m.content).join('\n')
    const res = await streamOnce({
      messages,
      onDelta: callbacks.onDelta,
      onRetry: callbacks.onRetry,
      stageId: 'write'
    })
    output = res.text
    if (res.truncated) {
      truncated = true
      truncatedMessage = res.error || '输出达到上限被截断'
      st.status = 'truncated'
      st.note = truncatedMessage
      st.error = ''
    } else {
      st.status = res.error ? 'error' : res.aborted ? 'aborted' : 'done'
      st.error = res.error || ''
      if (res.error) error = res.error
    }
    if (res.aborted) aborted = true

    // 没有文本、没有用量、也没被中止 → 请求大概压根没发出去（400/断网），
    // 这时记一条按提示词估算的「用量」是在编造花费，不如不记。
    // 被中止的则一定要记：钱已经花掉了，只是没花完。
    if (res.text || res.usage || res.aborted || res.truncated) {
      await record(
        {
          bookId,
          chapterId: chapter?.id,
          action: input?.action || 'continue',
          stage: 'write',
          provider: providerFromUrl(settings?.baseUrl),
          model: modelForStage(settings, 'write'),
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          inputText: promptText,
          outputText: res.text,
          durationMs: Date.now() - startedAt,
          status: res.truncated
            ? 'truncated'
            : res.error
              ? 'error'
              : res.aborted
                ? 'aborted'
                : 'done',
          finishReason: res.finishReason || '',
          attempts: res.attempts,
          error: res.error || ''
        },
        'write'
      )
    }
    // 截断的正文不完整，继续提取会得到半章事实；停在写正文这一步。
    return !res.error && !res.aborted
  }

  async function stageExtract() {
    const st = stageOf('extract')
    st.status = 'running'
    callbacks.onStage?.({ stage: 'extract', status: 'start' })
    // 续写时把「本章已有正文 + 这次生成的部分」一起交给提取，而不是只给新生成的那一段：
    // 提示词要的是**本章梗概**，而续写之后整章就是这两段拼起来的东西。只给片段的话，
    // 写回的梗概会是一个片段的梗概 —— 它会覆盖掉整章的总纲，界面上还看不出异常。
    const extractText =
      input?.action === 'continue' && chapter?.content
        ? `${chapter.content}\n${output}`
        : output
    const messages = buildExtractionMessages({
      book: input?.book,
      chapter,
      text: extractText,
      memory: input?.memory || {}
    })
    const promptText = messages.map((m) => m.content).join('\n')

    let res = null
    let parsed = null
    // 最多两次。模型偶发会先说一句「好的，以下是提取结果」再给围栏 JSON，
    // 而这一段的温度通常不高，重试一次的收益明显大于成本。
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedThis = Date.now()
      res = await streamOnce({ messages, onRetry: callbacks.onRetry, stageId: 'extract' })
      parsed = extractJson(res.text)
      extractRaw = res.text
      if (res.aborted) aborted = true
      // **每次尝试各记一条**：重试是一次真实计费调用，只记最后那次会让用户看到的
      // 金额低于账单 —— 而「这一章花了多少钱」正是整个记账功能存在的意义。
      if (res.text || res.usage || res.aborted) {
        await record(
          {
            bookId,
            chapterId: chapter?.id,
            action: input?.action || 'continue',
            stage: 'extract',
            provider: providerFromUrl(settings?.baseUrl),
            model: modelForStage(settings, 'extract'),
            inputTokens: res.usage?.inputTokens,
            outputTokens: res.usage?.outputTokens,
            inputText: promptText,
            outputText: res.text,
            durationMs: Date.now() - startedThis,
            status: res.truncated
              ? 'truncated'
              : res.error
                ? 'error'
                : res.aborted
                  ? 'aborted'
                  : parsed
                    ? 'done'
                    : 'error',
            finishReason: res.finishReason || '',
            attempts: res.attempts,
            error: res.error || ''
          },
          'extract'
        )
      }
      if (parsed || res.error || res.aborted) break
    }
    st.status = res.error ? 'error' : res.aborted ? 'aborted' : parsed ? 'done' : 'error'
    st.error = res.error || (parsed ? '' : '未能从返回内容中解析出 JSON')
    if (st.status === 'error') error = st.error

    if (parsed) {
      // 梗概与故事内时间是**章节**的字段，不是记忆实体。只取出来交给调用方，
      // 由它决定写在哪一章 —— 此刻正文还没被用户插入到任何章节里，
      // 只有调用方知道这段文字最终落到哪儿。见 AiPanel 的 applyChapterMeta。
      const summary = String(parsed.summary || '').trim()
      const timelineEnd = String(parsed.timelineEnd || '').trim()
      chapterMeta = summary || timelineEnd ? { summary, timelineEnd } : null

      changes = diffMemoryCandidates(input?.memory || {}, parsed, { chapterId: chapter?.id })
      const committed = await commitChanges(bookId, changes, {
        reviewHighRisk: settings?.reviewHighRisk !== false,
        autoApplyLowRisk: settings?.autoApplyLowRisk !== false,
        chapterId: chapter?.id
      })
      applied = committed.applied
      queued = committed.queued
    }
    // 记忆提取失败**不是**整次生成的失败：正文已经拿到手了，
    // 把它标成失败会让用户以为这一章白写了。
    return true
  }

  /**
   * 一致性审校。
   *
   * 三条刻意的设计：
   *
   * 1. **必经 Context Builder**（规格书 05）：人物状态、世界规则、未收束的伏笔、
   *    近期时间线都在里面 ——「林昭已死亡」正是模型判断这一章有没有写错所需要
   *    的判据，而这份判据的第一版实现就在 buildContext 里，不该在这里重拼。
   * 2. **整章正文单独给一条消息**：context 里的正文层只保留尾部（那是为续写
   *    设计的），拿它去审校等于只审了后半章，而前后矛盾最容易出现在开头。
   * 3. **报告不落库**：它是对**这一版正文**的意见，正文一改就过期，存下来只是
   *    过期噪音；它也不是规格书 05 意义上的持久实体。报告随返回值交给界面。
   */
  async function stageReview() {
    const st = stageOf('review')
    st.status = 'running'
    callbacks.onStage?.({ stage: 'review', status: 'start' })
    const startedAt = Date.now()
    const reviewCtx = buildContext({ ...input, action: 'review' })
    const text = String(input?.text ?? chapter?.content ?? '')
    const messages = [...messagesFromContext(reviewCtx), { role: 'user', content: buildReviewTask(text) }]
    const promptText = messages.map((m) => m.content).join('\n')
    const res = await streamOnce({ messages, onRetry: callbacks.onRetry, stageId: 'review' })
    reviewRaw = res.text
    reviewReport = extractJson(res.text)
    st.status = res.error ? 'error' : res.aborted ? 'aborted' : reviewReport ? 'done' : 'error'
    st.error = res.error || (reviewReport ? '' : '未能从返回内容中解析出 JSON')
    if (st.status === 'error') error = st.error
    if (res.aborted) aborted = true

    // 计费照常。手动触发也必须是**可见花费** —— 「这次检查花了多少钱」在
    // 控制台的「生成历史」里看得到，正是「规则常开 + AI 手动」这个组合能成立的
    // 前提：用户点之前就知道会花钱，点之后能看到花了多少。
    if (res.text || res.usage || res.aborted) {
      await record(
        {
          bookId,
          chapterId: chapter?.id,
          action: input?.action || 'review',
          stage: 'review',
          provider: providerFromUrl(settings?.baseUrl),
          model: modelForStage(settings, 'review'),
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          inputText: promptText,
          outputText: res.text,
          durationMs: Date.now() - startedAt,
          status: res.truncated
            ? 'truncated'
            : res.error
              ? 'error'
              : res.aborted
                ? 'aborted'
                : reviewReport
                  ? 'done'
                  : 'error',
          finishReason: res.finishReason || '',
          attempts: res.attempts,
          error: res.error || '',
          contextSummary: contextSummary(reviewCtx)
        },
        'review'
      )
    }
    return !res.error && !res.aborted
  }

  /**
   * 生成章节施工卡草案。
   *
   * 与审校一样**手动触发、正常计费、结果不落库**：草稿只是给用户看与挑选的，
   * 真正写进章节必须经界面上的确认动作。这样即使模型给了个糟糕的计划，
   * 也不会自动改写作者已经确认过的施工卡。
   */
  async function stagePlan() {
    const st = stageOf('plan')
    st.status = 'running'
    planValidation = null
    planBlocked = false
    callbacks.onStage?.({ stage: 'plan', status: 'start' })
    const startedAt = Date.now()
    const planCtx = buildContext({ ...input, action: 'plan' })
    const messages = [
      ...messagesFromContext(planCtx),
      { role: 'user', content: buildPlanTask(chapter) }
    ]
    const promptText = messages.map((m) => m.content).join('\n')
    const res = await streamOnce({ messages, onRetry: callbacks.onRetry, stageId: 'plan' })
    planRaw = res.text
    const parsed = extractJson(res.text)
    planDraft = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    st.status = res.error
      ? 'error'
      : res.aborted
        ? 'aborted'
        : res.truncated
          ? 'truncated'
          : planDraft
            ? 'done'
            : 'error'
    st.error = res.error || (planDraft ? '' : res.truncated ? '输出被截断' : '未能从返回内容中解析出 JSON')
    if (st.status === 'error') error = st.error
    if (res.aborted) aborted = true

    // 生成前校验：确定性、零成本、**失败不拖垮本阶段**。
    // 它的结论只用于「界面上要不要拦一下自动采用」，被校验的计划本身仍然
    // 原样交给用户看 —— 模型给了一份踩设定的计划，用户有权决定照用。
    const pv = settings?.planValidation || {}
    if (planDraft && pv.enabled !== false) {
      try {
        planValidation = validatePlan({
          plan: planDraft,
          chapter,
          book: input?.book,
          chapters: input?.chapters || [],
          memory: input?.memory || {},
          structure: input?.structure || {},
          options: pv
        })
        planBlocked = shouldBlockPlan(planValidation, { blockHigh: pv.blockHigh !== false })
        st.validation = planValidation
        st.blocked = planBlocked
      } catch (e) {
        // 校验器自己出错时退化成「没有校验」，绝不能因此让一份可用的草案失败。
        planValidation = null
        planBlocked = false
        st.validation = null
        st.blocked = false
        console.error('[orchestrator] 计划校验失败', e)
      }
    }
    if (res.truncated) {
      truncated = true
      truncatedMessage = '计划生成达到输出上限被截断，草案不完整'
    }
    if (res.text || res.usage || res.aborted) {
      await record(
        {
          bookId,
          chapterId: chapter?.id,
          action: 'plan',
          stage: 'plan',
          provider: providerFromUrl(settings?.baseUrl),
          model: modelForStage(settings, 'plan'),
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          inputText: promptText,
          outputText: res.text,
          durationMs: Date.now() - startedAt,
          status: st.status,
          finishReason: res.finishReason || '',
          attempts: res.attempts,
          error: res.error || '',
          contextSummary: contextSummary(planCtx)
        },
        'plan'
      )
    }
    return !res.error && !res.aborted
  }

  /**
   * 定向修复：输入一条问题，产出整章修订稿。
   *
   * **绝不直接写库**：修订稿由界面用 diff 预览，用户点「接受修订」之后才
   * 走 captureVersion（source:'review'）+ persistChapter。这样「AI 修稿」
   * 与「AI 写正文」一样，都有一个可回退的版本点。
   */
  async function stageFix() {
    const st = stageOf('fix')
    st.status = 'running'
    callbacks.onStage?.({ stage: 'fix', status: 'start' })
    const startedAt = Date.now()
    const issue = input?.issue || {}
    const fixCtx = buildContext({ ...input, action: 'fix' })
    const text = String(input?.text ?? chapter?.content ?? '')
    const messages = [
      ...messagesFromContext(fixCtx),
      { role: 'user', content: buildFixTask(issue, text) }
    ]
    const promptText = messages.map((m) => m.content).join('\n')
    const res = await streamOnce({ messages, onRetry: callbacks.onRetry, stageId: 'fix' })
    fixRaw = res.text
    const parsed = extractJson(res.text)
    fixDraft =
      parsed && typeof parsed === 'object' && typeof parsed.revised === 'string' && parsed.revised.trim()
        ? { revised: parsed.revised, explanation: String(parsed.explanation || '').trim() }
        : null
    st.status = res.error
      ? 'error'
      : res.aborted
        ? 'aborted'
        : res.truncated
          ? 'truncated'
          : fixDraft
            ? 'done'
            : 'error'
    st.error = res.error || (fixDraft ? '' : res.truncated ? '输出被截断' : '未能从返回内容中解析出修订稿')
    if (st.status === 'error') error = st.error
    if (res.aborted) aborted = true
    if (res.truncated) {
      truncated = true
      truncatedMessage = '修订稿达到输出上限被截断，不能直接采用'
    }
    if (res.text || res.usage || res.aborted) {
      await record(
        {
          bookId,
          chapterId: chapter?.id,
          action: 'fix',
          stage: 'fix',
          provider: providerFromUrl(settings?.baseUrl),
          model: modelForStage(settings, 'fix'),
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
          inputText: promptText,
          outputText: res.text,
          durationMs: Date.now() - startedAt,
          status: st.status,
          finishReason: res.finishReason || '',
          attempts: res.attempts,
          error: res.error || '',
          contextSummary: contextSummary(fixCtx),
          reviewRunId: input?.reviewRunId || ''
        },
        'fix'
      )
    }
    return !res.error && !res.aborted
  }

  const RUNNERS = {
    write: stageWrite,
    extract: stageExtract,
    review: stageReview,
    plan: stagePlan,
    fix: stageFix
  }

  async function runFrom(startIndex) {
    for (let i = startIndex; i < stages.length; i++) {
      const runner = RUNNERS[stages[i]]
      if (!runner) continue
      const ok = await runner()
      if (!ok) break
    }
  }

  // 中止句柄必须**同步**交出去：runFrom 的第一个 await 之前，stageWrite 里
  // 的 streamOnce 已经调过 chatStream 并把 abort 存进 run.abort，所以此刻
  // 句柄一定可用。反过来等本函数返回才拿到句柄，等于用户永远点不到「停止」——
  // 那时生成早就结束了。句柄每次都新读 run.abort，于是跨阶段自动跟着换。
  callbacks.onControl?.({ abort: () => run.abort?.(), run })

  /**
   * 收尾判定。
   *
   * **只有第一阶段（写正文）失败才算整次运行失败。** 后续阶段（提取）失败会把
   * 自己的阶段标成 error、并通过 error 把消息传出去，但运行本身仍是 done ——
   * 交付物（正文）已经拿到手了，把它标成失败会让用户以为这一章白写了。
   * 这与本模块开头「提取失败不是整次生成的失败」那条不变量是同一条。
   */
  function settleStatus() {
    run.finishedAt = Date.now()
    const primary = run.stages[0]
    run.status = aborted
      ? 'aborted'
      : truncated || primary?.status === 'truncated'
        ? 'truncated'
        : primary?.status === 'error'
          ? 'error'
          : 'done'
  }

  await runFrom(0)
  settleStatus()

  return {
    run,
    output,
    extractRaw,
    reviewRaw,
    reviewReport,
    planRaw,
    planDraft,
    planValidation,
    planBlocked,
    fixRaw,
    fixDraft,
    context: ctx,
    chapterMeta,
    changes,
    records,
    applied,
    queued,
    error,
    truncated,
    truncatedMessage,
    abort: () => run.abort?.(),
    /**
     * 从第一个没跑完的阶段接着跑。写正文成功、提取失败时用它 ——
     * 重跑整条链会白花一次正文的钱，而正文是这条链上最贵的一段。
     */
    retry: async () => {
      const idx = run.stages.findIndex((s) => s.status !== 'done')
      if (idx < 0) return null
      run.status = 'running'
      error = ''
      aborted = false
      truncated = false
      truncatedMessage = ''
      await runFrom(idx)
      settleStatus()
      return {
        run,
        output,
        reviewReport,
        planDraft,
        planValidation,
        planBlocked,
        fixDraft,
        chapterMeta,
        changes,
        records,
        applied,
        queued,
        error,
        truncated,
        truncatedMessage
      }
    }
  }
}
