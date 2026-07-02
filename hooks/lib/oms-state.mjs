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
		return state;
	} catch {
		return null;
	}
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
