---
name: issue-sweep
description: 用 Codex 整理并批量推进 open issues，先核验已完成、去重和归并交付，再逐项走 issue-dev 的隔离实现、三层验证与 GLM-5.3[1M] + DeepSeek 双谱系评审；台账可断点续跑，不自动合并或关单。用于批量处理 issues、清 issue 积压。
metadata:
  title: 整理积压与批量开发
  author: nvoyager
  version: 3.0.0
  license: MIT
---

# issue-sweep · Codex 批量开发

用 `$issue-sweep bug`、`$issue-sweep #230 #231` 或自然语言调用。
每项交付完整走相邻 `issue-dev/SKILL.md`，批量不减质量闸门。
`BASE` 在进 worktree 前只取一次；台账留 `$BASE/_tmp/issue-sweep/run-YYYYMMDD-HHmm.md`。
状态变化立即写盘：pending → in-progress → ready/draft/待拍板/skipped。
记录 issue 集合、主编号、HEAD、worktree、PR、评审状态和下一步；先恢复未完成台账，不重做 ready 项。

## 1. 整理队列后才开发

```bash
gh issue list --state open --limit 1000 --json number,title,body,labels,createdAt,url
gh pr list --state all --base dev --limit 1000 --json number,title,state,body,headRefName,url
```

达到上限时 `gh api --paginate` 补齐。查看疑似重复/已实现项的评论、关联 merged PR 和
`origin/dev` 代码证据，不能只看编号引用（普通 `#N` 引用不一定覆盖该 issue）。

台账分类：
- 已有 open PR / 在途 worktree：恢复或跳过，避免重复开发。
- 已合入 dev 且验收满足：列待关单证据，不重复修复，不自动 close。
- `[暂缓]` / `[待确认]` / `[pending]` / `[口径]`、正文含未拍板关键规则：待决，跳过。
- main-guard 告警：跳过。
- 可执行 Bug/需求：进入候选。
- 仅风格/死代码/守护建议：维护 backlog，默认不挤占业务队列。

同一根因/同一验收且必须一起交付的多条旧单可作为一个 **交付组**：一个 worktree、分支、PR，
主编号作 checkpoint，台账列全部编号，验收取并集。不为归并再新建 umbrella issue。
不同业务规则、独立发布或高风险迁移保持独立。分组前展示原因、完整范围和各单验收；
用户已指定一起处理或授权整理队列时可执行，否则等确认分组，独立项可以先推进。

## 2. 排序和执行

优先可复现的线上故障/金额权限风险 → 阻塞已确认功能的依赖 → 已确认需求。
不再以“小单数量多、容易清量”为目标。默认每批最多 3 项交付，按工作量限制上下文。
先展示候选、去重/待关单/待决项、依赖和冲突风险；用户已要求批量处理即授权开跑，
不重复索要开跑确认。`--triage-only` 或“仅整理”只输出台账，不改业务代码/远端 issue。

逐项走 issue-dev：隔离 worktree → 调研/澄清 → 实现 → 三层验证 → Codex 四维自审 →
GLM-5.3[1M]/OpenCode + DeepSeek/Claude Code → PR base dev → 归档/回收。
所有独立项基于最新 `origin/dev`，不堆叠未合并分支；依赖未合并先跳过依赖方。
同文件的不同 PR 标建议合并顺序；共享 PG migration、L2 数据命名空间、devtools 串行使用。

交付组在 checkpoint 记全部编号，所有对应验收进入 review 输入；PR 用 `Refs #A, #B`。
默认分支可能是 main：合入 dev 不保证 `Closes` 自动关单，不能把“已有 PR”记成“issue 已关”。

## 3. 卡住与收尾

- 新口径/歧义：一次集中列问题，台账待拍板，继续独立项；已确认规则不重复问。
- >3 天：正文给阶段建议，标建议单独会话，不自动创建子 issue。
- 实现/测试同因失败最多重试 2 次，记现场后跳过。
- 独立评审故障按 issue-dev 的 `references/review.md`：不可偷换谱系，draft 保留现场。
  账户级/环境级故障中止整批，别用下一项重试同一个失败账户。
- 任何未过闸门条目保留 worktree；ready PR 按 issue-dev 先归档再回收。

汇总表给：issue 集合 / PR / 验证与两路最终 HEAD / ready 或 draft / 待决 / 待关单证据。
review 范围外建议记本地 backlog，不自动派生新单。不 merge、不 close、不部署。
若当前 Codex 会话支持循环功能可分批续跑；不把 Claude `/loop` 当成 Codex 必备命令，
普通会话从台账恢复也可。无可执行项就结束，不循环制造任务。
