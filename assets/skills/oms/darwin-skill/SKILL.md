---
name: darwin-skill
description: Evaluate skills across 9 dimensions and apply a ratchet mechanism — only keep improvements, never regress.
---

# Darwin-Skill — Evolutionary Skill Evaluator

This skill evaluates skill quality across **9 dimensions** (total 100 points) and applies a **ratchet mechanism**: new versions are only kept if they score higher than the current best. Regressions are automatically reverted.

## When to Use

- After SkillEvolver has produced a candidate skill
- You are the **evaluator** in the diagnose → explore → evaluate pipeline
- Before saving the final skill to disk

## Core Principle

> Score can only go up. Each iteration either improves the skill or cleanly rolls back. No accumulated degradation over time.

## 9-Dimension Evaluation Rubric (100 points total)

### Structure Score (40 points)

| # | Dimension | Points | Criteria |
|---|-----------|--------|----------|
| 1 | **Coverage Completeness** | 8 | Does the skill cover all expected use cases? Are there obvious gaps in scenarios? |
| 2 | **Failure Mode Encoding** | 6 | Are known failure paths explicitly encoded? Not just "don't make mistakes" but specific failure modes with handling instructions. |
| 3 | **Executable Specificity** | 8 | No vague phrasing. Banned terms: "建议", "可以考虑", "根据情况", "灵活把握", "视情况而定", "consider", "if appropriate", "as needed". Every instruction must be concrete and actionable. |
| 4 | **High-Risk Action Blacklist** | 6 | Are destructive operations (rm, git reset --hard, force push, DROP TABLE) explicitly listed as forbidden or guarded? |
| 5 | **Example Quality** | 6 | Are there runnable, concrete code examples? Not pseudocode or vague descriptions. |
| 6 | **Modular Structure** | 6 | Are instructions clearly layered (overview → steps → details)? Can a reader find any section in under 10 seconds? |

### Effectiveness Score (60 points)

| # | Dimension | Points | Criteria |
|---|-----------|--------|----------|
| 7 | **Boundary Condition Coverage** | 10 | Are edge cases handled? Empty inputs, null values, concurrent access, large datasets, Unicode, timezone issues. |
| 8 | **Reusability** | 15 | Is the skill cross-project applicable? Or is it hardcoded to one project's specifics? Higher score = more general. |
| 9 | **Deployment Effectiveness** | 35 | **Highest weight.** Does the skill actually work when deployed? Based on SkillEvolver's test results: success rate × task coverage. A skill that reads beautifully but fails in practice scores zero here. |

## Ratchet Mechanism

```
Current best score: 78

Iteration 1: Candidate scores 82 → KEEP (82 > 78, new baseline = 82)
Iteration 2: Candidate scores 75 → REVERT (75 < 82, baseline stays 82)
Iteration 3: Candidate scores 85 → KEEP (85 > 82, new baseline = 85)
```

- The effective baseline **never decreases**
- Each improvement is locked in
- Regressions are cleanly reverted (no partial changes retained)

## Human-in-the-Loop

After each evaluation, **pause and present to the user**:

```
## Skill Evaluation Report

### Candidate: [Strategy name from SkillEvolver]

### Score Breakdown
| Dimension | Score | Max | Notes |
|-----------|-------|-----|-------|
| 1. Coverage | 7/8 | | Missing rate-limit scenario |
| 2. Failure Modes | 5/6 | | Good but missing timeout handling |
| ... | | | |
| **Total** | **82/100** | | **Previous: 78** |

### Ratchet Decision
**KEEP** — 82 > 78 (current baseline)

### Diff Summary
[Key changes from previous version]

---
Do you want to keep this version? (yes/no)
```

**You MUST wait for user confirmation before proceeding.** Do not auto-accept improvements, even if the score is higher.

## Convergence Criteria

The skill evolution loop converges when **ALL** of the following are true:
1. EmbodiSkill returns **0 revision signals** (no more issues found)
2. Darwin-skill total score **≥ 80/100**
3. No SKILL_DEFECT or DISCOVERY signals in the last EmbodiSkill run

If convergence is not reached within `maxIterations` (default 2, hard max 5), save the current best version.

## Procedure

### Step 1: Score the Candidate

Read the candidate SKILL.md and score each of the 9 dimensions. Use the criteria above.

### Step 2: Compare to Baseline

- If this is the first iteration, the baseline is 0 (any valid skill is an improvement)
- If candidate score > baseline → recommend KEEP
- If candidate score ≤ baseline → recommend REVERT

### Step 3: Present to User

Show the full score breakdown, diff summary, and ratchet decision. Wait for user confirmation.

### Step 4: Apply Decision

- **KEEP**: Update baseline score, save candidate as the new current skill
- **REVERT**: Discard candidate, keep current skill unchanged

## Output Format

```json
{
  "totalScore": 82,
  "previousScore": 78,
  "decision": "KEEP",
  "dimensions": {
    "coverage": 7,
    "failureModes": 5,
    "executableSpecificity": 7,
    "highRiskBlacklist": 5,
    "exampleQuality": 5,
    "modularStructure": 5,
    "boundaryConditions": 8,
    "reusability": 12,
    "deploymentEffectiveness": 28
  },
  "notes": "Missing rate-limit scenario in coverage. Good executable specificity. Examples are runnable."
}
```

## Rules

- **Deployment effectiveness has the highest weight (35 points)** — a beautiful skill that fails in practice is worthless
- **Never auto-accept** — always pause for human confirmation
- **Score honestly** — don't inflate scores to make the ratchet "work"
- **If no candidate beats the baseline, keep the baseline** — don't regress just to "make progress"
- **Document every scoring decision** — why each dimension got the score it did
