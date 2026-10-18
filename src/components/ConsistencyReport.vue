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
import {
  flattenReviewReport,
  saveIssueStates,
  setIssueStatus,
  stateMap,
  isIssueStale,
  contentHashOf,
  REVIEW_STATUS_LABELS,
  REVIEW_CATEGORY_LABELS
} from '../services/novel/reviewIssues'
import { diffText, collapsedDiff } from '../services/novel/diff'
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

const {
  store,
  currentChapter,
  selectChapter,
  captureChapterVersion,
  setChapterContent,
  persistChapter
} = useBooks()
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
 * 审校时那一版正文的快照。
 *
 * 问题列表与问题 id 都基于这一份文本，所以必须存下来：正文一改，旧报告就过期，
 * 界面要能**明确地说过期了**，而不是拿旧结论继续显示。也不能在读的时候取
 * 当前正文——那样 id 会跟着正文漂移，用户标过的「已忽略」就对不上了。
 */
const reviewSnapshot = ref({ chapterId: '', content: '' })
const issueStates = ref([])
const statesById = computed(() => stateMap(issueStates.value))

const chapterOf = (id) => store.chapters.find((c) => c.id === id) || null
const liveContentOf = (id) => chapterOf(id)?.content ?? ''

const reportStale = computed(() => {
  if (!reviewSnapshot.value.chapterId) return false
  return contentHashOf(liveContentOf(reviewSnapshot.value.chapterId)) !== contentHashOf(reviewSnapshot.value.content)
})
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
  // 快照在发起请求之前取：请求期间的任何改动都不该混进这一份报告的身份里。
  const contentSnapshot = ch.content || ''
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
        styleProfiles: structure.store.styleProfiles || [],
        settings: s.settings,
        action: 'review',
        text: contentSnapshot
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
      reviewSnapshot.value = { chapterId: ch.id, content: contentSnapshot }
      // 报告正文不落库，只落**用户对每条问题的状态**。saveIssueStates 只补缺失的
      // id，不会把用户标过的「已忽略」重置回「待处理」。
      const items = flattenReviewReport(wf.reviewReport, {
        chapterId: ch.id,
        content: contentSnapshot
      })
      issueStates.value = await saveIssueStates(store.bookId, items, {
        reportRunId: aiRunId.value
      })
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

/** AI 报告压平成一列问题；兼容新契约（单一 issues）与旧契约（三类数组）。 */
const aiItems = computed(() =>
  flattenReviewReport(aiReport.value, {
    chapterId: reviewSnapshot.value.chapterId,
    content: reviewSnapshot.value.content
  })
)

function statusOf(issue) {
  return statesById.value.get(issue.id)?.status || 'open'
}

/** 这条问题对应的正文已经变了 —— 状态仍显示，但要标明「报告已过期」。 */
function issueStale(issue) {
  const st = statesById.value.get(issue.id)
  if (!st) return false
  return isIssueStale(st, liveContentOf(issue.chapterId))
}

async function loadIssueStates() {
  if (!store.bookId) {
    issueStates.value = []
    return
  }
  issueStates.value = await db.coll.reviewIssueStates.getAll(store.bookId)
}

async function ignoreIssue(issue) {
  try {
    await setIssueStatus(store.bookId, issue, 'ignored', { reportRunId: aiRunId.value })
    await loadIssueStates()
    toast('已忽略这条问题', 'success')
  } catch (e) {
    console.error('[consistency] 问题状态保存失败', e)
    toast('状态保存失败：' + String((e && e.message) || e), 'error')
  }
}

// ---------------- 定向修复 ----------------
//
// 流程刻意分成三步：生成修订稿 → 预览 diff → 用户确认写回。任何一步都不会
// 自动改正文。写回前还要再比对一次基准正文：修复期间正文若被同步改动过，
// 直接写回就是一次静默覆盖。
const fixItem = ref(null)
const fixBusy = ref('')
const fixError = ref('')
const fixDraft = ref(null)
const fixBaseContent = ref('')
const fixChapterId = ref('')
const recheckBusy = ref(false)
const recheckDone = ref(false)
const recheckIssues = ref([])
const recheckVerdict = ref('')

const fixChapter = computed(() => chapterOf(fixChapterId.value))

const fixDiff = computed(() => {
  if (!fixDraft.value) return null
  const res = diffText(fixBaseContent.value, fixDraft.value.revised)
  return { rows: collapsedDiff(res.lines, 3), stats: res.stats }
})

async function startFix(issue) {
  if (fixBusy.value) return
  if (!s.settings.apiKey) {
    toast('请先在设置里填 API Key', 'error')
    return
  }
  const ch = chapterOf(issue.chapterId)
  if (!ch) {
    toast('问题对应的章节已经不存在', 'error')
    return
  }
  fixBusy.value = issue.id
  fixError.value = ''
  fixDraft.value = null
  fixItem.value = issue
  fixChapterId.value = ch.id
  fixBaseContent.value = ch.content || ''
  recheckDone.value = false
  recheckIssues.value = []
  recheckVerdict.value = ''
  try {
    const wf = await runChapterWorkflow({
      input: {
        book: store.book,
        bookId: store.bookId,
        chapter: ch,
        chapters: store.chapters,
        outlines: store.outlines,
        memory: memory.store,
        structure: structure.store,
        styleProfiles: structure.store.styleProfiles || [],
        settings: s.settings,
        action: 'fix',
        text: fixBaseContent.value,
        issue,
        reviewRunId: aiRunId.value
      },
      settings: s.settings,
      stages: ['fix'],
      recordRun: gen.recordRun
    })
    if (wf.run.status === 'error') {
      fixError.value = wf.error || '修复失败'
    } else if (!wf.fixDraft) {
      fixError.value = '模型没有返回可解析的修订稿，见「生成历史」里的原始输出'
    } else {
      fixDraft.value = wf.fixDraft
      const run = gen.store.runs.find((r) => r.id === wf.run.id)
      if (run?.cost != null) fixError.value = ''
    }
  } catch (e) {
    console.error('[consistency] 定向修复失败', e)
    fixError.value = String((e && e.message) || e)
  } finally {
    fixBusy.value = ''
  }
}

/**
 * 对修订稿重跑一次审校（会再产生一次真实调用与费用）。只做一轮：
 * 复核之后再修再复核会变成无限循环，而费用是用户自己的。
 */
async function recheckFix() {
  if (recheckBusy.value || !fixDraft.value || !fixItem.value) return
  const ch = fixChapter.value
  if (!ch) return
  recheckBusy.value = true
  recheckVerdict.value = ''
  recheckIssues.value = []
  try {
    const revised = fixDraft.value.revised
    const wf = await runChapterWorkflow({
      input: {
        book: store.book,
        bookId: store.bookId,
        chapter: { ...ch, content: revised },
        chapters: store.chapters,
        outlines: store.outlines,
        memory: memory.store,
        structure: structure.store,
        styleProfiles: structure.store.styleProfiles || [],
        settings: s.settings,
        action: 'review',
        text: revised
      },
      settings: s.settings,
      stages: ['review'],
      recordRun: gen.recordRun
    })
    if (wf.run.status === 'error' || !wf.reviewReport) {
      recheckVerdict.value = wf.error || '复核没有返回可解析的结果'
      return
    }
    const items = flattenReviewReport(wf.reviewReport, {
      chapterId: ch.id,
      content: revised
    })
    recheckIssues.value = items
    const target = fixItem.value
    const stillThere = items.find(
      (x) =>
        x.category === target.category &&
        (x.title === target.title || (target.quote && x.quote && x.quote === target.quote))
    )
    recheckDone.value = true
    if (stillThere) {
      recheckVerdict.value = '复核仍在修订稿里发现了这条问题，建议不要直接采用。'
      await setIssueStatus(store.bookId, target, 'recheck-failed', {
        reportRunId: aiRunId.value
      })
    } else {
      recheckVerdict.value = '复核未再发现这条问题。'
      await setIssueStatus(store.bookId, target, 'accepted', {
        reportRunId: aiRunId.value
      })
    }
    await loadIssueStates()
  } catch (e) {
    console.error('[consistency] 复核失败', e)
    recheckVerdict.value = String((e && e.message) || e)
  } finally {
    recheckBusy.value = false
  }
}

/**
 * 接受修订：先留一版（source:'review'），再写正文。
 * 写之前比对基准正文 —— 修复期间正文若被其他路径改过，拒绝写回。
 */
async function acceptFix() {
  if (!fixDraft.value || !fixItem.value) return
  const ch = fixChapter.value
  if (!ch) {
    toast('问题对应的章节已经不存在', 'error')
    return
  }
  if (String(ch.content || '') !== fixBaseContent.value) {
    toast('正文在修复期间发生了变化，为避免覆盖，请重新生成修订稿', 'error')
    return
  }
  const revised = fixDraft.value.revised
  fixBusy.value = 'accept'
  try {
    await captureChapterVersion(ch.id, { source: 'review' })
    setChapterContent(ch.id, revised)
    await persistChapter(ch.id)
    const newHash = contentHashOf(revised)
    await setIssueStatus(store.bookId, { ...fixItem.value, contentHash: newHash }, 'fixed', {
      reportRunId: aiRunId.value
    })
    await loadIssueStates()
    toast('已接受修订，修复前的那一版已存档', 'success')
    fixItem.value = null
    fixDraft.value = null
    emit('content-changed')
  } catch (e) {
    console.error('[consistency] 接受修订失败', e)
    toast('写回失败：' + String((e && e.message) || e), 'error')
  } finally {
    fixBusy.value = ''
  }
}

function dismissFix() {
  fixItem.value = null
  fixDraft.value = null
  fixError.value = ''
  recheckIssues.value = []
  recheckVerdict.value = ''
}

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
  if (store.bookId) {
    tombstones.value = await db.getTombstones(store.bookId)
    await loadIssueStates()
  }
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
        <p v-if="reportStale" class="cr-stale">
          这一章正文在审校之后已经改动过。下面的问题列表针对的是**审校时那一版**，
          请重新深检后再据此修改；你之前对每条问题的处理状态仍然保留。
        </p>
        <p v-if="!aiItems.length" class="cr-ok">模型没有发现新问题。</p>
        <div v-for="it in aiItems" :key="it.id" class="cr-ai-item" :class="`sev-${it.severity}`">
          <span class="cr-sev">{{ severityLabel(it.severity) }}</span>
          <span class="cr-kind">{{ REVIEW_CATEGORY_LABELS[it.category] || it.category }}</span>
          <span class="cr-title">{{ it.title }}</span>
          <span class="cr-state" :class="`st-${statusOf(it)}`">
            {{ REVIEW_STATUS_LABELS[statusOf(it)] || statusOf(it) }}
            <template v-if="issueStale(it)"> · 报告已过期</template>
          </span>
          <p v-if="it.quote" class="cr-quote">「{{ it.quote }}」</p>
          <p v-if="it.explanation" class="cr-detail">{{ it.explanation }}</p>
          <p v-if="it.evidence" class="cr-detail">证据：{{ it.evidence }}</p>
          <p v-if="it.suggestion" class="cr-detail">建议：{{ it.suggestion }}</p>
          <p v-if="it.falsePositiveHint" class="cr-detail">可能是误报的理由：{{ it.falsePositiveHint }}</p>
          <div class="cr-issue-ops">
            <button
              class="btn sm"
              :disabled="!!fixBusy || statusOf(it) === 'ignored'"
              @click="startFix(it)"
            >
              {{ fixBusy === it.id ? '生成修订稿…' : 'AI 定向修复' }}
            </button>
            <button
              class="btn ghost sm"
              :disabled="statusOf(it) === 'ignored'"
              @click="ignoreIssue(it)"
            >
              忽略
            </button>
          </div>

          <!-- 修订稿预览：改动看清楚之前不写库 -->
          <div v-if="fixItem && fixItem.id === it.id" class="cr-fix">
            <p v-if="fixError" class="cr-err">{{ fixError }}</p>
            <template v-if="fixDraft">
              <div class="cr-fix-stats">
                修订稿：新增 {{ fixDiff.stats.added }} 行 · 删除 {{ fixDiff.stats.removed }} 行 ·
                {{ fixDiff.stats.beforeWords }} → {{ fixDiff.stats.afterWords }} 字
              </div>
              <p v-if="fixDraft.explanation" class="cr-detail">修改说明：{{ fixDraft.explanation }}</p>
              <div class="cr-diff">
                <div v-for="(row, i) in fixDiff.rows" :key="i" class="dline" :class="row.type">
                  <template v-if="row.type === 'skip'">
                    <span class="dskip">… 省略 {{ row.count }} 行未变化的内容 …</span>
                  </template>
                  <template v-else>
                    <span class="dno">{{ row.type === 'add' ? (row.bLine ?? '') : (row.aLine ?? '') }}</span>
                    <span class="dmark">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ' }}</span>
                    <span class="dtext">{{ row.text }}</span>
                  </template>
                </div>
              </div>
              <p class="cr-hint">
                接受修订会先给当前正文存一版（来源「审校修复前」），再写回修订稿。
                复核会再调用一次模型并计费，每轮修复最多复核一次。
              </p>
              <p v-if="recheckVerdict" class="cr-recheck" :class="{ bad: recheckIssues.length && recheckVerdict.includes('建议') }">
                {{ recheckVerdict }}
              </p>
              <div class="cr-fix-ops">
                <button class="btn primary sm" :disabled="fixBusy === 'accept'" @click="acceptFix">
                  {{ fixBusy === 'accept' ? '写回中…' : '接受修订并写回' }}
                </button>
                <button
                  class="btn sm"
                  :disabled="recheckBusy || recheckDone"
                  @click="recheckFix"
                >
                  {{ recheckBusy ? '复核中…' : recheckDone ? '已复核（最多一次）' : '复核修订稿（计费）' }}
                </button>
                <button class="btn ghost sm" @click="dismissFix">放弃这次修订</button>
              </div>
            </template>
          </div>
        </div>
        <p class="cr-hint">
          完整报告**不落库**：它针对的是这一版正文，正文一改就过期。落库的只是
          你对每条问题的处理状态（待处理 / 已忽略 / 已接受 / 已修复 / 复核未通过），
          按正文指纹关联，正文变了就标「报告已过期」。
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
.cr-stale {
  margin: 0 0 8px;
  padding: 7px 10px;
  border: 1px solid #d5a021;
  border-radius: var(--radius-sm);
  color: #8a6508;
  background: rgba(213, 160, 33, 0.08);
  font-size: 12px;
  line-height: 1.8;
}
.cr-state {
  margin-left: auto;
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--bg-muted);
  color: var(--text-3);
}
.cr-state.st-fixed,
.cr-state.st-accepted {
  color: var(--success);
}
.cr-state.st-ignored {
  color: var(--text-3);
}
.cr-state.st-recheck-failed {
  color: var(--danger);
}
.cr-quote {
  margin: 0;
  flex-basis: 100%;
  font-size: 12px;
  color: var(--text-2);
  border-left: 2px solid var(--border);
  padding-left: 8px;
}
.cr-issue-ops {
  display: flex;
  gap: 6px;
  flex-basis: 100%;
}
.cr-fix {
  flex-basis: 100%;
  margin-top: 6px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cr-fix-stats {
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.cr-diff {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
}
.dline {
  display: flex;
  gap: 8px;
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dline.add {
  background: rgba(46, 160, 67, 0.12);
  color: var(--success);
}
.dline.del {
  background: rgba(248, 81, 73, 0.1);
  color: var(--danger);
}
.dline.equal {
  color: var(--text-2);
}
.dno {
  flex-shrink: 0;
  width: 34px;
  text-align: right;
  color: var(--text-3);
  user-select: none;
}
.dmark {
  flex-shrink: 0;
  width: 10px;
  user-select: none;
}
.dtext {
  flex: 1;
  min-width: 0;
}
.dskip {
  color: var(--text-3);
  padding: 2px 0;
}
.cr-recheck {
  margin: 0;
  font-size: 12px;
  color: var(--success);
}
.cr-recheck.bad {
  color: #b8860b;
}
.cr-fix-ops {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
