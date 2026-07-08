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
import {randomUUID} from 'crypto';

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
	/**
	 * Soft iteration cap — when turnCount exceeds this, onStop extends it by
	 * +10 and keeps the boulder rolling rather than stopping. Starts at 50.
	 * See on-stop.mjs MAX_TURNS replacement. Added in the anti-forge/staleness/
	 * soft-max patch (plan ralplan-oms-anti-forge-staleness-softmax.md).
	 */
	maxIterations: number;
	/**
	 * Hard iteration cap — the only true stop that ends the ralph loop
	 * (besides explicit oms-stop / oms-set-stage:done). When turnCount exceeds
	 * this, onStop force-stops. Defaults to 200 (aligned with omc strict mode).
	 * Set to 0 for unlimited (omc default behavior) — not recommended.
	 */
	hardMaxIterations: number;
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
	// OMS_STATE_DIR env var support is intentionally NOT used by the installer
	// (installer.ts setupMcpConfig omits it). Both the MCP server and hooks
	// fall back to process.cwd()/.snow/oms-state, which dynamically resolves
	// to the current project directory at runtime. The env var check is kept
	// for forward compatibility (e.g. custom deployments that override the path).
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
		// Backfill iteration caps for legacy state.json files created before the
		// anti-forge/staleness/soft-max patch (plan ralplan-oms-anti-forge-
		// staleness-softmax.md US-001). Old state lacks maxIterations/
		// hardMaxIterations; without backfill every access would be NaN and the
		// onStop soft-max comparison (turnCount > maxIterations) would misbehave.
		// Defaults match createState. Persisted by the next saveState mutation.
		if (state.maxIterations === undefined) {
			state.maxIterations = 50;
		}
		if (state.hardMaxIterations === undefined) {
			state.hardMaxIterations = 200;
		}
		// Staleness TTL (Phase 2 US-003): ralph 循环若中途崩溃留下僵尸 state,
		// 老 state 永久驱动循环会空转。三时间戳取最新判断活跃度——单看
		// state.updatedAt 会误杀长 PRD 循环会话 (setPrdStoryPasses/
		// setCriterionVerified 只 savePrd 不 saveState, store.ts:1018/1090), 所以把
		// prd.updatedAt 和 stageHistory 末尾也算进来。>2h 视为过期返回 null。
		// Must mirror oms-state.mjs loadState (double-write consistency).
		const STALE_STATE_MS = 2 * 60 * 60 * 1000; // 2 hours, 对齐 omc
		const t1 = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
		const prd = loadPrd();
		const t2 = prd && prd.updatedAt ? new Date(prd.updatedAt).getTime() : 0;
		const hist = Array.isArray(state.stageHistory) ? state.stageHistory : [];
		const lastHist = hist.length ? hist[hist.length - 1] : null;
		const t3 = lastHist && lastHist.timestamp ? new Date(lastHist.timestamp).getTime() : 0;
		const latestActivity = Math.max(t1, t2, t3);
		if (latestActivity > 0 && Date.now() - latestActivity > STALE_STATE_MS) {
			const ageMin = Math.round((Date.now() - latestActivity) / 60000);
			try {
				const logPath = join(getStateDir(), 'errors.log');
				const timestamp = new Date().toISOString();
				appendFileSync(
					logPath,
					`[${timestamp}] loadState: stale state ignored (age ${ageMin}min > ${STALE_STATE_MS / 60000}min)\n`,
					'utf-8',
				);
			} catch {}
			return null;
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
	// Phase 3 US-007: also clear verification-state.json on oms-stop so a
	// fresh session doesn't inherit a stale approval from the prior run.
	deleteVerificationState();
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
		// Soft/hard iteration caps (anti-forge/staleness/soft-max patch).
		// Soft cap auto-extends +10 on hit; hard cap is the true stop. See
		// hooks/on-stop.mjs MAX_TURNS replacement logic.
		maxIterations: 50,
		hardMaxIterations: 200,
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
 * @returns `{prd, wrote, persisted}`:
 *   - `prd`        — always present (on-disk winner's, or in-memory scaffold)
 *   - `wrote`      — whether THIS call persisted the scaffold to disk
 *   - `persisted`  — whether `prd` reflects a PRD that is currently on disk
 *                    (true when we wrote it, OR when we lost the race but the
 *                    winner's PRD is on disk; false only for the in-memory-only
 *                    scaffold with no disk PRD). Callers use this to decide
 *                    whether to surface a "refine to persist" warning without
 *                    an extra loadPrd round-trip.
 */
export function initPrd(task: string): {
	prd: Prd;
	wrote: boolean;
	persisted: boolean;
} {
	const existing = loadPrd();
	if (existing) {
		// PRD already on disk — not written by this call, but it IS persisted.
		return {prd: existing, wrote: false, persisted: true};
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
			return {prd: theirs, wrote: false, persisted: true};
		}
		// Lost the race AND no PRD on disk (winner wrote then deleted, or transient
		// lock failure). Do NOT force-write our scaffold here — that could clobber
		// a PRD the winner already refined in the gap, or resurrect a state the
		// user explicitly cleared via oms-stop. Return the in-memory scaffold so
		// the caller still has an object; if persistence is required, the caller's
		// next mutation (refinePrd) will write under the lock and reconcile.
		return {prd, wrote: false, persisted: false};
	}
	return {prd, wrote: true, persisted: true};
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
 * Result of setPrdStoryPasses — a structured outcome so the MCP layer can give
 * the agent an accurate, actionable error WITHOUT re-loading the PRD (which the
 * old `PrdStory | null` return forced — it could not distinguish "prd missing"
 * vs "story missing" vs "guard refused", so the caller had to loadPrd again).
 *
 *   - ok:true            → the story, mutated and persisted
 *   - ok:false + reason  → why it refused, plus counts for the guard case so the
 *                          MCP layer can report "Verified: N/M" directly
 */
export type SetPrdStoryPassesResult =
	| {ok: true; story: PrdStory}
	| {
			ok: false;
			reason: 'missing-prd' | 'missing-story' | 'guard' | 'no-approval';
			/** verified/total criteria at refusal — only meaningful for reason:'guard' */
			verifiedCount?: number;
			totalCount?: number;
	  };

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
 * The guard is intentionally asymmetric — only passes:true is gated:
 *   - mark-passes(true)  on an unverified story → REFUSED (ok:false, reason:'guard').
 *     Forces evidence. The guard ALSO rejects a story with zero acceptance
 *     criteria: `[].every()===true` would otherwise let an unverified story
 *     pass vacuously. validateStoryInput forbids empty criteria on
 *     refine/add-story, but it never runs on loadPrd, so a LEGACY PRD on disk
 *     (predating the validation) could still have an empty-criteria story —
 *     this guard closes that hole at runtime rather than requiring a migration.
 *   - mark-passes(true)  on a fully-verified story → OK (idempotent; also clears
 *     any prior `rejected` veto so the story is back to a clean pass state).
 *   - mark-passes(false) on any story → always OK (unmark needs no precondition;
 *     reviewer can reject at will). It CLEARS every criterion's `verified` flag
 *     AND sets `rejected=true`, so the agent must re-verify EACH criterion with
 *     fresh evidence before mark-passes(true) can succeed again. This is the
 *     veto: a reviewer's "打回" invalidates prior evidence, the agent cannot
 *     rubber-stamp the story back via a bare mark-passes(true).
 *
 * Returns a structured result so the caller can distinguish the three refusal
 * reasons (missing-prd / missing-story / guard) and, for the guard case, report
 * the exact verified/total counts without an extra loadPrd round-trip.
 */
export function setPrdStoryPasses(
	storyId: string,
	passes: boolean,
): SetPrdStoryPassesResult {
	const prd = loadPrd();
	if (!prd) {
		return {ok: false, reason: 'missing-prd'};
	}
	const story = prd.stories.find(s => s.id === storyId);
	if (!story) {
		return {ok: false, reason: 'missing-story'};
	}
	const totalCount = story.acceptanceCriteria.length;
	const verifiedCount = story.acceptanceCriteria.filter(c => c.verified).length;
	// Guard: refuse to mark passes:true unless the story has at least one
	// criterion AND every criterion is already verified. The length check closes
	// the vacuous-truth hole — `[].every(()=>...)===true` on an empty array would
	// otherwise let a legacy empty-criteria story (loaded from disk pre-validation)
	// pass with zero evidence, defeating the core Ralph invariant. This is a
	// runtime backstop; validateStoryInput prevents NEW empty-criteria stories.
	if (passes && (totalCount === 0 || verifiedCount !== totalCount)) {
		return {ok: false, reason: 'guard', verifiedCount, totalCount};
	}
	// No-approval gate (Phase 3 US-006, AC1.5): mark-passes(true) requires a
	// matching APPROVED verification (reviewer sign-off via submit-approval).
	// This is the anti-self-approval core — an AI can't rubber-stamp a story
	// without first requesting verification and getting a reviewer to approve.
	// 过渡期豁免 (R1): verification-state.json 不存在时 hasMatchingApproval returns
	// true (老会话放行); file exists but no matching approved → 'no-approval' refuse.
	if (passes && !hasMatchingApproval(storyId, 'story')) {
		return {ok: false, reason: 'no-approval'};
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
		// R9: 同步清 verification-state.json 的 approval (cross-reject 复用防御).
		// 在同一函数内调 (不跨函数, 缩小 TOCTOU — R7), 把 status 复位 pending +
		// 清 approval 字段, 防止 AI 拿旧 approval 重新 mark-passes 跳过重新验证.
		clearVerificationOnReject();
	}
	story.updatedAt = new Date().toISOString();
	savePrd(prd);
	return {ok: true, story};
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
	// Only lift passes when ALL criteria are verified AND the story hasn't been
	// explicitly rejected (rejected flag set by setPrdStoryPasses(id, false)).
	// After a reviewer rejects a story, re-verifying a criterion must NOT
	// auto-lift passes — the agent has to explicitly call mark-passes(true) to
	// re-pass, so a reviewer's rejection is a real veto rather than something a
	// noop re-verify overrides. A fresh `passes: false` story has rejected=false,
	// so it still auto-lifts on full verification (convenience for fresh refine).
	//
	// The `length > 0` term is defense-in-depth for the empty-criteria vacuous-
	// truth hole (an empty array makes every() return true vacuously). In
	// practice it is unreachable for empty-criteria stories here: the
	// `!criterion` check above already returns null when criterionIndex is out
	// of range on an empty array. The REAL protection against legacy
	// empty-criteria PRDs lives in setPrdStoryPasses's `totalCount === 0` guard
	// (mark-passes(true) is the only path that can set passes=true on a loaded
	// story). This term stays as a belt-and-suspenders safeguard against a
	// future change that relaxes the out-of-range check.
	//
	// R8 修复 (Phase 3 US-006, AC1.5a): auto-lift 加 no-approval gate. 原方案只
	// gate mark-passes, 但 auto-lift (这里) 直接设 passes=true 完全跳过 gate, 整个
	// 防伪层形同虚设. 现在 hasMatchingApproval 校验: 有匹配 approved 才 auto-lift,
	// 否则只设 verified=true 不自动 passes, 迫使走显式 mark-passes(true).
	// 过渡期豁免: verification-state.json 不存在时 hasMatchingApproval returns true,
	// 老会话 auto-lift 保持原行为.
	if (
		verified &&
		!story.rejected &&
		story.acceptanceCriteria.length > 0 &&
		story.acceptanceCriteria.every(c => c.verified) &&
		hasMatchingApproval(storyId, 'story')
	) {
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
 * Uses `??` (not `||`) so a PRD whose task is intentionally an empty string is
 * NOT misreported as '(no PRD yet)' — that marker only fires when loadPrd()
 * itself returns null (the PRD is genuinely absent). But an empty-string task
 * would render as a bare '# Task: ' line, which is hard to diagnose — so when a
 * PRD exists but its task is empty/null, we show '(no task set)' instead. This
 * can happen for a legacy PRD or one written via the store API bypassing the
 * MCP refine guard (which refuses empty tasks).
 */
export function initProgress(): boolean {
	const filePath = getProgressFilePath();
	if (existsSync(filePath)) {
		return false;
	}
	ensureStateDir();
	const prd = loadPrd();
	const task = !prd
		? '(no PRD yet)'
		: prd.task && prd.task.trim().length > 0
			? prd.task
			: '(no task set)';
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
			const task = !prd
				? '(no PRD yet)'
				: prd.task && prd.task.trim().length > 0
					? prd.task
					: '(no task set)';
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

// ── Verification State (Phase 3 US-005/006: request-id anti-forge) ──
//
// Purpose: 堵死 AI self-approval attack (AI 自己调 mark-passes 而不经 reviewer).
// 流程: AI 调 requestVerification 拿 UUID 令牌 → reviewer 带 requestId 审 →
// submitApproval 写 approved (带 reviewerAgentId 调用者归属审计) → mark-passes/
// auto-lift 的 no-approval gate 校验 hasMatchingApproval 才放行.
//
// 过渡期豁免 (R1): verification-state.json 不存在时 gate 不触发, 老会话原行为.
// forceSetStage 豁免 completion gate (AC1.11a): build 失败 done→executing 回退不被拦.

/** Verification scope — story-level vs whole-completion. */
export type VerificationScope = 'story' | 'completion';

/** Verification status lifecycle. */
export type VerificationStatus = 'pending' | 'approved' | 'rejected';

/**
 * A single verification request record. Lives in verification-state.json.
 * Only ONE pending verification at a time (most recent overwrites); approved/
 * rejected records are kept for audit (reviewerAgentId traces which reviewer
 * agent signed off — AC1.12, the structured-caller-attribution advantage tool-
 * based anti-forge has over omc's transcript scan).
 */
export interface VerificationState {
	/** UUID token — must match submit-approval's requestId (anti-forge). */
	requestId: string;
	/** Story id, or null for completion scope. */
	storyId: string | null;
	/** Criterion index within the story (optional, for story-scope granularity). */
	criterionIndex: number | null;
	/** Story-level vs whole-completion verification. */
	scope: VerificationScope;
	/** Current status of this verification. */
	status: VerificationStatus;
	/** How many submit-approval attempts have been made (reject increments). */
	attempts: number;
	/** Max attempts before the verification is locked (max-attempts gate). */
	maxAttempts: number;
	/** When the request was created (TTL clock starts here). */
	requestedAt: string;
	/** When the verification was resolved (approved/rejected), or null if pending. */
	resolvedAt: string | null;
	/** Reviewer feedback from the approval/rejection verdict. */
	reviewerFeedback: string | null;
	/** Critic tier used for the review (architect/critic/codex). */
	criticTier: string | null;
	/** Which reviewer agent submitted the approval (caller attribution, AC1.12). */
	reviewerAgentId: string | null;
}

/**
 * TTL for a verification request — requests older than this are stale (expired
 * gate). TTL clock starts at requestedAt (not resolvedAt), so a slow review that
 * takes longer than TTL will be rejected even on first submit (reviewer M2).
 * 2h chosen (aligned with state staleness STALE_STATE_MS) — 30min was too tight
 * for thorough architect reviews and would false-positive kill legitimate slow
 * reviews. The TTL bounds reuse-window AND submit-window; both reset on a fresh
 * requestVerification call.
 */
const VERIFICATION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours, 对齐 state 过期
/** Max submit-approval attempts before lockout (max-attempts gate). */
const VERIFICATION_MAX_ATTEMPTS = 3;

function getVerificationFilePath(): string {
	return join(getStateDir(), 'verification-state.json');
}

/**
 * Load verification-state.json. Returns null if the file does not exist.
 *
 * IMPORTANT (过渡期豁免 R1): null return is the "no verification layer active"
 * signal — hasMatchingApproval treats null as "豁免, 按老逻辑放行". A file that
 * exists but is empty/corrupt returns null too, but that's rare (atomicWriteFile
 * keeps it whole). The distinction matters: gate only fires when the file EXISTS
 * but lacks a matching approved record.
 */
export function loadVerificationState(): VerificationState | null {
	const filePath = getVerificationFilePath();
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, 'utf-8');
		const v = JSON.parse(content) as VerificationState;
		// Backfill null fields for forward-compat (older records may lack fields
		// added later — treat absent as the safe default rather than crashing).
		if (v.attempts === undefined) v.attempts = 0;
		if (v.maxAttempts === undefined) v.maxAttempts = VERIFICATION_MAX_ATTEMPTS;
		if (v.criterionIndex === undefined) v.criterionIndex = null;
		if (v.reviewerFeedback === undefined) v.reviewerFeedback = null;
		if (v.criticTier === undefined) v.criticTier = null;
		if (v.reviewerAgentId === undefined) v.reviewerAgentId = null;
		if (v.resolvedAt === undefined) v.resolvedAt = null;
		return v;
	} catch {
		return null;
	}
}

function saveVerificationState(v: VerificationState): void {
	atomicWriteFile(getVerificationFilePath(), JSON.stringify(v, null, 2));
}

/** Check if a verification approval is stale (past TTL). */
function isVerificationExpired(v: VerificationState): boolean {
	// TTL clock starts at requestedAt. An approved record that's been approved
	// for >TTL is also expired (prevents resurrecting an old approval).
	const requested = v.requestedAt ? new Date(v.requestedAt).getTime() : 0;
	if (requested === 0) return true;
	return Date.now() - requested > VERIFICATION_TTL_MS;
}

/**
 * Result of a submit-approval attempt. `reason` explains which gate failed:
 *   - 'mismatch'      : requestId doesn't match the pending request's token
 *   - 'used'          : request already resolved (approved/rejected), can't reuse
 *   - 'expired'       : request past TTL
 *   - 'max-attempts'  : too many failed submit attempts
 *   - 'missing'       : no pending verification (file exists but no record)
 *
 * NOTE: scope cross-wiring (story-scope approval used for completion gate and
 * vice versa) is NOT checked here — submitApproval only has the requestId, not
 * the caller's expected scope. Scope is enforced at the GATE layer by
 * hasMatchingApproval, which compares the caller's requested scope against the
 * verification record's scope (R6). This keeps submitApproval's job narrow
 * (validate the token + verdict) and centralizes scope enforcement in one place.
 */
export type SubmitApprovalResult =
	| {ok: true; verification: VerificationState}
	| {ok: false; reason: 'mismatch' | 'used' | 'expired' | 'max-attempts' | 'missing'};

/**
 * Request a new verification. Generates a UUID token and writes a pending record.
 * Overwrites any existing pending request (only one pending at a time).
 *
 * @param storyId    Story id, or null for completion scope.
 * @param scope      'story' or 'completion'.
 * @param criterionIndex Optional criterion index within the story.
 */
export function requestVerification(
	storyId: string | null,
	scope: VerificationScope,
	criterionIndex: number | null = null,
): VerificationState {
	const now = new Date().toISOString();
	// Detect overwrite of an existing pending request (reviewer M3): only one
	// pending verification at a time, so a new request silently supersedes the
	// prior. Log the supersession so the audit trail shows why a prior requestId
	// would now mismatch (its holder gets 'mismatch' on submit). We do NOT refuse
	// the overwrite — re-request is a valid recovery from a lost/stuck token — but
	// the log gives post-hoc visibility into the supersession.
	const existing = loadVerificationState();
	if (existing && existing.status === 'pending' && existing.requestId) {
		try {
			const logPath = join(getStateDir(), 'errors.log');
			const timestamp = new Date().toISOString();
			appendFileSync(
				logPath,
				`[${timestamp}] requestVerification: superseded pending request ${existing.requestId} (storyId=${existing.storyId}, scope=${existing.scope}) with new request for storyId=${storyId}, scope=${scope}\n`,
				'utf-8',
			);
		} catch {}
	}
	const v: VerificationState = {
		requestId: randomUUID(),
		storyId,
		criterionIndex,
		scope,
		status: 'pending',
		attempts: 0,
		maxAttempts: VERIFICATION_MAX_ATTEMPTS,
		requestedAt: now,
		resolvedAt: null,
		reviewerFeedback: null,
		criticTier: null,
		reviewerAgentId: null,
	};
	saveVerificationState(v);
	return v;
}

/**
 * Submit an approval/rejection verdict for a verification request.
 *
 * Four-gate check (AC1.3):
 *   1. File must exist & have a record (missing)
 *   2. requestId must match the pending token (mismatch) — anti-forge core
 *   3. Request must still be pending, not already resolved (used)
 *   4. Request must not be past TTL (expired)
 *   5. attempts must be under maxAttempts (max-attempts)
 *   6. storyId/scope must match the request (scope-mismatch)
 *
 * On success: writes verdict + reviewerFeedback + reviewerAgentId (caller
 * attribution, AC1.12). On reject verdict: increments attempts (toward
 * max-attempts lockout).
 */
export function submitApproval(
	requestId: string,
	verdict: 'approved' | 'rejected',
	feedback: string,
	reviewerAgentId: string,
	criticTier: string | null = null,
): SubmitApprovalResult {
	const v = loadVerificationState();
	if (!v) {
		return {ok: false, reason: 'missing'};
	}
	// Gate 1: token mismatch — the anti-forge core. An AI that didn't call
	// requestVerification can't know the requestId, so it can't fake an approval.
	if (v.requestId !== requestId) {
		return {ok: false, reason: 'mismatch'};
	}
	// Gate 2: already resolved (approved or rejected) — can't reuse a token.
	if (v.status !== 'pending') {
		return {ok: false, reason: 'used'};
	}
	// Gate 3: TTL expired.
	if (isVerificationExpired(v)) {
		return {ok: false, reason: 'expired'};
	}
	// Gate 4: max attempts (each rejected submit counts toward lockout).
	if (v.attempts >= v.maxAttempts) {
		return {ok: false, reason: 'max-attempts'};
	}
	// Scope cross-wiring (R6) is NOT checked here — submitApproval only has the
	// requestId, not the caller's expected scope. Scope is enforced at the GATE
	// layer by hasMatchingApproval (which compares the caller's requested scope
	// against v.scope). See SubmitApprovalResult doc for rationale.

	const now = new Date().toISOString();
	// On reject: increment attempts but KEEP status pending (reviewer may re-
	// review the same request until satisfied). Only the max-attempts gate
	// (checked at the top of the NEXT submit) locks the request — at which
	// point submit returns 'max-attempts' regardless of verdict. This makes
	// max-attempts reachable & testable: a reviewer can reject up to maxAttempts
	// times while the request stays pending, then the (maxAttempts+1)th submit
	// is blocked. Approved resolves immediately (no retry needed).
	if (verdict === 'rejected') {
		v.attempts += 1;
		v.reviewerFeedback = feedback;
		v.reviewerAgentId = reviewerAgentId;
		v.criticTier = criticTier;
		// Don't set status='rejected' here — keep pending so reviewer can retry.
		// The next submit's max-attempts gate is what finally locks it.
		saveVerificationState(v);
		return {ok: true, verification: v};
	}
	// Approved: resolve the verification.
	v.status = 'approved';
	v.resolvedAt = now;
	v.reviewerFeedback = feedback;
	v.criticTier = criticTier;
	v.reviewerAgentId = reviewerAgentId;
	saveVerificationState(v);
	return {ok: true, verification: v};
}

/**
 * Get the current pending (or last-resolved) verification record.
 * Returns the record including reviewerAgentId for post-hoc audit (AC1.12).
 */
export function getPendingVerification(): VerificationState | null {
	return loadVerificationState();
}

/**
 * Does the verification state have a matching APPROVED record for the given
 * story/scope? Used by the no-approval gates (US-006) to decide whether to
 * allow mark-passes / auto-lift / completion-stage transition.
 *
 * Conditions for a match (AC1.5a):
 *   - verification-state.json EXISTS (过渡期豁免: 不存在返回 true, 老会话放行)
 *   - status === 'approved'
 *   - scope === 'story' (completion-scope approvals don't authorize story auto-lift)
 *   - storyId matches (when storyId arg is non-null)
 *   - not past TTL
 *
 * @param storyId The story to check approval for. Pass null to check completion scope.
 * @param scope   'story' (default) or 'completion'.
 */
export function hasMatchingApproval(
	storyId: string | null,
	scope: VerificationScope = 'story',
): boolean {
	const filePath = getVerificationFilePath();
	const fileExists = existsSync(filePath);
	const v = loadVerificationState();
	// 过渡期豁免 (R1): verification-state.json 不存在 → 老会话, gate 不触发, 放行.
	// 这是为了不破坏已有进行中的 ralph 会话 (它们没有 verification-state.json).
	if (!fileExists) {
		return true;
	}
	// Fail-closed (reviewer CRITICAL): 文件存在但 loadVerificationState 返回 null
	// = JSON 损坏 (torn write / 手动编辑). 损坏文件不是"无文件豁免"语义, 而是活跃会话
	// 上的完整性失败 — 必须拒, 不能放行. 否则一个损坏的 verification-state.json
	// (可能由跨设备非原子写或崩溃产生) 会静默禁用整个防伪层, 无任何信号.
	// 区分 absent (豁免) vs corrupt (fail-closed) 与 inspectStateFile 模式一致.
	if (v === null) {
		return false;
	}
	if (v.status !== 'approved') {
		return false;
	}
	if (v.scope !== scope) {
		return false;
	}
	if (scope === 'story') {
		// storyId must match (both null is completion-scope, not story-scope).
		if (storyId === null || v.storyId !== storyId) {
			return false;
		}
	} else {
		// completion scope: storyId should be null on both sides.
		if (storyId !== null || v.storyId !== null) {
			return false;
		}
	}
	if (isVerificationExpired(v)) {
		return false;
	}
	return true;
}

/**
 * Clear the verification-state.json's approval on reject (R9).
 * Resets status to pending and clears approval fields, so a cross-reject
 * reuse of an old approval is blocked. Called by setPrdStoryPasses(id, false)
 * in the same function (不跨函数, 缩小 TOCTOU — R7).
 *
 * NOTE: this does NOT delete the file (过渡期豁免 relies on file existence
 * detection). It resets the record to a pending state so the next
 * requestVerification overwrites it cleanly.
 */
export function clearVerificationOnReject(): void {
	const v = loadVerificationState();
	if (!v) {
		return; // nothing to clear (过渡期豁免: file doesn't exist)
	}
	v.status = 'pending';
	v.resolvedAt = null;
	v.reviewerFeedback = null;
	v.reviewerAgentId = null;
	v.criticTier = null;
	// Keep `attempts` (reviewer L1): attempts counts failed submit-approval
	// attempts on THIS request token, not cross-story rejections. A story-level
	// reject (setPrdStoryPasses(id,false) → this function) clears the approval
	// so it can't be reused across rejects (R9), but does NOT reset the
	// submit-attempt counter — if a reviewer already burned N submit attempts on
	// this token, reusing the same token (without a fresh requestVerification)
	// should still progress toward max-attempts lockout. A fresh
	// requestVerification creates a new record with attempts=0, so legitimate
	// re-review after story reject resets cleanly via re-request.
	saveVerificationState(v);
}

/** Delete verification-state.json (called by oms-stop / deleteState cleanup). */
export function deleteVerificationState(): void {
	const filePath = getVerificationFilePath();
	if (existsSync(filePath)) {
		try {
			unlinkSync(filePath);
		} catch {}
	}
	cleanupTmpFiles(filePath);
}

// ── Generic OMS state store (对标 omc state_write/state_read) ──
//
// 通用键值状态存储：每个 mode 一个 JSON 文件，覆盖写语义。
// 用于 skill 跨会话/上下文压缩后恢复状态（interview rounds、trace 假设、
// dive 流水线桥接数据等）。skill 侧负责读-改-写：先 read 拿当前对象，
// 改字段，再 write 回去。
//
// 存储位置：.snow/oms-state/store/<mode>.json
// mode 是状态域，每个 skill 用独立 mode 隔离（如 "interview", "deep-dive", "trace"）。
// mode 只允许 ^[a-zA-Z0-9_-]+$，防路径遍历。

const MODE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** store 子目录：.snow/oms-state/store/ */
function getOmsStoreDir(): string {
	return join(getStateDir(), 'store');
}

/** mode 文件路径：.snow/oms-state/store/<mode>.json */
function getOmsStoreFilePath(mode: string): string {
	return join(getOmsStoreDir(), `${mode}.json`);
}

/** 校验 mode 名安全（只允许字母数字下划线连字符，防路径遍历；限长 128 防超长文件名）。 */
function validateModeName(mode: string): void {
	if (typeof mode !== 'string' || !MODE_NAME_PATTERN.test(mode)) {
		throw new Error(
			`Invalid mode name: "${mode}". Only alphanumeric characters, underscores, and hyphens are allowed (^[a-zA-Z0-9_-]+$).`,
		);
	}
	if (mode.length > 128) {
		throw new Error(
			`Invalid mode name: length ${mode.length} exceeds 128 characters. Over-long mode names may fail on some filesystems.`,
		);
	}
}

/**
 * 覆盖写整个 mode 对象到 .snow/oms-state/store/<mode>.json。
 * 覆盖语义：直接替换文件内容，不做 merge。skill 侧先 read 拿当前对象，
 * 改字段，再 write 回去。
 *
 * @param mode 状态域名（如 "interview", "deep-dive", "trace"）
 * @param data 任意可 JSON 序列化的对象
 */
export function writeOmsState(mode: string, data: unknown): void {
	validateModeName(mode);
	// undefined 不可序列化（JSON.stringify(undefined) === undefined，非字符串），写入会损坏文件。
	if (data === undefined) {
		throw new Error(
			`writeOmsState(mode="${mode}"): data must be a JSON-serializable object, got undefined. Pass null explicitly to clear a mode.`,
		);
	}
	const dir = getOmsStoreDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, {recursive: true});
	}
	const filePath = getOmsStoreFilePath(mode);
	const content = JSON.stringify(data, null, 2);
	// 复用现有原子写（lock + tmp + rename），保证并发安全和不产生半截文件。
	// 用 'skip' 策略：锁争用时返回 false 让调用方知道写失败，不静默丢数据。
	// oms-state 跟 prd.json 不同——skill state（interview rounds/trace hypotheses）
	// 丢失不可恢复，必须让调用方重试而不是 last-writer-wins 静默覆盖。
	const written = atomicWriteWithLock(filePath, content, 'skip');
	if (!written) {
		throw new Error(
			`Failed to acquire lock for oms-state mode "${mode}" after retries (concurrent write in progress). Re-read the state, re-apply your changes, and retry the write.`,
		);
	}
}

/**
 * 读整个 mode 对象。文件不存在返回 null。
 *
 * @param mode 状态域名
 * @returns 反序列化的对象，或 null（文件不存在/JSON 损坏）
 */
export function readOmsState(mode: string): unknown | null {
	validateModeName(mode);
	const filePath = getOmsStoreFilePath(mode);
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, 'utf-8');
		return JSON.parse(content);
	} catch (err) {
		// JSON 损坏（可恢复：让调用方重写覆盖）当 null 返回。
		// 真正的 IO/权限错误（EACCES/EPERM/磁盘故障）必须抛出，不能跟"不存在"混淆。
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return null;
		}
		if (err instanceof SyntaxError) {
			// JSON 解析失败——文件存在但内容损坏，返回 null 让调用方重写覆盖。
			return null;
		}
		throw err;
	}
}

/**
 * 删除 mode 文件。文件不存在返回 false，删除成功返回 true。
 *
 * @param mode 状态域名
 * @returns true 表示已删除，false 表示文件原本就不存在
 */
export function deleteOmsState(mode: string): boolean {
	validateModeName(mode);
	const filePath = getOmsStoreFilePath(mode);
	if (!existsSync(filePath)) {
		return false;
	}
	try {
		unlinkSync(filePath);
		// 清理可能残留的 lock/tmp 文件（跟 deleteState/deletePrd 一致）。
		cleanupTmpFiles(filePath);
		return true;
	} catch (err) {
		// ENOENT：文件刚被并发删了，当"原本不存在"返回 false。
		// 其他错误（EACCES/EPERM）必须抛出，不能静默当"不存在"。
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return false;
		}
		throw err;
	}
}

/**
 * 列出所有 mode 名（文件名去 .json 后缀）。
 * store 目录不存在时返回空数组。
 *
 * @returns mode 名数组，如 ["interview", "deep-dive", "trace"]
 */
export function listOmsModes(): string[] {
	const dir = getOmsStoreDir();
	if (!existsSync(dir)) {
		return [];
	}
	try {
		return readdirSync(dir)
			.filter(name => name.endsWith('.json'))
			.map(name => name.slice(0, -5)) // 去掉 .json
			.filter(name => MODE_NAME_PATTERN.test(name)) // 只返回合法 mode 名
			.sort();
	} catch {
		return [];
	}
}
