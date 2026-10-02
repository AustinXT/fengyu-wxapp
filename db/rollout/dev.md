# dev 数据库发布台账

目标：`101.34.242.103:5433/fengyu_wxapp`。同一套 Drizzle 迁移，独立执行记录；详见 [集成规则](README.md)。

历史迁移执行状态：**2026-10-02 只读核对，发现 0034 多余旧时间戳记录；停止发布**。未迁移该库。实际 pending 为 0058/0059/0060；详见末尾核验记录。

| 请求 | 正式迁移 tag / hash | 前置检查 → 执行 → 后置校验 | 依赖代码 | 状态 | 执行证据 |
|---|---|---|---|---|---|
| [#353](requests/issue-353.md) | `0058_store_surplus_standard_price` / `f7fb41a1127d3e9b61507e6f0199913ea39b309559ccf8858db454c165047690` | 目标断言 + journal/hash 只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → 列/CHECK/触发函数/hash 校验；额外脚本：无 | #353 标准价与盘溢业务须先迁库后上线；#365 正式生成须等本项合入 dev | 已随 #510 合入 dev；本环境执行事实未核对，不可自动执行 | 仅私有验证，未连接本环境 |
| [#364](requests/issue-364.md) | 与 #356 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 角色定义只读核对 → 目标断言后的 db:migrate → 角色授权/镜像一致性校验 | admin 新结算页闸，须先迁权限 | 正式迁移私有验证通过；待评审/合并；本环境未执行 | 私有验证见 #356 请求 |
| [#365](requests/issue-365.md) | `0059_market_supplier_owner` / `332af31a4e32e18752fb85af354ddaec813ad7e07e28f9883a9df51ef76b8c82` | 显式目标断言 + journal/hash、存量总数/启用停用数与名称唯一只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下 db:migrate 全部已核准 pending → `node db/scripts/verify-inventory-v3-schema.js`、存量 NULL 与数量/hash 只读核对；额外脚本：无 | #507 admin 与同构建 export-worker 必须先迁库后发布；#364 权限请求仍待集成 | 已随 #507 合入 dev；本环境执行事实未核对 | 仅私有库验证，未连接本环境 |
| [#356](requests/issue-356.md) | 与 #364 共用 `0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b` | 目标断言 + 全部journal/hash只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下db:migrate → lifecycle/有效trigger、权限定义与镜像、hash校验；额外脚本：无 | #356作废与#364结算页须先迁库后发布admin | 正式迁移私有验证通过；待评审/合并；本环境未执行 | 60→61真实Drizzle升级、空库61条、11条PG正负例/权限幂等、镜像锁超时回滚后重试通过；业务库未连接 |

集成完成后填写实际文件路径、内容 hash、前后置校验命令和准确顺序。登记一次性脚本还必须列明幂等性、目标断言、事务和失败续跑方法；没有额外脚本写“无”。

执行后记录：状态（待执行/执行中/成功/失败）、时间、发布 SHA、执行人、迁移 tag/hash、脱敏日志或验证证据。失败不继续依赖代码发布；不得用另一环境的成功记录补本表。

## 2026-10-02 dev 只读发布前核验（Codex）

- 目标已断言 `101.34.242.103:5433/fengyu_wxapp`；使用 `BEGIN READ ONLY` 查询 journal，未执行任何业务库写操作。
- 核验发布候选基线 `2f43739e3` + 本交付0060：本地journal共61条；目标journal共59行=58条when/hash精确匹配+1条多余旧记录。正确计数是本地61=已应用58+pending3；库的第59行不属于本地不可变历史。
- 历史差异：`0034_lakala-onboarding-schema-repair` 的SQL SHA-256 `d4549ec0237b8f4441af860a02c0905e59e382e3c07503063f6310ec95b896bd` 在库有两行：id34/created_at=`1787637056739`（多余旧记录）与id36/created_at=`1787715148177`（已匹配本地when）。git `c65260594`（2026-08-26）改了该when，SQL内容未变；本地时间戳已被正确记录，不能再把id34更新为同一when造成两个canonical记录，亦不得由常规发版自行删改journal。
- pending：0058/0059/0060，确切hash见表；无额外脚本。历史差异未按专项流程处理前，常规db:migrate/admin/analyst/云函数发布全部停止。
- 脱敏证据：起点仓库 `_tmp/db-integration/356-364/dev-journal-readonly.json` 与 `dev-journal-0034-readonly.json`，核验时间 `2026-10-02T02:03:47.300Z`。本记录不更改prod状态，也不授权journal修复。
