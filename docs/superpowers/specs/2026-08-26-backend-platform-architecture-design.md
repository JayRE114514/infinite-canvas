# Infinite Canvas 后端平台架构设计

状态：已确认，待实施

## 1. 背景与决策

Infinite Canvas 当前是 React/Vite 单页应用，画布、素材和模型配置主要保存在浏览器，AI 请求由浏览器直接访问上游。该模式适合本地工具，但不能安全承载平台统一模型额度、账号体系、团队空间、积分结算和可靠的异步生成任务。

项目采用 AI Agent 开发、人工验收的快速迭代模式，需要在七天内形成可上线的最小闭环，同时保留长期演进能力。

最终技术决策：

- 核心后端采用 TypeScript、Node.js 24 LTS、Fastify 5。
- 采用模块化单体，不提前拆分微服务。
- API 与 Worker 使用同一代码库，但作为独立进程部署和扩容。
- PostgreSQL 是身份关联、Workspace、画布、积分、任务和队列的唯一事实源。
- Drizzle 负责常规数据访问；账本锁定、条件更新和关键事务允许直接使用 SQL。
- pg-boss 作为 PostgreSQL 持久任务队列，任务与积分 Hold 在同一事务内入队。
- 图片、视频和音频存入私有 S3 兼容对象存储。
- 第一版使用 REST 和 SSE；多人实时协同只设计协议边界，不立即实现。
- Provider Adapter 只能由项目所有者编写、审核并随服务部署，普通用户不能安装或上传任意第三方插件。
- MVP 不引入 Redis。未来只在实时广播、Presence 或缓存确有需要时引入，且不能作为积分或任务权威数据源。

FastAPI 具备长期高可用能力，但当前工作负载主要是认证、事务、远程 HTTP 编排和对象存储，不是 Python 原生推理。采用 FastAPI 会增加前后端契约生成和双语言维护成本。Go 适合未来高密度长连接或高性能媒体服务，但在当前少于 200 峰值在线和少于 20 个并发 AI 任务的规模下，不能降低账本、幂等、上游不确定性和存储一致性风险，因此不作为 MVP 主后端。

## 2. 目标与非目标

### 2.1 目标

- 支持 1,000 至 10,000 注册用户，峰值在线少于 200。
- 支持个人和团队 Workspace，所有业务资源归属于当前 Workspace。
- 支持平台统一提供模型额度，用户通过 Workspace 积分消费。
- 支持注册赠送、管理员调整、冻结、任务预占、结算和释放。
- 支持图片和视频等长任务的可靠排队、重试、查询和对账。
- 支持 API 与 Worker 独立水平扩展。
- 消除浏览器跨域调用和前端暴露平台 API Key 的问题。
- 为未来多人协同、Go 实时网关和 Python 媒体 Worker 保留稳定边界。

### 2.2 非目标

- MVP 不接入真实支付或充值。
- MVP 不实现 CRDT、OT 或多人实时编辑。
- MVP 不支持用户提供服务端调用脚本或安装第三方 Provider 插件。
- MVP 不实现复杂自定义 RBAC。
- MVP 不实现自动跨 Provider 故障转移。
- MVP 不兼容旧的浏览器业务数据结构，也不自动上传旧 IndexedDB 数据。
- MVP 不在 API 进程内执行图片缩放、视频转码或其他 CPU 密集型媒体处理。

## 3. 总体架构

```text
浏览器
  ├── REST：认证、Workspace、画布、素材、积分、任务
  ├── SSE：AI 任务事件
  └── 预签名 URL：媒体直传和下载
          │
          ▼
    Fastify API（无状态，可多副本）
          │
          ├── PostgreSQL
          │     ├── 业务表
          │     ├── 不可变积分账本
          │     └── pg-boss 队列
          │
          └── S3 兼容对象存储
                    ▲
                    │
             Fastify Worker
                    │
                    ▼
            内置 Provider Adapters
                    │
                    ▼
           Gemini / Grok / OpenAI / 中转平台
```

API 负责控制面：认证、授权、事务、任务创建、状态查询和签名 URL。Worker 负责数据面之外的异步编排：调用 Provider、轮询远程任务、搬运输出、创建 Asset 和结算积分。浏览器与 API 都不代理大文件字节流。

## 4. 代码结构

```text
infinite-canvas/
├── web/
├── server/
│   ├── src/
│   │   ├── api.ts
│   │   ├── worker.ts
│   │   ├── modules/
│   │   │   ├── identity/
│   │   │   ├── workspaces/
│   │   │   ├── canvases/
│   │   │   ├── assets/
│   │   │   ├── billing/
│   │   │   ├── ai-tasks/
│   │   │   ├── providers/
│   │   │   └── admin/
│   │   └── infrastructure/
│   │       ├── database/
│   │       ├── queue/
│   │       ├── storage/
│   │       └── observability/
│   └── migrations/
└── packages/
    └── contracts/
```

代码按业务领域组织，不建立通用 `services` 或 `repositories` 大杂烩目录。模块通过应用接口和版本化事件协作，不直接导入其他模块的数据库实现。`contracts` 只共享外部 DTO、运行时 Schema 和事件，不共享数据库实体。

## 5. 模块边界

### 5.1 Identity

Better Auth 管理用户、Session、账号关联和验证。Organization 插件表名映射为 Workspace、成员和邀请表。其他业务模块只依赖应用身份接口和稳定 ID，不直接依赖 Better Auth 内部 API。

邮箱验证完成后才创建注册赠送交易，唯一操作键为 `signup-grant:<userId>`，重复回调不得重复发放积分。

### 5.2 Workspaces

个人空间和团队空间统一使用 Workspace：

```text
Workspace
├── type: personal | team
├── members
├── canvases
├── assets
├── wallet
└── ai_tasks
```

用户首次注册后获得一个个人 Workspace，并可加入多个团队 Workspace。所有资源接口在路径中显式携带 `workspaceId`，后端每次验证成员关系。第一版角色为 `owner`、`admin`、`member`。

### 5.3 Canvases

MVP 保存完整 JSONB 快照和递增 `revision`。客户端提交 `baseRevision`，服务端通过条件更新防止静默覆盖；冲突返回 `409 revision_conflict`。

未来多人协同新增操作日志和周期快照，不改变 Canvas 的稳定资源 ID。预留 `revision`、`operationId`、`clientId` 和独立版本的实时事件协议。

### 5.4 Assets

数据库只保存对象键、MIME、字节数、宽高、时长、状态和归属。媒体使用服务端生成的不可变对象键；浏览器通过短期预签名 URL 直传。生命周期为 `staging -> ready | failed -> deleted`。

### 5.5 Billing

使用 Workspace 钱包、不可变双向账本、每订单独立 Hold 和余额投影。积分使用 `BIGINT` 最小单位，不使用浮点数。注册赠送、管理员调整、Hold、结算、释放和审计必须在单个数据库事务中完成。

### 5.6 AI Tasks

AI Tasks 负责模型参数验证、价格快照、积分预占、原子入队、状态机、结果汇总和结算，不负责具体平台 JSON 转换。

### 5.7 Providers

Provider Adapter 将统一平台输入转换成特定平台请求，并解析同步、异步、URL、Base64 和错误响应。Adapter 静态编译并注册，数据库只保存不可执行的路由和模型配置。

### 5.8 Admin

MVP 提供用户和 Workspace 查询、钱包查看、积分调整、冻结、任务查询、人工对账和 Provider 路由启停。所有管理动作写入不可变审计日志。

## 6. 核心数据模型

### 6.1 身份和 Workspace

`workspaces`：`id`、`name`、`slug`、`type`、`owner_user_id`、`status`、时间和软删除字段。

`workspace_members`：`workspace_id`、`user_id`、`role`、`status`、`joined_at`，唯一约束为 `(workspace_id, user_id)`。

个人 Workspace 禁止邀请其他成员。删除 Workspace 不物理删除账本、任务和审计。

### 6.2 画布和素材

`canvases`：`id`、`workspace_id`、`title`、`snapshot_json`、`revision`、创建/更新用户和时间、`deleted_at`。

保存使用：

```sql
UPDATE canvases
SET snapshot_json = ?, revision = revision + 1
WHERE id = ? AND workspace_id = ? AND revision = ?;
```

`assets`：`id`、`workspace_id`、可空 `canvas_id`、`kind`、可空 `content_text`、可空 `object_key`、媒体元数据、`status`、`source`、创建用户和时间。文本素材直接保存文本；图片、视频、音频和文件只在数据库保存对象键与元数据。

### 6.3 钱包和账本

`wallets` 是快速余额投影：`workspace_id` 唯一，包含 `status`、`available_amount`、`held_amount` 和 `version`，可用和冻结金额都不得小于零。

`ledger_transactions` 表示一次完整财务动作，包含唯一 `operation_key`、类型、行为人和业务引用。

`ledger_postings` 保存交易分录。每个交易的全部分录必须满足 `SUM(amount) = 0`。

示例：

```text
注册赠送 100：
  workspace_available   +100
  system_issuance       -100

任务预占 30：
  workspace_available    -30
  workspace_held         +30

实际消费 25，退回 5：
  workspace_held         -30
  system_consumed        +25
  workspace_available     +5
```

历史错误只能通过补偿交易修正，不能编辑或删除分录。

### 6.4 计费订单和 Hold

`billing_orders` 一对一关联 AI Task，保存模型、不可变价格快照、预计金额、实际金额和 `reserved | settled | released | review` 状态。

`wallet_holds` 一对一关联 Billing Order，保存 `original_amount`、`captured_amount`、`released_amount` 和 `active | closed` 状态。必须满足：

```text
captured_amount + released_amount <= original_amount
```

关闭时必须相等。每个订单独立 Hold，禁止只维护无法归属到订单的聚合预留金额。

### 6.5 模型和路由

`models` 是用户可见的平台模型，保存能力类型、参数 Schema、价格配置和启用状态。

`provider_routes` 保存模型、`adapter_key`、上游精确模型 ID、Base URL、`secret_ref`、优先级、不可执行配置和启用状态。真实密钥只存在于服务端 Secret。

### 6.6 AI Task 和 Attempt

`ai_tasks` 保存 Workspace、创建用户、能力、模型、标准化输入、状态、幂等键、请求哈希、结果和公开错误。唯一约束为 `(workspace_id, idempotency_key)`。

同一幂等键和相同请求返回原任务；同一键但请求哈希不同返回 `409 idempotency_conflict`。

`provider_attempts` 保存尝试编号、路由、Adapter、上游模型、Provider 幂等键、远程任务 ID、状态、失败分类、脱敏请求快照、响应元数据和 heartbeat。唯一约束包括 `(task_id, attempt_number)` 和 `(adapter_key, provider_idempotency_key)`。

`task_events` 保存任务内递增 sequence、事件类型、载荷和时间，唯一约束为 `(task_id, sequence)`，用于 SSE 断线重放。

## 7. 关键事务与状态机

### 7.1 创建任务

单个 PostgreSQL 事务依次完成：

1. 验证 Workspace 成员和权限。
2. 校验幂等键与请求哈希。
3. 创建 AI Task。
4. 创建 Billing Order 和价格快照。
5. 锁定钱包并 Hold 最大预计积分。
6. 写入 Ledger Transaction 和 Postings。
7. 创建 Provider Attempt。
8. 通过 pg-boss 写入只包含 `taskId` 的 Job。
9. 提交事务。

事务提交前不得调用 Provider，也不得保持数据库事务跨越远程 HTTP 请求。

### 7.2 Task 状态

```text
queued -> submitting -> processing -> storing -> succeeded
                    ├───────────────-> failed
                    └───────────────-> reconciling

reconciling -> processing | storing | succeeded | failed
```

Provider 已成功但输出尚未存入平台对象存储时使用 `storing`，仅重试搬运，不重新生成。

Adapter 必须把失败分类为：

- `safe_retry`：可确认上游没有受理，可有限重试。
- `terminal`：确定失败，任务失败并释放积分。
- `ambiguous`：无法确认是否受理，进入 `reconciling`。
- `provider_processing`：已有远程任务 ID，进入查询。
- `success`：输出有效，进入存储和结算。

所有 500、502 和 timeout 都不能默认重试。

### 7.3 结算

- 成功：捕获实际费用，释放剩余 Hold。
- 提交前确定失败：全额释放。
- 上游明确拒绝且未计费：全额释放。
- 结果不确定：保持 Hold，等待后台或人工对账。
- 管理员对账：释放或捕获都必须同时写入补偿分录和审计。

状态更新采用带前置状态的条件更新和唯一操作键，确保重复 Worker 不能重复结算。

## 8. API 契约

业务接口统一使用 `/api/v1`，Better Auth 使用 `/api/auth/*`。Session 使用 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie。每个请求生成 `requestId`，写请求接受 `Idempotency-Key`。

主要资源：

```text
/api/v1/workspaces
/api/v1/workspaces/:workspaceId/members
/api/v1/workspaces/:workspaceId/canvases
/api/v1/workspaces/:workspaceId/assets
/api/v1/workspaces/:workspaceId/wallet
/api/v1/workspaces/:workspaceId/ledger-transactions
/api/v1/workspaces/:workspaceId/ai-tasks
/api/v1/workspaces/:workspaceId/ai-tasks/:taskId/events
/api/v1/models
/api/v1/admin/*
```

创建 AI Task 返回 `202 Accepted`，响应包含 `taskId`、状态和预计积分。

统一错误：

```json
{
  "error": {
    "code": "insufficient_points",
    "message": "当前空间积分不足",
    "retryable": false,
    "requestId": "..."
  }
}
```

公开错误不得包含上游 HTML、Authorization、完整响应、数据库错误或内部堆栈。

## 9. 模型能力与 Adapter

每个模型声明真实支持的画幅、分辨率、质量、生成张数、参考图数量和定价。前端根据模型能力渲染控件，不使用全局参数猜测。Gemini 不支持质量时不显示 `low/medium/high`；OpenAI Image 支持时才提交对应参数。

统一输入使用按 `kind` 区分的联合类型，不使用包含大量可空字段的万能对象。

核心 Adapter 接口：

```ts
interface ProviderAdapter {
  readonly key: string
  validate(route: ProviderRoute, input: GenerationInput): Promise<void>
  submit(context: SubmitContext): Promise<SubmitOutcome>
  poll?(context: PollContext): Promise<PollOutcome>
  cancel?(context: CancelContext): Promise<CancelOutcome>
  classifyError(error: unknown): ProviderFailure
}
```

Adapter 必须声明是否支持 Provider 幂等键、远程查询和取消。如果既不支持幂等也无法按客户端键查询，提交超时后必须进入对账。

静态注册示例：

```ts
const adapters = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  wawazz: new WawazzAdapter(),
  wawapii: new WawapiiAdapter(),
} satisfies Record<string, ProviderAdapter>
```

禁止动态 npm 安装、数据库可执行脚本、`new Function`、用户上传适配器和任意远程模块加载。

## 10. 媒体输出

Adapter 可返回临时 URL、Base64 或异步任务 ID。Worker 校验内容类型和大小，流式写入不可变临时对象键，提取媒体元数据，创建 Asset，并在同一结算事务内标记任务成功。前端只获得 Asset ID 和短期下载地址，不依赖上游临时 URL。

后台清理没有数据库引用的临时对象，并监控数据库记录和对象存储不一致。

## 11. 前端迁移

- 服务器成为画布、素材、积分和 AI 任务的权威来源。
- `localforage` 只保存未同步草稿和读取缓存。
- API Key 不再保存在普通用户浏览器。
- 普通用户不再配置任意上游地址，只选择平台模型。
- 现有渠道页迁移为管理员模型和 Provider 路由管理。
- 画布以 Zustand 本地编辑、防抖保存 `snapshot + baseRevision`。
- 旧 IndexedDB 画布不自动上传；需要时后续提供显式导入动作。

## 12. 安全

- 浏览器和 API 同源部署，消除平台调用 CORS 问题。
- Provider Base URL 只能由管理员从允许配置注册。
- 拒绝 loopback、私网、link-local 和云元数据地址，防止 SSRF。
- 限制请求体、文件大小、超时和并发。
- 日志脱敏 Cookie、Authorization、API Key 和 URL 敏感参数。
- 用户和 Workspace 分别限流，并在数据库内执行严格任务并发检查。
- Provider Key 仅存在服务端 Secret。
- 注册赠送在邮箱验证和基础反滥用检查后发放。

## 13. 部署与高可用

生产环境至少两个无状态 API 副本、一个或多个 Worker、托管 PostgreSQL 和 S3 兼容对象存储。单机 Docker Compose 只用于开发和测试，不能作为高可用生产方案。

数据库迁移由单独 release job 执行，应用实例不在启动时竞争迁移。PostgreSQL 开启自动备份和 PITR，并定期演练恢复。初期目标为 RPO 不超过 5 分钟、RTO 不超过 30 分钟、MVP 99.5% 可用性，稳定后提升至 99.9%。

API 停机时先退出 readiness、停止新请求、等待短请求、关闭 SSE 和连接池。Worker 停机时停止领取任务、保留 heartbeat 和租约，不把执行中任务直接标记失败或退款。

队列按 `ai-image`、`ai-video`、`ai-audio`、`provider-poll`、`reconciliation` 和 `maintenance` 隔离。设置平台、路由和 Workspace 三层并发限制。

## 14. 故障恢复

| 故障 | 行为 |
|---|---|
| API 在事务提交前崩溃 | 无任务、无扣分，客户端重试 |
| API 提交后响应前崩溃 | 幂等键返回原任务 |
| Worker 调用 Provider 前崩溃 | pg-boss 重新执行 |
| Provider 明确未受理 | 安全重试或失败释放 |
| Provider 可能受理但响应丢失 | 进入 `reconciling`，禁止盲目重试 |
| 已取得远程任务 ID 后崩溃 | 恢复查询远程任务 |
| Provider 成功但对象存储失败 | 从 `storing` 继续搬运 |
| 结算事务失败 | 保持 Hold，重试结算 |
| SSE 断开 | 使用 `Last-Event-ID` 补发 |
| PostgreSQL 故障 | 停止新任务和领取，恢复后继续 |
| Worker 重复执行 | 唯一约束和条件更新阻止重复调用或结算 |

Worker 使用租约和 heartbeat。Reaper 检查过期任务：`queued` 可安全重新领取；没有远程 ID 的过期 `submitting` 进入 `reconciling`；有远程 ID 的 `processing` 继续查询。

## 15. 可观测性

结构化日志关联 `requestId`、`userId`、`workspaceId`、`taskId`、`attemptId` 和 `providerRouteId`。默认不记录提示词、Cookie、密钥和完整上游响应。

核心指标包括：

- API 请求量、错误率、延迟、事件循环延迟、内存、CPU 和数据库连接池。
- 队列深度、最长等待、各状态停留时间、任务成功率和端到端耗时。
- Provider 路由成功率、429、5xx、timeout、生成耗时和查询失败率。
- 未关闭 Hold、Hold 年龄、账本平衡、未结算成功任务和未释放失败任务。
- SSE 连接和断线重放数量。

账本不平衡、负余额、`reconciling` 持续增长、队列积压、Provider 连续失败、连接池耗尽和 Asset/对象不一致必须告警。

## 16. 测试策略

单元测试覆盖模型能力、价格、状态转换、Hold/结算/释放、错误分类和响应解析。

真实 PostgreSQL 集成测试覆盖并发防透支、幂等 Hold、重复 Worker 结算、管理员调整与审计原子性、任务与 pg-boss 原子入队以及 Canvas revision 冲突。

每个 Adapter 使用固定 HTTP Fixture 覆盖正常 JSON、Base64、临时 URL、远程任务 ID、HTML 502、空响应、错误 JSON、重复字段、超时、连接中断、无媒体成功响应、画幅/分辨率映射和视频重复时长字段。每个真实上游故障都要沉淀为回归 Fixture。

故障注入覆盖事务后崩溃、Provider 接受后崩溃、S3 中断、结算断连、重复领取和 SSE 重连。

自动 E2E 覆盖注册验证、注册积分、创建画布、选择模型、生成图片、素材入库和积分流水。真实 Provider 冒烟测试使用低额度专用密钥人工触发，不进入普通 CI。

## 17. 七天交付切片

### 第 1 天

Server/Contracts 骨架、Fastify、PostgreSQL、Drizzle、pg-boss、Better Auth、个人 Workspace 和本地基础设施。

### 第 2 天

团队 Workspace、基础权限、Canvas 快照/revision、预签名上传、Asset 元数据、前端登录和 Workspace 切换。

### 第 3 天

Wallet、双向账本、Hold、Billing Order、注册赠送、管理员调整/冻结和并发幂等测试。

### 第 4 天

模型目录、AI Task 状态机、原子 Hold/入队、Provider Adapter 接口和 SSE 事件。

### 第 5 天

一个图片 Adapter、Worker 调用、输出入 S3、Asset 创建、结算/释放/对账和前端生成链路。

### 第 6 天

一个视频 Adapter、异步查询、heartbeat、Reaper、Reconciliation，以及 HTML 错误、超时和重复执行回归测试。

### 第 7 天

生产迁移、Secret、API/Worker 部署、日志指标告警、小额度真实图片/视频测试和人工验收修复。

## 18. 上线切线

必须完成：登录、个人 Workspace、基础团队 Workspace、云端 Canvas、对象存储、Workspace 积分钱包、管理员调整、一个图片 Provider、幂等/恢复和 SSE。

尽量完成：一个视频 Provider、邮件邀请和简单 Provider 路由管理界面。

明确延后：支付、多人实时编辑、任意第三方插件、自动跨 Provider 故障转移、复杂 RBAC、离线优先同步、CRDT/OT 和移动端专项适配。

如果进度落后，优先保证图片生成和账本可靠性，视频不得以削弱幂等、对账或积分正确性为代价上线。

## 19. 长期演进触发器

核心 Workspace、授权、账本和任务元数据保持在 Fastify/PostgreSQL 中，最晚拆分。

出现 Python 原生推理、Diffusers、复杂 OpenCV 或本地媒体分析时，新增独立 Python Media/ML Worker，通过版本化任务协议接收 Asset ID 和参数，不重写核心 API。

当持续连接超过约 5,000、房间投递达到每秒数万次、实时模块占 API 超过 30% 资源或事件循环延迟持续违反 SLO 时，先对独立 TypeScript 实时进程进行生产规模压测。只有 Go 原型在同等 SLO 下明显提高每 GiB 连接数或降低至少约 30% 成本时，才拆出 Go 实时网关。

未来 Go 网关只处理鉴权、房间、限流和版本化消息传输，不能掌管积分、任务或 Canvas 权威状态。

## 20. 参考资料

- [Fastify Plugins](https://fastify.dev/docs/latest/Reference/Plugins/)
- [Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)
- [Node.js event loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [pg-boss documentation](https://pgboss.io/)
- [Better Auth Organization plugin](https://better-auth.com/docs/plugins/organization)
