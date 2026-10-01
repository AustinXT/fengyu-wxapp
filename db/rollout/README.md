# 数据库变更集成与部署台账

2026-10-01 用户确认：issue 独立开发，正式迁移集中集成，dev/prod 分别登记执行状态。本规则取代「issue 全程持有迁移令牌」，不授权自动 merge、迁业务库或部署。

## 独立开发

1. 各 issue 在自己的 worktree 改 schema/业务代码，提交 `db/rollout/requests/issue-N.md`：变更目标、依赖、候选 SQL/回填脚本路径、数据兼容、执行顺序、验证和上线约束。候选 SQL 不放 `db/migrations/`，不选号、不改 journal。
2. 不运行正式 `db:generate`，不抢全局迁移令牌。私有库可用候选 SQL 验证；需真实新 schema 的测试在私有库进行，不迁共享 dev/prod。
3. 继续能独立完成的测试、四维自审与双谱系评审。等待的 DB 项标「待迁移集成」，不会阻止其他 issue 发车。最终 migration 未验证/评审的 PR 只能 draft，checkpoint/worktree 保留。
4. 新代码依赖迁移时不得提前合并为可部署交付。可兼容旧库的代码是否先合并须有测试证据，并在 PR 与环境台账明确发布约束。

## 集中集成

集成会话逐项处理；业务开发会话不担任长时间的锁持有者。

1. 从最新 `origin/dev` 开隔离集成 worktree，选依赖已满足的请求；读取相关业务提交/schema/候选 SQL。跨 issue 合并为一个 DB PR 时列全部编号与验收，不丢失 schema 改动和应用依赖。
2. 读取起点仓库 `_tmp/db-integration/current.md`（若有），扫描现存 worktree 的本地迁移 diff/未提交文件，并检查全部 open PR：用 `gh pr diff N --name-only`（不要只用 `--json files`）查 `db/migrations/`。若有尚未合并的正式迁移，先验证并交付它；下一项正式生成等待其合入 dev，业务开发/评审照常推进。**释放物理锁不等于允许从旧 journal 生成另一条迁移。**
3. 生成前用 `mkdir /tmp/fengyu-migration-integration.lock` 取短锁，成功后才写 owner（会话 ID、PID、worktree、开始时间），并设置 trap 清理自己的锁。失败只跳过本次集成，不跳过 issue 开发。锁被异常遗留时，核验 owner/PID 和工作状态后再清理；不删其他活跃会话的锁。
4. 锁内再次 fetch，核验已集成的 dev journal 和在途 PR，基于最新基线运行 `db:generate`；纯 SQL/权限数据变更走 `db:generate -- --custom --name <slug>`。只由生成器分配编号/when，不手改号、不复用旧 when。私有库重放空库与相关存量夹具，提交完整 SQL/journal/snapshot 及实际 schema 变更。
5. 生成、私有库验证和本地提交完成（或失败保存断点）后，先在起点仓库 `_tmp/db-integration/current.md` 登记候选 worktree、HEAD、tag/hash、验证状态与下一步，再释放锁；**不在业务开发、等待评审、等 merge、等部署期间持锁**。失败产生的未交付迁移必须登记为在途候选，后续会话先恢复处理，不视作可重新分配的空位。
6. 补 dev/prod 台账的确切 tag/文件哈希、脚本、顺序、应用依赖和校验；完成完整交付 diff 的验证与 GLM/DeepSeek 双谱系评审。独立 DB PR 与业务 PR 相互引用；业务 PR 的最终 HEAD 也必须评审。未经用户授权不 merge。前一 DB PR merge 且最新 dev 含完整迁移后，清除该候选记录，下一集成项更新基线继续。

锁只保护本机操作；跨机器集成还必须协调唯一集成会话和在途 PR。不得以「本机无锁」推断无人生成迁移。

## dev / prod 部署

- [dev.md](dev.md)：101.34.242.103:5433/fengyu_wxapp。
- [prod.md](prod.md)：118.178.196.26:5433/fengyu_wxapp。
- 同一套不可变 Drizzle 迁移，两份环境执行记录；不创建 dev/prod 两套 SQL 或 journal。
- 每次发布先根据待发布 commit 和目标库 `drizzle.__drizzle_migrations` 只读核对实际 pending（when/内容 hash）。台账是执行记录，不能代替目标库的事实。若库超前、hash 漂移或本地历史不完整，停止发布。
- 迁移执行入口仍为显式目标断言后的 `DATABASE_URL=<目标> npm --prefix db run db:migrate`，会执行该发布树中的全部 pending；不能按台账挑几条 SQL 跳过 journal。目标库写操作须已有部署授权。
- 按台账先做前置检查，再迁移，再执行已批准的一次性数据脚本，再校验，最后上线依赖代码。登记必要的具体命令/参数名但不记录连接串、密钥或客户数据。
- 一次性脚本不承担普通结构/权限迁移，不另建平行 migration runner。登记幂等性、事务、目标断言、依赖、失败续跑方式；仅登记不代表授权自动运行。release-all 仍不自动执行回填/修复脚本，须先按专项流程处理完成。
- 执行后只更新当前环境的状态、时间、发布 SHA、迁移 hash、验证证据和执行人；dev 成功不能把 prod 标成功。未知历史状态先核对，不猜。

## 过渡

`/tmp/fengyu-migration-token` 废弃为发车门禁，不再给新 issue 分配；不要直接删除现有会话目录。既有已生成迁移先核对是否已执行/已合并、基线及 hash，作为队列首项交接，不覆盖或重编号。未生成的「待迁移令牌」状态改为「待迁移集成」。

当前已知：#353 有候选 `0058_store_surplus_standard_price`（尚未在本次工作中验证其交付/执行状态），应优先交接；#364 已完成代码检查点，迁移未生成。其他会话自行登记其请求，不推断其就绪状态。
