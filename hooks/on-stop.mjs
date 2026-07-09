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
import { buildContinuationPrompt } from './lib/continuation-prompt.mjs';
import { writeHandoffFromState } from './lib/handoff.mjs';

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
		let handoffLine = 'unavailable';
		try {
			// R2: capture PRD/verify points when available (else null → preview says unknown)
			let prdSummary = null;
			if (prd && typeof prd === 'object') {
				const stories = Array.isArray(prd.stories) ? prd.stories : [];
				const passed = stories.filter((s) => s && s.passes === true).length;
				prdSummary =
					stories.length > 0
						? `PRD stories ${passed}/${stories.length} pass`
						: typeof prd.title === 'string'
							? `PRD: ${prd.title.slice(0, 80)}`
							: 'PRD present (no stories)';
			}
			const verifyNote = buildErrorPrefix
				? String(buildErrorPrefix).slice(0, 180)
				: null;
			const hw = writeHandoffFromState(state, {
				reason: 'hard_ceiling',
				prdSummary,
				verifyNote,
			});
			handoffLine = hw.ok
				? `written (${hw.path})`
				: `unavailable (${hw.error || 'write failed'})`;
		} catch (e) {
			handoffLine = `unavailable (${e instanceof Error ? e.message : String(e)})`;
		}
		process.stderr.write(
			buildHardStopReport(panelCtx, {handoffLine}),
		);
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
	// withStatusPanel: STATUS already carries goal/tasks/turns — slim actions only.
	let prompt = buildContinuationPrompt(state, fullDiff, prd, {
		withStatusPanel: true,
	});

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
