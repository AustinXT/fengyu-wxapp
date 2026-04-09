---
name: worktree-flow
description: |
  把一次隔离性修改封装成完整流水线：预检 → 创建 git worktree →
  在 worktree 内执行修改 → 提交 → 退出 → merge --no-ff 回原分支 → 清理。
  当用户说"开个 worktree 做 X"、"隔离试一下 X"、"用 worktree 改 X"、
  "/worktree-flow ..." 时激活。
argument-hint: '<修改要求描述>'
user-invocable: true
disable-model-invocation: false
metadata:
  title: Worktree 自动化流水线
  description_zh: 创建隔离 worktree 执行修改后自动合并回原分支
  author: nvoyager
  version: 1.0.0
---

# Worktree 自动化流水线

把一次隔离性修改封装成完整流水线：**预检 → 创建 worktree → 执行修改 → 提交 → 退出 → merge --no-ff → 清理**。

主 Claude 在同一会话内自己切进 worktree 干活，用户只提供"要做什么"。

## 何时使用

- 想在隔离环境做小范围实验性改动（重构、换实现、试优化），随时能丢掉
- 希望保留一条独立的 `merge --no-ff` 记录用于回滚
- 改动预期 ≤ 30 分钟能完成，且只涉及少量目录

## 不适用

- **跨 3 个以上目录的大型变更** → 走 plan mode，直接在原分支干
- **紧急 hotfix** → 直接在原分支改，不要绕路
- **需要持久保留 worktree 供另一会话使用** → 用 `scripts/worktree-setup.sh <branch>`，它会写到 `.tree/` 并拷贝 `.env`
- **涉及 db:migrate 的 schema 变更** → worktree 共享同一个 PG，迁移冲突风险高，改在主仓库做

---

## Phase 0：预检（创建前必做）

按顺序执行，任何一步失败就停下问用户，不要硬闯。

1. **当前不在嵌套 worktree**
   ```bash
   git rev-parse --show-toplevel
   git rev-parse --git-common-dir
   ```
   若 `git-dir` 指向 `.claude/worktrees/.../.git`，说明已在 worktree 内——**拒绝执行**，让用户先 `ExitWorktree` 回到主仓库。

2. **HEAD 不是 detached**
   ```bash
   git symbolic-ref -q HEAD
   ```
   失败 → 告诉用户当前是 detached HEAD，先 checkout 一个分支再来。

3. **工作区干净**
   ```bash
   git status --porcelain
   ```
   输出为空才放行。**非空则停下问用户**，给三个选项：
   - `stash`：`git stash push -u -m "worktree-flow-auto"` 后继续，结尾 pop
   - `继续`：无视脏状态继续（危险，worktree 不会带这些改动）
   - `取消`：终止 skill

4. **记录原分支**
   ```bash
   ORIG_BRANCH=$(git branch --show-current)
   ```
   整个流程都会用到这个值。

---

## Phase 1：创建 worktree

1. **生成 worktree 名字**：从 `<修改要求>` 抽关键词转 kebab-case，前缀 `wt-`，总长 ≤ 48 字符。
   - `重构 order.create 价格计算` → `wt-refactor-order-create-price`
   - `试试 pg_trgm 优化搜索` → `wt-trgm-search-opt`
   - 只保留 `[a-z0-9-]`，其余去掉。

2. **调用 `EnterWorktree`**：
   ```
   EnterWorktree(name="wt-xxx-yyy")
   ```
   这会：创建 `.claude/worktrees/wt-xxx-yyy/`、切新分支（与 worktree 同名）、把当前会话的 cwd 切到新 worktree。

3. **环境差异提示**（告诉用户一次，不要每步都提）：
   - `.env` 文件 **不会** 自动拷贝（EnterWorktree 的限制，与 `scripts/worktree-setup.sh` 的差异点）
   - `node_modules` 不共享；若要跑 `bun run test` / `tsc`，先 `cd fengyu-admin && bun install`
   - 所有 worktree 共享同一个 PG，**不要** 在 worktree 里跑 `db:migrate`

---

## Phase 2：执行修改

按 `<修改要求>` 正常干活。遵守项目 `CLAUDE.md` 的**编码后自检**：

| 改动范围 | 自检动作 |
|---------|---------|
| `fengyu-admin/src/` | `cd fengyu-admin && npx tsc --noEmit` |
| `cloudfunctions/*/routes/*.js` | 检查 SQL 参数化（`$1, $2`）+ OPENID 认证 |
| 小程序 `.wxml` / `.ts` | 确认 Vant 组件属性和事件名（参考 `vant-weapp` skill） |

**提交粒度**：每个逻辑单元 `git commit` 一次，允许多个 commit。commit message 跟仓库风格（`feat(xxx): ...` / `fix(xxx): ...` / `refactor(xxx): ...`）。

**中途放弃**：若用户说"算了不要了"：
```
ExitWorktree(action="remove", discard_changes=true)
```
然后报告已回到原分支，没有任何改动落盘。

---

## Phase 3：退出 + 合并回原分支

1. **确认有提交**：
   ```bash
   git log "$ORIG_BRANCH..HEAD" --oneline
   ```
   输出为空 → Phase 2 没改任何东西。直接：
   ```
   ExitWorktree(action="remove")
   ```
   告诉用户"没有产生任何改动"，结束。

2. **记下 worktree 分支名**（= worktree 目录名）。

3. **退出但保留分支**：
   ```
   ExitWorktree(action="keep")
   ```
   action 必须是 `keep`——`remove` 会删除分支，导致后面 merge 无源可合。会话 cwd 会回到主仓库根。

4. **确认回到原分支**：
   ```bash
   git rev-parse --show-toplevel   # 应为主仓库根
   git branch --show-current        # 应 = ORIG_BRANCH
   ```
   若被任何操作改到了别的分支，`git checkout "$ORIG_BRANCH"`。

5. **执行合并**：
   ```bash
   git merge --no-ff "$WT_BRANCH" -m "merge: <修改要求摘要 ≤60 字>"
   ```
   摘要从 `<修改要求>` 截取前 60 字符，去掉换行。

---

## Phase 4：清理

### 合并成功

```bash
git worktree remove .claude/worktrees/"$WT_BRANCH"
git branch -d "$WT_BRANCH"
git log --oneline -3
git worktree list
```

给用户汇报：
- merge commit hash
- 最近 3 条 log
- worktree list 只剩主仓库

若 Phase 0 执行过 `stash`：`git stash pop`（pop 失败说明合并后有冲突，告知用户手动 pop）。

### 合并冲突

```bash
git merge --abort
```

**不清理** worktree 和分支。告诉用户：

1. 冲突文件列表（合并前跑 `git diff --name-only --diff-filter=U` 能拿到；已 abort 则回忆 merge 前的 STDERR）
2. 两条出路：
   - **手动解决**：`cd .claude/worktrees/<WT_BRANCH>`，先 `git merge origin/$ORIG_BRANCH` 或 `git rebase $ORIG_BRANCH` 在 worktree 侧解决，解决完再触发本 skill 从 Phase 3 的 merge 步骤重来
   - **让 Claude 再进去修**：明确告诉 Claude "进 wt-xxx 重新跟 $ORIG_BRANCH 对齐"，Claude 用 `EnterWorktree(name="wt-xxx")` 重新切入

若 Phase 0 stash 过：**不要 pop**，原分支不能在有 merge 残局时接收更多改动；告诉用户 stash 名字在 `worktree-flow-auto`。

---

## 错误恢复 Checklist（给 Claude 自己看）

| 症状 | 原因 | 动作 |
|------|------|------|
| `EnterWorktree` 失败 "already in worktree" | Phase 0 守卫漏了 | 停下，让用户 ExitWorktree |
| `merge --no-ff` 产生了 fast-forward 样的单 commit | Phase 2 commit 策略异常 | 正常，不用管，`--no-ff` 仍保证有 merge commit |
| `merge --no-ff` 报 "Already up to date" | worktree 没 commit | 回 Phase 3 的"无提交"分支 |
| `git worktree remove` 拒绝（有 untracked） | Phase 2 漏提交 / 有生成物 | 告诉用户文件列表，问是否 `--force` |
| `git branch -d` 拒绝（未合并） | 上一步 merge 没真的跑成功 | 停下，`git log` 确认 |

---

## 示例触发

```
/worktree-flow 把 staffApi order.create 里的价格计算抽到 utils/price.js
/worktree-flow 试试把 client customer.search 的模糊匹配从 LIKE 改成 pg_trgm
/worktree-flow 重写 admin 订单列表的分页组件用 useSWRInfinite
```

自然语言触发也行：

> 开个 worktree 试试把 service.complete 的原子扣减抽成 SQL 函数

Claude 会自动把这句话当 `<修改要求>` 走完整流程。
