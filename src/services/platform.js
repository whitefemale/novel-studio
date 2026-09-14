// 平台判定：把散落各处的 window.electronAPI / Capacitor 判断收敛到这一处。
// 纯判定，无副作用；涉及原生插件的调用一律放到 native.js 里动态导入。

/** 桌面端（Electron） */
export function isDesktop() {
  return !!(typeof window !== 'undefined' && window.electronAPI?.isDesktop)
}

/** 原生容器（Android / iOS，经 Capacitor 打包） */
export function isNative() {
  return !!(typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.())
}

/** 纯浏览器 */
export function isWeb() {
  return !isDesktop() && !isNative()
}

/** 是否处于手机/窄屏布局（与 WritingView 的媒体查询断点保持一致） */
export function isNarrowLayout() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(max-width: 860px)').matches
}
