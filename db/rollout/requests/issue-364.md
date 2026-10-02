# #364 本店货款结算权限

- 状态：已与 #356 集中生成同一正式迁移，私有验证通过，待双谱系评审/合入 dev；业务检查点 `171543a97`，分支 `feat/issue-364-store-settlement`。
- 工作树：`.tree/feat/issue-364-store-settlement`；验证日志 `_tmp/issue-364/`。正式迁移：`0060_summary_void_store_settlement` / `4a542e22fed9c9bb1d307fa0606a429d5a88cda68a06d22e7ba6053a975d0d9b`；when `1790906092154`。
- 依赖：最新 dev 权限角色定义与 0050 镜像刷新模式；现存 #353 迁移先交接集成，不能复用其编号。
- 变更：角色定义追加 `inventory:store_settlement_view`。授予超管/manager，并保留既有同角色 `inventory:list` + 价格权持有者的结算入口；不扩展一般库存/价格权限，不改变 allowed_scope_types。
- 原子性：授权 UPDATE 和取 `permission_matrix:mirror` 锁刷新兼容镜像同事务，动作去重排序，重放不重复授权。
- 生成：2026-10-02 基于最新 dev 运行 `db:generate -- --custom --name summary_void_store_settlement`，与 #356 同一正式迁移；SQL 参考 0050，不手改编号/when。无 schema 列变更。
- 验证：私有库 `pg-verify-364`、端口 54404，构造存量 manager/超管/既有库存价格角色/普通库存员/自定义角色正负例并验证幂等。admin 端口 3014。代码 tsc 与 171 条相关单测已通过；正式迁移已在后续集成完成私有验证，最终双谱系评审待完成。
- 上线顺序：角色定义现状只读核对 → `db:migrate` → 校验角色动作与兼容镜像 → 上线依赖 admin。无需独立回填脚本；先迁权限再上新页闸，避免既有角色失去入口。
- 边界：COALESCE 回退留 #349；不新增股东账号、不迁共享库、不自动部署。

## 2026-10-02 集中集成

- 正式 SQL/journal/snapshot 与 #356 共用 `0060_summary_void_store_settlement`，基于 `origin/dev 2f43739e3`；旧60条SQL和journal前缀逐字节未变，无 schema 列变更。
- 授权范围：is_super_admin、manager，以及同角色同时持 inventory:list 与 supply_chain_price_view/market_price_view 的定义；其它角色不变，不扩展价格/一般库存权，不改 allowed_scope_types。
- 角色更新后取 permission_matrix:mirror 事务锁，独立下一语句刷新兼容镜像；lock_timeout=3s。
- 私有存量升级/空库、角色正负例、动作去重排序、范围/其它属性无损、镜像一致、SQL重放幂等通过；镜像锁超时全事务回滚后真实Drizzle重试成功。
- 无额外脚本。后置核验正式lifecycle有效trigger、permission_role_definitions与permission_matrix逐角色一致、journal when/hash；完成后才发布admin。两环境均未执行；dev后续只读核对发现0034 when差异，详见dev台账。
