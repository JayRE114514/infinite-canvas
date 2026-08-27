# Infinite Canvas 后端平台架构设计

状态：第四轮差异审查问题已修订，待最终收敛复审与用户复核；本文件通过前不授权继续实施

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

邮箱验证完成后才创建注册赠送交易。重复回调（包括并发回调）必须先锁定当前用户行并解析其唯一个人 Workspace，再在同一事务内完成或返回既有 provisioning；注册赠送幂等由“每用户唯一个人 Workspace + Workspace 内唯一 `signup-grant:<userId>` 操作键 + 相同 `request_hash`”共同保证，缺少任一条件都不得发放。

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

用户邮箱验证成功后，在同一业务流程中解析或创建其唯一个人 Workspace，并可加入多个团队 Workspace；列表接口不得以 GET 副作用反复补建。允许幂等的后台修复任务处理历史缺失，但必须走专用审计路径。所有资源接口在路径中显式携带 `workspaceId`，后端每次验证成员关系。第一版角色为 `owner`、`admin`、`member`。

Workspace 模块拥有成员与邀请的全部不变量。未来替换身份提供商时，只替换 Identity 适配器和登录流程，不迁移 Workspace、积分、画布、素材或任务关系。

### 5.3 Canvases

第一阶段明确为 `snapshot` 文档模式：保存完整 JSONB 快照和递增 `revision`。客户端提交 `baseRevision`，服务端在同一事务中锁定 Canvas 行、验证版本再条件更新，防止静默覆盖；冲突返回 `409 revision_conflict`。原生 IndexedDB 事务/CAS 只负责该模式下的浏览器未同步草稿恢复，不是云端权威，也不是未来 Yjs 的持久化引擎。`document_mode` 在 Gate 0 立即落库并进入只读响应契约，避免协作上线时对已有画布补做无约束模式迁移。

`canvases.document_mode` 明确区分 `snapshot | collaborative`，第一阶段只创建 `snapshot`。普通保存不得改变模式且 SQL 必须显式要求 `document_mode = 'snapshot'`；模式不匹配返回稳定的 `409 canvas_document_mode_mismatch`。不存在、跨租户不可见或已软删除统一返回 `404 canvas_not_found`，避免泄露资源存在性；错误判定顺序固定为可见性/删除态、模式、revision。未来模式转换必须通过独立、可恢复的流程完成。snapshot 模式以版本化 `snapshot_json + revision` 为唯一文档权威；collaborative 模式以 Yjs 二进制更新流为唯一权威，JSON 只能是导出或搜索投影，不能形成双写权威。

云端 snapshot 只包含共享文档字段和显式 `defaultViewport`。每用户实时 `viewport` 是独立 UI 投影：可在普通本地偏好或恢复 envelope 中持久化，但绝不进入云端文档序列化。文档 dirty sequence 与 UI dirty sequence 分离；平移后再编辑节点也不能把实时 viewport 夹带进云端快照。

未来多人协同使用独立 `collaborative` 文档模式，不在现有 `snapshot_json` 上追加全量覆盖协议。两种模式共享 Canvas 稳定资源 ID、Workspace 授权、Asset ID 和导出契约，但拥有不同的同步与离线持久化实现。

未来转换必须以 Canvas 行锁和期望 revision 作为 fencing：在事务外可预计算候选 Yjs baseline，事务内重新锁定并验证 snapshot revision，随后在同一 PostgreSQL 事务中写入可恢复的初始检查点并把模式切为 `collaborative`。任一步失败都保持 snapshot 模式；协作读写端点只接受 collaborative，snapshot 保存只接受 snapshot，不存在自动 fallback 或对外可见的半转换状态。

### 5.4 Assets

数据库只保存对象键、MIME、字节数、宽高、时长、状态和归属。媒体使用服务端生成的不可变对象键；浏览器通过短期预签名 URL 直传。生命周期为 `staging -> ready | failed -> deleted`。

### 5.5 Billing

使用 Workspace 钱包、不可变双向账本、每订单独立 Hold 和余额投影。积分使用 `BIGINT` 最小单位，不使用浮点数。注册赠送、管理员调整、Hold、结算、释放和审计必须在单个数据库事务中完成。

### 5.6 AI Tasks

AI Tasks 负责模型参数验证、价格快照、积分预占、原子入队、状态机、结果汇总和结算，不负责具体平台 JSON 转换。

### 5.7 Providers

Provider Adapter 将统一平台输入转换成特定平台请求，并解析同步、异步、URL、Base64 和错误响应。Adapter 静态编译并注册，数据库只保存不可执行的路由和模型配置。

### 5.8 Admin

MVP 提供用户和 Workspace 查询、钱包查看、积分调整、冻结、任务查询、人工对账和 Provider 路由启停。首版 admin purpose 固定为平台目标的 `user_read | model_read | model_write | provider_route_read | provider_route_write`，以及 Workspace 目标的 `workspace_read | workspace_suspend | workspace_deactivate | workspace_restore | wallet_adjust | wallet_status_write | billing_confirm_charge | billing_confirm_no_charge | ledger_compensate | workspace_export`；新增 purpose 必须经过迁移、动作矩阵和授权测试，不能接受自由字符串。所有管理动作写入不可变审计日志。

### 5.9 Collaboration（预留边界，第一阶段不实现）

协作服务是独立运行时，不与 Business API 共用 WebSocket 生命周期。Business API 仍拥有用户、Workspace、Canvas 元数据、权限、积分和 Asset；协作服务只拥有指定 Canvas 文档的实时 CRDT 会话。

- `Y.Map<nodes>` 以节点 ID 为键，`Y.Map<connections>` 以连线 ID 为键，设置使用独立 `Y.Map`，需要协同编辑的长文本使用 `Y.Text`。
- 图片、视频和音频只在文档中保存 Asset ID，不保存媒体字节或上游临时 URL。
- 光标、当前选择框、在线状态和每个用户的实时视口使用 Awareness，只传播、不持久化。共享默认视图是文档设置，只能由显式“设为默认视图”操作更新；普通平移缩放不得写云端快照或消耗 revision。
- PostgreSQL 的协作权威采用一条逻辑 Yjs 更新流：可直接加载的二进制检查点记录 `through_sequence`，恢复时加载最新检查点和其后的增量更新。每个更新必须先持久化并分配文档内 sequence，提交后才能向客户端发 durable ack 或向其他实例发布。检查点只是更新流的压缩结果，不是第二权威；JSON 搜索/导出投影保存在独立投影表，携带 `source_sequence + projection_schema_version` 并以单调条件更新，可从 Yjs 权威重建，永远不能反向覆盖文档。搜索允许按 SLO 最终一致；导出必须等待/重建到最新已提交 sequence。压缩锁、保留、崩溃恢复和并发写入仍须在协作子系统规范中通过故障测试后实施。
- Hocuspocus 通过短期协作令牌鉴权，令牌包含 `userId`、`workspaceId`、`canvasId`、权限和到期时间；协作服务不得自行维护另一套成员关系。
- 成员移除和角色降低必须在有界时间内终止或降级已存在连接，不能只在首次握手鉴权。正确性基线为不超过 60 秒的短令牌：协作运行时在每条连接上记录到期时间和权限，到期时若没有通过 in-band reauth 或受控重连成功获得新令牌，就关闭连接或禁用写入。Business API 每次签发都重新检查当前成员/角色；主动断连事件只能作为缩短窗口的优化。边界从成员变更事务提交算到首个越权更新被拒绝，并计入允许时钟偏差。
- Redis 只在协作服务需要多个实例时引入，用于实例间加速传播，不作为持久化层。Presence 由活动连接重建，Redis 中的副本只能是带 TTL 的缓存；Redis 重启后应在一个心跳周期内重新收敛，不能要求会话整体重连。文档更新以 PostgreSQL sequence 为恢复依据：实例记录每文档 `last_applied_sequence`，只在提交后发布，发现 gap、重连、进房或进程重启时先从 PostgreSQL 回放缺口再声明房间健康。Redis 故障时只要 PostgreSQL 可提交即可继续接收更新并标记跨实例 fan-out degraded，恢复后补齐 gap；无法保证此规则时必须 fail closed，不能形成静默分叉。
- Zustand 在协作模式中只保存本机 UI 投影和私有状态，不再是共享文档的权威来源。

## 6. 核心数据模型

### 6.1 身份和 Workspace

`workspaces`：`id`、`name`、`slug`、`type`、`owner_user_id`、`status`、`created_at`、`updated_at`、`deleted_at`。`owner_user_id` 对 `users` 使用 `RESTRICT/NO ACTION`，禁止身份删除级联删除 Workspace。`status` 固定为 `active | suspended | deactivated`；只有 `deactivated` 允许且必须带 `deleted_at`，其余状态必须为空。数据库使用 `(owner_user_id) WHERE type = 'personal'` 部分唯一索引保证一个用户终身至多一个个人 Workspace（包括已停用记录），停用后只能恢复原 Workspace，不能新建替代项；Gate 0 重命名现有列时必须保留并重新验证该索引。

`workspace_members`：`workspace_id`、`user_id`、`role`、`status`、`joined_at`，唯一约束为 `(workspace_id, user_id)`；`role` 受 `owner | admin | member` CHECK/枚举约束。部分唯一索引保证最多一个 `owner`，延迟约束触发器保证 active Workspace 提交时恰有一个 status=active 的 owner，且 `workspaces.owner_user_id` 必须等于该成员的 `user_id`。部分唯一索引不可延迟，因此团队所有者转移必须在同一事务中先把原 owner 降为 `admin`，再把目标成员提升为 `owner` 并更新 `owner_user_id`；提交时由延迟触发器验证最终状态。个人 Workspace 不允许转移所有者。

个人 Workspace 禁止邀请其他成员。Workspace 状态转换全部使用“期望起始状态”的条件更新并写审计：owner 可在 active 状态经 `withTenantTransaction` 自助执行 active→deactivated；该流程先插入审计，再把状态更新作为最后一条租户业务语句，两者任一失败都整体回滚，避免更新后普通成员 policy 无法写审计。平台管理员可用 `workspace_suspend` 执行 active→suspended、用 `workspace_deactivate` 执行 active/suspended→deactivated、用 `workspace_restore` 执行 suspended/deactivated→active。进入 deactivated 同事务写 `deleted_at`，恢复同事务清空；恢复前必须重新满足 active Workspace 的 owner/成员不变量。停用不物理删除账本、任务、Attempt、Asset 元数据或审计，普通业务外键不得对 Workspace 使用级联删除；已受理任务继续由 Worker 完成或对账，但停用后不得接收新任务。

`workspace_invitations` 由 Workspaces 模块拥有，保存 Workspace、目标邮箱、角色、邀请者、状态、到期时间和一次性令牌摘要。身份模块只提供当前用户和已验证邮箱，不处理成员状态转换。

`platform_admins` 是无租户 RLS 的全局授权表，只保存平台管理员用户与状态；`admin_operations` 也是不套 Workspace RLS 的全局不可变控制表，保存 operation ID、行为人、`target_kind = platform | workspace`、可空目标 Workspace、固定枚举动作、`transaction_xid`、`request_id` 和时间。应用角色对两表均无直接 `SELECT/INSERT/UPDATE/DELETE`；`admin_operations` 只能由 `begin_admin_operation` 插入，不能更新或删除。平台目标动作的脱敏前后值另写入 append-only `global_audit_logs`，Workspace 目标写入带租户键的审计表，两者都关联 operation ID。普通管理员操作必须先取得与当前数据库事务和目标类型绑定的 operation ID，不能把“平台管理员”伪装成任意 Workspace 成员。

### 6.2 画布和素材

`canvases`：`id`、`workspace_id`、`title`、`document_mode`、`snapshot_json`、`revision`、创建/更新用户和时间、`deleted_at`。`document_mode` 使用 `snapshot | collaborative` CHECK/枚举且默认 `snapshot`，第一阶段请求不得修改；`snapshot_json` 在 collaborative 模式中不得作为文档权威。`revision` 在数据库使用 `BIGINT`，但传输与 TypeScript 明确限制在 `Number.MAX_SAFE_INTEGER`，这是版本号的特例，绝不能套用到积分金额。

保存事务先按 `id + workspace_id` 执行授权范围内的 `SELECT revision, document_mode, deleted_at ... FOR UPDATE`，依次映射 `canvas_not_found`、`canvas_document_mode_mismatch` 和 `revision_conflict`；通过后验证文档 Schema 与 Asset 引用，并执行：

```sql
UPDATE canvases
SET snapshot_json = ?, revision = revision + 1
WHERE id = ? AND workspace_id = ? AND revision = ?
  AND document_mode = 'snapshot'
  AND deleted_at IS NULL
RETURNING revision;
```

行锁保证同一 Canvas 的并发保存按 revision 串行判定；已通过锁定校验后 UPDATE 若仍返回零行，属于服务端不变量失败，必须回滚并告警，不能猜测成用户冲突。同一事务随后重建 `canvas_asset_refs` 并提交，不能让文档与引用清单分开成功。

`assets`：`id`、`workspace_id`、可空 `canvas_id`、`kind`、可空 `content_text`、可空 `object_key`、媒体元数据、`status`、`source`、创建用户和时间。文本素材直接保存文本；图片、视频、音频和文件只在数据库保存对象键与元数据。

Canvas 文档使用版本化 `CanvasDocumentV1`，根对象必须包含字面量字段 `schemaVersion: 1`；未知版本默认拒绝读写，不得按 V1 猜测解析。所有内置节点和受控插件的媒体槽统一保存结构化 `assetId`，禁止 `storageKey`、`blob:`、Base64、上游 URL 或隐藏在任意 metadata 中的私有媒体引用。服务端按文档 Schema 提取引用，并在同一保存事务内维护 `canvas_asset_refs(workspace_id, canvas_id, asset_id)`；复合外键与状态校验证明所有 Asset 属于同一 Workspace。开放形状的插件若不能通过平台定义的媒体 envelope 提取 Asset ID，就不能持久化媒体引用。

Asset 切换顺序固定为：先幂等创建 `staging` Asset 并取得稳定 Asset ID，再把本地 `storageKey -> assetId + uploadState` 仅保存在恢复 envelope，随后 Canvas 可以引用 `staging | ready` Asset；其他客户端对 `staging` 显示上传中，对 `failed` 显示受控不可用。上传完成以幂等动作把 Asset 置为 `ready`，不增加 Canvas revision。Canvas 保存冲突或上传成功但未被引用时，后台只清理由 `canvas_asset_refs` 证明无引用且超过保留期的对象；重载后可继续上传或以新 Asset 替换失败引用。

### 6.3 钱包和账本

`wallets` 是快速余额投影：`workspace_id` 唯一，包含 `status`、`available_amount` 和 `held_amount`，可用和冻结金额都不得小于零。并发控制统一使用事务内 `SELECT ... FOR UPDATE`，不混用未定义的乐观 `version` 协议。投影必须满足：`available_amount` 等于该 Workspace 全部 `workspace_available` 分录之和，`held_amount` 等于全部 `workspace_held` 分录之和；`app_maintenance` 周期对账，任何偏差立即告警且只能通过补偿交易修正。

`ledger_transactions` 表示一次完整财务动作，包含 Workspace 内唯一 `operation_key`、不可空 `request_hash`、类型、行为人和业务引用。同一操作键与相同请求哈希返回重新读取的原交易及当前钱包投影；同一键但哈希不同返回 `409 idempotency_conflict`，不得把唯一冲突暴露为数据库错误。

`ledger_postings` 保存交易分录。每个交易的全部分录必须满足 `SUM(amount) = 0`，该多行不变量由 `DEFERRABLE INITIALLY DEFERRED` 约束触发器在提交时校验：交易和分录两侧都触发验证，分别覆盖“没有分录”和“分录不平衡”。服务层必须在提交边界映射约束错误；不能伪装成单行 CHECK。分录通过 `(workspace_id, transaction_id)` 复合外键继承交易租户键，使校验触发器在当前 Workspace policy 下能看到该交易全部分录；任何缩小分录可见范围的 policy 变更都必须重新验证余额不变量。

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

两表都是全局配置而非 Workspace 数据，但不能只依赖路由层保护写入：它们启用并 FORCE RLS，策略按角色和命令拆分。普通 `app_api` 只有 Model 公开列的列级 SELECT，且只能看到 enabled 行；`app_worker` 只有执行所需 Model/Route 列的 SELECT；应用角色没有普通 DML 权限。平台管理员读取 disabled Model 或 Route 必须分别走 `model_read | provider_route_read` 的平台目标 operation 和独立 `TO app_api` SELECT policy，且只授予管理界面所需列；Route 响应只暴露 `credential_configured` 等状态，不授予 `secret_ref` 或真实 Secret 的 SELECT。修改必须走 `model_write | provider_route_write` 的平台目标 operation，由独立 DML policy 调用 admin helper 授权并写全局审计；Workspace 目标 operation 不能读取或修改平台配置。

### 6.6 AI Task 和 Attempt

`ai_tasks` 保存 Workspace、创建用户、能力、模型、标准化输入、状态、幂等键、请求哈希、结果、公开错误、`lease_epoch`、`lease_expires_at` 和当前 Worker。唯一约束为 `(workspace_id, idempotency_key)`。

同一幂等键和相同请求返回原任务；同一键但请求哈希不同返回 `409 idempotency_conflict`。

`provider_attempts` 保存尝试编号、路由、Adapter、上游模型、Provider 幂等键、远程任务 ID、状态、失败分类、脱敏请求快照、响应元数据和 heartbeat。唯一约束包括 `(task_id, attempt_number)` 和 `(adapter_key, provider_idempotency_key)`。

`task_events` 保存任务内递增 sequence、事件类型、载荷和时间，唯一约束为 `(task_id, sequence)`，用于 SSE 断线重放。

### 6.7 租户键、数据库角色与 PostgreSQL RLS

`workspaces` 是租户根表，以自身 `id` 表示租户；所有可由租户请求直接访问的后代业务表必须包含不可空 `workspace_id`。子表若同时保存父资源 ID 和 `workspace_id`，必须使用复合外键或数据库约束保证两者属于同一 Workspace，不能只依赖应用代码保持一致。

身份全局表（用户、Session、账号、验证）不套用 Workspace RLS。租户根与授权表（`workspaces`、`workspace_members`、`workspace_invitations`）启用 RLS，但不启用 FORCE，以便受严格限制的 policy helper 读取授权事实；Canvas、Asset、Wallet、Ledger、Billing、AI Task、Attempt、Task Event 和审计等叶子业务表同时使用 `ENABLE ROW LEVEL SECURITY` 与 `FORCE ROW LEVEL SECURITY`。所有策略默认拒绝，按命令分别定义 `USING` 与 `WITH CHECK`，并必须显式限定 `TO app_api`、`TO app_worker` 或下文规定的只读 `TO app_maintenance`。普通 `app_api` 租户策略始终包含活动成员判断，不得因 PostgreSQL 将 permissive policy 以 OR 合并而继承仅依赖 Workspace 上下文的 Worker 或 Maintenance 宽松分支。

数据库凭据按进程分离：

- `schema_owner`：只供 release job 执行迁移并拥有对象，不承载应用流量，且明确没有 `BYPASSRLS`。
- `app_api`：使用独立 `DATABASE_URL_API`，不拥有表、没有 `BYPASSRLS`，只承载普通 API 请求。
- `app_worker`：使用独立 `DATABASE_URL_WORKER`，从 Job 取得候选 Workspace，设置事务级上下文后验证 Task 归属，不默认跨租户访问。
- `app_maintenance`：使用独立 `DATABASE_URL_MAINTENANCE` 和 Secret，仅供 Reaper 候选发现和对账扫描；不拥有表、没有 `BYPASSRLS`，对租户表只获得逐表枚举的列级 `SELECT` 与只读 `TO app_maintenance` policy，不得直接 INSERT/UPDATE/DELETE。首版清单仅含 Workspace 的 ID/状态，Task/Attempt/Hold 的租户键、ID、状态、租约/远程 ID 与时间，Wallet/Ledger 的租户键、账户类型与金额，以及 Asset 的租户键、ID、对象键、状态与时间；明确不含提示词、生成结果、用户资料或 Secret。它只把候选 `workspaceId + resourceId + protocolVersion` 投递给 pg-boss，具体状态转换由 `app_worker` 在租户上下文中重新验证并执行。

API、Worker 和 Maintenance 启动时查询 `current_user`、`rolbypassrls`、对象所有权和关键表授权；生产环境若发现任一运行时角色拥有业务表、具有 `BYPASSRLS`，或 Maintenance 对租户表拥有写权限/未列入清单的读取权限，必须拒绝就绪。每个进程只创建与自身角色相符的连接池，不能在同一个通用 `DATABASE_URL` 上通过 `SET ROLE` 模拟隔离。需要对 FORCE 表执行 DML 的迁移必须显式设置经过验证的租户上下文，或在同一迁移事务内成对执行 `NO FORCE ROW LEVEL SECURITY`、数据变更与恢复 FORCE，并写明原因和影响行数断言；禁止无上下文 backfill 后按成功退出。

所有业务上下文使用 `current_setting('app.user_id', true)` 和 `current_setting('app.workspace_id', true)` 的 missing-ok 形式；缺失上下文返回 NULL 并默认拒绝，不能抛出 500。禁止在池化连接上使用会泄漏到后续请求的会话级变量。

事务入口分为四类：

- `withUserTransaction`：Identity 在事务外取得可信 `userId`，事务开始后只设置 `user_id`，用于 Workspace 列表、创建和邀请接受等尚无目标成员关系的流程。
- `withTenantTransaction`：设置可信 `user_id` 和路径中的 `workspace_id`，随后在同一事务内验证 Workspace/成员状态和角色，再完成全部业务查询与写入。
- `withWorkerTransaction`：使用 Job 中的候选 `workspaceId` 设置 Workspace 上下文，按 `taskId + workspace_id` 验证业务 Task 后才访问后代资源。Worker policy 按数据库角色与 Workspace 上下文授权，不伪造普通用户身份，也不能用载荷绕过数据库归属校验。
- `withPlatformAdminTransaction`：接受受类型约束的 `platform` 或 `workspace` 目标；Workspace 目标设置真实 `user_id + workspace_id`，平台目标只设置真实 `user_id`。随后调用最小 `SECURITY DEFINER begin_admin_operation(target, purpose, request_id)`；函数验证当前用户仍在 `platform_admins`，校验 purpose 与 target 类型匹配，以 `pg_current_xact_id()` 写入 `admin_operations`，并通过事务级 `set_config` 设置 `app.admin_operation_id`。数据库 policy 只调用 `SECURITY DEFINER is_current_admin_operation(required_target, required_purpose, row_workspace_id?)`，由它验证 operation ID、当前用户、目标、动作、当前 transaction xid 和管理员状态全部匹配；旧 operation ID 在另一事务重放必须失败。随后业务动作和对应的租户或全局审计在同一事务提交。这是 app_api 中唯一不要求 Workspace 成员关系的分支，应用角色不直接读取控制表。

`withUserTransaction` provisioning 先锁定当前 `users` 行，以数据库唯一约束串行化重复验证回调；随后解析或新建个人 Workspace 和 owner 成员，并通过私有 `adoptOwnedWorkspaceContext(tx, resolvedWorkspaceId)`（名称可在实施计划中确定）锁定并确认该 Workspace 的 `owner_user_id = app.user_id`。该函数只接受本事务创建或按“当前用户唯一个人 Workspace”查询得到的数据库返回 ID，不接收路由或请求体中的任意 Workspace ID；采用成功后才设置事务级 `app.workspace_id` 并创建或读取首个 Wallet 和注册赠送账本。个人/团队 Workspace 创建、重复/并发回调、修复路径和越权采用均必须由真实 `app_api` 集成测试覆盖。

业务服务函数接收开放事务句柄，不接收连接池句柄，也不得在内部另开第二个事务。禁止保留“连接 A 查询成员，连接 B 执行业务 SQL”的两段式授权；当前 `requireWorkspaceMember()` 返回 access 后由 service 使用普通数据库句柄的实现必须在 Gate 0 重构为事务回调。

RLS 策略必须遵守以下非递归基线：

- `workspace_members` 的自查策略直接比较 `user_id = app.user_id`，不得在自身 policy 中再次查询 `workspace_members`。
- 管理员列成员、叶子表成员判断、邀请状态转换和平台 operation 校验统一调用各自最小化的 `SECURITY DEFINER` helper。helper 由 `schema_owner` 拥有，只读其声明的授权/控制表，固定安全 `search_path`、使用全限定表名、无动态 SQL、撤销 `PUBLIC EXECUTE`，并只向应用角色授予必要签名；任何 helper 都禁止读取 Canvas、Asset、Wallet、Ledger、Billing 或 Task 等叶子业务表。授权表不 FORCE、全局控制表不套 Workspace RLS，因此 owner helper 只在这些明确边界内读取完整事实，应用角色自身仍受 RLS。
- Workspace 自创建只允许 `owner_user_id = app.user_id`；首个成员只能是同一用户的 `owner`。邀请接受只能把当前已验证邮箱对应用户加入邀请指定 Workspace，并以一次性条件更新认领邀请；这些流程必须有独立 policy/helper 和事务集成测试，不能借用普通成员 policy。
- owner 自助 deactivation 使用独立、命令专用的 `TO app_api` UPDATE policy：`USING` 只接受当前用户拥有的 active Workspace，`WITH CHECK` 只接受同一 owner 的 deactivated + 非空 `deleted_at` 终态；普通成员更新 policy 仍只允许 active→active。路由 SQL 只能修改状态和删除时间，不能借该分支改 owner、类型或其他字段。
- 首个 Wallet 只允许在上述 adopted context 中创建，相关行的 `workspace_id` 必须等于当前上下文、Workspace owner 必须是当前用户且 Wallet 尚不存在；团队 Workspace 只创建零余额 Wallet。注册赠送分录额外要求目标是当前用户唯一的个人 Workspace。重复调用读取既有 Wallet 和交易，不向团队 Workspace 发放赠送；个人 Workspace 部分唯一索引、`signup-grant:<userId>` 的 Workspace 内唯一操作键和请求哈希共同保证重放幂等。
- `workspaces.status = active`、`workspaces.deleted_at IS NULL`、`workspace_members.status = active` 是 `withTenantTransaction` 普通成员分支的共同前置条件；owner 自助 deactivation 是在验证该前置条件后执行的专用终态动作。平台管理员分支不要求成员关系，也不要求 Workspace 为 active，但只能按 §5.8 固定动作矩阵访问 operation ID 所绑定的 Workspace：active 允许除 `workspace_restore` 外的全部 Workspace 目标动作；suspended 只允许 `workspace_read | workspace_deactivate | workspace_restore | billing_confirm_charge | billing_confirm_no_charge | ledger_compensate | workspace_export`；deactivated 只允许上述集合去掉 `workspace_deactivate`。非 active 状态禁止标准积分增发、Wallet 状态修改、普通 Canvas 写入、成员变更或新建生成任务。

RLS 不是应用授权替代品。路由仍执行成员和角色检查；RLS 负责阻止遗漏租户条件、错误 join 或未来代码回归造成的跨租户访问。全局 Reaper 和对账仅通过 `app_maintenance` 的列级只读授权扫描最小字段并投递候选，再由 `app_worker` 在租户上下文中重新读取、加锁和条件更新；Maintenance 扫描结果不是状态转换依据。面向人的平台管理员操作必须走 `withPlatformAdminTransaction`，不能借用维护凭据，也不能依赖把管理员加入所有 Workspace。

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

pg-boss 的队列元数据读取不属于上述业务事务。所有队列和 pg-boss schema 必须由 `schema_owner` release job 预先安装、迁移和 `createQueue`；release job 使用 pg-boss 公开的 `getConstructionPlans/getMigrationPlans` 执行包含异步索引步骤的完整 SQL，并核验预期索引，不得只以 `migrate: true` 启动后立即退出、遗留未运行的 BAM DDL。API 与 Worker 一律以 `migrate: false` 启动，启动和 readiness 校验 schema 版本、必需索引及队列，缺失或版本不匹配时拒绝服务。普通进程不得拥有 DDL 权限。

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
- snapshot 文档模式使用独立原生 IndexedDB 数据库 `infinite-canvas-recovery`（version 1），固定包含 `drafts`、`markers`、`epochs` 三个 object store。普通缓存仍可使用 localforage，但恢复库不得是 localforage instance，也不得与 `infinite-canvas` 数据库共用版本、对象仓库或事务语义。
- 三个 store 共享同一个不透明 `RecoveryScopeId`：未登录阶段使用 `local:<installationId>:<localCanvasId>`，登录后的云端画布使用 `account:<userId>:workspace:<workspaceId>:canvas:<canvasId>`；其中各 ID 都来自受信任的本地安装记录或服务端响应，不接受任意页面输入。`drafts` 主键为 `[scopeId, draftId]`，`markers` 为 `[scopeId, markerId]`，`epochs` 为 `scopeId`；所有读取、CAS 和 GC 都限定同一 scope，禁止跨 scope 枚举或删除。
- Gate 0 只使用 local scope 即可完成 CAS，不依赖尚未交付的账号或 Workspace。Gate 1/2 直接使用同一 version 1 键模型增加 account scope，不修改 object store 或主键。登录、登出和切换账号必须先关闭当前 Session，再切换 scope；其他身份的草稿不可见且不被当前身份 GC。local scope 不自动归属任何账号，只能通过显式导入创建新的云端 Canvas/Asset 和新 account scope，不能静默“认领”原记录。
- 恢复层以 factory 接收 `IDBFactory` 并显式执行 open/migrate，不在模块导入时产生删除或升级副作用。`versionchange` 必须关闭旧连接，`blocked` 必须有有界错误和可操作提示。
- `epochs` 记录分离 `coordinationRevision`、`deletionGeneration` 和持久 `tombstonedAt`。`writeSeq` 只在一个 `[scopeId, draftId]` 写会话内单调递增；普通 upsert/ack 在同一事务读取 scope epoch 与自身 draft，先拒绝 tombstone 或 `deletionGeneration` 不匹配，再拒绝 `stored.writeSeq >= incoming.writeSeq`，但不比较或推进 `coordinationRevision`。因此其他标签的 marker/repair 活动不会饿死本草稿，而确认删除后的迟到会话也不能复活它。
- marker 变更、外部草稿删除、repair commit 和 GC 携带打开时读取的 `expectedCoordinationRevision + expectedDeletionGeneration`，并在同一 `readwrite` 事务内校验后推进 `coordinationRevision`。打开画布必须在同一个只读事务中取得同 scope 的 marker、drafts 和 epoch 一致快照；过期 repair 必须重新解析。GC 删除前重新验证草稿仍过期且未被 marker 引用。“确认删除”只表示用户或服务端已经确认删除 Canvas 资源本身：本地 Canvas 可直接执行；云端 Canvas 必须先收到服务端删除成功或经查询确认已删除，响应不确定时不得预写 tombstone。确认后在单个事务中递增 `deletionGeneration`、写 tombstone 并删除该 scope 的 drafts/markers；tombstone 长期保留，首版不恢复同一 Canvas ID，若要找回内容必须创建新的 Canvas ID/scope。接受服务端版本、解决冲突、关闭 Session、普通草稿清理和 GC 都属于外部/自有草稿删除，只推进 `coordinationRevision`，绝不能写 tombstone 或推进 `deletionGeneration`。
- 每个有界操作独占一个 `IDBTransaction`；deadline 到期必须调用 `transaction.abort()`，不能只让 Promise 超时后允许迟到提交。事务 request queue 排空后不得 await 非 IndexedDB Promise。任何删除都不能基于事务外的旧读取结果。
- 当前 `canvas_recovery` localforage store 不是新协议的合法数据源。项目未上线，Gate 0 以显式升级动作删除它，不写双读兼容；升级前的测试草稿如需保留，由用户先显式导出。
- API Key 不再保存在普通用户浏览器。
- 普通用户不再配置任意上游地址，只选择平台模型。
- 现有渠道页迁移为管理员模型和 Provider 路由管理。
- snapshot 模式以 Zustand 本地编辑、防抖保存 canonical document `snapshot + baseRevision`。当前 Session 状态机、Manager 令牌和 prepare/commit 边界可以保留；localforage 恢复实现以及为不可取消迟到写设计的 `settled/whenLocalSettled` 补偿路径必须由原生事务 CAS 取代。clean/server recovery 结果统一由构造函数创建并总是携带 `repairs`，防止调用方漏字段。
- collaborative 模式必须使用独立文档引擎实例，不能直接复用 snapshot Session 的保存协议；Manager/store/页面的边界可以保留。
- collaborative 模式未来由 Y.Doc 成为共享文档权威，Zustand 只保留 UI 投影；两种模式通过显式文档引擎边界接入页面，不在组件中混合判断。
- 平移缩放属于按 `RecoveryScopeId` 保存的本地 UI 偏好，不触发全量云端快照保存；打开时优先使用本地视口，没有时回退共享 `defaultViewport`。恢复 envelope 分开保存 canonical document draft、local UI 和 `storageKey -> assetId/uploadState`，云端序列化器只读取 canonical document。Gate 2 必须压测完整快照大小、保存节奏、JSONB/TOAST 增长与 autovacuum，不能只验证 revision 正确性。
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
- 用户可见恢复单元同时包含 PostgreSQL 元数据和对象存储字节。对象不可变版本的保留期不得短于 PostgreSQL PITR 窗口；恢复顺序、跨存储对账和 readiness 标准必须成文，不能用数据库单项恢复结果代表平台恢复。
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
| PostgreSQL 恢复到时间 T 与对象版本不一致 | readiness 保持失败；按 Asset 引用对账对象版本，恢复可找回字节，隔离 T 之后孤儿对象，不可恢复引用显示受控不可用 |
| Worker 重复执行 | 唯一约束、条件更新和 `lease_epoch` 阻止旧 Worker 写入或重复结算；已发出的上游调用仍由幂等键/对账处理 |

Worker 使用租约、heartbeat 和 fencing epoch。Reaper 的 Maintenance 阶段只发现过期候选并投递；`app_worker` 在 `withWorkerTransaction` 中重新验证过期条件并通过条件更新递增 epoch：`queued` 可安全重新领取；没有远程 ID 的过期 `submitting` 进入 `reconciling`，不能直接再次 submit；有远程 ID 的 `processing` 继续查询。

## 15. 可观测性

结构化日志关联 `requestId`、`userId`、`workspaceId`、`taskId`、`attemptId` 和 `providerRouteId`。默认不记录提示词、Cookie、密钥和完整上游响应。

API、数据库事务、队列等待、Worker Attempt、Provider HTTP、对象存储和结算使用 OpenTelemetry 兼容的 trace/span 上下文；第一阶段可以只启用轻量 exporter，但上下文传播字段和敏感数据规则从第一版保持稳定。Prometheus、Grafana、Loki、Tempo 是可替换的运行部署选择，不进入领域模块接口。

核心指标包括：

- API 请求量、错误率、延迟、事件循环延迟、内存、CPU 和数据库连接池。
- 队列深度、最长等待、各状态停留时间、任务成功率和端到端耗时。
- Provider 路由成功率、429、5xx、timeout、生成耗时和查询失败率。
- 未关闭 Hold、Hold 年龄、进入 `review` 的 Hold、单交易账本平衡、Wallet 与账本投影偏差、未结算成功任务和未释放失败任务。
- SSE 连接和断线重放数量。
- 协作模式上线后增加令牌续期失败率、撤权收敛时长、单文档连接数、fan-out p95/p99、Redis 重收敛和重连风暴指标。

账本不平衡、Wallet 投影漂移、负余额、`reconciling` 持续增长、队列积压、Provider 连续失败、连接池耗尽和 Asset/对象不一致必须告警。

## 16. 测试策略

单元测试覆盖模型能力、价格、状态转换、Hold/结算/释放、错误分类和响应解析。

真实 PostgreSQL 集成测试覆盖邮箱验证后“个人 Workspace + owner + Wallet + signup grant”单事务提交、重复/并发验证回调最终全平台只有一个个人 Workspace/Wallet/signup grant、越权 context adoption 拒绝、并发防透支、幂等 Hold、延迟约束下的账本平衡、分录复合租户键、Wallet 投影对账、owner 合法转移顺序和 `owner_user_id` 一致性、租约接管与 fencing、重复 Worker 结算、管理员调整重放/冲突与审计原子性、任务与 pg-boss 原子入队、pg-boss 预期索引，以及 Canvas 并发 revision、软删除、模式不匹配和不可见资源的稳定错误映射。已有 Canvas 同 baseRevision 并发保存测试可作为 revision 证据，但不能替代新增 RLS、队列和账本测试。

租户隔离测试由 schema owner 只负责建库/迁移，并单独断言该 owner 没有 `BYPASSRLS`；实际请求使用生产等价的 `app_api`、`app_worker` 和 `app_maintenance` 登录角色。测试自身断言三者均非 owner、均无 `BYPASSRLS`，并证明缺少上下文、缺少显式 Workspace 条件、错误 join、伪造路径 Workspace、API 伪设无成员 Workspace、跨租户子资源 ID、伪造/跨事务复用 admin operation、邀请接受和池连接复用均默认拒绝；真实平台管理员事务只能访问 operation 绑定的目标 Workspace，并按动作矩阵处理 active/suspended/deactivated，跨 Workspace 或错误动作仍拒绝。状态机测试覆盖 owner 专用 policy 的 active→deactivated、管理员 active→suspended→deactivated、suspended/deactivated→active，并证明 deactivated 下 `wallet_adjust` 失败、restore 后才恢复 active 动作集合。平台目标 operation 只能按 read/write purpose 读取或修改 Model/Route；普通 app_api 读取 Route、读取 disabled Model、Workspace 目标 operation 和错误 purpose 必须失败，管理响应必须断言不含 `secret_ref` 或真实 Secret。Maintenance 只能读取清单中的扫描列，任何租户表写入或未授权列读取均失败，候选交给 Worker 后必须重新验证。不得以 schema owner 或超级用户运行后宣称 RLS 生效。

身份边界测试证明 Identity 适配器替换不会改变 Workspace 成员、角色、邀请、钱包或 Canvas 数据；Workspaces 模块测试不得依赖 Better Auth Organization API。

每个 Adapter 使用固定 HTTP Fixture 覆盖正常 JSON、Base64、临时 URL、远程任务 ID、HTML 502、空响应、错误 JSON、重复字段、超时、连接中断、无媒体成功响应、画幅/分辨率映射和视频重复时长字段。每个真实上游故障都要沉淀为回归 Fixture。

故障注入覆盖事务后崩溃、Provider 接受后崩溃、S3 中断、结算断连、重复领取和 SSE 重连。

Gate 0 先为 `web/` 建立范围受限的 Vitest + fake-indexeddb 测试入口，不引入 DOM/React 测试框架。snapshot 文档模式先让当前非原子实现下的关键测试失败，再用原生 IndexedDB 事务/CAS使其通过；至少覆盖双连接同键 CAS、同 draft 的 `writeSeq` 乱序拒绝、另一标签频繁推进 `coordinationRevision` 时私有草稿仍可前进、coordination CAS 过期拒绝、旧 `deletionGeneration` 与 tombstone 阻止迟到复活、事务/deadline abort 全量回滚、草稿 + marker 原子写、所有权条件删除、GC 不删除外部活动草稿，以及同一浏览器切换身份后另一 scope 的草稿不可读且不可被 GC 删除。

自动化测试还必须穿过真实的 Session/Manager adapter，而不只测存储原语：取消的 prepare 不写入、普通 open 原子提交 repairs、server-copy 使用 `repairs: []`、过期 repair 重新解析、双标签冲突保留两份入口、未知 marker 所有权时跳过 GC、服务端删除失败/不确定时不写 tombstone、确认删除 Canvas 后写 tombstone 且旧会话不能复活、接受服务端版本清除冲突草稿后新 Session 仍能在原 scope 正常写入、forced dispose abort 自有事务。当前 server-copy 漏传 `repairs` 的路径先作为红色回归测试，clean/server 结果改由统一构造函数产生。

fake-indexeddb 只能证明单进程 API 语义。Chrome、Firefox、Safari 的独立测试页必须覆盖双标签 `versionchange/blocked`、异常关闭、刷新后耐久性、跨标签竞争、隐私模式/配额失败和后台节流；不得关闭用户已打开页面。Gate 0 关闭前必须实际执行并归档三浏览器结果、用户执行的 typecheck 结果和失败截图，不能只定义矩阵。

viewport 测试覆盖：纯平移不发保存；平移后编辑节点仍保持服务端 `defaultViewport`；显式“设为默认视图”才增加文档 revision；重开时按本地视口→共享默认顺序补水。Asset 测试覆盖 staging/ready/failed、延迟或失败上传、上传后 Canvas 冲突、嵌套图片/聊天/引用位置、缺失本地 Blob、跨设备重开、跨 Workspace Asset 拒绝、服务端拒绝 local-only key 和无引用对象延迟清理。

未来 collaborative 模式单独验证 Yjs 合并、提交前无 durable ack、检查点 + 后续更新恢复、转换 fencing、旧 snapshot 客户端被拒绝、单调投影更新、最新序列导出、离线重连、Awareness 不落库、打开 socket 的到期/降权/续期失败、60 秒撤权边界、Redis 中断时双实例编辑后从 PostgreSQL gap 回放收敛、多实例广播、文档分片和重连风暴；两种模式的测试不得互相替代。

Canvas 保存容量测试按“并发编辑者 × 快照大小 × 保存节奏”测量请求延迟、数据库/TOAST 写放大、表膨胀和 autovacuum。纯平移缩放不得出现在网络保存样本中。

自动 E2E 覆盖注册验证、注册积分、创建画布、选择模型、生成图片、素材入库和积分流水。真实 Provider 冒烟测试使用低额度专用密钥人工触发，不进入普通 CI。

## 17. 交付门禁

交付按可验证能力推进，不按自然日推进。后续实现计划必须重新编排；现有按天计划在完成修订前只能作为历史任务清单，不能继续作为架构依据。

### Gate 0：架构纠正

- 按依赖顺序先建立 `schema_owner/app_api/app_worker/app_maintenance` 凭据与测试连接，再移除 Better Auth Organization 写路径、重命名 Workspace 列、修正级联删除/角色/状态约束，最后启用事务上下文和 RLS；不得并行打开 RLS 后再补连接架构。
- `withUserTransaction/withTenantTransaction/withWorkerTransaction/withPlatformAdminTransaction`、新建 Workspace context adoption、非递归 policy helper、启动角色断言和生产等价跨租户测试形成可执行规范；业务服务只能使用同一开放事务。
- `document_mode` 立即落库为只读 `snapshot`，同步保存协议不得修改模式。
- snapshot 原生 IndexedDB CAS 子规范通过固定提交的独立审查；`web/` 测试入口和关键并发/Session-Manager 回归先红后绿，真实三浏览器矩阵已经执行并归档，用户 typecheck 结果已记录。
- 新实施计划明确保留 Session/Manager/prepare-commit，重写 localforage 恢复层并删除迟到写补偿路径；不得用临时兼容分支掩盖差异。

### Gate 1：身份与 Workspace

用户可以注册、验证、登录并获得个人 Workspace；可以创建团队 Workspace、邀请成员和切换空间。应用授权和 RLS 都不能信任客户端提供的成员关系。

### Gate 2：云端 Canvas 与 Asset

成员可以创建、保存、重开和冲突恢复 snapshot Canvas，并通过预签名 URL 上传和读取私有 Asset。浏览器本地恢复失败不能覆盖云端权威状态；多标签共享草稿发生冲突时必须显式展示，载入服务端版本会按 coordination CAS 删除同一画布的共享本地冲突草稿，但不写 Canvas 删除 tombstone，之后新 Session 仍可正常建立恢复草稿。Asset ID 转换、不可解析本地 `storageKey` 状态和 Canvas 保存写放大测试全部通过后才关闭 Gate 2。

### Gate 3：积分账本

注册赠送和管理员调整产生平衡、不可变、可审计的账本分录；并发 Hold 不能透支；重复调用不能重复增减积分。

### Gate 4：AI 任务闭环

至少一个图片 Provider 完成 Task、Hold、Attempt、pg-boss Job 的原子创建，输出存为 Asset，积分只结算一次，SSE 可以断线重放，模糊上游结果进入对账而不盲目重试。

### Gate 5：生产验收

完成 Secret、迁移、备份、恢复演练、告警、限流、真实低额度 Provider 冒烟和人工验收。必须分别定义 Canvas、Asset 字节、账本/Hold/Task（未来含协作更新）的用户可见 RPO/RTO/可用性目标，并记录组件级与端到端演练实测值，不能以“待确定”或数据库单项恢复关闭。演练至少覆盖恢复到时间 T 前后的对象、缺失被引用版本、`staging` Asset、处于 `storing` 的 AI Task、排队/对账任务，以及 readiness 前的跨存储校验与孤儿隔离；任何容量或高可用声明都必须附带对应测试证据。

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
