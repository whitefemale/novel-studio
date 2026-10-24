import { reactive } from 'vue'
import * as db from '../storage'
import { isDesktop } from '../platform'
import { useSettings } from '../../store/settings'
import { useBooks } from '../../store/books'
import { useGeneration } from '../../store/generation'
import { deriveDeviceName } from '../settingsExtras'
import { collectSnapshot, toSnapshotJson } from '../novel/snapshot'
import { handleIncomingSnapshot, refreshUiAfterSync } from '../sync'
import {
  DAV_MAX_BYTES,
  DAV_SNAPSHOT_SUFFIX,
  describeDavStatus,
  headerValue,
  isEtagConflict,
  normalizeDeviceFileId,
  normalizeEtag,
  normalizeRemoteDir,
  parseDavBase,
  parseDavHrefs,
  remoteDirPath,
  remoteFilePath,
  snapshotFilesFromHrefs,
  snapshotPath
} from './webdavConfig'

/**
 * WebDAV 同步（渲染层）。
 *
 * 与局域网同步共用**同一套合并协议**：对每个对端文件调用
 * `handleIncomingSnapshot(..., { reload: false })`，它内部走 `applySnapshot`，
 * 等于走「恢复全量备份」那条路。冲突检测、冲突副本、墓碑判死、设备基线
 * 全都不在这里重写——一份规则只能有一个实现。
 *
 * 文件布局刻意是「每台设备一个文件」：
 *
 *     <remoteDir>/<deviceId>.json
 *
 * 这样两台设备同时同步不会互相覆盖同一个文件。代价是「读到的最新版本」
 * 取决于「先拉后推」的顺序，所以每次都会先把所有对端合并进来、再上传。
 * ETag 只在「同一个文件被另一个进程写过」时才会冲突（例如同一份 userData
 * 被复制到两台机器），仍然按 412 重拉合并、最多重试两次。
 *
 * **不做 CRDT、不做实时共编、不发 LOCK**：这是合并式同步，不是协同编辑。
 * 同一章两端都改仍按局域网同步的老规矩保留冲突副本。
 */

export const webdavState = reactive({
  /** 正在跑一次同步（界面据此禁用按钮） */
  working: false,
  /** 最近一次结果摘要，UI 直接读，不另存副本 */
  lastResult: null
})

/** 最多同时合并多少台对端的文件。再多的话一次同步会拖很久。 */
const MAX_PEERS = 20

export function webdavSupported() {
  return isDesktop() && !!window.electronAPI?.webdavRequest
}

function defaultRequest(payload) {
  if (!webdavSupported()) {
    return Promise.resolve({
      ok: false,
      code: 'unsupported',
      message: 'WebDAV 同步仅在桌面端可用'
    })
  }
  return window.electronAPI.webdavRequest(payload)
}

function defaultEnsureDir(payload) {
  if (!webdavSupported()) {
    return Promise.resolve({
      ok: false,
      code: 'unsupported',
      message: 'WebDAV 同步仅在桌面端可用'
    })
  }
  return window.electronAPI.webdavEnsureDir(payload)
}

function readConfig(webdav) {
  const cfg = parseDavBase(webdav?.url)
  if (!cfg.ok) return { ok: false, message: cfg.message }
  return {
    ok: true,
    baseUrl: cfg.base,
    remoteDir: normalizeRemoteDir(webdav.remoteDir),
    username: String(webdav.username || ''),
    timeoutSec: Number(webdav.timeoutSec) > 0 ? Number(webdav.timeoutSec) : 30
  }
}

function zeroStats() {
  return { added: 0, updated: 0, removed: 0 }
}

function addStats(total, delta) {
  if (!delta) return total
  total.added += Number(delta.added) || 0
  total.updated += Number(delta.updated) || 0
  total.removed += Number(delta.removed) || 0
  return total
}

async function persistResult({ status, error = '', lastSyncAt, lastEtag } = {}) {
  const { settings, persist } = useSettings()
  if (!settings.webdav) return
  settings.webdav.lastStatus = status
  settings.webdav.lastError = error
  if (lastSyncAt) settings.webdav.lastSyncAt = lastSyncAt
  if (lastEtag !== undefined) settings.webdav.lastEtag = lastEtag
  try {
    await persist()
  } catch {
    // 设置写失败不该把一次成功的同步说成失败
  }
}

/**
 * 测试连接：PROPFIND 远程目录；404 时顺手创建（用户第一次用必须有这一手，
 * 否则「测试连接」会永远失败，而用户不知道要先去哪里建目录）。
 */
export async function testWebdav({
  request = defaultRequest,
  ensureDir = defaultEnsureDir,
  password
} = {}) {
  const { settings } = useSettings()
  const w = settings.webdav || {}
  if (!webdavSupported()) {
    return { ok: false, code: 'unsupported', message: 'WebDAV 同步仅在桌面端可用' }
  }
  const cfg = readConfig(w)
  if (!cfg.ok) return { ok: false, code: 'EINVAL', message: cfg.message }

  const base = {
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    timeoutSec: cfg.timeoutSec,
    ...(password ? { password } : {})
  }
  let created = false
  let res = await request({
    ...base,
    path: remoteDirPath(cfg.remoteDir),
    method: 'PROPFIND',
    headers: { depth: '0' }
  })
  if (res.ok && res.status === 404) {
    const mk = await ensureDir({ ...base, remoteDir: cfg.remoteDir })
    if (!mk.ok) {
      return { ok: false, code: mk.code || 'EMKCOL', message: mk.message || '创建远程目录失败' }
    }
    created = true
    res = await request({
      ...base,
      path: remoteDirPath(cfg.remoteDir),
      method: 'PROPFIND',
      headers: { depth: '0' }
    })
  }
  if (!res.ok) return { ok: false, code: res.code || 'ENETWORK', message: res.message }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'EAUTH', status: res.status, message: describeDavStatus(res.status) }
  }
  // 有的服务器对目录 PROPFIND 返回 200 而不是 207——两者都算通
  if (res.status !== 207 && res.status !== 200) {
    return {
      ok: false,
      code: 'EHTTP',
      status: res.status,
      message: describeDavStatus(res.status)
    }
  }
  return { ok: true, status: res.status, created }
}

/**
 * 跑一次完整同步。
 *
 * `options` 只用于测试注入（request / ensureDir / flush / now），生产调用不传。
 */
export async function syncWithWebdav(options = {}) {
  const { settings } = useSettings()
  const w = settings.webdav || {}
  const request = options.request || defaultRequest
  const ensureDir = options.ensureDir || defaultEnsureDir
  const flush = options.flush || (async () => {})
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 2

  if (!webdavSupported()) {
    return { ok: false, code: 'unsupported', message: 'WebDAV 同步仅在桌面端可用' }
  }
  if (webdavState.working) {
    return { ok: false, code: 'EBUSY', message: '已有一次同步正在进行' }
  }
  const cfg = readConfig(w)
  if (!cfg.ok) return { ok: false, code: 'EINVAL', message: cfg.message }

  // 与局域网同步同一条硬约束：生成中用整组回写会与流式写入抢同一个键。
  // 这里是「跳过」而不是「失败」——自动同步撞上生成是正常情况，不该弹错误。
  if (useGeneration().store.running) {
    return { ok: true, skipped: 'busy', message: '正在生成正文，本次未同步' }
  }

  webdavState.working = true
  webdavState.lastResult = null
  const stats = zeroStats()
  const warnings = []
  const peers = []
  let conflicts = 0
  let uploadedBytes = 0

  const base = {
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    timeoutSec: cfg.timeoutSec,
    // 用户刚在输入框里敲完、还没保存就点了「立即同步」时，密码只在这一次调用里出现
    ...(options.password ? { password: options.password } : {})
  }

  try {
    await flush()
    // 指针在内存里防抖 600ms，先收口再取快照（同局域网同步）
    await useBooks().flushCurrentPointers()

    const deviceId = await db.getDeviceId()
    if (!normalizeDeviceFileId(deviceId)) {
      warnings.push('本机设备标识非法，无法确定远程文件名')
      await persistResult({ status: 'error', error: warnings.join('；') })
      return { ok: false, code: 'EDEVICE', message: warnings[0], warnings }
    }
    const deviceName = deriveDeviceName(settings.deviceName, deviceId)

    // 1) 确保目录存在。405 = 目录已存在，主进程已把它当成功。
    const mk = await ensureDir({ ...base, remoteDir: cfg.remoteDir })
    if (!mk.ok) {
      const message = mk.message || describeDavStatus(mk.status) || '无法创建远程目录'
      await persistResult({ status: 'error', error: message })
      return { ok: false, code: mk.code || 'EMKCOL', message }
    }

    // 2) 拉取并合并全部对端。合并是幂等的：重复同步同一份文件不会堆数据。
    async function pullOnce() {
      const listing = await request({
        ...base,
        path: remoteDirPath(cfg.remoteDir),
        method: 'PROPFIND',
        headers: { depth: '1' }
      })
      if (!listing.ok) {
        return { ok: false, code: listing.code || 'ENETWORK', message: listing.message }
      }
      if (listing.status !== 207 && listing.status !== 200) {
        return {
          ok: false,
          code: 'EHTTP',
          status: listing.status,
          message: describeDavStatus(listing.status)
        }
      }
      const hrefs = parseDavHrefs(listing.body)
      let files = snapshotFilesFromHrefs(hrefs, { ownDeviceId: deviceId })
      if (files.length > MAX_PEERS) {
        warnings.push(`远端有 ${files.length} 台设备的快照，本次只合并最近排序的前 ${MAX_PEERS} 份`)
        files = files.slice(0, MAX_PEERS)
      }
      for (const file of files) {
        const peerId = file.slice(0, -DAV_SNAPSHOT_SUFFIX.length)
        if (!normalizeDeviceFileId(peerId)) {
          warnings.push(`忽略文件名不合法的远程快照：${file}`)
          continue
        }
        const got = await request({
          ...base,
          path: remoteFilePath(cfg.remoteDir, file),
          method: 'GET'
        })
        if (!got.ok) {
          warnings.push(`读取 ${file} 失败：${got.message}`)
          continue
        }
        if (got.status === 404) continue
        if (got.status !== 200) {
          warnings.push(`读取 ${file} 失败：${describeDavStatus(got.status)}`)
          continue
        }
        let remote
        try {
          remote = JSON.parse(got.body)
        } catch {
          warnings.push(`${file} 不是有效的 JSON，已跳过`)
          continue
        }
        const merged = await handleIncomingSnapshot(remote, {
          remoteAddr: 'webdav:' + peerId,
          reload: false,
          conflictCopies: w.conflictCopies !== false
        })
        if (merged.busy) {
          return { ok: true, busy: true, message: merged.message }
        }
        if (!merged.ok) {
          warnings.push(`${file}：${merged.message || '合并失败'}`)
          continue
        }
        addStats(stats, merged.stats)
        conflicts += Number(merged.conflicts) || 0
        peers.push(String(remote.deviceName || peerId))
      }
      return { ok: true }
    }

    let pulled = await pullOnce()
    if (pulled.busy === true) {
      await persistResult({ status: 'skipped', error: '' })
      return { ok: true, skipped: 'busy', message: pulled.message, warnings }
    }
    if (!pulled.ok) {
      await persistResult({ status: 'error', error: pulled.message })
      return { ok: false, code: pulled.code, message: pulled.message, warnings }
    }

    // 3) 上传合并结果。先量真实字节数：中文是 3 字节/字符，按 length 判会低估。
    let snap = await collectSnapshot({ deviceName })
    let body = toSnapshotJson(snap)
    uploadedBytes = new Blob([body]).size
    if (uploadedBytes > DAV_MAX_BYTES) {
      const message = '快照超过 64MB，无法上传到 WebDAV'
      await persistResult({ status: 'error', error: message })
      return { ok: false, code: 'ETOOLARGE', message, warnings }
    }

    let etag = normalizeEtag(w.lastEtag)
    let attempt = 0
    let upload = null
    for (;;) {
      const headers = { 'content-type': 'application/json' }
      if (etag) headers['if-match'] = etag
      upload = await request({
        ...base,
        path: snapshotPath(cfg.remoteDir, deviceId),
        method: 'PUT',
        headers,
        body
      })
      if (upload.ok && upload.status >= 200 && upload.status < 300) break
      // 412 = 这个文件在我们读取之后被改过。重新拉取对端、重新合并后再传，
      // 不然会把别人刚写进来的改动覆盖掉。
      if (upload.ok && isEtagConflict(upload.status) && attempt < maxRetries) {
        attempt++
        warnings.push('远程快照已被改动，正在重新合并')
        const again = await pullOnce()
        if (again.busy) {
          await persistResult({ status: 'skipped', error: '' })
          return { ok: true, skipped: 'busy', message: '正在生成正文，本次未同步', warnings }
        }
        if (!again.ok) {
          const message = again.message || '重新读取远程快照失败'
          await persistResult({ status: 'error', error: message })
          return { ok: false, code: again.code, message, warnings }
        }
        snap = await collectSnapshot({ deviceName })
        body = toSnapshotJson(snap)
        uploadedBytes = new Blob([body]).size
        if (uploadedBytes > DAV_MAX_BYTES) {
          const message = '快照超过 64MB，无法上传到 WebDAV'
          await persistResult({ status: 'error', error: message })
          return { ok: false, code: 'ETOOLARGE', message, warnings }
        }
        // 换一个新的 ETag；拿不到就退化成无条件 PUT，并如实告诉用户
        const head = await request({
          ...base,
          path: snapshotPath(cfg.remoteDir, deviceId),
          method: 'HEAD'
        })
        etag =
          head.ok && head.status >= 200 && head.status < 300
            ? normalizeEtag(headerValue(head.headers, 'etag'))
            : ''
        if (!etag) warnings.push('服务器未返回 ETag，本次上传无法防止并发覆盖')
        continue
      }
      break
    }

    if (!upload.ok) {
      const message = upload.message || '上传快照失败'
      await persistResult({ status: 'error', error: message })
      return { ok: false, code: upload.code || 'ENETWORK', message, warnings }
    }
    if (upload.status < 200 || upload.status >= 300) {
      const message = describeDavStatus(upload.status) || `上传快照失败（HTTP ${upload.status}）`
      await persistResult({ status: 'error', error: message })
      return { ok: false, code: 'EHTTP', status: upload.status, message, warnings }
    }

    // 4) 记住新的 ETag。服务器不返回时退化为 HEAD，仍没有就清空，避免拿
    // 一个必然过期的值让之后每次同步都 412。
    let nextEtag = normalizeEtag(headerValue(upload.headers, 'etag'))
    if (!nextEtag) {
      const head = await request({
        ...base,
        path: snapshotPath(cfg.remoteDir, deviceId),
        method: 'HEAD'
      })
      if (head.ok && head.status >= 200 && head.status < 300) {
        nextEtag = normalizeEtag(headerValue(head.headers, 'etag'))
      }
    }
    if (!nextEtag) {
      warnings.push('服务器未返回 ETag，无法完全防止两台设备并发写入')
    }

    await persistResult({
      status: 'ok',
      error: '',
      lastSyncAt: now,
      lastEtag: nextEtag
    })

    // 5) 全部合并完才刷新一次界面。合并过程中每份都刷新会让书库/编辑器反复跳动。
    await refreshUiAfterSync()

    const result = {
      ok: true,
      at: now,
      stats,
      conflicts,
      peers,
      warnings,
      bytes: uploadedBytes,
      retries: attempt
    }
    webdavState.lastResult = result
    return result
  } catch (e) {
    const message = String((e && e.message) || e)
    await persistResult({ status: 'error', error: message })
    return { ok: false, code: 'EUNKNOWN', message, warnings }
  } finally {
    webdavState.working = false
  }
}
