# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

自动写小说桌面软件（Novel Studio）：Vue 3 单页应用 + Electron 桌面壳，同一套代码可跑浏览器 / Windows exe / Android（Capacitor，工具链已配好、可出 APK）。UI 与代码注释均为中文，白色简洁主题。所有数据存本机 IndexedDB（库 `novel-studio-db`，表 `novel-store`）。

## 速览（先对号入座）

- **改存储 / 加集合** → 读「数据模型」「V2 记忆层」：写库只经 `storage.js`（`serialize` + `toPlain` + `!bookId` 守卫），删除只写墓碑，快照写回只走公开写函数。
- **改生成链路** → 读「LLM 客户端双路径」「V2 记忆层 → 编排器」「V3」「V4」：只有提交记忆阶段写库；已收到正文后绝不自动重试；队列只出草稿、绝不自动写正文。
- **改同步 / 备份** → 读「V2 第二阶段 → 局域网同步」与「V4 → WebDAV」：同步顺序 `busy → flush → applySnapshot → reload`；同章双改保留冲突副本，不静默覆盖正文；设备本地态集合（队列/草稿/检索向量）不进快照。
- **改界面** → 读「重要约定与坑」#12 / #14 与「控制台 UI 的形态约束」：不新增第三层视图；不用 `window.prompt/confirm`；Vue 会吞掉回调里的异常，出错的组件照样渲染。
- **验证顺序** → `npm test` → `npm run build` → `SMOKE_TEST=1 npx electron .`；动了打包配置再加 `npm run dist:win:dir`，并**真的启动一次** exe；动了界面就 `npm run screenshots && npm run screenshots:check`；动了 Android 配置就跑 debug + release 并用 `apksigner verify` 验签。

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
# 签名 release（需 android/keystore.properties，见「Android」章节）：
npx cap sync android && (cd android && JAVA_HOME="C:/Android/jdk21" ./gradlew assembleRelease)
# 产物：android/app/build/outputs/apk/release/app-release.apk

# 发版：推 v* tag 触发 GitHub Actions 自动构建并发布 Release（详见「发布与 CI」章节）
git tag -a v1.0.1 -m "Novel Studio v1.0.1" && git push origin v1.0.1
```

自动化测试：

```bash
npm test                                           # Node 内置 node:test，276 项，秒级
node --test tests/unit/errors.test.mjs             # 只跑一个测试文件
node --test --test-name-pattern="脱敏" tests/unit/errors.test.mjs  # 只跑匹配的用例
npm run build && SMOKE_TEST=1 npx electron .       # Electron 端到端冒烟，232 项断言
npm run screenshots                                # 在临时 userData 里重建 docs/ 下 7 张截图
npm run screenshots:check                          # 校验截图存在 / PNG / 1440×900 / >20KB
```

项目**没有 lint / 格式化脚本**（纯 JS，无 TypeScript）：`npm run build` 是唯一的编译门槛，
它只验证「能打包」，不验证行为——行为靠单测与冒烟。

`npm test` 只跑 `tests/unit/*.test.mjs` 里的纯函数与内存态断言，不碰 IndexedDB / Electron，
CI 的 windows 与 android job 都会执行。`src/package.json` 里的 `"type": "module"` 是必需项：
根目录 `package.json` 不能加（`electron/main.js` 是 CommonJS），但那会让 Node 把 `src/` 下的
`.js` 当成 CommonJS，而它们全是 ESM。测试 import 时显式写 `.js` 扩展名。

冒烟测试全自动驱动核心逻辑并在主进程 stdout 打印结果，无交互、自动退出。成功时输出 `SMOKE_MOUNT ...`、`SMOKE_DETAIL {... "pass": true}`；失败时打印 `SMOKE_EVAL_ERROR` / `SMOKE_TEST_ERROR` / `SMOKE_FAIL`（见「冒烟测试机制」）。

## 架构

三层，各层解耦，浏览器与桌面共用同一渲染代码：

- **渲染层** `src/`：Vue 3 单 SPA（`App.vue` 顶层切换 书库/写作 两个视图）。无路由、无 UI 框架，纯 `styles.css` 白底变量 + 组件内样式。弹窗（设置 / 导出 / **小说控制台** / 全量备份）都是 `v-if` 渲染的层，**不新增第三层视图**。
  - `store/`（Composables）：`books.js` 持有全部领域状态（`store` 为模块级 `reactive` 单例：books/bookId/chapters/outlines），`settings.js` 持有全部持久化设置（AI 接口 + 保存与导出），`toast.js` 是全局轻提示队列。跨组件共享一律通过这三处，不另起本地副本。V2 又加了五个：`collectionSet.js`（一组按书隔离的集合的通用工厂）、`novelMemory.js` / `storyStructure.js`（记忆层与剧情骨架两族）、`novel.js`（按集合名路由到对应那族）、`generation.js`（生成记录与成本聚合）。V4 又加了两个：`writingQueue.js`（写作队列的内存态与操作入口）、`plugins.js`（已加载的插件清单与启停）。它们同样是模块级 `reactive` 单例。
  - `services/`：纯函数/无状态模块，供 store 与组件调用。`storage.js` 封装 idb-keyval；`llm.js` 是 LLM 客户端（见下）；`prompts.js` 组装 `messages`；`export.js` 生成 TXT/MD 文本与落盘分发；`autosave.js` 是自动保存调度器（状态机 `idle/dirty/saving/saved/failed` + 失败重试）；`backup.js` 定时备份；`platform.js` 统一平台判定；`native.js` 是 Capacitor 插件薄封装；`secret.js` 是 safeStorage 的薄封装（浏览器回退明文并如实标记）。V2 新增两个子目录（规格书 02 要求，既有扁平文件**不移动**）：`services/ai/`（`orchestrator.js` 多阶段工作流、`tokenUsage.js` 计量与成本，V3 又加了 `errors.js` 错误分类与脱敏、`request.js` 可靠流式请求（超时/重试/退避）、`taskStore.js` 生成任务与增量草稿、`models.js` 按任务分模型、`budget.js` 花费预算；V4 又加了 `providers.js` 服务商预设与统一调用面、`queue.js` 队列纯函数、`queueRunner.js` 串行执行器）、`services/novel/`（`schemas.js` 实体定义、`contextBuilder.js` 分层上下文、`snapshot.js` 全量快照与校验和，第二阶段又加了 `versioning.js` 章节版本、`timeline.js` 时间线与断链、`consistency.js` 一致性规则；V3 又加了 `diff.js` 版本差异、`planCheck.js` 施工卡完成度、`planning.js` 锁定节点与提案、`reviewIssues.js` 审校问题状态、`retrieval.js` 检索/反向查找/全书搜索、`stats.js` 统计、`style.js` 文风、`actions.js` 动作清单；V4 又加了 `pointers.js` 书籍指针、`planValidate.js` 生成前计划校验、`graph.js` 人物关系图）。另有根级的 `services/migration.js`（V1→V2 迁移，schemaVersion 3）、`services/sync.js`（局域网同步的渲染层一半，见「V2 第二阶段」）、`services/sync/conflicts.js`（冲突检测与确定性副本 id）、`services/ids.js`、`services/wordCount.js`、`services/settingsExtras.js`（V4 新设置键的默认值与 normalizer）。V4 新增三个子目录：`services/rag/`（`hashEmbedding.js` 哈希向量、`chunking.js` 分块、`search.js` 查询、`indexer.js` 懒索引、`context.js` 接入）、`services/plugins/`（`manifest.js` 清单校验、`hooks.js` 四个 hook）、`services/sync/webdav*.js`（WebDAV 配置与同步）；以及 `services/ai/providers.js` 等，全部纯函数、可注入。
  - `composables/usePagedList.js`：所有大列表的「每页 100 条 + 加载更多」。**不要引入虚拟列表依赖**；`watchKey` 负责在换书 / 换集合 / 换排序时回到第一页，漏掉它的表现是「换了书仍停在第 5 页」。
  - `main.js` 额外挂 `window.__ns` 测试钩子（db / store 工厂 / buildMessages / chatStream / 导出与自动保存的纯函数等），供冒烟测试注入脚本使用。**新增纯函数不加进去等于没被测试。**
  - `version.js` 的 `APP_VERSION` 来自 `vite.config.js` 注入的 `__APP_VERSION__`（唯一事实来源是 `package.json` 的 `version`），只用于快照头与界面展示；**协议兼容判断看 `SNAPSHOT_VERSION` / `SCHEMA_VERSION`，别看它**。
- **Electron 壳** `electron/`：`main.js` 创建窗口 + IPC + **局域网同步的 HTTP 服务**（见「V2 第二阶段」）；`webdav.js` 是 WebDAV 的受白名单约束的请求实现（V4）；`preload.js` 通过 `contextBridge` 暴露 `window.electronAPI`。`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`（LLM 请求必须走主进程代理，规避 CORS）。**所有 `fs` / `shell` / `dialog` / `net` 调用只在主进程**，这三个安全开关不得放开。

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
  | `webdav:request` | invoke | 受白名单约束的 DAV 请求（`PROPFIND/MKCOL/GET/HEAD/PUT`）。只允许 `http/https`、与配置地址同源、拒绝 `..`；密码由主进程从 safeStorage 取，**不写任何含密码/Authorization 的日志** |
  | `webdav:ensureDir` | invoke | 远程目录不存在时逐级 `MKCOL`。路径规则与上面一致 |
  | `plugins:list` | invoke | 列固定插件目录 `userData/plugins/*.json`（单文件 ≤256KB、最多 100 个）。坏文件只标记，不影响其他插件 |
  | `plugins:openFolder` | invoke | 在资源管理器中打开插件目录。**只此一个目录**，不接受路径参数 |
  | `secret:set` / `secret:get` / `secret:delete` | invoke | safeStorage 加密读写，`slot` 为 `'apiKey'`（默认）或 `'webdavPassword'`；未知槽返回 `EINVAL`。`isEncryptionAvailable()` 为假时返回 `unsupported`，**绝不回退成明文落盘** |
  | `app:before-close` | 主→渲染 推送 | 用户点了关窗，主进程先让渲染层 `flush()` 再关 |
  | `app:close-ready` | send（渲染→主） | 冲刷完成，可以关窗。主进程另有 2 秒超时兜底 |

  `export:saveFile` 与 `export:writeToDir` **刻意不合并**：返回契约不同（前者是 UI 结果，后者是 I/O 结果）。

  `secret:*` 的明文只在两处短暂出现：用户输入框与主进程加密前的内存。**不要给这些
  通道加日志**；`redactSecrets` 是错误路径的最后一道防线。`app:before-close` /
  `app:close-ready` 是关窗冲刷握手——主进程 `win.on('close')` 若不先问一句，
  防抖窗口里的几百字会随着窗口消失。

  `sync:*` 是第二阶段新增的，**默认关闭**：`syncAutoStart` 为 false 时主进程不创建任何
  server 对象，端到端零监听（`syncServerUpOk` 断言 `syncStatus().running === false && port === 0`）。
  这是本项目第一个长驻监听端口的组件，改它时记住两条：`app.on('before-quit', stopSyncServer)`
  已在位（否则进程会挂着一个没人在管的端口），以及 `SMOKE_TEST` 的退出前也要显式关一次
  ——`app.exit(0)` **不走** `before-quit`。
- **打包**：`electron-builder.yml`（win: nsis + portable，x64）。浏览器/Android 共用 `dist/` 产物；`android/` 不进 Electron 包（`files` 只含 `dist/**` 与 `electron/**`）。应用图标 `build/icon.ico` 由 `node scripts/gen-icon.mjs` 生成（纯 Node 手写 PNG + ICO 封装，无第三方依赖）——**换图标改这个脚本重跑即可，不要去装图标库**。`scripts/capture-screenshots.cjs` 用 Electron 在**临时 `userData`** 里写虚构数据并截图，`scripts/check-screenshots.cjs` 做静态校验；两者都不进 CI，也不读真实书库。
- **CSP 写在 `index.html` 的 `<meta http-equiv>` 里**（`script-src 'self'`、`connect-src 'self' http: https:`）：渲染层不能加内联 `<script>`、也不能引 CDN 脚本；新增的任何 `fetch` 目标协议必须已在 `connect-src` 中。改 LLM 端点本身不用动它（`http:`/`https:` 已全放行）——**局域网同步的 `http://192.168.x.x:8787` 也因此不用动它**，这正是不把 `connect-src` 收窄到具体域名的原因。

### LLM 客户端双路径（llm.js）

`chatStream({ settings, messages, callbacks, forceBrowser })`：
- **桌面端**：`window.electronAPI.isDesktop` 为真 → 渲染进程把 `{requestId, url, headers, body}` 交给主进程 `net.fetch` 代理，服务端 SSE 行经 `webContents.send('llm:delta', {requestId, line})` 逐行回传 → `parseSseLine` 提取增量文本 → `callbacks.onDelta`。
- **浏览器 / Android WebView**：渲染进程直接 `fetch` + `ReadableStream` 逐行解析（CORS 由服务端放行）。
- `buildChatUrl(baseUrl)` 自动补 `/chat/completions`；`parseSseLine(line)` 解析 `data:` 行，`[DONE]`/非 SSE 返回空串。
- **`onError` 的参数是对象**（`{ message, category, status, retryable, retryAfterMs }`），不再是字符串。分类由 `services/ai/errors.js` 做，文案经过 `redactSecrets`。
- **空闲超时**：每次收到数据重置计时，默认 60 秒（`requestIdleTimeoutSec`），超时用 `AbortController` 中止并标记为 `timeout`，与用户主动中止区分。
- **重试在上层**：`services/ai/request.js` 的可靠封装只对 network/timeout/429/5xx 重试（最多 `maxRetries=2`），指数退避 + 抖动并尊重 `Retry-After`；**已经收到任何正文之后绝不自动重试**——重发会重复计费，且两段文字拼不到一起。401/403/400/404 不重试。
- **截断**：`finish_reason === 'length'` 时阶段标 `truncated` 并保留正文，界面提示「达到输出上限」，不当成完整成功。

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
13. **Capacitor 插件一律 `await import('@capacitor/xxx')` 动态导入，且只在 native 分支内调用**（`native.js`）。这样 Electron 与浏览器产物里不会打进用不到的插件代码，构建产物会自然 code-split 出若干小 chunk——**`npm run build` 的模块数会因此明显增加（当前约 119 个）**，不是异常。
14. **Vue 会吞掉 watcher / 生命周期回调里抛出的错误**：它把事情 `console.error` 出去，然后**继续渲染**——组件照常挂载，界面照常出现。所以这类 bug 的症状不是白屏，而是「控制台一条报错 + 那个回调的后半段被静默跳过」，非常容易被漏掉。实例：`Editor.vue` 的 immediate watcher 回调里重置了 `findCursor`，而 `const findCursor` 当时声明在 watcher 下面（setup 自上而下执行，命中的是 TDZ `ReferenceError`）；因为不白屏，`npm run build`（只编译）、纯 store 层断言、以及「元素是否存在」的断言**全都发现不了**。两道防线：**相关状态声明一律排在 immediate watcher 之前**；冒烟测试的 `uiNoSwallowedErrors` 会劫持 `console.error` 并在整轮结束时断言没有 `ReferenceError`/`TypeError` 一类的被吞错误——**这条断言的价值高于任何「元素在不在」的检查**，改动组件后请留意它。
15. **审校报告不落库、只落问题状态**：`reviewIssueStates` 存的是`{id, chapterId, contentHash, status}`，完整报告仍只在内存里。报告针对某一版正文，正文一改就过期；状态是用户做出的决定，值得保留。**任何读取状态的地方都必须先比对 `contentHash`**，不一致就标「报告已过期」，不能拿旧结论去吓用户。
16. **`usePagedList` 的 `watchKey` 与「当前项可见」**：章节 / 实体 / 版本 / 历史 / 时间线的列表都分页，换书、换集合、换排序必须回到第一页（`watchKey`）；从搜索或时间线跳到远处章节时，侧栏要 `ensureChapterVisible` 展开到它，否则高亮会落在「看不见的地方」。
17. **`src/package.json` 的 `"type": "module"` 不可删**：它让 Node 把 `src/` 下的 `.js` 当 ESM 加载（`npm test` 依赖这一点）。根 `package.json` 不能加 `"type": "module"`——`electron/main.js` 是 CommonJS。测试 import 一律写完整 `.js` 扩展名。
18. **同步冲突副本的 id 必须确定性**：`conflict_<fnv1a32(chapterId, remoteDeviceId, remoteUpdatedAt)>`。用随机 id 的话，同一次同步重试会不断堆出副本；确定性 id 让重复提交幂等。首次同步只建基线、不判冲突——否则两台设备第一次握手就会因为「时间戳不同」造出一堆假副本。
19. **密钥明文只允许出现在两处**：输入框与主进程加密前的内存（API Key 与 WebDAV 密码都是）。`secret:*` 不加日志；迁移旧明文时必须**先写加密成功、再清 IndexedDB**，反过来一旦加密失败用户的 Key 就没了。`redactSecrets` 覆盖错误路径，但不要依赖它来「顺便」打印调试信息。
20. **书籍指针（当前卷/篇/章）用独立时间戳合并**：`books.currentPointerUpdatedAt` 只随指针变化更新，**绝不碰 `book.updatedAt`**——否则「换个章节」会被当成一次全书编辑，把另一台设备的正文更新压掉。写指针走 `storage.patchBook()`（在 `serialize('books')` 内读-改-写），不要用 `upsertBook` 整对象覆盖。`snapshot.js` 的 `mergeBookRecords` 负责这条规则。
21. **写作队列只生成草稿，永不自动改正文**：队列只跑 `['write']`，结果落 `generationQueue.result`，用户点「插入」时才走 `addChapterWithContent` / `captureChapterVersion` / `applyChapterMeta`；若 `autoExtractMemory` 为真，插入后再单独跑一次 `['extract']`（真实计费）。重启时 `running → interrupted` 并暂停，**不自动重跑**；任何失败项也不自动重试——每一次重试都是真实扣费。队列运行期间 `generationStore.running` 为真，局域网同步按 busy 拒绝。
22. **RAG 是本地态、默认关闭、字面检索**：`ragChunks` 在 `LOCAL_ONLY_COLLECTIONS` 里，**不进快照/同步**；IDF 在查询时按当前书全部 chunk 现算（不能存进向量，否则增量章节会让新旧权重不可比）。索引只在生成前与打开检索页时懒构建，**不要在 `persistChapter` 挂钩子**（那是自动保存落点，会与同步整组回写抢写）。任何检索异常一律返回空数组，不阻断写作。
23. **插件绝不执行代码**：只读取纯 JSON（`userData/plugins/*.json`），不得出现 `eval` / `new Function` / `import()` 插件内容；正则 flags 仅 `gimsuy`、必须能编译、拒绝空匹配；输入截断 200k、每章最多 20 条、单插件与总量都有上限。坏插件只标记错误，不能影响其他插件加载。UI 必须保留「复杂正则可能拖慢应用」的提示。
24. **WebDAV 的信任边界在主进程**：渲染层只提交 `{baseUrl, path, method, headers, body}`，主进程校验协议（仅 http/https）、同源、路径无 `..`、方法白名单、64MB 上限，并用 `redirect:'manual'` 拒绝重定向。密码只从 safeStorage 取，**任何日志都不得包含密码或 Authorization**。上传带 `If-Match`，412 时重新拉取合并、最多重试 2 次；服务器不给 `ETag` 时如实提示「无法完全防止并发覆盖」。**不做 CRDT / 实时共编 / LOCK**。
25. **生成前计划校验是提示而不是拦截**：七类规则全是确定性字面匹配，不调用 AI、不产生费用；`blockHigh` 只影响「AI 草案自动采用」与「队列自动继续」，**永远不阻断用户手工编辑**，且高风险项必须能显式覆盖。干净数据必须 0 条——新增规则要同时补 `planValidate` 的干净夹具。

### 冒烟测试机制

- 触发：`SMOKE_TEST=1` 环境变量。`electron/main.js` 会：启动本地 SSE mock 服务器（端口 `18765`，含 `带CORS` / `不带CORS` / `HTTP 500` 三条路径）→ 监听 `did-finish-load` → 先打印挂载状态 `SMOKE_MOUNT` → 建好临时目录 `%TEMP%\novel-studio-smoke` 并 `executeJavaScript('window.__nsSmokeDir = …')` 注入给渲染层 → 读 `tests/smoke-inject.js`，`replaceAll('__PORT__', 18765)` 后 `executeJavaScript` 执行 → 打印 `SMOKE_DETAIL` → 清理临时目录并退出。
- **渲染进程没有 `node:path`**，算不出临时目录，所以目录必须由主进程注入——这是 `window.__nsSmokeDir` 存在的唯一原因。
- **`tests/smoke-inject.js` 是运行时从磁盘读的**（`electron/main.js` 的 `fs.readFileSync`），不是打包进 `dist/` 的。所以**只改断言时不需要 `npm run build`**——直接 `SMOKE_TEST=1 npx electron .` 即可，迭代一轮只要几秒；只有改了 `src/` 才必须重新 build。
- `tests/smoke-inject.js` 共 **232 项断言**，沿用「扁平 `out` 对象 + `out.pass` 全部取 AND」的写法（**不要嵌套子对象**，`pass` 里漏掉一项就等于没有这项测试）。覆盖：设置默认值与旧记录回填、safeStorage 密钥迁移/读取（含 `webdavPassword` 槽）、文件名净化、自动保存的防抖/冲刷/不串目标、生命周期冲刷（pagehide）、多条大纲注入、目录直写的字节数与同名冲突、越界路径拒绝（含删除诱饵验证）、改名、关书守卫、**真实点击路径的组件挂载**、集合工厂的串行化与墓碑、迁移的幂等与非破坏、Context Builder 的预算与去重、usage 两种形状、编排器的提取/风险/中止/重试、错误分类/重试/退避/截断、快照校验和/副本重映射/恢复前快照/排除设备本地集合、章节版本的四类来源/裁剪无墓碑/回滚可撤销/删章可恢复、版本对比、施工卡与锁定提案、AI 计划草案、审校修复草案不自动覆盖与接受后落版本、时间线两种排序与断链、一致性规则（**含「干净数据必须 0 条」这条反向断言**）、全书搜索（章节命中/Enter 切章/实体跳转到正确标签）、草稿崩溃恢复、局域网同步的 HTTP 契约（预检/鉴权/冷却/体积/路由/停止/schema 拒绝）与一次真实的合并往返（含幂等、冲突副本、冲突副本幂等、生成中 409、快照无 API Key）、V4 的书籍指针恢复/删章回退/不 bump `book.updatedAt`、计划校验接入/阻止保存/覆盖保存、队列持久化/串行执行/不自动写正文/阻塞同步、RAG 建索引/增量替换/删除清理/上下文层、关系图节点与布局、WebDAV Mock 往返/ETag 冲突重试/busy 拒绝/快照无密码、插件清单隔离/上下文层/规则问题/模板导出，以及 3 条流式管线与错误路径。
- **同步相关的断言从渲染进程发真实 `fetch`**，不是直接调主进程的函数：手机端能不能连上全取决于 CORS 头与预检有没有发对，而那两样只有真发一次请求才验证得到。渲染层从 `file://`（不透明 origin）向 `http://127.0.0.1:<port>` 发请求是通的——本机回环豁免混合内容规则，加上服务端本来就发 `Access-Control-Allow-Origin: *`。所以计划里那条「退路」（主进程自己探 HTTP 再把结论注入渲染层）没有用到。
- **同步段落的客户端与服务端是同一个渲染进程**，因此「本机应用远端返回的合并结果」必然报 `diff = {0,0,0}` —— 那是**收敛（幂等）**，不是测试没生效。有意义的差集在 `syncState.lastIncoming.diff`（主进程那一侧的合并结果，也就是「手机的对手」那一侧）。
- `out.syncBigStatus` 是**诊断项，不进取 AND 链**：它记录客户端实际看到了什么（本机是 `'reset'` 而不是 `413`，见上面「V2 第二阶段」第 4 节第 1 条）。留着它是为了下一次有人问「413 到底有没有生效」时不必重新跑一遍才知道。
- 组件挂载段里的 `syncPanelToggleOk` **真的把服务开关点了一次**：`.sync-code` 只在服务运行时才渲染，它出现就说明「面板 → sync.js → 主进程 → HTTP 监听」整条链路是通的。点完要**再点一次关掉**，否则会给整轮留下一台没人管的服务（后面的 M 段还会自己开一台）。
- **没有「只跑某一项」的运行器——这是有意的，别去补**：232 项挤在一次 `executeJavaScript` 里，`SMOKE_TEST=1` 要么全跑要么不跑。要单独验证某一项时，两条更省事的路子：
  1. **在 DevTools 里手敲**（首选）：跑 `npm run dev` 或 `npm run electron`，控制台里用 `window.__ns`——它已挂好 db、store 工厂、`buildMessages`、`chatStream`、导出与自动保存的纯函数，绝大多数单项验证压根不需要碰测试脚本；
  2. 临时把其余断言短路（`if (false)` 掉），跑完**记得还原**——`out.pass` 是全体取 AND，忘了还原等于留了个永远不报错的口子。
- **组件挂载那一节必须点真实的 `.book-card`**，不能只调 store：它是唯一能覆盖「组件 setup 期抛错」的手段（见「重要约定与坑」#14）。配套的 `uiNoSwallowedErrors` 会在脚本开头劫持 `console.error`，收集整轮的被吞错误，末尾断言没有 `ReferenceError`/`TypeError` 之类——**只断言元素存在是不够的，出错的组件照样渲染**。这条断言经过反向验证：把 `Editor.vue` 的 TDZ 缺陷还原后它会失败并打印出 `at watch.immediate ...`，修好后转绿。
- **三条必须遵守的纪律**（都踩过）：
  1. 冒烟测试跑在**真实**的 `novel-studio-db` 上，不是沙箱库。所以**只清理标题为「测试小说」的书**、**绝不假设整个库是空的**（曾经断言 `getBooks().length === 0`，结果开发者库里一有真书就永久失败，而且看起来像代码坏了），新增的设置键**前后各复位一次**（否则开发者下次 `npm run electron` 会静默导出到 `%TEMP%`）。
  2. **不要测会弹原生对话框的通道**（`dialog:chooseDirectory`、`export:saveFile`）——它们会挂到超时。只断言 preload 函数存在 + 非法入参返回类型化错误。也**不要测** `openFolder({dir: <存在的目录>})`，那会在开发机上真的弹出资源管理器窗口。
  3. 判断「某个 key 存不存在」必须用 `db.rawGet` / `db.rawDelete`，**不能走 `getChapters(null)`**——守卫让它恒返回 `[]`，键不存在时也是 `[]`，断言恒真、毫无价值。同理，测关书守卫要**直调 storage 层**：`persistChapter('不存在的id')` 在 `store.chapters` 里找不到就直接返回了，根本到不了存储层。
- mock 服务器仅在 `SMOKE_TEST` 模式启动，生产代码不含测试痕迹。
- **单元测试是另一套、不要混**：`tests/unit/*.test.mjs` 用 Node 内置 `node:test`，只 import 纯函数与内存对象，**不碰 IndexedDB / Electron / DOM**；跑法是 `npm test`。新增纯函数时同时补单测并挂进 `window.__ns`——前者验证逻辑，后者让冒烟能调用它。**不要把需要 IndexedDB 的断言塞进单测**（`idb-keyval` 在 Node 里没有 indexedDB 全局）。
- **Android 侧无法用冒烟测试覆盖**：它是 Electron 专属机制，且 `tests/` 不在 electron-builder 的 `files` 里。Android 只能靠构建产物校验（见「Android」章节）。

## 发布与 CI（GitHub Actions）

`.github/workflows/release.yml`：推送 `v*` tag 时，`windows-latest` 与 `ubuntu-latest` 两个 job
并行出产物（安装版/便携版 exe、Android **签名 release APK**——未配置签名 Secrets 时退回 debug APK
并在日志与文件名里标注），第三个 job 合并并发布 Release。
`workflow_dispatch` **只构建、不发布**，产物在 Actions 页面的 Artifacts 里，用于上线前干跑。

两个构建 job 都会在构建前跑 **`npm test`**（276 项单元测试）。它们不跑 Electron 冒烟测试：
CI runner 没有可靠的 GUI 会话，且冒烟会读写真实 `novel-studio-db`；发版前请在本机手工跑一次
`SMOKE_TEST=1 npx electron .`，把 `assertionCount` 与 `pass` 写进验收记录。

发版顺序：改 `package.json` 的 `version`（决定 exe 内部版本号）→ 改 `android/app/build.gradle`
的 `versionCode` / `versionName`（**Capacitor 不会自动同步它**，不改的话 APK 里显示的仍是旧版本号）
→ 改 `RELEASE_NOTES.md`（正文 + 下载表里的版本号）→ 提交推送 → 打 tag 推送。

**跑的是 tag 指向的那个提交里的 workflow**——所以改了 `release.yml` 必须先推 main 再打 tag，
否则新 tag 用的仍是旧流程。同理，**「重新运行」一个历史 run 不会采用新的 workflow**，
那条路修不了配置问题（重写 v1.0.0 就是因为这个才必须删 tag 重推）。

### 六条硬约束（每一条都真的挂过一次，别改回去）

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
6. **Android 签名材料只经 Secrets，且绝不打印**。四个 Secrets 是
   `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
   `ANDROID_KEY_PASSWORD`；还原步骤用 `env:` 传值（密码里可能有引号/`$`，直接拼进 shell 会被二次解释）、
   `base64 -d` 写 jks、`umask 077` 写 `keystore.properties`。用 job 级 `env` 判断 Secrets 是否存在
   （`secrets` 上下文在 step 的 `if` 里不保证可用）。未配置时退回 debug 并打 `::warning::`，
   保证 `workflow_dispatch` 干跑仍可用；**正式发版前必须配好**，否则产出的包不能覆盖升级。

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
   - 密钥：`*.jks` / `*.keystore` / `.env*` / `android/keystore.properties`（桌面版 API Key 在用户本机的 safeStorage 加密文件里，浏览器/Android 在本机 IndexedDB 里，WebDAV 密码在 safeStorage 的 `webdavPassword` 槽；Android 签名材料由发布者自行保管。仓库里本就没有。**调试日志、截图、错误报告里也不许出现它们**）
   - **`android/gradle.properties` 里被注释掉的 `org.gradle.java.home`**：本机图省事取消注释后，**改完不要 commit**（理由见「Android」章节）
5. 中间产物均已忽略，克隆后 `npm run build` 即可重新生成：`dist/`、`release/`、`node_modules/`、`android/build/`、`android/app/build/`、`android/.kotlin/`、`android/app/src/main/assets/public/`（`cap sync` 的产物）。

## 数据模型（IndexedDB）

- `books`（键 `books`）：`{ id, title, intro, coverColor, plan, createdAt, updatedAt }`。`plan` 是 V3 追加的全书规划（`premise/theme/mainConflict/coreMystery/finalGoal/hardRules/endingConstraint`），旧书记录里是 `undefined`，读取处一律 `book.plan?.x || ''`；新建书时给 `{}`。V4 追加指针（可选）：`currentVolumeId/currentArcId/currentChapterId/currentPointerUpdatedAt`，只由 `patchBook` 写、按独立时间戳合并，见「重要约定与坑」#20。
- `chapters`（键 `chapters:{bookId}`）：`{ id, bookId, title, content, order, updatedAt }`，按 `order` 排序。V2 追加的字段**全部可选**：`arcId`、`summary`、`purpose`、`status`、`wordCount`、`timelineStart`、`timelineEnd`。V3 追加章节施工卡（同样全部可选）：`povCharacterId/openingState/coreConflict/mustEvents/threads/stateChanges/worldReveals/foreshadowActions/forbidden/endingHook/continuity/acceptance/targetWords/planStatus('none'|'draft'|'confirmed')/planVersion/lockedBeats`。V4 追加多设备署名：`lastEditedBy/lastEditedByName/lastEditedAt`（只在编辑正文的写入路径 stamp，`saveAll` / `applySnapshot` 不 stamp）。
- `outlines`（键 `outlines:{bookId}`）：`{ id, bookId, type: 'outline'|'character'|'world', title, content, updatedAt }`。迁移会在行上**追加** `migratedTo: [newId]`，其余字段一字不改。
- `meta`（键 `meta`）：`{ schemaVersion: 3, updatedAt, migrations }`。**刻意不放 settings**：`settings.load()` 会把缺失的键回填成默认值，被回填出来的 `schemaVersion` 恒假，而它恰恰用来判断要不要升级。V3 的 schemaVersion 只表示「新字段可用」，**不重写任何旧记录**（新字段全可选）。
- 根级辅助键（都**不进快照**）：`deviceId`（本机身份）、`syncPeers`（每台对端上次同步后的章节基线）、`preRestoreSnapshot`（恢复全量备份前的自动留底，只保留最近一份）、`generationQueueState`（V4 队列的暂停标记，设备本地态）。
- `settings`（键 `settings`）：单条，字段见 `src/store/settings.js` 的 `defaultSettings`。默认 `baseUrl: 'https://api.deepseek.com'`（不带 `/v1`，由 `buildChatUrl` 补路径）。**API Key 不按平台混存**：桌面端在 `userData/secure/api-key.bin`（safeStorage 加密），`persist()` 不把 `apiKey` 写进 IndexedDB；浏览器 / Android 没有系统级安全存储，仍是本机明文并在界面如实标注。旧明文迁移的顺序永远是「加密写成功 → 再清明文」。

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
  | `syncConflictCopies` | `true` | 同一章两端都改过时保留远端为「冲突副本」。**正文是唯一不可再生的内容，默认开** |

  V3 追加的键（同样由 `settingsBackfill` 与 `NEW_KEYS` 复位清单覆盖）：

  | 键 | 默认 | 含义 |
  |---|---|---|
  | `models` | `defaultTaskModels()` | 按任务分模型：`write/extract/review/plan/outline`。空串回退 `model`；`load()` 必须跑 `normalizeTaskModels`（浅合并坑，同 `pricing`） |
  | `includeStyle` | `true` | 生成时是否携带当前启用的文风档案 |
  | `autoApplyLowRisk` | `true` | 低风险记忆变更直接入库；关掉后连低风险也进审阅 |
  | `budgetPerCall` | `0` | 单次调用金额上限（元，0 = 不限） |
  | `budgetDaily` | `0` | 每日累计上限（元，0 = 不限） |
  | `budgetAction` | `'warn'` | `'warn'` 只提示 \| `'confirm'` 必须点「继续」 |
  | `requestIdleTimeoutSec` | `60` | 流式空闲超时（秒，0 = 关闭） |
  | `maxRetries` | `2` | 仅在**尚未收到正文**时对 network/timeout/429/5xx 重试 |
  | `secureKeyAvailable` | `false` | **运行时状态，不持久化**：桌面端 safeStorage 是否可用 |
  | `secureKeyError` | `''` | 同上，安全存储不可用时的原因（不含密钥） |

  V4 追加的键（默认值与 normalizer 都在 `src/services/settingsExtras.js`；同样由 `settingsBackfill` 与 `NEW_KEYS` 复位清单覆盖）：

  | 键 | 默认 | 含义 |
  |---|---|---|
  | `providerId` | `'deepseek'` | 仅用于预设填充与界面展示；**真正生效的永远是 `baseUrl + model`**。`normalizeProviderSettings` 在空值时会按 `baseUrl` 推断 |
  | `deviceName` | `''` | 快照头里的设备署名；空时由 `deviceId` 派生「设备 xxxx」 |
  | `planValidation` | `{enabled:true, blockHigh:true, repetitionWindow:3}` | 生成前计划校验；`blockHigh` 只拦「自动采用」，不拦手工编辑 |
  | `rag` | `{enabled:false, topK:6, minScore:0.18, budget:800, chunkChars:500, overlapChars:80}` | 本地检索。**默认关**：开启会改变提示词，不能悄悄发生 |
  | `webdav` | `{enabled:false, url:'', username:'', remoteDir:'novel-studio', autoSync:false, intervalSec:300, conflictCopies:true, timeoutSec:30, lastSyncAt:0, lastStatus:'idle', lastError:'', lastEtag:''}` | WebDAV 同步。**密码不在其中**，只在 safeStorage 的 `webdavPassword` 槽 |
  | `plugins` | `{enabled:true, disabledIds:[], contextBudget:400}` | 声明式插件开关与上下文预算；仅桌面端读取 |
  | `webdavPasswordSet` | `false` | **运行时状态，不持久化**：safeStorage 里是否已有 WebDAV 密码 |

  **坑**：`load()` 是**浅合并**，而 `pricing` 是数组、`models` / `planValidation` / `rag` / `webdav` / `plugins` 是对象——存储里的旧值会整体替换默认值，以后给默认条目加字段时老用户那里就缺字段。故 `load()` 之后必须跑对应的 normalizer 补齐，由 `pricingNormalizeOk`、`settingsBackfill` 与单测钉死。**给 `DEFAULT_PRICING` 的条目、`TASK_MODEL_KEYS` 或任一 V4 设置对象加字段时，必须同步改对应的 normalize。**

### V2 领域集合（键 `{集合名}:{bookId}`）

`storage.js` 的 `COLLECTIONS` 清单即唯一事实来源，`coll.xxx` 由 `makeCollection(name)` 工厂生成：`volumes`（卷）、`arcs`（篇）、`characters`、`locations`、`factions`、`worldRules`、`events`（时间线）、`foreshadowing`、`generationRuns`、`reviewQueue`、`chapterVersions`（章节历史版本）、`generationTasks`（流式草稿/崩溃恢复）、`memoryChangeLog`（记忆变更与撤销）、`syncConflicts`（同步冲突记录）、`scenes`（场景）、`planProposals`（锁定节拍的变更提案）、`reviewIssueStates`（审校问题状态）、`styleProfiles`（文风档案）、`tombstones`；V4 追加 `generationQueue`（写作队列）与 `ragChunks`（检索分块与向量）。

**加一条集合名就在这里加一行，别处都不用动**：`serialize` / `toPlain` / `!bookId` 守卫由工厂保证，`deleteBook` 的级联删键自动覆盖，`snapshot.js` 的 `DATA_COLLECTIONS` 由这份清单派生因而新集合**自动进全量备份与设备同步**。第二阶段加 `chapterVersions` 就是这一条的最好例子——数据层只写了一行。

**设备本地态集合有单独的清单 `snapshot.js` 的 `LOCAL_ONLY_COLLECTIONS`**：`generationTasks`（上次没跑完的调用）、`generationQueue`（排队任务同步过去会让同一批章节在两端各跑一遍、重复计费）、`ragChunks`（向量由本机算法生成，换机自动重建）。它们在 `COLLECTIONS` 里拿到工厂的全部保证，但被 `DATA_COLLECTIONS` 排除，**也不会出现在 `collectSnapshot`**。新增本地态集合时照这个做法：先进 `COLLECTIONS`，再加进 `LOCAL_ONLY_COLLECTIONS`，并把理由写在两处注释里。

字段定义**只看 `src/services/novel/schemas.js` 的 `ENTITY_SCHEMAS`**——它同时驱动三件事：控制台的表单/表格渲染（`EntityTable.vue` 一个组件通吃八个实体）、Context Builder 的层文本（`renderEntity`）、记忆提取的 JSON 约束（`extractionSpec`）。加字段只改 schema，三处自动跟上；反过来，**在别处硬编码实体字段名一定会与它分叉**。

`chapters` / `outlines` **刻意不迁进工厂**：它们的排序与重编号行为被断言钉着，重写只有风险没有收益。

## 提示词组装（prompts.js）

`buildMessages(action, {...})` 生成 `[system, user]` 两轮消息：system 为作者身份 + 设定上下文（按设置开关 `includeOutline/includeCharacters/includeWorld` 决定是否携带大纲/人物/世界观）；user 按 `action` 分支——`continue`（尾随当前章+前 N 章上下文）/ `expand` / `rewrite`（作用于 `selection`）/ `outline`（分章大纲）/ `chapter`（按大纲生成一章）。改提示词注意让 AI「直接输出正文、不输出标题」的约束始终保留。

`collectOutlineText(outlines)` 汇总**所有**「故事大纲」型设定（侧边栏允许建任意多条，旧实现用 `.find()` 只取第一条）。**只有一条时走与历史逐字一致的 `tail(content, 8000)` 分支**——这是刻意的，避免提示词回归、也保住既有的冒烟断言；多条时按 `《标题》\n内容` 拼接、每条 `tail(…, 4000)`（人物/世界观本就无界拼接，十几条大纲各带全文会撑爆上下文）。

V2 起它被 `services/novel/contextBuilder.js` 复用（导出后导入，不复制），并由 `messagesFromContext(ctx)` 把 `{system, context, task}` 变成 `[system, user]`。`buildMessages` 原样保留供旧路径与断言使用，两者的分工见「V2 记忆层」第 3 条。

## V2 记忆层（改领域功能前必读）

规格书在 `docs/`（6 份，来自 `NovelStudio_V2_Spec`）。**05_CLAUDE_ADDENDUM_V2.md 自己要求「改领域功能前先读 docs/」**，本节省略了与既有约定重叠的部分（安全边界、`toPlain`、`serialize`、冒烟纪律都以本文件为准）。`docs/07_UPGRADE_AUDIT_V3.md` 是 V3 的实施与验收报告：架构图、数据流、各阶段落地位置、测试矩阵与本机实测结果都在那里；**要判断某个 V3 能力「当初为什么这么做」时先查它**。`docs/08_UPGRADE_AUDIT_V4.md` 是 V4 的对应报告（Provider / 指针 / 计划校验 / 队列 / RAG / 关系图 / WebDAV / 插件 / 签名 APK），**改 V4 功能先看它**。

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

V3 加固（**读旧文件必须继续兼容**）：

- 快照头新增可选字段 `appVersion / counts / checksum / deviceId`。`checksum` 是对 `books + data + bookTombstones` 的规范化 JSON 做 FNV-1a 32 位；**有才校验**，没有的老文件照常可用。校验失败给出「文件损坏或被改动」并**拒绝写库**。
- `snapshotVersion > 本地` 拒绝，`schemaVersion > SCHEMA_VERSION` 拒绝；同步两端 `schemaVersion` 不同则直接报错让用户升级——**不做未知字段的半懂合并**。
- 恢复前 `BackupModal` 先把当前整库写进 `preRestoreSnapshot` 并告诉用户；「作为副本导入」走 `cloneSnapshotAsNewBooks`（重新映射每个 bookId，标题加「（导入副本）」），**不碰现有书**。
- `QuotaExceededError` 要翻译成「存储空间不足，原数据未改动」，不能把 IndexedDB 的原始英文错误抛给用户。
- `DATA_COLLECTIONS` 排除 `tombstones`（单独处理）与 `generationTasks`（设备本地）。

### 8. 控制台 UI 的形态约束

`NovelConsole.vue` 是**全屏弹窗**（`.modal.console` 修饰类覆盖既有 `.modal` 的 `max-width:460px` + 整框滚动），**不是** WritingView 的第四栏：三栏在窄屏上已经要靠底部标签切换，再加一栏会让移动端彻底不可用。`App.vue` 的 `handleBack()` 里控制台必须排在**最前**——它盖住了设置与导出，排在后面会先把看不见的弹窗关掉，表现为「返回键坏了」。

窄屏（≤860px）整屏铺满、标签栏转横向滚动条；`WritingView` 的 `pane` 逻辑一行都不改。

**新增标签时给 `badgeOf` 加显式分支**，这是第二阶段踩过的坑：它的默认分支是 `cols.list(key).length`，而标签键与集合名**并不总是一致**——`timeline` 对应的集合叫 `events`、`versions` 与 `consistency` 根本不是集合名。不显式映射的话徽标**恒为 0**，而且它会一直安静地错着，没人看得出（`versions` 那个若按条数报又是个四位数，对用户毫无意义，所以报的是章节组数）。

### 9. 迁移

`services/migration.js`：非破坏、幂等、只增不减、**不静默执行**。只有在控制台里点「一键升级」才会跑——静默改写用户的真实数据正是本项目一贯避免的；且不开控制台的 V1 用户因此保持 100% 旧行为。

`SCHEMA_VERSION` 在 V3 是 **3**，但升级本身**不改写任何记录**：新字段全可选，旧书打开后的行为与之前完全一致。启动时只做「无数据改写」的版本标记（`meta.migrations` 留报告）；真正会写数据的 V1→V2 迁移仍必须由用户点击。任何写数据的迁移执行前先落 `preMigrationSnapshot`，失败就停下并保留报告，不继续后续迁移。

「故事大纲」**不自动转换**：一整段自由文本映射成卷/篇必然丢信息又猜错结构，由用户在控制台里手建。两道幂等护栏：源行上的 `migratedTo`，以及规范化标题比对（防「实体建好了但源行没标记」那一半失败）。Context Builder 同时读旧 `outlines` 与新实体，靠同样两道去重（`contextNoDupOk`）。

### 10. 调试入口

- 控制台「上下文与迁移」标签 = Context Preview：每层 token / 截断 / 丢弃 + 最终提示词全文。
- `window.__ns` 已挂上全部 V2/V3 纯函数（`buildContext` / `allocate` / `extractJson` / `classifyRisk` / `mergeSnapshot` / `planMigration` / `parseSseUsage` / `captureVersion` / `pruneVersions` / `buildTimeline` / `runRuleChecks` / `CONSISTENCY_RULES` / `normalizeSyncUrl` / `handleIncomingSnapshot` / `reloadAfterSync` / `pushSnapshot` / `syncStatus` / `TASK_MODEL_KEYS` / `modelForStage` / `settingsForStage` / `dayStart` / `spentOnDay` / `estimateCall` / `checkBudget` / `activeStyleProfile` / `renderStyleProfile` / `styleProfileText` / `describeStyleProfile` / `buildStats` / `DENSITY_BUCKET` …）。**新增纯函数不加进去等于没被测试。**
- 局域网同步在 DevTools 里调：`await __ns.syncStatus()` 看开着没、`await __ns.testConnection('192.168.1.5:8787')` 打一发 `/hello`、`await __ns.pushSnapshot(url, code)` 走一次真实合并（在电脑上对自己发也能跑，两侧同库时 diff 恒为 0）。
- 手工验收清单见 README「长篇写作怎么用」与「小说控制台」两节。

## V2 第二阶段（版本 / 时间线 / 一致性 / 同步）

四块功能，共同点是**全部建立在第一阶段的数据模型之上，没有一处改既有记录的形状**，所以安装后无需迁移、`SCHEMA_VERSION` 与 `SNAPSHOT_VERSION` 都没动。改这四块之前先读这一节。

### 1. 章节版本（`services/novel/versioning.js`）

```
chapterVersions:{bookId}
{ id, bookId, chapterId, chapterTitle, content, wordCount, source, generationRunId, note, model, createdAt }
// source ∈ 'ai' | 'manual' | 'rollback' | 'delete' | 'review' | 'import'
```

**没有 `updatedAt`，这是刻意的**：版本是不可变的，改一个历史版本没有任何意义。同步靠 `mergeRecords` 的 `tstamp()` 回退到 `createdAt`（`snapshot.js`），所以不可变记录天然能正确合并——**别顺手给它补一个 `updatedAt`**，那会让「同一版在两端各自被刷过时间戳」变成一次无意义的覆盖。

**捕获点只有四个，全是显式调用，绝不在 `persistChapter` 里挂钩子**——那是自动保存的落点，1.5 秒防抖一次，挂在那里等于每写一段存一版：

| 触发点 | `source` | 位置 |
|---|---|---|
| AI 产出要覆盖某章已有的非空正文 | `'ai'` | `AiPanel.vue` 应用正文的动作（与 `applyChapterMeta` 同一处，那里同时拿得到 `chapterId` 与 `generationRunId`） |
| 用户点编辑器工具栏的「存档」 | `'manual'` | `Editor.vue` |
| 恢复某一版之前 | `'rollback'` | 版本面板的 `restore()`——**先存当前再覆盖**，回滚因此可撤销 |
| 删章之前 | `'delete'` | `books.js` 的 `removeChapter`。章节走硬删除，版本留下来，按「已删除章节」分组可恢复成新章——这是误删唯一的救回入口 |
| 接受 AI 定向修复、写回正文之前 | `'review'` | `ConsistencyReport.vue`。**先存后写**，所以修复也能当作一次可回滚的改动 |

**裁剪（`versionKeep`，默认 10）用 `saveAll` 整组回写，刻意不写墓碑**。裁剪是本地整理，不是用户删除：写墓碑会让它传播到另一台设备、把对方**故意**保留的更多版本也删掉，而且墓碑表会无限膨胀。代价是另一台设备下次同步可能把多出来的版本送回来——无害，版本不可变，多留几版不是数据丢失。

### 2. 时间线（`services/novel/timeline.js`）

`buildTimeline({chapters, events, foreshadowing, locations, characters, factions})` → `{ nodes, warnings }`，纯函数无 I/O。排序以 `chapters` 的 `order` 为主键（可切「按故事时间排」）；伏笔也在轴上：`firstChapterId` 是埋点、`expectedRevealChapterId` 是预期回收点，预期回收章已写完而状态仍是 `planted`/`developing` → 标「逾期未回收」（用 `ACTIVE_FORESHADOW_STATUS`，别再写一份状态枚举）。`orphan = true` 表示指向的章节已不存在。

**`warnings` 同时是一致性规则 #1 的实现**，两个功能共用一份——这是本轮最省工作量的设计，别把断链检测再写一遍。

`TimelineView.vue` 只是渲染层：竖轴用 CSS 竖线 + `::before` 圆点（不引入 SVG 依赖），表格视图原样保留供新增与编辑。点节点 → `store.selectChapter()`。

### 3. 一致性（`services/novel/consistency.js`）

`runRuleChecks({chapters, memory, structure, tombstones})` → `{ issues, stats }`，纯函数、**规则常开**（打开控制台即算）、零成本、零误报。十二条：

| # | 规则 | severity |
|---|---|---|
| 1 | 断链引用（复用 `timeline.js` 的 `warnings`） | high |
| 2 | 时间线倒挂（章节 `timelineStart` 与 `order` 不同向） | medium |
| 3 | 伏笔逾期未回收 | medium |
| 4 | 已死角色仍在出场（其后的事件里仍出现在 `characterIds`） | high |
| 5 | 重复事件（同章同标题） | low |
| 6 | 章节缺摘要（正文非空但 `summary` 为空） | low |
| 7 | 记忆陈旧（`characters.lastUpdatedChapterId` 距今超过 30 章） | low |
| 8 | 主线停滞（施工卡标了「主线」之后连续多章未推进） | medium |
| 9 | 关键人物过度密集出场（最近 10 章超过 70%） | low |
| 10 | 支线长期无进展（进行中的篇连续多章无对应章节） | low |
| 11 | 相邻章节目标重复（规范化 `purpose`） | low |
| 12 | 连续章节没有有效变化（已确认施工卡里无事件/伏笔动作/状态变化） | low |

后五条都是**大数字才触发**的兜底规则（阈值见各自实现），干净的小书不会因为它们报一条。新增规则必须同时给 `consistencyCleanOk` 的夹具补数据，保证「干净数据 0 条」仍然成立。

**`consistencyCleanOk` 是这一节最重要的断言**：干净数据必须算出 **0 条**。误报比漏报更能毁掉这个功能——一个总是喊着「这里有问题」的检查，用户第三次就会忽略它。

**AI 深检是编排器的 `review` 阶段**（`STAGE_LABELS.review = '一致性审校'`，runner 注册进 `RUNNERS`），输出契约逐字采用规格书 04 的 `{issues, styleIssues, continuityIssues, severity}`，用现成 `extractJson` 解析。三条不许改回去的设计：

- **不加入 `DEFAULT_STAGES`**：它只在用户点按钮时按需跑，所以「每章写完自动检查」这类隐性花费不会发生。这是「规则常开 + AI 手动」这个组合能成立的前提。
- **必经 Context Builder**，不自己拼 prompt。
- **计费照常**（走 `record(..., 'review')` 写 `generationRuns`）：手动触发也必须是**可见花费**，否则「AI 深检」就成了唯一一处悄悄扣钱的地方。

**完整报告不落库，但问题状态落库——这是 V3 对既有取舍的修订，别当成自相矛盾**：报告是针对**某一版正文**的意见，正文一改就过期，完整存下来只是过期噪音；但「用户接受了哪条、忽略哪条、修复了哪条」是作者的**决定**，换台设备继续处理时需要保留。故 `reviewIssueStates:{bookId}` 只存 `{ id, chapterId, contentHash, status }`，并在每次读取时比对 `contentHash`：不一致就显示「报告已过期」。生成历史里仍能找到那条 review 记录。`consistencyReviewNoPersistOk` 守的是「完整报告不落库」，`reviewIssueStates` 的存在不违反它。

**定向修复（`fix` 阶段）绝不自动覆盖正文**：它返回 `{ revised, explanation }`，界面用 `diff.js` 预览；用户点接受后才 `captureChapterVersion(..., { source: 'review' })` 再写回。修复后可按需复核，但轮数有上限（默认 1，最大 2），不允许无限循环扣钱。

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

**正文冲突：保留副本，绝不静默覆盖（`services/sync/conflicts.js`）**

- 只对 `chapters` 做冲突检测。正文是唯一不可再生的内容；实体仍按 LWW + 墓碑合并。
- 基线：根键 `syncPeers` 记录每个对端上次同步后各章的 `updatedAt`。**首次同步只建基线、不判冲突**，否则第一次握手就会因为两边时间戳不同造出一堆假副本。
- 判定：同一章两端 `content` 不同，且双方 `updatedAt` 都**晚于基线** → 冲突。
- 处理：本地版留在原章；远端版创建**确定性 id** 的副本章
  `conflict_<fnv1a32(chapterId, remoteDeviceId, remoteUpdatedAt)>`，标题加「【冲突副本】」，`order = max+1`；
  同时写 `syncConflicts:{bookId}` 记录，随合并结果传回对端。确定性 id 让重试与重复同步幂等。
- 设置项 `syncConflictCopies` 默认 **true**；关掉后回到 LWW（不推荐，README 里已写明）。
- `SyncPanel` 显示「待处理冲突 N」，可跳到两章对比并标记已解决。

**版本门槛**：`/hello` 与 `normalizeSnapshot` 都校验 `schemaVersion`，不一致直接拒绝并提示两端升级到同一版本。快照头里的 `deviceId` 只用于冲突 id 与基线，不参与合并。

**安全边界（README 与发版说明里写的口径，不要放松）**：

- **快照里没有 `settings`** —— `collectSnapshot` 只读 books / chapters / outlines / 集合 / 墓碑，**API Key 永不出本机**。`snapshotNoApiKeyOk` 断言把它钉死。
- 默认关闭；只在局域网可达（绑定本机网卡地址，不做端口映射）；每次开启换码；主进程不认识文件系统。
- **措辞一律用「局域网同步」，不用「云同步」**：这是两台自己的设备直连，数据不经过任何第三方服务器，与「本地优先、不提供云端存储」一致。用「云同步」会让用户以为有中转服务，那是另一个东西。
- 手机端明文 HTTP 在 **debug 与 release 都生效**：debug 侧靠 `capacitor.config.ts` 的 `cleartext: true` + `allowMixedContent: true`，release 侧靠 `res/xml/network_security_config.xml`（`cleartextTrafficPermitted="true"`）。**代价必须如实写明**：同一网络里的其他人可能看到请求内容（含 API Key），公网服务应一律用 `https://`。

**地址列表刻意列出全部网卡**（`os.networkInterfaces()` 的 IPv4 非 internal，私网段排前面）：Windows 上 VPN / WSL / VirtualBox 的虚拟网卡很常见，**猜错比列出来更糟**——猜错的表现是「电脑上显示了一个手机永远连不上的地址」，而用户没有任何办法知道问题出在哪。同理，端口被占用时向后试 10 个并把**实际端口**回报给界面，比报「端口被占」友好得多。

`normalizeSyncUrl` **先看有没有协议头再补**，两步不能合并成「先补 `http://` 再判协议」：那样 `file:///C:/Windows` 会被解析成主机名 `file`，得到一个语法完全合法、实则毫无意义的 `http://file:8787`，用户只会看到「连不上」，而他填的明明是一个「地址」。

### 5. 设置面板的同步节

`SyncPanel.vue` **一个组件两副面孔**（按 `isDesktop()` 分），放在 `SettingsPanel.vue` 的 `v-if="desktop"` **之外**——同步在电脑与手机两端都要能配：电脑端配的是服务本身，手机端配的是「连哪台电脑」。做成一个组件而不是两个，是因为两副面孔共享同一块设置区与同一个「上次结果」版式，拆开的结果是两边各写一份渲染然后慢慢分叉。

## V3（可靠性 / 规划 / 审校 / 文风 / 统计）

V3 的目标是「先保证不丢稿，再谈写得更好」。这一节只写**改这些功能时会踩的约束**；数据与入口见上面各节。

### 1. 自动保存与草稿恢复

`autosave.js` 的状态是 `idle | dirty | saving | saved | failed`，`onState(state, meta)` 让编辑器如实显示。
**失败必须可见、可重试**：重试只重跑同一个 `persist(id)`，不引入第二个写者；重试仍失败时保留 `failed`，绝不停在「保存中」。
生命周期冲刷挂在 `visibilitychange(hidden)` / `pagehide` / `window.blur` 与 Capacitor `appStateChange(!isActive)`；
Electron 关窗走 `app:before-close` → 渲染层 `flush()` → `app:close-ready`，主进程 2 秒超时兜底。**这条握手不能省**。

`services/ai/taskStore.js` 负责流式草稿：开始写一条 `running`，`onDelta` 节流（1.5 秒或 800 字）落 `outputText`，
结束时写 `done/aborted/error/truncated`。打开书时把本会话没有活跃流的 `running` 标成 `interrupted`，
`AiPanel` 顶部显示恢复条。恢复**只恢复已收到的草稿**，文案必须写明「服务端请求不会恢复」；
「重新生成」是新的调用、会再次计费。`running` 永不裁剪；每书保留最近 20 条已结束任务。

### 2. 接口错误、重试与密钥

错误分类在 `services/ai/errors.js`，重试策略在 `services/ai/request.js`，两者的契约见「LLM 客户端双路径」。
**不要把重试写回 `chatStream`**：`chatStream` 只负责一次流，可靠封装在外层；否则编排器与界面各有一份互相打架的重试。
`redactSecrets` 必须覆盖 `sk-…`、`Bearer …` 与 Authorization 值，主进程日志与渲染层错误都走它。

桌面端 Key 走 `secret:*` + safeStorage；`settings.persist()` 在桌面端**不写 `apiKey`**，
浏览器/Android 维持明文但 `secureKeyAvailable=false` 要如实显示。迁移顺序永远是「先写成功、再清明文」。

### 3. Context Builder 的 V3 层与多模型

层顺序（优先级从高到低）：写作规则 → 全书规划 → 当前卷 → 当前篇 → 章节施工卡 → 本章场景 → 人物状态 →
地点 → 时间线 → 伏笔 → 文风 → 近期摘要 → 最近正文 → 临时要求。施工卡未确认时层文本要**明确写「临时计划（未确认）」**，
确认后写版本号——否则模型会把草案当成硬约束。

`buildContext` 的预算要扣掉输出预留（`outputReserve`，默认 `maxTokens`）与安全余量；
`metadata` 如实标出预留、是否超预算与被丢弃的层。

按任务分模型在 `models.js`：`modelForStage(settings, stage)` 空串回退 `settings.model`；
`settingsForStage` 返回的临时对象**不得改到模块级 settings**（单测钉着）。编排器每阶段记录的模型必须是实际使用的那个。

### 4. 规划与施工卡

全书规划在 `books.plan`；施工卡字段定义在 `ENTITY_SCHEMAS.chapters` / `CHAPTER_PLAN_FIELDS`（只改 schema）。
`planCheck.js` 是确定性检查（目标字数区间、mustEvents、forbidden、acceptance），**不产生费用**；
它是提示而不是拦截——作者有权偏离自己的计划。

锁定节拍在 `lockedBeats`。AI 生成的计划若没有保留全部锁定节点，`planning.js` 只生成 `planProposals` 待确认，
**界面不得直接写进施工卡**。提案 id 由章节 + 草稿内容决定，重复点击不会堆出重复提案。

### 5. 版本差异、检索与统计

`diff.js` 是行/段落级 LCS，纯函数；长行再按句切分。版本面板用「两版对比」，**不要用第三方 diff 库**。
「复制为草稿」创建新章节，**不覆盖当前章**。

`retrieval.js` 的 `searchBook` 返回片段而非 HTML；渲染层用 `v-for + <mark>`，**禁止 `v-html`**。
集合名 → 控制台标签键不是恒等映射（`events`→`timeline`，`scenes/volumes/arcs`→`story`），
`SearchModal` 的 `TAB_FOR_COLLECTION` 必须同步维护——漏了的表现是「控制台打开了，但停在第一页」。

`stats.js` 的每个数字都必须在界面上写清口径（平均只除已写章节、废弃伏笔仍在分母、密度按每 10 章）。
**统计是描述不是评价**，文案里不许出现「写得好坏」的判断。

### 6. 预算

`budget.js` 的 `checkBudget` 只做「事先提示」；金额是估算，必须标「本机估算」。命中的是 `'*'` 兜底时
`cost` 为 `null`、界面写「价格未知」；**绝不能显示 ¥0**。每日合计里若有未定价调用，
`complete=false`——此时不能拿它去断言「还没超预算」。生成记录同时存 `priced/overBudget/budgetLevel`。

## V4（Provider / 指针 / 计划校验 / 队列 / RAG / 关系图 / WebDAV / 插件）

V4 的目标是把「规划—生成—检查—同步」串成可管理的流水线，同时**不新增任何运行时依赖**：
哈希向量不用 embedding 模型，关系图不用图表库，插件不执行代码。完整验收报告在
`docs/08_UPGRADE_AUDIT_V4.md`。

### 0. 数据与版本政策

- `SCHEMA_VERSION` 仍是 **3**、`SNAPSHOT_VERSION` 仍是 **1**，**没有数据迁移**。新增字段全部可选，
  旧客户端按整对象保留未知字段，不会丢。
- `generationQueue` / `ragChunks` 进 `COLLECTIONS`，但进 `LOCAL_ONLY_COLLECTIONS`（`snapshot.js`），
  **不进快照、不进局域网同步、不进 WebDAV**。`generationQueueState` 是根级本地键。
- 设置对象（`planValidation/rag/webdav/plugins`）必须过对应的 normalizer，理由同 `pricing` 的浅合并坑。

### 1. Provider（`services/ai/providers.js`）

- 所有服务商都走 OpenAI 兼容 `/chat/completions`，差别只在地址、模型与是否必须给 Key。
- `providerId` **只用于预设填充与展示**；请求永远以 `settings.baseUrl/model` 为准。
- **只有一份 active 凭据**：切换预设不清空、不覆盖用户的 API Key；Ollama 允许空 Key。
- `createProvider({settings, stage, chat, estimator})` 统一 `chatStream` / `chat` / `countTokens`；
  `chatStream` 委托 `chatStreamReliable`，重试/超时/截断契约不变。编排器的 `streamOnce` 走它，
  记录里的 model 必须是实际使用的那个。
- **不要引入 SDK / tokenizer**：`countTokens` 用既有字符估算。

### 2. 书籍指针（`services/novel/pointers.js` + `store/books.js`）

- `derivePointers(chapter, {arcs, volumes})`、`resolvePointerChapter`、删章回退（原位 → 前 → 后 → null）。
- `openBook` 优先恢复 `currentChapterId`，缺失/已删回退第一章；`selectChapter` 立即更新内存、
  600ms 防抖写回；`closeBook` / 返回书库 / 同步重载前 `flushCurrentPointers()`。
- 写指针走 `patchBook`（`serialize('books')` 内读-改-写），**不 bump `book.updatedAt`**；
  合并按 `currentPointerUpdatedAt` 独立比较（见「重要约定与坑」#20）。

### 3. 生成前计划校验（`services/novel/planValidate.js`）

- 七类确定性检查（死亡角色/覆灭势力/时间线倒挂/核心规则被改写/伏笔提前揭示/偏离必发节拍/与近章重复），
  只做字面匹配，**不调用模型、不产生费用**。
- 编排器在 `stagePlan` 解析出草案后跑校验，写 `st.validation / st.blocked`；**校验失败不让阶段失败**。
- `blockHigh` 只拦「AI 草案自动采用 / 队列自动继续」；用户手工编辑永远不受阻，高风险项可显式覆盖。
- 空草稿、空数据必须 0 条；每条 issue 的 `evidence` 要能指回原文。

### 4. 写作队列（`services/ai/queue.js` + `queueRunner.js` + `store/writingQueue.js`）

- 状态 `queued | running | interrupted | blocked | done | failed | canceled`；迁移必须显式。
- **全局串行**、一次只跑一项；`generationStore.running` 在运行期间为真（局域网同步据此回 busy）。
- 只跑 `['write']`；结果落 `result`（文本上限 200k），**绝不自动写章节**；用户点「插入」才写正文，
  需要时再单独跑一次 `['extract']`。
- 重启时 `running → interrupted` 并暂停；**任何失败都不能自动重试**（每次重试都是真实计费）。
- 每项开始前 `ui.flush()`；执行前校验章节仍存在；切书后不再启动旧书下一项；预算超限暂停队列。

### 5. 本地检索（`services/rag/`）

- `EMBEDDING_DIM=256`，FNV-1a 哈希 + 计数稀疏向量；CJK 字 + 双字 n-gram、拉丁词；**确定性、无随机数**。
- 分块 500 字 / 80 重叠（段落优先，长段按句切）；`topK 6`、`minScore 0.18`、每章最多 2 条。
- **IDF 在查询时按当前书全部 chunk 现算**——不要存进向量。
- 索引懒构建（生成前 + 打开检索页），按 `contentHash` 比对；**不要在 `persistChapter` 挂钩子**。
- `ragPassages` 层 `priority 11`、非必带、预算取 `settings.rag.budget`；无内容时不产生层；
  关闭时输出与旧版一致。检索异常一律返回空数组。
- 文案必须写清「字面相似检索，不是语义模型」。

### 6. 人物关系图（`services/novel/graph.js`）

- 完全派生，**不新增集合、不写库**；节点 = 人物 + 势力（地点可切换），边 = 首领/所属/事件共现/
  盟友敌对/伏笔相关/自由文本关系。
- 自由文本关系**只解析「恰好两个已知人物名 + 明确分隔符」的行**，低置信虚线；宁缺毋滥。
- 上限 80 节点 / 400 边，超出截断并提示；布局按势力分组、稳定排序、**无随机数**（同输入同输出）。
- 渲染用手写 SVG + CSS，**不引入图表库**。

### 7. WebDAV 同步（`electron/webdav.js` + `services/sync/webdav*.js`）

- 文件布局 `${remoteDir}/${deviceId}.json`；每次只合并、不做 CRDT / 实时共编 / LOCK。
- 主进程是信任边界：仅 `http/https`、同源、路径拒绝 `..`、方法白名单 `PROPFIND/MKCOL/GET/HEAD/PUT`、
  64MB 上限、`redirect:'manual'`。**密码只从 safeStorage 的 `webdavPassword` 槽取**。
- 合并复用 `handleIncomingSnapshot(remote, {reload:false})`（冲突副本、基线、墓碑全都不重写），
  最后统一 `reloadAfterSync()` + `ui.reloadEditor()`。
- 上传带 `If-Match`；412 时重新拉取合并、最多重试 2 次；服务器无 `ETag` 时明示并发风险。
- 生成中返回 `{ok:true, skipped:'busy'}`，不报错也不阻塞写作。设置项 `webdav.lastStatus/lastError`
  只用于展示，不参与合并。
- **措辞区分**：「局域网同步」是两台设备直连；「WebDAV 同步」是用户自建服务器。两者都不经过本项目的云。

### 8. 声明式插件（`electron/main.js` + `services/plugins/` + `store/plugins.js`）

- 插件是 `userData/plugins/*.json`，单文件 ≤256KB、最多 100 个；坏文件只标记，不影响其他插件。
- **绝不执行用户代码**；四个 hook：`contextFragments`、`rules`、`exportTemplates`、`keywordHints`。
- 清单校验（`manifest.js`）：id 正则 `^[a-z0-9][a-z0-9-_]{0,63}$`、flags 仅 `gimsuy`、拒绝空匹配；
  pattern ≤500、fragment ≤4000、template ≤100000；fragments ≤50、rules ≤100、templates ≤20、hints ≤100。
- 规则输入截断 200k、每章最多 20 条；模板占位符 `{{bookTitle}} {{intro}} {{chapters}} {{chapterCount}} {{date}}`，
  未知占位符原样保留。
- 接入点：Context Builder 的 `pluginContext` 层（priority 5、预算 `plugins.contextBudget`）、
  `runRuleChecks({pluginRules})`（`source:'plugin'`）、`ExportModal` 模板、`AiPanel` 关键词提示。
- 仅桌面端；UI 必须保留「复杂正则会拖慢应用、本软件不执行插件代码」的提示。

### 9. 调试入口

`window.__ns` 已挂上全部 V4 纯函数（`PROVIDER_PRESETS` / `inferProviderId` / `createProvider` /
`derivePointers` / `resolvePointerChapter` / `pickChapterAfterDelete` / `validatePlan` / `shouldBlockPlan` /
`QUEUE_STATUSES` / `nextRunnable` / `recoverQueueItems` / `capResultText` / `createQueueRunner` /
`embedText` / `chunkChapter` / `searchRag` / `retrieveRagContext` / `ensureBookIndex` /
`buildRelationshipGraph` / `parseRelationshipText` / `layoutRelationshipGraph` /
`parseDavBase` / `normalizeDavRemoteDir` / `davSnapshotPath` / `parseDavHrefs` / `describeDavStatus` /
`shouldRetryDavStatus` / `syncWithWebdav` / `testWebdav` /
`PLUGIN_LIMITS` / `validatePluginManifest` / `runPluginRules` / `renderExportTemplate` …）。
**新增纯函数不加进去等于没被测试。**

## Android

`android/` 是 `npx cap add android` 生成的原生工程，已配置完成并验证可产出 debug 与签名 release APK。

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

# 签名 release（本机需先有 android/keystore.properties 与 keystore 文件）
cd android && JAVA_HOME="C:/Android/jdk21" ./gradlew assembleRelease --no-daemon
# 产物：android/app/build/outputs/apk/release/app-release.apk

# 校验产物元信息与签名（不装模拟器也能验）
"C:/Android/Sdk/build-tools/36.0.0/aapt" dump badging <apk路径>
"C:/Android/Sdk/build-tools/36.0.0/apksigner.bat" verify --print-certs <apk路径>
# Windows 上 apksigner 的实际文件是 apksigner.bat；不带 .bat 会报 No such file or directory
```

期望看到：`package: name='com.novelstudio.app'`、`sdkVersion:'24'`、`targetSdkVersion:'36'`、`compileSdkVersion='36'`、`application-label:'Novel Studio'`；release 包还要看到 `Verifies` 与 `Signer #1 certificate DN: CN=Novel Studio...`。

### Release 签名（V4）

`android/app/build.gradle` 从 `android/keystore.properties` 读取签名材料，**两个文件都不入库**（`android/.gitignore` 已忽略 `*.jks` / `*.keystore` / `keystore/` / `keystore.properties`）：

```properties
storeFile=keystore/release.jks     # 相对 android/ 目录
storePassword=...
keyAlias=novelstudio
keyPassword=...
```

- 四个键**缺任何一个**时 `hasReleaseSigning=false`：`assembleRelease` 会通过 `gradle.taskGraph.whenReady` **明确抛错**，绝不静默产出 unsigned 包；`assembleDebug` 不受影响。
- 当前 `versionCode 5` / `versionName "4.0.0"`。**Capacitor 不会自动同步版本号**，发版时必须同时改 `package.json` 与这里。
- `minifyEnabled false` 是刻意的：Capacitor 插件依赖反射，本轮不引入混淆风险。
- **keystore 丢失 = 无法用同一包名覆盖升级**，只能卸载重装（本地数据会丢，除非先做全量备份）。密码与 keystore 不进仓库、不进日志、不进截图。
- CI 侧由四个 Secrets 还原（`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`）：workflow 用 `base64 -d` 写出 jks、`umask 077` 写 `keystore.properties`，**任何一步都不打印内容**；未配置时退回 debug APK 并在日志与产物名里标注。

### 明文 HTTP（release 同样允许）

`android/app/src/main/res/xml/network_security_config.xml` 的 `base-config cleartextTrafficPermitted="true"` + `AndroidManifest.xml` 的 `android:networkSecurityConfig` 让 **release 包也允许 `http://`**（Android 9+ 默认禁止）。这是为了局域网同步、本机 Ollama 与内网 LLM 端点；代价是同一网络里的其他人可能看到请求内容（含 API Key）。`capacitor.config.ts` 的 `server.cleartext` / `allowMixedContent` 仍服务于 WebView 侧。**这条放宽是有意的，改动前先看 README/RELEASE_NOTES 的风险说明。**

### 双端兼容约定

- **平台判定一律走 `src/services/platform.js`** 的 `isDesktop()` / `isNative()` / `isWeb()` / `isNarrowLayout()`，不要在组件里散写 `window.electronAPI?.isDesktop`。
- **Capacitor 插件全部动态 import**，见「重要约定与坑」#13。
- **Android 导出走系统分享面板**（`native.js` 的 `shareTextFile`）：写 `Directory.Cache` → `Share.share({url})`。选 Cache 而非 Documents 是刻意的——Documents 在 minSdk 24–28 上需要 `WRITE_EXTERNAL_STORAGE` 运行时权限，而 Cache + 分享**零权限**即可让用户把 TXT 存到任意位置。已从 Capacitor 源码确认 `SharePlugin` 接受 `file://` url 并经 `FileProvider`（`AndroidManifest.xml` 中 authority 为 `${applicationId}.fileprovider`）授权。
- **`window.prompt` 在 WebView 里不存在**，见「重要约定与坑」#12。
- **窄屏（≤860px）是三栏切换而非三栏堆叠**：`WritingView.vue` 的 `mobilePane` 只渲染一栏并配底部标签栏，`App.vue` 的 `handleBack()` 与 Android 返回键联动（AI → 正文 → 章节 → 书库 → 退出）。Android 返回键经 `native.js` 的 `registerBackButton` 注册，handler 返回 `true` 表示已消化该次返回。

### 已知限制（长期约束，不是待办）

这三条是环境与范围上的既定边界，**不要当成「还没做的 TODO」去顺手补上**：

- **Android 运行时行为在本机无法验证**：未装模拟器，且冒烟测试是 Electron 专属机制。窄屏布局、软键盘、返回键、分享导出、安全区、明文 HTTP、多网卡地址选择**只能装到真机上验**。
  **构建成功 ≠ 运行正常**——`gradlew assembleRelease` 通过、`apksigner verify` 通过，只说明能编出并签好包，不说明能跑起来。
- **可以出签名 release APK，但签名材料要自己保管**：本机按上面的方式生成 keystore 与 `keystore.properties`（不入库）；丢失后无法覆盖升级。release 已为明文 HTTP 配置 `networkSecurityConfig`，代价见 README/RELEASE_NOTES；**不要把这条放宽当成「安全上没问题」**。
- **不做 iOS**：无 macOS 环境。
