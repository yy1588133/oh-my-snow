---
name: wiki
description: 持久化 markdown 知识库，跨会话累积项目知识（ingest/query/lint/add/delete + 交叉引用 + 自动捕获）
---

# OMS Wiki Skill

持久化、自维护的 markdown 知识库，存项目知识和会话发现。对标 omc wiki（Karpathy LLM Wiki 模型），但跑在 snow-cli 上，用文件操作直接实现——不依赖 MCP 工具，不用向量嵌入，只用关键词 + tag 匹配，LLM 负责综合答案。

## When to Use

- 学到一条项目知识想长期存下来（架构决策、踩坑根因、复用模式、环境配置）
- 跨会话恢复上下文：上次踩的坑、上次定的架构，不想重新查一遍
- 接手老项目时快速捞已有知识
- 会话结束前把重大发现沉淀成 session-log 页
- 写新页前查老页避免重复

## When NOT to Use

- 临时草稿、一次性笔记 → 直接写 `.snow/oms-state/notes/`，别污染 wiki
- 代码本身的结构（API 签名、类型定义）→ 用 `codebase-search` 直接查代码，wiki 存「为什么」不存「是什么」
- 跨项目的通用知识 → wiki 是项目本地的，别存通用算法/语言语法
- 需要精确数学评分或多假设调查 → 用 `#oms_researcher` 或 oms trace skill

## Why This Exists

每个会话都在重新发现项目知识——上次定过的架构、踩过的坑、写过的模式，换个会话就忘了。wiki 把这些知识沉淀成持久化 markdown 文件，跨会话可查可引用。关键设计：**不用向量嵌入**（向量数据库要部署、要维护、还不可解释），只用关键词 + tag 匹配——简单、透明、git 友好。LLM 负责综合答案，文件系统负责存储，ace-search 负责检索，三者分工。

## Procedure

### Phase 1: Ingest（批量入库）

把多条知识一次性处理成 wiki 页。一次 ingest 可写多个页。

1. 确定每条知识的 `title` / `content` / `tags` / `category`
2. 生成 slug（kebab-case，如 `auth-architecture`）
3. 用 `filesystem-create` 写页文件到 `.snow/oms-state/wiki/<slug>.md`，带 YAML frontmatter：

```yaml
---
title: Auth Architecture
tags: [auth, architecture]
category: architecture
created: 2026-07-04
updated: 2026-07-04
---
```

4. 维护 `index.md`：在对应分类目录下追加该页条目（slug + title + tags）
5. 在 `log.md` 追加一行操作记录：`2026-07-04 ingest auth-architecture [auth, architecture]`

### Phase 2: Query（查询）

按关键词 + tag 搜索所有页，返回匹配页和片段——**LLM 综合答案**，附页名引用。

1. 用 `filesystem-read` 读 `.snow/oms-state/wiki/index.md` 拿到全部分类和 tag 目录
2. 用 `ace-search` 在 `.snow/oms-state/wiki/` 下搜关键词，按 tag 过滤
3. 用 `filesystem-read` 读命中的页文件，提取片段
4. LLM 综合：把片段拼成答案，每条结论后附 `[[page-name]]` 引用

### Phase 3: Lint（健康检查）

跑健康检查，找孤儿页 / 过期内容 / 坏交叉引用 / 超大页 / 结构矛盾。

1. 用 `filesystem-read` 读 `index.md` 拿到全部页列表
2. 逐页 `filesystem-read` 检查：
   - **孤儿页**：没有任何页用 `[[slug]]` 引用它
   - **坏链接**：页里写了 `[[xxx]]` 但 `xxx.md` 不存在
   - **超大页**：超过 500 行，该拆
   - **过期内容**：`updated` 超过 90 天且无 session-log 引用
3. 用 `ace-search` 搜 `[[page-name]]` 找全部交叉引用，建反查表
4. 输出问题清单，建议修复动作（合并 / 拆分 / 删除 / 更新）

### Phase 4: Quick Add / List / Read / Delete

- **Quick Add**：单页快速入库（比 ingest 简单）——`filesystem-create` 写页 + 更新 `index.md` + 追加 `log.md`
- **List**：`filesystem-read` 读 `index.md`，按分类列出全部页
- **Read**：`filesystem-read` 读 `.snow/oms-state/wiki/<slug>.md`
- **Delete**：用 `terminal-execute` 删页文件 + 更新 `index.md` 移除条目 + 追加 `log.md`

### Phase 5: Log（操作历史）

所有操作（ingest / add / delete / lint）都 append 到 `.snow/oms-state/wiki/log.md`，一行一条：

```
2026-07-04 ingest auth-architecture [auth, architecture]
2026-07-04 add deploy-runbook [deploy, runbook]
2026-07-04 lint 3 issues found
2026-07-04 delete outdated-api-v1
```

## Categories

页按 `category` 字段分类：

- `architecture` — 架构决策和组件设计
- `decision` — 关键技术选型和取舍
- `pattern` — 复用模式和约定
- `debugging` — 踩坑根因和修复
- `environment` — 环境配置和依赖
- `session-log` — 会话重大发现（自动捕获）

## Storage

- 页文件：`.snow/oms-state/wiki/*.md`（markdown + YAML frontmatter）
- 目录：`.snow/oms-state/wiki/index.md`（自动维护，按分类列条目）
- 日志：`.snow/oms-state/wiki/log.md`（append-only 操作编年）

## Cross-References

用 `[[page-name]]` wiki-link 语法建交叉引用。lint 阶段会检查所有 `[[xxx]]` 指向的页是否存在，坏链接要修或删。

## Auto-Capture

会话结束前，把重大发现（新踩的坑、新定的架构、新写的模式）自动捕获成 `session-log` 页。判断标准：影响后续会话的发现才入库，琐碎操作（改个 typo、跑个测试）不记。捕获流程跟 Quick Add 一致——写页 + 更新 index.md + 追加 log.md。

## Execution Policy

- **不用向量嵌入**——查询只用关键词 + tag 匹配，LLM 综合
- **wiki 默认 git 忽略**——`.snow/oms-state/` 是项目本地状态，不进版本库
- **slug 用 kebab-case**——`auth-architecture` 不用 `AuthArchitecture` 或 `auth_architecture`
- **每次写操作都更新 index.md + log.md**——index 是目录，log 是编年，缺一不可
- **页文件必须有 frontmatter**——title / tags / category / created / updated 五个字段
- **lint 建议优先合并 / 拆分，不轻易删除**——删除会丢上下文，先确认无 `[[page-name]]` 引用再删

## Anti-Patterns (Forbidden)

- **把代码结构存进 wiki**：API 签名、类型定义是代码的职责，wiki 存「为什么」不存「是什么」
- **用 oms-state 工具存 wiki**：wiki 是多页 markdown 文件系统，不是单 JSON 对象——state 工具的覆盖写语义不适合多页结构，直接用文件操作
- **向量化 / 嵌入**：违背「关键词 + tag」设计原则，引入运维负担和不可解释性
- **把 wiki 提交进 git**：`.snow/oms-state/` 是本地状态，泄露环境细节还污染提交历史
- **写页不更新 index.md**：目录失同步，后续 query 漏页
- **slug 用大写或下划线**：破坏 `[[page-name]]` 交叉引用一致性

## Quick Reference

| 工具 | 用途 |
|---|---|
| `filesystem-create` | 写新页 / 更新 index.md / 追加 log.md |
| `filesystem-read` | 读页 / 读 index.md / lint 逐页扫描 |
| `filesystem-edit` | 修改已有页内容 |
| `ace-search` | query 搜关键词 / lint 找 `[[page-name]]` 交叉引用 |
| `terminal-execute` | 删页文件 |
