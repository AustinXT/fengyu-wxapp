# 日报 PK 全部市场按月分班候选结构

## 业务约定

总部按归属月统一配置全市场班级、门店和军团。各市场经营日期仍独立；跨市场同班各自按经营月/当前经营周计算目标和完成，按周完成率统一排名。区域筛选仅查找门店。

## 独立测试库已执行

- 2026-10-07，在 `101.34.242.103:8151/fengyu_daily_dev` 执行候选 SQL，事务保护，Drizzle journal 保持不变。
- 备份：`/www/wwwroot/fengyu-daily-db/backups/daily-20261007T152638Z.dump`。
- 候选 SQL SHA-256：`1db463914068137472eb52506b9cae743c23e870bfbb2e1c94f9662f13023414`。
- `daily_pk_classes`、`daily_pk_stores` 新增 nullable `month_key`，存量从经营周期回填；增加按月班级名/门店唯一约束及班级复合外键。新后台保存始终写 month_key；period_id 保留兼容锚点。
- 执行后3个班级、9条门店分配不变，month_key 无空值。

## 待集中迁移集成

未生成正式迁移、未修改旧迁移和journal。正式发布前按 rollout 流程集成；独立库已经执行该候选结构，衔接时先核查以避免重复 DDL。共用dev/prod未执行。
