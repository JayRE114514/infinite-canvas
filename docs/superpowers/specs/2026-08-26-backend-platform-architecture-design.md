# Infinite Canvas 后端平台架构设计

状态：第一轮对抗审查问题已修订，待冻结复审与用户复核；本文件通过前不授权继续实施

## 1. 背景与决策

Infinite Canvas 当前是 React/Vite 单页应用，画布、素材和模型配置主要保存在浏览器，AI 请求由浏览器直接访问上游。该模式适合本地工具，但不能安全承载平台统一模型额度、账号体系、团队空间、积分结算和可靠的异步生成任务。

项目采用 AI Agent 开发、人工验收的迭代模式。交付速度通过缩小功能切片获得，不得通过省略架构验证、事务测试、租户隔离测试或恢复演练获得。任何核心架构都必须先完成规范、独立对抗审查、自动化测试设计和人工验收矩阵，再进入实现。

最终技术决策：

- 核心后端采用 TypeScript、Node.js 24 LTS、Fastify 5。
- 采用模块化单体，不提前拆分微服务。
- API 与 Worker 使用同一代码库，但作为独立进程部署和扩容。
- API、Worker、迁移和维护任务分别使用独立 PostgreSQL 登录角色与连接配置；角色隔离是进程凭据边界，不能用查询包装器模拟。
- PostgreSQL 是身份关联、Workspace、画布、积分、任务和队列的唯一事实源；Redis 和消息中间件不得成为这些领域的权威存储。
- Drizzle 负责常规数据访问；账本锁定、条件更新和关键事务允许直接使用 SQL。
- pg-boss 作为 PostgreSQL 持久任务队列，任务与积分 Hold 在同一事务内入队。
- 图片、视频和音频存入私有 S3 兼容对象存储。
- Better Auth 只负责用户身份、Session、账号关联和验证；Workspace、成员、角色和邀请由业务模块拥有，不把身份产品的 Organization 模型作为业务权威。
- 租户隔离同时使用应用层授权和 PostgreSQL RLS；RLS 不是替代应用授权，而是默认拒绝的第二道边界。
- 第一阶段使用 REST、SSE 和快照 revision；多人实时协同预留独立文档模式与服务边界，但不立即实现 Yjs、Hocuspocus 或 Redis。
- Provider Adapter 只能由项目所有者编写、审核并随服务部署，普通用户不能安装或上传任意第三方插件。
- 第一阶段不引入 NestJS、Keycloak、RabbitMQ、Redis 或 Kubernetes。未来引入必须由产品能力、SLO、容量数据和故障演练共同触发，不能仅因目标架构图存在而引入。

FastAPI 具备长期高可用能力，但当前工作负载主要是认证、事务、远程 HTTP 编排和对象存储，不是 Python 原生推理。采用 FastAPI 会增加前后端契约生成和双语言维护成本。Go 适合未来高密度长连接或高性能媒体服务，但在当前初始容量假设下，不能降低账本、幂等、上游不确定性和存储一致性风险，因此不作为 MVP 主后端。

## 2. 目标与非目标

### 2.1 目标

- 初始容量假设为 1,000 至 10,000 注册用户、峰值在线少于 200；这是压测输入，不是未经验证的容量承诺。
- 支持个人和团队 Workspace，所有业务资源归属于当前 Workspace。
- 支持平台统一提供模型额度，用户通过 Workspace 积分消费。
- 支持注册赠送、管理员调整、冻结、任务预占、结算和释放。
- 支持图片和视频等长任务的可靠排队、重试、查询和对账。
- 支持 API 与 Worker 独立水平扩展。
- 消除浏览器跨域调用和前端暴露平台 API Key 的问题。
- 为未来独立协作服务、可替换身份提供商、消息代理和 Python 媒体 Worker 保留稳定边界。

### 2.2 非目标

- MVP 不接入真实支付或充值。
- MVP 不实现 CRDT、OT 或多人实时编辑。
- MVP 不把 Keycloak、RabbitMQ、Redis、CloudNativePG、分布式 MinIO 或 Kubernetes 作为运行前提。
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

未来协作模式（不属于第一阶段运行依赖）：

浏览器 ── WSS ── Hocuspocus/Yjs 协作服务
                       ├── PostgreSQL：Yjs 检查点 + 后续更新（单一逻辑更新流）
                       └── Redis：仅在多实例时传播更新与可重建 Presence 缓存
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

Better Auth 管理用户、Session、账号关联和验证。Identity 对外只暴露稳定的 `userId`、认证上下文和验证事件；其他业务模块不得调用 Better Auth Organization API，也不得依赖其角色字符串、邀请状态机或内部表结构。`better-auth*` 只能在 `modules/identity/**` 导入，跨模块数据库 Schema 只能通过模块公开入口使用；该边界由静态导入规则验证，不能只靠约定。

业务表引用平台内部 `users.id`，不直接保存外部 OIDC `sub`、邮箱或 Provider 专用用户 ID。唯一例外是尚未注册用户的邀请目标邮箱：它只用于寻址，不是身份关联；邀请接受后成员关系只引用 `users.id`，历史邮箱仅作审计。未来身份提供商通过身份关联表映射到同一内部用户，避免更换登录系统时迁移业务资源所有权。

当前把 Better Auth Organization 插件映射到 `workspaces`、`workspace_members` 和邀请表的实现属于待纠正耦合。纠正应在继续扩展 Billing、Assets 和 AI Tasks 前完成：删除所有 Organization API 业务调用，把相关表移交 Workspaces 模块，并将 `organizationId` 直接重命名为 `workspace_id`。行 ID 保持稳定；项目尚未上线，不保留旧列兼容视图，也不让身份适配器继续成为 Workspace 的写入权威。

账号删除采用停用和匿名化：撤销 Session/账号关联并清理可删除的身份数据，但保留稳定的内部 `users.id` 作为账本、审计和任务行为人的引用。业务表到用户和 Workspace 的外键使用 `RESTRICT/NO ACTION`，不得因身份删除级联删除业务历史。

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

用户邮箱验证成功后，在同一业务流程中创建一个个人 Workspace，并可加入多个团队 Workspace；列表接口不得以 GET 副作用反复补建。允许幂等的后台修复任务处理历史缺失，但必须走专用审计路径。所有资源接口在路径中显式携带 `workspaceId`，后端每次验证成员关系。第一版角色为 `owner`、`admin`、`member`。

Workspace 模块拥有成员与邀请的全部不变量。未来替换身份提供商时，只替换 Identity 适配器和登录流程，不迁移 Workspace、积分、画布、素材或任务关系。

### 5.3 Canvases

第一阶段明确为 `snapshot` 文档模式：保存完整 JSONB 快照和递增 `revision`。客户端提交 `baseRevision`，服务端通过条件更新防止静默覆盖；冲突返回 `409 revision_conflict`。原生 IndexedDB 事务/CAS 只负责该模式下的浏览器未同步草稿恢复，不是云端权威，也不是未来 Yjs 的持久化引擎。`document_mode` 在 Gate 0 立即落库并进入只读响应契约，避免协作上线时对已有画布补做无约束模式迁移。

`canvases.document_mode` 明确区分 `snapshot | collaborative`，第一阶段只创建 `snapshot`。普通保存不得改变模式；未来模式转换必须通过独立、可恢复的迁移流程完成。snapshot 模式以 `snapshot_json + revision` 为唯一文档权威；collaborative 模式以 Yjs 二进制文档为唯一权威，JSON 只能是导出或搜索投影，不能形成双写权威。

未来多人协同使用独立 `collaborative` 文档模式，不在现有 `snapshot_json` 上追加全量覆盖协议。两种模式共享 Canvas 稳定资源 ID、Workspace 授权、Asset ID 和导出契约，但拥有不同的同步与离线持久化实现。

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

### 5.9 Collaboration（预留边界，第一阶段不实现）

协作服务是独立运行时，不与 Business API 共用 WebSocket 生命周期。Business API 仍拥有用户、Workspace、Canvas 元数据、权限、积分和 Asset；协作服务只拥有指定 Canvas 文档的实时 CRDT 会话。

- `Y.Map<nodes>` 以节点 ID 为键，`Y.Map<connections>` 以连线 ID 为键，设置使用独立 `Y.Map`，需要协同编辑的长文本使用 `Y.Text`。
- 图片、视频和音频只在文档中保存 Asset ID，不保存媒体字节或上游临时 URL。
- 光标、当前选择框、在线状态和每个用户的实时视口使用 Awareness，只传播、不持久化。共享默认视图是文档设置，只能由显式“设为默认视图”操作更新；普通平移缩放不得写云端快照或消耗 revision。
- PostgreSQL 的协作权威采用一条逻辑 Yjs 更新流：可直接加载的二进制检查点记录 `through_sequence`，恢复时加载最新检查点和其后的增量更新。检查点只是更新流的压缩结果，不是第二权威；JSON 搜索/导出投影必须携带来源 sequence，可从 Yjs 权威重建，永远不能反向覆盖文档。压缩锁、保留、崩溃恢复和并发写入仍须在协作子系统规范中通过故障测试后实施。
- Hocuspocus 通过短期协作令牌鉴权，令牌包含 `userId`、`workspaceId`、`canvasId`、权限和到期时间；协作服务不得自行维护另一套成员关系。
- 成员移除和角色降低必须在有界时间内终止或降级已存在连接，不能只在首次握手鉴权。正确性基线为不超过 60 秒的短令牌和经 Business API 静默续期；主动断连事件只能作为缩短窗口的优化。协作子系统上线前必须用自动化测试证明撤权边界。
- Redis 只在协作服务需要多个实例时引入，用于实例间传播，不作为持久化层。Presence 由活动连接重建，Redis 中的副本只能是带 TTL 的缓存；Redis 重启后应在一个心跳周期内重新收敛，不能要求会话整体重连。Redis 广播不能替代按文档路由、房间分片、连接压测和重连风暴测试。
- Zustand 在协作模式中只保存本机 UI 投影和私有状态，不再是共享文档的权威来源。

## 6. 核心数据模型

### 6.1 身份和 Workspace

`workspaces`：`id`、`name`、`slug`、`type`、`owner_user_id`、`status`、`created_at`、`updated_at`、`deleted_at`。`owner_user_id` 对 `users` 使用 `RESTRICT/NO ACTION`，禁止身份删除级联删除 Workspace。

`workspace_members`：`workspace_id`、`user_id`、`role`、`status`、`joined_at`，唯一约束为 `(workspace_id, user_id)`；`role` 受 `owner | admin | member` CHECK/枚举约束。部分唯一索引保证最多一个 `owner`，延迟约束触发器保证活动 Workspace 提交时至少一个 `owner`。所有者转移必须在一个事务中完成，不能先删除旧 owner。

个人 Workspace 禁止邀请其他成员。删除 Workspace 只允许把状态改为停用并写 `deleted_at`；账本、任务、Attempt、Asset 元数据和审计不物理删除。普通业务外键不得对 Workspace 使用级联删除。

`workspace_invitations` 由 Workspaces 模块拥有，保存 Workspace、目标邮箱、角色、邀请者、状态、到期时间和一次性令牌摘要。身份模块只提供当前用户和已验证邮箱，不处理成员状态转换。

### 6.2 画布和素材

`canvases`：`id`、`workspace_id`、`title`、`document_mode`、`snapshot_json`、`revision`、创建/更新用户和时间、`deleted_at`。`document_mode` 使用 `snapshot | collaborative` CHECK/枚举且默认 `snapshot`，第一阶段请求不得修改；`snapshot_json` 在 collaborative 模式中不得作为文档权威。`revision` 在数据库使用 `BIGINT`，但传输与 TypeScript 明确限制在 `Number.MAX_SAFE_INTEGER`，这是版本号的特例，绝不能套用到积分金额。

保存使用：

```sql
UPDATE canvases
SET snapshot_json = ?, revision = revision + 1
WHERE id = ? AND workspace_id = ? AND revision = ?;
```

`assets`：`id`、`workspace_id`、可空 `canvas_id`、`kind`、可空 `content_text`、可空 `object_key`、媒体元数据、`status`、`source`、创建用户和时间。文本素材直接保存文本；图片、视频、音频和文件只在数据库保存对象键与元数据。

### 6.3 钱包和账本

`wallets` 是快速余额投影：`workspace_id` 唯一，包含 `status`、`available_amount` 和 `held_amount`，可用和冻结金额都不得小于零。并发控制统一使用事务内 `SELECT ... FOR UPDATE`，不混用未定义的乐观 `version` 协议。

`ledger_transactions` 表示一次完整财务动作，包含唯一 `operation_key`、类型、行为人和业务引用。

`ledger_postings` 保存交易分录。每个交易的全部分录必须满足 `SUM(amount) = 0`，该多行不变量由 `DEFERRABLE INITIALLY DEFERRED` 约束触发器在提交时校验：交易和分录两侧都触发验证，分别覆盖“没有分录”和“分录不平衡”。服务层必须在提交边界映射约束错误；不能伪装成单行 CHECK。

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

`ai_tasks` 保存 Workspace、创建用户、能力、模型、标准化输入、状态、幂等键、请求哈希、结果、公开错误、`lease_epoch`、`lease_expires_at` 和当前 Worker。唯一约束为 `(workspace_id, idempotency_key)`。

同一幂等键和相同请求返回原任务；同一键但请求哈希不同返回 `409 idempotency_conflict`。

`provider_attempts` 保存尝试编号、路由、Adapter、上游模型、Provider 幂等键、远程任务 ID、状态、失败分类、脱敏请求快照、响应元数据和 heartbeat。唯一约束包括 `(task_id, attempt_number)` 和 `(adapter_key, provider_idempotency_key)`。

`task_events` 保存任务内递增 sequence、事件类型、载荷和时间，唯一约束为 `(task_id, sequence)`，用于 SSE 断线重放。

### 6.7 租户键、数据库角色与 PostgreSQL RLS

`workspaces` 是租户根表，以自身 `id` 表示租户；所有可由租户请求直接访问的后代业务表必须包含不可空 `workspace_id`。子表若同时保存父资源 ID 和 `workspace_id`，必须使用复合外键或数据库约束保证两者属于同一 Workspace，不能只依赖应用代码保持一致。

身份全局表（用户、Session、账号、验证）不套用 Workspace RLS。租户根与授权表（`workspaces`、`workspace_members`、`workspace_invitations`）启用 RLS，但不启用 FORCE，以便受严格限制的 policy helper 读取授权事实；Canvas、Asset、Wallet、Ledger、Billing、AI Task、Attempt、Task Event 和审计等叶子业务表同时使用 `ENABLE ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`。所有策略默认拒绝，并按命令分别定义 `USING` 与 `WITH CHECK`。

数据库凭据按进程分离：

- `schema_owner`：只供 release job 执行迁移并拥有对象，不承载应用流量。
- `app_api`：使用独立 `DATABASE_URL_API`，不拥有表、没有 `BYPASSRLS`，只承载普通 API 请求。
- `app_worker`：使用独立 `DATABASE_URL_WORKER`，从 Job 取得候选 Workspace，设置事务级上下文后验证 Task 归属，不默认跨租户访问。
- `app_maintenance`：使用独立 `DATABASE_URL_MAINTENANCE` 和 Secret，仅供 Reaper 发现、对账和受审计维护；若授予 `BYPASSRLS`，该凭据不得进入 API/Worker 进程。

API 和 Worker 启动时查询 `current_user`、`rolbypassrls` 和对象所有权；生产环境若发现应用角色拥有业务表或具有 `BYPASSRLS`，必须拒绝就绪。每个进程只创建与自身角色相符的连接池，不能在同一个通用 `DATABASE_URL` 上通过 `SET ROLE` 模拟隔离。

所有业务上下文使用 `current_setting('app.user_id', true)` 和 `current_setting('app.workspace_id', true)` 的 missing-ok 形式；缺失上下文返回 NULL 并默认拒绝，不能抛出 500。禁止在池化连接上使用会泄漏到后续请求的会话级变量。

事务入口分为三类：

- `withUserTransaction`：Identity 在事务外取得可信 `userId`，事务开始后只设置 `user_id`，用于 Workspace 列表、创建和邀请接受等尚无目标成员关系的流程。
- `withTenantTransaction`：设置可信 `user_id` 和路径中的 `workspace_id`，随后在同一事务内验证 Workspace/成员状态和角色，再完成全部业务查询与写入。
- `withWorkerTransaction`：使用 Job 中的候选 `workspaceId` 设置 Workspace 上下文，按 `taskId + workspace_id` 验证业务 Task 后才访问后代资源。Worker policy 按数据库角色与 Workspace 上下文授权，不伪造普通用户身份，也不能用载荷绕过数据库归属校验。

业务服务函数接收开放事务句柄，不接收连接池句柄，也不得在内部另开第二个事务。禁止保留“连接 A 查询成员，连接 B 执行业务 SQL”的两段式授权；当前 `requireWorkspaceMember()` 返回 access 后由 service 使用普通数据库句柄的实现必须在 Gate 0 重构为事务回调。

RLS 策略必须遵守以下非递归基线：

- `workspace_members` 的自查策略直接比较 `user_id = app.user_id`，不得在自身 policy 中再次查询 `workspace_members`。
- 管理员列成员、叶子表成员判断和邀请状态转换统一调用最小化的 `SECURITY DEFINER` helper。helper 由 `schema_owner` 拥有，只读授权表，固定安全 `search_path`、使用全限定表名、无动态 SQL、撤销 `PUBLIC EXECUTE`，并只向应用角色授予必要签名；授权表不 FORCE，因此 owner helper 可读取完整授权事实，应用角色自身仍受 RLS。
- Workspace 自创建只允许 `owner_user_id = app.user_id`；首个成员只能是同一用户的 `owner`。邀请接受只能把当前已验证邮箱对应用户加入邀请指定 Workspace，并以一次性条件更新认领邀请；这些流程必须有独立 policy/helper 和事务集成测试，不能借用普通成员 policy。
- `workspaces.status = active`、`workspaces.deleted_at IS NULL`、`workspace_members.status = active` 是资源访问的共同前置条件。

RLS 不是应用授权替代品。路由仍执行成员和角色检查；RLS 负责阻止遗漏租户条件、错误 join 或未来代码回归造成的跨租户访问。全局 Reaper 和对账仅通过 `app_maintenance` 扫描最小字段，再把具体任务交给 `app_worker` 在租户上下文中处理。面向人的平台管理员操作仍携带真实 `userId` 和目标 `workspaceId`，走 `app_api` 的显式平台管理员授权、RLS policy 和审计，不能借用维护凭据。

pg-boss 内部 schema 和 Identity 全局表不使用 Workspace RLS，只授予经真实集成测试证明所需的最小权限。Job 载荷仅含 `taskId`、`workspaceId` 与协议版本；Worker 先用载荷建立候选租户上下文，再从业务表验证归属。账本交易和分录即使包含系统侧账户，也继承当前交易的 `workspace_id`，全平台汇总只能通过维护/报表路径生成。

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
8. 通过 pg-boss 写入只包含 `taskId`、`workspaceId` 和协议版本的 Job。
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

`storing` 只适用于输出可以再次引用的情况，例如远程任务 ID 或仍有效且已持久化的临时 URL。同步 Base64 输出若在上传前丢失，不能伪装成可搬运状态；任务进入 `reconciling`，因为上游可能已经计费但输出不可恢复。

Worker 领取或 Reaper 接管任务时原子递增 `lease_epoch` 并取得新值。后续状态转换、heartbeat、结果写入和结算都必须在条件中携带领取时的 epoch；零行更新表示 Worker 已被 fencing，必须停止写入。租约纪元只能阻止被接管 Worker 继续写数据库，不能撤回已经发出的 Provider HTTP 调用；后者依赖 Provider 幂等键和 `reconciling` 处理。

Adapter 必须把失败分类为：

- `safe_retry`：可确认上游没有受理，可有限重试。
- `terminal`：确定失败，任务失败并释放积分。
- `ambiguous`：无法确认是否受理，进入 `reconciling`。
- `provider_processing`：已有远程任务 ID，进入查询。
- `success`：输出有效，进入存储和结算。

对可能已被上游受理的写操作 `submit`，500、502、连接中断和 timeout 一律归类为 `ambiguous`，不得重试；对 `poll` 等幂等只读操作可有限重试。Worker 在 `ambiguous` 分支必须正常结束当前 Job 而不是抛错，否则 pg-boss 的 Job 重试会再次执行提交。

### 7.3 结算

- 成功：捕获实际费用，释放剩余 Hold。
- 提交前确定失败：全额释放。
- 上游明确拒绝且未计费：全额释放。
- 结果不确定：保持 Hold，等待后台或人工对账。
- 管理员对账：释放或捕获都必须同时写入补偿分录和审计。

Hold 超过配置阈值仍无法终结时自动进入 `review` 并告警；第一阶段默认阈值为 24 小时，可按 Provider 调整。`review` 只能由受审计的 `confirm-charge` 或 `confirm-no-charge` 动作终结，结果不确定时不得自动释放。

状态更新采用带前置状态的条件更新和唯一操作键，确保重复 Worker 不能重复结算。

### 7.4 队列语义与未来迁移

第一阶段继续使用 pg-boss。任务、Billing Order、Hold、Attempt 和 pg-boss Job 必须通过 pg-boss 官方支持的外部事务连接，在同一个 PostgreSQL 事务内提交，因此不存在“业务已提交但消息尚未发布”的跨系统窗口。实现前必须用真实 PostgreSQL 集成测试证明：入队失败会回滚全部业务和账本记录，业务事务回滚不会留下 Job；普通 mock 不能作为原子性证据。

pg-boss 的队列元数据读取不属于上述业务事务。所有队列和 pg-boss schema 必须由 `schema_owner` release job 预先安装、迁移和 `createQueue`；API 与 Worker 一律以 `migrate: false` 启动，启动和 readiness 校验 schema 版本及必需队列，缺失或版本不匹配时拒绝服务。普通进程不得拥有 DDL 权限。

应用模块只依赖版本化的任务分发端口，不读取 pg-boss 内部表，也不把 pg-boss Job 当作业务任务记录。Job 载荷只包含 `taskId`、`workspaceId` 和协议版本；`workspaceId` 只用于建立 RLS 上下文，Worker 随后必须从 PostgreSQL 验证 Task 确实属于该 Workspace，不能信任 Job 载荷替代数据库事实。Worker 每次都重新读取业务状态并用前置状态、唯一操作键和 Provider 幂等键判断下一步。

任何队列都不得被描述成端到端 exactly-once。Worker 必须能处理重复领取、进程在外部副作用后崩溃、完成确认丢失和乱序重试。

只有当压测和生产指标证明 pg-boss 的队列扫描、表膨胀、数据库 I/O 或队列延迟持续违反 SLO，或者任务路由需要独立于 PostgreSQL 扩展时，才评估 RabbitMQ。迁移时采用 Transactional Outbox：业务事务写 Outbox，Relay 使用 Publisher Confirm 投递，消费者手动 ACK，并继续按至少一次交付设计。禁止在一个业务请求中直接双写 PostgreSQL 和 RabbitMQ。

## 8. API 契约

业务接口统一使用 `/api/v1`，Better Auth 使用 `/api/auth/*`。Session 使用 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie。每个请求生成 `requestId`。第一阶段只有 AI Task 创建和管理员积分调整接受 `Idempotency-Key`：前者由 `(workspace_id, key, request_hash)` 约束，后者由账本 `operation_key + request_hash` 约束；其他写接口不得宣称支持而实际忽略该请求头。

主要资源：

```text
/api/v1/workspaces
/api/v1/workspace-invitations/:invitationId/accept
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

`retryable: true` 只允许用于可确定未产生副作用，或由幂等键安全保护的错误。提交后响应丢失、上游受理状态不确定和非幂等写失败必须返回 `retryable: false`，客户端通过原幂等键查询/重放而不是新建请求。

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
- snapshot 文档模式使用独立原生 IndexedDB 数据库 `infinite-canvas-recovery`（version 1），至少包含 `drafts` 与 `markers` 两个 object store。普通缓存仍可使用 localforage，但恢复库不得是 localforage instance，也不得与 `infinite-canvas` 数据库共用版本、对象仓库或事务语义。
- 恢复层以 factory 接收 `IDBFactory` 并显式执行 open/migrate，不在模块导入时产生删除或升级副作用。`versionchange` 必须关闭旧连接，`blocked` 必须有有界错误和可操作提示。
- 以下动作必须在单个 `readwrite` 事务内完成 CAS：按 `epoch + writeSeq` 拒绝迟到草稿；同时写草稿和冲突 marker；仅在 marker 仍由调用方拥有时重写/删除 marker 与旧草稿；GC 删除前重新验证草稿仍过期且未被 marker 引用。任何删除都不能基于事务外的旧读取结果。
- 当前 `canvas_recovery` localforage store 不是新协议的合法数据源。项目未上线，Gate 0 以显式升级动作删除它，不写双读兼容；升级前的测试草稿如需保留，由用户先显式导出。
- API Key 不再保存在普通用户浏览器。
- 普通用户不再配置任意上游地址，只选择平台模型。
- 现有渠道页迁移为管理员模型和 Provider 路由管理。
- snapshot 模式以 Zustand 本地编辑、防抖保存 `snapshot + baseRevision`。当前 Session 状态机、Manager 令牌和 prepare/commit 边界可以保留；localforage 恢复实现以及为不可取消迟到写设计的 `settled/whenLocalSettled` 补偿路径必须由原生事务 CAS 取代。
- collaborative 模式必须使用独立文档引擎实例，不能直接复用 snapshot Session 的保存协议；Manager/store/页面的边界可以保留。
- collaborative 模式未来由 Y.Doc 成为共享文档权威，Zustand 只保留 UI 投影；两种模式通过显式文档引擎边界接入页面，不在组件中混合判断。
- 平移缩放属于每用户本地 UI 偏好，不触发全量云端快照保存；只有显式设置的共享默认视图进入文档。Gate 2 必须压测完整快照大小、保存节奏、JSONB/TOAST 增长与 autovacuum，不能只验证 revision 正确性。
- 当前快照中的浏览器本地 `storageKey` 不能作为云端 Asset 引用。Gate 2 在 Asset 切换时将可上传媒体显式转换为 Asset ID；不自动迁移的旧测试数据必须显示“资源仅存在于原设备/不可用”的受控状态，不能返回破图或把本地键冒充服务端对象键。
- 旧 IndexedDB 画布不自动上传；需要时后续提供显式导入动作。

## 12. 安全

- 浏览器和 API 同源部署，消除平台调用 CORS 问题。
- Provider Base URL 只能由管理员从允许配置注册。
- 拒绝 loopback、私网、link-local 和云元数据地址，防止 SSRF。
- Provider 主机名必须在连接前解析并校验最终 IP，重定向目标逐跳复验或直接禁止重定向；只在配置时检查主机名不足以防止 DNS rebinding。
- 限制请求体、文件大小、超时和并发。
- 日志脱敏 Cookie、Authorization、API Key 和 URL 敏感参数。
- 用户和 Workspace 分别限流，并在数据库内执行严格任务并发检查。
- 普通租户查询同时执行应用层 Workspace 授权和 PostgreSQL RLS；任何维护型绕过都使用独立角色并写入审计。
- Provider Key 仅存在服务端 Secret。
- 注册赠送在邮箱验证和基础反滥用检查后发放。

## 13. 部署与高可用

高可用是由 SLO、故障域、备份和恢复演练共同验证的运行属性，不由组件数量或 Kubernetes 架构图自动保证。部署分为三个等级，应用协议和模块边界在等级之间保持不变。

### 13.1 初始生产基线

- API 与 Worker 独立部署、独立伸缩和独立停止领取；进程保持无状态。
- 优先采用带自动备份和 PITR 的托管 PostgreSQL，以及带版本控制和生命周期策略的托管 S3 兼容对象存储。
- 数据库迁移由单独 release job 执行，应用实例不在启动时竞争迁移。
- pg-boss schema、迁移和队列创建同样由 release job 执行；API/Worker 只校验版本和队列，不自行迁移。
- Gate 5 进入前根据业务可承受的数据损失和停机时间定义数值化 RPO、RTO 与可用性目标；退出 Gate 5 前必须记录恢复演练实测值并证明达到目标，不能以“待确定”关闭门禁。
- API 停机时先退出 readiness、停止新请求、等待短请求、关闭 SSE 和连接池。Worker 停机时停止领取任务、保留 heartbeat 和租约，不把执行中任务直接标记失败或退款。
- 队列按 `ai-image`、`ai-video`、`ai-audio`、`provider-poll`、`reconciliation` 和 `maintenance` 隔离，并设置平台、路由和 Workspace 三层并发限制。

单机 Docker Compose 可用于开发、测试和受控内测，但不得被表述为高可用部署。

仓库现有 `render.yaml`、`vercel.json` 和 `docker-compose.yml` 只描述旧的静态前端/单容器路径，不能部署本架构的 API + Worker + release job。Gate 5 前必须替换并验证这些部署制品；Docker 静态资源路径仍是已知待办，不能据此宣称生产部署完成。

### 13.2 增长阶段

当容量测试和生产 SLO 需要时，API、Worker 分别增加副本，PostgreSQL 使用同区域高可用，负载均衡执行健康检查，备份进入独立故障域。协作服务上线且需要多实例时才增加 Redis。每次扩容都必须测试滚动升级、连接耗尽、任务重复领取、数据库切换和重连风暴。

### 13.3 自托管高可用阶段

只有在团队具备持续值守、升级、备份、恢复和容量管理能力，并且托管服务无法满足成本、合规或部署要求时，才采用高可用 Kubernetes、CloudNativePG、RabbitMQ Quorum Queue、Redis HA 和分布式 MinIO。

- CloudNativePG 必须明确同步复制、可用性和数据持久性之间的取舍，并验证主库切换后的 RPO/RTO。
- RabbitMQ 必须使用 Publisher Confirm、消费者手动 ACK、幂等消费者和 Outbox；Quorum Queue 不改变至少一次交付语义。
- Redis Sentinel 与 Redis Cluster 解决的问题不同，必须基于复制故障转移或分片需求选择，不能写成可互换选项。
- 分布式 MinIO 必须拥有真实独立驱动器和故障域，验证纠删码读写 quorum、节点损坏和恢复；在同一磁盘上启动多个实例不构成高可用。
- Kubernetes 控制面、工作节点、入口、存储和 DNS 都要覆盖故障演练，不能只验证 Pod 自动重启。

## 14. 故障恢复

| 故障 | 行为 |
|---|---|
| API 在事务提交前崩溃 | 无任务、无扣分，客户端重试 |
| API 提交后响应前崩溃 | 幂等键返回原任务 |
| Worker 调用 Provider 前崩溃 | pg-boss 重新执行 |
| Provider 明确未受理 | 安全重试或失败释放 |
| Provider 可能受理但响应丢失 | 进入 `reconciling`，禁止盲目重试 |
| 已取得远程任务 ID 后崩溃 | 恢复查询远程任务 |
| Provider 成功、输出可再次引用但对象存储失败 | 从 `storing` 继续搬运 |
| 同步 Base64 输出在上传前因进程崩溃丢失 | 进入 `reconciling`，不得重新生成或假装可搬运 |
| 结算事务失败 | 保持 Hold，有限重试；超阈值进入人工 `review` |
| SSE 断开 | 使用 `Last-Event-ID` 补发 |
| PostgreSQL 故障 | 停止新任务和领取，恢复后继续 |
| Worker 重复执行 | 唯一约束、条件更新和 `lease_epoch` 阻止旧 Worker 写入或重复结算；已发出的上游调用仍由幂等键/对账处理 |

Worker 使用租约、heartbeat 和 fencing epoch。Reaper 检查过期任务并通过条件更新递增 epoch：`queued` 可安全重新领取；没有远程 ID 的过期 `submitting` 进入 `reconciling`，不能直接再次 submit；有远程 ID 的 `processing` 继续查询。

## 15. 可观测性

结构化日志关联 `requestId`、`userId`、`workspaceId`、`taskId`、`attemptId` 和 `providerRouteId`。默认不记录提示词、Cookie、密钥和完整上游响应。

API、数据库事务、队列等待、Worker Attempt、Provider HTTP、对象存储和结算使用 OpenTelemetry 兼容的 trace/span 上下文；第一阶段可以只启用轻量 exporter，但上下文传播字段和敏感数据规则从第一版保持稳定。Prometheus、Grafana、Loki、Tempo 是可替换的运行部署选择，不进入领域模块接口。

核心指标包括：

- API 请求量、错误率、延迟、事件循环延迟、内存、CPU 和数据库连接池。
- 队列深度、最长等待、各状态停留时间、任务成功率和端到端耗时。
- Provider 路由成功率、429、5xx、timeout、生成耗时和查询失败率。
- 未关闭 Hold、Hold 年龄、进入 `review` 的 Hold、账本平衡、未结算成功任务和未释放失败任务。
- SSE 连接和断线重放数量。
- 协作模式上线后增加令牌续期失败率、撤权收敛时长、单文档连接数、fan-out p95/p99、Redis 重收敛和重连风暴指标。

账本不平衡、负余额、`reconciling` 持续增长、队列积压、Provider 连续失败、连接池耗尽和 Asset/对象不一致必须告警。

## 16. 测试策略

单元测试覆盖模型能力、价格、状态转换、Hold/结算/释放、错误分类和响应解析。

真实 PostgreSQL 集成测试覆盖并发防透支、幂等 Hold、延迟约束下的账本平衡、租约接管与 fencing、重复 Worker 结算、管理员调整与审计原子性、任务与 pg-boss 原子入队以及 Canvas revision 冲突。已有 Canvas 同 baseRevision 并发保存测试可作为 revision 证据，但不能替代新增 RLS、队列和账本测试。

租户隔离测试由 schema owner 只负责建库/迁移，实际请求使用生产等价的 `app_api` 和 `app_worker` 登录角色。测试自身断言 `current_user`、非 owner、非 `BYPASSRLS`，并证明缺少上下文、缺少显式 Workspace 条件、错误 join、伪造路径 Workspace、跨租户子资源 ID、邀请接受和池连接复用均默认拒绝。测试不得以 schema owner 或超级用户运行后宣称 RLS 生效。

身份边界测试证明 Identity 适配器替换不会改变 Workspace 成员、角色、邀请、钱包或 Canvas 数据；Workspaces 模块测试不得依赖 Better Auth Organization API。

每个 Adapter 使用固定 HTTP Fixture 覆盖正常 JSON、Base64、临时 URL、远程任务 ID、HTML 502、空响应、错误 JSON、重复字段、超时、连接中断、无媒体成功响应、画幅/分辨率映射和视频重复时长字段。每个真实上游故障都要沉淀为回归 Fixture。

故障注入覆盖事务后崩溃、Provider 接受后崩溃、S3 中断、结算断连、重复领取和 SSE 重连。

Gate 0 先为 `web/` 建立范围受限的 Vitest + fake-indexeddb 测试入口，不引入 DOM/React 测试框架。snapshot 文档模式先让当前非原子实现下的关键测试失败，再用原生 IndexedDB 事务/CAS使其通过；至少覆盖双连接同键 CAS、`epoch/writeSeq` 乱序拒绝、事务 abort 全量回滚、草稿 + marker 原子写、所有权条件删除和 GC 不删除外部活动草稿。

fake-indexeddb 只能证明单进程 API 语义。Chrome、Firefox、Safari 的独立测试页必须覆盖双标签 `versionchange/blocked`、异常关闭、刷新后耐久性、跨标签竞争、隐私模式/配额失败和后台节流；不得关闭用户已打开页面。未来 collaborative 模式单独验证 Yjs 合并、检查点 + 后续更新恢复、离线重连、投影重建、Awareness 不落库、60 秒撤权边界、Redis 重收敛、多实例广播、文档分片和重连风暴；两种模式的测试不得互相替代。

Canvas 保存容量测试按“并发编辑者 × 快照大小 × 保存节奏”测量请求延迟、数据库/TOAST 写放大、表膨胀和 autovacuum。纯平移缩放不得出现在网络保存样本中。

自动 E2E 覆盖注册验证、注册积分、创建画布、选择模型、生成图片、素材入库和积分流水。真实 Provider 冒烟测试使用低额度专用密钥人工触发，不进入普通 CI。

## 17. 交付门禁

交付按可验证能力推进，不按自然日推进。后续实现计划必须重新编排；现有按天计划在完成修订前只能作为历史任务清单，不能继续作为架构依据。

### Gate 0：架构纠正

- 按依赖顺序先建立 `schema_owner/app_api/app_worker/app_maintenance` 凭据与测试连接，再移除 Better Auth Organization 写路径、重命名 Workspace 列、修正级联删除/角色/状态约束，最后启用事务上下文和 RLS；不得并行打开 RLS 后再补连接架构。
- `withUserTransaction/withTenantTransaction`、非递归 policy helper、启动角色断言和生产等价跨租户测试形成可执行规范；业务服务只能使用同一开放事务。
- `document_mode` 立即落库为只读 `snapshot`，同步保存协议不得修改模式。
- snapshot 原生 IndexedDB CAS 子规范通过固定提交的独立审查；`web/` 测试入口和关键并发测试先红后绿，真实三浏览器矩阵已定义。
- 新实施计划明确保留 Session/Manager/prepare-commit，重写 localforage 恢复层并删除迟到写补偿路径；不得用临时兼容分支掩盖差异。

### Gate 1：身份与 Workspace

用户可以注册、验证、登录并获得个人 Workspace；可以创建团队 Workspace、邀请成员和切换空间。应用授权和 RLS 都不能信任客户端提供的成员关系。

### Gate 2：云端 Canvas 与 Asset

成员可以创建、保存、重开和冲突恢复 snapshot Canvas，并通过预签名 URL 上传和读取私有 Asset。浏览器本地恢复失败不能覆盖云端权威状态；多标签共享草稿发生冲突时必须显式展示，载入服务端版本会删除同一画布的共享本地冲突草稿。Asset ID 转换、不可解析本地 `storageKey` 状态和 Canvas 保存写放大测试全部通过后才关闭 Gate 2。

### Gate 3：积分账本

注册赠送和管理员调整产生平衡、不可变、可审计的账本分录；并发 Hold 不能透支；重复调用不能重复增减积分。

### Gate 4：AI 任务闭环

至少一个图片 Provider 完成 Task、Hold、Attempt、pg-boss Job 的原子创建，输出存为 Asset，积分只结算一次，SSE 可以断线重放，模糊上游结果进入对账而不盲目重试。

### Gate 5：生产验收

完成 Secret、迁移、备份、恢复演练、告警、限流、真实低额度 Provider 冒烟和人工验收。必须记录数值化 RPO/RTO/可用性目标与演练实测值，不能以“待确定”关闭；任何容量或高可用声明都必须附带对应测试证据。

## 18. 第一阶段切线

必须完成：Gate 0 至 Gate 5 中的登录、个人 Workspace、基础团队 Workspace、云端 Canvas、对象存储、Workspace 积分钱包、管理员调整、一个图片 Provider、幂等、恢复和 SSE。

可以在不影响门禁的前提下追加：一个视频 Provider、邀请邮件自动发送/重发界面和简单 Provider 路由管理界面；邀请事务和接受流程本身属于 Gate 1，不能延后。

明确延后：支付、Yjs/Hocuspocus 实时协作、Keycloak、RabbitMQ、Redis、Kubernetes、任意第三方插件、自动跨 Provider 故障转移、复杂 RBAC 和移动端专项适配。

范围不足时先删除视频、次要管理界面和非核心 Provider，不能削弱租户隔离、账本平衡、幂等、对账、恢复或测试门禁。

## 19. 长期演进触发器

核心 Workspace、授权、账本和任务元数据保持在 Fastify/PostgreSQL 模块化单体中，除非独立压测证明它们成为无法通过普通水平或垂直扩容解决的瓶颈。

- **Keycloak**：只有出现企业 SSO、统一身份生命周期、身份联邦、集中 MFA 或独立 IAM 运维要求时评估；用户数量本身不是切换理由。
- **Yjs/Hocuspocus**：只有多人同时编辑成为确认的产品需求时实施；先完成文档语义、权限、二进制持久化、离线合并和导出协议设计。
- **Redis**：只有协作服务需要多实例传播、Presence 或经测量确有缓存需求时引入；单实例协作服务不提前依赖 Redis。协作上线门禁必须先记录单实例最大稳定连接数、每文档 fan-out p95/p99、内存/文档和重连风暴的数值结果；超过当期 SLO 后才分片或加 Redis，不能用未经测量的固定人数替代。
- **RabbitMQ**：只有 pg-boss 对 PostgreSQL I/O、表维护、任务路由或队列 SLO 形成已测量瓶颈时引入，并通过 Outbox 迁移。
- **Kubernetes 与自托管 HA 数据层**：只有服务数量、独立伸缩、滚动发布、合规或成本证明其收益，并且团队能够承担持续运维时引入。
- **Python Media/ML Worker**：出现 Diffusers、复杂 OpenCV、本地推理或媒体分析时，通过版本化任务协议接收 Asset ID 和参数，不重写核心 API。
- **Go 实时网关**：先对 TypeScript 协作服务进行生产等价压测；只有 Go 原型在相同 SLO、故障恢复和可观测性标准下显著改善资源成本时拆出。Go 不能掌管积分、任务、成员或 Canvas 元数据权威状态。

## 20. 参考资料

- [Fastify Plugins](https://fastify.dev/docs/latest/Reference/Plugins/)
- [Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)
- [Node.js event loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [pg-boss](https://github.com/timgit/pg-boss)
- [RabbitMQ reliability guide](https://www.rabbitmq.com/docs/reliability)
- [RabbitMQ consumer acknowledgements and publisher confirms](https://www.rabbitmq.com/docs/confirms)
- [Yjs Awareness](https://docs.yjs.dev/api/about-awareness)
- [Hocuspocus persistence](https://tiptap.dev/docs/hocuspocus/guides/persistence)
- [Hocuspocus Redis extension](https://tiptap.dev/docs/hocuspocus/server/extensions/redis)
- [Keycloak production configuration](https://www.keycloak.org/server/configuration-production)
- [Keycloak high availability overview](https://www.keycloak.org/high-availability/introduction)
- [CloudNativePG automated failover](https://cloudnative-pg.io/documentation/current/failover/)
- [MinIO erasure coding](https://min.io/docs/minio/linux/operations/concepts/erasure-coding.html)
- [Kubernetes production environment](https://kubernetes.io/docs/setup/production-environment/)
