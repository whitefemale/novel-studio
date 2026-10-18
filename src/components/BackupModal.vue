<script setup>
import { ref, computed, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { toast } from '../store/toast'
import { saveToDisk } from '../services/export'
import { getPreRestoreSnapshot, savePreRestoreSnapshot } from '../services/storage'
import {
  buildSnapshotName,
  collectSnapshot,
  applySnapshot,
  mergeSnapshot,
  cloneSnapshotAsNewBooks,
  parseSnapshotJson,
  snapshotStats,
  diffSnapshots,
  toSnapshotJson
} from '../services/novel/snapshot'

/**
 * 全量备份 / 恢复（整库 .json）。
 *
 * 这是用户能拿到的最后一道保险：换机、重装、误删、数据库被浏览器清掉，
 * 都只剩下这份文件。所以它必须满足两个条件，缺一个就等于没有：
 *
 * 1. **恢复是合并，不是替换。** 覆盖式恢复会让「手机上刚写的一章」被三天前的
 *    电脑备份静默抹掉。合并只会输赢分明地逐条决定，不会有整片内容凭空消失。
 * 2. **确认前先摊开会发生什么。** 「确定要恢复吗？」这种提示等于让用户闭着眼点
 *    确定；这里在落盘前就告诉他会新增、覆盖、删除各多少条 —— 删除也必须说，
 *    因为备份里的墓碑确实会删掉本机的记录。
 *
 * 恢复之后必须 `init()` 重载书库：store.books 是内存副本，不重载的话书架上
 * 显示的还是恢复前的列表，用户会以为恢复没生效（或者更糟，以为恢复把书弄丢了）。
 */
const emit = defineEmits(['close'])

const { store, init } = useBooks()
const { settings } = useSettings()

const busy = ref(false)
const fileInput = ref(null)
const fileName = ref('')
const parsed = ref(null)
const preview = ref(null)
/** 'merge' 合并（默认，同 id 按时间戳） | 'copy' 作为副本导入（全部换新 id，不覆盖任何东西） */
const importMode = ref('merge')
const hasPreRestore = ref(false)
const restoreDone = ref(null)

const totalChapters = computed(() => store.books.length)

onMounted(async () => {
  hasPreRestore.value = !!(await getPreRestoreSnapshot())
})

/** 直写模式且配了保存地址才直写，否则交给保存框 —— 与正文导出的口径一致 */
function backupTarget() {
  if (settings.exportMode !== 'direct' || !settings.saveDir) return null
  return { dir: settings.saveDir }
}

async function exportAll() {
  if (busy.value) return
  busy.value = true
  try {
    const snap = await collectSnapshot()
    const st = snapshotStats(snap)
    if (!st.books) {
      toast('还没有可备份的小说', 'error')
      return
    }
    const res = await saveToDisk({
      fileName: buildSnapshotName(),
      content: toSnapshotJson(snap),
      ext: 'json',
      mime: 'application/json',
      target: backupTarget()
    })
    if (res?.canceled) return
    if (res?.ok === false) {
      toast(`备份失败：${res.message || res.code}`, 'error')
      return
    }
    toast(`已备份 ${st.books} 本书、${st.chapters} 章`, 'success')
  } catch (e) {
    console.error('[backup] 导出失败', e)
    toast('备份失败：' + String((e && e.message) || e), 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 读文件用 FileReader 而不是 `file.text()`。
 *
 * `File.text()` 在 Chromium 76+ 才有，而 Android 的 WebView 版本取决于用户
 * 装的系统组件 —— 这个项目在 Android 上本来就无法本机验证（见 CLAUDE.md），
 * 所以这里不赌版本，用哪都有的那份 API。
 */
function readText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(new Error('文件读取失败'))
    fr.readAsText(file)
  })
}

function pickFile() {
  if (busy.value) return
  fileInput.value?.click()
}

/**
 * 按当前导入策略算预览。
 *
 * 预览必须走一次**真实的合并计算**，而不是拿文件里的条数糊弄 ——
 * 用户要知道的是「和我现在这份数据合起来会怎样」。
 * 副本模式下合并对象是克隆后的快照，所以「新增」数会等于文件全部内容，
 * 且永远没有「覆盖 / 删除」——这正是副本的意义。
 */
async function buildPreview(snap) {
  const cur = await collectSnapshot()
  if (importMode.value === 'copy') {
    const clone = cloneSnapshotAsNewBooks(snap)
    const merged = mergeSnapshot(cur, clone)
    return {
      snapshot: clone,
      stats: snapshotStats(clone),
      sourceStats: snapshotStats(snap),
      diff: diffSnapshots(cur, merged)
    }
  }
  const merged = mergeSnapshot(cur, snap)
  return {
    snapshot: snap,
    stats: snapshotStats(snap),
    sourceStats: snapshotStats(snap),
    diff: diffSnapshots(cur, merged)
  }
}

async function onFile(event) {
  const file = event.target.files?.[0]
  // 清空 input 值：不清的话连续选同一个文件不会再触发 change，
  // 用户会以为「点了没反应」
  event.target.value = ''
  if (!file) return
  busy.value = true
  restoreDone.value = null
  try {
    const snap = parseSnapshotJson(await readText(file))
    const p = await buildPreview(snap)
    parsed.value = snap
    fileName.value = file.name
    preview.value = p
  } catch (e) {
    parsed.value = null
    preview.value = null
    fileName.value = ''
    toast(String((e && e.message) || e), 'error')
  } finally {
    busy.value = false
  }
}

async function onModeChange(mode) {
  if (importMode.value === mode) return
  importMode.value = mode
  if (!parsed.value || busy.value) return
  busy.value = true
  try {
    preview.value = await buildPreview(parsed.value)
  } catch (e) {
    toast(String((e && e.message) || e), 'error')
  } finally {
    busy.value = false
  }
}

async function confirmRestore() {
  if (!parsed.value || !preview.value || busy.value) return
  busy.value = true
  restoreDone.value = null
  try {
    // 恢复前自动留底。先写留底再动数据：顺序反过来的话，写库失败时
    // 用户既失去了原数据、也没有可回退的快照。
    await savePreRestoreSnapshot(await collectSnapshot())
    hasPreRestore.value = true

    const res = await applySnapshot(preview.value.snapshot || parsed.value)
    await init()
    const how = importMode.value === 'copy' ? '作为副本导入完成' : '已合并恢复'
    restoreDone.value = {
      text: `${how}：新增 ${res.stats.added}、覆盖 ${res.stats.updated}、删除 ${res.stats.removed}`
    }
    toast(restoreDone.value.text, 'success')
    parsed.value = null
    preview.value = null
    fileName.value = ''
  } catch (e) {
    console.error('[backup] 恢复失败', e)
    // applySnapshot 对空间不足给出的消息更具体（含「部分数据可能已写入」），别再套一层前缀
    toast(String((e && e.message) || e), 'error')
  } finally {
    busy.value = false
  }
}

async function downloadPreRestore() {
  if (busy.value) return
  busy.value = true
  try {
    const snap = await getPreRestoreSnapshot()
    if (!snap) {
      toast('还没有恢复前快照', 'error')
      hasPreRestore.value = false
      return
    }
    const res = await saveToDisk({
      fileName: buildSnapshotName().replace('全量备份', '恢复前快照'),
      content: toSnapshotJson(snap),
      ext: 'json',
      mime: 'application/json',
      target: backupTarget()
    })
    if (res?.canceled) return
    if (res?.ok === false) {
      toast(`导出失败：${res.message || res.code}`, 'error')
      return
    }
    toast('已导出恢复前快照', 'success')
  } catch (e) {
    toast('导出失败：' + String((e && e.message) || e), 'error')
  } finally {
    busy.value = false
  }
}

function reset() {
  parsed.value = null
  preview.value = null
  fileName.value = ''
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>全量备份与恢复</h3>
        <button class="btn ghost sm" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <p class="bk-lead">
          把整库（{{ totalChapters }} 本书及其章节、设定、人物、时间线…）导出成一个
          <b>.json</b> 文件；换机或重装后用它可以恢复全部内容。
        </p>
        <button class="btn primary bk-btn" :disabled="busy || !totalChapters" @click="exportAll">
          {{ busy ? '处理中…' : '导出全量备份（.json）' }}
        </button>

        <hr class="bk-hr" />

        <p class="bk-lead">
          从备份恢复内容是<b>合并</b>，不是覆盖：同一条记录以较新的修改时间为准，
          备份里的删除记录也会生效。因此本机独有的、比备份更新的内容会被保留下来。
        </p>
        <button class="btn bk-btn" :disabled="busy" @click="pickFile">选择备份文件…</button>
        <input
          ref="fileInput"
          class="bk-file"
          type="file"
          accept=".json,application/json"
          @change="onFile"
        />

        <div v-if="preview" class="bk-preview">
          <div class="bk-file-name">
            {{ fileName }}
            <span v-if="preview.sourceStats.exportedAt" class="bk-when">
              导出于 {{ fmtTime(preview.sourceStats.exportedAt) }}
            </span>
          </div>
          <p class="bk-line">
            文件内容：{{ preview.sourceStats.books }} 本书 ·
            {{ preview.sourceStats.chapters }} 章 ·
            {{ preview.sourceStats.entities }} 条设定
          </p>
          <p class="bk-line bk-meta">
            应用版本 {{ parsed?.appVersion || '未知' }} · 数据版本 v{{ parsed?.schemaVersion }} ·
            <span v-if="parsed?.checksum" class="bk-ok">
              校验和通过（{{ parsed.checksum }}）
            </span>
            <span v-else class="bk-when">旧格式备份，无校验和（已按结构校验）</span>
          </p>

          <div class="bk-modes" role="radiogroup" aria-label="导入方式">
            <label class="bk-mode" :class="{ active: importMode === 'merge' }">
              <input
                type="radio"
                name="importMode"
                value="merge"
                :checked="importMode === 'merge'"
                :disabled="busy"
                @change="onModeChange('merge')"
              />
              <span>
                <b>合并</b>
                <small>同一条记录按较新的修改时间为准，本机更新的内容保留</small>
              </span>
            </label>
            <label class="bk-mode" :class="{ active: importMode === 'copy' }">
              <input
                type="radio"
                name="importMode"
                value="copy"
                :checked="importMode === 'copy'"
                :disabled="busy"
                @change="onModeChange('copy')"
              />
              <span>
                <b>作为副本导入</b>
                <small>每本书换新 id、书名加「（导入副本）」，不覆盖任何现有内容</small>
              </span>
            </label>
          </div>

          <p class="bk-line bk-diff">
            {{ importMode === 'copy' ? '导入后将新增' : '恢复后：新增' }}
            <b>{{ preview.diff.added }}</b> 条、覆盖
            <b>{{ preview.diff.updated }}</b> 条、删除 <b>{{ preview.diff.removed }}</b> 条
          </p>
          <p v-if="preview.diff.removed" class="bk-warn">
            有 {{ preview.diff.removed }} 条本机记录会被删除 —— 它们在备份里被删掉过，
            且删除时间晚于本机的最后修改。若这不是你想要的，请先取消并导出一份当前备份。
          </p>
          <p v-else class="bk-hint">
            恢复前会自动保留一份当前整库快照，可在下方导出。
          </p>
        </div>

        <div v-if="restoreDone" class="bk-preview bk-done">
          <p class="bk-line">{{ restoreDone.text }}</p>
          <button v-if="hasPreRestore" class="btn sm" :disabled="busy" @click="downloadPreRestore">
            下载恢复前快照…
          </button>
        </div>

        <button
          v-if="hasPreRestore && !restoreDone"
          class="btn ghost sm bk-prestore"
          :disabled="busy"
          @click="downloadPreRestore"
        >
          下载最近一次「恢复前快照」…
        </button>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">取消</button>
        <button v-if="preview" class="btn primary" :disabled="busy" @click="confirmRestore">
          {{ busy ? '恢复中…' : importMode === 'copy' ? '确认作为副本导入' : '确认合并恢复' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bk-lead {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-2);
}
.bk-btn {
  width: 100%;
}
.bk-hr {
  border: 0;
  border-top: 1px dashed var(--border);
  margin: 18px 0;
}
/* 隐藏原生 file input，但留在 DOM 里 —— 点击必须由它自己发起 */
.bk-file {
  display: none;
}
.bk-preview {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-muted);
}
.bk-file-name {
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
}
.bk-when {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.bk-line {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-2);
}
.bk-diff b {
  color: var(--text);
}
.bk-warn {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--danger);
}
.bk-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-3);
}
.bk-meta {
  word-break: break-all;
}
.bk-ok {
  color: var(--ok, #2e7d32);
}
.bk-modes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.bk-mode {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  background: var(--bg);
}
.bk-mode.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary) inset;
}
.bk-mode input {
  margin-top: 3px;
}
.bk-mode span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.bk-mode small {
  color: var(--text-3);
  line-height: 1.6;
}
.bk-done {
  border-color: var(--primary);
}
.bk-prestore {
  margin-top: 12px;
  width: 100%;
}
</style>
