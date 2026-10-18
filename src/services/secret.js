// 显式带 .js，供 Node 原生 ESM（tests/unit）加载。
import { isDesktop } from './platform.js'

/**
 * API Key 安全存储的渲染层薄封装。
 *
 * - **桌面端**：走 Electron 主进程的 `safeStorage`，密文落在
 *   `userData/secure/api-key.bin`，渲染层只拿得到明文返回值，拿不到密文文件。
 * - **浏览器 / Android**：没有系统级安全存储。这两个平台退回 IndexedDB 明文，
 *   并由设置面板如实标注 —— 不说「已加密」，也不假装这是安全的。
 *
 * 所有函数都返回 `{ ok, value?, code?, message? }`，不抛异常：设置加载是
 * 应用启动路径的一部分，一个不可用的密钥库不该让整个应用打不开。
 */

export function secureStorageAvailable() {
  return isDesktop() && !!window.electronAPI?.secretGet
}

const UNSUPPORTED = {
  ok: false,
  code: 'unsupported',
  message: '当前平台没有系统安全存储'
}

export async function readSecureApiKey() {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  try {
    const res = await window.electronAPI.secretGet()
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}

/** 写入密钥；空字符串等同删除。 */
export async function writeSecureApiKey(key) {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  if (!key) return deleteSecureApiKey()
  try {
    const res = await window.electronAPI.secretSet(String(key))
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}

export async function deleteSecureApiKey() {
  if (!secureStorageAvailable()) return { ...UNSUPPORTED }
  try {
    const res = await window.electronAPI.secretDelete()
    if (!res || typeof res !== 'object') {
      return { ok: false, code: 'EBADRESPONSE', message: '安全存储返回了无效结果' }
    }
    return res
  } catch {
    return { ok: false, code: 'EIPC', message: '无法访问系统安全存储' }
  }
}
