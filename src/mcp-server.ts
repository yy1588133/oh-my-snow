/**
 * OMS MCP Server
 *
 * Provides 8 state management tools via stdio transport.
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
			'Set the team name reference on the OMS state. Used by /oms:team to record which snow-cli team this session orchestrates. OMS only stores the name — the authoritative team state lives in snow-cli (~/.snow/teams/<team>/).',
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
						text: `✅ Team name set: ${updated.teamName}\n\nOMS is now in multi-agent team mode.\nThe snow-cli team "${params.teamName}" owns the authoritative team state.\nUse team-* tools (spawn_teammate, create_task, etc.) to orchestrate teammates.`,
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
					'Maximum evolution iterations (default 2, hard max 5). Each iteration runs EmbodiSkill → SkillEvolver → darwin-skill.',
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
							`The initial draft has been saved. Now execute the evolution cycle:\n\n` +
							`### Iteration 1/${maxIter}\n\n` +
							`**Step 1: EmbodiSkill — Skill-Aware Reflection**\n` +
							`- Load the skill: \`/skill embodi-skill\`\n` +
							`- Analyze the current draft against the session trajectory\n` +
							`- Input: The draft at ${skillDir}/SKILL.md + session data (stageHistory, logs, tasks)\n` +
							`- Output: A JSON array of revision signals (DISCOVERY, OPTIMIZATION, SKILL_DEFECT, EXECUTION_LAPSE)\n\n` +
							`**Step 2: SkillEvolver — Strategy Exploration**\n` +
							`- Load the skill: \`/skill skill-evolver\`\n` +
							`- For each revision signal, generate K=4 distinct strategies (max 8 total candidates)\n` +
							`- Deploy and test each candidate, then audit for overfitting\n` +
							`- Select the best candidate\n\n` +
							`**Step 3: Darwin-Skill — Evaluation & Ratchet**\n` +
							`- Load the skill: \`/skill darwin-skill\`\n` +
							`- Score the candidate across 9 dimensions (total 100 points)\n` +
							`- Apply ratchet: if score > baseline → KEEP, else → REVERT\n` +
							`- **Present the score breakdown and diff to the user** — wait for their confirmation before continuing\n\n` +
							`### Convergence Check\n` +
							`- If EmbodiSkill returns 0 revision signals AND darwin-skill score ≥ 80 → converged, save final skill\n` +
							`- If this is the last iteration (iteration ${maxIter}/${maxIter}) → save current best result\n` +
							`- Otherwise → proceed to Iteration 2/${maxIter} (return to Step 1)\n\n` +
							`**Important:**\n` +
							`- You are performing iteration 1 of ${maxIter}. Include this count in your progress updates.\n` +
							`- If this is the last iteration, save the current best result as the final skill.\n` +
							`- After each darwin-skill evaluation, pause and ask the user: "Do you want to keep this version?" before proceeding.`,
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
