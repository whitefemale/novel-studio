const { contextBridge, ipcRenderer } = require('electron')

// 供渲染进程使用的桌面端能力。
// 浏览器/Capacitor 环境中 window.electronAPI 为 undefined，相关调用自动走直连兜底。
contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  // 发起 LLM 流式请求（主进程代理，规避 CORS）
  chatCompletions: (payload) => ipcRenderer.invoke('llm:chat', payload),
  abortChat: (requestId) => ipcRenderer.send('llm:abort', requestId),
  // 订阅流式增量行 / 完成 / 出错事件
  onDelta: (cb) => ipcRenderer.on('llm:delta', (_e, payload) => cb(payload)),
  onDone: (cb) => ipcRenderer.on('llm:done', (_e, requestId) => cb(requestId)),
  onAborted: (cb) => ipcRenderer.on('llm:aborted', (_e, requestId) => cb(requestId)),
  onError: (cb) => ipcRenderer.on('llm:error', (_e, payload) => cb(payload)),
  // 导出到本地磁盘（弹保存框）
  saveFile: (payload) => ipcRenderer.invoke('export:saveFile', payload),
  // 选择保存目录（原生目录选择器）
  chooseDirectory: (payload) => ipcRenderer.invoke('dialog:chooseDirectory', payload),
  // 直接写入已配置的目录，不弹框
  writeToDir: (payload) => ipcRenderer.invoke('export:writeToDir', payload),
  // 列出目录内的文件（自动备份清理用）
  listFiles: (payload) => ipcRenderer.invoke('fs:listFiles', payload),
  // 删除目录内的指定文件
  deleteFiles: (payload) => ipcRenderer.invoke('fs:deleteFiles', payload),
  // 在资源管理器中打开目录 / 定位文件
  openFolder: (payload) => ipcRenderer.invoke('shell:openFolder', payload)
})
