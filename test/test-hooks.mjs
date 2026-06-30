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
	sessionId: 'test_123',
	stage: 'planning',
	goal: 'Test goal — fix authentication bug',
	verifyCommand: '',
	tasks: [],
	turnCount: 0,
	stageHistory: [{ stage: 'planning', timestamp: new Date().toISOString() }],
	logs: [],
	snapshots: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

let pass = 0;
let fail = 0;

function assert(name, condition, detail = '') {
	if (condition) {
		console.log(`✅ PASS: ${name}`);
		pass++;
	} else {
		console.log(`❌ FAIL: ${name} ${detail}`);
		fail++;
	}
}

// Test 1: onUserMessage with no state → exit 0
writeState({ ...baseState, stage: 'idle' });
// Remove state to test no-state
rmSync(stateDir, { recursive: true, force: true });
const r1 = runHook('hooks/on-user-message.mjs', JSON.stringify({ message: 'hello' }));
assert('onUserMessage no state → exit 0', r1.exitCode === 0, `got ${r1.exitCode}`);

// Test 2: onUserMessage with planning state → exit 1 with prompt
mkdirSync(stateDir, { recursive: true });
writeState({ ...baseState, stage: 'planning' });
const r2 = runHook('hooks/on-user-message.mjs', JSON.stringify({ message: 'hello' }));
assert('onUserMessage planning → exit 1', r2.exitCode === 1, `got ${r2.exitCode}`);
assert('onUserMessage planning → contains [OMS:PLANNING]', r2.stderr.includes('[OMS:PLANNING]'), r2.stderr.slice(0, 200));
assert('onUserMessage planning → contains goal', r2.stderr.includes('Test goal'), r2.stderr.slice(0, 200));

// Test 3: onUserMessage with executing state → exit 1 with prompt
writeState({ ...baseState, stage: 'executing', tasks: [{ id: 'task_1', description: 'Fix bug', completed: false }] });
const r3 = runHook('hooks/on-user-message.mjs', JSON.stringify({ message: 'hello' }));
assert('onUserMessage executing → exit 1', r3.exitCode === 1, `got ${r3.exitCode}`);
assert('onUserMessage executing → contains [OMS:EXECUTING]', r3.stderr.includes('[OMS:EXECUTING]'), r3.stderr.slice(0, 200));

// Test 4: onStop with executing state → exit 2 with continuation
writeState({ ...baseState, stage: 'executing', turnCount: 2, tasks: [{ id: 'task_1', description: 'Fix bug', completed: false }] });
const r4 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop executing → exit 2', r4.exitCode === 2, `got ${r4.exitCode}`);
assert('onStop executing → contains [OMS:CONTINUE]', r4.stderr.includes('[OMS:CONTINUE]'), r4.stderr.slice(0, 200));
assert('onStop executing → contains Turn', r4.stderr.includes('Turn'), r4.stderr.slice(0, 200));

// Test 5: onStop with done state → exit 0 (no continuation)
writeState({ ...baseState, stage: 'done', turnCount: 5 });
const r5 = runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
assert('onStop done → exit 0', r5.exitCode === 0, `got ${r5.exitCode}`);

// Test 6: onStop increments turn count
writeState({ ...baseState, stage: 'executing', turnCount: 3 });
runHook('hooks/on-stop.mjs', JSON.stringify({ messages: [] }));
const updatedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
assert('onStop increments turnCount', updatedState.turnCount === 4, `got ${updatedState.turnCount}`);

// Test 7: onUserMessage with done state → exit 1 with completion message
writeState({ ...baseState, stage: 'done', turnCount: 1 });
const r7 = runHook('hooks/on-user-message.mjs', JSON.stringify({ message: 'hello' }));
assert('onUserMessage done → exit 1', r7.exitCode === 1, `got ${r7.exitCode}`);
assert('onUserMessage done → contains [OMS:DONE]', r7.stderr.includes('[OMS:DONE]'), r7.stderr.slice(0, 200));

// Cleanup
rmSync(stateDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
