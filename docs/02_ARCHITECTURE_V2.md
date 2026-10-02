# Novel Studio V2.0 架构设计

## 1. 总体结构

```text
UI / Vue
   ↓
Domain Store
   ↓
Novel Services
   ├── Story Planner
   ├── Context Builder
   ├── Memory Extractor
   ├── Consistency Checker
   ├── Version Manager
   └── AI Orchestrator
          ↓
       LLM Adapter
          ↓
 DeepSeek / OpenAI-compatible / 其他 Provider
```

现有 `llm.js` 不应直接承担小说业务逻辑。

## 2. 新增 services

建议新增：

```text
src/services/
├── novel/
│   ├── contextBuilder.js
│   ├── storyPlanner.js
│   ├── memoryExtractor.js
│   ├── consistency.js
│   ├── timeline.js
│   ├── foreshadowing.js
│   └── versioning.js
├── ai/
│   ├── orchestrator.js
│   ├── providers.js
│   └── tokenUsage.js
```

## 3. 新增 store

```text
src/store/
├── novelMemory.js
├── storyStructure.js
├── timeline.js
├── characters.js
├── foreshadowing.js
└── generation.js
```

不要把所有领域状态继续塞进 `books.js`。

## 4. Context Builder

不要继续固定“最近 N 章”。

输入：

```text
bookId
chapterId
action
userInstruction
```

输出：

```text
{
  system,
  context,
  task,
  metadata
}
```

Context 按相关性分层：

1. 写作硬规则
2. 当前卷目标
3. 当前篇目标
4. 当前章目标
5. 当前人物状态
6. 当前地点
7. 当前时间线
8. 相关伏笔
9. 相关历史事件
10. 最近章节摘要
11. 最近正文片段
12. 用户临时要求

## 5. AI Orchestrator

正文生成不直接调用 `chatStream()`。

推荐：

```text
plan
 ↓
validatePlan
 ↓
write
 ↓
review
 ↓
extractMemory
 ↓
commitMemory
```

每一步都可以单独失败和重试。

## 6. 数据安全原则

AI 自动更新记忆不能直接覆盖原数据。

必须：

```text
AI 提取
 ↓
候选变更
 ↓
差异预览
 ↓
用户确认 / 自动策略
 ↓
写入数据库
```

高风险变更，例如“人物死亡”“境界下降”“势力覆灭”，默认需要确认。

## 7. RAG

V2.0 第一阶段不必马上引入向量数据库。

先做结构化检索：

```text
人物 ID
地点 ID
势力 ID
伏笔 ID
事件 ID
时间范围
章节范围
标签
```

只有结构化检索无法满足后，再加入 embedding / vector search。
