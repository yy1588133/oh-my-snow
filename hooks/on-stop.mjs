#!/usr/bin/env node

/**
 * OMS onStop Hook
 *
 * Triggered when the AI finishes a turn.
 * 1. Reads OMS state and increments turn count
 * 2. Runs `git diff --stat` to detect actual file changes
 * 3. Injects continuation prompt based on stage + diff results
 *
 * Exit code 2+ = inject user message + continue conversation (drive the loop)
 * Exit code 0 = no injection, conversation ends
 *
 * Context passed via stdin (JSON):
 * { messages: [...] }
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

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

function saveState(state) {
	ensureStateDir();
	writeFileSync(getStateFilePath(), JSON.stringify(state, null, 2), 'utf-8');
}

function ensureStateDir() {
	const dir = getStateDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
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
		setTimeout(() => resolve(data), 100);
	});
}

// ── Git diff detection ──

function getGitDiffStat() {
	try {
		const output = execSync('git diff --stat', {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return output.trim();
	} catch {
		// Git not available, not a git repo, or diff failed
		return null;
	}
}

function getGitStagedDiffStat() {
	try {
		const output = execSync('git diff --cached --stat', {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return output.trim();
	} catch {
		return null;
	}
}

// ── Build continuation prompt ──

function buildContinuationPrompt(state, gitDiff) {
	const stage = state.stage;
	const turn = state.turnCount;
	const goal = state.goal;
	const tasks = state.tasks;
	const completedTasks = tasks.filter((t) => t.completed);
	const remainingTasks = tasks.filter((t) => !t.completed);

	let diffSection = '';
	if (gitDiff) {
		// Truncate to last 1000 chars if too long
		const truncated = gitDiff.length > 1000
			? '... ' + gitDiff.slice(-1000)
			: gitDiff;
		diffSection = `\nChanges detected:\n${truncated}\n`;
	} else {
		diffSection = '\n(No git changes detected or git not available)\n';
	}

	switch (stage) {
		case 'planning': {
			const taskList = tasks.length > 0
				? tasks.map((t) => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`).join('\n')
				: '  (no tasks yet)';
			return `[OMS:CONTINUE] Planning — Turn ${turn}
Goal: ${goal}
${diffSection}
Current plan:
${taskList}

Continue planning. Add more tasks with oms-add-task if needed.
When the plan is complete, call oms-set-stage { stage: "executing" } to start implementation.`;
		}

		case 'executing': {
			const taskList = tasks
				.map((t) => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`)
				.join('\n');
			return `[OMS:CONTINUE] Executing — Turn ${turn}
Goal: ${goal}
${diffSection}
Tasks (${completedTasks.length}/${tasks.length}):
${taskList}

Continue implementing remaining tasks.
Use oms-complete-task to mark tasks as done.
When all tasks are complete, call oms-set-stage { stage: "verifying" }.`;
		}

		case 'verifying': {
			return `[OMS:CONTINUE] Verifying — Turn ${turn}
Goal: ${goal}
${diffSection}
Review the changes above.
- If issues are found, call oms-set-stage { stage: "fixing" }
- If everything passes, call oms-set-stage { stage: "done" }`;
		}

		case 'fixing': {
			return `[OMS:CONTINUE] Fixing — Turn ${turn}
Goal: ${goal}
${diffSection}
Continue fixing the issues.
- Use filesystem-* tools to make corrections
- When fixes are done, call oms-set-stage { stage: "verifying" }`;
		}

		case 'done':
			// Session is complete — don't continue
			return null;

		default:
			return null;
	}
}

// ── Text bypass detection ──

function checkTextBypass(state, gitDiff) {
	// If the AI claims to have made changes but git diff shows nothing,
	// and we're in executing/fixing stage, warn the AI
	if (state.stage === 'executing' || state.stage === 'fixing') {
		if (!gitDiff || gitDiff.length === 0) {
			return true; // Bypass detected
		}
	}
	return false;
}

// ── Main ──

async function main() {
	// Read stdin context (consume it)
	await readStdin();

	const state = loadState();
	if (!state) {
		// No active OMS session — let the conversation end
		process.exit(0);
	}

	// Don't continue if session is done
	if (state.stage === 'done') {
		process.exit(0);
	}

	// Increment turn count
	state.turnCount = (state.turnCount || 0) + 1;
	state.updatedAt = new Date().toISOString();
	saveState(state);

	// Get git diff
	const gitDiff = getGitDiffStat();
	const gitStagedDiff = getGitStagedDiffStat();
	const fullDiff = [gitDiff, gitStagedDiff].filter(Boolean).join('\n') || null;

	// Check for text bypass
	const bypassDetected = checkTextBypass(state, fullDiff);

	// Build continuation prompt
	let prompt = buildContinuationPrompt(state, fullDiff);

	if (bypassDetected && prompt) {
		// Prepend warning about text bypass
		prompt =
			`⚠️ WARNING: No file changes detected via git diff, but you may have claimed to make changes.\n` +
			`Please use filesystem-* tools (filesystem-edit, filesystem-create, filesystem-replaceedit) to actually modify files.\n\n` +
			prompt;
	}

	if (!prompt) {
		// No continuation needed
		process.exit(0);
	}

	// Exit code 2: inject user message + continue conversation
	process.stderr.write(prompt);
	process.exit(2);
}

main().catch(() => {
	// On any error, let the conversation end normally (fail-open)
	process.exit(0);
});
