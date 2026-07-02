/**
 * OMS MCP Server
 *
 * Provides 10 state management tools via stdio transport.
 * No LLM calls — this server only manages orchestration state.
 *
 * Tools:
 *   oms-start          — Initialize an orchestration session
 *   oms-get-state      — Get current state (stage, tasks, etc.)
 *   oms-set-stage      — Transition to a new stage (validates transitions)
 *   oms-add-task       — Add a task during planning phase
 *   oms-complete-task  — Mark a task as completed
 *   oms-snapshot       — Save / restore / list execution snapshots
 *   oms-learn          — Extract reusable patterns + orchestrate skill evolution
 *   oms-set-team       — Set the team name reference + activate snow-cli Team Mode
 *   oms-prd            — Ralph PRD management (init/refine/story/criteria/progress)
 *   oms-stop           — End the orchestration session
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {
	loadState,
	createState,
	setStage,
	addTask,
	completeTask,
	setTeamName,
	addLog,
	saveSnapshot,
	loadSnapshot,
	listSnapshots,
	deleteState,
	saveVerifyCommandFile,
	initPrd,
	loadPrd,
	refinePrd,
	addPrdStory,
	getNextPrdStory,
	getPrdStory,
	setPrdStoryPasses,
	setCriterionVerified,
	getPrdStatus,
	initProgress,
	logProgress,
	readProgress,
	deletePrd,
	type RefinedStoryInput,
} from './state/store.js';
import {writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';

// ── Server setup ──

const server = new McpServer(
	{name: 'oh-my-snow', version: '0.2.0'},
	{
		capabilities: {
			tools: {},
		},
		instructions:
			'Oh-My-Snow orchestration server. Use oms-start to begin, oms-get-state to check progress, oms-set-stage to transition phases.',
	},
);

// ── Tool: oms-start ──

server.registerTool(
	'oms-start',
	{
		description:
			'Initialize an OMS orchestration session. Creates state.json and enters the "planning" stage. Call this first before any other oms-* tools.',
		inputSchema: {
			goal: z.string().describe('The high-level goal the AI should accomplish'),
			verifyCommand: z
				.string()
				.optional()
				.describe(
					'Command to run for build/test verification (e.g. "npm test", "dotnet build"). If omitted, auto-detect from project files.',
				),
		},
	},
	params => {
		try {
			const existing = loadState();
			// 'idle' is a legacy stage from v0.1.0 — treat it as "no active session"
			// Cast through string to safely check for the legacy 'idle' value
			// without bypassing TypeScript's type system with `as any`
			const existingStage = existing ? (existing.stage as string) : '';
			if (existing && existingStage !== 'done' && existingStage !== 'idle') {
				return {
					content: [
						{
							type: 'text' as const,
							text: `⚠️ An active OMS session already exists (stage: ${
								existing.stage
							}, goal: "${
								existing.goal
							}").\n\nUse oms-get-state to check current progress, or oms-stop to end the previous session first.\n\nCurrent state:\n- Stage: ${
								existing.stage
							}\n- Goal: ${existing.goal}\n- Tasks: ${existing.tasks.length} (${
								existing.tasks.filter(t => t.completed).length
							} completed)\n- Turn: ${existing.turnCount}`,
						},
					],
					isError: true,
				};
			}

			// Clean up residue from a previous 'done' session before creating a new one
			if (existing && existingStage === 'done') {
				deleteState();
			}
			const verifyCmd = params.verifyCommand ?? '';
			const state = createState(params.goal, verifyCmd);

			// If a verify command was provided, also write it to the verify.cmd file
			// so hooks (which don't have MCP access) can read it
			if (verifyCmd) {
				saveVerifyCommandFile(verifyCmd);
			}

			return {
				content: [
					{
						type: 'text' as const,
						text:
							`✅ OMS session started!\n\n` +
							`Session ID: ${state.sessionId}\n` +
							`Goal: ${state.goal}\n` +
							`Stage: planning\n` +
							`Verify Command: ${verifyCmd || '(auto-detect)'}\n\n` +
							`Next steps:\n` +
							`1. Analyze the codebase and create a plan\n` +
							`2. Use oms-add-task to add tasks to the plan\n` +
							`3. When the plan is ready, call oms-set-stage { stage: "executing" }\n` +
							`4. Implement tasks using filesystem-* and terminal-execute tools\n` +
							`5. Use oms-complete-task to mark tasks as done\n` +
							`6. Call oms-set-stage { stage: "verifying" } when all tasks are done\n` +
							`7. The system will auto-run build/test after file edits\n` +
							`8. If issues found, call oms-set-stage { stage: "executing" } to fix them\n` +
							`9. When everything passes, call oms-set-stage { stage: "done" }`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-get-state ──

server.registerTool(
	'oms-get-state',
	{
		description:
			'Get the current OMS orchestration state — stage, goal, tasks, turn count, and recent logs.',
		inputSchema: {},
	},
	() => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start to begin.',
						},
					],
					isError: true,
				};
			}

			const taskLines = state.tasks
				.map(t => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`)
				.join('\n');

			const recentLogs = state.logs
				.slice(-5)
				.map(l => `  [${l.stage}] ${l.timestamp}: ${l.message}`)
				.join('\n');

			const snapshots = listSnapshots(state)
				.map(s => `  - ${s.key} (created: ${s.createdAt})`)
				.join('\n');

			return {
				content: [
					{
						type: 'text' as const,
						text:
							`OMS State\n` +
							`────────────────────────────\n` +
							`Session: ${state.sessionId}\n` +
							`Stage:   ${state.stage}\n` +
							`Goal:    ${state.goal}\n` +
							`Turn:    ${state.turnCount}\n` +
							`Verify:  ${state.verifyCommand || '(auto-detect)'}\n` +
							(state.teamName
								? `Team:    ${state.teamName} (multi-agent mode)\n`
								: '') +
							`Created: ${state.createdAt}\n` +
							`Updated: ${state.updatedAt}\n\n` +
							`Tasks (${state.tasks.filter(t => t.completed).length}/${
								state.tasks.length
							} completed):\n` +
							(taskLines || '  (no tasks yet)') +
							'\n\n' +
							`Recent logs:\n` +
							(recentLogs || '  (none)') +
							(snapshots ? `\n\nSnapshots:\n${snapshots}` : ''),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-set-stage ──

server.registerTool(
	'oms-set-stage',
	{
		description:
			'Transition to a new orchestration stage. Valid transitions: planning→executing, executing→verifying|planning, verifying→done|executing (no fixing stage — verifying failure goes back to executing).',
		inputSchema: {
			stage: z
				.enum(['planning', 'executing', 'verifying', 'done'])
				.describe('The stage to transition to'),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			const updated = setStage(state, params.stage);
			return {
				content: [
					{
						type: 'text' as const,
						text: `✅ Stage transitioned: → ${
							params.stage
						}\n\nStage history:\n${updated.stageHistory
							.map(h => `  ${h.timestamp}: ${h.stage}`)
							.join('\n')}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-add-task ──

server.registerTool(
	'oms-add-task',
	{
		description:
			'Add a task to the plan. Should be called during the "planning" stage. Each task gets an auto-generated ID like task_1, task_2, etc.',
		inputSchema: {
			description: z
				.string()
				.describe('Clear, actionable description of the task'),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			const updated = addTask(state, params.description);
			const newTask = updated.tasks[updated.tasks.length - 1];
			return {
				content: [
					{
						type: 'text' as const,
						text: `✅ Task added: ${newTask.id}\n  Description: ${newTask.description}\n  Total tasks: ${updated.tasks.length}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-complete-task ──

server.registerTool(
	'oms-complete-task',
	{
		description: 'Mark a task as completed by its ID (e.g. "task_1").',
		inputSchema: {
			taskId: z
				.string()
				.describe('The task ID to mark as completed (e.g. "task_1")'),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			const updated = completeTask(state, params.taskId);
			const remaining = updated.tasks.filter(t => !t.completed).length;
			return {
				content: [
					{
						type: 'text' as const,
						text: `✅ Task completed: ${params.taskId}\n  Completed: ${
							updated.tasks.filter(t => t.completed).length
						}/${updated.tasks.length}\n  Remaining: ${remaining} task(s)`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-set-team ──

server.registerTool(
	'oms-set-team',
	{
		description:
			'Set the team name reference on the OMS state AND activate snow-cli Team Mode (writes teamMode=true to project .snow/settings.json). Used by /oms:team. After calling this, team-* tools (spawn_teammate, create_task, etc.) become visible on the next turn (snow-cli rebuilds the tool list because teamMode is part of configHash). OMS only stores the team name — authoritative team state lives in snow-cli.',
		inputSchema: {
			teamName: z
				.string()
				.describe('The snow-cli team name to associate with this OMS session'),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			const updated = setTeamName(state, params.teamName);
			return {
				content: [
					{
						type: 'text' as const,
						text:
							`✅ Team name set: ${updated.teamName}\n\n` +
							`OMS is now in multi-agent team mode.\n` +
							`snow-cli Team Mode has been ACTIVATED (teamMode=true written to .snow/settings.json).\n\n` +
							`⚠️ IMPORTANT — team-* tools (team-spawn_teammate, team-create_task, etc.) will appear on your NEXT turn.\n` +
							`snow-cli rebuilds the tool list when teamMode changes (configHash includes teamMode).\n` +
							`Do NOT try to call team-* tools in THIS turn — they are not mounted yet.\n\n` +
							`Continue with planning (use oms-add-task for the local task list), then call\n` +
							`oms-set-stage { stage: "executing" } — by then team-* tools will be available.`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-snapshot ──

server.registerTool(
	'oms-snapshot',
	{
		description:
			'Save, restore, or list execution snapshots for cross-session state recovery. Action "save" stores data under a key, "restore" retrieves it, "list" shows all saved snapshots.',
		inputSchema: {
			action: z
				.enum(['save', 'restore', 'list'])
				.describe('The snapshot action to perform'),
			key: z
				.string()
				.optional()
				.describe('Snapshot key (required for save/restore)'),
			data: z
				.string()
				.optional()
				.describe('JSON string of data to save (required for save action)'),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			if (params.action === 'list') {
				const snapshots = listSnapshots(state);
				return {
					content: [
						{
							type: 'text' as const,
							text:
								snapshots.length > 0
									? `Snapshots:\n${snapshots
											.map(s => `  - ${s.key} (created: ${s.createdAt})`)
											.join('\n')}`
									: 'No snapshots saved.',
						},
					],
				};
			}

			if (!params.key) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "key" is required for save/restore actions.',
						},
					],
					isError: true,
				};
			}

			if (params.action === 'save') {
				if (!params.data) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: "data" is required for save action.',
							},
						],
						isError: true,
					};
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(params.data);
				} catch {
					parsed = params.data; // Store as string if not valid JSON
				}
				saveSnapshot(state, params.key, parsed);
				return {
					content: [
						{
							type: 'text' as const,
							text: `✅ Snapshot saved: "${params.key}"`,
						},
					],
				};
			}

			if (params.action === 'restore') {
				const snapshot = loadSnapshot(state, params.key);
				if (!snapshot) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `No snapshot found with key: "${params.key}"`,
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: 'text' as const,
							text: `✅ Snapshot restored: "${params.key}"\nCreated: ${
								snapshot.createdAt
							}\nData:\n${JSON.stringify(snapshot.data, null, 2)}`,
						},
					],
				};
			}

			return {
				content: [
					{type: 'text' as const, text: `Unknown action: ${params.action}`},
				],
				isError: true,
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-learn ──

server.registerTool(
	'oms-learn',
	{
		description:
			'Extract reusable patterns from the current session and orchestrate a skill evolution cycle (reflect → explore → evaluate) to generate an optimized SKILL.md.',
		inputSchema: {
			summary: z.string().describe('Summary of what was accomplished'),
			patterns: z
				.string()
				.describe(
					'JSON array of pattern objects, each with "name", "description", and "applicability"',
				),
			skillName: z
				.string()
				.optional()
				.describe(
					'Name for the generated skill (defaults to "session_<sessionId>")',
				),
			maxIterations: z
				.number()
				.optional()
				.describe(
					'Maximum evolution iterations (default 2, hard max 5). Each iteration runs reflect → explore → evaluate (inlined in the learn skill).',
				),
		},
	},
	params => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session. Call oms-start first.',
						},
					],
					isError: true,
				};
			}

			// Parse patterns
			let patternsArr: Array<{
				name: string;
				description: string;
				applicability?: string;
			}>;
			try {
				patternsArr = JSON.parse(params.patterns);
			} catch {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "patterns" must be a valid JSON array.',
						},
					],
					isError: true,
				};
			}
			if (!Array.isArray(patternsArr)) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "patterns" must be a JSON array, not an object or primitive.',
						},
					],
					isError: true,
				};
			}
			// Validate each pattern has required fields
			for (const p of patternsArr) {
				if (!p.name || !p.description) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: each pattern must have "name" and "description" fields.',
							},
						],
						isError: true,
					};
				}
			}

			// Basic input quality gate (M5 fix: keep simple validation, remove complex scoring)
			if (!params.summary || params.summary.trim().length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "summary" must not be empty.',
						},
					],
					isError: true,
				};
			}
			if (patternsArr.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "patterns" must contain at least one pattern.',
						},
					],
					isError: true,
				};
			}

			// Generate initial SKILL.md draft
			const skillName = params.skillName || `session_${state.sessionId}`;

			// Validate skillName (Phase 1 #1 path traversal fix)
			if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: skillName must be alphanumeric with underscores/hyphens only.',
						},
					],
					isError: true,
				};
			}

			const maxIter = Math.min(params.maxIterations ?? 2, 5); // Hard cap at 5

			// Generate the initial SKILL.md draft content
			const draftContent = `---
name: ${skillName}
description: ${params.summary.split('\n')[0].slice(0, 200)}
---

# ${skillName}

## Summary
${params.summary}

## Patterns Learned
${patternsArr
	.map(
		(p, i) =>
			`### ${i + 1}. ${p.name}\n${p.description}\n${
				p.applicability ? `\n**When to apply:** ${p.applicability}` : ''
			}`,
	)
	.join('\n\n')}

## Session Context
- Goal: ${state.goal}
- Tasks completed: ${state.tasks.filter(t => t.completed).length}/${
				state.tasks.length
			}
- Turns: ${state.turnCount}

## Generated
- Session: ${state.sessionId}
- Date: ${new Date().toISOString()}
`;

			// Save the draft to the skill directory
			const skillDir = join(
				process.env.HOME || process.env.USERPROFILE || '',
				'.snow',
				'skills',
				'oms',
				skillName,
			);
			mkdirSync(skillDir, {recursive: true});
			writeFileSync(join(skillDir, 'SKILL.md'), draftContent, 'utf-8');

			// Log the learning
			addLog(
				state,
				`Skill draft generated: ${skillName}. Starting evolution cycle (max ${maxIter} iterations).`,
			);

			// Return orchestration instructions for the skill evolution pipeline
			return {
				content: [
					{
						type: 'text' as const,
						text:
							`✅ Skill draft generated: ${skillName}\n` +
							`  Location: ${skillDir}/SKILL.md\n` +
							`  Patterns: ${patternsArr.length}\n` +
							`  Max iterations: ${maxIter}\n\n` +
							`## Skill Evolution Pipeline\n\n` +
							`The initial draft has been saved. Now execute the evolution cycle per **Phase 4 of the learn SKILL.md** (already loaded in your context). The SKILL.md is the single source of truth for the full reflect → explore → evaluate methodology, the 9 dimension rubric, the K=4 strategy exploration, the independent-agent discipline, and the ratchet mechanism — do NOT re-derive or re-state those rules here, and do NOT load any external skills.\n\n` +
							`This tool only provides the dynamic state you can't get from the SKILL.md:\n\n` +
							`### Iteration 1/${maxIter}\n` +
							`- Draft to evolve: ${skillDir}/SKILL.md\n` +
							`- Step 1 input: the draft above + session trajectory (stageHistory, logs, tasks from state.json)\n` +
							`- Ratchet baseline file: ${skillDir}/.evolution.json (create on first Step 3; read it at the start of every Step 3 so a fresh Agent C knows the prior baseline)\n\n` +
							`### Reminders (full detail in SKILL.md Phase 4)\n` +
							`- Reflect → Explore → Evaluate, each in a separate sub-agent context.\n` +
							`- Convergence: 0 revision signals AND score ≥ 80 AND no DISCOVERY/SKILL_DEFECT.\n` +
							`- After each Step 3 evaluation, pause and ask the user: "Do you want to keep this version?" before proceeding.\n` +
							`- On the last iteration (${maxIter}/${maxIter}), save the current best result as the final skill.\n` +
							`- Include this iteration count (1/${maxIter}) in your progress updates.`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-prd ──
//
// PRD (Product Requirements Document) management for the Ralph persistence
// loop. Ralph iterates story-by-story until every story has passes:true and
// is reviewer-verified. This tool exposes PRD CRUD operations to the AI.
//
// Actions:
//   init          — create scaffold prd.json from a task description
//   refine        — replace scaffold stories with task-specific refined stories
//   add-story      — add a new story discovered during implementation
//   next-story     — get the highest-priority story with passes:false
//   get-story      — read a story's full details + acceptance criteria
//   mark-passes    — set a story's passes flag (true requires all criteria verified)
//   unmark-passes  — revert passes to false (on reviewer rejection)
//   verify-criterion — mark a single acceptance criterion as verified/unverified
//   status        — get PRD completion summary
//   init-progress — initialize progress.txt
//   log-progress  — append a learning entry to progress.txt
//   list          — list all stories with their passes status

server.registerTool(
	'oms-prd',
	{
		description:
			'Manage the Ralph PRD (Product Requirements Document) — create, refine, query, and update user stories and their acceptance criteria. Drives the Ralph persistence loop: stories iterate until every one has passes:true and is reviewer-verified.',
		inputSchema: {
			action: z
				.enum([
					'init',
					'refine',
					'add-story',
					'next-story',
					'get-story',
					'mark-passes',
					'unmark-passes',
					'verify-criterion',
					'status',
					'init-progress',
					'log-progress',
					'list',
				])
				.describe('The PRD action to perform'),
			task: z
				.string()
				.optional()
				.describe(
					'The task description (required for "init" and "refine")',
				),
			stories: z
				.array(
					z.object({
						title: z.string(),
						acceptanceCriteria: z.array(z.string()),
						priority: z.number().int().positive(),
					}),
				)
				.optional()
				.describe(
					'Refined stories (required for "refine"). Each has title, acceptance criteria texts, and priority.',
				),
			title: z
				.string()
				.optional()
				.describe('Story title (required for "add-story")'),
			acceptanceCriteria: z
				.array(z.string())
				.optional()
				.describe(
					'Acceptance criteria texts (required for "add-story")',
				),
			priority: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Story priority, lower = higher (for "add-story"); must be a positive integer'),
			storyId: z
				.string()
				.optional()
				.describe('Story id, e.g. "US-001" (for get-story / mark-passes / unmark-passes / verify-criterion)'),
			criterionIndex: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'Acceptance criterion index (0-based, non-negative integer) — required for "verify-criterion"',
				),
			verified: z
				.boolean()
				.optional()
				.describe(
					'Verified flag — required for "verify-criterion"',
				),
			message: z
				.string()
				.optional()
				.describe('Progress entry text — required for "log-progress"'),
		},
	},
	params => {
		// Shared error-response builders for the pre-check boilerplate that
		// mark-passes and verify-criterion both need. Centralizes the message
		// format so the two cases stay consistent (DRY). The store-layer
		// setPrdStoryPasses returns null without distinguishing "prd missing"
		// vs "story missing" vs "guard refused", so the MCP layer must do its
		// own loadPrd to give an accurate, actionable error to the agent.
		const noPrdError = () => ({
			content: [
				{
					type: 'text' as const,
					text: 'Error: No active PRD. Call oms-prd with action: "init" first.',
				},
			],
			isError: true as const,
		});
		const noStoryError = (storyId: string) => ({
			content: [
				{
					type: 'text' as const,
					text: `Error: No story found with id "${storyId}".`,
				},
			],
			isError: true as const,
		});
		try {
			switch (params.action) {
				case 'init': {
					if (!params.task) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "task" is required for the "init" action.',
								},
							],
							isError: true,
						};
					}
					const existing = loadPrd();
					if (existing) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `⚠️ A PRD already exists (task: "${existing.task}", refined: ${existing.refined}).\n\nIf you want to start fresh, call oms-stop first to clear state, or use "refine" to replace the stories.`,
								},
							],
							isError: true,
						};
					}
					const prd = initPrd(params.task);
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ PRD scaffold created.\n\n` +
									`Task: ${prd.task}\n` +
									`Stories: ${prd.stories.length} (scaffold)\n\n` +
									`⚠️ CRITICAL: The scaffold has generic acceptance criteria.\n` +
									`You MUST refine it with task-specific stories by calling oms-prd with action: "refine"\n` +
									`before entering the persistence loop.\n\n` +
									`Scaffold story:\n` +
									prd.stories
										.map(
											s =>
												`  ${s.id}: ${s.title} (priority ${s.priority})`,
										)
										.join('\n'),
							},
						],
					};
				}

				case 'refine': {
					if (!params.stories || params.stories.length === 0) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "stories" array is required for the "refine" action.',
								},
							],
							isError: true,
						};
					}
					// Refuse early when the task name would end up empty — refinePrd would embed
					// an empty task permanently into the PRD and progress.txt headers. Check here
					// (MCP layer) for an actionable error message; the store layer also tolerates
					// missing PRDs via implicit auto-init, so this guard is the agent's first line.
					const existingPrd = loadPrd();
					const effectiveTask = params.task || existingPrd?.task || '';
					if (!effectiveTask) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: No "task" provided and no existing task on the PRD to inherit. Pass a "task" with this refine call (e.g. the original goal), or call oms-prd with action: "init" first with a task.',
								},
							],
							isError: true,
						};
					}
					const prd = refinePrd(
						params.task || '',
						params.stories as RefinedStoryInput[],
					);
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ PRD refined with ${prd.stories.length} task-specific stories.\n\n` +
									`Task: ${prd.task}\n\n` +
									`Stories (priority order):\n` +
									prd.stories
										.sort((a, b) => a.priority - b.priority)
										.map(
											s =>
												`  ${s.id} [P${s.priority}]: ${s.title}\n` +
												`    Criteria: ${s.acceptanceCriteria.length}`,
										)
										.join('\n') +
									`\n\nPRD is ready for the persistence loop. Call oms-prd with action: "next-story" to begin.`,
							},
						],
					};
				}

				case 'add-story': {
					if (!params.title || !params.acceptanceCriteria) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "title" and "acceptanceCriteria" are required for the "add-story" action.',
								},
							],
							isError: true,
						};
					}
					const story = addPrdStory(
						params.title,
						params.acceptanceCriteria,
						params.priority ?? 99,
					);
					if (!story) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: No active PRD. Call oms-prd with action: "init" first.',
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text: `✅ Story added: ${story.id}: ${story.title} (priority ${story.priority}, ${story.acceptanceCriteria.length} criteria)`,
							},
						],
					};
				}

				case 'next-story': {
					const story = getNextPrdStory();
					if (!story) {
						const status = getPrdStatus();
						return {
							content: [
								{
									type: 'text' as const,
									text: status
										? `✅ All stories complete (${status.passed}/${status.total}). Proceed to reviewer verification.`
										: 'No active PRD. Call oms-prd with action: "init" first.',
								},
							],
							isError: !status,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`Next story to work on:\n\n` +
									`  ID: ${story.id}\n` +
									`  Title: ${story.title}\n` +
									`  Priority: ${story.priority}\n` +
									`  Passes: ${story.passes}\n\n` +
									`Acceptance criteria:\n` +
									story.acceptanceCriteria
										.map(
											(c, i) =>
												`  [${c.verified ? '✓' : '○'}] ${i}: ${c.criterion}`,
										)
										.join('\n'),
							},
						],
					};
				}

				case 'get-story': {
					if (!params.storyId) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "storyId" is required for the "get-story" action.',
								},
							],
							isError: true,
						};
					}
					const story = getPrdStory(params.storyId);
					if (!story) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `Error: No story found with id "${params.storyId}".`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`Story: ${story.id}\n` +
									`Title: ${story.title}\n` +
									`Priority: ${story.priority}\n` +
									`Passes: ${story.passes}\n\n` +
									`Acceptance criteria:\n` +
									story.acceptanceCriteria
										.map(
											(c, i) =>
												`  [${c.verified ? '✓' : '○'}] ${i}: ${c.criterion}`,
										)
										.join('\n'),
							},
						],
					};
				}

				case 'mark-passes':
				case 'unmark-passes': {
					if (!params.storyId) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "storyId" is required.',
								},
							],
							isError: true,
						};
					}
					const passes = params.action === 'mark-passes';
					// Distinguish the three reasons setPrdStoryPasses can return null
					// (prd missing / story missing / guard refused) so the agent gets
					// actionable guidance instead of a generic "no story found".
					const existingPrd = loadPrd();
					if (!existingPrd) {
						return noPrdError();
					}
					const existingStory = existingPrd.stories.find(
						s => s.id === params.storyId,
					);
					if (!existingStory) {
						return noStoryError(params.storyId);
					}
					const story = setPrdStoryPasses(params.storyId, passes);
					if (!story) {
						// Story exists + PRD exists → only remaining cause is the guard
						// (mark-passes:true refused because not all criteria are verified).
						// Re-load the PRD here for an ACCURATE verified count — the
						// existingStory snapshot above may be stale if another tool call
						// verified/unverified a criterion in the gap. setPrdStoryPasses
						// does its own internal loadPrd, so match that by reading fresh.
						//
						// C7 root cause: this 3rd loadPrd exists because the store-layer
						// setPrdStoryPasses returns null without distinguishing "guard
						// refused" from "story missing". To give the agent an accurate
						// verified/total count we must re-read the PRD here. Eliminating
						// this read requires changing the store signature to return a
						// structured result (deferred — out of scope for this change set).
						const freshPrd = loadPrd();
						const freshStory = freshPrd?.stories.find(
							s => s.id === params.storyId,
						);
						const verifiedCount = freshStory
							? freshStory.acceptanceCriteria.filter(c => c.verified).length
							: 0;
						const totalCount = freshStory
							? freshStory.acceptanceCriteria.length
							: existingStory.acceptanceCriteria.length;
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`Error: Cannot mark story "${params.storyId}" as passing — not all acceptance criteria are verified yet.\n` +
										`Call oms-prd with action: "verify-criterion" for each criterion with fresh evidence first.\n` +
										`Verified: ${verifiedCount}/${totalCount}`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text: `✅ Story ${story.id} passes set to ${story.passes}.`,
							},
						],
					};
				}

				case 'verify-criterion': {
					if (
						!params.storyId ||
						params.criterionIndex === undefined ||
						params.verified === undefined
					) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "storyId", "criterionIndex", and "verified" are required for the "verify-criterion" action.',
								},
							],
							isError: true,
						};
					}
					// Distinguish "story not found" from "criterion index out of range"
					// so the agent can correct the right argument.
					const prd = loadPrd();
					if (!prd) {
						return noPrdError();
					}
					const targetStory = prd.stories.find(
						s => s.id === params.storyId,
					);
					if (!targetStory) {
						return noStoryError(params.storyId);
					}
					if (
						params.criterionIndex < 0 ||
						params.criterionIndex >= targetStory.acceptanceCriteria.length
					) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`Error: criterion index ${params.criterionIndex} is out of range for story "${params.storyId}".\n` +
										`Valid range: 0-${targetStory.acceptanceCriteria.length - 1} (${targetStory.acceptanceCriteria.length} criteria).`,
								},
							],
							isError: true,
						};
					}
					const story = setCriterionVerified(
						params.storyId,
						params.criterionIndex,
						params.verified,
					);
					if (!story) {
						// Defensive — the checks above should make this unreachable.
						return {
							content: [
								{
									type: 'text' as const,
									text: `Error: Could not update criterion ${params.criterionIndex} of story "${params.storyId}".`,
								},
							],
							isError: true,
						};
					}
					const allVerified = story.acceptanceCriteria.every(c => c.verified);
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ Criterion ${params.criterionIndex} of ${story.id} verified=${params.verified}.\n` +
									`Story passes (auto): ${story.passes} (all criteria verified = ${allVerified})`,
							},
						],
					};
				}

				case 'status': {
					const status = getPrdStatus();
					if (!status) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'No active PRD. Call oms-prd with action: "init" first.',
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`PRD Status\n` +
									`────────────────────────────\n` +
									`Task: ${status.task}\n` +
									`Refined: ${status.refined}\n` +
									`Stories: ${status.passed}/${status.total} passed (${status.remaining} remaining)\n\n` +
									`Stories (priority order):\n` +
									status.stories
										.map(
											s =>
												`  [${s.passes ? '✓' : '○'}] ${s.id} [P${s.priority}]: ${s.title}`,
										)
										.join('\n'),
							},
						],
					};
				}

				case 'init-progress': {
					const created = initProgress();
					return {
						content: [
							{
								type: 'text' as const,
								text: created
									? '✅ progress.txt initialized.'
									: '• progress.txt already exists.',
							},
						],
					};
				}

				case 'log-progress': {
					if (!params.message) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "message" is required for the "log-progress" action.',
								},
							],
							isError: true,
						};
					}
					logProgress(params.message);
					return {
						content: [
							{
								type: 'text' as const,
								text: '✅ Progress logged.',
							},
						],
					};
				}

				case 'list': {
					const status = getPrdStatus();
					if (!status) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'No active PRD. Call oms-prd with action: "init" first.',
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`PRD Stories (${status.passed}/${status.total} passed):\n` +
									status.stories
										.map(
											s =>
												`  [${s.passes ? '✓' : '○'}] ${s.id} [P${s.priority}]: ${s.title}`,
										)
										.join('\n'),
							},
						],
					};
				}

				default:
					return {
						content: [
							{
								type: 'text' as const,
								text: `Unknown action: ${params.action}`,
							},
						],
						isError: true,
					};
			}
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Tool: oms-stop ──

server.registerTool(
	'oms-stop',
	{
		description:
			'End the current OMS orchestration session. Deletes the state file. The session is over — no further oms-* tools will work until oms-start is called again.',
		inputSchema: {},
	},
	() => {
		try {
			const state = loadState();
			if (!state) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'No active OMS session to stop.',
						},
					],
					isError: true,
				};
			}

			const summary = `Session ${state.sessionId} ended. Final stage: ${
				state.stage
			}. Tasks: ${state.tasks.filter(t => t.completed).length}/${
				state.tasks.length
			} completed. Turns: ${state.turnCount}.`;
			deleteState();
			// Also clean up Ralph PRD files (prd.json + progress.txt) if present.
			// Safe no-op if Ralph was never used.
			deletePrd();
			return {
				content: [
					{
						type: 'text' as const,
						text: `✅ OMS session stopped.\n\n${summary}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{type: 'text' as const, text: `Error: ${(error as Error).message}`},
				],
				isError: true,
			};
		}
	},
);

// ── Start server ──

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(error => {
	console.error('[OMS] Fatal error:', error);
	process.exit(1);
});
