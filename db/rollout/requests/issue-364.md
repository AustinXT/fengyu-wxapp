# #364 本店货款结算权限

- 状态：待迁移集成；业务检查点 `171543a97`，分支 `feat/issue-364-store-settlement`。
- 工作树：`.tree/feat/issue-364-store-settlement`；验证日志 `_tmp/issue-364/`。正式迁移 tag/hash：尚未生成。
- 依赖：最新 dev 权限角色定义与 0050 镜像刷新模式；现存 #353 迁移先交接集成，不能复用其编号。
- 变更：角色定义追加 `inventory:store_settlement_view`。授予超管/manager，并保留既有同角色 `inventory:list` + 价格权持有者的结算入口；不扩展一般库存/价格权限，不改变 allowed_scope_types。
- 原子性：授权 UPDATE 和取 `permission_matrix:mirror` 锁刷新兼容镜像同事务，动作去重排序，重放不重复授权。
- 生成：集中集成会话基于最新 dev 用 `db:generate -- --custom --name store_settlement_permissions`；SQL 参考 0050，不手改编号/when。无 schema 列变更。
- 验证：私有库 `pg-verify-364`、端口 54404，构造存量 manager/超管/既有库存价格角色/普通库存员/自定义角色正负例并验证幂等。admin 端口 3014。代码 tsc 与 171 条相关单测已通过；正式迁移和最终双谱系评审待完成。
- 上线顺序：角色定义现状只读核对 → `db:migrate` → 校验角色动作与兼容镜像 → 上线依赖 admin。无需独立回填脚本；先迁权限再上新页闸，避免既有角色失去入口。
- 边界：COALESCE 回退留 #349；不新增股东账号、不迁共享库、不自动部署。
