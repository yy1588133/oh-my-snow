---
name: dive
description: Perform deep code analysis covering structure, dependencies, data flow, and risk assessment.
---

# OMS Dive Skill

This skill performs a systematic deep code analysis through four progressive layers: structure, dependencies, data flow, and risks. Use this when you need to thoroughly understand a codebase before making changes.

## When to Use

- Before starting a complex refactoring
- When inheriting an unfamiliar codebase
- Before proposing architectural changes
- When diagnosing root causes of systemic issues

## Procedure

### Layer 1: Structure Analysis

Goal: Understand the high-level organization of the code.

1. **Directory tree** — Map the top-level directory structure
2. **Entry points** — Identify main entry points (main, index, app, server files)
3. **Module boundaries** — Identify how the code is divided into modules/packages
4. **File inventory** — Count files by type and identify the largest/most complex files
5. **Naming conventions** — Identify naming patterns and inconsistencies

Use `filesystem-read` on directories and `codebase-search` to find entry points.

### Layer 2: Dependency Analysis

Goal: Map what depends on what.

1. **Import graph** — For key modules, trace their imports to build a dependency graph
2. **External dependencies** — List third-party packages (package.json, requirements.txt, go.mod, etc.)
3. **Internal coupling** — Identify tightly coupled modules that should probably be decoupled
4. **Circular dependencies** — Detect any circular import chains
5. **Dependency depth** — Calculate the longest dependency chain to critical paths

Use `ace-search` with `action: find_references` to trace dependencies.

### Layer 3: Data Flow Analysis

Goal: Understand how data moves through the system.

1. **Input boundaries** — Where does data enter the system? (API endpoints, file readers, user input)
2. **Transformations** — How is data transformed as it flows through the system?
3. **State management** — Where is state stored and mutated? (databases, global state, caches)
4. **Output boundaries** — Where does data leave the system? (API responses, file outputs, logs)
5. **Side effects** — Identify operations that have side effects beyond their return value

Trace data flow by following function call chains from input to output.

### Layer 4: Risk Assessment

Goal: Identify potential problem areas.

1. **Complexity hotspots** — Files/functions with high cyclomatic complexity
2. **Fragile code** — Code that breaks easily when touched (no tests, many dependents)
3. **Technical debt** — TODO/FIXME/HACK comments, deprecated API usage, code smells
4. **Security risks** — Unvalidated input, hardcoded secrets, unsafe operations
5. **Performance risks** — N+1 queries, unnecessary allocations, blocking I/O
6. **Missing tests** — Critical paths without test coverage

## Output Format

Produce a structured analysis report:

```
# Deep Code Analysis Report

## 1. Structure
[Directory map, entry points, module boundaries]

## 2. Dependencies
[Dependency graph, coupling analysis, circular dependencies]

## 3. Data Flow
[Input → Processing → State → Output diagram, side effects]

## 4. Risks
[Risk items with severity: High/Medium/Low]

## 5. Recommendations
[Prioritized list of improvements]
```

## Rules

- Always read actual code, never guess
- Trace at least 2-3 complete data flow paths
- Rate each risk as High/Medium/Low with justification
- Provide actionable recommendations, not just observations
- Flag any assumptions you had to make
