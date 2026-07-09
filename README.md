# Oh-My-Snow (OMS)

[![npm version](https://img.shields.io/npm/v/oh-my-snow.svg)](https://www.npmjs.com/package/oh-my-snow)
[![Node.js](https://img.shields.io/node/v/oh-my-snow.svg)](https://www.npmjs.com/package/oh-my-snow)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Autonomous orchestration plugin for Snow CLI — turning AI coding sessions into reliable, self-driving workflows.

OMS wraps Snow CLI with a state machine, stage enforcement, auto-verification, and an orchestration loop that drives AI from goal to done — without losing track, skipping steps, or claiming success without actually making changes.

| | |
| --- | --- |
| **npm** | [`oh-my-snow`](https://www.npmjs.com/package/oh-my-snow) |
| **GitHub** | [yy1588133/oh-my-snow](https://github.com/yy1588133/oh-my-snow) |
| **CLI** | `oms` (alias: `oh-my-snow`) |
| **Requires** | Node.js ≥ 18, Snow CLI installed |

## Features

- 🔄 **Autonomous orchestration loop** — AI plans, executes, verifies, fixes, and completes work automatically
- 🚦 **Stage enforcement** — File edits are blocked during planning/verifying/done stages; the AI can't cheat the workflow
- 🎫 **Completion gates** — Machine-readable scorecards before verifying and before done; oral "done" is blocked
- 🔨 **Auto-verification** — Build/test runs automatically after every file edit during execution stage
- 📝 **Structured planning** — Tasks are tracked with completion status; the AI knows exactly what's left
- 🔍 **Text bypass detection** — If the AI claims to have made changes but `git diff` shows nothing, it gets called out
- 📸 **Snapshots** — Save and restore session state for long-running tasks
- 🎓 **Learning** — Extract reusable patterns from sessions into SKILL.md files
- 🤖 **18 specialized sub-agents** — Architecture, security, testing, research, and more, each with a structured `role` prompt ported from oh-my-claudecode (Role / Success Criteria / Constraints / Investigation Protocol / Final Checklist)
- 📚 **10 skills** — Knowledge base wiki, evidence-driven trace, ambiguity-gated interview, two-stage dive, visual-verdict QA, cleanup, research, learn, ralph, plan, and more
- 🛠️ **19 commands** — 11 workflow commands (auto, plan, qa, goal, verify, release, save, stop, resume, team, help) + 8 skill-mapping commands (interview, dive, trace, cleanup, vverify, wiki, research, learn)
- 📦 **Hard-stop handoff** — when turn hard cap hits, writes `handoff.json`; `/oms:resume` previews then restores progress + gates (not chat)

## Installation

```bash
npm install -g oh-my-snow
oms setup
oms doctor   # recommended post-install health check
```

Equivalent package entry: `oh-my-snow` (same CLI as `oms`).

### Prerequisites

- **Node.js** ≥ 18
- **npm** (for global install)
- **Snow CLI** installed and configured

### What `oms setup` does

1. Registers the MCP server in `~/.snow/settings.json`
2. Merges 18 sub-agents into `~/.snow/sub-agents.json`
3. Copies 10 skills to `~/.snow/skills/oms/`
4. Copies 19 commands to `~/.snow/commands/oms/` (11 workflow + 8 skill mappings)
5. Installs 4 hook configs to `~/.snow/hooks/` (global, with absolute path commands pointing to the npm package)
6. Creates `<project>/.snow/oms-state/` for session state (auto-created per project at runtime)

### CLI reference

| Command | Description |
| --- | --- |
| `oms setup` | Install / re-install OMS into Snow CLI (MCP, agents, skills, commands, hooks) |
| `oms doctor` | Post-install health check (MCP path, hooks timeout/path, agents, skills, commands) |
| `oms version` | Print package version (`-v` / `--version`) |
| `oms uninstall` | Remove OMS components from Snow CLI |
| `oms help` | Show installer help (`-h` / `--help`) |

> **Note**: `oms setup` can be run from any directory — all components are installed globally. The `.snow/oms-state/` directory is auto-created in each project at runtime when an OMS session starts.

> **Note**: Hook commands use absolute paths to the npm package's `hooks/` directory (e.g., `node "/usr/local/lib/node_modules/oh-my-snow/hooks/before-tool-call.mjs"`), which is cross-platform compatible.

### From source (development)

```bash
git clone https://github.com/yy1588133/oh-my-snow.git
cd oh-my-snow
npm install
npm run build
npm test
npm link          # exposes local oms on PATH
oms setup
```

## Quick Start

```bash
# Start an autonomous session — AI does everything: plan, execute, verify, fix, done
/oms:auto "Refactor the auth module to use JWT tokens"

# Plan first with user consensus, then execute
/oms:plan "Add user profile feature with avatar upload"

# Fix all build/test errors in a loop
/oms:qa "Fix TypeScript compilation errors after upgrading to v5"

# Get help
/oms:help
```

## Architecture Overview

OMS consists of **two systems** working together:

### System 1: MCP Server (State Management)

A stdio MCP server with 12 tools that manage the orchestration state file (`.snow/oms-state/state.json`) and skill state store (`.snow/oms-state/store/<mode>.json`). The AI calls these tools to start sessions, add tasks, transition stages, save snapshots, resume hard-stop handoffs, persist skill state, and learn patterns.

### System 2: Hooks (4 Lifecycle Hooks)

Shell scripts triggered by Snow CLI at specific lifecycle events:

| Hook             | Trigger                   | Purpose                                                                              |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `beforeToolCall` | Before any tool executes  | Blocks file edits in non-editing stages (planning, verifying, done)                  |
| `afterToolCall`  | After a tool completes    | Schedules build/test verification after file edits in executing stage                |
| `onUserMessage`  | When user sends a message | Injects stage-aware guidance into the conversation                                   |
| `onStop`         | When AI finishes a turn   | Drives the orchestration loop — injects continuation prompts and detects text bypass |

### State Machine

```
planning → executing → verifying → done
             ▲           │
             └───────────┘
               (verify fail → back to executing, no fixing middle stage)
```

| Stage       | Description                           | File Edits                     |
| ----------- | ------------------------------------- | ------------------------------ |
| `planning`  | Analyze codebase, create tasks        | ❌ Blocked                     |
| `executing` | Implement tasks with filesystem tools | ✅ Allowed (auto-verify after) |
| `verifying` | Review changes, run build/test        | ❌ Blocked                     |
| `done`      | Session complete                      | ❌ Blocked                     |

> **Note**: There is no `fixing` stage. When verification fails, the state transitions back to `executing` so the AI can fix issues and re-verify. A `done`-stage build failure also force-transitions to `executing`.

### Completion gates (new sessions)

New orchestration sessions start with `gatesRequired: true`. Stage transitions at two choke points require **ledger-backed scorecards**, not a verbal claim of “done”.

```
executing ──[task-complete]──► verifying ──[task-reconcile → code-quality → completion]──► done
                  │                         │
                  └─ missing scorecard ─────┴─ missing / rejected gate → stay or bounce to executing
```

| Gate | When | How to pass |
| --- | --- | --- |
| **task-complete** | Before `executing → verifying` | `oms-prd action:"submit-gate" scope:"task-complete"` with JSON scorecard (`pass`, `summary`, `evidence[]`). Incomplete tasks need `deferred[{id,reason}]`. Empty tasks need `noTasksReason` **or** a refined PRD with all stories `passes:true`. |
| **task-reconcile** | Inside `verifying` (first) | `submit-gate` scope `task-reconcile` — tasks/goal alignment. |
| **code-quality** | After reconcile | `request-verification` scope `code-quality`, then `submit-approval` with **allowlisted** reviewer (`oms_reviewer` / `oms_critic` / `oms_architect`) **and** a scorecard that includes evidence / `diffStat`. Self ids like `main` are rejected. |
| **completion** | Before `verifying → done` | Same as code-quality with scope `completion` and an independent `#oms_critic`-style review. |

**Observability:** `oms-get-state` prints `gatesRequired`, **Gate ledger**, and **Last gate failure**.

**Integrity:**

- Ledger file: `.snow/oms-state/verification-ledger.json` (per-scope approvals; re-request clears **only** that scope).
- Hooks block writing under `.snow/oms-state/` via filesystem tools **and** shell redirects that target the ledger/state dir.
- Returning to `executing` from `verifying`/`done` invalidates `code-quality` + `completion` so code changes must be re-reviewed.
- **L1 residual:** a client can still *claim* `reviewerAgentId: "oms_critic"` without spawning a real sub-agent. Gates block empty oral done; true process isolation is a future L2 host capability.

Legacy sessions without `gatesRequired` keep the older completion-approval exemption behavior for compatibility.

## Commands

| Command                   | Description                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `/oms:auto <goal>`        | Start autonomous orchestration with completion gates (plan → execute → gated verify → done) |
| `/oms:team <N> <goal>`    | Multi-agent orchestration — N teammates in isolated git worktrees, lead orchestrates           |
| `/oms:plan <goal>`        | Iterative planning with consensus — analyze, create tasks, discuss with user                   |
| `/oms:qa <context>`       | QA loop — diagnose issues, fix them, run build/test until clean                                |
| `/oms:goal <description>` | Ralph PRD loop — load `oms/ralph`, refine stories, implement until acceptance + reviewer pass  |
| `/oms:verify <context>`   | Manual verification — review changes and run build/test                                        |
| `/oms:release <context>`  | Release flow — version bump, changelog, git tag                                                |
| `/oms:save <context>`     | Save session memory — snapshot state and extract reusable patterns                             |
| `/oms:stop`               | Stop the active OMS session                                                                    |
| `/oms:resume`             | After hard-stop: preview handoff → user confirms → restore progress + gates (not chat history) |
| `/oms:help`               | Show the full OMS usage guide                                                                  |

### Skill-Mapping Commands

Each maps to a skill via the `skill-execute` tool — equivalent to `/skill oms/<name>` but with an OMS-namespaced entry point:

| Command                    | Skill            | Description                                                          |
| -------------------------- | ---------------- | -------------------------------------------------------------------- |
| `/oms:interview <desc>`    | `oms/interview`  | Math-gated Socratic deep interview — 4-dim weighted ambiguity + threshold execution bridge        |
| `/oms:dive <target>`       | `oms/dive`       | Two-stage pipeline: trace root-cause → 3-point inject into interview for requirements            |
| `/oms:trace <target>`      | `oms/trace`      | Evidence-driven causal trace — multi-hypothesis + 6-tier evidence + rebuttal rounds              |
| `/oms:cleanup <target>`    | `oms/cleanup`    | Detect and clean up AI-generated redundant or low-quality code       |
| `/oms:vverify <target>`    | `oms/vverify`    | Screenshot-driven visual QA judge — strict JSON verdict + 90-score threshold                     |
| `/oms:wiki <target>`       | `oms/wiki`       | Persistent markdown knowledge base — ingest/query/lint, cross-session accumulation               |
| `/oms:research <question>` | `oms/research`   | Autonomous multi-step research combining web search and code analysis |
| `/oms:learn`               | `oms/learn`      | Session-to-skill extractor + evolution pipeline                         |

> **Note:** `/oms:goal` loads skill `oms/ralph` (Ralph persistence loop). There is no `/oms:ralph` slash command. `/oms:auto` and `/oms:team` are **commands**, not skills — do not `skill-execute oms/auto` or `oms/team`.

## MCP Tools

| Tool                | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `oms-start`         | Initialize an orchestration session with a goal                                                      |
| `oms-get-state`     | Get current state (stage, tasks, turn count, logs, **gate ledger**, last gate failure)               |
| `oms-set-stage`     | Transition stages; **gatesRequired** sessions enforce task-complete before verifying and multi-gate before done |
| `oms-set-team`      | Record the active snow-cli team name (for /oms:team multi-agent mode)                                |
| `oms-add-task`      | Add a task during the planning phase                                                                 |
| `oms-complete-task` | Mark a task as completed                                                                             |
| `oms-snapshot`      | Save, restore, or list execution snapshots                                                           |
| `oms-learn`         | Extract reusable patterns and orchestrate skill evolution cycle                                      |
| `oms-prd`           | Ralph PRD + **gates**: `submit-gate`, `request-verification`, `submit-approval` (scorecard required for code-quality/completion) |
| `oms-state`         | Generic key-value state store for skills (mirrors omc state_write/state_read; `.snow/oms-state/store/<mode>.json`) |
| `oms-stop`          | End the orchestration session and clean up state (keeps `handoff.json` for resume)                  |
| `oms-resume`        | Preview or confirm hard-stop handoff restore (progress + gates only, not chat)                       |

#### Gate-related `oms-prd` actions

| Action | Purpose |
| --- | --- |
| `submit-gate` | Self-gates only: `task-complete` or `task-reconcile` + JSON `scorecard` |
| `request-verification` | Start a token for `story`, `code-quality`, or `completion` (not self-gates) |
| `submit-approval` | Resolve a token; for `code-quality`/`completion` requires allowlisted `reviewerAgentId` + `scorecard` |
| `get-pending-verification` | Inspect current pending verification token |

## Skills

Load a skill with `/skill oms/<name>`, or use the corresponding `/oms:<name>` command (see the Skill-Mapping Commands section above) for a namespaced entry point:

| Skill           | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `interview`     | Math-gated Socratic deep interview — 4-dimension weighted ambiguity score + threshold execution bridge |
| `dive`          | Two-stage pipeline: trace root-cause → 3-point inject into interview for requirements            |
| `trace`         | Evidence-driven causal trace — multi-hypothesis + 6-tier evidence + rebuttal rounds              |
| `cleanup`       | Detect and clean up AI-generated redundant or low-quality code                   |
| `vverify`       | Screenshot-driven visual QA judge — strict JSON verdict + 90-score threshold                     |
| `wiki`          | Persistent markdown knowledge base — ingest/query/lint, cross-session accumulation               |
| `research`      | Autonomous multi-step research combining web search and code analysis            |
| `learn`         | Session-to-skill extractor + self-contained evolution pipeline (reflect → explore → evaluate) |
| `plan`          | Strategic planning with interview/direct/consensus modes and approval gate       |
| `ralph`         | PRD-driven persistence loop (entry command: `/oms:goal`)                         |

## Sub-Agents

Spawn a sub-agent with `#oms_<agent_name>`.

Each agent ships with a structured `role` prompt adapted from [oh-my-claudecode](https://github.com/anthropics/claude-code)'s agent definitions — not a one-line description. The prompt follows a consistent tag structure: `<Role>` (responsibilities + handoff boundaries), `<Why_This_Matters>` (the rule's rationale), `<Success_Criteria>` (verifiable outcomes), `<Constraints>` (hard rules, e.g. read-only agents cannot edit), `<Investigation_Protocol>` (step-by-step method), `<Tool_Usage>` (snow-cli tool mapping + external consultation), `<Failure_Modes_To_Avoid>`, and `<Final_Checklist>`. Every agent also declares a `<Final_Response_Contract>` requiring a structured deliverable in its last message — no content-free "done" sign-offs.

**Mapping to omc roles**: `oms_architect`→architect, `oms_reviewer`→code-reviewer, `oms_tester`→test-engineer, `oms_security`→security-reviewer, `oms_ds`→scientist, `oms_docs`→writer, `oms_evaluator`→verifier, `oms_critic`→critic, `oms_designer`→designer, `oms_researcher`→explore+scientist+document-specialist. The role-specialized agents (`oms_frontend`, `oms_backend`, `oms_database`, `oms_api`, `oms_devops`, `oms_optimizer`, `oms_migrator`, `oms_summarizer`) use the executor pattern with domain-specific protocols.

Tool names and collaboration references are adapted to snow-cli: `Glob/Grep/Read`→`filesystem-read`+`ace-search`, `Write/Edit`→`filesystem-create/edit/replaceedit`, `Bash`→`terminal-execute`, `lsp_diagnostics*`→`ide-get_diagnostics`, `WebSearch/WebFetch`→`websearch-search`/`websearch-fetch`, `Task(subagent_type=...)`→`#oms_<name>`, `/team`→`/oms:team`.

| Agent            | Specialization                                             | Tools                                                           |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `oms_architect`  | System architecture design and review                      | filesystem-read, codebase-search, ace-search, terminal-execute  |
| `oms_researcher` | Deep research with web search and code analysis            | + websearch-search, websearch-fetch                             |
| `oms_designer`   | UI/UX design and interface specification                   | filesystem-read, codebase-search, ace-search                    |
| `oms_tester`     | Test writing and execution                                 | + filesystem-create/edit, terminal-execute, ide-get_diagnostics |
| `oms_ds`         | Data analysis and statistical modeling                     | filesystem-read, codebase-search, ace-search                    |
| `oms_reviewer`   | Code review and quality assessment                         | + ide-get_diagnostics, terminal-execute                         |
| `oms_security`   | Security audit and vulnerability assessment                | + websearch-search, websearch-fetch                              |
| `oms_devops`     | DevOps, deployment, and CI/CD pipeline management          | + filesystem-create/edit, terminal-execute, codebase-search, ide-get_diagnostics |
| `oms_frontend`   | Frontend development and component implementation          | + filesystem-create/edit, codebase-search                       |
| `oms_backend`    | Backend development and API implementation                 | + terminal-execute                                              |
| `oms_database`   | Database operations, schema design, and query optimization | + filesystem-create/edit, terminal-execute, ide-get_diagnostics |
| `oms_api`        | API design and contract specification                      | filesystem-read, codebase-search, ace-search, terminal-execute |
| `oms_docs`       | Documentation writing and maintenance                      | + filesystem-create/edit                                        |
| `oms_optimizer`  | Performance optimization and profiling                     | + terminal-execute                                              |
| `oms_migrator`   | Code migration and framework upgrades                      | + filesystem-create/edit, terminal-execute                      |
| `oms_evaluator`  | Evaluation and verification of deliverables                | filesystem-read, codebase-search, ace-search                    |
| `oms_summarizer` | Content summarization and distillation                     | filesystem-read                                                 |
| `oms_critic`     | Critical analysis and adversarial review                   | filesystem-read, codebase-search, ace-search                    |

## Configuration Reference

### Settings File

`~/.snow/settings.json` — MCP server configuration:

```json
{
	"mcpServers": {
		"oms": {
			"command": "node",
			"args": ["/absolute/path/to/oh-my-snow/dist/mcp-server.js"],
			"timeout": 300000,
			"enabled": true
		}
	}
}
```

### Sub-Agents File

`~/.snow/sub-agents.json` — Agent definitions:

```json
{
	"agents": [
		{
			"id": "oms_architect",
			"name": "OMS Architect",
			"description": "System architecture design and review",
			"systemPrompt": "...",
			"tools": ["filesystem-read", "codebase-search", "ace-search"]
		}
	]
}
```

### State File

`<project>/.snow/oms-state/state.json` — Session state (created at runtime):

```json
{
  "sessionId": "oms_1700000000000",
  "stage": "planning",
  "goal": "Refactor auth module",
  "verifyCommand": "npm test",
  "tasks": [
    { "id": "task_1", "description": "Analyze current auth", "completed": true }
  ],
  "turnCount": 3,
  "stageHistory": [...],
  "logs": [...],
  "snapshots": []
}
```

### Skill State Store

`<project>/.snow/oms-state/store/<mode>.json` — Per-mode skill state (one JSON file per mode, e.g. `interview.json`, `trace.json`, `deep-dive.json`). Managed via the `oms-state` MCP tool by skills themselves (read-modify-write with overwrite semantics), not the orchestration state machine.

### Hook Configuration

`<project>/.snow/hooks/beforeToolCall.json`:

```json
[
	{
		"matcher": "filesystem-create,filesystem-edit,filesystem-replaceedit,terminal-execute",
		"description": "OMS: Block file edits and terminal commands in non-editing stages",
		"hooks": [
			{
				"type": "command",
				"command": "node .snow/oms-state/before-tool-call.mjs",
				"timeout": 5000,
				"enabled": true
			}
		]
	}
]
```

## Uninstall

```bash
oms uninstall
# optional: also remove the global package
npm uninstall -g oh-my-snow
```

This command:

1. Removes the MCP server from `~/.snow/settings.json`
2. Removes all `oms_*` agents from `~/.snow/sub-agents.json`
3. Removes `~/.snow/skills/oms/` directory
4. Removes `~/.snow/commands/oms/` directory
5. Removes OMS hook rules from `~/.snow/hooks/*.json` (global)
6. Removes `<project>/.snow/oms-state/` directory (when run from a project that has one)

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # full regression suite
npm run pack:check # dry-run npm pack contents
```

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | `tsc --watch` |
| `npm test` | Run all `test/*.mjs` suites |
| `npm start` | Start MCP server (`dist/mcp-server.js`) |
| `npm run clean:pack-noise` | Strip local `.omc/` noise under `assets/` before packing |
| `npm run prepack` / `prepublishOnly` | Clean + build (+ test on publish) |

CI: GitHub Actions workflow at [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) (build + test).

Published package includes: `dist/`, `assets/`, `hooks/`, `README.md`, `LICENSE` (see `package.json` `files`).

## Project Structure

```
oh-my-snow/
├── src/
│   ├── mcp-server.ts          # MCP server with 12 tools (incl. oms-resume, oms-state store)
│   ├── installer.ts           # CLI: setup / uninstall / doctor / version / help
│   ├── i18n/                  # Installer translations (en, zh, zh-TW)
│   └── state/
│       └── store.ts           # State management (JSON file persistence)
├── hooks/
│   ├── before-tool-call.mjs   # Stage enforcement hook
│   ├── after-tool-call.mjs    # Auto-verification hook (writes pending-verify marker)
│   ├── on-stop.mjs            # Orchestration loop driver (runs build/test + injects continuation)
│   ├── on-user-message.mjs    # Stage-aware guidance injector
│   └── lib/
│       └── oms-state.mjs      # Shared utilities (state I/O, lock, verify detection)
├── assets/
│   ├── agents/
│   │   └── sub-agents.json    # 18 sub-agent definitions (structured `role` prompts)
│   ├── skills/
│   │   └── oms/
│   │       ├── interview/SKILL.md
│   │       ├── dive/SKILL.md
│   │       ├── trace/SKILL.md
│   │       ├── cleanup/SKILL.md
│   │       ├── vverify/SKILL.md
│   │       ├── wiki/SKILL.md
│   │       ├── research/SKILL.md
│   │       ├── learn/SKILL.md
│   │       ├── plan/SKILL.md
│   │       └── ralph/SKILL.md
│   ├── commands/
│   │   └── oms/               # 18 command JSON files (workflow + skill mappings)
│   └── hooks/
│       ├── beforeToolCall.json
│       ├── afterToolCall.json
│       ├── onStop.json
│       └── onUserMessage.json
├── scripts/
│   ├── clean-pack-noise.mjs   # Remove assets/**/.omc before npm pack
│   └── gen-sub-agents.mjs
├── test/                      # Node test suites (npm test)
├── .github/workflows/ci.yml
├── package.json
└── tsconfig.json
```

## Links

- npm: https://www.npmjs.com/package/oh-my-snow
- Source: https://github.com/yy1588133/oh-my-snow
- Issues: https://github.com/yy1588133/oh-my-snow/issues

## License

[MIT](./LICENSE)
