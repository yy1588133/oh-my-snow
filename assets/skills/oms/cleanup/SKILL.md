---
name: cleanup
description: Detect and clean up AI-generated redundant or low-quality code.
---

# OMS Cleanup Skill

This skill detects and removes redundant, duplicated, or low-quality code that often results from AI-assisted development. Use this to keep the codebase clean and maintainable after AI-generated code has accumulated.

## When to Use

- After a long AI-assisted coding session where many files were created/modified
- When reviewing a pull request that contains AI-generated code
- Periodically as part of code maintenance
- Before a release to ensure code quality

## Procedure

### Step 1: Detect Redundant Code

Scan for common patterns of AI-generated redundancy:

1. **Duplicate functions** — Multiple functions doing the same thing with slightly different names or signatures
2. **Over-commented code** — Excessive comments that restate obvious code (e.g., `// increment i by 1` for `i++`)
3. **Dead code** — Functions, variables, or imports that are defined but never used
4. **Over-abstraction** — Wrapper functions or interfaces that add no value beyond forwarding calls
5. **Boilerplate duplication** — Repeated blocks of similar code that could be extracted into a shared function

Use `codebase-search` and `ace-search` with `action: find_references` to detect these patterns.

### Step 2: Detect Low-Quality Code

Scan for quality issues common in AI-generated code:

1. **Inconsistent error handling** — Some functions throw, some return null, some log and continue
2. **Magic numbers** — Hardcoded values without named constants
3. **Improper naming** — Variables named `data`, `result`, `temp`, `x` without clear meaning
4. **Overly defensive code** — Excessive null checks for values that can never be null
5. **Copy-paste errors** — Code that was copied but not fully adapted to the new context
6. **Misplaced comments** — Comments that don't match the code they describe
7. **Unnecessary async/await** — Functions marked async that don't use await

### Step 3: Detect Structural Issues

1. **God files** — Files with more than 500 lines that should be split
2. **Circular dependencies** — Modules that import each other
3. **Mixed concerns** — Files handling multiple unrelated responsibilities
4. **Inconsistent patterns** — Different approaches to the same problem across the codebase

### Step 4: Create Cleanup Plan

Prioritize findings by impact:
- **Critical** — Dead code, broken imports, syntax errors
- **High** — Duplicate functions, mixed concerns
- **Medium** — Over-commenting, naming, magic numbers
- **Low** — Stylistic inconsistencies

### Step 5: Execute Cleanup

For each item in the cleanup plan:
1. **Read** the affected file(s) using `filesystem-read`
2. **Verify** that the code is truly redundant by checking all references with `ace-search`
3. **Remove or consolidate** the redundant code
4. **Extract** shared logic into reusable functions
5. **Rename** unclear variables and functions
6. **Remove** unnecessary comments
7. **Consolidate** error handling patterns

### Step 6: Verify Changes

After cleanup:
1. Run the build to ensure no compilation errors: `terminal-execute` with build command
2. Run tests to ensure no regressions
3. Check IDE diagnostics for any new warnings

## Output Format

Produce a cleanup report:

```
# Code Cleanup Report

## Issues Found

### Critical
- [file.ts:42] Dead function `unusedHelper()` — never called

### High
- [utils.ts:15, utils.ts:89] Duplicate functions `formatDate` and `formatDateString`

### Medium
- [parser.ts:120] Magic number `86400` should be named `SECONDS_PER_DAY`

## Cleanup Actions Taken
- [x] Removed `unusedHelper()` from file.ts
- [x] Consolidated `formatDate` and `formatDateString` into single `formatDate()`
- [x] Extracted `SECONDS_PER_DAY = 86400` as constant

## Verification
- Build: ✅ Passed
- Tests: ✅ All 42 tests passed
- Diagnostics: ✅ No new warnings
```

## Rules

- Never remove code without checking ALL references first
- Always run the build after cleanup
- Preserve behavior — cleanup is refactoring, not feature removal
- Keep a record of what was removed and why
- When in doubt, keep the code and flag it for manual review
