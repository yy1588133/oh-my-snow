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
import {join, dirname} from 'path';

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
 * Shared atomic-write primitive: acquire a lock, write to tmp, rename, release lock.
 * Used by saveState (state.json), atomicWriteFile (prd.json), and setProjectTeamMode
 * (project settings.json) so a single bugfix here fixes all three call sites.
 *
 * Behavior on lock contention (after MAX_RETRIES):
 *   - onContention = 'skip'   → return false, no write (state.json — never corrupt)
 *   - onContention = 'force'  → direct writeFileSync fallback (prd.json — better to lose
 *                                an update than silently drop it during a Ralph loop)
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

	// Stale lock detection: force-remove locks older than 120s
	if (existsSync(lockPath)) {
		try {
			const lockStat = statSync(lockPath);
			if (Date.now() - lockStat.mtimeMs > 120000) {
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
			// Fallback: direct write is better than losing the update (PRD loop)
			try {
				writeFileSync(filePath, content, 'utf-8');
				return true;
			} catch {
				return false;
			}
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
		return true;
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
 * Atomic write: write to temp file first, then rename.
 * This prevents corrupted state if the process is interrupted mid-write.
 */
export function saveState(state: OmsState): void {
	atomicWriteWithLock(getStateFilePath(), JSON.stringify(state, null, 2), 'skip');
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
 */
export function initPrd(task: string): Prd {
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
				priority: 1,
				createdAt: now,
				updatedAt: now,
			},
		],
		createdAt: now,
		updatedAt: now,
	};
	savePrd(prd);
	return prd;
}

export interface RefinedStoryInput {
	title: string;
	acceptanceCriteria: string[]; // plain criterion texts — wrapped in AcceptanceCriterion
	priority: number;
}

/**
 * Replace the scaffold stories with task-specific refined stories.
 * Sets refined: true so Ralph knows the PRD is ready for the loop.
 *
 * Also clears progress.txt: a refine is a (re)start of the PRD work, so any
 * stale progress log from a prior task on the same state dir must not survive.
 * Without this, logProgress entries from task A would linger under a header
 * still naming task A while the PRD now describes task B.
 */
export function refinePrd(
	task: string,
	stories: RefinedStoryInput[],
): Prd {
	const existing = loadPrd();
	const taskToUse = task || existing?.task || '';
	const now = new Date().toISOString();

	const refinedStories: PrdStory[] = stories.map((s, i) => ({
		id: `US-${String(i + 1).padStart(3, '0')}`,
		title: s.title,
		acceptanceCriteria: s.acceptanceCriteria.map(criterion => ({
			criterion,
			verified: false,
		})),
		passes: false,
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
 * Mark a story's passes flag.
 *
 * NOTE: this ONLY flips `passes`. It does NOT touch `acceptanceCriteria[].verified`
 * — verified flags must be set individually via setCriterionVerified() with
 * fresh evidence per criterion. Forcing verified=true here would let an agent
 * bypass per-criterion verification (the core Ralph invariant). The only place
 * `passes` is auto-derived is setCriterionVerified (passes = allCriteriaVerified).
 *
 * When setting passes:false (unmark, on reviewer rejection), criteria verified
 * flags are left as-is — the agent re-verifies them individually on the next pass.
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
	story.updatedAt = new Date().toISOString();
	savePrd(prd);
	return story;
}

/** Mark a single acceptance criterion as verified/unverified. */
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
	// If all criteria verified, auto-set passes: true; if any unverified, passes: false
	const allVerified = story.acceptanceCriteria.every(c => c.verified);
	story.passes = allVerified;
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

/** Initialize progress.txt. Returns true if created, false if already exists. */
export function initProgress(): boolean {
	const filePath = getProgressFilePath();
	if (existsSync(filePath)) {
		return false;
	}
	ensureStateDir();
	const header = `# Ralph Progress Log\n# Task: ${loadPrd()?.task || '(unknown)'}\n# Created: ${new Date().toISOString()}\n\n`;
	writeFileSync(filePath, header, 'utf-8');
	return true;
}

/**
 * Append a progress entry to progress.txt.
 * Self-healing: if the file doesn't exist yet (initProgress was skipped or the
 * process restarted), write the header first so logProgress never creates a
 * headerless file that would permanently confuse initProgress's existsSync check.
 */
export function logProgress(message: string): void {
	const filePath = getProgressFilePath();
	ensureStateDir();
	const timestamp = new Date().toISOString();
	const entry = `[${timestamp}] ${message}\n`;
	try {
		if (!existsSync(filePath)) {
			const header = `# Ralph Progress Log\n# Task: ${loadPrd()?.task || '(unknown)'}\n# Created: ${timestamp}\n\n`;
			writeFileSync(filePath, header, 'utf-8');
		}
		appendFileSync(filePath, entry, 'utf-8');
	} catch {
		// Silently fail — logging must not crash the loop
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
	// Clean up lock/tmp files
	for (const ext of ['.lock', '.tmp']) {
		const p = prdPath + ext;
		if (existsSync(p)) {
			try {
				unlinkSync(p);
			} catch {}
		}
	}
}
