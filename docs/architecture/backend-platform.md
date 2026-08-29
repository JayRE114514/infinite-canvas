# 后端平台架构

## 决策摘要

平台采用 **TypeScript + Fastify 模块化单体**。业务 API 与 Worker 共用领域模块和数据库模型，但作为独立进程运行；PostgreSQL 是用户、Workspace、权限、画布元数据、积分和任务状态的唯一业务权威。媒体字节进入 S3 兼容对象存储，长任务由 PostgreSQL 持久化队列驱动。

这套边界面向长期演进，但不预先部署当前规模不需要的 Keycloak、RabbitMQ、Redis 或 Kubernetes。扩容通过可观测指标触发，而不是通过组件数量证明“高可用”。

```text
Browser
  │ HTTPS / SSE / presigned upload
  ▼
Fastify API process
  ├── Identity / Workspace / Canvas / Billing / Task APIs
  ├── PostgreSQL transactions + default-deny RLS
  └── S3-compatible object storage

Fastify Worker process
  ├── durable PostgreSQL jobs
  ├── owner-maintained Provider Adapters
  └── upstream AI services
```

## 核心边界

| 领域 | 权威数据源 | 边界 |
| --- | --- | --- |
| 身份 | Better Auth + PostgreSQL | 只回答用户身份与会话，不承载业务团队权限 |
| Workspace 与权限 | PostgreSQL | 应用授权是第一层，默认拒绝 RLS 是第二层 |
| 云画布 | PostgreSQL `snapshot` + `revision` | 服务端快照是云端权威；冲突不能静默覆盖 |
| 本地恢复 | 独立原生 IndexedDB | 只保护未同步编辑，不替代服务端版本和协作协议 |
| 积分 | PostgreSQL 不可变账本 | 预冻结、结算、释放、退款均需事务和幂等键 |
| AI 任务 | PostgreSQL 任务表与持久化队列 | 写任务、冻结积分和投递意图在同一事务内 |
| 媒体 | PostgreSQL 元数据 + S3 字节 | 画布和任务只引用 Asset ID，不把大文件写入业务行 |
| 上游接入 | Provider Adapter | 仅项目所有者提供并随平台发布，用户不能安装任意可执行插件 |

## 模块与进程

业务代码按领域模块组织，而不是按控制器、服务、模型横切整个仓库。当前已经落地 Identity、Workspace、Canvas 和平台管理员边界；Billing、Assets、AI Tasks 与 Providers 按相同规则后续加入。

API 和 Worker 可以独立扩容、发布和隔离故障，但共享：

- 领域类型与不变量；
- PostgreSQL schema 与迁移链；
- 统一错误信封、幂等键和审计语义；
- 事务后写入的任务/outbox 协议。

远程模型调用不得占用数据库事务。Worker 先领取持久任务，再调用上游，最后以幂等事务结算；网络超时或响应不明确时进入 `reconciling`，不能盲目重试并再次扣费。

## 数据完整性不变量

1. 所有租户业务表都带 Workspace 作用域；缺少事务级用户/Workspace 上下文时 RLS 默认拒绝。
2. 迁移角色与运行期 API、Worker、维护角色分离，运行期角色不拥有业务对象且没有 `BYPASSRLS`。
3. 平台管理员跨租户操作必须通过固定 `search_path` 的窄口 `SECURITY DEFINER` 函数，并在同一事务内写入恰好一条不可变审计。
4. Canvas 保存使用服务端 `revision` 做条件更新；删除只有数据库签发、客户端精确验证的回执才构成删除证明。
5. 本地恢复的读取、判定与写入必须在同一 IndexedDB 事务内完成 CAS；不同标签页拥有不同草稿行。
6. 积分余额由不可变分录推导；任务开始前冻结，成功后结算，失败后释放，重复消息不能重复扣费。
7. 任务投递采用至少一次语义，消费者必须幂等；不假设消息天然“只处理一次”。

## 画布与多人协作

当前 Canvas 文档模式是完整快照。Zustand 是前端投影和交互状态，不是多人共享权威；本机 viewport 只进入恢复信封的 `localUi`，不推进服务端文档版本。

多人实时协作是后续独立模式：Yjs/Hocuspocus 负责 CRDT 文档与 WebSocket，会话在线状态使用 Awareness，PostgreSQL 保存快照与更新，Redis 只在协作服务多实例时承担广播与临时状态。协作模式不会与快照模式同时成为同一画布的双重权威，也不会把现有整份 JSON 定时上传改名为协作。

## 高可用与扩展触发器

当前优先保证单区域可恢复部署：数据库备份与恢复演练、对象存储生命周期、任务幂等、指标、日志和追踪。只有指标证明单体边界成为瓶颈时才拆分：

- API 或 Worker 资源曲线独立：分别水平扩容现有进程；
- 长任务吞吐受 PostgreSQL 队列限制：评估专用消息系统；
- 多实例协作需要跨进程广播：引入 Redis；
- 单集群故障目标无法满足：再引入编排和数据库高可用方案。

拆分时保持现有 HTTP 契约、任务幂等键、账本和 Asset ID，不重写业务协议。

## 当前实现状态

- 已实现：Fastify 模块化单体基础、API/Worker 进程边界、Better Auth、Workspace 与权限、角色分离、事务级租户上下文、默认拒绝 RLS、云画布快照与 revision、删除回执、原生 IndexedDB CAS 恢复。
- 尚未实现：PostgreSQL 积分钱包与账本、对象存储 Asset 生命周期、完整 AI 任务执行链、Provider Adapter 平台、Yjs 实时协作、生产容量与故障演练。
- 当前 Web 端部分画布媒体和“我的素材”仍主要保存在浏览器；AI API Key 仍保存在浏览器并由前端直连上游，不能把目标架构误写成已上线能力。

产品边界见[平台 PRD](../product/platform-prd.md)，稳定子系统契约与[需求追踪表](./requirements-traceability.md)位于本目录。相关决策见 `docs/adr/`，交付顺序见[平台路线图](./platform-roadmap.md)，验证证据见文档站的 Gate 0 记录。
