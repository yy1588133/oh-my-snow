/**
 * Smoke tests for oms doctor / version (maturity U9).
 * Invokes dist/installer.js as a CLI.
 */
import {spawnSync} from 'child_process';
import {join} from 'path';
import {existsSync} from 'fs';

const installer = join(process.cwd(), 'dist', 'installer.js');
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

assert('dist/installer.js exists', existsSync(installer));

const version = spawnSync(process.execPath, [installer, 'version'], {
	encoding: 'utf-8',
	timeout: 15000,
});
assert(
	'oms version exit 0',
	version.status === 0,
	`status=${version.status} stderr=${version.stderr}`,
);
assert(
	'oms version prints oh-my-snow',
	/oh-my-snow\s+\d+\.\d+\.\d+/.test(version.stdout),
	version.stdout.slice(0, 200),
);

const doctor = spawnSync(process.execPath, [installer, 'doctor'], {
	encoding: 'utf-8',
	timeout: 20000,
});
// doctor may exit 1 if global install incomplete — still must print checks
assert(
	'oms doctor prints header',
	/OMS doctor/i.test(doctor.stdout + doctor.stderr),
	(doctor.stdout + doctor.stderr).slice(0, 300),
);
assert(
	'oms doctor mentions package or FAIL lines',
	/package|FAIL|OK/i.test(doctor.stdout + doctor.stderr),
);

console.log(`\nDoctor: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
