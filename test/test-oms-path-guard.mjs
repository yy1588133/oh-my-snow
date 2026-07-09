/**
 * Path/terminal guard pure-function tests (negative-optimization U4).
 */
import {join} from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const guard = await import(
	'file:///' + join(root, 'hooks/lib/oms-path-guard.mjs').replace(/\\/g, '/')
);

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

const cwd = root;
const stateDir = join(cwd, '.snow', 'oms-state');

// File path: block under state
ok(
	'block state.json under state dir',
	guard.isOmsStateWritePath(join(stateDir, 'state.json'), stateDir, cwd) === true,
);
ok(
	'block relative .snow/oms-state/ledger',
	guard.isOmsStateWritePath(
		'.snow/oms-state/verification-ledger.json',
		stateDir,
		cwd,
	) === true,
);

// File path: allow docs with similar names
ok(
	'allow docs verification-ledger design note',
	guard.isOmsStateWritePath(
		'docs/notes/verification-ledger-design.md',
		stateDir,
		cwd,
	) === false,
);
ok(
	'allow random oms-state folder in repo docs',
	guard.isOmsStateWritePath('docs/oms-state/readme.md', stateDir, cwd) === false,
);

// Terminal: write blocked
ok(
	'block redirect into ledger',
	guard.isOmsStateWriteCommand(
		'echo x > .snow/oms-state/verification-ledger.json',
		stateDir,
		cwd,
	) === true,
);
ok(
	'block set-content to state',
	guard.isOmsStateWriteCommand(
		'Set-Content -Path .snow/oms-state/state.json -Value "{}"',
		stateDir,
		cwd,
	) === true,
);

// Terminal: read allowed
ok(
	'allow type/read ledger',
	guard.isOmsStateWriteCommand(
		'type .snow/oms-state/verification-ledger.json',
		stateDir,
		cwd,
	) === false,
);
ok(
	'allow rg verification-ledger in docs',
	guard.isOmsStateWriteCommand('rg verification-ledger docs', stateDir, cwd) ===
		false,
);
ok(
	'allow echo to unrelated file named verification-ledger',
	guard.isOmsStateWriteCommand(
		'echo x > docs/notes/verification-ledger-design.md',
		stateDir,
		cwd,
	) === false,
);

console.log(`\noms-path-guard: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
