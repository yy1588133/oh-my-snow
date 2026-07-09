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
import {
	loadLedgerSummary,
	buildStatusPanel,
	buildSoftExtendBanner,
	buildHardStopReport,
} from './lib/status-panel.mjs';

// loadPrd extracted to lib/oms-state.mjs (Phase 2 US-003) so loadState can read
// prd.updatedAt for the three-timestamp staleness check without duplicating the
// read logic. on-stop.mjs still calls loadPrd() for buildPrdSection (surfacing
// PRD progress in the continuation prompt) — same function, now shared.

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
	// Empty stories array — distinct from "all pass" (which implies stories exist
	// and are all verified). Without this, total=0 makes next=undefined and the
	// else-branch below would falsely say "All stories pass".
	if (total === 0) {
		return '\nPRD: no stories defined. Call oms-prd action "refine" with task-specific stories.\n';
	}
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
			shell: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch {
		return null;
	}
}

// ── Build continuation prompt ──

function buildContinuationPrompt(state, gitDiff, prd) {
	const stage = state.stage;
	const turn = state.turnCount;
	// Iteration progress for the header (US-002): show turn/softMax (hard max hardMax)
	// so the user can see how close the boulder is to the caps. Backfilled defaults
	// match loadState (50/200) for legacy state without these fields.
	const max = state.maxIterations ?? 50;
	const hardMax = state.hardMaxIterations ?? 200;
	const turnProgress = `${turn}/${max} (hard max ${hardMax})`;
	const goal = state.goal;
	// Guard against a malformed state.json (torn write / manual edit) — without
	// this, tasks.filter below throws TypeError and crashes the onStop hook.
	// Mirrors the Array.isArray(prd.stories) guard in buildPrdSection.
	const tasks = Array.isArray(state.tasks) ? state.tasks : [];
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
			// prd is passed from main() — loadState() already reads prd.json
			// internally for staleness check, so we reuse the cached result
			// instead of calling loadPrd() again here (saves one disk read +
			// JSON.parse per turn).
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
   - If build passed: complete task-reconcile + code-quality + completion gates, then oms-set-stage { stage: "done" } (oral done blocked)
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
- If everything looks good, complete gates before done:
  1) oms-prd submit-gate task-reconcile
  2) request-verification code-quality + independent #oms_reviewer approval
  3) request-verification completion + independent #oms_critic approval
  4) oms-set-stage { stage: "done" }
- Oral "done" without ledger approvals is blocked. Check oms-get-state for Gate ledger / Last gate failure.`;
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

	// Security: reject commands with dangerous shell metacharacters before
	// execution. The MCP layer (store.ts validateVerifyCommand) already
	// validates on input, but a stored command could have been tampered with
	// on disk or set by a legacy state.json. This is the last line of defense
	// before execSync(verifyCmd, { shell: true }).
	// Keep denylist in lockstep with src/state/store.ts validateVerifyCommand.
	// Residual risk: bare | remains allowed (pipe UX); || is blocked (silent-green).
	if (
		/[;`$<>]/.test(verifyCmd) ||
		/[\n\r\u2028\u2029\f\v]/.test(verifyCmd) ||
		verifyCmd.includes('||') ||
		verifyCmd.replace(/&&/g, '').includes('&')
	) {
		if (markerExists) {
			try { unlinkSync(markerPath); } catch {}
		}
		return `[OMS:VERIFY] Verify command contains dangerous shell metacharacters and was rejected for security.\n` +
			`Command: "${verifyCmd.slice(0, 100)}"\n\n` +
			`Blocked characters: ; backtick $ <> newline/CR || & (background)\n` +
			`Run oms-stop and restart with a safe verify command (allowed: &&, |).\n\n`;
	}

	let buildErrorPrefix = '';

	// VERIFY_TIMEOUT_MS must stay below assets/hooks/onStop.json host timeout
	// (HOST=330000, BUFFER=30000 → host >= verify + buffer). See maturity U1.
	const VERIFY_TIMEOUT_MS = 300000;

	// Execute the verify command (always — caller decides whether to invoke us)
	try {
		execSync(verifyCmd, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: VERIFY_TIMEOUT_MS,
			shell: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		// Build succeeded — no error prefix
	} catch (error) {
		// Distinguish timeout from build failure: execSync sets error.killed
		// and error.signal when the timeout fires. Without this check the AI
		// receives "BUILD FAILED" and tries to fix code, when the real issue
		// is a hung test/process that needs to be killed, not debugged.
		// Prefer timed-out message / ETIMEDOUT; killed+SIGTERM is secondary (Node
		// timeout path usually sets both). Avoid labeling unrelated SIGTERM as timeout.
		const errMsg = String(error.message || '');
		const timedOut =
			error.killed === true ||
			error.code === 'ETIMEDOUT' ||
			/ETIMEDOUT|timed out/i.test(errMsg);
		if (timedOut) {
			buildErrorPrefix =
				`[OMS:VERIFY TIMEOUT] Auto-verification command timed out after 300s.\n` +
				`Command: "${verifyCmd}"\n\n` +
				`The command did not finish within the 5-minute timeout. This usually means:\n` +
				`  - A test or process is hung (deadlock, infinite loop, waiting for input)\n` +
				`  - A dev server was started and never exited\n\n` +
				`Check for hung processes. If you are in the "verifying" stage, switch back:\n` +
				`  oms-set-stage { stage: "executing" }\n` +
				`Then fix the hang, or oms-stop and restart with a faster verifyCommand.\n` +
				`Note: shell:true may leave orphan child processes after the timeout kill.\n\n`;
		} else {
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

	// Shared panel context for every continue / hard-stop path below.
	const prd = state._cachedPrd !== undefined ? state._cachedPrd : loadPrd();
	const ledger = loadLedgerSummary(getStateDir());
	const panelCtx = {
		state,
		ledger,
		prd,
		verifyNote: buildErrorPrefix
			? truncForPanel(buildErrorPrefix, 180)
			: null,
	};
	const fullPanel = () =>
		buildStatusPanel(panelCtx, {mode: 'full'}) + '\n\n';

	// 4. Force-transition continue: must still carry full status panel (R1/F1).
	if (forceTransitioned) {
		const msg =
			fullPanel() +
			`[OMS:STAGE TRANSITION] done → executing — you can now edit files to fix the build errors.\n\n` +
			(buildErrorPrefix || '');
		process.stderr.write(msg);
		process.exit(2);
	}

	// ── Iteration caps (anti-forge/staleness/soft-max patch, plan US-002) ──
	const maxIter = state.maxIterations ?? 50;
	const hardMax = state.hardMaxIterations ?? 200;

	// Hard stop: end the conversation. Do NOT set stage=done or clear state.
	if (state.turnCount > hardMax) {
		process.stderr.write(buildHardStopReport(panelCtx));
		process.exit(0);
	}

	// Soft cap: extend +10 and keep rolling. NOT a stop; quota renew only.
	let extendedNote = '';
	if (state.turnCount > maxIter) {
		const oldMax = maxIter;
		const step = 10;
		state.maxIterations = maxIter + step;
		saveState(state);
		// Refresh panelCtx turns after soft extend (state already mutated).
		extendedNote =
			buildSoftExtendBanner({
				oldSoft: oldMax,
				newSoft: state.maxIterations,
				turnCount: state.turnCount,
				hardMax,
				delta: step,
			}) + '\n';
	}

	// Get git diff
	const fullDiff = getGitDiffStat();

	// Check for text bypass
	const bypassDetected = checkTextBypass(state, fullDiff);

	// Build continuation prompt
	let prompt = buildContinuationPrompt(state, fullDiff, prd);

	if (!prompt) {
		// Continue with build error only — still attach full status panel.
		if (buildErrorPrefix) {
			process.stderr.write(fullPanel() + (extendedNote || '') + buildErrorPrefix);
			process.exit(2);
		}
		process.exit(0);
	}

	// Order (KTD7): [STATUS full] → optional soft banner → instructions
	const statusBlock = fullPanel();

	if (bypassDetected && prompt) {
		prompt =
			`⚠️ WARNING: No file changes detected via git diff, but you may have claimed to have changes.\n` +
			`Please use filesystem-* tools (filesystem-edit, filesystem-create, filesystem-replaceedit) to actually modify files.\n\n` +
			prompt;
	}

	if (buildErrorPrefix) {
		prompt = buildErrorPrefix + prompt;
	}

	prompt = statusBlock + (extendedNote || '') + prompt;
	process.stderr.write(prompt);
	process.exit(2);
}

function truncForPanel(s, n) {
	const t = String(s || '').replace(/\s+/g, ' ').trim();
	if (t.length <= n) return t;
	return t.slice(0, n - 1) + '…';
}

main().catch((error) => {
	appendErrorLog(`onStop error: ${error.message}`);
	process.exit(0); // fail-open
});
