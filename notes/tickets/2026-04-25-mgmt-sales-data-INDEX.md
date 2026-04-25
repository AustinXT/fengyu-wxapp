# Tickets Index — 管理层销售数据页（mgmt-dashboard `sales` 入口子页）

> 生成日期：2026-04-25
> 需求来源：用户提出的设计稿（3 个时间 chip + 业绩与实耗分客型矩阵 + 业绩与品项三维度汇总）
> 现状：`pages/mgmt-dashboard` 的"查看销售数据"入口点击显示 Toast "销售数据 页面开发中"，尚无实际页面

本需求被拆为 2 个 ticket（前后端可并行）：

| # | Ticket | 端 | 前置 |
|---|---|---|---|
| 1 | [salesData-api](./2026-04-25-mgmt-sales-data-api.md) | staffApi 云函数 | 无 |
| 2 | [salesData-page](./2026-04-25-mgmt-sales-data-page.md) | fengyu-staff 前端 | T1 |

## 依赖图

```
metrics.md（分客型/品项指标定义）──→ T1（salesData API）──→ T2（sales-data 前端页）
                                                             ↑
                                     mgmt-dashboard.ts 中 onEntryTap 'sales' 跳转点
```

## 需求复述

### 页面结构（来自设计稿截图）

```
┌─────────────────────────────────────────────────┐
│  [本月] [上月] [本年]   [自定义日期范围（暂留空）]  │  ← 时间维度 chip，默认本月
│                                                   │
│  ── 业绩与实耗 ──────────────────────────────    │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │ 总业绩      小美客业绩  新增会员业绩  老会员业绩│   │
│  │ 40000.00   10000.00   10000.00   20000.00 │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ 总实耗      小美客项目实耗  新增会员实耗  老会员实耗│  │
│  │            10000.00     10000.00  20000.00 │  │
│  │ 40000.00   小美客产品出库  新增会员产品出库 老会员产品出库│  │
│  │            10000.00     3000.00   4000.00  │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  ── 业绩与品项 ──────────────────────────────    │
│  [按经营类型汇总]                                  │
│  [按一级品项汇总]                                  │
│  [按二级品项汇总]                                  │
└─────────────────────────────────────────────────┘
```

### 时间维度（专用口径）

| chip | period_start | period_end |
|------|-------------|------------|
| 本月 | 当月第 1 天 | 今天 |
| 上月 | 上月第 1 天 | 上月最后一天 |
| 本年 | 当年 1 月 1 日 | 今天 |

> 与 dashboard 首页（含"今日"）和排行榜（`date_trunc` 月度过滤）略有不同，销售数据页用 BETWEEN period_start AND period_end 写法。

### 指标来源（参见 metrics.md）

| 区域 | 指标 | metrics.md 节 |
|------|------|---------------|
| 总业绩 | `SUM(sale_orders.paid_amount)`，销售单+转换单+已支付 | 业绩 / 实耗 §业绩 |
| 小美客/新增会员/老会员业绩 | `SUM(sale_items.received)` + 顾客分型过滤 | 销售数据页 §分客型业绩 |
| 总实耗 | `SUM(service_items.unit_real_price * session_used)` | 业绩 / 实耗 §实耗 |
| 分客型项目实耗 | 同上 + 顾客分型过滤 | 销售数据页 §分客型项目实耗 |
| 分客型产品出库 | `SUM(sale_items.received)` WHERE product_kind='家居产品' + 分型 | 销售数据页 §分客型产品出库 |
| 三维品项汇总 | GROUP BY sales_category / product_kind / category_name | 品项维度汇总 |

### 顾客分型定义速查

| 分型 | 过滤 |
|------|------|
| 小美客 | `client_wechat_users.customer_type = '小美客'` |
| 新增会员 | `became_member_at::date BETWEEN period_start AND period_end` |
| 老会员 | `customer_type = '会员客' AND became_member_at < period_start` |

## 关键决策记录

### D1. 顾客分型使用当前快照

**决策**：`customer_type` / `became_member_at` 取 `client_wechat_users` 当前值，不追溯历史时点快照。

**理由**：`sale_orders` 无 `customer_type` 快照列；添加快照列需 schema 变更，开发阶段不值得。历史漂移量很小（小美客在订单发生后几天内就会升会员），实际影响可接受。

### D2. 产品出库 = 家居产品业绩行

**决策**：产品出库 = `sale_items.received` WHERE `product_categories.product_kind = '家居产品'`，时间轴 `paid_at`。

**理由**：
- "出库"在本业务场景 = "已付款的家居产品"（顾客取走即完成，无延迟出库流程）
- `pickup_records` 是疗程卡核销记录，与产品出库无关
- 与总业绩同口径（`paid_at`），方便管理者对比

**JOIN 代价**：需实时 JOIN `product_skus → product_categories` 获取 product_kind（无快照列），额外 2 个 JOIN，性能可接受。

### D3. 业绩总值用 paid_amount，分型用 received

**决策**：
- 总业绩 = `SUM(sale_orders.paid_amount)`（订单粒度）
- 分客型业绩 = `SUM(sale_items.received)`（item 粒度，允许按客户类型过滤）

**理由**：paid_amount 是订单层聚合，无法在行级做 customer_type 过滤；分型业绩需走 sale_items.received 才能精确到哪个顾客付了多少。两者理论上应相等（`SUM(received)` ≈ `paid_amount`），但三个分型之和 ≤ 总业绩（体验客/流量客的订单不计入任何分型）。

### D4. 品项汇总暂不做"按客型×品项交叉"

**决策**：三维品项汇总（经营类型/一级/二级）只显示全客型汇总，不与顾客分型交叉。

**理由**：交叉矩阵数据量大、展示空间有限；当前设计稿未显示交叉维度。如后续需要，另开 ticket。

### D5. 自定义日期范围预留空位，暂不实现

**决策**：设计稿右侧有一个日期范围输入框，本期 UI 留空位但不接入功能。

**理由**：chip 三维度已满足当前业务需求；自定义范围需额外 date picker 组件和接口参数变更，另开 ticket。

## 推荐执行顺序

1. **Day 1**：T1（接口 + 单元测试）
2. **Day 2**：T2（前端页面）+ 修改 mgmt-dashboard 的 `onEntryTap` 跳转逻辑

## 范围外（Follow-up）

- **自定义日期范围**：日期 picker 选择任意区间，另开 ticket
- **按客型×品项交叉矩阵**：另开 ticket
- **顾客分型历史时点快照**：在 sale_orders 添加 customer_type 快照列，另开 ticket
- **数据导出**：CSV 导出，另开 ticket
