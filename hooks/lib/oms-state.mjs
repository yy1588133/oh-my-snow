import { readFileSync, existsSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, statSync, openSync, closeSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';


export function getStateDir() {
	const envDir = process.env.OMS_STATE_DIR;
	if (envDir) return envDir;
	return join(process.cwd(), '.snow', 'oms-state');
}

export function getStateFilePath() {
	return join(getStateDir(), 'state.json');
}

export function getVerifyCommandFilePath() {
	return join(getStateDir(), 'verify.cmd');
}

/**
 * Detect the appropriate build/test command for the project.
 * Priority:
 * 1. OMS state's verifyCommand (set via oms-start)
 * 2. .snow/oms-state/verify.cmd file
 * 3. package.json scripts.test or scripts.build → npm test/npm run build
 * 4. *.csproj or *.sln → dotnet build
 * 5. Makefile → make
 * 6. Cargo.toml → cargo build
 * 7. go.mod → go build
 */
export function detectVerifyCommand(state) {
	// 1. OMS state's verifyCommand
	if (state.verifyCommand && state.verifyCommand.trim()) {
		return state.verifyCommand.trim();
	}

	// 2. verify.cmd file
	const verifyCmdFile = getVerifyCommandFilePath();
	if (existsSync(verifyCmdFile)) {
		try {
			const cmd = readFileSync(verifyCmdFile, 'utf-8').trim();
			if (cmd) return cmd;
		} catch {}
	}

	// 3. package.json
	const packageJsonPath = join(process.cwd(), 'package.json');
	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
			if (pkg.scripts?.test) return 'npm test';
			if (pkg.scripts?.build) return 'npm run build';
		} catch {}
	}

	// 4. .csproj or .sln (dotnet)
	const cwd = process.cwd();
	try {
		const files = readdirSync(cwd);
		if (files.some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) {
			return 'dotnet build';
		}
	} catch {}

	// 5. Makefile
	if (existsSync(join(cwd, 'Makefile'))) {
		return 'make';
	}

	// 6. Cargo.toml
	if (existsSync(join(cwd, 'Cargo.toml'))) {
		return 'cargo build';
	}

	// 7. go.mod
	if (existsSync(join(cwd, 'go.mod'))) {
		return 'go build ./...';
	}

	// No build system detected
	return null;
}

export function loadState() {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) return null;
	try {
		const state = JSON.parse(readFileSync(filePath, 'utf-8'));
		// Migrate legacy 'idle' stage (v0.1.0) to 'planning' in-memory (lazy migration).
		// The migration is persisted by the next saveState call from any mutation.
		if (state.stage === 'idle') {
			state.stage = 'planning';
		}
		// Backfill iteration caps for legacy state.json (anti-forge/staleness/
		// soft-max patch US-001). Must mirror store.ts loadState — both readers
		// (MCP server via store.ts, hooks via this file) must agree, else hook
		// and MCP would see different maxIterations for the same state.json.
		if (state.maxIterations === undefined) {
			state.maxIterations = 50;
		}
		if (state.hardMaxIterations === undefined) {
			state.hardMaxIterations = 200;
		}
		// Staleness TTL (Phase 2 US-003): ralph 循环若中途崩溃留下僵尸 state,
		// 老 state 永久驱动循环会空转。三时间戳取最新判断活跃度——单看
		// state.updatedAt 会误杀长 PRD 循环会话 (setPrdStoryPasses/setCriterion
		// Verified 只 savePrd 不 saveState), 所以把 prd.updatedAt 和 stageHistory
		// 末尾也算进来。>2h 视为过期返回 null。Must mirror store.ts loadState.
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
				appendErrorLog(`loadState: stale state ignored (age ${ageMin}min > ${STALE_STATE_MS / 60000}min)`);
			} catch {}
			return null;
		}
		return state;
	} catch {
		return null;
	}
}

/**
 * Inspect the state.json file WITHOUT parsing/returning the state — returns a
 * status string so on-stop.mjs (Phase 2 US-004) can distinguish three cases
 * that all make loadState() return null:
 *   - 'absent'   : state.json 不存在 (无活跃会话, 静默 exit 0)
 *   - 'expired'  : state.json 存在且可解析, 但三时间戳都老 (>2h TTL) → 僵尸态
 *                  → stderr [OMS:STATE EXPIRED] + exit 0
 *   - 'corrupt'  : state.json 存在但 JSON 解析失败 (torn write / 手动编辑损坏)
 *                  → stderr [OMS:STATE CORRUPT] + exit 0 (不误报 EXPIRED 误导用户)
 *   - 'ok'       : state.json 存在且新鲜 (loadState 会返回非 null)
 *
 * loadState 对 'expired' 和 'corrupt' 都返回 null, on-stop 无法靠 loadState 区分,
 * 所以单独调 inspectStateFile 决定 stderr 该写哪条提示。
 *
 * Must mirror the TTL logic in loadState above (three-timestamp max).
 */
export function inspectStateFile() {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) return 'absent';
	let state;
	try {
		state = JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch {
		return 'corrupt';
	}
	const STALE_STATE_MS = 2 * 60 * 60 * 1000;
	const t1 = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
	let prd = null;
	try { prd = loadPrd(); } catch {}
	const t2 = prd && prd.updatedAt ? new Date(prd.updatedAt).getTime() : 0;
	const hist = Array.isArray(state.stageHistory) ? state.stageHistory : [];
	const lastHist = hist.length ? hist[hist.length - 1] : null;
	const t3 = lastHist && lastHist.timestamp ? new Date(lastHist.timestamp).getTime() : 0;
	const latestActivity = Math.max(t1, t2, t3);
	if (latestActivity > 0 && Date.now() - latestActivity > STALE_STATE_MS) {
		return 'expired';
	}
	return 'ok';
}

/**
 * Read-only PRD loader for hooks (Phase 2 US-003: extracted from on-stop.mjs:55-77
 * so loadState can read prd.updatedAt for the three-timestamp staleness check
 * without duplicating the read logic). Hooks must NOT mutate prd.json — writes
 * go through the MCP oms-prd tool (backed by store.ts).
 *
 * Atomicity: store.ts writes prd.json via tmp+rename (atomic on the normal path).
 * The ONLY non-atomic path is the cross-device fallback (renameSync EXDEV → direct
 * writeFileSync), where a reader can catch a half-written file. We retry once after
 * a short sleep to ride out that window. We do NOT retry on ENOENT (file deleted —
 * not transient) — only on SyntaxError (partial/corrupt JSON).
 */
export function loadPrd() {
	const prdPath = join(getStateDir(), 'prd.json');
	if (!existsSync(prdPath)) return null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return JSON.parse(readFileSync(prdPath, 'utf-8'));
		} catch (error) {
			// ENOENT between the existsSync above and readFileSync means the
			// file was deleted mid-read (e.g. deletePrd during oms-stop) — not
			// transient, don't retry, just return null.
			if (error && error.code === 'ENOENT') {
				return null;
			}
			// SyntaxError (partial JSON from cross-device fallback) or other
			// transient read error — retry once after a short sleep before
			// giving up and dropping Ralph context from the continuation prompt.
			if (attempt === 0) {
				syncSleep(20);
			}
		}
	}
	return null;
}

export function ensureStateDir() {
	const dir = getStateDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function syncSleep(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// Fallback: if Atomics.wait or SharedArrayBuffer is unavailable, use Date.now() spin
		const start = Date.now();
		while (Date.now() - start < ms) {}
	}
}

export function saveState(state) {
	ensureStateDir();
	const filePath = getStateFilePath();
	const content = JSON.stringify(state, null, 2);

	const lockPath = filePath + '.lock';
	
	// Stale lock detection: if lock file exists and is older than 120s, force-remove it
	if (existsSync(lockPath)) {
		try {
			const lockStat = statSync(lockPath);
			const lockAge = Date.now() - lockStat.mtimeMs;
			if (lockAge > 120000) { // 120 seconds
				unlinkSync(lockPath);
			}
		} catch {}
	}

	let fd;
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
			appendErrorLog('saveState: lock contention after retries, skipping write to avoid data corruption');
		} catch {}
		return; // Skip write — do NOT fall through to the finally block
	}

	try {
		// PID-suffixed tmp path so two concurrent writers (locked holder + force
		// fallback) don't collide on the same `state.json.tmp` — matches store.ts
		// tmpRenameWrite which uses `.${process.pid}.tmp`. cleanupTmpFiles in
		// store.ts only matches `.<digits>.tmp` files, so a bare `.tmp` would
		// never be cleaned up after a crash.
		const tmpPath = `${filePath}.${process.pid}.tmp`;
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

/**
 * Force-transition to a new stage WITHOUT validation and WITHOUT saving.
 * The caller is responsible for calling saveState() after all mutations are done.
 * This bypasses VALID_TRANSITIONS — use only for exceptional force-transitions
 * (e.g., done → executing when build fails after an edit).
 */
export function forceSetStage(state, newStage) {
	state.stage = newStage;
	state.stageHistory.push({ stage: newStage, timestamp: new Date().toISOString() });
	state.updatedAt = new Date().toISOString();
}

export function readStdin() {
	return new Promise((resolve) => {
		let data = '';
		let resolved = false;
		process.stdin.setEncoding('utf-8');

		const done = () => {
			if (resolved) return;
			resolved = true;
			if (timer) clearTimeout(timer);
			resolve(data);
		};

		process.stdin.on('data', (chunk) => {
			data += chunk;
		});
		process.stdin.once('end', done);

		// Timeout fallback: 100ms for TTY (interactive), 5000ms for piped mode
		const timeoutMs = process.stdin.isTTY ? 100 : 2000;
		const timer = setTimeout(done, timeoutMs);
	});
}

export function appendErrorLog(message) {
	const dir = getStateDir();
	ensureStateDir();
	const logPath = join(dir, 'errors.log');
	const timestamp = new Date().toISOString();
	try {
		appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf-8');
	} catch {
		// Silently fail — we don't want logging to crash the hook
	}
}
