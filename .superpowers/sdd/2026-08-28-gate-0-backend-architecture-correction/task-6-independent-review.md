# Task 6 独立验收报告（Acceptance round 1/2）

- Range: `47be7a2ac5fb0216757dea837500e6d40eecf6a9..542efd7b8169e96b85d1d1a71a225fda254eec5c`
- Commit count: 恰好 1 个（`feat: lock Canvas snapshot mode and deletion receipt`），已用 `git rev-list --count` 核实。
- 审查人：k3（独立验收代理）。实现代理（Sol）的自测与报告仅作待证材料，未采信；以下结论全部来自我亲自运行的命令与探针。

## Verdict

**APPROVE —— Task 6 最终验收通过。**

Critical 0 / Important 0 / Minor 3（均不阻断，见末节）。

上一轮独立审查（task-6-code-review.md，针对已被取代的 6b58d41）提出的 4 个 Important——回执可被 app_api 改写、DELETE 不变量缺结构化诊断、迁移测试无回填/回滚覆盖、并发与授权矩阵非确定性——在当前 HEAD 均已修复，且经我独立复核确认修复真实有效。

## 我亲自运行的验证与结果

### 1. 已提交测试套件（我亲自执行，非转述）

| 命令 | 结果 |
| --- | --- |
| `vitest run test/canvases/schema.test.ts` | 24/24 通过 |
| `vitest run test/canvases/routes.test.ts` | 24/24 通过（含 advisory-lock 栅栏 + pg_stat_activity 确定性并发、AFTER UPDATE 故障注入回滚、BEFORE UPDATE RETURN NULL 强制零行 + logger spy、removed-member/suspended/deactivated 删除拒绝、回执逐字节重放） |
| `vitest run test/database/tenant-isolation.test.ts` | 49/49 通过（含真实 app_api 的回执不变量矩阵） |
| `vitest run test/database/migration-upgrade.test.ts` | 7/7 通过（含 0005→0006 实数据回填、注入 P0001 故障整体回滚、重试成功、journal/snapshot 链） |
| `vitest run`（完整 server 套件） | 17 个文件，317/317 通过，16.35s |
| `tsx scripts/check-module-boundaries.ts src` | module boundaries: ok |
| `git diff --check 47be7a2..542efd7` | 干净 |
| `git diff 47be7a2..542efd7 -- migrations/0000..0005` | 0 行（历史迁移未动） |

测试真实性：运行期间用 `docker ps` 确认 testcontainers 真实拉起 postgres:18-alpine 容器（多文件并行多容器），排除假绿。

### 2. 我的独立对抗性探针（/tmp/task6-probe.mts，独立容器 + 真实 drizzle 迁移器，29/29 通过）

数据库级删除回执不变量（全边界）：

- P1a/P1b：app_api INSERT 伪造 deleted_at+receipt 对、仅 receipt → 均 23514（触发器 INSERT 分支拒绝）。
- P2a：app_api 首次 `UPDATE SET deleted_at=now()` → 触发器签发回执并经 RETURNING 返回（receipt=afe5b382-…）。
- P2b：已签发后 app_api 再碰 deleted_at → 23514，且存储态逐字节不变。
- P2c：app_api 改写 receipt → 42501（列级授权不包含 deletion_receipt_id）。
- P3a/P3b/P3c：管理员直改 receipt / 平移 deleted_at / 清空删除对（复活）→ 均 23514，存储态逐字节不变。
- P3d：调用方在首次删除时自带 receipt → 被触发器覆盖（数据库是唯一签发方）。
- P3e：活跃行被直写 receipt → 触发器强制置 NULL（活跃行永远不会凭空出现回执）。

租户与授权边界：

- P4a：跨空间 UPDATE → 0 行且目标行未变。
- P4b：无租户上下文 SELECT → 0 行。
- P4c：成员被移除后立即失去行访问（before=1 → after=0）。
- P4d：app_api 硬 DELETE → 42501（无 DELETE 授权）。
- P4e1/P4e2：app_api 改 document_mode / workspace_id → 42501。

迁移原子性（0005→0006，真实 drizzle 迁移器，非手工 SQL）：

- P5a：预置 BEFORE UPDATE 故障触发器注入 P0001 → 0006 失败。
- P5b：回滚完整——新列不存在、`relforcerowsecurity=true` 保持。
- P5c/P5d：迁移历史停在 6 条（0000–0005），遗留 deleted_at 原值保留。
- P5e/P5f/P5g：移除故障重试 → 活跃行 receipt 为 NULL、两条已删行获得互不相同 UUID 回执、历史增至 7 条、`canvases_enforce_deletion_receipt` 触发器存在且 tgenabled='O'。

### 3. 静态核对（直接读码确认）

- `server/migrations/0004_tenant-rls.sql:46`：canvases UPDATE 为列级授权 `(title, snapshot_json, revision, updated_by, updated_at, deleted_at)`——新增列不落入旧授权，新列无需额外 REVOKE。app_worker/app_maintenance 对 canvases 无任何权限（全库 grep 确认）。
- `0004:242-247`：SELECT 策略不以 deleted_at 为谓词（有注释说明），这是授权重放能锁定已删行的前提；服务层 GET/LIST 用 `isNull(deletedAt)` 过滤。
- `0006_canvas_document_mode.sql:33-71`：触发器 SECURITY INVOKER、`search_path=pg_catalog, public`、属 schema_owner、REVOKE PUBLIC/运行时角色 EXECUTE；三个分支（INSERT 拒绝伪造 / 首次跃迁强制签发 / 签发后 `IS DISTINCT FROM` 逐字节不变量）覆盖完整状态机。
- `service.ts:164-218`（saveCanvas）与 `:221-265`（deleteCanvas）：锁定顺序为 可见性/已删除 404 → mode 409 → revision 409 → MAX_SAFE_INTEGER 上限 409 → 条件更新零行 → 内部不变量错误；删除重放读已持久化回执，无第二次状态变更。
- `routes.ts:128-140`（PUT）与 `:168-181`（DELETE）：不变量错误在事务回滚后捕获，结构化日志（requestId/canvasId/workspaceId/expectedRevision 或 reason/err）+ 稳定脱敏 500（`canvas_save_invariant_failed` / `canvas_delete_invariant_failed`，retryable=false）。
- `packages/contracts/src/canvases.ts`：`documentMode` 只读出现在响应 schema；Create/Save body 均 `additionalProperties: false` 不含 mode；`CanvasDeletionReceiptSchema` 仅 DELETE 使用；GET/LIST 路径无回执字段。
- drizzle 迁移器（`node_modules/drizzle-orm/pg-core/dialect.js:60-71`）将所有待执行迁移包在单个 `session.transaction` 中——0006 的 DDL+DML 原子性由真实迁移器保证（我亲验回滚）。
- snapshot 链：`0006_snapshot.json.prevId === 0005_snapshot.json.id`；新列/约束仅出现在 0006；除 canvases 外其余表与 0005 完全一致（迁移测试已断言，我复核通过）。
- `_journal.json` idx=6 条目与迁移测试的逐字段断言一致；0006 `when=1787900000000` 大于 0005 且早于任何未来真实生成时间，排序安全。
- 测试辅助代码：`forceCanvasUpdateOrder` 用随机 advisory key + 控制连接持锁 + pg_stat_activity 轮询，finally 中解锁/回收/drop 触发器；`testObjectNames` 随机后缀避免命名冲突；`auth.ts` 的 logger 覆盖默认 `false` 不外泄；`commitAsApi` 使用事务局部 set_config，无连接残留。未发现泄漏、竞态或生产边界绕过。

## 上一轮 4 个 Important 的关闭证据

1. 回执可被 app_api 改写 → 现由 BEFORE INSERT OR UPDATE 触发器在数据库层签发并锁死（P1a/P2a/P2b/P2c/P3a–P3e 全链路复核）。
2. DELETE 缺结构化不变量诊断 → 新增 `CanvasDeleteInvariantError`（reason: zero_row_update|missing_receipt）+ 路由捕获 + logger-spy 测试断言全部字段（我运行通过）。
3. 迁移测试无回填/回滚 → 新增真实 0005 schema + 实数据回填 + P0001 故障整体回滚 + 重试成功（我运行并以自己的夹具独立复现，P5a–P5g）。
4. 并发/授权矩阵非确定性 → 三个并发用例改为 advisory 栅栏强制 save-first/delete-first/delete-delete 真实重叠并观测锁等待；补齐 removed-member/suspended/deactivated/fault 路径（我运行通过）。

## Minor（不阻断，供后续 Gate 参考）

1. **P1c**：app_api 直接 INSERT 时可自带 `document_mode='collaborative'`（INSERT 为表级授权，触发器 INSERT 分支只拦截删除生命周期字段）。API 契约 400 拒绝、服务层恒写 'snapshot'，实际后果仅是同租户内生成一个无法保存（409）的画布，不破坏任何跨租户/回执/删除不变量。如需纵深对称，可在触发器 INSERT 分支加 `NEW.document_mode := 'snapshot'`。
2. **P2d**：已删除行的非生命周期列（如 title）在数据库层仍可被授权角色更新；`deleted_at`/`deletion_receipt_id` 本身不可变，服务层也永不这样做。当前语义满足"删除证明不可伪造、不可复活"，若未来要求墓碑完全只读再收紧触发器。
3. 继承的残余风险（实现方已声明，我确认属实）：数据库超级用户可通过禁用触发器或 `session_replication_role='replica'` 绕过该不变量；运行时角色无此能力。本地验证环境为 Node 22，生产基线 Node 24 发布前需复跑套件。

## 结论

Acceptance round 1/2：**APPROVE**。无 Critical/Important。回执签发与不可变性、迁移原子性、租户隔离、幂等删除证明、错误协议与并发线性化均有数据库级不变量与确定性测试支撑，并经独立对抗性探针复核。
