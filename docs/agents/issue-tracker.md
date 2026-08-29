# Issue tracker：本地 Markdown

本工作树的 Agent 规格和实现 tickets 使用 `.scratch/` 下的本地 Markdown，不自动创建或修改外部 issue。

- 每项工作使用 `.scratch/<feature-slug>/`。
- 规格写入 `spec.md`，实现 ticket 写入 `issues/<NN>-<slug>.md`。
- `Status:` 表示当前状态，`Blocked by:` 表示依赖；被未完成 ticket 阻塞时不得开始。
- `ready-for-agent` 表示边界已明确，`claimed` 表示正在处理，`resolved` 表示已完成。
- `.scratch/` 被 Git 忽略；里程碑完成独立验收后，再按 `AGENTS.md` 更新正式 todo、pending-test 和 CHANGELOG。
