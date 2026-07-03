---
name: vverify
description: 截图驱动的视觉 QA 判定器——把当前截图与参考图对比，返回严格 JSON 裁决，驱动下一轮编辑直到通过 90 分阈值
---

# OMS Vverify Skill

这是一台「看截图判差距」的视觉 QA 裁判，不是代码审查器。核心机制：读两张图（参考图 + 当前输出图），对比布局/间距/字体/颜色/层级，吐出一份严格 JSON 裁决（分数 + 通过/修改/失败 + 具体差距 + 可执行修改建议）。分数不到 90 就继续改、重跑，直到过线才算完。像素级 diff 只当辅助调试定位热点，权威判定永远是这份 JSON。

## When to Use

- 改完前端 UI，要确认实际渲染跟设计稿对得上（不是看代码猜，是看截图）
- 任务带视觉保真度要求：布局、间距、字体、组件样式、配色
- 手上有当前截图 + 至少一张参考图，需要一个可程序化判断 pass/fail 的结果驱动下一轮编辑
- 跑迭代循环：改完截图 → 判分 → 没过线继续改 → 重跑，直到 ≥90

## When NOT to Use

- 只改了后端/逻辑/数据层，没有视觉输出——直接走测试或 trace
- 没有参考图也没法拿到当前截图——这玩意儿没图没法判
- 想要代码层面的 UI 审查（design token 用没用、a11y、跨浏览器兼容）——那是老版 vverify 干的事，现在 vverify 只看截图。代码审查走 `#oms_reviewer` 或 `#oms_frontend`
- 想做像素级回归测试自动化——vverify 是单次判定，不是 CI 集成的回归套件

## Why This Exists

旧版 vverify 是「看代码猜视觉」——读 .tsx/.css，对照设计 token 表格，猜渲染出来啥样。问题是猜得再准也不等于实际渲染对得上。真出了视觉 bug，代码看着没问题，浏览器里就是歪的。omc 的 visual-verdict 把方向反过来：别猜代码，直接看截图。拿当前截图和参考图一比，差距摆在台面上，分数说话，不到 90 不算完。这样判定是证据驱动的，不是直觉驱动的；而且 JSON 结构化输出能被上层流水线当门控用——`score < 90` 就不让往下走。

## Procedure

### Phase 1: 准备输入

收齐三样东西：

1. **参考图 `reference_images[]`**：1 张或多张设计稿/目标截图的本地路径。多张时按优先级排（主参考图在前）
2. **当前截图 `generated_screenshot`**：本次编辑后渲染出来的输出图路径
3. **可选 `category_hint`**：目标 UI 类别/风格标签，例如 `hackernews`、`sns-feed`、`dashboard`、`landing-page`。帮判定时对齐「这是该长什么样」的预期

用 `filesystem-read` 把两张图读进来。**没有图就别判**——vverify 的核心哲学是看截图不看代码，没图等于没证据。

### Phase 2: 视觉对比与判定

逐项对比参考图 vs 当前截图，五维度：

| 维度 | 看什么 |
|---|---|
| 布局 (layout) | 主区块位置/大小/对齐，flex/grid 结构是否一致 |
| 间距 (spacing) | padding/margin/gap，密集还是松散 |
| 字体 (typography) | 字号/字重/行高/字体族 |
| 颜色 (colors) | 背景/文本/边框/强调色 |
| 层级 (hierarchy) | 视觉权重分布，主次是否突出 |

判定时同时检查 `category_match`：当前截图整体看起来像不像目标类别该有的样子（例如标签是 `sns-feed` 但截图长得像表单页，`category_match=false`）。

### Phase 3: 输出严格 JSON（6 字段契约）

**只返回 JSON，不返回别的文字。** 严格按这个形状：

```json
{
  "score": 0,
  "verdict": "revise",
  "category_match": false,
  "differences": ["..."],
  "suggestions": ["..."],
  "reasoning": "short explanation"
}
```

字段规则：
- `score`：整数 0-100，对参考图的视觉吻合度
- `verdict`：`pass`（≥90）/ `revise`（60-89，能改）/ `fail`（<60，方向就错了）
- `category_match`：布尔，截图是否符合 `category_hint` 描述的 UI 类别/风格（未给 hint 时按参考图整体风格判）
- `differences[]`：具体视觉差距，每条绑一个维度（布局/间距/字体/颜色/层级），描述「参考图是 X，当前是 Y」
- `suggestions[]`：可执行的下一步编辑动作，与 `differences[]` 一一对应或明显关联，落到具体改哪个值/哪个组件
- `reasoning`：1-2 句总结，说明分数怎么来的

### Phase 4: 阈值循环

- 通过阈值是 **90+**。`score >= 90` 且 `verdict=pass` 才算过
- `score < 90`：把 `suggestions[]` 喂给下一轮编辑，改完重新截图，再跑 `/oms:vverify`
- **没过阈值不算任务完成**——上层流水线（dive/autopilot 等）拿这个 JSON 当门控，`verdict != pass` 就卡住不让往下走
- 每轮判定是无状态的：不存历史 score。要看迭代轨迹，调用方自己记录每轮 JSON

### Phase 5: 像素 diff 调试辅助（仅当难诊断时）

当 `differences[]` 写不出来、差距说不清在哪、或两轮分数卡住不动时，上像素级 diff 定位热点：

1. 用 `terminal-execute` 跑像素 diff 工具：
   - ImageMagick：`compare -metric AE reference.png current.png diff.png`
   - pixelmatch CLI：`npx pixelmatch reference.png current.png diff.png`
   - 本地没有就 `npm i -D pixelmatch` 或装 ImageMagick
2. 看 diff.png 的红/黄热点区域，把每个热点转成一条 `differences[]` + 对应 `suggestions[]`
3. **像素 diff 永远是辅助，不是权威。** 权威判定仍然是 Phase 3 的 JSON。像素 diff 只帮你想清楚 `differences[]` 怎么写，不替你打分

## Fallback (snow-cli 工具限制的临时 workaround，不是等价路径)

> **⚠️ 这不是 vverify 的正常路径。** vverify 的输入契约是严格三输入（参考图 + 当前截图 + 可选 category_hint）。下面这条 fallback 只在 snow-cli 的 `filesystem-read` 暂时不支持读图像二进制时才用，**`filesystem-read` 支持读图后必须走标准三输入路径**。

**触发条件**：调用方确实拿不到图（既不能 `filesystem-read` 读二进制，也不能 `terminal-execute` 调截图工具现拿一张）。

**fallback 行为**：

1. **优先劝退**——告诉调用方「vverify 需要真图，请补图后重跑」，直接报 `verdict=fail`、`differences=["缺少参考图/当前截图，无法判定"]`、`reasoning="vverify 需要截图证据，未拿到图"`，让调用方补图再来。
2. **兜底描述模式**（仅在调用方明确坚持且确认这是临时 workaround 时）：要求调用方在调用时把两张图的**内容/差异描述**贴进来（「参考图描述」「当前截图描述」），vverify 基于描述判分。**必须在 `reasoning` 字段里显式标注 `"evidence_mode": "description_fallback"`**，提醒调用方判定的证据基础从「截图」退化为「描述」，不等价于标准路径，分数置信度打折。
3. **禁止静默走 fallback**——走描述模式时必须在 JSON 里显式标注，调用方一看就知道这次判定不是标准视觉判定。

**为什么这条单独成章**：把 fallback 混进 Phase 1 主流程会让调用方误以为「没图也能跑 vverify」是等价路径，但它不是——看描述判分违背「看截图不看代码」的核心哲学。隔离成独立章节 + 显式标注 + 优先劝退，才能保护输入契约边界。

## Execution Policy

- **只返回 JSON。** Phase 3 的契约是硬约束，多一个字段、少一个字段、带 markdown 包裹都算违反。调用方按字段名程序化解析，结构错就解析失败
- `score` 必须有证据：每条 `differences[]` 都要能对应到截图里具体位置/元素，不能空说「不太对」
- `suggestions[]` 必须可执行：落到「改哪个组件/哪个值/加几 px」，不能是「改好点」这种废话
- 90 分是硬阈值，不是建议。`score=89` 一样不算过
- 没有参考图就别判——直接报 `verdict=fail`，`differences=["缺少参考图，无法判定"]`，让调用方补图
- 像素 diff 不替代视觉判定。哪怕 diff 全绿，截图主观上歪了，`verdict` 照样 `revise`
- 判定是无状态单次调用，不读不写 `oms-state`

## Anti-Patterns (Forbidden)

- **看代码猜视觉**：读 .tsx/.css 然后说「应该没问题」——这是旧 vverify 的毛病，现在禁掉。vverify 只看截图。要看代码走 `#oms_frontend`
- **改 JSON 形状**：加 `severity`、`tags`、`components` 等额外字段，或把 `verdict` 写成 `needs_work`——调用方按 6 字段解析，多字段就崩
- **像素 diff 当权威**：拿 ImageMagick 的 AE 数值直接打分——数值只说像素差多少，不说差在哪、是不是重要。权威永远是人工视觉判定的 JSON
- **90 分放水**：因为「差不多」「改不动了」给 90——阈值是硬的，没过就是没过。放水等于伪造 token
- **空 differences/suggestions**：`differences: []` 但 `score=70`——分数低就一定有差距，写不出来说明没认真看图
- **suggestions 不绑定 differences**：建议跟差距对不上号——每条建议要能指回它解决哪条差距
- **把描述模式当等价路径**：走 Fallback 描述模式时不标 `evidence_mode`，或把它当标准路径推荐给调用方——描述模式是 snow-cli 工具限制的临时 workaround，看描述判分不等价于看截图，必须显式标注 + 优先劝退补图

## Quick Reference

| 工具/agent | 用途 |
|---|---|
| `filesystem-read` | 读参考图和当前截图（若 snow-cli 支持图像读取） |
| `terminal-execute` | 跑像素 diff（ImageMagick `compare` / pixelmatch CLI）；不支持读图时也可拿截图（`npx playwright screenshot`） |
| `/oms:vverify` | 触发本 skill 的命令入口 |
| `skill-execute { skill: "oms/vverify" }` | 程序化调用入口，上层流水线用这个拿 JSON 当门控 |
| `#oms_frontend` | 代码层面 UI 审查（design token / a11y / 跨浏览器）。仅当 `verdict=fail` 且差距属代码层问题（token 用错、a11y 缺失、跨浏览器不一致）时介入，截图判定搞不定时补充 |
| `#oms_designer` | 重新设计参考图。仅当 `verdict=fail` 且差距太大（连参考图都得重画，不是改几个 px 能解决）时介入 |

## Example

输入：
- `reference_images`: `["./design/dashboard-v2.png"]`
- `generated_screenshot`: `./output/current-dashboard.png`
- `category_hint`: `dashboard`

输出：

```json
{
  "score": 87,
  "verdict": "revise",
  "category_match": true,
  "differences": [
    "布局：顶部导航条高度比参考图矮 8px，导致主内容区上移",
    "间距：侧边栏图标与文字间距比参考图紧 4px",
    "字体：主标题字重用了 500，参考图是 600",
    "颜色：强调按钮背景色偏亮，参考图更沉"
  ],
  "suggestions": [
    "顶部导航条 height 从 56px 改到 64px",
    "侧边栏 .nav-item 的 gap 从 8px 改到 12px",
    "主标题 font-weight 从 500 改到 600",
    "强调按钮 background 从 #3b82f6 改成 #2563eb"
  ],
  "reasoning": "核心布局对得上，但间距/字重/配色四项细节还差一截，改完预计能过 90。"
}
```
