// Status panel unit + hook integration (U1/U3 + review fixes)
import {mkdtempSync, writeFileSync, readFileSync, existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {spawnSync} from 'child_process';

let pass = 0, fail = 0;
const ok = (n, c, detail = '') => {
	console.log((c ? '✅' : '❌') + ' ' + n + (c || !detail ? '' : ` ${detail}`));
	c ? pass++ : fail++;
};

const panel = await import('../hooks/lib/status-panel.mjs');

const baseState = {
	sessionId: 'oms_panel',
	stage: 'executing',
	goal: 'panel test goal that is reasonably long for truncation checks',
	tasks: [
		{id: 't1', description: 'one', completed: true},
		{id: 't2', description: 'two', completed: false},
	],
	turnCount: 3,
	maxIterations: 50,
	hardMaxIterations: 200,
	gatesRequired: true,
	lastGateFailure: null,
	teamName: null,
};

const now = Date.now();
const freshIso = new Date(now).toISOString();
const staleIso = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // 3h > 2h TTL

// ── full vs compact ──
const full = panel.buildStatusPanel({state: baseState, ledger: {entries: {}}}, {mode: 'full'});
const compact = panel.buildStatusPanel({state: baseState, ledger: {entries: {}}}, {mode: 'compact'});

ok('full has [OMS:STATUS]', full.includes('[OMS:STATUS]'));
ok('full has Stage', full.includes('Stage: executing'));
ok('full has Turns', full.includes('Turns: 3 / soft 50 / hard 200'));
ok('full has Tasks', full.includes('Tasks: 1/2'));
ok('full empty ledger lists missing scopes', full.includes('missing=[') && full.includes('task-complete'));
ok('full has LastGateFailure none', full.includes('LastGateFailure: none'));

ok('compact has [OMS:STATUS compact]', compact.includes('[OMS:STATUS compact]'));
ok('compact shorter than full', compact.length < full.length);

// Missing file vs empty — both show missing scopes, not "unavailable"
const missingLike = panel.formatGatesLine(baseState, {entries: {}, missingFile: true});
ok('missing file = empty ledger semantics', missingLike.missing.includes('completion'));
ok('missing file not "unavailable"', !missingLike.line.includes('unavailable'));

const loadErr = panel.formatGatesLine(baseState, {entries: {}, loadError: true});
ok('loadError says unavailable', loadErr.line.includes('unavailable'));

// Partial approvals
const partialLedger = {
	entries: {
		'task-complete': {status: 'approved', requestedAt: freshIso, resolvedAt: freshIso},
		'task-reconcile': {status: 'approved', requestedAt: freshIso, resolvedAt: freshIso},
	},
};
const partial = panel.formatGatesLine(baseState, partialLedger, now);
ok('partial: task-complete ok', partial.passed.includes('task-complete'));
ok('partial: completion missing', partial.missing.includes('completion'));
ok('partial line has ok= and missing=', partial.line.includes('ok=[') && partial.line.includes('missing=['));

// All approved fresh
const allOk = {
	entries: Object.fromEntries(
		['task-complete', 'task-reconcile', 'code-quality', 'completion'].map((s) => [
			s,
			{status: 'approved', requestedAt: freshIso, resolvedAt: freshIso},
		]),
	),
};
const allLine = panel.formatGatesLine(baseState, allOk, now);
ok('all approved', allLine.missing.length === 0 && allLine.line.includes('all approved'));

// Expired approval (TTL) — not counted as ok
const expiredLedger = {
	entries: {
		'task-complete': {status: 'approved', requestedAt: staleIso, resolvedAt: staleIso},
		'task-reconcile': {status: 'approved', requestedAt: freshIso, resolvedAt: freshIso},
	},
};
const exp = panel.formatGatesLine(baseState, expiredLedger, now);
ok('expired not in ok', !exp.passed.includes('task-complete'));
ok('expired listed as missing', exp.missing.includes('task-complete'));
ok('expired annotation', exp.line.includes('expired=') || exp.line.includes('task-complete'));

// isLedgerApprovalValid unit
ok(
	'isLedgerApprovalValid fresh true',
	panel.isLedgerApprovalValid(
		{status: 'approved', requestedAt: freshIso},
		now,
	),
);
ok(
	'isLedgerApprovalValid stale false',
	!panel.isLedgerApprovalValid(
		{status: 'approved', requestedAt: staleIso},
		now,
	),
);

// bare gates off
const bareFull = panel.buildStatusPanel(
	{state: {...baseState, tasks: [], gatesRequired: false, goal: 'x'}, ledger: {entries: {}}},
	{mode: 'full'},
);
ok('bare: gates off', bareFull.includes('Gates: off'));

// hard stop open-task cap
const manyOpen = {
	...baseState,
	tasks: Array.from({length: 20}, (_, i) => ({
		id: `t${i}`,
		description: `task ${i}`,
		completed: false,
	})),
};
const hardMany = panel.buildHardStopReport({state: manyOpen, ledger: {entries: {}}});
ok('hard stop caps open tasks', hardMany.includes('(+') && hardMany.includes('more)'));
ok('hard stop still has Incomplete tasks', hardMany.includes('Incomplete tasks'));
ok('hard stop id fallback ok', !hardMany.includes('undefined:'));

// soft banner delta
const ban = panel.buildSoftExtendBanner({
	oldSoft: 5,
	newSoft: 15,
	turnCount: 6,
	hardMax: 10,
	delta: 10,
});
ok('soft banner EXTENDED', ban.includes('[OMS:EXTENDED]'));
ok('soft banner +10 from delta', ban.includes('(+10)'));
ok('soft banner not completion phrase', ban.includes('not task completion'));

// hard report basics
const hard = panel.buildHardStopReport({
	state: {...baseState, turnCount: 201, maxIterations: 50, hardMaxIterations: 200},
	ledger: {entries: {}},
	verifyNote: null,
});
ok('hard HARD STOP', hard.includes('[OMS:HARD STOP]'));
ok('hard not successful done', hard.includes('NOT a successful done'));
ok('hard verify unknown', hard.includes('unknown') || hard.includes('unavailable'));

// ── onUserMessage integration ──
const umPath = join(process.cwd(), 'hooks', 'on-user-message.mjs');
const dir = mkdtempSync(join(tmpdir(), 'oms-um-'));
writeFileSync(join(dir, 'state.json'), JSON.stringify({...baseState}, null, 2), 'utf8');
const um = spawnSync('node', [umPath], {
	input: JSON.stringify({message: 'hello'}),
	env: {...process.env, OMS_STATE_DIR: dir},
	encoding: 'utf8',
	timeout: 10000,
});
const umOut = (um.stderr || '') + (um.stdout || '');
ok('onUserMessage exit 1', um.status === 1);
ok('onUserMessage compact panel', umOut.includes('[OMS:STATUS compact]'));
ok('onUserMessage keeps user text', umOut.includes('hello'));

// ── onStop force-transition has STATUS (mirror test-v2-hooks Test 23 setup) ──
const onStopPath = join(process.cwd(), 'hooks', 'on-stop.mjs');
const ftDir = mkdtempSync(join(tmpdir(), 'oms-ft-'));
const ftState = {
	sessionId: 'oms_ft',
	stage: 'done',
	goal: 'force transition panel',
	verifyCommand: 'node -e "process.exit(1)"',
	tasks: [],
	turnCount: 1,
	stageHistory: [{stage: 'done', timestamp: new Date().toISOString()}],
	logs: [],
	snapshots: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	maxIterations: 50,
	hardMaxIterations: 200,
	gatesRequired: false,
};
writeFileSync(join(ftDir, 'state.json'), JSON.stringify(ftState, null, 2), 'utf8');
writeFileSync(join(ftDir, '.pending-verify'), '', 'utf8');
const ft = spawnSync('node', [onStopPath], {
	input: JSON.stringify({messages: []}),
	env: {...process.env, OMS_STATE_DIR: ftDir, PATH: process.env.PATH},
	encoding: 'utf8',
	timeout: 20000,
	cwd: process.cwd(),
});
const ftOut = (ft.stderr || '') + (ft.stdout || '');
ok('force-transition exit 2', ft.status === 2, `exit=${ft.status} out=${ftOut.slice(0, 200)}`);
ok('force-transition has STATUS panel', ftOut.includes('[OMS:STATUS]'));
ok('force-transition STAGE TRANSITION', ftOut.includes('[OMS:STAGE TRANSITION]'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
