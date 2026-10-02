# CLAUDE.md V2.0 增量开发规则

本文件用于补充现有 CLAUDE.md，不替换已经验证过的工程安全规则。

## 一、最高优先级

修改小说领域功能前，先阅读：

- `docs/01_PROJECT_ROADMAP_V2.md`
- `docs/02_ARCHITECTURE_V2.md`
- `docs/03_DATA_MODEL_V2.md`
- `docs/04_AI_ORCHESTRATION_V2.md`

## 二、禁止事项

不要：

1. 重写现有 Electron IPC 安全架构
2. 删除 `toPlain()`
3. 删除 storage 的 `serialize()`
4. 把 IPC 监听重新放进 `chatStream()`
5. 取消 `contextIsolation`
6. 打开 `nodeIntegration`
7. 把 API Key 写入源码
8. 让 AI 响应直接覆盖人物/世界观数据库
9. 用“最近 3 章”作为唯一长期记忆方案
10. 在没有迁移方案的情况下修改 IndexedDB 数据结构

## 三、开发规则

### 数据层

新增实体必须：

- 有明确 schema
- 有 bookId
- 有 createdAt / updatedAt
- 有迁移策略
- 有删除/级联策略
- 有导入导出策略

### AI 层

所有小说 AI 调用必须经过：

```text
Context Builder
→ AI Orchestrator
→ llm.js
```

组件不得自己拼接完整 prompt 并直接访问 LLM。

### 状态更新

AI 只能产生：

```text
Generated Output
Candidate Memory Changes
```

由业务层决定是否提交数据库。

## 四、测试要求

新增领域功能至少覆盖：

- 新建
- 修改
- 删除
- 重新加载
- 数据迁移
- 生成失败
- 生成中止
- 并发保存
- 旧书兼容

新增 AI 工作流必须测试：

```text
plan
validate
write
review
extract
commit
```

## 五、性能

不要把整本小说拼成一个 prompt。

优先：

```text
结构化检索
+
章节摘要
+
相关实体
+
局部正文
```

只有必要时才增加全文。

## 六、UI

新增功能优先进入：

```text
小说控制台
剧情
设定
记忆
时间线
伏笔
AI 工作流
```

不要继续把所有功能塞进右侧“AI 写作”面板。
