<script setup>
import { computed, ref } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import {
  buildRelationshipGraph,
  layoutRelationshipGraph,
  GRAPH_EDGE_KINDS,
  GRAPH_NODE_KINDS
} from '../services/novel/graph'

/**
 * 人物关系图：纯派生视图。
 *
 * 这里没有「保存」按钮是刻意的：图上的每一条边都来自人物/势力/事件/伏笔里
 * 已经存在的数据，改图就是改那些记录。做一个能拖动连线的图编辑器意味着
 * 关系有第二份真相，而两份真相一定会分叉 —— 用户改了图，表里还是旧的。
 *
 * 用 SVG 手写而不是引图表库：一张静态的圆环布局不需要力导向模拟，
 * 手写还能保证「同输入同布局」，冒烟测试才断言得动。
 */

const emit = defineEmits(['goto'])

const { store } = useBooks()
const cols = useCollections()

const includeLocations = ref(false)
const includeForeshadow = ref(false)
const selectedId = ref('')

// Set 在 Vue 里不能就地增删后自动触发，所以每次换一个**新** Set
const allKinds = GRAPH_EDGE_KINDS.map((k) => k.key)
const activeKinds = ref(new Set(allKinds))

const graph = computed(() =>
  buildRelationshipGraph({
    characters: cols.list('characters'),
    factions: cols.list('factions'),
    locations: cols.list('locations'),
    events: cols.list('events'),
    foreshadowing: cols.list('foreshadowing'),
    options: {
      includeLocations: includeLocations.value,
      includeForeshadow: includeForeshadow.value
    }
  })
)

const visibleEdges = computed(() => graph.value.edges.filter((e) => activeKinds.value.has(e.kind)))

const layout = computed(() =>
  layoutRelationshipGraph(
    { nodes: graph.value.nodes, edges: visibleEdges.value },
    { width: 860, height: 540, padding: 60 }
  )
)

const labels = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n.label])))

const selected = computed(
  () => graph.value.nodes.find((n) => n.id === selectedId.value) || null
)

const selectedRelations = computed(() => {
  if (!selected.value) return []
  const id = selected.value.id
  return graph.value.edges
    .filter((e) => e.source === id || e.target === id)
    .map((e) => {
      const otherId = e.source === id ? e.target : e.source
      return {
        ...e,
        otherId,
        otherLabel: labels.value.get(otherId) || '未知',
        kindLabel: GRAPH_EDGE_KINDS.find((k) => k.key === e.kind)?.label || e.kind
      }
    })
    .sort((a, b) => b.weight - a.weight || a.otherLabel.localeCompare(b.otherLabel, 'zh-CN'))
})

const NODE_COLORS = Object.fromEntries(GRAPH_NODE_KINDS.map((k) => [k.key, k.color]))
const EDGE_COLORS = {
  leader: '#2b6cb0',
  member: '#4299e1',
  ally: '#38a169',
  enemy: '#e53e3e',
  cooccur: '#a0aec0',
  relation: '#d69e2e',
  foreshadow: '#805ad5',
  located: '#2f855a'
}

function toggleKind(key) {
  const next = new Set(activeKinds.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  activeKinds.value = next
}

function isKindOn(key) {
  return activeKinds.value.has(key)
}

function nodeColor(kind) {
  return NODE_COLORS[kind] || '#718096'
}

function selectNode(id) {
  selectedId.value = selectedId.value === id ? '' : id
}

function gotoEntity() {
  if (!selected.value) return
  if (selected.value.kind === 'character') emit('goto', 'characters')
  else if (selected.value.kind === 'faction') emit('goto', 'factions')
  else if (selected.value.kind === 'location') emit('goto', 'locations')
}
</script>

<template>
  <div class="rel">
    <div class="rel-head">
      <h4>人物关系图</h4>
      <p class="hint">
        全部由人物、势力、事件与伏笔**派生**，这里没有独立的「关系」数据 ——
        改图就是改那些记录。悬空引用（指向已删除记录）会直接丢弃，不会凭空画出一条边。
      </p>
    </div>

    <div class="rel-bar">
      <label class="check">
        <input v-model="includeLocations" type="checkbox" />
        显示地点
      </label>
      <label class="check">
        <input v-model="includeForeshadow" type="checkbox" />
        伏笔同涉
      </label>
      <span class="spacer"></span>
      <span class="stat">
        节点 {{ graph.stats.nodes }} · 边 {{ graph.stats.edges }}
        <template v-if="graph.stats.characters"> · 人物 {{ graph.stats.characters }}</template>
        <template v-if="graph.stats.factions"> · 势力 {{ graph.stats.factions }}</template>
      </span>
    </div>

    <div class="legend">
      <button
        v-for="k in GRAPH_EDGE_KINDS"
        :key="k.key"
        class="chip"
        :class="{ off: !isKindOn(k.key) }"
        @click="toggleKind(k.key)"
      >
        <span class="dot" :style="{ background: EDGE_COLORS[k.key] }"></span>{{ k.label }}
      </button>
      <span class="spacer"></span>
      <span class="hint">点图例可隐藏/显示该类边</span>
    </div>

    <p v-if="graph.truncated" class="warn">
      节点或边超过上限，已截断显示（节点 {{ graph.stats.nodes }}、
      边 {{ graph.stats.edges }}）。被截断的数量：节点 {{ graph.stats.droppedNodes }}、
      边 {{ graph.stats.droppedEdges }}。
    </p>

    <div v-if="!graph.nodes.length" class="empty">
      还没有人物或势力。先在「人物」「势力」标签里建几条记录，这里就会出现关系图。
    </div>

    <div v-else class="rel-body">
      <svg
        class="rel-svg"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="人物关系图"
      >
        <g class="edges">
          <line
            v-for="e in layout.edges"
            :key="e.id"
            :x1="e.x1"
            :y1="e.y1"
            :x2="e.x2"
            :y2="e.y2"
            :stroke="EDGE_COLORS[e.kind] || '#a0aec0'"
            :stroke-width="Math.min(4, 0.9 + Math.log2(e.weight + 1))"
            :stroke-dasharray="e.dashed ? '5 4' : ''"
            :opacity="e.kind === 'cooccur' ? 0.45 : 0.8"
          >
            <title>{{ e.label }}</title>
          </line>
        </g>
        <g class="nodes">
          <g
            v-for="n in layout.nodes"
            :key="n.id"
            class="node"
            :class="{ active: selectedId === n.id }"
            @click="selectNode(n.id)"
          >
            <circle
              :cx="n.x"
              :cy="n.y"
              :r="n.r"
              :fill="nodeColor(n.kind)"
              :stroke="selectedId === n.id ? '#1a202c' : '#fff'"
              :stroke-width="selectedId === n.id ? 2.5 : 1.5"
            />
            <text :x="n.x" :y="n.y + n.r + 14" text-anchor="middle">{{ n.label }}</text>
          </g>
        </g>
      </svg>

      <aside v-if="selected" class="rel-detail">
        <h5>{{ selected.label }}</h5>
        <p class="meta">
          {{ GRAPH_NODE_KINDS.find((k) => k.key === selected.kind)?.label || selected.kind }}
          <template v-if="selected.status"> · {{ selected.status }}</template>
          · 连接 {{ selected.degree }} 条
        </p>
        <ul v-if="selectedRelations.length" class="rels">
          <li v-for="r in selectedRelations" :key="r.id">
            <span class="kind">{{ r.kindLabel }}</span>
            <button class="link" @click="selectNode(r.otherId)">{{ r.otherLabel }}</button>
            <span v-if="r.count > 1" class="count">×{{ r.count }}</span>
            <span v-if="r.kind === 'relation'" class="note">{{ r.label }}</span>
          </li>
        </ul>
        <p v-else class="hint">这条记录还没有连到别人。</p>
        <button class="btn sm" @click="gotoEntity">打开{{ selected.kind === 'character' ? '人物' : selected.kind === 'faction' ? '势力' : '地点' }}表</button>
      </aside>
      <aside v-else class="rel-detail muted">
        <p class="hint">点一个节点查看它的关系。连线按关系类型着色，虚线表示推断出来的关系。</p>
      </aside>
    </div>

    <p class="hint">
      「同场」来自事件里的涉及人物；「人物关系」只解析每人「人物关系」栏里恰好提到两个已知人物、
      且有明确分隔符的行 —— 宁可少画，也不把一句叙述误读成关系。
    </p>
  </div>
</template>

<style scoped>
.rel {
  padding: 4px 2px 24px;
}
.rel-head h4 {
  margin: 0 0 6px;
}
.hint {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.7;
  margin: 6px 0;
}
.warn {
  color: var(--danger, #c0392b);
  font-size: 12.5px;
  line-height: 1.7;
}
.rel-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  background: var(--bg-muted, #fafafa);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.stat {
  font-size: 12.5px;
  color: var(--text-2);
}
.legend {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid var(--border, #eee);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg, #fff);
}
.chip.off {
  opacity: 0.38;
  text-decoration: line-through;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.empty {
  margin-top: 14px;
  padding: 20px;
  border: 1px dashed var(--border, #ddd);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.rel-body {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  align-items: stretch;
}
.rel-svg {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  background: var(--bg, #fff);
}
.node {
  cursor: pointer;
}
.node text {
  font-size: 12px;
  fill: var(--text, #1a202c);
  pointer-events: none;
}
.node:hover circle {
  stroke: var(--accent, #2b6cb0);
  stroke-width: 2.5;
}
.rel-detail {
  width: 230px;
  flex-shrink: 0;
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: flex-start;
}
.rel-detail.muted {
  color: var(--text-3, #999);
}
.rel-detail h5 {
  margin: 0;
  font-size: 14px;
}
.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}
.rels {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow: auto;
}
.rels li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.kind {
  color: var(--text-3, #999);
  font-size: 11.5px;
}
.link {
  color: var(--accent, #2b6cb0);
  background: none;
  padding: 0;
  font-size: 12.5px;
}
.count {
  color: var(--text-3, #999);
  font-size: 11.5px;
}
.note {
  color: var(--text-3, #999);
  font-size: 11.5px;
  width: 100%;
}
@media (max-width: 860px) {
  .rel-body {
    flex-direction: column;
  }
  .rel-detail {
    width: auto;
  }
}
</style>
