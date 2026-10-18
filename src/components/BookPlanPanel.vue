<script setup>
import { ref, computed, watch } from 'vue'
import { useBooks } from '../store/books'
import { BOOK_PLAN_FIELDS, isBookPlanEmpty } from '../services/novel/schemas'
import { toast } from '../store/toast'

/**
 * 全书规划：放在控制台「剧情」标签的最上方。
 *
 * 它回答的是**卷/篇/章都管不了的那个问题**：这本书到底在讲什么。没有这一层，
 * 写到一百章之后 AI 只能看到「最近的章节」与「当前卷」，于是每一章都合理，
 * 合起来却没有方向。
 *
 * 存 `books.plan` 而不是另建集合：每本书只有一份，跟着书走天然具备生命周期
 * （删书即消失、快照天然带上），也不会多出一张永远只有一行的表。
 */
const { store, updateBook } = useBooks()

const draft = ref({})
const dirty = ref(false)
const saving = ref(false)

/** 本地草稿从 store 拷一份。直接 v-model 到 store.book.plan 会让「还没保存」
 *  和「已保存」变成同一个状态，用户改了一半就去点了别的面板也无从得知。 */
function loadDraft() {
  const plan = store.book?.plan || {}
  const o = {}
  for (const f of BOOK_PLAN_FIELDS) o[f.key] = String(plan[f.key] ?? '')
  draft.value = o
  dirty.value = false
}

watch(
  () => [store.bookId, store.book?.updatedAt],
  () => {
    // 别的组件（例如同步合并后的 reload）改了书本身时不覆盖用户正在编辑的草稿
    if (!dirty.value) loadDraft()
  },
  { immediate: true }
)

const filled = computed(
  () => BOOK_PLAN_FIELDS.filter((f) => String(draft.value[f.key] ?? '').trim()).length
)

const emptyHint = computed(() =>
  isBookPlanEmpty({
    ...draft.value
  })
)

function onInput() {
  dirty.value = true
}

async function save() {
  if (!store.book || saving.value) return
  saving.value = true
  try {
    const plan = {}
    for (const f of BOOK_PLAN_FIELDS) plan[f.key] = String(draft.value[f.key] ?? '').trim()
    await updateBook({ plan })
    dirty.value = false
    toast('全书规划已保存', 'success')
  } catch (e) {
    console.error('[book-plan] 保存失败', e)
    toast('保存失败：' + String((e && e.message) || e), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="bp">
    <div class="bp-head">
      <h4>全书规划</h4>
      <span class="bp-meta">
        已填 {{ filled }} / {{ BOOK_PLAN_FIELDS.length }} 项
        <template v-if="dirty"> · 未保存</template>
      </span>
    </div>

    <p class="bp-hint">
      这里写的是整本书的方向，会作为**最高优先级**的设定层注入每一章的提示词。
      不是填得越多越好——只写你真正不想被 AI 忘掉的那几句。
      <template v-if="emptyHint">留空也完全可以，不会影响任何既有功能。</template>
    </p>

    <div class="bp-grid">
      <label v-for="f in BOOK_PLAN_FIELDS" :key="f.key" class="bp-field">
        <span>{{ f.label }}</span>
        <textarea
          v-model="draft[f.key]"
          class="textarea"
          rows="2"
          :placeholder="f.label"
          @input="onInput"
        />
      </label>
    </div>

    <div class="bp-ops">
      <button class="btn sm primary" :disabled="saving || !dirty" @click="save">
        {{ saving ? '保存中…' : dirty ? '保存全书规划' : '已保存' }}
      </button>
      <button class="btn sm ghost" :disabled="saving || !dirty" @click="loadDraft">
        放弃修改
      </button>
    </div>
  </section>
</template>

<style scoped>
.bp {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.bp-head h4 {
  margin: 0;
  font-size: 15px;
}
.bp-meta {
  font-size: 12px;
  color: var(--text-3);
}
.bp-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.bp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px 14px;
}
.bp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.bp-ops {
  display: flex;
  gap: 8px;
}
</style>
