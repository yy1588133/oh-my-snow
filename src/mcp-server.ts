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
	hasMatchingApproval,
	requestVerification,
	submitApproval,
	getPendingVerification,
	writeOmsState,
	readOmsState,
	deleteOmsState,
	listOmsModes,
	canEnterVerifying,
	canEnterDone,
	formatLedgerSummary,
	parseScorecard,
	approveSelfGate,
	validateTaskCompleteScorecard,
	assertApprovingScorecard,
	getLedgerApproval,
	setLastGateFailure,
	type RefinedStoryInput,
	type GateScope,
} from './state/store.js';
import {writeFileSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

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
			goal: z
				.string()
				.trim()
				.min(1)
				.max(2000)
				.describe('The high-level goal the AI should accomplish'),
			verifyCommand: z
				.string()
				.max(500)
				.optional()
				.describe(
					'Command to run for build/test verification (e.g. "npm test", "dotnet build"). If omitted, auto-detect from project files. Allowed: alphanumerics, paths, flags, &&, |. Blocked: ; ` $ <> newline/CR || bare & (background).',
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
							}\n- Goal: ${existing.goal}\n- Tasks: ${
								(Array.isArray(existing.tasks) ? existing.tasks : []).length
							} (${
								(Array.isArray(existing.tasks) ? existing.tasks : []).filter(t => t.completed).length
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
							`Gates: required (task-complete → verifying; task-reconcile + code-quality + completion → done)\n\n` +
							`Next steps:\n` +
							`1. Analyze the codebase and create a plan\n` +
							`2. Use oms-add-task to add tasks to the plan\n` +
							`3. When the plan is ready, call oms-set-stage { stage: "executing" }\n` +
							`4. Implement tasks using filesystem-* and terminal-execute tools\n` +
							`5. Use oms-complete-task to mark tasks as done\n` +
							`6. Submit task-complete gate (oms-prd submit-gate), then oms-set-stage verifying\n` +
							`7. In verifying: task-reconcile gate, then code-quality + completion via independent #oms_reviewer/#oms_critic\n` +
							`8. If issues found, oms-set-stage executing and fix; gate rejects bounce to executing\n` +
							`9. Only after all three ledger approvals: oms-set-stage done (oral done is blocked)\n` +
							`10. Use oms-get-state for Gate ledger / Last gate failure`,
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

			const tasks = Array.isArray(state.tasks) ? state.tasks : [];
			const taskLines = tasks
				.map(t => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`)
				.join('\n');

			const logs = Array.isArray(state.logs) ? state.logs : [];
			const recentLogs = logs
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
							`Updated: ${state.updatedAt}\n` +
							`Gates:   required=${state.gatesRequired === true}\n\n` +
						`Tasks (${tasks.filter(t => t.completed).length}/${
							tasks.length
						} completed):\n` +
							(taskLines || '  (no tasks yet)') +
							'\n\n' +
							`Gate ledger:\n${formatLedgerSummary()}\n` +
							(state.lastGateFailure
								? `\nLast gate failure (${state.lastGateFailure.at}):\n` +
									`  scope: ${state.lastGateFailure.scope}\n` +
									`  ${state.lastGateFailure.summary}\n`
								: '') +
							`\nRecent logs:\n` +
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

			// G1: entering verifying requires task-complete / PRD matrix when gatesRequired.
			if (params.stage === 'verifying' && state.gatesRequired === true) {
				const prd = loadPrd();
				const status = prd ? getPrdStatus() : null;
				const allPrdPass =
					!!status && status.total > 0 && status.passed === status.total;
				const check = canEnterVerifying({
					tasks: Array.isArray(state.tasks) ? state.tasks : [],
					hasPrd: !!prd && Array.isArray(prd.stories) && prd.stories.length > 0,
					allPrdStoriesPass: allPrdPass,
				});
				if (!check.ok) {
					setLastGateFailure('task-complete', check.reason, [check.reason]);
					return {
						content: [{type: 'text' as const, text: `❌ ${check.reason}`}],
						isError: true,
					};
				}
			}

			// G2: done requires multi-gate ledger when gatesRequired; else legacy completion.
			if (params.stage === 'done') {
				if (state.gatesRequired === true) {
					const check = canEnterDone(true);
					if (!check.ok) {
						setLastGateFailure('done', check.reason, [check.reason]);
						return {
							content: [{type: 'text' as const, text: `❌ ${check.reason}`}],
							isError: true,
						};
					}
				} else if (!hasMatchingApproval(null, 'completion')) {
					// Legacy: single completion approval (file-missing exemption inside hasMatchingApproval).
					return {
						content: [
							{
								type: 'text' as const,
								text:
									'❌ Cannot transition to done — no approved completion verification.\n\n' +
									'Before marking the session done, request a completion-scope review:\n' +
									'  oms-prd action:"request-verification" storyId:null scope:"completion"\n' +
									'Then have the reviewer approve via:\n' +
									'  oms-prd action:"submit-approval" requestId:<token> verdict:"approved" reviewerAgentId:<id>\n' +
									'Once approved, re-call oms-set-stage { stage: "done" }.',
							},
						],
						isError: true,
					};
				}
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
				.trim()
				.min(1)
				.max(2000)
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
				.max(100)
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
				.max(200)
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
				.max(200)
				.optional()
				.describe('Snapshot key (required for save/restore)'),
			data: z
				.string()
				.max(100000)
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
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "data" must be valid JSON. Serialize the object before passing it (e.g. JSON.stringify(myData)).',
						},
					],
					isError: true,
				};
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
			summary: z.string().max(10000).describe('Summary of what was accomplished'),
			patterns: z
				.string()
				.max(50000)
				.describe(
					'JSON array of pattern objects, each with "name", "description", and "applicability"',
				),
			skillName: z
				.string()
				.max(100)
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

			// Generate the initial SKILL.md draft content.
			// YAML-escape the description: wrap in double quotes and escape any
			// internal double quotes and backslashes. Without this, a summary
			// containing ":" or "---" would break the frontmatter parser.
			const yamlDescription = JSON.stringify(params.summary.split('\n')[0].slice(0, 200));
			const draftContent = `---
name: ${skillName}
description: ${yamlDescription}
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
- Tasks completed: ${(Array.isArray(state.tasks) ? state.tasks : []).filter(t => t.completed).length}/${
				(Array.isArray(state.tasks) ? state.tasks : []).length
			}
- Turns: ${state.turnCount}

## Generated
- Session: ${state.sessionId}
- Date: ${new Date().toISOString()}
`;

			// Save the draft to the skill directory
			const skillDir = join(
				homedir(),
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
//   mark-passes    — set a story's passes flag (true requires all criteria verified + matching approval)
//   unmark-passes  — revert passes to false (on reviewer rejection; also clears verification approval)
//   verify-criterion — mark a single acceptance criterion as verified/unverified (auto-lift now requires matching approval)
//   status        — get PRD completion summary
//   init-progress — initialize progress.txt
//   log-progress  — append a learning entry to progress.txt
//   list          — list all stories with their passes status
//   request-verification  — request a UUID-token verification (story or completion scope) for anti-forge review
//   submit-approval       — submit reviewer verdict (approved/rejected) + reviewerAgentId (caller attribution)
//   get-pending-verification — read the current verification state (audit)

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
					'request-verification',
					'submit-approval',
					'get-pending-verification',
					'submit-gate',
				])
				.describe('The PRD action to perform'),
			task: z
				.string()
				.max(2000)
				.optional()
				.describe(
					'The task description (required for "init" and "refine")',
				),
			stories: z
				.array(
					z.object({
						title: z.string().max(500),
						acceptanceCriteria: z.array(z.string().max(2000)).min(1),
						priority: z.number().int().positive(),
					}),
				)
				.max(100)
				.optional()
				.describe(
					'Refined stories (required for "refine"). Each has title, acceptance criteria texts, and priority.',
				),
			title: z
				.string()
				.max(500)
				.optional()
				.describe('Story title (required for "add-story")'),
			acceptanceCriteria: z
				.array(z.string().max(2000))
				.min(1)
				.max(50)
				.optional()
				.describe(
					'Acceptance criteria texts (required for "add-story"). At least one criterion is required so Ralph can verify each before passing.',
				),
			priority: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Story priority, lower = higher (for "add-story"); must be a positive integer'),
			storyId: z
				.string()
				.max(50)
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
				.max(5000)
				.optional()
				.describe('Progress entry text — required for "log-progress"'),
			scope: z
				.enum([
					'story',
					'completion',
					'task-complete',
					'task-reconcile',
					'code-quality',
				])
				.optional()
				.describe(
					'Verification/gate scope — request-verification or submit-gate. story | completion | task-complete | task-reconcile | code-quality.',
				),
			scorecard: z
				.string()
				.max(20000)
				.optional()
				.describe(
					'JSON scorecard for submit-gate OR submit-approval (required for code-quality/completion): {pass,summary,evidence[],deferred?,diffStat?,noTasksReason?}',
				),
			requestId: z
				.string()
				.max(100)
				.optional()
				.describe(
					'UUID verification token — required for "submit-approval" (must match the token returned by request-verification).',
				),
			verdict: z
				.enum(['approved', 'rejected'])
				.optional()
				.describe('Reviewer verdict — required for "submit-approval"'),
			feedback: z
				.string()
				.max(10000)
				.optional()
				.describe('Reviewer feedback text — required for "submit-approval"'),
			reviewerAgentId: z
				.string()
				.max(200)
				.optional()
				.describe(
					'Which reviewer agent submitted the approval (caller attribution audit, AC1.12) — required for "submit-approval"',
				),
			criticTier: z
				.string()
				.max(100)
				.optional()
				.describe('Critic tier used for the review (architect/critic/codex) — optional for "submit-approval"'),
		},
	},
	params => {
		// Shared error-response builders for mark-passes and verify-criterion.
		// Centralizes the message format so the two cases stay consistent (DRY).
		// setPrdStoryPasses returns a structured SetPrdStoryPassesResult that
		// distinguishes missing-prd / missing-story / guard, so the mark-passes
		// handler can give an accurate, actionable error in ONE store call — no
		// MCP-layer loadPrd pre-check needed. verify-criterion still does its own
		// loadPrd for the index-range check (it needs the story's criteria array
		// to validate criterionIndex before calling the store).
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
		// Shared CRITICAL refine warning for the init handler's two unrefined-PRD
		// paths (existing-PRD early-return + concurrent-persisted branch). An
		// unrefined PRD still has generic scaffold criteria — the agent must NOT
		// enter the loop with those. Centralizing the warning text in ONE place
		// keeps the two paths symmetric and prevents message drift. Returns '' for
		// an already-refined PRD so callers can append it unconditionally.
		const refineWarning = (prd: {refined: boolean}): string =>
			prd.refined
				? ''
				: '\n\n⚠️ CRITICAL: This PRD still has generic acceptance criteria (not refined yet).\n' +
				  'You MUST refine it with task-specific stories by calling oms-prd with action: "refine"\n' +
				  'before entering the persistence loop.';
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
						// Surface the CRITICAL refine warning when the existing PRD is
						// unrefined — same risk as the concurrent-persisted path below
						// (generic scaffold criteria must not enter the loop). The shared
						// `refineWarning` helper keeps the two paths' text in sync.
						return {
							content: [
								{
									type: 'text' as const,
									text: `⚠️ A PRD already exists (task: "${existing.task}", refined: ${existing.refined}).\n\nIf you want to start fresh, call oms-stop first to clear state, or use "refine" to replace the stories.` +
										refineWarning(existing),
								},
							],
							isError: true,
						};
					}
					const {prd, wrote, persisted} = initPrd(params.task);
					// `wrote` distinguishes "we persisted the scaffold" from "we lost the
					// lock race and are returning the winner's in-memory/disk PRD". The
					// agent-facing message must reflect which happened — claiming "created"
					// for a race-lost scaffold misleads the agent into refining a PRD that
					// may already have been refined by the winner.
					//
					// `persisted` tells us whether `prd` reflects a PRD currently on disk
					// (we wrote it, OR the winner's PRD is on disk). When !persisted, the
					// scaffold is in-memory only and the agent must refine to persist it.
					// This avoids a redundant `loadPrd()` re-read here — initPrd already
					// loaded theirs internally and returned it, so we reuse `prd` directly.
					if (wrote) {
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
					if (persisted) {
						// Case (a): another session created the PRD between our pre-check
						// and initPrd's internal loadPrd — we return theirs (now on disk).
						// Reuse `prd` directly instead of re-loading (initPrd already read
						// theirs). If the winner's PRD is NOT yet refined, surface the
						// CRITICAL refine warning — the agent must not enter the loop with
						// the winner's generic scaffold criteria. Shared `refineWarning`
						// helper keeps this text identical to the existing-PRD path above.
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`⚠️ A PRD was created concurrently by another session — using theirs instead of writing a new scaffold.\n\n` +
										`Task: ${prd.task}\n` +
										`Refined: ${prd.refined}\n` +
										`Stories: ${prd.stories.length}\n\n` +
										`Call oms-prd with action: "refine" if you need task-specific stories,\n` +
										`or action: "status" to inspect what the other session set up.` +
										refineWarning(prd),
								},
							],
						};
					}
					// Case (b): lost the lock race AND no PRD on disk (winner wrote then
					// deleted, or transient lock failure) — in-memory scaffold only.
					// Tell the agent persistence is deferred to the next refine. Unlike
					// the refine handler's guard (effectiveTask empty → error), refinePrd
					// inherits `existing?.task || ''` — but there's no existing PRD here,
					// so the agent MUST pass a task to refine, or call init again. We make
					// this explicit so the agent doesn't hit refine's empty-task dead-end.
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`⚠️ PRD scaffold was created in memory but NOT persisted to disk (lock contention with no winner write-through).\n\n` +
									`Task (in-memory): ${prd.task}\n\n` +
									`Recommended action: call oms-prd with action: "refine" AND pass a "task" (e.g. the original goal).\n` +
									`refinePrd writes under the lock and will reconcile/persist the PRD. Do NOT call refine\n` +
									`without a task — with no PRD on disk, refine has no task to inherit and would refuse.\n` +
									`Do NOT assume the scaffold is on disk until refine succeeds.`,
							},
						],
						isError: true,
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
					// setPrdStoryPasses returns a structured result distinguishing the
					// four refusal reasons (missing-prd / missing-story / guard / no-approval)
					// plus the verified/total counts for the guard case. This lets us give
					// the agent an accurate, actionable error in ONE store call — no MCP-layer
					// loadPrd pre-check and no post-refusal freshPrd re-read.
					const result = setPrdStoryPasses(params.storyId, passes);
					if (!result.ok) {
						if (result.reason === 'missing-prd') {
							return noPrdError();
						}
						if (result.reason === 'missing-story') {
							return noStoryError(params.storyId);
						}
						if (result.reason === 'guard') {
							// mark-passes(true) refused because not all criteria are verified
							// (or the story has zero criteria — a legacy PRD). Direct the
							// agent to verify each criterion first; the counts come straight
							// from the store, no re-read needed.
							return {
								content: [
									{
										type: 'text' as const,
										text:
											`Error: Cannot mark story "${params.storyId}" as passing — not all acceptance criteria are verified yet.\n` +
											`Call oms-prd with action: "verify-criterion" for each criterion with fresh evidence first.\n` +
											`Verified: ${result.verifiedCount}/${result.totalCount}`,
									},
								],
								isError: true,
							};
						}
						// result.reason === 'no-approval': all criteria verified but
						// no matching approved verification. Direct the agent to
						// request verification and get reviewer approval first.
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`Error: Cannot mark story "${params.storyId}" as passing — no matching approved verification.\n` +
										`All acceptance criteria are verified, but a reviewer must approve first.\n\n` +
										`1. Call oms-prd with action: "request-verification", storyId: "${params.storyId}", scope: "story"\n` +
										`2. Have the reviewer approve via: oms-prd action: "submit-approval" requestId: <token> verdict: "approved" feedback: "..." reviewerAgentId: "<id>"\n` +
										`3. Then re-call oms-prd with action: "mark-passes" and storyId: "${params.storyId}"`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text: `✅ Story ${result.story.id} passes set to ${result.story.passes}.`,
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
					// Build a status line that explains WHY passes is what it is, so the
					// agent doesn't see "all verified = true" + "passes = false" and get
					// confused. After a reviewer reject (rejected=true), passes can't
					// auto-lift even when all criteria are verified — the agent must
					// explicitly call mark-passes(true). Surface that requirement here.
					//
					// passes-true branch MUST consult allVerified: setCriterionVerified's
					// auto-lift is asymmetric — un-verifying a criterion on a passed story
					// does NOT drop passes (only setPrdStoryPasses(false) does). So a story
					// can have passes=true while allVerified=false. Reporting "all criteria
					// verified" in that state would lie to the agent.
					let statusLine: string;
					if (story.passes && allVerified) {
						statusLine = `Story passes: true (all criteria verified)`;
					} else if (story.passes) {
						// passes=true but a criterion was un-verified after passing — the
						// story is in a stale-pass state. Drop passes via mark-passes(false)
						// to rework, or re-verify the outstanding criterion.
						const verifiedCount = story.acceptanceCriteria.filter(c => c.verified).length;
						statusLine =
							`Story passes: true BUT ${story.acceptanceCriteria.length - verifiedCount} criterion/criteria un-verified after passing.\n` +
							`passes was not auto-dropped (only mark-passes:false drops it). Re-verify the outstanding criterion, or call oms-prd with action: "unmark-passes" to rework.`;
					} else if (story.rejected) {
						// Split on allVerified so the message names the ACTUAL blocker:
						//   - all verified → only the veto blocks auto-lift (needs mark-passes(true))
						//   - not all verified → BOTH incomplete evidence AND the veto block
						if (allVerified) {
							statusLine =
								`Story passes: false — story was REJECTED by a reviewer.\n` +
								`All criteria are verified, but auto-lift is blocked by the reject veto.\n` +
								`To re-pass: call oms-prd with action: "mark-passes" and storyId "${story.id}".`;
						} else {
							statusLine =
								`Story passes: false — story was REJECTED by a reviewer.\n` +
								`Not all criteria are verified yet (${story.acceptanceCriteria.filter(c => c.verified).length}/${story.acceptanceCriteria.length}), AND auto-lift is blocked by the reject veto.\n` +
								`To re-pass: re-verify each criterion via "verify-criterion", then call oms-prd with action: "mark-passes" and storyId "${story.id}".`;
						}
					} else {
						statusLine =
							`Story passes: false (all criteria verified = ${allVerified}).\n` +
							`Auto-lifts to true once the last criterion is verified.`;
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ Criterion ${params.criterionIndex} of ${story.id} verified=${params.verified}.\n` +
									statusLine,
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

				// Phase 3 US-007: request-id anti-forge actions.
				// Flow: request-verification (get UUID token) → reviewer signs off →
				// submit-approval (record verdict + reviewerAgentId) → mark-passes /
				// oms-set-stage:done (gates check hasMatchingApproval). The token is
				// unguessable, so an AI that didn't actually call a reviewer can't fake
				// an approval.
				case 'submit-gate': {
					// Self-gates: task-complete / task-reconcile write ledger directly.
					// code-quality requires allowlisted reviewer via request+submit (use those).
					const scope = params.scope as GateScope | undefined;
					if (
						!scope ||
						(scope !== 'task-complete' && scope !== 'task-reconcile')
					) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										'Error: submit-gate supports scope "task-complete" or "task-reconcile" only.\n' +
										'For code-quality / completion use request-verification + submit-approval with reviewerAgentId oms_critic|oms_reviewer.',
								},
							],
							isError: true,
						};
					}
					if (!params.scorecard) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "scorecard" JSON is required for submit-gate.',
								},
							],
							isError: true,
						};
					}
					try {
						const card = parseScorecard(params.scorecard);
						assertApprovingScorecard(card, scope);
						if (scope === 'task-complete') {
							const st = loadState();
							const prd = loadPrd();
							const status = prd ? getPrdStatus() : null;
							const allPrdPass =
								!!status &&
								status.total > 0 &&
								status.passed === status.total;
							const reasons = validateTaskCompleteScorecard(
								card,
								st?.tasks ?? [],
								allPrdPass,
							);
							if (reasons.length) {
								setLastGateFailure('task-complete', reasons.join('; '), reasons);
								return {
									content: [
										{
											type: 'text' as const,
											text: `❌ task-complete rejected:\n- ${reasons.join('\n- ')}`,
										},
									],
									isError: true,
								};
							}
						}
						if (scope === 'task-reconcile') {
							// Order: nothing special for reconcile first
						}
						const entry = approveSelfGate({
							scope,
							scorecard: card,
							reviewerAgentId: params.reviewerAgentId ?? 'executor',
						});
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`✅ Gate ${scope} approved on ledger.\n` +
										`requestId: ${entry.requestId}\n` +
										`summary: ${card.summary}\n` +
										`Ledger:\n${formatLedgerSummary()}`,
								},
							],
						};
					} catch (e) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `❌ submit-gate failed: ${(e as Error).message}`,
								},
							],
							isError: true,
						};
					}
				}

				case 'request-verification': {
					if (!params.scope) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "scope" is required for "request-verification" (use "story" with storyId, or "completion" for whole-session sign-off).',
								},
							],
							isError: true,
						};
					}
					// story-scope requires a storyId; completion-scope requires null.
					if (params.scope === 'story' && !params.storyId) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "storyId" is required when scope="story". For whole-session sign-off use scope="completion" with storyId omitted.',
								},
							],
							isError: true,
						};
					}
					// Order hard-gate: code-quality requires task-reconcile first.
					if (
						params.scope === 'code-quality' &&
						!getLedgerApproval('task-reconcile')
					) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										'❌ Cannot request code-quality until task-reconcile is approved.\n' +
										'  oms-prd action:"submit-gate" scope:"task-reconcile" scorecard:\'{"pass":true,"summary":"...","evidence":["..."]}\'',
								},
							],
							isError: true,
						};
					}
					const storyId =
						params.scope === 'story' ? (params.storyId as string) : null;
					const v = requestVerification(
						storyId,
						params.scope as GateScope,
						params.criterionIndex ?? null,
					);
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ Verification requested (scope: ${v.scope}).\n` +
									`requestId: ${v.requestId}\n` +
									`storyId: ${v.storyId ?? '(completion scope)'}\n\n` +
									`Pass this requestId to the reviewer agent. After review, the reviewer calls:\n` +
									`  oms-prd action:"submit-approval" requestId:"${v.requestId}" verdict:"approved|rejected" feedback:"..." reviewerAgentId:"oms_critic" scorecard:'{"pass":true,"summary":"...","evidence":["..."],"diffStat":"..."}'\n` +
									`code-quality/completion REQUIRE scorecard + allowlisted reviewer (oms_critic|oms_reviewer|oms_architect). Re-request invalidates prior ledger approval for this scope only.\n` +
									`Once approved, mark-passes (story) or multi-gate done check may pass.`,
							},
						],
					};
				}

				case 'submit-approval': {
					if (!params.requestId) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "requestId" is required for "submit-approval". Call request-verification first.',
								},
							],
							isError: true,
						};
					}
					if (!params.verdict) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "verdict" (approved|rejected) is required for "submit-approval".',
								},
							],
							isError: true,
						};
					}
					if (!params.feedback) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "feedback" is required for "submit-approval" (reviewer must justify the verdict).',
								},
							],
							isError: true,
						};
					}
					if (!params.reviewerAgentId) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'Error: "reviewerAgentId" is required for "submit-approval" (caller attribution audit — which reviewer agent signed off?).',
								},
							],
							isError: true,
						};
					}
					const result = submitApproval(
						params.requestId,
						params.verdict,
						params.feedback,
						params.reviewerAgentId,
						params.criticTier ?? null,
						params.scorecard ?? null,
					);
					if (!result.ok) {
						// Map the four-gate failure reasons to actionable guidance.
						const guidance: Record<string, string> = {
							'mismatch': 'The requestId does not match the pending verification. Re-request and use the new token.',
							'used': 'This verification was already resolved (approved/rejected) and cannot be reused. Re-request a new verification.',
							'expired': 'This verification is past its TTL (2 hours). Re-request a fresh verification.',
							'max-attempts': 'Too many failed submit-approval attempts (reject count exceeded). Re-request a new verification to reset.',
							'missing': 'No pending verification exists. Call request-verification first.',
							'forbidden':
								'reviewerAgentId not allowlisted, scorecard missing/invalid for code-quality|completion, or code-quality without task-reconcile. ' +
								'Use reviewerAgentId oms_critic|oms_reviewer|oms_architect and scorecard JSON with pass/summary/evidence (diffStat for code-quality).',
						};
						return {
							content: [
								{
									type: 'text' as const,
									text: `❌ Approval rejected: ${result.reason}\n\n${guidance[result.reason] ?? ''}`,
								},
							],
							isError: true,
						};
					}
					const stAfter = loadState();
					const rejectBounce =
						params.verdict === 'rejected' && stAfter
							? `\nStage: ${stAfter.stage}` +
								(stAfter.lastGateFailure
									? `\nLast gate failure: ${stAfter.lastGateFailure.summary}`
									: '') +
								'\nNon-story reject clears ledger approval and bounces verifying/done → executing.'
							: '';
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`✅ Verification ${result.verification.status === 'approved' ? 'approved' : 'reject recorded (still pending token)'}.\n` +
									`requestId: ${result.verification.requestId}\n` +
									`scope: ${result.verification.scope}\n` +
									`reviewerAgentId: ${result.verification.reviewerAgentId}\n` +
									`attempts: ${result.verification.attempts}/${result.verification.maxAttempts}\n\n` +
									(result.verification.status === 'approved'
										? 'Approval recorded on ledger. mark-passes / oms-set-stage:done may proceed if all required gates are green.'
										: 'Rejection recorded.' + rejectBounce),
							},
						],
					};
				}

				case 'get-pending-verification': {
					const st = loadState();
					const v = getPendingVerification();
					if (!v) {
						const gatesNote =
							st?.gatesRequired === true
								? 'gatesRequired=true: missing pending token does NOT pass stage gates — use submit-gate / request-verification + scorecard approvals. Check oms-get-state Gate ledger.'
								: 'Legacy session (gatesRequired not set): absent verification-state may still exempt old completion gate.';
						return {
							content: [
								{
									type: 'text' as const,
									text: `No pending verification-state.json.\n${gatesNote}`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: 'text' as const,
								text:
									`Verification state:\n` +
									`  requestId: ${v.requestId}\n` +
									`  scope: ${v.scope}\n` +
									`  storyId: ${v.storyId ?? '(completion)'}\n` +
									`  status: ${v.status}\n` +
									`  attempts: ${v.attempts}/${v.maxAttempts}\n` +
									`  requestedAt: ${v.requestedAt}\n` +
									`  resolvedAt: ${v.resolvedAt ?? '(pending)'}\n` +
									`  reviewerAgentId: ${v.reviewerAgentId ?? '(none yet)'}\n` +
									`  criticTier: ${v.criticTier ?? '(none)'}\n` +
									`  feedback: ${v.reviewerFeedback ?? '(none)'}`,
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

// ── Tool: oms-state ──
//
// 通用键值状态存储，对标 omc state_write/state_read。每个 mode 一个 JSON 文件，
// 覆盖写语义。用于 skill 跨会话/上下文压缩后恢复状态（interview rounds、
// trace hypotheses、deep-dive phase 等）。
//
// 存储位置：.snow/oms-state/store/<mode>.json
// 覆盖写语义：skill 侧先 read 拿当前对象，改字段，再 write 回去。

server.registerTool(
	'oms-state',
	{
		description:
			'Generic key-value state store (mirrors omc state_write/state_read). Each mode is one JSON file with overwrite semantics. Used by skills to persist state across sessions and context compaction (e.g. interview rounds, trace hypotheses, deep-dive phase). Read-modify-write: call "read" first, mutate the object, then "write" it back. Storage: .snow/oms-state/store/<mode>.json',
		inputSchema: {
			action: z
				.enum(['write', 'read', 'delete', 'list'])
				.describe('The state action to perform'),
			mode: z
				.string()
				.regex(/^[a-zA-Z0-9_-]+$/, 'Mode name must be alphanumeric with underscores/hyphens only')
				.max(128, 'Mode name must not exceed 128 characters')
				.optional()
				.describe(
					'State domain name (e.g. "interview", "deep-dive", "trace"). Required for write/read/delete; ignored by list. Must match ^[a-zA-Z0-9_-]+$, max 128 chars.',
				),
			data: z
				.string()
				.optional()
				.describe(
					'JSON-serialized string of the state object (required for "write"). Overwrite semantics: the entire mode object is replaced.',
				),
		},
	},
	params => {
		try {
			if (params.action === 'list') {
				const modes = listOmsModes();
				return {
					content: [
						{
							type: 'text' as const,
							text:
								modes.length > 0
									? `Stored modes (${modes.length}):\n${modes
											.map(m => `  - ${m}`)
											.join('\n')}`
									: 'No state modes stored yet.',
						},
					],
				};
			}

			// write/read/delete all require a mode
			if (!params.mode) {
				return {
					content: [
						{
							type: 'text' as const,
							text: 'Error: "mode" is required for write/read/delete actions. Use action:"list" to see all modes.',
						},
					],
					isError: true,
				};
			}

			if (params.action === 'write') {
				if (params.data === undefined) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: "data" (JSON string) is required for the "write" action.',
							},
						],
						isError: true,
					};
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(params.data);
				} catch {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: "data" must be valid JSON. Serialize the state object before passing it.',
							},
						],
						isError: true,
					};
				}
				writeOmsState(params.mode, parsed);
				return {
					content: [
						{
							type: 'text' as const,
							text: `✅ State written: mode "${params.mode}" (${params.data.length} bytes).\n\nOverwrite semantics: the entire mode object was replaced. Read-modify-write pattern: call read first, mutate, then write back.`,
						},
					],
				};
			}

			if (params.action === 'read') {
				const data = readOmsState(params.mode);
				if (data === null) {
					// read 不存在是正常首写场景（read-modify-write 的首次 read），不当错误。
					// 标 isError 会让 skill 误判为失败；改成中性提示，调用方据此知道该首次写入。
					return {
						content: [
							{
								type: 'text' as const,
								text: `No state found for mode "${params.mode}" (first write or already cleared). Call action:"write" to initialize this mode.`,
							},
						],
					};
				}
				return {
					content: [
						{
							type: 'text' as const,
							text: `✅ State read: mode "${params.mode}"\n\n${JSON.stringify(data, null, 2)}`,
						},
					],
				};
			}

			if (params.action === 'delete') {
				const deleted = deleteOmsState(params.mode);
				// delete is idempotent — "not found" is not an error, the end state
				// (mode absent) is the same either way. Returning isError would make
				// skill retry logic treat a clean-up as a failure.
				return {
					content: [
						{
							type: 'text' as const,
							text: deleted
								? `✅ State deleted: mode "${params.mode}".`
								: `• No state found for mode "${params.mode}" (already absent — nothing to delete).`,
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
			const statePath = join(process.cwd(), '.snow', 'oms-state', 'state.json');
			// loadState returns null for absent, expired, AND corrupt. Expired/corrupt
			// still leave files on disk — U8 hooks tell agents to oms-stop, so we must
			// still delete residual state when the file exists.
			if (!state) {
				if (existsSync(statePath)) {
					const cleaned = deleteState();
					deletePrd();
					if (!cleaned) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										`⚠️ OMS session was expired/corrupt and cleanup is incomplete.\n\n` +
										`state.json and/or verify.cmd may still exist under .snow/oms-state/.\n` +
										`Delete them manually, then oms-start.`,
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
									`✅ OMS session cleaned up (was expired or corrupt — no live session).\n` +
									`You can oms-start a new session.`,
							},
						],
					};
				}
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

			const tasks = Array.isArray(state.tasks) ? state.tasks : [];
			const summary = `Session ${state.sessionId} ended. Final stage: ${
				state.stage
			}. Tasks: ${tasks.filter(t => t.completed).length}/${
				tasks.length
			} completed. Turns: ${state.turnCount}.`;
			const cleaned = deleteState();
			// Also clean up Ralph PRD files (prd.json + progress.txt) if present.
			// Safe no-op if Ralph was never used.
			deletePrd();
			if (!cleaned) {
				return {
					content: [
						{
							type: 'text' as const,
							text:
								`⚠️ OMS session stop incomplete — critical state artifacts remain on disk.\n\n` +
								`${summary}\n\n` +
								`state.json and/or verify.cmd could not be deleted (file in use / permissions).\n` +
								`Manually remove .snow/oms-state/state.json and verify.cmd before oms-start,\n` +
								`or residual verify.cmd may drive the next session's auto-verify gate.`,
						},
					],
					isError: true,
				};
			}
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
