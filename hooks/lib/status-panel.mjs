/**
 * Shared OMS status panel for onStop (full) and onUserMessage (compact).
 * Formatters are pure; loadLedgerSummary does filesystem IO only.
 */

import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const MAX_GOAL_LEN = 120;
const MAX_OPEN_TASKS = 8;
const MAX_FAIL_LEN = 160;
/** Match src/state/gates.ts VERIFICATION_TTL_MS — keep in sync. */
export const LEDGER_TTL_MS = 2 * 60 * 60 * 1000;
const GATE_SCOPES = ['task-complete', 'task-reconcile', 'code-quality', 'completion'];

/**
 * Load ledger for panel display.
 * - Missing file → empty entries (same as MCP: no approvals yet)
 * - Parse/IO failure → loadError so UI can say unavailable
 * @returns {{ entries: Record<string, unknown>, loadError?: boolean, missingFile?: boolean }}
 */
export function loadLedgerSummary(dir) {
	try {
		const p = join(dir, 'verification-ledger.json');
		if (!existsSync(p)) {
			return {entries: {}, missingFile: true};
		}
		const raw = JSON.parse(readFileSync(p, 'utf-8'));
		if (!raw || typeof raw !== 'object') {
			return {entries: {}, loadError: true};
		}
		return {
			entries:
				raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
		};
	} catch {
		return {entries: {}, loadError: true};
	}
}

/**
 * Mirror gates.ts isEntryExpired: approved only if within TTL.
 */
export function isLedgerApprovalValid(entry, nowMs = Date.now()) {
	if (!entry || entry.status !== 'approved') return false;
	const t = entry.requestedAt
		? new Date(entry.requestedAt).getTime()
		: entry.resolvedAt
			? new Date(entry.resolvedAt).getTime()
			: 0;
	if (!t || Number.isNaN(t)) return false;
	return nowMs - t <= LEDGER_TTL_MS;
}

function trunc(s, n) {
	const t = String(s ?? '');
	if (t.length <= n) return t;
	return t.slice(0, n - 1) + '…';
}

function taskStats(state) {
	const tasks = Array.isArray(state.tasks) ? state.tasks : [];
	const completed = tasks.filter((t) => t && t.completed);
	const open = tasks.filter((t) => t && !t.completed);
	return {tasks, completed, open, done: completed.length, total: tasks.length};
}

/**
 * Gate line from gatesRequired + ledger entries (TTL-aware).
 * @returns {{ line: string, missing: string[], passed: string[] }}
 */
export function formatGatesLine(state, ledger, nowMs = Date.now()) {
	if (!state.gatesRequired) {
		return {
			line: 'Gates: off (legacy / gatesRequired=false)',
			missing: [],
			passed: [],
		};
	}
	// Missing ledger file = empty (not system failure). loadError = true unavailable.
	if (ledger && ledger.loadError) {
		return {
			line: 'Gates: required — ledger unavailable (read/parse error)',
			missing: GATE_SCOPES.slice(),
			passed: [],
		};
	}
	const entries = ledger?.entries && typeof ledger.entries === 'object'
		? ledger.entries
		: {};
	const passed = [];
	const missing = [];
	const expired = [];
	for (const s of GATE_SCOPES) {
		const e = entries[s];
		if (isLedgerApprovalValid(e, nowMs)) {
			passed.push(s);
		} else if (e && e.status === 'approved') {
			// Was approved but TTL elapsed — treat as not valid
			expired.push(s);
			missing.push(s);
		} else {
			missing.push(s);
		}
	}
	if (missing.length === 0) {
		return {
			line: `Gates: required — all approved (${passed.join(', ')})`,
			missing: [],
			passed,
		};
	}
	const expNote =
		expired.length > 0 ? ` expired=[${expired.join(', ')}]` : '';
	return {
		line: `Gates: required — ok=[${passed.join(', ') || 'none'}] missing=[${missing.join(', ')}]${expNote}`,
		missing,
		passed,
	};
}

function formatLastGateFailure(state) {
	const f = state.lastGateFailure;
	if (!f || typeof f !== 'object') return 'LastGateFailure: none';
	const scope = f.scope || '?';
	const summary = trunc(f.summary || '', MAX_FAIL_LEN);
	return `LastGateFailure: ${scope} — ${summary || '(no summary)'}`;
}

function formatTurns(state) {
	const cur = state.turnCount ?? 0;
	const soft = state.maxIterations ?? 50;
	const hard = state.hardMaxIterations ?? 200;
	return {cur, soft, hard, line: `Turns: ${cur} / soft ${soft} / hard ${hard}`};
}

function formatOpenTaskLines(open, indent = '  ') {
	if (open.length === 0) return `${indent}(none)`;
	const shown = open.slice(0, MAX_OPEN_TASKS);
	const lines = shown.map(
		(t) =>
			`${indent}- ${t.id || '?'}: ${trunc(t.description || '', 80)}`,
	);
	if (open.length > MAX_OPEN_TASKS) {
		lines.push(`${indent}(+${open.length - MAX_OPEN_TASKS} more)`);
	}
	return lines.join('\n');
}

/**
 * @param {object} ctx
 * @param {{ mode: 'full'|'compact', softExtend?: { oldSoft: number, newSoft: number }|null, nowMs?: number }} opts
 */
export function buildStatusPanel(ctx, opts = {}) {
	const mode = opts.mode === 'compact' ? 'compact' : 'full';
	const state = ctx.state || {};
	const ledger = ctx.ledger ?? {entries: {}};
	const prd = ctx.prd ?? null;
	const verifyNote = ctx.verifyNote ?? null;
	const softExtend = opts.softExtend ?? null;
	const nowMs = opts.nowMs ?? Date.now();

	const {done, total, open} = taskStats(state);
	const turns = formatTurns(state);
	const gates = formatGatesLine(state, ledger, nowMs);
	const lgf = formatLastGateFailure(state);
	const goal = trunc(state.goal || '(no goal)', mode === 'compact' ? 80 : MAX_GOAL_LEN);

	if (mode === 'compact') {
		const lines = [
			'[OMS:STATUS compact]',
			`Stage: ${state.stage || '?'}`,
			turns.line,
			`Tasks: ${done}/${total}`,
			gates.line,
			lgf,
			`Goal: ${goal}`,
		];
		return lines.join('\n');
	}

	const openIds = open
		.slice(0, MAX_OPEN_TASKS)
		.map((t) => t.id || '?')
		.join(', ');
	const more = open.length > MAX_OPEN_TASKS ? ` (+${open.length - MAX_OPEN_TASKS} more)` : '';
	const openLine =
		total === 0
			? 'OpenTasks: (none listed)'
			: open.length === 0
				? 'OpenTasks: (all completed)'
				: `OpenTasks: ${openIds}${more}`;

	const lines = [
		'[OMS:STATUS]',
		`Goal: ${goal}`,
		`Stage: ${state.stage || '?'}`,
		`Tasks: ${done}/${total}`,
		openLine,
		turns.line,
		`GatesRequired: ${state.gatesRequired ? 'true' : 'false'}`,
		gates.line,
		lgf,
	];

	if (state.teamName) {
		lines.push(`Team: ${state.teamName}`);
	}
	// Soft-extend detail lives in [OMS:EXTENDED] banner; avoid duplicate SoftExtend line.
	if (verifyNote) {
		lines.push(`Verify: ${trunc(verifyNote, 200)}`);
	}
	if (prd && Array.isArray(prd.stories) && prd.stories.length > 0) {
		const passed = prd.stories.filter((s) => s && s.passes).length;
		lines.push(`PRD: ${passed}/${prd.stories.length} stories pass`);
	}

	return lines.join('\n');
}

/**
 * Soft-cap quota renew banner (not completion).
 * @param {{ oldSoft: number, newSoft: number, turnCount: number, hardMax: number, delta?: number }} p
 */
export function buildSoftExtendBanner({oldSoft, newSoft, turnCount, hardMax, delta}) {
	const step = delta != null ? delta : (newSoft ?? 0) - (oldSoft ?? 0);
	const remaining = Math.max(0, (hardMax ?? 200) - (turnCount ?? 0));
	return (
		`[OMS:EXTENDED] Soft-cap quota renew (not task completion).\n` +
		`  Soft cap: ${oldSoft} → ${newSoft} (+${step}). Turns now: ${turnCount}. Hard cap: ${hardMax}. ` +
		`~${remaining} turns until hard stop.\n` +
		`  Multiple renewals allowed until hard cap.\n`
	);
}

/**
 * Hard-stop full checkup. Does not claim done.
 */
export function buildHardStopReport(ctx, opts = {}) {
	const state = ctx.state || {};
	const ledger = ctx.ledger ?? {entries: {}};
	const prd = ctx.prd ?? null;
	const verifyNote = ctx.verifyNote;
	const nowMs = opts.nowMs ?? Date.now();
	const hard = state.hardMaxIterations ?? 200;
	const {done, total, open} = taskStats(state);
	const gates = formatGatesLine(state, ledger, nowMs);
	const lgf = formatLastGateFailure(state);
	const turns = formatTurns(state);

	const openList = formatOpenTaskLines(open, '  ');

	const verifyLine =
		verifyNote != null && String(verifyNote).trim()
			? `Verify: ${trunc(verifyNote, 200)}`
			: 'Verify: unknown / unavailable';

	let prdLine = 'PRD: none / unavailable';
	if (prd && Array.isArray(prd.stories)) {
		if (prd.stories.length === 0) prdLine = 'PRD: scaffold (0 stories)';
		else {
			const passed = prd.stories.filter((s) => s && s.passes).length;
			prdLine = `PRD: ${passed}/${prd.stories.length} stories pass`;
		}
	}

	return (
		`[OMS:HARD STOP] Hit hard iteration ceiling (${hard}). Forced stop — NOT a successful done.\n` +
		`Session state is kept for inspection (not auto-cleared).\n\n` +
		`--- Checkup ---\n` +
		`Goal: ${trunc(state.goal || '(no goal)', MAX_GOAL_LEN)}\n` +
		`Stage: ${state.stage || '?'} (must not treat as successful done)\n` +
		`${turns.line}\n` +
		`Tasks: ${done}/${total}\n` +
		`Incomplete tasks:\n${openList}\n` +
		`${gates.line}\n` +
		`${lgf}\n` +
		`${verifyLine}\n` +
		`${prdLine}\n\n` +
		`Suggested next:\n` +
		`  - oms-get-state  (inspect)\n` +
		`  - oms-stop       (cleanup)\n` +
		`  - /oms:goal …   (fresh session if still needed)\n`
	);
}
