import test from 'node:test'
import assert from 'node:assert/strict'
import {
  entityNames,
  relevanceOf,
  rankEntities,
  eventRelevance,
  mentionedIds,
  snippetAround,
  searchBook,
  relatedEntities
} from '../../src/services/novel/retrieval.js'

/**
 * 检索与相关性：Context Builder 靠它决定「谁先被注入」。
 *
 * 这些断言守的是**确定性**与**可解释性**：同样的输入必须给出同样的顺序，
 * 而排序理由（focus / available）必须能在 Context Preview 里如实展示。
 * 不测「文学上谁更重要」—— 那是作者的事，代码只负责规则。
 */

test('entityNames 取主标题与别名，去掉单字与空值', () => {
  assert.deepEqual(entityNames({ name: '林昭', aliases: ['昭哥', '', '王', '林昭'] }), ['林昭', '昭哥'])
  assert.deepEqual(entityNames({ title: '灵气枯竭' }), ['灵气枯竭'])
  assert.deepEqual(entityNames(null), [])
})

test('relevanceOf：多次命中加分，单字名不参与匹配', () => {
  const focus = '林昭推门而入。林昭看见苏九，林昭愣住了。'
  const once = relevanceOf({ name: '苏九' }, focus)
  const thrice = relevanceOf({ name: '林昭' }, focus)
  assert.ok(once > 0)
  assert.ok(thrice > once, '出现三次应当比出现一次分数高')
  // 单字名噪声太大，刻意不匹配
  assert.equal(relevanceOf({ name: '林' }, focus), 0)
  assert.equal(relevanceOf({ name: '林昭' }, ''), 0)
})

test('rankEntities：按分数降序，reason 只有 focus / available 两档，且不改入参', () => {
  const focus = '林昭与苏九在药庐。林昭先开口。'
  const list = [
    { name: '无关路人' },
    { name: '苏九' },
    { name: '林昭' }
  ]
  const ranked = rankEntities(list, focus)
  assert.deepEqual(
    ranked.map((r) => r.entity.name),
    ['林昭', '苏九', '无关路人']
  )
  assert.equal(ranked[0].reason, 'focus')
  assert.equal(ranked[1].reason, 'focus')
  assert.equal(ranked[2].reason, 'available')
  assert.equal(ranked[2].score, 0)
  // 原数组顺序不变
  assert.deepEqual(
    list.map((x) => x.name),
    ['无关路人', '苏九', '林昭']
  )
  // 确定性
  assert.deepEqual(rankEntities(list, focus), ranked)
})

test('eventRelevance：结构化关联比纯标题更重，按地点 / 人物 / 势力叠加', () => {
  const focus = '他回到了药庐。'
  const ids = {
    characters: new Set(['p1', 'p2']),
    locations: new Set(['l1']),
    factions: new Set(['f1'])
  }
  const base = { title: '旧事', characterIds: [], factionIds: [] }
  const none = eventRelevance(base, focus, ids)
  const character = eventRelevance({ ...base, characterIds: ['p1'] }, focus, ids)
  const twoCharacters = eventRelevance({ ...base, characterIds: ['p1', 'p2'] }, focus, ids)
  const location = eventRelevance({ ...base, locationId: 'l1' }, focus, ids)
  const faction = eventRelevance({ ...base, factionIds: ['f1'] }, focus, ids)
  assert.equal(none, 0)
  assert.equal(character, 3)
  assert.equal(twoCharacters, 6)
  assert.equal(location, 4)
  assert.equal(faction, 2)
  assert.ok(location > character, '同章同地点的旧事比「人物相关」更值得带出')
  // 标题命中与关联叠加
  assert.equal(
    eventRelevance({ ...base, title: '药庐' }, focus, ids),
    relevanceOf({ title: '药庐' }, focus)
  )
})

test('mentionedIds 只收被提到的实体 id', () => {
  const focus = '林昭与苏九在药庐。'
  const ids = mentionedIds(
    [
      { id: 'p1', name: '林昭' },
      { id: 'p2', name: '苏九' },
      { id: 'p3', name: '路人甲' },
      { id: '', name: '林昭' }
    ],
    focus
  )
  assert.deepEqual([...ids].sort(), ['p1', 'p2'])
})

test('snippetAround：命中前后留上下文，未命中给开头，加省略号', () => {
  const source = '甲'.repeat(100) + '关键线索' + '乙'.repeat(100)
  const snip = snippetAround(source, '关键线索', 10)
  assert.ok(snip.includes('关键线索'))
  assert.ok(snip.startsWith('…'))
  assert.ok(snip.endsWith('…'))
  assert.ok(snip.length < source.length)

  assert.equal(snippetAround('短文本', '不存在'), '短文本')
  assert.equal(snippetAround('', 'x'), '')
})

test('searchBook：标题命中排在正文命中之前，实体 / 章节 / 旧设定都覆盖', () => {
  const data = {
    query: '药庐',
    chapters: [
      { id: 'c1', order: 1, title: '雨夜', content: '林昭走进药庐。' },
      { id: 'c2', order: 2, title: '药庐大火', content: '无关内容' }
    ],
    outlines: [{ id: 'o1', type: 'outline', title: '总纲', content: '第三卷发生药庐大火' }],
    memory: {
      locations: [{ id: 'l1', name: '药庐', description: '城外草庐' }],
      characters: [{ id: 'p1', name: '林昭', identity: '药师' }]
    },
    structure: { volumes: [{ id: 'v1', title: '第一卷' }] }
  }
  const hits = searchBook(data)
  assert.equal(hits.length, 4)
  // 标题命中的章节与实体排在前面（score 2），正文命中在后（score 1）
  assert.equal(hits[0].score, 2)
  assert.equal(hits[1].score, 2)
  assert.deepEqual(
    hits.slice(2).map((h) => h.kind).sort(),
    ['chapter', 'outline']
  )
  const chapter = hits.find((h) => h.kind === 'chapter' && h.id === 'c1')
  assert.ok(chapter.snippet.includes('药庐'))
  assert.equal(chapter.chapterId, 'c1')
  const loc = hits.find((h) => h.kind === 'locations')
  assert.equal(loc.title, '药庐')
  assert.equal(loc.kindLabel, '地点')
  // 无关实体不出现
  assert.ok(!hits.some((h) => h.id === 'p1'))
  assert.ok(!hits.some((h) => h.id === 'v1'))
})

test('searchBook：空查询返回空、limit 生效、结果确定', () => {
  const data = {
    query: '',
    chapters: [{ id: 'c1', title: '一', content: '正文' }]
  }
  assert.deepEqual(searchBook(data), [])

  const many = {
    query: '甲',
    chapters: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `第${i}章`, content: '甲乙丙' }))
  }
  const limited = searchBook(many, { limit: 2 })
  assert.equal(limited.length, 2)
  assert.deepEqual(limited, searchBook(many, { limit: 2 }))
})

test('relatedEntities：人物 → 事件 / 伏笔 / 出现过的章节', () => {
  const memory = {
    characters: [{ id: 'p1', name: '林昭', aliases: ['昭哥'] }],
    events: [
      { id: 'e1', title: '拜师', characterIds: ['p1'], locationId: 'l1' },
      { id: 'e2', title: '无关', characterIds: [], locationId: 'l2' }
    ],
    foreshadowing: [{ id: 'f1', title: '旧伤', relatedCharacterIds: ['p1'] }]
  }
  const chapters = [
    { id: 'c1', title: '一', content: '林昭出场' },
    { id: 'c2', title: '二', content: '昭哥离开' },
    { id: 'c3', title: '三', content: '无人' }
  ]
  const rel = relatedEntities({ type: 'characters', id: 'p1', memory, chapters })
  assert.deepEqual(
    rel.events.map((e) => e.id),
    ['e1']
  )
  assert.deepEqual(
    rel.foreshadowing.map((f) => f.id),
    ['f1']
  )
  assert.deepEqual(
    rel.chapters.map((c) => c.id),
    ['c1', 'c2'],
    '别名出现也算关联'
  )

  const byLocation = relatedEntities({ type: 'locations', id: 'l1', memory, chapters: [] })
  assert.deepEqual(
    byLocation.events.map((e) => e.id),
    ['e1']
  )

  const byEvent = relatedEntities({ type: 'events', id: 'e1', memory, chapters: [] })
  assert.deepEqual(byEvent.events, [])
  assert.deepEqual(byEvent.foreshadowing, [])

  assert.deepEqual(relatedEntities({ type: '', id: '', memory, chapters }), {
    events: [],
    foreshadowing: [],
    chapters: []
  })
})
