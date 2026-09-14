<script setup>
import { ref } from 'vue'
import { useSettings } from '../store/settings'
import { chatStream } from '../services/llm'
import { isDesktop } from '../services/platform'
import { toast } from '../store/toast'

const emit = defineEmits(['close'])
const { settings, persist } = useSettings()

const showKey = ref(false)
const testing = ref(false)
const pickingDir = ref(false)
// 「保存与导出」整节只在桌面端有意义：移动端导出走系统分享面板，没有可配置的目录
const desktop = isDesktop()

async function save() {
  if (!settings.baseUrl.trim()) {
    toast('请填写接口地址', 'error')
    return
  }
  await persist()
  toast('设置已保存', 'success')
  emit('close')
}

async function chooseDir() {
  if (!window.electronAPI?.chooseDirectory) return
  pickingDir.value = true
  try {
    const res = await window.electronAPI.chooseDirectory({ defaultPath: settings.saveDir || '' })
    if (res && !res.canceled && res.dir) settings.saveDir = res.dir
  } catch {
    toast('无法打开目录选择器', 'error')
  } finally {
    pickingDir.value = false
  }
}

async function openSaveDir() {
  if (!settings.saveDir) return
  await window.electronAPI?.openFolder({ dir: settings.saveDir })
}

async function testConnection() {
  if (!settings.apiKey) {
    toast('请先填写 API Key', 'error')
    return
  }
  testing.value = true
  const { abort } = chatStream({
    settings: { ...settings, maxTokens: 1, temperature: 0 },
    messages: [{ role: 'user', content: 'ping' }],
    callbacks: {
      onDelta: () => {},
      onDone: () => {
        testing.value = false
        toast('连接成功 ✓', 'success')
      },
      onError: (msg) => {
        testing.value = false
        toast(`连接失败：${msg}`, 'error')
      },
      onAborted: () => {
        testing.value = false
      }
    }
  })
  // 10 秒未完成则视为超时
  setTimeout(() => {
    if (testing.value) {
      testing.value = false
      abort()
      toast('连接超时，请检查地址与网络', 'error')
    }
  }, 10000)
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal wide">
      <div class="modal-header">
        <h3>设置</h3>
        <button class="btn ghost sm" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <h4 class="section-title">AI 接口</h4>

        <label class="label">接口地址 Base URL（OpenAI 兼容）</label>
        <input v-model="settings.baseUrl" class="input" placeholder="https://api.deepseek.com" />
        <p class="hint">支持 DeepSeek、Kimi、通义千问、GLM、OpenAI 等任何 OpenAI 兼容接口，填厂商文档中的 base_url 即可。</p>

        <div style="height: 14px"></div>
        <label class="label">API Key</label>
        <div class="key-row">
          <input
            v-model="settings.apiKey"
            class="input"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
            autocomplete="off"
          />
          <button class="btn sm" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        </div>

        <div style="height: 14px"></div>
        <label class="label">模型名</label>
        <input v-model="settings.model" class="input" placeholder="deepseek-chat" />

        <div style="height: 14px"></div>
        <!-- 手工改坏过的持久化数据可能是字符串或 undefined，先兜底再格式化 -->
        <label class="label">温度：{{ Number(settings.temperature || 0).toFixed(1) }}（越高越有创意）</label>
        <input
          v-model.number="settings.temperature"
          type="range"
          min="0"
          max="2"
          step="0.1"
          class="range"
        />

        <div style="height: 14px"></div>
        <label class="label">单次最大 Token：{{ settings.maxTokens }}</label>
        <input v-model.number="settings.maxTokens" type="range" min="512" max="8192" step="256" class="range" />

        <div style="height: 14px"></div>
        <label class="label">续写时携带最近章节数：{{ settings.contextChapters }}</label>
        <input v-model.number="settings.contextChapters" type="range" min="0" max="8" step="1" class="range" />

        <div style="height: 14px"></div>
        <div class="checks">
          <label class="check">
            <input v-model="settings.includeOutline" type="checkbox" />
            生成时携带故事大纲
          </label>
          <label class="check">
            <input v-model="settings.includeCharacters" type="checkbox" />
            生成时携带人物设定
          </label>
          <label class="check">
            <input v-model="settings.includeWorld" type="checkbox" />
            生成时携带世界观
          </label>
        </div>

        <!-- 保存与导出（仅桌面端） -->
        <template v-if="desktop">
          <div class="divider"></div>
          <h4 class="section-title">保存与导出</h4>

          <label class="label">小说保存地址</label>
          <div class="key-row">
            <!-- readonly：路径只能来自原生选择器，不接受手输 -->
            <input
              :value="settings.saveDir"
              class="input"
              readonly
              placeholder="未设置 —— 导出时会弹出保存对话框"
            />
            <button class="btn sm" :disabled="pickingDir" @click="chooseDir">
              {{ pickingDir ? '选择中…' : '选择…' }}
            </button>
            <button v-if="settings.saveDir" class="btn sm" @click="openSaveDir">打开</button>
            <button v-if="settings.saveDir" class="btn sm" @click="settings.saveDir = ''">清除</button>
          </div>
          <p class="hint">
            设置后，「导出」会直接写入该目录，不再弹框；文件名冲突时自动加序号，不会覆盖已有文件。
          </p>

          <div style="height: 14px"></div>
          <label class="label">导出方式</label>
          <div class="seg">
            <button
              class="seg-btn"
              :class="{ active: settings.exportMode === 'direct' }"
              @click="settings.exportMode = 'direct'"
            >
              直接存到保存地址
            </button>
            <button
              class="seg-btn"
              :class="{ active: settings.exportMode === 'ask' }"
              @click="settings.exportMode = 'ask'"
            >
              每次询问
            </button>
          </div>

          <div style="height: 14px"></div>
          <div class="checks">
            <label class="check">
              <input v-model="settings.perBookFolder" type="checkbox" />
              在保存地址下按书名建立子文件夹
            </label>
            <label class="check">
              <input v-model="settings.openFolderAfterExport" type="checkbox" />
              导出后在资源管理器中定位文件
            </label>
          </div>

          <div class="divider"></div>
          <h4 class="section-title">自动备份</h4>

          <div class="checks">
            <label class="check">
              <input v-model="settings.autoBackup" type="checkbox" />
              定时自动备份当前小说
            </label>
          </div>

          <template v-if="settings.autoBackup">
            <div style="height: 14px"></div>
            <label class="label">备份间隔：每 {{ settings.backupInterval }} 分钟</label>
            <input
              v-model.number="settings.backupInterval"
              type="range"
              min="1"
              max="60"
              step="1"
              class="range"
            />

            <div style="height: 14px"></div>
            <label class="label">每本书最多保留：{{ settings.backupKeep }} 份</label>
            <input
              v-model.number="settings.backupKeep"
              type="range"
              min="1"
              max="100"
              step="1"
              class="range"
            />
            <p class="hint">
              备份写入「保存地址 / 书名 / 备份 /」，超出保留份数的旧备份会被自动删除，不会堆满硬盘。
              需要先设置保存地址。
            </p>
          </template>
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" :disabled="testing" @click="testConnection">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <div class="spacer"></div>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存设置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.key-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.key-row .input {
  flex: 1;
  min-width: 0;
}
.range {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
.spacer {
  flex: 1;
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
.seg {
  display: flex;
  gap: 8px;
}
.seg-btn {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-2);
  transition: all 0.15s ease;
}
.seg-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* 触屏下把复选框与分段按钮放大到可点 */
@media (pointer: coarse) {
  .check input {
    width: 20px;
    height: 20px;
  }
  .seg-btn {
    padding: 11px 0;
  }
}
</style>
