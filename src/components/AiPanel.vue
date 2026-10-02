<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { useGeneration, describeRun, aggregateRuns } from '../store/generation'
import { useNovelMemory } from '../store/novelMemory'
import { useStoryStructure } from '../store/storyStructure'
import { chatStream } from '../services/llm'
import { buildMessages } from '../services/prompts'
import { runChapterWorkflow, DEFAULT_STAGES, STAGE_LABELS } from '../services/ai/orchestrator'
import { ACTIONS, WORKFLOW_ACTIONS } from '../services/novel/actions'
import { providerFromUrl, formatTokens, formatCost } from '../services/ai/tokenUsage'
import { copyToClipboard } from '../services/native'
import { toast } from '../store/toast'

const props = defineProps({
  selectionText: { type: String, default: '' }
})
const emit = defineEmits(['append', 'replace', 'save-as-new'])

const { store, currentChapter, addOutline, updateChapter, captureChapterVersion } = useBooks()
const { settings } = useSettings()
const gen = useGeneration()
const { recordRun } = gen
const memory = useNovelMemory()
const structure = useStoryStructure()

const MODES = ACTIONS

const mode = ref('continue')
const instruction = ref('')
const output = ref('')
// 生成中的真相来源是 store（不是这里的局部 ref）：局域网同步要靠它判断
// 「现在能不能合并」，见 generation.js 里 running 的注释。下面所有
// `generating.value = x` 读写照旧，换掉的只是它的存放位置。
const generating = computed({
  get: () => gen.store.running,
  set: (v) => {
    gen.store.running = !!v
  }
})
const error = ref('')
const outBox = ref(null)
let abortFn = null

/** 走编排器还是旧路径，取决于当前模式（清单见 services/novel/actions.js） */
const useWorkflow = computed(() => WORKFLOW_ACTIONS.includes(mode.value))

// 本次生成的全部调用记录。用 ref 而不是 computed：它描述的是「刚刚那一次」，
// 生成结束后要留在界面上给用户看，不能被下一次输入变化清掉。
// 编排器一次跑两个阶段，所以这里是数组而不是单条 —— 只显示合计会让
// 「提取记忆也花钱」这件事看不见。
const sessionRuns = ref([])
const memoryNote = ref('')
const stageLabel = ref('')
const showUsageDetail = ref(false)
// 编排器提取出的本章梗概与故事内时间。**不能**在生成结束时立刻写库 ——
// 那一刻正文还没被用户插入到任何章节里，只有后续的插入动作知道它落到哪儿。
const lastMeta = ref(null)
// 最近一次编排器运行的 id。用来把「AI 覆盖前」那一版正文与生成历史里的那次调用
// 对上号 —— 用户事后能看出「这一版是被哪一次生成、花了多少钱覆盖掉的」。
const lastRunId = ref(null)

const usageLine = computed(() => {
  const runs = sessionRuns.value
  if (!runs.length) return ''
  const agg = aggregateRuns(runs)
  const money =
    agg.unpriced > 0
      ? '部分模型未配置价格'
      : formatCost({ total: agg.cost, currency: agg.currency })
  const head = runs.length > 1 ? `${runs.length} 次调用` : '本次'
  return `${head} ${formatTokens(agg.inputTokens)} 输入 + ${formatTokens(agg.outputTokens)} 输出 · ${money}${
    agg.estimated ? '（估）' : ''
  }`
})

const hasOutline = computed(() => store.outlines.some((o) => o.type === 'outline'))

// 扩写/改写要处理的那段文字。
// 不能只用 textarea 的选中区：手机上「选中并保持一段 range」很不可靠，
// 一旦失焦选区就没了，这两个模式等于不可用。所以默认由选中的文字同步填入，
// 同时允许用户手动粘贴或修改。
const targetText = ref('')

watch(
  () => props.selectionText,
  (v) => {
    // 选区被清空时不要抹掉用户已经手动填好的内容
    if (v) targetText.value = v
  },
  { immediate: true }
)

watch(mode, () => {
  if ((mode.value === 'expand' || mode.value === 'rewrite') && props.selectionText) {
    targetText.value = props.selectionText
  }
})

const placeholderMap = {
  continue: '可选：告诉 AI 接下来的剧情方向，例如"主角发现身世之谜……"',
  expand: '可选：扩写方向，例如"加入环境描写与心理活动"',
  rewrite: '可选：改写风格，例如"更简洁有力"',
  chapter: '可选：本章需要的情节要点',
  outline: '可选：故事主题 / 题材 / 想看什么类型的故事'
}

// 内联判断 hasOutline，使其随大纲的增删实时更新。
// （旧实现把这张表固化在 setup 期，加了大纲后提示仍然是「请先添加大纲」。）
const hints = computed(() => {
  switch (mode.value) {
    case 'expand':
      return '在左侧正文中选中要扩写的文字，或直接粘贴到下方'
    case 'rewrite':
      return '在左侧正文中选中要改写的文字，或直接粘贴到下方'
    case 'chapter':
      return hasOutline.value ? '将依据故事大纲生成一章正文' : '请先添加或生成「故事大纲」'
    default:
      return ''
  }
})

const needTarget = computed(() => mode.value === 'expand' || mode.value === 'rewrite')

const canGenerate = computed(() => {
  if (!settings.apiKey) return false
  if (needTarget.value && !targetText.value.trim()) return false
  if (mode.value === 'chapter' && !hasOutline.value) return false
  return true
})

const placeholders = computed(() => placeholderMap[mode.value] || '')

function switchMode(m) {
  if (generating.value) return
  mode.value = m
  error.value = ''
}

/** 把一条计费记录追加到本次会话。编排器一次跑两个阶段，所以是个数组。 */
function pushRun(record) {
  if (record) sessionRuns.value = [...sessionRuns.value, record]
}

async function generate() {
  if (generating.value) return
  if (!settings.apiKey) {
    error.value = '请先点击右上角「设置」，填写 API Key'
    return
  }

  error.value = ''
  output.value = ''
  sessionRuns.value = []
  memoryNote.value = ''
  stageLabel.value = ''
  showUsageDetail.value = false
  lastMeta.value = null
  generating.value = true

  try {
    if (useWorkflow.value) await generateViaWorkflow()
    else await generateViaLegacy()
  } catch (e) {
    // 走到这里说明是流程本身出错，而不是模型返回了错误。必须兜住：
    // 漏出去会让 generating 永远停在 true，按钮再也点不动。
    error.value = String((e && e.message) || e)
    console.error('[ai] 生成流程异常', e)
  } finally {
    generating.value = false
    abortFn = null
    stageLabel.value = ''
  }
}

/**
 * 旧路径：扩写 / 改写 / 生成大纲。
 *
 * 这三个模式不进编排器是刻意的 —— 规格书明确要求扩写与改写不得改动人物设定、
 * 世界规则、时间线与伏笔，它们本就不该触发记忆提取；而且一次改五个入口会让
 * 回归面失控。编排器只接「续写」与「生成章节」。
 */
function generateViaLegacy() {
  const messages = buildMessages(mode.value, {
    book: store.book,
    chapter: currentChapter.value,
    chapters: store.chapters,
    outlines: store.outlines,
    settings,
    selection: targetText.value,
    instruction: instruction.value
  })

  // 三点都记下来供结算用：起点时间、提示词原文（端点不回 usage 时按它估算）、
  // 以及端点返回的真实用量。
  const startedAt = Date.now()
  const promptText = messages.map((m) => m.content).join('\n')
  let usage = null

  return new Promise((resolve) => {
    /** 结算并落库。三种收尾（完成/中止/出错）都要走 —— 中止和失败也是花了钱的。 */
    async function settle(status) {
      try {
        pushRun(
          await recordRun({
            chapterId: currentChapter.value?.id,
            action: mode.value,
            stage: 'write',
            provider: providerFromUrl(settings.baseUrl),
            model: settings.model,
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            inputText: promptText,
            outputText: output.value,
            durationMs: Date.now() - startedAt,
            status
          })
        )
      } catch (e) {
        // 记账失败绝不能把一次成功的生成显示成失败：正文已经在界面上了。
        console.error('[usage] 生成记录落库失败', e)
      }
      resolve()
    }

    const { abort } = chatStream({
      settings,
      messages,
      callbacks: {
        onDelta: (t) => {
          output.value += t
          scrollOut()
        },
        onUsage: (u) => {
          usage = u
        },
        onDone: async () => {
          await settle('done')
          toast('生成完成', 'success')
        },
        onError: async (msg) => {
          await settle('error')
          error.value = msg
        },
        onAborted: async () => {
          await settle('aborted')
          toast('已停止生成', 'info')
        }
      }
    })
    abortFn = abort
  })
}

/**
 * 编排器路径：写正文 → 提取记忆 → 按风险入库。
 *
 * 与旧路径的区别不只是多了提取：写正文的提示词由 Context Builder 按预算分层
 * 组装（人物状态、世界规则、伏笔、近期摘要都在里面），而不是「最近三章 +
 * 几段扁平设定」。
 */
async function generateViaWorkflow() {
  const bookId = store.bookId
  if (!bookId) {
    error.value = '请先打开一本书'
    return
  }

  // 记忆与剧情结构可能还没载入 —— 用户这一轮可能压根没开过控制台。
  // 不载的话 Context Builder 只剩「最近几章」可用，那正是 V2 要治的病。
  await Promise.all([
    memory.store.loaded ? null : memory.loadForBook(bookId),
    structure.store.loaded ? null : structure.loadForBook(bookId)
  ])

  const wf = await runChapterWorkflow({
    input: {
      book: store.book,
      bookId,
      chapter: currentChapter.value,
      chapters: store.chapters,
      outlines: store.outlines,
      memory: memory.store,
      structure: structure.store,
      settings,
      action: mode.value,
      instruction: instruction.value,
      selection: targetText.value
    },
    settings,
    // 「写 + 提取」是默认档。关掉自动提取后这条链只剩写正文一次调用，
    // 用户仍可随时在控制台里手动触发提取。
    stages: settings.autoExtractMemory === false ? ['write'] : DEFAULT_STAGES,
    recordRun,
    callbacks: {
      onDelta: (t) => {
        output.value += t
        scrollOut()
      },
      onStage: ({ stage, status, record }) => {
        if (status === 'start') stageLabel.value = STAGE_LABELS[stage] || stage
        else {
          pushRun(record)
          stageLabel.value = ''
        }
      },
      // 中止句柄是**同步**回调出来的。等 runChapterWorkflow 返回再拿，
      // 生成早就结束了，「停止」按钮等于摆设。
      onControl: (h) => {
        abortFn = h.abort
      }
    }
  })

  lastMeta.value = wf.chapterMeta || null
  lastRunId.value = wf.run.id || null
  const writeStage = wf.run.stages.find((s) => s.id === 'write')
  if (writeStage && writeStage.status === 'error') {
    error.value = writeStage.error || '生成失败'
  } else if (wf.run.status === 'aborted') {
    toast('已停止生成', 'info')
  } else if (wf.error) {
    // 提取失败**不算**这一章失败：正文已经拿到手了。把它显示成红色报错会让
    // 用户以为这一章白写了。
    toast(`记忆提取未完成：${wf.error}`, 'error')
  } else {
    toast('生成完成', 'success')
  }

  const { applied, queued } = wf
  if (applied.length || queued.length) {
    memoryNote.value =
      `已更新 ${applied.length} 条记忆` +
      (queued.length ? `；${queued.length} 条高风险变更待确认（控制台 →「记忆审阅」）` : '')
    // 落库之后必须刷新内存态：控制台的审阅队列条数要立刻反映出来。
    await memory.loadForBook(bookId)
  }
}

/**
 * 把提取出的梗概与故事内时间写到**正文最终落到的那一章**上。
 *
 * 提取发生在正文还只存在于这个面板里的时候，所以要到「插入正文」这一刻才知道
 * 它落到哪一章。存为新章节走另一条路 —— 新章节的 id 由建章动作产生，
 * 见 WritingView 的 handleSaveAsNew。
 */
async function applyChapterMeta(chapterId) {
  const meta = lastMeta.value
  if (!meta || !chapterId) return
  const patch = {}
  if (meta.summary) patch.summary = meta.summary
  if (meta.timelineEnd) patch.timelineEnd = meta.timelineEnd
  if (!Object.keys(patch).length) return
  try {
    await updateChapter(chapterId, patch)
  } catch (e) {
    // 梗概落库失败不该让「已插入到正文」这个提示消失：正文是真的插进去了。
    console.error('[ai] 章节梗概落库失败', e)
  }
}

function stop() {
  abortFn?.()
}

function scrollOut() {
  nextTick(() => {
    if (outBox.value) outBox.value.scrollTop = outBox.value.scrollHeight
  })
}

async function copyText(t) {
  try {
    await copyToClipboard(t)
    toast('已复制', 'success')
  } catch {
    toast('复制失败', 'error')
  }
}

async function insertToChapter() {
  if (!output.value) return
  // 先记下目标章节：insertToChapter 之后用户可能马上切章，那时 currentChapter
  // 已经不是接收这段文字的那一章了。
  const chapterId = currentChapter.value?.id
  // 存版本必须在下发 emit **之前**：emit 会同步走到编辑器的 setChapterContent，
  // 那一刻 store 里的正文就已经是新内容了，之后再存等于存了覆盖后的正文。
  await captureChapterVersion(chapterId, { source: 'ai', generationRunId: lastRunId.value })
  emit('append', output.value)
  await applyChapterMeta(chapterId)
  toast('已插入到正文', 'success')
}

async function replaceSelection() {
  if (!output.value) return
  const chapterId = currentChapter.value?.id
  // 改写会把选中那段整段换掉，原样同样不可恢复，所以和插入一样先存一版。
  await captureChapterVersion(chapterId, { source: 'ai', generationRunId: lastRunId.value })
  emit('replace', output.value)
  toast('已替换选中文字', 'success')
}

/** 建章与写入正文由 WritingView 统一编排（需要先冲刷上一章的挂起改动） */
function saveAsNewChapter() {
  if (!output.value) return
  // 梗概随建章一起写入：新章节的 id 由建章动作产生，这里给不出，
  // 所以只能把 meta 一并交给 WritingView。
  emit('save-as-new', output.value, lastMeta.value)
  lastMeta.value = null
  toast('已生成新章节', 'success')
}

async function saveOutline() {
  if (!output.value) return
  await addOutline({ type: 'outline', title: '全书大纲', content: output.value })
  toast('大纲已存入设定', 'success')
}

function clearOutput() {
  output.value = ''
  instruction.value = ''
  error.value = ''
}
</script>

<template>
  <aside class="ai-panel">
    <div class="ai-head">
      <span>AI 写作</span>
      <button class="btn ghost sm" title="清空" @click="clearOutput">清空</button>
    </div>

    <div class="modes">
      <button
        v-for="m in MODES"
        :key="m.key"
        class="mode"
        :class="{ active: mode === m.key, disabled: generating }"
        @click="switchMode(m.key)"
      >
        {{ m.label }}
      </button>
    </div>

    <div class="ai-body">
      <div v-if="hints" class="hint" :class="{ warn: mode === 'chapter' && !hasOutline }">
        <template v-if="needTarget && props.selectionText">
          已选中 {{ props.selectionText.length }} 字
        </template>
        <template v-else>{{ hints }}</template>
      </div>

      <template v-if="needTarget">
        <label class="label">待处理文字</label>
        <textarea
          v-model="targetText"
          class="textarea target-ta"
          rows="4"
          placeholder="在左侧正文中选中文字会自动填入；也可以直接在这里粘贴或修改"
        ></textarea>
      </template>

      <textarea
        v-model="instruction"
        class="textarea instr"
        :placeholder="placeholders"
        rows="2"
      ></textarea>

      <button
        class="btn lg block gen-btn"
        :class="{ primary: !generating }"
        :disabled="generating || !canGenerate"
        @click="generating ? stop() : generate()"
      >
        {{ generating ? '⏹ 停止生成' : '✦ 开始写作' }}
      </button>

      <div v-if="error" class="error">
        {{ error }}
      </div>

      <div ref="outBox" class="out-box" :class="{ empty: !output && !generating }">
        <div v-if="!output && !generating" class="out-placeholder">
          生成结果将显示在这里
        </div>
        <div v-else class="out-text">
          <span>{{ output }}</span>
          <span v-if="generating" class="cursor">▌</span>
        </div>
      </div>

      <!-- 提取记忆是第二次调用。写正文已经出字了，若不说明，用户会以为它卡住了 -->
      <div v-if="stageLabel" class="stage-line">正在{{ stageLabel }}…</div>

      <div v-if="memoryNote" class="memory-note">{{ memoryNote }}</div>

      <div v-if="output" class="result-ops">
        <button class="btn sm primary" @click="insertToChapter">＋ 插入正文</button>
        <button v-if="needTarget" class="btn sm" @click="replaceSelection">替换选中</button>
        <button v-if="mode === 'chapter'" class="btn sm" @click="saveAsNewChapter">
          存为新章节
        </button>
        <button v-if="mode === 'outline'" class="btn sm" @click="saveOutline">存入设定</button>
        <button class="btn sm" @click="copyText(output)">复制</button>
      </div>

      <div v-if="usageLine && settings.showUsage !== false" class="usage-box">
        <button class="usage-line" @click="showUsageDetail = !showUsageDetail">
          <span>{{ usageLine }}</span>
          <span class="usage-caret">{{ showUsageDetail ? '▾' : '▸' }}</span>
        </button>
        <div v-if="showUsageDetail" class="usage-detail">
          <div v-for="r in sessionRuns" :key="r.id" class="usage-row">
            <span class="usage-stage">{{ STAGE_LABELS[r.stage] || r.stage || '调用' }}</span>
            <span class="usage-fig">{{ describeRun(r) }}</span>
            <span class="usage-src">
              {{ r.model || '—' }}{{ r.provider ? ` · ${r.provider}` : '' }} ·
              {{ (r.durationMs / 1000).toFixed(1) }}s ·
              {{ r.usageSource === 'provider' ? '接口返回' : '本地估算' }} ·
              {{ r.status === 'done' ? '已完成' : r.status === 'aborted' ? '已中止' : '失败' }}
            </span>
          </div>
          <div class="usage-note">计费依据：请以服务商官方定价页为准，可在「设置」里修改价目表</div>
        </div>
      </div>

      <p class="api-state" :class="{ ok: settings.apiKey }">
        {{ settings.apiKey ? `已连接 · ${settings.model || ''}` : '未配置 API，点击右上角「设置」' }}
      </p>
    </div>
  </aside>
</template>

<style scoped>
.ai-panel {
  width: 320px;
  flex-shrink: 0;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-weight: 600;
  font-size: 14px;
  border-bottom: 1px solid var(--border);
}
.modes {
  display: flex;
  gap: 6px;
  padding: 12px 14px 6px;
  flex-wrap: wrap;
}
.mode {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  transition: all 0.15s ease;
}
.mode:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.mode.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.mode.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-body {
  flex: 1;
  overflow: auto;
  padding: 10px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
}
.hint.warn {
  color: var(--danger);
}
.instr {
  font-size: 13px;
}
.target-ta {
  font-size: 13px;
}
.label {
  margin-bottom: -4px;
}
.gen-btn {
  border-radius: 10px;
  font-weight: 600;
}
.error {
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  word-break: break-all;
}
.out-box {
  flex: 1;
  min-height: 160px;
  max-height: 42vh;
  /* dvh 让软键盘弹出时高度跟着可视区变，vh 会保持旧值把内容顶出屏幕 */
  max-height: 42dvh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
  padding: 14px;
}
.out-box.empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.out-placeholder {
  color: var(--text-3);
  font-size: 13px;
}
.out-text {
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}
.cursor {
  color: var(--accent);
  animation: blink 0.9s infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.result-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.usage-box {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  overflow: hidden;
}
.usage-line {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-2);
  text-align: left;
}
.usage-line:hover {
  color: var(--text);
}
.usage-caret {
  flex-shrink: 0;
  color: var(--text-3);
}
.usage-detail {
  padding: 6px 10px 8px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
  border-top: 1px solid var(--border);
}
.usage-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 0;
}
.usage-row + .usage-row {
  border-top: 1px dashed var(--border);
}
.usage-stage {
  color: var(--text-2);
  font-weight: 600;
}
.usage-src {
  color: var(--text-3);
}
.usage-note {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}
.stage-line {
  font-size: 12px;
  color: var(--accent);
}
.memory-note {
  font-size: 12px;
  color: var(--text-2);
  background: var(--accent-soft);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  line-height: 1.6;
}
.api-state {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.api-state.ok {
  color: var(--success);
}
</style>
