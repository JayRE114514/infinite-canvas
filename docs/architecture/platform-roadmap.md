# 后端平台路线图

路线按依赖和可验收能力划分，不按固定日期或任务数量划分。期限只能缩减某个 Gate 的功能范围，不能绕过事务、不变量或验收门槛。

## Gate 0：架构与数据边界

状态：**已完成用户批准的 Chrome + Firefox 范围**。

- Fastify 模块化单体与 API/Worker 进程边界；
- PostgreSQL 角色分离、事务级租户上下文和默认拒绝 RLS；
- Workspace 权限、平台管理员窄口审计；
- 云画布快照、revision 冲突与删除回执；
- 独立原生 IndexedDB 事务/CAS 恢复；
- Chrome、Firefox 的真实并发、损坏与渲染进程强杀验收。

macOS Safari 由用户明确豁免，因此保持“未验证”，不计为通过。Gate 0 不代表生产部署、容量或全部云画布操作已完成人工验收。

## Gate 1：身份与 Workspace 产品闭环

状态：后端主体已实现，详细人工验收仍在 Pending Tests。

退出条件：注册、邮箱验证、登录、个人 Workspace、团队邀请、成员权限、退出登录和跨标签页 Workspace 选择形成可用闭环，关键并发与跨租户行为有证据。认证只确定 User，Workspace 成员关系和 `owner | admin | member` 授权仍由业务数据库权威管理。

## Gate 2：云画布与 Asset 生命周期

状态：云画布快照和本地恢复已实现；服务端媒体生命周期未完成。

退出条件：Canvas 与 Asset 元数据由 PostgreSQL 权威管理，媒体上传、引用、删除、导出和孤儿清理走对象存储生命周期；浏览器本地媒体不再阻断跨设备使用。验收必须覆盖：

- 先创建稳定 Asset ID，再通过服务端签发的上传能力写入不可变对象键；
- `staging -> ready | failed -> deleted` 状态只沿合法方向推进；
- 云端 Canvas 只保存 `assetId`，不保存 `blob:`、本地 `storageKey`、base64 或上游临时 URL；
- 删除只释放引用，物理清理由“无引用 + 保留期 + 无活跃任务/上传”共同决定；
- 跨设备打开、导出和任务输入不依赖创建浏览器的本地媒体库。

## Gate 3：积分账本

状态：未开始。

退出条件：个人与团队 Credit Account、不可变双重记账分录、充值/赠送/冻结/结算/退款、幂等键和并发余额保护完成；任何失败路径都不能重复扣费或凭空增发积分。验收必须覆盖：

- 金额只使用最小整数单位，交易分录提交时总和为零；
- Wallet 投影与账本聚合一致，余额和 Hold 在并发事务中保持非负；
- 同一幂等键/同一请求哈希重放原结果，同键/不同哈希返回 `409 idempotency_conflict`；
- Hold 满足 `captured + released <= original`，关闭时必须恰好相等；
- 历史只能通过补偿交易更正，管理员调整同时留下不可变审计。

## Gate 4：AI 任务与 Provider Adapter

状态：未开始。

退出条件：至少一个图片 Provider 完成下列纵向切片：

1. API 在同一 PostgreSQL 事务中创建 AI Task、不可变价格快照/Billing Order、Credit Hold、首个 Provider Attempt 和持久任务/Outbox 意图。
2. Worker 在事务提交后领取带 `lease_epoch` 的任务，并通过项目所有者维护的 Provider Adapter 调用上游；旧租约的迟到写入被拒绝。
3. 成功输出先进入 `ready` Asset，再且仅再结算一次；明确失败释放 Hold；提交结果不明确时进入 `reconciling`，不得盲目重试。
4. Task Event 以任务内单调序号持久化，SSE 按 `Last-Event-ID` 重放，重复消息不产生重复 UI 结果或重复扣费。
5. 普通用户不再向平台任务提交任意 Provider Base URL、密钥或可执行适配脚本；旧 URL 节点插件安装入口在发布前禁用或移除。

## Gate 5：生产验收

状态：未开始。

退出条件：目标 Node 版本上的自动化套件、生产密钥边界、迁移与回滚、备份恢复、滚动部署、权限审计、限流、队列重放、Provider 冒烟、容量基线和可观测性通过；再依据结果决定是否发布稳定大版本。

## 延后能力

Yjs/Hocuspocus 多人协作先保留协议和持久化边界，等单人云画布、Asset、积分和任务链稳定后实施。Redis、专用消息队列、Kubernetes 和多区域部署只有在负载或恢复目标提供证据时引入。

各 Gate 对应的稳定需求见[平台 PRD](../product/platform-prd.md)和[需求追踪表](./requirements-traceability.md)。
