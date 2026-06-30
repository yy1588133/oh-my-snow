#!/usr/bin/env node

/**
 * OMS onUserMessage Hook
 *
 * Triggered when the user sends a message.
 * Reads OMS state from .snow/oms-state/state.json and injects
 * stage-aware guidance into the conversation.
 *
 * Exit code 1 = stderr replaces the user's message
 * Exit code 0 = original message preserved
 *
 * Context passed via stdin (JSON):
 * { message: string, imageCount: number, ... }
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';

// ── Path helpers (must match store.ts logic) ──

function getStateDir() {
	const envDir = process.env.OMS_STATE_DIR;
	if (envDir) return envDir;
	return join(process.cwd(), '.snow', 'oms-state');
}

function getStateFilePath() {
	return join(getStateDir(), 'state.json');
}

function loadState() {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

// ── Read context from stdin ──

function readStdin() {
	return new Promise((resolve) => {
		let data = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => {
			data += chunk;
		});
		process.stdin.on('end', () => {
			resolve(data);
		});
		// Timeout fallback — if stdin is not piped, resolve after 100ms
		setTimeout(() => resolve(data), 100);
	});
}

// ── Stage-specific prompts ──

function getStagePrompt(state) {
	const stage = state.stage;
	const goal = state.goal;
	const tasks = state.tasks;
	const completedTasks = tasks.filter((t) => t.completed);
	const remainingTasks = tasks.filter((t) => !t.completed);

	switch (stage) {
		case 'planning':
			return `[OMS:PLANNING]
Goal: ${goal}
Tasks planned: ${tasks.length}

Instructions:
- Analyze the codebase and identify what needs to be done
- Use oms-add-task to add concrete, actionable tasks
- DO NOT edit any files yet — planning stage only
- When the plan is ready, call oms-set-stage { stage: "executing" }`;

		case 'executing':
			const taskList = tasks
				.map((t) => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`)
				.join('\n');
			return `[OMS:EXECUTING]
Goal: ${goal}
Tasks (${completedTasks.length}/${tasks.length}):
${taskList || '  (no tasks — add some with oms-add-task)'}

Instructions:
- Use filesystem-* tools to implement the remaining tasks
- Use oms-complete-task to mark each task as done
- The system will auto-run build/test after file edits
- When all tasks are complete, call oms-set-stage { stage: "verifying" }`;

		case 'verifying':
			return `[OMS:VERIFYING]
Goal: ${goal}
Tasks completed: ${completedTasks.length}/${tasks.length}

Instructions:
- Review all changes made during execution
- Run tests and verify correctness
- DO NOT edit files — verification only
- If issues are found, call oms-set-stage { stage: "fixing" }
- If everything passes, call oms-set-stage { stage: "done" }`;

		case 'fixing':
			return `[OMS:FIXING]
Goal: ${goal}
Remaining tasks: ${remainingTasks.length}

Instructions:
- Fix the issues identified during verification
- Use filesystem-* tools to make corrections
- The system will auto-run build/test after edits
- When fixes are complete, call oms-set-stage { stage: "verifying" }`;

		case 'done':
			return `[OMS:DONE]
Goal: ${goal}
All tasks completed. Session finished.

Instructions:
- The orchestration session is complete
- No further actions needed
- Use oms-learn to extract reusable patterns from this session
- Use oms-stop to clean up the session state`;

		default:
			return null;
	}
}

// ── Main ──

async function main() {
	// Read stdin context (we don't strictly need it, but consume it)
	await readStdin();

	const state = loadState();
	if (!state) {
		// No active OMS session — let the original message through
		process.exit(0);
	}

	const prompt = getStagePrompt(state);
	if (!prompt) {
		process.exit(0);
	}

	// Exit code 1: stderr replaces the user's message
	// The user's original message is prepended for context
	const originalMessage = ''; // We don't have the original message in stderr mode
	// Note: Snow CLI replaces the ENTIRE user message with stderr content
	// So we include the stage guidance as the new message content
	process.stderr.write(prompt);
	process.exit(1);
}

main().catch(() => {
	// On any error, let the original message through (fail-open)
	process.exit(0);
});
