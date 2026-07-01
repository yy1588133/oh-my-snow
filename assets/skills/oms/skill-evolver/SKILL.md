---
name: skill-evolver
description: Meta-skill for skill lifecycle management — author, deploy, test, and refine skills through strategy-diversified exploration.
---

# SkillEvolver — Skill Lifecycle Manager

This skill manages the **entire lifecycle of a skill artifact**: authoring, deploying to test agents, collecting results, and refining. It uses **strategy-diversified exploration** to generate multiple candidate approaches per iteration.

## When to Use

- After EmbodiSkill has produced revision signals (you need targeted improvements)
- Before darwin-skill evaluates and scores candidates
- You are the **explorer** in the diagnose → explore → evaluate pipeline

## Core Principle

> Don't just fix the symptom — explore K different strategies to solve the same problem, test each one, and let the evidence decide.

## Procedure

### Step 1: Receive Revision Signals

EmbodiSkill provides a JSON array of revision signals. For each signal:
1. Understand the target area and suggested fix
2. Note the signal type (DISCOVERY, OPTIMIZATION, SKILL_DEFECT, EXECUTION_LAPSE)

### Step 2: Strategy-Diversified Exploration

For each revision signal (or cluster of related signals), generate **K=4 distinct strategies**:

```
Signal: [DISCOVERY] rate-limit handling missing

Strategy 1: Exponential backoff with jitter
  - Use retry-after header when present
  - Start with 1s delay, multiply by 2, add random 0-500ms jitter
  - Max 5 retries

Strategy 2: Circuit breaker pattern
  - Track failure rate per endpoint
  - Open circuit after 5 consecutive failures
  - Half-open after 30s cooldown

Strategy 3: Queue + worker pattern
  - Enqueue all requests
  - Worker processes at controlled rate
  - Retry failed items with increasing delay

Strategy 4: Token bucket rate limiter
  - Client-side rate limiting
  - Refill tokens at known rate limit / window
  - Block when tokens exhausted
```

Each strategy must cover a **different axis** (library choice, algorithm family, architectural pattern, etc.) — not just token-level variations of the same approach.

**Candidate cap**: Maximum 8 total candidates per iteration. If more than 8 are generated, prioritize by:
1. Critical signals first
2. Strategies most likely to generalize
3. Strategies least similar to already-tried approaches

### Step 3: Deploy and Test

For each candidate strategy:
1. Create a modified SKILL.md incorporating the strategy
2. Deploy it to a fresh test agent
3. Run the same test tasks used to generate the original revision signals
4. Collect:
   - Did the agent succeed?
   - Did the agent follow the skill correctly?
   - Were there new failure modes?

### Step 4: Independent Audit

After testing, an **independent auditor** (not the same agent that authored the strategy) checks each candidate for overfitting:

1. **Hardcoded literals** — Does the skill hardcode specific values that should be parameters?
2. **Untraceable claims** — Does the skill make assertions without evidence?
3. **Parametric-axis under-abstraction** — Is the skill too specific to one scenario?
4. **Primary-action hoisting** — Is the core action buried under too much preamble?
5. **Silent bypass** — Could the agent ignore the skill at runtime without detection?

A candidate with audit violations is either fixed (if violations are minor) or rejected.

### Step 5: Select Best Candidates

From the audited candidates:
1. Rank by test success rate
2. Break ties by audit cleanliness (fewer violations)
3. Select the top candidate for darwin-skill evaluation
4. If no candidate improved over the baseline, report this honestly

## Output Format

```
# SkillEvolver Iteration Report

## Input Signals
[Summary of revision signals from EmbodiSkill]

## Strategies Explored

### Strategy 1: [Name]
**Approach**: [Brief description]
**Test Result**: [Pass/Fail + details]
**Audit**: [Clean / N violations]

### Strategy 2: [Name]
[Same structure]

[...up to 8 strategies...]

## Selected Candidate
**Strategy**: [Name]
**Rationale**: [Why this candidate was selected]
**Changes from baseline**: [Diff summary]

## Test Trajectory
[Full test execution trajectory for EmbodiSkill's next iteration]
```

## Rules

- **K=4 strategies per signal**, but **cap total candidates at 8 per iteration** (truncate by priority)
- **Each strategy must be genuinely different** — different library, algorithm, or architecture
- **The auditor must be independent** — never the same agent that authored the strategy
- **Report failures honestly** — if no candidate improved, say so
- **Preserve the baseline** — if all candidates are worse, keep the current skill unchanged
- **Document every decision** — why each strategy was chosen, why each passed/failed audit
