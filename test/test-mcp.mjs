import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Isolate ALL state to a temp dir so the test never touches the real
// .snow/settings.json or .snow/oms-state/ of the package directory.
// setProjectTeamMode (called by oms-set-team) writes <cwd>/.snow/settings.json,
// so cwd MUST point at the temp dir too. But the server script path must be
// ABSOLUTE — otherwise node resolves it relative to cwd (the temp dir) and fails.
const tmpRoot = mkdtempSync(join(tmpdir(), 'oms-mcp-test-'));
const serverScript = resolve('dist/mcp-server.js');
const child = spawn('node', [serverScript], {
	stdio: ['pipe', 'pipe', 'pipe'],
	cwd: tmpRoot,
	env: { ...process.env, OMS_STATE_DIR: join(tmpRoot, '.snow', 'oms-state') },
});

let buffer = '';
child.stdout.on('data', (data) => { buffer += data.toString(); });
child.stderr.on('data', (data) => { console.error('STDERR:', data.toString()); });

let msgId = 0;
function send(method, params) {
	const msg = JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params });
	child.stdin.write(msg + '\n');
}

function sendNotif(method, params) {
	const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
	child.stdin.write(msg + '\n');
}

let pass = 0, fail = 0;
function assert(name, condition, detail = '') {
	if (condition) {
		console.log(`✅ PASS: ${name}`);
		pass++;
	} else {
		console.log(`❌ FAIL: ${name} ${detail}`);
		fail++;
	}
}

async function waitForResponse(id, timeout = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const lines = buffer.split('\n').filter(l => l.trim());
			for (const line of lines) {
				try {
					const msg = JSON.parse(line);
					if (msg.id === id) return msg;
				} catch {}
			}
		} catch {}
		await new Promise(r => setTimeout(r, 100));
	}
	return null;
}

async function runTests() {
	// Initialize
	send('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'test', version: '1.0' }
	});
	await waitForResponse(1);
	sendNotif('notifications/initialized', {});

	// Tool: oms-start
	send('tools/call', { name: 'oms-start', arguments: { goal: 'Build a REST API', verifyCommand: 'npm test' } });
	const r1 = await waitForResponse(2);
	assert('oms-start returns content', r1?.result?.content?.length > 0, JSON.stringify(r1).slice(0, 200));
	assert('oms-start mentions session started', r1?.result?.content?.[0]?.text?.includes('OMS session started'), JSON.stringify(r1).slice(0, 200));

	// Tool: oms-add-task
	send('tools/call', { name: 'oms-add-task', arguments: { description: 'Create Express server' } });
	const r2 = await waitForResponse(3);
	assert('oms-add-task returns content', r2?.result?.content?.length > 0);

	// Tool: oms-add-task (second task)
	send('tools/call', { name: 'oms-add-task', arguments: { description: 'Add authentication middleware' } });
	await waitForResponse(4);

	// Tool: oms-get-state
	send('tools/call', { name: 'oms-get-state', arguments: {} });
	const r3 = await waitForResponse(5);
	assert('oms-get-state shows planning stage', r3?.result?.content?.[0]?.text?.includes('planning'), JSON.stringify(r3).slice(0, 200));
	assert('oms-get-state shows 2 tasks', r3?.result?.content?.[0]?.text?.includes('2/2') || r3?.result?.content?.[0]?.text?.includes('0/2'), JSON.stringify(r3).slice(0, 300));

	// Tool: oms-set-stage (planning → executing)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'executing' } });
	const r4 = await waitForResponse(6);
	assert('oms-set-stage planning→executing', r4?.result?.content?.[0]?.text?.includes('executing'), JSON.stringify(r4).slice(0, 200));

	// Tool: oms-set-stage (invalid transition: executing → done)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'done' } });
	const r5 = await waitForResponse(7);
	assert('oms-set-stage executing→done rejected', r5?.result?.isError === true, JSON.stringify(r5).slice(0, 200));

	// Tool: oms-complete-task
	send('tools/call', { name: 'oms-complete-task', arguments: { taskId: 'task_1' } });
	const r6 = await waitForResponse(8);
	assert('oms-complete-task task_1', r6?.result?.content?.[0]?.text?.includes('completed'), JSON.stringify(r6).slice(0, 200));

	// Tool: oms-snapshot save
	send('tools/call', { name: 'oms-snapshot', arguments: { action: 'save', key: 'checkpoint1', data: '{"progress":"50%"}' } });
	const r7 = await waitForResponse(9);
	assert('oms-snapshot save', r7?.result?.content?.[0]?.text?.includes('saved'), JSON.stringify(r7).slice(0, 200));

	// Tool: oms-snapshot list
	send('tools/call', { name: 'oms-snapshot', arguments: { action: 'list' } });
	const r8 = await waitForResponse(10);
	assert('oms-snapshot list shows checkpoint1', r8?.result?.content?.[0]?.text?.includes('checkpoint1'), JSON.stringify(r8).slice(0, 200));

	// Complete remaining task + task-complete gate before verifying
	send('tools/call', { name: 'oms-complete-task', arguments: { taskId: 'task_2' } });
	await waitForResponse(11);
	send('tools/call', {
		name: 'oms-prd',
		arguments: {
			action: 'submit-gate',
			scope: 'task-complete',
			scorecard: JSON.stringify({
				pass: true,
				summary: 'all tasks done',
				evidence: ['task_1', 'task_2'],
			}),
		},
	});
	const rGate1 = await waitForResponse(12);
	assert('submit-gate task-complete', rGate1?.result?.isError !== true, JSON.stringify(rGate1).slice(0, 200));

	// Tool: oms-set-stage (executing → verifying)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'verifying' } });
	const r9 = await waitForResponse(13);
	assert('oms-set-stage executing→verifying', r9?.result?.content?.[0]?.text?.includes('verifying'), JSON.stringify(r9).slice(0, 200));

	// Dual gates + completion before done
	send('tools/call', {
		name: 'oms-prd',
		arguments: {
			action: 'submit-gate',
			scope: 'task-reconcile',
			scorecard: JSON.stringify({
				pass: true,
				summary: 'tasks match goal',
				evidence: ['reviewed tasks'],
			}),
		},
	});
	await waitForResponse(14);
	send('tools/call', {
		name: 'oms-prd',
		arguments: { action: 'request-verification', scope: 'code-quality' },
	});
	const rCq = await waitForResponse(15);
	const cqId = (rCq?.result?.content?.[0]?.text ?? '').match(/requestId: ([a-f0-9-]+)/)?.[1];
	const qualityCard = JSON.stringify({
		pass: true,
		summary: 'quality ok',
		evidence: ['npm test green'],
		diffStat: '2 files changed',
	});
	send('tools/call', {
		name: 'oms-prd',
		arguments: {
			action: 'submit-approval',
			requestId: cqId,
			verdict: 'approved',
			feedback: 'quality ok',
			reviewerAgentId: 'oms_reviewer',
			scorecard: qualityCard,
		},
	});
	await waitForResponse(16);
	send('tools/call', {
		name: 'oms-prd',
		arguments: { action: 'request-verification', scope: 'completion' },
	});
	const rComp = await waitForResponse(17);
	const compId = (rComp?.result?.content?.[0]?.text ?? '').match(/requestId: ([a-f0-9-]+)/)?.[1];
	send('tools/call', {
		name: 'oms-prd',
		arguments: {
			action: 'submit-approval',
			requestId: compId,
			verdict: 'approved',
			feedback: 'session complete',
			reviewerAgentId: 'oms_critic',
			scorecard: JSON.stringify({
				pass: true,
				summary: 'session complete',
				evidence: ['all gates green'],
			}),
		},
	});
	await waitForResponse(18);

	// Tool: oms-set-stage (verifying → done)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'done' } });
	const r10 = await waitForResponse(19);
	assert('oms-set-stage verifying→done', r10?.result?.content?.[0]?.text?.includes('done'), JSON.stringify(r10).slice(0, 200));

	// Tool: oms-set-team (US-002/003 — records team name reference for /oms:team multi-agent mode)
	// Note: state is 'done' here, but oms-set-team only mutates teamName (no stage transition) so it works in any stage.
	send('tools/call', { name: 'oms-set-team', arguments: { teamName: 'refactor-utils' } });
	const r10b = await waitForResponse(20);
	assert('oms-set-team returns success', r10b?.result?.content?.[0]?.text?.includes('Team name set'), JSON.stringify(r10b).slice(0, 200));
	assert('oms-set-team mentions team name', r10b?.result?.content?.[0]?.text?.includes('refactor-utils'), JSON.stringify(r10b).slice(0, 200));

	// Tool: oms-get-state should now show the teamName
	send('tools/call', { name: 'oms-get-state', arguments: {} });
	const r10c = await waitForResponse(21);
	assert('oms-get-state shows teamName', r10c?.result?.content?.[0]?.text?.includes('Team:') && r10c?.result?.content?.[0]?.text?.includes('refactor-utils'), JSON.stringify(r10c).slice(0, 300));

	// ── setProjectTeamMode verification (US-team-activation) ──
	// oms-set-team must have written teamMode=true to <cwd>/.snow/settings.json.
	// This is the critical activation link: without it, snow-cli never mounts team-* tools.
	const settingsPath = join(tmpRoot, '.snow', 'settings.json');
	assert('settings.json was created by oms-set-team', existsSync(settingsPath), 'settings.json missing');

	let settingsOk = false;
	let settingsTeamMode = undefined;
	let settingsPreserved = true;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
		settingsTeamMode = settings.teamMode;
		settingsOk = settings.teamMode === true;
		// teamMode should NOT be the only field — OMS must not clobber existing settings.
		// (Here the file didn't exist before, so only teamMode is present — that's fine.
		// The preservation guarantee is tested by the pre-existing-fields test below.)
	} catch (e) {
		settingsOk = false;
	}
	assert('oms-set-team wrote teamMode=true to settings.json', settingsOk, `teamMode=${settingsTeamMode}`);

	// Verify oms-set-team response mentions the next-turn tool visibility (key UX cue)
	assert('oms-set-team warns team-* tools appear next turn', r10b?.result?.content?.[0]?.text?.includes('NEXT turn'), JSON.stringify(r10b).result?.content?.[0]?.text?.slice(0, 300));

	// ── Field preservation test: pre-existing settings.json fields must survive the write ──
	// Stop the session, pre-seed settings.json with extra fields, start a new session,
	// call oms-set-team again, and confirm the extra fields are still there.
	send('tools/call', { name: 'oms-stop', arguments: {} });
	await waitForResponse(22);

	// Pre-seed settings.json with user fields (ensure .snow dir exists first)
	mkdirSync(join(tmpRoot, '.snow'), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({
		yoloMode: true,
		planMode: true,
		customUserField: 'preserve-me',
		nested: { keep: 'yes' },
	}, null, 2), 'utf-8');

	// New session
	send('tools/call', { name: 'oms-start', arguments: { goal: 'team activation 2' } });
	await waitForResponse(23);
	send('tools/call', { name: 'oms-set-team', arguments: { teamName: 'team-b' } });
	const rPreserve = await waitForResponse(24);

	let preservedOk = false;
	let preservedDetail = '';
	try {
		const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
		preservedOk = settings.teamMode === true
			&& settings.yoloMode === true
			&& settings.planMode === true
			&& settings.customUserField === 'preserve-me'
			&& settings.nested?.keep === 'yes';
		if (!preservedOk) preservedDetail = JSON.stringify(settings).slice(0, 300);
	} catch (e) {
		preservedDetail = `parse error: ${e.message}`;
	}
	assert('oms-set-team preserves pre-existing settings.json fields', preservedOk, preservedDetail);

	// ── Idempotency test: calling oms-set-team when teamMode already true should not error ──
	send('tools/call', { name: 'oms-set-team', arguments: { teamName: 'team-b' } });
	const rIdem = await waitForResponse(25);
	assert('oms-set-team idempotent (second call still succeeds)', rIdem?.result?.content?.[0]?.text?.includes('Team name set'), JSON.stringify(rIdem).slice(0, 200));

	// Tool: oms-stop (final cleanup of the second session)
	send('tools/call', { name: 'oms-stop', arguments: {} });
	const r11 = await waitForResponse(26);
	assert('oms-stop ends session', r11?.result?.content?.[0]?.text?.includes('stopped'), JSON.stringify(r11).slice(0, 200));

	console.log(`\n${'='.repeat(50)}`);
	console.log(`Results: ${pass} passed, ${fail} failed`);

	child.kill();
	// Clean up the temp dir (state + settings.json isolation)
	try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
	process.exit(fail > 0 ? 1 : 0);
}

setTimeout(runTests, 500);
