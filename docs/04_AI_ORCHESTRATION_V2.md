# Novel Studio V2.0 AI 写作编排规范

## 核心原则

DeepSeek 负责生成语言，不负责决定整个小说数据库的真实状态。

Novel Studio 才是小说状态的控制器。

## 工作流 A：生成下一章

### Step 1：收集上下文

```text
Master Rules
+ Volume
+ Arc
+ Chapter Plan
+ Character State
+ Timeline
+ Foreshadowing
+ Relevant Events
+ Recent Summaries
+ Recent Text
```

### Step 2：生成剧情计划

输出结构：

```json
{
  "chapterGoal": "",
  "conflict": "",
  "scenes": [],
  "characterChanges": [],
  "events": [],
  "foreshadowing": [],
  "endingHook": ""
}
```

这一步不生成正文。

### Step 3：计划检查

检查：

- 人物状态冲突
- 时间线冲突
- 世界规则冲突
- 伏笔提前揭示
- 已死亡人物重新出现
- 当前卷目标偏离
- 与最近章节重复

### Step 4：正文生成

正文模型只接收已经批准的章节计划和 Context。

要求：

- 直接输出正文
- 不输出分析
- 不输出章节标题，除非用户明确要求
- 不自行改变人物状态
- 不自行改变世界规则

### Step 5：正文审校

返回：

```json
{
  "issues": [],
  "styleIssues": [],
  "continuityIssues": [],
  "severity": "low|medium|high"
}
```

### Step 6：记忆提取

AI 从最终正文提取：

```text
newCharacters
characterChanges
newLocations
newFactions
events
timelineChanges
foreshadowingPlanted
foreshadowingResolved
worldRuleChanges
```

### Step 7：提交

候选变更进入：

```text
Memory Review
```

高风险变更默认需要用户确认。

## 续写

“续写”不应等于“读取最近三章”。

应该：

```text
当前章末尾
+
当前章摘要
+
当前篇目标
+
当前人物状态
+
相关事件
+
相关伏笔
+
必要的最近正文
```

## 扩写 / 改写

扩写与改写默认只改变选区，不改变：

- 人物设定
- 世界规则
- 时间线
- 伏笔状态

除非用户明确要求。

## Context Preview

每次 AI 调用前允许用户查看：

```text
模型
任务
system prompt
小说规则
剧情上下文
人物
时间线
伏笔
最近正文
用户要求
预计 token
```

这是调试长篇小说一致性的核心功能。

## Provider 抽象

统一：

```js
provider.chatStream(...)
provider.chat(...)
provider.countTokens(...)
```

DeepSeek 只是默认 Provider。

## 成本记录

每次请求保存：

```text
provider
model
inputTokens
outputTokens
duration
estimatedCost
```
