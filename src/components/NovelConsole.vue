<script setup>
import { ref, computed, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { useGeneration } from '../store/generation'
import { ENTITY_SCHEMAS } from '../services/novel/schemas'
import { groupVersions } from '../services/novel/versioning'
import { planMigrationForBook, applyMigration } from '../services/migration'
import { toast } from '../store/toast'
import EntityTable from './EntityTable.vue'
import MemoryReview from './MemoryReview.vue'
import ContextPreview from './ContextPreview.vue'
import GenerationHistory from './GenerationHistory.vue'
import ChapterVersions from './ChapterVersions.vue'
import TimelineView from './TimelineView.vue'
import ConsistencyReport from './ConsistencyReport.vue'
import { runRuleChecks } from '../services/novel/consistency'

/**
 * 小说控制台：长篇小说的记忆与骨架都在这里。
 *
 * 做成**全屏弹窗**而不是 WritingView 的第四栏，是刻意的：三栏在窄屏上已经要
 * 靠底部标签切换，再加一栏会让移动端彻底不可用；而这些内容（几十个人物、
 * 上百条时间线事件）需要的是能滚动的整屏，不是一条 320px 的侧栏。
 *
 * 标签顺序 = 用户排查问题的顺序：先看骨架（卷/篇），再看人物与世界，
 * 然后时间线与伏笔，最后才是 AI 干活留下的痕迹（审阅/上下文/花费）。
 */
const emit = defineEmits(['close'])

const { store } = useBooks()
const cols = useCollections()
const gen = useGeneration()

const TABS = [
  { key: 'story', label: '剧情' },
  { key: 'characters', label: '人物' },
  { key: 'locations', label: '地点' },
  { key: 'factions', label: '势力' },
  { key: 'worldRules', label: '世界规则' },
  { key: 'timeline', label: '时间线' },
  { key: 'foreshadowing', label: '伏笔' },
  { key: 'review', label: '记忆审阅' },
  { key: 'consistency', label: '一致性' },
  { key: 'versions', label: '版本' },
  { key: 'workflow', label: '上下文与迁移' },
  { key: 'history', label: '生成历史' }
]

const tab = ref('story')

const pendingCount = computed(
  () => cols.list('reviewQueue').filter((r) => r.status === 'pending').length
)

const versionGroupCount = computed(
  () => groupVersions(store.versions, { chapters: store.chapters }).length
)

/**
 * 一致性徽标 = 规则发现的问题数。
 *
 * 这里与「一致性」那一页各算一次同一个纯函数 —— 输入是同一批 store，
 * 所以两处的数字必然一致。要在徽标上看到它，就必须在打开控制台时就算，
 * 而不是等用户点进去；纯函数无 I/O，这个代价可以忽略。
 */
const consistencyCount = computed(() =>
  store.bookId
    ? runRuleChecks({
        chapters: store.chapters,
        memory: cols.memory.store,
        structure: cols.structure.store
      }).stats.total
    : 0
)

function badgeOf(key) {
  if (key === 'review') return pendingCount.value || 0
  if (key === 'history') return gen.store.runs.length
  // 'versions' 不是集合名，走不到下面那支（cols.list 对未知名字返回空数组，
  // 徽标会恒为 0）。版本次数按**章节组数**报，与面板里列出的组数一致——
  // 按条数报会是个四位数，那个数字对用户没有任何意义。
  if (key === 'versions') return versionGroupCount.value || 0
  // 同理：标签键叫 'timeline'，而集合叫 'events'。不显式映射的话这个徽标
  // 恒为 0 —— 它会一直安静地错着，没人看得出（时间轴面板里另有一份真实计数）。
  if (key === 'timeline') return cols.list('events').length
  if (key === 'consistency') return consistencyCount.value
  const n = cols.list(key).length
  return n || 0
}

// ---------------- 迁移 ----------------

const migration = ref(null) // planMigration 的结果，null = 没查到候选
const migrating = ref(false)

/**
 * 只在控制台打开时**查询**候选，绝不自动执行。
 *
 * 静默改写用户的真实数据正是这个项目一贯避免的事；而且不开控制台的 V1 用户
 * 应当保持 100% 的旧行为。迁移是「用户点了才会发生」的动作。
 */
async function scanMigration() {
  if (!store.bookId) return
  const plan = await planMigrationForBook(store.bookId)
  migration.value = plan.candidates.length ? plan : null
}

async function runMigration() {
  if (!migration.value || migrating.value) return
  migrating.value = true
  try {
    const res = await applyMigration(store.bookId, migration.value.candidates)
    // 落库之后刷新内存态，否则新建的实体要等下次开控制台才看得到
    await cols.loadForBook(store.bookId)
    migration.value = null
    toast(`已升级 ${res.migrated} 条旧设定`, 'success')
  } catch (e) {
    console.error('[console] 迁移失败', e)
    toast('升级失败：' + String((e && e.message) || e), 'error')
  } finally {
    migrating.value = false
  }
}

onMounted(async () => {
  if (!store.bookId) return
  // 载入必须走 useCollections：它同时覆盖记忆层与剧情结构，漏一族就会在界面上
  // 表现为「卷是空的」，而用户明明建过。
  await Promise.all([cols.loadForBook(store.bookId), gen.loadForBook(store.bookId)])
  await scanMigration()
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal console">
      <div class="modal-header">
        <h3>小说控制台 ·《{{ store.book?.title || '未命名' }}》</h3>
        <button class="btn ghost sm" @click="emit('close')">关闭</button>
      </div>

      <div v-if="migration" class="console-banner">
        <span>
          发现 {{ migration.stats.candidates }} 条旧设定可以升级为结构化实体。
          升级只是**新增**一份可被 AI 增量更新的副本，原有设定一字不改，侧栏里照旧可用。
        </span>
        <button class="btn sm primary" :disabled="migrating" @click="runMigration">
          {{ migrating ? '升级中…' : '一键升级' }}
        </button>
      </div>

      <div class="console-body">
        <nav class="console-tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="ctab"
            :class="{ active: tab === t.key }"
            @click="tab = t.key"
          >
            <span>{{ t.label }}</span>
            <span v-if="badgeOf(t.key)" class="ctab-badge">{{ badgeOf(t.key) }}</span>
          </button>
        </nav>

        <div class="console-pane">
          <!-- 剧情：卷与篇是作者自己规划的骨架，不由 AI 从正文反推 -->
          <template v-if="tab === 'story'">
            <EntityTable collection="volumes" order-by="order" />
            <hr class="console-hr" />
            <EntityTable collection="arcs" order-by="order" />
          </template>

          <!-- 时间线：轴用来看，表格用来录。表格那一份就是原来那行 EntityTable -->
          <TimelineView v-else-if="tab === 'timeline'" />

          <!-- 其余标签的 key 与集合名一一对应，一个组件按 schema 通吃 -->
          <EntityTable v-else-if="ENTITY_SCHEMAS[tab]" :key="tab" :collection="tab" />

          <MemoryReview v-else-if="tab === 'review'" />
          <!--
            报告里的每条问题都能跳走：实体类问题切到对应标签，章节类问题直接
            关掉控制台落到那一章。标签状态只在这里，所以由这里接住 goto。
          -->
          <ConsistencyReport
            v-else-if="tab === 'consistency'"
            @goto="tab = $event"
            @close="emit('close')"
          />
          <ChapterVersions v-else-if="tab === 'versions'" />
          <ContextPreview v-else-if="tab === 'workflow'" />
          <GenerationHistory v-else-if="tab === 'history'" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 既有 .modal 是 max-width:460px + overflow:auto（整框滚动），这与
 * 「左侧标签栏固定 + 右侧内容区独立滚动」直接冲突，所以这里用 .console
 * 修饰类覆盖掉，而不是去改 .modal —— 设置与导出两个弹窗仍在用那套。
 */
.modal.console {
  max-width: 1040px;
  height: 82vh;
  height: 82dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.console-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: var(--accent-soft);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
}
.console-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.console-tabs {
  width: 168px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 10px 8px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-2);
  text-align: left;
}
.ctab:hover {
  background: var(--bg-muted);
  color: var(--text);
}
.ctab.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.ctab-badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  background: var(--bg-muted);
  border-radius: 999px;
  padding: 0 6px;
}
.ctab.active .ctab-badge {
  background: var(--bg);
}
.console-pane {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.console-hr {
  width: 100%;
  border: 0;
  border-top: 1px dashed var(--border);
  margin: 4px 0;
}

/*
 * 窄屏：整屏铺满、标签栏改成顶部横向可滚动条。
 * 不去动 WritingView 的三栏/pane 逻辑 —— 控制台是完全独立的一层。
 */
@media (max-width: 860px) {
  .modal.console {
    max-width: none;
    height: 100vh;
    height: 100dvh;
    border-radius: 0;
  }
  .console-body {
    flex-direction: column;
  }
  .console-tabs {
    width: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 8px;
    gap: 6px;
  }
  .ctab {
    flex-shrink: 0;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .console-pane {
    padding: 14px;
  }
}
</style>
