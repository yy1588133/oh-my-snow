// Verify isDirectInvocation() fix under npm-global-style symlink.
// Reproduces: launcher passes symlink path as argv[1], ESM import.meta.url
// resolves to the real path. Pre-fix: equal=false (silent no-op).
// Post-fix: equal=true (CLI runs).
//
// Tests the COMPILED dist/installer.js (what ships). Run after `npm run build`.
// Uses a temp package-dir symlink so CI/Linux and any machine work — no
// hardcoded developer npm-global path.
import {spawnSync} from 'child_process';
import {randomBytes} from 'crypto';
import {existsSync, mkdirSync, rmSync, symlinkSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join, resolve} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const installerJs = resolve(packageRoot, 'dist', 'installer.js');

if (!existsSync(installerJs)) {
	console.error('❌ dist/installer.js missing — run `npm run build` first.');
	process.exit(1);
}

// Fake npm-global layout: <tmp>/node_modules/oh-my-snow → package root.
// On Windows use a junction (no admin). On POSIX use a directory symlink.
const tmpRoot = join(tmpdir(), `oms-direct-inv-${randomBytes(4).toString('hex')}`);
const fakePkg = join(tmpRoot, 'node_modules', 'oh-my-snow');
mkdirSync(dirname(fakePkg), {recursive: true});
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
symlinkSync(packageRoot, fakePkg, linkType);

const symlinkArgv1 = join(fakePkg, 'dist', 'installer.js');
if (!existsSync(symlinkArgv1)) {
	rmSync(tmpRoot, {recursive: true, force: true});
	console.error('❌ Symlink layout did not expose dist/installer.js');
	process.exit(1);
}

let pass = 0, fail = 0;
function assert(name, cond, detail = '') {
	console.log(`${cond ? '✅ PASS' : '❌ FAIL'}: ${name}${detail ? ' ' + detail : ''}`);
	cond ? pass++ : fail++;
}

try {
	// 1. `oms help` via symlink path → should print help (not silent no-op).
	// Prefer help over setup: proves isDirectInvocation without mutating ~/.snow.
	{
		const res = spawnSync(process.execPath, [symlinkArgv1, 'help'], {
			encoding: 'utf-8',
			timeout: 30000,
		});
		const out = res.stdout || '';
		assert(
			'oms help via symlink path prints help text',
			out.includes('Usage') || out.includes('Commands') || out.includes('help') || out.includes('用法') || out.includes('命令'),
			`stdout=${JSON.stringify(out.slice(0, 120))} stderr=${JSON.stringify((res.stderr || '').slice(0, 200))} exit=${res.status}`,
		);
	}

	// 2. `oms version` via symlink path → should print package name/version.
	{
		const res = spawnSync(process.execPath, [symlinkArgv1, 'version'], {
			encoding: 'utf-8',
			timeout: 30000,
		});
		const out = res.stdout || '';
		assert(
			'oms version via symlink path prints package id',
			out.includes('oh-my-snow') || /\d+\.\d+\.\d+/.test(out),
			`stdout=${JSON.stringify(out.slice(0, 120))} stderr=${JSON.stringify((res.stderr || '').slice(0, 200))} exit=${res.status}`,
		);
	}

	// 3. Direct real-path invocation still works (local dev `node dist/installer.js`).
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
} finally {
	rmSync(tmpRoot, {recursive: true, force: true});
}

console.log(`\nisDirectInvocation fix: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
