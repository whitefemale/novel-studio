# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

自动写小说桌面软件（Novel Studio）：Vue 3 单页应用 + Electron 桌面壳，同一套代码可跑浏览器 / Windows exe / Android（Capacitor，工具链已配好、可出 APK）。UI 与代码注释均为中文，白色简洁主题。所有数据存本机 IndexedDB（库 `novel-studio-db`，表 `novel-store`）。

## 常用命令

```bash
npm install          # 依赖（项目已配置 npmmirror 镜像；electron 安装走 ELECTRON_MIRROR）
npm run dev          # 浏览器开发模式 → http://localhost:5173
npm run build        # 仅构建 dist/（vite build）
npm run electron     # build + electron .（桌面版运行，加载 dist/index.html）
npm run dist:win     # build + electron-builder --win → 产出 release/ 下安装版+便携版 exe
npm run dist:win:dir # 仅产出 win-unpacked/（跳过安装包，排错更快）

# Electron 下带 HMR 的开发：改组件即时热更，不必 build、不必重启（两个终端）
npm run dev                                               # 终端 1
VITE_DEV_SERVER_URL=http://localhost:5173 npx electron .  # 终端 2

# Android（详见「Android」章节）——必须 Node ≥22，这是 @capacitor/cli 的硬性要求
npx cap sync android && (cd android && JAVA_HOME="C:/Android/jdk21" ./gradlew assembleDebug)
# 产物：android/app/build/outputs/apk/debug/app-debug.apk

# 发版：推 v* tag 触发 GitHub Actions 自动构建并发布 Release（详见「发布与 CI」章节）
git tag -a v1.0.1 -m "Novel Studio v1.0.1" && git push origin v1.0.1
```

自动化测试（Electron 冒烟测试）：

```bash
npm run build && SMOKE_TEST=1 npx electron .
```

冒烟测试全自动驱动核心逻辑并在主进程 stdout 打印结果，无交互、自动退出。成功时输出 `SMOKE_MOUNT ...`、`SMOKE_DETAIL {... "pass": true}`；失败时打印 `SMOKE_EVAL_ERROR` / `SMOKE_TEST_ERROR` / `SMOKE_FAIL`（见「冒烟测试机制」）。

## 架构

三层，各层解耦，浏览器与桌面共用同一渲染代码：

- **渲染层** `src/`：Vue 3 单 SPA（`App.vue` 顶层切换 书库/写作 两个视图）。无路由、无 UI 框架，纯 `styles.css` 白底变量 + 组件内样式。弹窗（设置 / 导出 / **小说控制台** / 全量备份）都是 `v-if` 渲染的层，**不新增第三层视图**。
  - `store/`（Composables）：`books.js` 持有全部领域状态（`store` 为模块级 `reactive` 单例：books/bookId/chapters/outlines），`settings.js` 持有全部持久化设置（AI 接口 + 保存与导出），`toast.js` 是全局轻提示队列。跨组件共享一律通过这三处，不另起本地副本。V2 又加了五个：`collectionSet.js`（一组按书隔离的集合的通用工厂）、`novelMemory.js` / `storyStructure.js`（记忆层与剧情骨架两族）、`novel.js`（按集合名路由到对应那族）、`generation.js`（生成记录与成本聚合）。它们同样是模块级 `reactive` 单例。
  - `services/`：纯函数/无状态模块，供 store 与组件调用。`storage.js` 封装 idb-keyval；`llm.js` 是 LLM 客户端（见下）；`prompts.js` 组装 `messages`；`export.js` 生成 TXT/MD 文本与落盘分发；`autosave.js` 是自动保存调度器；`backup.js` 定时备份；`platform.js` 统一平台判定；`native.js` 是 Capacitor 插件薄封装。V2 新增两个子目录（规格书 02 要求，既有扁平文件**不移动**）：`services/ai/`（`orchestrator.js` 多阶段工作流、`tokenUsage.js` 计量与成本）、`services/novel/`（`schemas.js` 实体定义、`contextBuilder.js` 分层上下文、`snapshot.js` 全量快照，第二阶段又加了 `versioning.js` 章节版本、`timeline.js` 时间线与断链、`consistency.js` 一致性规则）。另有根级的 `services/migration.js`（V1→V2 迁移）、`services/sync.js`（局域网同步的渲染层一半，见「V2 第二阶段」）、`services/ids.js`、`services/wordCount.js`。
  - `main.js` 额外挂 `window.__ns` 测试钩子（db / store 工厂 / buildMessages / chatStream / 导出与自动保存的纯函数等），供冒烟测试注入脚本使用。
- **Electron 壳** `electron/`：`main.js` 创建窗口 + IPC + **局域网同步的 HTTP 服务**（见「V2 第二阶段」）；`preload.js` 通过 `contextBridge` 暴露 `window.electronAPI`。`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`（LLM 请求必须走主进程代理，规避 CORS）。**所有 `fs` / `shell` / `dialog` 调用只在主进程**，这三个安全开关不得放开。

  **窗口加载哪一份前端，由 `VITE_DEV_SERVER_URL` 决定**（`main.js` 顶部二选一）：

  ```js
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)                      // 开发：Vite dev server，带 HMR
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))  // 生产：构建产物
  ```

  这解释了「为什么改了组件 Electron 里没变化」——默认走的是 `dist/` 产物，必须先 `npm run build`；想免掉这一步就用上面「常用命令」里的 HMR 配方。已实测该分支可用：带着 `VITE_DEV_SERVER_URL` 跑冒烟测试，`SMOKE_MOUNT` 仍报 `appChildren:1` 与正确标题，说明从 dev server 加载时应用确实挂载（**不是**加载失败时的空白页）。

  IPC 通道清单：

  | 通道 | 方向 | 用途 |
  |---|---|---|
  | `llm:chat` / `llm:abort` | invoke / send | LLM 流式代理与中止 |
  | `llm:delta` / `llm:done` / `llm:error` / `llm:aborted` | 主→渲染 推送 | SSE 增量回传（`llm.js` 的 `ipcHub` 单例订阅） |
  | `export:saveFile` | invoke | 弹保存框。返回 `{canceled}` 或 `{canceled:false, filePath}` |
  | `dialog:chooseDirectory` | invoke | 选保存地址。返回 `{canceled}` 或 `{canceled:false, dir}` |
  | `export:writeToDir` | invoke | 直写保存地址。返回 `{ok, filePath, bytes}` 或 `{ok:false, code, message}` |
  | `fs:listFiles` / `fs:deleteFiles` | invoke | 列目录 / 删文件（自动备份淘汰用） |
  | `shell:openFolder` | invoke | 资源管理器中打开目录或定位文件 |
  | `sync:start` / `sync:stop` / `sync:status` / `sync:rotateCode` | invoke | 局域网同步服务的开关、状态、换码 |
  | `sync:respond` | invoke（渲染→主） | 唤醒一个挂起的 HTTP 请求（见下） |
  | `sync:incoming` | 主→渲染 推送 | 有设备来同步，把远端快照交给渲染层 |

  `export:saveFile` 与 `export:writeToDir` **刻意不合并**：返回契约不同（前者是 UI 结果，后者是 I/O 结果）。

  `sync:*` 是第二阶段新增的，**默认关闭**：`syncAutoStart` 为 false 时主进程不创建任何
  server 对象，端到端零监听（`syncServerUpOk` 断言 `syncStatus().running === false && port === 0`）。
  这是本项目第一个长驻监听端口的组件，改它时记住两条：`app.on('before-quit', stopSyncServer)`
  已在位（否则进程会挂着一个没人在管的端口），以及 `SMOKE_TEST` 的退出前也要显式关一次
  ——`app.exit(0)` **不走** `before-quit`。
- **打包**：`electron-builder.yml`（win: nsis + portable，x64）。浏览器/Android 共用 `dist/` 产物；`android/` 不进 Electron 包（`files` 只含 `dist/**` 与 `electron/**`）。应用图标 `build/icon.ico` 由 `node scripts/gen-icon.mjs` 生成（纯 Node 手写 PNG + ICO 封装，无第三方依赖）——**换图标改这个脚本重跑即可，不要去装图标库**。
- **CSP 写在 `index.html` 的 `<meta http-equiv>` 里**（`script-src 'self'`、`connect-src 'self' http: https:`）：渲染层不能加内联 `<script>`、也不能引 CDN 脚本；新增的任何 `fetch` 目标协议必须已在 `connect-src` 中。改 LLM 端点本身不用动它（`http:`/`https:` 已全放行）——**局域网同步的 `http://192.168.x.x:8787` 也因此不用动它**，这正是不把 `connect-src` 收窄到具体域名的原因。

### LLM 客户端双路径（llm.js）

`chatStream({ settings, messages, callbacks, forceBrowser })`：
- **桌面端**：`window.electronAPI.isDesktop` 为真 → 渲染进程把 `{requestId, url, headers, body}` 交给主进程 `net.fetch` 代理，服务端 SSE 行经 `webContents.send('llm:delta', {requestId, line})` 逐行回传 → `parseSseLine` 提取增量文本 → `callbacks.onDelta`。
- **浏览器 / Android WebView**：渲染进程直接 `fetch` + `ReadableStream` 逐行解析（CORS 由服务端放行）。
- `buildChatUrl(baseUrl)` 自动补 `/chat/completions`；`parseSseLine(line)` 解析 `data:` 行，`[DONE]`/非 SSE 返回空串。

### 重要约定与坑（改代码前必读）

1. **IndexedDB 写入前必须 `toPlain()`**（`storage.js`）：Vue `reactive` 代理对象无法被结构化克隆，`set()` 前一律 `JSON.parse(JSON.stringify(v))`。所有 `saveXxx` 已内置，新增存储函数时沿用。
2. **IPC 事件中枢必须是模块级单例**（`llm.js` 顶部 `ipcHub` + `ensureIpcHub()`）：经实测，在 `chatStream` 函数体内逐次注册 `onDone/onError` 监听收不到事件；模块加载时注册一次、按 `requestId` 分发才稳定。这是有意为之，勿改回函数内注册。
3. **`vite.config.js` 的 `base: './'` 不可去掉**：构建产物用相对路径，Electron 才能以 `file://` 加载 `dist/index.html`。
4. **electron-builder 的 `files` 拦不住 `node_modules`——必须显式写 `'!node_modules/**'`**。这是本项目踩过的一个真实坑：光写 `dist/**` 与 `electron/**`，electron-builder 仍会**隐式**把所有 `dependencies` 打进 asar。加入 Capacitor 后 `@capacitor/android`（499 个 Java/Gradle 源文件）连同整套 CLI 依赖（rimraf / @babel/types / native-run / xml2js …）一起进了安装包，asar 条目从 18 涨到 **3916**、exe 从 80MB 涨到 **87MB**——而且**全程没有任何警告**，只有体积在悄悄变大。现在的约定：
   - `electron-builder.yml` 显式排除 `'!node_modules/**'`。渲染层已由 Vite 全量打包进 `dist/`，主进程只用 `electron` 与 node 内置模块（`path`/`fs`/`http`），**运行时不需要任何 node_modules**；
   - `@capacitor/*` 一律放 `devDependencies`（它们是构建期输入，产物是 `dist/` 与 APK）；这也与「Android 构建本来就依赖 `vite` / `@capacitor/cli` 等 devDependencies」一致；
   - 排查手法：`npx asar list release/win-unpacked/resources/app.asar`，**条目数应当在 20 上下**（只有 `package.json` + `electron/2 个文件` + `dist/**`）。数量级到几百上千就是漏了；
   - 改完打包配置务必**真的启动一次** `release/win-unpacked/Novel Studio.exe` 确认能起来——删 node_modules 是否安全，只有启动过才算验证过。
   `src/`、`tests/` 本来就不进 asar。给打包产物注入测试代码时需用 `node_modules/@electron/asar` 解包→复制→重新打包，验收后须重建干净的 asar（否则交付物含测试代码）。
5. **winCodeSign 缓存坑（Windows 打包）**：electron-builder 首次 `--win` 会下载 winCodeSign 并 7z 解压，其 `darwin/10.12/lib` 含符号链接，Windows 无管理员/开发者模式下解压失败（`Cannot create symbolic link : 客户端没有所需的特权`）导致整次打包中止。app-builder 的缓存判定是**最终目录 `...\Cache\winCodeSign\winCodeSign-2.6.0` 存在即跳过下载**——已手动预解压该目录（含两个 dylib 链接文件）到 `C:\Users\16049\AppData\Local\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`，NSIS 同理已预解压到 `...\Cache\nsis\nsis-3.0.4.1`。若打包报符号链接错误，检查这两个目录是否完整；换机/清缓存后需重做此步骤。
6. **npm / Electron 走 npmmirror**：仓库根目录的 **`.npmrc` 就是这条配置的载体**（`registry` + `electron_mirror`），它随仓库一起走，所以换机 `npm install` 也能直接装上 Electron。**不要删 `.npmrc`、也不要改成默认源**——`electron_mirror` 一旦失效，`npm install` 会去 GitHub 拉 ~100MB 的 Electron 包，国内基本装不下来。
7. **绝不要把 `\uXXXX` 转义序列写进源文件**：写入文件时它会被解码成**真正的控制字节**（含 NUL），文件随即变成 grep 眼里的「二进制文件」，且这种损坏极难修——正则替换匹配不上、按行号重写也不一定生效。需要控制字符时用「按码点过滤的循环」（见 `export.js` / `electron/main.js` 的 `stripControlChars`）或在测试里用 `String.fromCharCode(n)` 现造。`export.js` 与 `electron/main.js` 里那份净化函数就是被这个坑逼出来的写法。
8. **写入前必须串行化读-改-写**：`upsertChapter` / `upsertBook` / `upsertOutline` 都是「get → 改 → set」，任意两个并发写者（自动保存 vs 建章、自动保存 vs 移动章节）都会互相覆盖。`storage.js` 的 `serialize(key, fn)` 按 key 排队把它们串起来——**新增的存储写函数必须包一层 `serialize`**，否则这个竞态会悄悄回来。公开函数与内部的 `writeXxx` 是分开的：公开层负责排队，内部层只做事，两者不能嵌套（同 key 嵌套会自锁）。
9. **自动保存的待保存 id 必须在 `schedule()` 时捕获，并在第一个 `await` 之前摘除**（`autosave.js` 的 `run()`）。按触发时刻去读「当前章节」的写法，会在用户于防抖窗口内切章时把最后一笔写到新章节上。切章时 `flush()` **刻意不 await**——await 会让正文切换多等一个 IndexedDB 往返、闪出上一章内容；而 `flush` 在首个 `await` 前已同步清空 `pendingId`，留在飞行中是安全的。
10. **导出目录的安全边界在主进程，渲染层的净化结果不可信**：导出请求可能来自即发即忘、无法向上报错的路径（`onBeforeUnmount` 的冲刷），渲染层 `sanitizeFileName` 只用于预览与建议文件名。两条策略**刻意不对称，勿「统一」**：子目录越界 → **拒绝**（`EINVALID_SUBDIR`），文件名越界 → **改写**（`../../evil.txt` 变成留在目录内的 `_.._evil.txt`）。后者是刻意的：书名里带个斜杠不该让整次导出失败。`resolveTarget` 末尾那次 `path.resolve` 包含性断言与逐段校验冗余，这是特性不是重复。
11. **返回书库的正确顺序是 `flush()` → `closeBook()`**（`App.vue` 的 `handleBackToShelf`）。先 `closeBook()` 会赶在 Vue 卸载 `WritingView` 之前执行，`store.chapters` 已被清空，最后一笔再也写不回去。纵深防御在 `storage.js`：所有以 `bookId` 为作用域的函数在 `!bookId` 时直接返回（读返回 `[]`、写 `console.warn`），永久消除 `chapters:null` 这类垃圾键。
12. **渲染进程不得使用 `window.prompt` / `window.confirm`**：Electron 与 Android WebView **都不实现**它们，在三个目标平台中有两个必然静默 no-op。需要输入就做弹窗组件（参见 `BookShelf.vue` 的编辑弹窗）。
13. **Capacitor 插件一律 `await import('@capacitor/xxx')` 动态导入，且只在 native 分支内调用**（`native.js`）。这样 Electron 与浏览器产物里不会打进用不到的插件代码，构建产物会自然 code-split 出若干小 chunk——**`npm run build` 的模块数从 36 涨到 57 是预期结果**，不是异常。
14. **Vue 会吞掉 watcher / 生命周期回调里抛出的错误**：它把事情 `console.error` 出去，然后**继续渲染**——组件照常挂载，界面照常出现。所以这类 bug 的症状不是白屏，而是「控制台一条报错 + 那个回调的后半段被静默跳过」，非常容易被漏掉。实例：`Editor.vue` 的 immediate watcher 回调里重置了 `findCursor`，而 `const findCursor` 当时声明在 watcher 下面（setup 自上而下执行，命中的是 TDZ `ReferenceError`）；因为不白屏，`npm run build`（只编译）、纯 store 层断言、以及「元素是否存在」的断言**全都发现不了**。两道防线：**相关状态声明一律排在 immediate watcher 之前**；冒烟测试的 `uiNoSwallowedErrors` 会劫持 `console.error` 并在整轮结束时断言没有 `ReferenceError`/`TypeError` 一类的被吞错误——**这条断言的价值高于任何「元素在不在」的检查**，改动组件后请留意它。

### 冒烟测试机制

- 触发：`SMOKE_TEST=1` 环境变量。`electron/main.js` 会：启动本地 SSE mock 服务器（端口 `18765`，含 `带CORS` / `不带CORS` / `HTTP 500` 三条路径）→ 监听 `did-finish-load` → 先打印挂载状态 `SMOKE_MOUNT` → 建好临时目录 `%TEMP%\novel-studio-smoke` 并 `executeJavaScript('window.__nsSmokeDir = …')` 注入给渲染层 → 读 `tests/smoke-inject.js`，`replaceAll('__PORT__', 18765)` 后 `executeJavaScript` 执行 → 打印 `SMOKE_DETAIL` → 清理临时目录并退出。
- **渲染进程没有 `node:path`**，算不出临时目录，所以目录必须由主进程注入——这是 `window.__nsSmokeDir` 存在的唯一原因。
- **`tests/smoke-inject.js` 是运行时从磁盘读的**（`electron/main.js` 的 `fs.readFileSync`），不是打包进 `dist/` 的。所以**只改断言时不需要 `npm run build`**——直接 `SMOKE_TEST=1 npx electron .` 即可，迭代一轮只要几秒；只有改了 `src/` 才必须重新 build。
- `tests/smoke-inject.js` 共 140 项断言，沿用「扁平 `out` 对象 + `out.pass` 全部取 AND」的写法（**不要嵌套子对象**，`pass` 里漏掉一项就等于没有这项测试）。覆盖：设置默认值与旧记录回填、文件名净化、自动保存的防抖/冲刷/不串目标、多条大纲注入、目录直写的字节数与同名冲突、越界路径拒绝（含删除诱饵验证）、改名、关书守卫、**真实点击路径的组件挂载**、集合工厂的串行化与墓碑、迁移的幂等与非破坏、Context Builder 的预算与去重、usage 两种形状、编排器的提取/风险/中止/重试、快照合并与整库往返、章节版本的四类来源/裁剪无墓碑/回滚可撤销/删章可恢复、时间线两种排序与断链、七条一致性规则（**含「干净数据必须 0 条」这条反向断言**）、局域网同步的 HTTP 契约（预检/鉴权/冷却/体积/路由/停止）与一次真实的合并往返（含幂等、生成中 409、快照无 API Key），以及 3 条流式管线。
- **同步相关的断言从渲染进程发真实 `fetch`**，不是直接调主进程的函数：手机端能不能连上全取决于 CORS 头与预检有没有发对，而那两样只有真发一次请求才验证得到。渲染层从 `file://`（不透明 origin）向 `http://127.0.0.1:<port>` 发请求是通的——本机回环豁免混合内容规则，加上服务端本来就发 `Access-Control-Allow-Origin: *`。所以计划里那条「退路」（主进程自己探 HTTP 再把结论注入渲染层）没有用到。
- **同步段落的客户端与服务端是同一个渲染进程**，因此「本机应用远端返回的合并结果」必然报 `diff = {0,0,0}` —— 那是**收敛（幂等）**，不是测试没生效。有意义的差集在 `syncState.lastIncoming.diff`（主进程那一侧的合并结果，也就是「手机的对手」那一侧）。
- `out.syncBigStatus` 是**诊断项，不进取 AND 链**：它记录客户端实际看到了什么（本机是 `'reset'` 而不是 `413`，见上面「V2 第二阶段」第 4 节第 1 条）。留着它是为了下一次有人问「413 到底有没有生效」时不必重新跑一遍才知道。
- 组件挂载段里的 `syncPanelToggleOk` **真的把服务开关点了一次**：`.sync-code` 只在服务运行时才渲染，它出现就说明「面板 → sync.js → 主进程 → HTTP 监听」整条链路是通的。点完要**再点一次关掉**，否则会给整轮留下一台没人管的服务（后面的 M 段还会自己开一台）。
- **没有「只跑某一项」的运行器——这是有意的，别去补**：102 项挤在一次 `executeJavaScript` 里，`SMOKE_TEST=1` 要么全跑要么不跑。要单独验证某一项时，两条更省事的路子：
  1. **在 DevTools 里手敲**（首选）：跑 `npm run dev` 或 `npm run electron`，控制台里用 `window.__ns`——它已挂好 db、store 工厂、`buildMessages`、`chatStream`、导出与自动保存的纯函数，绝大多数单项验证压根不需要碰测试脚本；
  2. 临时把其余断言短路（`if (false)` 掉），跑完**记得还原**——`out.pass` 是全体取 AND，忘了还原等于留了个永远不报错的口子。
- **组件挂载那一节必须点真实的 `.book-card`**，不能只调 store：它是唯一能覆盖「组件 setup 期抛错」的手段（见「重要约定与坑」#14）。配套的 `uiNoSwallowedErrors` 会在脚本开头劫持 `console.error`，收集整轮的被吞错误，末尾断言没有 `ReferenceError`/`TypeError` 之类——**只断言元素存在是不够的，出错的组件照样渲染**。这条断言经过反向验证：把 `Editor.vue` 的 TDZ 缺陷还原后它会失败并打印出 `at watch.immediate ...`，修好后转绿。
- **三条必须遵守的纪律**（都踩过）：
  1. 冒烟测试跑在**真实**的 `novel-studio-db` 上，不是沙箱库。所以**只清理标题为「测试小说」的书**、**绝不假设整个库是空的**（曾经断言 `getBooks().length === 0`，结果开发者库里一有真书就永久失败，而且看起来像代码坏了），新增的设置键**前后各复位一次**（否则开发者下次 `npm run electron` 会静默导出到 `%TEMP%`）。
  2. **不要测会弹原生对话框的通道**（`dialog:chooseDirectory`、`export:saveFile`）——它们会挂到超时。只断言 preload 函数存在 + 非法入参返回类型化错误。也**不要测** `openFolder({dir: <存在的目录>})`，那会在开发机上真的弹出资源管理器窗口。
  3. 判断「某个 key 存不存在」必须用 `db.rawGet` / `db.rawDelete`，**不能走 `getChapters(null)`**——守卫让它恒返回 `[]`，键不存在时也是 `[]`，断言恒真、毫无价值。同理，测关书守卫要**直调 storage 层**：`persistChapter('不存在的id')` 在 `store.chapters` 里找不到就直接返回了，根本到不了存储层。
- mock 服务器仅在 `SMOKE_TEST` 模式启动，生产代码不含测试痕迹。
- **Android 侧无法用冒烟测试覆盖**：它是 Electron 专属机制，且 `tests/` 不在 electron-builder 的 `files` 里。Android 只能靠构建产物校验（见「Android」章节）。

## 发布与 CI（GitHub Actions）

`.github/workflows/release.yml`：推送 `v*` tag 时，`windows-latest` 与 `ubuntu-latest` 两个 job
并行出产物（安装版/便携版 exe、Android debug APK），第三个 job 合并并发布 Release。
`workflow_dispatch` **只构建、不发布**，产物在 Actions 页面的 Artifacts 里，用于上线前干跑。

发版顺序：改 `package.json` 的 `version`（决定 exe 内部版本号）→ 改 `android/app/build.gradle`
的 `versionCode` / `versionName`（**Capacitor 不会自动同步它**，不改的话 APK 里显示的仍是旧版本号）
→ 改 `RELEASE_NOTES.md`（正文 + 下载表里的版本号）→ 提交推送 → 打 tag 推送。

**跑的是 tag 指向的那个提交里的 workflow**——所以改了 `release.yml` 必须先推 main 再打 tag，
否则新 tag 用的仍是旧流程。同理，**「重新运行」一个历史 run 不会采用新的 workflow**，
那条路修不了配置问题（重写 v1.0.0 就是因为这个才必须删 tag 重推）。

### 五条硬约束（每一条都真的挂过一次，别改回去）

1. **Node ≥22，workflow 里固定 24**。`@capacitor/cli` 的 `engines` 是 `>=22.0.0`，
   不够时它在启动时直接 `[fatal]` 退出。**只影响 android job**——`npm run dev` /
   `npm run electron` / `npm run dist:win` 在 Node 18 上都能跑，所以低版本 Node 下
   表现为「前端一切正常、只有 Android 构建突然失败」。本机是 v24，正是它掩盖了这个问题。
2. **action 版本有下限**（GitHub 已于 2026-09-16 移除 Node 20 运行时）：
   `upload-artifact` **≥v6**（v5 仍是 node20）、`download-artifact` **≥v7**（v5/v6 仍是 node20）、
   `setup-android` **≥v4**（v3 会直接崩），其余取各自最低的 node24 大版本。
   升级时查 `action.yml` 里的 `runs.using`，**别只看版本号大小**——中间版本可能仍是 node20。
3. **产物文件名必须是纯 ASCII**。artifact「上传→下载」这一轮会**直接丢弃非 ASCII 字符**：
   便携版原叫 `Novel-Studio-便携版.exe`，发出来变成 `Novel-Studio-.exe`，既看不出是便携版、
   也和 README/Release notes 对不上。故 windows job 在上传前显式重命名为
   `Novel-Studio-Setup/Portable-<tag>.exe`（**本地 `npm run dist:win` 仍产出中文名**，
   只改发布链路）。新增产物一律走同样的路子。
4. **`--publish never` 不能省**。不加时 electron-builder 在 CI + tag 环境下可能自己去发一次，
   与 release job 抢同一个 Release。
5. **改 Release 正文要改 `RELEASE_NOTES.md`**（release job 以 `body_path` 引用它），
   不要在网页上直接改——下次发版会被覆盖。

### 两个只在 CI 上成立的差异

- android job 把 `gradle-wrapper.properties` 的腾讯镜像 `sed` 回官方源——那个镜像是给
  中国大陆本机用的，GitHub runner 在境外。**只改 CI 里的那份副本，仓库文件不动**。
- release job 会先**清空该 Release 上的既有产物**再上传：`action-gh-release` 只覆盖同名资产、
  不删多余的，重跑同一个 tag 时旧文件会残留下来（重写 v1.0.0 时踩过）。

### 排查 CI 失败的姿势

**日志正文需要仓库管理员权限**（API 返回 403 "Must have admin rights to Repository."），
但 **step 级结论是公开可读的**：

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/actions/runs/<run_id>/jobs"
# 看每个 job 的 steps[].conclusion，能定位到具体是哪一步红的
```

所以 workflow 里的步骤要**尽量拆细**：「构建渲染层」与「同步进原生工程」本可以合成一条
`run`，拆成两步就是为了失败时能定位到具体命令。新增多命令步骤时沿用这个做法。

另有一个容易误判的点：**Annotations 里那几条 deprecation 警告不是失败原因**，
真正的错误在日志正文里。别被它们带偏。

## 版本库约定（.gitignore / .gitattributes）

本仓库按开源项目组织，附带 MIT 许可证（根目录 `LICENSE`）。几条刻意为之、**看起来像配置错误其实不是**的约定：

1. **`.gitignore` 里的 `*.txt` 与 `备份/` 是刻意的，但有个坑**：本项目导出正文就是 `.txt`、自动备份目录就叫「备份」。若有人把设置里的「保存地址」指向仓库目录，整本小说会被 `git add` 进去——这是本仓库的头号误提交风险，故一律忽略。
   **代价**：以后往仓库里加任何 `.txt`（测试夹具、示例数据）都会**被静默忽略**，`git status` 不显示、没有警告，很容易以为是文件没保存。真需要提交 `.txt` 就用 `git add -f`，或在那条规则下加 `!` 例外。
   **同一条风险的第二份**：全量备份是一个含全部正文与设定的 `.json`（默认名见 `snapshot.js` 的 `buildSnapshotName`），也能被「保存地址直写」写进仓库。故忽略 `NovelStudio-全量备份-*.json`——只忽略这一个前缀而**不是** `*.json`，后者会把 `package.json` 之流也一起忽略掉。改名时两处要同步。
2. **`android/gradlew` 必须保持可执行位（mode `100755`）**，否则 Linux / macOS 克隆后 `./gradlew` 直接无法执行。**Windows 上这个位容易在重新 `git add` 或 checkout 时丢掉**，提交前用 `git ls-files -s android/gradlew` 复查，掉了就用 `git update-index --chmod=+x android/gradlew` 补回。
3. **`.gitattributes` 固定了换行符**：`* text=auto`（仓库内存 LF）、`gradlew`/`*.sh` 强制 LF、`*.bat` 强制 CRLF。`gradlew` 那条是必需的——它带 CRLF 时在 Unix 上会报 `sh\r: No such file or directory`。新增二进制类型记得加进 `binary` 列表。
4. **以下三类文件永远不要提交**（前两类已在 `.gitignore` 里，第三类只能靠自觉）：
   - 本机与个人偏好：`.claude/settings.local.json`、`android/local.properties`（含本机 SDK 路径）
   - 密钥：`*.jks` / `*.keystore` / `.env*`（本项目 API Key 存在用户本机 IndexedDB，仓库里本就没有）
   - **`android/gradle.properties` 里被注释掉的 `org.gradle.java.home`**：本机图省事取消注释后，**改完不要 commit**（理由见「Android」章节）
5. 中间产物均已忽略，克隆后 `npm run build` 即可重新生成：`dist/`、`release/`、`node_modules/`、`android/build/`、`android/app/build/`、`android/.kotlin/`、`android/app/src/main/assets/public/`（`cap sync` 的产物）。

## 数据模型（IndexedDB）

- `books`（键 `books`）：`{ id, title, intro, coverColor, createdAt, updatedAt }`
- `chapters`（键 `chapters:{bookId}`）：`{ id, bookId, title, content, order, updatedAt }`，按 `order` 排序。V2 追加的字段**全部可选**：`arcId`、`summary`、`purpose`、`status`、`wordCount`、`timelineStart`、`timelineEnd`。
- `outlines`（键 `outlines:{bookId}`）：`{ id, bookId, type: 'outline'|'character'|'world', title, content, updatedAt }`。迁移会在行上**追加** `migratedTo: [newId]`，其余字段一字不改。
- `meta`（键 `meta`）：`{ schemaVersion, updatedAt }`。**刻意不放 settings**：`settings.load()` 会把缺失的键回填成默认值，被回填出来的 `schemaVersion` 恒假，而它恰恰用来判断要不要升级。
- `settings`（键 `settings`）：单条，字段见 `src/store/settings.js` 的 `defaultSettings`。默认 `baseUrl: 'https://api.deepseek.com'`（不带 `/v1`，由 `buildChatUrl` 补路径）。

  「保存与导出」七个键（仅桌面端生效；Android 上设置面板整节隐藏）：

  | 键 | 默认 | 含义 |
  |---|---|---|
  | `saveDir` | `''` | 小说保存目录（绝对路径）；`''` = 未设置，导出时弹保存框 |
  | `exportMode` | `'direct'` | `'direct'` 直写 saveDir \| `'ask'` 每次弹保存框 |
  | `perBookFolder` | `true` | 在 saveDir 下按书名建子文件夹 |
  | `openFolderAfterExport` | `false` | 导出后在资源管理器中定位文件 |
  | `autoBackup` | `false` | 定时自动备份整本 |
  | `backupInterval` | `10` | 自动备份间隔（分钟） |
  | `backupKeep` | `20` | 每本书最多保留的备份份数 |

  **无需迁移代码**：`load()` 走 `Object.assign(settings, defaultSettings, s)`，旧记录缺的键自动补成默认值——由冒烟测试的 `settingsBackfill` 断言钉死。`exportMode` 默认 `'direct'` 是安全的，因为 `saveDir` 默认为空时会自动回落到对话框，老用户零行为变化。

  V2 追加的键（同样由 `settingsBackfill` 与测试里的 `NEW_KEYS` 复位清单覆盖）：

  | 键 | 默认 | 含义 |
  |---|---|---|
  | `showUsage` | `true` | AI 面板显示本次 token 与金额 |
  | `streamUsage` | `true` | 请求带 `stream_options.include_usage`（少数兼容端点不认，给用户关掉的开关） |
  | `pricing` | `DEFAULT_PRICING`（数组） | 可编辑价目表 |
  | `contextBudget` | `6000` | Context Builder 的 token 预算 |
  | `autoExtractMemory` | `true` | 写完自动提取记忆（「写 + 提取」档） |
  | `reviewHighRisk` | `true` | 高风险变更进审阅队列 |
  | `versionKeep` | `10` | 每章最多保留多少个历史版本（裁剪不写墓碑，见「V2 第二阶段」） |
  | `syncPort` | `8787` | 电脑端监听端口（被占用时主进程向后试，实际端口以界面显示的为准） |
  | `syncAutoStart` | `false` | 下次启动自动开启同步服务。**默认 false 是安全默认**，且它是用户「我知道这会在局域网上开一个端口」的明确表示 |
  | `syncUrl` | `''` | 手机端：电脑地址，如 `192.168.1.5:8787` |
  | `syncCode` | `''` | 手机端：6 位配对码（**电脑端的码不在这里**，它只存在主进程内存里） |

  **坑**：`load()` 是**浅合并**，而 `pricing` 是数组——存储里的旧数组会整体替换默认值，以后给默认条目加字段时老用户那里就缺字段。故 `load()` 之后必须跑一次 `normalizePricing(settings.pricing)` 补齐，由 `pricingNormalizeOk` 钉死。**给 `DEFAULT_PRICING` 的条目加字段时，必须同步改 `normalizePricing`。**

### V2 领域集合（键 `{集合名}:{bookId}`）

`storage.js` 的 `COLLECTIONS` 清单即唯一事实来源，`coll.xxx` 由 `makeCollection(name)` 工厂生成：`volumes`（卷）、`arcs`（篇）、`characters`、`locations`、`factions`、`worldRules`、`events`（时间线）、`foreshadowing`、`generationRuns`、`reviewQueue`、`chapterVersions`（章节历史版本）、`tombstones`。

**加一条集合名就在这里加一行，别处都不用动**：`serialize` / `toPlain` / `!bookId` 守卫由工厂保证，`deleteBook` 的级联删键自动覆盖，`snapshot.js` 的 `DATA_COLLECTIONS` 由这份清单派生因而新集合**自动进全量备份与设备同步**。第二阶段加 `chapterVersions` 就是这一条的最好例子——数据层只写了一行。

字段定义**只看 `src/services/novel/schemas.js` 的 `ENTITY_SCHEMAS`**——它同时驱动三件事：控制台的表单/表格渲染（`EntityTable.vue` 一个组件通吃八个实体）、Context Builder 的层文本（`renderEntity`）、记忆提取的 JSON 约束（`extractionSpec`）。加字段只改 schema，三处自动跟上；反过来，**在别处硬编码实体字段名一定会与它分叉**。

`chapters` / `outlines` **刻意不迁进工厂**：它们的排序与重编号行为被断言钉着，重写只有风险没有收益。

## 提示词组装（prompts.js）

`buildMessages(action, {...})` 生成 `[system, user]` 两轮消息：system 为作者身份 + 设定上下文（按设置开关 `includeOutline/includeCharacters/includeWorld` 决定是否携带大纲/人物/世界观）；user 按 `action` 分支——`continue`（尾随当前章+前 N 章上下文）/ `expand` / `rewrite`（作用于 `selection`）/ `outline`（分章大纲）/ `chapter`（按大纲生成一章）。改提示词注意让 AI「直接输出正文、不输出标题」的约束始终保留。

`collectOutlineText(outlines)` 汇总**所有**「故事大纲」型设定（侧边栏允许建任意多条，旧实现用 `.find()` 只取第一条）。**只有一条时走与历史逐字一致的 `tail(content, 8000)` 分支**——这是刻意的，避免提示词回归、也保住既有的冒烟断言；多条时按 `《标题》\n内容` 拼接、每条 `tail(…, 4000)`（人物/世界观本就无界拼接，十几条大纲各带全文会撑爆上下文）。

V2 起它被 `services/novel/contextBuilder.js` 复用（导出后导入，不复制），并由 `messagesFromContext(ctx)` 把 `{system, context, task}` 变成 `[system, user]`。`buildMessages` 原样保留供旧路径与断言使用，两者的分工见「V2 记忆层」第 3 条。

## V2 记忆层（改领域功能前必读）

规格书在 `docs/`（6 份，来自 `NovelStudio_V2_Spec`）。**05_CLAUDE_ADDENDUM_V2.md 自己要求「改领域功能前先读 docs/」**，本节省略了与既有约定重叠的部分（安全边界、`toPlain`、`serialize`、冒烟纪律都以本文件为准）。

第一阶段已落地：存储地基 + 迁移 + Context Builder + token 计费 + 编排器 + 控制台 UI + 快照。第二阶段也已落地：章节版本历史、时间线可视化、一致性检查、局域网电脑 ↔ 手机同步——**见本文件末尾的「V2 第二阶段」一节**，那一节才是改这四块功能时的依据。

`snapshot.js` 当初是给同步铺的路，现在两条路都在用它：`applySnapshot` 是「恢复全量备份」与「局域网同步」**共用的同一个落库入口**，合并规则只有那一份。改它等于同时改这两个功能，改完两条都要验。

### 1. 删除只有一种表示：墓碑

不给记录加 `deleted` 标记，而是统一记在 `tombstones:{bookId}` 里：`{ id, type, deletedAt }`。理由与两条硬约束：

- 加标记的代价是**每个列表渲染都要记得过滤**，漏一处就把删掉的人物显示出来；独立一张表则让 `getAll` 天然只返回活记录，渲染层零改动。
- `coll.remove` 的顺序是**先写墓碑、再摘记录**（跨键没有事务，`serialize` 是 per-key 的，必须选一个失败方向）：墓碑成功而删除失败只留下一条无害的多余墓碑；反过来的失败会让删掉的记录在另一台设备上复活。
- `deleteChapter` / `deleteOutline` 在既有硬删除逻辑**之外追加**一次墓碑写入，数组语义与 UI 行为完全不变。这条不是锦上添花——章节恰恰是用户删得最多的东西。
- `deleteBook` 走 `bookTombstones`（全局键，书都没了没有 bookId 可挂），并**级联删除全部 `COLLECTIONS` 键**。级联只覆盖新集合，`chapters` / `outlines` 的既有删除逻辑不动。

### 2. 集合工厂 `coll`（`serialize` 的结构性保证）

新增 per-book 集合一律用 `coll.xxx.upsert/saveAll/remove/getAll`，**不要自己 `set(key, …)`**：工厂把「`serialize(collKey)` + `toPlain()` + `!bookId` 守卫」三件事固化成结构性保证，而不是「记得加」的约定——漏掉 `serialize` 意味着并发写互相覆盖，这种缺陷不报错，只是静默丢数据。

`upsert` 会补 `createdAt`（沿用原值，刷新就丢了「什么时候建的」）与 `updatedAt`（每次刷新，第二阶段的同步全靠它比较）。

### 3. Context Builder（`services/novel/contextBuilder.js`）

`buildContext({...})` → `{ system, context, task, metadata }`，**全部纯函数、无 I/O**。这是「由代码决定提示词装什么，不交给模型」的落点，也是预算算法能确定性验证的前提。

- 层按 `priority` 排序，`required` 层**永不截断**（因此总量可能高于预算，`metadata.overBudget` 会如实置位）。
- 降级方向按层类型分：正文/摘要类保留**尾部**（越近越重要），规则/设定类保留**头部**。**别把两者统一。**
- `metadata.layers` 同时包含被丢弃的层（带 `label`），直接驱动 Context Preview —— 丢弃的层正是「AI 忘了这件事」的元凶，必须让用户看得见。
- **两条路径并存且不许「统一」**：`buildMessages`（V1 旧路径）供 `expand` / `rewrite` / `outline` 与既有断言使用；编排器路径（`continue` / `chapter`）必经 Context Builder。规格书 04 本就规定扩写/改写不得改动人设、世界规则、时间线与伏笔，所以它们不进编排器是**符合**而非违背规格。
- `collectOutlineText` 从 `prompts.js` 导出后由 contextBuilder 复用，只有一条大纲时走与历史**逐字一致**的 `tail(content, 8000)` 分支；多条时各 `tail(…, 4000)` 并加 `《标题》`。改这里等于改历史提示词。

### 4. 编排器（`services/ai/orchestrator.js`）

`runChapterWorkflow({ input, settings, stages, recordRun, callbacks })`，默认 `['write','extract']`。四条不许改回去的设计：

1. **只有提交记忆会写库**（`commitChanges`），所以中途中止不会留下半提交状态。
2. **只有第一阶段（写正文）失败才算整次运行失败**（`settleStatus()` 只看 `run.stages[0]`）。提取失败只把自己的阶段标成 error 并经 `wf.error` 传出去——正文已经拿到手了，把整次标成失败会让用户以为这一章白写了。
3. **提取重试的每一次尝试都要各自记一条账**。重试是一次真实计费调用，只记最后一次会让用户看到的金额低于账单——而「这一章花了多少钱」正是记账功能存在的意义。
4. **中止句柄必须同步交出去**（`callbacks.onControl({ abort })` 在 `await runFrom(0)` **之前**触发）。等 `runChapterWorkflow` 返回再拿，生成早就结束了，「停止」按钮等于摆设。已实测该时机是同步的，`workflowSyncAbortOk` 钉着它。

提取出的 `summary` / `timelineEnd` 是**章节**字段而不是记忆实体，所以由 `runChapterWorkflow` 回传给调用方，**只在文字真正落进某一章的那一刻**才写库（`AiPanel` 的 `applyChapterMeta`）——提取发生时正文还没被插入任何章节，只有后续的插入动作知道它落到哪儿。

### 5. usage 的两种形状（`parseSseUsage`）

**必须独立于 `choices` 判断**：DeepSeek 把 usage 挂在**最后一个内容块**上（`choices` 非空、`delta` 为空、`finish_reason` 非空），而 OpenAI / vLLM / Kimi 那类是**单独的 usage 块**（`choices: []`）。只挑 `choices.length > 0` 的行解析是这一功能最常见的实现错误——usage 会永远是 0。mock 服务器（`electron/main.js`，`/usage` 路径）两种形状都发，`usageParseOk` 钉死。

两条传输路径都要接（IPC 与浏览器直连），但**不需要新增 IPC 通道**：主进程早已把原始 SSE 行透传给渲染进程，`parseSseUsage` 在 `ipcHub` 的 `onDelta` 处理器里跑一遍即可。`onDone` 的契约（零参）保持不变。

### 6. 价格表

`DEFAULT_PRICING` 里的 DeepSeek 条目**只作种子，不是权威**：公开资料互相矛盾且历史上多次调整。因此任何价格都不得被当成硬编码事实——设置里提供可编辑价目表并标注「请以官方定价页为准」。

`priced: false` 表示命中的是 `'*'` 兜底条目（单价 0），**必须与「花费 ¥0」区分开**：前者是「不知道多少钱」，后者会让用户以为这次调用免费。`describeRun` 与 `unpricedHonestOk` 都在守这条。

### 7. 快照与第二阶段的同步

`services/novel/snapshot.js` 是「整库备份」与将来「设备同步」**共用的一份协议**，合并规则只在 `mergeSnapshot` 里写一次：

- 同 id 记录 `updatedAt` 大的赢，**相等时保留本地**（否则重复恢复同一个文件会让本机数据来回抖动）；
- 删除靠墓碑判死：`deletedAt >= updatedAt` → 删；墓碑旧于记录 → 记录活着（说明删掉之后又被编辑过）；
- 墓碑合并只保留**最早**的删除时刻（与 `addTombstone` 一致）；
- 整书墓碑命中时，这本书的 per-book 数据一并丢弃——否则恢复后「书没了但人物还在」，而那些人永远没有入口可删。

`applySnapshot` 写回**一律走 storage 的公开写函数**，于是 `toPlain` / `serialize` 自动生效；**不要自己 `set(key, obj)`**，那会绕过写队列，与正在进行的自动保存互相覆盖。恢复是**合并不是替换**，且落盘前必须由 `diffSnapshots` 先报出「新增 / 覆盖 / 删除」各多少条——删除也必须报，报喜不报忧的确认框是在骗人。

### 8. 控制台 UI 的形态约束

`NovelConsole.vue` 是**全屏弹窗**（`.modal.console` 修饰类覆盖既有 `.modal` 的 `max-width:460px` + 整框滚动），**不是** WritingView 的第四栏：三栏在窄屏上已经要靠底部标签切换，再加一栏会让移动端彻底不可用。`App.vue` 的 `handleBack()` 里控制台必须排在**最前**——它盖住了设置与导出，排在后面会先把看不见的弹窗关掉，表现为「返回键坏了」。

窄屏（≤860px）整屏铺满、标签栏转横向滚动条；`WritingView` 的 `pane` 逻辑一行都不改。

**新增标签时给 `badgeOf` 加显式分支**，这是第二阶段踩过的坑：它的默认分支是 `cols.list(key).length`，而标签键与集合名**并不总是一致**——`timeline` 对应的集合叫 `events`、`versions` 与 `consistency` 根本不是集合名。不显式映射的话徽标**恒为 0**，而且它会一直安静地错着，没人看得出（`versions` 那个若按条数报又是个四位数，对用户毫无意义，所以报的是章节组数）。

### 9. 迁移

`services/migration.js`：非破坏、幂等、只增不减、**不静默执行**。只有在控制台里点「一键升级」才会跑——静默改写用户的真实数据正是本项目一贯避免的；且不开控制台的 V1 用户因此保持 100% 旧行为。

「故事大纲」**不自动转换**：一整段自由文本映射成卷/篇必然丢信息又猜错结构，由用户在控制台里手建。两道幂等护栏：源行上的 `migratedTo`，以及规范化标题比对（防「实体建好了但源行没标记」那一半失败）。Context Builder 同时读旧 `outlines` 与新实体，靠同样两道去重（`contextNoDupOk`）。

### 10. 调试入口

- 控制台「上下文与迁移」标签 = Context Preview：每层 token / 截断 / 丢弃 + 最终提示词全文。
- `window.__ns` 已挂上全部 V2 纯函数（`buildContext` / `allocate` / `extractJson` / `classifyRisk` / `mergeSnapshot` / `planMigration` / `parseSseUsage` / `captureVersion` / `pruneVersions` / `buildTimeline` / `runRuleChecks` / `CONSISTENCY_RULES` / `normalizeSyncUrl` / `handleIncomingSnapshot` / `reloadAfterSync` / `pushSnapshot` / `syncStatus` …）。**新增纯函数不加进去等于没被测试。**
- 局域网同步在 DevTools 里调：`await __ns.syncStatus()` 看开着没、`await __ns.testConnection('192.168.1.5:8787')` 打一发 `/hello`、`await __ns.pushSnapshot(url, code)` 走一次真实合并（在电脑上对自己发也能跑，两侧同库时 diff 恒为 0）。
- 手工验收清单见 README「长篇写作怎么用」与「小说控制台」两节。

## V2 第二阶段（版本 / 时间线 / 一致性 / 同步）

四块功能，共同点是**全部建立在第一阶段的数据模型之上，没有一处改既有记录的形状**，所以安装后无需迁移、`SCHEMA_VERSION` 与 `SNAPSHOT_VERSION` 都没动。改这四块之前先读这一节。

### 1. 章节版本（`services/novel/versioning.js`）

```
chapterVersions:{bookId}
{ id, bookId, chapterId, chapterTitle, content, wordCount, source, generationRunId, createdAt }
// source ∈ 'ai' | 'manual' | 'rollback' | 'delete'
```

**没有 `updatedAt`，这是刻意的**：版本是不可变的，改一个历史版本没有任何意义。同步靠 `mergeRecords` 的 `tstamp()` 回退到 `createdAt`（`snapshot.js`），所以不可变记录天然能正确合并——**别顺手给它补一个 `updatedAt`**，那会让「同一版在两端各自被刷过时间戳」变成一次无意义的覆盖。

**捕获点只有四个，全是显式调用，绝不在 `persistChapter` 里挂钩子**——那是自动保存的落点，1.5 秒防抖一次，挂在那里等于每写一段存一版：

| 触发点 | `source` | 位置 |
|---|---|---|
| AI 产出要覆盖某章已有的非空正文 | `'ai'` | `AiPanel.vue` 应用正文的动作（与 `applyChapterMeta` 同一处，那里同时拿得到 `chapterId` 与 `generationRunId`） |
| 用户点编辑器工具栏的「存档」 | `'manual'` | `Editor.vue` |
| 恢复某一版之前 | `'rollback'` | 版本面板的 `restore()`——**先存当前再覆盖**，回滚因此可撤销 |
| 删章之前 | `'delete'` | `books.js` 的 `removeChapter`。章节走硬删除，版本留下来，按「已删除章节」分组可恢复成新章——这是误删唯一的救回入口 |

**裁剪（`versionKeep`，默认 10）用 `saveAll` 整组回写，刻意不写墓碑**。裁剪是本地整理，不是用户删除：写墓碑会让它传播到另一台设备、把对方**故意**保留的更多版本也删掉，而且墓碑表会无限膨胀。代价是另一台设备下次同步可能把多出来的版本送回来——无害，版本不可变，多留几版不是数据丢失。

### 2. 时间线（`services/novel/timeline.js`）

`buildTimeline({chapters, events, foreshadowing, locations, characters, factions})` → `{ nodes, warnings }`，纯函数无 I/O。排序以 `chapters` 的 `order` 为主键（可切「按故事时间排」）；伏笔也在轴上：`firstChapterId` 是埋点、`expectedRevealChapterId` 是预期回收点，预期回收章已写完而状态仍是 `planted`/`developing` → 标「逾期未回收」（用 `ACTIVE_FORESHADOW_STATUS`，别再写一份状态枚举）。`orphan = true` 表示指向的章节已不存在。

**`warnings` 同时是一致性规则 #1 的实现**，两个功能共用一份——这是本轮最省工作量的设计，别把断链检测再写一遍。

`TimelineView.vue` 只是渲染层：竖轴用 CSS 竖线 + `::before` 圆点（不引入 SVG 依赖），表格视图原样保留供新增与编辑。点节点 → `store.selectChapter()`。

### 3. 一致性（`services/novel/consistency.js`）

`runRuleChecks({chapters, memory, structure, tombstones})` → `{ issues, stats }`，纯函数、**规则常开**（打开控制台即算）、零成本、零误报。七条：

| # | 规则 | severity |
|---|---|---|
| 1 | 断链引用（复用 `timeline.js` 的 `warnings`） | high |
| 2 | 时间线倒挂（章节 `timelineStart` 与 `order` 不同向） | medium |
| 3 | 伏笔逾期未回收 | medium |
| 4 | 已死角色仍在出场（其后的事件里仍出现在 `characterIds`） | high |
| 5 | 重复事件（同章同标题） | low |
| 6 | 章节缺摘要（正文非空但 `summary` 为空） | low |
| 7 | 记忆陈旧（`characters.lastUpdatedChapterId` 距今超过 30 章） | low |

**`consistencyCleanOk` 是这一节最重要的断言**：干净数据必须算出 **0 条**。误报比漏报更能毁掉这个功能——一个总是喊着「这里有问题」的检查，用户第三次就会忽略它。

**AI 深检是编排器的 `review` 阶段**（`STAGE_LABELS.review = '一致性审校'`，runner 注册进 `RUNNERS`），输出契约逐字采用规格书 04 的 `{issues, styleIssues, continuityIssues, severity}`，用现成 `extractJson` 解析。三条不许改回去的设计：

- **不加入 `DEFAULT_STAGES`**：它只在用户点按钮时按需跑，所以「每章写完自动检查」这类隐性花费不会发生。这是「规则常开 + AI 手动」这个组合能成立的前提。
- **必经 Context Builder**，不自己拼 prompt。
- **计费照常**（走 `record(..., 'review')` 写 `generationRuns`）：手动触发也必须是**可见花费**，否则「AI 深检」就成了唯一一处悄悄扣钱的地方。

**报告不落库，这是有意为之，别当成漏做**：报告是针对**某一版正文**的意见，正文一改就过期，存下来只是过期噪音；它也不是规格书 05 意义上的「实体」（没有需要导入导出的持久对象）。要回看历史就去「生成历史」里找那条 review 记录。`consistencyReviewNoPersistOk` 钉着它。

### 4. 局域网同步（`services/sync.js` + `electron/main.js`）

**手机发起，一次往返收敛**。手机没有服务端，所以电脑不可能主动推：

```
POST /sync   X-Pair-Code: <6位>
  体：手机的 collectSnapshot() JSON
  电脑：applySnapshot(体) → 返回 after（合并结果）   → 200
  手机：applySnapshot(响应) → 两侧一致
```

- **必须是单个 `POST` 而不是「先拉后推」**：两个请求之间任一侧写入都会丢更新，一次往返把窗口压到一个请求内。
- `GET /hello` → `{app, version, protocol, snapshotVersion, schemaVersion}`。**无鉴权、无数据**，专供手机端「测试连接」区分「地址不通」与「码不对」。`protocol: 'novel-studio-sync'` 还负责区分「端口上蹲着别的软件」。
- 错误码：`401` 码错/缺码/冷却中 · `400` bad-json/bad-snapshot · `413` 体过大 · `409` 电脑正在生成 · `503` 渲染层超时未应答 · 其余路径一律 `404`。
- 服务器只认 **两条精确路径**（`new URL(req.url, …).pathname` 全等，不是 `includes`），**无路径参数，完全不认识文件系统**。

**尺寸与配对的四道闸**，每一道都对应一个真实的攻击面：

1. **体上限 64 MB**，`Content-Length` 预检 + 累积时再判一次，超限立刻 `req.pause()` 回 413 然后 `res.on('finish', () => req.destroy())`。**发超大体的客户端看不到那个 413**（连接已被重置，Chromium 报网络错误）——这是拿「拒绝得早、不占带宽」换来的，所以**客户端必须自己先量体积**（`sync.js` 的 `pushSnapshot` 用 `new Blob([text]).size`，**不是 `text.length`**：中文是 3 字节/字符，按 length 判会让 60 MB 的中文快照看起来只有 20 MB）。
2. **6 位配对码**用 `crypto.randomInt` 生成，`crypto.timingSafeEqual` 比对，**每次开启服务重新生成，只存在主进程内存里**，不落盘、不进设置、不进日志。
3. **连续 10 次错码锁定该 IP 一分钟**。这条是必需品而不是加固：`Access-Control-Allow-Origin: *` 意味着**用户访问的任意网页**都能对这个端口发请求并读到响应，6 位码只有百万种可能，没有冷却就是可穷举的。冷却期间**正确码也拒绝**——否则它就不是锁。用户唯一的自助出口是「换一个配对码」，它同时清掉锁。
4. **CORS 与预检是必需的**：Android WebView 的 origin 是 `https://localhost`，与 `http://192.168.x.x` 跨源，且带自定义 `X-Pair-Code` 头 → 必然先发 `OPTIONS`（回 204，放行 `Content-Type, X-Pair-Code`）。少任何一个头，Android 上就一个字节都收不到。

**渲染层的硬约束（`handleIncomingSnapshot` 的顺序，四步都不能换）**：

1. **正在生成 → 直接回 busy**（主进程翻译成 409）。合并是 `saveChapters` 整组回写，与流式写入抢同一个键，撞上就是一次静默丢稿。「是否正在生成」的真相来源是 `generationStore.running`（不是 AiPanel 的局部 ref）——同步层读它，而 service 不能反向 import 组件。`AiPanel` 那个 `generating` 已改成带 getter/setter 的 `computed`，所以既有的 `generating.value = x` 一行没改。
2. **`await ui.flush()`**：把编辑器防抖窗口里的正文先落库，否则用户刚敲的几百字会被随后的整组回写覆盖掉，且没有任何提示。
3. **`applySnapshot(remote)`** — 只写库，**完全不碰 store**。
4. **`reloadAfterSync()` + `ui.reloadEditor()`**。漏掉的表现是「同步完成了但界面还是旧的，重启才变」。`reloadAfterSync` 有两处刻意不走现成函数：**不用 `init()`**（它有 `loaded` 守卫，第二次直接返回，书库列表还是旧的）、**保留 `chapterId`**（`openBook()` 会把光标重置到第一章，用户正在写第 12 章时被同步打断、正文突然跳回第 1 章，比不刷新更糟）。

**IPC 与事件中枢**：`sync:incoming`（主→渲染）＋ `sync:respond`（渲染→主）与既有 `llm:*` 同构；`ensureSyncHub()` **在模块加载时注册一次**，按 `requestId` 分发——CLAUDE.md 坑 #2 的铁律在同步通道上一模一样地成立，**不得**改回函数体内注册。主进程侧 `askRenderer` 有 20 秒超时，超时后迟到的应答拿到 `ESTALE`（不是错误，直接丢弃）。`handleSyncRequest` 之外的任何一处抛出都会让请求没有下文，所以那些回调里的 `try/catch` 是必需品，不是防御性冗余。

**安全边界（README 与发版说明里写的口径，不要放松）**：

- **快照里没有 `settings`** —— `collectSnapshot` 只读 books / chapters / outlines / 集合 / 墓碑，**API Key 永不出本机**。`snapshotNoApiKeyOk` 断言把它钉死。
- 默认关闭；只在局域网可达（绑定本机网卡地址，不做端口映射）；每次开启换码；主进程不认识文件系统。
- **措辞一律用「局域网同步」，不用「云同步」**：这是两台自己的设备直连，数据不经过任何第三方服务器，与「本地优先、不提供云端存储」一致。用「云同步」会让用户以为有中转服务，那是另一个东西。
- 手机端明文 HTTP 目前**只在 debug APK 生效**（`capacitor.config.ts` 的 `cleartext: true` + `allowMixedContent: true`），release 需另配 `networkSecurityConfig` —— 沿用既有的限制说明，不许含糊。

**地址列表刻意列出全部网卡**（`os.networkInterfaces()` 的 IPv4 非 internal，私网段排前面）：Windows 上 VPN / WSL / VirtualBox 的虚拟网卡很常见，**猜错比列出来更糟**——猜错的表现是「电脑上显示了一个手机永远连不上的地址」，而用户没有任何办法知道问题出在哪。同理，端口被占用时向后试 10 个并把**实际端口**回报给界面，比报「端口被占」友好得多。

`normalizeSyncUrl` **先看有没有协议头再补**，两步不能合并成「先补 `http://` 再判协议」：那样 `file:///C:/Windows` 会被解析成主机名 `file`，得到一个语法完全合法、实则毫无意义的 `http://file:8787`，用户只会看到「连不上」，而他填的明明是一个「地址」。

### 5. 设置面板的同步节

`SyncPanel.vue` **一个组件两副面孔**（按 `isDesktop()` 分），放在 `SettingsPanel.vue` 的 `v-if="desktop"` **之外**——同步在电脑与手机两端都要能配：电脑端配的是服务本身，手机端配的是「连哪台电脑」。做成一个组件而不是两个，是因为两副面孔共享同一块设置区与同一个「上次结果」版式，拆开的结果是两边各写一份渲染然后慢慢分叉。

## Android

`android/` 是 `npx cap add android` 生成的原生工程，已配置完成并验证可产出 APK。

### 工具链（版本彼此咬合，改一个就要重验全套）

| 项 | 版本 | 位置 / 说明 |
|---|---|---|
| Node.js | **≥22**（CI 用 24） | `@capacitor/cli` 的 `engines` 要求。**只影响 `cap sync`**，浏览器与 Electron 流程 18 即可 |
| JDK | **21**（21~24 均可） | `C:/Android/jdk21`（本机路径，**不写进仓库**） |
| Gradle | **8.14.3** | `android/gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | **8.13.0** | Capacitor 8 模板自带 |
| Android SDK | platform-tools + platforms;android-36 + build-tools;36.0.0 | `C:/Android/Sdk`（选纯 ASCII 无空格路径——Android 构建对含空格/非 ASCII 的 SDK 路径有历史性故障） |
| compileSdk / targetSdk | **36** | |
| minSdk | **24**（Android 7.0） | |

**为什么必须单独装 JDK 21**：Capacitor 8 的 `capacitor/build.gradle` 写死 `sourceCompatibility JavaVersion.VERSION_21`，而 Gradle 8.14.3 最高只支持 Java 24——系统默认的 **JDK 26 会被直接拒绝**。JDK 21 只在两处显式使用，**系统 `JAVA_HOME` 保持不动**（其他工作依赖 JDK 26）：
- 跑 `sdkmanager` 时内联 `JAVA_HOME="C:/Android/jdk21"`；
- 跑 Gradle 时在命令前内联 `JAVA_HOME="C:/Android/jdk21" ./gradlew assembleDebug`。

**`android/gradle.properties` 里刻意没有 `org.gradle.java.home`**：那是一个本机绝对路径，
一旦提交，别人克隆后 Groovy/Gradle 会去一个不存在的目录找 JDK，**Android 构建直接失败**，
且报错信息指向 JDK 而不是这个配置，很难查。仓库里只保留了一段注释说明该机制；
本机要省掉每次内联 `JAVA_HOME` 的话，自行取消注释并改成自己的路径（**改完不要 commit**）。

### 网络注意（换机/清缓存后需重做）

- Gradle 发行包（约 200MB）**已改成腾讯镜像**：`android/gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip`（实测 0.1s vs 官方 17s）。删掉这一行会退回龟速下载。**GitHub Actions 上会临时换回官方源**
（runner 在境外），见「发布与 CI」章节。
- Maven 仓库保持模板默认的 `google()` / `mavenCentral()`，直连实测够快，**不需要改**。
- `android/local.properties` 里 `sdk.dir=C:/Android/Sdk`（此文件是本机路径，不入库）。

### 构建与校验

```bash
npm run build
npx cap sync android            # 把 dist/ 复制到 android/app/src/main/assets/public/，改了渲染层代码必须重跑
                                # 它也负责把 @capacitor/* 插件注册进原生工程（当前 5 个）
cd android && JAVA_HOME="C:/Android/jdk21" ./gradlew assembleDebug --no-daemon
# JAVA_HOME 内联是必需的：仓库里没有 org.gradle.java.home（见上）
# 产物：android/app/build/outputs/apk/debug/app-debug.apk

# 校验产物元信息（不装模拟器也能验）
"C:/Android/Sdk/build-tools/36.0.0/aapt" dump badging <apk路径>
```

期望看到：`package: name='com.novelstudio.app'`、`sdkVersion:'24'`、`targetSdkVersion:'36'`、`compileSdkVersion='36'`、`application-label:'Novel Studio'`。

### 双端兼容约定

- **平台判定一律走 `src/services/platform.js`** 的 `isDesktop()` / `isNative()` / `isWeb()` / `isNarrowLayout()`，不要在组件里散写 `window.electronAPI?.isDesktop`。
- **Capacitor 插件全部动态 import**，见「重要约定与坑」#13。
- **Android 导出走系统分享面板**（`native.js` 的 `shareTextFile`）：写 `Directory.Cache` → `Share.share({url})`。选 Cache 而非 Documents 是刻意的——Documents 在 minSdk 24–28 上需要 `WRITE_EXTERNAL_STORAGE` 运行时权限，而 Cache + 分享**零权限**即可让用户把 TXT 存到任意位置。已从 Capacitor 源码确认 `SharePlugin` 接受 `file://` url 并经 `FileProvider`（`AndroidManifest.xml` 中 authority 为 `${applicationId}.fileprovider`）授权。
- **`window.prompt` 在 WebView 里不存在**，见「重要约定与坑」#12。
- **窄屏（≤860px）是三栏切换而非三栏堆叠**：`WritingView.vue` 的 `mobilePane` 只渲染一栏并配底部标签栏，`App.vue` 的 `handleBack()` 与 Android 返回键联动（AI → 正文 → 章节 → 书库 → 退出）。Android 返回键经 `native.js` 的 `registerBackButton` 注册，handler 返回 `true` 表示已消化该次返回。

### 已知限制（长期约束，不是待办）

这三条是环境与范围上的既定边界，**不要当成「还没做的 TODO」去顺手补上**：

- **Android 运行时行为在本机无法验证**：未装模拟器，且冒烟测试是 Electron 专属机制。窄屏布局、软键盘、返回键、分享导出、安全区**只能装到真机上验**。
  **构建成功 ≠ 运行正常**——`gradlew assembleDebug` 通过只说明能编出包，不说明能跑起来。
- **不出 Release 签名 APK**：需要 keystore 与密码；且 release 若要支持明文 `http://` 的 LLM 端点，还需额外配置 `networkSecurityConfig`。当前 `capacitor.config.ts` 的 `cleartext: true` + `allowMixedContent: true` **只服务 debug**，不要据此认为 release 也支持明文 HTTP。
- **不做 iOS**：无 macOS 环境。
