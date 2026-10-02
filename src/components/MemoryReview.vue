<script setup>
import { computed } from 'vue'
import { useCollections } from '../store/novel'
import { useBooks } from '../store/books'
import { ENTITY_SCHEMAS, extractionFields } from '../services/novel/schemas'
import { applyChange } from '../services/ai/orchestrator'
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

async function approve(item) {
  const bookId = store.bookId
  if (!bookId) return
  // 应用时重新读一遍当前记录再合并（applyChange 里做的），而不是把入库时那份
  // 快照整体覆盖 —— 从提取到用户点「通过」之间可能隔了很久，用户也许已经改过。
  const applied = await applyChange(bookId, {
    entity: item.entity,
    id: item.entityId,
    op: item.op,
    title: item.title,
    data: item.data
  })
  if (!applied) {
    toast('原记录已不存在，请改为手动新增', 'error')
    return
  }
  await cols.remove('reviewQueue', item.id)
  toast('已采纳', 'success')
}

async function reject(item) {
  await cols.remove('reviewQueue', item.id)
  toast('已忽略', 'success')
}

async function clearAll() {
  for (const item of pending.value) await cols.remove('reviewQueue', item.id)
  toast('已清空待确认项', 'success')
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
      <button v-if="pending.length" class="btn ghost sm" @click="clearAll">全部忽略</button>
    </div>

    <p class="rv-hint">
      AI 写完一章后会提取设定变化。低风险项已自动入库；下面这些会改变后续每一章的生成前提，
      改动很小但影响很大，所以请你过一眼。
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
        <div v-if="item.reason" class="rv-reason">{{ item.reason }}</div>
        <div class="rv-ops">
          <button class="btn sm primary" @click="approve(item)">采纳</button>
          <button class="btn ghost sm" @click="reject(item)">忽略</button>
        </div>
      </li>
    </ul>
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
.rv-ops {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}
</style>
