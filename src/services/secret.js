// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import { isDesktop } from './platform.js'

/**
 * 秘密（API Key、WebDAV 密码）安全存储的渲染层薄封装。
 *
 * - **桌面端**：走 Electron 主进程的 `safeStorage`，密文分别落在
 *   `userData/secure/api-key.bin` 与 `userData/secure/webdav-password.bin`，
 *   渲染层只拿得到明文返回值，拿不到密文文件。
 * - **浏览器 / Android**：没有系统级安全存储。API Key 退回 IndexedDB 明文，
 *   并由设置面板如实标注；**WebDAV 密码则直接不支持**（宁可让功能在移动端
 *   不可用，也不把服务器密码写进 IndexedDB）。
 *
 * 所有函数都返回 `{ ok, value?, code?, message? }`，不抛异常：设置加载是
 * 应用启动路径的一部分，一个不可用的密钥库不该让整个应用打不开。
 */

/** 允许的命名槽。未知槽在主进程返回 EINVAL，绝不悄悄落到 apiKey 上。 */
export const SECRET_SLOTS = ['apiKey', 'webdavPassword']

export function normalizeSecretSlot(slot) {
  const s = typeof slot === 'string' ? slot : ''
  return SECRET_SLOTS.includes(s) ? s : 'apiKey'
}

export function secureStorageAvailable() {
  return isDesktop() && !!window.electronAPI?.secretGet
}

const UNSUPPORTED = {
  ok: false,
  code: 'unsupported',
  message: '当前平台没有系统安全存储'
}

export async function readSecureSecret(slot = 'apiKey') {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  try {
    const res = await window.electronAPI.secretGet(normalizeSecretSlot(slot))
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}

/** 写入秘密；空字符串等同删除。 */
export async function writeSecureSecret(slot, value) {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  if (!value) return deleteSecureSecret(slot)
  try {
    const res = await window.electronAPI.secretSet(String(value), normalizeSecretSlot(slot))
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}

export async function deleteSecureSecret(slot = 'apiKey') {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  try {
    const res = await window.electronAPI.secretDelete(normalizeSecretSlot(slot))
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}

// ---- 兼容旧调用（apiKey 槽）----
export const readSecureApiKey = () => readSecureSecret('apiKey')
export const writeSecureApiKey = (key) => writeSecureSecret('apiKey', key)
export const deleteSecureApiKey = () => deleteSecureSecret('apiKey')

// ---- WebDAV 密码槽 ----
// 与 API Key 不同，这里**没有明文回退**：浏览器/Android 上直接返回 unsupported，
// 由界面把 WebDAV 同步标成「仅桌面端可用」。服务器密码落进 IndexedDB 的代价
// 比「移动端暂时用不了这个功能」大得多。
export const readSecureWebdavPassword = () => readSecureSecret('webdavPassword')
export const writeSecureWebdavPassword = (password) =>
  writeSecureSecret('webdavPassword', password)
export const deleteSecureWebdavPassword = () => deleteSecureSecret('webdavPassword')
