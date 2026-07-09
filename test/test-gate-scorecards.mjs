/**
 * Store-layer tests for completion gates (ledger, task-complete validation).
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = process.cwd();

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
	if (cond) {
		console.log(`✅ PASS: ${name}`);
		pass++;
	} else {
		console.log(`❌ FAIL: ${name} ${detail}`);
		fail++;
	}
}

const tmp = mkdtempSync(join(tmpdir(), 'oms-gates-'));
process.env.OMS_STATE_DIR = join(tmp, '.snow', 'oms-state');

// Load compiled store after env is set
const store = require(join(root, 'dist/state/store.js'));

// 1. createState sets gatesRequired
const s = store.createState('gate unit', 'npm test');
ok('createState gatesRequired=true', s.gatesRequired === true);

// 2. without gates, done-path hasMatchingApproval false for completion
ok(
	'no completion on ledger → hasMatchingApproval completion false',
	store.hasMatchingApproval(null, 'completion') === false,
);

// 3. task-complete self gate
const entry = store.approveSelfGate({
	scope: 'task-complete',
	scorecard: {
		pass: true,
		summary: 'done',
		evidence: ['t1'],
		noTasksReason: 'no tasks',
	},
});
ok('approveSelfGate task-complete', !!entry && entry.scope === 'task-complete');
ok(
	'ledger has task-complete',
	store.getLedgerApproval('task-complete') != null,
);

// 4. empty tasks without noTasksReason rejected by validator
const reasons = store.validateTaskCompleteScorecard(
	{ pass: true, summary: 'x', evidence: ['e'] },
	[],
	false,
);
ok('empty tasks need noTasksReason', reasons.length > 0);

// 5. incomplete task without deferred
const reasons2 = store.validateTaskCompleteScorecard(
	{ pass: true, summary: 'x', evidence: ['e'] },
	[{ id: 'task_1', description: 'a', completed: false }],
	false,
);
ok('incomplete needs deferred', reasons2.some(r => r.includes('task_1')));

// 6. multi-scope ledger independence
store.approveSelfGate({
	scope: 'task-reconcile',
	scorecard: { pass: true, summary: 'r', evidence: ['e'] },
});
ok('task-complete still present after reconcile', store.getLedgerApproval('task-complete') != null);
ok('task-reconcile present', store.getLedgerApproval('task-reconcile') != null);

// 7. canEnterDone missing quality/completion
const d1 = store.canEnterDone(true);
ok('canEnterDone false when incomplete', d1.ok === false);
ok('canEnterDone mentions missing', /missing|code-quality|completion/i.test(d1.reason));

// 8. self reviewer blocked helpers
ok('main is self', store.isSelfReviewerId('main') === true);
ok('oms_critic allowlisted', store.isAllowlistedStrictReviewer('oms_critic') === true);

// cleanup
try {
	rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(`\nGate scorecards: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
