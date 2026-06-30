---
name: trace
description: Trace execution paths through code, recording call chains and state changes.
---

# OMS Trace Skill

This skill traces execution paths through a codebase, recording the call chain and state changes at each step. Use this when you need to understand exactly how a specific feature or code path executes from start to finish.

## When to Use

- Debugging a specific issue by following the execution path
- Understanding how a feature works end-to-end
- Verifying that a code change won't have unintended side effects
- Onboarding someone to a complex code path

## Procedure

### Step 1: Identify the Entry Point

Determine where execution begins for the feature you're tracing:
- A user action (button click, API call, CLI command)
- A scheduled job or event handler
- A function call from another module

Use `codebase-search` to find the entry point by searching for relevant keywords or function names.

### Step 2: Build the Call Chain

Starting from the entry point, follow each function call:

1. Read the function body using `filesystem-read`
2. Identify all function/method calls within the body
3. For each call, determine if it's:
   - **Internal** — A call to another function in the same codebase → follow it
   - **External** — A call to a library/framework function → note it but don't trace inside
   - **Conditional** — A call inside an if/switch → note the condition and both branches
4. Record the call in the chain with: function name, file, line number, and purpose

Use `ace-search` with `action: find_definition` to resolve function references.

### Step 3: Record State Changes

At each step in the call chain, identify state changes:

- **Variable mutations** — Local variables that change value
- **Object property changes** — Properties set or modified on objects
- **Database writes** — INSERT, UPDATE, DELETE operations
- **File system writes** — Files created, modified, or deleted
- **External API calls** — Requests sent to external services
- **Event emissions** — Events dispatched to listeners
- **Global state changes** — Module-level or global variable modifications

### Step 4: Identify Branch Points

For each conditional branch (if/else, switch, ternary):
1. Record the condition being evaluated
2. Trace the path for each branch (at least the likely ones)
3. Note which branch is taken under what circumstances

### Step 5: Map Error Paths

For each function in the chain:
- What exceptions can it throw?
- How are they caught (or not)?
- What state is left in if an error occurs mid-execution?

### Step 6: Produce the Trace Report

Compile the full trace into a structured report.

## Output Format

```
# Execution Trace Report

## Entry Point
[Function name, file:line, trigger condition]

## Call Chain

### 1. [functionName] (file.ts:42)
Purpose: [what this function does]
Calls:
  - → [nextFunction] (file.ts:88)
State changes:
  - Sets `user.status = 'active'`
  - Writes to database: UPDATE users SET status='active'

### 2. [nextFunction] (file.ts:88)
Purpose: [what this function does]
Calls:
  - → [external] axios.post(url) — external API call
  - → [anotherFunction] (file.ts:120)
State changes:
  - Emits event 'user:activated'

## Branch Analysis
- At step 2: if `user.role === 'admin'` → takes admin path (step 2a)
  - else → takes regular path (step 2b)

## Error Paths
- Step 1: Database write fails → exception propagates to caller, user.status unchanged
- Step 2: API call fails → caught by try/catch, logged, continues

## Summary
[Key observations: total steps, external dependencies, critical state mutations]
```

## Rules

- Follow every internal call — don't skip steps
- Always cite exact file and line numbers
- Distinguish between what WILL happen vs what COULD happen (branches)
- Note any assumptions about runtime conditions
- If a function is too deep to trace fully, note where you stopped and why
