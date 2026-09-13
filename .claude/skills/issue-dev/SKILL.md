---
name: issue-dev
description: |
  单条 issue 从摄入到 PR 的完整流水线：状态校验 → 调研 → 确定性分流 → 细化 →
  实现 → 三层验证 → pr-ready 对抗审查 → 双谱系评审 → PR base dev。
  全程 checkpoint 落 _tmp/issue-<N>/，可断点重入。需求歧义必停等拍板；
  质量闸门不因维护期降级。
  当用户说"处理 issue #N"、"跑这个 issue"、"把这条 issue 做了"、
  "发车"、"issue-dev"时激活。
argument-hint: '<issue 编号 or URL>，如: 70'
user-invocable: true
metadata:
  title: 单条 issue 开发流水线
  description_zh: issue 摄入 → 分流 → 实现 → 三层验证 → 双闸门评审 → PR base dev
  author: nvoyager
  version: 2.0.0
  license: MIT
---

# issue-dev · 单条 issue 开发

维护期定位：**需求没做对是事故；质量闸门是放手让 AI 执行的前提，不是可裁剪的精益求精**。"不精益求精"只体现在：粒度小、不做产品方向决策、不追求代码美学——验证与评审纪律一项不减。

## 0. 状态管理（长程执行的生命线）

工作目录 `_tmp/issue-<N>/`（项目约定的临时区，已 gitignore）：

| 文件 | 内容 | 写入时机 |
|---|---|---|
| `state.md` | checkpoint：当前阶段 / 分支名 / 已完成步骤 / 下一步 | **每过一个阶段闸门立即更新** |
| `triage.md` | 调研产出（§2） | §2 结束 |
| `spec.md` | 细化产出（§4，同步回填 issue 评论） | §4 结束 |
| `verify.md` | 三层验证结果（§6） | §6 结束 |
| `review/` | pr-ready 四份 audit 存档 + 双谱系各轮输入输出 | §7 每轮 |

纪律：
- **长输出一律落文件，对话只给路径 + ≤200 字摘要**（防 token 黑屏把上下文吃光）
- **commit 即检查点**：实现阶段每完成一个可编译的子步就本地 commit，防网关中断/token 超限把活清零
- **重入协议**：启动时若 `_tmp/issue-<N>/state.md` 已存在 → 先读它 + `git log` 该分支，从断点继续，**不重做已完成阶段**
- 路径一律绝对路径（评审跑得久，cwd 可能被并发命令改掉）

## 1. 状态校验（永远第一步）

```bash
git fetch origin && git status && git log --oneline -3 origin/dev
```

- 工作区有并发改动 → **不 stash**（stash 栈与其它会话共享），后续用精确 `git add` 隔离
- 基于 origin/dev 建分支：需求 `feat/issue-N-<slug>`，Bug `fix/issue-N-<slug>`

## 2. 摄入与调研（先别写代码）

1. `gh issue view N --comments` 读全文 + 评论 + 关联 issue/PR + 最近合并的 sibling PR（套其改造模式）
2. 定位涉及端：client / staff / admin / db / 云函数；口径存疑对照 `.42cog/` specs 与 MEMORY.md
3. **是否已部分实现先 grep**——只补差量，别重做
4. Bug 类先复现/确诊根因；跨层的先定位是哪层，**别猜**
5. 产出写 `_tmp/issue-<N>/triage.md`：根因/涉及端/工作量粗估/已实现部分/风险点

## 3. 确定性分流闸门（快走 ≠ 免检）

| 情形 | 行为 |
|---|---|
| 高确定性（根因明确 / 需求清晰有验收标准） | 一句话确认 → 直接进 §5，**后续验证评审照跑** |
| 需求歧义 / 触业务口径（金额、权限、状态机、提成） | §4 集中列关键问题（每个给推荐 + tradeoff）→ 回填 issue 评论 → **停等拍板**；无人值守标记跳过 |
| 已部分实现 | 核对已有部分，只补差量 |
| 估算 > 3 天 | **拒绝无人值守**，先在 issue 评论拆步骤/子任务，等确认 |
| 值不值得做存疑 | 给「做 / 不做 / 关闭」结论 + 理由，等拍板 |

**触业务口径必问**——本项目大量口径 memory（回款/退款/提成/寄存单）都源于口径拍板，不替甲方决定。

## 4. 细化 + 回填 issue

复杂需求（新表/新字段/新状态机/跨 3 端）走三段细化，产出 `_tmp/issue-<N>/spec.md` 并**回填 issue 评论**（不只留对话里）：

1. **实体与字段**：对照 `db/schema/` 列新增/修改的表、字段、枚举；有状态流转必画状态机（必经 vs 可选、终态、能否回流、死锁态检查）
2. **信息流**：动作表——触发方式 / 输入 / 输出 / 同步异步 / 副作用（写库、发通知、扣次数）
3. **安全边界**：老数据兼容、旧接口是否动、写入是否复用已有接口（不绕过）、会不会破坏已上线功能

简单 bug / 文案 / 单端小改跳过本节，直接进 §5。

## 5. 实现

- 动手前对照 MEMORY.md：diff 触到的概念（回款、退款、寄存单、积分、提成、权限……）先 cat 对应 memory，别撞已知口径
- 跨端共有逻辑（refund-cascade / settlePoints / scope / error-codes 等）**改一端必 grep 其余端副本同步**
- 结构性变更（枚举 / 删改字段 / 表结构）→ 先走 `wx-change-propagation` 扫全仓影响
- 编码后自检（CLAUDE.md 规定）：admin → 同轮 `npx tsc --noEmit`；云函数 → SQL 参数化 + OPENID；`.wxml` → vant 陷阱表
- 每个可编译子步本地 commit（checkpoint）

## 6. 三层验证（规则 · 判据 · 实效）

三层都过才算过；结果写 `_tmp/issue-<N>/verify.md` 并更新 `state.md`。

**规则层**（全部退出码 0，不过 → 先修实现或补测试，**不绕过**）：

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

## 7. 评审双闸门（PR 前，硬纪律）

**闸门 1 · `/pr-ready`**（3 并行对抗 reviewer + simplify）：
- 调用全局 `pr-ready` skill——它按项目模版（`templates/fengyu-wxapp.md`：invariant 触发表 / 评审维度 / 验收命令）派 sibling-auditor、concurrency-adversary、boundary-critic 三个并行 reviewer + 跑 `/simplify`，产出 P1/P2 audit 表与 PR description 草稿
- 跑之前先 `git add` staged（pr-ready 只审 staged diff）
- **P1 清零才进闸门 2**；audit 四份文件从 `.claude/notes/pr-ready/` 拷贝存档到 `_tmp/issue-<N>/review/`（pr-ready 是覆盖式快照，不存档会被下一条 issue 冲掉）

**闸门 2 · 双谱系评审**（两个不同谱系的前沿模型都通过才算过）：
- 配置读 `.claude/dev-launch.review.md`（主链 codex/GPT 系 + opencode GLM 系，降级 DeepSeek/Gemini；文件不存在 → 先停下按其首次配置流程问人）
- **喂法铁律**：评审输入（提示词 + diff + 验收标准 + invariant 摘要）落成文件，**stdin 重定向**喂，绝不把内容插值进 shell（反引号会被当命令执行）
- 每轮输入输出存 `_tmp/issue-<N>/review/round-K-<谱系>.md`，按 P0/P1/P2/P3 分级逐条闭环
- **收敛标准是「无 P0/P1/P2」，不是轮数**；某谱系挂掉（429/auth）→ 按降级链换谱系凑齐两个，**绝不降级为单评审**
- 谱系全挂 → 停下报告，PR 标 draft 并注明"双谱系未完成"，不带病放行

## 8. 交付

1. **精确 add**：`git add <明确文件列表>`——排除 version.ts、并发会话的无关改动，禁 `git add -A`
2. conventional commit 带 issue 号：`fix(staff): 修复 xxx (#N)`
3. 开 PR（body 落临时文件防反引号插值）：`gh pr create --base dev --title "..." --body-file /tmp/pr-body.md`

PR body 固定结构（大部分内容闸门 1 已生成草稿）：

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
- pr-ready：P1 0 / P2 <n>（详情 _tmp/issue-N/review/）
- 双谱系：<谱系A> + <谱系B>，共 <K> 轮，收敛无 P0/P1/P2

Closes #N
```

4. `gh issue comment N`：实现说明 + PR 链接 + 实效验证点清单
5. **不自动 merge、不自动 close**——merge 由用户执行，`Closes #N` 随 merge 自动关单
6. 重大架构决策 / 生产操作 → 调 `dev-changedoc` 补 `docs/changes/`（⚠️ 多批 PR 改同一索引会冲突，resolve 保留所有行）
7. 更新 `state.md` 为 `delivered`，收尾对话给 ≤200 字总结 + 关键路径

## 意外处理

| 意外 | 处理 |
|---|---|
| 中断重启 / 会话被压缩 | 读 `_tmp/issue-<N>/state.md` + 分支 git log，从断点续，不重做 |
| git 状态异常 / 未知分支 | 先调查再动，不覆盖在途工作 |
| 根因模糊 | 先定位层级再改，不猜 |
| sibling 漂移（别的端副本已改过） | 以 snapshot 测试为准对齐，别单边改 |
| 规则层缺检查手段（如 wxml 无 CLI 编译检查） | 判据层补人工走查项 + 实效层列真机验证点——是整改不是绕过 |
| 评审 harness 版本参数变化 | 先 `--help` 核对，坑记回 `.claude/dev-launch.review.md` |
| 小程序审核被阻（前端发不了版） | 照常开发合入 dev，issue 评论标注"待审核通过后发版" |
| 触及产品方向 / 业务口径 | 停下问人，不编造结论关 issue |
| 输出超长 | 落 `_tmp/issue-<N>/`，对话给路径 + 摘要 |
