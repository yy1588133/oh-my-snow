// Verify the PRD data-layer fixes from the code review:
// 1. setPrdStoryPasses(true) REFUSES a story whose criteria aren't all verified
// 2. setCriterionVerified auto-flips passes=true when last criterion verified
// 3. setCriterionVerified(false) drops passes but leaves other verified intact
// 4. refinePrd deletes a stale progress.txt
// 5. getPrdStatus doesn't mutate the loaded prd.stories order
import {mkdtempSync, existsSync, writeFileSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const stateDir = mkdtempSync(join(tmpdir(), 'oms-prd-fix-'));
process.env.OMS_STATE_DIR = stateDir;

const store = await import('../dist/state/store.js');
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// init + refine with a 2-criterion story
store.initPrd('Test task');
store.refinePrd('Test task', [
	{title: 'Story A', acceptanceCriteria: ['crit 1', 'crit 2'], priority: 1},
]);
const story = store.getPrdStory('US-001');
ok('refine created 2 criteria', story.acceptanceCriteria.length === 2);

// FIX 1: mark-passes(true) must REFUSE when criteria not all verified
const refused = store.setPrdStoryPasses('US-001', true);
ok('mark-passes refuses unverified story (returns null)', refused === null);
const afterRefuse = store.getPrdStory('US-001');
ok('story passes still false after refused mark', afterRefuse.passes === false);
ok('criteria still unverified after refused mark', afterRefuse.acceptanceCriteria.every(c => !c.verified));

// FIX 2: verify criterion 0, then 1 → passes auto-flips true
store.setCriterionVerified('US-001', 0, true);
let mid = store.getPrdStory('US-001');
ok('after verify crit 0: passes still false (1 of 2)', mid.passes === false);
ok('crit 0 verified', mid.acceptanceCriteria[0].verified === true);
store.setCriterionVerified('US-001', 1, true);
let all = store.getPrdStory('US-001');
ok('after verify crit 1: passes auto true (all verified)', all.passes === true);

// Now mark-passes(true) should SUCCEED (all verified)
const accepted = store.setPrdStoryPasses('US-001', true);
ok('mark-passes accepts fully-verified story', accepted !== null && accepted.passes === true);

// FIX 3: unmark-passes(false) drops passes, leaves verified intact (re-verify next pass)
store.setPrdStoryPasses('US-001', false);
let afterUnmark = store.getPrdStory('US-001');
ok('after unmark: passes false', afterUnmark.passes === false);
ok('after unmark: criteria verified flags left intact', afterUnmark.acceptanceCriteria.every(c => c.verified === true));

// FIX 4: refinePrd deletes stale progress.txt
store.initProgress(); // creates progress.txt
ok('progress.txt exists before refine', existsSync(join(stateDir, 'progress.txt')));
store.refinePrd('New task', [
	{title: 'New story', acceptanceCriteria: ['new crit'], priority: 1},
]);
ok('refinePrd deletes stale progress.txt', !existsSync(join(stateDir, 'progress.txt')));

// FIX 5: getPrdStatus doesn't mutate prd.stories order
// Insert stories out of priority order, then call status twice — if it mutates,
// the second call's underlying array would already be sorted (latent). We check
// getPrdStatus returns sorted by priority without us having sorted the source.
store.refinePrd('Order test', [
	{title: 'high pri', acceptanceCriteria: ['c'], priority: 5},
	{title: 'low pri', acceptanceCriteria: ['c'], priority: 1},
]);
const s1 = store.getPrdStatus();
ok('status sorts by priority (low first)', s1.stories[0].priority === 1);
// load raw prd and confirm stories array still in insertion order (not mutated)
const rawPrd = store.loadPrd();
ok('loadPrd stories preserve insertion order (not mutated by getPrdStatus)', rawPrd.stories[0].priority === 5);

store.deletePrd();

// ── FIX 6: verify-criterion(false) must NOT drop Passes (asymmetric derivation) ──
// Previously setCriterionVerified set passes = allVerified on every call, so
// un-verifying one criterion silently unmarked the whole story — contradicting
// setPrdStoryPasses's "passes:false leaves verified flags as-is" contract.
// Now verify-criterion only LIFTS passes (when all verified); dropping is
// setPrdStoryPasses(id, false)'s job.
//
// Note: refinePrd is called WITHOUT a preceding initPrd here. This relies on
// refinePrd's implicit auto-init behavior (store.ts: it tolerates a missing
// existing PRD via `existing?.createdAt || now` and `task || '' || ''`). If
// refinePrd ever adds a precondition check that rejects a missing PRD, this
// test must add an explicit `store.initPrd('Asymmetry test')` first.
store.refinePrd('Asymmetry test', [
	{title: 'story', acceptanceCriteria: ['c1', 'c2'], priority: 1},
]);
store.setCriterionVerified('US-001', 0, true);
store.setCriterionVerified('US-001', 1, true);
let allVerified = store.getPrdStory('US-001');
ok('asym: both criteria verified → passes true', allVerified.passes === true);

// Now un-verify criterion 0: passes must STAY true (only setPrdStoryPasses drops it)
store.setCriterionVerified('US-001', 0, false);
let afterUnverify = store.getPrdStory('US-001');
ok('asym: verify-criterion(false) does NOT drop passes', afterUnverify.passes === true);
ok('asym: criterion 0 flag cleared', afterUnverify.acceptanceCriteria[0].verified === false);
ok('asym: criterion 1 flag intact', afterUnverify.acceptanceCriteria[1].verified === true);

// Re-verify criterion 0: passes was already true, stays true
store.setCriterionVerified('US-001', 0, true);
let reVerified = store.getPrdStory('US-001');
ok('asym: re-verify crit 0 → passes still true', reVerified.passes === true);

// Explicit unmark via setPrdStoryPasses(false): passes drops, verified intact
store.setPrdStoryPasses('US-001', false);
let afterMark = store.getPrdStory('US-001');
ok('asym: explicit unmark drops passes', afterMark.passes === false);
ok('asym: explicit unmark leaves verified intact', afterMark.acceptanceCriteria.every(c => c.verified));

// Re-mark passes(true): succeeds because all criteria still verified
const reMarked = store.setPrdStoryPasses('US-001', true);
ok('asym: re-mark after unmark succeeds (verified intact)', reMarked !== null && reMarked.passes === true);

// Reviewer rejects again, then agent re-verifies a SINGLE criterion (already true)
// → passes auto-lifts back to true WITHOUT an explicit mark-passes(true).
// This is intended (see setCriterionVerified JSDoc): re-verifying IS the
// rework confirmation, so the story legitimately re-passes. A reviewer who
// needs a permanent veto should delete the story, not rely on mark-passes(false).
store.setPrdStoryPasses('US-001', false);
let afterReject = store.getPrdStory('US-001');
ok('asym: reviewer reject drops passes', afterReject.passes === false);
ok('asym: reviewer reject leaves verified intact', afterReject.acceptanceCriteria.every(c => c.verified));
store.setCriterionVerified('US-001', 0, true); // re-confirm criterion 0 (already verified)
let afterReverify = store.getPrdStory('US-001');
ok('asym: re-verify after reject re-lifts passes (intended)', afterReverify.passes === true);

store.deletePrd();
console.log(`\n${'='.repeat(50)}\nPRD fixes: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
