# Changelog

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
