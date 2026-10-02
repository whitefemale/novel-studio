import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import * as db from './services/storage'
import { useBooks } from './store/books'
import { useSettings, defaultSettings } from './store/settings'
import { buildMessages, messagesFromContext, collectOutlineText } from './services/prompts'
import { buildContext, buildLayers, allocate } from './services/novel/contextBuilder'
import {
  ENTITY_SCHEMAS,
  injectableFields,
  entityTitle,
  renderEntity,
  extractionSpec,
  ACTIVE_FORESHADOW_STATUS
} from './services/novel/schemas'
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
  normalizeTitle,
  SCHEMA_VERSION
} from './services/migration'
import { useNovelMemory, MEMORY_COLLECTIONS } from './store/novelMemory'
import { useStoryStructure, STRUCTURE_COLLECTIONS } from './store/storyStructure'
import { useGeneration, aggregateRuns, describeRun } from './store/generation'
import {
  runChapterWorkflow,
  buildExtractionMessages,
  buildReviewTask,
  extractJson,
  classifyRisk,
  riskReason,
  normalizeExtractedItem,
  diffMemoryCandidates,
  describeChange,
  applyChange,
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
  STALE_CHAPTERS
} from './services/novel/consistency'
import {
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
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION
} from './services/novel/snapshot'
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
  normalizeTitle,
  SCHEMA_VERSION,

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
  ENTITY_SCHEMAS,
  injectableFields,
  entityTitle,
  renderEntity,
  extractionSpec,
  ACTIVE_FORESHADOW_STATUS,

  // ---- V2：AI 编排器 ----
  runChapterWorkflow,
  buildExtractionMessages,
  buildReviewTask,
  extractJson,
  classifyRisk,
  riskReason,
  normalizeExtractedItem,
  diffMemoryCandidates,
  describeChange,
  applyChange,
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
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,

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
  STALE_CHAPTERS
}
