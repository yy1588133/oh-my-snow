// Verify isDirectInvocation() fix under Windows + npm global symlink.
// Reproduces the exact scenario: oms.cmd passes symlink path as argv[1],
// ESM import.meta.url resolves to real path. Pre-fix: equal=false (silent no-op).
// Post-fix: equal=true (setup runs).
//
// This imports the COMPILED dist/installer.js (not src) to test what actually
// ships. Run after `npm run build`.
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {dirname, resolve} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/ is one level below the package root; dist/ lives at package root.
const installerJs = resolve(__dirname, '..', 'dist/installer.js');

// Spawn node with argv[1] = the symlink path (what oms.cmd does on this machine).
// The symlink is at <npm-global>/node_modules/oh-my-snow → this dev dir.
// We construct the symlink path from the known npm global location.
const NPM_GLOBAL = 'D:\\Program Files (x86)\\nvm\\v24.12.0';
const symlinkArgv1 = `${NPM_GLOBAL}\\node_modules\\oh-my-snow\\dist\\installer.js`;

let pass = 0, fail = 0;
function assert(name, cond, detail = '') {
	console.log(`${cond ? '✅ PASS' : '❌ FAIL'}: ${name}${detail ? ' ' + detail : ''}`);
	cond ? pass++ : fail++;
}

// 1. `oms setup` via symlink path → should print banner (not silent).
{
	const res = spawnSync(process.execPath, [symlinkArgv1, 'setup'], {
		encoding: 'utf-8',
		timeout: 30000,
	});
	const out = res.stdout || '';
	assert(
		'oms setup via symlink path prints banner',
		out.includes('Oh-My-Snow') || out.includes('setup') || out.includes('╗') || out.includes('安装'),
		`stdout=${JSON.stringify(out.slice(0, 120))} stderr=${JSON.stringify((res.stderr||'').slice(0,200))} exit=${res.status}`,
	);
}

// 2. `oms help` via symlink path → should print help title.
{
	const res = spawnSync(process.execPath, [symlinkArgv1, 'help'], {
		encoding: 'utf-8',
		timeout: 30000,
	});
	const out = res.stdout || '';
	assert(
		'oms help via symlink path prints help text',
		out.includes('Usage') || out.includes('Commands') || out.includes('help') || out.includes('用法') || out.includes('命令'),
		`stdout=${JSON.stringify(out.slice(0, 120))} exit=${res.status}`,
	);
}

// 3. Direct real-path invocation still works (non-symlink case, e.g. local dev `node dist/installer.js`).
{
	const res = spawnSync(process.execPath, [installerJs, 'help'], {
		encoding: 'utf-8',
		timeout: 30000,
	});
	const out = res.stdout || '';
	assert(
		'direct real-path invocation still works',
		out.includes('Usage') || out.includes('Commands') || out.includes('用法') || out.includes('命令'),
		`stdout=${JSON.stringify(out.slice(0, 120))} exit=${res.status}`,
	);
}

console.log(`\nisDirectInvocation fix: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
