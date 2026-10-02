# #356 市场报货汇总作废 lifecycle 集成

- 状态：与 #364 合并为同一 DB 交付，正式迁移已生成及私有验证，待完整双谱系评审/合入 dev；未迁业务库。
- 基线：`origin/dev 2f43739e3`，0059 已合入；生成前扫描所有 worktree 正式迁移 dirty 与所有开放 PR，均无竞争候选。
- 正式文件：`db/migrations/0060_summary_void_store_settlement.sql`；when `1790906092154`；SHA-256 `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b`。编号/when/snapshot 由 `db:generate -- --custom --name summary_void_store_settlement` 生成。
- 变更：沿用 0043 lifecycle 全部已有规则，仅允许市场报货汇总已完成→已取消，要求非空作废原因、零履约、无未取消采购引用。单据、明细、血缘保留；不得恢复，其它已完成单据仍不能取消。
- 应用依赖：已合入 #356 的 voidMarketReportSummary；总部主体→明细→单头锁序与采购建单一致，DB EXISTS 守卫作二次防护。
- 顺序：目标断言与全部 journal when/hash 只读核对 → `PGOPTIONS="-c lock_timeout=3s"` 下真实 db:migrate → lifecycle 定义/有效 trigger、权限定义/镜像及 journal hash 校验 → 发布 admin。额外脚本：无。
- 与 #364 权限同事务，SQL 首条 SET LOCAL lock_timeout=3s；镜像锁超时 3652ms 后函数/权限/journal 全回滚，解除阻塞后真实 Drizzle 重试成功。
- 私有验证：自有 pg-integration-356-364:54406，旧60条→61条真实 Drizzle升级、空历史61条 bootstrap，全部 when/hash 匹配、db:migrate重复无pending；11条 PG正负例/授权边界/幂等通过，schema校验全过；admin tsc和419条相关单测通过。
- 完整链路198通过、2条既有#336血缘标签断言失败；#356/#364验收通过。既有失败与原#356/#365验证记录一致，不冒称全链全绿。
- 双谱系评审和PR链接在完成后追加；dev/prod执行事实独立，当前均未连接，不能由私有验证推断业务库成功。
