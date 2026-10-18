<script setup>
import { computed } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { buildStats, DENSITY_BUCKET } from '../services/novel/stats'

/**
 * 写作统计：完成度、人物出场、伏笔回收、事件密度。
 *
 * 刻意只用 CSS 条形，不引图表库：
 *   - 打包体积是实打实的约束（见 CLAUDE.md 的 asar 条目数约定），
 *     而这里要画的只是「一排按比例伸缩的 div」；
 *   - 图表库会顺手带来 tooltip / 动画 / 主题等一整套默认样式，
 *     在一个纯白色主题里反而要挨个覆盖。
 *
 * 所有数字来自纯函数 buildStats（可单测），本组件只负责排版。
 * 每块标题旁都写明口径 —— 「这个 38% 到底在算什么」不该靠猜。
 */

const { store } = useBooks()
const cols = useCollections()

const stats = computed(() =>
  buildStats({
    chapters: store.chapters,
    memory: cols.memory.store,
    structure: cols.structure.store
  })
)

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN')
const pct = (v) => `${Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)))}%`

const topCharacters = computed(() => stats.value.characters.rows.filter((r) => r.chapters > 0).slice(0, 15))
const maxCharChapters = computed(() =>
  Math.max(1, ...topCharacters.value.map((r) => r.chapters))
)
const maxBucketEvents = computed(() =>
  Math.max(1, ...stats.value.density.buckets.map((b) => b.events))
)
const volumeRows = computed(() => stats.value.volumes.slice(0, 40))
const arcRows = computed(() => stats.value.arcs.slice(0, 60))
</script>

<template>
  <div class="stats">
    <div class="stats-head">
      <h4>写作统计</h4>
      <p class="hint">{{ stats.note }}</p>
    </div>

    <div class="cards">
      <div class="card">
        <span class="k">总字数</span>
        <span class="v">{{ fmt(stats.chapters.words) }}</span>
        <span class="s">已写 {{ stats.chapters.written }} / {{ stats.chapters.total }} 章</span>
      </div>
      <div class="card">
        <span class="k">平均章字数</span>
        <span class="v">{{ fmt(Math.round(stats.chapters.avgWords)) }}</span>
        <span class="s">中位数 {{ fmt(Math.round(stats.chapters.medianWords)) }}（只算已写章节）</span>
      </div>
      <div class="card">
        <span class="k">目标字数完成度</span>
        <span class="v">
          {{ stats.chapters.targetWords ? pct(stats.chapters.targetProgress) : '—' }}
        </span>
        <span class="s">
          {{
            stats.chapters.targetWords
              ? `目标 ${fmt(stats.chapters.targetWords)} 字`
              : '施工卡里还没填目标字数'
          }}
        </span>
      </div>
      <div class="card">
        <span class="k">事件 / 伏笔</span>
        <span class="v">{{ stats.events.total }} / {{ stats.foreshadowing.total }}</span>
        <span class="s">
          伏笔回收率 {{ pct(stats.foreshadowing.rate) }} · 逾期
          {{ stats.foreshadowing.overdue.length }} 条
        </span>
      </div>
    </div>

    <section class="block">
      <h5>卷完成度 <span class="cap">按「已写章节 / 挂在本卷的章节」</span></h5>
      <p v-if="!volumeRows.length" class="empty">还没有建卷。卷与篇在「剧情」标签里维护。</p>
      <div v-for="v in volumeRows" :key="v.id" class="bar-row">
        <div class="bar-head">
          <span class="bar-label">{{ v.title }}</span>
          <span class="bar-meta">
            {{ v.written }} / {{ v.total }} 章 · {{ fmt(v.words) }} 字
            <template v-if="v.status"> · {{ v.status }}</template>
          </span>
        </div>
        <div class="bar"><i :style="{ width: pct(v.progress) }"></i></div>
      </div>
    </section>

    <section class="block">
      <h5>篇进度 <span class="cap">按章上的「所属篇」统计</span></h5>
      <p v-if="!arcRows.length" class="empty">还没有建篇。</p>
      <div class="scroll-list">
        <div v-for="a in arcRows" :key="a.id" class="bar-row">
          <div class="bar-head">
            <span class="bar-label">{{ a.title }}</span>
            <span class="bar-meta">{{ a.written }} / {{ a.total }} 章 · {{ fmt(a.words) }} 字</span>
          </div>
          <div class="bar thin"><i :style="{ width: pct(a.progress) }"></i></div>
        </div>
      </div>
    </section>

    <section class="block">
      <h5>线索推进 <span class="cap">「主线」标记写在施工卡的线索字段里</span></h5>
      <p v-if="stats.threads.mainLastOrder == null" class="empty">
        还没有任何章节标记「主线」。在章节施工卡的「涉及的线索」里写上「主线」即可参与统计。
      </p>
      <p v-else class="line">
        最后一次主线推进：第 {{ stats.threads.mainLastOrder }} 章之后又写了
        <b>{{ stats.threads.mainGap }}</b> 章。
      </p>
      <div v-if="stats.threads.arcs.length" class="thread-list">
        <div v-for="a in stats.threads.arcs" :key="a.id" class="thread-row">
          <span>{{ a.title }}</span>
          <span class="bar-meta">
            <template v-if="a.lastOrder != null">最近挂章：第 {{ a.lastOrder }} 章 · 之后 {{ a.gap }} 章</template>
            <template v-else>还没有章节挂到这一篇</template>
          </span>
        </div>
      </div>
    </section>

    <section class="block">
      <h5>人物出场 <span class="cap">事件 / 场景涉及 + 最近出场章节，按章去重</span></h5>
      <p class="line">
        共 {{ stats.characters.tracked }} 人，出现过 {{ stats.characters.appeared }} 人，
        从未出场 {{ stats.characters.never }} 人。
      </p>
      <p v-if="!topCharacters.length" class="empty">还没有可统计的人物出场记录。</p>
      <div v-for="p in topCharacters" :key="p.id" class="bar-row">
        <div class="bar-head">
          <span class="bar-label">{{ p.name }}</span>
          <span class="bar-meta">
            {{ p.chapters }} 章 · 事件 {{ p.events }} · 场景 {{ p.scenes }}
            <template v-if="p.gap != null && p.gap > 0"> · 已 {{ p.gap }} 章未出场</template>
          </span>
        </div>
        <div class="bar"><i :style="{ width: pct(p.chapters / maxCharChapters) }"></i></div>
      </div>
    </section>

    <section class="block">
      <h5>伏笔 <span class="cap">回收率 =（已揭示 + 已收束）/ 全部</span></h5>
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-label">回收进度</span>
          <span class="bar-meta">
            {{ stats.foreshadowing.revealed + stats.foreshadowing.resolved }} /
            {{ stats.foreshadowing.total }} · 进行中 {{ stats.foreshadowing.active }} ·
            已废弃 {{ stats.foreshadowing.abandoned }}
          </span>
        </div>
        <div class="bar"><i :style="{ width: pct(stats.foreshadowing.rate) }"></i></div>
      </div>
      <p v-if="!stats.foreshadowing.overdue.length" class="line ok">没有逾期未回收的伏笔。</p>
      <div v-else class="overdue">
        <p class="line warn">逾期未回收（预计揭示章已写完，状态仍是已埋下 / 发展中）：</p>
        <ul>
          <li v-for="f in stats.foreshadowing.overdue" :key="f.id">
            {{ f.title }} <span class="muted">（预计第 {{ f.expectedOrder }} 章）</span>
          </li>
        </ul>
      </div>
    </section>

    <section class="block">
      <h5>
        事件密度
        <span class="cap">每 {{ DENSITY_BUCKET }} 章一段，按所属章节归属事件与场景</span>
      </h5>
      <p v-if="!stats.density.buckets.length" class="empty">还没有章节可分段。</p>
      <div v-for="b in stats.density.buckets" :key="`${b.from}-${b.to}`" class="bar-row">
        <div class="bar-head">
          <span class="bar-label">第 {{ b.from }}–{{ b.to }} 章</span>
          <span class="bar-meta">
            {{ b.events }} 事件 · {{ b.scenes }} 场景 · {{ fmt(b.words) }} 字 ·
            每千字 {{ b.perThousandWords.toFixed(2) }} 事件
          </span>
        </div>
        <div class="bar"><i :style="{ width: pct(b.events / maxBucketEvents) }"></i></div>
      </div>
      <p class="hint">
        平均每段 {{ stats.density.meanEvents.toFixed(1) }} 个事件。密度高低不直接等于好坏：
        它只说明「这一段发生的事多不多」，情节评价仍由作者判断。
      </p>
    </section>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.stats-head h4 {
  margin: 0 0 4px;
  font-size: 15px;
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  background: var(--bg-muted);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.card .k {
  font-size: 12px;
  color: var(--text-3);
}
.card .v {
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.card .s {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}
.block {
  border-top: 1px dashed var(--border);
  padding-top: 14px;
}
.block h5 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.cap {
  font-weight: 400;
  color: var(--text-3);
  font-size: 11px;
  margin-left: 6px;
}
.line {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
}
.line.ok {
  color: var(--success);
}
.line.warn {
  color: var(--warn);
}
.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
}
.bar-row {
  margin-bottom: 9px;
}
.bar-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 3px;
}
.bar-label {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-meta {
  flex-shrink: 0;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.bar {
  height: 7px;
  border-radius: 999px;
  background: var(--bg-hover);
  overflow: hidden;
}
.bar.thin {
  height: 5px;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s ease;
}
.scroll-list {
  max-height: 280px;
  overflow: auto;
  padding-right: 4px;
}
.thread-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.thread-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border);
}
.overdue ul {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
}
.muted {
  color: var(--text-3);
}
</style>
