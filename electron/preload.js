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
  openFolder: (payload) => ipcRenderer.invoke('shell:openFolder', payload),
  // ---- 局域网同步 ----
  // 电脑侧是 HTTP 服务端。配对码由主进程生成、只存在内存里，这里只是把它读出来
  // 给界面显示；渲染层不会也不能把码持久化到 IndexedDB。
  syncStart: (payload) => ipcRenderer.invoke('sync:start', payload),
  syncStop: () => ipcRenderer.invoke('sync:stop'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncRotateCode: () => ipcRenderer.invoke('sync:rotateCode'),
  // 合并结果回传给主进程，唤醒那个挂起的 HTTP 请求
  syncRespond: (payload) => ipcRenderer.invoke('sync:respond', payload),
  // 主→渲染：有设备来同步了，把远端快照交下来处理
  onSyncIncoming: (cb) => ipcRenderer.on('sync:incoming', (_e, payload) => cb(payload)),
  // ---- 秘密存储（safeStorage；密钥只在主进程加解密） ----
  // slot: 'apiKey'（默认）| 'webdavPassword'。未知槽返回 EINVAL，绝不回退明文。
  // 返回 { ok, value?, code?, message? }。code==='unsupported' 时渲染层如实提示。
  secretGet: (slot = 'apiKey') => ipcRenderer.invoke('secret:get', { slot }),
  secretSet: (value, slot = 'apiKey') => ipcRenderer.invoke('secret:set', { value, slot }),
  secretDelete: (slot = 'apiKey') => ipcRenderer.invoke('secret:delete', { slot }),
  // ---- WebDAV（仅桌面端） ----
  // 只暴露「发一个受白名单约束的 DAV 请求」，不暴露通用 net/fs。
  // 密码由主进程从 safeStorage 取；payload.password 只在「刚输入、还没保存」
  // 的那一次测试连接里出现。
  webdavRequest: (payload) => ipcRenderer.invoke('webdav:request', payload),
  webdavEnsureDir: (payload) => ipcRenderer.invoke('webdav:ensureDir', payload),
  // ---- 声明式插件（仅桌面端） ----
  // 只暴露「列固定插件目录」与「打开该目录」。插件是纯 JSON，不执行代码；
  // 渲染层也拿不到任意路径的读取能力。
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsOpenFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  // ---- 关窗前的保存握手 ----
  // 主进程拦下第一个 close 事件，等渲染层把防抖窗口里的正文落库后再放行
  onBeforeClose: (cb) => ipcRenderer.on('app:before-close', () => cb()),
  closeReady: () => ipcRenderer.invoke('app:close-ready')
})
