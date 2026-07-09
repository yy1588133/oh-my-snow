/**
 * Handoff pack unit tests (hooks/lib/handoff.mjs + hard-stop integration).
 */
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';
import {
	buildHandoffPayload,
	writeHandoffFromState,
	getHandoffPath,
	computeGitAnchor,
	loadLedgerSafe,
} from '../hooks/lib/handoff.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond) {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		console.error(`  FAIL ${name}`);
	}
}

const root = mkdtempSync(join(tmpdir(), 'oms-handoff-'));
const stateDir = join(root, '.snow', 'oms-state');
mkdirSync(stateDir, {recursive: true});
process.env.OMS_STATE_DIR = stateDir;
process.chdir(root);

const state = {
	sessionId: 'oms_test',
	stage: 'executing',
	goal: 'ship handoff',
	tasks: [
		{id: 't1', description: 'done task', completed: true},
		{id: 't2', description: 'open task', completed: false},
	],
	turnCount: 201,
	maxIterations: 50,
	hardMaxIterations: 200,
	gatesRequired: true,
	lastGateFailure: {scope: 'completion', summary: 'missing scorecard', reasons: [], at: 'now'},
};

console.log('test-handoff');

const payload = buildHandoffPayload(state, {version: 1, entries: {completion: {status: 'approved'}}}, {
	nowIso: '2026-07-09T00:00:00.000Z',
	gitAnchor: {head: 'abc', porcelainFingerprint: 'fp1', capturedAt: '2026-07-09T00:00:00.000Z'},
});
ok('payload has goal/stage/tasks', payload.goal === 'ship handoff' && payload.stage === 'executing' && payload.tasks.length === 2);
ok('payload embeds ledger', payload.ledger?.entries?.completion?.status === 'approved');
ok('payload gatesRequired', payload.gatesRequired === true);

const w = writeHandoffFromState(state, {
	ledger: {version: 1, entries: {completion: {status: 'approved'}}},
	gitAnchor: {head: 'abc', porcelainFingerprint: 'fp1', capturedAt: '2026-07-09T00:00:00.000Z'},
});
ok('write ok', w.ok === true);
ok('handoff file exists', existsSync(getHandoffPath()));
const disk = JSON.parse(readFileSync(getHandoffPath(), 'utf-8'));
ok('roundtrip goal', disk.goal === 'ship handoff');
ok('roundtrip open task', disk.tasks.some(t => t.id === 't2' && !t.completed));

// git anchor shape
const ga = computeGitAnchor();
ok('git anchor has capturedAt', typeof ga.capturedAt === 'string');

// hard-stop integration via on-stop (mirror test-iteration-limits)
import {fileURLToPath} from 'url';
import {dirname} from 'path';
const here = dirname(fileURLToPath(import.meta.url));
const onStop = join(here, '..', 'hooks', 'on-stop.mjs');

const hardDir = mkdtempSync(join(tmpdir(), 'oms-hard-handoff-'));
const nowIso = new Date().toISOString();
const hardState = {
	sessionId: 'oms_hard_handoff',
	stage: 'executing',
	goal: 'hard handoff',
	verifyCommand: '',
	tasks: [{id: 't1', description: 'open', completed: false}],
	turnCount: 11,
	stageHistory: [{stage: 'executing', timestamp: nowIso}],
	logs: [],
	snapshots: [],
	createdAt: nowIso,
	updatedAt: nowIso,
	maxIterations: 5,
	hardMaxIterations: 10,
	gatesRequired: true,
	lastGateFailure: null,
};
writeFileSync(join(hardDir, 'state.json'), JSON.stringify(hardState, null, 2), 'utf-8');

const r = spawnSync(process.execPath, [onStop], {
	env: {...process.env, OMS_STATE_DIR: hardDir},
	input: JSON.stringify({messages: []}),
	encoding: 'utf-8',
	timeout: 15000,
});
const hardAll = (r.stderr || '') + (r.stdout || '');
ok('hard stop exit 0', r.status === 0);
ok('hard stop has HARD STOP', hardAll.includes('[OMS:HARD STOP]'));
ok('hard stop mentions resume', hardAll.includes('/oms:resume'));
ok('hard stop handoff written line', hardAll.includes('Handoff:'));
const handoffPath = join(hardDir, 'handoff.json');
ok('handoff still on disk after hard stop', existsSync(handoffPath));
if (existsSync(handoffPath)) {
	const hardHandoff = JSON.parse(readFileSync(handoffPath, 'utf-8'));
	ok('hard handoff goal', hardHandoff.goal === 'hard handoff');
	ok('hard handoff keeps open task', hardHandoff.tasks?.some(t => t.id === 't1'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
