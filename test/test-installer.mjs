// Tests for setupSubAgents field-level merge logic (mergeOmsAgents).
// Verifies that `oms setup` preserves user-customized `tools` while still
// updating `name`/`description`/`role` from the package on every setup.
//
// Run: node test/test-installer.mjs
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Compile output is dist/installer.js. We import the exported pure merger.
let mergeOmsAgents;
try {
	({ mergeOmsAgents } = await import('../dist/installer.js'));
} catch (e) {
	console.error('❌ Cannot import dist/installer.js — run `npm run build` first.');
	console.error(e.message);
	process.exit(1);
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
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ─── Test fixtures ───────────────────────────────────────────────────────────

const pkgAgents = [
	{
		id: 'oms_architect',
		name: 'OMS Architect',
		description: 'System architecture design and review',
		tools: ['filesystem-read', 'codebase-search', 'ace-search', 'ide-get_diagnostics', 'terminal-execute'],
		role: '<Agent_Prompt>v1</Agent_Prompt>',
	},
	{
		id: 'oms_researcher',
		name: 'OMS Researcher',
		description: 'Deep research with web search and code analysis',
		tools: ['filesystem-read', 'codebase-search', 'ace-search', 'websearch-search', 'websearch-fetch', 'todo-manage'],
		role: '<Agent_Prompt>researcher v1</Agent_Prompt>',
	},
];

// ─── Tests ───────────────────────────────────────────────────────────────────

// 1. Fresh install (no existing agents): all package agents added as-is.
{
	const result = mergeOmsAgents([], pkgAgents);
	assert('Fresh install: 2 agents added', result.length === 2, `got ${result.length}`);
	assert('Fresh install: architect tools from package',
		eq(result[0].tools, pkgAgents[0].tools));
}

// 2. CORE CONTRACT: user-customized tools preserved on re-setup.
{
	const userAgents = [
		{
			id: 'oms_architect',
			name: 'OLD NAME (stale)',         // should be overwritten by package
			description: 'old desc',           // should be overwritten
			tools: ['filesystem-read', 'umans-web-search', 'custom-tool'],  // PRESERVED
			role: 'old role',                  // should be overwritten
		},
	];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const arch = result.find(a => a.id === 'oms_architect');
	assert('Customized tools preserved',
		eq(arch.tools, ['filesystem-read', 'umans-web-search', 'custom-tool']),
		`got ${JSON.stringify(arch.tools)}`);
	assert('Stale name overwritten by package',
		arch.name === 'OMS Architect', `got ${arch.name}`);
	assert('Stale description overwritten', arch.description === 'System architecture design and review');
	assert('Stale role overwritten', arch.role === '<Agent_Prompt>v1</Agent_Prompt>');
}

// 3. User tools preserved even if they are a subset of package tools.
{
	const userAgents = [{ id: 'oms_architect', name: 'x', tools: ['filesystem-read'] }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const arch = result.find(a => a.id === 'oms_architect');
	assert('Subset tools preserved (no auto-merge of package tools)',
		eq(arch.tools, ['filesystem-read']), `got ${JSON.stringify(arch.tools)}`);
}

// 4. Non-OMS agents preserved unchanged.
{
	const userAgents = [
		{ id: 'my_custom_agent', name: 'Custom', tools: ['filesystem-read', 'custom-x'] },
		{ id: 'another_one', name: 'Other', tools: ['terminal-execute'] },
	];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const custom = result.find(a => a.id === 'my_custom_agent');
	const other = result.find(a => a.id === 'another_one');
	assert('Non-OMS agent #1 preserved', custom && custom.name === 'Custom');
	assert('Non-OMS agent #1 tools untouched', eq(custom.tools, ['filesystem-read', 'custom-x']));
	assert('Non-OMS agent #2 preserved', other && other.name === 'Other');
	assert('Result has 4 agents (2 non-OMS + 2 OMS)', result.length === 4, `got ${result.length}`);
}

// 5. Empty user tools array → fall back to package tools (don't leave agent toolless).
{
	const userAgents = [{ id: 'oms_architect', name: 'x', tools: [] }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const arch = result.find(a => a.id === 'oms_architect');
	assert('Empty tools array falls back to package tools',
		eq(arch.tools, pkgAgents[0].tools), `got ${JSON.stringify(arch.tools)}`);
}

// 6. User tools missing entirely → package tools used.
{
	const userAgents = [{ id: 'oms_architect', name: 'x' /* no tools field */ }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const arch = result.find(a => a.id === 'oms_architect');
	assert('Missing tools field uses package tools',
		eq(arch.tools, pkgAgents[0].tools));
}

// 7. New package agent (no matching user agent) added as-is.
{
	const userAgents = [{ id: 'oms_architect', name: 'x', tools: ['custom'] }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const researcher = result.find(a => a.id === 'oms_researcher');
	assert('New package agent added', researcher && researcher.id === 'oms_researcher');
	assert('New package agent uses package tools',
		eq(researcher.tools, pkgAgents[1].tools));
}

// 8. OMS agent the user deleted is reinstalled (cannot distinguish from fresh install).
{
	const userAgents = [
		{ id: 'oms_architect', name: 'x', tools: ['custom'] },
		// oms_researcher intentionally absent — user "deleted" it
	];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const researcher = result.find(a => a.id === 'oms_researcher');
	assert('Deleted-by-user OMS agent reinstalled', researcher && researcher.tools.length > 0);
}

// 9. tools with wrong type (not array) → package tools used (defensive).
{
	const userAgents = [{ id: 'oms_architect', name: 'x', tools: 'filesystem-read' /* string, not array */ }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	const arch = result.find(a => a.id === 'oms_architect');
	assert('Malformed tools (not array) falls back to package',
		eq(arch.tools, pkgAgents[0].tools));
}

// 10. Round-trip idempotency: running merge twice yields the same result.
{
	const userAgents = [{ id: 'oms_architect', name: 'x', tools: ['custom'] }];
	const once = mergeOmsAgents(userAgents, pkgAgents);
	const twice = mergeOmsAgents(once, pkgAgents);
	assert('Merge is idempotent across re-setup', eq(once, twice));
}

// 11. Non-string id → treated as non-OMS (defensive: avoid crash on bad data).
{
	const userAgents = [{ id: null, name: 'weird', tools: ['x'] }];
	const result = mergeOmsAgents(userAgents, pkgAgents);
	assert('Non-string id does not crash, agent preserved', result.length === 3, `got ${result.length}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\ninstaller mergeOmsAgents: ${pass} passed, ${fail} failed`);
if (fail > 0) {
	process.exit(1);
}
