import type {TranslationKeys} from '../types.js';

export const en: TranslationKeys = {
	installer: {
		setupBanner: 'Oh-My-Snow (OMS) — Setup',
		setupProgress: 'Setting up OMS components...',
		packageLabel: 'Package:',
		mcpConfigAdded: (n: string) => `✓ MCP server config added to ${n}`,
		subAgentsMerged: (n: number, p: string) => `✓ ${n} sub-agents merged into ${p}`,
		skillsCopied: (n: number, p: string) => `✓ ${n} skills copied to ${p}`,
		commandsCopied: (n: number, p: string) => `✓ ${n} commands copied to ${p}`,
		hookConfigsMerged: (n: number, p: string) => `✓ ${n} hook configs merged into ${p} (global)`,
		stateDirCreated: (p: string) => `✓ State directory created at ${p}`,
		setupComplete: '✅ OMS setup complete!',
		setupNextSteps: 'Next steps:',
		setupNextRestart: '1. Restart Snow CLI to load the new MCP server and global hooks',
		setupNextHelp: '2. Run /oms:help to see all available commands',
		setupNextAuto: '3. Start with: /oms:auto "your goal here"',
		uninstallBanner: 'Oh-My-Snow (OMS) — Uninstall',
		uninstallProgress: 'Removing OMS components...',
		mcpRemoved: (p: string) => `✓ Removed oms from ${p}`,
		mcpNotFound: '• settings.json not found, skipping MCP config removal.',
		agentsRemoved: (n: number, p: string) => `✓ Removed ${n} OMS agents from ${p}`,
		agentsNotFound: '• No OMS agents found in sub-agents.json, skipping.',
		skillsDirRemoved: (p: string) => `✓ Removed ${p}`,
		skillsDirNotFound: '• skills/oms/ directory not found, skipping.',
		commandsDirRemoved: (p: string) => `✓ Removed ${p}`,
		commandsDirNotFound: '• commands/oms/ directory not found, skipping.',
		hookRulesRemoved: (n: number, p: string) => `✓ Removed OMS hook rules from ${n} config file(s) in ${p}`,
		hookRulesNotFound: '• No OMS hook rules found in ~/.snow/hooks/, skipping.',
		hookDirReadFail: '⚠️  Could not read hook config directory.',
		hookDirNotFound: '• ~/.snow/hooks/ directory not found, skipping hook config removal.',
		stateDirRemoved: (p: string) => `✓ Removed ${p}`,
		stateDirNotFound: '• .snow/oms-state/ directory not found, skipping.',
		uninstallComplete: '✅ OMS uninstall complete!',
		uninstallRemoved: 'OMS has been fully removed from this project.',
		uninstallRestart: 'Restart Snow CLI to apply the changes.',
		helpTitle: 'Oh-My-Snow (OMS) — Autonomous orchestration plugin for Snow CLI',
		helpUsage: 'Usage:',
		helpUsageCommand: 'oms <command>',
		helpCommands: 'Commands:',
		helpCmdSetup: 'setup      Install OMS — register MCP server, agents, skills, commands, and hooks',
		helpCmdUninstall: 'uninstall  Remove OMS — clean up all OMS components from system and project',
		helpCmdHelp: 'help       Show this help message',
		helpSetupDetails: 'Setup details:',
		helpUninstallDetails: 'Uninstall details:',
		helpAfterSetup: 'After setup, use in Snow CLI:',
		helpPrerequisites: 'Prerequisites:',
		helpSetupDetailItems:
			'• Registers MCP server in ~/.snow/settings.json\n' +
			'• Merges 18 sub-agents into ~/.snow/sub-agents.json\n' +
			'• Copies 10 skills to ~/.snow/skills/oms/\n' +
			'• Copies 18 commands to ~/.snow/commands/oms/ (7 workflow + 11 skill mappings)\n' +
			'• Installs 4 hook configs to ~/.snow/hooks/ (global, with absolute path commands)\n' +
			'• Creates <project>/.snow/oms-state/ for session state (auto-created per project at runtime)',
		helpUninstallDetailItems:
			'• Removes MCP server from settings.json\n' +
			'• Removes all oms_* agents from sub-agents.json\n' +
			'• Removes ~/.snow/skills/oms/ directory\n' +
			'• Removes ~/.snow/commands/oms/ directory\n' +
			'• Removes OMS hook rules from ~/.snow/hooks/*.json (global)\n' +
			'• Removes <project>/.snow/oms-state/ directory',
		helpAfterSetupItems:
			'/oms:auto "your goal"     — Start autonomous orchestration\n' +
			'/oms:plan "your goal"     — Strategic planning — consensus loop produces decision artifact, execution only after approval\n' +
			'/oms:qa "context"         — Fix build/test errors in a loop\n' +
			'/oms:help                 — Full usage guide with all features',
		errFindNodeModules: 'Failed to find global node_modules path. Is npm installed and on PATH?',
		errFindPackageDir: 'Could not find the oh-my-snow package directory. Ensure it is installed globally (`npm install -g oh-my-snow`) or run from within the package directory.',
		errUnknownCommand: (c: string) => `Unknown command: ${c}`,
		warnMcpNotFound: '⚠️  Warning: dist/mcp-server.js not found. Run `npm run build` first.',
		warnSubAgentsNotFound: '⚠️  Warning: sub-agents.json not found in package assets.',
		warnSkillsNotFound: '⚠️  Warning: skills/oms/ directory not found in package assets.',
		warnCommandsNotFound: '⚠️  Warning: commands/oms/ directory not found in package assets.',
		warnHooksNotFound: '⚠️  Warning: assets/hooks/ directory not found in package.',
	},
};
