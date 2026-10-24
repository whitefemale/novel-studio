<script setup>
import { ref, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { toast } from '../store/toast'
import { coll } from '../services/storage'
import { ensureBookIndex, getRagIndexStatus, clearBookIndex } from '../services/rag/indexer'
import { searchRag } from '../services/rag/search'
import { buildRagQueryText } from '../services/rag/context'

/**
 * 「检索」标签：本地字面检索（RAG）的状态与试跑。
 *
 * 界面文案必须把边界说清楚：这是**字面相似**检索，不是语义模型。
 * 用户看到「相关历史片段」时很容易以为软件理解了剧情，于是对召回质量
 * 产生不切实际的期待；同义词、代词指代召回不到是算法本身的限制，
 * 不是缺陷。说清楚比事后解释便宜得多。
 *
 * 索引是设备本地态：不进全量备份、不进局域网/WebDAV 同步。换台设备
 * 第一次写作用到检索时会自动重建，这里的「重建」按钮是给内容大改后
 * 想立刻验证、或怀疑索引损坏时用的。
 */

const { store } = useBooks()
const { settings, persist } = useSettings()

const status = ref(null)
const busy = ref('')
const query = ref('')
const results = ref([])
const searched = ref(false)

const fmt = (n) => Number(n || 0).toLocaleString('zh-CN')
const pct = (v) => `${Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)))}%`

function describeTime(ts) {
  const t = Number(ts) || 0
  if (!t) return '尚未建立'
  try {
    return new Date(t).toLocaleString('zh-CN')
  } catch {
    return '未知'
  }
}

async function refresh() {
  if (!store.bookId) return
  status.value = await getRagIndexStatus(store.bookId, store.chapters)
}

async function rebuild() {
  if (!store.bookId || busy.value) return
  busy.value = 'rebuild'
  try {
    const res = await ensureBookIndex(store.bookId, store.chapters, settings, { force: true })
    toast(`索引已重建：${res.chunkCount} 个片段`, 'success')
    await refresh()
  } catch (e) {
    toast('重建索引失败：' + String((e && e.message) || e), 'error')
  } finally {
    busy.value = ''
  }
}

async function clearIndex() {
  if (!store.bookId || busy.value) return
  busy.value = 'clear'
  try {
    const res = await clearBookIndex(store.bookId)
    results.value = []
    searched.value = false
    toast(`已清除 ${res.cleared} 个片段（下次生成或查询时会按需重建）`, 'success')
    await refresh()
  } catch (e) {
    toast('清除索引失败：' + String((e && e.message) || e), 'error')
  } finally {
    busy.value = ''
  }
}

async function runQuery() {
  if (!store.bookId || busy.value) return
  const q = query.value.trim()
  if (!q) {
    toast('请先输入要检索的内容', 'error')
    return
  }
  busy.value = 'query'
  try {
    // 查询前确保索引是最新的：用户可能刚同步进来几章。
    await ensureBookIndex(store.bookId, store.chapters, settings)
    const chunks = await coll.ragChunks.getAll(store.bookId)
    results.value = searchRag({
      query: q,
      chunks,
      topK: settings.rag.topK,
      minScore: settings.rag.minScore
    })
    searched.value = true
    await refresh()
  } catch (e) {
    toast('检索失败：' + String((e && e.message) || e), 'error')
  } finally {
    busy.value = ''
  }
}

function previewQuery() {
  query.value = buildRagQueryText({
    action: 'continue',
    chapter: store.currentChapter,
    chapters: store.chapters
  })
  if (!query.value) toast('当前章节还没有可组成查询的内容', 'info')
}

onMounted(refresh)
</script>

<template>
  <div class="rag">
    <div class="rag-head">
      <h4>本地检索（RAG）</h4>
      <p class="hint">
        用**字面相似度**（单字 + 双字 + 英文词）从已写正文里找回相关片段，注入写作提示词。
        它不是语义模型：同义词、代词指代召回不到；默认关闭，开启后只多一层上下文，不影响其他设置。
      </p>
    </div>

    <section class="block">
      <div class="row">
        <label class="check">
          <input
            v-model="settings.rag.enabled"
            type="checkbox"
            @change="persist()"
          />
          生成时检索相关历史片段
        </label>
        <span class="spacer"></span>
        <button class="btn sm" :disabled="!!busy" @click="rebuild">
          {{ busy === 'rebuild' ? '重建中…' : '重建索引' }}
        </button>
        <button class="btn ghost sm" :disabled="!!busy" @click="clearIndex">
          {{ busy === 'clear' ? '清除中…' : '清除索引' }}
        </button>
        <button class="btn ghost sm" :disabled="!!busy" @click="refresh">刷新</button>
      </div>
      <p class="hint">
        索引只保存在本机（IndexedDB），不进全量备份、不进局域网 / WebDAV 同步；
        换设备后第一次写作用到检索时会自动重建。
      </p>
    </section>

    <section v-if="status" class="block">
      <h5>索引状态</h5>
      <div class="cards">
        <div class="card">
          <span class="k">覆盖率</span>
          <span class="v">{{ pct(status.coverage) }}</span>
          <span class="s">
            {{ status.indexedChapters }} / {{ status.contentChapters }} 个有正文的章节
          </span>
        </div>
        <div class="card">
          <span class="k">片段数</span>
          <span class="v">{{ fmt(status.chunkCount) }}</span>
          <span class="s">共 {{ fmt(status.totalChars) }} 字（含重叠）</span>
        </div>
        <div class="card">
          <span class="k">已过期</span>
          <span class="v">{{ fmt(status.staleChapters) }}</span>
          <span class="s">
            缺索引 {{ status.missingChapters }} 章 · 残留 {{ status.orphanChapters }} 章
          </span>
        </div>
        <div class="card">
          <span class="k">上次建立</span>
          <span class="v small">{{ describeTime(status.builtAt) }}</span>
          <span class="s">生成前会自动更新过期章节</span>
        </div>
      </div>
      <p v-if="status.staleChapters || status.missingChapters || status.orphanChapters" class="hint warn">
        有章节在建立索引之后被改过或删除。生成前会自动重建这些章节；也可以点「重建索引」立即处理。
      </p>
    </section>

    <section class="block">
      <h5>参数 <span class="cap">改动会在下次检索时生效</span></h5>
      <div class="grid">
        <label class="field">
          <span>召回片段数上限</span>
          <input v-model.number="settings.rag.topK" class="input" type="number" min="1" max="20" @change="persist()" />
        </label>
        <label class="field">
          <span>注入提示词的 token 预算</span>
          <input v-model.number="settings.rag.budget" class="input" type="number" min="0" max="4000" step="50" @change="persist()" />
        </label>
        <label class="field">
          <span>最低相似度（0–1）</span>
          <input v-model.number="settings.rag.minScore" class="input" type="number" min="0" max="1" step="0.01" @change="persist()" />
        </label>
      </div>
      <p class="hint">
        「最低相似度」越高召回越少、越精确。0.18 是保守默认值；调得过高可能一条都召不回，
        这不会报错，只是提示词里没有这一层。
      </p>
    </section>

    <section class="block">
      <h5>试跑 <span class="cap">只读：不会写入正文，也不会调用接口</span></h5>
      <textarea
        v-model="query"
        class="input query"
        rows="3"
        placeholder="输入一段文字，看看会召回哪些历史片段"
      ></textarea>
      <div class="row">
        <button class="btn sm" :disabled="!!busy" @click="runQuery">
          {{ busy === 'query' ? '检索中…' : '检索' }}
        </button>
        <button class="btn ghost sm" :disabled="!!busy" @click="previewQuery">用当前章生成查询</button>
        <span class="spacer"></span>
        <span v-if="searched" class="hint">命中 {{ results.length }} 条</span>
      </div>

      <p v-if="searched && !results.length" class="empty">
        没有达到最低相似度的片段。可以调低「最低相似度」，或先多写几章正文。
      </p>

      <div v-for="r in results" :key="r.id" class="hit">
        <div class="hit-head">
          <strong>第{{ r.chapterOrder }}章 {{ r.chapterTitle || '未命名' }}</strong>
          <span class="score">相似度 {{ r.score.toFixed(4) }}</span>
          <span class="pos">原文第 {{ r.start }}–{{ r.end }} 字</span>
        </div>
        <pre class="hit-text">{{ r.text.length > 800 ? r.text.slice(0, 800) + '…' : r.text }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rag {
  padding: 4px 2px 24px;
}
.rag-head h4 {
  margin: 0 0 6px;
}
.hint {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.7;
  margin: 6px 0;
}
.hint.warn {
  color: var(--danger, #c0392b);
}
.block {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border, #eee);
}
.block h5 {
  margin: 0 0 10px;
  font-size: 14px;
}
.cap {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-3, #999);
  margin-left: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
}
.card {
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-muted, #fafafa);
}
.card .k {
  font-size: 12px;
  color: var(--text-3, #999);
}
.card .v {
  font-size: 20px;
  font-weight: 600;
}
.card .v.small {
  font-size: 13px;
  font-weight: 500;
}
.card .s {
  font-size: 12px;
  color: var(--text-2);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-2);
}
.query {
  width: 100%;
  resize: vertical;
  margin-bottom: 8px;
  font-family: inherit;
}
.empty {
  color: var(--text-3, #999);
  font-size: 13px;
}
.hit {
  margin-top: 12px;
  border: 1px solid var(--border, #eee);
  border-radius: 8px;
  overflow: hidden;
}
.hit-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  background: var(--bg-muted, #fafafa);
  font-size: 12.5px;
  color: var(--text-2);
}
.score {
  color: var(--accent, #2b6cb0);
}
.pos {
  color: var(--text-3, #999);
}
.hit-text {
  margin: 0;
  padding: 10px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.75;
}
</style>
