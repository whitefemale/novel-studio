// 定时自动备份：把整本小说按时间戳写入 `<保存目录>/<书名>/备份/`。
//
// 仅在「桌面端 + 已配置保存地址 + 当前有书有章节」时工作；其余情况静默跳过。
// 启停一律走 start/stop，不要在组件里裸跑 setInterval —— 热更新会让定时器叠层。
import { isDesktop } from './platform'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import { buildTxt, buildBackupName, buildBackupTarget, pickStaleBackups } from './export'

let timer = null
let running = false

/** 立即备份一次当前打开的书；返回主进程的写入结果 */
export async function backupNow() {
  const { settings } = useSettings()
  const { store } = useBooks()

  if (!isDesktop() || !settings.saveDir) return { ok: false, code: 'SKIPPED_NO_DIR' }
  if (!store.book || !store.chapters.length) return { ok: false, code: 'SKIPPED_EMPTY' }
  // 上一轮还没写完就跳过，避免慢磁盘上备份任务堆积
  if (running) return { ok: false, code: 'SKIPPED_BUSY' }

  const target = buildBackupTarget(settings, store.book)
  if (!target) return { ok: false, code: 'SKIPPED_NO_DIR' }

  running = true
  try {
    const res = await window.electronAPI.writeToDir({
      ...target,
      fileName: buildBackupName(store.book),
      content: buildTxt(store.book, store.chapters)
    })
    if (res?.ok) await pruneBackups(target, settings.backupKeep)
    return res
  } finally {
    running = false
  }
}

/** 按文件名倒序保留 keep 份，其余删除。失败不影响已完成的备份。 */
async function pruneBackups(target, keep) {
  try {
    const listed = await window.electronAPI.listFiles(target)
    if (!listed?.ok) return
    const stale = pickStaleBackups(listed.files, keep)
    if (!stale.length) return
    await window.electronAPI.deleteFiles({ ...target, fileNames: stale })
  } catch {
    // 清理失败只意味着多留几份备份，不该向上冒泡
  }
}

/** 启动定时备份（重复调用安全：先停后起） */
export function startAutoBackup() {
  stopAutoBackup()
  const { settings } = useSettings()
  if (!isDesktop() || !settings.autoBackup || !settings.saveDir) return

  const minutes = Number(settings.backupInterval)
  const interval = (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000
  timer = setInterval(() => {
    backupNow()
  }, interval)
}

export function stopAutoBackup() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
