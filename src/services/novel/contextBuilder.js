import { estimateTokens, cutToTokens } from '../ai/tokenUsage.js'
import {
  ENTITY_SCHEMAS,
  renderEntity,
  entityTitle,
  renderBookPlan,
  isBookPlanEmpty,
  CHAPTER_PLAN_FIELDS,
  ACTIVE_FORESHADOW_STATUS,
  FACT_LAYER_LABELS,
  NON_FACT_LAYERS,
  NON_INJECTABLE_CONFIRM
} from './schemas.js'
import { normalizeTitle } from '../migration.js'
import { collectOutlineText } from '../prompts.js'
import { rankEntities, eventRelevance, mentionedIds } from './retrieval.js'
import { styleProfileText } from './style.js'

/**
 * 提示词版本。每次改动分层规则、硬规则或任务描述时**必须**手动递增，
 * 它会随每一条生成记录落库。没有它，「同样的输入这次怎么写得不一样」
 * 就分不清是提示词改了、参数改了，还是模型自己漂了。
 */
export const PROMPT_VERSION = 'v3.7'

/**
 * Context Builder：把「写这一章需要知道的一切」按相关性分层组装成提示词。
 *
 * 这是 V2 最重要的一处替换。V1 的上下文就是「最近 3 章正文 + 几段扁平设定」，
 * 写到第 300 章时模型对人物状态、伏笔、时间线一无所知，必然自相矛盾。
 *
 * 三条设计原则：
 *
 * 1. **全部是纯函数，没有 I/O。** 输入是内存里的数据，输出是字符串与元数据。
 *    这样预算分配才能被确定性单测钉死 —— 而「确定性」本身就是要求：
 *    同一章、同一设置，两次组装必须给出逐字相同的结果，否则提示词会因为
 *    某个集合的加载顺序不同而漂移，出了回归根本无从复现。
 *
 * 2. **相关性由结构化规则决定，不交给模型。** 谁进上下文、谁被裁掉，
 *    全部由下面的固定规则算出（在近期正文里被提到过的排前面、伏笔按状态筛、
 *    事件按章节窗口分远近）。规格书说的「不让 LLM 决定提示词装什么」即此。
 *
 * 3. **预算内可降级，但必需层永不裁。** 写作硬规则与用户当次要求是 required，
 *    它们总共只占一百多个 token，裁掉它们换来的空间远不值得让模型自由发挥。
 */

/** 每层的裁剪策略：'tail' 保留尾部（越近越重要），'head' 保留头部（开头是要义） */
const KEEP = { head: 'head', tail: 'tail' }

/**
 * 写作硬规则。**required 且不截断**。
 *
 * 这些约束逐条对应规格书 04 对「正文生成」的要求：模型可以自由发挥文笔与细节，
 * 但不得自行改动人物状态、世界规则、时间线与伏笔 —— 那三类改动必须经由
 * 记忆提取 → 审阅 → 提交的流程，而不是模型在正文里顺手宣布。
 */
const WRITING_RULES = [
  '你正在创作长篇小说，必须严格遵守以下硬性约束：',
  '1. 直接输出正文，不要输出章节标题，不要写「好的」之类的客套话，不要任何解释说明。',
  '2. 不得擅自改变人物的既有设定（身份、境界、性格、关系）。人物状态的变化必须有正文中的事件作为依据，不能凭空发生。',
  '3. 不得擅自在正文里宣布新的世界规则，也不得推翻已确立的世界规则。',
  '4. 已死亡或已失踪的人物不得无理由重新出现。',
  '5. 尚未到揭示时机的伏笔不得提前揭示，也不得把已埋下的伏笔当成没发生过。',
  '6. 不要重复已经写过的情节，也不要跳过必要的铺垫直接进入转折。'
].join('\n')

const MIN_LAYER_TOKENS = 40

// ---------------------------------------------------------------------------
// 相关性：谁被提到过
// ---------------------------------------------------------------------------

function sortedChapters(chapters) {
  return [...(chapters || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function prevChapters(input, n) {
  const sorted = sortedChapters(input.chapters)
  const idx = sorted.findIndex((c) => c.id === input.chapter?.id)
  if (idx <= 0) return []
  return sorted.slice(Math.max(0, idx - n), idx)
}

/**
 * 「焦点文本」：这一章要写的东西的自然语言描述。
 *
 * 当前章的目标与最近几章正文合成的。用它来判断一个人物/地点/事件是否**相关** ——
 * 这是纯字符串包含判断，确定、便宜、可解释（用户问「为什么这个人物被注入了」，
 * 答案就是「他在这章的纲要或上一章正文里被提到了」）。
 */
function focusText(input) {
  const parts = []
  if (input.instruction) parts.push(input.instruction)
  const ch = input.chapter
  if (ch) {
    parts.push(ch.title || '', ch.purpose || '', ch.summary || '')
    // 施工卡字段同样决定「这一章跟谁有关」：写「与苏九在药庐对峙」时，
    // 苏九和药庐应当在相关性排序里被顶上来。
    for (const f of CHAPTER_PLAN_FIELDS) parts.push(String(ch[f.key] ?? ''))
    // 当前章已写的部分当然也要算进来
    parts.push(String(ch.content || '').slice(-4000))
  }
  for (const c of prevChapters(input, 3)) parts.push(String(c.content || '').slice(-2000))
  return parts.join('\n')
}

/**
 * 名字有没有出现在焦点文本里。单字名字（「王」）不参与判断 —— 一个汉字的
 * 命中率高到没有信息量，只会把预算浪费在不相干的人物上。
 */
/**
 * 只有「作者确认过、并且仍是有效」的记录才作为作者事实注入。
 *
 * 待确认（pending）的候选、已否决（rejected）与已弃用（deprecated）的记录
 * 如果照样注入，AI 会把它当成既定事实继续写——于是用户刚在审阅队列里点了
 * 「忽略」，下一章里那件事仍然发生了，且界面上完全看不出原因。
 */
function visibleMemory(list) {
  return (list || []).filter((e) => e && !NON_INJECTABLE_CONFIRM.includes(e.confirmStatus))
}

/**
 * 同一层里的重名记录：规范化标题相同但未被合并的两条。
 *
 * **不静默择一**是关键。两条「林昭」各自写着不同的境界时，无论挑哪一条，
 * 模型都会把另一半当成不存在；而用户完全不知道提示词里发生过一次取舍。
 * 所以两条都注入，并在层文本里明确标出冲突，让模型与用户都看见。
 */
function duplicateTitleSet(list, schema) {
  const counts = new Map()
  for (const e of list || []) {
    const key = normalizeTitle(entityTitle(schema, e))
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k))
}

/** 非作者事实（角色认知/传闻/推测）加前缀，避免被当成世界真相 */
function factLayerPrefix(entity) {
  const layer = entity?.factLayer
  if (!NON_FACT_LAYERS.includes(layer)) return ''
  return `[${FACT_LAYER_LABELS[layer] || layer}] `
}

/** V2 实体 → 层条目（带来源与原因，供 Context Preview 解释「为什么它在」） */
function itemsFrom(list, schema, resolveRef, focus) {
  const visible = visibleMemory(list)
  const duplicates = duplicateTitleSet(visible, schema)
  return rankEntities(visible, focus).map(({ entity: e, score, reason }) => {
    const name = entityTitle(schema, e)
    const dup = duplicates.has(normalizeTitle(name))
    const body = `${factLayerPrefix(e)}${renderEntity(schema, e, resolveRef)}`
    return {
      name,
      text: dup
        ? `${body}\n⚠ 冲突：另有同名记录「${name}」，两条内容不一致且未合并，请勿同时当作事实。`
        : body,
      mentioned: score > 0,
      source: `${schema.label}「${name}」`,
      reason,
      conflict: dup
    }
  })
}

/** 旧侧栏设定行 → 层条目。旧行只有 title + 一段自由文本，直接拼。 */
function legacyItems(list, focus) {
  return rankEntities(list, focus).map(({ entity: o, score, reason }) => ({
    name: o.title || '未命名',
    text: `${o.title || '未命名'}：${o.content}`,
    mentioned: score > 0,
    source: `旧设定「${o.title || '未命名'}」`,
    reason
  }))
}

/** 两组条目合并后按「是否被提到」重排，让被提到的排在前面 */
function byMention(items) {
  return [...items].sort((a, b) => (b.mentioned ? 1 : 0) - (a.mentioned ? 1 : 0))
}

// ---------------------------------------------------------------------------
// 旧「设定」侧栏的注入与去重
// ---------------------------------------------------------------------------

/**
 * 旧侧栏的某类设定行，过滤掉已经被 V2 实体取代的那些。
 *
 * 两道去重，缺一不可：
 *   ① 源行的 migratedTo 指向一个**当前存在**的 V2 实体 → 跳过旧行；
 *   ② 规范化标题与某个 V2 实体相同 → 跳过旧行。
 *
 * 第二道是必需的而非冗余：用户在侧栏编辑旧设定时，useBooks 内存副本的
 * 「读-改-写」会把 migratedTo 覆盖掉（见 migration.js 的说明），此时只剩
 * 标题比对能挡住重复注入。没有它，同一个人物会在提示词里出现两次，
 * 而且两次内容可能不一致 —— 模型会挑一个照做，用户则完全看不出原因。
 */
function legacyRowsOfType(outlines, type, v2List, titleOf) {
  const v2Ids = new Set((v2List || []).map((e) => e.id))
  const v2Titles = new Set((v2List || []).map((e) => normalizeTitle(titleOf(e))))
  return (outlines || [])
    .filter((o) => o.type === type && o.content)
    .filter((o) => !(o.migratedTo || []).some((id) => v2Ids.has(id)))
    .filter((o) => !v2Titles.has(normalizeTitle(o.title)))
}

// ---------------------------------------------------------------------------
// 分层
// ---------------------------------------------------------------------------

function layer(id, label, opts, items) {
  return {
    id,
    label,
    priority: opts.priority,
    required: !!opts.required,
    minTokens: opts.minTokens ?? MIN_LAYER_TOKENS,
    keep: opts.keep || KEEP.head,
    items: (items || []).filter((it) => it && it.text)
  }
}

/** 章节标题，形如「第3章 雨夜」 */
function chapterLabel(c) {
  if (!c) return ''
  return c.title ? `第${c.order}章 ${c.title}` : `第${c.order}章`
}

/**
 * 检索片段 → 层条目，并在这里就把 `settings.rag.budget` 用掉。
 *
 * 预算必须在**建层时**扣，不能只写在层上：`allocate` 只认全局预算，
 * 不会为某一层单独设上限（见那里的实现）。若这里不裁，检索层会按全局
 * 预算一路吃下去，把「最近正文」这种更重要的层挤掉。
 */
function ragPassageItems(passages, budgetTokens) {
  const limit = Math.max(0, Number(budgetTokens) || 0)
  if (!limit || !Array.isArray(passages)) return []
  const items = []
  let left = limit
  for (const p of passages) {
    const text = String(p?.text ?? '').trim()
    if (!text) continue
    const title = p.chapterTitle
      ? `第${Number(p.chapterOrder) || '?'}章 ${p.chapterTitle}`
      : `第${Number(p.chapterOrder) || '?'}章`
    const full = `【${title}】\n${text}`
    const tokens = estimateTokens(full)
    if (tokens <= left) {
      items.push({
        name: title,
        text: full,
        source: `检索·${title}`,
        reason: 'rag'
      })
      left -= tokens
      continue
    }
    const cut = cutToTokens(full, left, KEEP.head)
    if (cut) {
      items.push({ name: title, text: cut, source: `检索·${title}`, reason: 'rag' })
    }
    break
  }
  return items
}

/**
 * 插件提供的固定片段 → 层条目。
 *
 * 与检索片段一样，预算在**建层时**就扣掉：`allocate` 只认全局预算，不会为
 * 单层设上限。放不下的整条跳过（`hooks.js` 已经做过一次同样的裁剪，
 * 这里再裁一次是因为调用方可能直接传入未裁剪的数组）。
 */
function pluginFragmentItems(fragments, budgetTokens) {
  const limit = Math.max(0, Number(budgetTokens) || 0)
  if (!limit || !Array.isArray(fragments)) return []
  let left = limit
  const items = []
  for (const f of fragments) {
    const text = String(f?.text ?? '').trim()
    if (!text) continue
    const tokens = estimateTokens(text)
    if (tokens > left) continue
    items.push({
      name: f.name || '插件',
      text,
      source: f.source || '插件',
      reason: 'plugin'
    })
    left -= tokens
  }
  return items
}

function makeResolvers(input) {
  const maps = {
    characters: new Map((input.memory?.characters || []).map((e) => [e.id, e.name || ''])),
    locations: new Map((input.memory?.locations || []).map((e) => [e.id, e.name || ''])),
    factions: new Map((input.memory?.factions || []).map((e) => [e.id, e.name || ''])),
    events: new Map((input.memory?.events || []).map((e) => [e.id, e.title || ''])),
    chapters: new Map((input.chapters || []).map((c) => [c.id, chapterLabel(c)]))
  }
  return (coll, id) => maps[coll]?.get(id) || ''
}

/**
 * 组装全部层。导出是为了让 Context Preview 与测试能单独看分层结果，
 * 而不必走完整的 buildContext。
 */
export function buildLayers(input = {}) {
  const settings = input.settings || {}
  const mem = input.memory || {}
  const structure = input.structure || {}
  const focus = focusText(input)
  const resolveRef = makeResolvers(input)
  const rows = (name) => mem[name] || []

  const layers = []

  // 1) 写作硬规则（必需）
  layers.push(
    layer('writingRules', '写作硬规则', { priority: 1, required: true, keep: KEEP.head }, [
      { name: 'rules', text: WRITING_RULES, source: '写作硬规则', reason: 'required' }
    ])
  )

  // 2) 全书规划。它比卷/篇更高一层，也最稳定 —— 放在大纲之前，
  //    让模型先看到「这本书到底在讲什么」，再看到具体骨架。
  if (!isBookPlanEmpty(input.book?.plan)) {
    layers.push(
      layer('bookPlan', '全书规划', { priority: 2, keep: KEEP.head }, [
        {
          name: 'bookPlan',
          text: renderBookPlan(input.book.plan),
          source: `书「${input.book?.title || '未命名'}」的规划`,
          reason: 'required'
        }
      ])
    )
  }

  // 3) 故事大纲。直接复用 V1 的 collectOutlineText，保证「单条 tail 8000 /
  //    多条各 4000」的历史行为逐字不变（既有断言钉着它）。
  //    老书没有卷/篇，这一层就是它唯一的长程规划来源，所以优先级很高。
  //
  //    尊重 V1 的三个「携带哪些设定」开关：它们是在设置面板里对用户承诺过的，
  //    新路径若不认，用户关掉「携带大纲」却发现大纲照样被发出去 —— 而且他
  //    没有任何办法看出来。开关的语义按它字面的意思继续有效。
  const outlineText = settings.includeOutline !== false ? collectOutlineText(input.outlines) : ''
  if (outlineText) {
    layers.push(
      layer('storyOutline', '故事大纲', { priority: 3, keep: KEEP.head }, [
        { name: 'outline', text: outlineText, source: '旧设定·故事大纲', reason: 'required' }
      ])
    )
  }

  // 4) 当前卷 / 5) 当前篇。章 → 篇 → 卷 是 V2 的结构，卷不直接挂章，
  //    所以要先由章的 arcId 找到篇，再由篇的 volumeId 找到卷。
  //    `arcs.volumeId` 是第四阶段补上的字段；旧数据没有它时仍回退到
  //    `book.currentVolumeId`，不会因为加了字段反而让老书失去卷层上下文。
  const arcs = structure.arcs || []
  const volumes = structure.volumes || []
  const curChapter = input.chapter
  // 章节没归篇时退到书里记住的当前篇（V4 指针）。这与 currentVolumeId 的回退是
  // 同一套口径：旧数据没有 arcId 时，至少还能带上「上次所在的篇」。
  const curArc =
    arcs.find((a) => a.id === (curChapter?.arcId || input.book?.currentArcId)) || null
  const curVolume =
    volumes.find((v) => v.id === (curArc?.volumeId || input.book?.currentVolumeId)) || null

  if (curVolume) {
    layers.push(
      layer('volume', '当前卷', { priority: 4, keep: KEEP.head }, [
        {
          name: curVolume.title,
          text: renderEntity(ENTITY_SCHEMAS.volumes, curVolume, resolveRef),
          source: `卷「${curVolume.title}」`,
          reason: 'focus'
        }
      ])
    )
  }
  if (curArc) {
    layers.push(
      layer('arc', '当前篇', { priority: 5, keep: KEEP.head }, [
        {
          name: curArc.title,
          text: renderEntity(ENTITY_SCHEMAS.arcs, curArc, resolveRef),
          source: `篇「${curArc.title}」`,
          reason: 'focus'
        }
      ])
    )
  }

  // 6) 本章目标
  if (curChapter) {
    const bits = []
    if (curChapter.purpose) bits.push(`本章要完成：${curChapter.purpose}`)
    if (curChapter.summary) bits.push(`本章已定梗概：${curChapter.summary}`)
    if (curChapter.timelineStart || curChapter.timelineEnd) {
      bits.push(`故事内时间：${curChapter.timelineStart || '?'} ~ ${curChapter.timelineEnd || '?'}`)
    }
    if (bits.length) {
      layers.push(
        layer('chapterGoal', '本章目标', { priority: 6, keep: KEEP.head }, [
          {
            name: chapterLabel(curChapter),
            text: `${chapterLabel(curChapter)}\n${bits.join('\n')}`,
            source: chapterLabel(curChapter),
            reason: 'focus'
          }
        ])
      )
    }
  }

  // 7) 本章施工卡。`planStatus` 必须如实告诉模型：临时计划不等于已确认计划，
  //    否则模型会把作者随手记的草稿当成硬约束，而作者一改计划就会前后矛盾。
  if (curChapter) {
    const planBits = []
    for (const f of CHAPTER_PLAN_FIELDS) {
      let v = curChapter[f.key]
      if (f.type === 'ref' && v) v = resolveRef(f.ref, v) || v
      v = String(v ?? '').trim()
      if (v) planBits.push(`${f.label}：${v}`)
    }
    const locked = String(curChapter.lockedBeats || '').trim()
    if (locked) planBits.push(`锁定节点（不得改动）：\n${locked}`)
    if (planBits.length) {
      const status =
        curChapter.planStatus === 'confirmed'
          ? `已确认${Number(curChapter.planVersion) > 0 ? ` v${curChapter.planVersion}` : ''}`
          : curChapter.planStatus === 'draft'
            ? '临时计划（尚未确认）'
            : '未确认'
      layers.push(
        layer('chapterCard', '本章施工卡', { priority: 7, keep: KEEP.head }, [
          {
            name: chapterLabel(curChapter),
            text: `${chapterLabel(curChapter)} 施工卡（${status}）\n${planBits.join('\n')}`,
            source: chapterLabel(curChapter),
            reason: 'focus'
          }
        ])
      )
    }
  }

  // 8) 本章场景。场景比章节更细，只在真正写了场景规划时才注入；
  //    按章内 order 排序，确保「先发生什么」的顺序不会被集合载入顺序打乱。
  if (curChapter) {
    const scenes = (structure.scenes || [])
      .filter((s) => s.chapterId === curChapter.id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    if (scenes.length) {
      layers.push(
        layer(
          'scenes',
          '本章场景',
          { priority: 8, keep: KEEP.head, minTokens: 60 },
          scenes.map((s) => ({
            name: s.title || '未命名场景',
            text: renderEntity(ENTITY_SCHEMAS.scenes, s, resolveRef),
            source: `场景「${s.title || '未命名场景'}」`,
            reason: 'focus'
          }))
        )
      )
    }
  }

  // 9) 文风档案。位置刻意排在本章场景之后、人物之前：
  //    - 它跨章稳定，不属于「这一章的信息」，但必须先于正文与摘要出现，
  //      模型才会在动笔前定下腔调；
  //    - 它已经被 style.js 压到十几行，不会挤掉人物/世界规则；
  //    - `includeStyle` 与人物/大纲/世界观三个开关同语义，关掉就一个字都不发。
  const styleText = styleProfileText(input.styleProfiles || [], settings.includeStyle !== false)
  if (styleText) {
    layers.push(
      layer('style', '文风档案', { priority: 9, keep: KEEP.head, minTokens: 60 }, [
        { name: 'style', text: styleText, source: '文风档案', reason: 'required' }
      ])
    )
  }

  // 9.5) 声明式插件提供的固定片段（V4）。
  //      只包含用户自己放进去的 JSON 文本，**不执行任何插件代码**。
  //      预算来自 settings.plugins.contextBudget；默认 400 token，且整条跳过
  //      而不是截断 —— 半句写作要求比没有更糟。没有片段时不产生层，
  //      提示词与未装插件时逐字相同。
  const pluginBudget = Math.max(0, Number(settings.plugins?.contextBudget ?? 0) || 0)
  const pluginItems =
    settings.plugins?.enabled === false
      ? []
      : pluginFragmentItems(input.pluginFragments, pluginBudget)
  if (pluginItems.length) {
    layers.push(
      layer('pluginContext', '插件上下文', { priority: 5, keep: KEEP.head, minTokens: 60 }, pluginItems)
    )
  }

  // 6) 人物状态。被提到的排前面 —— 预算不够时先丢的是「这一章用不到的人」。
  //    死亡人物也一起注入：硬规则里说不许复活，但点名说「林昭已死亡」比一句
  //    泛泛的规则有效得多，而相关人物通常就是刚死掉的那个。
  //
  //    **两个来源合并**：V2 结构化人物 + 尚未迁移的旧「人物设定」行。
  //    老书里一条 V2 人物也没有，旧行就是它全部的人物信息 —— 只读新集合
  //    等于升级之后提示词里一个人物都没有，这是最不能出的回归。
  if (settings.includeCharacters !== false) {
    const items = byMention([
      ...itemsFrom(rows('characters'), ENTITY_SCHEMAS.characters, resolveRef, focus),
      ...legacyItems(
        legacyRowsOfType(input.outlines, 'character', rows('characters'), (c) => c.name),
        focus
      )
    ])
    if (items.length) {
      layers.push(layer('characters', '人物状态', { priority: 6, keep: KEEP.head, minTokens: 80 }, items))
    }
  }

  // 7) 地点
  const locations = itemsFrom(rows('locations'), ENTITY_SCHEMAS.locations, resolveRef, focus)
  if (locations.length) {
    layers.push(layer('locations', '地点', { priority: 7, keep: KEEP.head }, locations))
  }

  // 8) 世界规则。同样合并旧「世界观设定」行（理由见人物层）。
  //    V2 规则按优先级倒序（优先级高的先保留，预算不够时丢的是次要规则），
  //    旧行没有优先级概念，按侧栏原顺序接在后面。
  if (settings.includeWorld !== false) {
    const rules = [...rows('worldRules')].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    const legacyRules = legacyRowsOfType(
      input.outlines,
      'world',
      rows('worldRules'),
      (r) => r.title
    )
    const items = [
      ...itemsFrom(rules, ENTITY_SCHEMAS.worldRules, resolveRef, focus),
      ...legacyItems(legacyRules, focus)
    ]
    if (items.length) {
      layers.push(layer('worldRules', '世界规则', { priority: 8, keep: KEEP.head }, items))
    }
  }

  // 9) 时间线：近几章发生过什么（「现在到哪儿了」）
  const events = visibleMemory(rows('events'))
  const recentIds = new Set(
    [...prevChapters(input, 5).map((c) => c.id), curChapter?.id].filter(Boolean)
  )
  const chapterOrderOf = (id) =>
    (input.chapters || []).find((c) => c.id === id)?.order ?? 1e9
  const byChapterOrder = (a, b) => chapterOrderOf(a.chapterId) - chapterOrderOf(b.chapterId)
  const eventItem = (e, reason) => ({
    name: entityTitle(ENTITY_SCHEMAS.events, e),
    text: `${factLayerPrefix(e)}${renderEntity(ENTITY_SCHEMAS.events, e, resolveRef)}`,
    source: `事件「${entityTitle(ENTITY_SCHEMAS.events, e)}」`,
    reason
  })
  const inWindow = events.filter((e) => recentIds.has(e.chapterId)).sort(byChapterOrder)
  if (inWindow.length) {
    layers.push(
      layer(
        'timeline',
        '时间线',
        { priority: 9, keep: KEEP.head, minTokens: 60 },
        inWindow.map((e) => eventItem(e, 'recent'))
      )
    )
  }

  // 10) 相关伏笔：只注入尚未揭示、且仍有效的
  const foreshadowing = visibleMemory(rows('foreshadowing')).filter((f) =>
    ACTIVE_FORESHADOW_STATUS.includes(f.status)
  )
  const sortedForeshadow = rankEntities(foreshadowing, focus)
    .sort(
      (a, b) =>
        (a.entity.status === 'developing' ? -1 : 0) -
        (b.entity.status === 'developing' ? -1 : 0)
    )
    .map(({ entity: f, score }) => ({
      name: entityTitle(ENTITY_SCHEMAS.foreshadowing, f),
      text: `${factLayerPrefix(f)}${renderEntity(ENTITY_SCHEMAS.foreshadowing, f, resolveRef)}`,
      mentioned: score > 0,
      source: `伏笔「${entityTitle(ENTITY_SCHEMAS.foreshadowing, f)}」`,
      reason: score > 0 ? 'focus' : 'available'
    }))
  if (sortedForeshadow.length) {
    layers.push(
      layer(
        'foreshadowing',
        '未收束的伏笔',
        { priority: 10, keep: KEEP.head, minTokens: 60 },
        sortedForeshadow
      )
    )
  }

  // 11) 相关历史事件：窗口之外、但与本章人物/地点/势力相关的旧事。
  //     这里用结构化关联（characterIds / locationId / factionIds）而不只是
  //     标题字符串：「A 回到药庐」应当带出「三年前在药庐发生的事」。
  const focusIds = {
    characters: mentionedIds(rows('characters'), focus),
    locations: mentionedIds(rows('locations'), focus),
    factions: mentionedIds(rows('factions'), focus)
  }
  const older = events
    .filter((e) => !recentIds.has(e.chapterId))
    .map((e) => ({ e, score: eventRelevance(e, focus, focusIds) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || byChapterOrder(a.e, b.e))
    .map((x) => eventItem(x.e, 'focus'))
  if (older.length) {
    layers.push(
      layer(
        'relevantEvents',
        '相关历史事件',
        { priority: 11, keep: KEEP.head, minTokens: 60 },
        older
      )
    )
  }

  // 11.5) 检索到的历史片段（V4）。放在「相关历史事件」之后、「近期摘要」之前：
  //    它是按字面相似度召回的正文原文，属于补充材料；摘要与最近正文更接近
  //    「这一章正在发生什么」，不该被它挤到后面。
  //
  //    `input.ragPassages` 由调用方在生成前检索好（AiPanel / ChapterCardModal）。
  //    Context Builder 本身保持纯函数、不碰 IndexedDB —— 这是它能被单测逐字
  //    钉死的前提。没有片段时不产生层，提示词与旧版完全一致。
  const ragBudget = Math.max(0, Number(settings.rag?.budget ?? 0) || 0)
  const ragItems = ragPassageItems(input.ragPassages, ragBudget)
  if (ragItems.length) {
    layers.push(
      layer('ragPassages', '相关历史片段', { priority: 11, keep: KEEP.head, minTokens: 60 }, ragItems)
    )
  }

  // 12) 近期章节摘要。窗口比「最近 N 章正文」大得多（摘要很短，几十章也占不了
  //     多少 token），这正是规格书要的「不要拿最近三章当长期记忆」。
  const withSummary = prevChapters(input, 40).filter((c) => c.summary)
  if (withSummary.length) {
    layers.push(
      layer(
        'recentSummary',
        '近期章节摘要',
        { priority: 12, keep: KEEP.tail, minTokens: 80, maxTokens: 1500 },
        withSummary.map((c) => ({
          name: chapterLabel(c),
          text: `${chapterLabel(c)}：${c.summary}`,
          source: chapterLabel(c),
          reason: 'recent'
        }))
      )
    )
  }

  // 13) 最近正文片段。最后一项是**当前章已写的部分** —— 因为这一层按尾部保留，
  //     预算不够时被丢掉的正是更早的章节，而当前章节的衔接处永远留着。
  const recentTextItems = []
  for (const c of prevChapters(input, Number(settings.contextChapters ?? 3) || 3)) {
    if (!c.content) continue
    recentTextItems.push({
      name: chapterLabel(c),
      text: `【${c.title || chapterLabel(c)}】\n${String(c.content).slice(-800)}`,
      source: chapterLabel(c),
      reason: 'recent'
    })
  }
  if (curChapter?.content) {
    recentTextItems.push({
      name: `${chapterLabel(curChapter)}（已写部分）`,
      text: `【本章已写部分】\n${String(curChapter.content).slice(-6000)}`,
      source: chapterLabel(curChapter),
      reason: 'recent'
    })
  }
  if (recentTextItems.length) {
    layers.push(
      layer('recentText', '最近正文', { priority: 13, keep: KEEP.tail, minTokens: 100 }, recentTextItems)
    )
  }

  // 14) 用户当次要求（必需）
  const inst = (input.instruction || '').trim()
  if (inst) {
    layers.push(
      layer('instruction', '本次要求', { priority: 14, required: true, keep: KEEP.head }, [
        {
          name: 'instruction',
          text: `【本次要求】\n${inst}`,
          source: '本次要求',
          reason: 'required'
        }
      ])
    )
  }
  // 扩写/改写要处理的那段文字也是必需信息 —— 没有它这个动作根本不成立
  const selection = (input.selection || '').trim()
  if (selection) {
    layers.push(
      layer('selection', '待处理文字', { priority: 15, required: true, keep: KEEP.head }, [
        {
          name: 'selection',
          text: `【待处理文字】\n${selection}`,
          source: '待处理文字',
          reason: 'required'
        }
      ])
    )
  }

  return layers
}

// ---------------------------------------------------------------------------
// 预算分配
// ---------------------------------------------------------------------------

/**
 * 按优先级把预算分给各层。**纯函数**，是 contextBudgetOk / contextDropOk
 * 两条断言直接钉住的对象。
 *
 * 规则：
 *   - required 层无条件全量保留，即使因此超出预算（并置 overBudget）；
 *   - 其余层按顺序分配：装得下就整层保留，装不下就按 keep 策略保留若干条，
 *     再不够就把这一条按剩余预算截断，剩下的条目全部丢弃；
 *   - 剩余预算连 minTokens 都不到时整层丢弃 —— 留半句话比不留更糟，
 *     模型会把半截设定当成完整设定照做。
 */
export function allocate(layers, budget) {
  const total = Math.max(0, Number(budget) || 0)
  let remaining = total
  const out = []
  let overBudget = false

  for (const l of layers || []) {
    const items = l.items || []
    const sizes = items.map((it) => estimateTokens(it.text))
    const need = sizes.reduce((a, b) => a + b, 0)

    if (!items.length) {
      out.push({ ...l, items: [], text: '', tokens: 0, truncated: false, dropped: false })
      continue
    }

    // 条目包装：把 source/reason/mentioned/conflict 一路带到 metadata，
    // Context Preview 才能回答「为什么这一条被注入了」。
    const wrap = (it, tokens, extra) => ({
      name: it.name,
      text: extra?.text ?? it.text,
      tokens,
      source: it.source || '',
      reason: it.reason || '',
      mentioned: !!it.mentioned,
      conflict: !!it.conflict,
      ...(extra || {})
    })

    const kept = new Array(items.length).fill(null)
    let truncated = false
    let dropped = false

    if (l.required) {
      items.forEach((it, i) => (kept[i] = wrap(it, sizes[i])))
      remaining -= need
      if (remaining < 0) overBudget = true
    } else if (need <= remaining) {
      items.forEach((it, i) => (kept[i] = wrap(it, sizes[i])))
      remaining -= need
    } else if (remaining < l.minTokens) {
      dropped = true
    } else {
      // keep='tail' 从末尾往前取（越近越重要），'head' 从头往后取
      const order = l.keep === KEEP.tail
        ? Array.from(items.keys()).reverse()
        : Array.from(items.keys())
      let left = remaining
      for (const i of order) {
        if (sizes[i] <= left) {
          kept[i] = wrap(items[i], sizes[i])
          left -= sizes[i]
          continue
        }
        const text = cutToTokens(items[i].text, left, l.keep)
        if (text) {
          kept[i] = wrap(items[i], estimateTokens(text), { text, truncated: true })
          truncated = true
          left -= kept[i].tokens
        }
        break
      }
      remaining = left
      if (kept.every((k) => !k)) dropped = true
    }

    const finalItems = kept.filter(Boolean)
    const text = finalItems.map((it) => it.text).join('\n')
    out.push({
      id: l.id,
      label: l.label,
      priority: l.priority,
      required: !!l.required,
      keep: l.keep,
      items: finalItems,
      text,
      tokens: finalItems.reduce((a, b) => a + b.tokens, 0),
      totalItems: items.length,
      truncated,
      dropped
    })
  }

  const totalTokens = out.reduce((a, b) => a + b.tokens, 0)
  return {
    layers: out,
    totalTokens,
    budget: total,
    overBudget: overBudget || totalTokens > total,
    droppedLayers: out.filter((l) => l.dropped).map((l) => l.id),
    truncatedLayers: out.filter((l) => l.truncated).map((l) => l.id)
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

const TASK_BY_ACTION = {
  continue: '请续写当前章节正文，从文末处自然衔接，延续上文风格与剧情继续推进。',
  chapter: '请根据上述设定与大纲，创作本章的完整正文。',
  expand: '请扩写下面的文字，使其更丰富、细节更生动、更有画面感，同时保持原意、风格与视角一致。',
  rewrite: '请改写下面的文字，优化文笔、语言节奏与逻辑表达，保持原意不变。',
  // 下面三种动作的产物是 JSON 而不是正文，具体契约由 orchestrator 的
  // buildReviewTask / buildPlanTask / buildFixTask 接管；这里只提供方向性说明。
  review: '请以审校者的身份阅读下面这一章，对照上述设定逐条指出问题。',
  plan: '请为本章生成施工卡草案，按下面的 JSON 契约输出。',
  fix: '请针对给定的审校问题修订整章正文，按下面的 JSON 契约输出。'
}

/** 产物是 JSON 而非正文的动作。「只输出正文本身」对它们是反向要求。 */
const JSON_ACTIONS = ['review', 'plan', 'fix']

function taskText(action) {
  const base = TASK_BY_ACTION[action] || '请根据上述设定继续写作。'
  if (JSON_ACTIONS.includes(action)) return base
  return `${base}\n（再次强调：只输出正文本身，不要标题，不要解释。）`
}

/**
 * 组装上下文。
 *
 * 返回 { system, context, task, metadata }：
 *   system   —— 作者身份 + 写作硬规则
 *   context  —— 其余各层按【标题】分段
 *   task     —— 动作对应的任务描述 + 本次要求 + 待处理文字
 *   metadata —— 分配结果，直接驱动 Context Preview，也是纯数据
 *
 * 注意 task 里的层是从 metadata 里取回来的：层文本已经过预算裁剪，
 * 若再从这里读原始数据就会出现「预览说裁掉了、提示词里却还在」的不一致。
 */
export function buildContext(input, budget, options = {}) {
  const settings = input?.settings || {}
  // 显式传入的 budget 是「最终分配预算」——Context Preview 与冒烟测试用它
  // 查看固定预算下的完整分配结果。不传时才按设置算：
  //   可用上下文 = contextBudget - 输出预留(maxTokens) - 安全余量
  // 给输出预留是必需的：把窗口全塞满输入，模型就没有空间写正文，
  // 表现是「请求成功但输出立刻截断」。余量则留给 chat 模板与工具各自的开销。
  const explicit = budget != null && Number.isFinite(Number(budget))
  const baseBudget = explicit
    ? Number(budget)
    : Number(settings.contextBudget ?? 6000) || 6000
  const outputReserve = explicit
    ? Math.max(0, Number(options.outputReserve) || 0)
    : Math.max(0, Number(options.outputReserve ?? settings.maxTokens ?? 0) || 0)
  const margin = explicit
    ? Math.max(0, Number(options.margin) || 0)
    : Math.max(0, Number(options.margin ?? 256) || 0)
  // 下限 512 只作用于「按设置算出来的预算」：低于它连硬规则都放不下，再减下去
  // 只会让所有层都被判超预算，预览里全是红色告警，反而看不出真正的问题。
  // 显式传入的 budget 是调用方指定的**最终**分配预算（冒烟测试与调试会故意传
  // 60 这种极小值来验证降级），必须原样使用，不能再抬高 —— 否则那些层永远
  // 不会被丢弃，「必需层保住、其余层降级」这条路径就再也测不到了。
  const effectiveBudget = explicit
    ? Math.max(0, baseBudget)
    : Math.max(512, baseBudget - outputReserve - margin)
  const layers = buildLayers(input)
  const alloc = allocate(layers, effectiveBudget)
  const byId = new Map(alloc.layers.map((l) => [l.id, l]))
  const pick = (id) => byId.get(id)?.text || ''

  const system = [
    `你是一名资深中文网文作者，正在创作长篇小说《${input?.book?.title || '未命名'}》。请用流畅、自然、有画面感的中文写作，保持文笔连贯、逻辑自洽。`,
    pick('writingRules')
  ]
    .filter(Boolean)
    .join('\n\n')

  const context = alloc.layers
    .filter((l) => !['writingRules', 'instruction', 'selection'].includes(l.id) && l.text)
    .map((l) => `【${l.label}】\n${l.text}`)
    .join('\n\n')

  const task = [taskText(input?.action || 'continue'), pick('instruction'), pick('selection')]
    .filter(Boolean)
    .join('\n\n')

  return {
    system,
    context,
    task,
    metadata: {
      action: input?.action || 'continue',
      promptVersion: PROMPT_VERSION,
      budget: alloc.budget,
      budgetBase: baseBudget,
      outputReserve,
      margin,
      totalTokens: alloc.totalTokens,
      overBudget: alloc.overBudget,
      droppedLayers: alloc.droppedLayers,
      truncatedLayers: alloc.truncatedLayers,
      estimate: 'heuristic-cjk',
      layers: alloc.layers.map((l) => ({
        id: l.id,
        label: l.label,
        tokens: l.tokens,
        // `items` 保留**条数**（既有界面与断言依赖它），条目明细在 itemsDetail。
        items: l.items.length,
        totalItems: l.totalItems,
        truncated: l.truncated,
        dropped: l.dropped,
        required: l.required,
        itemsDetail: l.items.map((it) => ({
          name: it.name,
          source: it.source || '',
          reason: it.reason || '',
          tokens: it.tokens,
          truncated: !!it.truncated,
          conflict: !!it.conflict
        }))
      }))
    }
  }
}
