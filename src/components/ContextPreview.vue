<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { useSettings } from '../store/settings'
import { buildContext } from '../services/novel/contextBuilder'
import { messagesFromContext } from '../services/prompts'
import { ACTIONS } from '../services/novel/actions'

/**
 * 上下文预览：把「这一章 AI 实际会看到什么」摊开给用户看。
 *
 * 为什么它是本轮的必做项而不是锦上添花：长篇小说的一致性问题是**不可见**的。
 * 用户看到的是「AI 把已经死掉的角色又写活了」，而真正的原因可能是「人物状态
 * 那一层被预算丢掉了」。没有这一页，那个原因永远只能靠猜。
 *
 * 全部是纯数据的直接渲染 —— buildContext 是纯函数，这里不做任何额外推理。
 */
const { store, currentChapter } = useBooks()
const cols = useCollections()
const { settings } = useSettings()

const action = ref('continue')
const showFull = ref(false)

const input = computed(() => ({
  book: store.book,
  bookId: store.bookId,
  chapter: currentChapter.value,
  chapters: store.chapters,
  outlines: store.outlines,
  memory: cols.memory.store,
  structure: cols.structure.store,
  settings,
  action: action.value,
  instruction: ''
}))

const ctx = computed(() => buildContext(input.value))

/** 被丢弃的层要显眼：它们正是「AI 忘了这件事」的元凶 */
const dropped = computed(() => ctx.value.metadata.droppedLayers || [])
const layers = computed(() => ctx.value.metadata.layers || [])

const fullText = computed(() => {
  const msgs = messagesFromContext(ctx.value)
  return msgs.map((m) => `【${m.role === 'system' ? 'system' : 'user'}】\n${m.content}`).join('\n\n')
})

const layerLabel = (id) => layers.value.find((l) => l.id === id)?.label || id
</script>

<template>
  <div class="ctx">
    <div class="ctx-head">
      <h4>上下文预览</h4>
      <select v-model="action" class="select ctx-action">
        <option v-for="a in ACTIONS" :key="a.key" :value="a.key">{{ a.label }}</option>
      </select>
    </div>

    <p class="ctx-hint">
      这是「{{ currentChapter?.title || '未选中章节' }}」在
      <b>{{ ACTIONS.find((a) => a.key === action)?.label }}</b> 模式下实际会发给 AI 的内容。
      预算 {{ ctx.metadata.budget }} tokens，本次用掉 <b>{{ ctx.metadata.totalTokens }}</b>。
      <span v-if="ctx.metadata.overBudget" class="ctx-warn">
        超出预算：必带的层不会被截断，因此总量可能高于预算。
      </span>
    </p>

    <div v-if="dropped.length" class="ctx-drop">
      因预算不足被丢弃：{{ dropped.map(layerLabel).join('、') }} ——
      这些内容这次**没有**告诉 AI，写出来对不上是正常的。
    </div>

    <table class="ctx-table">
      <thead>
        <tr>
          <th>层</th>
          <th>条目</th>
          <th>tokens</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="l in layers" :key="l.id">
          <td>{{ l.label }}</td>
          <td>{{ l.items ?? '—' }}</td>
          <td>{{ l.tokens }}</td>
          <td>
            <span v-if="l.dropped" class="tag danger">已丢弃</span>
            <span v-else-if="l.truncated" class="tag warn">已截断</span>
            <span v-else class="tag ok">完整</span>
          </td>
        </tr>
      </tbody>
    </table>

    <button class="btn ghost sm ctx-toggle" @click="showFull = !showFull">
      {{ showFull ? '▾ 收起全文' : '▸ 查看最终提示词全文' }}
    </button>
    <pre v-if="showFull" class="ctx-full">{{ fullText }}</pre>
  </div>
</template>

<style scoped>
.ctx {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ctx-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ctx-head h4 {
  margin: 0;
  font-size: 15px;
}
.ctx-action {
  width: 140px;
}
.ctx-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.ctx-warn {
  color: var(--danger);
}
.ctx-drop {
  font-size: 12px;
  line-height: 1.7;
  background: var(--danger-soft);
  color: var(--danger);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
}
.ctx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.ctx-table th,
.ctx-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.ctx-table th {
  color: var(--text-3);
  font-weight: 500;
}
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
}
.tag.ok {
  background: var(--bg-muted);
  color: var(--text-3);
}
.tag.warn {
  background: var(--accent-soft);
  color: var(--accent);
}
.tag.danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.ctx-toggle {
  align-self: flex-start;
}
.ctx-full {
  margin: 0;
  padding: 12px;
  background: var(--bg-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 50vh;
  overflow: auto;
}
</style>
