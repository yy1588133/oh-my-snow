/**
 * Hard-stop handoff pack — survives oms-stop cleanup of state/ledger.
 * Path: .snow/oms-state/handoff.json
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
	renameSync,
} from 'fs';
import {join} from 'path';
import {createHash} from 'crypto';
import {execFileSync} from 'child_process';
import type {OmsState, Task} from './store.js';
import type {VerificationLedger} from './gates.js';

export const HANDOFF_VERSION = 1 as const;
export const HANDOFF_FILENAME = 'handoff.json';

export type GitAnchor = {
	head: string | null;
	porcelainFingerprint: string | null;
	capturedAt: string;
};

export type HandoffPayload = {
	version: typeof HANDOFF_VERSION;
	createdAt: string;
	reason: 'hard_ceiling';
	sessionId: string;
	goal: string;
	stage: string;
	tasks: Task[];
	turnCount: number;
	maxIterations: number;
	hardMaxIterations: number;
	gatesRequired: boolean;
	lastGateFailure: OmsState['lastGateFailure'];
	teamName?: string;
	verifyCommand?: string;
	ledger: VerificationLedger;
	prdSummary: string | null;
	verifyNote: string | null;
	gitAnchor: GitAnchor;
};

export type StaleResult =
	| {status: 'fresh'}
	| {status: 'stale'; reason: string}
	| {status: 'unknown'; reason: string};

function getStateDir(): string {
	const envDir = process.env.OMS_STATE_DIR;
	if (envDir) return envDir;
	return join(process.cwd(), '.snow', 'oms-state');
}

export function getHandoffPath(): string {
	return join(getStateDir(), HANDOFF_FILENAME);
}

function atomicWrite(filePath: string, content: string): void {
	const dir = join(filePath, '..');
	mkdirSync(dir, {recursive: true});
	const tmp = `${filePath}.tmp.${process.pid}`;
	writeFileSync(tmp, content, 'utf-8');
	try {
		renameSync(tmp, filePath);
	} catch {
		// Windows fallback
		try {
			if (existsSync(filePath)) unlinkSync(filePath);
		} catch {
			/* ignore */
		}
		writeFileSync(filePath, content, 'utf-8');
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
}

function runGit(args: string[]): string | null {
	try {
		return execFileSync('git', args, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

export function computeGitAnchor(nowIso?: string): GitAnchor {
	const head = runGit(['rev-parse', 'HEAD']);
	const porcelain = runGit(['status', '--porcelain']);
	let porcelainFingerprint: string | null = null;
	if (porcelain !== null) {
		const lines = porcelain
			.split(/\r?\n/)
			.map(l => l.trimEnd())
			.filter(Boolean)
			.sort();
		porcelainFingerprint = createHash('sha256')
			.update(lines.join('\n'))
			.digest('hex')
			.slice(0, 16);
	}
	return {
		head: head || null,
		porcelainFingerprint,
		capturedAt: nowIso ?? new Date().toISOString(),
	};
}

export function detectStale(anchor: GitAnchor | null | undefined): StaleResult {
	if (!anchor) {
		return {status: 'unknown', reason: 'no git anchor on handoff'};
	}
	if (anchor.head == null && anchor.porcelainFingerprint == null) {
		return {status: 'unknown', reason: 'git unavailable at handoff time'};
	}
	const now = computeGitAnchor();
	if (now.head == null && now.porcelainFingerprint == null) {
		return {status: 'unknown', reason: 'git unavailable now'};
	}
	if (anchor.head && now.head && anchor.head !== now.head) {
		return {status: 'stale', reason: `HEAD moved ${anchor.head.slice(0, 7)} → ${now.head.slice(0, 7)}`};
	}
	if (
		anchor.porcelainFingerprint != null &&
		now.porcelainFingerprint != null &&
		anchor.porcelainFingerprint !== now.porcelainFingerprint
	) {
		return {status: 'stale', reason: 'working tree status changed since handoff'};
	}
	return {status: 'fresh'};
}

export function buildHandoffPayload(
	state: OmsState,
	ledger: VerificationLedger,
	opts?: {
		reason?: 'hard_ceiling';
		prdSummary?: string | null;
		verifyNote?: string | null;
		gitAnchor?: GitAnchor;
		nowIso?: string;
	},
): HandoffPayload {
	const now = opts?.nowIso ?? new Date().toISOString();
	return {
		version: HANDOFF_VERSION,
		createdAt: now,
		reason: opts?.reason ?? 'hard_ceiling',
		sessionId: state.sessionId,
		goal: state.goal ?? '',
		stage: state.stage,
		tasks: Array.isArray(state.tasks) ? structuredClone(state.tasks) : [],
		turnCount: state.turnCount ?? 0,
		maxIterations: state.maxIterations ?? 50,
		hardMaxIterations: state.hardMaxIterations ?? 200,
		gatesRequired: state.gatesRequired === true,
		lastGateFailure: state.lastGateFailure ?? null,
		teamName: state.teamName,
		verifyCommand: state.verifyCommand,
		ledger: ledger
			? structuredClone(ledger)
			: {version: 1, entries: {}},
		prdSummary: opts?.prdSummary ?? null,
		verifyNote: opts?.verifyNote ?? null,
		gitAnchor: opts?.gitAnchor ?? computeGitAnchor(now),
	};
}

export function writeHandoff(payload: HandoffPayload): {ok: true; path: string} | {ok: false; error: string} {
	try {
		const path = getHandoffPath();
		atomicWrite(path, JSON.stringify(payload, null, 2));
		return {ok: true, path};
	} catch (e) {
		return {ok: false, error: e instanceof Error ? e.message : String(e)};
	}
}

export function readHandoff(): HandoffPayload | null {
	const path = getHandoffPath();
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, 'utf-8')) as HandoffPayload;
		if (!raw || typeof raw !== 'object') return null;
		if (raw.version !== HANDOFF_VERSION) return null;
		if (!Array.isArray(raw.tasks)) raw.tasks = [];
		if (!raw.ledger || typeof raw.ledger !== 'object') {
			raw.ledger = {version: 1, entries: {}};
		}
		return raw;
	} catch {
		return null;
	}
}

export function deleteHandoff(): void {
	const path = getHandoffPath();
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			/* ignore */
		}
	}
}

export function formatHandoffPreview(
	handoff: HandoffPayload | null,
	liveState: OmsState | null,
	stale: StaleResult,
): string {
	const source = handoff
		? 'handoff.json'
		: liveState
			? 'live state (no handoff file)'
			: 'none';
	const goal = handoff?.goal ?? liveState?.goal ?? '(none)';
	const stage = handoff?.stage ?? liveState?.stage ?? '?';
	const tasks = handoff?.tasks ?? liveState?.tasks ?? [];
	const open = tasks.filter(t => t && !t.completed);
	const gatesRequired = handoff
		? handoff.gatesRequired
		: liveState?.gatesRequired === true;
	const lgf = handoff?.lastGateFailure ?? liveState?.lastGateFailure;

	const lines = [
		'[OMS:RESUME PREVIEW] Handoff is NOT a time machine — only progress + gates, not chat history.',
		`Source: ${source}`,
		`Goal: ${String(goal).slice(0, 200)}`,
		`Stage: ${stage}`,
		`Tasks: ${tasks.filter(t => t?.completed).length}/${tasks.length} complete; open: ${open.length}`,
		...open.slice(0, 12).map(t => `  - [${t.id}] ${t.description}`),
		open.length > 12 ? `  … +${open.length - 12} more` : '',
		`GatesRequired: ${gatesRequired}`,
		lgf
			? `LastGateFailure: ${lgf.scope} — ${String(lgf.summary || '').slice(0, 120)}`
			: 'LastGateFailure: none',
		handoff
			? `Handoff created: ${handoff.createdAt} reason=${handoff.reason}`
			: 'Handoff file: absent',
		stale.status === 'stale'
			? `⚠ STALE: working tree changed since handoff (${stale.reason}). Resume still allowed.`
			: stale.status === 'unknown'
				? `Stale check: unknown (${stale.reason})`
				: 'Stale check: fresh (or no detectable change)',
		'',
		'To continue: call oms-resume action:"confirm" after user approval.',
		'This will reset turnCount to 0 and soft/hard to session defaults (50/200).',
	].filter(Boolean);

	return lines.join('\n');
}

/** Defaults match createState */
export const DEFAULT_SOFT = 50;
export const DEFAULT_HARD = 200;
