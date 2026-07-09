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
import {formatGatesPreviewLine} from './gates.js';

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

/** Defaults match createState */
export const DEFAULT_SOFT = 50;
export const DEFAULT_HARD = 200;

export type ResumePathPlan =
	| {path: 'A'; reason: string}
	| {path: 'B'; reason: string}
	| {path: 'conflict'; reason: string}
	| {path: 'none'; reason: string};

/**
 * Decide which confirm path would run (must stay in sync with oms-resume).
 * Path A only when live is active and either no handoff or same sessionId.
 */
export function planResumePath(
	handoff: HandoffPayload | null,
	liveState: OmsState | null,
): ResumePathPlan {
	const liveActive =
		!!liveState &&
		(liveState.stage as string) !== 'done' &&
		(liveState.stage as string) !== 'idle';
	if (!handoff && !liveActive) {
		return {path: 'none', reason: 'no handoff.json and no active session'};
	}
	if (liveActive && liveState) {
		if (handoff && handoff.sessionId && liveState.sessionId && handoff.sessionId !== liveState.sessionId) {
			return {
				path: 'conflict',
				reason:
					`handoff session ${handoff.sessionId} ≠ live session ${liveState.sessionId} — ` +
					`refusing Path A. Stop the live session (oms-stop keeps handoff) then confirm to restore handoff (Path B), ` +
					`or remove handoff.json if you only want the live session.`,
			};
		}
		return {
			path: 'A',
			reason: handoff
				? 'same-session (or undated) handoff + active live — reactivate live, reset turns'
				: 'active live, no handoff — reactivate live, reset turns',
		};
	}
	if (handoff) {
		return {path: 'B', reason: 'no active live session — rebuild from handoff.json'};
	}
	return {path: 'none', reason: 'nothing to resume'};
}

export function formatHandoffPreview(
	handoff: HandoffPayload | null,
	liveState: OmsState | null,
	stale: StaleResult,
): string {
	const plan = planResumePath(handoff, liveState);
	const source = handoff
		? 'handoff.json'
		: liveState
			? 'live state (no handoff file)'
			: 'none';
	// Preview content for the snapshot confirm will apply:
	// Path A / conflict-with-live: prefer live for goal/stage/tasks when same session;
	// Path B: handoff only.
	const useHandoffFields = plan.path === 'B' || (plan.path === 'A' && !liveState);
	const goal = useHandoffFields
		? (handoff?.goal ?? liveState?.goal ?? '(none)')
		: (liveState?.goal ?? handoff?.goal ?? '(none)');
	const stage = useHandoffFields
		? (handoff?.stage ?? liveState?.stage ?? '?')
		: (liveState?.stage ?? handoff?.stage ?? '?');
	const tasks = useHandoffFields
		? (handoff?.tasks ?? liveState?.tasks ?? [])
		: (liveState?.tasks ?? handoff?.tasks ?? []);
	const open = tasks.filter(t => t && !t.completed);
	const gatesRequired = handoff
		? handoff.gatesRequired
		: liveState?.gatesRequired === true;
	const lgf = handoff?.lastGateFailure ?? liveState?.lastGateFailure;
	const turnCur = useHandoffFields
		? (handoff?.turnCount ?? liveState?.turnCount ?? 0)
		: (liveState?.turnCount ?? handoff?.turnCount ?? 0);
	const turnSoft = useHandoffFields
		? (handoff?.maxIterations ?? liveState?.maxIterations ?? DEFAULT_SOFT)
		: (liveState?.maxIterations ?? handoff?.maxIterations ?? DEFAULT_SOFT);
	const turnHard = useHandoffFields
		? (handoff?.hardMaxIterations ?? liveState?.hardMaxIterations ?? DEFAULT_HARD)
		: (liveState?.hardMaxIterations ?? handoff?.hardMaxIterations ?? DEFAULT_HARD);
	const ledgerForGates =
		plan.path === 'B'
			? handoff?.ledger
			: plan.path === 'A' && handoff?.sessionId && liveState?.sessionId === handoff.sessionId
				? handoff?.ledger
				: handoff?.ledger ?? undefined;
	const gatesLine = formatGatesPreviewLine(gatesRequired, ledgerForGates ?? null);
	const prdSummary = handoff?.prdSummary ?? null;
	const verifyNote = handoff?.verifyNote ?? null;

	const lines = [
		'[OMS:RESUME PREVIEW] Handoff is NOT a time machine — only progress + gates, not chat history.',
		`Source: ${source}`,
		`Confirm path: ${plan.path} — ${plan.reason}`,
		handoff && liveState
			? `Sessions: handoff=${handoff.sessionId || '?'} live=${liveState.sessionId || '?'}`
			: handoff
				? `Handoff session: ${handoff.sessionId || '?'}`
				: liveState
					? `Live session: ${liveState.sessionId || '?'}`
					: '',
		`Goal: ${String(goal).slice(0, 200)}`,
		`Stage: ${stage}`,
		`Turns at snapshot: ${turnCur} / soft ${turnSoft} / hard ${turnHard}`,
		`Tasks: ${tasks.filter(t => t?.completed).length}/${tasks.length} complete; open: ${open.length}`,
		...open.slice(0, 12).map(t => `  - [${t.id}] ${t.description}`),
		open.length > 12 ? `  … +${open.length - 12} more` : '',
		`GatesRequired: ${gatesRequired}`,
		gatesLine,
		lgf
			? `LastGateFailure: ${lgf.scope} — ${String(lgf.summary || '').slice(0, 120)}`
			: 'LastGateFailure: none',
		prdSummary
			? `PRD: ${String(prdSummary).slice(0, 160)}`
			: 'PRD: unknown / none in handoff',
		verifyNote
			? `Verify: ${String(verifyNote).slice(0, 160)}`
			: 'Verify: unknown / none in handoff',
		handoff
			? `Handoff created: ${handoff.createdAt} reason=${handoff.reason}`
			: 'Handoff file: absent',
		stale.status === 'stale'
			? `⚠ STALE: working tree changed since handoff (${stale.reason}). Resume still allowed.`
			: stale.status === 'unknown'
				? `Stale check: unknown (${stale.reason})`
				: 'Stale check: fresh (or no detectable change)',
		'',
		plan.path === 'conflict'
			? 'CONFIRM BLOCKED until session conflict is resolved (see Confirm path above).'
			: 'To continue: call oms-resume action:"confirm" ONLY after explicit user approval in this conversation (no silent auto-confirm).',
		'Confirm will reset turnCount to 0 and soft/hard to session defaults (50/200).',
		'Confirm refreshes approved gate timestamps so overnight resume does not drop R3 credit via TTL.',
		'Successful confirm consumes handoff.json (deletes it).',
	].filter(Boolean);

	return lines.join('\n');
}
