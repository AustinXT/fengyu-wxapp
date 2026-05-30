# 变更记录 (Changes)

按类型分目录、按顺序编号的项目变更记录。

## 三类文档

| 类型 | 何时写 |
|------|--------|
| `arch/` | 重要架构 / 技术选型决策 |
| `ops/`  | 生产环境重要操作（部署、迁移、配置） |
| `fix/`  | 值得复盘的故障 |

## arch — 架构决策

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](arch/001_legacy-orders-manual-pull-pivot.md) | 2026-05-19 | admin /legacy-orders 改为按顾客手动拉取（弃用全量 bulk 导入） |
| [002](arch/002_inventory-domain-v1.md) | 2026-05-19 | 门店库存域 v1（PG 4 对表 + admin 主写 + 员工端只读 + 提货流程 UI） |
| [003](arch/003_lakala-payment-integration.md) | 2026-05-20 | 拉卡拉聚合支付接入（收银台 SDK + payNotify 启用 + 统一退货预留） |
| [004](arch/004_merge-danpin-into-liaochengka.md) | 2026-05-21 | 单品合并入疗程卡（product_type 枚举 3→2 值） |
| [005](arch/005_beautician-picker-include-wellness.md) | 2026-05-21 | 开单/下单/服务单的美容师选择列表放开养生师 |
| [006](arch/006_service-order-customer-confirmation.md) | 2026-05-23 | 服务单新增「顾客确认」步骤（待客户确认 中间态） |
| [007](arch/007_store-unbind-to-transfer-flow.md) | 2026-05-23 | 门店解绑流程改为「转店」（前置选新门店）+ 修复审批缓存陈旧 bug |
| [008](arch/008_lakala-preorder-migration.md) | 2026-05-29 | 拉卡拉支付从收银台模式整体迁移到聚合主扫模式（+ 支付宝吱口令） |
| [009](arch/009_lakala-merchant-onboarding.md) | 2026-05-29 | 拉卡拉商户入网模块（admin 14 步 OpenAPI 流程 + N:1 商户绑定 + 费率全 admin 不可见） |

## ops — 生产操作

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](ops/001_admin-container-timezone.md) | 2026-05-27 | admin 容器锁定东八区（tzdata + TZ），修复后台时间列晚 8 小时 |
| [002](ops/002_lakala-3-merchants-backfill.md) | 2026-05-30 | 凤御 3 个拉卡拉商户 legacy 行手抄入库 + admin 加「反查开户状态」按钮 |

## fix — 故障复盘

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](fix/001_drop-stores-lakala-sub-appid.md) | 2026-05-30 | stores 删除冗余 lakala_sub_appid 列（双源风险预防性清理） |
