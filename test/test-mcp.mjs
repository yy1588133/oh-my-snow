import { spawn } from 'child_process';

const child = spawn('node', ['dist/mcp-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

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

	// Tool: oms-set-stage (executing → verifying)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'verifying' } });
	const r9 = await waitForResponse(11);
	assert('oms-set-stage executing→verifying', r9?.result?.content?.[0]?.text?.includes('verifying'), JSON.stringify(r9).slice(0, 200));

	// Tool: oms-set-stage (verifying → done)
	send('tools/call', { name: 'oms-set-stage', arguments: { stage: 'done' } });
	const r10 = await waitForResponse(12);
	assert('oms-set-stage verifying→done', r10?.result?.content?.[0]?.text?.includes('done'), JSON.stringify(r10).slice(0, 200));

	// Tool: oms-stop
	send('tools/call', { name: 'oms-stop', arguments: {} });
	const r11 = await waitForResponse(13);
	assert('oms-stop ends session', r11?.result?.content?.[0]?.text?.includes('stopped'), JSON.stringify(r11).slice(0, 200));

	console.log(`\n${'='.repeat(50)}`);
	console.log(`Results: ${pass} passed, ${fail} failed`);

	child.kill();
	process.exit(fail > 0 ? 1 : 0);
}

setTimeout(runTests, 500);
