---
name: gcf
description: Bounded Generate-Critique-Fix on existing changes — independent #oms_critic issues[], maxRounds 3, dry when no open P0/P1, honest hitCeiling
---

# OMS GCF Skill — Bounded Generate–Critique–Fix

有界「挑刺 → 修复」金牌工序。默认针对**已有改动/指定范围**，不是从零写功能。  
Generate 退化为**锁定范围**；核心是独立 Critique + Fix 对账，最多 **maxRounds = 3**。

## When to Use

- 刚改完一批代码，想系统挑刺再修，而不是只跑 build/test
- auto / 手改后、进完成门前，想多一轮独立质量工序
- 有明确范围（路径 / diff / 模块）需要有界质量循环

## When NOT to Use

- **从零实现功能** → `/oms:plan` 或 `/oms:auto`
- **只清编译/测试红** → `/oms:qa`
- **未知规模扫雷 / 找干了再停** → 未来 loop-until-dry；不要无界循环伪装成 GCF
- **大 PR 多维审查流水线** → 未来分片 review；本 skill 是有界 CF 循环

## Why This Exists

完成门卡「能不能收工」，cleanup/qa 会转圈，但都缺少可复现形状：  
**结构化 issues[] + 轮次硬帽 + P0/P1 门槛 + 禁止自审 + 撞帽诚实失败**。

## Procedure

### Step 0 — Generate：锁定范围（非从零生成）

1. 读取用户参数 `$ARGUMENTS` / 当前目标文本作为范围提示。
2. **默认范围规则：**
   - 参数非空 → 以参数为审查/修复范围（路径、模块、自然语言目标均可）。
   - 参数为空 → 用 `terminal-execute` 取 `git status --porcelain` 与 `git diff`（含 staged，可用 `git diff HEAD` / `git diff --cached` 组合）。
   - **非 git 且无参数** → **中止**，报告 `outcome: aborted`，要求用户给出路径/范围。**不要**默认扫整个工作区。
3. 向用户（或日志）确认：
   - `scope` 摘要（文件列表或 diff 摘要）
   - `maxRounds: 3`
   - 干判定：无 `status=open` 的 **P0/P1**
   - P2/P3 可不修完仍可 `dry`
4. 若存在活跃 OMS 会话：调用 `oms-get-state`。后续 **Fix 改文件前**，若 `stage` 不是 `executing`，先 `oms-set-stage { stage: "executing" }`。  
   **无会话：** 跳过 OMS MCP，报告中标注 `session: none`；仍可完整跑 GCF。

### Step 1 — 有界循环（round = 1..3）

对 `round` 从 1 到 **maxRounds=3**：

#### 1a. Critique（必须独立子代理）

1. **Spawn `#oms_critic`**（或文档标明的等价只读审查子代理）。  
   - 主会话 agent **禁止自审**并声称 GCF 通过。  
   - **无法 spawn critic → 立即中止**，`outcome: aborted`，原因写清。**禁止降级为主代理自审成功。**
2. 给 critic 的 brief 必须包含：锁定范围、diff/文件内容指针、要求输出 **仅** 一个 JSON（可包在 markdown 代码块），形状：

```json
{
  "round": 1,
  "issues": [
    {
      "id": "I1",
      "severity": "…",
      "severity": "P0",
      "file": "path/to/file.ts",
      "line": 42,
      "status": "open"
    }
  ]
}
```

字段要求：

| 字段 | 规则 |
|------|------|
| `id` | 稳定短 id（本轮内唯一） |
| `severity` | 非空 |
| `severity` | `P0` \| `P1` \| `P2` \| `P3` |
| `file` | 仓库相对路径 |
| `line` | 可选；有则正整数 |
| `status` | Critique 产出时为 `open` |

3. 解析失败：允许 **同轮重试 spawn 一次**；仍失败则插入技术债 issue：`id: PARSE_FAIL`，`severity: P1`，`status: open`，进入 Fix 或撞帽路径。
4. **干判定：** 若没有 `status=open` 且 `severity` 为 P0 或 P1 的 issue → **成功退出循环**，`outcome: dry`（**不必**硬跑满 3 轮）。P2/P3 仍为 open **不阻止** dry。

#### 1b. Fix（主代理，按 id 对账）

1. 仅处理 open 的 **P0/P1**（默认）；P2/P3 可记入报告，不强制本 skill 修完。
2. 逐条 `id` 修复；禁止笼统「都修了」而无 id 对账。
3. 每条修完后更新内存中的 `status` → `fixed`（或 `deferred` + 原因，仅用户明确要求推迟时）。
4. 改文件后依赖宿主 auto-verify（若有）；不要假装测试已绿若未跑。
5. `round++`，若 `round <= 3` 回到 1a；否则进入 Step 2 撞帽。

### Step 2 — 终局报告

始终输出结构化终局报告（可用 markdown）：

```markdown
# GCF Report
- outcome: dry | hitCeiling | aborted
- scope: …
- session: none | active (stage=…)
- roundsUsed: N / maxRounds 3
- openP0P1: K
- issues: (全量或至少全部 open P0/P1 + 本轮 fixed 摘要)
```

**outcome 语义：**

| outcome | 含义 |
|---------|------|
| `dry` | 成功：无 open 的 P0/P1 |
| `hitCeiling` | **失败语义**：满 3 轮仍有 open P0/P1；**禁止**声称「已修干净 / GCF 成功」 |
| `aborted` | 失败：无范围、无法 spawn critic 等 |

#### 可选完成门 evidence（R14/R15）

若 `session: active` 且用户可能走完成门：

- 列出 **Evidence candidates** 3–8 条可粘贴进 scorecard `evidence[]` 的短句（含 outcome、rounds、openP0P1、关键 `file:line`）。
- **禁止**由本 skill 调用 `oms-prd submit-gate` / `submit-approval` 或 `oms-set-stage done`。  
  GCF **不**自动放行收工；完成门规则不变。

每轮与终局须展示：`round/maxRounds`、本轮新增/关闭计数、仍 open 的 P0/P1 数。

## Execution Policy

- **maxRounds = 3**（一轮 = Critique + Fix）；达到上限不得静默开第 4 轮。
- **独立 `#oms_critic`**；禁止主代理自审冒充 GCF。
- **干 = 无 open P0/P1**；P2/P3 可选修。
- **hitCeiling = 诚实失败**，不假绿。
- **可无 OMS session 独立运行**。
- 有 session 时 Fix 仅在 `executing` 写盘。
- 不修改完成门通过公式；不默认挂到 `/oms:auto` 收工路径。

## Anti-Patterns (Forbidden)

- **主代理自审通过：** 无 `#oms_critic` 却报告 dry/成功。
- **无界循环：** 只靠模型 done、不设 maxRounds。
- **假绿 hitCeiling：** 满轮仍有 P0/P1 却写成功。
- **从零 Generate 冒充 GCF：** 本 skill 不负责 greenfield 实现。
- **自动 submit-gate / set-stage done：** 绑架收工。
- **无范围扫全仓：** 非 git 且无参数时必须 aborted。
- **无 id 对账的“全修了”：** 违反 Fix 契约。

## Quick Reference

| 工具/agent | 用途 |
|---|---|
| `#oms_critic` | 每轮独立 Critique → `issues[]` |
| `filesystem-read` / `codebase-search` / `ace-search` | 范围与修复取证 |
| `filesystem-edit` 等 | Fix（仅 executing 或无 session） |
| `terminal-execute` | git diff/status；可选 verify |
| `oms-get-state` / `oms-set-stage` | 可选会话衔接 |
| `skill-execute { skill: "oms/gcf" }` | 入口（由 `/oms:gcf` 触发） |
