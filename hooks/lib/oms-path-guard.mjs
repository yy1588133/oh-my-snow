/**
 * OMS control-plane path / terminal write guards.
 * Pure helpers: only block writes under the real state directory.
 */

import {isAbsolute, normalize, resolve, sep} from 'path';

const WRITE_CMD_RE =
	/(>|>>|out-file|set-content|add-content|\btee\b|\bcopy\b|\bmove\b|\brm\b|\bdel\b|remove-item|unlink|rmdir|rd\b)/i;

/**
 * Normalize path for prefix comparison (Windows-safe).
 * @param {string} p
 * @returns {string}
 */
export function normalizePathKey(p) {
	let s = String(p || '').replace(/\\/g, '/');
	// Drop duplicate slashes except leading // for UNC
	s = s.replace(/([^:]\/)\/+/g, '$1');
	return s.toLowerCase();
}

/**
 * Resolve a tool path argument against cwd.
 * @param {string} p
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveCandidatePath(p, cwd = process.cwd()) {
	const raw = String(p || '').trim();
	if (!raw) return '';
	const base = cwd || process.cwd();
	const abs = isAbsolute(raw) ? normalize(raw) : resolve(base, raw);
	return abs;
}

/**
 * True if target is the state dir or a file under it.
 * @param {string} candidatePath - absolute or relative path from tool args
 * @param {string} stateDir - getStateDir()
 * @param {string} [cwd]
 */
export function isOmsStateWritePath(candidatePath, stateDir, cwd = process.cwd()) {
	if (!candidatePath || !stateDir) return false;
	const target = normalizePathKey(resolveCandidatePath(candidatePath, cwd));
	if (!target) return false;
	const root = normalizePathKey(resolve(stateDir));
	if (!root) return false;
	if (target === root) return true;
	const prefix = root.endsWith('/') ? root : root + '/';
	return target.startsWith(prefix);
}

/**
 * Detect terminal command that writes/deletes under state dir.
 * Read-only inspection of ledger paths is allowed.
 * @param {string} cmd
 * @param {string} stateDir
 * @param {string} [cwd]
 */
export function isOmsStateWriteCommand(cmd, stateDir, cwd = process.cwd()) {
	const raw = String(cmd || '').trim();
	if (!raw || !stateDir) return false;
	const lower = raw.toLowerCase();
	const rootKey = normalizePathKey(resolve(stateDir));
	const rootSlash = rootKey.endsWith('/') ? rootKey : rootKey + '/';

	// Fast reject: no mention of state area and no write ops — allow
	const mentionsState =
		lower.includes('.snow') ||
		lower.includes('oms-state') ||
		lower.includes('verification-ledger') ||
		lower.includes('verification-state') ||
		lower.includes(rootKey) ||
		// relative fragments
		lower.includes('oms-state\\') ||
		lower.includes('oms-state/');

	if (!mentionsState) return false;
	if (!WRITE_CMD_RE.test(raw)) return false;

	// Tokenize path-like fragments and see if any resolve under stateDir
	const pathLike =
		raw.match(
			/(?:["']?)((?:[A-Za-z]:)?[^\s"'|;<>]+(?:oms-state|verification-ledger|verification-state)[^\s"'|;<>]*)/gi,
		) || [];
	for (const m of pathLike) {
		const cleaned = m.replace(/^["']|["']$/g, '');
		if (isOmsStateWritePath(cleaned, stateDir, cwd)) return true;
	}

	// Redirect targets: > path or >> path
	const redir = [...raw.matchAll(/(?:>>|>)\s*([^\s|&;]+)/g)];
	for (const m of redir) {
		if (isOmsStateWritePath(m[1], stateDir, cwd)) return true;
	}

	// Fallback: write intent + command body contains normalized state root
	const bodyKey = normalizePathKey(raw);
	if (bodyKey.includes(rootSlash) || bodyKey.includes(rootKey)) return true;

	// Relative .snow/oms-state with write ops
	if (
		/(\.snow[\\/]+oms-state|oms-state[\\/]|(?:^|[\s"'])verification-ledger(?:\.json)?|(?:^|[\s"'])verification-state\.json)/i.test(
			raw,
		)
	) {
		return true;
	}

	return false;
}
