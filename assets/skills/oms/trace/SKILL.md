---
name: trace
description: Evidence-driven causal investigation lane that orchestrates competing hypotheses across parallel tracer workers, ranks evidence by a 6-tier strength hierarchy, forces falsification, runs a rebuttal round, and persists investigation state for cross-session recovery.
---

# OMS Trace Skill

This skill is an **evidence-driven causal investigation orchestration layer**（证据驱动的因果调查编排层）——不是代码调用链走读。
它把"为什么会出现这个观察结果"这个问题拆成多个互相竞争的假设，派多个调查道并行收集正反证据，按证据强度分级排序，强制证伪自己的最爱假设，跑反驳轮次，最后给出一个排好序的假设表、关键未知、和能最快消除不确定性的判别探针。

核心契约：永远区分 7 个要素——观察、假设、正据、反据/缺口、当前最佳解释、关键未知、判别探针。不要塌陷成修代码循环或调试器摘要。

## When to Use

- 运行时 bug / 回归，且原因不明、多个嫌疑并存
- 性能 / 延迟 / 资源行为异常，需要解释"为什么"
- 架构 / 事前验尸 / 事后复盘分析
- 科学或实验结果追踪（结果不符合预期，要找根因）
- 配置 / 路由 / 编排行为解释
- 验证方法缺陷排查（多实体 key 跨实体复用、schema grain 不匹配、catalog/column 名跨运行时假设可移植）
- "给定这个输出，反推可能的成因"

判断标准：问题**模糊**、**因果性**强、**证据密集**、适合用并行假设竞争来收敛。

## When NOT to Use

- 只想看某条调用链怎么走完 → 用代码走读，不需要 trace 的多假设编排
- 已知根因、只需修代码 → 直接 executor，不需要假设竞争
- 单一明确 bug、复现路径清晰 → 普通调试流程即可
- 纯性能数值测量（无解释需求）→ 用 `oms_ds` 直接测
- 需要 Socratic 澄清需求 → 用 `oms:interview`
- 需要 trace + interview + 执行桥接的完整流水线 → 用 `oms:dive`（它内部会调 trace）

## Why This Exists

普通调试的失败模式是**确认偏差**：调查者锁定一个解释，只找支持它的证据，忽略反证，最后给一个看似合理实则错误的根因。omc trace 的设计哲学是"证据驱动的对抗式调查"——

1. 强制生成**多个互相不同**的假设，避免单一叙事陷阱
2. 每个 worker 必须收集**正反两向**证据，强制证伪自己的假设
3. 证据按 6 级强度分级，低级别被高级别反证时显式降权
4. 跑**反驳轮次**让最强非领先道挑战领先道
5. 区分"真收敛"（同根因机制 / 独立证据流汇聚）vs"语言相似但机制不同"
6. 显式说**为什么一个假设排下去**，不只给最终表——教读者排序逻辑，不只给结论

oms 版本把这个机制搬到 snow-cli 上：调查道用 `#oms_researcher`（带 websearch，适合外部线索 + 代码证据搜集），数据/度量道用 `#oms_ds`，状态用 `oms-state` 持久化到 `.snow/oms-state/store/trace.json`，最终报告写到 `.snow/oms-state/specs/trace-<slug>.md`。

## Core Tracing Contract (7 Elements)

调查全程必须保留这 7 个要素的区分，任何一步塌陷都算失败：

1. **Observation（观察）**——实际观察到了什么，精确重述，不带解释
2. **Hypotheses（假设）**——互相竞争的候选解释，必须刻意不同
3. **Evidence For（正据）**——支持每个解释的证据，带强度分级
4. **Evidence Against / Gaps（反据/缺口）**——反驳它的证据 + 还缺什么证据
5. **Current Best Explanation（当前最佳解释）**——此刻领先的解释
6. **Critical Unknown（关键未知）**——把前几个解释分开的那个缺失事实
7. **Discriminating Probe（判别探针）**——能最快消除不确定性的下一步

禁止塌陷成：通用修代码循环 / 通用调试器摘要 / worker 输出原样拼接 / 证据不全时假装确定。

## Evidence Strength Hierarchy (6 Tiers)

证据是分级的，不是平的。从强到弱：

1. **受控复现 / 直接实验 / 唯一判别性 artifact**——能复现、能控制变量、能唯一区分假设的产物
2. **一手 artifact 强溯源**——trace 事件、日志、metrics、benchmark 输出、配置、git 历史、file:line 行为
3. **多独立源收敛**——多个互相独立的证据源指向同一解释
4. **单源代码路径推断**——只从一条代码路径推断的行为
5. **弱间接线索**——时序、命名、栈顺序、像之前的某个 bug
6. **直觉 / 类比 / 猜测**

规则：当高级别反证存在时，主要依赖低级别的假设必须显式降权。不要把第 6 级直觉当第 1 级实验结果汇报。

## Procedure

### Phase 1: Restate Observation & Generate Hypotheses

1. **精确重述观察**——用 `filesystem-read` 读触发观察的代码/config/log，确认观察到底是什么（不是"系统慢了"，而是"P99 从 50ms 涨到 800ms，发生在 UTC 14:00 切流后"）
2. **抽取调查目标**——一句话"我们要解释为什么 ___"
3. **生成 3 个刻意不同的候选假设**——刻意覆盖不同机制类别，不要 3 个其实是同一解释的变体
4. **写初始状态**——`oms-state action:"write" mode:"trace" data:'{...}'`，记录 observation、hypotheses、空 evidence、空 ranking、phase: "lane-spawn"

### Phase 2: Spawn 3 Parallel Tracer Lanes

默认 3 道，除非 prompt 强烈暗示更好的划分：

1. **代码路径 / 实现因**——某段代码逻辑导致观察
2. **配置 / 环境 / 编排因**——配置、环境、上下游编排、协调效应导致
3. **度量 / artifact / 假设失配因**——验证方法本身有缺陷。覆盖范围：验证 query 把单个维度 key 跨实体复用（tenant/stream/group）；比较 filter 的形状跟 schema grain 不匹配；catalog/column 名被假设跨运行时可移植但实际不行。多实体前提/key 假设失配归这道。

**派道方式：**

- **首选**：用 `#oms_researcher` 派 3 道调查（每道一个独立调用，互不共享上下文）。`#oms_researcher` 带 websearch，适合既搜代码又查外部线索。team mode（`/oms:team` + `oms-set-team`）可用时走 team 机制并行派 3 道，否则串行调 `#oms_researcher` 3 次（每次一道）。跟 omc 一样：串行不是失败，只是慢。
- **数据/度量道**：若第 3 道需要数据分析（复现验证、度量对比），用 `#oms_ds` 代替 `#oms_researcher`。

每个 worker 收到 prompt 时强调：**追求刻意不同的解释，不要在并行里跑同一解释的变体。**

### Phase 3: Worker Contract (Each Lane)

每个 worker 是一条 tracer 道的主人，不是通用执行器。worker 必须：

- **own 恰好一条假设道**——明确重述自己道的假设
- 收集**正据（Evidence For）**——用 `filesystem-read` 读代码/config，用 `ace-search` 找证据，用 `terminal-execute` 跑复现实验
- 收集**反据（Evidence Against / Gaps）**——找反驳自己假设的证据，找还缺的证据
- **给证据分级**——按 6 级强度标注每条证据
- **指出缺失证据 / 失败预测 / 剩余不确定性**
- **命名本道的关键未知（Critical Unknown）**
- **推荐本道的最佳判别探针（Discriminating Probe）**——最便宜、能最快区分本道 vs 邻道
- **不塌陷成实现**——除非明确指示，否则不要跳进改代码

worker 证据源：

- 代码、测试、配置、文档、日志、输出、benchmark artifact（`filesystem-read` / `ace-search`）
- 已有 trace 产物（`.snow/oms-state/specs/trace-*.md`）
- 复现实验（`terminal-execute`）
- 外部线索（`#oms_researcher` 的 websearch）

worker 返回结构：

1. **Lane**（道名）
2. **Hypothesis**（假设陈述）
3. **Evidence For**（正据，每条带强度等级）
4. **Evidence Against / Gaps**（反据/缺口）
5. **Evidence Strength**（本道整体证据强度：Strong / Moderate / Weak）
6. **Critical Unknown**（关键未知）
7. **Best Discriminating Probe**（最佳判别探针）
8. **Confidence**（置信度：High / Medium / Low）

### Phase 4: Mandatory Cross-check Lenses

初始证据轮之后，对领先假设施压，用这 3 个镜头（relevant 时用，不是每条都用，但每条都要想过）：

- **系统镜头（Systems lens）**——队列、重试、背压、反馈回路、上下游依赖、边界失败、协调效应。问：有没有隐藏依赖、跨服务协调问题、被忽略的边界条件？
- **事前验尸镜头（Premortem lens）**——假设当前最佳解释不完整或错了，未来什么失败模式会让这次 trace 尴尬？这个镜头能挖出被忽略的解释。
- **科学镜头（Science lens）**——对照、混淆变量、测量偏差、替代变量、可证伪预测。问：有没有混淆变量？测量方法本身有偏吗？

这些镜头不是凑数。当它们能挖出被遗漏的解释、隐藏依赖、弱推断时，必须用。

### Phase 5: Rebuttal Round & Convergence Detection

关闭调查前强制跑：

1. **让最强非领先道向当前领先道提出最佳反驳**
2. **强制领先道用证据回应反驳**——不是断言，不是"我觉得不对"
3. **若反驳实质性削弱领先道 → 重排假设表**
4. **收敛检测**——区分真收敛 vs 语言相似：
   - **真收敛**：两个"不同"假设归约到同一底层机制，或独立证据流汇聚到同一解释 → 合并并显式说明"合并原因是同根因机制"
   - **假收敛**：两个假设听起来相似但暗示不同的下一步探针 → 保持分离，即使措辞相近
5. **禁止仅因多个 worker 用相似语言就声称收敛**——收敛要求：同根因机制 **或** 独立证据流指向同一解释

### Phase 6: Leader Synthesis Contract (10-Element Output)

leader 综合输出，不是拼接 worker 输出。必须包含 10 要素：

1. **Observed Result**（观察结果）
2. **Ranked Hypotheses**（排好序的假设表）
3. **Evidence Summary by Hypothesis**（每假设证据摘要）
4. **Evidence Against / Missing Evidence**（反据/缺失证据）
5. **Rebuttal Round**（反驳轮次记录）
6. **Convergence / Separation Notes**（收敛/分离说明）
7. **Most Likely Explanation**（最可能解释）
8. **Critical Unknown**（关键未知）
9. **Recommended Discriminating Probe**（推荐判别探针）
10. **Additional Trace Lanes**（额外道，仅当不确定性仍高时才给）

即使一个解释当前占优，也要保留排序后的候选清单——不要删掉非领先假设。

### Phase 7: State Persistence & Output

1. **更新 trace 状态**——`oms-state action:"write" mode:"trace" data:'{...}'`，记录最终 ranked hypotheses、evidence、rebuttal、critical unknown、phase: "synthesized"
2. **写最终报告**——`filesystem-create` 写到 `.snow/oms-state/specs/trace-<slug>.md`，slug 从 observation 提取（如 `trace-p99-latency-regression.md`）
3. **跨会话恢复**——context compaction 后用 `oms-state action:"read" mode:"trace"` 恢复调查状态，继续从断点跑

`oms-state` 的 `trace` mode JSON 结构建议：

```json
{
  "trace_id": "<slug>",
  "observation": "<精确重述>",
  "phase": "lane-spawn | evidence-gathering | cross-check | rebuttal | synthesized",
  "hypotheses": [
    {
      "lane": "code-path | config-env | measurement-artifact",
      "hypothesis": "<陈述>",
      "evidence_for": [{"claim": "...", "tier": 1, "source": "file:line"}],
      "evidence_against": [{"claim": "...", "tier": 2, "source": "..."}],
      "strength": "Strong | Moderate | Weak",
      "confidence": "High | Medium | Low",
      "critical_unknown": "...",
      "discriminating_probe": "..."
    }
  ],
  "ranking": ["<lane1>", "<lane2>", "<lane3>"],
  "rebuttal": {"challenger": "...", "leader_response": "...", "re_ranked": true},
  "convergence": "merged | separate | partial",
  "critical_unknown": "<最终关键未知>",
  "discriminating_probe": "<最终判别探针>",
  "report_path": ".snow/oms-state/specs/trace-<slug>.md"
}
```

## Falsification & Down-ranking Rules

### 强制证伪

每个顶级假设都必须尝试证伪自己：

- 收集**正据**
- 收集**反据**
- 说它做出的**独特预测（distinctive prediction）**——跟对手解释不同的可观察后果
- 说**难以跟它调和的观察**——什么观察会让它站不住
- 找**最便宜的判别探针**——能把它和次优替代分开的最低成本实验

### 降权规则

假设出现以下情况时降权：

- 被直接证据反证
- 靠新增未验证假设存活（ad hoc 假设）
- 跟对手相比没有独特预测
- 有更强替代用更少假设解释同样事实（Occam 剪刀）
- 主要靠间接线索，而对手有更强证据级别

### 显式降权说明

leader 必须显式说**为什么一个假设排下去**——

- 被更强证据反证
- 缺了它预测的观察
- 需要额外 ad hoc 假设
- 解释的事实比领先道少
- 反驳轮次输了
- 收敛进了更强的父解释

这条很重要：trace 要**教读者为什么一个解释排第一、另一个排第二**，不是只给最终表。

## Execution Policy

- **80%+ claims 带 file:line 引用**——`filesystem-read` / `ace-search` 拿到的证据必须标源
- **证据分级强制**——每条证据标 tier（1-6），不标等级的 evidence 视为 tier 6
- **不塌陷成实现**——除非 prompt 明确说"修代码"，否则只调查不改代码
- **串行编排有依赖的 agent**——反驳轮次里 leader 必须在 challenger 之后回应，不能并行
- **状态持久化**——每个 phase 切换都 `oms-state write` 一次，context compaction 后能 read 恢复
- **假完成禁止**——不留 TODO/placeholder/skip，不写"假设 X 待验证"然后跳过验证
- **收敛判定严格**——禁止仅因语言相似声称收敛，必须同根因机制或独立证据流汇聚
- **3 道必须刻意不同**——不要在并行里跑同一解释的变体
- **第 3 道必须审计多实体前提**——零行/不匹配结果可能来自 key 跨实体复用，不是系统缺陷

## Anti-Patterns (Forbidden)

- **确认偏差陷阱**：只收集正据、忽略反据。每个顶级假设必须双向取证。
- **单一叙事**：3 个"不同"假设其实是同一解释的措辞变体。生成时刻意覆盖不同机制类别。
- **证据扁平化**：把 tier 6 直觉当 tier 1 实验结果汇报。每条证据必须标等级。
- **假收敛**：两个假设措辞相近就声称收敛。收敛要同根因机制或独立证据流。
- **断言式反驳回应**：leader 用"我觉得不对"回应 challenger。必须用证据回应。
- **worker 输出原样拼接**：leader 必须综合、排序、跑反驳、判收敛，不是 concat。
- **删掉非领先假设**：即使一个解释占优，也要保留排序后的候选清单。
- **跳过降权说明**：只给最终表不说为什么排下去。必须显式说降权理由。
- **塌陷成修代码循环**：没指示就跳进改代码。trace 是调查层，不是执行层。
- **状态不落盘**：只在内存里跑，context compaction 后全丢。每 phase 切换必须 `oms-state write`。

## Quick Reference

| 工具/agent | 用途 |
|---|---|
| `filesystem-read` | 读代码/config/log，获取一手 artifact |
| `ace-search` | 搜证据（代码路径、配置引用、日志模式） |
| `terminal-execute` | 跑受控复现实验（tier 1 证据） |
| `#oms_researcher` | 派调查道（带 websearch，适合代码 + 外部线索） |
| `#oms_ds` | 数据分析道（度量对比、复现验证） |
| `/oms:team` + `oms-set-team` | team mode 派 3 道（可选，不可用则串行 fallback） |
| `oms-state action:"write" mode:"trace"` | 持久化调查状态（hypotheses/evidence/ranking/rebuttal） |
| `oms-state action:"read" mode:"trace"` | 跨会话恢复调查状态 |
| `filesystem-create` | 写最终报告到 `.snow/oms-state/specs/trace-<slug>.md` |

## Suggested Lead Orchestration Skeleton

派道时用这个 prompt 骨架：

1. "精确重述观察。"
2. "生成 3 个刻意不同的假设。"
3. "每假设派一个 `#oms_researcher` 调查道，串行或并行（team mode 可用则并行，否则串行 fallback）。"
4. "每个道收集正反证据、标强度等级、命名关键未知、推荐最佳判别探针。不塌陷成实现。"
5. "对领先假设施压：系统镜头 / 事前验尸镜头 / 科学镜头（relevant 时用）。"
6. "跑反驳轮次：最强非领先道反驳领先道，领先道用证据回应，重排。"
7. "判收敛：同根因机制或独立证据流汇聚才算真收敛，否则保持分离。"
8. "返回排好序的假设表 + 收敛说明 + 关键未知 + 最佳判别探针 + 降权理由。"
9. "`oms-state write` 落盘，`filesystem-create` 写报告到 `.snow/oms-state/specs/trace-<slug>.md`。"

## Example Final Synthesis Shape

### Observed Result
[实际观察到了什么]

### Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | ... | High/Medium/Low | Strong/Moderate/Weak | ... |
| 2 | ... | ... | ... | ... |
| 3 | ... | ... | ... | ... |

### Evidence Summary by Hypothesis
- 假设 1：[正据 + tier] 
- 假设 2：[正据 + tier]
- 假设 3：[正据 + tier]

### Evidence Against / Missing Evidence
- 假设 1：[反据 + 缺口]
- 假设 2：[反据 + 缺口]
- 假设 3：[反据 + 缺口]

### Rebuttal Round
- 最强非领先道对领先道的反驳：...
- 领先道用证据的回应：...
- 重排结果：...

### Convergence / Separation Notes
- [真收敛：合并进 X，因为同根因机制 / 独立证据流汇聚]
- [保持分离：措辞相近但暗示不同探针]

### Most Likely Explanation
[当前最佳解释]

### Critical Unknown
[把前几个解释分开的那个缺失事实]

### Recommended Discriminating Probe
[能最快消除不确定性的单一下一步]

### Down-ranking Reasons
- 假设 X 排第 N 的原因：[被反证 / 缺预测 / ad hoc 假设 / 解释更少 / 反驳输了 / 收敛进父解释]

### Additional Trace Lanes
[仅当不确定性仍高时给]
