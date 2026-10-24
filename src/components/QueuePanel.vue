<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { useWritingQueue } from '../store/writingQueue'
import { toast } from '../store/toast'
import { isNarrowLayout } from '../services/platform'
import {
  QUEUE_ACTIVE_STATUSES,
  QUEUE_STATUS_LABELS,
  hasUsableResult,
  queueItemTitle
} from '../services/ai/queue'

/**
 * 写作队列面板。
 *
 * 它不是「一次性生成很多章」的批处理工具，而是**排好队、逐章出草稿**的工作台：
 *
 * - 队列只跑写正文，结果停在面板里；正文一个字都不会自己动。
 * - 用户点「插入本章」才写回，且先存版本，所以插错了能回滚。
 * - 失败就停：同一个错误（Key 失效、余额不足）继续跑只会重复扣费。
 *
 * 界面刻意把「这不改正文」与「每章都真实计费」两条写在最上面 —— 它们是最容易被
 * 误解的两件事，而误解的代价分别是丢稿与花钱。
 */
const emit = defineEmits(['close'])

const { store } = useBooks()
const { settings } = useSettings()
const queue = useWritingQueue()
const q = queue.store

const busy = ref(false)
const picked = ref([])
const previewId = ref('')
const adding = ref(false)

const chapters = computed(() => store.chapters || [])
const items = computed(() => q.items || [])
const summary = computed(() => queue.summary())
const activeItems = computed(() =>
  items.value.filter((x) => QUEUE_ACTIVE_STATUSES.includes(x.status))
)
const previewItem = computed(() => items.value.find((x) => x.id === previewId.value) || null)
const canStart = computed(
  () => !q.running && summary.value.queued > 0 && !queueBlockedReason.value
)

const queueBlockedReason = computed(() => {
  if (!String(settings.apiKey || '').trim()) return '请先在设置里填写 API Key'
  if (!String(settings.baseUrl || '').trim()) return '请先在设置里填写接口地址'
  return ''
})

/** 已经排队的章节不可再选（同一章重复入队等于同一笔钱花两次）。 */
const queuedChapterIds = computed(
  () => new Set(activeItems.value.map((x) => x.chapterId))
)

function isPicked(id) {
  return picked.value.includes(id)
}

function togglePick(id) {
  if (queuedChapterIds.value.has(id)) return
  picked.value = isPicked(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

function pickAll() {
  const ids = chapters.value
    .filter((c) => !queuedChapterIds.value.has(c.id))
    .map((c) => c.id)
  picked.value = ids
}

function clearPicked() {
  picked.value = []
}

async function addPicked() {
  if (adding.value || !picked.value.length) return
  adding.value = true
  try {
    const list = chapters.value.filter((c) => picked.value.includes(c.id))
    const res = await queue.enqueueMany(list)
    if (!res.ok) {
      toast(res.error || '入队失败', 'error')
      return
    }
    picked.value = []
    toast(`已加入 ${res.added} 章`, 'success')
  } finally {
    adding.value = false
  }
}

async function addCurrent() {
  if (!store.chapterId) return
  const res = await queue.enqueue({ chapterId: store.chapterId })
  if (!res.ok) {
    toast(res.error || '入队失败', 'error')
    return
  }
  toast('已加入队列', 'success')
}

async function startQueue() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await queue.start()
    if (!res.ok) {
      toast(res.error || '无法开始队列', 'error')
      return
    }
    if (!res.already) toast('队列已开始，可以关掉面板继续写', 'success')
  } finally {
    busy.value = false
  }
}

async function pauseQueue() {
  await queue.pause()
  toast('队列已暂停：当前这一章会跑完，之后不再开始新的一章', 'info')
}

async function cancelItem(item) {
  const res = await queue.cancel(item.id)
  if (!res.ok) toast(res.error || '取消失败', 'error')
  else if (item.status === 'running') toast('已请求停止，正在等请求结束…', 'info')
}

async function retryItem(item) {
  const res = await queue.retry(item.id)
  if (!res.ok) toast(res.error || '重试失败', 'error')
  else toast('已重新排队', 'success')
}

async function removeItem(item) {
  const res = await queue.removeItem(item.id)
  if (!res.ok) toast(res.error || '删除失败', 'error')
}

async function clearFinished() {
  const res = await queue.clearFinished()
  if (!res.ok) toast(res.error || '清理失败', 'error')
  else toast('已清理完成与已取消的条目', 'success')
}

async function apply(item, mode) {
  if (busy.value) return
  busy.value = true
  try {
    const res = await queue.applyResult(item.id, { mode })
    if (!res.ok) {
      toast(res.error || '处理失败', 'error')
      return
    }
    if (mode === 'discard') toast('已丢弃这条草稿', 'info')
    else toast(mode === 'new' ? '已存为新章节' : '已追加到章节末尾（可回滚）', 'success')
    if (previewId.value === item.id) previewId.value = ''
  } finally {
    busy.value = false
  }
}

function fmtChars(n) {
  const v = Number(n) || 0
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万字` : `${v} 字`
}

function statusText(item) {
  return QUEUE_STATUS_LABELS[item.status] || item.status
}

onMounted(async () => {
  await queue.loadForBook(store.bookId)
})

watch(
  () => store.bookId,
  async (id) => {
    previewId.value = ''
    picked.value = []
    await queue.loadForBook(id)
  }
)

watch(
  () => q.items.map((x) => x.id + ':' + x.status).join(','),
  () => {
    // 预留在队列里被删掉/被重试后，底部的预览不能还挂着一个不存在的条目。
    if (previewId.value && !items.value.some((x) => x.id === previewId.value)) {
      previewId.value = ''
    }
  }
)
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal wide queue-modal" :class="{ narrow: isNarrowLayout() }">
      <div class="modal-header">
        <h3>写作队列</h3>
        <button class="btn ghost sm" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <p class="q-lead">
          队列<b>只生成草稿，不会自动改正文</b>。每章都会真实调用一次接口（计费），
          结果停在这里，由你决定插入、另存还是丢弃。
        </p>

        <div class="q-top">
          <div class="q-stats">
            <span class="q-chip">共 {{ summary.total }} 条</span>
            <span class="q-chip" :class="{ on: summary.queued }">待生成 {{ summary.queued }}</span>
            <span class="q-chip" :class="{ on: summary.done }">已完成 {{ summary.done }}</span>
            <span class="q-chip" :class="{ on: summary.failed }">失败 {{ summary.failed }}</span>
            <span class="q-chip" :class="{ on: summary.interrupted }">中断 {{ summary.interrupted }}</span>
          </div>
          <div class="q-actions">
            <button
              v-if="!q.running"
              class="btn primary sm"
              :disabled="!canStart || busy"
              :title="queueBlockedReason || (summary.queued ? '' : '队列里还没有待生成的章节')"
              @click="startQueue"
            >
              开始队列
            </button>
            <button v-else class="btn sm" @click="pauseQueue">暂停（跑完本章）</button>
          </div>
        </div>

        <p v-if="queueBlockedReason" class="q-warn">{{ queueBlockedReason }}</p>
        <p v-else-if="q.running" class="q-note">
          正在逐章生成…关闭面板不会中断；队列运行期间局域网同步会被拒绝（避免整组覆盖）。
        </p>
        <p v-if="q.paused && !q.running" class="q-note">
          队列已暂停。点「开始队列」继续；失败条目需要先「重试」或「取消」。
        </p>
        <p v-if="q.lastError" class="q-warn">{{ q.lastError }}</p>
        <p v-if="settings.budgetDaily > 0" class="q-note">
          每日预算上限 ¥{{ settings.budgetDaily }}：每完成一章会核对当日花费，超限自动暂停。
        </p>

        <!-- 入队 -->
        <details class="q-add" :open="!items.length">
          <summary>把章节加入队列</summary>
          <div class="q-add-body">
            <div class="q-add-bar">
              <button class="btn ghost sm" @click="pickAll">全选未入队章节</button>
              <button class="btn ghost sm" @click="clearPicked">清空选择</button>
              <button class="btn primary sm" :disabled="!picked.length || adding" @click="addPicked">
                {{ adding ? '加入中…' : `加入队列（${picked.length}）` }}
              </button>
              <button class="btn sm" @click="addCurrent">只加入当前章</button>
            </div>
            <div class="q-chapters">
              <label
                v-for="c in chapters"
                :key="c.id"
                class="q-chapter"
                :class="{ disabled: queuedChapterIds.has(c.id), picked: isPicked(c.id) }"
              >
                <input
                  type="checkbox"
                  :checked="isPicked(c.id) || queuedChapterIds.has(c.id)"
                  :disabled="queuedChapterIds.has(c.id)"
                  @change="togglePick(c.id)"
                />
                <span class="q-chapter-title">{{ c.title || '未命名' }}</span>
                <span class="q-chapter-meta">
                  {{ queuedChapterIds.has(c.id) ? '已在队列' : fmtChars((c.content || '').length) }}
                </span>
              </label>
              <p v-if="!chapters.length" class="q-empty">这本书还没有章节。</p>
            </div>
          </div>
        </details>

        <!-- 队列条目 -->
        <div v-if="items.length" class="q-list">
          <div
            v-for="it in items"
            :key="it.id"
            class="q-item"
            :class="'st-' + it.status"
          >
            <div class="q-item-main">
              <div class="q-item-line">
                <span class="q-status">{{ statusText(it) }}</span>
                <span class="q-title" :title="queueItemTitle(it)">
                  {{ queueItemTitle(it) }}
                </span>
                <span v-if="it.attempts > 1" class="q-try">第 {{ it.attempts }} 次</span>
                <span v-if="it.result && it.result.chars" class="q-meta">
                  {{ fmtChars(it.result.chars) }}
                </span>
                <span v-if="it.result && it.result.appliedMode" class="q-meta">
                  {{ it.result.appliedMode === 'discard' ? '已丢弃' : it.result.appliedMode === 'new' ? '已存为新章' : '已插入' }}
                </span>
              </div>
              <p v-if="it.error" class="q-error">{{ it.error }}</p>
              <p v-if="it.result && it.result.truncated" class="q-warn">
                输出达到上限被截断：已收到的内容仍保留，可以作为半章使用。
              </p>
            </div>

            <div class="q-item-ops">
              <button
                v-if="hasUsableResult(it)"
                class="btn ghost sm"
                @click="previewId = previewId === it.id ? '' : it.id"
              >
                {{ previewId === it.id ? '收起' : '预览' }}
              </button>
              <button
                v-if="it.status === 'queued' || it.status === 'running'"
                class="btn ghost sm"
                @click="cancelItem(it)"
              >
                取消
              </button>
              <button
                v-if="['interrupted', 'failed', 'canceled', 'blocked'].includes(it.status)"
                class="btn ghost sm"
                @click="retryItem(it)"
              >
                重试
              </button>
              <button
                v-if="it.status !== 'running'"
                class="btn ghost sm danger-text"
                @click="removeItem(it)"
              >
                删除
              </button>
            </div>

            <div v-if="hasUsableResult(it)" class="q-apply">
              <button class="btn sm primary" :disabled="busy" @click="apply(it, 'insert')">
                插入本章末尾
              </button>
              <button class="btn sm" :disabled="busy" @click="apply(it, 'new')">另存为新章</button>
              <button class="btn ghost sm" :disabled="busy" @click="apply(it, 'discard')">丢弃</button>
            </div>
          </div>
        </div>
        <p v-else class="q-empty">队列是空的。展开上面的「把章节加入队列」，选几章开始。</p>

        <div v-if="previewItem" class="q-preview">
          <div class="q-preview-head">
            <span>{{ queueItemTitle(previewItem) }} · 草稿预览</span>
            <button class="btn ghost sm" @click="previewId = ''">收起</button>
          </div>
          <pre class="q-preview-text">{{ previewItem.result?.text || '（没有文本）' }}</pre>
        </div>
      </div>

      <div class="modal-footer">
        <button v-if="items.length" class="btn ghost sm" @click="clearFinished">清理已结束</button>
        <button class="btn sm" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-modal.narrow {
  max-width: 100%;
  height: 92dvh;
}
.q-lead {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}
.q-lead b { color: var(--text); }
.q-top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.q-stats { display: flex; flex-wrap: wrap; gap: 6px; }
.q-chip {
  font-size: 12px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-2);
}
.q-chip.on { background: #e8f1ff; color: var(--accent); }
.q-actions { display: flex; gap: 8px; }
.q-warn {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff4e5;
  color: #8a4b00;
  font-size: 12.5px;
  line-height: 1.6;
}
.q-note {
  margin: 8px 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
}
.q-add {
  margin: 14px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.q-add summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.q-add-body { padding-top: 10px; }
.q-add-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.q-chapters {
  max-height: 220px;
  overflow: auto;
  border-top: 1px dashed var(--border);
}
.q-chapter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.q-chapter.picked { background: #f2f7ff; }
.q-chapter.disabled { color: var(--text-3); cursor: default; }
.q-chapter-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-chapter-meta { font-size: 11px; color: var(--text-3); }
.q-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.q-item {
  border: 1px solid var(--border);
  border-left: 3px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.q-item.st-running { border-left-color: var(--accent); background: #f7fbff; }
.q-item.st-done { border-left-color: var(--success); }
.q-item.st-failed { border-left-color: var(--danger); }
.q-item.st-interrupted, .q-item.st-blocked { border-left-color: #d38b00; }
.q-item-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.q-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-2);
}
.st-running .q-status { background: #e8f1ff; color: var(--accent); }
.st-done .q-status { background: #e8f8ee; color: var(--success); }
.st-failed .q-status { background: #fdecec; color: var(--danger); }
.q-title { font-size: 13px; font-weight: 600; flex: 1; min-width: 120px; }
.q-meta, .q-try { font-size: 11px; color: var(--text-3); }
.q-error { margin: 6px 0 0; font-size: 12px; color: var(--danger); line-height: 1.5; }
.q-item-ops { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.q-apply {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.danger-text { color: var(--danger); }
.q-preview {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.q-preview-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  font-size: 12.5px;
  background: var(--bg-muted);
}
.q-preview-text {
  margin: 0;
  padding: 12px;
  max-height: 260px;
  overflow: auto;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}
.q-empty { font-size: 12.5px; color: var(--text-3); margin: 10px 0; }
</style>
