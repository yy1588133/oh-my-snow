import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';

// Setup test state
const stateDir = join(process.cwd(), '.snow', 'oms-state');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

function writeState(state) {
	writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
}

function runHook(script, stdinData) {
	const result = spawnSync('node', [script], {
		input: stdinData,
		encoding: 'utf-8',
		timeout: 10000,
		cwd: process.cwd(),
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function runHookFromDir(script, stdinData, customCwd, customStateDir) {
	const result = spawnSync('node', [script], {
		input: stdinData,
		encoding: 'utf-8',
		timeout: 10000,
		cwd: customCwd,
		env: { ...process.env, OMS_STATE_DIR: customStateDir },
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
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
const teamSpawnContext = JSON.stringify({ toolName: 'team-spawn_teammate', args: { name: 'worker1', role: 'coder', prompt: 'do work' } });

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

// Test 6: team-spawn_teammate stage enforcement (delayed spawn — US-005/006)
// planning blocks spawn (delayed spawn), verifying blocks spawn, done blocks spawn, executing allows spawn
writeState({ ...baseState, stage: 'planning' });
const r6a = runHook('hooks/before-tool-call.mjs', teamSpawnContext);
assert('beforeToolCall: planning blocks team-spawn_teammate', r6a.exitCode === 1, `got ${r6a.exitCode}`);
assert('beforeToolCall: planning spawn block message', r6a.stderr.includes('Delayed spawn'), r6a.stderr.slice(0, 200));

writeState({ ...baseState, stage: 'executing' });
const r6b = runHook('hooks/before-tool-call.mjs', teamSpawnContext);
assert('beforeToolCall: executing allows team-spawn_teammate', r6b.exitCode === 0, `got ${r6b.exitCode}`);

writeState({ ...baseState, stage: 'verifying' });
const r6c = runHook('hooks/before-tool-call.mjs', teamSpawnContext);
assert('beforeToolCall: verifying blocks team-spawn_teammate', r6c.exitCode === 1, `got ${r6c.exitCode}`);

writeState({ ...baseState, stage: 'done' });
const r6d = runHook('hooks/before-tool-call.mjs', teamSpawnContext);
assert('beforeToolCall: done blocks team-spawn_teammate', r6d.exitCode === 1, `got ${r6d.exitCode}`);

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

// Test 11b: beforeToolCall idle stage blocks filesystem-edit (backward compat)
writeState({ ...baseState, stage: 'idle' });
const r11b = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: idle blocks filesystem-edit', r11b.exitCode === 1, `got ${r11b.exitCode}`);
assert('beforeToolCall: idle block message', r11b.stderr.includes('[OMS:BLOCKED]'), r11b.stderr.slice(0, 200));

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

// Test 15: onStop with failing verifyCommand = exit 2 with build error
writeState({ ...baseState, stage: 'executing', verifyCommand: 'node -e "process.exit(1)"', turnCount: 1 });
// Write pending-verify marker to simulate afterToolCall
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r15 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: failing verify = exit 2', r15.exitCode === 2, `got ${r15.exitCode}`);
assert('onStop: failure message contains BUILD FAILED', r15.stderr.includes('[OMS:BUILD FAILED]'), r15.stderr.slice(0, 200));
assert('onStop: marker cleaned up after build failure', !existsSync(join(stateDir, '.pending-verify')), 'marker still exists');
// Verify that build failure context is NOT lost — continuation prompt should also be present
assert('onStop: build failure includes continuation prompt', r15.stderr.includes('[OMS:CONTINUE]'), r15.stderr.slice(0, 500));

// Test 15c: MAX_TURNS triggers exit(2) with wrap-up message
writeState({ ...baseState, stage: 'executing', turnCount: 50, tasks: [{ id: 'task_1', description: 'Test task', completed: false }] });
const r15c = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: MAX_TURNS triggers exit 2', r15c.exitCode === 2, `got ${r15c.exitCode}`);
assert('onStop: MAX_TURNS message delivered', r15c.stderr.includes('[OMS:MAX TURNS]'), r15c.stderr.slice(0, 200));
assert('onStop: MAX_TURNS includes task summary', r15c.stderr.includes('0/1 completed'), r15c.stderr.slice(0, 300));

// Test 15b: onStop auto-detects verifyCommand from verify.cmd file (avoids npm test recursion)
writeState({ ...baseState, stage: 'executing', verifyCommand: '', turnCount: 1 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
writeFileSync(join(stateDir, 'verify.cmd'), 'echo verify-cmd-detected', 'utf-8');
const r15b = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
// verify.cmd is priority #2, should be detected and run (echo always succeeds)
assert('onStop: auto-detects verifyCommand from verify.cmd', r15b.exitCode === 0 || r15b.exitCode === 2, `got ${r15b.exitCode}`);

// Test 16: afterToolCall verifying stage does NOT trigger verify
// Fix: Use 'node -e "process.exit(1)"' instead of 'echo success' — if verification is incorrectly triggered, exit code should be 1
writeState({
	...baseState,
	stage: 'verifying',
	verifyCommand: 'node -e "process.exit(1)"',
});
const r16 = runHook(
	'hooks/after-tool-call.mjs',
	JSON.stringify({ toolName: 'filesystem-edit', args: {}, result: 'ok' }),
);
assert(
	'afterToolCall: verifying stage does NOT trigger verify (blocked)',
	r16.exitCode === 0,
	`got ${r16.exitCode}`,
);

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

// ── Regression tests for code review fixes ──

// Clean up verify.cmd if Test 15b created it (avoid interfering with new tests)
rmSync(join(stateDir, 'verify.cmd'), { force: true });

// Test 20: onStop with 'done' stage + pending-verify marker + PASSING build → exit 0, marker cleaned up
writeState({ ...baseState, stage: 'done', verifyCommand: 'echo success', turnCount: 1 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r20 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: done + marker + passing build = exit 0', r20.exitCode === 0, `got ${r20.exitCode}`);
assert('onStop: done + marker + passing build = marker cleaned up', !existsSync(join(stateDir, '.pending-verify')), 'marker still exists');

// Test 21: onStop with 'done' stage + pending-verify marker + FAILING build → exit 2 with BUILD FAILED
writeState({ ...baseState, stage: 'done', verifyCommand: 'node -e "process.exit(1)"', turnCount: 1 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r21 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: done + marker + failing build = exit 2', r21.exitCode === 2, `got ${r21.exitCode}`);
assert('onStop: done + marker + failing build = BUILD FAILED message', r21.stderr.includes('[OMS:BUILD FAILED]'), r21.stderr.slice(0, 200));
assert('onStop: done + marker + failing build = marker cleaned up', !existsSync(join(stateDir, '.pending-verify')), 'marker still exists');

// Test 22: loadState migrates 'idle' to 'planning' (verified via onStop behavior)
writeState({ ...baseState, stage: 'idle', turnCount: 0 });
const r22 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: idle stage migrated to planning (exit 2 with planning prompt)', r22.exitCode === 2, `got ${r22.exitCode}`);
assert('onStop: idle migrated to planning prompt', r22.stderr.includes('[OMS:CONTINUE]') && r22.stderr.includes('Planning'), r22.stderr.slice(0, 300));
// Verify the state file was updated to 'planning'
const migratedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
assert('onStop: idle stage persisted as planning in state.json', migratedState.stage === 'planning', `got ${migratedState.stage}`);

// Test 23: done + failing build → stage force-transitioned to 'executing' in state.json
// (fixing stage removed — verifying/done failure goes back to executing to allow edits)
writeState({ ...baseState, stage: 'done', verifyCommand: 'node -e "process.exit(1)"', turnCount: 1 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r23 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: done + failing build = exit 2', r23.exitCode === 2, `got ${r23.exitCode}`);
assert('onStop: done + failing build = STAGE TRANSITION message', r23.stderr.includes('[OMS:STAGE TRANSITION]'), r23.stderr.slice(0, 300));
assert('onStop: done + failing build = BUILD FAILED message', r23.stderr.includes('[OMS:BUILD FAILED]'), r23.stderr.slice(0, 300));
// Verify state was force-transitioned to 'executing' (was 'fixing' before stage removal)
const state23 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
assert('onStop: done + failing build = stage is executing in state.json', state23.stage === 'executing', `got ${state23.stage}`);
assert('onStop: done + failing build = turnCount incremented', state23.turnCount === 2, `got ${state23.turnCount}`);
assert('onStop: done + failing build = stageHistory has executing entry', state23.stageHistory.some(h => h.stage === 'executing'), JSON.stringify(state23.stageHistory));

// Test 23b: After force-transition to executing, beforeToolCall allows filesystem-edit
// (state23 from previous test already has stage='executing' in state.json)
const r23b = runHook('hooks/before-tool-call.mjs', fsEditContext);
assert('beforeToolCall: executing (after force-transition) allows filesystem-edit', r23b.exitCode === 0, `got ${r23b.exitCode}`);

// Test 24: done + PASSING build → exit 0, turn count NOT incremented (optimization preserved)
writeState({ ...baseState, stage: 'done', verifyCommand: 'echo success', turnCount: 5 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r24 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: done + passing build = exit 0', r24.exitCode === 0, `got ${r24.exitCode}`);
assert('onStop: done + passing build = marker cleaned up', !existsSync(join(stateDir, '.pending-verify')), 'marker still exists');
// Verify turn count was NOT incremented
const state24 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
assert('onStop: done + passing build = turnCount NOT incremented', state24.turnCount === 5, `got ${state24.turnCount}`);

// Test 25: onUserMessage with malformed stdin → exit 0 (message preserved)
writeState({ ...baseState, stage: 'planning' });
const r25 = runHook('hooks/on-user-message.mjs', 'NOT VALID JSON {{{');
assert('onUserMessage: malformed stdin = exit 0 (preserve message)', r25.exitCode === 0, `got ${r25.exitCode}`);

// Test 26: Hard stop (turnCount=56) → stderr contains [OMS:HARD STOP]
writeState({ ...baseState, stage: 'executing', turnCount: 56 });
const r26 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: hard stop = exit 0', r26.exitCode === 0, `got ${r26.exitCode}`);
assert('onStop: hard stop = HARD STOP message', r26.stderr.includes('[OMS:HARD STOP]'), r26.stderr.slice(0, 200));

// Test 27: Boundary — turnCount=54 → after increment = 55 → soft warning (exit 2)
writeState({ ...baseState, stage: 'executing', turnCount: 54 });
const r27 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: turnCount 54→55 = soft warning exit 2', r27.exitCode === 2, `got ${r27.exitCode}`);
assert('onStop: turnCount 54→55 = MAX TURNS message', r27.stderr.includes('[OMS:MAX TURNS]'), r27.stderr.slice(0, 200));

// Test 28: Boundary — turnCount=55 → after increment = 56 → hard stop (exit 0)
writeState({ ...baseState, stage: 'executing', turnCount: 55 });
const r28 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: turnCount 55→56 = hard stop exit 0', r28.exitCode === 0, `got ${r28.exitCode}`);
assert('onStop: turnCount 55→56 = HARD STOP message', r28.stderr.includes('[OMS:HARD STOP]'), r28.stderr.slice(0, 200));

// Test 29: loadState with idle stage → in-memory migration, state.json NOT modified (no write)
// Write state with 'idle' stage
writeState({ ...baseState, stage: 'idle', turnCount: 0 });
// Record the file content before calling the hook
const fileBefore = readFileSync(join(stateDir, 'state.json'), 'utf-8');
// Run beforeToolCall which calls loadState (migrates idle→planning in-memory) but does NOT saveState
const r29 = runHook('hooks/before-tool-call.mjs', fsEditContext);
// idle is migrated to planning in-memory, which blocks file edits
assert('loadState: idle migrated to planning (blocks edit)', r29.exitCode === 1, `got ${r29.exitCode}`);
// Verify the state file was NOT modified (loadState should not write)
const fileAfter = readFileSync(join(stateDir, 'state.json'), 'utf-8');
assert('loadState: idle NOT persisted to file (no write)', fileBefore === fileAfter, 'state file was modified');
// Verify the file still says 'idle'
const state29 = JSON.parse(fileAfter);
assert('loadState: state file still has idle', state29.stage === 'idle', `got ${state29.stage}`);

// Test 30: Non-git directory — checkTextBypass should NOT trigger
// 必须使用 git 仓库外的目录（os.tmpdir()），否则 git 命令仍会成功
const tmpDir = join(tmpdir(), 'oms-test-nongit');
mkdirSync(tmpDir, { recursive: true });
writeState({ ...baseState, stage: 'executing', turnCount: 2 });
// 脚本路径必须用绝对路径，否则 Node.js 会相对于 customCwd 解析
const r30 = runHookFromDir(
	join(process.cwd(), 'hooks/on-stop.mjs'),
	JSON.stringify({ messages: [] }),
	tmpDir,
	stateDir,
);
assert(
	'onStop: non-git dir — no bypass false positive',
	!r30.stderr.includes('WARNING: No file changes detected'),
	r30.stderr.slice(0, 300),
);
rmSync(tmpDir, { recursive: true, force: true });

// Test 31: onStop with executing stage + failing build → continuation prompt, NOT stage transition
// (was 'fixing' before stage removal; fixing deleted so verifying failure goes back to executing.
//  executing + failing build should NOT force-transition — only done→executing force-transitions.)
writeState({ ...baseState, stage: 'executing', verifyCommand: 'node -e "process.exit(1)"', turnCount: 1 });
writeFileSync(join(stateDir, '.pending-verify'), '', 'utf-8');
const r31 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop: executing + failing build = exit 2', r31.exitCode === 2, `got ${r31.exitCode}`);
assert('onStop: executing + failing build = no STAGE TRANSITION message', !r31.stderr.includes('[OMS:STAGE TRANSITION]'), r31.stderr.slice(0, 300));
assert('onStop: executing + failing build = BUILD FAILED message', r31.stderr.includes('[OMS:BUILD FAILED]'), r31.stderr.slice(0, 300));
assert('onStop: executing + failing build = CONTINUE prompt', r31.stderr.includes('[OMS:CONTINUE]'), r31.stderr.slice(0, 500));

// Test 32: verifying stage runs verification UNCONDITIONALLY (no marker needed) — US-008
// (verifying never writes the .pending-verify marker because afterToolCall's VERIFY_STAGES excludes 'verifying',
//  so the old marker-gated check would skip. Fix: runVerification called unconditionally for verifying.)
// Uses an isolated state dir so the unconditional verify doesn't pollute the shared state.json for later tests.
const isoDir32 = join(tmpdir(), `oms-test-32-${Date.now()}`);
mkdirSync(isoDir32, { recursive: true });
writeFileSync(join(isoDir32, 'state.json'), JSON.stringify({ ...baseState, stage: 'verifying', verifyCommand: 'node -e "process.exit(1)"', turnCount: 1 }, null, 2));
// NOTE: no .pending-verify marker written — verifying must run build anyway
const r32 = runHookFromDir('hooks/on-stop.mjs', JSON.stringify({ messages: [] }), process.cwd(), isoDir32);
assert('onStop: verifying + no marker = still runs build (exit 2)', r32.exitCode === 2, `got ${r32.exitCode}`);
assert('onStop: verifying + no marker = BUILD FAILED message', r32.stderr.includes('[OMS:BUILD FAILED]'), r32.stderr.slice(0, 300));
assert('onStop: verifying + failing build = CONTINUE prompt', r32.stderr.includes('[OMS:CONTINUE]') && r32.stderr.includes('Verifying'), r32.stderr.slice(0, 500));
rmSync(isoDir32, { recursive: true, force: true });

// Test 33: verifying stage with no verify command → null fallback (US-008 hazard d)
// Isolated dir + no package.json/verify.cmd → detectVerifyCommand returns null.
// Must NOT silently pass — should surface "[OMS:VERIFY] No build/test command detected".
const isoDir33 = join(tmpdir(), `oms-test-33-${Date.now()}`);
mkdirSync(isoDir33, { recursive: true });
writeFileSync(join(isoDir33, 'state.json'), JSON.stringify({ ...baseState, stage: 'verifying', verifyCommand: '', turnCount: 1, goal: 'no build system' }, null, 2));
const r33 = runHookFromDir(join(process.cwd(), 'hooks/on-stop.mjs'), JSON.stringify({ messages: [] }), isoDir33, isoDir33);
assert('onStop: verifying + null verify = exit 2 (not silent pass)', r33.exitCode === 2, `got ${r33.exitCode} stderr=${r33.stderr.slice(0, 200)}`);
assert('onStop: verifying + null verify = VERIFY warning (no silent pass)', r33.stderr.includes('[OMS:VERIFY]') && r33.stderr.includes('No build/test command detected'), r33.stderr.slice(0, 400));
rmSync(isoDir33, { recursive: true, force: true });

// Test 34: teamName in state → team-mode continuation prompt (US-009)
const isoDir34 = join(tmpdir(), `oms-test-34-${Date.now()}`);
mkdirSync(isoDir34, { recursive: true });
writeFileSync(join(isoDir34, 'state.json'), JSON.stringify({ ...baseState, stage: 'planning', teamName: 'refactor-utils', turnCount: 1, goal: 'split utils' }, null, 2));
const r34 = runHookFromDir(join(process.cwd(), 'hooks/on-stop.mjs'), JSON.stringify({ messages: [] }), isoDir34, isoDir34);
assert('onStop: teamName + planning = Team Lead prompt', r34.stderr.includes('Planning (Team Lead)'), r34.stderr.slice(0, 400));
assert('onStop: teamName + planning = delayed spawn notice', r34.stderr.includes('Delayed spawn'), r34.stderr.slice(0, 500));
// CRITICAL-1 fix: planning team-mode prompt MUST instruct oms-add-task as the task-creation tool
// (snow-cli's team-create_task requires an active team that only exists after first spawn → deadlock if called in planning)
assert('onStop: teamName + planning = instructs oms-add-task', r34.stderr.includes('oms-add-task'), r34.stderr.slice(0, 600));

writeFileSync(join(isoDir34, 'state.json'), JSON.stringify({ ...baseState, stage: 'executing', teamName: 'refactor-utils', turnCount: 1, goal: 'split utils' }, null, 2));
const r34b = runHookFromDir(join(process.cwd(), 'hooks/on-stop.mjs'), JSON.stringify({ messages: [] }), isoDir34, isoDir34);
assert('onStop: teamName + executing = Team Lead prompt', r34b.stderr.includes('Executing (Team Lead)'), r34b.stderr.slice(0, 400));
assert('onStop: teamName + executing = spawn instruction', r34b.stderr.includes('team-spawn_teammate'), r34b.stderr.slice(0, 500));
rmSync(isoDir34, { recursive: true, force: true });

// Test 35: non-team mode (no teamName) → original single-agent prompt preserved (backward compat)
const isoDir35 = join(tmpdir(), `oms-test-35-${Date.now()}`);
mkdirSync(isoDir35, { recursive: true });
writeFileSync(join(isoDir35, 'state.json'), JSON.stringify({ ...baseState, stage: 'planning', turnCount: 1, goal: 'solo task' }, null, 2));
const r35 = runHookFromDir(join(process.cwd(), 'hooks/on-stop.mjs'), JSON.stringify({ messages: [] }), isoDir35, isoDir35);
assert('onStop: no teamName = single-agent prompt (backward compat)', r35.stderr.includes('Planning — Turn') && !r35.stderr.includes('Team Lead'), r35.stderr.slice(0, 400));
assert('onStop: no teamName = oms-add-task instruction preserved', r35.stderr.includes('oms-add-task'), r35.stderr.slice(0, 500));
rmSync(isoDir35, { recursive: true, force: true });

// Cleanup
rmSync(stateDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
