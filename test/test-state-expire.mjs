// US-003: Phase 2 三时间戳 TTL 状态过期判断
// Tests (per plan Step 2.4):
//  1. 活跃 state (updatedAt 刚刚) 正常返回
//  2. 僵尸 state (三时间戳都老 >2h) 返回 null + 写 errors.log
//  3. state.json 老但 prd.json 新 (PRD 循环活跃) 正常返回 (三时间戳取最新)
//  4. 过期文件不被删 (保守留证据)
//  5. 双写一致性: 同一过期 state 跑 store.ts loadState 和 oms-state.mjs loadState,
//     都返回 null; 同一老 state (无 maxIterations) 两边都补默认值
//
// 时间控制: loadState 读 state.updatedAt / prd.updatedAt / stageHistory 末尾
// timestamp (JSON 字段), 不读文件 mtime. 所以直接写老 ISO timestamp 到 JSON.
import {mkdtempSync, writeFileSync, readFileSync, existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {spawnSync} from 'child_process';

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// ── helper: 写 state.json + prd.json 到指定 dir ──
function writeStateFiles(dir, stateObj, prdObj) {
	writeFileSync(join(dir, 'state.json'), JSON.stringify(stateObj, null, 2), 'utf8');
	if (prdObj !== undefined) {
		writeFileSync(join(dir, 'prd.json'), JSON.stringify(prdObj, null, 2), 'utf8');
	}
}

const HOURS_AGO = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const NOW = () => new Date().toISOString();

const baseState = {
	sessionId: 'oms_expire_test',
	stage: 'executing',
	goal: 'expire test',
	verifyCommand: '',
	tasks: [],
	turnCount: 1,
	stageHistory: [{stage: 'executing', timestamp: NOW()}],
	logs: [],
	snapshots: [],
	maxIterations: 50,
	hardMaxIterations: 200,
};

// ── 1. 活跃 state (updatedAt 刚刚) 正常返回 ──
const dir1 = mkdtempSync(join(tmpdir(), 'oms-expire-active-'));
process.env.OMS_STATE_DIR = dir1;
writeStateFiles(dir1, {...baseState, updatedAt: NOW(), createdAt: NOW()});
const store = await import('../dist/state/store.js');
const activeState = store.loadState();
ok('活跃 state: loadState 返回非 null', activeState !== null);
ok('活跃 state: stage 正确', activeState && activeState.stage === 'executing');

// ── 2. 僵尸 state (三时间戳都老 >2h) 返回 null + 写 errors.log ──
const dir2 = mkdtempSync(join(tmpdir(), 'oms-expire-stale-'));
process.env.OMS_STATE_DIR = dir2;
const staleTs = HOURS_AGO(5); // 5h ago, > 2h TTL
writeStateFiles(dir2, {
	...baseState,
	updatedAt: staleTs,
	createdAt: staleTs,
	stageHistory: [{stage: 'executing', timestamp: staleTs}],
}, {refined: true, updatedAt: staleTs, stories: []});
// 清空 errors.log (前面测试可能写过)
const errLogPath = join(dir2, 'errors.log');
if (existsSync(errLogPath)) writeFileSync(errLogPath, '', 'utf8');
const staleState = store.loadState();
ok('僵尸 state (三时间戳都老): loadState 返回 null', staleState === null);
ok('僵尸 state: errors.log 写了 stale 记录',
	existsSync(errLogPath) && readFileSync(errLogPath, 'utf8').includes('stale state ignored'));
ok('僵尸 state: errors.log 含 age 分钟数',
	existsSync(errLogPath) && readFileSync(errLogPath, 'utf8').match(/age \d+min/));

// ── 3. state.json 老但 prd.json 新 (PRD 循环活跃) 正常返回 ──
// 三时间戳取最新: state.updatedAt 老 (5h) + prd.updatedAt 新 (刚刚) → 最新 = 新 → 不过期
const dir3 = mkdtempSync(join(tmpdir(), 'oms-expire-prdnew-'));
process.env.OMS_STATE_DIR = dir3;
const oldTs = HOURS_AGO(5);
writeStateFiles(dir3, {
	...baseState,
	updatedAt: oldTs,
	createdAt: oldTs,
	stageHistory: [{stage: 'executing', timestamp: oldTs}],
}, {refined: true, updatedAt: NOW(), stories: []});
const prdFreshState = store.loadState();
ok('state 老 + prd 新: loadState 返回非 null (三时间戳取最新, PRD 活跃)', prdFreshState !== null);

// ── 3b. state.json 老 + stageHistory 末尾新 → 正常返回 (第三时间戳救命) ──
const dir3b = mkdtempSync(join(tmpdir(), 'oms-expire-histnew-'));
process.env.OMS_STATE_DIR = dir3b;
writeStateFiles(dir3b, {
	...baseState,
	updatedAt: oldTs,
	createdAt: oldTs,
	stageHistory: [
		{stage: 'planning', timestamp: oldTs},
		{stage: 'executing', timestamp: NOW()}, // 最新 stage 切换是新的
	],
}, {refined: true, updatedAt: oldTs, stories: []});
const histFreshState = store.loadState();
ok('state.updatedAt 老 + stageHistory 末尾新: loadState 返回非 null (t3 救命)', histFreshState !== null);

// ── 4. 过期文件不被删 (保守留证据) ──
ok('过期 state.json 文件保留 (不自动删)', existsSync(join(dir2, 'state.json')));

// ── 5. 双写一致性: 同一过期 state 跑 store.ts + oms-state.mjs, 都返回 null ──
const omsState = await import('../hooks/lib/oms-state.mjs');

// 5a. 过期 state: 两边都返回 null
const dir5a = mkdtempSync(join(tmpdir(), 'oms-expire-dual-stale-'));
writeStateFiles(dir5a, {
	...baseState,
	updatedAt: staleTs,
	createdAt: staleTs,
	stageHistory: [{stage: 'executing', timestamp: staleTs}],
}, {refined: true, updatedAt: staleTs, stories: []});
process.env.OMS_STATE_DIR = dir5a;
const storeStale = store.loadState();
const hookStale = omsState.loadState();
ok('双写一致性: 过期 state — store.ts 返回 null', storeStale === null);
ok('双写一致性: 过期 state — oms-state.mjs 返回 null', hookStale === null);

// 5b. 老 state (无 maxIterations) — 两边都补默认值 (不因 TTL 误杀新鲜的老结构)
const dir5b = mkdtempSync(join(tmpdir(), 'oms-expire-dual-legacy-'));
const legacyState = {
	sessionId: 'oms_legacy',
	stage: 'executing',
	goal: 'legacy test',
	verifyCommand: '',
	tasks: [],
	turnCount: 1,
	stageHistory: [{stage: 'executing', timestamp: NOW()}],
	logs: [],
	snapshots: [],
	updatedAt: NOW(),
	createdAt: NOW(),
	// 故意不写 maxIterations / hardMaxIterations
};
writeStateFiles(dir5b, legacyState, undefined);
process.env.OMS_STATE_DIR = dir5b;
const storeLegacy = store.loadState();
const hookLegacy = omsState.loadState();
ok('双写一致性: 老 state — store.ts 补 maxIterations=50',
	storeLegacy && storeLegacy.maxIterations === 50);
ok('双写一致性: 老 state — oms-state.mjs 补 maxIterations=50',
	hookLegacy && hookLegacy.maxIterations === 50);
ok('双写一致性: 老 state — store.ts 补 hardMaxIterations=200',
	storeLegacy && storeLegacy.hardMaxIterations === 200);
ok('双写一致性: 老 state — oms-state.mjs 补 hardMaxIterations=200',
	hookLegacy && hookLegacy.hardMaxIterations === 200);

// 5c. 活跃 state: 两边都返回非 null
process.env.OMS_STATE_DIR = dir1;
const storeActive = store.loadState();
const hookActive = omsState.loadState();
ok('双写一致性: 活跃 state — store.ts 返回非 null', storeActive !== null);
ok('双写一致性: 活跃 state — oms-state.mjs 返回非 null', hookActive !== null);

// ── US-004: on-stop.mjs exit 区分三种情况 ──
// spawnSync 跑 hook (非 execFileSync, 因 exit 0 时 execFileSync 丢 stderr)
const hookPath = join(process.cwd(), 'hooks', 'on-stop.mjs');

function runOnStop(stateDir) {
	const r = spawnSync('node', [hookPath], {
		input: JSON.stringify({messages: []}),
		env: {...process.env, OMS_STATE_DIR: stateDir},
		encoding: 'utf8',
		timeout: 15000,
	});
	return {
		exitCode: r.status,
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
	};
}

// 6a. 无 state.json: 静默 exit 0, stderr 无 EXPIRED/CORRUPT
const dir6a = mkdtempSync(join(tmpdir(), 'oms-onstop-absent-'));
const r6a = runOnStop(dir6a);
ok('on-stop 无文件: exit 0', r6a.exitCode === 0);
ok('on-stop 无文件: stderr 不含 EXPIRED', !r6a.stderr.includes('[OMS:STATE EXPIRED]'));
ok('on-stop 无文件: stderr 不含 CORRUPT', !r6a.stderr.includes('[OMS:STATE CORRUPT]'));

// 6b. state 过期 (>2h): exit 0 + stderr [OMS:STATE EXPIRED]
const dir6b = mkdtempSync(join(tmpdir(), 'oms-onstop-expired-'));
const expiredTs = HOURS_AGO(5);
writeFileSync(join(dir6b, 'state.json'), JSON.stringify({
	...baseState,
	updatedAt: expiredTs,
	createdAt: expiredTs,
	stageHistory: [{stage: 'executing', timestamp: expiredTs}],
}, null, 2), 'utf8');
writeFileSync(join(dir6b, 'prd.json'), JSON.stringify({refined: true, updatedAt: expiredTs, stories: []}, null, 2), 'utf8');
const r6b = runOnStop(dir6b);
ok('on-stop 过期: exit 0', r6b.exitCode === 0);
ok('on-stop 过期: stderr 含 [OMS:STATE EXPIRED]', r6b.stderr.includes('[OMS:STATE EXPIRED]'));
ok('on-stop 过期: stderr 不含 CORRUPT (不误报)', !r6b.stderr.includes('[OMS:STATE CORRUPT]'));

// 6c. state 损坏 (JSON parse 失败): exit 0 + stderr [OMS:STATE CORRUPT]
const dir6c = mkdtempSync(join(tmpdir(), 'oms-onstop-corrupt-'));
writeFileSync(join(dir6c, 'state.json'), '{ this is not valid json,,,', 'utf8');
const r6c = runOnStop(dir6c);
ok('on-stop 损坏: exit 0', r6c.exitCode === 0);
ok('on-stop 损坏: stderr 含 [OMS:STATE CORRUPT]', r6c.stderr.includes('[OMS:STATE CORRUPT]'));
ok('on-stop 损坏: stderr 不含 EXPIRED (不误报)', !r6c.stderr.includes('[OMS:STATE EXPIRED]'));

// 6d. 活跃 state: on-stop 正常进循环 (exit 2, 不是 exit 0 三态分支)
// 注意: 活跃 state 会进 ralph 循环, 这里只验证它没走 EXPIRED/CORRUPT 分支
const dir6d = mkdtempSync(join(tmpdir(), 'oms-onstop-active-'));
writeFileSync(join(dir6d, 'state.json'), JSON.stringify({
	...baseState,
	updatedAt: NOW(),
	createdAt: NOW(),
	stageHistory: [{stage: 'executing', timestamp: NOW()}],
}, null, 2), 'utf8');
const r6d = runOnStop(dir6d);
ok('on-stop 活跃 state: 不走 EXPIRED 分支', !r6d.stderr.includes('[OMS:STATE EXPIRED]'));
ok('on-stop 活跃 state: 不走 CORRUPT 分支', !r6d.stderr.includes('[OMS:STATE CORRUPT]'));

console.log(`\n==================================================`);
console.log(`State expire: ${pass} passed, ${fail} failed`);
console.log(`==================================================`);
process.exit(fail > 0 ? 1 : 0);
