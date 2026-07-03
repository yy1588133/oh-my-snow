// US-007 补强 (reviewer HIGH 修复): completion gate 在 mcp-server 工具层验证
// test-prd-verification.mjs #11 只测了 store 层 hasMatchingApproval 语义,
// 没测真正的 oms-set-stage 工具 handler (mcp-server.ts:274-289). R11 是 architect
// CRITICAL 修复, gate 在工具层 — 必须在工具层测, 否则未来重构 mcp-server.ts:274
// 的 gate 检查的回归不会被捕获.
//
// 测两种情况:
//  1. 有 completion-scope approved → oms-set-stage:done 成功
//  2. 无 completion approval (或只有 story-scope) → oms-set-stage:done 被拒 (isError)
//
// 用 stdio MCP 协议直接调 oms-set-stage 工具, 与 test-mcp.mjs 同模式.
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

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

async function waitForResponse(buffer_ref, id, timeout = 5000) {
	// buffer_ref is a {val: string} holder we mutate from stdout
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const lines = buffer_ref.val.split('\n').filter(l => l.trim());
		for (const line of lines) {
			try {
				const msg = JSON.parse(line);
				if (msg.id === id) return msg;
			} catch {}
		}
		await new Promise(r => setTimeout(r, 100));
	}
	return null;
}

function makeServer(tmpRoot) {
	const serverScript = resolve('dist/mcp-server.js');
	const child = spawn('node', [serverScript], {
		stdio: ['pipe', 'pipe', 'pipe'],
		cwd: tmpRoot,
		env: { ...process.env, OMS_STATE_DIR: join(tmpRoot, '.snow', 'oms-state') },
	});
	const buf = { val: '' };
	child.stdout.on('data', (data) => { buf.val += data.toString(); });
	child.stderr.on('data', () => {}); // suppress
	let msgId = 0;
	const send = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params }) + '\n');
	const sendNotif = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
	return { child, buf, send, sendNotif, waitForResponse: (id) => waitForResponse(buf, id) };
}

async function runScenario(label, setupFn) {
	const tmpRoot = mkdtempSync(join(tmpdir(), `oms-gate-${label}-`));
	const { child, send, sendNotif, waitForResponse } = makeServer(tmpRoot);
	try {
		send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
		await waitForResponse(1);
		sendNotif('notifications/initialized', {});

		// oms-start + init PRD + refine + verify all criteria + go to verifying
		send('tools/call', { name: 'oms-start', arguments: { goal: 'gate test', verifyCommand: 'npm test' } });
		await waitForResponse(2);
		send('tools/call', { name: 'oms-prd', arguments: { action: 'init', task: 'gate test' } });
		await waitForResponse(3);
		send('tools/call', { name: 'oms-prd', arguments: { action: 'refine', task: 'gate test', stories: [{ title: 'S1', acceptanceCriteria: ['c1'], priority: 1 }] } });
		await waitForResponse(4);
		send('tools/call', { name: 'oms-prd', arguments: { action: 'verify-criterion', storyId: 'US-001', criterionIndex: 0, verified: true } });
		await waitForResponse(5);
		send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'executing' } });
		await waitForResponse(6);
		send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'verifying' } });
		await waitForResponse(7);

		// Now at 'verifying'. setupFn sets up verification state (story/completion approved or not)
		// then we call oms-set-stage:done and check the result.
		const doneId = await setupFn({ send, waitForResponse, startId: 8 });
		const result = await waitForResponse(doneId);
		return result;
	} finally {
		try { child.kill(); } catch {}
	}
}

async function main() {
	// ── Scenario A: 无 completion approval → oms-set-stage:done 被拒 ──
	// 没有 verification-state.json (过渡期豁免) — 但等等, 豁免会让 gate 放行!
	// 所以这个场景必须建一个 verification-state.json (非豁免), 但只 approve story-scope,
	// completion gate 仍应拒.
	const resA = await runScenario('blocked', async ({ send, waitForResponse, startId }) => {
		// 建 verification-state.json: request story-scope + approve (但不是 completion)
		send('tools/call', { name: 'oms-prd', arguments: { action: 'request-verification', storyId: 'US-001', scope: 'story' } });
		const rReq = await waitForResponse(startId); // 8
		// 提取 requestId
		const reqText = rReq?.result?.content?.[0]?.text ?? '';
		const m = reqText.match(/requestId: ([a-f0-9-]+)/);
		const requestId = m ? m[1] : null;
		// approve story-scope (不是 completion)
		send('tools/call', { name: 'oms-prd', arguments: { action: 'submit-approval', requestId, verdict: 'approved', feedback: 'story ok', reviewerAgentId: 'architect-1' } });
		await waitForResponse(startId + 1); // 9
		// 现在 mark-passes story (走通 story gate)
		send('tools/call', { name: 'oms-prd', arguments: { action: 'mark-passes', storyId: 'US-001', passes: true } });
		await waitForResponse(startId + 2); // 10
		// 调 oms-set-stage:done — 应被 completion gate 拒 (只有 story-scope approval, 无 completion)
		send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'done' } });
		return startId + 3; // 11
	});
	assert('A. 无 completion approval → oms-set-stage:done isError=true',
		resA?.result?.isError === true, JSON.stringify(resA).slice(0, 300));
	assert('A. 错误消息提及 completion verification',
		(resA?.result?.content?.[0]?.text ?? '').includes('completion'), JSON.stringify(resA).slice(0, 300));

	// ── Scenario B: 有 completion-scope approved → oms-set-stage:done 成功 ──
	const resB = await runScenario('allowed', async ({ send, waitForResponse, startId }) => {
		// request completion-scope + approve
		send('tools/call', { name: 'oms-prd', arguments: { action: 'request-verification', storyId: null, scope: 'completion' } });
		const rReq = await waitForResponse(startId); // 8
		const reqText = rReq?.result?.content?.[0]?.text ?? '';
		const m = reqText.match(/requestId: ([a-f0-9-]+)/);
		const requestId = m ? m[1] : null;
		send('tools/call', { name: 'oms-prd', arguments: { action: 'submit-approval', requestId, verdict: 'approved', feedback: 'session ok', reviewerAgentId: 'architect-1' } });
		await waitForResponse(startId + 1); // 9
		// 调 oms-set-stage:done — 应成功 (有 completion approval)
		send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'done' } });
		return startId + 2; // 10
	});
	assert('B. 有 completion approval → oms-set-stage:done 成功 (非 isError)',
		resB?.result?.isError !== true, JSON.stringify(resB).slice(0, 300));
	assert('B. 成功消息提及 Stage transitioned',
		(resB?.result?.content?.[0]?.text ?? '').includes('Stage transitioned'), JSON.stringify(resB).slice(0, 300));

	console.log(`\n==================================================`);
	console.log(`Completion gate (mcp tool layer): ${pass} passed, ${fail} failed`);
	console.log(`==================================================`);
	process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
