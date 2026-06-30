#!/usr/bin/env node

/**
 * OMS Installer
 *
 * CLI entry point for Oh-My-Snow setup and uninstall.
 * Run via `oms setup`, `oms uninstall`, or `oms help`.
 *
 * What `oms setup` does:
 *   1. Finds the global node_modules path and oh-my-snow package path
 *   2. Merges MCP server config into ~/.snow/settings.json (absolute paths)
 *   3. Merges 18 oms_* agents into ~/.snow/sub-agents.json
 *   4. Copies skills from assets/skills/oms/ to ~/.snow/skills/oms/
 *   5. Copies commands from assets/commands/oms/ to ~/.snow/commands/oms/
 *   6. Copies hook scripts (*.mjs) to <project>/.snow/oms-state/ (按项目部署)
 *   7. Copies hook config JSONs to <project>/.snow/hooks/ (merging with existing)
 *   8. Creates .snow/oms-state/ directory
 *
 * What `oms uninstall` does:
 *   1. Removes oms from settings.json mcpServers
 *   2. Removes oms_* agents from sub-agents.json
 *   3. Removes ~/.snow/skills/oms/ directory
 *   4. Removes ~/.snow/commands/oms/ directory
 *   5. Removes OMS hook rules from .snow/hooks/*.json
 *   6. Removes .snow/oms-state/ directory
 */

import {execSync} from 'child_process';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	cpSync,
	rmSync,
	readdirSync,
} from 'fs';
import {join, dirname, resolve} from 'path';
import {homedir} from 'os';

// ── Constants ──

const HOME = homedir();
const SNOW_DIR = join(HOME, '.snow');
const SETTINGS_PATH = join(SNOW_DIR, 'settings.json');
const SUB_AGENTS_PATH = join(SNOW_DIR, 'sub-agents.json');
const SKILLS_TARGET = join(SNOW_DIR, 'skills', 'oms');
const COMMANDS_TARGET = join(SNOW_DIR, 'commands', 'oms');

const OMS_HOOK_DESCRIPTION_PREFIX = 'OMS:';

// ── Color helpers ──

const c = {
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ── Path discovery ──

/** Find the global node_modules directory via `npm root -g`. */
function findGlobalNodeModules(): string {
	try {
		return execSync('npm root -g', {encoding: 'utf-8'}).trim();
	} catch {
		throw new Error(
			'Failed to find global node_modules path. Is npm installed and on PATH?',
		);
	}
}

/** Find the oh-my-snow package directory. */
function findPackageDir(): string {
	// Try: global node_modules (installed globally)
	try {
		const globalRoot = findGlobalNodeModules();
		const globalPath = join(globalRoot, 'oh-my-snow');
		if (existsSync(globalPath)) {
			return resolve(globalPath);
		}
	} catch {
		// npm not available, fall through
	}

	// Try: __dirname (running from dist/ inside the package)
	const localPath = resolve(__dirname, '..');
	if (existsSync(join(localPath, 'package.json'))) {
		return localPath;
	}

	// Try: process.cwd() if it looks like the package
	const cwdPath = process.cwd();
	if (existsSync(join(cwdPath, 'package.json'))) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(cwdPath, 'package.json'), 'utf-8'),
			);
			if (pkg.name === 'oh-my-snow') {
				return cwdPath;
			}
		} catch {
			// not a valid package.json, fall through
		}
	}

	throw new Error(
		'Could not find the oh-my-snow package directory. ' +
			'Ensure it is installed globally (`npm install -g oh-my-snow`) or run from within the package directory.',
	);
}

// ── JSON helpers ──

function readJson<T = unknown>(filePath: string): T {
	if (!existsSync(filePath)) {
		return {} as T;
	}
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
	} catch {
		return {} as T;
	}
}

function writeJson(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), {recursive: true});
	writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Setup: MCP server config ──

function setupMcpConfig(packageDir: string): void {
	const mcpServerPath = resolve(packageDir, 'dist', 'mcp-server.js');

	if (!existsSync(mcpServerPath)) {
		console.warn(
			c.yellow(
				'  ⚠️  Warning: dist/mcp-server.js not found. Run `npm run build` first.',
			),
		);
	}

	const settings = readJson<Record<string, unknown>>(SETTINGS_PATH);
	if (!settings.mcpServers) {
		settings.mcpServers = {};
	}

	const stateDir = join(process.cwd(), '.snow', 'oms-state');
	const mcpServers = settings.mcpServers as Record<string, unknown>;
	mcpServers['oms'] = {
		command: 'node',
		args: [mcpServerPath],
		env: {
			OMS_STATE_DIR: stateDir,
		},
		timeout: 300000,
		enabled: true,
	};

	writeJson(SETTINGS_PATH, settings);
	console.log(c.green(`  ✓ MCP server config added to ${SETTINGS_PATH}`));
	console.log(c.dim(`    → node ${mcpServerPath}`));
}

// ── Setup: Sub-agents ──

function setupSubAgents(packageDir: string): void {
	const agentsPath = join(packageDir, 'assets', 'agents', 'sub-agents.json');
	if (!existsSync(agentsPath)) {
		console.warn(
			c.yellow('  ⚠️  Warning: sub-agents.json not found in package assets.'),
		);
		return;
	}

	const agentsData = readJson<{agents: Array<Record<string, unknown>>}>(
		agentsPath,
	);
	const omsAgents = agentsData.agents || [];

	// Read existing sub-agents.json
	const existing = readJson<{agents: Array<Record<string, unknown>>}>(
		SUB_AGENTS_PATH,
	);
	const existingAgents = existing.agents || [];

	// Filter out any existing oms_* agents to avoid duplicates
	const nonOmsAgents = existingAgents.filter(
		a => !String(a.id || '').startsWith('oms_'),
	);

	// Merge: non-OMS agents + OMS agents
	const merged = {
		agents: [...nonOmsAgents, ...omsAgents],
	};

	writeJson(SUB_AGENTS_PATH, merged);
	console.log(
		c.green(
			`  ✓ ${omsAgents.length} sub-agents merged into ${SUB_AGENTS_PATH}`,
		),
	);
}

// ── Setup: Skills ──

function setupSkills(packageDir: string): void {
	const skillsSource = join(packageDir, 'assets', 'skills', 'oms');

	if (!existsSync(skillsSource)) {
		console.warn(
			c.yellow(
				'  ⚠️  Warning: skills/oms/ directory not found in package assets.',
			),
		);
		return;
	}

	// Remove existing OMS skills directory if present, then copy fresh
	if (existsSync(SKILLS_TARGET)) {
		rmSync(SKILLS_TARGET, {recursive: true, force: true});
	}

	mkdirSync(SKILLS_TARGET, {recursive: true});
	cpSync(skillsSource, SKILLS_TARGET, {recursive: true});

	// Count skills
	let skillCount = 0;
	try {
		skillCount = readdirSync(SKILLS_TARGET, {withFileTypes: true}).filter(d =>
			d.isDirectory(),
		).length;
	} catch {
		// ignore
	}

	console.log(c.green(`  ✓ ${skillCount} skills copied to ${SKILLS_TARGET}`));
}

// ── Setup: Commands ──

function setupCommands(packageDir: string): void {
	const commandsSource = join(packageDir, 'assets', 'commands', 'oms');

	if (!existsSync(commandsSource)) {
		console.warn(
			c.yellow(
				'  ⚠️  Warning: commands/oms/ directory not found in package assets.',
			),
		);
		return;
	}

	// Remove existing OMS commands directory if present, then copy fresh
	if (existsSync(COMMANDS_TARGET)) {
		rmSync(COMMANDS_TARGET, {recursive: true, force: true});
	}

	mkdirSync(COMMANDS_TARGET, {recursive: true});
	cpSync(commandsSource, COMMANDS_TARGET, {recursive: true});

	// Count commands
	let commandCount = 0;
	try {
		commandCount = readdirSync(COMMANDS_TARGET).filter(f =>
			f.endsWith('.json'),
		).length;
	} catch {
		// ignore
	}

	console.log(
		c.green(`  ✓ ${commandCount} commands copied to ${COMMANDS_TARGET}`),
	);
}

// ── Setup: Hooks ──

function setupHooks(packageDir: string): void {
	const cwd = process.cwd();
	const hooksSourceDir = join(packageDir, 'hooks');
	const hookConfigsSourceDir = join(packageDir, 'assets', 'hooks');

	const hooksTargetDir = join(cwd, '.snow', 'oms-state');
	const hookConfigsTargetDir = join(cwd, '.snow', 'hooks');

	// 1. Copy hook scripts (*.mjs) to <project>/.snow/oms-state/
	if (existsSync(hooksSourceDir)) {
		mkdirSync(hooksTargetDir, {recursive: true});

		let hookScriptCount = 0;
		const hookFiles = readdirSync(hooksSourceDir).filter(f =>
			f.endsWith('.mjs'),
		);

		for (const file of hookFiles) {
			const src = join(hooksSourceDir, file);
			const dst = join(hooksTargetDir, file);
			cpSync(src, dst, {force: true});
			hookScriptCount++;
		}

		console.log(
			c.green(
				`  ✓ ${hookScriptCount} hook scripts copied to ${hooksTargetDir}`,
			),
		);
	} else {
		console.warn(
			c.yellow('  ⚠️  Warning: hooks/ directory not found in package.'),
		);
	}

	// 2. Copy hook config JSONs to <project>/.snow/hooks/ (merging with existing)
	if (existsSync(hookConfigsSourceDir)) {
		mkdirSync(hookConfigsTargetDir, {recursive: true});

		const configFiles = readdirSync(hookConfigsSourceDir).filter(f =>
			f.endsWith('.json'),
		);

		for (const configFile of configFiles) {
			const configSrcPath = join(hookConfigsSourceDir, configFile);
			const configDstPath = join(hookConfigsTargetDir, configFile);

			// Read the new OMS hook rules
			const omsRules = readJson<unknown[]>(configSrcPath);
			if (!Array.isArray(omsRules)) {
				continue;
			}

			// Read existing rules (if any) and filter out old OMS rules
			let existingRules: unknown[] = [];
			if (existsSync(configDstPath)) {
				try {
					const existingData = readJson<unknown[]>(configDstPath);
					if (Array.isArray(existingData)) {
						existingRules = existingData;
					}
				} catch {
					existingRules = [];
				}
			}

			// Filter out existing OMS rules (by description prefix)
			const nonOmsRules = existingRules.filter(rule => {
				if (typeof rule === 'object' && rule !== null) {
					const desc = (rule as Record<string, unknown>).description;
					if (typeof desc === 'string') {
						return !desc.startsWith(OMS_HOOK_DESCRIPTION_PREFIX);
					}
				}
				return true;
			});

			// Merge: non-OMS rules + new OMS rules
			const mergedRules = [...nonOmsRules, ...omsRules];
			writeJson(configDstPath, mergedRules);
		}

		console.log(
			c.green(
				`  ✓ ${configFiles.length} hook configs merged into ${hookConfigsTargetDir}`,
			),
		);
	} else {
		console.warn(
			c.yellow('  ⚠️  Warning: assets/hooks/ directory not found in package.'),
		);
	}

	// 3. Create .snow/oms-state/ directory
	const stateDir = join(cwd, '.snow', 'oms-state');
	mkdirSync(stateDir, {recursive: true});
	console.log(c.green(`  ✓ State directory created at ${stateDir}`));
}

// ── Uninstall: MCP server config ──

function uninstallMcpConfig(): void {
	if (!existsSync(SETTINGS_PATH)) {
		console.log(
			c.dim('  • settings.json not found, skipping MCP config removal.'),
		);
		return;
	}

	const settings = readJson<Record<string, unknown>>(SETTINGS_PATH);
	const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;

	if (mcpServers && 'oms' in mcpServers) {
		delete mcpServers['oms'];
		writeJson(SETTINGS_PATH, settings);
		console.log(c.green(`  ✓ Removed oms from ${SETTINGS_PATH}`));
	} else {
		console.log(c.dim('  • oms not found in settings.json, skipping.'));
	}
}

// ── Uninstall: Sub-agents ──

function uninstallSubAgents(): void {
	if (!existsSync(SUB_AGENTS_PATH)) {
		console.log(
			c.dim('  • sub-agents.json not found, skipping agent removal.'),
		);
		return;
	}

	const existing = readJson<{agents: Array<Record<string, unknown>>}>(
		SUB_AGENTS_PATH,
	);
	const existingAgents = existing.agents || [];

	const remaining = existingAgents.filter(
		a => !String(a.id || '').startsWith('oms_'),
	);

	if (remaining.length !== existingAgents.length) {
		writeJson(SUB_AGENTS_PATH, {agents: remaining});
		const removed = existingAgents.length - remaining.length;
		console.log(
			c.green(`  ✓ Removed ${removed} OMS agents from ${SUB_AGENTS_PATH}`),
		);
	} else {
		console.log(c.dim('  • No OMS agents found in sub-agents.json, skipping.'));
	}
}

// ── Uninstall: Skills ──

function uninstallSkills(): void {
	if (existsSync(SKILLS_TARGET)) {
		rmSync(SKILLS_TARGET, {recursive: true, force: true});
		console.log(c.green(`  ✓ Removed ${SKILLS_TARGET}`));
	} else {
		console.log(c.dim('  • skills/oms/ directory not found, skipping.'));
	}
}

// ── Uninstall: Commands ──

function uninstallCommands(): void {
	if (existsSync(COMMANDS_TARGET)) {
		rmSync(COMMANDS_TARGET, {recursive: true, force: true});
		console.log(c.green(`  ✓ Removed ${COMMANDS_TARGET}`));
	} else {
		console.log(c.dim('  • commands/oms/ directory not found, skipping.'));
	}
}

// ── Uninstall: Hooks ──

function uninstallHooks(): void {
	const cwd = process.cwd();
	const hookConfigsDir = join(cwd, '.snow', 'hooks');
	const stateDir = join(cwd, '.snow', 'oms-state');

	// 1. Remove OMS hook rules from .snow/hooks/*.json
	if (existsSync(hookConfigsDir)) {
		let removedConfigs = 0;
		try {
			const configFiles = readdirSync(hookConfigsDir).filter(f =>
				f.endsWith('.json'),
			);

			for (const configFile of configFiles) {
				const configPath = join(hookConfigsDir, configFile);
				const existingRules = readJson<unknown[]>(configPath);

				if (!Array.isArray(existingRules) || existingRules.length === 0) {
					continue;
				}

				const nonOmsRules = existingRules.filter(rule => {
					if (typeof rule === 'object' && rule !== null) {
						const desc = (rule as Record<string, unknown>).description;
						if (typeof desc === 'string') {
							return !desc.startsWith(OMS_HOOK_DESCRIPTION_PREFIX);
						}
					}
					return true;
				});

				if (nonOmsRules.length !== existingRules.length) {
					writeJson(configPath, nonOmsRules);
					removedConfigs++;
				}
			}

			if (removedConfigs > 0) {
				console.log(
					c.green(
						`  ✓ Removed OMS hook rules from ${removedConfigs} config file(s) in ${hookConfigsDir}`,
					),
				);
			} else {
				console.log(
					c.dim('  • No OMS hook rules found in .snow/hooks/, skipping.'),
				);
			}
		} catch {
			console.warn(c.yellow('  ⚠️  Could not read hook config directory.'));
		}
	} else {
		console.log(
			c.dim(
				'  • .snow/hooks/ directory not found, skipping hook config removal.',
			),
		);
	}

	// 2. Remove .snow/oms-state/ directory (contains hook scripts + state.json)
	if (existsSync(stateDir)) {
		rmSync(stateDir, {recursive: true, force: true});
		console.log(c.green(`  ✓ Removed ${stateDir}`));
	} else {
		console.log(c.dim('  • .snow/oms-state/ directory not found, skipping.'));
	}
}

// ── Main entry points ──

function setup(): void {
	console.log(
		c.bold(c.cyan('\n╔══════════════════════════════════════════════════╗')),
	);
	console.log(
		c.bold(c.cyan('║        Oh-My-Snow (OMS) — Setup                  ║')),
	);
	console.log(
		c.bold(c.cyan('╚══════════════════════════════════════════════════╝\n')),
	);

	// Find package directory
	let packageDir: string;
	try {
		packageDir = findPackageDir();
		console.log(c.dim(`  Package: ${packageDir}`));
	} catch (error) {
		console.error(c.red(`\n✖ ${(error as Error).message}\n`));
		process.exit(1);
	}

	// Ensure ~/.snow/ exists
	mkdirSync(SNOW_DIR, {recursive: true});

	console.log('\n  Setting up OMS components...\n');

	// 1. MCP server config
	setupMcpConfig(packageDir);

	// 2. Sub-agents
	setupSubAgents(packageDir);

	// 3. Skills
	setupSkills(packageDir);

	// 4. Commands
	setupCommands(packageDir);

	// 5-6. Hooks (scripts + configs)
	setupHooks(packageDir);

	console.log(c.green('\n  ═══════════════════════════════════════════════'));
	console.log(c.green('  ✅ OMS setup complete!\n'));
	console.log(c.cyan('  Next steps:'));
	console.log('    1. Restart Snow CLI to load the new MCP server and hooks');
	console.log('    2. Run /oms:help to see all available commands');
	console.log('    3. Start with: /oms:auto "your goal here"\n');
}

function uninstall(): void {
	console.log(
		c.bold(c.yellow('\n╔══════════════════════════════════════════════════╗')),
	);
	console.log(
		c.bold(c.yellow('║        Oh-My-Snow (OMS) — Uninstall              ║')),
	);
	console.log(
		c.bold(c.yellow('╚══════════════════════════════════════════════════╝\n')),
	);

	console.log('  Removing OMS components...\n');

	// 1. MCP server config
	uninstallMcpConfig();

	// 2. Sub-agents
	uninstallSubAgents();

	// 3. Skills
	uninstallSkills();

	// 4. Commands
	uninstallCommands();

	// 5-7. Hooks (configs + directories)
	uninstallHooks();

	console.log(c.green('\n  ═══════════════════════════════════════════════'));
	console.log(c.green('  ✅ OMS uninstall complete!\n'));
	console.log(c.cyan('  OMS has been fully removed from this project.'));
	console.log(c.dim('  Restart Snow CLI to apply the changes.\n'));
}

function help(): void {
	console.log(`
${c.bold(
	c.cyan('Oh-My-Snow (OMS)'),
)} — Autonomous orchestration plugin for Snow CLI

${c.bold('Usage:')}
  ${c.cyan('oms')} <command>

${c.bold('Commands:')}
  ${c.green(
		'setup',
	)}      Install OMS — register MCP server, agents, skills, commands, and hooks
  ${c.green(
		'uninstall',
	)} Remove OMS — clean up all OMS components from system and project
  ${c.green('help')}       Show this help message

${c.bold('Setup details:')}
  • Registers MCP server in ~/.snow/settings.json
  • Merges 18 sub-agents into ~/.snow/sub-agents.json
  • Copies 7 skills to ~/.snow/skills/oms/
  • Copies 9 commands to ~/.snow/commands/oms/
  • Copies 4 hook scripts to <project>/.snow/oms-state/
  • Merges 4 hook configs into <project>/.snow/hooks/
  • Creates <project>/.snow/oms-state/ for session state

${c.bold('Uninstall details:')}
  • Removes MCP server from settings.json
  • Removes all oms_* agents from sub-agents.json
  • Removes ~/.snow/skills/oms/ directory
  • Removes ~/.snow/commands/oms/ directory
  • Removes OMS hook rules from .snow/hooks/*.json
  • Removes .snow/oms-state/ directory

${c.bold('After setup, use in Snow CLI:')}
  /oms:auto "your goal"     — Start autonomous orchestration
  /oms:plan "your goal"     — Iterative planning with consensus
  /oms:help                 — Full usage guide with all features

${c.bold('Prerequisites:')}
  • Snow CLI installed and configured
  • Node.js 18+ 
  • npm (for global installation)
`);
}

// ── CLI entry point ──

const command = process.argv[2]?.toLowerCase();

switch (command) {
	case 'setup':
	case 'install':
		setup();
		break;
	case 'uninstall':
	case 'remove':
		uninstall();
		break;
	case 'help':
	case '--help':
	case '-h':
	case undefined:
		help();
		break;
	default:
		console.error(c.red(`\n✖ Unknown command: ${command}\n`));
		help();
		process.exit(1);
}
