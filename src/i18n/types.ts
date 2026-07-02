// OMS i18n types
//
// Language codes MUST align with snow-cli's source/utils/config/languageConfig.ts
// so that the shared ~/.snow/language.json switch drives both snow-cli and oms.
// snow-cli supports: 'en' | 'zh' | 'zh-TW'

export type Language = 'en' | 'zh' | 'zh-TW';

/**
 * The full translation table — one entry per supported language.
 */
export type Translations = Record<Language, TranslationKeys>;

/**
 * Translation keys for all user-facing strings in oms.
 * AI-facing strings (MCP tool descriptions, hook-injected prompts,
 * command `command` fields) are NOT translated and stay English.
 *
 * Strings with dynamic values are functions that take the values
 * and return the formatted string. This keeps interpolation explicit
 * and type-checked, unlike naive string.replace.
 */
export interface TranslationKeys {
	installer: {
		// Setup banner + steps
		setupBanner: string;
		setupProgress: string;
		packageLabel: string;
		mcpConfigAdded: (path: string) => string;
		subAgentsMerged: (count: number, path: string) => string;
		skillsCopied: (count: number, path: string) => string;
		commandsCopied: (count: number, path: string) => string;
		hookConfigsMerged: (count: number, path: string) => string;
		stateDirCreated: (path: string) => string;
		setupComplete: string;
		setupNextSteps: string;
		setupNextRestart: string;
		setupNextHelp: string;
		setupNextAuto: string;
		// Uninstall
		uninstallBanner: string;
		uninstallProgress: string;
		mcpRemoved: (path: string) => string;
		mcpNotFound: string;
		agentsRemoved: (count: number, path: string) => string;
		agentsNotFound: string;
		skillsDirRemoved: (path: string) => string;
		skillsDirNotFound: string;
		commandsDirRemoved: (path: string) => string;
		commandsDirNotFound: string;
		hookRulesRemoved: (count: number, path: string) => string;
		hookRulesNotFound: string;
		hookDirReadFail: string;
		hookDirNotFound: string;
		stateDirRemoved: (path: string) => string;
		stateDirNotFound: string;
		uninstallComplete: string;
		uninstallRemoved: string;
		uninstallRestart: string;
		// Help
		helpTitle: string;
		helpUsage: string;
		helpUsageCommand: string;
		helpCommands: string;
		helpCmdSetup: string;
		helpCmdUninstall: string;
		helpCmdHelp: string;
		helpSetupDetails: string;
		helpUninstallDetails: string;
		helpAfterSetup: string;
		helpPrerequisites: string;
		// Help detail bullet lists (multi-line, \n-separated)
		helpSetupDetailItems: string;
		helpUninstallDetailItems: string;
		helpAfterSetupItems: string;
		// Errors
		errFindNodeModules: string;
		errFindPackageDir: string;
		errUnknownCommand: (command: string) => string;
		warnMcpNotFound: string;
		warnSubAgentsNotFound: string;
		warnSkillsNotFound: string;
		warnCommandsNotFound: string;
		warnHooksNotFound: string;
	};
}
