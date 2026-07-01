/**
 * Integration Test: Skill Evolution Pipeline (diagnose → explore → evaluate)
 *
 * This test verifies the oms-learn MCP tool's orchestration output at the protocol level.
 * Since the actual evolution cycle is driven by LLM prompts (not code), we verify:
 *
 * 1. Input validation gates (path traversal, empty summary, invalid patterns)
 * 2. SKILL.md draft file creation on disk
 * 3. Orchestration instruction structure (3-step pipeline: EmbodiSkill → SkillEvolver → Darwin-Skill)
 * 4. Iteration counting and maxIterations enforcement
 * 5. Convergence check instructions
 * 6. Human-in-the-loop pause instructions
 * 7. SKILL.md content structure (frontmatter, summary, patterns, session context)
 *
 * Test approach: Spawn the MCP server as a child process, communicate via JSON-RPC stdio,
 * and assert on tool responses + filesystem artifacts.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Test infrastructure ──

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

async function waitForResponse(id, timeout = 5000) {
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

// ── Helper: extract text from MCP tool response ──
function getResponseText(response) {
	return response?.result?.content?.[0]?.text || '';
}

function getIsError(response) {
	return response?.result?.isError === true;
}

// ── Test data ──

const VALID_PATTERNS = JSON.stringify([
	{
		name: 'Atomic State Write',
		description: 'Always use temp-file-then-rename pattern for state persistence to prevent corruption.',
		applicability: 'Any time state.json is written by MCP server or hooks',
	},
	{
		name: 'Path Whitelist Validation',
		description: 'Validate user-provided names with ^[a-zA-Z0-9_-]+$ before using in filesystem paths.',
		applicability: 'When user input becomes part of a file path',
	},
	{
		name: 'Fail-Open Error Handling',
		description: 'Hooks should catch errors and exit(0) to avoid blocking the AI workflow.',
		applicability: 'All lifecycle hooks (beforeToolCall, afterToolCall, onStop, onUserMessage)',
	},
]);

// ── Main test suite ──

async function runTests() {
	// Initialize MCP connection
	send('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'skill-evolution-test', version: '1.0' },
	});
	await waitForResponse(1);
	sendNotif('notifications/initialized', {});

	// ──────────────────────────────────────────────
	// Group 1: Pre-condition — session must exist
	// ──────────────────────────────────────────────

	// Start a session first (oms-learn requires an active session)
	send('tools/call', {
		name: 'oms-start',
		arguments: { goal: 'Build and test a REST API with authentication', verifyCommand: 'npm test' },
	});
	const r0 = await waitForResponse(2);
	assert('oms-start succeeds (precondition)', !getIsError(r0), JSON.stringify(r0).slice(0, 200));

	// Add some tasks to make the session realistic
	send('tools/call', { name: 'oms-add-task', arguments: { description: 'Create Express server' } });
	await waitForResponse(3);
	send('tools/call', { name: 'oms-add-task', arguments: { description: 'Add JWT auth middleware' } });
	await waitForResponse(4);
	send('tools/call', { name: 'oms-add-task', arguments: { description: 'Write integration tests' } });
	await waitForResponse(5);

	// ──────────────────────────────────────────────
	// Group 2: Input validation gates
	// ──────────────────────────────────────────────

	console.log('\n── Group 2: Input Validation Gates ──');

	// Test: oms-learn rejects path traversal in skillName
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built a REST API',
			patterns: VALID_PATTERNS,
			skillName: '../../etc/cron.d',
		},
	});
	const r1 = await waitForResponse(6);
	assert(
		'Path traversal skillName rejected',
		getIsError(r1) && getResponseText(r1).includes('alphanumeric'),
		`got: ${getResponseText(r1).slice(0, 100)}`,
	);

	// Test: oms-learn rejects empty summary
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: '   ',
			patterns: VALID_PATTERNS,
		},
	});
	const r2 = await waitForResponse(7);
	assert(
		'Empty summary rejected',
		getIsError(r2) && getResponseText(r2).includes('summary') && getResponseText(r2).includes('empty'),
		`got: ${getResponseText(r2).slice(0, 100)}`,
	);

	// Test: oms-learn rejects invalid JSON patterns
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built a REST API',
			patterns: '{not an array}',
		},
	});
	const r3 = await waitForResponse(8);
	assert(
		'Invalid JSON patterns rejected',
		getIsError(r3) && getResponseText(r3).includes('JSON'),
		`got: ${getResponseText(r3).slice(0, 100)}`,
	);

	// Test: oms-learn rejects non-array patterns (valid JSON but not array)
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built a REST API',
			patterns: '{"name": "test"}',
		},
	});
	const r4 = await waitForResponse(9);
	assert(
		'Non-array JSON patterns rejected',
		getIsError(r4) && getResponseText(r4).includes('array'),
		`got: ${getResponseText(r4).slice(0, 100)}`,
	);

	// Test: oms-learn rejects patterns with missing required fields
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built a REST API',
			patterns: JSON.stringify([{ name: 'test' }]), // missing description
		},
	});
	const r5 = await waitForResponse(10);
	assert(
		'Pattern missing description rejected',
		getIsError(r5) && getResponseText(r5).includes('name') && getResponseText(r5).includes('description'),
		`got: ${getResponseText(r5).slice(0, 100)}`,
	);

	// Test: oms-learn rejects empty patterns array
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built a REST API',
			patterns: '[]',
		},
	});
	const r6 = await waitForResponse(11);
	assert(
		'Empty patterns array rejected',
		getIsError(r6) && getResponseText(r6).includes('at least one'),
		`got: ${getResponseText(r6).slice(0, 100)}`,
	);

	// ──────────────────────────────────────────────
	// Group 3: Successful oms-learn with default maxIterations
	// ──────────────────────────────────────────────

	console.log('\n── Group 3: Orchestration Output (default iterations) ──');

	const testSkillName = 'test-evolution-' + Date.now();
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Built and tested a REST API with JWT authentication. Used atomic state writes and path validation patterns.',
			patterns: VALID_PATTERNS,
			skillName: testSkillName,
		},
	});
	const r7 = await waitForResponse(12, 8000);
	assert('oms-learn succeeds with valid input', !getIsError(r7), JSON.stringify(r7).slice(0, 300));

	const responseText = getResponseText(r7);

	// ──────────────────────────────────────────────
	// Group 4: Orchestration instruction structure — 3-step pipeline
	// ──────────────────────────────────────────────

	console.log('\n── Group 4: Pipeline Structure (diagnose → explore → evaluate) ──');

	assert(
		'Step 1: EmbodiSkill mentioned',
		responseText.includes('EmbodiSkill') || responseText.includes('embodi-skill'),
		'missing EmbodiSkill reference',
	);
	assert(
		'Step 1: /skill embodi-skill command',
		responseText.includes('/skill embodi-skill'),
		'missing /skill embodi-skill command',
	);
	assert(
		'Step 1: Revision signals mentioned',
		responseText.includes('DISCOVERY') || responseText.includes('OPTIMIZATION') || responseText.includes('SKILL_DEFECT') || responseText.includes('EXECUTION_LAPSE'),
		'missing revision signal types',
	);

	assert(
		'Step 2: SkillEvolver mentioned',
		responseText.includes('SkillEvolver') || responseText.includes('skill-evolver'),
		'missing SkillEvolver reference',
	);
	assert(
		'Step 2: /skill skill-evolver command',
		responseText.includes('/skill skill-evolver'),
		'missing /skill skill-evolver command',
	);
	assert(
		'Step 2: K=4 strategy exploration mentioned',
		responseText.includes('K=4'),
		'missing K=4 strategy mention',
	);
	assert(
		'Step 2: Max 8 candidates mentioned',
		responseText.includes('8'),
		'missing max 8 candidates mention',
	);

	assert(
		'Step 3: Darwin-Skill mentioned',
		responseText.includes('darwin-skill') || responseText.includes('Darwin-Skill') || responseText.includes('Darwin'),
		'missing Darwin-Skill reference',
	);
	assert(
		'Step 3: /skill darwin-skill command',
		responseText.includes('/skill darwin-skill'),
		'missing /skill darwin-skill command',
	);
	assert(
		'Step 3: 9 dimensions mentioned',
		responseText.includes('9 dimension'),
		'missing 9 dimensions reference',
	);
	assert(
		'Step 3: Ratchet mechanism mentioned',
		responseText.includes('ratchet') || responseText.includes('Ratchet'),
		'missing ratchet mechanism reference',
	);

	// ──────────────────────────────────────────────
	// Group 5: Iteration counting & convergence
	// ──────────────────────────────────────────────

	console.log('\n── Group 5: Iteration Counting & Convergence ──');

	assert(
		'Iteration 1/2 mentioned (default maxIterations)',
		responseText.includes('1/2') || responseText.includes('iteration 1'),
		'missing iteration counter',
	);
	assert(
		'Convergence check section present',
		responseText.includes('Convergence'),
		'missing convergence check',
	);
	assert(
		'Convergence: 0 revision signals criterion',
		responseText.includes('0 revision'),
		'missing 0 revision signals convergence criterion',
	);
	assert(
		'Convergence: score ≥ 80 criterion',
		responseText.includes('80'),
		'missing score ≥ 80 convergence criterion',
	);

	// ──────────────────────────────────────────────
	// Group 6: Human-in-the-loop
	// ──────────────────────────────────────────────

	console.log('\n── Group 6: Human-in-the-Loop ──');

	assert(
		'User confirmation pause instruction present',
		responseText.includes('wait') || responseText.includes('confirmation') || responseText.includes('Do you want'),
		'missing human confirmation pause',
	);
	assert(
		'Diff/score presentation instruction present',
		responseText.includes('diff') || responseText.includes('score'),
		'missing diff/score presentation',
	);

	// ──────────────────────────────────────────────
	// Group 7: SKILL.md draft file creation
	// ──────────────────────────────────────────────

	console.log('\n── Group 7: SKILL.md Draft File ──');

	const homeDir = process.env.HOME || process.env.USERPROFILE || '';
	const skillDir = join(homeDir, '.snow', 'skills', 'oms', testSkillName);
	const skillFile = join(skillDir, 'SKILL.md');

	assert('SKILL.md directory created', existsSync(skillDir), `expected dir: ${skillDir}`);
	assert('SKILL.md file exists', existsSync(skillFile), `expected file: ${skillFile}`);

	if (existsSync(skillFile)) {
		const skillContent = readFileSync(skillFile, 'utf-8');

		// Frontmatter
		assert(
			'SKILL.md has YAML frontmatter',
			skillContent.startsWith('---'),
			'missing YAML frontmatter',
		);
		assert(
			'SKILL.md frontmatter has name',
			skillContent.includes(`name: ${testSkillName}`),
			'missing name in frontmatter',
		);
		assert(
			'SKILL.md frontmatter has description',
			skillContent.includes('description:'),
			'missing description in frontmatter',
		);

		// Body structure
		assert(
			'SKILL.md has H1 title',
			skillContent.includes(`# ${testSkillName}`),
			'missing H1 title',
		);
		assert(
			'SKILL.md has Summary section',
			skillContent.includes('## Summary'),
			'missing Summary section',
		);
		assert(
			'SKILL.md has Patterns Learned section',
			skillContent.includes('## Patterns Learned'),
			'missing Patterns Learned section',
		);
		assert(
			'SKILL.md has Session Context section',
			skillContent.includes('## Session Context'),
			'missing Session Context section',
		);
		assert(
			'SKILL.md has Generated section',
			skillContent.includes('## Generated'),
			'missing Generated section',
		);

		// Pattern content
		assert(
			'SKILL.md contains pattern 1 name',
			skillContent.includes('Atomic State Write'),
			'missing pattern 1 name',
		);
		assert(
			'SKILL.md contains pattern 2 name',
			skillContent.includes('Path Whitelist Validation'),
			'missing pattern 2 name',
		);
		assert(
			'SKILL.md contains pattern 3 name',
			skillContent.includes('Fail-Open Error Handling'),
			'missing pattern 3 name',
		);
		assert(
			'SKILL.md contains applicability info',
			skillContent.includes('When to apply'),
			'missing applicability info',
		);

		// Session context
		assert(
			'SKILL.md contains goal',
			skillContent.includes('Goal:') && skillContent.includes('REST API'),
			'missing goal in session context',
		);
		assert(
			'SKILL.md contains task count',
			skillContent.includes('Tasks completed:'),
			'missing task count',
		);
		assert(
			'SKILL.md contains turn count',
			skillContent.includes('Turns:'),
			'missing turn count',
		);

		// Cleanup test artifact
		try {
			rmSync(skillDir, { recursive: true, force: true });
		} catch {}
	}

	// ──────────────────────────────────────────────
	// Group 8: maxIterations enforcement
	// ──────────────────────────────────────────────

	console.log('\n── Group 8: maxIterations Enforcement ──');

	// Test: maxIterations=3
	const testSkillName2 = 'test-iter3-' + Date.now();
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Another test session',
			patterns: VALID_PATTERNS,
			skillName: testSkillName2,
			maxIterations: 3,
		},
	});
	const r8 = await waitForResponse(13, 8000);
	assert('oms-learn with maxIterations=3 succeeds', !getIsError(r8), JSON.stringify(r8).slice(0, 200));
	assert(
		'Response shows iteration 1/3',
		getResponseText(r8).includes('1/3'),
		`missing 1/3 iteration: ${getResponseText(r8).slice(0, 100)}`,
	);
	assert(
		'Response mentions 3 max iterations',
		getResponseText(r8).includes('3'),
		'missing max iterations 3',
	);

	// Cleanup
	const skillDir2 = join(homeDir, '.snow', 'skills', 'oms', testSkillName2);
	try { rmSync(skillDir2, { recursive: true, force: true }); } catch {}

	// Test: maxIterations exceeding hard cap (5) gets clamped
	const testSkillName3 = 'test-iter10-' + Date.now();
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Test hard cap',
			patterns: VALID_PATTERNS,
			skillName: testSkillName3,
			maxIterations: 10,
		},
	});
	const r9 = await waitForResponse(14, 8000);
	assert('oms-learn with maxIterations=10 succeeds', !getIsError(r9), JSON.stringify(r9).slice(0, 200));
	assert(
		'maxIterations=10 clamped to 5',
		getResponseText(r9).includes('1/5'),
		`expected 1/5 in response: ${getResponseText(r9).slice(0, 100)}`,
	);

	// Cleanup
	const skillDir3 = join(homeDir, '.snow', 'skills', 'oms', testSkillName3);
	try { rmSync(skillDir3, { recursive: true, force: true }); } catch {}

	// Test: maxIterations=1 (single iteration, should mention saving best result)
	const testSkillName4 = 'test-iter1-' + Date.now();
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Single iteration test',
			patterns: VALID_PATTERNS,
			skillName: testSkillName4,
			maxIterations: 1,
		},
	});
	const r10 = await waitForResponse(15, 8000);
	assert('oms-learn with maxIterations=1 succeeds', !getIsError(r10), JSON.stringify(r10).slice(0, 200));
	assert(
		'Response shows iteration 1/1',
		getResponseText(r10).includes('1/1'),
		`missing 1/1 iteration: ${getResponseText(r10).slice(0, 100)}`,
	);
	assert(
		'Response mentions saving current best (last iteration)',
		getResponseText(r10).includes('last iteration') || getResponseText(r10).includes('save') || getResponseText(r10).includes('best'),
		'missing save-best instruction for last iteration',
	);

	// Cleanup
	const skillDir4 = join(homeDir, '.snow', 'skills', 'oms', testSkillName4);
	try { rmSync(skillDir4, { recursive: true, force: true }); } catch {}

	// ──────────────────────────────────────────────
	// Group 9: No active session error
	// ──────────────────────────────────────────────

	console.log('\n── Group 9: No Active Session Error ──');

	// Stop the session first
	send('tools/call', { name: 'oms-stop', arguments: {} });
	await waitForResponse(16);

	// Try oms-learn without a session
	send('tools/call', {
		name: 'oms-learn',
		arguments: {
			summary: 'Test without session',
			patterns: VALID_PATTERNS,
		},
	});
	const r11 = await waitForResponse(17);
	assert(
		'oms-learn without session returns error',
		getIsError(r11) && getResponseText(r11).includes('No active OMS session'),
		`expected no-session error: ${getResponseText(r11).slice(0, 100)}`,
	);

	// ──────────────────────────────────────────────
	// Group 10: SKILL.md files exist for all three pipeline skills
	// ──────────────────────────────────────────────

	console.log('\n── Group 10: Pipeline SKILL.md Files Exist ──');

	const skillsBasePath = join(process.cwd(), 'assets', 'skills', 'oms');

	assert(
		'darwin-skill SKILL.md exists',
		existsSync(join(skillsBasePath, 'darwin-skill', 'SKILL.md')),
		'missing darwin-skill/SKILL.md',
	);
	assert(
		'skill-evolver SKILL.md exists',
		existsSync(join(skillsBasePath, 'skill-evolver', 'SKILL.md')),
		'missing skill-evolver/SKILL.md',
	);
	assert(
		'embodi-skill SKILL.md exists',
		existsSync(join(skillsBasePath, 'embodi-skill', 'SKILL.md')),
		'missing embodi-skill/SKILL.md',
	);

	// Verify darwin-skill has 9 dimensions
	const darwinContent = readFileSync(join(skillsBasePath, 'darwin-skill', 'SKILL.md'), 'utf-8');
	assert(
		'darwin-skill has 9-dimension rubric',
		darwinContent.includes('9-Dimension') || darwinContent.includes('9 dimension'),
		'missing 9-dimension rubric',
	);
	assert(
		'darwin-skill has ratchet mechanism',
		darwinContent.includes('Ratchet') || darwinContent.includes('ratchet'),
		'missing ratchet mechanism',
	);
	assert(
		'darwin-skill has convergence criteria (score >= 80)',
		darwinContent.includes('80'),
		'missing convergence score threshold',
	);

	// Verify embodi-skill has 4 signal types
	const embodiContent = readFileSync(join(skillsBasePath, 'embodi-skill', 'SKILL.md'), 'utf-8');
	assert(
		'embodi-skill has DISCOVERY signal',
		embodiContent.includes('DISCOVERY'),
		'missing DISCOVERY signal type',
	);
	assert(
		'embodi-skill has OPTIMIZATION signal',
		embodiContent.includes('OPTIMIZATION'),
		'missing OPTIMIZATION signal type',
	);
	assert(
		'embodi-skill has SKILL_DEFECT signal',
		embodiContent.includes('SKILL_DEFECT'),
		'missing SKILL_DEFECT signal type',
	);
	assert(
		'embodi-skill has EXECUTION_LAPSE signal',
		embodiContent.includes('EXECUTION_LAPSE'),
		'missing EXECUTION_LAPSE signal type',
	);

	// Verify skill-evolver has K=4 and audit
	const evolverContent = readFileSync(join(skillsBasePath, 'skill-evolver', 'SKILL.md'), 'utf-8');
	assert(
		'skill-evolver has K=4 strategy exploration',
		evolverContent.includes('K=4'),
		'missing K=4 strategy exploration',
	);
	assert(
		'skill-evolver has candidate cap (8)',
		evolverContent.includes('8'),
		'missing candidate cap',
	);
	assert(
		'skill-evolver has independent audit',
		evolverContent.includes('audit') || evolverContent.includes('Audit'),
		'missing audit step',
	);
	assert(
		'skill-evolver has overfitting checks',
		evolverContent.includes('overfitting') || evolverContent.includes('Hardcoded') || evolverContent.includes('hardcoded'),
		'missing overfitting check',
	);

	// ──────────────────────────────────────────────
	// Summary
	// ──────────────────────────────────────────────

	console.log(`\n${'='.repeat(60)}`);
	console.log(`Skill Evolution Pipeline Integration Test Results:`);
	console.log(`  ${pass} passed, ${fail} failed`);
	console.log(`${'='.repeat(60)}`);

	child.kill();
	process.exit(fail > 0 ? 1 : 0);
}

setTimeout(runTests, 500);
