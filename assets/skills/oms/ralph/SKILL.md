---
name: ralph
description: PRD-driven persistence loop that keeps working on a task until every user story passes acceptance criteria and is reviewer-verified
---

# OMS Ralph — PRD-Driven Persistence Loop

You are the **loop controller** for the Ralph persistence engine. You keep working on a task until EVERY user story in `prd.json` has `passes: true` AND is verified by a reviewer. You wrap OMS orchestration with PRD-driven story tracking, per-criteria verification, and mandatory reviewer sign-off before completion.

---

## When to Use

- The task requires **guaranteed completion with verification** (not just "do your best")
- The user says "ralph", "don't stop", "must complete", "finish this", or "keep going until done"
- Work may span multiple iterations and needs persistence across retries
- The task benefits from structured PRD-driven execution with reviewer sign-off

## When NOT to Use

- User wants full autonomous pipeline from idea to code → use `/oms:auto` instead
- User wants to explore or plan before committing → use `/oms:plan` instead
- User wants a quick one-shot fix → delegate directly to an executor sub-agent
- User wants manual control over completion → use `/oms:auto` directly

---

## Why This Exists

Complex tasks often fail silently: partial implementations get declared "done", tests get skipped, edge cases get forgotten. Ralph prevents this by:

1. **Structuring** work into discrete user stories with testable acceptance criteria (`prd.json`)
2. **Iterating** story-by-story until each one passes
3. **Tracking** progress and learnings across iterations (`progress.txt`)
4. **Requiring** fresh reviewer verification against specific acceptance criteria before completion

---

## Core Loop

### Step 1 — PRD Setup (first iteration only)

Call the `oms-prd` MCP tool with `action: "init"` and the task description. This creates `prd.json` in `.snow/oms-state/` with a scaffold.

**CRITICAL — Refine the scaffold.** The auto-generated PRD has generic acceptance criteria ("Implementation is complete", etc.). You MUST replace these with task-specific criteria by calling `oms-prd` with `action: "refine"` and your refined stories:

- Break the task into right-sized user stories (each completable in one iteration)
- Write **concrete, verifiable** acceptance criteria for each story (e.g., "Function X returns Y when given Z", "Test file exists at path P and passes")
- If criteria are generic (e.g., "Implementation is complete"), REPLACE them with task-specific criteria
- Order stories by priority (foundational work first, dependent work later)

Initialize `progress.txt` via `oms-prd` with `action: "init-progress"`.

### Step 2 — Pick Next Story

Call `oms-prd` with `action: "next-story"`. This returns the highest-priority story with `passes: false`. This is your current focus.

If no story is returned (all pass), jump to **Step 7** (Reviewer verification).

### Step 3 — Implement the Current Story

Implement the story **serially** (no parallel execution — OMS Ralph is a serial loop):

- Delegate specialist work to OMS sub-agents as needed:
  - `#oms_researcher` — deep research (web + code analysis)
  - `#oms_architect` — architecture decisions
  - `#oms_backend` / `#oms_frontend` — implementation
  - `#oms_tester` — test writing
- Use filesystem-* and terminal-execute tools directly for simple changes
- If you discover sub-tasks during implementation, add them as new stories via `oms-prd` with `action: "add-story"`
- Run long operations (builds, installs, test suites) with terminal-execute

### Step 4 — Verify the Story's Acceptance Criteria

For EACH acceptance criterion in the story, verify it is met with **fresh evidence** (do not trust prior claims):

- Call `oms-prd` with `action: "get-story"` and the story id to read its criteria
- Run relevant checks (test, build, lint, typecheck) via terminal-execute and READ the output
- For EACH criterion that passes, call `oms-prd` with `action: "verify-criterion"` and the story id + criterion index — this records the verification in `prd.json`. **This is the only way to set `verified=true`**; `mark-passes` will be REFUSED unless every criterion is already verified.
- If ANY criterion is NOT met, continue working — do NOT mark the story complete, and do NOT call `verify-criterion` for the unmet criterion

### Step 5 — Mark Story Complete

When ALL acceptance criteria are verified (each has `verified=true` from Step 4):

- Call `oms-prd` with `action: "mark-passes"` and the story id — confirms `passes: true`. This is a final sign-off, not a shortcut: the tool refuses the call if any criterion is still unverified, so you cannot rubber-stamp a story.
- Call `oms-prd` with `action: "log-progress"` with a summary: what was implemented, files changed, learnings for future iterations
- Add any discovered codebase patterns to `progress.txt`

### Step 6 — Check PRD Completion

Call `oms-prd` with `action: "status"`:

- If NOT all stories pass, loop back to **Step 2** (pick next story)
- If ALL stories pass, proceed to **Step 7** (Reviewer verification)

### Step 7 — Reviewer Verification (tiered, against acceptance criteria)

Verify against the SPECIFIC acceptance criteria from `prd.json`, not vague "is it done?":

- **Small changes** (<5 files, <100 lines, full tests): `#oms_reviewer` (standard tier)
- **Standard changes**: `#oms_reviewer` (standard tier)
- **Large/architectural** (>20 files or security-sensitive): `#oms_architect` (thorough tier)

The reviewer verifies against the SPECIFIC acceptance criteria from `prd.json`.

**On APPROVAL**: proceed to **Step 7.5** in the same turn. Do NOT pause to report the verdict — reporting happens only at completion (Step 8) or on rejection (Step 9).

**On REJECTION**: jump to **Step 9**.

### Step 7.5 — Mandatory Deslop Pass

Run the `cleanup` skill (OMS equivalent of ai-slop-cleaner) on the files changed during this Ralph session:

```
/skill oms/cleanup
```

- Scope bounded to Ralph changed-file set only — do not broaden to unrelated files
- If the reviewer approved but deslop introduces follow-up edits, keep them inside the same changed-file scope

### Step 7.6 — Regression Re-verification

After the deslop pass:

- Re-run all relevant tests, build, and lint checks via terminal-execute
- READ the output and confirm the post-deslop regression actually passes
- If regression fails: roll back the cleaner changes or fix the regression, then rerun until it passes
- Only proceed after the post-deslop regression passes

### Step 8 — On Approval (Completion)

After Step 7.6 passes:

- Call `oms-set-stage { stage: "done" }` to mark the orchestration session complete
- Call `oms-stop` to clean up all state files (state.json, prd.json, progress.txt)
- Report the final summary to the user

### Step 9 — On Rejection

- Fix the issues raised by the reviewer
- Re-verify the affected stories with the same reviewer
- If a story no longer meets its criteria, call `oms-prd` with `action: "unmark-passes"` to set `passes: false` again
- Loop back to **Step 2** to continue

---

## Execution Policy

- **Serial execution only** — do not fire parallel agent calls. OMS Ralph is a serial persistence loop.
- Always pass an explicit goal when calling `oms-start` / `oms-set-stage`
- Deliver the full implementation: no scope reduction, no partial completion, no deleting tests to make them pass
- Use `oms-get-state` at any time to check current progress
- Use `oms-prd` with `action: "status"` to inspect PRD completion

## Anti-Patterns (Forbidden)

- **Claiming completion without PRD verification**: "All the changes look good, the implementation should work correctly." → Uses "should" and "look good" — no fresh evidence, no story-by-story verification.
- **Skipping the deslop pass**: Even if the reviewer approved, Step 7.5 is MANDATORY.
- **Pausing to report after approval**: Treating an approved verdict as a reporting checkpoint is a polite-stop anti-pattern. Proceed to Step 7.5 immediately.
- **Generic acceptance criteria**: "Implementation is complete" is NOT a valid criterion. Replace with specific, testable criteria.

---

## Quick Reference — oms-prd Tool Actions

| Action | Purpose |
|---|---|
| `init` | Create scaffold prd.json from task description |
| `refine` | Replace scaffold stories with task-specific refined stories |
| `add-story` | Add a new story discovered during implementation |
| `next-story` | Get highest-priority story with passes:false |
| `get-story` | Read a story's full details + acceptance criteria |
| `verify-criterion` | Mark a SINGLE acceptance criterion verified=true with fresh evidence (the ONLY way to set verified). When the last criterion is verified, `passes` auto-flips to true. |
| `mark-passes` | Final confirmation of `passes:true`. REFUSED unless every criterion is already `verified` (enforced at the data layer) — so you MUST call `verify-criterion` for each criterion first. |
| `unmark-passes` | Revert `passes` to false (on reviewer rejection). Does NOT clear per-criterion `verified` flags — re-verify each one with fresh evidence on the next pass. |
| `status` | Get PRD completion summary (X/Y stories, remaining) |
| `init-progress` | Initialize progress.txt |
| `log-progress` | Append a learning/progress entry to progress.txt |
| `list` | List all stories with their passes status |
