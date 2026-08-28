# 原生 IndexedDB CAS 实施计划 — 最终独立验收（Acceptance round 2/2）

审查者：claude-opus-5（未启动子代理，未修改计划/代码/提交；仅写入本文件）
范围：BASE af37bfa355e6de411c46729c162d31c548ada92d → HEAD d7f59c9c8e93bc08e9193e0222e40712b97b3b51
被验收对象：docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md（3714 行，全文通读）
依据：AGENTS.md、权威架构 spec §11/§16/§17、当前 web 侧 canvas-sync-session.ts(909) / canvas-sync-manager.ts(388) / canvas-sync/types.ts(260) / canvas-repository.ts / api/platform-client.ts / api/canvases.ts / lib/canvas/canvas-snapshot.ts、packages/contracts CanvasDeletionReceiptSchema、round1 报告
作者报告仅作索引，未作为证据采纳。

**结论：NOT APPROVED — Critical 1 / Important 2 / Minor 4**

round1 的 3 Critical + 4 Important + 9 Minor 全部 CLOSED，且逐项亲自复验而非采信描述。本轮拒绝仅由一个新引入的 Critical 触发：计划刻意不注入任何 ambient IndexedDB 全局，但 store.ts 的作用域枚举仍裸用 `IDBKeyRange`，Node 测试环境下它是 undefined，导致事务内抛 ReferenceError 并以 `aborted` 收场。这会让 Task 3/4/6 的“跑到全绿”永远不绿，且把环境缺陷伪装成有界失败原因，正是本计划自己要消灭的那类误导。修正是两行以内、无设计决策的改动。

---

## 我亲自执行的验证（非转述）

探针目录 /tmp/idb-probe/r2，fake-indexeddb 6.2.5（与计划锁定版本一致），Node v22.23.2。逐字复刻计划 Task 1 Step 7 的 `createRecoveryDatabase`/`run` 到 runner.mjs（120 行），仅额外加入两个开关用于假绿对照。

1. `node c1-deadline.mjs` — C1 新 deadline 测试形态
   - 带 abort：`{"status":"failed","reason":"timeout"}`，用时 51ms；readBack `{"status":"ok"}`（value undefined）→ **abort 真实回滚**。
   - 去掉 `transaction.abort()`：仍先得到 `timeout`，但 readBack 返回完整 epoch 记录，且 readonly 排在写者之后（readMs=181）→ **假绿对照真实变红**。
   - 吞吐：100k 次 `get` 全排空需 225ms，远大于 50ms deadline，循环有界性成立。
2. `node nested-await.mjs` / `nested-await-fixed.mjs` — 事务存活与 IDBKeyRange
   - 无 `globalThis.IDBKeyRange` 时，GC 形状操作（嵌套 async helper + marker get + 逐条 delete + epoch put）返回 `{"status":"failed","reason":"aborted"}`，后续读同样 aborted。
   - 注入 `globalThis.IDBKeyRange` 后，同一操作 `{"status":"ok","value":{"removed":2,...}}`，提交态 `{"ids":["a"],"rev":1}`；confirmDeletion 形状（getAllKeys + 逐 key delete + marker delete + epoch put）`{"deletedKeys":1}`，终态 `deletionGeneration:1` 且 `tombstonedAt` 已写 → **嵌套 async helper 的顺序 txn.req 不会提前提交，计划的多步事务合法**；上一条的 aborted 唯一原因是 IDBKeyRange 缺失。
   - work 中途 throw：`{"status":"failed","reason":"error"}` 且两个 store 均回滚。
3. `node globals.mjs` — Node 测试环境全局面
   - `typeof IDBKeyRange` = **undefined**；`typeof indexedDB` = undefined；`performance` = object；`structuredClone` = function。
   - 裸 `IDBKeyRange.only(...)` 抛 `ReferenceError: IDBKeyRange is not defined`。
   - `index.getAll("s1")` / `index.getAllKeys("s1")` 用普通键正常返回 → 存在零 ambient 依赖的等价写法。
   - 根导入 fake-indexeddb 不会注入 `globalThis.indexedDB`（仍 undefined），计划 setup 文件“不注入全局”的断言成立。
4. `node -e "typeof globalThis.indexedDB"` = undefined → C3 的惰性单例前提成立。
5. 仓库事实核对（read-only）
   - `ls node_modules/.bin` 在 worktree 与主仓库均**不存在**（根 node_modules 仅 .bun/.vite）；`web/node_modules/.bin` 含 vite/tsc/prettier/nanoid/shadcn，`server/node_modules/.bin` 含 vitest。即 bun 按 workspace 放置 binary，不 hoist 到根 .bin。
   - `rg "画布未同步草稿恢复.*原生 IndexedDB.*同事务 CAS" AGENTS.md` → exit 1（无匹配）；AGENTS.md:50 实际措辞为“独立原生 IndexedDB 数据库和同一事务内的 CAS”。
   - PlatformApiError 构造签名 `(code, status, retryable=false, requestId="")`，计划测试 `new PlatformApiError("revision_conflict", 409)` 成立；项目冲突判定走 `isRevisionConflictError` → `error.code === REVISION_CONFLICT_CODE`。
   - CanvasDeletionReceipt = { canvasId, deletionReceipt(uuid), deletedAt(date-time) }，与计划 isReceipt/测试 fixture 一致。
   - manager 公开面 setScope/prepareOpen/commitPrepared/prepareServerCopy/commitServerCopy/getActiveSession/deleteCanvases 均存在；session 现有 draftKey/whenLocalSettled 待 Task 6/7 替换，与计划一致。
   - projectToSnapshot 的非测试调用点仅 session:389 与 manager:274；manager:274 是列表级重命名，序列化的是刚从服务端 load 的 project，不含本地实时视口。
   - 计划自称的测试计数复核为真：43（6 文件）、74（9 文件）、session 12 / manager 10 与实际用例条数逐条对齐。

---

## Round1 findings 逐项结论

| # | 结论 | 亲自验证到的证据 |
|---|---|---|
| C1 deadline 测试必然失败且测的是被禁模式 | **CLOSED** | 新测试改为 100k 次有界 `txn.req(get)`（行 250-257），探针实测带 abort → timeout + 完整回滚，去 abort → 记录提交、回滚断言变红；行 21 补入 auto-commit 机理，Step 8 明文禁止 `await new Promise(() => {})` |
| C2 纯视口永不落盘 / 会话测试必失败 | **CLOSED** | 引入 localUiSeq / materializedLocalUiSeq / persistedLocalUiSeq 三元组；materialize 门重写为 `if (!documentChanged && !localUiChanged) return`（行 2803-2812）；贯通 update(2926) / scheduleLocal / materialize / drainLocal(2852,2864,2872) / flushLocal(2886) / queueDraftSettlement(2967) / disposeBody(3008)；assertCounters 独立 localUiOrdered 且 cleanOk 明文只描述文档态（行 2772-2779）；纯平移用例断言 state 为 synced、hasUnsavedEdits 为 false、save 未被调用；假绿项“删除 localUiSeq += 1” |
| C3 Node 下 import 即 ReferenceError | **CLOSED** | `createLazyBrowserRecoveryStore(getFactory = () => globalThis.indexedDB)` 默认参数为函数，模块求值不读全局（行 1556）；缺失时返回 unavailable/unsupported；manager 单例改用 `browserCanvasRecoveryStore`；两处测试断言 + 假绿项“换回 createRecoveryDatabase(indexedDB) 必须在任何用例体之前失败” |
| I1 实时视口泄漏进云端 defaultViewport | **CLOSED** | 会话冻结 `documentDefaultViewport`（行 2755）；`ensureDocumentSnapshot` 用冻结值替换 content.viewport（行 2799）；startSave/finalSave 只经 ensureDocumentSnapshot，无第二条序列化入口；stale/retry 走 `recoveryLoad()`（行 3017）同样用冻结值；测试断言 `save.mock.calls[0][2].snapshot.viewport` 仍为 {0,0,1} 且 localUi 为 {90,45,2}；假绿项“在 startSave 里序列化 content.viewport” |
| I2 tombstoned 未进事件白名单 | **部分 CLOSED（见 Important-2）** | ALLOWED_PHASES 的 flush/hold/dispose 已含 tombstoned（行 3144-3155）；update 在 assertEvent 前 return false；localTick 经 enterTombstoned 的 clearLocalTimer + drainLocal 守卫不可达；requestOutdated 吞掉迟到网络回调；retrySave/releaseHold 早退安全。**唯一未闭合的对外动作是 rename** |
| I3 stale cleanup 一次性放弃 | **CLOSED** | clearConflictDrafts 改为 MAX_COORDINATION_ATTEMPTS 有界重读-重试（行 3399-3428），语义命名为 cleared / nothing-to-clear / tombstoned / retained-stale / retained-unavailable，失败经 `session.reportRecoveryCleanupFailure()` → markDegraded；两条确定性用例（一次 stale 后成功重试；两次 stale 保留 marker+draft 且 localPersist=degraded，均断言 commitCoordination 调用 2 次） |
| I4 三条活体路径无 CAS 规定与测试 | **CLOSED** | persistConflictRecords（行 3190）先落自己 pending 再以同一致快照发布 marker、stale 有界重读、保留外来有效条目；onSaveConflict await 完整尾巴；retryRecovery（行 3267）不提交完成前不解锁、unavailable 明确留在 recovery-blocked；exportConflictDrafts（行 3341）单次只读零变更；双标签两份入口用例断言 marker 为 draft-a/draft-b 且导出为 a/b，并断言快照前后完全相等 |
| M1 confirmLocalDeletion 注释与代码矛盾 | CLOSED | 改为固定 `confirmDeletion(scopeId, 0, now)` 并说明 generation 0 是 v1 唯一存活代、CAS 在事务内重读 |
| M2 Replaced/Deleted 表任务边界错位 | CLOSED | CanvasLocalWrite / whenLocalSettled / deleteMarkerIfOwned / CanvasDraftScope 均已标 Task 6，模块删除标 Task 7 |
| M3 文件数笔误 | CLOSED | 17/3 文件、43/6 文件、74/9 文件、session 12 + manager 10 = sync 22，逐项复核一致 |
| M4 损坏 epoch 未 fail closed | CLOSED | readEpoch 仅 missing 才造 initialEpoch，present-invalid 返回 corrupt；readOpenSnapshot / upsertDraft / commitCoordination / confirmDeletion / collectGarbage 五处一律 unavailable+corrupt；损坏 marker 同样不降级为“无 marker” |
| M5 缺依赖安装步骤 | CLOSED（但见 Important-1） | Task 1 Step 2 明确 `bun install` 并要求先确认 vitest 存在再进 RED |
| M6 scopeIdFor 返回 null 无命名结果 | CLOSED | ScopeIdResult 的 invalid-scope + `canvas.recovery.invalidScope` 文案 + prepare 在 load 前返回该失败的用例 |
| M7 双标签两份入口未真正钉住 | CLOSED | 见 I4，已是确定性两份断言 |
| M8 未声明只接线 account scope | CLOSED | Global Constraints 显式声明当前只派生 account scope、local 构造器同 schema 但未接线 |
| M9 AGENTS 缺 localforage 例外 | CLOSED（措辞见 Minor-1） | AGENTS.md:50 已存在该例外规则 |

---

## Critical

### C-new-1. store.ts 裸用 `IDBKeyRange`，而计划刻意不注入任何 IndexedDB 全局，Node 下作用域枚举必然抛 ReferenceError 并伪装成 `aborted`

位置：计划行 1102（`readScopeDrafts`：`index(SCOPE_INDEX).getAll(IDBKeyRange.only(scopeId))`）、行 1487（`confirmDeletion`：`getAllKeys(IDBKeyRange.only(scopeId))`）；对照行 300-309（setup 只导出 freshIndexedDB，不注入全局）、行 287-291（environment 为 node）。

复现（已实测）：

- `typeof globalThis.IDBKeyRange` 在 Node v22 + 仅 `import { IDBFactory } from "fake-indexeddb"` 下为 `undefined`；裸引用抛 `ReferenceError: IDBKeyRange is not defined`。
- 用计划逐字复刻的 runner 跑 GC 形状事务：无该全局时结果 `{"status":"failed","reason":"aborted"}`；注入后同一操作 `{"status":"ok","value":{"removed":2,"markerAbsent":true,"seen":3}}`。差异唯一变量就是 IDBKeyRange。

机理与后果：`work` 抛出后 runner 走 rejection 分支调 `transaction.abort()`，`onabort` 先于 `onerror` 落地，于是失败原因被归类为 **aborted**——而计划全局约束把 `aborted` 定义为“操作发起方取消”。实施者看到的不是 ReferenceError，而是“所有者取消了事务”，这是主动误导。

影响面：`readScopeDrafts` 是 readOpenSnapshot 与 collectGarbage 的唯一枚举入口，`getAllKeys` 是 confirmDeletion 的删除入口。因此 store-draft(12)、store-coordination(11)、session(12)、manager(10) 共 45 个用例在 Task 3 Step 4 / Task 4 Step 4 / Task 6 Step 7 的“跑到全绿”处集体不绿，且每条都表现为 unavailable/aborted 或 expected ok 抛错。scope(5) / types(5) / bootstrap(3) / repository(9) 不受影响。

这不是笔误而是设计缺口：计划为了证明“没有 ambient factory 依赖”刻意不装全局（行 300-309 的注释即如此声明），却漏掉了 `IDBKeyRange` 这个同样 ambient 的构造器；生产浏览器有它，所以这条只在计划自己规定的验证门上炸。

定向修复（二选一，两者均已实测成立）：

1. 首选、保持零 ambient 依赖：把两处改为普通键 `index(SCOPE_INDEX).getAll(scopeId)` / `getAllKeys(scopeId)`。实测 `getAll("s1")` 返回 `[{"scopeId":"s1","draftId":"d1"}]`、`getAllKeys("s1")` 返回 `[["s1","d1"]]`，单作用域语义与 `IDBKeyRange.only` 等价，且顺带消掉一个隐藏全局依赖，与“每个操作只限一个 scope”的约束更贴合。
2. 或在 `web/test/setup-indexeddb.ts` 追加 `import { IDBKeyRange } from "fake-indexeddb"; globalThis.IDBKeyRange ??= IDBKeyRange;`——但这会削弱该文件“不注入任何全局”的现有声明，需同步改注释。

无论选哪条，建议在 Task 3 补一句约束：恢复层事务内只允许使用注入的 factory 与 `txn` 上的对象，不得依赖任何其他 IndexedDB 全局构造器。

---

## Important

### I-new-1. 19 条测试命令的 vitest 路径在本仓库不存在，而计划自己的前置检查用的是另一条正确路径

位置：计划行 328、506、618、662、717、826、1053、1167、1404、1582、1635、1667、1829、1934、2644、3479、3482、3612 全部写作 `cd web && ../node_modules/.bin/vitest run ...`；行 153 的前置检查却要求确认 `web/node_modules/.bin/vitest` 存在。

实测：worktree 与主仓库的根 `node_modules/.bin` **均不存在**（根 node_modules 只有 .bun 与 .vite）；`web/node_modules/.bin` 与 `server/node_modules/.bin` 存在，后者已含 vitest（server 在用同版本）。本仓库 bun 按 workspace 落 binary，不 hoist 到根 .bin。

后果：`../node_modules/.bin/vitest` 从 web 解析到根 .bin，command not found——正是行 153 警告“会伪装成预期失败”的那种结果。行 153 与命令自相矛盾，实施者会立刻撞上且必须自行判断哪条对。

定向修复：统一为 `cd web && ./node_modules/.bin/vitest run ...`（与 Step 2 的存在性检查一致），或统一为 `bun --cwd web run test` 形式并让 Step 2 检查同一路径。Task 1 Step 1 已加 `"test": "vitest run"`，用 bun 脚本形式更不易漂移。

### I-new-2. `rename` 是 tombstoned 状态下唯一未闭合的对外动作，会把受控不可用翻成 invariant save-error

位置：现行 canvas-sync-session.ts:362-370 的 `rename` 早退条件为 `held || phase === "loading" || "disposing" || "disposed"`，不含 tombstoned；计划 Task 6 Step 5 重写了 `update` / `flush` / `holdForDelete` / `dispose`，全文对 `rename` 只有一处无关提及（行 2666 指的是重命名类型名），未收窄它。

逻辑反例（沿计划给出的代码推演）：

1. 会话运行中另一标签删除画布，某次 CAS 返回 tombstoned → `enterTombstoned()` → `phase = "tombstoned"`，清计时器、清单槽。
2. 用户改标题 → `rename` 早退条件不含 tombstoned → 进入 `registerEdit()` → `editSeq += 1`；phase 既非 clean 也非 save-error，保持 tombstoned；`scheduleLocal()` 重新起 120ms 计时器。
3. 计时器触发 `materialize()`：`documentChanged = materializedSeq < editSeq` 为真，于是不再早退，执行 `assertEvent("localTick")`。
4. 计划行 3146 的 `localTick: [...ACTIVE_PHASES, "disposing"]` **不含 tombstoned** → `CanvasSyncInvariantError` → guard → enterInvariant → `phase = "save-error"`、`saveError = invariant`。

结果与 I2 修复目标相反：视图从 `unavailableKey = "canvas.recovery.tombstoned"` 翻成通用保存错误，用户看到“保存失败”而不是“画布已删除”。无数据丢失、无复活风险，所以是 Important 而非 Critical，但它正是 round1 I2 要求“闭合所有对外动作”的同一处漏网。

定向修复（任一）：`rename` 早退条件加 `tombstoned`（与 `update` 对齐，返回 local-only）；或把 tombstoned 也加进 `localTick` 白名单并让 materialize 在 tombstoned 时早退。前者更贴近“tombstoned 拒绝一切新编辑”的既有语义。建议同时补一条用例：tombstoned 会话 rename 后 view.phase 仍为 tombstoned、unavailableKey 不变。

---

## Minor（不阻断）

1. Task 7 Step 1 的校验正则 `画布未同步草稿恢复.*原生 IndexedDB.*同事务 CAS` 与 AGENTS.md:50 实际措辞（“独立原生 IndexedDB 数据库和同一事务内的 CAS”）不匹配，实测 rg exit 1。按 Step 1 的“若缺失则补”分支，实施者会再加一条重复例外规则，AGENTS 出现两条同义条款而正则恰好 1 命中，检查看起来仍绿。建议把正则改成匹配现有措辞，并把该步骤明确为“只校验、不新增”。
2. Task 6 的 Produces 块未声明 `CanvasSessionInit` 新增的 `scopeId` 字段，只在 Step 3 的预期 RED 文本里间接体现；而所有测试都按 `{ ..., scopeId, resolution }` 构造。补进接口清单可免去实施者反推。
3. `collectGarbage` 里 `removed` 累加后仅 `void removed;`，是无用变量；要么用于返回/日志，要么删掉。
4. deadline 与 signal-abort 两个用例共用 100k 次请求循环：实测全排空约 225ms，对 50ms deadline 与 20ms signal 都有充足余量，但这条余量是隐式的。建议在测试旁注明“循环上界必须显著大于 deadline 期内可排空的请求数”，避免后人把 100_000 调小成假绿。

---

## 本轮额外确认为成立的部分

- 多步事务合法性：嵌套 async helper 内顺序 `await txn.req(...)`（readEpoch → marker get → readScopeDrafts → 逐条 delete → epoch put）实测保持事务存活并正确提交；GC 与 confirmDeletion 形状均验证通过。事务内无隐藏外部 await：store 五个操作只 await `txn.req`，会话/管理器的重试循环全部发生在事务之间（每次 store 调用各自一个 run()）。
- 类型签名跨任务一致：RecoveryScopeId 自 Task 2 起为唯一 scope 类型；五个 store 方法的 signal 可选参数与 outcome 联合在 Task 3/4/6 完全一致；CanvasDeleteOutcome（HTTP 证明）与 CanvasDeletionOutcome（存储结果）不可混用；draftKey→draftId 只在 Task 6 换一次；MAX_COORDINATION_ATTEMPTS 单一定义处 + 两处导入；MAX_CONFLICT_MARKER_ENTRIES 由 recovery 拥有、sync 仅 re-export。
- 无双协议、逐任务可部署：Task 1-4 纯新增无生产入口引用；Task 5 只收窄删除认定（DELETE 契约 + 证明门），仍跑在 legacy 持久化上；Task 6 单提交切换 session+manager+types 并使 legacy 模块变为无引用；Task 7 删除该模块并接线消费者。
- delete receipt / tombstone / GC 仍符合规格：仅匹配 canvasId 的正向回执（或显式本地删除）才可 confirmDeletion；denied/indeterminate 五行矩阵均保留草稿且不写 tombstone；confirmDeletion 单事务内 bump generation + 写 tombstone + 删除全 scope 草稿与 marker（含结构损坏行）；GC 在快照不可读时整体跳过，并在删除事务内重读 marker 引用与年龄。
- 会话不变量分离正确：superseded 回退把两条序号同时 Math.min 到已落盘值再 rematerialize，不会丢失最新视口；clean 判定只看文档序号；三条 localUi 序号进入 invariant context 以便区分文档与 UI 失序。

## 最危险的实施检查点（non-blocking guidance）

- Task 6 是唯一的协议切换提交，session/manager/types 同时改：建议在该提交内先跑 `src/services/canvas-sync` 再跑全量，任一 assertCounters 抛出都当作设计问题回看序号表，而不是就地放宽不变量。
- `enterTombstoned` 是 5 条以上路径的汇合点（upsertDraft/commitCoordination/readOpenSnapshot 的 tombstoned、外部删除、初始 resolution）：实现时确认它对 held、inflightRequest、disposePromise 的交互只做幂等收敛，不改 disposeReason。
- 假绿检查共 12 项（Task 1 两项、2/3/4 各一至两项、5 两项、6 六项、7 三项）：每一项都必须“改→观察变红→还原→复跑”，只提交还原态。其中 Task 6 的“把 MAX_COORDINATION_ATTEMPTS 降为 1”会同时命中三条用例，若只红一条说明另外两条的 stale 注入没生效。
- 三浏览器矩阵 10 行仍是人工门，fake-indexeddb 不可记入；Gate 0 未跑完三浏览器与用户自己的 web typecheck 之前不得声称关闭。
