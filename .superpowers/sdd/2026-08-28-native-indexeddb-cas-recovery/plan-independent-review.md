# 原生 IndexedDB CAS 实施计划 — 独立对抗性计划验收（Acceptance round 1/2）

审查者：Kimi（未启动子代理，未修改计划/代码/提交）
范围：BASE af37bfa..HEAD f782940，计划 docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md（2652 行）全文逐行通读
依据：AGENTS.md、权威架构 spec §11/§16/§17（docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md）、旧 sync spec 顶部 superseded 声明、当前 web 侧 recovery/types/session/manager/repository/api/store/hooks/package.json 全文、server DELETE 契约、packages/contracts CanvasDeletionReceiptSchema

**结论：NOT APPROVED — Critical 3 / Important 4 / Minor 9**

三个 Critical 都是同一类问题：计划自己规定的测试/命令按计划原文执行就不可能通过。实施者将被迫现场重设计关键机制，这恰恰是计划评审要拦截的事。

## 我亲自执行的验证（非转述）

1. 用计划指定的同一版本 fake-indexeddb@6.2.5 在 /tmp/idb-probe 独立复刻了计划 Task 1 Step 6 的 run() 实现，并运行四个探针场景（结果引用在下文 C1）。
2. 核对服务端契约：server/src/modules/canvases/routes.ts:148-190 的 DELETE 以 response 200 = CanvasDeletionReceiptSchema 直接返回回执对象（无信封），与计划 Task 5 的 api 层假设一致。
3. 核对 web/src/services/api/platform-client.ts:59 使用 fetch 而非 axios，计划 Task 5 测试用 vi.stubGlobal("fetch") 成立；PlatformApiError 带 code/status（platform-client.ts:26-42），与计划的分类器一致。
4. 核对 bun.lock:2026 已锁 vitest 4.1.11（server 在用），fake-indexeddb@6.2.5 可安装且 IDBFactory/databases()/VersionError 语义实测正常。
5. 核对计划引用的全部文件路径与锚点：main.tsx:13 initAnalytics、project.tsx:531-536 viewport effect、canvas-save-status.tsx、canvas-delete-projects-dialog.tsx:24-33、zh-CN.ts:408 canvas.save 组、todo/pending-test 双语文件，均存在且与计划描述一致。
6. 探针确认：顺序 await txn.req() 的合法模式在 fake-indexeddb 下事务保持存活（read-modify-write 正确提交）；双连接同键竞写正确串行化（无丢失更新）；versionchange 关闭旧连接后 v1 打开 v2 库报 VersionError（计划 Task 1 测试 5 成立）。

---

## Critical

### C1. Task 1 的 deadline-abort 测试按计划原文必然失败，且它测试的正是计划自己禁止的模式

位置：计划行 223-237（测试）、行 366-410（run 实现的 deadline 分支）、行 423-427（fake-green 检查）、行 21（全局约束"事务内禁止 await 非 IndexedDB promise"）。

复现（我已实测，fake-indexeddb@6.2.5，逐字复刻计划的 run 实现）：

- 计划的测试场景：work 内 put 一条 epoch 记录，然后 await 一个永不解决的 Promise，deadline=0。
- 实测结果：run 解决为 { status: "failed", reason: "error" }——不是计划断言的 "timeout"；并且 readBack 读到了该记录——**事务已经提交，回滚没有发生**。
- 机理：await 非 IDB promise 期间请求队列排空，事务在 0ms 计时器触发前就已 auto-commit；deadline 分支调 transaction.abort() 对已结束事务抛 InvalidStateError（被 catch 吞掉），随后 oncomplete 以 produced=false 收场为 "error"。这与真实浏览器行为一致（规范：请求队列排空且控制权回到事件循环即提交），所以这不是 fake-indexeddb 的偏差。

为什么计划自身的验证捕获不到：Step 5 的"预期失败"只要求 import 解析失败；Step 7 的"run until green"会在这一测试上永久卡住，实施者只能绕过或改写。行 427 的 fake-green 检查（去掉 abort 后 readBack 断言应变红）同样不成立——带不带 abort，该场景下记录都会提交。

深层后果：该测试是"deadline 到期必须 abort 而非放任迟到提交"这一核心机制的唯一自动化证据。它当前采用的触发方式（await 永不解决的非 IDB promise）恰恰是全局约束行 21 禁止的模式，因此即使断言改对，它证明的也是"禁止模式下的行为"，而不是机制本身。

定向修复：把 deadline 测试改为合法模式下让事务在 deadline 时仍有在飞请求，例如 work 内先 put、再有界循环 await txn.req(get)（我实测：50ms deadline 下结果为 { status: "failed", reason: "timeout" } 且记录完整回滚——abort 路径真实有效）。循环必须有界（如 10 万次）以便 fake-green 检查（去掉 abort）时事务最终提交、readBack 断言如期变红。同时在计划里补一句机理说明：abort 只能回滚"deadline 时仍有在飞请求"的事务；work 卡死在非 IDB promise 上时事务会先 auto-commit，这正是禁止该模式的原因。

### C2. 纯视口变更永远无法落盘——计划未重写 materialize 的 editSeq 门，自己的会话测试因此必然失败

位置：计划行 2297-2312（update 拆分）、行 1844-1863（"treats pan and zoom as local UI… persisted in the envelope" 测试）；现行代码 web/src/services/canvas-sync/canvas-sync-session.ts:407-409（materialize 的门：materializedSeq >= editSeq 即返回）。

逻辑反例：

1. 计划的 update() 对纯 viewport patch：不增 editSeq（设计如此），只 scheduleLocal()。
2. scheduleLocal 120ms 后调 materialize()；计划全文（grep materialize/materializedSeq 仅命中测试注释，无任何重写）保留了现行门 `if (materializedSeq >= editSeq) return;`。
3. 纯平移时 editSeq=0、materializedSeq=0，0>=0 直接返回，pendingSlot 永远为空，drainLocal 无事可做——**localUi 永远不会被写入 drafts**。
4. 计划行 1860 的断言 snapshot.snapshot.drafts[0].envelope.localUi.viewport 在 drafts 为空时直接抛 TypeError。测试红在到达即失败，与实现质量无关。

为什么计划自身的验证捕获不到：该测试本就是捕获者，但计划没有给出能让它通过的实现机制。实施者必须现场发明第二种物化触发（如独立的 localUiSeq/dirty 标志并改 materialize 的门），而这会触碰 assertCounters 的序号不变量（savedSeq <= editSeq、persistedSeq <= materializedSeq）——会话最核心的排序不变量被临场改造，风险不受控。

定向修复：在 Task 6 明确引入 localUi 物化序号（例如 localUiSeq/materializedLocalUiSeq 对，或一个 localUiDirty 标志），重写 materialize 的门为"文档无新编辑且 localUi 无新变化才返回"，并在序号不变量清单中声明该计数器与 editSeq 的关系（不参与 savedSeq/clean 判定）。测试断言保持不变即可。

### C3. Task 6 的单例在计划自建的 Node 测试环境下 import 即 ReferenceError，manager 测试文件整体无法加载

位置：计划行 2449（recovery: createCanvasRecoveryStore(createRecoveryDatabase(indexedDB))）、行 287-291（vitest.config environment: "node"）、行 300-309（setup-indexeddb.ts 只导出 freshIndexedDB，不注入任何全局）。

逻辑反例：

1. canvas-sync-manager.ts 模块底部的 canvasSyncManager 单例初始化在模块求值时执行，indexedDB 是裸标识符。
2. 计划指定的测试环境是 Node（environment: "node"），Node 没有 indexedDB 全局，setup 文件也不 polyfill。
3. canvas-sync-manager.test.ts 第一行 import { createCanvasSyncManager } from "./canvas-sync-manager" → 模块求值 → ReferenceError: indexedDB is not defined → 整个测试文件加载失败。
4. Task 6 Step 7 的命令 vitest run src/services/canvas-sync 因此不可能全绿。

为什么计划自身的验证捕获不到：Task 6 的所有测试都写在"先红后绿"框架里，但这个红是环境性 ReferenceError，与功能无关，实施者无法区分"还没实现"与"入口坏了"。

定向修复：把行 2449 改为 createRecoveryDatabase(globalThis.indexedDB)（Node 下求值为 undefined，工厂惰性、不会被调用；浏览器下正常），或改为惰性访问器。顺带在 Task 6 的验收标准里加一条：管理器测试文件必须能在无任何 ambient indexedDB 的 Node 环境下加载。

---

## Important

### I1. 平移后的下一次云端保存会把实时视口写进共享 defaultViewport，违反 spec §16

spec 行 604 明确要求："平移后编辑节点仍保持服务端 defaultViewport；显式「设为默认视图」才增加文档 revision"。

计划行 2302 在平移时执行 content = { ...content, viewport: nextViewport }，而网络保存路径 ensureSnapshot() → projectToSnapshot(content)（web/src/lib/canvas/canvas-snapshot.ts:100 的 viewport: project.viewport）会把这个实时视口序列化进云端快照。即：用户平移后再编辑一次节点并触发保存，服务端共享视口被悄悄改写，其他设备/标签重开时看到的默认视图变了——没有任何"显式设为默认视图"动作。

计划的自审表把视口决策映射到 Task 2/6/7，但三个任务都没有冻结"文档视口的序列化来源"。计划自己的测试也只断言"纯平移不发保存"，没有覆盖"平移后编辑的保存内容不含新视口"。

定向修复：Task 6 增加一个会话级 defaultViewport（打开时取自 load.project.viewport，只能被未来的显式动作改写），云端序列化与 envelope.document.snapshot 一律使用该值；本地实时视口只进 localUi。补一条测试：平移→编辑→保存，断言请求体 snapshot.viewport 仍为打开时的值。

### I2. "tombstoned" 进入 CanvasSyncPhase 但未进入事件白名单，dispose/flush 必然走不变量事故路径

计划行 1745 把 "tombstoned" 加进 resolution phase 联合类型，行 2140 加进 CanvasSyncPhase，行 2183 的 resolve 在 tombstoned 时返回 phase: "tombstoned"。install() 会把它赋给会话 phase（现行 canvas-sync-session.ts:307 的 phase = resolution.phase 逻辑按计划保留）。但现行 ALLOWED_PHASES（canvas-sync-session.ts:180-194）没有任何一行包含 "tombstoned"，计划全文也未更新该表（grep ALLOWED_PHASES 零命中）。

后果：tombstoned 会话的 dispose() 直接 assertEvent 抛 CanvasSyncInvariantError → guard 吞掉 → enterInvariant → phase 变 "save-error"、saveError=invariant——与计划想要的 controlled-unavailable（unavailableKey = "canvas.recovery.tombstoned"）完全相反。flush() 同理（计划行 2289 的 update 有 tombstoned 标志挡着，但 flush/dispose 没有）。

为什么计划自身的验证捕获不到：计划中所有 tombstoned 用例（行 1887-1903、manager 测试）走的都是"tombstoned 标志 + localPersist"路径，phase 保持原值；没有任何测试安装一个 resolution.phase === "tombstoned" 的会话再 dispose。（该路径在 account scope 下也确实难触发——服务端 404 会先到——但计划把它立为一等阶段，就把一等地雷埋下了。）

定向修复：ALLOWED_PHASES 的 dispose/flush/hold 行加入 "tombstoned"；或在 prepare 层把 tombstoned resolution 映射为不创建正常会话的受控不可用结果。二选一，写进 Task 6。

### I3. clearConflictDrafts 对 stale 一次性放弃，已被用户解决的冲突草稿会在下次打开时复活

计划行 2396-2410：接受服务端版本后的清理由"读快照 → 以读到的 epoch 做一次 commitCoordination"组成。若另一标签在读与提交之间推进了 coordinationRevision，CAS 返回 stale，函数直接返回——冲突草稿与 marker 原样保留。下次打开该画布时 resolve 会把它们重新升级为冲突呈现给用户：用户已经显式解决过的冲突又回来了。

这与计划自己在会话侧确立的规则不一致（行 2360-2384：runRecoveryRepairs 遇 stale 必须 re-resolve，绝不强制执行），spec §17 Gate 2 也要求"载入服务端版本会按 coordination CAS 删除同一画布的共享本地冲突草稿"——是删除，不是"尝试一次"。

为什么计划自身的验证捕获不到：manager 测试"clears conflict drafts on accept-server-version…"（行 1985-2011）无并发推进，走的是一次成功路径。

定向修复：给 clearConflictDrafts 加有界的"重读-重试"循环（如最多 2 次），或在 stale 时显式记录并把清理推迟到下次打开；同时补一条"两次清理之间另一标签推进 coordination"的测试。

### I4. 活体 409 冲突写、retryRecovery、exportConflictDrafts 的旧实现被删除，但 CAS 替代体未被规定、无测试钉住

计划 Task 6 Step 5.1（行 2163-2165）删除 trackLocal/trackWrite/inFlightLocal 等，现行 onSaveConflict → persistConflictRecords（canvas-sync-session.ts:644-673，读改写 marker、保旧条目、封顶 2 条）、retryRecovery（:692-745，外来 pending 草稿提升为条目）、exportConflictDrafts（:748-761，readMarker + readDraftByKey）依赖的存储接口整体消失，而计划全文对这三条路径的新 CAS 实现只字未提（grep onSaveConflict/persistConflictRecords/retryRecovery 在计划中零命中；exportConflictDrafts 仅在行 1916 的测试断言里出现一次）。

这三条正是 spec §16 点名要穿过 Session/Manager 的路径（"双标签冲突保留两份入口"、"未知 marker 所有权时跳过 GC"的会话侧、冲突导出）。实施者将临场决定：活体 409 用哪个 expected  revision 提交 marker CAS、stale 时怎么办、导出改用 readOpenSnapshot 后如何过滤——全是正确性敏感决策。

定向修复：在 Task 6 补三条最小语义规定（活体 409：以会话当前 epoch 提交 commitCoordination(marker=[own, ...validExisting])，stale 则 re-resolve；retryRecovery：同一 CAS，失败不解锁；导出：readOpenSnapshot + 排除自身 draftId），并各补一条测试，其中"双标签各写一条 marker 条目后两份都在"必须有确定性用例。

---

## Minor（不阻断，供实施时一并处理）

1. 计划行 2415-2422 confirmLocalDeletion：注释说"Unreadable: retry on the next confirmed delete, never guess"，代码却在 unavailable 时以 expected=0 继续调用 confirmDeletion。行为本身安全（CAS 在事务内重读），是注释与代码矛盾，改注释或提前 return 二选一。
2. 计划行 45-60 的 Replaced/Deleted 表把 CanvasLocalWrite/whenLocalSettled/deleteMarkerIfOwned/CanvasDraftScope 标为"Removed in Task 5"，但 Task 5 的步骤并不碰它们，真正删除在 Task 6 Step 4（行 2130-2133）。表格与任务边界矛盾，易误导任务级审查。
3. 计数笔误：行 1456"5 files, 36 passed"实为 6 个文件；行 2571"8 files, 59 passed"实为 9 个文件（database/scope/types/store-draft/store-coordination/bootstrap/repository/session/manager）。59 的总数本身正确。
4. types.ts 的 asEpoch 校验失败即返回 null，store 的 readEpoch 把 null 折叠为 initialEpoch——一条损坏的 tombstoned epoch 会被当作全新 scope，迟到写可复活画布。实际被服务端 404 挡住、影响有界，但与计划其他位置的 fail-closed 姿态不一致；建议损坏的 epoch 行按 unavailable 处理。
5. Task 1 缺依赖安装步骤：全新 worktree 下 ../node_modules/.bin/vitest 不存在，Step 5 的命令会以 command not found 告终；补一步 bun install。
6. 计划行 2390-2393 scopeIdFor 返回 null 时 prepare 的行为没有命名结果（cancelled/failed/降级？）。当前 ID 字母表下实际不可达，但"拒绝行动"的契约应有名字。
7. spec §16"双标签冲突保留两份入口"只被存储层 CAS 覆盖；行 1916 的会话测试只种一条外来草稿、断言导出长度 > 0，未真正钉住"两份"。并入 I4 修复即可。
8. spec §11 说"Gate 0 只使用 local scope"，计划实际只接线 account scope（合理：身份已先于 Gate 0 落地），但计划未声明这一偏离；readInstallationId 在本地画布存在前是死代码。各加一句说明即可。
9. AGENTS.md"前端业务数据默认使用 localforage"与新恢复层冲突，计划的文档任务未包含更新 AGENTS.md；按其"反复提醒沉淀"条款应补一条例外规则。

---

## 已验证为成立的部分（供后续轮次聚焦）

- Task 5 删除回执否定矩阵与服务端契约端到端连通：DELETE 返回裸回执对象、fetch 可 stub、PlatformApiError 的 code/status 与分类器逐项吻合；receipt.canvasId 匹配逻辑正确。
- 写入/协调/删除三层 CAS 的语义设计本身成立，探针证实其依赖的底层行为（顺序 await 存活、双连接串行化、versionchange 关闭、VersionError）在 fake-indexeddb@6.2.5 下全部为真。
- 任务拆分无双协议：Task 1-4 纯新增、Task 5 只收窄删除认定、Task 6 单提交切换、Task 7 删除遗留模块，任何中间提交可部署。
- 文件路径、i18n 锚点、文档落点、vitest 版本锁定全部与仓库现状一致。

## 复验范围建议（round 2/2）

修复提交后，复验只需覆盖：C1 的新 deadline 测试形态（有界请求循环 + fake-green 检查重新成立）、C2 的 localUi 物化机制与序号不变量声明、C3 的单例改法、I1 的 defaultViewport 冻结与测试、I2 的事件白名单、I3 的有界重试、I4 的三条路径语义与测试。Minor 可在同一提交顺手处理，不单独设验。
