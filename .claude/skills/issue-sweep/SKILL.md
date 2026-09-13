---
name: issue-sweep
description: |
  遍历 open issues 批量推进开发：过滤可做项 → 逐条走 issue-dev 完整流水线
  （三层验证 + pr-ready + 双谱系评审，闸门不因批量降级）→ 攒 PR 出汇总表。
  run ledger 持久化进度，可断点续跑。不自动 merge、不自动关单。
  当用户说"把 open issues 清一遍"、"遍历 issues"、"批量处理 issues"、
  "清 issue 积压"、"issue-sweep"时激活。
argument-hint: '[过滤条件]，如: bug / 积分 / "#70 #65"'
user-invocable: true
metadata:
  title: 批量遍历 issues
  description_zh: open issues 批量推进，逐条完整 issue-dev 流水线，ledger 断点续跑
  author: nvoyager
  version: 2.0.0
  license: MIT
---

# issue-sweep · 批量遍历 issues

把 issue 积压批量清掉。**每条完整走 `issue-dev` 流水线——三层验证、pr-ready 对抗审查、双谱系评审一项不减**（批量 = 更少人盯 = 更需要闸门，不是相反）。收尾只给汇总表，merge 与关单留给人。

## 0. 状态管理：run ledger（断点续跑的生命线）

台账文件 `_tmp/issue-sweep/run-<YYYYMMDD-HHmm>.md`：

```markdown
# sweep run 2026-09-10 14:00
过滤条件: <用户给的 or 默认>
| # | issue | 状态 | 分支/PR | 备注 |
|---|---|---|---|---|
| 70 | [需求][积分商城] … | done | PR #123 | 评审 3 轮收敛 |
| 65 | [待确认][…] … | skipped | — | 标题即待确认 |
| 72 | [Bug][回款] … | in-progress | fix/issue-72-x | §6 三层验证中 |
```

- **每条 issue 状态变化立即写盘**（pending → in-progress → done / 待拍板 / skipped+原因）
- **断点续跑**：启动时先查最近的 ledger——有 `in-progress`/`pending` 项 → 从断点继续（in-progress 的先读该 issue 的 `_tmp/issue-<N>/state.md` 恢复现场），不重做 done
- 单条 issue 的细粒度状态在各自 `_tmp/issue-<N>/state.md`（issue-dev §0），ledger 只记批次视图

## 1. 拉单与过滤

```bash
gh issue list --state open --limit 100 --json number,title,labels,createdAt
```

**排除**（不碰）：
- 标题带 `[暂缓]`（业务未拍板）或 `[待确认]`（理解存疑，等答复）
- main-guard 自动 issue（标题含"main 收到未经"）——分支守护告警，不是开发任务
- 已有关联 open PR 的（`gh pr list --base dev` 交叉核对，避免重复做）

用户给了过滤条件（label / 模块关键词 / 指定编号）则以其为准。

## 2. 排序与开跑确认

默认优先级：**Bug（线上问题）→ 小改动（快速清量）→ 需求（按时间先后）**。

写入 ledger 并展示执行清单（# / 标题 / 初判工作量 / 顺序）；用户在场确认后开跑，无人值守（/loop 触发）直接按默认顺序跑。**单批 ≤ 3 条**——每条含完整评审轮次，防上下文过长导致后面的活质量下滑；剩余留下一批。

## 3. 逐条执行（闸门不降级）

每条完整走 `issue-dev` 全流水线：状态校验 → 调研 → 分流 → 细化 → 实现 → **三层验证** → **pr-ready（P1 清零）** → **双谱系评审（收敛无 P0/P1/P2）** → PR base dev。

批量模式专属纪律：
- **每条独立分支、独立 PR，均基于 origin/dev**（不叠罗汉，互不依赖）；上一条开完 PR 切回 dev 起下一条，工作区必须干净
- `.claude/notes/pr-ready/` 是覆盖式快照——**每条跑完立即把四份 audit 拷到 `_tmp/issue-<N>/review/` 存档**，否则被下一条冲掉
- 多条 PR 改同一文件（docs 索引、同一路由、error-codes 副本等）→ ledger 与汇总表标注冲突风险与建议 merge 顺序
- 无人值守时分流闸门的"停等拍板"变为：issue 评论列问题 → 标记待拍板 → 跳下一条

## 4. 卡住处理（登记跳过，不空转）

| 情形 | 处理 |
|---|---|
| 需求歧义 / 触业务口径 | issue 评论列关键问题（每个给推荐方案），ledger 标"待拍板"，跳下一条 |
| 估算 > 3 天 | issue 评论给拆步骤建议，标"建议单独会话"，跳过——sweep 只吃小中活 |
| 实现/测试反复失败 | 重试 ≤ 2 次，仍失败则失败现场（报错 + 已尝试路径）写 issue 评论，跳过 |
| 单谱系评审 harness 挂（429/auth） | 按 `.claude/dev-launch.review.md` 降级链换谱系，**凑齐两谱系，不降单评审** |
| 双谱系全挂 | 该条 PR 标 draft + 注明"双谱系未完成"；连续两条如此 → 中止整批报告 |
| 环境级故障（gh 认证失效、db 连不上） | 中止整批，ledger 记现场，别带病硬跑 |

## 5. 收尾汇总表

全部跑完（或中止时）从 ledger 生成：

```markdown
| # | issue | PR | 验证/评审 | 状态 |
|---|---|---|---|---|
| 70 | [需求][积分商城] … | #123 | 三层✅ pr-ready P1=0 双谱系 3 轮收敛 | PR 待 merge |
| 72 | [Bug][回款] … | #124 | 三层✅ 双谱系 2 轮收敛 | PR 待 merge（与 #123 同改 error-codes，先 merge #123） |
| 65 | [待确认][…] … | — | — | 跳过（标题即待确认） |
```

外加：
- 批量 review 入口：`gh pr list --base dev`；每个 PR body 已带 Invariant Audit 表 + 验收标准对照，扫摘要即可判断
- 待拍板条目清单（用户答复后再跑单条 `issue-dev #N`）
- 实效层验证点汇总（merge 后用户在 dev 环境逐条点验）

## 不做的事

- **不** `gh pr merge`、**不** close issue（merge 时 `Closes #N` 自动关）
- **不**动 `[暂缓]` / `[待确认]` / main-guard issue
- **不**替甲方做业务口径决策——列问题等拍板
- **不**因批量而跳过任何验证/评审闸门
- **不**在一批里混入大重构——那是独立会话的活

## 与 /loop 配合

```bash
/loop /issue-sweep
```

每轮 sweep 吃一批（≤3 条），无可做项时停止 loop。与 `dev-loop` 的分工：`dev-loop` 是无 issue 载体的自由优化循环（QA/重构），`issue-sweep` 严格以 gh issues 为任务队列、以 PR 为交付物、以 ledger 为状态源。
