<script setup>
import { ref, computed, watch } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { ENTITY_SCHEMAS, entityTitle, renderEntity } from '../services/novel/schemas'
import { relatedEntities } from '../services/novel/retrieval'
import { usePagedList } from '../composables/usePagedList'
import { toast } from '../store/toast'

/**
 * 一张由 schema 驱动的实体表：列表 / 新建 / 编辑 / 删除。
 *
 * 一份 ENTITY_SCHEMAS 服务八个实体，所以这里没有「人物表单」「势力表单」之分 ——
 * 加一个字段只改 schemas.js，界面自动跟上。代价是这一处必须把七种字段类型
 * 都渲染对，收益是不会有「人物能改别名、势力忘了」这种不一致。
 *
 * 列表里显示的文本与送给 AI 的**完全相同**（同一个 renderEntity），这不是偷懒：
 * 用户在控制台里看到的就该是 AI 看到的那一行，否则「我明明写了它怎么不知道」
 * 会变成一个真正的谜团。
 */
const props = defineProps({
  collection: { type: String, required: true },
  /** 'none' | 'order' | 'timeline' —— 时间线要按章节顺序而不是录入顺序 */
  orderBy: { type: String, default: 'none' }
})

const { store } = useBooks()
const cols = useCollections()

const schema = computed(() => ENTITY_SCHEMAS[props.collection] || { label: props.collection, fields: [] })
const rows = computed(() => cols.list(props.collection))

/** 引用型字段（所在地点、涉及人物…）要显示名字，存的是 id */
function resolveRef(coll, id) {
  if (!id) return ''
  const list = coll === 'chapters' ? store.chapters : cols.list(coll)
  const hit = (list || []).find((x) => x.id === id)
  return hit ? entityTitle(ENTITY_SCHEMAS[coll] || {}, hit) : '（已删除）'
}

/** 列表行：标题之外的部分。renderEntity 已把标题放在行首，这里不重复显示。 */
function rowText(row) {
  const full = renderEntity(schema.value, row, resolveRef)
  const title = entityTitle(schema.value, row)
  return full.startsWith(title) ? full.slice(title.length).replace(/^\s*——\s*/, '') : full
}

const chapterOrder = (id) => {
  const i = store.chapters.findIndex((c) => c.id === id)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

const orderedRows = computed(() => {
  const list = [...rows.value]
  if (props.orderBy === 'order') {
    list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
  } else if (props.orderBy === 'timeline') {
    // 时间线按**章节顺序**排，而不是录入顺序：事件的先后关系是它的全部意义，
    // 而录入顺序取决于用户什么时候想起来记录，与故事时间无关。
    list.sort(
      (a, b) =>
        chapterOrder(a.chapterId) - chapterOrder(b.chapterId) ||
        String(a.time || '').localeCompare(String(b.time || ''), 'zh-Hans-CN')
    )
  }
  return list
})

/*
 * 大列表分页：几千条人物/事件一次性铺成 DOM 会拖慢整个控制台，
 * 而「加载更多」不需要任何新依赖。
 * 切换集合或换书时回到第一页（watchKey），否则会在新书里看到空的「已加载 300 条」。
 */
const {
  visible: visibleRows,
  hasMore: hasMoreRows,
  total: totalRows,
  loadMore
} = usePagedList(() => orderedRows.value, {
  watchKey: () => [props.collection, store.bookId]
})

// ---------------- 关联展开 ----------------

/**
 * 「这条设定影响过什么」：人物 → 参与的事件/伏笔/出现过的章节。
 * 只对记忆层的四种实体开放；卷/篇/场景/文风没有这套反向引用。
 */
const RELATED_KINDS = new Set(['characters', 'locations', 'factions', 'events'])
const relatedId = ref('')

function toggleRelated(row) {
  relatedId.value = relatedId.value === row.id ? '' : row.id
}

const related = computed(() => {
  if (!relatedId.value || !RELATED_KINDS.has(props.collection)) return null
  return relatedEntities({
    type: props.collection,
    id: relatedId.value,
    memory: cols.memory.store,
    chapters: store.chapters
  })
})

const relatedTitle = (kind, item) =>
  kind === 'chapters'
    ? `第${item.order}章 ${item.title || ''}`.trim()
    : entityTitle(ENTITY_SCHEMAS[kind] || {}, item)

// ---------------- 编辑 ----------------

const editingId = ref(null)
const form = ref({})
const confirmId = ref(null)

function blank() {
  const o = {}
  for (const f of schema.value.fields) {
    o[f.key] =
      f.type === 'tags' || f.type === 'refs'
        ? []
        : f.type === 'number'
          ? 0
          : f.type === 'checkbox'
            ? false
            : ''
  }
  return o
}

/** 打开表单。拷一份再进表单，直接引用 store 里的对象会让「取消」也生效。 */
function openCreate() {
  editingId.value = null
  confirmId.value = null
  form.value = blank()
}

function openEdit(row) {
  editingId.value = row.id
  confirmId.value = null
  const o = blank()
  for (const f of schema.value.fields) {
    const v = row[f.key]
    if (v == null) continue
    o[f.key] = Array.isArray(v) ? [...v] : v
  }
  form.value = o
}

function cancelEdit() {
  editingId.value = null
  form.value = {}
}

const editing = computed(() => editingId.value !== null || Object.keys(form.value).length > 0)

function missingRequired() {
  return schema.value.fields.filter((f) => f.required && !String(form.value[f.key] ?? '').trim())
}

async function save() {
  const miss = missingRequired()
  if (miss.length) {
    toast(`请填写：${miss.map((f) => f.label).join('、')}`, 'error')
    return
  }
  // 先记下来：cancelEdit() 会把 editingId 清空，之后再读就永远是「新增」
  const isEdit = editingId.value !== null
  const data = { ...form.value }
  if (editingId.value) data.id = editingId.value
  // 数字字段在 input 里永远是字符串，不转的话列表排序会按字典序排（"10" < "9"）
  for (const f of schema.value.fields) {
    if (f.type !== 'number') continue
    const n = Number(data[f.key])
    data[f.key] = Number.isFinite(n) ? n : 0
  }
  const saved = await cols.upsert(props.collection, data)
  if (!saved) {
    toast('保存失败：没有打开的小说', 'error')
    return
  }
  cancelEdit()
  toast(isEdit ? '已保存' : '已新增', 'success')
}

async function doRemove(row) {
  await cols.remove(props.collection, row.id)
  confirmId.value = null
  toast('已删除', 'success')
}

// ---------------- 引用型字段的候选项 ----------------

function refOptions(field) {
  const list = field.ref === 'chapters' ? store.chapters : cols.list(field.ref)
  const refSchema = ENTITY_SCHEMAS[field.ref] || {}
  return (list || []).map((x) => ({ value: x.id, label: entityTitle(refSchema, x) }))
}

const tagsText = (v) => (Array.isArray(v) ? v.join('、') : String(v || ''))
function setTags(field, text) {
  form.value[field.key] = String(text)
    .split(/[、,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 切换实体时收起表单：留着会让上一个人的输入出现在下一个实体的表单里
watch(
  () => props.collection,
  () => {
    cancelEdit()
    relatedId.value = ''
  }
)
</script>

<template>
  <div class="entity-table">
    <div class="et-head">
      <h4>{{ schema.label }}<span class="et-count">{{ rows.length }}</span></h4>
      <button class="btn sm primary" @click="openCreate">＋ 新增{{ schema.label }}</button>
    </div>

    <div v-if="!rows.length && !editing" class="et-empty">
      还没有{{ schema.label }}。AI 写完一章后会自动提取，也可以在这里手工建立。
    </div>

    <ul v-else class="et-list">
      <li v-for="row in visibleRows" :key="row.id" class="et-row" :class="{ expanded: relatedId === row.id }">
        <div class="et-main">
          <div class="et-title">{{ entityTitle(schema, row) }}</div>
          <div v-if="rowText(row)" class="et-sub">{{ rowText(row) }}</div>
        </div>
        <div class="et-ops">
          <button
            v-if="RELATED_KINDS.has(props.collection)"
            class="btn ghost sm"
            :aria-expanded="relatedId === row.id"
            :aria-label="`查看「${entityTitle(schema, row)}」的关联`"
            @click="toggleRelated(row)"
          >
            关联
          </button>
          <button class="btn ghost sm" @click="openEdit(row)">编辑</button>
          <template v-if="confirmId === row.id">
            <button class="btn ghost sm danger" @click="doRemove(row)">确认删除</button>
            <button class="btn ghost sm" @click="confirmId = null">取消</button>
          </template>
          <button v-else class="btn ghost sm" @click="confirmId = row.id">删除</button>
        </div>

        <div v-if="relatedId === row.id && related" class="et-related">
          <div v-if="!related.events.length && !related.foreshadowing.length && !related.chapters.length" class="et-rel-empty">
            没有找到关联记录。
          </div>
          <div v-if="related.events.length" class="et-rel-group">
            <span class="et-rel-label">事件 · {{ related.events.length }}</span>
            <span class="et-rel-items">
              <span v-for="e in related.events.slice(0, 20)" :key="e.id">{{ relatedTitle('events', e) }}</span>
              <span v-if="related.events.length > 20" class="et-rel-more">…还有 {{ related.events.length - 20 }} 条</span>
            </span>
          </div>
          <div v-if="related.foreshadowing.length" class="et-rel-group">
            <span class="et-rel-label">伏笔 · {{ related.foreshadowing.length }}</span>
            <span class="et-rel-items">
              <span v-for="f in related.foreshadowing.slice(0, 20)" :key="f.id">{{ relatedTitle('foreshadowing', f) }}</span>
              <span v-if="related.foreshadowing.length > 20" class="et-rel-more">…还有 {{ related.foreshadowing.length - 20 }} 条</span>
            </span>
          </div>
          <div v-if="related.chapters.length" class="et-rel-group">
            <span class="et-rel-label">正文提及 · {{ related.chapters.length }}</span>
            <span class="et-rel-items">
              <span v-for="c in related.chapters.slice(0, 20)" :key="c.id">{{ relatedTitle('chapters', c) }}</span>
              <span v-if="related.chapters.length > 20" class="et-rel-more">…还有 {{ related.chapters.length - 20 }} 章</span>
            </span>
          </div>
          <p class="et-rel-hint">「正文提及」按名字出现在章节文本里统计，不代表这条设定一定被使用。</p>
        </div>
      </li>
    </ul>

    <div v-if="hasMoreRows" class="et-more">
      <button class="btn sm" @click="loadMore">
        加载更多（还有 {{ totalRows - visibleRows.length }} 条）
      </button>
    </div>

    <form v-if="editing" class="et-form" @submit.prevent="save">
      <div class="et-form-head">{{ editingId ? '编辑' : '新增' }}{{ schema.label }}</div>
      <label v-for="f in schema.fields" :key="f.key" class="et-field">
        <span class="et-label">
          {{ f.label }}
          <em v-if="f.required" class="et-req">必填</em>
          <em v-if="f.inject" class="et-inject" title="这一项会被写进给 AI 的上下文">注入</em>
          <em v-if="f.meta" class="et-meta" title="流程自动维护的元数据，AI 不会直接修改">元数据</em>
        </span>

        <input
          v-if="f.type === 'checkbox'"
          v-model="form[f.key]"
          class="et-check"
          type="checkbox"
        />

        <textarea
          v-if="f.type === 'textarea'"
          v-model="form[f.key]"
          class="textarea"
          rows="2"
        ></textarea>

        <select v-else-if="f.type === 'select'" v-model="form[f.key]" class="select">
          <option value="">（未设置）</option>
          <option v-for="o in f.options || []" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <select v-else-if="f.type === 'ref'" v-model="form[f.key]" class="select">
          <option value="">（未设置）</option>
          <option v-for="o in refOptions(f)" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <select
          v-else-if="f.type === 'refs'"
          class="select"
          multiple
          :value="form[f.key]"
          @change="
            form[f.key] = [...$event.target.options].filter((o) => o.selected).map((o) => o.value)
          "
        >
          <option v-for="o in refOptions(f)" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <input
          v-else-if="f.type === 'tags'"
          class="input"
          :value="tagsText(form[f.key])"
          placeholder="用「、」分隔"
          @input="setTags(f, $event.target.value)"
        />

        <input
          v-else-if="f.type === 'number'"
          v-model.number="form[f.key]"
          class="input"
          type="number"
        />

        <input v-else v-model="form[f.key]" class="input" />
      </label>

      <div class="et-form-ops">
        <button class="btn primary" type="submit">保存</button>
        <button class="btn ghost" type="button" @click="cancelEdit">取消</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.entity-table {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.et-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.et-head h4 {
  margin: 0;
  font-size: 15px;
}
.et-count {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-3);
  font-weight: 400;
}
.et-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 20px 0;
  line-height: 1.8;
}
.et-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.et-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.et-row.expanded {
  background: var(--bg-muted);
}
.et-related {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  border: 1px dashed var(--border);
}
.et-rel-group {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
}
.et-rel-label {
  flex-shrink: 0;
  color: var(--text-3);
}
.et-rel-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--text-2);
}
.et-rel-more {
  color: var(--text-3);
}
.et-rel-empty {
  font-size: 12px;
  color: var(--text-3);
}
.et-rel-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.et-more {
  display: flex;
  justify-content: center;
  padding: 4px 0;
}
.et-main {
  flex: 1;
  min-width: 0;
}
.et-title {
  font-size: 14px;
  font-weight: 600;
}
.et-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
  word-break: break-word;
}
.et-ops {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.et-form {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  background: var(--bg-muted);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.et-form-head {
  font-size: 13px;
  font-weight: 600;
}
.et-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.et-label {
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.et-req,
.et-inject,
.et-meta {
  font-style: normal;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
}
.et-check {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.et-meta {
  background: var(--bg-muted);
  color: var(--text-3);
  border: 1px solid var(--border);
}
.et-req {
  background: var(--danger-soft);
  color: var(--danger);
}
.et-inject {
  background: var(--accent-soft);
  color: var(--accent);
}
.et-form-ops {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.danger {
  color: var(--danger);
}
@media (max-width: 860px) {
  .et-row {
    flex-direction: column;
    gap: 6px;
  }
}
</style>
