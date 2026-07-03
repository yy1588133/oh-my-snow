// Verify the PRD data-layer fixes from the code review:
// 1. setPrdStoryPasses(true) REFUSES a story whose criteria aren't all verified
// 2. setCriterionVerified auto-flips passes=true when last criterion verified
// 3. setCriterionVerified(false) drops passes but leaves other verified intact
// 4. refinePrd deletes a stale progress.txt
// 5. getPrdStatus doesn't mutate the loaded prd.stories order
// 6. Reject (mark-passes=false) is a REAL VETO: clears ALL verified flags +
//    sets rejected=true. verify-criterion won't auto-lift; mark-passes(true)
//    is refused until every criterion is re-verified with fresh evidence.
import {mkdtempSync, existsSync, writeFileSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const stateDir = mkdtempSync(join(tmpdir(), 'oms-prd-fix-'));
process.env.OMS_STATE_DIR = stateDir;

const store = await import('../dist/state/store.js');
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// init + refine with a 2-criterion story
// FIX (test #4): initPrd returns {prd, wrote, persisted} — assert the contract
// so a future refactor that breaks the shape is caught at the store boundary.
const initRes = store.initPrd('Test task');
ok('initPrd returns {prd, wrote} shape with wrote=true on fresh init',
	initRes && typeof initRes === 'object' && initRes.prd &&
	typeof initRes.prd.task === 'string' &&
	initRes.wrote === true && initRes.persisted === true);
ok('initPrd.prd has the scaffold story', initRes.prd.stories.length === 1);
store.refinePrd('Test task', [
	{title: 'Story A', acceptanceCriteria: ['crit 1', 'crit 2'], priority: 1},
]);
const story = store.getPrdStory('US-001');
ok('refine created 2 criteria', story.acceptanceCriteria.length === 2);

// FIX 1: mark-passes(true) must REFUSE when criteria not all verified
// New signature: {ok:false, reason:'guard'} instead of null.
const refused = store.setPrdStoryPasses('US-001', true);
ok('mark-passes refuses unverified story (ok=false, reason=guard)',
	refused && refused.ok === false && refused.reason === 'guard');
ok('refused result carries verified/total counts for the message',
	refused.verifiedCount === 0 && refused.totalCount === 2);
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

// Now mark-passes(true) should SUCCEED (all verified) — {ok:true, story}
const accepted = store.setPrdStoryPasses('US-001', true);
ok('mark-passes accepts fully-verified story (ok=true)',
	accepted && accepted.ok === true && accepted.story.passes === true);
// Lock the OTHER side of the union contract: the ok:true variant MUST carry a
// `story` field (the ok:false variant must NOT — see the legacy empty-criteria
// test below). Together these two assertions pin the discriminated union so a
// future refactor that drops `story` from ok:true (or adds it to ok:false) is
// caught at the store boundary.
ok('ok:true variant carries a story object (union discriminated correctly)',
	accepted.story !== undefined && typeof accepted.story === 'object' && accepted.story.id === 'US-001');

// FIX 3: unmark-passes(false) drops passes AND clears verified (v2 veto semantics).
// Previously unmark left verified flags intact; now it clears them + sets rejected,
// so the agent must re-verify each criterion before mark-passes(true) can succeed.
store.setPrdStoryPasses('US-001', false);
let afterUnmark = store.getPrdStory('US-001');
ok('after unmark: passes false', afterUnmark.passes === false);
ok('after unmark: criteria verified flags CLEARED (veto)', afterUnmark.acceptanceCriteria.every(c => !c.verified));

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

// Explicit unmark via setPrdStoryPasses(false): passes drops AND verified cleared (v2 veto)
store.setPrdStoryPasses('US-001', false);
let afterMark = store.getPrdStory('US-001');
ok('asym: explicit unmark drops passes', afterMark.passes === false);
ok('asym: explicit unmark CLEARS verified flags (veto)', afterMark.acceptanceCriteria.every(c => !c.verified));

// Re-mark passes(true) is REFUSED — criteria were cleared by the unmark, so the
// agent must re-verify each before mark-passes(true) can succeed.
const refusedReMark = store.setPrdStoryPasses('US-001', true);
ok('asym: re-mark after unmark REFUSED (evidence cleared)', refusedReMark && refusedReMark.ok === false && refusedReMark.reason === 'guard');
// Re-verify all criteria, then mark-passes(true) succeeds.
store.setCriterionVerified('US-001', 0, true);
store.setCriterionVerified('US-001', 1, true);
const reMarked = store.setPrdStoryPasses('US-001', true);
ok('asym: re-mark after re-verify succeeds', reMarked && reMarked.ok === true && reMarked.story.passes === true);

// ── FIX 6 (v2): reject is a REAL VETO — clears evidence + blocks auto-lift ──
// New semantics: setPrdStoryPasses(id,false) clears ALL criterion verified flags
// AND sets rejected=true. So:
//   - after reject, every criterion is unverified (evidence invalidated)
//   - re-verifying a single criterion does NOT auto-lift passes (rejected blocks it)
//   - mark-passes(true) is REFUSED until every criterion is re-verified
//   - after re-verifying all + mark-passes(true), the veto is cleared and passes=true
store.setPrdStoryPasses('US-001', false);
let afterReject = store.getPrdStory('US-001');
ok('asym: reviewer reject drops passes', afterReject.passes === false);
ok('asym: reviewer reject CLEARS all verified flags (veto)', afterReject.acceptanceCriteria.every(c => !c.verified));
ok('asym: reviewer reject sets rejected=true', afterReject.rejected === true);

// Re-verifying a SINGLE criterion: passes stays false (rejected blocks auto-lift)
store.setCriterionVerified('US-001', 0, true);
let afterReverifyOne = store.getPrdStory('US-001');
ok('asym: re-verify one criterion after reject — passes still false (veto)', afterReverifyOne.passes === false);
ok('asym: re-verify one criterion marks it verified', afterReverifyOne.acceptanceCriteria[0].verified === true);

// mark-passes(true) is REFUSED — not all criteria re-verified yet (criterion 1 still false)
const refusedMark = store.setPrdStoryPasses('US-001', true);
ok('asym: mark-passes(true) refused after partial re-verify (evidence cleared by reject)', refusedMark && refusedMark.ok === false && refusedMark.reason === 'guard');

// Re-verify the remaining criterion. At this point ALL criteria are verified,
// but passes must STILL be false — the rejected veto blocks setCriterionVerified's
// auto-lift even on a fully-verified story. This is the critical auto-lift guard
// that an explicit mark-passes(true) is required to clear. Asserting it here
// catches a future regression that drops the `!story.rejected` guard from
// setCriterionVerified (which would silently re-introduce the veto bypass).
store.setCriterionVerified('US-001', 1, true);
let afterFullReverify = store.getPrdStory('US-001');
ok('asym: all re-verified but passes STILL false (rejected blocks auto-lift)', afterFullReverify.passes === false);
ok('asym: all re-verified — every criterion verified flag true', afterFullReverify.acceptanceCriteria.every(c => c.verified));
// Now the explicit mark-passes(true) succeeds and clears the veto.
const reMarkedAfterReject = store.setPrdStoryPasses('US-001', true);
ok('asym: mark-passes(true) re-passes after full re-verify', reMarkedAfterReject && reMarkedAfterReject.ok === true && reMarkedAfterReject.story.passes === true);
ok('asym: mark-passes(true) clears rejected veto', reMarkedAfterReject.story.rejected === false);

store.deletePrd();

// ── FIX 7 (C14): refinePrd rejects non-positive / non-integer priority ──
// refinePrd must throw BEFORE savePrd so a bad priority never lands on disk.
// Covers: priority=0 (non-positive), priority=1.5 (non-integer), priority=-1.
const expectThrow = (label, fn) => {
	let threw = false;
	try { fn(); } catch { threw = true; }
	ok(label, threw);
};
store.initPrd('Priority validation test');
expectThrow('C14: priority=0 throws', () => store.refinePrd('t', [{title: 'x', acceptanceCriteria: ['c'], priority: 0}]));
expectThrow('C14: priority=1.5 throws', () => store.refinePrd('t', [{title: 'x', acceptanceCriteria: ['c'], priority: 1.5}]));
expectThrow('C14: priority=-1 throws', () => store.refinePrd('t', [{title: 'x', acceptanceCriteria: ['c'], priority: -1}]));
// PRD on disk should NOT have been overwritten by a failed refine — task stays as the init task.
const afterBadRefine = store.loadPrd();
ok('C14: failed refine does not corrupt PRD task', afterBadRefine && afterBadRefine.task === 'Priority validation test');
ok('C14: failed refine does not write refined stories', afterBadRefine && afterBadRefine.refined === false);
// C14 sweep: also assert the stories array itself is NOT polluted by the failed
// refine attempts — the disk PRD should still have the init scaffold's single
// story, not a partially-built refinedStories from a throw mid-map.
ok('C14: failed refine does not leave partial refinedStories on disk', afterBadRefine && afterBadRefine.stories.length === 1 && afterBadRefine.stories[0].id === 'US-001');
// A valid priority still works after the failed attempts.
store.refinePrd('Priority validation test', [{title: 'ok', acceptanceCriteria: ['c'], priority: 1}]);
ok('C14: valid priority=1 refines normally', store.loadPrd().refined === true);

store.deletePrd();

// ── FIX 8 (C3 sweep): refinePrd rejects empty acceptanceCriteria ──
// An empty criteria array would make mark-passes(true)'s every(verified)
// vacuously true (no criteria to verify) — violating Ralph's core invariant.
// refinePrd must throw BEFORE savePrd so an empty-criteria story never lands on disk.
store.initPrd('Empty criteria test');
expectThrow('C3: empty acceptanceCriteria throws', () => store.refinePrd('t', [{title: 'x', acceptanceCriteria: [], priority: 1}]));
const afterEmptyCriteria = store.loadPrd();
ok('C3: empty-criteria refine does not corrupt PRD', afterEmptyCriteria && afterEmptyCriteria.task === 'Empty criteria test');
ok('C3: empty-criteria refine does not set refined=true', afterEmptyCriteria && afterEmptyCriteria.refined === false);

// ── FIX 9 (C11 sweep): addPrdStory validates priority + non-empty criteria ──
// addPrdStory must use the same validateStoryInput as refinePrd so the store-layer
// invariant holds for both entry points (the MCP layer's zod is the first defense,
// this is the store-layer backstop for non-MCP callers).
store.refinePrd('Add story validation test', [{title: 'base', acceptanceCriteria: ['c'], priority: 1}]);
expectThrow('C11: addPrdStory priority=0 throws', () => store.addPrdStory('bad', ['c'], 0));
expectThrow('C11: addPrdStory priority=1.5 throws', () => store.addPrdStory('bad', ['c'], 1.5));
expectThrow('C11: addPrdStory priority=-1 throws', () => store.addPrdStory('bad', ['c'], -1));
expectThrow('C3: addPrdStory empty criteria throws', () => store.addPrdStory('bad', [], 1));
// PRD on disk should be unaffected by the failed addPrdStory calls.
const afterBadAdd = store.loadPrd();
ok('C11: failed addPrdStory does not add a story', afterBadAdd && afterBadAdd.stories.length === 1);
// A valid addPrdStory still works.
const added = store.addPrdStory('good', ['c1', 'c2'], 2);
ok('C11: valid addPrdStory succeeds', added !== null && added.id === 'US-002' && added.priority === 2);

store.deletePrd();

// ── FIX 10 (#1): legacy PRD with empty acceptanceCriteria cannot bypass the reject veto ──
// validateStoryInput forbids empty criteria on refine/add-story, but it never
// runs on loadPrd. A PRD written before the validation existed (or via the store
// API bypassing the MCP guard) could have a story with acceptanceCriteria: [].
// `[].every(()=>...)===true` would then let mark-passes(true) succeed vacuously,
// clearing a reject veto with ZERO verified evidence — defeating Ralph's core
// invariant. The store must defend at RUNTIME, not rely on migration.
//
// Simulate a legacy PRD by writing one directly to disk (bypassing refinePrd's
// validation), then assert both refusal paths hold:
//   - setPrdStoryPasses(id, true) is refused (guard catches empty criteria)
//   - setCriterionVerified does NOT auto-lift (length===0 guard in auto-lift)
const legacyPrd = {
	task: 'Legacy empty-criteria PRD',
	refined: true,
	stories: [{
		id: 'US-001',
		title: 'legacy empty story',
		acceptanceCriteria: [],
		passes: false,
		rejected: true,  // pretend a reviewer already rejected it
		priority: 1,
		createdAt: '2024-01-01T00:00:00.000Z',
		updatedAt: '2024-01-01T00:00:00.000Z',
	}],
	createdAt: '2024-01-01T00:00:00.000Z',
	updatedAt: '2024-01-01T00:00:00.000Z',
};
writeFileSync(join(stateDir, 'prd.json'), JSON.stringify(legacyPrd, null, 2), 'utf-8');

// mark-passes(true) must be REFUSED despite empty every() being vacuously true.
// The guard's `totalCount === 0` check closes the vacuous-truth hole — this is
// the REAL protection for legacy empty-criteria stories (setCriterionVerified's
// length>0 auto-lift guard is unreachable for empty criteria because the
// out-of-range null check fires first; mark-passes is the only path to
// passes=true on a loaded story, so its guard is the load-bearing one).
const legacyMark = store.setPrdStoryPasses('US-001', true);
ok('#1: legacy empty-criteria story mark-passes(true) REFUSED (guard catches empty criteria)',
	legacyMark && legacyMark.ok === false && legacyMark.reason === 'guard');
ok('#1: refused result reports 0/0 counts (no criteria to verify)',
	legacyMark.verifiedCount === 0 && legacyMark.totalCount === 0);
// Lock the union contract: the ok:false variant must NOT carry a `story` field.
// A future refactor that adds `story?: PrdStory` to the false variant (and
// leaks a stale story) would not be caught without this assertion.
ok('#1: refused result has no story field (union discriminated correctly)',
	legacyMark.story === undefined);

// setCriterionVerified on a non-existent index returns null (no criterion to
// flip). For an empty-criteria story, criterionIndex 0 is out of range, so the
// `!criterion` check returns null BEFORE the auto-lift guard is evaluated.
// Asserting this documents that setCriterionVerified cannot be used to bypass
// the veto on an empty-criteria story — the only path to passes=true is
// mark-passes(true), which the guard above already refuses.
const legacyVerify = store.setCriterionVerified('US-001', 0, true);
ok('#1: setCriterionVerified on empty-criteria story returns null (out of range)', legacyVerify === null);
// After the (no-op) verify attempt, passes must still be false — no path set it.
const legacyAfterVerify = store.getPrdStory('US-001');
ok('#1: empty-criteria story passes STILL false after verify attempt', legacyAfterVerify.passes === false);

store.deletePrd();
console.log(`\n${'='.repeat(50)}\nPRD fixes: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
