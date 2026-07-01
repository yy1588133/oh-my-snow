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

import { loadState, readStdin, appendErrorLog } from './lib/oms-state.mjs';

// ── Stage enforcement matrix ──

// Tools that modify files — these are blocked in non-editing stages
const FILE_WRITE_TOOLS = new Set([
	'filesystem-create',
	'filesystem-edit',
	'filesystem-replaceedit',
]);

// Tools that execute terminal commands — blocked in 'done' stage
const TERMINAL_TOOLS = new Set([
	'terminal-execute',
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
						`  Call oms-set-stage { stage: "fixing" }\n\n` +
						`Then you can edit files to fix the issues.\n` +
						`If everything passes:\n` +
						`  Call oms-set-stage { stage: "done" }`,
				};
			case 'done':
				return {
					allowed: false,
					reason:
						`[OMS:BLOCKED] The orchestration session is DONE — no further file edits allowed.\n\n` +
						`If you need to make more changes, start a new session with oms-start.`,
				};
			// executing and fixing stages allow file edits
			// Note: 'idle' is handled by loadState()'s migration to 'planning',
			// so it never reaches this function as 'idle'.
			default:
				return { allowed: true, reason: '' };
		}
	}

	// Terminal tools — blocked in done stage
	if (TERMINAL_TOOLS.has(toolName)) {
		if (stage === 'done') {
			return {
				allowed: false,
				reason:
					`[OMS:BLOCKED] The orchestration session is DONE — no further commands allowed.\n\n` +
					`If you need to do more work, start a new session with oms-start.`,
			};
		}
		return { allowed: true, reason: '' };
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
		// No active session — allow all tools
		process.exit(0);
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
