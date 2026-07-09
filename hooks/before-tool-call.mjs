#!/usr/bin/env node

/**
 * OMS beforeToolCall Hook
 *
 * Triggered before a tool is executed.
 * Reads OMS state and BLOCKS filesystem write tools if the current
 * stage doesn't allow file editing.
 *
 * Exit code 1 = BLOCK the tool, stderr returned to AI as tool result
 * Exit code 0 = allow the tool to execute
 *
 * Context passed via stdin (JSON):
 * { toolName: string, args: Record<string, any> }
 *
 * Matcher (in hook config JSON):
 *   "filesystem-create,filesystem-edit,filesystem-replaceedit"
 *   This ensures the hook only fires for filesystem WRITE tools.
 */

import { loadState, readStdin, appendErrorLog, inspectStateFile, getStateDir } from './lib/oms-state.mjs';
import { isOmsStateWritePath, isOmsStateWriteCommand } from './lib/oms-path-guard.mjs';

// ── Stage enforcement matrix ──

// Tools that modify files — these are blocked in non-editing stages
const FILE_WRITE_TOOLS = new Set([
	'filesystem-create',
	'filesystem-edit',
	'filesystem-replaceedit',
]);

// Tools that execute terminal commands — blocked in planning/done.
// verifying ALLOWS terminal so /oms:verify can run git/test (filesystem writes stay blocked).
const TERMINAL_TOOLS = new Set([
	'terminal-execute',
]);

// Team spawn tool — blocked in non-executing stages (delayed-spawn enforcement).
// snow-cli exposes team tools with a `team-` prefix (mcpToolsManager.ts:411),
// so the AI calls `team-spawn_teammate` and the hook receives that full name.
const TEAM_SPAWN_TOOLS = new Set([
	'team-spawn_teammate',
]);

/**
 * Check if the current stage allows the given tool.
 * Returns { allowed: boolean, reason: string }
 */
function checkStageEnforcement(stage, toolName) {
	// File write tools
	if (FILE_WRITE_TOOLS.has(toolName)) {
		switch (stage) {
			case 'planning':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] You are in the PLANNING stage — file editing is not allowed.\n` +
						`The planning stage is for analysis and task creation only.\n\n` +
						`To start editing files:\n` +
						`1. Complete your plan by adding tasks with oms-add-task\n` +
						`2. Call oms-set-stage { stage: "executing" }\n\n` +
						`Then you can use filesystem-* tools to implement your plan.`,
				};
			case 'verifying':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] You are in the VERIFYING stage — file editing is not allowed.\n` +
						`The verifying stage is for reviewing changes, not making new ones.\n\n` +
						`If you found issues that need fixing:\n` +
						`  Call oms-set-stage { stage: "executing" }\n\n` +
						`Then you can edit files to fix the issues (lead self-fix or re-spawn teammate).\n` +
						`If everything passes, complete gates then:\n` +
						`  task-reconcile + code-quality + completion approvals, then oms-set-stage { stage: "done" }`,
				};
			case 'done':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] The orchestration session is DONE — no further file edits allowed.\n\n` +
						`If you need to make more changes, start a new session with oms-start.`,
				};
			// executing stage allows file edits
			// Note: 'idle' is handled by loadState()'s migration to 'planning',
			// so it never reaches this function as 'idle'.
			default:
				return { allowed: true, reason: '' };
		}
	}

	// Terminal tools — blocked in planning/done (shell can write files).
	// verifying allows terminal for git/test review (/oms:verify contract);
	// filesystem writes remain blocked in verifying.
	if (TERMINAL_TOOLS.has(toolName)) {
		switch (stage) {
			case 'planning':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] You are in the PLANNING stage — terminal-execute is not allowed.\n` +
						`Shell can modify the workspace and would bypass the file-edit gate.\n\n` +
						`Use read-only tools (filesystem-read, codebase-search, ace-search) for analysis.\n` +
						`When ready to implement:\n` +
						`  Call oms-set-stage { stage: "executing" }\n` +
						`Then terminal-execute is allowed.`,
				};
			case 'done':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] The orchestration session is DONE — no further commands allowed.\n\n` +
						`If you need to do more work, start a new session with oms-start.`,
				};
			// executing + verifying allow terminal
			default:
				return { allowed: true, reason: '' };
		}
	}

	// Team spawn tool — delayed-spawn enforcement.
	// Only allowed in executing stage; blocked in planning (lead must plan first),
	// verifying (merge phase, no new teammates), and done (session over).
	if (TEAM_SPAWN_TOOLS.has(toolName)) {
		switch (stage) {
			case 'planning':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] You are in the PLANNING stage — spawning teammates is not allowed yet.\n` +
						`Delayed spawn is in effect: plan first, spawn later.\n\n` +
						`1. Use oms-add-task to record the task list (OMS local tasks — for your own tracking; teammates cannot see these yet)\n` +
						`   Do NOT call team-create_task in planning — it requires an active team that only exists after the first spawn\n` +
						`2. Call oms-set-stage { stage: "executing" }\n` +
						`3. Then spawn the FIRST teammate (creates the team), call team-create_task to publish tasks, and spawn the remaining teammates\n\n` +
						`Only then can you spawn teammates with team-spawn_teammate.`,
				};
			case 'verifying':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] You are in the VERIFYING stage — no new teammates allowed.\n` +
						`The verifying stage is for merging and reviewing teammate work.\n\n` +
						`If you need more work done:\n` +
						`  Call oms-set-stage { stage: "executing" } to go back and re-spawn teammates.\n\n` +
						`Otherwise, proceed with team-merge_all_teammate_work.`,
				};
			case 'done':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] The orchestration session is DONE — no further teammates allowed.\n\n` +
						`If you need more work, start a new session with oms-start.`,
				};
			// executing stage allows spawning teammates
			default:
				return { allowed: true, reason: '' };
		}
	}

	// All other tools are always allowed
	return { allowed: true, reason: '' };
}

// ── Main ──

async function main() {
	const stdinData = await readStdin();

	// Parse context from stdin
	let context = {};
	try {
		if (stdinData.trim()) {
			context = JSON.parse(stdinData);
		}
	} catch {
		// If we can't parse the context, fail-open
		process.exit(0);
	}

	const toolName = context.toolName || '';
	if (!toolName) {
		// No tool name — fail-open
		process.exit(0);
	}

	// Only check if we have an active OMS session
	const state = loadState();
	if (!state) {
		// loadState null: no file, expired, or corrupt. No file → fail-open
		// (non-OMS usage). Expired/corrupt + write tools → fail-closed so a
		// zombie session cannot silently bypass stage gates.
		const status = inspectStateFile();
		if (
			(status === 'expired' || status === 'corrupt') &&
			(FILE_WRITE_TOOLS.has(toolName) || TERMINAL_TOOLS.has(toolName))
		) {
			const label = status === 'expired' ? 'STATE EXPIRED' : 'STATE CORRUPT';
			const detail =
				status === 'expired'
					? 'Session state is stale (no activity > 2h).'
					: 'Session state.json is corrupt or unreadable.';
			process.stderr.write(
				`[OMS:BLOCKED] ${label} — ${detail}\n` +
					`Write tools and terminal-execute are blocked until the session is cleaned up.\n\n` +
					`Run oms-stop to clean up, or delete .snow/oms-state/state.json, then oms-start.\n`,
			);
			process.exit(1);
		}
		// No active session — allow all tools
		process.exit(0);
	}

	// Protect OMS control-plane files from agent write bypass.
	// Anchor to real getStateDir() — do not substring-match unrelated docs.
	const args = context.args || context.arguments || {};
	const stateDir = getStateDir();
	if (FILE_WRITE_TOOLS.has(toolName)) {
		const pathCandidates = [
			args.path,
			args.filePath,
			args.file_path,
			args.file,
			args.target,
			args.target_file,
			typeof args === 'string' ? args : '',
		].filter(Boolean);
		if (pathCandidates.some((p) => isOmsStateWritePath(p, stateDir))) {
			process.stderr.write(
				`[OMS:BLOCKED] Cannot write under OMS state dir — gate ledger and session state are MCP-owned.\n` +
					`Use oms-prd submit-gate / request-verification / submit-approval and oms-set-stage instead.\n`,
			);
			process.exit(1);
		}
	}
	// Terminal: block write/delete to state dir; allow read/inspect.
	if (TERMINAL_TOOLS.has(toolName)) {
		const cmd = String(
			args.command || args.cmd || args.script || args.input || '',
		);
		if (cmd && isOmsStateWriteCommand(cmd, stateDir)) {
			process.stderr.write(
				`[OMS:BLOCKED] terminal-execute must not write/delete OMS state (including verification-ledger).\n` +
					`Gate state is MCP-owned. Use oms-prd / oms-set-stage tools instead.\n`,
			);
			process.exit(1);
		}
	}

	// Check stage enforcement
	const result = checkStageEnforcement(state.stage, toolName);

	if (!result.allowed) {
		// Exit code 1: BLOCK the tool, stderr returned to AI as tool result
		process.stderr.write(result.reason);
		process.exit(1);
	}

	// Tool is allowed
	process.exit(0);
}
main().catch((error) => {
	appendErrorLog(`beforeToolCall error: ${error.message}`);
	process.exit(0); // fail-open
});
