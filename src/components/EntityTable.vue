<script setup>
import { ref, computed, watch } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { ENTITY_SCHEMAS, entityTitle, renderEntity } from '../services/novel/schemas'
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

// ---------------- 编辑 ----------------

const editingId = ref(null)
const form = ref({})
const confirmId = ref(null)

function blank() {
  const o = {}
  for (const f of schema.value.fields) {
    o[f.key] = f.type === 'tags' || f.type === 'refs' ? [] : f.type === 'number' ? 0 : ''
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
  () => cancelEdit()
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
      <li v-for="row in orderedRows" :key="row.id" class="et-row">
        <div class="et-main">
          <div class="et-title">{{ entityTitle(schema, row) }}</div>
          <div v-if="rowText(row)" class="et-sub">{{ rowText(row) }}</div>
        </div>
        <div class="et-ops">
          <button class="btn ghost sm" @click="openEdit(row)">编辑</button>
          <template v-if="confirmId === row.id">
            <button class="btn ghost sm danger" @click="doRemove(row)">确认删除</button>
            <button class="btn ghost sm" @click="confirmId = null">取消</button>
          </template>
          <button v-else class="btn ghost sm" @click="confirmId = row.id">删除</button>
        </div>
      </li>
    </ul>

    <form v-if="editing" class="et-form" @submit.prevent="save">
      <div class="et-form-head">{{ editingId ? '编辑' : '新增' }}{{ schema.label }}</div>
      <label v-for="f in schema.fields" :key="f.key" class="et-field">
        <span class="et-label">
          {{ f.label }}
          <em v-if="f.required" class="et-req">必填</em>
          <em v-if="f.inject" class="et-inject" title="这一项会被写进给 AI 的上下文">注入</em>
        </span>

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
  align-items: flex-start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
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
.et-inject {
  font-style: normal;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
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
