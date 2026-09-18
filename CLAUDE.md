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

- **渲染层** `src/`：Vue 3 单 SPA（`App.vue` 顶层切换 书库/写作 两个视图）。无路由、无 UI 框架，纯 `styles.css` 白底变量 + 组件内样式。
  - `store/`（Composables）：`books.js` 持有全部领域状态（`store` 为模块级 `reactive` 单例：books/bookId/chapters/outlines），`settings.js` 持有全部持久化设置（AI 接口 + 保存与导出），`toast.js` 是全局轻提示队列。跨组件共享一律通过这三处，不另起本地副本。
  - `services/`：纯函数/无状态模块，供 store 与组件调用。`storage.js` 封装 idb-keyval；`llm.js` 是 LLM 客户端（见下）；`prompts.js` 组装 `messages`；`export.js` 生成 TXT/MD 文本与落盘分发；`autosave.js` 是自动保存调度器；`backup.js` 定时备份；`platform.js` 统一平台判定；`native.js` 是 Capacitor 插件薄封装。
  - `main.js` 额外挂 `window.__ns` 测试钩子（db / store 工厂 / buildMessages / chatStream / 导出与自动保存的纯函数等），供冒烟测试注入脚本使用。
- **Electron 壳** `electron/`：`main.js` 创建窗口 + IPC；`preload.js` 通过 `contextBridge` 暴露 `window.electronAPI`。`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`（LLM 请求必须走主进程代理，规避 CORS）。**所有 `fs` / `shell` / `dialog` 调用只在主进程**，这三个安全开关不得放开。

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

  `export:saveFile` 与 `export:writeToDir` **刻意不合并**：返回契约不同（前者是 UI 结果，后者是 I/O 结果）。
- **打包**：`electron-builder.yml`（win: nsis + portable，x64）。浏览器/Android 共用 `dist/` 产物；`android/` 不进 Electron 包（`files` 只含 `dist/**` 与 `electron/**`）。应用图标 `build/icon.ico` 由 `node scripts/gen-icon.mjs` 生成（纯 Node 手写 PNG + ICO 封装，无第三方依赖）——**换图标改这个脚本重跑即可，不要去装图标库**。
- **CSP 写在 `index.html` 的 `<meta http-equiv>` 里**（`script-src 'self'`、`connect-src 'self' http: https:`）：渲染层不能加内联 `<script>`、也不能引 CDN 脚本；新增的任何 `fetch` 目标协议必须已在 `connect-src` 中。改 LLM 端点本身不用动它（`http:`/`https:` 已全放行）。

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
- `tests/smoke-inject.js` 共 48 项断言，沿用「扁平 `out` 对象 + `out.pass` 全部取 AND」的写法（**不要嵌套子对象**，`pass` 里漏掉一项就等于没有这项测试）。覆盖：设置默认值与旧记录回填、文件名净化、自动保存的防抖/冲刷/不串目标、多条大纲注入、目录直写的字节数与同名冲突、越界路径拒绝（含删除诱饵验证）、改名、关书守卫、**真实点击路径的组件挂载**，以及 3 条流式管线。
- **没有「只跑某一项」的运行器——这是有意的，别去补**：48 项挤在一次 `executeJavaScript` 里，`SMOKE_TEST=1` 要么全跑要么不跑。要单独验证某一项时，两条更省事的路子：
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

发版顺序：改 `package.json` 的 `version`（决定 exe 内部版本号）→ 改 `RELEASE_NOTES.md`
（正文 + 下载表里的版本号）→ 提交推送 → 打 tag 推送。

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
2. **`android/gradlew` 必须保持可执行位（mode `100755`）**，否则 Linux / macOS 克隆后 `./gradlew` 直接无法执行。**Windows 上这个位容易在重新 `git add` 或 checkout 时丢掉**，提交前用 `git ls-files -s android/gradlew` 复查，掉了就用 `git update-index --chmod=+x android/gradlew` 补回。
3. **`.gitattributes` 固定了换行符**：`* text=auto`（仓库内存 LF）、`gradlew`/`*.sh` 强制 LF、`*.bat` 强制 CRLF。`gradlew` 那条是必需的——它带 CRLF 时在 Unix 上会报 `sh\r: No such file or directory`。新增二进制类型记得加进 `binary` 列表。
4. **以下三类文件永远不要提交**（前两类已在 `.gitignore` 里，第三类只能靠自觉）：
   - 本机与个人偏好：`.claude/settings.local.json`、`android/local.properties`（含本机 SDK 路径）
   - 密钥：`*.jks` / `*.keystore` / `.env*`（本项目 API Key 存在用户本机 IndexedDB，仓库里本就没有）
   - **`android/gradle.properties` 里被注释掉的 `org.gradle.java.home`**：本机图省事取消注释后，**改完不要 commit**（理由见「Android」章节）
5. 中间产物均已忽略，克隆后 `npm run build` 即可重新生成：`dist/`、`release/`、`node_modules/`、`android/build/`、`android/app/build/`、`android/.kotlin/`、`android/app/src/main/assets/public/`（`cap sync` 的产物）。

## 数据模型（IndexedDB）

- `books`（键 `books`）：`{ id, title, intro, coverColor, createdAt, updatedAt }`
- `chapters`（键 `chapters:{bookId}`）：`{ id, bookId, title, content, order, updatedAt }`，按 `order` 排序
- `outlines`（键 `outlines:{bookId}`）：`{ id, bookId, type: 'outline'|'character'|'world', title, content, updatedAt }`
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

## 提示词组装（prompts.js）

`buildMessages(action, {...})` 生成 `[system, user]` 两轮消息：system 为作者身份 + 设定上下文（按设置开关 `includeOutline/includeCharacters/includeWorld` 决定是否携带大纲/人物/世界观）；user 按 `action` 分支——`continue`（尾随当前章+前 N 章上下文）/ `expand` / `rewrite`（作用于 `selection`）/ `outline`（分章大纲）/ `chapter`（按大纲生成一章）。改提示词注意让 AI「直接输出正文、不输出标题」的约束始终保留。

`collectOutlineText(outlines)` 汇总**所有**「故事大纲」型设定（侧边栏允许建任意多条，旧实现用 `.find()` 只取第一条）。**只有一条时走与历史逐字一致的 `tail(content, 8000)` 分支**——这是刻意的，避免提示词回归、也保住既有的冒烟断言；多条时按 `《标题》\n内容` 拼接、每条 `tail(…, 4000)`（人物/世界观本就无界拼接，十几条大纲各带全文会撑爆上下文）。

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
