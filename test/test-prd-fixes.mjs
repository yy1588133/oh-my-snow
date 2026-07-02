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
console.log(`\n${'='.repeat(50)}\nPRD fixes: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
