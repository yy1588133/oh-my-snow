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

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getStateDir, loadState, saveState, detectVerifyCommand, readStdin, appendErrorLog, forceSetStage } from './lib/oms-state.mjs';

// ── Git diff detection ──

function getGitDiffStat() {
	try {
		return execSync('git diff HEAD --stat', {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
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

	let diffSection = '';
	if (gitDiff == null) {
		diffSection = '\n(git not available — cannot detect changes)\n';
	} else if (gitDiff.length === 0) {
		diffSection = '\n(No git changes detected)\n';
	} else {
		// Truncate to last 1000 chars if too long
		const truncated = gitDiff.length > 1000
			? '... ' + gitDiff.slice(-1000)
			: gitDiff;
		diffSection = `\nChanges detected:\n${truncated}\n`;
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
	if ((state.stage === 'executing' || state.stage === 'fixing') && state.turnCount > 1) {
		if (gitDiff != null && gitDiff.length === 0) {
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

	// Build error prefix (populated if pending-verify marker triggers a failed build)
	let buildErrorPrefix = '';

	// Run build verification if .pending-verify marker exists (set by afterToolCall).
	// The marker means "a file was edited and needs verification" — this must run
	// regardless of current stage, including 'done' (the AI may have rushed to done
	// in the same turn as an edit).
	const markerPath = join(getStateDir(), '.pending-verify');
	if (existsSync(markerPath)) {
		// Run verification, then clean up marker
		try {
			const verifyCmd = detectVerifyCommand(state);
			if (verifyCmd) {
				try {
					execSync(verifyCmd, {
						cwd: process.cwd(),
						encoding: 'utf-8',
						timeout: 110000,
						stdio: ['pipe', 'pipe', 'pipe'],
					});
					// Build succeeded — no error prefix
				} catch (error) {
					// Build failed — prepend build error to continuation prompt
					const buildError = error.stderr || error.stdout || error.message || 'Unknown build error';
					const truncated = buildError.length > 2000 ? '...\n' + buildError.slice(-2000) : buildError;
					buildErrorPrefix =
						`[OMS:BUILD FAILED] Auto-verification command: "${verifyCmd}"\n\n` +
						`The build/test check failed after your edits.\n` +
						`You must fix the build errors before proceeding.\n\n` +
						`Build output:\n${truncated}\n\n` +
						`Fix the errors above.\n` +
						`If you're in the "verifying" stage, switch to "fixing": oms-set-stage { stage: "fixing" }\n\n`;
				}
			}
		} finally {
			// Always remove the marker, even on failure
			try { unlinkSync(markerPath); } catch {}
		}
	}

	// If session is done and build succeeded, end the conversation.
	// (done + build failure falls through to turn count increment + stage transition below)
	if (state.stage === 'done' && !buildErrorPrefix) {
		process.exit(0);
	}

	// ── Merged: turn count increment + optional force-transition + single save ──

	// 1. Increment turn count FIRST (Test 23 expects turnCount === 2)
	state.turnCount = (state.turnCount || 0) + 1;
	state.updatedAt = new Date().toISOString();

	// 2. If done + build failure: force-transition to fixing (mutates only, no save)
	//    Use a flag to track whether force-transition actually occurred,
	//    so we don't falsely show "STAGE TRANSITION" when already in 'fixing'.
	const forceTransitioned = (state.stage === 'done' && buildErrorPrefix);
	if (forceTransitioned) {
		forceSetStage(state, 'fixing');
	}

	// 3. Single saveState call (covers both normal and force-transition paths)
	saveState(state);

	// 4. If force-transitioned: inject transition message and exit
	if (forceTransitioned) {
		buildErrorPrefix =
			`[OMS:STAGE TRANSITION] done → fixing — you can now edit files to fix the build errors.\n\n` +
			buildErrorPrefix;
		process.stderr.write(buildErrorPrefix);
		process.exit(2);
	}

	// Prevent infinite loops — hard stop after grace period, soft warning at limit
	const MAX_TURNS = 50;
	const HARD_STOP = MAX_TURNS + 5; // 5 grace turns to wrap up

	// Hard stop: end the conversation entirely (fail-open)
	if (state.turnCount > HARD_STOP) {
		process.stderr.write('[OMS:HARD STOP] Session force-stopped after exceeding maximum turns.');
		process.exit(0);
	}

	// Soft warning: inject a wrap-up message, but let the AI continue
	if (state.turnCount > MAX_TURNS) {
		const maxTurnsMsg =
			`[OMS:MAX TURNS] Reached ${MAX_TURNS} turns. Stopping to prevent infinite loop.\n\n` +
			`Goal: ${state.goal}\n` +
			`Stage: ${state.stage}\n` +
			`Tasks: ${state.tasks.filter(t => t.completed).length}/${state.tasks.length} completed\n\n` +
			`Please wrap up your current work. Call oms-set-stage { stage: "done" } if you are finished, or oms-stop to end the session.\n` +
			`Note: The session will be force-stopped at turn ${HARD_STOP}.`;
		process.stderr.write(maxTurnsMsg);
		process.exit(2);
	}

	// Get git diff
	const fullDiff = getGitDiffStat();

	// Check for text bypass
	const bypassDetected = checkTextBypass(state, fullDiff);

	// Build continuation prompt
	let prompt = buildContinuationPrompt(state, fullDiff);

	if (!prompt) {
		// No continuation needed — but if there was a build error, inject it
		if (buildErrorPrefix) {
			process.stderr.write(buildErrorPrefix);
			process.exit(2);
		}
		process.exit(0);
	}

	if (bypassDetected && prompt) {
		// Prepend warning about text bypass
		prompt =
			`⚠️ WARNING: No file changes detected via git diff, but you may have claimed to have changes.\n` +
			`Please use filesystem-* tools (filesystem-edit, filesystem-create, filesystem-replaceedit) to actually modify files.\n\n` +
			prompt;
	}

	// Prepend build error (if any) to the continuation prompt
	if (buildErrorPrefix) {
		prompt = buildErrorPrefix + prompt;
	}

	// Exit code 2: inject user message + continue conversation
	process.stderr.write(prompt);
	process.exit(2);
}

main().catch((error) => {
	appendErrorLog(`onStop error: ${error.message}`);
	process.exit(0); // fail-open
});
