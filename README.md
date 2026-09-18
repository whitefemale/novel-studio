# Novel Studio · 自动写小说

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B%20%7C%20Android%2022%2B-brightgreen.svg)](https://nodejs.org)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org)
[![Electron](https://img.shields.io/badge/Electron-31-47848f.svg)](https://www.electronjs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Browser%20%7C%20Android-lightgrey.svg)](#)

一款连接大模型 API（OpenAI 兼容接口）自动写小说的软件。白色简洁界面，支持书库管理、章节管理、AI 续写/扩写/改写、生成大纲与章节、设定管理、自动保存、查找替换与导出。

- **Windows**：双击即可运行的独立 exe（安装版 / 便携版）
- **浏览器**：`npm run dev` 打开 localhost 即可使用
- **Android**：同一套代码，已配好工具链，可直接产出 APK

所有数据存在本机 IndexedDB，**不上传任何服务器**；除了调用你自己配置的 LLM 接口，软件不会向外发送任何数据。

## 下载

到 [**Releases**](https://github.com/whitefemale/novel-studio/releases/latest) 页面下载：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `Novel-Studio-Setup-*.exe` | 安装版，可选安装目录、建桌面与开始菜单快捷方式 |
| Windows | `Novel-Studio-Portable-*.exe` | 便携版，单文件双击即用、不写注册表，适合放 U 盘 |
| Android | `Novel-Studio-Android-*.apk` | 手机安装包（debug 签名） |

> ⚠️ 安装包**没有做代码签名**，Windows 首次运行会弹「Windows 已保护你的电脑」。
> 这是 SmartScreen 对未知发布者的默认拦截，不是杀毒软件报毒——点「更多信息」→「仍要运行」即可。

> 软件本身不带 API Key，第一次打开要先在「设置」里填 Base URL / API Key / 模型名。
> 默认 `https://api.deepseek.com`，任何 OpenAI 兼容接口都能用。

<!-- 截图（强烈建议补上，对 star 数影响很大）：把图片放进 docs/ 目录后取消下面的注释
<p align="center">
  <img src="docs/shelf.png" width="32%" alt="书库">
  <img src="docs/editor.png" width="32%" alt="编辑器">
  <img src="docs/ai.png" width="32%" alt="AI 写作">
</p>
-->

## 功能

| 功能 | 说明 |
|---|---|
| 书库管理 | 多部小说卡片、新建/删除/编辑（书名 / 简介 / 封面配色）、关键词搜索与排序 |
| 章节管理 | 侧边栏目录、增删改、上下排序 |
| 编辑器 | 纯文本编辑 + Markdown 预览、实时字数统计、1.5 秒防抖自动保存（Ctrl/Cmd+S 立即保存） |
| 查找替换 | Ctrl/Cmd+F 打开查找栏，支持上一个/下一个/替换/全部替换（纯字面量匹配） |
| AI 续写 | 从当前章节末尾自然衔接，携带大纲/人物/世界观与最近章节上下文 |
| AI 扩写 / 改写 | 选中正文中的文字，AI 扩写或润色，一键替换/插入；触屏设备上可直接粘贴或编辑待处理文字 |
| 生成大纲 | 根据书名与创意点生成完整分章大纲，存入设定 |
| 生成章节 | 依据故事大纲生成一章正文，可直接存为新章节 |
| 设定管理 | 故事大纲 / 人物设定 / 世界观，自动注入 AI 提示词（**多条大纲会全部注入**） |
| 导出 | 整本或单章导出 TXT / Markdown；可设置保存地址直写，也可每次弹保存框 |
| 自动备份 | 按设定间隔把整本小说备份到 `保存地址/书名/备份/`，自动淘汰超出保留份数的旧备份 |
| API 设置 | Base URL、API Key、模型名、温度、最大 Token、上下文策略 |

## 快速开始

需要 **Node.js 18 或更高版本**。浏览器模式与 Electron 打包在 18 上即可；
**Android 构建需要 22 或更高**（见下方 Android 章节）。

```bash
git clone <你的仓库地址>
cd novel-studio
npm install
```

```bash
npm run dev          # 浏览器开发模式 → http://localhost:5173
npm run electron     # 桌面版运行（先 build 再用 Electron 加载产物）
npm run dist:win     # 打包 Windows 安装版 + 便携版 → release/
```

> 仓库自带的 `.npmrc` 已把 registry 与 Electron 二进制指向 npmmirror 国内镜像，
> 国内网络下 `npm install` 可以直接装上 Electron（约 100MB）。若你不在国内，
> 删掉 `.npmrc` 即可走官方源。

首次使用请点击右上角「设置」填写：
- **接口地址**：如 `https://api.deepseek.com`（DeepSeek / Kimi / 通义 / GLM / OpenAI 等任何 OpenAI 兼容接口均可）
- **API Key**：你的密钥
- **模型名**：如 `deepseek-chat`

然后「测试连接」验证，即可开始写作。

## 使用流程

1. 「新建小说」填写书名与一句话简介
2. 左侧「章节」新建章节，或直接点「生成大纲」
3. 右侧「AI 写作」选择续写/扩写/改写等，可选填写创作要求，点「开始写作」
4. 生成结果流式显示，点「插入正文」「替换选中」或「存为新章节」
5. 「设定」页维护大纲、人物、世界观，AI 会参考这些设定写作
6. 随时「导出」为 TXT / Markdown

> **书库默认按「最近更新」排序**（此前是按新建顺序倒排）。可在书库顶部切换到「创建时间」或「书名」。

## 保存地址与自动备份（桌面端）

在「设置 → 保存与导出」中选定一个文件夹后，「导出」会**直接写入** `保存地址/<书名>/`，不再弹保存对话框：

- **同名文件不覆盖**：自动加序号（`剑与星辰 (1).txt`），原文件始终保留。
- **另存为…**：导出弹窗里始终保留这个按钮，可临时改存到别处。
- **保存地址不可用**（被删除、拔了盘、没权限）时会提示一次并自动降级为另存为对话框。
- **自动备份**：开启后按设定间隔把整本小说写到 `保存地址/<书名>/备份/书名-YYYYMMDD-HHmm.txt`；每本书最多保留 N 份，超出的旧备份自动删除，不会堆满硬盘。

Android 与浏览器端没有「保存与导出」这一节：浏览器直接下载文件；Android 写入应用缓存后拉起系统分享面板，由你决定存到哪或直接分享，**不需要任何存储权限**。

## 目录结构

```
novel-studio/
├── electron/            # Electron 主进程（窗口、LLM IPC 代理、文件写入与安全边界）
├── src/
│   ├── components/      # 书库/编辑器/AI 面板/设置/导出等组件
│   ├── services/        # 存储(IndexedDB)、LLM 客户端(SSE)、提示词、导出、自动保存、平台判定
│   ├── store/           # Vue 状态（书籍/章节/设定/设置/提示）
│   ├── App.vue
│   └── styles.css       # 白色简洁主题
├── tests/               # Electron 冒烟测试（SMOKE_TEST=1 npx electron .）
├── android/             # Capacitor 生成的 Android 原生工程
├── scripts/gen-icon.mjs # 图标生成脚本（纯 Node 手写 PNG+ICO，无第三方依赖）
├── build/icon.ico       # 应用图标，由上面的脚本生成
├── capacitor.config.ts  # Android 打包配置
├── electron-builder.yml # Windows 打包配置
└── CLAUDE.md            # 面向 AI 助手的开发约定与踩坑记录
```

`dist/`、`release/`、`node_modules/` 与 Android 的构建中间产物都在 `.gitignore` 里，
克隆后跑一次 `npm run build` 即可重新生成。

## Android 打包

工具链版本已锁定并验证通过（详见 CLAUDE.md 的 Android 章节）：

| 项 | 版本 |
|---|---|
| Node.js | **22+**（**必须**，见下方说明） |
| JDK | 21（**必须**，见下方说明） |
| Gradle | 8.14.3（发行包走腾讯镜像，无需手动下载） |
| Android Gradle Plugin | 8.13.0 |
| Android SDK | platform-tools + platforms;android-36 + build-tools;36.0.0 |
| compileSdk / targetSdk | 36 |
| minSdk | 24（Android 7.0） |

**Node.js 必须是 22 或更高**：`@capacitor/cli` 的 `engines` 声明是 `>=22.0.0`，
版本不够时它在启动时直接 `[fatal]` 退出，报错是：

```
[fatal] The Capacitor CLI requires NodeJS >=22.0.0
Please install the latest LTS version.
```

注意这条**只影响 Android**：`npx cap sync android` 才会调 Capacitor CLI，
`npm run dev` / `npm run electron` / `npm run dist:win` 在 Node 18 上都能正常跑。
所以低版本 Node 下容易表现为「前端一切正常，只有 Android 构建突然失败」。

**JDK 必须是 21~24**：Capacitor 8 硬编码 `sourceCompatibility = JavaVersion.VERSION_21`，
而 Gradle 8.14.3 最高只支持到 Java 24。如果你机器上的默认 JDK 是 25 或更新，
构建会被直接拒绝。此时用内联 `JAVA_HOME` 指定 JDK 21，**不用改系统默认 JDK**：

```bash
npm run build
npx cap sync android          # 改了渲染层代码必须重跑，它负责把 dist/ 同步进原生工程

# 构建（按需在命令前内联 JAVA_HOME）
cd android && JAVA_HOME="C:/Android/jdk21" ./gradlew assembleDebug
# Windows PowerShell:  $env:JAVA_HOME="C:/Android/jdk21"; ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

Android SDK 路径写在 `android/local.properties`（`sdk.dir=...`）。该文件**不入库**，
换机后按自己机器上的实际路径新建即可。建议把 SDK 装在纯 ASCII、无空格的路径下
（如 `C:/Android/Sdk`）——Android 构建对含空格或非 ASCII 的 SDK 路径有历史性故障。

安装到手机：`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`

发布用的签名版 APK 未包含在本次范围内：需要自备 keystore，且若要让 LLM 端点走明文 `http://`，还需额外配置 Android 的 `networkSecurityConfig`。

## 数据存储

所有数据保存在本机 IndexedDB（`novel-studio-db`），离线可用，AI 生成需联网。导出与备份是这套数据之外的另一份副本，两者互不影响。

## 测试

```bash
npm run build && SMOKE_TEST=1 npx electron .
```

成功时输出 `SMOKE_DETAIL {... "pass": true}`（共 48 项断言），覆盖：设置默认值与旧记录回填、文件名净化、自动保存调度器的防抖/冲刷/不串目标、提示词多条大纲注入、目录直写的字节数与同名冲突、越界路径拒绝（含删除诱饵验证）、改名、关书守卫、真实点击路径的组件挂载（并断言没有报错被静默吞掉），以及三条流式管线。

> 注意：冒烟测试跑在**真实的** `novel-studio-db` 上，会复位「保存与导出」相关的设置键。它只清理标题为「测试小说」的书，**不会碰你自己的作品**。

## 常见问题

**接口报 CORS 错误？**
浏览器里直接调 LLM 接口受服务端 CORS 限制。**桌面版没有这个问题**——请求走 Electron 主进程代理，
不经过渲染进程的网络栈。浏览器模式建议换用放行 CORS 的接口地址。

**首次 `npm run dist:win` 打包失败，报符号链接错误？**
electron-builder 首次打包会下载 winCodeSign 并解压，其 `darwin` 目录含符号链接；
Windows 在没有管理员权限或开发者模式时会解压失败。解决办法二选一：以管理员身份跑一次，
或在「设置 → 隐私和安全性 → 开发者选项」里打开开发者模式。缓存目录为
`%LOCALAPPDATA%\electron-builder\Cache\`，该目录完整存在后后续打包就会跳过下载。

**打包出来的 exe 比预期大？**
`electron-builder.yml` 里有 `'!node_modules/**'`，不要删。渲染层已由 Vite 全量打包进 `dist/`，
主进程只用 Electron 与 Node 内置模块，运行时不需要任何 `node_modules`。
验证方法：`npx asar list release/win-unpacked/resources/app.asar`，
条目数应在 20 上下；到几百上千就是漏了。

**改了 `src/` 里的代码，Electron 里没变化？**
`npm run electron` 会先 `vite build`。但如果你是自己手动跑 `electron .`，
必须先 `npm run build`，因为 Electron 加载的是 `dist/index.html` 构建产物。

**Android 上导出文件存到哪了？**
走系统分享面板，由你决定存到哪或直接分享。文件先写到应用缓存目录再经 FileProvider 授权分享，
**不需要任何存储权限**。

## 许可证

[MIT](LICENSE)
