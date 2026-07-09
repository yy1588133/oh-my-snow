/**
 * Completion / stage gate ledger (completion-gates plan U1–U4).
 *
 * Multi-scope approvals live in verification-ledger.json so approving one
 * scope cannot wipe another. Legacy verification-state.json still holds the
 * single pending token for request/submit flows.
 */

import {
	existsSync,
	readFileSync,
	unlinkSync,
} from 'fs';
import {join} from 'path';
import {randomUUID} from 'crypto';

// ── Types ──

export type GateScope =
	| 'story'
	| 'completion'
	| 'task-complete'
	| 'task-reconcile'
	| 'code-quality';

export const GATE_SCOPES: GateScope[] = [
	'story',
	'completion',
	'task-complete',
	'task-reconcile',
	'code-quality',
];

export interface GateScorecard {
	pass: boolean;
	summary: string;
	evidence: string[];
	taskIds?: string[];
	deferred?: {id: string; reason: string}[];
	diffStat?: string;
	testExitCode?: number;
	degraded?: boolean;
	noTasksReason?: string;
}

export interface LedgerEntry {
	scope: GateScope;
	storyId: string | null;
	status: 'approved';
	requestId: string;
	scorecard: GateScorecard | null;
	reviewerAgentId: string | null;
	reviewerFeedback: string | null;
	resolvedAt: string;
	requestedAt: string;
}

export interface VerificationLedger {
	version: 1;
	entries: Record<string, LedgerEntry>;
}

export interface LastGateFailure {
	scope: string;
	summary: string;
	reasons: string[];
	at: string;
}

const VERIFICATION_TTL_MS = 2 * 60 * 60 * 1000;
const SELF_REVIEWER_IDS = new Set([
	'',
	'main',
	'executor',
	'primary',
	'self',
	'agent',
	'oms',
	'lead',
]);

const STRICT_SCOPES: GateScope[] = ['completion', 'code-quality'];

// Injected by store.ts to avoid circular path helpers
let _getStateDir: () => string = () =>
	join(process.cwd(), '.snow', 'oms-state');
let _atomicWrite: (path: string, content: string) => void = () => {
	throw new Error('gates not initialized');
};
let _cleanupTmp: (path: string) => void = () => {};

export function initGatesRuntime(opts: {
	getStateDir: () => string;
	atomicWriteFile: (path: string, content: string) => void;
	cleanupTmpFiles: (path: string) => void;
}): void {
	_getStateDir = opts.getStateDir;
	_atomicWrite = opts.atomicWriteFile;
	_cleanupTmp = opts.cleanupTmpFiles;
}

function ledgerPath(): string {
	return join(_getStateDir(), 'verification-ledger.json');
}

export function ledgerKey(scope: GateScope, storyId: string | null): string {
	if (scope === 'story') {
		return `story:${storyId ?? 'unknown'}`;
	}
	return scope;
}

export function loadLedger(): VerificationLedger {
	const filePath = ledgerPath();
	if (!existsSync(filePath)) {
		return {version: 1, entries: {}};
	}
	try {
		const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as VerificationLedger;
		if (!raw || typeof raw !== 'object') {
			return {version: 1, entries: {}};
		}
		if (!raw.entries || typeof raw.entries !== 'object') {
			raw.entries = {};
		}
		raw.version = 1;
		return raw;
	} catch {
		return {version: 1, entries: {}};
	}
}

export function saveLedger(ledger: VerificationLedger): void {
	_atomicWrite(ledgerPath(), JSON.stringify(ledger, null, 2));
}

export function deleteLedger(): void {
	const filePath = ledgerPath();
	if (existsSync(filePath)) {
		try {
			unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}
	_cleanupTmp(filePath);
}

function isEntryExpired(entry: LedgerEntry): boolean {
	const t = entry.requestedAt
		? new Date(entry.requestedAt).getTime()
		: entry.resolvedAt
			? new Date(entry.resolvedAt).getTime()
			: 0;
	if (t === 0) return true;
	return Date.now() - t > VERIFICATION_TTL_MS;
}

/**
 * Re-stamp approved ledger entries so a handoff restore does not silently
 * lose R3 gate progress solely due to VERIFICATION_TTL_MS (2h).
 * Used only on intentional resume — not on ordinary load.
 */
export function refreshLedgerForResume(
	ledger: VerificationLedger | null | undefined,
	nowIso?: string,
): VerificationLedger {
	const now = nowIso ?? new Date().toISOString();
	const src = ledger?.entries && typeof ledger.entries === 'object' ? ledger.entries : {};
	const entries: Record<string, LedgerEntry> = {};
	for (const [key, entry] of Object.entries(src)) {
		if (!entry || typeof entry !== 'object') continue;
		if (entry.status !== 'approved') {
			entries[key] = structuredClone(entry);
			continue;
		}
		entries[key] = {
			...structuredClone(entry),
			requestedAt: now,
			resolvedAt: now,
		};
	}
	return {version: 1, entries};
}

/** Preview/UI line: which gate scopes are valid vs missing (TTL-aware). */
export function formatGatesPreviewLine(
	gatesRequired: boolean,
	ledger: VerificationLedger | null | undefined,
	nowMs: number = Date.now(),
): string {
	if (!gatesRequired) {
		return 'Gates: off / not applicable (gatesRequired=false)';
	}
	const entries = ledger?.entries && typeof ledger.entries === 'object' ? ledger.entries : {};
	const passed: string[] = [];
	const missing: string[] = [];
	const expired: string[] = [];
	// Align with hard-stop panel order (task gates first, then quality/completion).
	const order: GateScope[] = [
		'task-complete',
		'task-reconcile',
		'code-quality',
		'completion',
	];
	for (const scope of order) {
		const e = entries[scope];
		if (!e || e.status !== 'approved') {
			missing.push(scope);
			continue;
		}
		const t = e.requestedAt
			? new Date(e.requestedAt).getTime()
			: e.resolvedAt
				? new Date(e.resolvedAt).getTime()
				: 0;
		const fresh = t > 0 && nowMs - t <= VERIFICATION_TTL_MS;
		if (fresh) {
			passed.push(scope);
		} else {
			expired.push(scope);
			missing.push(scope);
		}
	}
	if (missing.length === 0) {
		return `Gates: required — all approved (${passed.join(', ')})`;
	}
	const expNote = expired.length > 0 ? ` expired=[${expired.join(', ')}]` : '';
	return `Gates: required — ok=[${passed.join(', ') || 'none'}] missing=[${missing.join(', ')}]${expNote}`;
}

export function getLedgerApproval(
	scope: GateScope,
	storyId: string | null = null,
): LedgerEntry | null {
	const ledger = loadLedger();
	const key = ledgerKey(scope, storyId);
	const entry = ledger.entries[key];
	if (!entry || entry.status !== 'approved') return null;
	if (scope === 'story' && entry.storyId !== storyId) return null;
	if (isEntryExpired(entry)) return null;
	return entry;
}

export function recordLedgerApproval(opts: {
	scope: GateScope;
	storyId: string | null;
	requestId: string;
	scorecard: GateScorecard | null;
	reviewerAgentId: string | null;
	reviewerFeedback: string | null;
	requestedAt: string;
}): LedgerEntry {
	const now = new Date().toISOString();
	const entry: LedgerEntry = {
		scope: opts.scope,
		storyId: opts.storyId,
		status: 'approved',
		requestId: opts.requestId,
		scorecard: opts.scorecard,
		reviewerAgentId: opts.reviewerAgentId,
		reviewerFeedback: opts.reviewerFeedback,
		resolvedAt: now,
		requestedAt: opts.requestedAt || now,
	};
	const ledger = loadLedger();
	ledger.entries[ledgerKey(opts.scope, opts.storyId)] = entry;
	saveLedger(ledger);
	return entry;
}

export function clearLedgerApproval(
	scope: GateScope,
	storyId: string | null = null,
): void {
	const ledger = loadLedger();
	const key = ledgerKey(scope, storyId);
	if (ledger.entries[key]) {
		delete ledger.entries[key];
		saveLedger(ledger);
	}
}

/** Invalidate completion + code-quality after forced done→executing. */
export function invalidatePostDoneGates(): void {
	const ledger = loadLedger();
	delete ledger.entries['completion'];
	delete ledger.entries['code-quality'];
	saveLedger(ledger);
}

export function isSelfReviewerId(id: string): boolean {
	const n = (id || '').trim().toLowerCase();
	if (SELF_REVIEWER_IDS.has(n)) return true;
	// Bounded prefixes only — bare startsWith('main') misclassifies
	// "maintainability" / "mainline" as self (negative-optimization fix).
	if (n.startsWith('main-') || n.startsWith('executor-')) return true;
	if (n.startsWith('main_') || n.startsWith('executor_')) return true;
	return false;
}

export function isAllowlistedStrictReviewer(id: string): boolean {
	const n = (id || '').trim().toLowerCase();
	if (!n || isSelfReviewerId(n)) return false;
	// Exact / bounded suffix allowlist only. No bare team: wildcard (would
	// allow team:executor self-sign). No substring includes().
	const prefixes = [
		'oms_critic',
		'oms_reviewer',
		'oms_architect',
		'#oms_critic',
		'#oms_reviewer',
		'#oms_architect',
	];
	return prefixes.some(
		p => n === p || n.startsWith(p + '-') || n.startsWith(p + '_'),
	);
}

export function requiresStrictReviewer(scope: GateScope): boolean {
	return STRICT_SCOPES.includes(scope);
}

export function parseScorecard(raw: unknown): GateScorecard {
	if (raw == null) {
		throw new Error('scorecard is required');
	}
	let obj: Record<string, unknown>;
	if (typeof raw === 'string') {
		try {
			obj = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			throw new Error('scorecard must be valid JSON');
		}
	} else if (typeof raw === 'object') {
		obj = raw as Record<string, unknown>;
	} else {
		throw new Error('scorecard must be an object or JSON string');
	}
	if (typeof obj.pass !== 'boolean') {
		throw new Error('scorecard.pass must be boolean');
	}
	if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
		throw new Error('scorecard.summary must be a non-empty string');
	}
	if (!Array.isArray(obj.evidence)) {
		throw new Error('scorecard.evidence must be an array');
	}
	const evidence = obj.evidence.map(String).map(s => s.trim()).filter(Boolean);
	const card: GateScorecard = {
		pass: obj.pass,
		summary: String(obj.summary).trim(),
		evidence,
	};
	if (Array.isArray(obj.taskIds)) {
		card.taskIds = obj.taskIds.map(String);
	}
	if (Array.isArray(obj.deferred)) {
		card.deferred = (obj.deferred as {id: string; reason: string}[]).map(d => ({
			id: String(d.id),
			reason: String(d.reason || ''),
		}));
	}
	if (obj.diffStat != null) card.diffStat = String(obj.diffStat);
	if (typeof obj.testExitCode === 'number') card.testExitCode = obj.testExitCode;
	if (typeof obj.degraded === 'boolean') card.degraded = obj.degraded;
	if (obj.noTasksReason != null) card.noTasksReason = String(obj.noTasksReason);
	return card;
}

export function assertApprovingScorecard(
	card: GateScorecard,
	scope: GateScope,
): void {
	if (!card.pass) {
		throw new Error(
			'Cannot approve with scorecard.pass=false — use verdict rejected instead',
		);
	}
	if (!card.summary.trim()) {
		throw new Error('scorecard.summary is required for approval');
	}
	if (scope === 'code-quality') {
		// Hard field only — evidence keywords like "npm test" are not sufficient.
		const ds = (card.diffStat || '').trim();
		if (!ds) {
			throw new Error(
				'code-quality scorecard requires non-empty diffStat (evidence keywords alone are not enough)',
			);
		}
		if (card.evidence.length === 0) {
			throw new Error(
				'code-quality scorecard.evidence must be a non-empty array',
			);
		}
		return;
	}
	const hasEvidence =
		card.evidence.length > 0 ||
		(card.diffStat != null && card.diffStat.trim().length > 0);
	if (!hasEvidence) {
		throw new Error(
			'scorecard.evidence (or diffStat) must be non-empty for approval',
		);
	}
}

export interface TaskLike {
	id: string;
	description: string;
	completed: boolean;
}

export function validateTaskCompleteScorecard(
	card: GateScorecard,
	tasks: TaskLike[],
	hasPrdAllPass: boolean,
): string[] {
	const reasons: string[] = [];
	if (tasks.length === 0 && !hasPrdAllPass) {
		if (!card.noTasksReason || !card.noTasksReason.trim()) {
			reasons.push(
				'tasks is empty and no PRD stories passed — provide noTasksReason or add tasks',
			);
		}
	}
	const incomplete = tasks.filter(t => !t.completed);
	const deferred = card.deferred ?? [];
	const deferredIds = new Set(deferred.map(d => d.id));
	for (const t of incomplete) {
		const d = deferred.find(x => x.id === t.id);
		if (!d || !d.reason.trim()) {
			reasons.push(`incomplete task ${t.id} missing deferred reason`);
		}
	}
	if (
		tasks.length > 0 &&
		incomplete.length === tasks.length &&
		!card.noTasksReason?.trim()
	) {
		// 100% deferred without goal-level declaration
		const allHaveReasons = incomplete.every(t =>
			deferredIds.has(t.id) &&
			(deferred.find(d => d.id === t.id)?.reason || '').trim(),
		);
		if (allHaveReasons && !card.noTasksReason?.trim()) {
			reasons.push(
				'all tasks deferred — set scorecard.noTasksReason explaining why none were implemented',
			);
		}
	}
	// Forbid empty reasons in deferred list
	for (const d of deferred) {
		if (!d.reason.trim()) {
			reasons.push(`deferred entry ${d.id} has empty reason`);
		}
	}
	return reasons;
}

/** Direct self-gate approval (task-complete / task-reconcile) without external critic. */
export function approveSelfGate(opts: {
	scope: 'task-complete' | 'task-reconcile';
	scorecard: GateScorecard;
	reviewerAgentId?: string;
}): LedgerEntry {
	assertApprovingScorecard(opts.scorecard, opts.scope);
	const now = new Date().toISOString();
	return recordLedgerApproval({
		scope: opts.scope,
		storyId: null,
		requestId: randomUUID(),
		scorecard: opts.scorecard,
		reviewerAgentId: opts.reviewerAgentId ?? 'executor',
		reviewerFeedback: opts.scorecard.summary,
		requestedAt: now,
	});
}

export function formatLedgerSummary(): string {
	const ledger = loadLedger();
	const keys = Object.keys(ledger.entries);
	if (keys.length === 0) return '(no ledger approvals)';
	return keys
		.map(k => {
			const e = ledger.entries[k];
			return `  [${e.status}] ${k} reviewer=${e.reviewerAgentId ?? '-'} at ${e.resolvedAt}`;
		})
		.join('\n');
}

export function canEnterVerifying(opts: {
	tasks: TaskLike[];
	hasPrd: boolean;
	allPrdStoriesPass: boolean;
}): {ok: boolean; reason: string} {
	const taskOk = getLedgerApproval('task-complete') != null;
	const prdOk = opts.hasPrd && opts.allPrdStoriesPass;
	if (opts.tasks.length > 0 && opts.hasPrd) {
		if (taskOk && prdOk) return {ok: true, reason: ''};
		const missing: string[] = [];
		if (!taskOk) missing.push('task-complete gate');
		if (!prdOk) missing.push('all PRD stories passes:true');
		return {
			ok: false,
			reason: `Cannot enter verifying — need both: ${missing.join(' AND ')}`,
		};
	}
	if (opts.tasks.length > 0) {
		if (taskOk) return {ok: true, reason: ''};
		return {
			ok: false,
			reason:
				'Cannot enter verifying — submit task-complete scorecard first:\n' +
				'  oms-prd action:"submit-gate" scope:"task-complete" scorecard:\'{"pass":true,"summary":"...","evidence":["..."]}\'',
		};
	}
	if (opts.hasPrd) {
		if (prdOk) return {ok: true, reason: ''};
		return {
			ok: false,
			reason:
				'Cannot enter verifying — all PRD stories must have passes:true (or submit task-complete if using tasks)',
		};
	}
	// No tasks and no PRD: require task-complete with noTasksReason
	if (taskOk) return {ok: true, reason: ''};
	return {
		ok: false,
		reason:
			'Cannot enter verifying — no tasks and no PRD. Submit task-complete with noTasksReason, or add tasks/PRD first.',
	};
}

/**
 * Resolve approval from an already-loaded ledger (single-read helper).
 * Mirrors getLedgerApproval TTL/status rules without re-reading disk.
 */
function approvalFromLedger(
	ledger: VerificationLedger,
	scope: GateScope,
	storyId: string | null = null,
): LedgerEntry | null {
	const key = ledgerKey(scope, storyId);
	const entry = ledger.entries[key];
	if (!entry || entry.status !== 'approved') return null;
	if (scope === 'story' && entry.storyId !== storyId) return null;
	if (isEntryExpired(entry)) return null;
	return entry;
}

function formatLedgerSummaryFrom(ledger: VerificationLedger): string {
	const keys = Object.keys(ledger.entries);
	if (keys.length === 0) return '(no ledger approvals)';
	return keys
		.map(k => {
			const e = ledger.entries[k];
			return `  [${e.status}] ${k} reviewer=${e.reviewerAgentId ?? '-'} at ${e.resolvedAt}`;
		})
		.join('\n');
}

export function canEnterDone(gatesRequired: boolean): {
	ok: boolean;
	reason: string;
} {
	if (!gatesRequired) {
		// Legacy path handled by caller via hasMatchingApproval completion only
		return {ok: true, reason: ''};
	}
	// One disk read for all three scopes + failure summary (perf fix).
	const ledger = loadLedger();
	const missing: string[] = [];
	const bad: string[] = [];
	for (const scope of ['task-reconcile', 'code-quality', 'completion'] as GateScope[]) {
		const e = approvalFromLedger(ledger, scope);
		if (!e) {
			missing.push(scope);
			continue;
		}
		// Strict gates must carry a real scorecard (blocks scorecard:null rubber stamps).
		if (
			(scope === 'code-quality' || scope === 'completion') &&
			(!e.scorecard || e.scorecard.pass !== true)
		) {
			bad.push(`${scope} (missing valid scorecard)`);
		}
	}
	if (missing.length === 0 && bad.length === 0) return {ok: true, reason: ''};
	const parts = [
		missing.length ? `missing approved gates: ${missing.join(', ')}` : '',
		bad.length ? `invalid: ${bad.join(', ')}` : '',
	]
		.filter(Boolean)
		.join('; ');
	return {
		ok: false,
		reason:
			`Cannot transition to done — ${parts}\n` +
			`Order: task-reconcile → code-quality → completion (independent critic), then oms-set-stage done.\n` +
			`Ledger:\n${formatLedgerSummaryFrom(ledger)}`,
	};
}

/** Scopes that must use submit-gate, not request-verification. */
export function isSelfOnlyGateScope(scope: string): boolean {
	return scope === 'task-complete' || scope === 'task-reconcile';
}
