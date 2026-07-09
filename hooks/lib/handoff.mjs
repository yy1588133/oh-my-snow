/**
 * Hard-stop handoff writer for hooks (mirrors src/state/handoff.ts contract).
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
import {getStateDir} from './oms-state.mjs';

export const HANDOFF_FILENAME = 'handoff.json';
export const HANDOFF_VERSION = 1;

export function getHandoffPath() {
	return join(getStateDir(), HANDOFF_FILENAME);
}

function atomicWrite(filePath, content) {
	const dir = join(filePath, '..');
	mkdirSync(dir, {recursive: true});
	const tmp = `${filePath}.tmp.${process.pid}`;
	writeFileSync(tmp, content, 'utf-8');
	try {
		renameSync(tmp, filePath);
	} catch {
		try {
			if (existsSync(filePath)) unlinkSync(filePath);
		} catch {}
		writeFileSync(filePath, content, 'utf-8');
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

function runGit(args) {
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

export function computeGitAnchor(nowIso) {
	const head = runGit(['rev-parse', 'HEAD']);
	const porcelain = runGit(['status', '--porcelain']);
	let porcelainFingerprint = null;
	if (porcelain !== null) {
		const lines = porcelain
			.split(/\r?\n/)
			.map((l) => l.trimEnd())
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

export function loadLedgerSafe() {
	const p = join(getStateDir(), 'verification-ledger.json');
	if (!existsSync(p)) return {version: 1, entries: {}};
	try {
		const raw = JSON.parse(readFileSync(p, 'utf-8'));
		if (!raw || typeof raw !== 'object') return {version: 1, entries: {}};
		if (!raw.entries || typeof raw.entries !== 'object') raw.entries = {};
		raw.version = 1;
		return raw;
	} catch {
		return {version: 1, entries: {}};
	}
}

export function buildHandoffPayload(state, ledger, opts = {}) {
	const now = opts.nowIso ?? new Date().toISOString();
	return {
		version: HANDOFF_VERSION,
		createdAt: now,
		reason: opts.reason ?? 'hard_ceiling',
		sessionId: state.sessionId || '',
		goal: state.goal || '',
		stage: state.stage || 'executing',
		tasks: Array.isArray(state.tasks) ? JSON.parse(JSON.stringify(state.tasks)) : [],
		turnCount: state.turnCount ?? 0,
		maxIterations: state.maxIterations ?? 50,
		hardMaxIterations: state.hardMaxIterations ?? 200,
		gatesRequired: state.gatesRequired === true,
		lastGateFailure: state.lastGateFailure ?? null,
		teamName: state.teamName,
		verifyCommand: state.verifyCommand,
		ledger: ledger
			? JSON.parse(JSON.stringify(ledger))
			: {version: 1, entries: {}},
		prdSummary: opts.prdSummary ?? null,
		verifyNote: opts.verifyNote ?? null,
		gitAnchor: opts.gitAnchor ?? computeGitAnchor(now),
	};
}

export function writeHandoffFromState(state, opts = {}) {
	try {
		const ledger = opts.ledger ?? loadLedgerSafe();
		const payload = buildHandoffPayload(state, ledger, opts);
		const path = getHandoffPath();
		atomicWrite(path, JSON.stringify(payload, null, 2));
		return {ok: true, path};
	} catch (e) {
		return {ok: false, error: e instanceof Error ? e.message : String(e)};
	}
}
