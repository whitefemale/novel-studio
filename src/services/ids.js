/**
 * 全局唯一 id 生成器。
 *
 * 从 books.js 抽出来共用：V2 的十几个新实体与三个新 store 都要建 id，
 * 各写一份迟早会分叉。
 *
 * crypto.randomUUID 在三个目标平台都可用（Electron 的 Chromium、现代浏览器、
 * Android WebView —— minSdk 24 的 WebView 视版本而定，故保留下面那条回落分支）。
 * 回落的 id 不做密码学意义上的唯一性保证，只保证本机不撞。
 */
export function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}
