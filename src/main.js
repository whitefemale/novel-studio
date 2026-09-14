import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import * as db from './services/storage'
import { useBooks } from './store/books'
import { useSettings, defaultSettings } from './store/settings'
import { buildMessages } from './services/prompts'
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
import { chatStream, parseSseLine, buildChatUrl } from './services/llm'

createApp(App).mount('#app')

// 自动化测试钩子：供 Electron 冒烟测试驱动核心逻辑
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
  buildChatUrl
}
