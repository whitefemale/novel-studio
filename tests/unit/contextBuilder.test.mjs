import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContext,
  buildLayers,
  allocate,
  PROMPT_VERSION
} from '../../src/services/novel/contextBuilder.js'

/**
 * Context Builder 的预算与注入规则。
 *
 * 这一组测试里最重要的不是「预算算对了」，而是几条**会静默污染提示词**的规则：
 *   - 输出预留：不预留就等于让模型没有空间写正文；
 *   - 显式预算必须原样使用：极小预算下必需层要活下来、其余层要被丢弃；
 *   - pending / rejected / deprecated 的记忆不得作为作者事实注入；
 *   - 重名记录必须**两条都注入并标注冲突**，不能静默择一；
 *   - 传闻 / 角色认知必须带前缀，不能被当成世界真相。
 */

function baseInput(over = {}) {
  const chapter = {
    id: 'c2',
    bookId: 'b1',
    title: '药庐夜话',
    order: 2,
    content: '',
    purpose: '林昭向苏九打听旧事',
    summary: '',
    ...over.chapter
  }
  // `chapter` 字段单独处理：若直接 `...over`，传入的局部覆盖会把上面这个
  // 带 id/order 的完整章节整个替换掉，而 Context Builder 恰恰按 chapter.id
  // 找场景与篇 —— 测试会以「层没出现」的样子失败，而不是报覆盖错了。
  const { chapter: _chapterOverride, ...rest } = over
  return {
    book: { id: 'b1', title: '测试长篇' },
    chapter,
    chapters: [
      { id: 'c1', bookId: 'b1', title: '入城', order: 1, content: '林昭进了城。' },
      chapter
    ],
    outlines: [],
    memory: {},
    structure: { volumes: [], arcs: [] },
    settings: { maxTokens: 2048 },
    action: 'continue',
    instruction: '接着写林昭与苏九在药庐的对话',
    ...rest
  }
}

/** buildLayers 返回的是未分配的层：文本在 items 里，allocate 之后才有层级 text。 */
const textOf = (layer) => (layer?.items || []).map((it) => it.text).join('\n')

const charItems = (list) => {
  const layer = buildLayers(baseInput({ memory: { characters: list } })).find(
    (l) => l.id === 'characters'
  )
  return layer?.items || []
}

test('显式预算被原样使用：极小预算下必需层保住、其余层被丢弃', () => {
  const ctx = buildContext(baseInput(), 60)
  assert.equal(ctx.metadata.budget, 60)
  assert.equal(ctx.metadata.overBudget, true)
  assert.ok(ctx.metadata.droppedLayers.length > 0)
  const required = ctx.metadata.layers.filter((l) => l.required)
  assert.ok(required.length >= 2, '写作硬规则与本次要求都是必需层')
  assert.ok(required.every((l) => l.items > 0 && !l.dropped))
  assert.ok(ctx.system.includes('不得擅自改变人物的既有设定'))
  assert.ok(ctx.task.includes('接着写林昭与苏九在药庐的对话'))
})

test('不传预算时按设置算：扣除输出预留与安全余量，并在下限 512 截住', () => {
  const input = baseInput({ settings: { contextBudget: 6000, maxTokens: 4000 } })
  const ctx = buildContext(input)
  assert.equal(ctx.metadata.budgetBase, 6000)
  assert.equal(ctx.metadata.outputReserve, 4000)
  assert.equal(ctx.metadata.margin, 256)
  assert.equal(ctx.metadata.budget, 1744)
  assert.equal(ctx.metadata.overBudget, false)
  assert.ok(ctx.metadata.totalTokens <= 1744)

  // 输出预留吃掉全部预算时，不能把输入预算算成负数或几十 —— 那会让所有层
  // 都被判超预算，预览里全是告警，真正的问题反而看不见。
  const tiny = buildContext(baseInput({ settings: { contextBudget: 1000, maxTokens: 4000 } }))
  assert.equal(tiny.metadata.budget, 512)
})

test('metadata 记下提示词版本与每一条的来源 / 原因', () => {
  const ctx = buildContext(
    baseInput({
      memory: { characters: [{ id: 'p1', name: '林昭', identity: '药童' }] }
    }),
    6000
  )
  assert.equal(ctx.metadata.promptVersion, PROMPT_VERSION)
  const layer = ctx.metadata.layers.find((l) => l.id === 'characters')
  assert.ok(layer)
  assert.equal(layer.items, 1)
  const detail = layer.itemsDetail[0]
  assert.equal(detail.name, '林昭')
  assert.equal(detail.source, '人物「林昭」')
  assert.equal(detail.reason, 'focus')
  assert.ok(detail.tokens > 0)
  assert.equal(detail.conflict, false)
})

test('组装是确定性的：同一输入两次逐字一致', () => {
  const input = baseInput({
    memory: {
      characters: [
        { id: 'p1', name: '林昭', identity: '药童' },
        { id: 'p2', name: '苏九', identity: '掌柜' }
      ]
    }
  })
  const a = buildContext(input, 6000)
  const b = buildContext(input, 6000)
  assert.equal(a.system, b.system)
  assert.equal(a.context, b.context)
  assert.equal(a.task, b.task)
  assert.deepEqual(a.metadata.layers, b.metadata.layers)
})

test('pending / rejected / deprecated 的记忆不注入；confirmed 与未标注的照常注入', () => {
  const items = charItems([
    { id: 'p1', name: '林昭', confirmStatus: 'confirmed' },
    { id: 'p2', name: '影子人', confirmStatus: 'pending' },
    { id: 'p3', name: '谣言甲', confirmStatus: 'rejected' },
    { id: 'p4', name: '旧设定乙', confirmStatus: 'deprecated' },
    { id: 'p5', name: '苏九' }
  ])
  const names = items.map((it) => it.name).sort()
  assert.deepEqual(names, ['林昭', '苏九'])
})

test('传闻 / 角色认知 / 推测加前缀，作者事实不加', () => {
  const items = charItems([
    { id: 'p1', name: '林昭', factLayer: 'author-fact', identity: '药童' },
    { id: 'p2', name: '苏九', factLayer: 'rumor', identity: '掌柜' },
    { id: 'p3', name: '老赵', factLayer: 'character-belief', identity: '路人' },
    { id: 'p4', name: '小周', factLayer: 'speculation', identity: '学徒' }
  ])
  const byName = Object.fromEntries(items.map((it) => [it.name, it.text]))
  assert.ok(!byName['林昭'].includes('[作者事实]'))
  assert.ok(byName['苏九'].startsWith('[传闻] '))
  assert.ok(byName['老赵'].startsWith('[角色认知] '))
  assert.ok(byName['小周'].startsWith('[推测] '))
})

test('同名记录两条都注入并标注冲突，绝不静默择一', () => {
  const items = charItems([
    { id: 'p1', name: '林昭', identity: '药童' },
    { id: 'p2', name: '林昭', identity: '城主' }
  ])
  assert.equal(items.length, 2)
  assert.ok(items.every((it) => it.text.includes('⚠ 冲突')))
  assert.ok(items.every((it) => it.text.includes('林昭')))
  // 两条内容都还在
  assert.ok(items.some((it) => it.text.includes('药童')))
  assert.ok(items.some((it) => it.text.includes('城主')))
})

test('待确认的同名记录不参与冲突标注（它本来就不该被注入）', () => {
  const items = charItems([
    { id: 'p1', name: '林昭', identity: '药童' },
    { id: 'p2', name: '林昭', identity: '城主', confirmStatus: 'pending' }
  ])
  assert.equal(items.length, 1)
  assert.ok(!items[0].text.includes('⚠ 冲突'))
})

test('allocate 本身：预算不够时整层丢弃，够时按 keep 方向裁剪', () => {
  const layers = [
    { id: 'a', label: 'a', priority: 1, required: false, minTokens: 40, keep: 'head', items: [{ text: '甲'.repeat(400) }] },
    { id: 'b', label: 'b', priority: 2, required: true, minTokens: 40, keep: 'head', items: [{ text: '乙' }] }
  ]
  const dropped = allocate(layers, 0)
  const a = dropped.layers.find((l) => l.id === 'a')
  const b = dropped.layers.find((l) => l.id === 'b')
  assert.equal(a.dropped, true)
  assert.equal(a.tokens, 0)
  assert.equal(b.dropped, false)
  assert.ok(b.tokens > 0)
  assert.equal(dropped.overBudget, true)

  const roomy = allocate(layers, 6000)
  const a2 = roomy.layers.find((l) => l.id === 'a')
  assert.equal(a2.dropped, false)
  assert.equal(a2.truncated, false)

  const partial = allocate(
    [
      {
        id: 'tail',
        label: 'tail',
        priority: 1,
        required: false,
        minTokens: 1,
        keep: 'tail',
        items: [{ text: '早'.repeat(2000) }, { text: '晚'.repeat(2000) }]
      }
    ],
    300
  )
  const t = partial.layers[0]
  // 尾部保留：后一条整条留下，前一条被截断
  assert.ok(t.items.some((it) => it.truncated))
  assert.ok(t.text.includes('晚'))
})

test('故事大纲开关与人物开关继续有效', () => {
  const withOutline = buildContext(
    baseInput({
      outlines: [{ id: 'o1', type: 'outline', title: '总纲', content: '三卷完结' }]
    }),
    6000
  )
  assert.ok(withOutline.context.includes('三卷完结'))

  const off = buildContext(
    baseInput({
      outlines: [{ id: 'o1', type: 'outline', title: '总纲', content: '三卷完结' }],
      settings: { maxTokens: 2048, includeOutline: false }
    }),
    6000
  )
  assert.ok(!off.context.includes('三卷完结'))
})

// ---------------------------------------------------------------------------
// 阶段 4：全书规划、卷 / 篇、施工卡、场景、JSON 动作
// ---------------------------------------------------------------------------

test('全书规划层：有内容才注入，空字段不占位', () => {
  const book = {
    id: 'b1',
    title: '测试长篇',
    plan: { premise: '一个人找回自己的名字', mainConflict: '林昭 vs 城主' }
  }
  const layers = buildLayers(baseInput({ book }))
  const plan = layers.find((l) => l.id === 'bookPlan')
  assert.ok(plan)
  assert.ok(textOf(plan).includes('核心命题：一个人找回自己的名字'))
  assert.ok(textOf(plan).includes('主线冲突：林昭 vs 城主'))
  assert.ok(!textOf(plan).includes('核心悬念'))
  // 空规划不产生层：不然预览里会多出一行「全书规划」却什么都没说
  assert.equal(buildLayers(baseInput()).find((l) => l.id === 'bookPlan'), undefined)
})

test('卷层由章的篇解析（arcs.volumeId），不依赖书的 currentVolumeId', () => {
  const input = baseInput({
    book: { id: 'b1', title: '测试长篇', currentVolumeId: 'v2' },
    chapter: { arcId: 'a1' },
    structure: {
      volumes: [
        { id: 'v1', title: '第一卷' },
        { id: 'v2', title: '第二卷' }
      ],
      arcs: [{ id: 'a1', title: '药庐篇', volumeId: 'v1' }]
    }
  })
  const layers = buildLayers(input)
  const volume = layers.find((l) => l.id === 'volume')
  const arc = layers.find((l) => l.id === 'arc')
  assert.ok(volume && textOf(volume).includes('第一卷'))
  assert.ok(!textOf(volume).includes('第二卷'), '章所属的篇指向哪一卷就注入哪一卷')
  assert.ok(arc && textOf(arc).includes('药庐篇'))
})

test('旧数据没有 arcs.volumeId 时回退到 book.currentVolumeId', () => {
  const input = baseInput({
    book: { id: 'b1', title: '测试长篇', currentVolumeId: 'v1' },
    chapter: { arcId: 'a1' },
    structure: {
      volumes: [{ id: 'v1', title: '回退卷' }],
      arcs: [{ id: 'a1', title: '旧篇' }]
    }
  })
  const volume = buildLayers(input).find((l) => l.id === 'volume')
  assert.ok(volume && textOf(volume).includes('回退卷'))
})

test('施工卡层如实标注确认状态：临时计划与已确认版本不可混淆', () => {
  const draft = buildLayers(
    baseInput({ chapter: { planStatus: 'draft', coreConflict: '夺回灵石', lockedBeats: '林昭必须活下来' } })
  ).find((l) => l.id === 'chapterCard')
  assert.ok(draft)
  assert.ok(textOf(draft).includes('临时计划（尚未确认）'))
  assert.ok(textOf(draft).includes('锁定节点（不得改动）'))
  assert.ok(textOf(draft).includes('林昭必须活下来'))

  const confirmed = buildLayers(
    baseInput({ chapter: { planStatus: 'confirmed', planVersion: 2, coreConflict: '夺回灵石' } })
  ).find((l) => l.id === 'chapterCard')
  assert.ok(textOf(confirmed).includes('已确认 v2'))

  // 没填任何施工卡字段时不注入空层
  assert.equal(buildLayers(baseInput()).find((l) => l.id === 'chapterCard'), undefined)
})

test('场景层只取本章，并按章内 order 排序', () => {
  const input = baseInput({
    structure: {
      volumes: [],
      arcs: [],
      scenes: [
        { id: 's2', chapterId: 'c2', title: '对峙', order: 2, purpose: '摊牌' },
        { id: 's1', chapterId: 'c2', title: '入屋', order: 1, purpose: '试探' },
        { id: 's3', chapterId: 'c1', title: '别章场景', order: 0 }
      ]
    }
  })
  const scenes = buildLayers(input).find((l) => l.id === 'scenes')
  assert.ok(scenes)
  assert.deepEqual(scenes.items.map((it) => it.name), ['入屋', '对峙'])
  assert.ok(textOf(scenes).includes('摊牌'))
  assert.ok(!textOf(scenes).includes('别章场景'))
})

test('plan / fix / review 的动作说明不含「只输出正文本身」', () => {
  for (const action of ['plan', 'fix', 'review']) {
    const ctx = buildContext(baseInput({ action }), 6000)
    assert.ok(!ctx.task.includes('只输出正文本身'), `${action} 的产物不是正文`)
    assert.ok(ctx.task.length > 0)
  }
  const cont = buildContext(baseInput({ action: 'continue' }), 6000)
  assert.ok(cont.task.includes('只输出正文本身'))
})
