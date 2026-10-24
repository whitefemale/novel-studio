<script setup>
import { computed, ref } from 'vue'
import { useSettings } from '../store/settings'
import { isDesktop } from '../services/platform'
import { toast } from '../store/toast'
import { describeWebdavState } from '../services/sync/webdavConfig'
import {
  syncWithWebdav,
  testWebdav,
  webdavState,
  webdavSupported
} from '../services/sync/webdav'

/**
 * WebDAV 同步设置（仅桌面端）。
 *
 * 与「局域网同步」是两件事，措辞必须分清：
 * - 局域网同步：两台自己的设备在同一 Wi-Fi 下直连，电脑是服务端；
 * - WebDAV 同步：用户自己的 WebDAV 服务器当中转，多台设备各写自己的
 *   `<deviceId>.json`，每次同步先合并全部对端再上传。
 *
 * 两者都**不经过本项目的服务器**，也**都不包含 API Key**。
 *
 * 密码不放在 settings 里：它写入系统安全存储（safeStorage），只在
 * 「刚输入、还没保存」的那一次测试 / 同步调用里临时传给主进程。
 */
const { settings, persistWebdavPassword, clearWebdavPassword } = useSettings()
const desktop = isDesktop()
const supported = webdavSupported()

const passwordInput = ref('')
const showPassword = ref(false)
const busy = ref(false)
const testResult = ref(null)
const syncResult = ref(null)

const w = computed(() => settings.webdav)
const state = computed(() => describeWebdavState(settings.webdav))
const canRun = computed(() => supported && !busy.value && !webdavState.working)

/**
 * 用户刚敲进输入框、还没点「保存密码」时，先把它写进安全存储再发请求。
 * 写失败（例如系统安全存储不可用）就停在这里 —— 绝不退化成把密码塞进
 * 请求参数再寄希望于它「只是一次性的」。
 */
async function ensurePasswordSaved() {
  const pw = passwordInput.value
  if (!pw) return true
  if (!settings.secureKeyAvailable) {
    toast('系统安全存储不可用，无法保存 WebDAV 密码', 'error')
    return false
  }
  const res = await persistWebdavPassword(pw)
  if (!res.ok) {
    toast(res.message || '密码保存失败', 'error')
    return false
  }
  passwordInput.value = ''
  return true
}

async function savePassword() {
  if (!passwordInput.value) {
    toast('请先输入密码', 'error')
    return
  }
  if (await ensurePasswordSaved()) toast('密码已加密保存（不会写入数据库或备份）', 'success')
}

async function removePassword() {
  await clearWebdavPassword()
  passwordInput.value = ''
  toast('已清除本机保存的 WebDAV 密码', 'success')
}

async function doTest() {
  if (!(await ensurePasswordSaved())) return
  busy.value = true
  testResult.value = null
  try {
    const res = await testWebdav()
    testResult.value = res
    if (res.ok) {
      toast(res.created ? '连接成功，已创建远程目录' : '连接成功', 'success')
    }
  } finally {
    busy.value = false
  }
}

async function doSync() {
  if (!(await ensurePasswordSaved())) return
  busy.value = true
  syncResult.value = null
  try {
    const res = await syncWithWebdav()
    syncResult.value = res
    if (res.skipped === 'busy') {
      toast('正在生成正文，本次未同步，稍后再试', 'error')
    } else if (res.ok) {
      const d = res.stats || { added: 0, updated: 0, removed: 0 }
      toast(`WebDAV 同步完成：新增 ${d.added} · 覆盖 ${d.updated} · 删除 ${d.removed}`, 'success')
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="webdav-panel">
    <div class="divider"></div>
    <h4 class="section-title">WebDAV 同步</h4>

    <p class="hint">
      把小说与设定备份到你<b>自己的 WebDAV 服务器</b>（坚果云、Nextcloud、群晖等），
      多台设备各自写一个文件、每次先合并再上传。数据只存在你的服务器上，
      <b>不经过本项目的任何服务</b>，也<b>不包含 API Key</b>。
    </p>

    <p v-if="!desktop || !supported" class="hint warn">
      WebDAV 同步仅在桌面端可用。移动端没有系统级安全存储，我们不把服务器密码
      写进应用数据库；手机上请使用上一节的局域网同步。
    </p>

    <template v-else>
      <div class="row">
        <label class="check">
          <input v-model="settings.webdav.enabled" type="checkbox" />
          启用 WebDAV 同步
        </label>
      </div>

      <div style="height: 12px"></div>
      <label class="label">服务器地址</label>
      <input
        v-model="settings.webdav.url"
        class="input"
        placeholder="https://dav.example.com/dav"
        spellcheck="false"
      />
      <p class="hint">
        填 WebDAV 根地址（以 http:// 或 https:// 开头），不要带查询串。
        明文 http 只在你的内网可信时使用——密码会以 Basic 认证发送。
      </p>

      <div style="height: 12px"></div>
      <div class="row two">
        <label class="field">
          <span class="label">用户名</span>
          <input v-model="settings.webdav.username" class="input" autocomplete="username" />
        </label>
        <label class="field">
          <span class="label">密码</span>
          <input
            v-model="passwordInput"
            class="input"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="settings.webdavPasswordSet ? '已加密保存（留空则不修改）' : '未设置'"
            autocomplete="current-password"
          />
        </label>
      </div>
      <div class="row">
        <button class="btn sm" :disabled="!passwordInput" @click="savePassword">保存密码</button>
        <button class="btn sm" @click="showPassword = !showPassword">
          {{ showPassword ? '隐藏' : '显示' }}
        </button>
        <button
          v-if="settings.webdavPasswordSet"
          class="btn sm"
          @click="removePassword"
        >
          清除密码
        </button>
      </div>
      <p class="hint">
        密码由系统安全存储（Windows DPAPI）加密后放在本机，<b>不写入数据库、不进备份、
        不参与同步</b>。换电脑或重装系统后需要重新输入。
      </p>

      <div style="height: 12px"></div>
      <label class="label">远程目录</label>
      <input
        v-model="settings.webdav.remoteDir"
        class="input"
        placeholder="novel-studio"
        spellcheck="false"
      />
      <p class="hint">
        相对于上面的根地址，会自动创建。每台设备写一个
        <code>设备标识.json</code>，不会互相覆盖同一个文件。
      </p>

      <div style="height: 12px"></div>
      <label class="check">
        <input v-model="settings.webdav.autoSync" type="checkbox" />
        自动同步（仅在软件运行时）
      </label>
      <div class="row" style="margin-top: 8px">
        <span class="hint inline">间隔</span>
        <input
          v-model.number="settings.webdav.intervalSec"
          class="input narrow"
          type="number"
          min="60"
          max="86400"
          step="30"
        />
        <span class="hint inline">秒（最小 60）</span>
      </div>

      <div style="height: 8px"></div>
      <label class="check">
        <input v-model="settings.webdav.conflictCopies" type="checkbox" />
        同章冲突时保留另一版副本（推荐）
      </label>
      <p class="hint">
        关闭后同章冲突按「后改的赢」，被覆盖的正文无法找回。正文是唯一不可再生的内容，
        建议保持开启。
      </p>

      <div style="height: 14px"></div>
      <div class="row">
        <button class="btn sm" :disabled="!canRun" @click="doTest">
          {{ busy ? '请稍候…' : '测试连接' }}
        </button>
        <button class="btn sm primary" :disabled="!canRun" @click="doSync">
          {{ webdavState.working || busy ? '同步中…' : '立即同步' }}
        </button>
        <span class="hint inline">
          上次：{{ state.label }}<template v-if="state.when"> · {{ state.when }}</template>
        </span>
      </div>

      <p v-if="testResult" class="hint" :class="{ ok: testResult.ok }">
        <template v-if="testResult.ok">
          已连上 WebDAV 服务器<template v-if="testResult.created">，并创建了远程目录</template>。
        </template>
        <template v-else>{{ testResult.message }}</template>
      </p>

      <p v-if="state.error" class="hint warn">上次失败：{{ state.error }}</p>

      <div v-if="syncResult" class="result">
        <p class="hint" :class="{ ok: syncResult.ok }">
          <template v-if="syncResult.skipped === 'busy'">正在生成正文，本次未同步。</template>
          <template v-else-if="syncResult.ok">
            合并：新增 {{ syncResult.stats.added }} · 覆盖 {{ syncResult.stats.updated }} ·
            删除 {{ syncResult.stats.removed }}
            <template v-if="syncResult.peers.length">
              · 已合并 {{ syncResult.peers.length }} 台设备（{{ syncResult.peers.join('、') }}）
            </template>
            <template v-if="syncResult.conflicts"> · 冲突副本 {{ syncResult.conflicts }} 份</template>
            · {{ Math.round((syncResult.bytes || 0) / 1024) }} KB
          </template>
          <template v-else>{{ syncResult.message }}</template>
        </p>
        <p v-for="(msg, i) in syncResult.warnings || []" :key="i" class="hint warn">
          {{ msg }}
        </p>
        <p v-if="syncResult.retries" class="hint">
          因远程文件被改动，重新合并了 {{ syncResult.retries }} 次。
        </p>
      </div>

      <p class="hint">
        同步是「先合并全部设备、再上传自己」的一次往返，<b>不是实时协作</b>：
        同一时刻两端改了同一章仍会保留冲突副本。自动同步会跳过正在生成正文的时刻。
      </p>
    </template>
  </div>
</template>

<style scoped>
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
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.row.two {
  align-items: flex-end;
}
.row.two .field {
  flex: 1;
  min-width: 140px;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
.result {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  background: var(--bg-muted);
}
@media (pointer: coarse) {
  .check input {
    width: 20px;
    height: 20px;
  }
}
</style>
