---
name: issue-dev
description: |
  单条 issue 从摄入到 PR 的完整流水线：状态校验 → 开隔离 worktree → 调研 →
  确定性分流 → 细化 → 实现 → 三层验证 → Codex 四维自审 → GLM-5.3[1M] + DeepSeek 双谱系评审 →
  PR base dev 与断点归档。全程在独立 worktree 内进行，起点仓库不受影响；
  checkpoint 按 issue 编号落本地临时目录，可断点重入。需求歧义必停等拍板；
  质量闸门不因维护期降级。
  当用户说"处理 issue #N"、"跑这个 issue"、"把这条 issue 做了"、
  "发车"、"issue-dev"时激活。
metadata:
  title: 单条 issue 开发流水线
  description_zh: 开隔离 worktree → 分流 → 实现 → 三层验证 → 双闸门评审 → PR base dev → 回收
  author: nvoyager
  version: 3.0.0
  license: MIT
---

# issue-dev · Codex 开发与独立双谱系评审

在 Codex 中用 `$issue-dev 70` 或自然语言调用；旧 `/issue-dev` 意图也照常处理。
`.agents/skills` 已链接到 `.claude/skills`，维护这一份源文件即可，无须复制全局 skill。
Codex 负责实现；外部 reviewer 固定 GLM-5.3[1M] + OpenCode、DeepSeek + Claude Code CLI。
开发期间发现的维护建议落本地 backlog，不自动派生新 issue。

维护期定位：**需求没做对是事故；质量闸门是放手让 AI 执行的前提，不是可裁剪的精益求精**。"不精益求精"只体现在：按验收归并交付、不做产品方向决策、不追求代码美学——验证与评审纪律一项不减。

## 0. 状态管理（长程执行的生命线）

**三个路径变量贯穿全程**，§1 建立后写进 `state.md` 头部，后续每个阶段都用它们：

| 变量 | 含义 | 取值 |
|---|---|---|
| `BASE` | **起点仓库**——发车时所在的仓库根，全程保持不动 | `git rev-parse --show-toplevel`，**只在 §1 `cd` 之前取一次** |
| `WT` | **本条 issue 的隔离 worktree**，所有开发/验证/评审都在这里 | `$BASE/.tree/<branch>` |
| `BRANCH` | 分支全名 | `fix/issue-N-<slug>` 或 `feat/issue-N-<slug>` |

工作目录 `_tmp/issue-<N>/`（已 gitignore）**落在 worktree 内**（`$WT/_tmp/issue-<N>/`），跟代码同住：

| 文件 | 内容 | 写入时机 |
|---|---|---|
| `state.md` | checkpoint：`BASE=`/`WT=`/`BRANCH=` 三行头 + 当前阶段 / 已完成步骤 / 下一步 | **每过一个阶段闸门立即更新** |
| `triage.md` | 调研产出（§2） | §2 结束 |
| `spec.md` | 细化产出（§4，同步回填 issue 评论） | §4 结束 |
| `verify.md` | 三层验证结果（§6） | §6 结束 |
| `review/` | Codex 四维自审 + GLM / DeepSeek 各轮输入输出 | §7 每轮 |

**起点仓库只留一个指针**：`$BASE/_tmp/issue-<N>/WORKTREE`，内容就是 `$WT` 绝对路径一行。会话被压缩、cwd 漂到别处时，靠它找回现场。§8 交付时 checkpoint 整个归档回 `$BASE/_tmp/issue-<N>/`，然后 worktree 才允许删。

纪律：
- **每个阶段的命令块以 `cd "$WT"` 起手**——评审跑得久，cwd 会被并发命令改掉；跨仓操作一律 `git -C "$WT"` 或绝对路径
- ⚠️ **`BASE` 绝不中途重算**：worktree 也是合法仓库根，进驻后再跑 `git rev-parse --show-toplevel` 拿到的是 `$WT` 而不是起点仓库，用它拼路径会得到 `$WT/.tree/...` 这种套娃路径（本 skill 落地时真踩过）。`BASE` 以 `state.md` 头部记录的值为准
- **长输出一律落文件，对话只给路径 + ≤200 字摘要**（防 token 黑屏把上下文吃光）
- **commit 即检查点**：实现阶段每完成一个可编译的子步就本地 commit，防网关中断/token 超限把活清零
- **重入协议**：启动时若 `$BASE/_tmp/issue-<N>/WORKTREE` 或 `$WT/_tmp/issue-<N>/state.md` 已存在 → 先读它 + `git -C "$WT" log`，从断点继续，**不重做已完成阶段、不重建 worktree**
- 路径一律绝对路径

## 1. 状态校验 + 开隔离 worktree（永远第一步）

建 worktree 前先核验 issue 状态、评论与关联 PR：已关闭/已有在途 PR 则恢复或报告；
merged 到 dev 的 PR 要对照验收和当前 `origin/dev` 实现，满足就列待关单，不重复开发。
交付组沿用主编号 checkpoint，`state.md` 另记 `ISSUES=` 全部编号、分组理由与验收并集；
所有编号进入 review 输入、PR 的 `Refs` 和交付摘要，不遗漏任何子单。组内技术步骤不派生 issue。

**每项交付都在独立 worktree 里开发，无例外**——小改动也开。起点仓库全程不动，你可以在它上面并行干别的。

```bash
BASE=$(git rev-parse --show-toplevel)
git fetch origin && git status && git log --oneline -3 origin/dev
```

**① 定分支名**（沿用既有约定）：需求 `feat/issue-N-<slug>`，Bug `fix/issue-N-<slug>`。

**② 重入判断先做**（早于任何创建动作）：

```bash
git worktree list --porcelain | rg --fixed-strings "$BRANCH"
```

命中 → 该分支的 worktree 已存在，取其路径当 `$WT`，`cd "$WT"` 后**读** `_tmp/issue-<N>/state.md` 从断点续跑（跳过 ③，④ 只补写缺失的 `WORKTREE` 指针，不覆盖 `state.md`）。**绝不重建**：同一分支不能在两个 worktree 同时 checkout，硬建必失败。

**③ 创建 worktree**（`origin/dev` 必须显式传，脚本省略第二参数时基于当前 HEAD，那会把无关分支的改动带进来）：

```bash
bash "$BASE/scripts/worktree-setup.sh" "$BRANCH" origin/dev
WT="$BASE/.tree/$BRANCH"
```

脚本已代办：`.env` ×4、`project.private.config.json` ×2、`miniprogram_npm` ×2、admin/db/三处云函数的 node_modules 软链、admin `PORT=3010`、`next-env.d.ts`、`version.ts`、仓库内 `.agents/skills/issue-dev/references/review.md`（评审约定，不依赖本机旧评审配置）。

**base 校验（必做）**——残留 worktree / 分叉分支会让新分支落到过时的 commit 上：

```bash
git -C "$WT" log --oneline origin/dev..HEAD     # 必须为空
```

非空 → 先调查是否复用了在途分支。只对已证明没有用户工作的新分支纠正基线；不自动 reset 已有分支。

**④ 进驻 + 落盘**：

```bash
cd "$WT"
mkdir -p "$WT/_tmp/issue-<N>" "$BASE/_tmp/issue-<N>"
echo "$WT" > "$BASE/_tmp/issue-<N>/WORKTREE"
```

写 `$WT/_tmp/issue-<N>/state.md`，头三行记 `BASE=` / `WT=` / `BRANCH=`。

**⑤ 起点仓库的脏改动不会被带进 worktree**——`git worktree add` 只基于 commit。这取代了原先「不 stash，后续用精确 `git add` 隔离」的权宜之计：隔离由 worktree 天然保证，**永远不要 stash**（stash 栈与其它会话共享）。⚠️ 反过来说，若起点仓库有**本条 issue 需要的**未提交改动，先核对归属，获本次任务授权的改动可精确复制到 worktree；不要代提交起点仓库的其它工作，否则 worktree 里看不到。

## 2. 摄入与调研（先别写代码）

1. `gh issue view N --comments` 读全文 + 评论 + 关联 issue/PR + 最近合并的 sibling PR（套其改造模式）
2. 定位涉及端：client / staff / admin / db / 云函数；口径存疑对照 `.42cog/` specs 与已有决策（memory 路径见评审参考）
3. **是否已部分实现先 grep**——只补差量，别重做
4. Bug 类先复现/确诊根因；跨层的先定位是哪层，**别猜**
5. 产出写 `_tmp/issue-<N>/triage.md`：根因/涉及端/工作量粗估/已实现部分/风险点

## 3. 确定性分流闸门（快走 ≠ 免检）

| 情形 | 行为 |
|---|---|
| 高确定性（根因明确 / 需求清晰有验收标准） | 一句话确认 → 直接进 §5，**后续验证评审照跑** |
| 需求歧义 / 未确定的新业务口径 | §4 集中列关键问题（每个给推荐 + tradeoff）→ 回填 issue 评论 → **停等拍板**；无人值守标记跳过 |
| 已部分实现 | 核对已有部分，只补差量 |
| 估算 > 3 天 | **拒绝无人值守**，先在 issue 评论拆步骤/子任务，等确认 |
| 值不值得做存疑 | 给「做 / 不做 / 关闭」结论 + 理由，等拍板 |

**未确定的业务口径才问**——先查 spec、issue / 评论和已确认决策；既有口径已经明确就执行，不能因为碰到金额/权限/提成重复确认。不替甲方决定新口径。

## 4. 细化 + 回填 issue

复杂需求（新表/新字段/新状态机/跨 3 端）走三段细化，产出 `_tmp/issue-<N>/spec.md` 并**回填 issue 评论**（不只留对话里）：

1. **实体与字段**：对照 `db/schema/` 列新增/修改的表、字段、枚举；有状态流转必画状态机（必经 vs 可选、终态、能否回流、死锁态检查）
2. **信息流**：动作表——触发方式 / 输入 / 输出 / 同步异步 / 副作用（写库、发通知、扣次数）
3. **安全边界**：老数据兼容、旧接口是否动、写入是否复用已有接口（不绕过）、会不会破坏已上线功能

简单 bug / 文案 / 单端小改跳过本节，直接进 §5。

## 5. 实现

- 动手前对照仓库 spec 与可用的旧 memory：diff 触到的概念（回款、退款、寄存单、积分、提成、权限……）先 cat 对应 memory，别撞已知口径
- 跨端共有逻辑（refund-cascade / settlePoints / scope / error-codes 等）**改一端必 grep 其余端副本同步**
- 结构性变更（枚举 / 删改字段 / 表结构）→ 先走 `wx-change-propagation` 扫全仓影响
- 编码后自检（AGENTS.md 规定）：admin → 同轮 `npx tsc --noEmit`；云函数 → SQL 参数化 + OPENID；`.wxml` → vant 陷阱表
- 每个可编译子步本地 commit（checkpoint）

worktree 专属守卫（共享资源，隔离不到位的两处）：

- **db migration**：所有 worktree 共享同一个 PG，同一时间只能有一个执行 `db:migrate`。worktree 内写 migration 文件没问题，**执行前先确认没有其它 worktree 在跑迁移**；新增 migration 前查两线 journal 尾部防撞号——`.tree/` 并行会放大撞号风险（已撞过两次）
- **L2 e2e / 小程序 devtools**：`e2e-cloudfn` 各 worktree 共用 `TE2L2_` 命名空间，并发跑会互相污染；同 appid 的 devtools 不能同时开两处。单 worktree 串行跑无碍，多条并行时必须错开

## 6. 三层验证（规则 · 判据 · 实效）

规则层和判据层必须通过，实效层列 merge 后人工验证项；结果写 `_tmp/issue-<N>/verify.md` 并更新 `state.md`。

**规则层**（全部退出码 0，不过 → 先修实现或补测试，**不绕过**）。**先 `cd "$WT"` 再跑**——下列相对路径都以 worktree 根为基准，跑错仓库等于没验：

```bash
cd fengyu-admin && npx tsc --noEmit                                    # 改了 admin 必跑
cd fengyu-admin && npx vitest run <相关文件>                            # admin 相关单测
cd fengyu-staff/cloudfunctions/staffApi && npx vitest run <相关文件>    # staff 云函数单测
# 跨端副本改动必跑 snapshot：
cd fengyu-staff/cloudfunctions/staffApi && npx vitest run __tests__/routes/cross-end-*.test.js
cd fengyu-admin && npx vitest run src/lib/__tests__/error-codes-cross-end.test.ts
bun fengyu-staff/tests/e2e-cloudfn/run-all.mjs --filter <module>        # 云函数行为改动补 L2 smoke
```

**判据层**（对照判据走正负例，判"好坏"）：
- issue 验收标准逐条核对，每条给证据（file:line / 测试名）
- `.42cog/real.md`（硬规则）与相关 pr.spec 章节走查
- 特殊单正负例：寄存单/历史单（禁退款回款改实收）、退款态、待支付 pending、空值/零金额

**实效层**（留给人，AI 不能替代）：
- 在 issue 评论列「实效验证点」清单：dev 环境 admin 上点哪个页面看什么、微信开发者工具/真机走哪条路径
- 这是 merge 后由用户执行的最终定标，不阻塞开 PR

## 7. 评审双闸门（PR 前）

先读 [评审约定](references/review.md)，它包含四维自审、两路 CLI、输入材料、finding 裁决与故障规则。

1. Codex 按 sibling / concurrency / boundary / simplify 四维审完整交付 diff，记录 `review/self-audit.md`；相关 invariant 全部有证据，P0/P1 清零后进入独立评审。
2. 精确提交待审文件，准备 `review/context.md`，调用 `scripts/dual_review.py`。两路固定 GLM-5.3[1M] + DeepSeek；不得把开发者 Codex 计作独立谱系。
3. 范围内 P0/P1/P2 修复并复验，逐条记录裁决。两路都审过同一最终 HEAD、无未处理的阻塞项才开 ready PR。范围外建议留本地 backlog，不自动派生 issues。
4. harness 失败/材料不足/争议未收敛保留 worktree，可交付 draft 并说明缺口。账户级错误不空转、不自动更换谱系；不冒充通过。

## 8. 交付

1. **精确 add**：`git add <明确文件列表>`——排除 version.ts、并发会话的无关改动，禁 `git add -A`
2. conventional commit 带 issue 号：`fix(staff): 修复 xxx (#N)`
3. `git push -u origin "$BRANCH"` 后开 PR（body 落临时文件防反引号插值）：`gh pr create --base dev --title "..." --body-file /tmp/pr-body.md`

PR body 固定结构（由 Codex 按实际结果整理）：

```markdown
## 改了什么
<一句话>

## Invariant Audit 表
| Invariant | 是否守住 | 证据 |
|---|---|---|

## 验收标准对照
- [x] <issue 验收标准逐条> — <证据 file:line 或测试名>

## 三层验证
- [x] 规则层：<实际跑过的命令与结果>
- [x] 判据层：<正负例走查结论>
- [ ] 实效层（merge 后人工）：<验证点清单>

## 评审
- Codex 四维自审：<invariant 与结论>
- 独立双谱系：GLM-5.3[1M] / OpenCode + DeepSeek / Claude Code，最终 HEAD <SHA>，无未处理的范围内 P0/P1/P2
- 范围外建议：<本地 backlog 路径与裁决，未自动建单>

Refs #N
```

4. `gh issue comment N`：实现说明 + PR 链接 + 实效验证点清单
5. **不自动 merge、不自动 close**——merge 由用户执行，仓库默认分支未必是 dev，不能依赖 `Closes #N` 在合入 dev 时自动关单；PR 用 `Refs #N`，合并后核验并由用户决定关单
6. 重大架构决策 / 生产操作 → 调 `dev-changedoc` 补 `docs/changes/`（⚠️ 多批 PR 改同一索引会冲突，resolve 保留所有行）

### 回收 worktree（顺序不可颠倒）

**① 归档 checkpoint 回起点仓库**——⚠️ **这一步是唯一防线，顺序绝不能颠倒**：`git worktree remove` 不会因为 `_tmp/` 是 gitignored 就拒绝或告警，它直接连 `_tmp/` 一起删掉（已实测）。PR body 里引用的 `_tmp/issue-N/review/` 必须在 worktree 消失后依然有效：

```bash
cp -R "$WT/_tmp/issue-<N>/." "$BASE/_tmp/issue-<N>/"
```

**② 三项前置核验，任一不过就保留 worktree 并报告，不删**：

```bash
git -C "$WT" status --porcelain                      # 空 = 无未提交改动
git -C "$WT" log --oneline "origin/$BRANCH..HEAD"    # 空 = commit 全部已 push
ls "$BASE/_tmp/issue-<N>/"                           # 归档文件在
```

**③ 清本机产物再删**：

```bash
rm -f "$WT/fengyu-admin/node_modules" "$WT/db/node_modules"    # 只是软链，unlink 不碰目标
rm -rf "$WT/_tmp"
cd "$BASE" && git worktree remove "$WT"              # 若拒绝 → --force（三项核验已过，安全）
```

实测两点（省得临场犹豫）：`git worktree remove` **不**跟着 node_modules 软链去删起点仓库的依赖；gitignored 文件也**不**会让它拒绝——所以它通常一次就过，前两行 `rm` 是防御性的，别指望 git 帮你拦住误删。

**④ 本地分支保留，不删**：分支还没 merge 进 dev，`git branch -d` 会拒绝；留着它，PR review 提意见要回改时 `bash scripts/worktree-setup.sh "$BRANCH"` 就能重建现场（这次不传 start-point，直接 checkout 已有分支）。

**⑤ 收尾**：更新 `$BASE/_tmp/issue-<N>/state.md` 为 `delivered`，删掉 `$BASE/_tmp/issue-<N>/WORKTREE` 指针，对话给 ≤200 字总结 + 关键路径。

⚠️ **中途失败一律不回收**：blocked / 待拍板 / 评审未收敛 / 三层验证未过 → worktree 原样保留，`state.md` 记清停在哪一步，等下次重入。回收只发生在 PR 成功开出之后。

## 意外处理

| 意外 | 处理 |
|---|---|
| 中断重启 / 会话被压缩 | 读 `$BASE/_tmp/issue-<N>/WORKTREE` 找回 `$WT` → 读其 `state.md` + `git -C "$WT" log`，从断点续，不重做、不重建 worktree |
| 发车时该分支的 worktree 已存在 | 复用它，读 `state.md` 续跑——同分支不能在两个 worktree 同时 checkout，重建必失败 |
| `worktree-setup.sh` 报主仓 node_modules 不存在 | 先在**起点仓库** `cd fengyu-admin && bun install`（db 同理），再重跑脚本 |
| base 校验 `origin/dev..HEAD` 非空 | 先调查是否为在途分支；不丢弃已有提交 |
| `git worktree remove` 拒绝 | 漏清 node_modules 软链或 `_tmp`；清完重试，仍拒绝且三项核验已过 → `--force` |
| git 状态异常 / 未知分支 | 先调查再动，不覆盖在途工作 |
| 根因模糊 | 先定位层级再改，不猜 |
| sibling 漂移（别的端副本已改过） | 以 snapshot 测试为准对齐，别单边改 |
| 规则层缺检查手段（如 wxml 无 CLI 编译检查） | 判据层补人工走查项 + 实效层列真机验证点——是整改不是绕过 |
| 评审 harness 版本参数变化 | 先 `--help` 核对，更新仓库内评审脚本/参考文档 |
| 小程序审核被阻（前端发不了版） | 照常开发合入 dev，issue 评论标注"待审核通过后发版" |
| 新的产品方向 / 未确定业务口径 | 集中澄清，不编造结论；已有确认不重复问 |
| 输出超长 | 落 `_tmp/issue-<N>/`，对话给路径 + 摘要 |
