<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { useGeneration, aggregateRuns } from '../store/generation'
import { STAGE_LABELS } from '../services/ai/orchestrator'
import { formatTokens, formatCost } from '../services/ai/tokenUsage'
import { toast } from '../store/toast'
import { usePagedList } from '../composables/usePagedList'

/**
 * 生成历史与成本汇总。
 *
 * 按**每一次调用**列，而不是按章合并：一次写章包含「写正文」与「提取记忆」
 * 两次调用，合并之后用户就答不上「钱花在哪一步」——而提取那一步往往是他
 * 没意识到要花钱的地方。
 */
const { store } = useBooks()
const gen = useGeneration()

const rows = computed(() =>
  [...gen.store.runs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
)

const total = computed(() => aggregateRuns(gen.store.runs))

// 生成记录可能上千条（每次调用一行），翻页保持在「最近 100 次」以内。
// 换书时回到第一页。
const {
  visible: visibleRows,
  hasMore: hasMoreRows,
  total: totalRows,
  loadMore
} = usePagedList(() => rows.value, { watchKey: () => store.bookId })

const chapterTitle = (id) => store.chapters.find((c) => c.id === id)?.title || ''

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const stageOf = (run) => STAGE_LABELS[run.stage] || run.stage || '调用'

/** 展开一行，显示可复现参数与上下文摘要。 */
const expandedId = ref('')
function toggle(run) {
  expandedId.value = expandedId.value === run.id ? '' : run.id
}

const statusLabel = (s) =>
  ({ done: '完成', aborted: '已中止', error: '失败', truncated: '被截断' })[s] || s || ''

function droppedText(run) {
  const dropped = run.contextSummary?.dropped || []
  return dropped.length ? dropped.join('、') : '无'
}

async function clearAll() {
  const bookId = store.bookId
  if (!bookId) return
  for (const r of [...gen.store.runs]) await gen.removeRun(r.id)
  toast('已清空生成历史', 'success')
}
</script>

<template>
  <div class="gh">
    <div class="gh-head">
      <h4>生成历史</h4>
      <button v-if="rows.length" class="btn ghost sm" @click="clearAll">清空</button>
    </div>

    <div class="gh-sum">
      <div class="gh-card">
        <span class="gh-k">调用次数</span>
        <b>{{ total.count }}</b>
      </div>
      <div class="gh-card">
        <span class="gh-k">输入 tokens</span>
        <b>{{ formatTokens(total.inputTokens) }}</b>
      </div>
      <div class="gh-card">
        <span class="gh-k">输出 tokens</span>
        <b>{{ formatTokens(total.outputTokens) }}</b>
      </div>
      <div class="gh-card">
        <span class="gh-k">合计花费</span>
        <b>
          {{ total.unpriced ? '部分未定价' : formatCost({ total: total.cost, currency: total.currency }) }}
          <em v-if="total.estimated" class="gh-est">含估算</em>
        </b>
      </div>
    </div>

    <p class="gh-hint">
      金额按「设置 → 价目表」计算，仅供参考，<b>请以服务商官方账单为准</b>。
      标「估」的记录表示该端点没有返回用量，token 数是本地按字符估算的。
    </p>

    <div v-if="!rows.length" class="gh-empty">还没有生成记录。</div>

    <table v-else class="gh-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>阶段</th>
          <th>章节</th>
          <th>模型</th>
          <th>tokens</th>
          <th>金额</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in visibleRows" :key="r.id">
          <tr class="gh-row" @click="toggle(r)">
            <td>{{ fmtTime(r.createdAt) }}</td>
            <td>
              {{ stageOf(r) }}
              <span v-if="r.status !== 'done'" class="gh-bad">{{ statusLabel(r.status) }}</span>
              <span class="gh-caret">{{ expandedId === r.id ? '▾' : '▸' }}</span>
            </td>
            <td>{{ chapterTitle(r.chapterId) || '—' }}</td>
            <td class="gh-model">{{ r.model || '—' }}</td>
            <td>{{ formatTokens((r.inputTokens || 0) + (r.outputTokens || 0)) }}</td>
            <td>{{ r.priced === false ? '—' : formatCost({ total: r.cost, currency: r.currency }) }}</td>
          </tr>
          <tr v-if="expandedId === r.id" class="gh-detail">
            <td colspan="6">
              <div class="gh-detail-grid">
                <div><span class="gh-k">提示词版本</span><b>{{ r.promptVersion || '（旧记录未保存）' }}</b></div>
                <div>
                  <span class="gh-k">参数</span>
                  <b>
                    <template v-if="r.params">
                      温度 {{ r.params.temperature ?? '—' }} · 最大输出
                      {{ r.params.maxTokens ?? '—' }} tokens
                    </template>
                    <template v-else>（旧记录未保存）</template>
                  </b>
                </div>
                <div><span class="gh-k">任务 id</span><b>{{ r.taskId || '—' }}</b></div>
                <div><span class="gh-k">尝试次数</span><b>{{ r.attempts || 1 }}</b></div>
                <div>
                  <span class="gh-k">上下文</span>
                  <b v-if="r.contextSummary">
                    {{ r.contextSummary.tokens }} tokens · 预算 {{ r.contextSummary.budget }} ·
                    丢弃层 {{ droppedText(r) }}
                  </b>
                  <b v-else>（旧记录未保存）</b>
                </div>
                <div><span class="gh-k">结束原因</span><b>{{ r.finishReason || '—' }}</b></div>
              </div>
              <div v-if="r.error" class="gh-detail-err">错误：{{ r.error }}</div>
              <div v-if="r.contextSummary?.sources?.length" class="gh-sources">
                上下文来源：{{ r.contextSummary.sources.join('、') }}
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="hasMoreRows" class="gh-more">
      <button class="btn sm" @click="loadMore">
        加载更多（还有 {{ totalRows - visibleRows.length }} 条）
      </button>
    </div>
  </div>
</template>

<style scoped>
.gh {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gh-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.gh-head h4 {
  margin: 0;
  font-size: 15px;
}
.gh-sum {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.gh-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg-muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gh-k {
  font-size: 11px;
  color: var(--text-3);
}
.gh-card b {
  font-size: 16px;
}
.gh-est {
  font-style: normal;
  font-size: 11px;
  font-weight: 400;
  color: var(--accent);
  margin-left: 4px;
}
.gh-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.gh-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 16px 0;
}
.gh-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.gh-table th,
.gh-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.gh-table th {
  color: var(--text-3);
  font-weight: 500;
}
.gh-model {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gh-bad {
  color: var(--danger);
  font-size: 11px;
}
.gh-caret {
  margin-left: 4px;
  color: var(--text-3);
  font-size: 10px;
}
.gh-row {
  cursor: pointer;
}
.gh-row:hover {
  background: var(--bg-muted);
}
.gh-detail td {
  background: var(--bg-muted);
  padding: 10px 12px;
}
.gh-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
  font-size: 12px;
}
.gh-detail-grid > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.gh-detail-grid b {
  font-weight: 500;
  word-break: break-word;
}
.gh-detail-err {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger);
  word-break: break-word;
}
.gh-sources {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
  word-break: break-word;
}
.gh-more {
  display: flex;
  justify-content: center;
  padding: 4px 0;
}
</style>
