# 平台需求追踪表

本表把稳定需求连接到权威设计、交付 Gate、进度记录与验证证据。状态只从对应 Gate 和验证记录推导，不能因代码存在而自动视为完成。

| Requirement | 权威设计 / ADR | Roadmap Gate | 进度入口 | 验证入口 |
| --- | --- | --- | --- | --- |
| R-01 身份只负责认证，Workspace 负责成员与权限 | [PRD](../product/platform-prd.md)、[平台架构](./backend-platform.md)、[ADR-0001](../adr/0001-modular-monolith-and-postgresql-authority.md) | Gate 1 | [Todo](../content/docs/progress/todo.mdx)、[Pending Tests](../content/docs/progress/pending-test.mdx) | [Gate 0 后端](../content/docs/progress/gate-0-backend-verification.mdx)及后续 Gate 1 记录 |
| R-02 PostgreSQL 是租户业务权威，RLS 默认拒绝 | [平台架构](./backend-platform.md)、[ADR-0001](../adr/0001-modular-monolith-and-postgresql-authority.md) | Gate 0 | [Pending Tests](../content/docs/progress/pending-test.mdx) | [Gate 0 后端](../content/docs/progress/gate-0-backend-verification.mdx) |
| R-03 Canvas 使用云端 snapshot/revision，冲突不静默覆盖 | [PRD](../product/platform-prd.md)、[平台架构](./backend-platform.md) | Gate 0 / 2 | [Pending Tests](../content/docs/progress/pending-test.mdx) | [Gate 0 前端](../content/docs/progress/gate-0-frontend-verification.mdx) |
| R-04 本地恢复使用独立 IndexedDB 事务/CAS | [恢复契约](./native-canvas-recovery.md)、[ADR-0002](../adr/0002-native-indexeddb-cas-recovery.md) | Gate 0 | [Pending Tests](../content/docs/progress/pending-test.mdx) | [Gate 0 前端](../content/docs/progress/gate-0-frontend-verification.mdx) |
| R-05 删除必须由精确 Deletion Receipt 证明 | [恢复契约](./native-canvas-recovery.md)、[ADR-0002](../adr/0002-native-indexeddb-cas-recovery.md) | Gate 0 | [Pending Tests](../content/docs/progress/pending-test.mdx) | [Gate 0 前端](../content/docs/progress/gate-0-frontend-verification.mdx) |
| R-06 Asset 元数据/字节分离，稳定 ID 与不可变对象键 | [Asset 契约](./assets.md)、[平台架构](./backend-platform.md) | Gate 2 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 2 验证记录 |
| R-07 积分使用整数双重记账与不可变分录 | [积分账本](./credits-ledger.md)、[PRD](../product/platform-prd.md) | Gate 3 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 3 验证记录 |
| R-08 Hold 的冻结、捕获、释放与幂等冲突保持守恒 | [积分账本](./credits-ledger.md) | Gate 3 / 4 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 3/4 验证记录 |
| R-09 Task、Hold、价格快照与投递意图同事务创建 | [AI Task 契约](./ai-task-provider.md)、[平台架构](./backend-platform.md) | Gate 4 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 4 验证记录 |
| R-10 Worker 至少一次执行但业务结果与结算恰好一次 | [AI Task 契约](./ai-task-provider.md) | Gate 4 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 4 故障注入与对账记录 |
| R-11 SSE 按 Task Event 序号断点重放 | [AI Task 契约](./ai-task-provider.md) | Gate 4 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 4 API 验证记录 |
| R-12 所有可执行插件仅由项目所有者维护 | [PRD](../product/platform-prd.md)、[ADR-0003](../adr/0003-owner-maintained-provider-adapters.md) | Gate 4 前发布门禁 | [Todo](../content/docs/progress/todo.mdx) | 发布前静态门禁与功能验收 |
| R-13 浏览器 Provider Key/直连最终退出普通用户路径 | [PRD](../product/platform-prd.md)、[AI Task 契约](./ai-task-provider.md) | Gate 4 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 4 安全边界验证 |
| R-14 多人协同只能有一个共享文档权威 | [平台架构](./backend-platform.md) | Gate 2–4 后 | [Todo](../content/docs/progress/todo.mdx) | 后续协作 Gate 记录 |
| R-15 生产发布必须有恢复、容量、审计和 Provider 冒烟证据 | [PRD](../product/platform-prd.md)、[路线图](./platform-roadmap.md) | Gate 5 | [Todo](../content/docs/progress/todo.mdx) | 后续 Gate 5 生产验收记录 |

## 维护规则

- 新增稳定需求时先给出 Requirement ID，再连接权威设计与 Gate。
- 实现切片只更新本地 tracker；里程碑验收后再更新 Todo、Pending Tests 和对应验证记录。
- `Verification` 没有证据时保持“后续记录”，不得用单元测试或目标架构替代真实 Gate 结论。
- Safari 在 Gate 0 由用户豁免，状态是“未验证”而不是“通过”。
