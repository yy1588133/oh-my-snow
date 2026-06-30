---
name: interview
description: Conduct deep interviews to clarify requirements through iterative questioning.
---

# OMS Interview Skill

This skill enables the AI to conduct Socratic-style requirement clarification interviews. Use this when requirements are ambiguous, incomplete, or when the user's request could be interpreted in multiple ways.

## When to Use

- The user's request is vague or high-level (e.g., "make it better", "add a feature")
- Multiple valid interpretations exist for the request
- Critical constraints (performance, budget, timeline) are unknown
- The scope boundaries are unclear

## Procedure

### Step 1: Initial Assessment

Read the user's request carefully. Identify what is explicitly stated versus what is assumed. List the key unknowns that could change your approach.

### Step 2: Classify Unknowns

Categorize each unknown by impact:
- **Critical** — Without this information, you cannot proceed meaningfully
- **Important** — This will significantly affect your approach
- **Nice-to-have** — This would improve quality but isn't blocking

### Step 3: Formulate Questions

For each critical and important unknown, craft a focused question following these rules:

1. **One question at a time** — Never overwhelm the user with a wall of questions
2. **Offer context** — Briefly explain why the question matters
3. **Provide options** — Where possible, give 2-3 concrete options to choose from
4. **Show your work** — Explain what you've already understood so the user can correct you

### Step 4: Iterative Deepening

After each answer:
- Update your understanding
- Identify new unknowns the answer revealed
- Ask the next most critical question
- Stop when all critical unknowns are resolved

### Step 5: Summarize Understanding

Once sufficient clarity is achieved, produce a structured summary:
- **Goal**: Restate the confirmed goal in one sentence
- **Scope**: What is in-scope and out-of-scope
- **Constraints**: All known constraints (technical, timeline, etc.)
- **Success Criteria**: How to know the work is done
- **Open Items**: Remaining unknowns you'll handle with reasonable defaults

## Question Templates

Use these patterns to structure your questions:

- **Scope clarification**: "Should this cover [A] only, or also include [B]? For context, [A] is simpler but [B] gives a more complete solution."
- **Priority**: "If we can't do everything, which is more important: [X] or [Y]?"
- **Technical constraint**: "Are there any constraints on [technology/approach]? For example, [option A] vs [option B]."
- **Edge cases**: "What should happen when [edge case scenario]?"

## Output Format

When conducting an interview, structure your responses as:

```
## Current Understanding
[Brief summary of what you know so far]

## Question [N]
**Context**: [Why this matters]
**Question**: [The actual question]
**Options** (if applicable):
  - Option A: [description]
  - Option B: [description]
```

## Rules

- Never assume — if you don't know, ask
- Never ask more than 3 questions in a single turn
- Always acknowledge the user's previous answer before asking the next question
- If the user says "use your best judgment", note that and proceed with reasonable defaults
- Keep the interview focused — don't ask about trivia that won't change your approach
