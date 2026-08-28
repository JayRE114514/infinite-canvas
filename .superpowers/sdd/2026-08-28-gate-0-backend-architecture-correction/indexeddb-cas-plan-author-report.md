# IndexedDB CAS 计划撰写与最终审查修订报告

- BASE：`af37bfa355e6de411c46729c162d31c548ada92d`
- 原计划提交：`f782940`，round-1 修订提交为 `d7f59c9`；最终修订继续在同一提交上 amend，不新增第二个计划提交。
- 产出：`docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md`（3762 行，7 个可独立验收任务）。
- 权威 Spec：`docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`（§11、§16、§17 Gate 0）。未另造规格；2026-08-27 canvas-sync spec/plan 在本地持久化、测试与视口三项上仍为 superseded，仅作历史背景引用。
- 边界：本单元只修改计划、ledger 与验收记录；未修改 production/test code，未启动子代理，未触碰 `.superpowers/research/**`。
- Round 1/2：Kimi `NOT APPROVED — Critical 3 / Important 4 / Minor 9`，全部 finding 已在 `d7f59c9` 收敛。
- Round 2/2：Opus `NOT APPROVED — Critical 1 / Important 2 / Minor 4`。按用户设定的两轮上限逐项精确修正，不发起第三轮；状态为“corrected after final review; implementation authorized; no APPROVE claim”。下一份可执行证据是 Task 1 RED/GREEN 与后续逐任务独立验收。

## 实际阅读与复核范围

完整阅读 `AGENTS.md`；权威架构 spec 的 IndexedDB/CAS/删除证明/前端迁移段落；旧 canvas-sync spec/plan 顶部 superseded 说明；当前 `canvas-local-recovery`、canvas-sync types/session/manager、repository/API、Zustand store、hooks/pages；Task 6/7 独立验收与 ledger；round-1 `plan-independent-review.md`；以及终轮 `plan-final-review.md` 全文。修订时再次核对当前 session 的保存/冲突/重试/导出/收尾路径、manager 的 prepare/commit/删除/GC 路径、合同中的 `CanvasDeletionReceiptSchema`、AGENTS:50 和 workspace Vitest/lockfile 状态。

## Round-1 finding 修复映射

| Finding | 处理位置 | 修订结果 |
|---|---|---|
| C1 deadline 测试非法且假绿 | Task 1 Step 5、Step 7、Step 8 | deadline 改为 50ms、10 万次有限 `txn.req(get)` 循环；断言 timeout 与整事务回滚；去掉 abort 后循环最终排空并提交，readback 必红。正文解释请求队列排空后 await 非 IDB Promise 会 auto-commit，因此事务 callback 禁止计时器/网络/任意外部 Promise。另加 owner AbortSignal 回滚测试。 |
| C2 纯 viewport 无法物化 | Task 6 session RED、Step 5.4-5.5 | 引入 `localUiSeq/materializedLocalUiSeq/persistedLocalUiSeq`，重写 materialize 门、单槽、drain、flush、ack settlement、dispose 与 counters；local UI 可独立落盘但不参与 `savedSeq`、clean 或云端调度。 |
| C3 Node import 裸 `indexedDB` | Task 4 lazy adapter；Task 6 manager RED/单例 | `browserCanvasRecoveryStore` 惰性读取 `globalThis.indexedDB`；模块 import 不读取工厂。Node 无 ambient IDB 时静态 import 安全，首次操作返回 `unavailable/unsupported`。假绿把单例改回裸标识符会让 suite 在用例前失败。 |
| I1 default viewport 泄漏 | Task 6 session RED；Step 5.2、5.4-5.6 | resolution 冻结并复制 `documentDefaultViewport`；本地 document snapshot、`startSave`、`finalSave` 和 stale parser 全部从冻结值序列化。新增 pan→node edit→save 同时断言云端/document viewport 保持打开值、localUi 保存实时值。 |
| I2 tombstoned 状态不完整 | Task 6 session RED；Step 5.7 | 明确采用完整状态机方案：事件白名单包含 tombstoned 的 flush/hold/dispose，update 返回 false，flush/hold 为有界 no-op，dispose 合法到 disposed；view 给出 `localPersist=tombstoned` 与命名 unavailable key。 |
| I3 accept-server stale 放弃 | Task 6 manager RED；Step 6.3 | `clearConflictDrafts` 固定两次总 CAS 尝试，每次重新读取一致 snapshot 并重算目标；首次 stale 可成功，连续两次 stale/任何 unavailable 均保留记录并报告 degraded。测试强制另一标签推进 coordination，并覆盖成功重试与耗尽保留。 |
| I4 三条 CAS 替代路径缺失 | Task 6 session RED；Step 5.8 | 明确 `onSaveConflict/persistConflictRecords`、`retryRecovery`、`exportConflictDrafts`：双标签 live-409 合并两条 marker，stale 重读重试；retry stale 后重解析、失败保持 blocked 且不 save；export 只读一次一致 snapshot、不写 marker、不删 draft、不推进 epoch。 |
| M1 删除注释/行为矛盾 | Task 6 Step 6.4 | 删除多余预读；仅匹配回执路径调用 `confirmDeletion(scopeId, 0, now)`，注释明确 0 是 v1 唯一 live generation，事务内重读会拒绝既有 tombstone/非零 generation/损坏 epoch。 |
| M2 Task 5/6 边界表错误 | Replaced And Deleted Interfaces；Task 5/6 Files | HTTP/API/repository outcome 与 manager proof gate 属 Task 5；旧 local write/session/two-phase cleanup 的替换属 Task 6，遗留模块物理删除属 Task 7。 |
| M3 文件/测试计数错误 | Task 4、Task 6、Task 7、Self-Review | 最终精确为 9 个测试文件、74 项：7/5/5/12/11/3/9/12/10。 |
| M4 损坏 epoch 被折叠 | Task 3 tests/`readEpoch`；全局 corruption rules | 只有不存在才创建 initial epoch；present-invalid epoch/marker 返回 `unavailable/corrupt`。损坏 draft 对 open 是按行跳过但保留，禁止猜测 writeSeq 覆盖，普通 GC 不删，只有确认删除按 scope key 清除。 |
| M5 缺安装步骤 | Task 1 Step 1-2 | 先写 pinned devDependency，再从仓库根执行 `bun install`，确认 lock 与 `web/node_modules/.bin/vitest` 后才允许进入 RED。 |
| M6 scopeId null 无命名结果 | Task 6 manager RED；Step 6.2；Task 7 i18n | `ScopeIdResult` 明确 `invalid-scope`，prepare 在网络 load 前返回 `{status:"failed", messageKey:"canvas.recovery.invalidScope"}`，测试断言 repository 未被调用。 |
| M7 未钉住两份 marker | Task 6 live-409 RED | 两个 session 使用不同 draftId，第二次 marker CAS 被强制 stale；最终 marker 与 export 都精确包含 a/b 两份，并验证 export 前后 snapshot 完全一致。 |
| M8 account/local 接线偏离未说明 | Global Constraints、Task 2、Task 6 scope 注释、Self-Review | 明确本分支 Identity/Workspace/Cloud Canvas 已落地，因此当前生产接 account scope；local constructor/installation id/schema 同版保留但不接线，不会把 local 数据静默归入 account scope。 |
| M9 AGENTS 未写例外 | Task 7 Files/Step 1、File Responsibility Map | 仓库已有明确例外；最终审查后改为固定字符串只校验、禁止新增或编辑，避免同义重复。 |

## Final-review finding 修复映射

| Finding | 处理位置 | 修订结果 |
|---|---|---|
| C1 ambient `IDBKeyRange` | Global Constraints；Task 3 scope-isolation test / `readScopeDrafts`；Task 4 `confirmDeletion` | 两处 `IDBKeyRange.only(scopeId)` 分别改为 `index.getAll(scopeId)` / `getAllKeys(scopeId)`。规则明确恢复层只能使用注入 factory 及其派生对象；真正需要 range 时必须显式注入同 factory 的构造器。现有 scope 用例改为在 `globalThis.indexedDB` 与 `globalThis.IDBKeyRange` 均为 undefined 时实际执行两 scope 枚举并断言隔离。 |
| I1 Vitest 可执行路径 | Task 1-7 的全部 Run 命令；Task 1 install precondition | 从 `web` 工作目录执行的命令全部统一为 `./node_modules/.bin/vitest`，与根目录安装后检查 `web/node_modules/.bin/vitest` 完全一致；不存在的根 `node_modules/.bin` 不再被引用。 |
| I2 tombstoned rename | Task 6 Produces、session RED、Step 5.7、fake-green | `SessionEvent` 新增 `rename`，`ALLOWED_PHASES.rename = ACTIVE_PHASES`；rename 在 tombstoned 时于 title mutation、`registerEdit` 和 timer 前返回 `local-only`。初始 tombstone 用例推进本地计时器后断言 title 未改、无 upsert、phase 仍 tombstoned、`saveError` 仍 null，再覆盖 flush/hold/dispose。 |
| M1 AGENTS 校验假绿 | Task 7 Step 1 / Step 7 / Step 9；File Responsibility Map | 使用与 AGENTS:50 现有文字一致的 `rg -F`，要求恰好一条；Task 7 明确 verify-only，提交文件列表移除 AGENTS；负向探针只改搜索 needle，不改源文件。 |
| M2 `CanvasSessionInit.scopeId` 漏列 | Task 6 Interfaces/Produces | 补出完整 `CanvasSessionInit` 签名与受信 `RecoveryScopeId` 字段，和所有 RED 用例构造保持一致。 |
| M3 GC 无用 `removed` | Task 4 `collectGarbage` 伪码 | 删除声明、递增与 `void removed`，outcome 签名不变。 |
| M4 abort 测试余量隐式 | Task 1 database RED | 两个用例共用 `TRANSACTION_HOLD_REQUESTS = 100_000`；注释记录 fake-indexeddb 6.2.5 约 225ms 的终审探针，并规定不能在未测量 50ms/20ms 活跃队列余量时下调。 |

四项 Minor 全部采纳，无技术性不采纳项。

## 关键架构决策

1. 独立 `infinite-canvas-recovery` v1 固定三 store 和 keyPath/index；核心工厂注入，浏览器单例再做惰性 ambient 适配。
2. 每个 bounded store operation 独占一个 transaction；deadline/owner cancel 均 abort。事务 callback 只能 await IDB request，所有网络、timer 与状态机等待在 transaction 外。
3. `writeSeq` 只保护单 draft；`coordinationRevision` 只保护共享 marker/repair/foreign-delete/GC；`deletionGeneration+tombstonedAt` 只由确认删除同事务推进。
4. canonical document、local UI、asset mapping 三分；document 与 local UI 分别计数，default viewport 冻结，未提前引入 Yjs。
5. 删除证明是 HTTP `CanvasDeleteOutcome`，存储落地是不同名的 `CanvasDeletionOutcome`；404/inactive/removed/network/timeout/unknown 全部保留本地。
6. Session/Manager ownership、prepare/commit、单槽和有界 detached 保留；`settled/whenLocalSettled` 与两阶段迟到清理完全删除，不留兼容协议。

## 自查结论

- Spec coverage：计划 Self-Review 逐项映射 IndexedDB/CAS、删除证明、前端迁移、legacy drop 与人工浏览器矩阵。
- 完整性：计划内无未决占位或泛化实现指令；所有失败都有命名 outcome、重试上限和最终保留/报告语义。
- 类型签名：五个 recovery store 方法的 optional owner signal、`RecoveryFailureReason`、两类 deletion outcome、scope、repair、session state 与共享两次重试常量跨任务一致。
- 升级/回滚：legacy store 只在显式 bootstrap drop；不双读、不上传、不迁移。回滚是代码回滚，切换后 native 草稿对旧版本不可见，可能丢失，计划明确记录该 pre-release 代价。
- 跨任务可部署：Task 1-4 无生产入口；Task 5 仅收窄现有删除认定；Task 6 是唯一协议切换；Task 7 删除无引用旧模块并显式执行 upgrade。无半接口、无双活协议。
- 自动/人工边界：fake-indexeddb 只计 API 语义；Chrome/Firefox/Safari 的真实 blocked/versionchange、耐久性、跨标签调度、配额与后台节流仍只能由人工矩阵验收。
