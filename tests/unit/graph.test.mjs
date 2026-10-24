import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAPH_EDGE_KINDS,
  GRAPH_LIMITS,
  normalizeGraphName,
  parseRelationshipText,
  buildRelationshipGraph,
  layoutRelationshipGraph
} from '../../src/services/novel/graph.js'

const characters = [
  { id: 'c1', name: '林昭', currentFactionId: 'f1', currentLocationId: 'l1' },
  { id: 'c2', name: '苏九', aliases: ['九姑娘'] },
  { id: 'c3', name: '周野', status: 'dead' }
]

const factions = [
  { id: 'f1', name: '青云门', leaders: ['c1'], allies: ['药王谷'], enemies: ['血刀盟'] },
  { id: 'f2', name: '药王谷', allies: ['青云门'] },
  { id: 'f3', name: '血刀盟', enemies: ['青云门'] }
]

const locations = [{ id: 'l1', name: '药庐' }]

function graphOf(overrides = {}) {
  return buildRelationshipGraph({
    characters,
    factions,
    locations,
    events: [],
    ...overrides
  })
}

function edgeBetween(graph, a, b, kind) {
  return graph.edges.find(
    (e) =>
      e.kind === kind &&
      ((e.source.endsWith(`:${a}`) && e.target.endsWith(`:${b}`)) ||
        (e.source.endsWith(`:${b}`) && e.target.endsWith(`:${a}`)))
  )
}

test('关系图：节点来自人物与势力，地点默认关闭', () => {
  const g = graphOf()
  assert.equal(g.stats.characters, 3)
  assert.equal(g.stats.factions, 3)
  assert.equal(g.stats.locations, 0)
  assert.ok(g.nodes.every((n) => n.kind === 'character' || n.kind === 'faction'))
  // 地点开关打开后才有地点节点与「所在」边
  const withLoc = graphOf({ options: { includeLocations: true } })
  assert.equal(withLoc.stats.locations, 1)
  assert.ok(edgeBetween(withLoc, 'c1', 'l1', 'located'))
})

test('关系图：首领 / 所属 / 盟友 / 敌对，且盟友边双向只留一条', () => {
  const g = graphOf()
  assert.ok(edgeBetween(g, 'f1', 'c1', 'leader'))
  assert.ok(edgeBetween(g, 'c1', 'f1', 'member'))
  assert.ok(edgeBetween(g, 'f1', 'f2', 'ally'))
  assert.ok(edgeBetween(g, 'f1', 'f3', 'enemy'))
  // 青云门与药王谷互相声明盟友，不能出现两条同向重复边
  const ally = g.edges.filter((e) => e.kind === 'ally')
  assert.equal(ally.length, 1)
  // 名称标签解析不上的盟友直接忽略，不造节点
  assert.ok(g.nodes.every((n) => n.kind !== 'faction' || ['f1', 'f2', 'f3'].includes(n.refId)))
})

test('关系图：事件同场按次数累加权重', () => {
  const g = graphOf({
    events: [
      { id: 'e1', title: '夜谈', characterIds: ['c1', 'c2'] },
      { id: 'e2', title: '再会', characterIds: ['c2', 'c1'] },
      { id: 'e3', title: '独行', characterIds: ['c1', 'c1'] }
    ]
  })
  const edge = edgeBetween(g, 'c1', 'c2', 'cooccur')
  assert.ok(edge)
  // 权重就是共同出场次数；标签也如实写出，界面上不必再猜这个数字的含义
  assert.equal(edge.weight, 2)
  assert.ok(edge.label.includes('同场 2 次'))
  // 自己与自己不产生边
  assert.equal(g.edges.filter((e) => e.kind === 'cooccur').length, 1)
})

test('关系图：悬空引用被丢弃，绝不凭空造节点', () => {
  const g = buildRelationshipGraph({
    characters: [{ id: 'c1', name: '林昭', currentFactionId: 'gone' }],
    factions: [{ id: 'f1', name: '青云门', leaders: ['ghost'], allies: ['不存在'] }],
    events: [{ id: 'e1', characterIds: ['c1', 'nobody'] }]
  })
  assert.deepEqual(
    g.nodes.map((n) => n.kind).sort(),
    ['character', 'faction']
  )
  // leaders/allies/事件引用全部指空 → 零条边
  assert.equal(g.edges.length, 0)
})

test('parseRelationshipText：只认「恰好两个已知人物 + 明确分隔符」', () => {
  const chars = [
    { id: 'c1', name: '林昭' },
    { id: 'c2', name: '苏九', aliases: ['九姑娘'] },
    { id: 'c3', name: '周野' },
    { id: 'c4', name: '林昭然' }
  ]
  const ok = parseRelationshipText('林昭与苏九是同门。', chars)
  assert.equal(ok.length, 1)
  assert.equal(ok[0].sourceId, 'c1')
  assert.equal(ok[0].targetId, 'c2')

  // 别名也能识别
  assert.equal(parseRelationshipText('九姑娘——林昭的旧识', chars).length, 1)
  // 长名字优先：林昭然不会被拆成「林昭」+ 别人
  assert.equal(parseRelationshipText('林昭然与周野是兄弟', chars).length, 1)
  assert.equal(parseRelationshipText('林昭然与周野是兄弟', chars)[0].sourceId, 'c4')

  // 叙述性句子：没有分隔符、只有一个名字、或出现三个人，都不画线
  assert.deepEqual(parseRelationshipText('林昭想起苏九曾说过的话', chars), [])
  assert.deepEqual(parseRelationshipText('林昭独自走进药庐', chars), [])
  assert.deepEqual(parseRelationshipText('林昭、苏九与周野三人同行', chars), [])
  // 同一对人物只出一条
  assert.equal(
    parseRelationshipText('林昭与苏九是同门\n林昭与苏九曾是敌人', chars).length,
    1
  )
  // 一行只提到自己的别名不算关系
  assert.deepEqual(parseRelationshipText('苏九，又名九姑娘', chars), [])
  assert.deepEqual(parseRelationshipText('', chars), [])
})

test('关系图：自由文本关系是虚线低权重边', () => {
  const g = graphOf({
    characters: [
      { id: 'c1', name: '林昭', relationships: '苏九——林昭的师姐' },
      { id: 'c2', name: '苏九' }
    ]
  })
  const edge = edgeBetween(g, 'c1', 'c2', 'relation')
  assert.ok(edge)
  assert.equal(edge.dashed, true)
  assert.ok(GRAPH_EDGE_KINDS.find((k) => k.key === 'relation').dashed)
})

test('关系图：节点数超限时先保高连接度节点，并如实报告截断', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    name: `人物${i}`,
    currentFactionId: 'f1'
  }))
  const g = buildRelationshipGraph({
    characters: many,
    factions: [{ id: 'f1', name: '青云门', leaders: ['c0'] }],
    events: [{ id: 'e1', characterIds: ['c0', 'c1', 'c2'] }],
    options: { maxNodes: 5, maxEdges: 4 }
  })
  assert.equal(g.nodes.length, 5)
  assert.equal(g.stats.droppedNodes, 26)
  assert.ok(g.truncated)
  // c0 度数最高（首领 + 两次同场），不会被截掉
  assert.ok(g.nodes.some((n) => n.refId === 'c0'))
  assert.ok(g.edges.length <= 4)
})

test('layoutRelationshipGraph：确定性、所有节点落在画布内、无孤立坐标', () => {
  const g = graphOf({
    events: [
      { id: 'e1', characterIds: ['c1', 'c2', 'c3'] },
      { id: 'e2', characterIds: ['c1', 'c2'] }
    ]
  })
  const opts = { width: 800, height: 500, padding: 50 }
  const l1 = layoutRelationshipGraph(g, opts)
  const l2 = layoutRelationshipGraph(g, opts)
  assert.deepEqual(l1, l2)
  assert.equal(l1.nodes.length, g.nodes.length)
  for (const n of l1.nodes) {
    assert.ok(n.x >= 0 && n.x <= 800)
    assert.ok(n.y >= 0 && n.y <= 500)
    assert.ok(n.r > 0)
  }
  for (const e of l1.edges) {
    assert.equal(typeof e.x1, 'number')
    assert.equal(typeof e.y2, 'number')
  }
  // 空图不炸
  const empty = layoutRelationshipGraph({ nodes: [], edges: [] })
  assert.deepEqual(empty.nodes, [])
  assert.ok(empty.radius > 0)
  // 单节点放在正中间（未传尺寸时用默认画布 860×540）
  const one = layoutRelationshipGraph({ nodes: [g.nodes[0]], edges: [] })
  assert.equal(one.nodes[0].x, 430)
  assert.equal(one.nodes[0].y, 270)
})

test('规格常量：边种类唯一、权重为正、名称归一化', () => {
  const keys = GRAPH_EDGE_KINDS.map((k) => k.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(GRAPH_EDGE_KINDS.every((k) => k.weight > 0))
  assert.equal(normalizeGraphName(' 青云 门 '), '青云门')
  assert.equal(normalizeGraphName(null), '')
  assert.ok(GRAPH_LIMITS.maxNodes > 0 && GRAPH_LIMITS.maxEdges > 0)
})
