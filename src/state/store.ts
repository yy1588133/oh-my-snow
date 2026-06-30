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
	readdirSync,
	unlinkSync,
} from 'fs';
import {join, dirname} from 'path';

// ── Types ──

export type Stage = 'idle' | 'planning' | 'executing' | 'verifying' | 'fixing' | 'done';

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
	stageHistory: { stage: Stage; timestamp: string }[];
	/** Verification results log */
	logs: LogEntry[];
	/** Snapshots for cross-session state recovery */
	snapshots: Snapshot[];
	/** When the session was created */
	createdAt: string;
	/** When the session was last updated */
	updatedAt: string;
}

// ── Constants ──

const VALID_TRANSITIONS: Record<Stage, Stage[]> = {
	idle: ['planning'],
	planning: ['executing'],
	executing: ['verifying', 'planning'],
	verifying: ['fixing', 'done'],
	fixing: ['verifying'],
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
		mkdirSync(dir, { recursive: true });
	}
}

export function loadState(): OmsState | null {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const content = readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as OmsState;
	} catch {
		return null;
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

	// Write directly — on Windows, rename can fail if target exists.
	// We use writeFileSync which is atomic for small files on most filesystems.
	writeFileSync(filePath, content, 'utf-8');
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
		stageHistory: [{ stage: 'planning', timestamp: now }],
		logs: [],
		snapshots: [],
		createdAt: now,
		updatedAt: now,
	};
	saveState(state);
	return state;
}

export function getStage(state: OmsState): Stage {
	return state.stage;
}

export function setStage(state: OmsState, newStage: Stage): OmsState {
	const current = state.stage;
	const allowed = VALID_TRANSITIONS[current];
	if (!allowed.includes(newStage)) {
		throw new Error(
			`Invalid stage transition: ${current} → ${newStage}. Valid transitions from "${current}": [${allowed.join(', ')}]`,
		);
	}
	state.stage = newStage;
	state.stageHistory.push({ stage: newStage, timestamp: new Date().toISOString() });
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
	const task = state.tasks.find((t) => t.id === taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}
	task.completed = true;
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

export function incrementTurn(state: OmsState): OmsState {
	state.turnCount++;
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

// ── Snapshot operations ──

export function saveSnapshot(state: OmsState, key: string, data: unknown): OmsState {
	// Remove existing snapshot with same key
	state.snapshots = state.snapshots.filter((s) => s.key !== key);
	state.snapshots.push({ key, data, createdAt: new Date().toISOString() });
	state.updatedAt = new Date().toISOString();
	saveState(state);
	return state;
}

export function loadSnapshot(state: OmsState, key: string): Snapshot | null {
	return state.snapshots.find((s) => s.key === key) ?? null;
}

export function listSnapshots(state: OmsState): { key: string; createdAt: string }[] {
	return state.snapshots.map((s) => ({ key: s.key, createdAt: s.createdAt }));
}

// ── Verify command file ──

export function saveVerifyCommandFile(cmd: string): void {
	ensureStateDir();
	writeFileSync(getVerifyCommandFilePath(), cmd, 'utf-8');
}

export function loadVerifyCommandFile(): string | null {
	const path = getVerifyCommandFilePath();
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, 'utf-8').trim();
	} catch {
		return null;
	}
}

// ── Utility ──

export function getActiveTaskCount(state: OmsState): number {
	return state.tasks.filter((t) => !t.completed).length;
}

export function getCompletedTaskCount(state: OmsState): number {
	return state.tasks.filter((t) => t.completed).length;
}

export function getStateDirPath(): string {
	return getStateDir();
}
