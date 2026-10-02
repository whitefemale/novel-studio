<script setup>
import { ref, computed, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useNovelMemory } from '../store/novelMemory'
import { useStoryStructure } from '../store/storyStructure'
import { useSettings } from '../store/settings'
import { useGeneration } from '../store/generation'
import {
  runRuleChecks,
  CONSISTENCY_RULES,
  severityLabel,
  severityRank
} from '../services/novel/consistency'
import { runChapterWorkflow } from '../services/ai/orchestrator'
import { formatCost, formatTokens } from '../services/ai/tokenUsage'
import * as db from '../services/storage'
import { toast } from '../store/toast'

/**
 * 一致性报告：规则常开 + AI 深检手动。
 *
 * 这条分工是本组件存在的理由，也是界面上要讲清楚的第一件事：**规则那一半
 * 永远免费**。所以页面顶部写死了那句「规则检查不调用 AI，不产生费用」——
 * 用户必须能在按下任何按钮之前就知道哪些动作会花钱。
 *
 * 报告刻意分组折叠：一本 300 章的书光「章节缺摘要」就可能几百条，
 * 逐条平铺的结果是用户只看到第一屏、以为报告就这么多。
 */
const emit = defineEmits(['close'])

const { store, currentChapter, selectChapter } = useBooks()
const memory = useNovelMemory()
const structure = useStoryStructure()
const s = useSettings()
const gen = useGeneration()

const openRule = ref('')
const aiBusy = ref(false)
const aiReport = ref(null)
const aiError = ref('')
const aiRunId = ref('')
/**
 * 墓碑是异步读的，而 computed 必须同步 —— 所以它单独存一份 ref，
 * 由 onMounted 载入。缺了它只影响断链消息里那句「何时删除」的提示。
 */
const tombstones = ref([])

/**
 * 规则检查在打开这一页时算一次，之后跟着数据变化重算。
 * 纯函数、无 I/O，所以没有「刷新」按钮也不会有过期问题 —— 唯一能改变结果的
 * 事情是这个组件之外的动作（改了人物、删了章节），而那些动作会把 store 换掉。
 */
const report = computed(() =>
  store.bookId
    ? runRuleChecks({
        chapters: store.chapters,
        memory: memory.store,
        structure: structure.store,
        tombstones: tombstones.value
      })
    : { issues: [], stats: { total: 0, bySeverity: {}, byRule: {}, chapters: 0, entities: 0 } }
)

/** 按规则分组，组内保持 runRuleChecks 给出的顺序（稳定） */
const groups = computed(() => {
  const map = new Map()
  for (const it of report.value.issues) {
    if (!map.has(it.rule)) map.set(it.rule, [])
    map.get(it.rule).push(it)
  }
  const meta = new Map(CONSISTENCY_RULES.map((r, i) => [r.id, { r, i }]))
  return [...map.entries()]
    .map(([rule, items]) => ({ rule, ...meta.get(rule), items }))
    .sort((a, b) => severityRank(a.r.severity) - severityRank(b.r.severity) || a.i - b.i)
})

/** 完全没问题的规则也列出来 —— 「检查过了、没问题」和「没检查」不是一回事 */
const cleanRules = computed(() => {
  const hit = new Set(groups.value.map((g) => g.rule))
  return CONSISTENCY_RULES.filter((r) => !hit.has(r.id))
})

async function runAiReview() {
  if (aiBusy.value) return
  const ch = currentChapter.value
  if (!ch) {
    toast('请先在左侧选中一章再深检', 'error')
    return
  }
  if (!s.settings.apiKey) {
    toast('请先在设置里填 API Key', 'error')
    return
  }
  aiBusy.value = true
  aiError.value = ''
  aiReport.value = null
  try {
    await Promise.all([
      memory.store.loaded ? null : memory.loadForBook(store.bookId),
      structure.store.loaded ? null : structure.loadForBook(store.bookId)
    ])
    const wf = await runChapterWorkflow({
      input: {
        book: store.book,
        bookId: store.bookId,
        chapter: ch,
        chapters: store.chapters,
        outlines: store.outlines,
        memory: memory.store,
        structure: structure.store,
        settings: s.settings,
        action: 'review',
        text: ch.content || ''
      },
      settings: s.settings,
      // 只跑审校这一个阶段。它不是 DEFAULT_STAGES 的一员，见 orchestrator 的说明。
      stages: ['review'],
      recordRun: gen.recordRun
    })
    aiRunId.value = wf.run.id || ''
    if (wf.run.status === 'error') {
      aiError.value = wf.error || '审校失败'
    } else if (!wf.reviewReport) {
      aiError.value = '模型没有返回可解析的 JSON，见「生成历史」里的原始输出'
    } else {
      aiReport.value = wf.reviewReport
      // 记账已经由编排器落库（每次真实调用一条），这里只把金额显示出来。
      // 只有看得见花费，「手动触发」才不算是隐性花费。
      const run = gen.store.runs.find((r) => r.id === wf.run.id)
      toast(
        run?.cost != null ? `审校完成（花费 ${formatCost(run.cost)}）` : '审校完成',
        'success'
      )
    }
  } catch (e) {
    console.error('[consistency] AI 深检失败', e)
    aiError.value = String((e && e.message) || e)
  } finally {
    aiBusy.value = false
  }
}

/** AI 报告的三个数组合并成一份可渲染的列表，并标出它来自哪一类 */
const aiItems = computed(() => {
  const r = aiReport.value
  if (!r) return []
  const pick = (arr, kind) =>
    (Array.isArray(arr) ? arr : []).map((x, i) => ({
      id: `${kind}-${i}`,
      kind,
      title: x?.title || x?.message || '（未命名问题）',
      detail: x?.detail || x?.description || '',
      severity: x?.severity || r.severity || 'medium'
    }))
  return [
    ...pick(r.issues, '冲突'),
    ...pick(r.continuityIssues, '情节'),
    ...pick(r.styleIssues, '文风')
  ]
})

const KIND_LABELS = { 冲突: '与设定冲突', 情节: '情节衔接', 文风: '文风表达' }

const aiCost = computed(() => {
  const run = gen.store.runs.find((r) => r.id === aiRunId.value)
  return run ? describeCost(run) : ''
})

function describeCost(run) {
  const total = (run.inputTokens || 0) + (run.outputTokens || 0)
  return `${formatTokens(total)} tokens · ${run.cost == null ? '未定价' : formatCost(run.cost)}`
}

/**
 * 跳到出问题的地方。
 *
 * 「跳到实体」这件事在控制台内部没有路由 —— 标签是由 NovelConsole 持有的。
 * 与其把 tab 状态提升出去，不如让 NovelConsole 通过 emit('goto') 接住，
 * 它本来就是唯一知道标签怎么切的那一层。
 */
function goto(issue) {
  if (issue.entityType && issue.entityType !== 'chapters') {
    emit('goto', issue.entityType)
    return
  }
  if (issue.chapterId) {
    selectChapter(issue.chapterId)
    emit('close')
  }
}

onMounted(async () => {
  // 撑开第一条有问题的规则：一进来就看到具体内容才有用
  const first = groups.value[0]
  if (first) openRule.value = first.rule
  if (store.bookId) tombstones.value = await db.getTombstones(store.bookId)
})
</script>

<template>
  <div class="cr">
    <div class="cr-head">
      <h4>一致性检查</h4>
      <span class="cr-free">规则检查不调用 AI，不产生费用</span>
    </div>

    <div class="cr-sum">
      <span v-if="!report.stats.total" class="cr-ok">规则未发现问题</span>
      <template v-else>
        <span>共 {{ report.stats.total }} 项</span>
        <span v-if="report.stats.bySeverity.high" class="cr-high">
          高 {{ report.stats.bySeverity.high }}
        </span>
        <span v-if="report.stats.bySeverity.medium" class="cr-mid">
          中 {{ report.stats.bySeverity.medium }}
        </span>
        <span v-if="report.stats.bySeverity.low" class="cr-low">
          低 {{ report.stats.bySeverity.low }}
        </span>
      </template>
      <span class="cr-scope">
        已检查 {{ report.stats.chapters }} 章 / {{ report.stats.entities }} 条设定
      </span>
    </div>

    <div v-for="g in groups" :key="g.rule" class="cr-group" :class="`sev-${g.r.severity}`">
      <button class="cr-ghead" @click="openRule = openRule === g.rule ? '' : g.rule">
        <span class="cr-caret">{{ openRule === g.rule ? '▾' : '▸' }}</span>
        <span class="cr-sev">{{ severityLabel(g.r.severity) }}</span>
        <span class="cr-glabel">{{ g.r.label }}</span>
        <span class="cr-gcount">{{ g.items.length }}</span>
      </button>
      <div v-if="openRule === g.rule" class="cr-list">
        <p class="cr-hint">{{ g.r.hint }}</p>
        <button v-for="it in g.items" :key="it.id" class="cr-item" @click="goto(it)">
          <span class="cr-title">{{ it.title }}</span>
          <span class="cr-detail">{{ it.detail }}</span>
          <span v-if="it.deletedAt" class="cr-gone">目标记录已于 {{ new Date(it.deletedAt).toLocaleDateString() }} 删除</span>
          <span class="cr-go">{{ it.chapterId ? '去这一章 →' : '去这一栏 →' }}</span>
        </button>
      </div>
    </div>

    <details v-if="cleanRules.length" class="cr-clean">
      <summary>未发现问题的 {{ cleanRules.length }} 条规则</summary>
      <ul>
        <li v-for="r in cleanRules" :key="r.id">
          <b>{{ r.label }}</b> —— {{ r.hint }}
        </li>
      </ul>
    </details>

    <!-- ---------------- AI 深检 ---------------- -->
    <div class="cr-ai">
      <div class="cr-ai-head">
        <h4>AI 深检</h4>
        <span class="cr-cost">
          手动触发。<b>会真实调用模型并计费</b>，费用记在「生成历史」里
        </span>
      </div>
      <p class="cr-hint">
        规则只能查确定性的事（断链、逾期、倒挂）。文风前后不一、语气突变、
        暗示与回收是否相称这类判断交给模型，所以它是手动的：
        <b>{{ currentChapter ? `当前章：第${currentChapter.order}章 ${currentChapter.title || ''}` : '尚未选中章节' }}</b>
      </p>
      <div class="cr-ai-ops">
        <button class="btn primary sm" :disabled="aiBusy || !currentChapter" @click="runAiReview">
          {{ aiBusy ? '审校中…' : 'AI 深检本章' }}
        </button>
        <span v-if="aiCost" class="cr-ai-cost">{{ aiCost }}</span>
      </div>

      <p v-if="aiError" class="cr-err">{{ aiError }}</p>

      <div v-if="aiReport" class="cr-ai-out">
        <p v-if="!aiItems.length" class="cr-ok">模型没有发现新问题。</p>
        <div v-for="it in aiItems" :key="it.id" class="cr-ai-item" :class="`sev-${it.severity}`">
          <span class="cr-sev">{{ severityLabel(it.severity) }}</span>
          <span class="cr-kind">{{ KIND_LABELS[it.kind] }}</span>
          <span class="cr-title">{{ it.title }}</span>
          <p v-if="it.detail" class="cr-detail">{{ it.detail }}</p>
        </div>
        <p class="cr-hint">
          这份报告**不落库**：它针对的是这一版正文，正文一改就过期。
          要留档请把上面这段复制走。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cr {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cr-head,
.cr-ai-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.cr-head h4,
.cr-ai-head h4 {
  margin: 0;
  font-size: 15px;
}
.cr-free {
  font-size: 12px;
  color: var(--success);
}
.cr-sum {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-3);
}
.cr-ok {
  color: var(--success);
}
.cr-high {
  color: var(--danger);
}
.cr-mid {
  color: #b8860b;
}
.cr-low {
  color: var(--text-3);
}
.cr-scope {
  margin-left: auto;
}
.cr-group {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.cr-group.sev-high {
  border-left: 3px solid var(--danger);
}
.cr-group.sev-medium {
  border-left: 3px solid #d5a021;
}
.cr-group.sev-low {
  border-left: 3px solid var(--border);
}
.cr-ghead {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  text-align: left;
  font-size: 13px;
}
.cr-ghead:hover {
  background: var(--bg-muted);
}
.cr-caret {
  color: var(--text-3);
  font-size: 11px;
}
.cr-sev {
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  color: var(--text-3);
  flex-shrink: 0;
}
.sev-high .cr-sev {
  color: var(--danger);
  border-color: var(--danger);
}
.sev-medium .cr-sev {
  color: #b8860b;
}
.cr-glabel {
  flex: 1;
}
.cr-gcount {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-muted);
  border-radius: 999px;
  padding: 1px 7px;
}
.cr-list {
  border-top: 1px solid var(--border);
  padding: 8px 12px 12px;
}
.cr-hint {
  margin: 6px 0 10px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.cr-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.cr-item + .cr-item {
  border-top: 1px dashed var(--border);
}
.cr-item:hover {
  background: var(--bg-muted);
}
.cr-title {
  color: var(--text);
}
.cr-detail {
  margin: 0;
  color: var(--text-3);
  line-height: 1.8;
}
.cr-gone {
  color: var(--danger);
}
.cr-go {
  color: var(--accent);
  font-size: 11px;
}
.cr-clean {
  font-size: 12px;
  color: var(--text-3);
}
.cr-clean summary {
  cursor: pointer;
}
.cr-clean ul {
  margin: 6px 0 0;
  padding-left: 20px;
  line-height: 1.9;
}
.cr-ai {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cr-cost {
  font-size: 12px;
  color: var(--text-3);
}
.cr-ai-ops {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cr-ai-cost {
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.cr-err {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
  line-height: 1.8;
}
.cr-ai-out {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.cr-ai-item {
  padding: 7px 0;
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.cr-ai-item .cr-detail {
  flex-basis: 100%;
}
.cr-kind {
  font-size: 11px;
  color: var(--text-3);
}
</style>
