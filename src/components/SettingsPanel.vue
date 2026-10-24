<script setup>
import { ref } from 'vue'
import { useSettings } from '../store/settings'
import { chatStream } from '../services/llm'
import { describeError } from '../services/ai/errors'
import { isDesktop } from '../services/platform'
import { toast } from '../store/toast'
import { TASK_MODEL_KEYS, TASK_MODEL_LABELS } from '../services/ai/models'
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  isPresetApplied
} from '../services/ai/providers'
import SyncPanel from './SyncPanel.vue'
import WebDavPanel from './WebDavPanel.vue'
import PluginsPanel from './PluginsPanel.vue'

const emit = defineEmits(['close'])
const { settings, persist, persistApiKey, clearApiKey } = useSettings()

const showKey = ref(false)
const testing = ref(false)
const pickingDir = ref(false)
const confirmDeleteKey = ref(false)
const presets = PROVIDER_PRESETS

function presetOf(id) {
  return getProviderPreset(id)
}

/**
 * 把预设的地址与建议模型填进表单。
 *
 * 只在用户**主动点按钮**时执行：切换下拉框本身不动 baseUrl，因为那会让
 * 「我只是想看看有哪些服务商」变成一次静默的地址改写。
 * API Key 永远不动 —— 它属于当前服务商，换预设不该顺手清掉。
 */
function applyPreset() {
  const p = presetOf(settings.providerId)
  if (!p || !p.baseUrl) return
  settings.baseUrl = p.baseUrl
  if (p.models.length && !p.models.includes(settings.model)) settings.model = p.models[0]
  toast(`已填入 ${p.label} 的预设地址`, 'success')
}
// 「保存与导出」整节只在桌面端有意义：移动端导出走系统分享面板，没有可配置的目录
const desktop = isDesktop()

async function save() {
  if (!settings.baseUrl.trim()) {
    toast('请填写接口地址', 'error')
    return
  }
  // API Key 的落点由平台决定：桌面端进 safeStorage 密文文件，其余平台进 IndexedDB。
  // 失败时 persistApiKey 已回退明文并保存，这里只负责如实告知。
  const keyRes = await persistApiKey()
  if (!keyRes.ok) {
    toast(`设置已保存，但 API Key 未能加密：${keyRes.message || '已改用明文存储'}`, 'error')
  } else if (keyRes.secure) {
    toast('设置已保存（API Key 已加密存储）', 'success')
  } else {
    toast('设置已保存', 'success')
  }
  emit('close')
}

async function removeKey() {
  if (!confirmDeleteKey.value) {
    confirmDeleteKey.value = true
    return
  }
  await clearApiKey()
  confirmDeleteKey.value = false
  toast('API Key 已删除', 'success')
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
      onError: (info) => {
        testing.value = false
        const msg = typeof info === 'string' ? info : describeError(info, { includeDetail: false })
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

        <label class="label">服务商</label>
        <div class="key-row">
          <select v-model="settings.providerId" class="input">
            <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
          <button
            class="btn sm"
            :disabled="!presetOf(settings.providerId) || !presetOf(settings.providerId).baseUrl"
            @click="applyPreset"
          >填入预设地址</button>
        </div>
        <p class="hint">
          切换服务商不会改动已填的 API Key。所有服务商都走 OpenAI 兼容接口，
          下面两栏始终是真正生效的配置。
        </p>

        <label class="label">接口地址 Base URL（OpenAI 兼容）</label>
        <input v-model="settings.baseUrl" class="input" placeholder="https://api.deepseek.com" />
        <p class="hint">支持 DeepSeek、Kimi、通义千问、GLM、OpenAI 等任何 OpenAI 兼容接口，填厂商文档中的 base_url 即可。</p>
        <p v-if="!isPresetApplied(settings)" class="hint">
          当前地址与所选服务商的预设不同，将以你填写的地址为准。
        </p>

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
          <button
            class="btn sm danger"
            :disabled="!settings.apiKey"
            @click="removeKey"
          >{{ confirmDeleteKey ? '确认删除？' : '删除' }}</button>
        </div>
        <p v-if="desktop && settings.secureKeyAvailable" class="hint">
          ✅ 已使用系统安全存储（Electron safeStorage）加密保存。密钥不会写入 IndexedDB、全量备份或局域网同步。
        </p>
        <p v-else-if="desktop" class="hint">
          ⚠ 系统安全存储不可用{{ settings.secureKeyError ? `（${settings.secureKeyError}）` : '' }}，API Key 将以明文保存在本机 IndexedDB。若这是共用电脑，请改用其他机器的设置。
        </p>
        <p v-else class="hint">
          ⚠ 浏览器 / Android 没有系统级安全存储，API Key 以明文保存在本机 IndexedDB（不会上传到任何服务器）。
        </p>

        <div style="height: 14px"></div>
        <label class="label">模型名</label>
        <input v-model="settings.model" class="input" placeholder="deepseek-chat" />

        <details class="model-split">
          <summary>按任务分模型（可选）</summary>
          <p class="hint">
            留空 = 使用上面的「模型名」。写正文看重文笔，提取记忆看重严格输出 JSON，
            审校看重长上下文 —— 想分开配就在这里逐项填。
          </p>
          <div v-for="key in TASK_MODEL_KEYS" :key="key" class="model-row">
            <label class="label">{{ TASK_MODEL_LABELS[key] }}</label>
            <input
              v-model="settings.models[key]"
              class="input"
              :placeholder="settings.model || '继承通用模型'"
            />
          </div>
        </details>

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
          <label class="check">
            <input v-model="settings.includeStyle" type="checkbox" />
            生成时携带当前启用的文风档案
          </label>
        </div>

        <div class="divider"></div>
        <h4 class="section-title">记忆与上下文</h4>
        <label class="label">上下文预算：{{ settings.contextBudget }} tokens</label>
        <input
          v-model.number="settings.contextBudget"
          type="range"
          min="2000"
          max="32000"
          step="500"
          class="range"
        />
        <p class="hint">
          实际可用 = 预算 − 单次最大 Token（{{ settings.maxTokens }}）− 安全余量 256。
          给输出预留空间是必需的，否则模型没有余量写正文。
        </p>
        <div class="checks" style="margin-top: 10px">
          <label class="check">
            <input v-model="settings.autoExtractMemory" type="checkbox" />
            写完自动提取记忆
          </label>
          <label class="check">
            <input v-model="settings.reviewHighRisk" type="checkbox" />
            高风险变更必须人工确认
          </label>
          <label class="check">
            <input v-model="settings.autoApplyLowRisk" type="checkbox" />
            低风险变更直接入库
          </label>
        </div>
        <p class="hint">
          关掉「低风险直接入库」后，所有 AI 提取的变更都会进入控制台的「记忆审阅」；
          每条变更都会记录原文依据，并可在「最近变更」里撤销。
        </p>

        <div class="checks" style="margin-top: 10px">
          <label class="check">
            <input v-model="settings.rag.enabled" type="checkbox" />
            生成时检索相关历史片段（本地字面检索）
          </label>
        </div>
        <p class="hint">
          默认关闭。开启后会在生成前从已写正文里按**字面相似度**（单字 + 双字 + 英文词）
          召回少量片段，注入提示词；它不是语义模型，同义词与代词指代召回不到。
          索引只保存在本机，不进全量备份与设备同步。片段数与 token 预算可在
          控制台「检索」标签里调整与试跑。
        </p>

        <div class="divider"></div>
        <h4 class="section-title">预算（可选）</h4>
        <div class="budget-grid">
          <label class="budget-field">
            <span>单次上限（元）</span>
            <input v-model.number="settings.budgetPerCall" class="input" type="number" min="0" step="0.1" />
          </label>
          <label class="budget-field">
            <span>每日上限（元）</span>
            <input v-model.number="settings.budgetDaily" class="input" type="number" min="0" step="0.1" />
          </label>
          <label class="budget-field">
            <span>超出时</span>
            <select v-model="settings.budgetAction" class="input">
              <option value="warn">只提示，照常生成</option>
              <option value="confirm">要求点「继续生成」</option>
            </select>
          </label>
        </div>
        <p class="hint">
          0 = 不限制。金额按上面的本机价目表估算，不是服务商账单；价目表里没有的模型
          会如实显示「价格未知」，不会按 0 元处理。每日上限只统计本书已载入的生成记录。
        </p>

        <!--
          下面两节都在 v-if="desktop" **之外**：
          版本历史三个平台都有；局域网同步在电脑端配的是服务本身、手机端配的是「连哪台电脑」。
        -->
        <div class="divider"></div>
        <h4 class="section-title">章节版本</h4>
        <label class="label">每章最多保留：{{ settings.versionKeep }} 版</label>
        <input
          v-model.number="settings.versionKeep"
          type="range"
          min="1"
          max="50"
          step="1"
          class="range"
        />
        <p class="hint">
          AI 覆盖正文、手动存档、回滚前、删章前都会各留一版。超出的最旧版本会被清理，
          <b>清理只在本机进行</b>，不会把另一台设备上保留的版本一起删掉。
        </p>

        <SyncPanel />

        <!--
          WebDAV 是「用户自建服务器」这条路线，与上面的局域网直连不是同一件事。
          组件在非桌面端只显示一句说明，所以这里不包 v-if：
          SettingsPanel 的保存按钮按同一份 settings 落盘，藏起来反而让人以为没保存。
        -->
        <WebDavPanel />

        <!--
          插件同样不包 v-if：组件自己会在非桌面端显示「仅桌面端可用」，
          这样手机用户知道有这回事，而不是以为软件没有这个功能。
        -->
        <PluginsPanel />

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

.model-split {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.model-split > summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.model-row {
  margin-top: 10px;
}
.budget-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.budget-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
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
