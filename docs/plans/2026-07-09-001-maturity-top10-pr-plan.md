---
title: "Maturity Top-10: 可执行 PR 计划"
date: 2026-07-09
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: maturity audit 2026-07-09 (ce-code-review full-product)
---

# Maturity Top-10: 可执行 PR 计划

## Goal Capsule

- **Objective:** 将产品级成熟度审计的 Top 10 落地为可独立合并的 PR 栈，优先堵住「验证静默失败 / 门禁失效 / skill 桥接断裂」，再补安装可观测性与 CI。
- **Authority:** 本计划 > 审计报告中的 severity 排序；冲突时以「验证门与 stage 承诺是否对用户诚实」为准。
- **Stop conditions:** 全部 U1–U8 合并、Verification Contract 命令全绿、Definition of Done 勾选完毕。不得在未解决 P0（U1–U3）时开启 CI-only 或 docs-only 收尾。
- **Execution profile:** 以 PR 栈实现；每个 U 对应 1 个可 merge 的 PR（U6 可与 U5 同 PR 若体积小）。优先 characterization/回归测试，再改行为。
- **Out of scope for this goal:** allowlist 式 verify（可选后续）、多角色 reviewer 身份绑定、拆分 `mcp-server.ts`/`store.ts` 巨型文件、完整 i18n 迁移。

## Product Contract

### Summary

oh-my-snow 已具备可用的编排闭环（状态机 + MCP + PRD + 18 agents），但审计显示若干产品承诺与实现不一致：onStop 宿主超时短于 verify、verify 允许 `||` 静默绿灯、skill 桥接到不存在的 `oms/auto`/`oms/team`、planning 阶段仍可 shell 写盘、Ralph 入口命名混乱、agent 工具/幻影引用、installer 覆盖风险、无 doctor、无 CI。本计划按 Top 10 分 PR 修齐，使插件达到「0.x 可信」门槛。

### Problem Frame

- **Who:** Snow CLI 用户、自主 agent、维护者
- **What breaks:** 验证被宿主砍掉后 fail-open；`npm test || true` 永远绿；interview/dive 无法桥接到执行；用户以为 planning 不能改代码但 shell 可以；文档/skill 指向错误命令；setup 损坏用户 hook/skill 自定义；装完无法自检；无 CI 护栏
- **Why now:** 成熟度审计综合 ~65/100，P0 不修则「自驾可靠」叙事不可对外承诺

### Requirements

- R1. onStop 宿主 timeout 必须严格大于 verify 的 `execSync` timeout（含缓冲），setup 安装后用户环境生效。
- R2. `validateVerifyCommand` 与 `hooks/on-stop.mjs` 执行前 denylist 必须拒绝 `||`；`&&` 仍允许；双实现保持锁步并有共享回归测试。
- R3. `assets/skills/oms/interview` 与 `dive`（及任何引用处）不得 `skill-execute oms/auto` 或 `oms/team`；桥接改为真实 command/MCP 路径（`/oms:auto`、`/oms:team`、`oms-start` 流程描述）。
- R4. `beforeToolCall` 在 `planning` 与 `verifying` 阶段阻止 `terminal-execute`（与 filesystem 写拦截对齐）；`executing` 允许；`done` 保持现有拦截。
- R5. 所有 skill/README/help 文案统一：Ralph 入口为 `/oms:goal`（加载 `oms/ralph` skill）；禁止误导性 `/oms:ralph` 命令名（除非未来真正增加该 command）。
- R6. `oms_optimizer` 的 tools 与 Role 一致：要么获得 filesystem 写工具，要么 Role 明确「仅建议不落地」；删除 `#oms_debugger` 幻影引用。
- R7. installer：损坏的现有 hook JSON 不得静默抹成仅 OMS 规则；skills/commands 覆盖前应有可关闭备份或明确 warn。
- R8. 有活跃/损坏/过期 OMS state 时，hooks 关键路径不得静默 fail-open 到「等同无会话放行写操作」而不留 agent 可见信号（至少 stderr + errors.log）。
- R9. 提供 `oms doctor`（及可选 `oms version`）：检查 MCP 注册、hooks 超时与路径、agents 数量、skills 目录、关键绝对路径是否存在。
- R10. 增加最小 CI（lint/build/test）与 setup 契约测试（含 onStop timeout ≥ verify timeout、skill 桥接无悬空）。

### Actors

- A1. End user（安装/运行 OMS）
- A2. Autonomous agent（受 hooks + MCP 约束）
- A3. Maintainer（合并 PR / 发布 npm）

### Key Flows

- F1. Auto-verify after edit
  - **Trigger:** executing 阶段文件写成功 → afterToolCall marker → onStop runVerification
  - **Covered by:** R1, R2, R8
- F2. Interview/dive → execute bridge
  - **Trigger:** skill Phase 5 用户选择自动执行
  - **Covered by:** R3, R5
- F3. Planning stage discipline
  - **Trigger:** agent 尝试 terminal-execute 改文件
  - **Covered by:** R4
- F4. Post-install health
  - **Trigger:** `oms setup` 后 `oms doctor`
  - **Covered by:** R7, R9, R10

### Acceptance Examples

- AE1. Covers R1 — Given installed onStop hook timeout was 120s and verify is 300s, When this plan ships, Then installed/asset onStop timeout ≥ verify timeout + buffer and a test fails if they regress.
- AE2. Covers R2 — Given `validateVerifyCommand("npm test || true")`, When called, Then throws; `npm run build && npm test` still allowed.
- AE3. Covers R3 — Given repo grep for `skill-execute` + `oms/auto`, When plan done, Then zero matches under `assets/skills`.
- AE4. Covers R4 — Given stage=planning and tool=terminal-execute, When beforeToolCall runs, Then blocked with actionable OMS message.
- AE5. Covers R9 — Given broken MCP path after nvm move, When `oms doctor`, Then non-zero exit and names the broken path.

### Success Criteria

- Top 10 审计项均有对应 U 与测试/契约证明
- `npm test` 全绿；CI workflow 在默认分支可运行
- README 对 goal/ralph、hooks 路径、skills 清单与实现一致

### Scope Boundaries

**In scope:** Top 10 列表中的行为修复、文档对齐、最小 doctor、最小 CI、相关测试。

**Deferred for later:**

- verify 完整 allowlist / `shell:false` argv
- PRD multi-agent identity-bound approval
- 拆分巨型 `store.ts` / `mcp-server.ts`
- 完整 installer i18n
- text-bypass 高精度重写

**Outside identity:** 改变 Snow CLI 宿主 hook 协议本身；重做 OMC 对标 skill 深度。

### Sources

- Maturity audit run `maturity-20260709-162816-381c48`（installer/hooks/mcp/agents/skills/product 六面）
- Prior branch hardening on `fix/oms-verify-and-state-hardening`
- Product Contract preservation: bootstrap from audit Top 10 — no separate brainstorm file

## Planning Contract

### Key Technical Decisions

- KTD1. **onStop timeout 源 of truth:** 在 `assets/hooks/onStop.json` 将 `timeout` 设为 **330000**（300s verify + 30s 缓冲）。在 `hooks/on-stop.mjs` 将 verify timeout 提升为命名常量 `VERIFY_TIMEOUT_MS = 300000`，并在注释与测试中锁定 `HOST_TIMEOUT >= VERIFY + BUFFER` 关系。不在 installer 里硬编码第二份数字，避免三处漂移；若 installer 改写 hook JSON，必须保留 timeout 字段。
- KTD2. **禁 `||` 不禁 `&&`:** `cmd.includes('||')`（或等价）在 store 与 on-stop 同时拒绝。保留 `|` 与 `&&` 的既有产品 UX；`|` 残差记入 residual risk，不在本计划扩大为 allowlist 工程。
- KTD3. **Skill 桥接策略:** 不新增 `oms/auto`/`oms/team` skill 文件。将桥接文案改为「调用 slash command `/oms:auto` / `/oms:team`」或「直接按 command prompt 启动 `oms-start`…」。避免假 skill 名进入 `skill-execute`。
- KTD4. **Terminal stage policy:** `planning` 与 `verifying` 硬拦 `terminal-execute`；与 marketing「非 executing 不能改」对齐。`executing` 全开。不做 shell 写意图启发式（过脆）。
- KTD5. **Ralph 命名:** 保留已发布 command 名 `oms:goal`；skill 目录保持 `oms/ralph`。全仓文案把「用户输入」写成 `/oms:goal`，把「skill 加载」写成 `skill-execute oms/ralph`。
- KTD6. **Optimizer tools:** 采用 **补 filesystem-create/edit/replaceedit**（与 migrator/backend 同类 executor），因 Success Criteria 要求落地优化并验证前后测量；纯建议路径会削弱 agent 价值。
- KTD7. **Installer hook corrupt:** parse 失败 → 打印错误、**跳过该 hook 文件的 merge**（或 abort setup 并 isError），绝不 `writeFile` 仅含 OMS 规则。skills：覆盖前将现有目录 rename 到 `~/.snow/skills/oms.bak-<timestamp>`（可文档说明；保留最近 1 份即可）。
- KTD8. **Fail-open 收紧（有限）:** 本计划不改「无 state 时 fail-open 以不挡非 OMS 使用」的全局哲学；但当 `inspectStateFile()` 为 `corrupt` 或 `expired` 时，`beforeToolCall` 对 **写工具** fail-closed（block），并 stderr 输出可操作信息。纯无文件仍 exit 0。
- KTD9. **Doctor:** 子命令 `oms doctor` 只读检查，exit 0=健康，1=发现问题。检查项：package 可解析、MCP settings 含 oms、四个 hook 文件存在且 onStop.timeout≥330000、agents 含 18 个 `oms_*`、skills 10 个目录、hook command 路径 existsSync。
- KTD10. **CI:** 添加 `.github/workflows/ci.yml`：Node 20、`npm ci`、`npm run build`、`npm test`。不做矩阵多 OS 首版（Windows 本地仍靠维护者）；契约测试用纯 node 不依赖全局 install 路径。

### Assumptions

- Snow CLI 会尊重 hook JSON 的 `timeout` 字段（现网已使用）。
- 用户可接受 `||` 被拒；若有人用 `cmd1 || cmd2` 做 fallback verify，需改为两个 session 或 `&&` 链。
- planning 拦 terminal 会迫使 agent 用 read-only 工具做探测（符合设计）。

### Sequencing / PR stack

```text
U1 (timeout) ─┐
U2 (|| ban)  ─┼─→ U4 (terminal) ─→ U8 (fail-open) ─┐
U3 (bridges) ─┘                                     ├─→ U9 (doctor) ─→ U10 (CI)
U5 (naming/docs) ───────────────────────────────────┤
U6 (agents tools) ──────────────────────────────────┤
U7 (installer) ─────────────────────────────────────┘
```

- **PR 栈建议顺序:** U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8 → U9 → U10
- U1–U3 可并行开发但合并顺序按上图；U10 最后以锁死契约测试为准。

### Research breadcrumbs

- `assets/hooks/onStop.json` timeout 120000 vs `hooks/on-stop.mjs` execSync 300000
- Dual denylist: `src/state/store.ts` `validateVerifyCommand` + `hooks/on-stop.mjs`
- Bridge hits: `assets/skills/oms/interview/SKILL.md`, `dive/SKILL.md`, `plan/SKILL.md`
- Stage gate: `hooks/before-tool-call.mjs` TERMINAL_TOOLS only blocks `done`
- Agents: `assets/agents/sub-agents.json`, `scripts/gen-sub-agents.mjs`
- Installer skills wipe: `src/installer.ts` setupSkills ~L339
- Tests patterns: `test/test-verify-hardening.mjs`, `test/test-v2-hooks.mjs`, `test/test-installer.mjs`

## Implementation Units

### Unit Index

| U-ID | Title | Primary files | Depends-on |
|------|-------|---------------|------------|
| U1 | onStop/host verify timeout lockstep | `assets/hooks/onStop.json`, `hooks/on-stop.mjs`, `test/*` | — |
| U2 | Ban `||` in verify denylist | `src/state/store.ts`, `hooks/on-stop.mjs`, `test/test-verify-hardening.mjs` | — |
| U3 | Fix skill bridges (no oms/auto|team) | `assets/skills/oms/**/SKILL.md` | — |
| U4 | Block terminal in planning/verifying | `hooks/before-tool-call.mjs`, `test/test-v2-hooks.mjs` | — |
| U5 | Ralph naming + README/help truth | `README.md`, `assets/skills/**`, `src/i18n/**` | U3 |
| U6 | Optimizer tools + drop debugger phantom | `assets/agents/sub-agents.json`, `scripts/gen-sub-agents.mjs` | — |
| U7 | Installer safe hooks + skill backup | `src/installer.ts`, `test/test-installer.mjs` | — |
| U8 | Corrupt/expired state fail-closed writes | `hooks/before-tool-call.mjs`, `hooks/lib/oms-state.mjs`, tests | U4 |
| U9 | `oms doctor` (+ version) | `src/installer.ts`, `src/i18n/**`, tests | U1, U7 |
| U10 | CI + contract tests | `.github/workflows/ci.yml`, `test/test-maturity-contracts.mjs` | U1–U9 |

### U1. onStop/host verify timeout lockstep

- **Goal:** 消除宿主 120s 砍掉 300s verify 导致的静默失败。
- **Requirements:** R1, AE1
- **Files:** `assets/hooks/onStop.json`, `hooks/on-stop.mjs`, `test/test-maturity-contracts.mjs`（新建，本 U 写入 timeout 断言；U10 扩展）
- **Approach:** 设 host timeout=330000；verify 用命名常量 300000；注释写明不等式；契约测试读 JSON 与常量（或正则抽常量）断言 `host >= verify + 30000`。确认 installer 合并 hook 时不覆盖/删除 timeout。
- **Test scenarios:**
  1. Asset onStop.json timeout is 330000
  2. Contract: host timeout - verify timeout >= 30000
  3. Existing v2-hooks verify failure paths still pass
- **Verification:** `node test/test-maturity-contracts.mjs`（或暂挂在 verify-hardening）+ 相关 hook tests
- **PR:** `fix/maturity-u1-onstop-timeout`

### U2. Ban `||` in verify denylist

- **Goal:** 阻止 `npm test || true` 类静默绿灯。
- **Requirements:** R2, AE2
- **Files:** `src/state/store.ts`, `hooks/on-stop.mjs`, `test/test-verify-hardening.mjs`, MCP describe 文案若提及 allowed ops
- **Approach:** store 与 on-stop 同步增加 `||` 拒绝；错误文案列出 Blocked: `||`；测试 reject/allow 矩阵扩展。
- **Test scenarios:**
  1. Reject `npm test || true`
  2. Reject `a||b`
  3. Allow `a && b`
  4. Allow `npm test` and current pipe cases (until future ban)
- **Verification:** `npm run build && node test/test-verify-hardening.mjs`
- **PR:** `fix/maturity-u2-ban-or-or`

### U3. Fix skill bridges (no oms/auto|team)

- **Goal:** interview/dive 执行桥接指向真实入口。
- **Requirements:** R3, AE3
- **Files:** `assets/skills/oms/interview/SKILL.md`, `assets/skills/oms/dive/SKILL.md`, `assets/skills/oms/plan/SKILL.md`（若仍写 `/oms:ralph` 作命令）, 全 `assets/skills` grep 清理
- **Approach:** 替换所有 `skill-execute { skill: "oms/auto"|"oms/team" }` 为明确步骤：提示用户/agent 调用 `/oms:auto`、`/oms:team`，或展开等价 `oms-start` → … 序列。表格 Tools 节同步。
- **Test scenarios:**
  1. Contract grep: zero `oms/auto` / `oms/team` as skill-execute targets under assets/skills
  2. Manual doc skim: Phase 5 still has an actionable execute path
- **Verification:** `node test/test-maturity-contracts.mjs` bridge assertions
- **PR:** `fix/maturity-u3-skill-bridges`

### U4. Block terminal in planning/verifying

- **Goal:** stage 门禁覆盖 shell 写面。
- **Requirements:** R4, AE4
- **Files:** `hooks/before-tool-call.mjs`, `test/test-v2-hooks.mjs`（或 `test-hooks.mjs`）
- **Approach:** TERMINAL_TOOLS 分支：planning/verifying → block + 可操作 reason；executing → allow；done → 保持 block。
- **Test scenarios:**
  1. planning + terminal-execute → blocked
  2. verifying + terminal-execute → blocked
  3. executing + terminal-execute → allowed
  4. done + terminal-execute → blocked
  5. planning + filesystem-read → allowed
- **Verification:** `node test/test-v2-hooks.mjs`
- **PR:** `fix/maturity-u4-terminal-stage-gate`

### U5. Ralph naming + README/help truth

- **Goal:** 消除 `/oms:ralph` 幻影命令与 README 漂移。
- **Requirements:** R5
- **Files:** `README.md`, `assets/skills/oms/**/SKILL.md`, `src/i18n/lang/en.ts`, `zh.ts`, `zh-TW.ts`, `assets/commands/oms/help.json`（若有）
- **Approach:** 全局替换用户向 `/oms:ralph` → `/oms:goal`；说明 skill 名为 `oms/ralph`。README 补 skills 表 plan/ralph；修正 goal 描述为 Ralph 持久循环而非「goal artifact」。修正 help 中 10+8 command 分类若仍错误。
- **Test scenarios:**
  1. Contract: no `/oms:ralph` as slash command in assets/commands
  2. README lists 10 skills including plan and ralph
  3. goal.json still loads `oms/ralph`
- **Verification:** maturity contracts + 人工扫 README 命令表
- **PR:** `fix/maturity-u5-naming-docs`

### U6. Optimizer tools + drop debugger phantom

- **Goal:** agent 工具与 role 一致、无幻影 agent。
- **Requirements:** R6
- **Files:** `assets/agents/sub-agents.json`, `scripts/gen-sub-agents.mjs`（若 gen 是源，先改 gen 再生成；否则双改并加注释约定源 of truth）
- **Approach:** optimizer 增加 filesystem-create/edit/replaceedit；将 `#oms_debugger` 改为现有 agent（如 `#oms_critic` / `#oms_trace` 模式或 `#oms_reviewer`）。若 gen 脚本是权威源，跑 gen 更新 JSON。
- **Test scenarios:**
  1. optimizer.tools includes at least one filesystem write tool
  2. grep agents JSON: zero `oms_debugger`
  3. agents length still 18；ids 稳定
- **Verification:** node assert on JSON + optional gen golden later in U10
- **PR:** `fix/maturity-u6-agent-tools`

### U7. Installer safe hooks + skill backup

- **Goal:** setup 不静默毁掉用户 hook/skill 自定义。
- **Requirements:** R7
- **Files:** `src/installer.ts`, `test/test-installer.mjs`, i18n 新字符串
- **Approach:** hook merge：JSON.parse 失败 → warn + skip file（保留原文件）。skills：rm 前 rename 到 `.bak-<iso>`，并 console 提示路径。commands 同步策略（至少 backup 一次）。
- **Test scenarios:**
  1. Corrupt existing hook file is left intact and setup reports warning
  2. Pre-existing skills dir is renamed to bak before copy
  3. Fresh setup still installs 10 skills / merges hooks
- **Verification:** `npm run build && node test/test-installer.mjs`
- **PR:** `fix/maturity-u7-installer-safe-merge`

### U8. Corrupt/expired state fail-closed writes

- **Goal:** 僵尸/损坏会话不能静默允许写。
- **Requirements:** R8
- **Files:** `hooks/before-tool-call.mjs`, `hooks/lib/oms-state.mjs`（inspectStateFile）, `test/test-state-expire.mjs` 或 v2-hooks
- **Approach:** loadState null 时调用 inspectStateFile；corrupt/expired + 写工具 → block；无文件 → 仍 allow。stderr 区分 EXPIRED vs CORRUPT。
- **Test scenarios:**
  1. expired state + filesystem-edit → blocked
  2. corrupt state + filesystem-edit → blocked
  3. no state file + filesystem-edit → allowed
  4. active executing + filesystem-edit → allowed
- **Verification:** state-expire + v2-hooks tests
- **PR:** `fix/maturity-u8-state-fail-closed`

### U9. `oms doctor` (+ version)

- **Goal:** 装后可自检。
- **Requirements:** R9, AE5
- **Files:** `src/installer.ts`, `src/i18n/lang/*.ts`, `test/test-doctor.mjs`（新建）
- **Approach:** CLI case `doctor` / `version`。doctor 聚合检查项列表，打印 OK/FAIL 行，任一 FAIL → exit 1。version 打印 package.json version + resolved packageDir。
- **Test scenarios:**
  1. doctor exit 0 on healthy fixture HOME
  2. doctor exit 1 when onStop timeout too low（fixture）
  3. doctor exit 1 when MCP entry missing
  4. version prints semver
- **Verification:** `node test/test-doctor.mjs`
- **PR:** `fix/maturity-u9-doctor`

### U10. CI + maturity contract tests

- **Goal:** 主分支自动守卫 Top 10 不回退。
- **Requirements:** R10
- **Files:** `.github/workflows/ci.yml`, `test/test-maturity-contracts.mjs`, `package.json` test script 串联
- **Approach:** CI：ubuntu-latest, node 20, npm ci, build, test。Contracts：timeout 不等式、禁 skill-execute oms/auto|team、optimizer 写工具、无 oms_debugger、denylist 含 `||` 拒绝用例（可调用 store API）。移除/改写 `test-direct-invocation` 对单机全局路径的硬依赖（若仍阻塞 CI）。
- **Test scenarios:**
  1. CI workflow file validates with actionlint-or-manual schema sanity
  2. maturity contracts cover R1–R6 static assertions
  3. Full `npm test` green locally mirrors CI
- **Verification:** `npm test`；推送后 CI 绿
- **PR:** `fix/maturity-u10-ci-contracts`

## Verification Contract

| Gate | Command / check |
|------|-----------------|
| Build | `npm run build` |
| Unit/integration | `npm test` |
| Hardening | `node test/test-verify-hardening.mjs` |
| Hooks | `node test/test-v2-hooks.mjs` |
| Installer | `node test/test-installer.mjs` |
| Contracts | `node test/test-maturity-contracts.mjs` |
| Doctor | `node test/test-doctor.mjs`（U9 后） |
| Static | grep: no `skill-execute` targets `oms/auto` or `oms/team` under `assets/skills` |
| Release | `prepublishOnly` 继续 build+test；U10 后依赖 CI 同命令 |

## Definition of Done

### Global

- [ ] U1–U10 均已实现并合并（或等价单 PR 含全部且可审查）
- [ ] `npm run build && npm test` 全绿
- [ ] AE1–AE5 可演示
- [ ] README 与 help 对 goal/ralph、hooks 全局安装、10 skills 描述正确
- [ ] 无死代码/半截 TODO；abandoned 实验路径已删
- [ ] 每个 PR 信息遵循仓库中文 commit 约定：`类型: 描述`

### Per-unit

- 各 U 的 Test scenarios 有对应自动化测试或契约断言
- 行为变更有 agent 可见错误文案（中英文可沿用现有 i18n 模式）

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 拦 planning terminal 破坏依赖 shell 的探测工作流 | 文案引导用 codebase-search/filesystem-read；必要时 executing 再跑命令 |
| 禁 `||` 破坏现有用户 verifyCommand | 错误信息给出改写示例；release note 写 breaking |
| skill backup 占盘 | 只保留一份 bak；文档说明可删 |
| CI 无 Windows | U10 首版 ubuntu；Windows 靠本地与后续 matrix |
| gen-sub-agents 与 JSON 双源 | U6 明确单一源并更新另一边 |

## System-Wide Impact

- Hooks 更严 → agent 在 planning 行为变化
- verify 更严 → 部分 session 需改 verifyCommand
- installer 更保守 → setup 在 corrupt hook 时可能部分成功（需 doctor 指引）

## Documentation / Operational Notes

- README Installation 后增加 `oms doctor` 推荐
- Uninstall/setup 行为变化写入简短 CHANGELOG 段落（若仓库仍无 CHANGELOG，在 README 或 PR 描述记录即可；完整 CHANGELOG 不在本计划强制）

## Open Questions

无阻塞问题。以下为 **deferred**（不挡 implementation-ready）：

- D1. 是否在后续 PR 禁 `|` 或改 allowlist？（本计划明确不处理）
- D2. doctor 是否应尝试自动 re-setup？（本计划只读）

## Appendix

### Top 10 → U 映射

| # | Audit item | U |
|---|------------|---|
| 1 | onStop timeout 120s < verify 300s | U1 |
| 2 | 禁/限 verify `||` | U2 |
| 3 | interview/dive 桥接 oms/auto\|team | U3 |
| 4 | planning/verifying terminal | U4 |
| 5 | Ralph 命名 + README | U5 |
| 6 | oms_optimizer 工具 | U6 |
| 7 | 删 #oms_debugger | U6 |
| 8 | installer corrupt hook + skill 备份 | U7 |
| 9 | oms doctor | U9 |
| 10 | CI + 契约测试 | U10 |

关联加固（审计 P1，非 Top10 序号但阻塞成熟度）:

| 项 | U |
|----|---|
| corrupt/expired state 写路径 fail-open | U8 |

执行顺序仍按 Unit Index：U1→U2→U3→U4→U5→U6→U7→U8→U9→U10。
