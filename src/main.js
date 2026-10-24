import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import * as db from './services/storage'
import { useBooks } from './store/books'
import { useSettings, defaultSettings } from './store/settings'
import { buildMessages, messagesFromContext, collectOutlineText } from './services/prompts'
import {
  buildContext,
  buildLayers,
  allocate,
  PROMPT_VERSION
} from './services/novel/contextBuilder'
import {
  ENTITY_SCHEMAS,
  injectableFields,
  entityTitle,
  renderEntity,
  extractionSpec,
  ACTIVE_FORESHADOW_STATUS,
  FACT_LAYERS,
  FACT_LAYER_LABELS,
  NON_FACT_LAYERS,
  CONFIRM_STATUSES,
  NON_INJECTABLE_CONFIRM,
  BOOK_PLAN_FIELDS,
  CHAPTER_PLAN_FIELDS,
  ALL_CHAPTER_PLAN_FIELDS,
  LOCKED_BEATS_FIELD,
  CHAPTER_PLAN_STATUS,
  SCENE_STATUS,
  isBookPlanEmpty,
  renderBookPlan
} from './services/novel/schemas'
import {
  entityNames,
  relevanceOf,
  rankEntities,
  eventRelevance,
  mentionedIds,
  snippetAround,
  searchBook,
  relatedEntities
} from './services/novel/retrieval'
import {
  CONFLICT_TITLE_PREFIX,
  CONFLICT_ID_PREFIX,
  CONFLICTS_COLLECTION,
  conflictCopyId,
  conflictRecordId,
  isConflictCopy,
  baselineTime,
  makeChapterBaseline,
  detectChapterConflicts,
  applyConflictCopies,
  updatePeerBaseline,
  isConflictStale
} from './services/sync/conflicts'
import {
  buildTxt,
  buildMarkdown,
  buildChapterText,
  buildChapterMarkdown,
  sanitizeFileName,
  buildBackupName,
  buildExportTarget,
  buildBackupTarget,
  pickStaleBackups,
  saveToDisk
} from './services/export'
import { createAutosaver } from './services/autosave'
import { chatStream, parseSseLine, parseSseUsage, parseSseChunk, buildChatUrl } from './services/llm'
import { genId } from './services/ids'
import { countWords } from './services/wordCount'
import {
  DEFAULT_PRICING,
  normalizePricing,
  findPrice,
  estimateTokens,
  computeCost,
  providerFromUrl,
  formatTokens,
  formatCost
} from './services/ai/tokenUsage'
import {
  planMigration,
  planMigrationForBook,
  applyMigration,
  ensureSchemaVersion,
  recordMigrationReport,
  normalizeTitle,
  SCHEMA_VERSION
} from './services/migration'
import { useNovelMemory, MEMORY_COLLECTIONS } from './store/novelMemory'
import { useStoryStructure, STRUCTURE_COLLECTIONS } from './store/storyStructure'
import { useGeneration, aggregateRuns, describeRun } from './store/generation'
import {
  TASK_MODEL_KEYS,
  TASK_MODEL_LABELS,
  defaultTaskModels,
  normalizeTaskModels,
  modelForStage,
  settingsForStage
} from './services/ai/models'
import { dayStart, spentOnDay, estimateCall, checkBudget } from './services/ai/budget'
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  inferProviderId,
  normalizeProviderId,
  normalizeProviderSettings,
  createProvider,
  providerLabel,
  isPresetApplied
} from './services/ai/providers'
import {
  activeStyleProfile,
  renderStyleProfile,
  styleProfileText,
  describeStyleProfile
} from './services/novel/style'
import { buildStats, DENSITY_BUCKET } from './services/novel/stats'
import {
  runChapterWorkflow,
  buildExtractionMessages,
  buildReviewTask,
  buildPlanTask,
  buildFixTask,
  extractJson,
  classifyRisk,
  riskReason,
  normalizeExtractedItem,
  diffMemoryCandidates,
  describeChange,
  applyChange,
  undoMemoryChange,
  commitChanges,
  STAGE_LABELS,
  DEFAULT_STAGES
} from './services/ai/orchestrator'

import {
  buildVersion,
  pruneVersions,
  sortVersions,
  captureVersion,
  listVersions,
  groupVersions,
  versionDelta,
  sourceLabel,
  removeVersionsForChapter,
  VERSION_SOURCES,
  DEFAULT_VERSION_KEEP
} from './services/novel/versioning'
import {
  buildTimeline,
  findBrokenRefs,
  refFields,
  TIMELINE_KINDS,
  TIMELINE_SORTS
} from './services/novel/timeline'
import {
  runRuleChecks,
  CONSISTENCY_RULES,
  severityLabel,
  timeKey,
  STALE_CHAPTERS,
  MAIN_THREAD_MARK,
  MAIN_THREAD_STALLED,
  SUBPLOT_STALLED,
  DENSITY_WINDOW,
  DENSITY_RATIO,
  NO_CHANGE_MIN
} from './services/novel/consistency'
import { splitLines, splitSentences, diffLinesOf, diffText, collapsedDiff } from './services/novel/diff'
import {
  splitPlanTerms,
  matchesTerm,
  planCompleteness,
  checkChapterPlan
} from './services/novel/planCheck'
import {
  PLAN_PROPOSAL_STATUSES,
  splitLockedBeats,
  missingLockedBeats,
  normalizePlanDraft,
  buildPlanProposal,
  proposalPatch
} from './services/novel/planning'
import {
  REVIEW_ISSUE_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_CATEGORIES,
  REVIEW_CATEGORY_LABELS,
  contentHashOf,
  normalizeReviewIssue,
  flattenReviewReport,
  isIssueStale,
  stateMap,
  saveIssueStates,
  setIssueStatus,
  listIssueStates
} from './services/novel/reviewIssues'
import {
  buildSnapshot,
  mergeSnapshot,
  applyTombstones,
  mergeTombstones,
  mergeRecords,
  mergeBookRecords,
  BOOK_POINTER_FIELDS,
  BOOK_POINTER_STAMP,
  LOCAL_ONLY_COLLECTIONS,
  snapshotStats,
  diffSnapshots,
  parseSnapshotJson,
  toSnapshotJson,
  collectSnapshot,
  applySnapshot,
  normalizeSnapshot,
  emptySnapshot,
  stableStringify,
  fnv1a32,
  snapshotChecksum,
  snapshotCounts,
  finalizeSnapshot,
  cloneSnapshotAsNewBooks,
  isQuotaError,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION
} from './services/novel/snapshot'
import {
  TASK_STATUSES,
  RECOVERABLE_STATUSES,
  TASK_STATUS_LABELS,
  createTaskRecord,
  appendDraft,
  settleTaskRecord,
  shouldFlushDraft,
  markRunningInterrupted,
  isRecoverable,
  pickRecoverable,
  pruneTasks,
  taskSummary,
  loadTasks
} from './services/ai/taskStore'
import {
  classifyError,
  redactSecrets,
  shouldRetry,
  computeBackoff,
  parseRetryAfter,
  describeError,
  ERROR_CATEGORIES,
  RETRYABLE_CATEGORIES
} from './services/ai/errors'
import {
  chatStreamReliable,
  isTruncatedFinishReason,
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MAX_RETRIES
} from './services/ai/request'
import {
  PLAN_VALIDATION_VERSION,
  PLAN_ISSUE_CATEGORIES,
  PLAN_ISSUE_LABELS,
  DEFAULT_REPETITION_WINDOW,
  REPETITION_THRESHOLD,
  normalizePlanCandidate,
  validatePlan,
  shouldBlockPlan,
  validationSummary,
  bigramDice
} from './services/novel/planValidate'
import {
  resolvePointerChapter,
  derivePointers,
  pickChapterAfterDelete,
  pointersEqual,
  pointerPatch
} from './services/novel/pointers'
import {
  QUEUE_STATUSES,
  QUEUE_STATUS_LABELS,
  QUEUE_ACTIVE_STATUSES,
  QUEUE_RETRYABLE_STATUSES,
  MAX_RESULT_CHARS,
  canTransition,
  isTerminalStatus,
  capResultText,
  createQueueItem,
  normalizeQueueItem,
  sortQueueItems,
  transitionQueueItem,
  nextRunnable,
  recoverQueueItems,
  queueSummary,
  queueItemTitle,
  hasUsableResult,
  queueBudgetExceeded
} from './services/ai/queue'
import { createQueueRunner } from './services/ai/queueRunner'
import { useWritingQueue, queueStore } from './store/writingQueue'
import {
  EMBEDDING_VERSION,
  EMBEDDING_DIM,
  embeddingTokens,
  embedTokens,
  embedText,
  buildIdf,
  applyIdf,
  cosineSimilarity
} from './services/rag/hashEmbedding'
import {
  chunkChapter,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_MAX_CHUNKS
} from './services/rag/chunking'
import { searchRag, RAG_TOP_K, RAG_MIN_SCORE, RAG_MAX_PER_CHAPTER } from './services/rag/search'
import {
  ensureBookIndex,
  getRagIndexStatus,
  clearBookIndex,
  ragChunkId,
  RAG_COLLECTION
} from './services/rag/indexer'
import {
  buildRagQueryText,
  ragExcludeChapterIds,
  retrieveRagContext
} from './services/rag/context'
import {
  GRAPH_NODE_KINDS,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_KIND_MAP,
  GRAPH_LIMITS,
  normalizeGraphName,
  parseRelationshipText,
  buildRelationshipGraph,
  layoutRelationshipGraph
} from './services/novel/graph'
import {
  parseDavBase,
  normalizeRemoteDir as normalizeDavRemoteDir,
  snapshotPath as davSnapshotPath,
  snapshotFilesFromHrefs,
  parseDavHrefs,
  describeDavStatus,
  shouldRetryDavStatus,
  describeWebdavState,
  DAV_MAX_BYTES
} from './services/sync/webdavConfig'
import {
  syncWithWebdav,
  testWebdav,
  webdavState,
  webdavSupported
} from './services/sync/webdav'
import {
  defaultPlanValidation,
  normalizePlanValidation,
  defaultRagSettings,
  normalizeRagSettings,
  defaultWebdavSettings,
  normalizeWebdavSettings,
  normalizeRemoteDirInput,
  defaultPluginSettings,
  normalizePluginSettings,
  deriveDeviceName
} from './services/settingsExtras'
import {
  PLUGIN_SCHEMA_VERSION,
  PLUGIN_LIMITS,
  HOOK_KEYS,
  RULE_SEVERITIES,
  RULE_FLAGS_ALLOWED,
  TEMPLATE_PLACEHOLDERS,
  validatePluginManifest,
  normalizePluginList,
  pluginDisplayName,
  pluginHookCounts
} from './services/plugins/manifest'
import {
  activePlugins,
  pluginContextFragments,
  runPluginRules,
  collectKeywordHints,
  renderTemplateChapters,
  renderExportTemplate,
  validateTemplatePlaceholders,
  pluginTemplates,
  describePluginHooks
} from './services/plugins/hooks'
import { usePlugins, pluginState } from './store/plugins'
import { APP_VERSION } from './version'
import {
  setUiHooks,
  syncState,
  handleIncomingSnapshot,
  reloadAfterSync,
  normalizeSyncUrl,
  testConnection,
  pushSnapshot,
  startSyncServer,
  stopSyncServer,
  rotateSyncCode,
  syncStatus,
  SYNC_MAX_BYTES
} from './services/sync'

createApp(App).mount('#app')

// 自动化测试钩子：供 Electron 冒烟测试驱动核心逻辑。
//
// 注意 db 是 `import * as db` 的整个模块命名空间，所以 storage.js 里新增的任何
// 导出（coll / addTombstone / getTombstones / getMeta / saveMeta / listRawKeys /
// addBookTombstone / COLLECTIONS …）都自动出现在 window.__ns.db 上，不必逐个列。
//
// 约定：**纯函数不加进这里等于没被测试**。新增可单测的纯函数时一并加进来。
window.__ns = {
  db,
  useBooks,
  useSettings,
  defaultSettings,
  buildMessages,
  buildTxt,
  buildMarkdown,
  buildChapterText,
  buildChapterMarkdown,
  sanitizeFileName,
  buildBackupName,
  buildExportTarget,
  buildBackupTarget,
  pickStaleBackups,
  saveToDisk,
  createAutosaver,
  chatStream,
  parseSseLine,
  parseSseUsage,
  parseSseChunk,
  buildChatUrl,

  // ---- V2：id / 字数 / 用量与成本 ----
  genId,
  countWords,
  DEFAULT_PRICING,
  normalizePricing,
  findPrice,
  estimateTokens,
  computeCost,
  providerFromUrl,
  formatTokens,
  formatCost,

  // ---- V2：迁移 ----
  planMigration,
  planMigrationForBook,
  applyMigration,
  ensureSchemaVersion,
  recordMigrationReport,
  normalizeTitle,
  SCHEMA_VERSION,
  APP_VERSION,

  // ---- V2：新 store ----
  useNovelMemory,
  MEMORY_COLLECTIONS,
  useStoryStructure,
  STRUCTURE_COLLECTIONS,
  useGeneration,
  aggregateRuns,
  describeRun,

  // ---- V2：Context Builder 与实体 schema ----
  messagesFromContext,
  collectOutlineText,
  buildContext,
  buildLayers,
  allocate,
  PROMPT_VERSION,
  ENTITY_SCHEMAS,
  injectableFields,
  entityTitle,
  renderEntity,
  extractionSpec,
  ACTIVE_FORESHADOW_STATUS,
  FACT_LAYERS,
  FACT_LAYER_LABELS,
  NON_FACT_LAYERS,
  CONFIRM_STATUSES,
  NON_INJECTABLE_CONFIRM,

  // ---- V3 阶段 5：多模型 / 预算 / 文风 / 统计 ----
  TASK_MODEL_KEYS,
  TASK_MODEL_LABELS,
  defaultTaskModels,
  normalizeTaskModels,
  modelForStage,
  settingsForStage,
  dayStart,
  spentOnDay,
  estimateCall,
  checkBudget,
  activeStyleProfile,
  renderStyleProfile,
  styleProfileText,
  describeStyleProfile,
  buildStats,
  DENSITY_BUCKET,

  // ---- V3 阶段 3：检索与相关性 ----
  entityNames,
  relevanceOf,
  rankEntities,
  eventRelevance,
  mentionedIds,
  snippetAround,
  searchBook,
  relatedEntities,

  // ---- V3 阶段 3：同步冲突副本 ----
  CONFLICT_TITLE_PREFIX,
  CONFLICT_ID_PREFIX,
  CONFLICTS_COLLECTION,
  conflictCopyId,
  conflictRecordId,
  isConflictCopy,
  baselineTime,
  makeChapterBaseline,
  detectChapterConflicts,
  applyConflictCopies,
  updatePeerBaseline,
  isConflictStale,

  // ---- V2：AI 编排器 ----
  runChapterWorkflow,
  buildExtractionMessages,
  buildReviewTask,
  buildPlanTask,
  buildFixTask,
  extractJson,
  classifyRisk,
  riskReason,
  normalizeExtractedItem,
  diffMemoryCandidates,
  describeChange,
  applyChange,
  undoMemoryChange,
  commitChanges,
  STAGE_LABELS,
  DEFAULT_STAGES,

  // ---- V2：全量快照（第二阶段同步的协议本体） ----
  buildSnapshot,
  mergeSnapshot,
  applyTombstones,
  mergeTombstones,
  mergeRecords,
  snapshotStats,
  diffSnapshots,
  parseSnapshotJson,
  toSnapshotJson,
  collectSnapshot,
  applySnapshot,
  normalizeSnapshot,
  emptySnapshot,
  stableStringify,
  fnv1a32,
  snapshotChecksum,
  snapshotCounts,
  finalizeSnapshot,
  cloneSnapshotAsNewBooks,
  isQuotaError,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,

  // ---- V3 阶段 1：流式草稿 / 崩溃恢复 ----
  TASK_STATUSES,
  RECOVERABLE_STATUSES,
  TASK_STATUS_LABELS,
  createTaskRecord,
  appendDraft,
  settleTaskRecord,
  shouldFlushDraft,
  markRunningInterrupted,
  isRecoverable,
  pickRecoverable,
  pruneTasks,
  taskSummary,
  loadTasks,

  // ---- V3 阶段 2：错误分类 / 重试 / 超时 / 截断 ----
  classifyError,
  redactSecrets,
  shouldRetry,
  computeBackoff,
  parseRetryAfter,
  describeError,
  ERROR_CATEGORIES,
  RETRYABLE_CATEGORIES,
  chatStreamReliable,
  isTruncatedFinishReason,
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MAX_RETRIES,

  // ---- V2：局域网同步（电脑端服务控制 + 客户端 + 事件中枢）----
  setUiHooks,
  syncState,
  handleIncomingSnapshot,
  reloadAfterSync,
  normalizeSyncUrl,
  testConnection,
  pushSnapshot,
  startSyncServer,
  stopSyncServer,
  rotateSyncCode,
  syncStatus,
  SYNC_MAX_BYTES,

  // ---- V2：章节版本 ----
  buildVersion,
  pruneVersions,
  sortVersions,
  captureVersion,
  listVersions,
  groupVersions,
  versionDelta,
  sourceLabel,
  removeVersionsForChapter,
  VERSION_SOURCES,
  DEFAULT_VERSION_KEEP,

  // ---- V2：时间线（warnings 同时是一致性规则 #1） ----
  buildTimeline,
  findBrokenRefs,
  refFields,
  TIMELINE_KINDS,
  TIMELINE_SORTS,

  // ---- V2：一致性检查（规则部分；AI 深检是编排器的 review 阶段） ----
  runRuleChecks,
  CONSISTENCY_RULES,
  severityLabel,
  timeKey,
  STALE_CHAPTERS,
  MAIN_THREAD_MARK,
  MAIN_THREAD_STALLED,
  SUBPLOT_STALLED,
  DENSITY_WINDOW,
  DENSITY_RATIO,
  NO_CHANGE_MIN,

  // ---- V3 阶段 4：版本差异 ----
  splitLines,
  splitSentences,
  diffLinesOf,
  diffText,
  collapsedDiff,

  // ---- V3 阶段 4：施工卡与计划提案 ----
  BOOK_PLAN_FIELDS,
  CHAPTER_PLAN_FIELDS,
  ALL_CHAPTER_PLAN_FIELDS,
  LOCKED_BEATS_FIELD,
  CHAPTER_PLAN_STATUS,
  SCENE_STATUS,
  isBookPlanEmpty,
  renderBookPlan,
  buildPlanTask,
  buildFixTask,
  splitPlanTerms,
  matchesTerm,
  planCompleteness,
  checkChapterPlan,
  PLAN_PROPOSAL_STATUSES,
  splitLockedBeats,
  missingLockedBeats,
  normalizePlanDraft,
  buildPlanProposal,
  proposalPatch,

  // ---- V3 阶段 4：审校问题生命周期 ----
  REVIEW_ISSUE_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_CATEGORIES,
  REVIEW_CATEGORY_LABELS,
  contentHashOf,
  normalizeReviewIssue,
  flattenReviewReport,
  isIssueStale,
  stateMap,
  saveIssueStates,
  setIssueStatus,
  listIssueStates,

  // ---- V4 阶段 1：服务商预设与 Provider ----
  PROVIDER_PRESETS,
  getProviderPreset,
  inferProviderId,
  normalizeProviderId,
  normalizeProviderSettings,
  createProvider,
  providerLabel,
  isPresetApplied,

  // ---- V4 阶段 3：生成前计划校验 ----
  PLAN_VALIDATION_VERSION,
  PLAN_ISSUE_CATEGORIES,
  PLAN_ISSUE_LABELS,
  DEFAULT_REPETITION_WINDOW,
  REPETITION_THRESHOLD,
  normalizePlanCandidate,
  validatePlan,
  shouldBlockPlan,
  validationSummary,
  bigramDice,

  // ---- V4 阶段 4：持久化写作队列 ----
  QUEUE_STATUSES,
  QUEUE_STATUS_LABELS,
  QUEUE_ACTIVE_STATUSES,
  QUEUE_RETRYABLE_STATUSES,
  MAX_RESULT_CHARS,
  canTransition,
  isTerminalStatus,
  capResultText,
  createQueueItem,
  normalizeQueueItem,
  sortQueueItems,
  transitionQueueItem,
  nextRunnable,
  recoverQueueItems,
  queueSummary,
  queueItemTitle,
  hasUsableResult,
  queueBudgetExceeded,
  createQueueRunner,
  useWritingQueue,
  queueStore,

  // ---- V4 阶段 5：本地哈希检索（RAG） ----
  EMBEDDING_VERSION,
  EMBEDDING_DIM,
  embeddingTokens,
  embedTokens,
  embedText,
  buildIdf,
  applyIdf,
  cosineSimilarity,
  chunkChapter,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_MAX_CHUNKS,
  searchRag,
  RAG_TOP_K,
  RAG_MIN_SCORE,
  RAG_MAX_PER_CHAPTER,
  ensureBookIndex,
  getRagIndexStatus,
  clearBookIndex,
  ragChunkId,
  RAG_COLLECTION,
  buildRagQueryText,
  ragExcludeChapterIds,
  retrieveRagContext,

  // ---- V4 阶段 6：人物关系图（纯派生，不写库） ----
  GRAPH_NODE_KINDS,
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_KIND_MAP,
  GRAPH_LIMITS,
  normalizeGraphName,
  parseRelationshipText,
  buildRelationshipGraph,
  layoutRelationshipGraph,

  // ---- V4 阶段 2：书籍指针 ----
  resolvePointerChapter,
  derivePointers,
  pickChapterAfterDelete,
  pointersEqual,
  pointerPatch,

  // ---- V4 阶段 0：快照指针与本地态集合 ----
  mergeBookRecords,
  BOOK_POINTER_FIELDS,
  BOOK_POINTER_STAMP,
  LOCAL_ONLY_COLLECTIONS,
  defaultPlanValidation,
  normalizePlanValidation,
  defaultRagSettings,
  normalizeRagSettings,
  defaultWebdavSettings,
  normalizeWebdavSettings,
  normalizeRemoteDirInput,
  defaultPluginSettings,
  normalizePluginSettings,
  deriveDeviceName,

  // ---- V4 阶段 7：WebDAV 同步 ----
  parseDavBase,
  normalizeDavRemoteDir,
  davSnapshotPath,
  snapshotFilesFromHrefs,
  parseDavHrefs,
  describeDavStatus,
  shouldRetryDavStatus,
  describeWebdavState,
  DAV_MAX_BYTES,
  syncWithWebdav,
  testWebdav,
  webdavState,
  webdavSupported,

  // ---- V4 阶段 8：声明式插件（只读纯数据，绝不执行代码） ----
  PLUGIN_SCHEMA_VERSION,
  PLUGIN_LIMITS,
  HOOK_KEYS,
  RULE_SEVERITIES,
  RULE_FLAGS_ALLOWED,
  TEMPLATE_PLACEHOLDERS,
  validatePluginManifest,
  normalizePluginList,
  pluginDisplayName,
  pluginHookCounts,
  activePlugins,
  pluginContextFragments,
  runPluginRules,
  collectKeywordHints,
  renderTemplateChapters,
  renderExportTemplate,
  validateTemplatePlaceholders,
  pluginTemplates,
  describePluginHooks,
  usePlugins,
  pluginState
}
