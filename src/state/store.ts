/**
 * OMS State Manager
 *
 * Manages orchestration state via a JSON file on disk.
 * The state file is located at `${process.cwd()}/.snow/oms-state/state.json`,
 * isolating sessions per project.
 *
 * Both the MCP server and the Hook scripts read/write this same file.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	unlinkSync,
	renameSync,
	openSync,
	closeSync,
	statSync,
	readdirSync,
} from 'fs';
import {join, dirname, basename} from 'path';

// ── Types ──

export type Stage = 'planning' | 'executing' | 'verifying' | 'done';

export interface Task {
	id: string;
	description: string;
	completed: boolean;
}

export interface LogEntry {
	timestamp: string;
	stage: Stage;
	message: string;
}

export interface Snapshot {
	key: string;
	data: unknown;
	createdAt: string;
}

export interface OmsState {
	/** Session id (timestamp-based) */
	sessionId: string;
	/** Current stage in the state machine */
	stage: Stage;
	/** The high-level goal the AI is working towards */
	goal: string;
	/** Command used to verify changes (build/test), empty string = auto-detect */
	verifyCommand: string;
	/** Tasks planned during the planning stage */
	tasks: Task[];
	/** Turn counter — incremented by onStop each AI turn */
	turnCount: number;
	/** Timestamps for each stage transition */
	stageHistory: {stage: Stage; timestamp: string}[];
	/** Verification results log */
	logs: LogEntry[];
	/** Snapshots for cross-session state recovery */
	snapshots: Snapshot[];
	/** When the session was created */
	createdAt: string;
	/** When the session was last updated */
	updatedAt: string;
	/**
	 * Team name reference (optional).
	 * Only set when running in /oms:team multi-agent mode — references the
	 * snow-cli TeamConfig name. OMS does NOT mirror snow-cli's team state;
	 * this is a single reference field so oms-get-state can surface team context.
	 */
	teamName?: string;
}

// ── Constants ──

const VALID_TRANSITIONS: Record<Stage, Stage[]> = {
	planning: ['executing'],
	executing: ['verifying', 'planning'],
	// 无 fixing 中间态：verifying 失败直接回 executing（lead 自修或重新 spawn）
	verifying: ['done', 'executing'],
	done: [],
};

// ── Path resolution ──

function getStateDir(): string {
	// OMS_STATE_DIR env var is set by the MCP server config in settings.json
	// Hooks don't have this env var, so they use process.cwd() relative path
	const envDir = process.env.OMS_STATE_DIR;
	if (envDir) {
		return envDir;
	}
	return join(process.cwd(), '.snow', 'oms-state');
}

function getStateFilePath(): string {
	return join(getStateDir(), 'state.json');
}

function getVerifyCommandFilePath(): string {
	return join(getStateDir(), 'verify.cmd');
}

// ── State operations ──

export function ensureStateDir(): void {
	const dir = getStateDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
}

export function loadState(): OmsState | null {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, 'utf-8');
		const state = JSON.parse(content) as OmsState;
		// Migrate legacy 'idle' stage (v0.1.0) to 'planning' in-memory (lazy migration).
		// The migration is persisted by the next saveState call from any mutation.
		if ((state.stage as string) === 'idle') {
			state.stage = 'planning';
		}
		return state;
	} catch {
		return null;
	}
}

function syncSleep(ms: number): void {
	// Synchronous sleep used for lock-retry backoff. Atomics.wait parks the OS
	// thread (kernel-level, no CPU burn) when SharedArrayBuffer is available;
	// it does NOT yield the JS event loop. Falls back to a Date.now() spin.
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// Fallback: if Atomics.wait or SharedArrayBuffer is unavailable, use Date.now() spin
		const start = Date.now();
		while (Date.now() - start < ms) {
			// spin
		}
	}
}

/**
 * Shared atomic-write primitive: acquire a lock, write to tmp, rename, release lock.
 * Used by saveState (state.json), atomicWriteFile (prd.json), and setProjectTeamMode
 * (project settings.json) so a single bugfix here fixes all three call sites.
 *
 * Behavior on lock contention (after MAX_RETRIES):
 *   - onContention = 'skip'   → return false, no write (state.json — never corrupt)
 *   - onContention = 'force'  → tmp+rename anyway (prd.json — better to force the
 *                                update through than silently drop it during a Ralph
 *                                loop; tmp+rename keeps atomicity so no torn file)
 *
 * @returns true if the write succeeded (lock acquired + renamed, or forced write OK)
 */
function atomicWriteWithLock(
	filePath: string,
	content: string,
	onContention: 'skip' | 'force' = 'skip',
	dirOverride?: string,
): boolean {
	// Default to the OMS state dir; callers writing elsewhere (e.g. project
	// settings.json) pass dirOverride so we mkdir that instead.
	if (dirOverride) {
		mkdirSync(dirOverride, {recursive: true});
	} else {
		ensureStateDir();
	}
	const lockPath = filePath + '.lock';

	// Stale lock detection: force-remove locks older than STALE_LOCK_MS.
	// 120s is intentionally generous — saveState on a large state.json or
	// savePrd on a large prd.json + slow disk
	// can take seconds, and force-removing a still-live lock would break mutual
	// exclusion. Only locks held far past any legitimate write are reaped.
	const STALE_LOCK_MS = 120000;
	if (existsSync(lockPath)) {
		try {
			const lockStat = statSync(lockPath);
			if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
				unlinkSync(lockPath);
			}
		} catch {}
	}

	let lockCreated = false;
	const MAX_RETRIES = 5;
	const RETRY_DELAY_MS = 50;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const fd = openSync(lockPath, 'wx'); // atomic create — throws if exists
			closeSync(fd);
			lockCreated = true;
			break;
		} catch {
			if (attempt < MAX_RETRIES - 1) {
				syncSleep(RETRY_DELAY_MS);
			}
		}
	}

	if (!lockCreated) {
		if (onContention === 'force') {
			// Couldn't acquire the lock after retries, but prd.json MUST be written
			// (a Ralph loop dropping a story update loses progress). Write without
			// the lock — tmp+rename still keeps the FILE atomic (no torn read), we
			// just lose cross-process serialization for this one write. The lock
			// holder's write and this write race; last writer wins on rename, which
			// is acceptable for the PRD (the losing state is recoverable via
			// re-refine). This is strictly better than the old direct writeFileSync
			// which could leave a half-written file and make loadPrd return null.
			return tmpRenameWrite(filePath, content);
		}
		// onContention === 'skip': log and skip to avoid corrupting concurrent writes
		try {
			const logPath = join(getStateDir(), 'errors.log');
			const timestamp = new Date().toISOString();
			appendFileSync(
				logPath,
				`[${timestamp}] atomicWriteWithLock(${filePath}): lock contention after retries, skipping write\n`,
				'utf-8',
			);
		} catch {}
		return false;
	}

	try {
		// Single shared write path — same tmp+rename as the force fallback, so a
		// bug in the rename/cross-device handling only needs fixing in ONE place.
		return tmpRenameWrite(filePath, content);
	} finally {
		// Only delete the lock if THIS process created it.
		// Deleting another process's lock breaks the mutual exclusion guarantee.
		if (lockCreated) {
			try {
				unlinkSync(lockPath);
			} catch {}
		}
	}
}

/**
 * Write `content` to `filePath` atomically via tmp+rename.
 *
 * On a normal same-device rename this is fully atomic: a reader sees either the
 * old file or the new file, never a partial write. If rename throws (typically
 * EXDEV across filesystems), fall back to a direct writeFileSync — this loses
 * atomicity for that one write (a reader can briefly see a partial write), but
 * is better than dropping the update entirely. This is the ONLY non-atomic path
 * in the whole write stack, and it's reserved for the cross-device edge case.
 *
 * `.tmp` cleanup is best-effort: it runs on the rename-success path (rename
 * consumes the file) and in both error branches. If writeFileSync itself throws
 * (disk full), the outer atomicWriteWithLock catch / caller handles the throw
 * and deleteState()/deletePrd() sweep leftover .tmp files on the next cleanup.
 * Returns false on any unrecoverable write failure.
 */
function tmpRenameWrite(filePath: string, content: string): boolean {
	// PID-suffixed tmp path so two concurrent writers (locked holder + force
	// fallback) don't collide on the same `prd.json.tmp` — the lock only
	// serializes lock acquisition, not the tmp file itself. With per-pid names,
	// each process writes its own tmp; on a same-device rename the loser's rename
	// either wins (last writer) or throws (and the file is left for cleanup).
	// Note: this guarantees cross-PROCESS isolation (distinct PIDs → distinct
	// tmps). It does NOT protect against re-entrant writes within the same process,
	// but tmpRenameWrite is fully synchronous (writeFileSync + renameSync) so Node's
	// single-threaded execution makes same-process re-entry impossible.
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tmpPath, content, 'utf-8');
	} catch {
		// Could not even finish writing the tmp file (disk full, permissions).
		// A partial .tmp may exist on disk — clean it up so it doesn't trip
		// the next call, matching the cleanup in the rename-failure branch below.
		try {
			unlinkSync(tmpPath);
		} catch {}
		return false;
	}
	try {
		renameSync(tmpPath, filePath);
		return true;
	} catch {
		// Cross-device fallback: direct write as last resort. Not atomic, but
		// preserves the data — the only non-atomic path in the whole write stack.
		try {
			writeFileSync(filePath, content, 'utf-8');
		} catch {
			// Both rename and direct write failed — make sure we don't leave a
			// stale .tmp behind for the next call to trip over.
			try {
				unlinkSync(tmpPath);
			} catch {}
			return false;
		}
		// Direct write succeeded; clean up the now-orphaned tmp.
		try {
			unlinkSync(tmpPath);
		} catch {}
		return true;
	}
}

/**
 * Atomic write: write to temp file first, then rename.
 * This prevents corrupted state if the process is interrupted mid-write.
 */
export function saveState(state: OmsState): void {
	atomicWriteWithLock(getStateFilePath(), JSON.stringify(state, null, 2), 'skip');
}

/**
 * Sweep leftover lock + tmp files for a base path (e.g. state.json / prd.json).
 * Shared by deleteState and deletePrd so the cleanup rule lives in ONE place.
 *
 * Matches exactly two filename shapes — anchored to the PID-suffixed tmp format
 * (tmpRenameWrite writes `<base>.<pid>.tmp`), NOT a loose `*.tmp` glob, so a
 * user's intentional `prd.json.backup.tmp` or `state.json.export.tmp` is NOT
 * swept up:
 *   - `<base>.lock`        — the lock file atomicWriteWithLock acquires
 *   - `<base>.<digits>.tmp` — a PID-suffixed tmp from a crashed/timed-out write
 *
 * `<digits>` is matched via regex (PID is a positive integer on every platform).
 */
function cleanupTmpFiles(filePath: string): void {
	const dir = dirname(filePath);
	const base = basename(filePath);
	const tmpRe = new RegExp(`^${escapeRegex(base)}\\.(\\d+)\\.tmp$`);
	try {
		for (const name of readdirSync(dir)) {
			if (name === `${base}.lock` || tmpRe.test(name)) {
				try {
					unlinkSync(join(dir, name));
				} catch {}
			}
		}
	} catch {}
}

/**
 * Escape a literal string for use inside a RegExp (so dots/etc. in a filename
 * are treated as literals, not metacharacters). Mirrors MDN's recommended escape.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deleteState(): void {
	const filePath = getStateFilePath();
	if (existsSync(filePath)) {
		unlinkSync(filePath);
	}
	// Also clean up verify.cmd if present
	const verifyPath = getVerifyCommandFilePath();
	if (existsSync(verifyPath)) {
		unlinkSync(verifyPath);
	}
	// Clean up pending-verify marker (may be left over from abnormal termination)
	const markerPath = join(getStateDir(), '.pending-verify');
	if (existsSync(markerPath)) {
		try {
			unlinkSync(markerPath);
		} catch {}
	}
	// Clean up lock + PID-suffixed tmp files from saveState.
	cleanupTmpFiles(filePath);
}

// ── State mutations ──

export function createState(goal: string, verifyCommand: string): OmsState {
	const now = new Date().toISOString();
	const state: OmsState = {
		sessionId: `oms_${Date.now()}`,
		stage: 'planning',
		goal,
		verifyCommand,
		tasks: [],
		turnCount: 0,
		stageHistory: [{stage: 'planning', timestamp: now}],
		logs: [],
		snapshots: [],
		createdAt: now,
		updatedAt: now,
	};
	saveState(state);
	return state;
}

export function setStage(state: OmsState, newStage: Stage): OmsState {
	const current = state.stage;
	const allowed = VALID_TRANSITIONS[current] ?? [];
	if (!allowed.includes(newStage)) {
		throw new Error(
			`Invalid stage transition: ${current} → ${newStage}. Valid transitions from "${current}": [${allowed.join(
				', ',
			)}]`,
		);
	}
	state.stage = newStage;
	state.stageHistory.push({
		stage: newStage,
		timestamp: new Date().toISOString(),
	});
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

export function addTask(state: OmsState, description: string): OmsState {
	const task: Task = {
		id: `task_${state.tasks.length + 1}`,
		description,
		completed: false,
	};
	state.tasks.push(task);
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

export function completeTask(state: OmsState, taskId: string): OmsState {
	const task = state.tasks.find(t => t.id === taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}
	task.completed = true;
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

/**
 * Set the team name reference on the state.
 * Used by /oms:team to record which snow-cli team this session orchestrates.
 * OMS only stores the name — the authoritative team state lives in snow-cli
 * (~/.snow/teams/<team>/config.json).
 *
 * Also activates snow-cli's built-in Team Mode by writing `teamMode: true` to
 * the PROJECT-LEVEL `.snow/settings.json`. This is the critical activation link
 * that was missing: snow-cli's mcpToolsManager.ts includes teamMode in configHash
 * (mcpToolsManager.ts:206), so writing it invalidates the tool cache and rebuilds
 * the AI's tool list on the next turn — mounting the `team-*` tools (mcpToolsManager.ts:411
 * prefixes them with `team-`).
 *
 * Why this lives in the MCP tool (not the command prompt or the AI itself):
 *   - The /oms:team command runs in the PLANNING stage, where beforeToolCall
 *     hard-blocks filesystem-edit. So the AI cannot edit settings.json itself
 *     (it would be blocked by its own stage discipline).
 *   - By doing the write inside the oms-set-team MCP tool, the activation is
 *     performed by the server process, sidestepping the hook entirely.
 *
 * snow-cli's getTeamMode (projectSettings.ts:168) reads project scope first,
 * then falls back to global — so writing project scope is sufficient.
 *
 * Uses the same atomic write pattern as saveState (lock + tmp + rename) to
 * avoid corrupting the user's settings.json under concurrent access.
 *
 * @returns true if the file was actually changed (teamMode was not already true),
 *          false if teamMode was already true (no write needed).
 * @throws on unrecoverable I/O errors (lock contention after retries is NOT
 *         thrown — it returns false to avoid blocking the tool call).
 */
export function setProjectTeamMode(enabled: boolean): boolean {
	const settingsPath = join(process.cwd(), '.snow', 'settings.json');

	// Read existing settings (empty object if missing/corrupt — preserves other fields)
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
		} catch {
			// Corrupt settings.json — start fresh but warn via stderr (server context)
			settings = {};
		}
	}

	// Idempotent: skip the write if already in the desired state
	if (settings.teamMode === enabled) {
		return false;
	}

	settings.teamMode = enabled;

	// Atomic write via the shared lock+tmp+rename primitive (skip on contention —
	// the AI can retry oms-set-team; never corrupt settings.json with a torn write).
	const content = JSON.stringify(settings, null, 2);
	const wrote = atomicWriteWithLock(
		settingsPath,
		content,
		'skip',
		dirname(settingsPath),
	);
	if (!wrote) {
		console.error('[OMS] setProjectTeamMode: lock contention, skipping write');
		return false;
	}

	return true;
}

/**
 * Set the team name reference on the state AND activate snow-cli Team Mode.
 * Used by /oms:team to record which snow-cli team this session orchestrates
 * and to flip teamMode=true so team-* tools become visible on the next turn.
 */
export function setTeamName(state: OmsState, teamName: string): OmsState {
	state.teamName = teamName;
	state.updatedAt = new Date().toISOString();
	saveState(state);

	// Activate snow-cli Team Mode (writes project-level .snow/settings.json).
	// This is what actually mounts the team-* tools for the lead on the next turn.
	try {
		setProjectTeamMode(true);
	} catch (error) {
		// Don't fail the whole tool call if settings.json can't be updated —
		// the teamName is still recorded, and the command prompt instructs the
		// user to run /team manually as a fallback.
		console.error(`[OMS] setTeamName: failed to activate teamMode: ${(error as Error).message}`);
	}

	return state;
}

export function addLog(state: OmsState, message: string): OmsState {
	state.logs.push({
		timestamp: new Date().toISOString(),
		stage: state.stage,
		message,
	});
	// Keep only last 50 logs
	if (state.logs.length > 50) {
		state.logs = state.logs.slice(-50);
	}
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

// ── Snapshot operations ──

export function saveSnapshot(
	state: OmsState,
	key: string,
	data: unknown,
): OmsState {
	// Remove existing snapshot with same key
	state.snapshots = state.snapshots.filter(s => s.key !== key);
	state.snapshots.push({key, data, createdAt: new Date().toISOString()});
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

export function loadSnapshot(state: OmsState, key: string): Snapshot | null {
	return state.snapshots.find(s => s.key === key) ?? null;
}

export function listSnapshots(
	state: OmsState,
): {key: string; createdAt: string}[] {
	return state.snapshots.map(s => ({key: s.key, createdAt: s.createdAt}));
}

export function saveVerifyCommandFile(cmd: string): void {
	ensureStateDir();
	writeFileSync(getVerifyCommandFilePath(), cmd, 'utf-8');
}

// ── Ralph PRD management ──
//
// PRD (Product Requirements Document) drives the Ralph persistence loop.
// Each user story has testable acceptance criteria; Ralph iterates
// story-by-story until every story has `passes: true` and is reviewer-verified.
//
// Files (stored in the same .snow/oms-state/ directory as state.json):
//   - prd.json      : the PRD with stories and acceptance criteria
//   - progress.txt  : append-only log of learnings across iterations
//
// Uses the same atomic write pattern (lock + tmp + rename) as saveState to
// avoid corruption under concurrent access from MCP server and hooks.

export interface AcceptanceCriterion {
	/** The criterion text — must be concrete and testable */
	criterion: string;
	/** Whether this criterion has been verified with fresh evidence */
	verified: boolean;
}

export interface PrdStory {
	/** Story id, e.g. "US-001" */
	id: string;
	/** Short title of the story */
	title: string;
	/** Concrete, testable acceptance criteria */
	acceptanceCriteria: AcceptanceCriterion[];
	/** Whether ALL acceptance criteria are verified → story is complete */
	passes: boolean;
	/**
	 * Whether this story has been EXPLICITLY rejected by a reviewer via
	 * setPrdStoryPasses(id, false). When a reject happens, ALL criterion
	 * `verified` flags are also cleared (evidence invalidated), forcing the
	 * agent to re-verify each one with fresh evidence before mark-passes(true)
	 * can succeed. The `rejected` flag additionally blocks setCriterionVerified's
	 * auto-lift as a second defense-in-depth layer — an explicit mark-passes(true)
	 * is required to re-pass and clear the veto. Distinct from `passes: false` on
	 * a fresh story (rejected=false, auto-lift allowed on full verification).
	 */
	rejected: boolean;
	/** Priority (lower = higher priority, foundational work first) */
	priority: number;
	/** When the story was created */
	createdAt: string;
	/** When the story's passes flag was last updated */
	updatedAt: string;
}

export interface Prd {
	/** The original task description Ralph is working on */
	task: string;
	/** Whether the PRD has been refined (scaffold replaced with task-specific stories) */
	refined: boolean;
	/** The user stories */
	stories: PrdStory[];
	/** When the PRD was created */
	createdAt: string;
	/** When the PRD was last updated */
	updatedAt: string;
}

function getPrdFilePath(): string {
	return join(getStateDir(), 'prd.json');
}

function getProgressFilePath(): string {
	return join(getStateDir(), 'progress.txt');
}

/**
 * Atomic write for prd.json — thin wrapper over atomicWriteWithLock.
 * Uses 'force' contention policy: during a Ralph loop it's better to fall back
 * to a direct write than to silently drop a story update.
 */
function atomicWriteFile(filePath: string, content: string): void {
	atomicWriteWithLock(filePath, content, 'force');
}

/** Load the PRD. Returns null if no PRD file exists. */
export function loadPrd(): Prd | null {
	const filePath = getPrdFilePath();
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as Prd;
	} catch {
		return null;
	}
}

function savePrd(prd: Prd): void {
	prd.updatedAt = new Date().toISOString();
	atomicWriteFile(getPrdFilePath(), JSON.stringify(prd, null, 2));
}

/**
 * Create a scaffold PRD from a task description.
 * The scaffold has a single generic story — the caller MUST refine it
 * with task-specific acceptance criteria via refinePrd().
 *
 * Concurrency-safe init: uses the lock with 'skip' contention policy, NOT the
 * 'force' policy that savePrd/refinePrd use. Two MCP sessions calling initPrd
 * simultaneously race on lock acquisition; the loser SKIPS its scaffold write
 * (rather than force-overwriting the winner's file) and re-reads to return the
 * winner's PRD. This is the key difference from savePrd — init is "create if
 * absent", and a force write here would clobber a PRD the winner already
 * refined in the gap between our loadPrd() check and the write.
 *
 * The TOCTOU window between loadPrd() and the locked write is closed by the
 * lock itself: the loser's 'skip' means it writes nothing, then re-reads the
 * file the winner wrote under the lock. loadPrd() before the write is just an
 * optimization to skip building the scaffold when a PRD already exists.
 *
 * On losing the lock race with no PRD on disk, init returns the in-memory
 * scaffold WITHOUT force-writing it — force-writing could clobber a PRD the
 * winner already refined in the gap or resurrect a state the user cleared via
 * oms-stop. Persistence is deferred to the caller's next mutation (refinePrd).
 *
 * @returns an object with the PRD (always present, possibly in-memory only) and
 *          `wrote` — whether this call actually persisted the scaffold to disk.
 *          Callers that surface a "created" message to the agent should check
 *          `wrote` so they don't claim success for a race-lost in-memory scaffold.
 */
export function initPrd(task: string): {prd: Prd; wrote: boolean} {
	const existing = loadPrd();
	if (existing) {
		// PRD already on disk — not written by this call.
		return {prd: existing, wrote: false};
	}
	const now = new Date().toISOString();
	const prd: Prd = {
		task,
		refined: false,
		stories: [
			{
				id: 'US-001',
				title: 'Implement the task',
				acceptanceCriteria: [
					{
						criterion: 'Implementation is complete',
						verified: false,
					},
				],
				passes: false,
				rejected: false,
				priority: 1,
				createdAt: now,
				updatedAt: now,
			},
		],
		createdAt: now,
		updatedAt: now,
	};
	// 'skip' on contention: if another process is mid-write (or already wrote),
	// don't force-overwrite — re-read and return theirs. This is what makes
	// init idempotent under concurrent init rather than last-writer-wins.
	const wrote = atomicWriteWithLock(
		getPrdFilePath(),
		JSON.stringify(prd, null, 2),
		'skip',
	);
	if (!wrote) {
		// We lost the lock race — another session created the PRD. Return theirs
		// instead of clobbering it with our scaffold.
		const theirs = loadPrd();
		if (theirs) {
			return {prd: theirs, wrote: false};
		}
		// Lost the race AND no PRD on disk (winner wrote then deleted, or transient
		// lock failure). Do NOT force-write our scaffold here — that could clobber
		// a PRD the winner already refined in the gap, or resurrect a state the
		// user explicitly cleared via oms-stop. Return the in-memory scaffold so
		// the caller still has an object; if persistence is required, the caller's
		// next mutation (refinePrd) will write under the lock and reconcile.
		return {prd, wrote: false};
	}
	return {prd, wrote: true};
}

export interface RefinedStoryInput {
	title: string;
	acceptanceCriteria: string[]; // plain criterion texts — wrapped in AcceptanceCriterion
	priority: number;
}

/**
 * Validate a story's priority and acceptance criteria before persisting it.
 * Centralizes the rules so refinePrd and addPrdStory stay consistent (DRY):
 *   - priority must be a positive integer (>= 1)
 *   - acceptanceCriteria must be non-empty (Ralph verifies EACH criterion — an
 *     empty array would make mark-passes(true)'s `every(verified)` vacuously true
 *     and let an unverified story pass, violating the core invariant)
 * Throws on the first invalid story with a 1-based index for actionable diagnosis.
 */
function validateStoryInput(
	story: {title: string; acceptanceCriteria: string[]; priority: number},
	index: number,
): void {
	if (!Number.isInteger(story.priority) || story.priority < 1) {
		throw new Error(
			`Story ${index + 1} has invalid priority ${story.priority}: must be a positive integer (>= 1).`,
		);
	}
	if (story.acceptanceCriteria.length === 0) {
		throw new Error(
			`Story ${index + 1} has no acceptance criteria — at least one is required so Ralph can verify each before passing.`,
		);
	}
}

/**
 * Replace the scaffold stories with task-specific refined stories.
 * Sets refined: true so Ralph knows the PRD is ready for the loop.
 *
 * Also clears progress.txt: a refine is a (re)start of the PRD work, so any
 * stale progress log from a prior task on the same state dir must not survive.
 * Without this, logProgress entries from task A would linger under a header
 * still naming task A while the PRD now describes task B.
 *
 * WARNING: refine REPLACES the entire stories array — any stories added via
 * addPrdStory since the last init/refine are discarded (re-numbered to US-001..NNN
 * from the passed array). If you need to keep added stories, append them to the
 * stories array you pass to refine instead of relying on addPrdStory persistence.
 */
export function refinePrd(
	task: string,
	stories: RefinedStoryInput[],
): Prd {
	const existing = loadPrd();
	const taskToUse = task || existing?.task || '';
	const now = new Date().toISOString();

	// Validate BEFORE building any story objects — a bad priority or empty
	// criteria never reaches disk. Throws on the first invalid story.
	stories.forEach((s, i) => validateStoryInput(s, i));

	// validateStoryInput already enforced priority + non-empty criteria above,
	// so this map only constructs the stored object (no re-check needed here).
	const refinedStories: PrdStory[] = stories.map((s, i) => ({
		id: `US-${String(i + 1).padStart(3, '0')}`,
		title: s.title,
		acceptanceCriteria: s.acceptanceCriteria.map(criterion => ({
			criterion,
			verified: false,
		})),
		passes: false,
		rejected: false,
		priority: s.priority,
		createdAt: now,
		updatedAt: now,
	}));

	const prd: Prd = {
		task: taskToUse,
		refined: true,
		stories: refinedStories,
		createdAt: existing?.createdAt || now,
		updatedAt: now,
	};
	savePrd(prd);

	// Drop any stale progress.txt so the next initProgress() rewrites the header
	// with the (possibly new) task name and a clean slate.
	const progressPath = getProgressFilePath();
	if (existsSync(progressPath)) {
		try {
			unlinkSync(progressPath);
		} catch {}
	}

	return prd;
}

/**
 * Add a new story (discovered during implementation).
 * Returns the added story.
 *
 * Validates priority + non-empty criteria via the same validateStoryInput used by
 * refinePrd, so the store-layer invariant (positive integer priority, >= 1
 * criterion) holds for both entry points — the MCP layer's zod schema is the
 * first line of defense, this is the store-layer backstop for non-MCP callers.
 */
export function addPrdStory(
	title: string,
	acceptanceCriteria: string[],
	priority: number,
): PrdStory | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	// Validate BEFORE mutation — use the existing stories length as the 1-based
	// index in the error message so it matches the would-be story number.
	validateStoryInput({title, acceptanceCriteria, priority}, prd.stories.length);
	const now = new Date().toISOString();
	const nextId = `US-${String(prd.stories.length + 1).padStart(3, '0')}`;
	const story: PrdStory = {
		id: nextId,
		title,
		acceptanceCriteria: acceptanceCriteria.map(criterion => ({
			criterion,
			verified: false,
		})),
		passes: false,
		rejected: false,
		priority,
		createdAt: now,
		updatedAt: now,
	};
	prd.stories.push(story);
	savePrd(prd);
	return story;
}

/** Get the highest-priority story with passes: false. Returns null if all pass. */
export function getNextPrdStory(): PrdStory | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	const pending = prd.stories
		.filter(s => !s.passes)
		.sort((a, b) => a.priority - b.priority);
	return pending[0] ?? null;
}

/** Get a story by id. */
export function getPrdStory(storyId: string): PrdStory | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	return prd.stories.find(s => s.id === storyId) ?? null;
}

/**
 * Mark a story's passes flag, or unmark it (reviewer rejection / rework).
 *
 * NOTE: this ONLY flips `passes` plus the `rejected` veto flag. The
 * acceptanceCriteria[].verified flags are managed by setCriterionVerified()
 * with one exception (see mark-passes(false) below). Forcing verified=true here
 * would let an agent bypass per-criterion verification (the core Ralph
 * invariant). The only place `passes` is auto-derived is setCriterionVerified
 * (passes = allCriteriaVerified on a non-rejected story).
 *
 * The guard is intentionally asymmetric — only passes:true is gated on every()
 * being verified:
 *   - mark-passes(true)  on an unverified story → REFUSED (null). Forces evidence.
 *   - mark-passes(true)  on a fully-verified story → OK (idempotent; also clears
 *     any prior `rejected` veto so the story is back to a clean pass state).
 *   - mark-passes(false) on any story → always OK (unmark needs no precondition;
 *     reviewer can reject at will). It CLEARS every criterion's `verified` flag
 *     AND sets `rejected=true`, so the agent must re-verify EACH criterion with
 *     fresh evidence before mark-passes(true) can succeed again. This is the
 *     veto: a reviewer's "打回" invalidates prior evidence, the agent cannot
 *     rubber-stamp the story back via a bare mark-passes(true).
 *
 * Why mark-passes(false) clears verified flags (design choice, was previously
 * "leave as-is"): keeping verified=true across a reject let an agent bypass the
 * veto — mark-passes(true)'s `every(verified)` guard would pass immediately
 * without any re-verification, making the reject a no-op. Clearing evidence on
 * reject forces a genuine rework cycle: reject → (criteria now unverified) →
 * re-verify each with fresh evidence → mark-passes(true) succeeds. The
 * `rejected` flag additionally blocks setCriterionVerified's auto-lift, so the
 * agent MUST end with an explicit mark-passes(true) rather than relying on the
 * "last criterion verified → passes auto-flips" convenience.
 */
export function setPrdStoryPasses(
	storyId: string,
	passes: boolean,
): PrdStory | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	const story = prd.stories.find(s => s.id === storyId);
	if (!story) {
		return null;
	}
	// Guard: refuse to mark passes:true unless every criterion is already verified.
	// This enforces the "verify EACH criterion before mark-passes" invariant at the
	// data layer — an agent can't skip per-criterion evidence and rubber-stamp a story.
	if (passes && !story.acceptanceCriteria.every(c => c.verified)) {
		return null;
	}
	story.passes = passes;
	if (passes) {
		// Re-passing clears any prior veto — the story is back to a clean pass.
		story.rejected = false;
	} else {
		// Reject / unmark: invalidate ALL prior evidence so mark-passes(true) can't
		// rubber-stamp the story back without re-verification. This is what makes a
		// reviewer's rejection a real veto rather than a no-op the agent can skip.
		// The `rejected` flag additionally blocks setCriterionVerified's auto-lift,
		// forcing an explicit mark-passes(true) to re-pass.
		for (const c of story.acceptanceCriteria) {
			c.verified = false;
		}
		story.rejected = true;
	}
	story.updatedAt = new Date().toISOString();
	savePrd(prd);
	return story;
}

/**
 * Mark a single acceptance criterion as verified/unverified.
 *
 * Passes derivation rule (asymmetric by design):
 *   - verify-criterion(idx, true)  → when the LAST criterion is verified AND the
 *     story has not been rejected (rejected flag is false), auto-lift passes=true.
 *     This is a convenience so a fresh refine + full verification passes without
 *     a separate mark-passes call.
 *   - verify-criterion(idx, false) → only clears that criterion's flag. It does
 *     NOT auto-drop passes — unmarking a story is the caller's explicit job via
 *     setPrdStoryPasses(id, false). This keeps responsibilities clean: this
 *     function owns criterion flags, setPrdStoryPasses owns the passes flag.
 *     Previously it set `passes = allVerified` on every call, which meant
 *     flipping one criterion to false silently unmarked the whole story.
 *
 * Interaction with reviewer rejection (veto semantics):
 *   setPrdStoryPasses(id, false) (reviewer reject) clears ALL verified flags AND
 *   sets rejected=true. So after a reject, the agent finds every criterion
 *   unverified and must re-verify each one with fresh evidence. The `!rejected`
 *   guard below is a SECOND layer of defense: even if some path left verified
 *   flags set after a reject, auto-lift would still be blocked until an explicit
 *   mark-passes(true) clears the veto. To permanently block a story, delete it
 *   or rewrite its criteria.
 */
export function setCriterionVerified(
	storyId: string,
	criterionIndex: number,
	verified: boolean,
): PrdStory | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	const story = prd.stories.find(s => s.id === storyId);
	if (!story) {
		return null;
	}
	const criterion = story.acceptanceCriteria[criterionIndex];
	if (!criterion) {
		return null;
	}
	criterion.verified = verified;
	story.updatedAt = new Date().toISOString();
	// Only lift passes when all criteria are verified AND the story hasn't been
	// explicitly rejected (rejected flag set by setPrdStoryPasses(id, false)).
	// After a reviewer rejects a story, re-verifying a criterion must NOT
	// auto-lift passes — the agent has to explicitly call mark-passes(true) to
	// re-pass, so a reviewer's rejection is a real veto rather than something a
	// noop re-verify overrides. A fresh `passes: false` story has rejected=false,
	// so it still auto-lifts on full verification (convenience for fresh refine).
	if (verified && !story.rejected && story.acceptanceCriteria.every(c => c.verified)) {
		story.passes = true;
	}
	savePrd(prd);
	return story;
}

/** Get PRD completion summary. */
export function getPrdStatus(): {
	task: string;
	refined: boolean;
	total: number;
	passed: number;
	remaining: number;
	stories: {id: string; title: string; passes: boolean; priority: number}[];
} | null {
	const prd = loadPrd();
	if (!prd) {
		return null;
	}
	const passed = prd.stories.filter(s => s.passes).length;
	return {
		task: prd.task,
		refined: prd.refined,
		total: prd.stories.length,
		passed,
		remaining: prd.stories.length - passed,
		// Sort a COPY — sorting prd.stories in place would mutate the loaded
		// object (a latent footgun if loadPrd ever caches/persists the reference).
		stories: [...prd.stories]
			.sort((a, b) => a.priority - b.priority)
			.map(s => ({
				id: s.id,
				title: s.title,
				passes: s.passes,
				priority: s.priority,
			})),
	};
}

/**
 * Initialize progress.txt. Returns true if created, false if already exists.
 *
 * If no PRD exists yet (agent called init-progress before init), the header is
 * written with a visible '(no PRD yet)' marker so the empty header is diagnosable
 * — the next refinePrd deletes this file and rebuilds it with the real task.
 *
 * NOTE: uses `??` (not `||`) so a PRD whose task is intentionally an empty
 * string stays accurate ('# Task: ' empty) rather than being misreported as
 * '(no PRD yet)'. The '(no PRD yet)' marker only fires when loadPrd() itself
 * returns null — the PRD is genuinely absent.
 */
export function initProgress(): boolean {
	const filePath = getProgressFilePath();
	if (existsSync(filePath)) {
		return false;
	}
	ensureStateDir();
	const prd = loadPrd();
	const task = prd ? (prd.task ?? '') : '(no PRD yet)';
	const header = `# Ralph Progress Log\n# Task: ${task}\n# Created: ${new Date().toISOString()}\n\n`;
	writeFileSync(filePath, header, 'utf-8');
	return true;
}

/**
 * Append a progress entry to progress.txt.
 * Self-healing: if the file doesn't exist yet (initProgress was skipped or the
 * process restarted), write the header first so logProgress never creates a
 * headerless file that would permanently confuse initProgress's existsSync check.
 *
 * The header write + entry append are not individually locked, but progress.txt
 * is an append-only log — concurrent logProgress calls only risk interleaved
 * entries, never a lost header (the self-heal writeFileSync is the first writer
 * wins; the loser's appendFileSync still lands its entry after).
 */
export function logProgress(message: string): void {
	const filePath = getProgressFilePath();
	ensureStateDir();
	const timestamp = new Date().toISOString();
	const entry = `[${timestamp}] ${message}\n`;
	try {
		if (!existsSync(filePath)) {
			const prd = loadPrd();
			const task = prd ? (prd.task ?? '') : '(no PRD yet)';
			const header = `# Ralph Progress Log\n# Task: ${task}\n# Created: ${timestamp}\n\n`;
			writeFileSync(filePath, header, 'utf-8');
		}
		appendFileSync(filePath, entry, 'utf-8');
	} catch (error) {
		// Logging must not crash the loop, but record WHY it failed so the agent
		// can diagnose (disk full, permissions, etc.) — a bare catch{} swallowed
		// every failure silently before.
		try {
			const logPath = join(getStateDir(), 'errors.log');
			appendFileSync(
				logPath,
				`[${timestamp}] logProgress failed: ${(error as Error).message}\n`,
				'utf-8',
			);
		} catch {
			// even errors.log is unwritable — nothing more we can do
		}
	}
}

/** Read progress.txt content. Returns empty string if not found. */
export function readProgress(): string {
	const filePath = getProgressFilePath();
	if (!existsSync(filePath)) {
		return '';
	}
	try {
		return readFileSync(filePath, 'utf-8');
	} catch {
		return '';
	}
}

/** Delete PRD files (called by oms-stop cleanup). */
export function deletePrd(): void {
	const prdPath = getPrdFilePath();
	if (existsSync(prdPath)) {
		try {
			unlinkSync(prdPath);
		} catch {}
	}
	const progressPath = getProgressFilePath();
	if (existsSync(progressPath)) {
		try {
			unlinkSync(progressPath);
		} catch {}
	}
	// Clean up lock + PID-suffixed tmp files from savePrd (shared helper so the
	// rule stays in sync with deleteState's cleanup).
	cleanupTmpFiles(prdPath);
}
