# Oh-My-Snow (OMS)

> Autonomous orchestration plugin for Snow CLI — turning AI coding sessions into reliable, self-driving workflows.

OMS wraps Snow CLI with a state machine, stage enforcement, auto-verification, and an orchestration loop that drives AI from goal to done — without losing track, skipping steps, or claiming success without actually making changes.

## Features

- 🔄 **Autonomous orchestration loop** — AI plans, executes, verifies, fixes, and completes work automatically
- 🚦 **Stage enforcement** — File edits are blocked during planning/verifying/done stages; the AI can't cheat the workflow
- 🔨 **Auto-verification** — Build/test runs automatically after every file edit during execution stage
- 📝 **Structured planning** — Tasks are tracked with completion status; the AI knows exactly what's left
- 🔍 **Text bypass detection** — If the AI claims to have made changes but `git diff` shows nothing, it gets called out
- 📸 **Snapshots** — Save and restore session state for long-running tasks
- 🎓 **Learning** — Extract reusable patterns from sessions into SKILL.md files
- 🤖 **18 specialized sub-agents** — Architecture, security, testing, research, and more
- 📚 **10 skills** — Deep code analysis, execution tracing, cleanup, visual verification, and more
- 🛠️ **9 commands** — Auto, plan, QA, goal, verify, release, save, stop, help

## Installation

```bash
npm install -g oh-my-snow
oms setup
```

The `oms setup` command:

1. Registers the MCP server in `~/.snow/settings.json`
2. Merges 18 sub-agents into `~/.snow/sub-agents.json`
3. Copies 10 skills to `~/.snow/skills/oms/`
4. Copies 9 commands to `~/.snow/commands/oms/`
5. Installs 4 hook configs to `~/.snow/hooks/` (global, with absolute path commands pointing to the npm package)
6. Creates `<project>/.snow/oms-state/` for session state (auto-created per project at runtime)

> **Note**: `oms setup` can be run from any directory — all components are installed globally. The `.snow/oms-state/` directory is auto-created in each project at runtime when an OMS session starts.

> **Note**: Hook commands use absolute paths to the npm package's `hooks/` directory (e.g., `node "/usr/local/lib/node_modules/oh-my-snow/hooks/before-tool-call.mjs"`), which is cross-platform compatible.

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

A stdio MCP server with 8 tools that manage the orchestration state file (`.snow/oms-state/state.json`). The AI calls these tools to start sessions, add tasks, transition stages, save snapshots, and learn patterns.

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

## Commands

| Command                   | Description                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `/oms:auto <goal>`        | Start autonomous orchestration — plan, execute, verify, done (verify fail → back to executing) |
| `/oms:team <N> <goal>`    | Multi-agent orchestration — N teammates in isolated git worktrees, lead orchestrates           |
| `/oms:plan <goal>`        | Iterative planning with consensus — analyze, create tasks, discuss with user                   |
| `/oms:qa <context>`       | QA loop — diagnose issues, fix them, run build/test until clean                                |
| `/oms:goal <description>` | Generate a structured goal artifact with scope and success criteria                            |
| `/oms:verify <context>`   | Manual verification — review changes and run build/test                                        |
| `/oms:release <context>`  | Release flow — version bump, changelog, git tag                                                |
| `/oms:save <context>`     | Save session memory — snapshot state and extract reusable patterns                             |
| `/oms:stop`               | Stop the active OMS session                                                                    |
| `/oms:help`               | Show the full OMS usage guide                                                                  |

## MCP Tools

| Tool                | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `oms-start`         | Initialize an orchestration session with a goal                                                      |
| `oms-get-state`     | Get current state (stage, tasks, turn count, logs)                                                   |
| `oms-set-stage`     | Transition to a new stage (planning → executing → verifying → done; verify fail → back to executing) |
| `oms-set-team`      | Record the active snow-cli team name (for /oms:team multi-agent mode)                                |
| `oms-add-task`      | Add a task during the planning phase                                                                 |
| `oms-complete-task` | Mark a task as completed                                                                             |
| `oms-snapshot`      | Save, restore, or list execution snapshots                                                           |
| `oms-learn`         | Extract reusable patterns and orchestrate skill evolution cycle                                      |
| `oms-stop`          | End the orchestration session and clean up state                                                     |

## Skills

Load a skill with `/skill <name>`:

| Skill           | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `interview`     | Socratic-style requirement clarification through iterative questioning           |
| `dive`          | Deep code analysis: structure → dependencies → data flow → risks                 |
| `trace`         | Execution tracing: call chain tracing + state change recording                   |
| `cleanup`       | Detect and clean up AI-generated redundant or low-quality code                   |
| `vverify`       | Visual verification: UI screenshot comparison + visual consistency               |
| `wiki`          | Auto-generate wiki documentation from source code analysis                       |
| `research`      | Autonomous multi-step research combining web search and code analysis            |
| `darwin-skill`  | Evaluate skills across 9 dimensions + ratchet mechanism (keep only improvements) |
| `skill-evolver` | Strategy-diversified exploration — author, deploy, test, refine skills           |
| `embodi-skill`  | Skill-aware reflection — targeted revision signals from execution trajectories   |

## Sub-Agents

Spawn a sub-agent with `#oms_<agent_name>`:

| Agent            | Specialization                                             | Tools                                                           |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| `oms_architect`  | System architecture design and review                      | filesystem-read, codebase-search, ace-search                    |
| `oms_researcher` | Deep research with web search and code analysis            | + websearch-search, websearch-fetch                             |
| `oms_designer`   | UI/UX design and interface specification                   | filesystem-read, codebase-search, ace-search                    |
| `oms_tester`     | Test writing and execution                                 | + filesystem-create/edit, terminal-execute, ide-get_diagnostics |
| `oms_ds`         | Data analysis and statistical modeling                     | filesystem-read, codebase-search, ace-search                    |
| `oms_reviewer`   | Code review and quality assessment                         | + ide-get_diagnostics                                           |
| `oms_security`   | Security audit and vulnerability assessment                | + websearch-search                                              |
| `oms_devops`     | DevOps, deployment, and CI/CD pipeline management          | + filesystem-create/edit, terminal-execute                      |
| `oms_frontend`   | Frontend development and component implementation          | + filesystem-create/edit, codebase-search                       |
| `oms_backend`    | Backend development and API implementation                 | + terminal-execute                                              |
| `oms_database`   | Database operations, schema design, and query optimization | + filesystem-create/edit, terminal-execute                      |
| `oms_api`        | API design and contract specification                      | filesystem-read, codebase-search, ace-search                    |
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
```

This command:

1. Removes the MCP server from `~/.snow/settings.json`
2. Removes all `oms_*` agents from `~/.snow/sub-agents.json`
3. Removes `~/.snow/skills/oms/` directory
4. Removes `~/.snow/commands/oms/` directory
5. Removes OMS hook rules from `<project>/.snow/hooks/*.json`
6. Removes `<project>/.snow/oms-state/` directory

## Project Structure

```
oh-my-snow/
├── src/
│   ├── mcp-server.ts          # MCP server with 8 tools
│   ├── installer.ts           # CLI entry point (oms setup/uninstall/help)
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
│   │   └── sub-agents.json    # 18 sub-agent definitions
│   ├── skills/
│   │   └── oms/
│   │       ├── interview/SKILL.md
│   │       ├── dive/SKILL.md
│   │       ├── trace/SKILL.md
│   │       ├── cleanup/SKILL.md
│   │       ├── vverify/SKILL.md
│   │       ├── wiki/SKILL.md
│   │       ├── research/SKILL.md
│   │       ├── darwin-skill/SKILL.md
│   │       ├── skill-evolver/SKILL.md
│   │       └── embodi-skill/SKILL.md
│   ├── commands/
│   │   └── oms/
│   │       ├── auto.json
│   │       ├── team.json
│   │       ├── plan.json
│   │       ├── qa.json
│   │       ├── goal.json
│   │       ├── verify.json
│   │       ├── release.json
│   │       ├── save.json
│   │       ├── stop.json
│   │       └── help.json
│   └── hooks/
│       ├── beforeToolCall.json
│       ├── afterToolCall.json
│       ├── onStop.json
│       └── onUserMessage.json
├── package.json
└── tsconfig.json
```

## License

MIT
