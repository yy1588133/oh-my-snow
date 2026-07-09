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
 *   6. Installs hook configs to ~/.snow/hooks/ (global, with absolute path commands)
 *   7. Creates <project>/.snow/oms-state/ directory (for runtime state storage)
 *
 * What `oms uninstall` does:
 *   1. Removes oms from settings.json mcpServers
 *   2. Removes oms_* agents from sub-agents.json
 *   3. Removes ~/.snow/skills/oms/ directory
 *   4. Removes ~/.snow/commands/oms/ directory
 *   5. Removes OMS hook rules from ~/.snow/hooks/*.json (global)
 *   6. Removes <project>/.snow/oms-state/ directory
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
	realpathSync,
	renameSync,
} from 'fs';
import {join, dirname, resolve} from 'path';
import {homedir} from 'os';
import {fileURLToPath} from 'url';
import {getTranslations} from './i18n/index.js';

// ESM equivalent of CommonJS __dirname (package.json has "type": "module").
// Without this, `__dirname` is undefined at runtime → `oms setup` crashes.
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ──

const HOME = homedir();
const SNOW_DIR = join(HOME, '.snow');
const SETTINGS_PATH = join(SNOW_DIR, 'settings.json');
const SUB_AGENTS_PATH = join(SNOW_DIR, 'sub-agents.json');
const SKILLS_TARGET = join(SNOW_DIR, 'skills', 'oms');
const COMMANDS_TARGET = join(SNOW_DIR, 'commands', 'oms');
const GLOBAL_HOOKS_DIR = join(SNOW_DIR, 'hooks');

// Banner box geometry. The top/bottom borders are `╔` + N×`═` + `╗`; the
// content row is `║` + BANNER_INDENT spaces + padDisplay(text, W) + `║`.
// For the right `║` to land at the same column as the borders, the content
// region must equal the border's `═` count, so W = BANNER_INNER_WIDTH where
// BANNER_INNER_WIDTH = BANNER_BORDER_WIDTH − BANNER_INDENT.
// Keep these in sync with the `╔══...══╗` literals in setup()/uninstall()
// (the `═` count there must equal BANNER_BORDER_WIDTH).
const BANNER_BORDER_WIDTH = 50; // count of `═` in the top/bottom border
const BANNER_INDENT = 8; // spaces between `║` and the padded text
const BANNER_INNER_WIDTH = BANNER_BORDER_WIDTH - BANNER_INDENT; // = 42

const OMS_HOOK_DESCRIPTION_PREFIX = 'OMS:';

// i18n — read once at startup. Language follows snow-cli's ~/.snow/language.json.
const t = getTranslations().installer;

// ── Color helpers ──

const c = {
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/**
 * Pad a string to a target DISPLAY width (not char count).
 * CJK characters take 2 display columns; padEnd(42) counts them as 1, which
 * breaks the right border ║ of the setup/uninstall banner for zh/zh-TW.
 * This measures display width and pads with spaces accordingly.
 *
 * Callers pass BANNER_INNER_WIDTH (= BANNER_BORDER_WIDTH − BANNER_INDENT, see
 * constants above) so the right `║` lands at the same column as the borders.
 */
function padDisplay(str: string, width: number): string {
	let displayWidth = 0;
	for (const ch of str) {
		// CJK Unified Ideographs + common CJK punctuation ~ width 2.
		// Code point ranges: Hiragana/Katakana/CJK/CJK Ext/Fullwidth forms.
		const cp = ch.codePointAt(0) ?? 0;
		const isWide =
			(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
			(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals
			(cp >= 0x3040 && cp <= 0x33bf) || // Hiragana/Katakana/CJK punct
			(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
			(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
			(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
			(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
			(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
			(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compat Forms
			(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
			(cp >= 0xffe0 && cp <= 0xffe6);
		displayWidth += isWide ? 2 : 1;
	}
	const pad = Math.max(0, width - displayWidth);
	return str + ' '.repeat(pad);
}

// ── Path discovery ──

/** Find the global node_modules directory via `npm root -g`. */
function findGlobalNodeModules(): string {
	try {
		return execSync('npm root -g', {encoding: 'utf-8'}).trim();
	} catch {
		throw new Error(
			t.errFindNodeModules,
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

	// Try: __dirname (ESM-defined above; running from dist/ inside the package)
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
		t.errFindPackageDir,
	);
}

// ── JSON helpers ──

function readJson<T = unknown>(filePath: string): T {
	if (!existsSync(filePath)) {
		return {} as T;
	}
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
	} catch (error) {
		// Corrupt JSON — refuse to silently return {} and risk overwriting
		// the user's entire config. Throw so the caller can surface the error
		// and the user can fix the file manually before proceeding.
		throw new Error(
			`${filePath} exists but contains invalid JSON: ${(error as Error).message}. ` +
			`Fix or delete the file manually, then re-run oms setup.`,
		);
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
				t.warnMcpNotFound,
			),
		);
	}

	const settings = readJson<Record<string, unknown>>(SETTINGS_PATH);
	if (!settings.mcpServers) {
		settings.mcpServers = {};
	}

	// OMS_STATE_DIR is intentionally omitted — both the MCP server (store.ts)
	// and hook scripts (oms-state.mjs) fall back to process.cwd() at runtime,
	// which dynamically resolves to the current project directory.
	const mcpServers = settings.mcpServers as Record<string, unknown>;
	mcpServers['oms'] = {
		command: 'node',
		args: [mcpServerPath],
		timeout: 300000,
		enabled: true,
	};

	writeJson(SETTINGS_PATH, settings);
	console.log(c.green(t.mcpConfigAdded(SETTINGS_PATH)));
	console.log(c.dim(`    → node ${mcpServerPath}`));
}

// ── Setup: Sub-agents ──

/**
 * Pure field-level merge of OMS agents.
 *
 * Exported for testing. `tools` is preserved from the user's existing agent
 * when present (and non-empty); all other fields (`name`, `description`,
 * `role`, etc.) come from the package version so prompt fixes propagate.
 * Non-OMS agents are passed through unchanged. Package agents without a
 * matching user agent are added as-is.
 */
export function mergeOmsAgents(
	existingAgents: Array<Record<string, unknown>>,
	pkgAgents: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const existingOmsById = new Map<string, Record<string, unknown>>();
	for (const a of existingAgents) {
		const id = String(a.id || '');
		if (id.startsWith('oms_')) {
			existingOmsById.set(id, a);
		}
	}

	const nonOmsAgents = existingAgents.filter(
		a => !String(a.id || '').startsWith('oms_'),
	);

	const mergedOmsAgents = pkgAgents.map(pkgAgent => {
		const id = String(pkgAgent.id || '');
		const userAgent = existingOmsById.get(id);
		if (userAgent && Array.isArray(userAgent.tools) && userAgent.tools.length > 0) {
			return { ...pkgAgent, tools: userAgent.tools };
		}
		return pkgAgent;
	});

	return [...nonOmsAgents, ...mergedOmsAgents];
}

/**
 * Merge OMS agents into the user's ~/.snow/sub-agents.json.
 *
 * Field-level merge per agent id (see `mergeOmsAgents` for the contract):
 * - `tools`: PRESERVED from the user's existing agent. This is the critical
 *   customization surface — users may add project-specific MCP tools or
 *   remove tools they don't want. `oms setup` must never clobber it.
 * - `name` / `description` / `role`: UPDATED from the package so prompt
 *   improvements propagate on every setup.
 * - New package agents are added; deleted-by-user agents are reinstalled
 *   (cannot distinguish "deleted on purpose" from "never installed").
 */
function setupSubAgents(packageDir: string): void {
	const agentsPath = join(packageDir, 'assets', 'agents', 'sub-agents.json');
	if (!existsSync(agentsPath)) {
		console.warn(
			c.yellow(t.warnSubAgentsNotFound),
		);
		return;
	}

	const agentsData = readJson<{agents: Array<Record<string, unknown>>}>(
		agentsPath,
	);
	const omsAgents = agentsData.agents || [];

	// Read existing sub-agents.json (empty object if missing — see readJson).
	const existing = readJson<{agents: Array<Record<string, unknown>>}>(
		SUB_AGENTS_PATH,
	);
	const existingAgents = existing.agents || [];

	const mergedAgents = mergeOmsAgents(existingAgents, omsAgents);

	writeJson(SUB_AGENTS_PATH, { agents: mergedAgents });

	// Count how many agents had their tool config preserved, for user feedback.
	let preservedCount = 0;
	const pkgOmsIds = new Set(omsAgents.map(a => String(a.id || '')));
	for (const a of existingAgents) {
		const id = String(a.id || '');
		if (pkgOmsIds.has(id) && Array.isArray(a.tools) && a.tools.length > 0) {
			preservedCount++;
		}
	}
	console.log(
		c.green(
			t.subAgentsMerged(omsAgents.length, SUB_AGENTS_PATH),
		),
	);
	if (preservedCount > 0) {
		console.log(
			c.dim(
				`  Preserved tool config for ${preservedCount} customized OMS agent(s).`,
			),
		);
	}
}

// ── Setup: Skills ──

function setupSkills(packageDir: string): void {
	const skillsSource = join(packageDir, 'assets', 'skills', 'oms');

	if (!existsSync(skillsSource)) {
		console.warn(
			c.yellow(
				t.warnSkillsNotFound,
			),
		);
		return;
	}

	// Backup existing OMS skills before wipe-and-copy so user customizations
	// are not silently destroyed (maturity U7).
	if (existsSync(SKILLS_TARGET)) {
		const bak = `${SKILLS_TARGET}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			renameSync(SKILLS_TARGET, bak);
			console.log(c.yellow(`  ⚠ Existing skills backed up to ${bak}`));
		} catch {
			rmSync(SKILLS_TARGET, {recursive: true, force: true});
		}
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

	console.log(c.green(t.skillsCopied(skillCount, SKILLS_TARGET)));
}

// ── Setup: Commands ──

function setupCommands(packageDir: string): void {
	const commandsSource = join(packageDir, 'assets', 'commands', 'oms');

	if (!existsSync(commandsSource)) {
		console.warn(
			c.yellow(
				t.warnCommandsNotFound,
			),
		);
		return;
	}

	// Backup existing commands before wipe-and-copy (maturity U7).
	if (existsSync(COMMANDS_TARGET)) {
		const bak = `${COMMANDS_TARGET}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			renameSync(COMMANDS_TARGET, bak);
			console.log(c.yellow(`  ⚠ Existing commands backed up to ${bak}`));
		} catch {
			rmSync(COMMANDS_TARGET, {recursive: true, force: true});
		}
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
		c.green(t.commandsCopied(commandCount, COMMANDS_TARGET)),
	);
}

// ── Setup: Hooks ──

function setupHooks(packageDir: string): void {
	const hooksSourceDir = join(packageDir, 'hooks');
	const hookConfigsSourceDir = join(packageDir, 'assets', 'hooks');

	// Normalize a path to use forward slashes and wrap in double quotes
	// for safe cross-platform usage in shell commands.
	function toQuotedPath(p: string): string {
		return '"' + p.replace(/\\/g, '/') + '"';
	}

	// Hook scripts stay in the npm package — no copying to each project needed.
	// Commands in hook configs reference them via absolute paths.

	// 1. Install hook config JSONs to ~/.snow/hooks/ (global, merging with existing)
	if (existsSync(hookConfigsSourceDir)) {
		mkdirSync(GLOBAL_HOOKS_DIR, {recursive: true});

		const configFiles = readdirSync(hookConfigsSourceDir).filter(f =>
			f.endsWith('.json'),
		);

		for (const configFile of configFiles) {
			const configSrcPath = join(hookConfigsSourceDir, configFile);
			const configDstPath = join(GLOBAL_HOOKS_DIR, configFile);

			// Read the new OMS hook rules
			const omsRules = readJson<unknown[]>(configSrcPath);
			if (!Array.isArray(omsRules)) {
				continue;
			}

			// Replace relative paths in command fields with absolute paths to the npm package
			for (const rule of omsRules) {
				if (typeof rule === 'object' && rule !== null) {
					const hooks = (rule as Record<string, unknown>).hooks;
					if (Array.isArray(hooks)) {
						for (const hook of hooks) {
							if (typeof hook === 'object' && hook !== null) {
								const cmd = (hook as Record<string, unknown>).command;
								if (typeof cmd === 'string') {
									// Replace ".snow/oms-state/xxx.mjs" with absolute path to package hooks dir
									const scriptMatch = cmd.match(/\.snow\/oms-state\/(.+\.mjs)/);
									if (scriptMatch) {
										const absolutePath = join(hooksSourceDir, scriptMatch[1]);
										(hook as Record<string, unknown>).command =
											'node ' + toQuotedPath(absolutePath);
									}
								}
							}
						}
					}
				}
			}

			// Read existing rules (if any) and filter out old OMS rules.
			// Corrupt JSON: skip this file entirely — never wipe user hooks
			// down to OMS-only rules (maturity U7).
			let existingRules: unknown[] = [];
			if (existsSync(configDstPath)) {
				try {
					const existingData = readJson<unknown[]>(configDstPath);
					if (Array.isArray(existingData)) {
						existingRules = existingData;
					} else {
						console.warn(
							c.yellow(
								`  ⚠ Skipping ${configFile}: existing file is not a JSON array — fix it manually, then re-run oms setup.`,
							),
						);
						continue;
					}
				} catch (error) {
					console.warn(
						c.yellow(
							`  ⚠ Skipping ${configFile}: corrupt JSON (${(error as Error).message}) — not overwritten.`,
						),
					);
					continue;
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
				t.hookConfigsMerged(configFiles.length, GLOBAL_HOOKS_DIR),
			),
		);
	} else {
		console.warn(
			c.yellow(t.warnHooksNotFound),
		);
	}

	// 2. Create project-level .snow/oms-state/ directory (for runtime state storage)
	const stateDir = join(process.cwd(), '.snow', 'oms-state');
	mkdirSync(stateDir, {recursive: true});
	console.log(c.green(t.stateDirCreated(stateDir)));
}

// ── Uninstall: MCP server config ──

function uninstallMcpConfig(): void {
	if (!existsSync(SETTINGS_PATH)) {
		console.log(
			c.dim(t.mcpNotFound),
		);
		return;
	}

	const settings = readJson<Record<string, unknown>>(SETTINGS_PATH);
	const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;

	if (mcpServers && 'oms' in mcpServers) {
		delete mcpServers['oms'];
		writeJson(SETTINGS_PATH, settings);
		console.log(c.green(t.mcpRemoved(SETTINGS_PATH)));
	} else {
		console.log(c.dim(t.mcpNotFound));
	}
}

// ── Uninstall: Sub-agents ──

function uninstallSubAgents(): void {
	if (!existsSync(SUB_AGENTS_PATH)) {
		console.log(
			c.dim(t.agentsNotFound),
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
			c.green(t.agentsRemoved(removed, SUB_AGENTS_PATH)),
		);
	} else {
		console.log(c.dim(t.agentsNotFound));
	}
}

// ── Uninstall: Skills ──

function uninstallSkills(): void {
	if (existsSync(SKILLS_TARGET)) {
		rmSync(SKILLS_TARGET, {recursive: true, force: true});
		console.log(c.green(t.skillsDirRemoved(SKILLS_TARGET)));
	} else {
		console.log(c.dim(t.skillsDirNotFound));
	}
}

// ── Uninstall: Commands ──

function uninstallCommands(): void {
	if (existsSync(COMMANDS_TARGET)) {
		rmSync(COMMANDS_TARGET, {recursive: true, force: true});
		console.log(c.green(t.commandsDirRemoved(COMMANDS_TARGET)));
	} else {
		console.log(c.dim(t.commandsDirNotFound));
	}
}

function uninstallHooks(): void {
	// 1. Remove OMS hook rules from ~/.snow/hooks/*.json (global)
	if (existsSync(GLOBAL_HOOKS_DIR)) {
		let removedConfigs = 0;
		try {
			const configFiles = readdirSync(GLOBAL_HOOKS_DIR).filter(f =>
				f.endsWith('.json'),
			);

			for (const configFile of configFiles) {
				const configPath = join(GLOBAL_HOOKS_DIR, configFile);
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
						t.hookRulesRemoved(removedConfigs, GLOBAL_HOOKS_DIR),
					),
				);
			} else {
				console.log(
					c.dim(t.hookRulesNotFound),
				);
			}
		} catch {
			console.warn(c.yellow(t.hookDirReadFail));
		}
	} else {
		console.log(
			c.dim(
				t.hookDirNotFound,
			),
		);
	}

	// 2. Remove project-level .snow/oms-state/ directory (contains state.json)
	const stateDir = join(process.cwd(), '.snow', 'oms-state');
	if (existsSync(stateDir)) {
		rmSync(stateDir, {recursive: true, force: true});
		console.log(c.green(t.stateDirRemoved(stateDir)));
	} else {
		console.log(c.dim(t.stateDirNotFound));
	}
}

// ── Main entry points ──

function setup(): void {
	console.log(
		c.bold(c.cyan('\n╔══════════════════════════════════════════════════╗')),
	);
	console.log(
		c.bold(c.cyan(`║        ${padDisplay(t.setupBanner, BANNER_INNER_WIDTH)}║`)),
	);
	console.log(
		c.bold(c.cyan('╚══════════════════════════════════════════════════╝\n')),
	);

	// Find package directory
	let packageDir: string;
	try {
		packageDir = findPackageDir();
		console.log(c.dim(`  ${t.packageLabel} ${packageDir}`));
	} catch (error) {
		console.error(c.red(`\n✖ ${(error as Error).message}\n`));
		process.exit(1);
	}

	// Ensure ~/.snow/ exists
	mkdirSync(SNOW_DIR, {recursive: true});

	console.log(`\n  ${t.setupProgress}\n`);

	// 1. MCP server config
	setupMcpConfig(packageDir);

	// 2. Sub-agents
	setupSubAgents(packageDir);

	// 3. Skills
	setupSkills(packageDir);

	// 4. Commands
	setupCommands(packageDir);

	// 5-6. Hooks (global configs + project state dir)
	setupHooks(packageDir);

	console.log(c.green('\n  ═══════════════════════════════════════════════'));
	console.log(c.green(`  ${t.setupComplete}\n`));
	console.log(c.cyan(`  ${t.setupNextSteps}`));
	console.log(`    ${t.setupNextRestart}`);
	console.log(`    ${t.setupNextHelp}`);
	console.log(`    ${t.setupNextAuto}\n`);
}

function uninstall(): void {
	console.log(
		c.bold(c.yellow('\n╔══════════════════════════════════════════════════╗')),
	);
	console.log(
		c.bold(c.yellow(`║        ${padDisplay(t.uninstallBanner, BANNER_INNER_WIDTH)}║`)),
	);
	console.log(
		c.bold(c.yellow('╚══════════════════════════════════════════════════╝\n')),
	);

	console.log(`  ${t.uninstallProgress}\n`);

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
	console.log(c.green(`  ${t.uninstallComplete}\n`));
	console.log(c.cyan(`  ${t.uninstallRemoved}`));
	console.log(c.dim(`  ${t.uninstallRestart}\n`));
}

function help(): void {
	console.log(`
${c.bold(c.cyan(t.helpTitle))}

${c.bold(t.helpUsage)}
  ${t.helpUsageCommand}

${c.bold(t.helpCommands)}
  ${c.green('setup')}      ${t.helpCmdSetup}
  ${c.green('uninstall')}  ${t.helpCmdUninstall}
  ${c.green('help')}       ${t.helpCmdHelp}

${c.bold(t.helpSetupDetails)}
  ${t.helpSetupDetailItems}

${c.bold(t.helpUninstallDetails)}
  ${t.helpUninstallDetailItems}

${c.bold(t.helpAfterSetup)}
  ${t.helpAfterSetupItems}

${c.bold(t.helpPrerequisites)}
  • Snow CLI installed and configured
  • Node.js 18+
  • npm (for global installation)
`);
}


// ── CLI entry point ──
// Only run when invoked directly via `oms <command>`, not when imported as a
// module (e.g. by tests importing `mergeOmsAgents`).
//
// On Windows (and typically also macOS/Linux) npm installs globals as a
// symlink: `<prefix>/node_modules/oh-my-snow` → real package dir. The npm
// launcher (oms.cmd / oms shell script) passes the *symlink path* as
// process.argv[1], but Node's ESM loader resolves the symlink first, so
// import.meta.url points at the *real path*. `path.resolve()` does not
// resolve symlinks, so the raw comparison would always be false under a
// global install → `oms setup` silently does nothing (exit 0).
//
// Fix: realpathSync() both sides so symlinked and non-symlinked installs
// compare equal. realpathSync the invoked path only if it exists (argv may
// be a removed temp path or empty on some edge cases); realpathSync on
// import.meta.url is always safe since the module is loaded.
function isDirectInvocation(): boolean {
	if (!process.argv[1]) return false;
	const invokedRaw = resolve(process.argv[1]);
	const invoked = existsSync(invokedRaw)
		? realpathSync(invokedRaw).replace(/\\/g, '/')
		: invokedRaw.replace(/\\/g, '/');
	const here = realpathSync(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
	return invoked === here;
}

/**
 * Read package version from package.json next to dist/ or package root.
 */
function getPackageVersion(packageDir: string): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(packageDir, 'package.json'), 'utf-8'),
		) as {version?: string};
		return pkg.version ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Read timeout from installed or package onStop.json (first rule, first hook).
 */
function readOnStopTimeout(onStopPath: string): number | null {
	try {
		const data = JSON.parse(readFileSync(onStopPath, 'utf-8')) as unknown;
		if (!Array.isArray(data) || data.length === 0) return null;
		const hooks = (data[0] as {hooks?: unknown}).hooks;
		if (!Array.isArray(hooks) || hooks.length === 0) return null;
		const timeout = (hooks[0] as {timeout?: unknown}).timeout;
		return typeof timeout === 'number' ? timeout : null;
	} catch {
		return null;
	}
}

/**
 * oms doctor — post-install health check (maturity U9).
 * Exit 0 when healthy, 1 when any check fails.
 */
function doctor(): void {
	const packageDir = findPackageDir();
	const checks: {ok: boolean; label: string; detail: string}[] = [];

	// Package resolvable
	const pkgOk = Boolean(packageDir && existsSync(join(packageDir, 'package.json')));
	checks.push({
		ok: pkgOk,
		label: 'package',
		detail: pkgOk
			? `oh-my-snow ${getPackageVersion(packageDir!)} @ ${packageDir}`
			: 'oh-my-snow package not found (npm install -g oh-my-snow)',
	});

	// MCP registration
	let mcpOk = false;
	let mcpDetail = 'settings.json missing or unreadable';
	if (existsSync(SETTINGS_PATH)) {
		try {
			const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as {
				mcpServers?: Record<string, {command?: string; args?: string[]}>;
			};
			const oms = settings.mcpServers?.oms;
			if (oms?.args?.[0]) {
				const serverPath = oms.args[0];
				const pathOk = existsSync(serverPath);
				mcpOk = pathOk;
				mcpDetail = pathOk
					? `oms MCP → ${serverPath}`
					: `oms MCP path missing: ${serverPath} (re-run oms setup after nvm/prefix change)`;
			} else {
				mcpDetail = 'mcpServers.oms not registered — run oms setup';
			}
		} catch (error) {
			mcpDetail = `settings.json corrupt: ${(error as Error).message}`;
		}
	}
	checks.push({ok: mcpOk, label: 'mcp', detail: mcpDetail});

	// Agents count
	let agentsOk = false;
	let agentsDetail = 'sub-agents.json missing';
	if (existsSync(SUB_AGENTS_PATH)) {
		try {
			const data = JSON.parse(readFileSync(SUB_AGENTS_PATH, 'utf-8')) as {
				agents?: {id?: string}[];
			};
			const omsAgents = (data.agents ?? []).filter(
				a => typeof a.id === 'string' && a.id.startsWith('oms_'),
			);
			agentsOk = omsAgents.length === 18;
			agentsDetail = `${omsAgents.length}/18 oms_* agents`;
		} catch (error) {
			agentsDetail = `sub-agents.json corrupt: ${(error as Error).message}`;
		}
	}
	checks.push({ok: agentsOk, label: 'agents', detail: agentsDetail});

	// Skills
	let skillsOk = false;
	let skillsDetail = `skills missing at ${SKILLS_TARGET}`;
	if (existsSync(SKILLS_TARGET)) {
		const dirs = readdirSync(SKILLS_TARGET, {withFileTypes: true}).filter(d =>
			d.isDirectory(),
		);
		skillsOk = dirs.length >= 10;
		skillsDetail = `${dirs.length} skill dirs under ${SKILLS_TARGET}`;
	}
	checks.push({ok: skillsOk, label: 'skills', detail: skillsDetail});

	// Commands
	let commandsOk = false;
	let commandsDetail = `commands missing at ${COMMANDS_TARGET}`;
	if (existsSync(COMMANDS_TARGET)) {
		const files = readdirSync(COMMANDS_TARGET).filter(f => f.endsWith('.json'));
		commandsOk = files.length >= 18;
		commandsDetail = `${files.length} command json under ${COMMANDS_TARGET}`;
	}
	checks.push({ok: commandsOk, label: 'commands', detail: commandsDetail});

	// onStop timeout >= 330000
	const onStopInstalled = join(GLOBAL_HOOKS_DIR, 'onStop.json');
	const onStopAsset =
		packageDir !== null
			? join(packageDir, 'assets', 'hooks', 'onStop.json')
			: null;
	const timeoutPath = existsSync(onStopInstalled)
		? onStopInstalled
		: onStopAsset && existsSync(onStopAsset)
			? onStopAsset
			: null;
	const timeout = timeoutPath ? readOnStopTimeout(timeoutPath) : null;
	const timeoutOk = timeout !== null && timeout >= 330000;
	checks.push({
		ok: timeoutOk,
		label: 'onStop.timeout',
		detail:
			timeout === null
				? 'onStop.json not found or timeout missing — run oms setup'
				: `timeout=${timeout}ms (need >= 330000; verify is 300000 + buffer)`,
	});

	// Hook script paths exist (if installed)
	let hooksPathOk = true;
	let hooksPathDetail = 'hook configs not installed';
	if (existsSync(GLOBAL_HOOKS_DIR)) {
		const hookFiles = readdirSync(GLOBAL_HOOKS_DIR).filter(f =>
			f.endsWith('.json'),
		);
		const missing: string[] = [];
		for (const f of hookFiles) {
			try {
				const rules = JSON.parse(
					readFileSync(join(GLOBAL_HOOKS_DIR, f), 'utf-8'),
				) as {hooks?: {command?: string}[]}[];
				if (!Array.isArray(rules)) continue;
				for (const rule of rules) {
					const hooks = rule.hooks;
					if (!Array.isArray(hooks)) continue;
					for (const h of hooks) {
						const cmd = h.command ?? '';
						const m = cmd.match(/node\s+"?([^"]+\.mjs)"?/);
						if (m && !existsSync(m[1].replace(/^"|"$/g, ''))) {
							missing.push(m[1]);
						}
					}
				}
			} catch {
				// skip unreadable
			}
		}
		hooksPathOk = missing.length === 0;
		hooksPathDetail =
			missing.length === 0
				? `${hookFiles.length} hook configs; script paths OK`
				: `missing hook scripts: ${missing.slice(0, 3).join(', ')}`;
	}
	checks.push({ok: hooksPathOk, label: 'hook-paths', detail: hooksPathDetail});

	console.log(c.bold('\n  OMS doctor\n'));
	let failed = 0;
	for (const check of checks) {
		const mark = check.ok ? c.green('OK  ') : c.red('FAIL');
		console.log(`  ${mark} ${check.label.padEnd(16)} ${check.detail}`);
		if (!check.ok) failed++;
	}
	console.log('');
	if (failed > 0) {
		console.log(
			c.yellow(
				`  ${failed} check(s) failed. Run: npm install -g oh-my-snow && oms setup\n`,
			),
		);
		process.exit(1);
	}
	console.log(c.green('  All checks passed.\n'));
}

function printVersion(): void {
	const packageDir = findPackageDir();
	const version = packageDir ? getPackageVersion(packageDir) : 'unknown';
	console.log(`oh-my-snow ${version}`);
	if (packageDir) {
		console.log(packageDir);
	}
}

if (isDirectInvocation()) {
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
		case 'doctor':
			doctor();
			break;
		case 'version':
		case '--version':
		case '-v':
			printVersion();
			break;
		case 'help':
		case '--help':
		case '-h':
		case undefined:
			help();
			break;
		default:
			console.error(c.red(`\n✖ ${t.errUnknownCommand(command)}\n`));
			help();
			process.exit(1);
	}
}
