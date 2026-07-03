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

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getStateDir, loadState, saveState, detectVerifyCommand, readStdin, appendErrorLog, forceSetStage, loadPrd, inspectStateFile } from './lib/oms-state.mjs';

// loadPrd extracted to lib/oms-state.mjs (Phase 2 US-003) so loadState can read
// prd.updatedAt for the three-timestamp staleness check without duplicating the
// read logic. on-stop.mjs still calls loadPrd() for buildPrdSection (surfacing
// PRD progress in the continuation prompt) — same function, now shared.

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
	// Iteration progress for the header (US-002): show turn/softMax (hard max hardMax)
	// so the user can see how close the boulder is to the caps. Backfilled defaults
	// match loadState (50/200) for legacy state without these fields.
	const max = state.maxIterations ?? 50;
	const hardMax = state.hardMaxIterations ?? 200;
	const turnProgress = `${turn}/${max} (hard max ${hardMax})`;
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
				return `[OMS:CONTINUE] Planning (Team Lead) — Turn ${turnProgress}
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
			return `[OMS:CONTINUE] Planning — Turn ${turnProgress}
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
				return `[OMS:CONTINUE] Executing (Team Lead) — Turn ${turnProgress}
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
			return `[OMS:CONTINUE] Executing — Turn ${turnProgress}
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
				return `[OMS:CONTINUE] Verifying (Team Lead) — Turn ${turnProgress}
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
			return `[OMS:CONTINUE] Verifying — Turn ${turnProgress}
Goal: ${goal}
${diffSection}
Review the changes above.
- If issues are found, call oms-set-stage { stage: "executing" } to fix them
- If everything passes, call oms-set-stage { stage: "done" }`;
		}

		case 'done':
			// Session is complete — don't continue (unless build failed → force-transition handled below)
			if (inTeamMode) {
				return `[OMS:CONTINUE] Done (Team Lead) — Turn ${turnProgress}
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
		// Phase 2 US-004: 区分三种情况, loadState 对 expired/corrupt 都返回 null,
		// 用 inspectStateFile 决定 stderr 该写哪条提示, 让用户能区分过期/损坏/无会话.
		const status = inspectStateFile();
		if (status === 'expired') {
			// 僵尸态 (>2h 无活跃) — 明确提示后 exit 0, 不刷屏
			process.stderr.write(
				`[OMS:STATE EXPIRED] Session state is stale (no activity > 2h), ralph loop stopped.\n` +
				`Run oms-stop to clean up, or /oms:goal again with a fresh session.\n`
			);
		} else if (status === 'corrupt') {
			// JSON 解析失败 (torn write / 手动编辑损坏) — 区别于 EXPIRED 避免误报
			process.stderr.write(
				`[OMS:STATE CORRUPT] state.json exists but is unreadable (torn write or manual edit).\n` +
				`Run oms-stop to clean up and restart.\n`
			);
		}
		// 'absent' (无 state.json) 或上面两种: 都 exit 0 让对话结束
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

	// ── Iteration caps (anti-forge/staleness/soft-max patch, plan US-002) ──
	// Old fixed MAX_TURNS=50 / HARD_STOP=55 replaced with dynamic caps stored
	// on state. Soft cap auto-extends +10 on hit ("boulder keeps rolling");
	// only hard cap is a true stop. Defaults backfilled by loadState (50/200)
	// so legacy state.json without these fields still works.
	const maxIter = state.maxIterations ?? 50;
	const hardMax = state.hardMaxIterations ?? 200;

	// Hard stop: end the conversation entirely (fail-open). The only true stop
	// besides explicit oms-stop / oms-set-stage:done. turnCount > hardMax means
	// even with soft-cap extensions the loop ran past the hard ceiling.
	if (state.turnCount > hardMax) {
		const hardStopMsg =
			`[OMS:HARD STOP] Reached hard max iterations (${hardMax}). Session force-stopped.\n` +
			`Goal: ${state.goal}\n` +
			`Stage: ${state.stage}\n` +
			`Run oms-stop to clean up, or /oms:goal again with a fresh session.`;
		process.stderr.write(hardStopMsg);
		process.exit(0);
	}

	// Soft cap reached: extend +10 and keep the boulder rolling. NOT a stop.
	// omc ralph's "boulder never stops" philosophy — only hardMax truly ends.
	// We saveState the new cap so the extension persists across turns, then
	// fall through to normal continuation injection.
	let extendedNote = '';
	if (state.turnCount > maxIter) {
		const oldMax = maxIter;
		state.maxIterations = maxIter + 10;
		saveState(state);
		extendedNote =
			`[OMS:EXTENDED] Reached soft cap ${oldMax} turns, extending to ${state.maxIterations}. Boulder keeps rolling.\n\n`;
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
	// Prepend extended-cap note (if soft cap was hit this turn) to the prompt.
	if (extendedNote) {
		prompt = extendedNote + prompt;
	}
	process.stderr.write(prompt);
	process.exit(2);
}

main().catch((error) => {
	appendErrorLog(`onStop error: ${error.message}`);
	process.exit(0); // fail-open
});
