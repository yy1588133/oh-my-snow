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
} from 'fs';
import {join} from 'path';

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
 * Atomic write: write to temp file first, then rename.
 * This prevents corrupted state if the process is interrupted mid-write.
 */
export function saveState(state: OmsState): void {
	ensureStateDir();
	const filePath = getStateFilePath();
	const content = JSON.stringify(state, null, 2);

	const lockPath = filePath + '.lock';

	// Stale lock detection: if lock file is older than 120s, force-remove it
	if (existsSync(lockPath)) {
		try {
			const lockStat = statSync(lockPath);
			const lockAge = Date.now() - lockStat.mtimeMs;
			if (lockAge > 120000) {
				unlinkSync(lockPath);
			}
		} catch {}
	}

	let fd: number | undefined;
	let lockCreated = false;

	// Retry loop: attempt to acquire lock up to 5 times with 50ms busy-wait delays
	const MAX_RETRIES = 5;
	const RETRY_DELAY_MS = 50;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			fd = openSync(lockPath, 'wx'); // Atomic create, throws if exists
			lockCreated = true;
			closeSync(fd);
			fd = undefined;
			break; // Lock acquired successfully
		} catch {
			if (attempt < MAX_RETRIES - 1) {
				syncSleep(RETRY_DELAY_MS);
			}
		}
	}

	if (!lockCreated) {
		// All retries exhausted — skip write to avoid data corruption from concurrent writes
		try {
			const logPath = join(getStateDir(), 'errors.log');
			const timestamp = new Date().toISOString();
			appendFileSync(
				logPath,
				`[${timestamp}] saveState: lock contention after retries, skipping write to avoid data corruption\n`,
				'utf-8',
			);
		} catch {}
		return; // Skip write — do NOT fall through to the finally block
	}

	try {
		const tmpPath = filePath + '.tmp';
		writeFileSync(tmpPath, content, 'utf-8');
		try {
			renameSync(tmpPath, filePath);
		} catch {
			// Cross-device fallback: direct write
			writeFileSync(filePath, content, 'utf-8');
			try {
				unlinkSync(tmpPath);
			} catch {}
		}
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
	// Clean up lock and tmp files from saveState
	const lockPath = filePath + '.lock';
	if (existsSync(lockPath)) {
		try {
			unlinkSync(lockPath);
		} catch {}
	}
	const tmpPath = filePath + '.tmp';
	if (existsSync(tmpPath)) {
		try {
			unlinkSync(tmpPath);
		} catch {}
	}
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
 */
export function setTeamName(state: OmsState, teamName: string): OmsState {
	state.teamName = teamName;
	state.updatedAt = new Date().toISOString();
	saveState(state);
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
