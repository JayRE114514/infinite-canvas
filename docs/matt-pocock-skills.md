# Matt Pocock 技能使用说明

本项目只使用用户级全局安装的正式技能包，仓库不复制第三方 `SKILL.md` 或其辅助资源。`AGENTS.md` 始终是权限、测试范围、实现/验收分工和外部状态变更的权威来源；技能只能帮助执行这些规则，不能覆盖它们。

## 项目内配套

- `.scratch/<feature-slug>/`：本地规格、ticket 和测试证据，不提交 Git。
- `CONTEXT.md`：稳定领域词汇。
- `docs/adr/`：难以逆转且已经批准的架构决策。
- `docs/agents/`：tracker、triage 和领域文档的路由约定。

## 自动触发边界

| 技能 | 使用时机 |
| --- | --- |
| `engineering-core` | 根因不确定、公共边界、并发写入、高风险集成或结论需要证据时 |
| `grilling` | 关键需求或设计仍不清晰时；总结决定与未决项后等待用户确认 |
| `domain-modeling` | 新增或修改领域术语、`CONTEXT.md` 或 ADR 时 |
| `codebase-design` | 设计公共接口、模块边界、所有权或一致性接缝时 |
| `diagnosing-bugs` | 困难、间歇性或性能故障且根因未知时 |
| `writing-for-agents` | 创建或修改 `AGENTS.md`、技能说明或 Agent 路由文档时 |
| `tdd` | 多个切片已经形成可运行里程碑，需要补齐集成行为缺口时 |
| `code-review` | 里程碑测试完成并固定 diff 与证据后 |

其他 Matt 技能只能由用户以 `$skill-name` 明确调用。普通局部切片由主 Agent 直接处理，不为了流程完整而串行调用整套技能。

## 调用示例

- “用 `$grilling` 压测这个积分结算方案”：先澄清不变量和未决选择，用户确认后才实施。
- “更新 Provider Adapter 的领域术语”：读取 `CONTEXT.md` 和相关 ADR，必要时使用 `domain-modeling`。
- “多个恢复切片已经集成，进入里程碑验收”：使用 `tdd` 运行受影响功能集，再由一个 Opus 或 Kimi 子代理使用 `code-review` 验收固定 diff；阻断修复后最多复验一次。
- “普通按钮文案修复”：直接修改并运行一个最小定向功能测试，不自动扩展为全量红绿或独立审查。

## 维护

全局技能升级、增删或改名后，只更新本文件的路由说明和 `AGENTS.md` 中的允许列表；不要把技能源码复制进项目。若技能说明与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准并修正文档。外部 issue、提交、合并、关闭 PR 或发布仍需遵守当前用户授权。
