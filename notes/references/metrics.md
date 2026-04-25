# 统计指标定义表

> 所有业务统计指标的**唯一权威定义**。新增指标必须在此登记。
> 字段格式：`表名.列名`；筛选条件标准缩写见底部。

---

## 业绩 / 实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 门店业绩 | `SUM(paid_amount)` | `sale_orders.paid_amount` | `sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `[paid_at]` |
| 生美业绩 | `SUM(received)` | `sale_items.received` | JOIN sale_orders；`sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `is_shengmei=TRUE` ∩ `[paid_at]` |
| 门店实耗 | `SUM(unit_real_price * session_used)` | `service_items.unit_real_price` × `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `[service_date]` |
| 生美实耗 | `SUM(unit_real_price * session_used)` | 同上 | 加 `service_items.is_shengmei=TRUE` |

> **门店业绩 vs 生美业绩为何用不同口径**：paid_amount 是订单层（已含转换/回款抵消），不能按 sku 维度过滤生美；生美必须走 sale_items 行级 SUM(received)。

## 客流 / 客量 / 新会员

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流 | `COUNT(DISTINCT client_user_id)` | `service_orders.client_user_id` | `status='已完成'` ∩ `client_user_id IS NOT NULL` ∩ `[service_date]` |
| 客量 | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date]` |
| 新会员 | `COUNT(*)` | `client_wechat_users` | `old_member_level IS NULL` ∩ `member_level IS NOT NULL` ∩ `[member_level_upgraded_at]` |
| 项目数 | _占位_ | _待定义_ | _待定义_ |

## 派生指标

| 指标 | 公式 |
|------|------|
| 月店均 | `本月数据 / scope 下 store 数量` （scope=单店时分母=1；分母=0 时返回 0） |

---

## scope（市场/门店）过滤

| scope | sale_orders / sale_items / service_orders | client_wechat_users |
|-------|------|------|
| 全部 | 不过滤 | 不过滤 |
| 市场 | `store_id IN (SELECT id FROM org_nodes WHERE type='store' AND parent_id=$market)` | `bound_store_id IN (...)` |
| 门店 | `store_id = $store` | `bound_store_id = $store` |

> **市场维度统一走 org_nodes 子查询，不用 `service_orders.market_name` 文本匹配**：org_nodes 是关系来源，市场改名不会让历史统计漂移。

## scope 下 store 数量

```sql
SELECT COUNT(*) FROM org_nodes WHERE type='store' [AND parent_id=$market]
-- 全部：不加 parent_id；市场：加；门店：恒为 1
```

---

## 时间窗口缩写约定

| 缩写 | 含义 |
|------|------|
| `[paid_at]` | 在所选日期/月份范围内（按 `paid_at::date`） |
| `[service_date]` | 在所选日期/月份范围内（按 `service_date`） |
| `[member_level_upgraded_at]` | 在所选日期/月份范围内（按 `member_level_upgraded_at::date`） |

- 「今日」= `col::date = $date`
- 「本月」= `date_trunc('month', col) = date_trunc('month', $date::date)`

---

## 快照字段依赖（写入时落地）

| 字段 | 写入路径 | 来源 |
|------|----------|------|
| `sale_items.is_shengmei` | order.create / createRepayment / createConversion / createRefund | `product_skus.is_shengmei`（转换/退款继承原销售行）|
| `service_items.is_shengmei` | service.create | `sale_items.is_shengmei` |
| `client_wechat_users.old_member_level` | cronTask 升降级 SQL | 升级前的 `member_level` 值 |

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-04-25 | 初版：管理层数据中心首页 8 指标定义 |
