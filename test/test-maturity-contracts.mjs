/**
 * Maturity Top-10 static + unit contracts (plan U1–U6, U10).
 */
import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import {pathToFileURL} from 'url';

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

// U1: onStop host timeout lockstep
const onStop = JSON.parse(
	readFileSync(join(root, 'assets/hooks/onStop.json'), 'utf-8'),
);
const hostTimeout = onStop[0]?.hooks?.[0]?.timeout;
assert('U1 onStop.json timeout is 330000', hostTimeout === 330000, `got ${hostTimeout}`);

const onStopSrc = readFileSync(join(root, 'hooks/on-stop.mjs'), 'utf-8');
const verifyMsMatch = onStopSrc.match(/VERIFY_TIMEOUT_MS\s*=\s*(\d+)/);
const verifyMs = verifyMsMatch ? Number(verifyMsMatch[1]) : null;
assert('U1 VERIFY_TIMEOUT_MS named constant present', verifyMs === 300000, `got ${verifyMs}`);
assert(
	'U1 host timeout >= verify + 30000',
	hostTimeout != null && verifyMs != null && hostTimeout >= verifyMs + 30000,
);

// U2: || ban in store + on-stop
const storeSrc = readFileSync(join(root, 'src/state/store.ts'), 'utf-8');
assert('U2 store.ts bans ||', storeSrc.includes("includes('||')"));
assert('U2 on-stop.mjs bans ||', onStopSrc.includes("includes('||')"));

// U3: no skill-execute oms/auto|team
const skillFiles = [
	'assets/skills/oms/interview/SKILL.md',
	'assets/skills/oms/dive/SKILL.md',
	'assets/skills/oms/plan/SKILL.md',
];
let bridgeHits = 0;
for (const rel of skillFiles) {
	const p = join(root, rel);
	if (!existsSync(p)) continue;
	const text = readFileSync(p, 'utf-8');
	// Target only skill-execute payloads that name oms/auto|team as a skill id.
	const re = /skill:\s*["']oms\/(auto|team)["']/g;
	const m = text.match(re);
	if (m) bridgeHits += m.length;
}
assert('U3 no skill-execute oms/auto|team in skills', bridgeHits === 0, `hits=${bridgeHits}`);

// U6: optimizer tools + no debugger
const agents = JSON.parse(
	readFileSync(join(root, 'assets/agents/sub-agents.json'), 'utf-8'),
);
const optimizer = agents.agents.find(a => a.id === 'oms_optimizer');
assert('U6 optimizer has filesystem-edit', optimizer?.tools?.includes('filesystem-edit'));
assert(
	'U6 no oms_debugger in agents JSON',
	!JSON.stringify(agents).includes('oms_debugger'),
);
assert('U6 still 18 agents', agents.agents.length === 18);

// Live unit: validateVerifyCommand
const storePath = join(root, 'dist/state/store.js');
const store = await import(pathToFileURL(storePath).href);

function expectReject(label, cmd) {
	let threw = false;
	try {
		store.validateVerifyCommand(cmd);
	} catch {
		threw = true;
	}
	assert(label, threw);
}
function expectAllow(label, cmd) {
	try {
		store.validateVerifyCommand(cmd);
		assert(label, true);
	} catch (e) {
		assert(label, false, e.message);
	}
}
expectAllow('U2 allow &&', 'npm run build && npm test');
expectReject('U2 reject || true', 'npm test || true');

console.log(`\nMaturity contracts: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
