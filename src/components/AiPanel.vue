<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { chatStream } from '../services/llm'
import { buildMessages } from '../services/prompts'
import { copyToClipboard } from '../services/native'
import { toast } from '../store/toast'

const props = defineProps({
  selectionText: { type: String, default: '' }
})
const emit = defineEmits(['append', 'replace', 'save-as-new'])

const { store, currentChapter, addOutline } = useBooks()
const { settings } = useSettings()

const MODES = [
  { key: 'continue', label: '续写' },
  { key: 'expand', label: '扩写' },
  { key: 'rewrite', label: '改写' },
  { key: 'chapter', label: '生成章节' },
  { key: 'outline', label: '生成大纲' }
]

const mode = ref('continue')
const instruction = ref('')
const output = ref('')
const generating = ref(false)
const error = ref('')
const outBox = ref(null)
let abortFn = null

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

async function generate() {
  if (generating.value) return
  if (!settings.apiKey) {
    error.value = '请先点击右上角「设置」，填写 API Key'
    return
  }
  error.value = ''
  output.value = ''
  generating.value = true

  const messages = buildMessages(mode.value, {
    book: store.book,
    chapter: currentChapter.value,
    chapters: store.chapters,
    outlines: store.outlines,
    settings,
    selection: targetText.value,
    instruction: instruction.value
  })

  const { abort } = chatStream({
    settings,
    messages,
    callbacks: {
      onDelta: (t) => {
        output.value += t
        scrollOut()
      },
      onDone: () => {
        generating.value = false
        abortFn = null
        toast('生成完成', 'success')
      },
      onError: (msg) => {
        generating.value = false
        abortFn = null
        error.value = msg
      },
      onAborted: () => {
        generating.value = false
        abortFn = null
        toast('已停止生成', 'info')
      }
    }
  })
  abortFn = abort
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

function insertToChapter() {
  if (!output.value) return
  emit('append', output.value)
  toast('已插入到正文', 'success')
}

function replaceSelection() {
  if (!output.value) return
  emit('replace', output.value)
  toast('已替换选中文字', 'success')
}

/** 建章与写入正文由 WritingView 统一编排（需要先冲刷上一章的挂起改动） */
function saveAsNewChapter() {
  if (!output.value) return
  emit('save-as-new', output.value)
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

      <div v-if="output" class="result-ops">
        <button class="btn sm primary" @click="insertToChapter">＋ 插入正文</button>
        <button v-if="needTarget" class="btn sm" @click="replaceSelection">替换选中</button>
        <button v-if="mode === 'chapter'" class="btn sm" @click="saveAsNewChapter">
          存为新章节
        </button>
        <button v-if="mode === 'outline'" class="btn sm" @click="saveOutline">存入设定</button>
        <button class="btn sm" @click="copyText(output)">复制</button>
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
.api-state {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.api-state.ok {
  color: var(--success);
}
</style>
