---
name: plan
description: Strategic planning through consensus — analyzes codebase, drives a Planner→Architect→Critic loop, produces a RALPLAN-DR + ADR decision artifact, and gates execution behind explicit user approval before any code is written.
---

# OMS Plan Skill

This skill drives structured strategic planning inside the OMS `planning`
stage. It analyzes the codebase, runs a Planner → `#oms_architect` →
`#oms_critic` consensus loop, produces a RALPLAN-DR + ADR decision artifact
mapped to PRD stories, and gates execution behind explicit user approval.
Use this before any non-trivial implementation work.

The `/oms:plan` command is the entry point — it calls `oms-start` and loads
this skill via `skill-execute`. This SKILL.md is the single source of truth
for the full procedure, mode selection, consensus loop, quality standards,
and the approval gate. Do NOT re-derive these rules from the command prompt.

---

## When to Use

- User wants to plan before implementing — "plan this", "规划", "先列计划"
- The request is vague or broad and needs scoping before code is written
- User wants multi-perspective consensus — `--consensus`, "ralplan"
- User wants an existing plan/PRD reviewed — `--review`, "review this plan"
- High-risk change needs pre-mortem + expanded test plan — `--deliberate`, or
  the request touches auth/security, data migration, destructive/irreversible
  changes, production incidents, compliance/PII, or public API breakage

## When NOT to Use

- User wants end-to-end autonomous execution → use `/oms:auto`
- Request is a single clear fix with obvious scope → use `/oms:dive` or
  delegate directly to an executor sub-agent
- User wants to start coding immediately with a clear task → use `/oms:ralph`
- User asks a simple question that can be answered directly → just answer it

---

## Why This Exists

Jumping into code without understanding requirements leads to rework, scope
creep, and missed edge cases. Plan provides structured requirements gathering,
expert consensus validation, and quality-gated decision artifacts so execution
starts from a solid foundation.

OMS's stage machine + hooks hard-block file edits during planning, and the PRD
system makes every decision traceable and verifiable story-by-story. This skill
adds the missing pieces: multi-perspective consensus, structured decision
output (RALPLAN-DR + ADR), and an explicit approval gate so the planning stage
knows when to STOP and ask the user rather than looping indefinitely or
auto-transitioning to execution.

---

## Procedure

### Mode Selection

| Mode | Trigger | Behavior |
|---|---|---|
| Interview | Default for broad requests | Socratic requirements gathering (one question at a time) |
| Direct | `--direct` or detailed request | Skip interview, generate plan directly |
| Consensus | `--consensus` or "ralplan" | Planner → `#oms_architect` → `#oms_critic` loop until agreement |
| Review | `--review` or "review this plan" | `#oms_critic` evaluates an existing plan/PRD |

A request is "broad" when it has vague verbs, no specific files, and touches
3+ areas. A request is "detailed" when it names specific files, functions,
or acceptance criteria.

### Interview Mode (broad/vague requests)

1. **Classify the request** — broad requests trigger interview mode
2. **Gather codebase facts FIRST** — delegate to `#oms_researcher` (external
   docs + code analysis) or `#oms_architect` (codebase structure) to find
   existing implementation. Never ask the user what you can look up yourself.
3. **Ask ONE focused question at a time** via `askuser-ask_question`, each
   building on the previous answer. Offer 2-3 concrete options where possible.
4. **Stop when requirements are clear enough to plan** — do not over-interview
5. **Proceed to Consensus Mode step 1** to produce the structured plan

### Direct Mode (detailed requests)

1. **Brief `#oms_architect` consultation** (optional) — for hidden constraints
   or coupling risks
2. **Generate the plan + RALPLAN-DR summary directly** (see Output Format)
3. **Optional `#oms_critic` review** — if the user wants a second pass
4. **Proceed to the Approval gate** (Consensus Mode step 7)

### Consensus Mode (`--consensus` / "ralplan")

**RALPLAN-DR modes**: Short (default) and Deliberate. Deliberate mode is
forced by `--deliberate` OR by high-risk signals in the request: auth/security,
data migration, destructive/irreversible changes, production incidents,
compliance/PII, public API breakage. Deliberate mode adds a pre-mortem and
an expanded test plan.

#### Step 1 — Planner creates initial plan + RALPLAN-DR summary

Create the initial plan and a compact RALPLAN-DR summary BEFORE any review:

- **Principles** (3-5) — the guiding design principles for this work
- **Decision Drivers** (top 3) — the forces that should steer the decision
- **Viable Options** (≥2) with bounded pros/cons for each
- If only one viable option remains, give an explicit **invalidation
  rationale** for the rejected alternatives
- **Deliberate mode only**: pre-mortem (3 failure scenarios) + expanded test
  plan (unit / integration / e2e / observability)

Use `oms-add-task` to record the working task list during drafting.

#### Step 2 — Draft feedback (`--interactive` only)

If `--interactive` is set, present the draft + RALPLAN-DR summary to the user
via `askuser-ask_question` with these options:

- Proceed to review — send to `#oms_architect` and `#oms_critic`
- Request changes — return to step 1 with user feedback incorporated
- Skip review — go directly to the approval gate (step 7)

Without `--interactive`, automatically proceed to review (step 3).

#### Step 3 — Architect review

Delegate to `#oms_architect` for architectural soundness. The Architect MUST
provide:

- The strongest **steelman counterargument** (antithesis) against the favored
  option
- At least one real **tradeoff tension**
- When possible, a **synthesis path**
- In deliberate mode: explicitly flag any principle violations

**Wait for this step to complete before step 4. Do NOT run steps 3 and 4
in parallel** — the Critic must see the Architect's output first.

#### Step 4 — Critic evaluation

Delegate to `#oms_critic` for quality evaluation. Run only after step 3
completes. The Critic MUST verify:

- Principle-option consistency
- Fair alternative exploration (no strawman options)
- Risk mitigation clarity
- Testable acceptance criteria
- Concrete verification steps

In deliberate mode, the Critic MUST reject a missing/weak pre-mortem or
missing/weak expanded test plan.

#### Step 5 — Re-review loop (max 5 iterations)

If the Critic rejects (verdict other than APPROVE):

a. Collect all rejection feedback from Architect + Critic
b. Planner produces a revised plan
c. Return to **Step 3** — Architect reviews the revised plan
d. Return to **Step 4** — Critic evaluates the revised plan
e. Repeat until Critic approves OR 5 iterations reached
f. If max iterations reached without approval, present the best version to
   the user via `askuser-ask_question` with a note that expert consensus was
   not reached

#### Step 6 — Apply improvements

When reviewers approve (with or without improvement suggestions), merge all
accepted improvements into the plan. The final consensus output MUST include
an **ADR** section:

- **Decision** — what was decided
- **Drivers** — the decision drivers that led here
- **Alternatives considered** — the options rejected
- **Why chosen** — why the chosen option won
- **Consequences** — what we accept by choosing this
- **Follow-ups** — downstream work this decision creates

#### Step 7 — Approval gate (CRITICAL — distinguishes planning from execution)

Mark the plan `pending approval`. This is the boundary between planning and
execution.

> **Enforcement note**: this gate is enforced by **convention + the filesystem
> hook**, not at the `oms-set-stage` layer. The `before-tool-call` hook
> hard-blocks `filesystem-*` edits while `stage === "planning"`, so no source
> changes can land until the stage flips to `executing`. But `oms-set-stage`
> itself does NOT refuse a `planning → executing` transition — so
> auto-transitioning without approval is a convention violation the AI MUST
> avoid per the Anti-Patterns section, not a code-level impossibility. Future
> hardening could add a `pending_approval` gate state to refuse the transition
> server-side; until then, the SKILL.md + Anti-Patterns are the contract.

- **With `--interactive`**: present the plan to the user via
  `askuser-ask_question` with these options:
  - Approve via `/oms:team` (parallel coordinated agents — recommended for
    large tasks)
  - Approve via `/oms:ralph` (serial execution with per-story verification)
  - Approve via `/oms:auto` (autonomous loop)
  - Request changes (return to step 1 with feedback)
  - Reject (discard the plan entirely)
- **Without `--interactive`**: output the final plan marked `pending
  approval`, save it to `.snow/oms-state/plans/`, and STOP. Do NOT
  auto-transition to executing. Do NOT call `oms-set-stage`.

#### Step 8 — On approval

After the user explicitly approves:

1. **Persist decisions as PRD stories** — call `oms-prd` with
   `action: "refine"`, passing task-specific stories whose acceptance
   criteria are the testable verification targets from the plan. This is
   what makes every decision traceable story-by-story.
2. **Save the plan artifact** — write the full plan (with RALPLAN-DR + ADR)
   to `.snow/oms-state/plans/<slug>.md` so future iterations can recall
   why decisions were made.
3. **Transition to executing** — call `oms-set-stage` with `stage: "executing"`.
4. **Hand off to the chosen execution skill** — invoke `/oms:team`,
   `/oms:ralph`, or `/oms:auto` with the plan context. Do NOT implement
   directly in the planning agent.

### Review Mode (`--review`)

1. Read the existing plan from `.snow/oms-state/plans/` or the PRD via
   `oms-prd` `action: "list"`
2. Delegate to `#oms_critic` for evaluation against the quality criteria
3. Return verdict: APPROVED / REVISE (with specific feedback) / REJECT
   (replanning required)

---

## Execution Policy

- **Planning/execution boundary**: the planning stage inspects context and
  produces plan/spec/proposal artifacts only. It MUST NOT edit source files,
  commit, push, open PRs, invoke execution skills, or delegate implementation
  tasks. The `before-tool-call` hook hard-blocks `filesystem-*` tools in
  planning; commit/push/PR must also be avoided by convention.
- **Approval gate is mandatory**: execution MUST NOT begin without explicit
  user approval. This is what prevents the planning stage from looping
  indefinitely (the AI knows when to STOP and ask) or auto-transitioning to
  executing on its own.
- **Consensus loop ordering**: Architect (step 3) and Critic (step 4) MUST
  run sequentially, never in parallel. Always await the Architect result
  before issuing the Critic call.
- **PRD-driven decisions**: RALPLAN-DR Options map to PRD stories; each
  story's acceptance criteria must be testable. The ADR lives in the plan
  artifact file, not in the PRD.
- Always pass an explicit goal when calling `oms-start`.

---

## Anti-Patterns (Forbidden)

- **Auto-transitioning without approval**: silently calling
  `oms-set-stage {stage:"executing"}` after drafting a plan, bypassing the
  approval gate. The planning stage's job is to produce a `pending approval`
  artifact and stop.
- **Parallel Architect + Critic**: firing `#oms_architect` and `#oms_critic`
  in the same turn. The Critic must see the Architect's output first —
  always await step 3 before step 4.
- **Generic acceptance criteria**: "implementation is complete" is NOT
  valid. Replace with specific, testable criteria before refining the PRD.
- **Asking the user what you can look up**: "where is auth implemented?" →
  delegate to `#oms_researcher` instead of asking the user.
- **Batching interview questions**: asking 3+ questions at once. Ask ONE
  focused question at a time, each building on the previous answer.
- **Skipping the approval gate in non-interactive mode**: marking the plan
  as approved without user opt-in. Non-interactive means output `pending
  approval` and stop — not auto-execute.
- **Vague terms without metrics**: "fast" → "p99 < 200ms"; "secure" →
  "authz check on every route in src/routes/".

---

## Output Format

Every plan is saved to `.snow/oms-state/plans/<slug>.md` (NOT `.snow/plan/`,
which belongs to snow-cli's own planning documents — OMS plan artifacts stay
in the OMS state namespace to avoid mixing).

```markdown
# Plan: <task>

## Requirements Summary
<one-paragraph restatement of the confirmed goal and scope>

## Acceptance Criteria (testable — mapped to PRD stories)
- [ ] <criterion 1>
- [ ] <criterion 2>

## Implementation Steps (with file:line references)
1. <step> — touches `src/foo.ts:42`
2. <step> — touches `src/bar.ts:15`

## Risks and Mitigations
- **Risk**: <risk> → **Mitigation**: <action>

## Verification Steps
1. <how to verify — command, test, or manual check>

## RALPLAN-DR Summary (consensus mode only)
- **Principles**: <3-5>
- **Decision Drivers**: <top 3>
- **Viable Options**: <≥2 with pros/cons>

## ADR (consensus final output only)
- **Decision**: <what was decided>
- **Drivers**: <decision drivers>
- **Alternatives considered**: <rejected options>
- **Why chosen**: <rationale>
- **Consequences**: <what we accept>
- **Follow-ups**: <downstream work created>

## Pre-mortem + Expanded Test Plan (deliberate mode only)
- **Failure scenarios**: <3>
- **Test plan**: unit / integration / e2e / observability
```

Drafts go to `.snow/oms-state/plans/<slug>.draft.md` during iteration; the
final approved plan is saved to `<slug>.md` (drop the `.draft` suffix).

---

## Rules

- Stop interviewing when requirements are clear enough to plan — do not
  over-interview.
- In consensus mode, stop after 5 iterations and present the best version.
- Non-interactive mode outputs `pending approval` and stops — no auto-exec.
- If the user says "just do it" or "skip planning" without naming an
  execution path, output the `pending approval` plan and require an explicit
  choice via `askuser-ask_question`. Do NOT auto-transition.
- Escalate to the user on irreconcilable tradeoffs requiring a business
  decision.
- Every claim cites a file:line reference (80%+ of claims).
- 90%+ of acceptance criteria must be testable.
- No vague terms without metrics.

---

## Quick Reference

| Tool / Agent | Purpose in Plan |
|---|---|
| `oms-start` | Initialize the planning session (stage = `planning`) |
| `oms-add-task` | Local task tracking during planning |
| `oms-prd` `action:"refine"` | Persist decisions as verifiable PRD stories (step 8) |
| `oms-prd` `action:"list"` | Read existing PRD for Review mode |
| `oms-set-stage` | Transition to `executing` AFTER approval (step 8) |
| `oms-snapshot` | Save long-planning intermediate state |
| `askuser-ask_question` | Approval gate + draft feedback + interview questions |
| `#oms_researcher` | Codebase facts + external docs (Interview + Direct) |
| `#oms_architect` | Architectural review (Consensus step 3) |
| `#oms_critic` | Quality evaluation (Consensus step 4 + Review mode) |
