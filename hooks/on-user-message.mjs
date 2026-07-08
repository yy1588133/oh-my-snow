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

import { loadState, readStdin, appendErrorLog } from './lib/oms-state.mjs';

// ── Stage-specific prompts ──

function getStagePrompt(state) {
	const stage = state.stage;
	const goal = state.goal;
	// Guard against a malformed state.json (torn write / manual edit) — without
	// this, tasks.filter below throws TypeError and crashes the hook.
	const tasks = Array.isArray(state.tasks) ? state.tasks : [];
	const completedTasks = tasks.filter((t) => t.completed);

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
- If issues are found, call oms-set-stage { stage: "executing" } to fix them
- If everything passes, call oms-set-stage { stage: "done" }`;

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

async function main() {
	// Read stdin context and extract user message
	const stdinData = await readStdin();
	let context = {};
	try {
		if (stdinData.trim()) {
			context = JSON.parse(stdinData);
		}
	} catch {
		// Can't parse context — preserve original message (fail-open)
		process.exit(0);
	}

	const state = loadState();
	if (!state) {
		// No active OMS session — let the original message through
		process.exit(0);
	}

	const prompt = getStagePrompt(state);
	if (!prompt) {
		process.exit(0);
	}

	// Prepend the user's original message to the stage guidance
	const userMsg = context.message || '';
	process.stderr.write(userMsg ? `${userMsg}\n\n---\n${prompt}` : prompt);
	process.exit(1);
}
main().catch((error) => {
	appendErrorLog(`onUserMessage error: ${error.message}`);
	process.exit(0); // fail-open
});
