# 日报经营周期模板与分级目标填报

- 变更目标：支持全局及区域经营周期模板、按月覆盖和快照生成；日报读取按员工门店区域解析周期；目标支持组织范围内代填及按周天数分摊。
- 状态：正式迁移待集中集成。候选 SQL 已于 2026-10-05 在日报独立测试库 `fengyu_daily_dev` 事务执行并回读验证；未修改共享 dev/prod 数据库，也未写入 Drizzle journal。
- 依赖：现有 `daily_operating_periods`、`daily_operating_targets`、`daily_pk_*`、`daily_reports`；不修改历史已提交日报快照。
- 候选 SQL：`daily-cycle-templates.sql`。本文件不是正式迁移，不生成正式编号或 journal。
- 兼容：旧周期 `region_id/month_key/template_id IS NULL` 作为全局历史周期；新建区域周期优先匹配区域，缺少区域周期时回退全局。
- 独立库执行：`scripts/backup-daily-db.sh` 备份至 `/www/wwwroot/fengyu-daily-db/backups/daily-20261005T134826Z.dump` 后，以 `daily_owner` 对 `fengyu_daily_dev` 执行候选 SQL；SHA-256 `f54f3e70cd3014a65bb1834016566dd21a685c39e18272086bde6ab3f63d6225`。回读确认 3 张新表、4 个周期字段，应用账号可执行周期关联查询。
- 验证：私有 PostgreSQL 空库/存量库；区域周期优先级、单月覆盖、连续周校验、日报归属、目标与 PK 区域隔离、授权代填、周目标取整与尾差、并发与审计。当前独立库候选结构不能替代正式迁移；正式迁移生成时须核对并处理该候选状态，避免重复添加。
- 部署顺序：正式迁移集中集成并评审 → 经授权迁移目标库 → 部署后台及 dailyApi；本次开发不执行共享数据库迁移、不部署。
- 风险：区域周期后总部跨区域周成果表不能混用周边界；界面必须选定区域后查看周视图。门店区域变化按经营月快照处理。
