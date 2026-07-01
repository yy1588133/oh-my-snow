---
name: embodi-skill
description: Skill-aware reflection — analyze execution trajectories against the current skill to produce targeted revision signals.
---

# EmbodiSkill — Skill-Aware Reflection

This skill performs **skill-aware reflection**: it examines execution trajectories *with respect to the current skill* and produces **targeted revision signals** — not coarse whole-skill rewrites.

## When to Use

- After a skill has been deployed and tested (either in a real session or a SkillEvolver test run)
- When you need to identify *specific* areas of a skill that need improvement
- Before calling SkillEvolver — your revision signals guide its strategy exploration

## Core Principle

> A failed execution may reflect either **incorrect skill content** or an **execution lapse** (the skill was valid but the agent failed to follow it). Do NOT blindly rewrite the entire skill — diagnose first.

## Four Revision Signal Types

For each execution trajectory, classify findings into exactly one of four categories:

### 1. DISCOVERY — Missing Skill Content

The trajectory reveals a scenario the skill doesn't cover at all.

```json
{
  "type": "DISCOVERY",
  "target": "error_handling_missing",
  "evidence": "Skill has no guidance on handling rate-limit errors (HTTP 429). Agent encountered 429 in test but skill only covers 200 and 500.",
  "suggested_fix": "Add a section on rate-limit handling: exponential backoff with jitter, respect Retry-After header."
}
```

### 2. OPTIMIZATION — Better Implementation Exists

The skill covers the scenario, but the trajectory shows a more effective approach.

```json
{
  "type": "OPTIMIZATION",
  "target": "file_search_strategy",
  "evidence": "Skill suggests 'use glob to find files'. Test run shows ace-search with semantic_search finds files 3x faster with better recall.",
  "suggested_fix": "Update file search guidance to recommend ace-search semantic_search as primary, glob as fallback."
}
```

### 3. SKILL DEFECT — Incorrect or Incomplete Content

The skill contains wrong, outdated, or underspecified information.

```json
{
  "type": "SKILL_DEFECT",
  "target": "git_branch_naming",
  "evidence": "Skill says 'use kebab-case for branch names' but doesn't specify a prefix convention. Agent created 'feature-xyz' instead of 'feat/xyz' per project convention.",
  "suggested_fix": "Specify full convention: feat/, fix/, docs/, refactor/, chore/ prefixes followed by kebab-case description."
}
```

### 4. EXECUTION LAPSE — Skill Correct, Agent Failed to Follow

The skill guidance is valid, but the agent didn't execute it correctly. **Do NOT revise the skill** — instead, strengthen the emphasis.

```json
{
  "type": "EXECUTION_LAPSE",
  "target": "test_before_commit",
  "evidence": "Skill clearly states 'run npm test before committing'. Agent committed without testing in trajectory 3.",
  "suggested_fix": "Strengthen wording: make 'run npm test' a BOLD mandatory step, add 'DO NOT skip this step' warning."
}
```

## Procedure

### Step 1: Gather Inputs

Collect the following:
1. **Current skill** — Read the SKILL.md file being evaluated
2. **Execution trajectory** — One of:
   - **First iteration**: The original OMS session data (stageHistory, logs, tasks, snapshots from state.json)
   - **Subsequent iterations**: SkillEvolver's test execution results (which strategies were tried, what succeeded/failed)

### Step 2: Map Trajectory to Skill

For each significant event in the trajectory:
1. Identify what the agent did
2. Find the corresponding skill instruction (or note its absence)
3. Classify the gap using the 4 signal types above

### Step 3: Produce Revision Signals

Compile findings into a JSON array:

```json
[
  {
    "type": "DISCOVERY",
    "target": "<area_name>",
    "evidence": "<what happened in the trajectory>",
    "suggested_fix": "<specific, actionable fix>"
  },
  ...
]
```

### Step 4: Prioritize

Rank signals by impact:
- **Critical**: DISCOVERY or SKILL_DEFECT that caused task failure
- **Important**: OPTIMIZATION that significantly improves outcomes
- **Minor**: EXECUTION_LAPSE emphasis strengthening

## Output Format

```
# EmbodiSkill Reflection Report

## Trajectory Source
[Original session | SkillEvolver iteration N]

## Revision Signals

### Critical
1. [DISCOVERY] <target> — <evidence summary>
   Fix: <suggested_fix>

### Important
2. [OPTIMIZATION] <target> — <evidence summary>
   Fix: <suggested_fix>

### Minor
3. [EXECUTION_LAPSE] <target> — <evidence summary>
   Fix: <suggested_fix>

## JSON Output
[Copy the JSON array for SkillEvolver to consume]
```

## Rules

- **Examine the skill first, then the trajectory** — your goal is to find where the skill failed to guide the agent
- **One signal per issue** — don't bundle multiple problems into one signal
- **Be specific** — cite exact trajectory events and exact skill sections
- **Distinguish DEFECT from LAPSE** — if the skill is correct, don't rewrite it, just strengthen emphasis
- **First iteration reflects on original session; subsequent iterations reflect on SkillEvolver test runs**
- **Maximum 10 signals per iteration** — focus on the most impactful issues
