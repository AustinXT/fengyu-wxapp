# 用户文档 (Docs)

面向用户的正式文档，包括使用指南、API 文档和变更记录。

## 建议目录

```
docs/
├── guides/           # 使用指南
├── api/              # API 文档
└── changes/          # 变更记录（arch / ops / fix 三类顺序编号）
```

## 使用建议

- 文档使用中文，文件名使用英文
- 随代码变更同步更新相关文档
- 架构设计等开发者文档放在 `notes/` 下

## 变更记录索引

### arch — 架构决策

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](changes/arch/001_legacy-orders-manual-pull-pivot.md) | 2026-05-19 | admin /legacy-orders 改为按顾客手动拉取（弃用全量 bulk 导入） |
| [002](changes/arch/002_inventory-domain-v1.md) | 2026-05-19 | 门店库存域 v1（PG 4 对表 + admin 主写 + 员工端只读 + 提货流程 UI）**（已被 011 推翻）** |
| [003](changes/arch/003_lakala-payment-integration.md) | 2026-05-20 | 拉卡拉聚合支付接入（收银台 SDK + payNotify 启用 + 统一退货预留） |
| [004](changes/arch/004_merge-danpin-into-liaochengka.md) | 2026-05-21 | 单品合并入疗程卡（product_type 枚举 3→2 值） |
| [005](changes/arch/005_beautician-picker-include-wellness.md) | 2026-05-21 | 开单/下单/服务单的美容师选择列表放开养生师 |
| [006](changes/arch/006_service-order-customer-confirmation.md) | 2026-05-23 | 服务单新增「顾客确认」步骤（待客户确认 中间态） |
| [007](changes/arch/007_store-unbind-to-transfer-flow.md) | 2026-05-23 | 门店解绑流程改为「转店」（前置选新门店）+ 修复审批缓存陈旧 bug |
| [008](changes/arch/008_lakala-preorder-migration.md) | 2026-05-29 | 拉卡拉支付从收银台模式整体迁移到聚合主扫模式（+ 支付宝吱口令） |
| [009](changes/arch/009_lakala-merchant-onboarding.md) | 2026-05-29 | 拉卡拉商户入网模块（admin 14 步 OpenAPI 流程 + N:1 商户绑定 + 费率全 admin 不可见） |
| [010](changes/arch/010_fengyu-analyst-independent-site.md) | 2026-07-21 | fengyu-analyst 独立分析站点技术方案（Next.js 独立部署 + 复用业务主库与 admin 账号权限） |
| [011](changes/arch/011_inventory-domain-v3.md) | 2026-09-02 | 进销存域 v3（三级统一 14+1 表 + 33 单据类型 + 独立角色三重 scope 强制 + 金额触发器单源 + 四档价格裁剪） |
| [012](changes/arch/012_split-picked-up-quantity-into-three-columns.md) | 2026-09-18 | sale_items.picked_up_quantity 三语义拆列（新增 refunded_quantity / converted_quantity） |

### ops — 生产操作

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](changes/ops/001_admin-container-timezone.md) | 2026-05-27 | admin 容器锁定东八区（tzdata + TZ），修复后台时间列晚 8 小时 |
| [002](changes/ops/002_lakala-3-merchants-backfill.md) | 2026-05-30 | 凤御 3 个拉卡拉商户 legacy 行手抄入库 + admin 加「反查开户状态」按钮 |

### fix — 故障复盘

| 编号 | 日期 | 标题 |
|------|------|------|
| [001](changes/fix/001_drop-stores-lakala-sub-appid.md) | 2026-05-30 | stores 删除冗余 lakala_sub_appid 列（双源风险预防性清理） |
| [002](changes/fix/002_zero-payable-order-stuck-pending.md) | 2026-06-06 | 优惠券全额抵扣（应付实金为 0）订单卡在「待支付」死循环 |
| [003](changes/fix/003_cloudfn-pg-timestamp-timezone.md) | 2026-06-16 | 云函数 pg timestamp 读取时区根治（北京时间间歇晚 8 小时显示 16 点） |
| [004](changes/fix/004_staff-confirm-session-count-and-qrcode-amount.md) | 2026-06-29 | staff 开单确认页补疗程卡规定次数 + 二维码页充值卡单/转换单金额误显 0 |
| [005](changes/fix/005_conversion-panel-align-sales-confirm.md) | 2026-06-29 | staff 转换单确认页对齐销售单（补商品明细/活动/支付卡片+支付宝） |
| [006](changes/fix/006_staff-list-member-price-always-dual.md) | 2026-06-29 | staff 开单页商品列表无条件展示划线标价+会员价（修正 #26 子项1 前轮误判） |
| [007](changes/fix/007_scan-detail-staff-order-timeout.md) | 2026-06-29 | admin 开单顾客扫码即「已关闭」（admin 写 sale_order_datetime UTC 时区 bug 致 closeExpiredOrder 误判，opened_by 守卫兜底） |
| [008](changes/fix/008_payment-status-not-update-after-lakala-pay.md) | 2026-06-30 | client 支付完成订单状态不更新（拉卡拉回调偶发丢失无补偿 + 前端跳转不等回调 + 详情页频闪） |
| [009](changes/fix/009_legacy-order-approve-no-payments.md) | 2026-07-20 | 历史订单审核剥离「首次支付」补登流水（回归哑数据口径 + I1 豁免 legacy） |
