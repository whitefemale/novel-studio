<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useSettings } from '../store/settings'
import { useBooks } from '../store/books'
import { coll } from '../services/storage'
import { isDesktop } from '../services/platform'
import { copyToClipboard } from '../services/native'
import { toast } from '../store/toast'
import { isConflictStale } from '../services/sync/conflicts'
import {
  startSyncServer,
  stopSyncServer,
  rotateSyncCode,
  syncStatus,
  testConnection,
  pushSnapshot,
  syncState
} from '../services/sync'

/**
 * 局域网同步设置。同一个组件两副面孔：
 *
 * - **电脑端**：它是服务端 —— 开关、端口、可供手机填的地址、6 位配对码、上次结果。
 * - **手机 / 浏览器端**：它是客户端 —— 电脑地址、配对码、测试连接、立即同步。
 *
 * 做成一个组件而不是两个，是因为两副面孔共享同一块设置区、同一个「上次结果」
 * 版式；拆成两个组件的结果是两边各写一份「同步结果」的渲染，然后慢慢分叉。
 *
 * 它放在 SettingsPanel 的 `v-if="desktop"` **之外** —— 同步在两端的设置里都要能配。
 */
const { settings } = useSettings()
const { store, selectChapter } = useBooks()
const desktop = isDesktop()

const st = ref({ running: false, port: 0, code: '', addresses: [], last: null })
const busy = ref(false)
const testResult = ref(null)
const pushResult = ref(null)
const conflictRows = ref([])

const addresses = computed(() => st.value.addresses || [])

const openConflicts = computed(() => conflictRows.value.filter((r) => r.status === 'open'))

async function refresh() {
  st.value = await syncStatus()
}

/**
 * 冲突记录随快照同步，所以两台设备都会收到同一批。这里只展示**当前这本书**
 * 的记录——在 A 书的设置页里看到 B 书的冲突，用户点「打开」会跳到一本他
 * 根本没在看的书，那比不显示更糟。
 */
async function loadConflicts() {
  if (!store.bookId) {
    conflictRows.value = []
    return
  }
  const all = await coll.syncConflicts.getAll(store.bookId)
  conflictRows.value = [...all].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

function conflictStale(row) {
  return isConflictStale(row, store.chapters)
}

function chapterTitle(id) {
  return store.chapters.find((c) => c.id === id)?.title || '（章节已不存在）'
}

function openChapter(id) {
  if (store.chapters.some((c) => c.id === id)) {
    selectChapter(id)
    toast('已切换到该章节', 'success')
  } else {
    toast('这一章已经不存在了', 'error')
  }
}

async function resolveConflict(row) {
  if (!store.bookId) return
  await coll.syncConflicts.upsert(store.bookId, {
    ...row,
    status: 'resolved',
    resolvedAt: Date.now(),
    updatedAt: Date.now()
  })
  await loadConflicts()
  toast('已标记为已解决（冲突副本仍保留在章节列表里）', 'success')
}

onMounted(async () => {
  if (desktop) await refresh()
  await loadConflicts()
})

watch(() => store.bookId, loadConflicts)
// 同步完成后刷新冲突列表。lastIncoming / lastOutgoing 是同步服务写入的状态，
// 它们变化就说明这一轮往返已经落了库。
watch(
  () => [syncState.lastIncoming, syncState.lastOutgoing],
  () => loadConflicts()
)

async function toggleServer() {
  if (busy.value) return
  busy.value = true
  try {
    if (st.value.running) {
      await stopSyncServer()
      await refresh()
      toast('同步服务已关闭', 'success')
    } else {
      const res = await startSyncServer(settings.syncPort)
      if (!res.ok) {
        toast(res.message || '开启失败', 'error')
        return
      }
      await refresh()
      // 端口回退了要说出来：用户已经把这个端口抄进手机了，不告诉他就会
      // 在手机那头对着一个连不上的地址反复重试
      if (res.port !== Number(settings.syncPort)) {
        toast(`端口 ${settings.syncPort} 被占用，已改用 ${res.port}`, 'error')
      } else {
        toast('同步服务已开启', 'success')
      }
    }
  } finally {
    busy.value = false
  }
}

async function rotate() {
  const res = await rotateSyncCode()
  if (res.ok) {
    await refresh()
    toast('已换用新的配对码，旧码立即失效', 'success')
  }
}

async function copy(text) {
  try {
    await copyToClipboard(text)
    toast('已复制', 'success')
  } catch {
    toast('复制失败，请手动抄写', 'error')
  }
}

async function doTest() {
  busy.value = true
  testResult.value = null
  try {
    testResult.value = await testConnection(settings.syncUrl)
  } finally {
    busy.value = false
  }
}

async function doSync() {
  busy.value = true
  pushResult.value = null
  try {
    const res = await pushSnapshot(settings.syncUrl, settings.syncCode)
    pushResult.value = res
    if (res.ok) toast(`同步完成：新增 ${res.diff.added} · 覆盖 ${res.diff.updated} · 删除 ${res.diff.removed}`, 'success')
  } finally {
    busy.value = false
  }
}

function when(ts) {
  return ts ? new Date(ts).toLocaleString() : ''
}
</script>

<template>
  <div class="sync-panel">
    <div class="divider"></div>
    <h4 class="section-title">局域网同步</h4>
    <p class="hint">
      两台设备在同一个 Wi-Fi 下，把小说与设定互相补齐。数据只在两台设备之间直接传输，
      <b>不经过任何第三方服务器</b>，也<b>不包含 API Key</b>。
    </p>

    <!-- ---------------- 冲突（两端都显示） ---------------- -->
    <div v-if="openConflicts.length" class="sync-conflicts">
      <h5>待处理冲突 {{ openConflicts.length }} 条</h5>
      <p class="hint">
        同一章在两台设备上都被改过。同步不会替你选一个：主章保留电脑上的版本，
        另一版本以「【冲突副本】」另存为一章，两边的正文都在。
      </p>
      <div v-for="row in openConflicts" :key="row.id" class="sync-conflict">
        <div class="sync-conflict-title">{{ row.chapterTitle || chapterTitle(row.chapterId) }}</div>
        <div class="hint">
          主章：{{ chapterTitle(row.chapterId) }} · 副本：{{ chapterTitle(row.copyChapterId) }}
        </div>
        <div v-if="conflictStale(row)" class="hint warn">
          这条冲突解决之后，主章或副本又被改过，请重新对照一下再标记。
        </div>
        <div class="sync-row">
          <button class="btn sm" @click="openChapter(row.chapterId)">打开主章</button>
          <button class="btn sm" @click="openChapter(row.copyChapterId)">打开冲突副本</button>
          <button class="btn sm primary" @click="resolveConflict(row)">标记已解决</button>
        </div>
      </div>
    </div>
    <p v-else-if="conflictRows.length" class="hint ok">
      同步冲突已全部处理（共 {{ conflictRows.length }} 条记录）。
    </p>

    <!-- ---------------- 电脑端：服务端 ---------------- -->
    <template v-if="desktop">
      <div class="sync-row">
        <label class="check">
          <input type="checkbox" :checked="st.running" :disabled="busy" @change="toggleServer" />
          开启同步服务（手机连过来时使用）
        </label>
      </div>

      <div style="height: 12px"></div>
      <label class="label">监听端口</label>
      <div class="sync-row">
        <input
          v-model.number="settings.syncPort"
          class="input narrow"
          type="number"
          min="1024"
          max="65535"
          :disabled="st.running"
        />
        <span class="hint inline">被占用时会自动向后顺延，实际端口以下方地址为准</span>
      </div>

      <div style="height: 12px"></div>
      <label class="check">
        <input v-model="settings.syncAutoStart" type="checkbox" />
        下次启动软件时自动开启（否则每次都要手动点一下）
      </label>

      <div style="height: 8px"></div>
      <label class="check">
        <input v-model="settings.syncConflictCopies" type="checkbox" />
        同章冲突时保留远端副本（推荐）
      </label>
      <p class="hint">
        开启后，同一章在两端都改过时不会覆盖任何一边：主章保留本机版本，
        远端版本另存为「【冲突副本】」，并在上方列出待处理冲突。
        关闭它意味着同章冲突按「后改的赢」处理，被覆盖的正文将无法找回。
      </p>

      <template v-if="st.running">
        <div style="height: 14px"></div>
        <label class="label">在手机上填写这个地址</label>
        <div v-for="a in addresses" :key="a.address" class="sync-row">
          <code class="sync-addr">{{ a.url }}</code>
          <span class="sync-nic">{{ a.name }}</span>
          <button class="btn sm" @click="copy(a.url)">复制</button>
        </div>
        <p v-if="!addresses.length" class="hint">
          没有找到局域网地址。请确认这台电脑已连上 Wi-Fi 或网线。
        </p>
        <p v-else class="hint">
          列出的每一张网卡都可能是对的（VPN、虚拟机也会出现）。挑手机能连上的那一个。
        </p>

        <div style="height: 14px"></div>
        <label class="label">配对码</label>
        <div class="sync-row">
          <span class="sync-code">{{ st.code }}</span>
          <button class="btn sm" @click="rotate">换一个</button>
          <button class="btn sm" @click="copy(st.code)">复制</button>
        </div>
        <p class="hint">
          每次开启服务都会重新生成，且只存在这台电脑的内存里。连错 10 次会锁定一分钟。
        </p>

        <div v-if="st.last" class="sync-last">
          上次同步：{{ when(st.last.at) }} · 来自 {{ st.last.addr }} ·
          <template v-if="st.last.stats">
            新增 {{ st.last.stats.added }} · 覆盖 {{ st.last.stats.updated }} · 删除
            {{ st.last.stats.removed }}
          </template>
        </div>

        <p class="hint warn">
          首次开启时 Windows 会弹出防火墙授权，<b>必须选「允许访问」</b>，否则手机连不上。
          误点了拒绝请到「Windows 防火墙 → 允许应用通过防火墙」里放行，或重开一次服务。
        </p>
      </template>

      <p v-if="syncState.merging" class="hint">正在合并来自手机的改动…</p>
      <p v-else-if="syncState.lastIncoming" class="hint">
        最近一次接收：新增 {{ syncState.lastIncoming.diff.added }} · 覆盖
        {{ syncState.lastIncoming.diff.updated }} · 删除 {{ syncState.lastIncoming.diff.removed }}
      </p>
    </template>

    <!-- ---------------- 手机 / 浏览器端：客户端 ---------------- -->
    <template v-else>
      <label class="label">电脑地址</label>
      <input v-model="settings.syncUrl" class="input" placeholder="192.168.1.5:8787" />

      <div style="height: 12px"></div>
      <label class="label">配对码</label>
      <input
        v-model="settings.syncCode"
        class="input narrow"
        inputmode="numeric"
        maxlength="6"
        placeholder="电脑上显示的 6 位数字"
      />

      <div style="height: 14px"></div>
      <div class="sync-row">
        <button class="btn sm" :disabled="busy" @click="doTest">
          {{ busy ? '请稍候…' : '测试连接' }}
        </button>
        <button class="btn sm primary" :disabled="busy" @click="doSync">立即同步</button>
      </div>

      <p v-if="testResult" class="hint" :class="{ ok: testResult.ok }">
        <template v-if="testResult.ok">
          已连上电脑（Novel Studio {{ testResult.info.version }}），可以点「立即同步」。
        </template>
        <template v-else>{{ testResult.message }}</template>
      </p>

      <p v-if="pushResult" class="hint" :class="{ ok: pushResult.ok }">
        <template v-if="pushResult.ok">
          同步完成：新增 {{ pushResult.diff.added }} · 覆盖 {{ pushResult.diff.updated }} · 删除
          {{ pushResult.diff.removed }}
        </template>
        <template v-else>{{ pushResult.message }}</template>
      </p>

      <p class="hint">
        同步是「互相补齐」，不是「用一方覆盖另一方」：两边独有的内容都会保留，
        删除也会传过去。第一次同步前建议先做一次全量备份。
      </p>
    </template>
  </div>
</template>

<style scoped>
.sync-panel {
  display: block;
}
.section-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.divider {
  height: 1px;
  background: var(--border);
  margin: 20px 0 16px;
}
.sync-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sync-row .input {
  flex: 1;
  min-width: 0;
}
.input.narrow {
  max-width: 140px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.hint.inline {
  margin: 0;
}
.hint.ok {
  color: var(--success);
}
.hint.warn {
  color: #b8860b;
}
.sync-addr {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
}
.sync-nic {
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 28px;
  letter-spacing: 6px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  padding: 4px 12px 4px 18px;
}
.sync-last {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.sync-conflicts {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  background: var(--bg-muted);
}
.sync-conflicts h5 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--danger);
}
.sync-conflict {
  border-top: 1px solid var(--border);
  padding-top: 10px;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-conflict-title {
  font-size: 13px;
  font-weight: 600;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.check input {
  accent-color: var(--accent);
  width: 15px;
  height: 15px;
}

@media (pointer: coarse) {
  .check input {
    width: 20px;
    height: 20px;
  }
}
</style>
