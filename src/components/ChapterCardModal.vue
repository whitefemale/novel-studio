<script setup>
import { ref, computed, onMounted } from 'vue'
import { useBooks } from '../store/books'
import { useCollections } from '../store/novel'
import { useSettings } from '../store/settings'
import { useGeneration } from '../store/generation'
import { usePlugins } from '../store/plugins'
import {
  ALL_CHAPTER_PLAN_FIELDS,
  CHAPTER_PLAN_STATUS,
  entityTitle,
  ENTITY_SCHEMAS
} from '../services/novel/schemas'
import {
  splitLockedBeats,
  missingLockedBeats,
  normalizePlanDraft,
  buildPlanProposal,
  proposalPatch
} from '../services/novel/planning'
import { checkChapterPlan } from '../services/novel/planCheck'
import {
  validatePlan,
  shouldBlockPlan,
  validationSummary,
  PLAN_ISSUE_LABELS
} from '../services/novel/planValidate'
import { runChapterWorkflow } from '../services/ai/orchestrator'
import { retrieveRagContext } from '../services/rag/context'
import * as db from '../services/storage'
import { toast } from '../store/toast'

/**
 * 章节施工卡：把「这一章要写成什么样」写成 AI 必须遵守的硬约束。
 *
 * 与「大纲」的区别是本组件存在的理由：大纲是写给人看的故事梗概，施工卡是写给
 * AI 的执行要求（视角、必须发生什么、禁止出现什么、验收标准）。AI 生成的草稿
 * **绝不直接落库**——用户先看到、再保存；锁定节点被触碰时更是只生成提案。
 */
const props = defineProps({
  chapterId: { type: String, required: true }
})
const emit = defineEmits(['close', 'saved'])

const { store, saveChapterPlan } = useBooks()
const cols = useCollections()
const { settings } = useSettings()
const gen = useGeneration()
const plugins = usePlugins()

const chapter = computed(() => store.chapters.find((c) => c.id === props.chapterId) || null)

const form = ref({})
const dirty = ref(false)
const saving = ref(false)
const confirmArmed = ref(false)

const statusLabel = computed(
  () => CHAPTER_PLAN_STATUS.find((s) => s.value === (chapter.value?.planStatus || 'none'))?.label || '未填写'
)

const locked = computed(() => splitLockedBeats(form.value.lockedBeats))
const missing = computed(() => missingLockedBeats(normalizePlanDraft(form.value), form.value.lockedBeats))

const planCheck = computed(() => {
  const c = chapter.value
  if (!c) return null
  return checkChapterPlan(
    { ...c, ...normalizePlanDraft(form.value) },
    c.content || '',
    { characters: cols.list('characters') }
  )
})

/**
 * 生成前校验：跟着表单实时重算。
 *
 * 与 AI 阶段里的那次校验用的是同一个纯函数；这里再算一遍是为了让用户改完
 * 一行字就能看到问题消失，而不是必须重新生成一次计划（那是要花钱的）。
 */
const validation = computed(() => {
  const c = chapter.value
  if (!c) return null
  return validatePlan({
    plan: normalizePlanDraft(form.value),
    chapter: c,
    book: store.book,
    chapters: store.chapters,
    memory: cols.memory.store,
    structure: cols.structure.store,
    options: settings.planValidation || {}
  })
})

const blocking = computed(() =>
  shouldBlockPlan(validation.value, { blockHigh: settings.planValidation?.blockHigh !== false })
)

/** 高风险问题被用户显式放行。任何一次输入都会把它复位。 */
const override = ref(false)

function severityLabel(s) {
  return { high: '高', medium: '中', low: '低' }[s] || s
}

function adoptAnyway() {
  override.value = true
  toast('已选择「仍然采用」，保存时会记下这次放行', 'info')
}

const characterOptions = computed(() => cols.list('characters'))

function blank() {
  const o = {}
  for (const f of ALL_CHAPTER_PLAN_FIELDS) {
    o[f.key] = f.type === 'number' ? 0 : ''
  }
  return o
}

function loadForm() {
  const c = chapter.value
  const o = blank()
  for (const f of ALL_CHAPTER_PLAN_FIELDS) {
    const v = c?.[f.key]
    if (v != null) o[f.key] = f.type === 'number' ? Number(v) || 0 : String(v)
  }
  form.value = o
  dirty.value = false
  confirmArmed.value = false
  override.value = false
}

function onInput() {
  dirty.value = true
  confirmArmed.value = false
  // 改了任何一行都可能让问题消失：放行是一次性的，不跟着表单走。
  override.value = false
}

async function save(confirm = false) {
  const id = props.chapterId
  if (!id || saving.value) return null
  if (blocking.value && !override.value) {
    toast('生成前校验发现高风险问题，请先处理，或点「仍然采用」再保存', 'error')
    return null
  }
  saving.value = true
  try {
    const patch = normalizeDraftForSave()
    // 只存摘要（版本号 + 时间 + 是否放行 + 问题 id）。完整报告随正文变化而
    // 失效，存下来只会变成过期噪音；「我放行过」这件事则值得留痕。
    patch.planValidation = validationSummary(validation.value, Date.now(), {
      overridden: override.value
    })
    const res = await saveChapterPlan(id, patch, { confirm })
    if (!res) {
      toast('这本书已经关了，无法保存施工卡', 'error')
      return null
    }
    dirty.value = false
    confirmArmed.value = false
    toast(confirm ? '施工卡已确认' : '施工卡草稿已保存', 'success')
    emit('saved', res)
    return res
  } catch (e) {
    console.error('[chapter-card] 保存失败', e)
    toast('保存失败：' + String((e && e.message) || e), 'error')
    return null
  } finally {
    saving.value = false
  }
}

function normalizeDraftForSave() {
  const out = {}
  for (const f of ALL_CHAPTER_PLAN_FIELDS) {
    out[f.key] = f.type === 'number' ? Number(form.value[f.key]) || 0 : String(form.value[f.key] ?? '').trim()
  }
  return out
}

function onConfirmClick() {
  if (!confirmArmed.value) {
    confirmArmed.value = true
    return
  }
  save(true)
}

// ---------------- AI 生成计划 ----------------

const planBusy = ref(false)
const planError = ref('')
const proposals = ref([])

function proposalLabel(p) {
  return p.missingBeats?.[0] || '锁定节点'
}

async function loadProposals() {
  if (!store.bookId) return
  const list = await db.coll.planProposals.getAll(store.bookId)
  proposals.value = list.filter((p) => p.chapterId === props.chapterId && p.status === 'pending')
}

async function generatePlan() {
  if (planBusy.value) return
  const c = chapter.value
  if (!c) return
  if (!settings.apiKey) {
    toast('请先在设置里填 API Key', 'error')
    return
  }
  planBusy.value = true
  planError.value = ''
  try {
    await cols.loadForBook(store.bookId)
    // 把表单里的**当前草稿**交给 Context Builder：用户可能刚补了两条硬约束，
    // 生成计划时应当看到它们，而不是库里那份旧的。
    const draftChapter = { ...c, ...normalizePlanDraft(form.value) }
    const input = {
      book: store.book,
      bookId: store.bookId,
      chapter: draftChapter,
      chapters: store.chapters,
      outlines: store.outlines,
      memory: cols.memory.store,
      structure: cols.structure.store,
      styleProfiles: cols.structure.store.styleProfiles || [],
      settings: settings,
      action: 'plan',
      text: c.content || ''
    }
    // 检索到的历史片段对「生成施工卡」同样有用：作者要写的这一章与几十章前
    // 埋的伏笔有关时，计划草案里才可能提到它。失败返回空数组，不影响生成。
    input.ragPassages = await retrieveRagContext(input, settings)
    // 插件片段与手动续写、队列共用同一条装配路径，模板/规则在各入口一致。
    input.pluginFragments = plugins.fragments()
    const wf = await runChapterWorkflow({
      input,
      settings,
      stages: ['plan'],
      recordRun: gen.recordRun
    })
    if (wf.run.status === 'error') {
      planError.value = wf.error || '计划生成失败'
    } else if (!wf.planDraft) {
      planError.value = '模型没有返回可解析的施工卡 JSON，见「生成历史」里的原始输出'
    } else {
      const draft = normalizePlanDraft(wf.planDraft)
      const missingBeats = missingLockedBeats(draft, form.value.lockedBeats)
      if (missingBeats.length) {
        // 触碰锁定节点：只落提案，不把草稿填进表单。用户接受之前，章节里的
        // 那份计划一字不动。
        const proposal = buildPlanProposal({
          bookId: store.bookId,
          chapterId: c.id,
          current: { ...c, ...normalizePlanDraft(form.value) },
          proposed: draft,
          reportRunId: wf.run.id || ''
        })
        if (proposal) {
          await db.coll.planProposals.upsert(store.bookId, proposal)
          await loadProposals()
        }
        toast(`AI 计划缺失 ${missingBeats.length} 个锁定节点，已生成待确认提案`, 'info')
      } else {
        // 不自动保存，只回填表单供预览。用户点「保存草稿 / 确认施工卡」才落库。
        for (const f of ALL_CHAPTER_PLAN_FIELDS) {
          if (f.type === 'number') {
            if (draft[f.key] != null) form.value[f.key] = Number(draft[f.key]) || 0
          } else if (f.key !== 'lockedBeats' && draft[f.key] != null) {
            form.value[f.key] = draft[f.key]
          }
        }
        dirty.value = true
        override.value = false
        toast(
          wf.planBlocked
            ? `AI 计划草案已填入，但有 ${wf.planValidation?.stats?.high ?? 0} 条高风险问题，保存前需确认`
            : 'AI 计划草案已填入，检查后请手动保存',
          wf.planBlocked ? 'error' : 'success'
        )
      }
    }
  } catch (e) {
    console.error('[chapter-card] AI 计划失败', e)
    planError.value = String((e && e.message) || e)
  } finally {
    planBusy.value = false
  }
}

async function markProposal(p, status) {
  try {
    await db.coll.planProposals.upsert(store.bookId, { ...p, status, updatedAt: Date.now() })
    await loadProposals()
  } catch (e) {
    console.error('[chapter-card] 提案状态更新失败', e)
    toast('提案状态更新失败：' + String((e && e.message) || e), 'error')
  }
}

async function acceptProposal(p) {
  const patch = proposalPatch(p)
  for (const f of ALL_CHAPTER_PLAN_FIELDS) {
    if (patch[f.key] == null) continue
    form.value[f.key] = f.type === 'number' ? Number(patch[f.key]) || 0 : patch[f.key]
  }
  const saved = await save(false)
  if (saved) await markProposal(p, 'accepted')
}

async function rejectProposal(p) {
  await markProposal(p, 'rejected')
}

onMounted(async () => {
  loadForm()
  if (store.bookId) {
    await cols.loadForBook(store.bookId)
    await loadProposals()
  }
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal cc">
      <div class="modal-header">
        <h3>章节施工卡 · {{ chapter ? `第${chapter.order}章 ${chapter.title || ''}` : '章节不存在' }}</h3>
        <button class="btn ghost sm" @click="emit('close')">关闭</button>
      </div>

      <div class="modal-body">
        <p class="cc-hint">
          施工卡是给 AI 的**硬约束**，不是大纲。填了才会注入提示词；全部留空即维持原行为。
          当前状态：<b>{{ statusLabel }}</b>
          <template v-if="chapter?.planVersion">（第 {{ chapter.planVersion }} 版已确认）</template>
        </p>

        <div class="cc-grid">
          <label v-for="f in ALL_CHAPTER_PLAN_FIELDS" :key="f.key" class="cc-field" :class="{ wide: f.type === 'textarea' || f.key === 'lockedBeats' }">
            <span>
              {{ f.label }}
              <template v-if="f.key === 'lockedBeats' && locked.length">
                · {{ locked.length }} 条
              </template>
            </span>
            <select
              v-if="f.key === 'povCharacterId'"
              v-model="form[f.key]"
              class="select"
              @change="onInput"
            >
              <option value="">（未指定）</option>
              <option v-for="c in characterOptions" :key="c.id" :value="c.id">
                {{ entityTitle(ENTITY_SCHEMAS.characters, c) }}
              </option>
            </select>
            <input
              v-else-if="f.type === 'number'"
              v-model.number="form[f.key]"
              class="input"
              type="number"
              min="0"
              @input="onInput"
            />
            <textarea
              v-else
              v-model="form[f.key]"
              class="textarea"
              rows="2"
              @input="onInput"
            />
          </label>
        </div>

        <div v-if="planCheck" class="cc-check" :class="{ bad: !planCheck.ok }">
          <b>施工卡自检：</b>
          <span v-if="planCheck.ok">必填项与目标字数的形状没问题。</span>
          <template v-else>
            <span>发现 {{ planCheck.issues.length }} 条提示：</span>
            <ul>
              <li v-for="(it, i) in planCheck.issues" :key="i">[{{ it.severity }}] {{ it.message }}</li>
            </ul>
          </template>
          <span v-if="missing.length" class="cc-missing">
            当前表单缺失 {{ missing.length }} 个锁定节点。
          </span>
        </div>

        <div
          v-if="validation && validation.issues.length"
          class="cc-validate"
          :class="{ bad: blocking }"
        >
          <div class="cc-validate-head">
            <b>生成前校验：</b>
            <span v-if="blocking" class="cc-strong">
              发现 {{ validation.stats.high }} 条高风险问题
            </span>
            <span v-else>发现 {{ validation.stats.total }} 条提醒</span>
            <span class="cc-small">只做字面匹配，宁可漏报</span>
          </div>
          <ul>
            <li v-for="it in validation.issues" :key="it.id">
              <span class="cc-sev" :class="it.severity">{{ severityLabel(it.severity) }}</span>
              <span class="cc-cat">{{ PLAN_ISSUE_LABELS[it.category] || it.category }}</span>
              {{ it.message }}
              <div v-if="it.evidence" class="cc-evidence">证据：{{ it.evidence }}</div>
            </li>
          </ul>
          <div v-if="blocking" class="cc-override">
            <span v-if="!override">高风险问题不会被静默忽略；你可以作主：</span>
            <span v-else>已选择「仍然采用」，保存时会记下这次放行。</span>
            <button v-if="!override" class="btn sm" @click="adoptAnyway">仍然采用</button>
          </div>
        </div>

        <div class="cc-ai">
          <div class="cc-ai-head">
            <b>AI 生成本章计划</b>
            <span>手动触发，**会真实调用模型并计费**；草案不会自动保存。</span>
          </div>
          <div class="cc-ai-ops">
            <button class="btn sm primary" :disabled="planBusy || !chapter" @click="generatePlan">
              {{ planBusy ? '生成中…' : '生成计划草案' }}
            </button>
            <span v-if="locked.length" class="cc-small">锁定节点 {{ locked.length }} 条，触碰时只生成提案</span>
          </div>
          <p v-if="planError" class="cc-err">{{ planError }}</p>

          <div v-if="proposals.length" class="cc-proposals">
            <div class="cc-small">待确认提案（不会改动当前施工卡）</div>
            <div v-for="p in proposals" :key="p.id" class="cc-proposal">
              <span class="cc-proposal-title">AI 未保留：{{ p.missingBeats.join('；') }}</span>
              <span class="cc-proposal-ops">
                <button class="btn sm" @click="acceptProposal(p)">接受并填入</button>
                <button class="btn sm ghost" @click="rejectProposal(p)">拒绝</button>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" :disabled="saving" @click="emit('close')">关闭</button>
        <button class="btn" :disabled="saving || !chapter" @click="save(false)">
          {{ saving ? '保存中…' : '保存草稿' }}
        </button>
        <button
          class="btn primary"
          :class="{ danger: confirmArmed }"
          :disabled="saving || !chapter"
          @click="onConfirmClick"
        >
          {{ confirmArmed ? '再点一次确认锁定' : '确认施工卡' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.cc {
  max-width: 760px;
  width: calc(100vw - 32px);
}
.cc-hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.cc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px 14px;
}
.cc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.cc-field.wide {
  grid-column: 1 / -1;
}
.cc-check {
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-3);
}
.cc-check.bad {
  border-color: #d5a021;
}
.cc-check ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.cc-missing {
  display: block;
  color: var(--danger);
}
.cc-validate {
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
}
.cc-validate.bad {
  border-color: #d5a021;
  background: #fffbf0;
}
.cc-validate-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cc-strong {
  color: var(--danger);
  font-weight: 600;
}
.cc-validate ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.cc-validate li + li {
  margin-top: 4px;
}
.cc-sev {
  display: inline-block;
  min-width: 28px;
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 3px;
  text-align: center;
  font-size: 11px;
  color: #fff;
  background: var(--text-3);
}
.cc-sev.high {
  background: var(--danger);
}
.cc-sev.medium {
  background: #d5a021;
}
.cc-sev.low {
  background: #8a949f;
}
.cc-cat {
  margin-right: 4px;
  color: var(--text-3);
}
.cc-evidence {
  color: var(--text-3);
  font-size: 11px;
  word-break: break-all;
}
.cc-override {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}
.cc-ai {
  margin-top: 14px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cc-ai-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--text-3);
}
.cc-ai-ops {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cc-small {
  font-size: 12px;
  color: var(--text-3);
}
.cc-err {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.cc-proposals {
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cc-proposal {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.cc-proposal-title {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
}
.cc-proposal-ops {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
