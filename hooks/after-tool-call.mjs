#!/usr/bin/env node

/**
 * OMS afterToolCall Hook
 *
 * Triggered after a tool execution completes.
 * If the tool was a filesystem write tool and the stage allows editing,
 * automatically runs the build/test command and replaces the tool result
 * with the build output if it fails.
 *
 * Exit code 0 = preserve original tool result
 * Exit code 1 = replace tool result with stderr (build failure)
 *
 * Context passed via stdin (JSON):
 * { toolName: string, args: Record<string, any>, result: any, error: Error | null }
 *
 * Matcher (in hook config JSON):
 *   "filesystem-create,filesystem-edit,filesystem-replaceedit"
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// ── Path helpers ──

function getStateDir() {
	const envDir = process.env.OMS_STATE_DIR;
	if (envDir) return envDir;
	return join(process.cwd(), '.snow', 'oms-state');
}

function getStateFilePath() {
	return join(getStateDir(), 'state.json');
}

function getVerifyCommandFilePath() {
	return join(getStateDir(), 'verify.cmd');
}

function loadState() {
	const filePath = getStateFilePath();
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

function appendErrorLog(message) {
	const dir = getStateDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const logPath = join(dir, 'errors.log');
	const timestamp = new Date().toISOString();
	try {
		const existing = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
		writeFileSync(logPath, existing + `[${timestamp}] ${message}\n`, 'utf-8');
	} catch {
		// Silently fail — we don't want logging to crash the hook
	}
}

// ── Read context from stdin ──

function readStdin() {
	return new Promise((resolve) => {
		let data = '';
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk) => {
			data += chunk;
		});
		process.stdin.on('end', () => {
			resolve(data);
		});
		setTimeout(() => resolve(data), 100);
	});
}

// ── Verify command detection ──

/**
 * Detect the appropriate build/test command for the project.
 * Priority:
 * 1. OMS state's verifyCommand (set via oms-start)
 * 2. .snow/oms-state/verify.cmd file
 * 3. package.json scripts.build or scripts.test → npm run build/test
 * 4. *.csproj or *.sln → dotnet build
 * 5. Makefile → make
 * 6. Cargo.toml → cargo build
 * 7. go.mod → go build
 */
function detectVerifyCommand(state) {
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

// ── File write tools ──

const FILE_WRITE_TOOLS = new Set([
	'filesystem-create',
	'filesystem-edit',
	'filesystem-replaceedit',
]);

// Stages that should trigger auto-verification after file edits
const VERIFY_STAGES = new Set(['executing', 'verifying', 'fixing']);

// ── Main ──

async function main() {
	const stdinData = await readStdin();

	// Parse context
	let context = {};
	try {
		if (stdinData.trim()) {
			context = JSON.parse(stdinData);
		}
	} catch {
		// Can't parse context — fail-open
		process.exit(0);
	}

	const toolName = context.toolName || '';

	// Only verify after filesystem write tools
	if (!FILE_WRITE_TOOLS.has(toolName)) {
		process.exit(0);
	}

	// Check if we have an active OMS session
	const state = loadState();
	if (!state) {
		// No active session — don't auto-verify
		process.exit(0);
	}

	// Only auto-verify in appropriate stages
	if (!VERIFY_STAGES.has(state.stage)) {
		process.exit(0);
	}

	// Detect verify command
	const verifyCmd = detectVerifyCommand(state);
	if (!verifyCmd) {
		// No build system detected — don't block
		process.exit(0);
	}

	// Run the verify command
	try {
		const output = execSync(verifyCmd, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			timeout: 120000, // 2 minute timeout for builds
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Build succeeded — preserve original tool result
		process.exit(0);
	} catch (error) {
		// Build failed — replace tool result with build error
		const buildError = error.stderr || error.stdout || error.message || 'Unknown build error';
		const truncated = buildError.length > 2000 ? '...\n' + buildError.slice(-2000) : buildError;

		const message =
			`[OMS:BUILD FAILED] Auto-verification command: "${verifyCmd}"\n\n` +
			`The file edit was applied, but the build/test check failed.\n` +
			`You must fix the build errors before proceeding.\n\n` +
			`Build output:\n${truncated}\n\n` +
			`Fix the errors above, then the system will re-verify automatically on your next edit.\n` +
			`If you're in the "verifying" stage, switch to "fixing": oms-set-stage { stage: "fixing" }`;

		process.stderr.write(message);
		process.exit(1);
	}
}

main().catch((error) => {
	// On any error, fail-open (preserve original tool result)
	appendErrorLog(`afterToolCall hook error: ${error.message}`);
	process.exit(0);
});
