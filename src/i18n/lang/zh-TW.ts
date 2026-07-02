import type {TranslationKeys} from '../types.js';

export const zhTW: TranslationKeys = {
	installer: {
		setupBanner: 'Oh-My-Snow (OMS) — 安裝',
		setupProgress: '正在安裝 OMS 元件...',
		packageLabel: '套件路徑:',
		mcpConfigAdded: (path: string) => `✓ MCP 伺服器設定已新增至 ${path}`,
		subAgentsMerged: (count: number, path: string) => `✓ ${count} 個子代理已合併至 ${path}`,
		skillsCopied: (count: number, path: string) => `✓ ${count} 個技能已複製至 ${path}`,
		commandsCopied: (count: number, path: string) => `✓ ${count} 個命令已複製至 ${path}`,
		hookConfigsMerged: (count: number, path: string) => `✓ ${count} 個鉤子設定已合併至 ${path}（全域）`,
		stateDirCreated: (path: string) => `✓ 狀態目錄已建立於 ${path}`,
		setupComplete: '✅ OMS 安裝完成！',
		setupNextSteps: '後續步驟:',
		setupNextRestart: '1. 重啟 Snow CLI 以載入新的 MCP 伺服器和全域鉤子',
		setupNextHelp: '2. 執行 /oms:help 查看所有可用命令',
		setupNextAuto: '3. 開始使用: /oms:auto "你的目標"',
		uninstallBanner: 'Oh-My-Snow (OMS) — 解除安裝',
		uninstallProgress: '正在移除 OMS 元件...',
		mcpRemoved: (path: string) => `✓ 已從 ${path} 移除 oms`,
		mcpNotFound: '• 找不到 settings.json,略過 MCP 設定移除。',
		agentsRemoved: (count: number, path: string) => `✓ 已從 ${path} 移除 ${count} 個 OMS 代理`,
		agentsNotFound: '• 在 sub-agents.json 中找不到 OMS 代理,略過。',
		skillsDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		skillsDirNotFound: '• 找不到 skills/oms/ 目錄,略過。',
		commandsDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		commandsDirNotFound: '• 找不到 commands/oms/ 目錄,略過。',
		hookRulesRemoved: (count: number, path: string) => `✓ 已從 ${path} 的 ${count} 個設定檔中移除 OMS 鉤子規則`,
		hookRulesNotFound: '• 在 ~/.snow/hooks/ 中找不到 OMS 鉤子規則,略過。',
		hookDirReadFail: '⚠️  無法讀取鉤子設定目錄。',
		hookDirNotFound: '• 找不到 ~/.snow/hooks/ 目錄,略過鉤子設定移除。',
		stateDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		stateDirNotFound: '• 找不到 .snow/oms-state/ 目錄,略過。',
		uninstallComplete: '✅ OMS 解除安裝完成！',
		uninstallRemoved: 'OMS 已從此專案完全移除。',
		uninstallRestart: '重啟 Snow CLI 以套用變更。',
		helpTitle: 'Oh-My-Snow (OMS) — Snow CLI 自主編排外掛',
		helpUsage: '用法:',
		helpUsageCommand: 'oms <命令>',
		helpCommands: '命令:',
		helpCmdSetup: 'setup      安裝 OMS — 註冊 MCP 伺服器、代理、技能、命令和鉤子',
		helpCmdUninstall: 'uninstall  解除安裝 OMS — 清理系統和專案中的所有 OMS 元件',
		helpCmdHelp: 'help       顯示此說明訊息',
		helpSetupDetails: '安裝詳情:',
		helpUninstallDetails: '解除安裝詳情:',
		helpAfterSetup: '安裝完成後,在 Snow CLI 中使用:',
		helpPrerequisites: '前置條件:',
		helpSetupDetailItems:
			'• 在 ~/.snow/settings.json 註冊 MCP 伺服器\n' +
			'• 將 18 個子代理合併到 ~/.snow/sub-agents.json\n' +
			'• 複製 9 個技能到 ~/.snow/skills/oms/\n' +
			'• 複製 18 個命令到 ~/.snow/commands/oms/(11 個工作流 + 7 個技能映射)\n' +
			'• 安裝 4 個鉤子設定到 ~/.snow/hooks/(全域,使用絕對路徑命令)\n' +
			'• 建立 <專案>/.snow/oms-state/ 用於儲存工作階段狀態(執行時按專案自動建立)',
		helpUninstallDetailItems:
			'• 從 settings.json 移除 MCP 伺服器\n' +
			'• 從 sub-agents.json 移除所有 oms_* 代理\n' +
			'• 移除 ~/.snow/skills/oms/ 目錄\n' +
			'• 移除 ~/.snow/commands/oms/ 目錄\n' +
			'• 從 ~/.snow/hooks/*.json 移除 OMS 鉤子規則(全域)\n' +
			'• 移除 <專案>/.snow/oms-state/ 目錄',
		helpAfterSetupItems:
			'/oms:auto "你的目標"     — 啟動自主編排\n' +
			'/oms:plan "你的目標"     — 迭代式規劃達成共識\n' +
			'/oms:qa "上下文"         — 迴圈修復建置/測試錯誤\n' +
			'/oms:help                 — 完整使用指南(含所有功能)',
		errFindNodeModules: '無法找到全域 node_modules 路徑。請確認 npm 已安裝並在 PATH 中。',
		errFindPackageDir: '無法找到 oh-my-snow 套件目錄。請確保已全域安裝(`npm install -g oh-my-snow`)或在套件目錄內執行。',
		errUnknownCommand: (command: string) => `未知命令: ${command}`,
		warnMcpNotFound: '⚠️  警告: 找不到 dist/mcp-server.js。請先執行 `npm run build`。',
		warnSubAgentsNotFound: '⚠️  警告: 套件資源中找不到 sub-agents.json。',
		warnSkillsNotFound: '⚠️  警告: 套件資源中找不到 skills/oms/ 目錄。',
		warnCommandsNotFound: '⚠️  警告: 套件資源中找不到 commands/oms/ 目錄。',
		warnHooksNotFound: '⚠️  警告: 套件中找不到 assets/hooks/ 目錄。',
	},
};
