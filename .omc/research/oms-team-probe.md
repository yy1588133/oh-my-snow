# OMS Team Plan 鉴别探针验证报告

> 日期: 2026-07-02
> 来源: oms-team-plan.md Phase 1 第 0 步要求的鉴别探针
> 探针方式: 静态源码核实（snow-cli 主仓库 `D:\yangyang\Docker\snow-cli\source`）
> 目的: 在动代码前确认两个决定整个方案可行性的硬问题

## 背景

oms-team-plan.md Phase 1 第 0 步要求"写代码前先跑鉴别探针"，并配了判定阈值表：

> (a) teammate 的 filesystem-create 是否被 OMS beforeToolCall 阻断？
> (b) 不手动 /team，仅 OMS 写 settings.json teamMode=true，lead 下轮能否看到 team-* 工具？

判定阈值：
- (a) 阻断 + (b) 工具可见 → 方案核心可行，继续后续步骤
- (a) 阻断 + (b) 工具不可见 → 激活需 fallback
- (a) 未阻断 → hooks 不生效，整个方案前提崩塌
- (b) 单独失败但 (a) 成功 → 不阻断，激活走 fallback 提示路径

## 探针 (a)：teammate 工具循环是否触发 beforeToolCall

**核实方法**: grep snow-cli `source/utils/execution/teamExecutor.ts` 中的 hook 调用。

**核实结果 ✅ 成立**：

- `teamExecutor.ts:992-997`（第一处工具循环）：teammate 调工具前先 `executeHooks('beforeToolCall', {toolName, args})`
- `teamExecutor.ts:1154-1159`（第二处工具循环）：同样调 `executeHooks('beforeToolCall', ...)`
- `:998-1001` 和 `:1160-1163`：`interpretHookResult` 返回 `action === 'block'` 时，工具被阻断，结果回传给 teammate

**结论**: teammate 子进程的工具调用**确实触发 OMS beforeToolCall hook**。OMS 的阶段强制（planning/verifying 阻断 filesystem-edit）对 teammate 同样生效，因为 teammate 的 cwd 继承主项目根，hook 读的是同一份 `.snow/oms-state/state.json`。

**判定**: (a) = 阻断生效。符合"方案核心可行"的前提。

## 探针 (b)：写 settings.json teamMode 后工具列表是否重建

**核实方法**: grep `mcpToolsManager.ts` 的 configHash 计算 + teamMode 引用 + team-* 工具挂载逻辑。

**核实结果 ✅ 机制通**：

- `mcpToolsManager.ts:206`：`configHash` 的输入包含 `teamMode: getTeamMode()` —— teamMode 是 configHash 的一部分
- `mcpToolsManager.ts:225`：`const configChanged = toolsCache.configHash !== configHash;` —— configHash 变化时 configChanged=true
- `mcpToolsManager.ts:411`：team 工具挂载时 name 加 `team-` 前缀 → `team-${tool.name}`
- `mcpToolsManager.ts:1241-1243`：工具名 `team-` 前缀路由到 team service

snow-cli 的 `getTeamMode`（`projectSettings.ts:168-171`）：
```ts
export function getTeamMode(): boolean {
  const settings = loadSettings();  // project 优先，回退 global
  return settings.teamMode ?? false;
}
```
`loadSettings`（`projectSettings.ts:46-73`）用 `readSettings('project')` 优先、`readSettings('global')` 回退 —— 写项目级 `.snow/settings.json` 的 `teamMode=true` 即可让 getTeamMode 返回 true。

**结论**: 写项目级 settings.json 后，**下一轮** lead 的工具列表会重建（configChanged=true 触发重建），team-* 工具被挂载。但**同一轮内**工具列表已固定，不会即时可见。

**判定**: (b) = 工具可见（下一轮）。符合"方案核心可行"的前提。

## 探针结论

| 探针 | 结果 | 判定 |
|------|------|------|
| (a) teammate 触发 beforeToolCall | ✅ 成立（teamExecutor.ts:994/:1156） | 阻断生效 |
| (b) 写 teamMode 后工具列表重建 | ✅ 成立（mcpToolsManager.ts:206/225） | 工具下一轮可见 |

**总判定: (a) 阻断 + (b) 工具可见 → 方案核心可行，继续后续步骤。**

## 衍生发现：激活链路的真正断裂点

探针虽然确认了 (a)(b) 机制都通，但深入核查发现**两机制之间的衔接断裂**：

- 探针 (b) 的前提是"有人写 settings.json 的 teamMode=true"
- 但 OMS 代码里**没有任何一处写这个文件**：
  - `oms-set-team` 工具原实现只调 `setTeamName(state, teamName)`，改的是 `state.json` 的 `teamName` 字段，**不碰 settings.json**
  - `installer.ts` grep `teamMode` 零命中
  - `/oms:team` 命令 prompt 声称"OMS activated snow-cli's built-in Team Mode for you (wrote teamMode=true)"，但实际没人执行这个写入
- 而 AI 自己不能在 planning 阶段编辑 settings.json —— beforeToolCall 会硬阻断 filesystem-edit（planning 纪律）

**结果**: 真实环境下 teamMode 永远是 false → team-* 工具永远不挂载 → AI 调 team-spawn_teammate 时 snow-cli 报"工具不存在" → beforeToolCall 的 spawn 阻断分支是死代码（matcher 都没机会跑）。整个 team 流程跑不起来，除非用户手动 `/team`。

这就是为什么单元测试全绿但真机跑不起来：测试直接构造假的 `{toolName: 'team-spawn_teammate'}` 喂给 hook 脚本（`test-v2-hooks.mjs:72`），绕过了"snow-cli 是否真把 team 工具挂载进 AI 工具列表"这个前提。

## 修复方案（已落地）

把激活写入下沉到 `oms-set-team` MCP 工具内部：

1. **store.ts 新增 `setProjectTeamMode(enabled)`**: 原子写项目级 `.snow/settings.json` 的 `teamMode` 字段（复用 saveState 的 lock+tmp+rename 模式），保留其他字段，幂等（已为目标值则跳过）。
2. **`setTeamName` 改造**: 存完 state.teamName 后调用 `setProjectTeamMode(true)`，激活 snow-cli Team Mode。settings.json 写失败不抛错（fallback 走命令 prompt 的"手动 /team"提示）。
3. **oms-set-team 工具描述 + 返回信息更新**: 明确告知 lead"teamMode 已激活，team-* 工具下一轮可见，本轮不要调 team-*"。
4. **team.json 命令 prompt 修正**: 删掉空头支票"已经帮你激活"，改成明确"调 oms-set-team 来激活"+ 强调"下一轮工具才可见"。

**为什么下沉到 MCP 工具而不是命令 prompt 或 AI 自身**:
- planning 阶段 beforeToolCall 硬阻断 filesystem-edit → AI 不能自己写 settings.json
- MCP 工具是 server 进程执行写文件，绕开 hook —— 这是唯一能在 planning 阶段完成激活的路径

## 仍需真机验证的项（静态探针无法覆盖）

以下需要真实 Snow CLI 运行环境验证，本次静态探针无法覆盖：

1. **configHash 重建时序**: 写 settings.json 后到工具列表重建之间，lead 同轮内调 team-spawn_teammate 是否真能拿到工具（team.json prompt 已加"下一轮才可见"提示兜底）
2. **teammate 子进程 teamMode 传递**: teamExecutor.ts 调 chat API 不传 teamMode（teammate 拿默认系统提示词），但 teamContext prompt 注入覆盖了核心上下文 —— 需真机确认 teammate 行为符合预期
3. **端到端 team 流程**: planning→executing(spawn)→verifying(merge)→done(cleanup) 全链路真机跑通

这三项是 team-plan Risks 表里已识别的，且有兜底措施，不阻断本次代码修复落地。
