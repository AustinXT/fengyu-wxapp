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
  version: 1.2.0
---

# Worktree 自动化流水线

把一次隔离性修改封装成完整流水线：**预检 → 创建 worktree → 执行修改 → 提交 → 退出 → merge --no-ff → 清理**。

**核心设计**：主 Agent 只做编排（Phase 0/1/3/4），Phase 2 的代码修改整个下发给子 Agent，避免读文件、tsc 输出、schema 验证把主会话上下文撑爆。用户只提供"要做什么"。

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

4. **记录原分支 + 采集 tsc baseline**
   ```bash
   ORIG_BRANCH=$(git branch --show-current)
   # 若修改预计涉及 fengyu-admin，顺手采一次基线错误数
   TSC_BASELINE=$(cd fengyu-admin && ./node_modules/.bin/tsc --noEmit 2>&1 \
       | grep -c "error TS")
   ```
   `TSC_BASELINE` 会作为参数传给 Phase 2 的子 Agent——它知道"多出来多少个才是我引入的"。不涉及 fengyu-admin 可以跳过。

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

3. **⚠ base 校验（必做）**：`EnterWorktree` 不保证基于 `$ORIG_BRANCH` 的 HEAD——如果仓库里有残留 worktree 或 detached 分支，可能会落到一个**分叉**的 commit 上，导致后续改动基于一份过时/错误的代码：
   ```bash
   git merge-base --is-ancestor HEAD "$ORIG_BRANCH" && echo OK || echo DIVERGED
   git log --oneline "$ORIG_BRANCH"..HEAD | head -5   # 必须为空
   ```
   - 输出 `OK` 且"HEAD 额外 commits"为空 → 继续 Phase 2
   - 输出 `DIVERGED` 或 HEAD 额外 commits 非空 → **修正**：
     ```bash
     git reset --hard "$ORIG_BRANCH"
     ```
     worktree 分支指针移到 `$ORIG_BRANCH` HEAD，untracked 文件会保留。只有当 worktree 分支上还没 commit 时才安全——本步骤就是在创建后立即做，所以总是安全。

4. **环境差异提示**（告诉用户一次）：
   - `.env` 文件 **不会** 自动拷贝（EnterWorktree 的限制）
   - `node_modules` 不共享；Phase 2 子 Agent 会用 symlink 复用主仓库的
   - 所有 worktree 共享同一个 PG，**不要** 在 worktree 里跑 `db:migrate`

---

## Phase 2：执行修改（下发给子 Agent）

**默认下发给 general-purpose 子 Agent 执行**。读参考文件、跑 tsc、schema 验证、写多个文件——这些动辄几千到几万 tokens 的脏活全留在主 Agent 上下文里，几轮下来必然撑爆。主 Agent 只管编排和结果核对。

### 判断：下发还是直接做

**直接做**（主 Agent 自己动手）的条件，必须**全部满足**：

- 修改 ≤ 2 个文件
- 不需要读任何参考文件作为模板
- 不涉及 schema、类型、跨模块依赖
- 预期 tsc / lint 不会报错（纯 JSON 配置、Markdown 文档、单个字符串常量等）

否则**一律下发**。宁可下发一次简单任务，也不要让主 Agent 的上下文被 tsc 输出污染。

### 下发调用

```
Agent(
  subagent_type="general-purpose",
  description="worktree 执行：<修改要求摘要 ≤ 5 词>",
  prompt=<见下方 Prompt 模板>
)
```

子 Agent 继承主会话的 cwd（已在 worktree 内），但 prompt 里用**绝对路径**交代关键位置，避免 cwd 漂移带来的误操作。

### Prompt 模板

把 `<...>` 占位符替换后直接发：

    你正在一个 git worktree 内执行隔离性修改。全程不要 cd 出 worktree，不要
    调用 EnterWorktree / ExitWorktree，不要 checkout / merge / 切分支，
    不要 push，不要动原分支。只负责在 worktree 内完成代码修改并 commit。

    【worktree 路径】 /Users/nv/proj.xt.com/fengyu-wxapp/.claude/worktrees/<wt-name>
    【源分支】       <ORIG_BRANCH>（主 Agent 已验证 HEAD 是其后代或等同）
    【主仓库 fengyu-admin】 /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin
    【tsc baseline】 <TSC_BASELINE>（主仓库当前的 pre-existing 错误数，主 Agent 已采）

    【修改要求】
    <用户提出的改动内容，原样转述，不要改写>

    【操作约束】
    1. 遵守项目根 CLAUDE.md 与涉及子目录 CLAUDE.md 的编码规范与"编码后自检"
    2. schema 字段一律以 worktree 当前 HEAD 为准，不要信任任何外部报告：
         git show HEAD:db/schema/<module>.ts
       特别留意枚举中英文混用（如 messageRecipientType 曾有
       '客户'/'员工' 与 'client'/'staff' 两版），改代码前先 grep
       db/schema/enums.ts 确认当前值
    3. 字段历史：近期 product 域重构后 productSkus 直接绑定 categoryId，
       没有 productId；SKU 的 specName 已包含完整"商品名 规格"
    4. 若需要 fengyu-admin/ 的 tsc 检查：
       a) 建 symlink 复用主仓库 node_modules：
          ln -s /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-admin/node_modules \
                fengyu-admin/node_modules
       b) 跑 tsc：
          ./fengyu-admin/node_modules/.bin/tsc --noEmit \
              -p fengyu-admin/tsconfig.json 2>&1 | grep -c "error TS"
       c) 判定：错误数 ≤ baseline + 2（sidebar.tsx 找不到 logo.png 的
          symlink 伪影）= 通过；大于就是你引入的，必须修
       d) commit 前必须 rm fengyu-admin/node_modules 清理 symlink
    5. 按逻辑单元 commit，多个 commit 也行。message 风格：
       feat(xxx): ... / fix(xxx): ... / refactor(xxx): ...
    6. 禁止事项：push / merge / 切分支 / 跑 db:migrate / 改原分支 / bun install

    【完成后返回（硬性格式，≤ 400 字，不要超）】
    status: completed | blocked | aborted
    commits:
      - <SHA7> <subject>
      - <SHA7> <subject>
    files_changed: 新增 N，修改 M
    tsc: 0 new errors | N new errors（若 N>0 列出前 5 条摘要）
    notes: <blocked 时说明停在哪一步、根因、建议主 Agent 下一步；
            completed 时留空>

    不要返回代码片段、完整 diff、完整 tsc 输出、文件内容引用。主 Agent
    需要细节时会用 SendMessage 追问你（不要重启新 Agent，上下文会丢）。

### 验证子 Agent 返回（主 Agent 动作，不读文件、不重跑 tsc）

收到返回后只做三件事：

1. **commit 真的存在**：
   ```bash
   git log "$ORIG_BRANCH"..HEAD --oneline
   ```
   行数应 = 子 Agent 汇报的 commits 数

2. **工作区干净**（symlink 和生成物都清理了）：
   ```bash
   git status --porcelain
   ```
   输出为空

3. **根据 status 字段决策**：
   - `completed` → 进入 Phase 3
   - `blocked` → 用 `SendMessage` 继续让子 Agent 解决（保留它的上下文），或和用户确认后 `ExitWorktree(action="remove", discard_changes=true)` 放弃
   - `aborted` → 直接 `ExitWorktree(action="remove", discard_changes=true)`

子 Agent 的 tsc 判定相信它，真有遗漏 Phase 3 的 merge 也能兜一层（原分支的 CI 也会拦）。

### 中途放弃

用户说"算了不要了"：
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
   - **重新下发给子 Agent**：用 `Agent` + `SendMessage` 让原来那个子 Agent（或新 Agent）"进 wt-xxx 对齐 $ORIG_BRANCH"

若 Phase 0 stash 过：**不要 pop**，原分支不能在有 merge 残局时接收更多改动；告诉用户 stash 名字在 `worktree-flow-auto`。

---

## 错误恢复 Checklist（给主 Agent 自己看）

| 症状 | 原因 | 动作 |
|------|------|------|
| `EnterWorktree` 失败 "already in worktree" | Phase 0 守卫漏了 | 停下，让用户 ExitWorktree |
| **Phase 1 base 校验报 `DIVERGED`** | EnterWorktree 落到了分叉的残留分支（曾真实发生：主 dev HEAD=abb9c10，worktree HEAD=39b0747，在 ecc4524 后分叉，枚举中英文相反、菜单项不同、字段存在性不同） | `git reset --hard "$ORIG_BRANCH"`（仅限分支上还无 commit 时） |
| **`git log "$ORIG_BRANCH"..HEAD` 非空且有无关 commit** | 同上，base 不对 | 同上 reset |
| **子 Agent 返回 status=blocked** | tsc 有新错误 / schema 字段不对 / 需要澄清 | 用 SendMessage 追问，保留上下文；不要重启新 Agent |
| **主 Agent 核验时 commit 数对不上** | 子 Agent 汇报失准 | SendMessage 让它重跑 `git log "$ORIG_BRANCH"..HEAD --oneline` 自查 |
| **核验时工作区不干净**（有 node_modules 软链/临时文件残留） | 子 Agent 漏清理 | `rm` 掉，再继续；频繁发生就在模板里加粗约束 |
| `merge --no-ff` 产生了 fast-forward 样的单 commit | 正常 | `--no-ff` 仍保证有 merge commit |
| `merge --no-ff` 报 "Already up to date" | worktree 没 commit | 回 Phase 3 的"无提交"分支 |
| **`merge --no-ff` 引入了意料之外的文件** | Phase 1 base 校验漏做 | `git merge --abort` → 回 worktree reset → 重做 Phase 2 |
| `git worktree remove` 拒绝（有 untracked） | Phase 2 漏提交 / 残留 symlink | 先 `rm` symlink，再试；实在不行 `--force` |
| `git branch -d` 拒绝（未合并） | 上一步 merge 没真跑成功 | 停下，`git log` 确认 |

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
