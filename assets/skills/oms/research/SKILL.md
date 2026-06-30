---
name: research
description: Conduct autonomous multi-step research combining web search and code analysis.
---

# OMS Autonomous Research Skill

This skill conducts autonomous multi-step research by combining web search, code analysis, and iterative refinement. Use this when you need to investigate a topic, compare approaches, or gather information that requires both external sources and codebase understanding.

## When to Use

- Evaluating different libraries or frameworks for a project
- Researching best practices for a specific pattern or architecture
- Investigating how a third-party API or service works
- Comparing implementation approaches before coding
- Understanding how similar features are implemented in other projects

## Procedure

### Step 1: Define Research Question

Clearly articulate what you need to find out:
- What is the specific question or decision being researched?
- What are the key criteria for evaluation (performance, ease of use, cost, etc.)?
- What is the scope (which alternatives, what timeframe, what constraints)?
- What would a successful answer look like?

Write down the research question and criteria before starting.

### Step 2: Initial Web Search

Use `websearch-search` to find relevant information:
1. Search with 2-3 different query formulations to get diverse results
2. Identify the most credible and relevant sources (official docs, reputable tech blogs, benchmarks)
3. Use `websearch-fetch` to read the full content of the most promising result
4. Take notes: key facts, pros/cons, version info, dates

### Step 3: Codebase Analysis

If the research involves the current project:
1. Use `codebase-search` to find how similar things are already done in the codebase
2. Use `ace-search` to find existing patterns, utilities, or dependencies
3. Check if there are constraints that would affect the decision (existing dependencies, coding standards)
4. Note any existing patterns the research should align with

### Step 4: Deep Dive

Based on initial findings, identify gaps and search more specifically:
1. If a source references another important source, fetch that too
2. Search for counter-arguments or known issues with promising options
3. Look for benchmarks, case studies, or migration stories
4. Check for recent updates or deprecations

### Step 5: Synthesize Findings

Compile all findings into a structured analysis:
1. **Direct comparison** — Create a comparison table of options against criteria
2. **Evidence** — Cite sources for each claim
3. **Context** — Relate findings to the specific project context
4. **Trade-offs** — Explicitly state what you gain and what you lose with each option

### Step 6: Form Recommendation

Based on the synthesized findings:
1. State a clear recommendation with justification
2. List the conditions under which you'd recommend an alternative
3. Note any risks or unknowns that could change the recommendation
4. Suggest next steps (prototype, benchmark, deeper investigation)

## Iteration Rules

- If initial search results are insufficient, reformulate the query and search again
- If findings conflict, note the conflict and investigate further
- If a source is outdated (> 2 years old for fast-moving topics), note that and search for newer info
- Stop when you have enough information to make a confident recommendation
- Maximum 5 search iterations to avoid endless searching

## Output Format

Produce a structured research report:

```
# Research Report: [Topic]

## Research Question
[The specific question being investigated]

## Criteria
[Evaluation criteria with weights if applicable]

## Findings

### Option A: [Name]
**Summary**: [2-3 sentence summary]
**Pros**:
  - [Pro 1] (source: [link])
  - [Pro 2]
**Cons**:
  - [Con 1] (source: [link])
  - [Con 2]
**Codebase fit**: [How well it fits the existing project]

### Option B: [Name]
[Same structure]

## Comparison

| Criterion        | Option A | Option B |
|-----------------|----------|----------|
| [Criterion 1]   | [Rating] | [Rating] |
| [Criterion 2]   | [Rating] | [Rating] |

## Recommendation
**Recommended**: [Option]
**Justification**: [Why this option, based on evidence]
**Conditions for alternative**: [When you'd choose the other option]

## Sources
1. [Title](url) — [Why this source is credible]
2. [Title](url) — [Relevance]

## Open Questions
[Any unresolved questions that would need further investigation]
```

## Rules

- Always cite sources for factual claims
- Distinguish between facts (from sources) and opinions (your assessment)
- If you can't find enough information, say so honestly
- Prioritize official documentation and reputable sources over blog posts
- Always relate research findings back to the project's specific context
- Never present a recommendation without supporting evidence
