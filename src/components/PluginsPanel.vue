<script setup>
import { computed } from 'vue'
import { useSettings } from '../store/settings'
import { usePlugins } from '../store/plugins'
import { isDesktop } from '../services/platform'
import { toast } from '../store/toast'
import { pluginDisplayName, pluginHookCounts, PLUGIN_LIMITS } from '../services/plugins/manifest'

/**
 * 声明式插件设置（仅桌面端）。
 *
 * 插件是 `userData/plugins/*.json` 里的**纯数据**：本项目只读取、校验与
 * 应用其中四种声明（上下文片段 / 正则规则 / 导出模板 / 关键词提示），
 * **绝不执行插件代码**，插件也拿不到网络、密钥或文件系统。
 *
 * 这里的开关只写 `settings.plugins`，与设置面板其余字段一样由「保存」落盘；
 * 「重新读取」只重读目录，不改用户的选择。
 */
const { settings } = useSettings()
const plugins = usePlugins()
const desktop = isDesktop()

const state = plugins.store
const enabledGlobal = computed(() => settings.plugins?.enabled !== false)
const disabledIds = computed(() => settings.plugins?.disabledIds || [])

function isOn(id) {
  return !disabledIds.value.includes(id)
}

function toggle(id, on) {
  const list = disabledIds.value.filter((x) => x !== id)
  if (!on) list.push(id)
  settings.plugins.disabledIds = list
}

const total = computed(() => state.manifests.length)
const onCount = computed(() => state.manifests.filter((m) => isOn(m.id)).length)

async function reload() {
  const res = await plugins.load()
  if (res.ok) {
    toast(
      res.errors
        ? `已读取 ${res.manifests} 个插件，${res.errors} 个文件有问题`
        : `已读取 ${res.manifests} 个插件`,
      res.errors ? 'error' : 'success'
    )
  } else if (res.code !== 'unsupported') {
    toast(res.message || '读取插件目录失败', 'error')
  }
}

async function openFolder() {
  const res = await plugins.openFolder()
  if (res && res.ok === false) toast(res.message || '无法打开插件目录', 'error')
}
</script>

<template>
  <div class="plugins-panel">
    <div class="divider"></div>
    <h4 class="section-title">声明式插件</h4>

    <p class="hint">
      插件是放在软件数据目录下的 <code>*.json</code> 文本文件，可以给提示词补一段设定、
      在正文里查敏感词、提供导出模板或关键词提示。
      <b>本软件只读取这些声明，绝不执行插件代码</b>，插件也拿不到网络、API Key 或文件系统。
    </p>

    <p v-if="!desktop" class="hint warn">
      插件仅在桌面端可用。浏览器与 Android 版不读取插件目录，这一节在那些平台上不生效。
    </p>

    <template v-else>
      <label class="check">
        <input v-model="settings.plugins.enabled" type="checkbox" />
        启用插件（总开关）
      </label>
      <p class="hint">
        关闭后，插件不再影响提示词、一致性检查与导出模板；已读取的清单仍保留在内存里。
      </p>

      <div style="height: 10px"></div>
      <div class="row">
        <span class="hint inline">上下文预算</span>
        <input
          v-model.number="settings.plugins.contextBudget"
          class="input narrow"
          type="number"
          min="0"
          max="4000"
          step="50"
        />
        <span class="hint inline">token（0 = 不加载片段）</span>
      </div>

      <div style="height: 12px"></div>
      <div class="row">
        <button class="btn sm" :disabled="state.loading" @click="reload">
          {{ state.loading ? '读取中…' : '重新读取' }}
        </button>
        <button class="btn sm" @click="openFolder">打开插件目录</button>
        <span class="hint inline">
          共 {{ total }} 个插件<template v-if="total"> · 已启用 {{ onCount }} 个</template>
        </span>
      </div>

      <p v-if="state.dir" class="hint path">
        目录：<code>{{ state.dir }}</code>
      </p>
      <p v-if="state.skipped" class="hint warn">
        目录里另有 {{ state.skipped }} 个文件因数量上限（最多 {{ PLUGIN_LIMITS.maxFiles }} 个）
        未读取。
      </p>

      <div v-if="state.loaded && !total && !state.errors.length" class="hint empty">
        还没有插件。点「打开插件目录」，放一个 <code>*.json</code> 进去，再点「重新读取」。
      </div>

      <ul v-if="total" class="plugin-list">
        <li v-for="p in state.manifests" :key="p.id" class="plugin-item">
          <label class="check plugin-head">
            <input type="checkbox" :checked="isOn(p.id)" @change="toggle(p.id, $event.target.checked)" />
            <span class="plugin-name">{{ pluginDisplayName(p) }}</span>
            <span v-if="p.version" class="plugin-ver">v{{ p.version }}</span>
          </label>
          <p v-if="p.description" class="hint plugin-desc">{{ p.description }}</p>
          <p class="hint plugin-meta">
            <code>{{ p.id }}</code>
            · 上下文片段 {{ pluginHookCounts(p).fragments }}
            · 规则 {{ pluginHookCounts(p).rules }}
            · 模板 {{ pluginHookCounts(p).templates }}
            · 关键词提示 {{ pluginHookCounts(p).hints }}
            <template v-if="p.author"> · {{ p.author }}</template>
          </p>
        </li>
      </ul>

      <ul v-if="state.errors.length" class="plugin-errors">
        <li v-for="(e, i) in state.errors" :key="i" class="hint warn">
          <b>{{ e.file || '读取失败' }}</b>：{{ e.message }}
        </li>
      </ul>

      <p class="hint warn">
        插件规则来自第三方。正则匹配在每次一致性检查时对全书正文逐章执行，<b>过于复杂或写得不好
        的正则会明显拖慢应用</b>；对来源不明的插件，建议先在单人小项目上试用。插件不写数据库、
        不进全量备份，删除对应 JSON 文件后点「重新读取」即可卸载。
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
.input.narrow {
  max-width: 120px;
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
.hint.warn {
  color: #b8860b;
}
.hint.path,
.hint.empty {
  word-break: break-all;
}
.hint.empty {
  padding: 10px 12px;
  background: var(--bg-muted);
  border-radius: var(--radius-sm);
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
  flex-shrink: 0;
}
.plugin-list,
.plugin-errors {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}
.plugin-item {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}
.plugin-head {
  color: var(--text);
  font-weight: 600;
}
.plugin-ver {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}
.plugin-desc {
  margin-top: 6px;
  color: var(--text-2);
}
.plugin-meta {
  margin-top: 4px;
}
.plugin-errors li + li {
  margin-top: 6px;
}
</style>
