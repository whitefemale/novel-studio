<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { buildTimeline, TIMELINE_SORTS, TIMELINE_KINDS } from '../services/novel/timeline'
import EntityTable from './EntityTable.vue'

/**
 * 时间线：事件与伏笔在同一条轴上的样子。
 *
 * 图形轴与表格是**两种用途**，不是两种风格：轴用来一眼看出「哪一章发生了多少事、
 * 伏笔埋在哪、有没有逾期没回收」，表格用来录入与修改。表格那一份原样保留了
 * 既有的 EntityTable，没有另写一个编辑器。
 *
 * 轴的画法是纯 CSS（一条竖线 + 圆点），只有分支连线才用内联 SVG ——
 * 为了这条轴去装一个图形库，与「运行时依赖只有三个」这条约定直接冲突。
 */
const { store, selectChapter } = useBooks()
const cols = useCollections()

const mode = ref('axis') // 'axis' | 'table'
const sortBy = ref('chapter')
const expanded = ref('') // 展开详情的节点 id

const inputs = () => ({
  chapters: store.chapters,
  events: cols.list('events'),
  foreshadowing: cols.list('foreshadowing'),
  locations: cols.list('locations'),
  characters: cols.list('characters'),
  factions: cols.list('factions'),
  worldRules: cols.list('worldRules'),
  volumes: cols.list('volumes'),
  arcs: cols.list('arcs')
})

/**
 * 每次相关集合变化都重算。buildTimeline 是纯函数，没有缓存也就没有过期问题 ——
 * 这条轴的数据量是「一本书的事件数」，重算的开销远小于维护缓存的复杂度。
 */
const timeline = computed(() => buildTimeline({ ...inputs(), sortBy: sortBy.value }))
const nodes = computed(() => timeline.value.nodes)
const warnings = computed(() => timeline.value.warnings)

/**
 * 折叠成「章节锚点 + 挂在它下面的节点」。
 * 轴上重复出现同一个章节锚点会让人以为那是两章。
 */
const groups = computed(() => {
  const out = []
  let cur = null
  for (const n of nodes.value) {
    const key = n.chapterId || ''
    if (!cur || cur.key !== key) {
      cur = {
        key,
        chapterId: n.chapterId,
        order: n.chapterOrder,
        title: n.chapterTitle,
        orphan: n.orphan,
        items: []
      }
      out.push(cur)
    }
    cur.items.push(n)
  }
  return out
})

const warningOf = (sourceType, sourceId) =>
  warnings.value.filter((w) => w.sourceType === sourceType && w.sourceId === sourceId)

function jumpTo(n) {
  // 章节已删除的节点没有可去的地方，点了不该静默无反应
  if (!n.chapterId || n.orphan) return
  selectChapter(n.chapterId)
  if (typeof document !== 'undefined') {
    // 控制台是盖住编辑器的一层，点节点后关掉它才看得见那一章
    document.querySelector('.modal.console .modal-header .btn')?.click()
  }
}
</script>

<template>
  <div class="tl">
    <div class="tl-head">
      <h4>时间线</h4>
      <div class="tl-ops">
        <button class="btn sm" :class="{ primary: mode === 'axis' }" @click="mode = 'axis'">
          时间轴
        </button>
        <button class="btn sm" :class="{ primary: mode === 'table' }" @click="mode = 'table'">
          表格
        </button>
      </div>
    </div>

    <template v-if="mode === 'axis'">
      <div class="tl-sum">
        <span>事件 {{ timeline.counts.events }}</span>
        <span>伏笔 {{ timeline.counts.foreshadowing }}</span>
        <span v-if="timeline.counts.overdue" class="tl-warn">逾期未回收 {{ timeline.counts.overdue }}</span>
        <span v-if="timeline.counts.orphan" class="tl-warn">章节已删除 {{ timeline.counts.orphan }}</span>
        <span v-if="timeline.counts.warnings" class="tl-warn">断链 {{ timeline.counts.warnings }}</span>
        <label class="tl-sort">
          排序
          <select v-model="sortBy" class="input tl-select">
            <option v-for="s in TIMELINE_SORTS" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
      </div>

      <p v-if="warnings.length" class="tl-notes">
        <b>断链</b>：下面这些引用指向了已删除的记录，轴上的标记是虚线。
        <span v-for="w in warnings" :key="w.id" class="tl-note">{{ w.message }}</span>
      </p>

      <div v-if="!groups.length" class="tl-empty">
        还没有事件。在「事件」标签里建几条，或者让 AI 写完一章后自动提取。
      </div>

      <ol v-else class="tl-axis">
        <li v-for="g in groups" :key="g.key || '__none__'" class="tl-group">
          <div class="tl-anchor">
            <span class="tl-dot"></span>
            <span class="tl-chap">
              {{ g.chapterId ? g.orphan ? '章节已删除' : `第${g.order}章 · ${g.title}` : '未归入章节' }}
            </span>
            <button
              v-if="g.chapterId && !g.orphan"
              class="btn ghost sm"
              @click="jumpTo({ chapterId: g.chapterId })"
            >
              去这一章
            </button>
          </div>

          <div class="tl-items">
            <div
              v-for="n in g.items"
              :key="n.id"
              class="tl-node"
              :class="[`kind-${n.kind}`, { orphan: n.orphan, overdue: n.overdue }]"
            >
              <div class="tl-row" @click="expanded = expanded === n.id ? '' : n.id">
                <span class="tl-kind">{{ TIMELINE_KINDS[n.kind] }}</span>
                <span v-if="n.time" class="tl-time">{{ n.time }}</span>
                <span class="tl-title">{{ n.title }}</span>
                <span v-if="n.overdue" class="tl-flag">逾期未回收</span>
                <span v-if="n.orphan" class="tl-flag">引用已失效</span>
              </div>
              <div v-if="expanded === n.id" class="tl-detail">
                <p v-if="n.detail" class="tl-text">{{ n.detail }}</p>
                <p v-if="n.extra" class="tl-text tl-sub">{{ n.extra }}</p>
                <div v-if="n.refs.length" class="tl-refs">
                  <span
                    v-for="r in n.refs"
                    :key="r.field + r.id"
                    class="tl-ref"
                    :class="{ bad: !r.ok }"
                  >
                    {{ r.fieldLabel }}：{{ r.name }}
                  </span>
                </div>
                <div
                  v-for="w in warningOf(n.kind === 'event' ? 'events' : 'foreshadowing', n.entityId)"
                  :key="w.id"
                  class="tl-broken"
                >
                  ⚠ {{ w.message }}
                </div>
              </div>
            </div>
          </div>
        </li>
      </ol>
    </template>

    <!-- 录入与修改仍走 schema 驱动的那张表，不另写编辑器 -->
    <EntityTable v-else collection="events" order-by="timeline" />
  </div>
</template>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.tl-head h4 {
  margin: 0;
  font-size: 15px;
}
.tl-ops {
  display: flex;
  gap: 6px;
}
.tl-sum {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-3);
}
.tl-warn {
  color: var(--danger);
}
.tl-sort {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.tl-select {
  padding: 3px 8px;
  font-size: 12px;
}
.tl-notes {
  margin: 0;
  font-size: 12px;
  line-height: 1.9;
  color: var(--text-2);
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.tl-note {
  display: block;
  color: var(--danger);
}
.tl-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 16px 0;
}

/* ---- 竖轴 ---- */
.tl-axis {
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
  position: relative;
}
.tl-axis::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: var(--border);
}
.tl-group {
  position: relative;
  padding-bottom: 14px;
}
.tl-anchor {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  position: relative;
}
.tl-dot {
  position: absolute;
  left: -14px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--bg);
}
.tl-chap {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.tl-node {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
/* 伏笔的埋点与回收点用不同的边色：轴上最常问的就是「这条回收了没有」 */
.tl-node.kind-plant {
  border-left-color: #d5a021;
}
.tl-node.kind-reveal {
  border-left-color: #2f9e6e;
}
/* 引用失效 / 逾期用虚线：这两类是「需要作者去处理」的信号，
   不应该和正常节点长得一样 */
.tl-node.orphan,
.tl-node.overdue {
  border-style: dashed;
}
.tl-node.overdue {
  border-left-color: var(--danger);
  border-left-style: solid;
}
.tl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  cursor: pointer;
  flex-wrap: wrap;
}
.tl-row:hover {
  background: var(--bg-muted);
}
.tl-kind {
  font-size: 11px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  flex-shrink: 0;
}
.tl-time {
  color: var(--accent);
  font-size: 11px;
  flex-shrink: 0;
}
.tl-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-flag {
  color: var(--danger);
  font-size: 11px;
  flex-shrink: 0;
}
.tl-detail {
  border-top: 1px dashed var(--border);
  padding: 8px 10px 10px;
}
.tl-text {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
  white-space: pre-wrap;
}
.tl-sub {
  color: var(--text-3);
}
.tl-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tl-ref {
  font-size: 11px;
  background: var(--bg-muted);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--text-2);
}
.tl-ref.bad {
  color: var(--danger);
}
.tl-broken {
  margin-top: 6px;
  font-size: 11px;
  color: var(--danger);
  line-height: 1.8;
}
</style>
