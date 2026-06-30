import { execSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';

// Setup test state
const stateDir = join(process.cwd(), '.snow', 'oms-state');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

function writeState(state) {
	writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
}

function runHook(script, stdinData) {
	try {
		const result = execSync(`node ${script}`, {
			input: stdinData,
			encoding: 'utf-8',
			timeout: 10000,
			cwd: process.cwd(),
		});
		return { exitCode: 0, stdout: result, stderr: '' };
	} catch (e) {
		return {
			exitCode: e.status ?? -1,
			stdout: e.stdout ?? '',
			stderr: e.stderr ?? '',
		};
	}
}

const baseState = {
	sessionId: 'test_456',
	stage: 'planning',
	goal: 'Test V2 hooks',
	verifyCommand: '',
	tasks: [],
	turnCount: 0,
	stageHistory: [],
	logs: [],
	snapshots: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

let pass = 0, fail = 0;
function assert(name, condition, detail = '') {
	if (condition) {
		console.log(`✅ PASS: ${name}`);
		pass++;
	} else {
		console.log(`❌ FAIL: ${name} ${detail}`);
		fail++;
	}
}

const fsEditContext = JSON.stringify({ toolName: 'filesystem-edit', args: { filePath: 'test.ts' } });
const fsCreateContext = JSON.stringify({ toolName: 'filesystem-create', args: { filePath: 'new.ts' } });
const readContext = JSON.stringify({ toolName: 'filesystem-read', args: {} });
const terminalContext = JSON.stringify({ toolName: 'terminal-execute', args: {} });

// ── beforeToolCall tests ──

// Test 1: planning stage blocks filesystem-edit
writeState({ ...baseState, stage: 'planning' });
const r1 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: planning blocks filesystem-edit', r1.exitCode === 1, `got ${r1.exitCode}`);
assert('beforeToolCall: planning block message', r1.stderr.includes('[OMS:BLOCKED]'), r1.stderr.slice(0, 200));

// Test 2: planning stage blocks filesystem-create
const r2 = runHook('hooks/before-tool-call.mjs', fsCreateContext);
assert('beforeToolCall: planning blocks filesystem-create', r2.exitCode === 1, `got ${r2.exitCode}`);

// Test 3: planning stage allows filesystem-read (non-write tool)
const r3 = runHook('hooks/before-tool-call.mjs', readContext);
assert('beforeToolCall: planning allows filesystem-read', r3.exitCode === 0, `got ${r3.exitCode}`);

// Test 4: executing stage allows filesystem-edit
writeState({ ...baseState, stage: 'executing' });
const r4 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: executing allows filesystem-edit', r4.exitCode === 0, `got ${r4.exitCode}`);

// Test 5: verifying stage blocks filesystem-edit
writeState({ ...baseState, stage: 'verifying' });
const r5 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: verifying blocks filesystem-edit', r5.exitCode === 1, `got ${r5.exitCode}`);

// Test 6: fixing stage allows filesystem-edit
writeState({ ...baseState, stage: 'fixing' });
const r6 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: fixing allows filesystem-edit', r6.exitCode === 0, `got ${r6.exitCode}`);

// Test 7: done stage blocks filesystem-edit
writeState({ ...baseState, stage: 'done' });
const r7 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: done blocks filesystem-edit', r7.exitCode === 1, `got ${r7.exitCode}`);

// Test 8: done stage blocks terminal-execute
const r8 = runHook('hooks/before-tool-call.mjs', terminalContext);
assert('beforeToolCall: done blocks terminal-execute', r8.exitCode === 1, `got ${r8.exitCode}`);

// Test 9: executing stage allows terminal-execute
writeState({ ...baseState, stage: 'executing' });
const r9 = runHook('hooks/before-tool-call.mjs', terminalContext);
assert('beforeToolCall: executing allows terminal-execute', r9.exitCode === 0, `got ${r9.exitCode}`);

// Test 10: no state = fail-open
rmSync(stateDir, { recursive: true, force: true });
const r10 = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: no state = allow', r10.exitCode === 0, `got ${r10.exitCode}`);

// Test 11: crash recovery — malformed stdin
mkdirSync(stateDir, { recursive: true });
writeState({ ...baseState, stage: 'planning' });
const r11 = runHook('hooks/before-tool-call.mjs', 'NOT JSON');
assert('beforeToolCall: malformed stdin = fail-open', r11.exitCode === 0, `got ${r11.exitCode}`);

// ── afterToolCall tests ──

// Test 12: afterToolCall planning = no verification (exit 0)
writeState({ ...baseState, stage: 'planning' });
const r12 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: planning = no verify', r12.exitCode === 0, `got ${r12.exitCode}`);

// Test 13: afterToolCall non-write tool = no verification
writeState({ ...baseState, stage: 'executing' });
const r13 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-read', args: {}, result: 'ok' }));
assert('afterToolCall: non-write tool = no verify', r13.exitCode === 0, `got ${r13.exitCode}`);

// Test 14: afterToolCall executing + verifyCommand = run build
// Use a simple echo command as verifyCommand that always succeeds
writeState({ ...baseState, stage: 'executing', verifyCommand: 'echo success' });
const r14 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: executing + echo success = exit 0', r14.exitCode === 0, `got ${r14.exitCode}`);

// Test 15: afterToolCall executing + failing verifyCommand = exit 1
writeState({ ...baseState, stage: 'executing', verifyCommand: 'node -e "process.exit(1)"' });
const r15 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: executing + failing cmd = exit 1', r15.exitCode === 1, `got ${r15.exitCode}`);
assert('afterToolCall: failure message contains BUILD FAILED', r15.stderr.includes('[OMS:BUILD FAILED]'), r15.stderr.slice(0, 200));

// Test 16: afterToolCall verifying stage triggers verification
writeState({ ...baseState, stage: 'verifying', verifyCommand: 'echo success' });
const r16 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: verifying stage triggers verify', r16.exitCode === 0, `got ${r16.exitCode}`);

// Test 17: afterToolCall done stage = no verification
writeState({ ...baseState, stage: 'done', verifyCommand: 'echo success' });
const r17 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: done = no verify', r17.exitCode === 0, `got ${r17.exitCode}`);

// Test 18: afterToolCall no state = fail-open
rmSync(stateDir, { recursive: true, force: true });
const r18 = runHook('hooks/after-tool-call.mjs', JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }));
assert('afterToolCall: no state = fail-open', r18.exitCode === 0, `got ${r18.exitCode}`);

// Test 19: afterToolCall crash recovery (malformed stdin)
mkdirSync(stateDir, { recursive: true });
writeState({ ...baseState, stage: 'executing', verifyCommand: 'echo success' });
const r19 = runHook('hooks/after-tool-call.mjs', 'BROKEN');
assert('afterToolCall: malformed stdin = fail-open', r19.exitCode === 0, `got ${r19.exitCode}`);

// Cleanup
rmSync(stateDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
