---
name: req-to-issues
description: 将会议、聊天或 spec 需求整理成少量可验收的 GitHub 交付单，先去重与归并，未拍板和 review 建议留本地；用户确认具体清单后创建或补充 issue。适用于需求登记、把需求建成 issues。
metadata:
  title: 需求归并与任务登记
  author: nvoyager
  version: 2.0.0
  license: MIT
---

# 需求 → 少量可交付 issues

Codex 用 `$req-to-issues notes/meetings/meeting-YYYYMMDD` 或自然语言调用。
开发交给 `issue-dev`，批量交给 `issue-sweep`。本 skill 不实现功能。

## 1. 先分清决策与任务

会议目录先读 `summary.md`，必要时回查 `article.md`，不把讨论过程当决定。
口头需求同样提取：业务目标、已确认规则、验收条件、来源。

- 可执行交付：有明确业务结果与可验证验收，才候选建 issue。
- 未拍板 / 暂缓 / 待确认：放来源旁 `backlog.md`，集中列问题；**默认不建 `[待确认]` / `[暂缓]` / `[pending]` issue**。无来源目录时用 `notes/backlog/YYYYMMDD.md`。
- 已实现 / 保持现状：查代码与已有 PR 证据，记入去重结果。
- review 顺带发现的风格、重复代码、潜在测试守护：放本地 backlog。独立可复现且有用户影响的缺陷才进入 Bug 候选，不因 reviewer 给 P2 就建单。

需要改 spec 时单独走 `meeting-to-spec`，此处引用已有 spec。

## 2. 全量去重（含已合并 PR）

```bash
gh issue list --state all --limit 1000 --json number,title,state,body,labels,url
gh pr list --state all --limit 1000 --base dev --json number,title,state,body,url
```

若达到上限，必须用 `gh api --paginate` 补齐；关键候选读 `gh issue view N --comments`。
不能只查最近 100 条或凭标题判断：关键词 + 用户目标 + 根因 + 验收内容交叉比较。
已合入 dev 但仍 open 的单，核验实现后列“待关单”，不再登记或开发。

每个条目给一个动作：`新建 / 补充已有 #N / 已覆盖 / 待决 / 不排期`。
补充已有 issue 先起草增量，不覆盖原验收；评论只写新信息，重跑前查是否已写过。
closed 单仅在有新需求差量或新复现的回归时新建，并引用旧单。

## 3. 按交付归并，技术步骤留正文

**一条 issue = 同一用户目标的一项可独立验收交付。**
同一根因的跨端修复、同一功能的表/接口/UI/测试、上线不可分的子项放同一单的 checkbox。
公共骨架通常是功能单内的实现步骤，不单独产出“骨架→组件→每页”任务链。
只有独立验收/发布、明确依赖或高风险需要分阶段迁移时拆单；表名/文件数/涉及端数量不是拆单依据。

不要把整个模块塞成巨单：不同业务口径、独立功能或风险不同仍拆开；工作量 >3 天先在父单
正文列阶段和决策点，明确到可独立交付后才提子单清单。禁止递归自动派生任务。

展示归并表：业务目标 / 包含子项 / 动作与关联 # / 验收要点 / 来源 / 待决问题。
同时报告“原始条目数 → 新建 issue 数”，每条新单说明为何不能补充已有单。
默认一次最多提出 5 条新单；若超过，先展示剩余 backlog 与拆分理由，不静默截断需求。
已有明确授权的清单直接执行；否则具体清单交用户确认，等待期间继续去重和起草正文。

## 4. 创建或补充

标题只用 `[需求][模块] 业务结果` 或 `[Bug][模块] 故障结果`。
正文含：背景、范围/不做项、已确认规则、验收 checkbox、涉及端、依赖、来源。
技术步骤放正文；待决问题放 backlog，别把不能开工的单混进开发队列。

创建前再查一次近期 issues 防并发重复；逐条创建并立刻落盘编号/URL，失败重入只补未创建项。
正文写文件，避免 shell 插值：

```bash
gh issue create --title "[需求][模块] 业务结果" --label enhancement --body-file /abs/path/body.md
gh issue comment N --body-file /abs/path/increment.md
```

Bug 用 `bug`；标签不存在先报告，不静默创建标签。输出新建/补充/不建清单与 backlog 路径。
不要自动关闭旧 issue、建新的“汇总 issue”复制整个队列，或为每个 review finding 建单。
