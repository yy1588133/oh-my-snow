#!/usr/bin/env node

/**
 * OMS onStop Hook
 *
 * Triggered when the AI finishes a turn.
 * 1. Reads OMS state and increments turn count
 * 2. Runs `git diff --stat` to detect actual file changes
 * 3. Injects continuation prompt based on stage + diff results
 * 4. Runs build/test verification (marker-driven for executing/done,
 *    unconditional for verifying — see runVerification)
 *
 * Exit code 2+ = inject user message + continue conversation (drive the loop)
 * Exit code 0 = no injection, conversation ends
 *
 * Context passed via stdin (JSON):
 * { messages: [...] }
 */

import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getStateDir, loadState, saveState, detectVerifyCommand, readStdin, appendErrorLog, forceSetStage } from './lib/oms-state.mjs';

// ── Ralph PRD helper (read-only — writes go through the MCP oms-prd tool) ──
//
// on-stop only needs to SURFACE PRD progress in the continuation prompt so the
// AI knows which story to work on next. All mutations happen via the oms-prd
// MCP tool (backed by store.ts). This reads prd.json directly to avoid a
// runtime dependency on the compiled store.js (hooks are plain .mjs scripts).
//
// Atomicity note: store.ts writes prd.json via tmp+rename, which IS atomic on
// the normal path — a reader sees either the old file or the new file, never a
// partial one. The ONLY non-atomic path is the cross-device fallback in
// tmpRenameWrite (renameSync throws EXDEV → direct writeFileSync), where a
// reader can catch a half-written file. We retry once after a short sleep to
// ride out that window. We do NOT retry on ENOENT (file deleted — not
// transient) — only on SyntaxError (partial/corrupt JSON).

function syncSleep(ms) {
	// Synchronous sleep via Atomics.wait when SharedArrayBuffer is available;
	// falls back to a Date.now() spin (same primitive store.ts uses). This is a
	// sync hook, so blocking the event loop for ~20ms is acceptable. Note:
	// Atomics.wait does NOT yield the JS thread (it's a sync block) — it parks
	// the OS thread at the kernel level without burning CPU, which is cheaper
	// than a Date.now() spin but still blocks the event loop for the duration.
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) { /* spin fallback */ }
	}
}

function loadPrd() {
	const prdPath = join(getStateDir(), 'prd.json');
	if (!existsSync(prdPath)) return null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return JSON.parse(readFileSync(prdPath, 'utf-8'));
		} catch (error) {
			// ENOENT between the existsSync above and readFileSync means the
			// file was deleted mid-read (e.g. deletePrd during oms-stop) — not
			// transient, don't retry, just return null.
			if (error && error.code === 'ENOENT') {
				return null;
			}
			// SyntaxError (partial JSON from cross-device fallback) or other
			// transient read error — retry once after a short sleep before
			// giving up and dropping Ralph context from the continuation prompt.
			if (attempt === 0) {
				syncSleep(20);
			}
		}
	}
	return null;
}

function buildPrdSection(prd) {
	if (!prd || !prd.refined) {
		return prd
			? '\nPRD: scaffold created but NOT refined — call oms-prd action "refine" with task-specific stories before looping.\n'
			: '';
	}
	// Guard against a malformed prd.json (manual edit / torn write) — without this,
	// prd.stories.filter below throws TypeError and crashes the onStop hook.
	if (!Array.isArray(prd.stories)) {
		return '\nPRD: malformed prd.json (stories is not an array). Run oms-prd action "status" via the MCP tool to inspect.\n';
	}
	const passed = prd.stories.filter((s) => s && s.passes).length;
	const total = prd.stories.length;
	// Sort a COPY so we never mutate the loaded prd object (matters if loadPrd
	// is ever cached; harmless today but avoids a latent footgun).
	const sorted = [...prd.stories].sort((a, b) => a.priority - b.priority);
	const next = sorted.filter((s) => !s.passes)[0];
	const storyLines = sorted
		.map((s) => `  [${s.passes ? '✓' : '○'}] ${s.id} [P${s.priority}]: ${s.title}`)
		.join('\n');
	const nextBlock = next
		? `\nNext story: ${next.id} — ${next.title}\n  Call oms-prd action "next-story" for full acceptance criteria.\n`
		: '\nAll stories pass — proceed to reviewer verification (call #oms_reviewer or #oms_architect).\n';
	return `\nPRD Progress (${passed}/${total} stories passed):\n${storyLines}\n${nextBlock}`;
}

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
	const inTeamMode = !!state.teamName;

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
			if (inTeamMode) {
				// Team mode: lead plans locally, does NOT spawn yet (delayed spawn).
				// IMPORTANT: use oms-add-task (OMS local tasks) — NOT team-create_task.
				// snow-cli's team-create_task requires an active team, which only exists
				// after the first team-spawn_teammate runs (team.ts:560-566 throws otherwise).
				// Since OMS blocks spawn in planning, calling team-create_task here would deadlock.
				// Tasks migrate to team-create_task in the executing stage (after first spawn).
				return `[OMS:CONTINUE] Planning (Team Lead) — Turn ${turn}
Goal: ${goal}
${diffSection}
You are the TEAM LEAD in the planning stage. Delayed spawn is in effect.

Do NOT spawn teammates yet — planning stage blocks team-spawn_teammate.
1. Analyze the task and split it into N independent work items
2. Use \`oms-add-task\` to record the task list (OMS local tasks — for your own tracking; teammates cannot see these yet)
   - Do NOT call team-create_task in planning — it requires an active team (created by the first spawn), which doesn't exist yet
3. When the plan is complete, call oms-set-stage { stage: "executing" }

In executing stage you will: spawn the FIRST teammate (creates the team) → use team-create_task to publish the planned tasks → spawn the remaining N-1 teammates (each claims a task and works in its own worktree).`;
			}
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
			if (inTeamMode) {
				// Team mode: lead spawns teammates + drives standby teammates via messages
				return `[OMS:CONTINUE] Executing (Team Lead) — Turn ${turn}
Goal: ${goal}
${diffSection}
You are the TEAM LEAD in the executing stage. Spawn teammates now.

1. Call \`team-spawn_teammate\` N times (one per work item) — each gets a name, role, prompt
2. Each teammate will claim a task and work in its own isolated git worktree
3. Teammates that finish their work enter STANDBY (blocked on wait_for_messages)
   - To give them more work: \`team-message_teammate\` with a new task
   - To end them: \`team-shutdown_teammate\` (the ONLY way to terminate a teammate)
4. When all teammates are done, call oms-set-stage { stage: "verifying" }

Note: teammates do NOT trigger onStop — they run on a message-pump loop, not the turn loop.
Drive standby teammates yourself via message_teammate.`;
			}
			const taskList = tasks
				.map((t) => `  [${t.completed ? '✓' : '○'}] ${t.id}: ${t.description}`)
				.join('\n');
			// Ralph mode: if a PRD exists, surface its progress so the AI knows
			// which story to work on next. No-op when Ralph isn't active.
			const prd = loadPrd();
			const prdSection = buildPrdSection(prd);
			const ralphHint = prd
				? `\nRalph mode active. Use oms-prd to manage stories; verify EACH acceptance criterion with fresh evidence before mark-passes.\n`
				: '';
			return `[OMS:CONTINUE] Executing — Turn ${turn}
Goal: ${goal}
${diffSection}
Tasks (${completedTasks.length}/${tasks.length}):
${taskList}${prdSection}${ralphHint}
Continue implementing remaining tasks.
Use oms-complete-task to mark tasks as done.
When all tasks are complete, call oms-set-stage { stage: "verifying" }.`;
		}

		case 'verifying': {
			if (inTeamMode) {
				// Team mode: lead merges all teammate work + verification ran unconditionally by runVerification
				return `[OMS:CONTINUE] Verifying (Team Lead) — Turn ${turn}
Goal: ${goal}
${diffSection}
You are the TEAM LEAD in the verifying stage. Merge teammate work.

1. Call \`team-merge_all_teammate_work\` to serially merge all teammate branches
   - On conflict: snow-cli AI resolves it (manual/theirs/ours/auto)
2. Verification (build/test) runs AUTOMATICALLY after this turn (see build result below)
   - If build failed: call oms-set-stage { stage: "executing" } to fix (lead self-fix or re-spawn)
   - If build passed: call oms-set-stage { stage: "done" }
3. Before re-spawning teammates after a failed verify: check worktree state
   - If cleanup_team already ran: re-spawn creates fresh worktrees
   - If not: createTeamWorktree reuses old worktree — clean dirty changes with git checkout first

Note: teammate-side verification is ineffective (teammates don't run onStop).
Lead-side onStop is the single source of verification truth.`;
			}
			return `[OMS:CONTINUE] Verifying — Turn ${turn}
Goal: ${goal}
${diffSection}
Review the changes above.
- If issues are found, call oms-set-stage { stage: "executing" } to fix them
- If everything passes, call oms-set-stage { stage: "done" }`;
		}

		case 'done':
			// Session is complete — don't continue (unless build failed → force-transition handled below)
			if (inTeamMode) {
				return `[OMS:CONTINUE] Done (Team Lead) — Turn ${turn}
Goal: ${goal}
Team work complete. Call \`team-cleanup_team\` to reclaim all worktrees + branches.`;
			}
			return null;

		default:
			return null;
	}
}

// ── Text bypass detection ──

function checkTextBypass(state, gitDiff) {
	// If the AI claims to have made changes but git diff shows nothing,
	// and we're in executing stage, warn the AI.
	if (state.stage === 'executing' && state.turnCount > 1) {
		if (gitDiff != null && gitDiff.length === 0) {
			return true; // Bypass detected
		}
	}
	return false;
}

// ── Verification (extracted, addresses two team-mode hazards) ──
//
// Hazards fixed:
//   - Original logic was wrapped in `if (existsSync(markerPath))`, so the
//     verifying stage (which never writes the marker — afterToolCall's
//     VERIFY_STAGES excludes 'verifying') would skip verification entirely.
//     Fix: runVerification is called UNCONDITIONALLY for 'verifying'.
//   - detectVerifyCommand() can return null (no build system detected).
//     Original `if (verifyCmd)` silently passed — a false "verified OK".
//     Fix: null is surfaced as an explicit "cannot auto-verify" prompt.

/**
 * Run build/test verification.
 * @param {object} state - OMS state
 * @returns {string} buildErrorPrefix — non-empty if verification ran and FAILED,
 *   or if no verify command could be detected (null fallback). Empty on success.
 */
function runVerification(state) {
	const markerPath = join(getStateDir(), '.pending-verify');
	const markerExists = existsSync(markerPath);

	const verifyCmd = detectVerifyCommand(state);

	// Null fallback: no build system / verify command detected.
	// Do NOT silently pass — surface it so the lead knows it can't auto-verify.
	if (!verifyCmd) {
		// Clean up marker if present (don't leave it dangling)
		if (markerExists) {
			try { unlinkSync(markerPath); } catch {}
		}
		return `[OMS:VERIFY] No build/test command detected for this project (detectVerifyCommand returned null).\n` +
			`Cannot auto-verify ${state.stage === 'verifying' ? 'merged code' : 'edits'}. Manual verification required.\n\n` +
			`Either:\n` +
			`  - Run your tests manually to confirm, OR\n` +
			`  - Call oms-start with an explicit verifyCommand (e.g. "npm test") and retry\n\n`;
	}

	let buildErrorPrefix = '';

	// Execute the verify command (always — caller decides whether to invoke us)
	try {
		execSync(verifyCmd, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 110000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		// Build succeeded — no error prefix
	} catch (error) {
		const buildError = error.stderr || error.stdout || error.message || 'Unknown build error';
		const truncated = buildError.length > 2000 ? '...\n' + buildError.slice(-2000) : buildError;
		buildErrorPrefix =
			`[OMS:BUILD FAILED] Auto-verification command: "${verifyCmd}"\n\n` +
			`The build/test check failed after your edits.\n` +
			`You must fix the build errors before proceeding.\n\n` +
			`Build output:\n${truncated}\n\n` +
			`Fix the errors above.\n` +
			`If you're in the "verifying" stage, switch back to executing: oms-set-stage { stage: "executing" }\n\n`;
	}

	// Clean up marker (always, even on failure)
	if (markerExists) {
		try { unlinkSync(markerPath); } catch {}
	}

	return buildErrorPrefix;
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

	// Build error prefix (populated if verification fails or no verify command)
	let buildErrorPrefix = '';

	// Verification dispatch: verifying runs unconditionally (beforeToolCall blocks
	// edits in verifying → afterToolCall never writes the marker → marker-gated
	// check would skip merged code). executing/done stay marker-driven. See runVerification.
	if (state.stage === 'verifying') {
		buildErrorPrefix = runVerification(state);
	} else {
		// Marker-driven (original path) — only runs when afterToolCall wrote the marker
		const markerPath = join(getStateDir(), '.pending-verify');
		if (existsSync(markerPath)) {
			buildErrorPrefix = runVerification(state);
		}
	}

	// If session is done and build succeeded (no error prefix), end the conversation.
	// (done + build failure falls through to force-transition below)
	if (state.stage === 'done' && !buildErrorPrefix) {
		process.exit(0);
	}

	// ── Merged: turn count increment + optional force-transition + single save ──

	// 1. Increment turn count FIRST (Test 23 expects turnCount === 2)
	state.turnCount = (state.turnCount || 0) + 1;
	state.updatedAt = new Date().toISOString();

	// 2. If done + build failure: force-transition to executing so the AI can fix.
	//    Use a flag to track whether force-transition actually occurred,
	//    so we don't falsely show "STAGE TRANSITION" when already in 'executing'.
	const forceTransitioned = (state.stage === 'done' && buildErrorPrefix);
	if (forceTransitioned) {
		forceSetStage(state, 'executing');
	}

	// 3. Single saveState call (covers both normal and force-transition paths)
	saveState(state);

	// 4. If force-transitioned: inject transition message and exit
	if (forceTransitioned) {
		buildErrorPrefix =
			`[OMS:STAGE TRANSITION] done → executing — you can now edit files to fix the build errors.\n\n` +
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
