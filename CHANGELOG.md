# Changelog

## Unreleased

### Added

- **有界 GCF 金牌配方**：`/oms:gcf` + skill `oms/gcf` — 对已有改动做独立 `#oms_critic` 挑刺 → Fix 对账；默认 maxRounds=3；无 open P0/P1 为 dry；撞帽 `hitCeiling` 诚实失败；可选完成门 evidence 文案，不自动过门。
- 契约测试 `test/test-gcf-recipe.mjs`。

## 0.4.0 — 2026-07-10

### Added

- **硬停交班包（handoff）**：`turnCount` 越过 hard 上限时，除完整体检外自动写入 `.snow/oms-state/handoff.json`（目标、stage、任务、轮次、gates/ledger 快照、git 锚点等）。写失败时硬停文案仍发出并标明交班不可用。
- **`/oms:resume` 两步续跑**：`oms-resume` preview（只读摘要 + 陈旧工作树警告）→ 用户确认后 confirm，恢复进度与完成门，**不恢复聊天**。
- **轮次重置（R6b）**：确认后续后 `turnCount=0`，soft/hard 恢复默认 50/200，文案写明新配额。
- **交班可跨 stop**：`oms-stop` / `deleteState` **保留** `handoff.json`，避免「接不上 vs 清光进度」二选一。

### Fixed / Hardened

- **会话绑定**：Path A（续活 live）仅当 handoff 与 live `sessionId` 一致；跨会话冲突拒绝，禁止外源 ledger 灌入新会话。
- **确认后消费 handoff**：成功 confirm 后删除 `handoff.json`，避免永久毒化后续会话。
- **过夜门 TTL**：续跑时 `refreshLedgerForResume` 刷新已批准门时间戳，避免 2h TTL 静默丢门。
- **Preview 信息完整**：展示 Confirm path、门 ok/missing、轮次快照、PRD/verify 要点（有则写入）。
- **Path B 清残留**：从 handoff 重建前先 `deleteState`（仍保留 handoff 直至消费完毕）；`done→executing` 重映射时作废 post-done 门。

### Docs / Tests

- README：`/oms:resume`、`oms-resume`、硬停 handoff 说明。
- `/oms:help`：补 resume 命令与 hard-stop 交班说明（本版本同步）。
- 新增 `test/test-handoff.mjs`、`test/test-resume.mjs`；计划文档 `docs/plans/2026-07-09-005-feat-hard-stop-handoff-resume-plan.md`。

## 0.3.0 — 2026-07-09

### Added

- **完成门禁 ledger**：task-complete / task-reconcile / code-quality / completion 多 scope 审批；`gatesRequired` 新会话默认开启；口头 done 拦截。
- **状态面板与诚实收口**：onStop 完整 STATUS、onUserMessage 缩略面板；软上限续命文案；硬停完整体检（不伪 done）。
- 控制面写保护：禁止 agent 直接改写 OMS state / verification-ledger。

### Fixed

- 严格 reviewer 去掉裸 `team:` 通配，堵住自签旁路。
- `isSelfReviewerId` 不再用 `startsWith('main')` 误伤 maintainability 等 id。
- code-quality scorecard 强制非空 `diffStat`。
- `canEnterDone` 单次读 ledger。
- 路径/终端拦截锚定真实 state 目录，避免误伤文档与只读命令。
- onStop 续跑指令与 STATUS 去重，降低每轮上下文重复。

### Docs

- README / `/oms:help` 补充完成门禁说明。
- 计划文档：completion gates、status panel、negative-optimization 修复。
