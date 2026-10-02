<script setup>
import { ref, computed, watch } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { groupVersions, versionDelta, sourceLabel } from '../services/novel/versioning'
import { toast } from '../store/toast'

/**
 * 章节版本面板。控制台「版本」标签与编辑器「版本」按钮用的是同一个组件。
 *
 * 两处共用而不是各写一个，是因为它们看的是同一批数据：分开写的话，两边对
 * 「哪些组要展开、字数差怎么算、删掉的章节排在哪」早晚给出不同答案，而用户
 * 会以为自己看错了。
 *
 * 组件只读 store.versions（打开书时已载入，每次捕获/回滚后自动刷新），
 * 不自己存一份副本——副本一定会和 store 分叉。
 */
const props = defineProps({
  /** 只看某一章的版本（编辑器的用法）。留空则按章分组列出全书。 */
  chapterId: { type: String, default: '' }
})

const emit = defineEmits(['restored'])

const { store, restoreChapterVersion } = useBooks()
// 保留数写在提示里而不是写死：用户改了设置却不生效的话，这里就是最直接的证据
const { settings } = useSettings()

const groups = computed(() => {
  const list = props.chapterId
    ? store.versions.filter((v) => v.chapterId === props.chapterId)
    : store.versions
  return groupVersions(list, { chapters: store.chapters })
})

/**
 * 展开策略。
 *
 * 编辑器只给了一章，展开它；控制台里组数不多就**全展开** —— 一进来就看到内容
 * 才有用，全折起来等于逼用户逐组点一遍。组数多时先折起来：一本 500 章的小说
 * 可能条条都有版本，全展开是一屏几千行，渲染不动、也没人看得完。
 */
const MAX_AUTO_EXPAND = 5
const openGroups = ref(
  new Set(
    props.chapterId
      ? [props.chapterId]
      : groups.value.length <= MAX_AUTO_EXPAND
        ? groups.value.map((g) => g.chapterId)
        : []
  )
)
// 编辑器里切章时面板不重挂，展开状态得自己跟上，否则展开的是上一章那一组。
watch(
  () => props.chapterId,
  (id) => {
    if (id) openGroups.value = new Set([...openGroups.value, id])
  }
)
const openVersion = ref('')
// 二次确认的待办：恢复是**改动正文**的动作，且它本身会先存一版，
// 误触一次就会在版本列表里多出一条，不能一点就执行。
const pendingId = ref('')
const busyId = ref('')

const total = computed(() => groups.value.reduce((n, g) => n + g.versions.length, 0))

const chapterContent = (chapterId) =>
  store.chapters.find((c) => c.id === chapterId)?.content ?? null

const alive = (chapterId) => store.chapters.some((c) => c.id === chapterId)

function toggleGroup(id) {
  const next = new Set(openGroups.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openGroups.value = next
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 「比当前少 1,204 字」这类提示。没有当前正文（章节已删）时不显示。
 * delta 是「当前 − 这一版」，所以正数意味着这一版更短。
 */
function deltaText(v) {
  const d = versionDelta(v, chapterContent(v.chapterId))
  if (d.delta == null) return ''
  if (d.delta === 0) return '与当前相同'
  return d.delta > 0 ? `比当前少 ${d.delta} 字` : `比当前多 ${-d.delta} 字`
}

async function restore(v) {
  if (pendingId.value !== v.id) {
    pendingId.value = v.id
    return
  }
  pendingId.value = ''
  busyId.value = v.id
  try {
    const c = await restoreChapterVersion(v)
    if (!c) {
      toast('这本书已经关了，无法恢复', 'error')
      return
    }
    toast(`已恢复到 ${fmtTime(v.createdAt)} 的那一版`, 'success')
    // 正文换了，编辑器必须重读：它只在 chapterId 变化时同步正文，
    // 同章内改内容它一概不理会（这正是「恢复了但界面没变」的成因）。
    emit('restored', c)
  } catch (e) {
    console.error('[versions] 恢复失败', e)
    toast('恢复失败：' + String((e && e.message) || e), 'error')
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <div class="cv">
    <div class="cv-head">
      <h4>章节版本{{ chapterId ? '（本章）' : '' }}</h4>
      <span class="cv-count">{{ total }} 版</span>
    </div>

    <p class="cv-hint">
      AI 覆盖、回滚前、手动存档、删章前各自动留一版，每章最多保留
      <b>{{ settings.versionKeep }}</b> 版（在「设置 → 章节版本」里改）。
      超出的最旧版本会被清掉，且这次清理**不会同步给别的设备**。
      正文一改，存下来的旧版就是唯一能退回去的地方。
    </p>

    <div v-if="!groups.length" class="cv-empty">
      还没有任何版本。点编辑器工具栏的「存档」可以先留一个点。
    </div>

    <div v-for="g in groups" :key="g.chapterId" class="cv-group" :class="{ dead: !g.alive }">
      <button class="cv-ghead" @click="toggleGroup(g.chapterId)">
        <span class="cv-caret">{{ openGroups.has(g.chapterId) ? '▾' : '▸' }}</span>
        <span class="cv-gtitle">
          {{ g.alive ? `第${g.order}章 · ${g.chapterTitle}` : `${g.chapterTitle}（章节已删除）` }}
        </span>
        <span class="cv-gcount">{{ g.versions.length }}</span>
      </button>

      <div v-if="openGroups.has(g.chapterId)" class="cv-list">
        <div v-for="v in g.versions" :key="v.id" class="cv-item">
          <div class="cv-row">
            <span class="cv-time">{{ fmtTime(v.createdAt) }}</span>
            <span class="cv-src" :class="`src-${v.source}`">{{ sourceLabel(v.source) }}</span>
            <span class="cv-wc">{{ v.wordCount }} 字</span>
            <span v-if="alive(g.chapterId)" class="cv-delta">{{ deltaText(v) }}</span>
            <span class="cv-ops">
              <button
                class="btn ghost sm"
                @click="openVersion = openVersion === v.id ? '' : v.id"
              >
                {{ openVersion === v.id ? '收起' : '看全文' }}
              </button>
              <button
                class="btn sm"
                :class="{ danger: pendingId === v.id }"
                :disabled="busyId === v.id"
                @click="restore(v)"
              >
                {{ busyId === v.id ? '恢复中…' : pendingId === v.id ? '确认恢复？' : '恢复此版' }}
              </button>
            </span>
          </div>
          <pre v-if="openVersion === v.id" class="cv-text">{{ v.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cv {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.cv-head h4 {
  margin: 0;
  font-size: 15px;
}
.cv-count {
  font-size: 12px;
  color: var(--text-3);
}
.cv-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.cv-empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 16px 0;
}
.cv-group {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
/* 章节已被删除的那一组用虚线与灰底：它是「误删救回」的入口，必须一眼看出来
   和活着的章节不是一回事 */
.cv-group.dead {
  border-style: dashed;
  background: var(--bg-muted);
}
.cv-ghead {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  text-align: left;
  font-size: 13px;
}
.cv-ghead:hover {
  background: var(--bg-muted);
}
.cv-caret {
  color: var(--text-3);
  font-size: 11px;
}
.cv-gtitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cv-gcount {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-muted);
  border-radius: 999px;
  padding: 1px 7px;
}
.cv-list {
  border-top: 1px solid var(--border);
}
.cv-item + .cv-item {
  border-top: 1px dashed var(--border);
}
.cv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 12px;
  flex-wrap: wrap;
}
.cv-time {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.cv-src {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  background: var(--bg-muted);
  color: var(--text-2);
}
.cv-src.src-ai {
  background: var(--accent-soft);
  color: var(--accent);
}
.cv-src.src-delete {
  color: var(--danger);
}
.cv-wc {
  color: var(--text-3);
}
.cv-delta {
  color: var(--text-3);
}
.cv-ops {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.cv-text {
  margin: 0;
  padding: 10px 12px 14px;
  max-height: 320px;
  overflow: auto;
  background: var(--bg-muted);
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: var(--text-2);
}
</style>
