// 原生容器（Android）能力封装。
//
// 约定：Capacitor 插件一律用 `await import()` 动态导入，且只在 isNative() 分支内执行。
// 这样 Electron 与浏览器产物里不会打进用不到的插件代码，也不会因为插件在 web
// 环境下抛「not implemented」而受影响。
import { isNative } from './platform'

/** 状态栏改成浅色（白色背景 + 深色文字），与整体白色主题一致 */
export async function initNativeUI() {
  if (!isNative()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // 注意 Capacitor 的命名：Style.Light = 深色文字（用于浅色背景），不是「浅色文字」
    await StatusBar.setStyle({ style: Style.Light })
  } catch {
    // 插件缺失或平台不支持时静默降级，不影响主流程
  }
}

/**
 * 注册 Android 硬件返回键。
 * handler 返回 true 表示已消化该次返回；返回 false 则退出应用。
 */
export function registerBackButton(handler) {
  if (!isNative()) return
  import('@capacitor/app')
    .then(({ App }) => {
      App.addListener('backButton', () => {
        let consumed = false
        try {
          consumed = handler() === true
        } catch {
          consumed = false
        }
        if (!consumed) App.exitApp()
      })
    })
    .catch(() => {})
}

/**
 * 复制文本到剪贴板。
 * WebView 里 navigator.clipboard 需要安全上下文，execCommand 已废弃且不可靠，
 * 因此原生端一律走 Clipboard 插件。
 */
export async function copyToClipboard(text) {
  if (isNative()) {
    const { Clipboard } = await import('@capacitor/clipboard')
    await Clipboard.write({ string: text })
    return
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}

/**
 * 原生端「导出」：写入应用缓存目录再拉起系统分享面板。
 *
 * 选 Directory.Cache 而不是 Documents 是有意的：Documents 在 minSdk 24~28 的
 * 机器上需要 WRITE_EXTERNAL_STORAGE 运行时权限，而 Cache + 分享零权限即可完成
 * 「把导出的文本存到任意位置」的诉求，落点交给系统分享面板决定。
 *
 * Share 插件内部会把 file:// 交给 FileProvider（authority 为
 * `${applicationId}.fileprovider`，Capacitor 模板已在 AndroidManifest 中声明）
 * 转成 content:// 再分享，因此这里的 file:// 是合法的。
 */
export async function shareTextFile(fileName, content) {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')

  const written = await Filesystem.writeFile({
    path: fileName,
    data: content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true
  })

  await Share.share({
    title: fileName,
    url: written.uri,
    dialogTitle: '导出小说'
  })

  return { canceled: false, filePath: written.uri, platform: 'android' }
}
