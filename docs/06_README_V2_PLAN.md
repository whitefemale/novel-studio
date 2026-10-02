# README V2.0 更新方案

README 当前对产品的描述仍以“AI 续写、扩写、改写、设定管理”为主。V2 应突出长篇小说控制能力。

## 产品定位

建议改成：

> Novel Studio 是一款面向长篇小说创作的本地优先 AI 写作工作台。它通过结构化人物、世界观、剧情、时间线和伏笔记忆，将大模型用于剧情规划、正文生成和一致性审校。

## 功能栏目新增

### 长篇剧情

- 卷 / 篇 / 章 / 场景
- 当前剧情目标
- 主线与支线

### 小说记忆

- 人物状态
- 人物关系
- 世界规则
- 地点
- 势力
- 时间线
- 事件
- 伏笔

### AI 工作流

```text
剧情规划
→ 计划审校
→ 正文生成
→ 正文审校
→ 记忆提取
→ 状态更新
```

### AI 可解释性

- Context Preview
- Token 统计
- 生成历史
- 章节版本
- 一致性报告

## 环境说明

README 不要把：

```text
Node 18+
Android 22+
```

写成容易误解的 badge。

建议明确：

```text
浏览器 / Electron：Node.js 18+（项目当前实际兼容范围）
Android 构建：Node.js 22+
Android JDK：21
```

如果后续统一升级最低 Node 版本，再同步修改 CLAUDE.md、README、CI。

## 安全说明

明确：

- API Key 只保存在本机设置
- 小说正文默认保存在本机 IndexedDB
- 调用 AI Provider 时，相关上下文会发送给用户配置的 API 服务
- 软件本身不提供云端小说存储

这一点比“不会向外发送任何数据”更严谨，因为 AI 请求本身当然会发送小说上下文。

## 截图

建议补：

```text
docs/
├── shelf.png
├── editor.png
├── story-console.png
├── memory.png
├── timeline.png
├── foreshadowing.png
└── ai-workflow.png
```

README 用截图展示 V2 的核心价值。
