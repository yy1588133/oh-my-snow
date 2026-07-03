# OMS Skill 复刻约束（所有复刻 agent 必读）

本文件是 oms（oh-my-snow）复刻 omc（oh-my-claudecode）skill 时的共同设计约束。所有复刻 agent 必须严格遵守，确保产出的 skill 符合 oms 设计架构。

---

## 1. 总体目标

把 oms 现有的 5 个轻量 skill（wiki/trace/interview/dive/vverify）**完全重写**，对标 omc 对应 skill 的能力深度，但用 oms 自己的设计语言（工具名、目录、frontmatter、章节结构、状态机）表达。目标是复刻 omc 的**机制深度**（数学评分、多假设并行、状态持久化、流水线桥接、JSON 阈值循环等），不是照搬文字。

| oms skill | omc 对标 | 复刻核心机制 |
|---|---|---|
| wiki | omc wiki | 持久化知识库（ingest/query/lint/add/delete + 交叉引用 + 自动捕获） |
| trace | omc trace | 多假设因果调查（3 道并行 + 证据 6 级分级 + 强制证伪 + 反驳轮次 + 收敛检测） |
| interview | omc deep-interview | 数学化歧义评分（4 维度加权 + Round 0 拓扑门 + 挑战代理 + 本体论跟踪 + 阈值门控） |
| dive | omc deep-dive | 2 阶段流水线（trace 3 道并行 → 3 点注入 interview → 执行桥接） |
| vverify | omc visual-verdict | 截图驱动视觉判定（JSON 输出 + 90 分阈值 + 像素 diff 调试） |

---

## 2. oms 设计语言（必须遵守）

### 2.1 工具名映射（snow-cli 工具，不是 omc 的）

oms 跑在 snow-cli 上，工具名跟 omc（claude code）不同。所有 SKILL.md 里引用工具时用 snow-cli 名字：

| 用途 | oms (snow-cli) | omc (claude code) 对应 |
|---|---|---|
| 文件读 | `filesystem-read` | Read |
| 搜索 | `codebase-search`, `ace-search` | Glob/Grep |
| 文件写 | `filesystem-create`, `filesystem-edit`, `filesystem-replaceedit` | Write/Edit |
| 终端 | `terminal-execute` | Bash |
| 诊断 | `ide-get_diagnostics` | lsp_diagnostics |
| 提问 | `askuser-ask_question` | AskUserQuestion |
| 子 agent | `#oms_<name>` | Task(subagent_type=...) |
| skill 加载 | `skill-execute { skill: "oms/<name>" }` | Skill() |

### 2.2 可用子 agent（用 `#oms_<name>` 调用）

`oms_architect`（架构）/ `oms_researcher`（调研，带 websearch）/ `oms_critic`（对抗审查）/ `oms_evaluator`（评估）/ `oms_reviewer`（代码审查）/ `oms_tester`/ `oms_security`/ `oms_ds`（数据分析）/ `oms_docs`/ `oms_designer`/ `oms_frontend`/ `oms_backend`/ `oms_database`/ `oms_api`/ `oms_devops`/ `oms_optimizer`/ `oms_migrator`/ `oms_summarizer`。

### 2.3 目录与状态

| 用途 | 路径 |
|---|---|
| oms skill 源文件 | `oh-my-snow/assets/skills/oms/<name>/SKILL.md` |
| 安装后 skill | `~/.snow/skills/oms/<name>/SKILL.md` |
| 项目状态根 | `.snow/oms-state/` |
| 通用状态存储 | `.snow/oms-state/store/<mode>.json`（见第 3 节） |
| 计划/spec 文档 | `.snow/oms-state/specs/<slug>.md` |
| trace 产物 | `.snow/oms-state/specs/trace-<slug>.md` |
| 临时/中间产物 | `.snow/oms-state/` 或通过 oms-state 工具，**禁止**写到仓库根或任意工作路径 |

⚠️ **不要用 omc 的 `.omc/` 目录**，oms 用 `.snow/oms-state/`。

### 2.4 SKILL.md frontmatter（极简）

oms 的 frontmatter 只有 `name` + `description` 两个字段，**不带** omc 的 `argument-hint/triggers/pipeline/handoff/level/agent` 等字段：

```yaml
---
name: <skill名>
description: <一句话描述，覆盖核心机制>
---
```

### 2.5 标准章节结构

```markdown
---
name: <name>
description: <...>
---

# OMS <Skill名> Skill

<2-3 句定位：这玩意儿干啥的，核心机制是什么>

## When to Use
- <场景列表>

## When NOT to Use
- <反场景列表，指向替代 skill>

## Why This Exists
<段落：为什么需要这个 skill，解决什么痛点>

## Procedure

### Step 1 / Phase 1: <名字>
<详细步骤，含工具调用示例>

### Step 2 / Phase 2: <名字>
...

## Execution Policy
- <硬规则列表>

## Anti-Patterns (Forbidden)
- **<反模式名>**：<为什么错>

## Quick Reference
| 工具/agent | 用途 |
|---|---|
```

### 2.6 设计哲学（贯穿所有 skill）

1. **PRD 驱动**：涉及执行落地的 skill 用 `oms-prd` 把决策拆成 story + 可测试验收标准
2. **审批门**：用 `askuser-ask_question` 做显式批准，不自动过渡到执行
3. **反伪造 token**：reviewer 签走要 `request-verification` → `submit-approval`（已有 MCP 工具）
4. **agent 串行编排**：有依赖的 agent 调用要串行（如 Architect 完再 Critic），独立任务才并行
5. **file:line 引用**：80%+ 的 claims 要有文件行号
6. **可测试验收标准**：90%+ 能写成测试
7. **阶段状态机**：planning → executing → verifying → done，文件编辑只在 executing（hook 强制）
8. **状态持久化**：跨会话/上下文压缩能恢复——用 `oms-state` 工具存 artifact 路径和进度

---

## 3. 通用状态工具 oms-state（对标 omc state_write/state_read）

omc 的 deep-interview/deep-dive 大量依赖 `state_write(mode="deep-interview")` 存 interview 状态、rounds、ontology 快照。oms 没有这个工具，**复刻时由独立 agent 在 src 层新增** `oms-state` MCP 工具。

### 3.1 接口约定（所有 skill 用这个接口）

工具名：`oms-state`
输入参数：
- `action`: `"write" | "read" | "delete" | "list"`
- `mode`: string（如 `"interview"`, `"deep-dive"`, `"trace"`）—— 状态域，每个 skill 用不同 mode 隔离
- `data`: string（JSON 序列化，仅 `write` 必填）—— 整个 mode 存一个 JSON 对象，**覆盖写**

存储位置：`.snow/oms-state/store/<mode>.json`（每个 mode 一个文件）

### 3.2 用法示例

```
# 写入（整个 mode 对象覆盖）
oms-state action:"write" mode:"interview" data:'{"interview_id":"uuid","rounds":[],"current_ambiguity":1.0,"threshold":0.2,"topology":{...}}'

# 读取（返回整个 mode 对象）
oms-state action:"read" mode:"interview"

# 删除
oms-state action:"delete" mode:"interview"

# 列出所有 mode
oms-state action:"list"
```

### 3.3 设计要点

- 整个 mode 一个 JSON 对象，`write` 是覆盖语义（读-改-写：先 read 拿到当前对象，改字段，再 write 回去）
- 跨会话持久：文件落盘，context compaction 后能 read 恢复
- 每个 skill 用独立 mode，互不干扰
- skill 在 SKILL.md 里引用 `oms-state` 工具名即可（工具由独立 agent 实现）

---

## 4. omc 源文件位置（复刻参考）

omc 4.15.1 的 skill 源文件路径（绝对路径，agent 自行 Read 消化）：

| omc skill | 绝对路径 |
|---|---|
| wiki | `C:/Users/yangyang/.claude/plugins/cache/omc/oh-my-claudecode/4.15.1/skills/wiki/SKILL.md` |
| trace | `C:/Users/yangyang/.claude/plugins/cache/omc/oh-my-claudecode/4.15.1/skills/trace/SKILL.md` |
| deep-interview | `C:/Users/yangyang/.claude/plugins/cache/omc/oh-my-claudecode/4.15.1/skills/deep-interview/SKILL.md` |
| deep-dive | `C:/Users/yangyang/.claude/plugins/cache/omc/oh-my-claudecode/4.15.1/skills/deep-dive/SKILL.md` |
| visual-verdict | `C:/Users/yangyang/.claude/plugins/cache/omc/oh-my-claudecode/4.15.1/skills/visual-verdict/SKILL.md` |

oms 现有 skill 源文件（要重写的目标）：

| oms skill | 绝对路径 |
|---|---|
| wiki | `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/wiki/SKILL.md` |
| trace | `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/trace/SKILL.md` |
| interview | `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/interview/SKILL.md` |
| dive | `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/dive/SKILL.md` |
| vverify | `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/vverify/SKILL.md` |

---

## 5. 验收标准（每个 skill 必须满足）

1. ✅ frontmatter 只有 `name` + `description`
2. ✅ 用 oms 工具名（filesystem-read / ace-search / askuser-ask_question / #oms_<name> 等），不用 omc 工具名
3. ✅ 目录用 `.snow/oms-state/`，不用 `.omc/`
4. ✅ 对标 omc 的核心机制全部覆盖（见第 1 节表格）
5. ✅ 状态持久化用 `oms-state` 工具（interview/dive/trace 必需）
6. ✅ 标准章节齐全（When to Use / When NOT / Why / Procedure / Execution Policy / Anti-Patterns / Quick Reference）
7. ✅ 产出文件写到 `D:/yangyang/Docker/snow-cli/oh-my-snow/assets/skills/oms/<name>/SKILL.md`（覆盖现有）
8. ✅ 篇幅对标 omc（omc 这些 skill 普遍 80-800 行，oms 复刻版不应比 omc 短太多）
9. ✅ 不留 TODO/placeholder/skip 等假完成标记
10. ✅ 完成后给出一份简短的"复刻完成报告"：覆盖了哪些 omc 机制、做了哪些 oms 适配、有没有遗漏
