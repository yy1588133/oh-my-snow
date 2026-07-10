/**
 * Contract tests for bounded GCF recipe (plan 006 U1–U4).
 */
import {readFileSync, existsSync} from 'fs';
import {join} from 'path';

const root = process.cwd();
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

const skillPath = join(root, 'assets/skills/oms/gcf/SKILL.md');
const cmdPath = join(root, 'assets/commands/oms/gcf.json');

assert('U1 skill file exists', existsSync(skillPath));
assert('U2 command file exists', existsSync(cmdPath));

const skill = existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : '';
const cmdRaw = existsSync(cmdPath) ? readFileSync(cmdPath, 'utf-8') : '';

assert('U1 frontmatter name gcf', /^---\r?\nname:\s*gcf\r?\n/m.test(skill));
assert('U1 maxRounds = 3', /maxRounds\s*=\s*3|maxRounds:\s*3/i.test(skill));
assert('U1 P0/P1 dry rule', /P0/.test(skill) && /P1/.test(skill));
assert('U1 hitCeiling present', /hitCeiling/.test(skill));
assert('U1 independent #oms_critic', /#oms_critic/.test(skill));
assert(
	'U1 forbid self-review success',
	/禁止.*自审|never main-agent self-review|禁止主代理自审/i.test(skill),
);
assert('U1 issues fields', /"id"/.test(skill) && /severity/.test(skill) && /status/.test(skill));
assert(
	'U1 no auto submit-gate/done',
	/submit-gate/.test(skill) && /set-stage done|oms-set-stage done/.test(skill),
);
assert('U3 no-session path', /session:\s*none|无会话|no-session|session: none/i.test(skill));
assert('U1 aborted on no scope', /aborted/.test(skill) && /非 git|no git|非 git/i.test(skill));

let cmd;
try {
	cmd = JSON.parse(cmdRaw);
} catch {
	cmd = null;
}
assert('U2 command JSON parses', cmd != null);
assert('U2 name oms:gcf', cmd?.name === 'oms:gcf');
assert('U2 skill-execute oms/gcf', typeof cmd?.command === 'string' && cmd.command.includes('oms/gcf'));
assert('U2 mentions maxRounds or 3', /maxRounds\s*=\s*3|最多 3/.test(cmd?.command + cmd?.description));
assert('U2 mentions #oms_critic', /#oms_critic/.test(cmd?.command ?? ''));

const readme = readFileSync(join(root, 'README.md'), 'utf-8');
assert('U4 README mentions /oms:gcf', /\/oms:gcf/.test(readme));
assert('U4 README skills count 11', /11 skills/.test(readme));
assert('U4 README commands count 20', /20 commands/.test(readme));

const help = readFileSync(join(root, 'assets/commands/oms/help.json'), 'utf-8');
assert('U4 help mentions gcf', /oms:gcf|\/oms:gcf/.test(help));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
assert(
	'U4 package.json test includes test-gcf-recipe',
	typeof pkg.scripts?.test === 'string' && pkg.scripts.test.includes('test-gcf-recipe'),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
