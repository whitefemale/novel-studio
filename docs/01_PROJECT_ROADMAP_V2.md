# Novel Studio V2.0 项目改造路线图

## 目标

Novel Studio V1 已经具备稳定的跨平台编辑器基础：
- Vue 3 + Electron + Capacitor
- IndexedDB 本地存储
- OpenAI 兼容 API / DeepSeek
- SSE 流式生成
- 自动保存、自动备份、导出
- Electron 冒烟测试与 CI

V2 不重写底层，而是在现有工程上增加“长篇小说智能控制层”。

最终目标：

> 从“AI 续写编辑器”升级为“500～600章长篇小说生产与一致性管理系统”。

## 优先级

### P0：必须做

1. 小说知识库 / 长期记忆
2. 卷 → 篇 → 章 → 场景的剧情层级
3. 人物状态与关系
4. 时间线 / 事件
5. 伏笔数据库
6. AI Context Builder
7. AI 多阶段写作工作流
8. 章节生成后的自动记忆更新
9. Context Preview
10. 一致性检查

### P1：强烈建议

1. 章节版本历史与回滚
2. AI 生成历史
3. Token / 成本统计
4. 多模型 / 多 Provider
5. 章节摘要
6. 自动提取人物、事件、伏笔
7. 写作任务队列

### P2：后续

1. RAG / 向量检索
2. 本地 embedding
3. 更复杂的关系图
4. 协作与云同步
5. 插件系统

## 不应重做

- Electron contextIsolation
- nodeIntegration=false
- webSecurity
- IPC LLM 代理
- IndexedDB 基础封装
- 自动保存串行化
- 导出安全边界
- 现有冒烟测试体系
- Capacitor 动态 import 约定

这些是当前项目已经验证过的基础设施。

## 推荐开发顺序

Phase 1：领域模型
→ Phase 2：Context Builder
→ Phase 3：AI 工作流
→ Phase 4：一致性检查
→ Phase 5：版本与成本
→ Phase 6：RAG

每个 Phase 完成后必须：
- build
- Electron smoke test
- 数据迁移测试
- 至少一个真实小说工作流验收
