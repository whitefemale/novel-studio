<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useCollections } from '../store/novel'
import { useBooks } from '../store/books'
import { ENTITY_SCHEMAS, extractionFields } from '../services/novel/schemas'
import { applyChange, undoMemoryChange } from '../services/ai/orchestrator'
import { coll } from '../services/storage'
import { toast } from '../store/toast'

/**
 * 记忆审阅队列：AI 提出、但还没被批准的变更。
 *
 * 为什么要有这一层：模型在正文里写死一个角色，不该等于数据库里那个角色自动死了。
 * 高风险变更（死亡、失踪、境界变化、势力覆灭、世界规则改动）改错了用户**看不出来**
 * —— 它们会静默改变后续每一章的生成前提，所以必须由人过一眼。
 *
 * 通过 / 拒绝都**只删队列项**，不「回滚」任何东西：变更本来就没落库，
 * 队列项只是待办。这也是「只有 commitMemory 会写库」那条不变量的延伸。
 */
const { store } = useBooks()
const cols = useCollections()

const pending = computed(() => cols.list('reviewQueue').filter((r) => r.status === 'pending'))

const labelOf = (entity, field) => {
  const f = extractionFields(ENTITY_SCHEMAS[entity] || {}).find((x) => x.key === field)
  return f ? f.label : field || ''
}

/** 值的可读化：select 存的是 value，界面上要看 label */
function labelValue(entity, field, v) {
  if (v == null || v === '') return '（空）'
  const f = extractionFields(ENTITY_SCHEMAS[entity] || {}).find((x) => x.key === field)
  const opt = (f?.options || []).find((o) => o.value === v)
  if (opt) return opt.label
  if (f?.type === 'ref' && f.ref === 'chapters') {
    const c = store.chapters.find((x) => x.id === v)
    if (c) return c.title
  }
  return String(v)
}

function describe(item) {
  if (item.op === 'create') {
    const schema = ENTITY_SCHEMAS[item.entity] || {}
    return `新增${schema.label || item.entity}：${item.title}`
  }
  return `${labelOf(item.entity, item.field)}：${labelValue(item.entity, item.field, item.from)} → ${labelValue(
    item.entity,
    item.field,
    item.to
  )}`
}

const chapterTitle = (id) => store.chapters.find((c) => c.id === id)?.title || ''

async function approve(item, { silent = false } = {}) {
  const bookId = store.bookId
  if (!bookId) return
  // 应用时重新读一遍当前记录再合并（applyChange 里做的），而不是把入库时那份
  // 快照整体覆盖 —— 从提取到用户点「通过」之间可能隔了很久，用户也许已经改过。
  const applied = await applyChange(
    bookId,
    {
      entity: item.entity,
      id: item.entityId,
      op: item.op,
      title: item.title,
      field: item.field,
      from: item.from,
      to: item.to,
      data: item.data,
      risk: item.risk,
      chapterId: item.chapterId,
      evidence: item.evidence
    },
    { source: 'review' }
  )
  if (!applied) {
    toast('原记录已不存在，请改为手动新增', 'error')
    return false
  }
  await cols.remove('reviewQueue', item.id)
  await loadLogs()
  if (!silent) toast('已采纳', 'success')
  return true
}

/** 批量采纳：autoApplyLowRisk 关闭时，低风险项可能一次积很多条。 */
async function approveAll() {
  let n = 0
  for (const item of [...pending.value]) {
    if (await approve(item, { silent: true })) n++
  }
  if (n) toast(`已采纳 ${n} 条变更`, 'success')
}

async function reject(item) {
  await cols.remove('reviewQueue', item.id)
  toast('已忽略', 'success')
}

async function clearAll() {
  for (const item of pending.value) await cols.remove('reviewQueue', item.id)
  toast('已清空待确认项', 'success')
}

// ---------------- 最近变更与撤销 ----------------

const logs = ref([])
const undoing = ref('')

async function loadLogs() {
  if (!store.bookId) {
    logs.value = []
    return
  }
  const all = await coll.memoryChangeLog.getAll(store.bookId)
  logs.value = [...all].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20)
}

onMounted(loadLogs)
watch(() => store.bookId, loadLogs)
// 审阅队列变化（例如 AI 刚跑完一章自动入库了几条）也刷新日志，
// 否则用户会以为「刚才自动改的那条没有记录」。
watch(() => cols.list('reviewQueue').length, loadLogs)

function logText(log) {
  if (log.op === 'create') return `新增${entityLabel(log.entity)}：${log.title}`
  if (log.op === 'delete') return `删除${entityLabel(log.entity)}：${log.title}`
  if (log.op === 'undo') return `撤销：${log.title}`
  const before = log.before?.[log.field]
  const after = log.after?.[log.field]
  return `${log.title} · ${labelOf(log.entity, log.field)}：${labelValue(log.entity, log.field, before)} → ${labelValue(log.entity, log.field, after)}`
}

async function undo(log) {
  if (!store.bookId || undoing.value) return
  undoing.value = log.id
  try {
    const res = await undoMemoryChange(store.bookId, log.id)
    toast(res.message, res.ok ? 'success' : 'error')
    await loadLogs()
  } finally {
    undoing.value = ''
  }
}

function entityLabel(entity) {
  return ENTITY_SCHEMAS[entity]?.label || entity
}

/** 队列项显示的实体名。新建项的名字在 data 里，更新项的标题字段在 title 上。 */
function itemName(item) {
  if (item.op === 'create') return item.data?.name || item.data?.title || item.title
  return item.title
}
</script>

<template>
  <div class="review">
    <div class="rv-head">
      <h4>记忆审阅<span class="rv-count">{{ pending.length }} 条待确认</span></h4>
      <div class="rv-head-ops">
        <button v-if="pending.length" class="btn ghost sm" @click="approveAll">全部采纳</button>
        <button v-if="pending.length" class="btn ghost sm" @click="clearAll">全部忽略</button>
      </div>
    </div>

    <p class="rv-hint">
      AI 写完一章后会提取设定变化。低风险项通常会直接入库；下面这些会改变后续每一章的生成前提，
      改动很小但影响很大，所以请你过一眼。关掉「低风险自动入库」后，低风险项也会排到这里。
    </p>

    <div v-if="!pending.length" class="rv-empty">没有待确认的变更。</div>

    <ul v-else class="rv-list">
      <li v-for="item in pending" :key="item.id" class="rv-item">
        <div class="rv-top">
          <span class="rv-tag">{{ entityLabel(item.entity) }}</span>
          <span class="rv-title">{{ itemName(item) }}</span>
          <span v-if="item.chapterId" class="rv-src">来自「{{ chapterTitle(item.chapterId) }}」</span>
        </div>
        <div class="rv-diff">{{ describe(item) }}</div>
        <div v-if="item.evidence" class="rv-evidence">原文依据：{{ item.evidence }}</div>
        <div v-if="item.reason" class="rv-reason">
          <span v-if="item.coreImmutable" class="rv-lock">核心不可变</span>
          {{ item.reason }}
        </div>
        <div class="rv-ops">
          <button class="btn sm primary" @click="approve(item)">采纳</button>
          <button class="btn ghost sm" @click="reject(item)">忽略</button>
        </div>
      </li>
    </ul>

    <div class="rv-log">
      <div class="rv-log-head">
        <h4>最近变更</h4>
        <span class="rv-count">可撤销最近 20 条</span>
      </div>
      <p class="rv-hint">
        自动入库的变更也在这里。撤销只会在「当前值仍是那次写入的值」时生效——
        之后你又改过的话，撤销会拒绝执行，以免覆盖你的后续编辑。
      </p>
      <div v-if="!logs.length" class="rv-empty">还没有变更记录。</div>
      <ul v-else class="rv-list">
        <li v-for="log in logs" :key="log.id" class="rv-item">
          <div class="rv-top">
            <span class="rv-tag">{{ entityLabel(log.entity) }}</span>
            <span class="rv-title">{{ logText(log) }}</span>
            <span v-if="log.undone" class="rv-undone">已撤销</span>
            <span v-else-if="log.source === 'undo'" class="rv-undone">撤销记录</span>
          </div>
          <div v-if="log.evidence" class="rv-evidence">原文依据：{{ log.evidence }}</div>
          <div
            v-if="!log.undone && log.source !== 'undo'"
            class="rv-ops"
          >
            <button
              class="btn ghost sm"
              :disabled="undoing === log.id"
              @click="undo(log)"
            >
              {{ undoing === log.id ? '撤销中…' : '撤销' }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rv-head h4 {
  margin: 0;
  font-size: 15px;
}
.rv-count {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}
.rv-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.rv-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 16px 0;
}
.rv-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rv-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--bg-muted);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rv-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rv-tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.rv-title {
  font-size: 14px;
  font-weight: 600;
}
.rv-src {
  font-size: 11px;
  color: var(--text-3);
}
.rv-diff {
  font-size: 13px;
  color: var(--text);
}
.rv-reason {
  font-size: 12px;
  color: var(--danger);
}
.rv-evidence {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
  background: var(--bg);
  border-left: 2px solid var(--border);
  padding: 4px 8px;
  word-break: break-word;
}
.rv-lock {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--danger-soft);
  color: var(--danger);
  margin-right: 4px;
}
.rv-head-ops {
  display: flex;
  gap: 6px;
}
.rv-log {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rv-log-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.rv-log-head h4 {
  margin: 0;
  font-size: 14px;
}
.rv-undone {
  font-size: 11px;
  color: var(--text-3);
  text-decoration: line-through;
}
.rv-ops {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
</style>
