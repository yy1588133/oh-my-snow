import type {TranslationKeys} from '../types.js';

export const zh: TranslationKeys = {
	installer: {
		setupBanner: 'Oh-My-Snow (OMS) — 安装',
		setupProgress: '正在安装 OMS 组件...',
		packageLabel: '包路径:',
		mcpConfigAdded: (path: string) => `✓ MCP 服务器配置已添加到 ${path}`,
		subAgentsMerged: (count: number, path: string) => `✓ ${count} 个子代理已合并到 ${path}`,
		skillsCopied: (count: number, path: string) => `✓ ${count} 个技能已复制到 ${path}`,
		commandsCopied: (count: number, path: string) => `✓ ${count} 个命令已复制到 ${path}`,
		hookConfigsMerged: (count: number, path: string) => `✓ ${count} 个钩子配置已合并到 ${path}（全局）`,
		stateDirCreated: (path: string) => `✓ 状态目录已创建于 ${path}`,
		setupComplete: '✅ OMS 安装完成！',
		setupNextSteps: '后续步骤:',
		setupNextRestart: '1. 重启 Snow CLI 以加载新的 MCP 服务器和全局钩子',
		setupNextHelp: '2. 运行 /oms:help 查看所有可用命令',
		setupNextAuto: '3. 开始使用: /oms:auto "你的目标"',
		uninstallBanner: 'Oh-My-Snow (OMS) — 卸载',
		uninstallProgress: '正在移除 OMS 组件...',
		mcpRemoved: (path: string) => `✓ 已从 ${path} 移除 oms`,
		mcpNotFound: '• 未找到 settings.json,跳过 MCP 配置移除。',
		agentsRemoved: (count: number, path: string) => `✓ 已从 ${path} 移除 ${count} 个 OMS 代理`,
		agentsNotFound: '• 在 sub-agents.json 中未找到 OMS 代理,跳过。',
		skillsDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		skillsDirNotFound: '• 未找到 skills/oms/ 目录,跳过。',
		commandsDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		commandsDirNotFound: '• 未找到 commands/oms/ 目录,跳过。',
		hookRulesRemoved: (count: number, path: string) => `✓ 已从 ${path} 的 ${count} 个配置文件中移除 OMS 钩子规则`,
		hookRulesNotFound: '• 在 ~/.snow/hooks/ 中未找到 OMS 钩子规则,跳过。',
		hookDirReadFail: '⚠️  无法读取钩子配置目录。',
		hookDirNotFound: '• 未找到 ~/.snow/hooks/ 目录,跳过钩子配置移除。',
		stateDirRemoved: (path: string) => `✓ 已移除 ${path}`,
		stateDirNotFound: '• 未找到 .snow/oms-state/ 目录,跳过。',
		uninstallComplete: '✅ OMS 卸载完成！',
		uninstallRemoved: 'OMS 已从此项目完全移除。',
		uninstallRestart: '重启 Snow CLI 以应用更改。',
		helpTitle: 'Oh-My-Snow (OMS) — Snow CLI 自主编排插件',
		helpUsage: '用法:',
		helpUsageCommand: 'oms <命令>',
		helpCommands: '命令:',
		helpCmdSetup: 'setup      安装 OMS — 注册 MCP 服务器、代理、技能、命令和钩子',
		helpCmdUninstall: 'uninstall  卸载 OMS — 清理系统和项目中的所有 OMS 组件',
		helpCmdHelp: 'help       显示此帮助信息',
		helpSetupDetails: '安装详情:',
		helpUninstallDetails: '卸载详情:',
		helpAfterSetup: '安装完成后,在 Snow CLI 中使用:',
		helpPrerequisites: '前置条件:',
		helpSetupDetailItems:
			'• 在 ~/.snow/settings.json 注册 MCP 服务器\n' +
			'• 将 18 个子代理合并到 ~/.snow/sub-agents.json\n' +
			'• 复制 9 个技能到 ~/.snow/skills/oms/\n' +
			'• 复制 18 个命令到 ~/.snow/commands/oms/(11 个工作流 + 7 个技能映射)\n' +
			'• 安装 4 个钩子配置到 ~/.snow/hooks/(全局,使用绝对路径命令)\n' +
			'• 创建 <项目>/.snow/oms-state/ 用于存储会话状态(运行时按项目自动创建)',
		helpUninstallDetailItems:
			'• 从 settings.json 移除 MCP 服务器\n' +
			'• 从 sub-agents.json 移除所有 oms_* 代理\n' +
			'• 移除 ~/.snow/skills/oms/ 目录\n' +
			'• 移除 ~/.snow/commands/oms/ 目录\n' +
			'• 从 ~/.snow/hooks/*.json 移除 OMS 钩子规则(全局)\n' +
			'• 移除 <项目>/.snow/oms-state/ 目录',
		helpAfterSetupItems:
			'/oms:auto "你的目标"     — 启动自主编排\n' +
			'/oms:plan "你的目标"     — 迭代式规划达成共识\n' +
			'/oms:qa "上下文"         — 循环修复构建/测试错误\n' +
			'/oms:help                 — 完整使用指南(含所有功能)',
		errFindNodeModules: '无法找到全局 node_modules 路径。请确认 npm 已安装并在 PATH 中。',
		errFindPackageDir: '无法找到 oh-my-snow 包目录。请确保已全局安装(`npm install -g oh-my-snow`)或在包目录内运行。',
		errUnknownCommand: (command: string) => `未知命令: ${command}`,
		warnMcpNotFound: '⚠️  警告: 未找到 dist/mcp-server.js。请先运行 `npm run build`。',
		warnSubAgentsNotFound: '⚠️  警告: 包资源中未找到 sub-agents.json。',
		warnSkillsNotFound: '⚠️  警告: 包资源中未找到 skills/oms/ 目录。',
		warnCommandsNotFound: '⚠️  警告: 包资源中未找到 commands/oms/ 目录。',
		warnHooksNotFound: '⚠️  警告: 包中未找到 assets/hooks/ 目录。',
	},
};
