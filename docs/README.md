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
| [004](changes/arch/004_merge-danpin-into-liaochengka.md) | 2026-05-21 | 单品合并入疗程卡（product_type 枚举 3→2 值） |
| [005](changes/arch/005_beautician-picker-include-wellness.md) | 2026-05-21 | 开单/下单/服务单的美容师选择列表放开养生师 |
| [006](changes/arch/006_service-order-customer-confirmation.md) | 2026-05-23 | 服务单新增「顾客确认」步骤（待客户确认 中间态） |
| [007](changes/arch/007_store-unbind-to-transfer-flow.md) | 2026-05-23 | 门店解绑流程改为「转店」（前置选新门店）+ 修复审批缓存陈旧 bug |

### ops — 生产操作

_暂无_

### fix — 故障复盘

_暂无_
