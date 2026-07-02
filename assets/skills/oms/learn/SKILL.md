---
name: learn
description: Extract a repeatable workflow from the current session into a skill draft, then run the evolution pipeline (reflect → explore → evaluate) to optimize it
---

# OMS Learn — Session-to-Skill Extractor + Evolution Pipeline

This skill **fuses** two capabilities:
1. **skillify** — extract a repeatable workflow from the current session into a structured skill draft
2. **evolution pipeline** — iterate the draft through reflect → explore → evaluate until it converges

Use this skill when the current session uncovered a repeatable workflow that should become a reusable, optimized OMS skill.

---

## Phase 1 — Quality Gate (skillify)

Before extracting a skill, verify ALL THREE are true. If any is false, stop and tell the user this belongs in documentation, not a skill.

- **"Could someone Google this in 5 minutes?"** → No.
- **"Is this specific to this codebase, project, or workflow?"** → Yes.
- **"Did this take real debugging, design, or operational effort to discover?"** → Yes.

Prefer skills that encode **decision-making heuristics, constraints, pitfalls, and verification steps**. Avoid generic snippets, boilerplate, or library usage examples.

---

## Phase 2 — Workflow Extraction (skillify)

Extract the repeatable task the session accomplished:

1. **Identify** the repeatable task. If it's not actually repeatable, stop.
2. **Extract** the workflow structure:
   - **Inputs** — what was needed to start
   - **Ordered steps** — what was done, in sequence
   - **Success criteria** — how to know each step worked
   - **Constraints / pitfalls** — what broke, what to avoid
   - **Verification evidence** — how the final result was confirmed
3. **Decide target location**:
   - User-level learned skill → `~/.snow/skills/oms/<name>/SKILL.md`
   - Documentation only → not a skill, stop
4. **Validate the skill name**: must match `^[a-zA-Z0-9_-]+$`.

---

## Phase 3 — Generate Draft + Trigger Evolution Pipeline

Call the `oms-learn` MCP tool with the extracted workflow:

```
oms-learn({
  summary: "<one-line description of what the skill does>",
  patterns: "<JSON array of pattern objects>",
  skillName: "<validated-skill-name>",
  maxIterations: 2
})
```

**`patterns` format** — derive from the extracted workflow's ordered steps + pitfalls:

```json
[
  {
    "name": "Pattern 1 name",
    "description": "What this pattern does and why",
    "applicability": "When to apply this pattern"
  }
]
```

Each ordered step → a pattern. Each pitfall → a pattern describing the failure mode and how to avoid it.

The `oms-learn` tool will:
- Generate an initial SKILL.md draft at `~/.snow/skills/oms/<skillName>/SKILL.md`
- Return orchestration instructions for the evolution pipeline

---

## Phase 4 — Evolution Pipeline (reflect → explore → evaluate)

**Self-contained.** All methodology is inlined below — do NOT load external skills. Run reflection, exploration, and evaluation directly using the rubrics in this section.

For each iteration (up to `maxIterations`, hard cap 5):

### ⚠️ Independent-Agent Discipline (prevents lookahead bias)

Each of the three stages MUST run in a **separate agent context** — never let one agent both diagnose and score its own work. Lookahead bias (using future/later-stage information to contaminate an earlier judgment) silently inflates scores and turns the ratchet into a rubber stamp.

| Stage | Runs in | Must NOT have seen |
|-------|---------|--------------------|
| Step 1 — Reflect | Agent A (e.g. `#oms_critic`) | Step 2's candidate strategies, Step 3's scores |
| Step 2 — Explore | Agent B (fresh executor, different per strategy) | Step 3's scores |
| Step 3 — Evaluate | Agent C (e.g. `#oms_evaluator`) | Step 1's revision signals (judge the candidate, not the diagnosis) |

**Rules**:
- Spawn a dedicated sub-agent (`#oms_<name>`) for each stage; do NOT run two stages in the same context.
- The agent that authored a strategy (Step 2) must NOT audit it (Step 2 audit) or score it (Step 3).
- Pass only the required handoff artifact between stages — never the prior stage's reasoning, only its output (Step 1 → JSON signals; Step 2 → candidate SKILL.md + test results; Step 3 → score + decision).
- If only one agent context is available (no sub-agents), state this limitation explicitly in the report and treat all scores as preliminary — the ratchet is not trustworthy without isolation.

### Step 1 — Reflect (skill-aware reflection)

**Agent**: A (e.g. `#oms_critic`) — see Independent-Agent Discipline above for isolation rules.

**Core principle**: A failed execution may reflect either incorrect skill content OR an execution lapse (the skill was valid but the agent failed to follow it). Diagnose first — do NOT blindly rewrite the entire skill.

**Inputs**: the draft at `~/.snow/skills/oms/<skillName>/SKILL.md` + trajectory. First iteration reflects on the original session (stageHistory, logs, tasks from state.json); subsequent iterations reflect on Step 2's test execution results.

**Procedure**:
1. Read the current SKILL.md first, then map the trajectory to it.
2. For each significant trajectory event: identify what the agent did → find the corresponding skill instruction (or note its absence) → classify the gap.

**Four revision signal types** — classify each finding into exactly one:

| Type | Meaning | Action |
|------|---------|--------|
| `DISCOVERY` | Skill doesn't cover this scenario at all | Add new section |
| `OPTIMIZATION` | Skill covers it, but a better approach exists | Update guidance |
| `SKILL_DEFECT` | Skill content is wrong, outdated, or underspecified | Fix the content |
| `EXECUTION_LAPSE` | Skill is correct, agent failed to follow it | Do NOT rewrite — strengthen emphasis only |

**Output**: a JSON array (max 10 signals, one signal per issue — don't bundle):

```json
[
  {
    "type": "DISCOVERY|OPTIMIZATION|SKILL_DEFECT|EXECUTION_LAPSE",
    "target": "<area_name>",
    "evidence": "<exact trajectory event + exact skill section>",
    "suggested_fix": "<specific, actionable fix>"
  }
]
```

**Prioritize**: Critical = `DISCOVERY`/`SKILL_DEFECT` that caused task failure → Important = `OPTIMIZATION` → Minor = `EXECUTION_LAPSE`.

### Step 2 — Explore (strategy-diversified exploration)

**Agent**: B (fresh executor per strategy) — see Independent-Agent Discipline above.

**Core principle**: Don't just fix the symptom — explore K different strategies to solve the same problem, test each one, and let the evidence decide.

For each revision signal (or cluster of related signals) from Step 1:

1. **Generate K=4 distinct strategies** — each must cover a different axis (library choice, algorithm family, architectural pattern), not token-level variations of the same approach.
2. **Cap total candidates at 8 per iteration**. If more than 8, prioritize by: critical signals first → most likely to generalize → least similar to already-tried approaches.
3. **Deploy and test each candidate** (fresh executor agent per candidate):
   - Create a modified SKILL.md incorporating the strategy
   - Run the same test tasks that generated the original revision signals
   - Collect: Did the agent succeed? Follow the skill correctly? New failure modes?
4. **Independent audit** — an independent auditor (NOT the same agent that authored or tested the strategy) checks each candidate for overfitting:
   - **Hardcoded literals** — specific values that should be parameters?
   - **Untraceable claims** — assertions without evidence?
   - **Parametric-axis under-abstraction** — too specific to one scenario?
   - **Primary-action hoisting** — core action buried under too much preamble?
   - **Silent bypass** — could the agent ignore the skill at runtime without detection?

   Violations → fix (if minor) or reject.
5. **Select best candidate** — rank by test success rate, break ties by audit cleanliness. If no candidate beat the baseline, report honestly and keep the baseline unchanged.

### Step 3 — Evaluate (9-dimension rubric + ratchet)

**Agent**: C (e.g. `#oms_evaluator`) — see Independent-Agent Discipline above. Judge the candidate on its own merits, not on whether it addresses Step 1's diagnosis.

**Core principle**: Score can only go up. Each iteration either improves the skill or cleanly rolls back — no accumulated degradation.

**Score the candidate across 9 dimensions (total 100 points)**:

**Structure (40 points)**:

| # | Dimension | Pts | Criteria |
|---|-----------|-----|----------|
| 1 | Coverage Completeness | 8 | All expected use cases covered? Obvious scenario gaps? |
| 2 | Failure Mode Encoding | 6 | Known failure paths explicitly encoded with handling instructions? |
| 3 | Executable Specificity | 8 | No vague phrasing. Banned: "建议","可以考虑","根据情况","灵活把握","视情况而定","consider","if appropriate","as needed". Every instruction concrete and actionable. |
| 4 | High-Risk Action Blacklist | 6 | Destructive ops (rm, git reset --hard, force push, DROP TABLE) forbidden/guarded? |
| 5 | Example Quality | 6 | Runnable, concrete code examples? Not pseudocode. |
| 6 | Modular Structure | 6 | Clearly layered (overview → steps → details)? Find any section in <10s? |

**Effectiveness (60 points)**:

| # | Dimension | Pts | Criteria |
|---|-----------|-----|----------|
| 7 | Boundary Condition Coverage | 10 | Edge cases handled? Empty inputs, null, concurrency, large datasets, Unicode, timezones. |
| 8 | Reusability | 15 | Cross-project applicable? Or hardcoded to one project? Higher = more general. |
| 9 | Deployment Effectiveness | 35 | **Highest weight.** Does it actually work when deployed? Based on Step 2 test results: success rate × task coverage. A skill that reads beautifully but fails in practice scores zero here. |

**Ratchet mechanism**:
- First iteration: baseline = 0 (any valid skill is an improvement)
- candidate score > baseline → **KEEP** (new baseline = candidate score)
- candidate score ≤ baseline → **REVERT** (keep current skill unchanged, baseline stays)
- The effective baseline **never decreases**

**⚠️ Baseline persistence (required — the ratchet is meaningless without it).** Agent C is a fresh context every iteration (per Independent-Agent Discipline above), so it CANNOT remember the prior baseline. You MUST persist it to disk so the next iteration's Agent C can read it:

- File: `~/.snow/skills/oms/<skillName>/.evolution.json`
- Schema: `{"baseline": <number>, "lastScore": <number>, "iterations": <number>, "history": [{"score": n, "decision": "KEEP|REVERT", "strategy": "..."}]}`
- Step 3 procedure: read `.evolution.json` first (baseline defaults to 0 if missing) → score candidate → compare → on KEEP, overwrite baseline + save candidate; on REVERT, leave baseline unchanged, append the attempt to history → write the file back.
- This file is the ONLY source of truth for the baseline — never hold it only in Agent C's context.

**Present to user** — show full score breakdown, diff summary, and ratchet decision. **MUST wait for user confirmation before applying.** Do NOT auto-accept even if the score is higher:

```
## Skill Evaluation Report
### Candidate: [Strategy name]
### Score Breakdown
| Dimension | Score | Max | Notes |
|-----------|-------|-----|-------|
| 1. Coverage | 7/8 | | ... |
| ... | | | |
| **Total** | **82/100** | | **Previous: 78** |
### Ratchet Decision
**KEEP** — 82 > 78
### Diff Summary
[Key changes from previous version]
---
Keep this version? (yes/no)
```

### Convergence Check

The loop converges when **ALL** are true:
1. Step 1 returns **0 revision signals**
2. Step 3 total score **≥ 80/100**
3. No `SKILL_DEFECT` or `DISCOVERY` signals in the last Step 1 run

If not converged and iterations remain → return to Step 1.
If this is the last iteration or hard cap 5 reached → save current best version.

---

## Phase 5 — Report

After the pipeline completes (or converges early), report to the user:

- **Skill name** and final location (`~/.snow/skills/oms/<skillName>/SKILL.md`)
- **Final score** (if available) — across the 9 dimensions, with previous baseline
- **Iterations run** vs max
- **Convergence status** — converged early / hit max iterations
- **Agent isolation** — confirm each stage ran in a separate agent context (A/B/C); if any stage shared context, flag the score as preliminary due to lookahead-bias risk
- **Open questions** — anything still too fuzzy to encode safely

---

## Rules

- Only capture workflows that are **actually repeatable**.
- Never force a skill out of a one-off task.
- Prefer **explicit success criteria** over vague prose.
- Note unresolved branching decisions before drafting.
- The skill name must match `^[a-zA-Z0-9_-]+$`.
- **Each evolution stage (Reflect/Explore/Evaluate) MUST run in a separate agent context** — never let one agent both diagnose and score its own work (lookahead bias). If sub-agents are unavailable, report scores as preliminary.
- After each Step 3 evaluation, **pause and ask the user** "Keep this version?" before proceeding to the next iteration.
- If the quality gate (Phase 1) fails, do NOT proceed to extraction — tell the user it should be documentation.
