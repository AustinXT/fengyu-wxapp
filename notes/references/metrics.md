# 统计指标定义表

> 所有业务统计指标的**唯一权威定义**。新增指标必须在此登记。
> 字段格式：`表名.列名`；筛选条件标准缩写见底部。

---

## 业绩 / 实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 业绩 | `SUM(paid_amount)` | `sale_orders.paid_amount` | `sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `[paid_at]` |
| 生美业绩 | `SUM(received)` | `sale_items.received` | JOIN sale_orders；`sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `is_shengmei=TRUE` ∩ `[paid_at]` |
| 实耗 | `SUM(unit_real_price * session_used)` | `service_items.unit_real_price` × `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `[service_date]` |
| 生美实耗 | `SUM(unit_real_price * session_used)` | 同上 | 加 `service_items.is_shengmei=TRUE` |

> **门店业绩 vs 生美业绩为何用不同口径**：paid_amount 是订单层（已含转换/回款抵消），不能按 sku 维度过滤生美；生美必须走 sale_items 行级 SUM(received)。

## 客流 / 客量 / 新会员

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流 | `COUNT(DISTINCT client_user_id)` | `service_orders.client_user_id` | `status='已完成'` ∩ `client_user_id IS NOT NULL` ∩ `[service_date]` |
| 客量 | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date]` |
| 新会员 | `COUNT(*)` | `client_wechat_users` | `old_member_level IS NULL` ∩ `member_level IS NOT NULL` ∩ `[member_level_upgraded_at]` |
| 项目数 | `SUM(session_used)` | `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `[service_date]` |

> **项目数为何只算「自销自耗 / 他销自耗」**：项目数衡量的是"本店实际承接的服务次数"。`他销他耗` / `生态合作` 属于跨店或合作机构消耗，不计入本店项目数；与提成口径一致。
> **快照依赖**：`service_items.sales_category` 须在 `service.create` 时从 `sale_items.sales_category` 拷贝（与 `is_shengmei` 同思路），避免 sku 后续修改导致历史漂移。见下方"快照字段依赖"表。

## 提成

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 销售提成收入（salesCommissionIncome） | `SUM(total_amount)` | `sale_allocations.total_amount` | JOIN sale_items + sale_orders；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `[paid_at]` |
| 服务提成收入（serviceCommissionIncome） | `SUM(commission_amount)` | `service_commissions.commission_amount` | JOIN service_items + service_orders；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ `status='已完成'` ∩ `[service_date]` |

> **为何 role_type 限定美容师/养生师**：管理层观察的是"产能员工"的人均产出；推广师虽享提成但人头不计入「员工数」（`skills && ARRAY['美容师','养生师']`），分子分母口径必须一致。
> **为何销售提成对齐"业绩"口径**：销售提成是业绩的下游分配，时间窗口与状态过滤一致便于"业绩 → 提成"对照分析；退款单 `total_amount` 为负数自动相互抵销，符合"净销售提成"语义。
> **为何服务提成对齐"实耗"口径**：服务提成（手工费 + 消耗提成）是实耗的下游分配，同理；`commission_amount` 已是 `fixed_fee + consume_amount` 之和，直接 SUM。
> **scope 走 JOIN 上游表**：`sale_allocations` / `service_commissions` 不直接持有 store_id，分别 JOIN `sale_items` → `sale_orders` / `service_items` → `service_orders` 拿 store_id 命中 scope 子查询。

## 门店状况 / 人效（截面快照，不随日历变化）

> **2026-04-25 起**：本节 4 项及其派生指标已规划历史化改造（详见 ticket 索引
> [`mgmt-dashboard-metrics-date-alignment.md`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)）。
> 改造完成前为实时快照，UI 区域有过渡角标提示。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 会员数（memberCount） | `COUNT(*)` | `client_wechat_users` | `customer_type='会员客'` ∩ scope（`bound_store_id`） |
| 保有会员数（retainedMemberCount） | `COUNT(DISTINCT so.client_user_id)` | `service_orders` JOIN `client_wechat_users` | `so.status='已完成'` ∩ `so.client_user_id IS NOT NULL` ∩ `so.service_date BETWEEN ($date - 90 days) AND $date` ∩ `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= $date` ∩ scope（`c.bound_store_id`） |
| 员工数（employeeCount） | `COUNT(*)` | `staff_wechat_users` | `is_resigned=FALSE` ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`） |

> **会员数 / 员工数**为"当前快照"，**不与日历日期挂钩**（结构性数据反映"看的时候的状态"，非"那一天的状态"）。
> 若产品后续要"那一天的会员数"，需另设审计字段（与 `old_member_level` 同思路），属另开 ticket 范围（T2/T3）。
>
> **保有会员数（2026-04-25 T5 起）已切「方案 B 实时计算」**：基于 `service_orders` 90 天窗口聚合 + `became_member_at` 守卫。
> - 不再读 `client_wechat_users.customer_status` 列（该列由 cronTask 每日重算，是当前快照，无法反映历史日期）。
> - 任意 `$date` 都可还原"那一天的保有会员数"，已与 `selectedDate` 对齐。
> - 业务规则简化：合并「保有会员-稳定」(visits_90d≥1 ∧ total_visits≥6) 与「保有会员-有效」(visits_90d≥1 ∧ total_visits≤5) 为合并态「保有会员」= `visits_90d ≥ 1`（mgmt-dashboard 当前不区分细分子类）。
> - 性能：30 店 × 800 单/月 × 60 月 ≈ 130 万行 service_orders，90 天窗口扫描 ~7.2 万行，P95 估 200-400ms（落在 mgmt-dashboard.summary 的 800ms slow warn 阈值内）。如 EXPLAIN ANALYZE 慢可追加部分索引 `idx_svc_orders_completed_date_client(service_date, client_user_id) WHERE status='已完成' AND client_user_id IS NOT NULL`。

## 派生指标

| 指标 | 公式 | 防除零 |
|------|------|--------|
| 月店均 | `本月数据 / scope 下 store 数量` （scope=单店时分母=1） | 分母=0 时返回 0 |
| 占比（memberRetainRate） | `retainedMemberCount / memberCount × 100%` | `memberCount=0 → '--'` |
| 店均会员（avgMembersPerStore） | `memberCount / storeCount` | `storeCount=0 → '--'` |
| 店均保有会员（avgRetainedPerStore） | `retainedMemberCount / storeCount` | 同上 |
| 人均会员数（avgMembersPerEmp） | `memberCount / employeeCount` | `employeeCount=0 → '--'` |
| 人均业绩 日/月 | `storeRevenue.today/.month / employeeCount` | 同上 |
| 人均生美业绩 日/月 | `shengmeiRevenue.today/.month / employeeCount` | 同上 |
| 人均实耗 日/月 | `storeConsume.today/.month / employeeCount` | 同上 |
| 人均生美实耗 日/月 | `shengmeiConsume.today/.month / employeeCount` | 同上 |
| 人均客流 日/月 | `footfall.today/.month / employeeCount` | 同上 |
| 人均客量 日/月 | `headcount.today/.month / employeeCount` | 同上 |
| 人均新客 日/月 | `newMembers.today/.month / employeeCount` | 同上 |
| 人均项目数 日/月 | `projectCount.today/.month / employeeCount` | `employeeCount=0 → '--'` |
| 人均提成收入 日/月 | `(salesCommissionIncome + serviceCommissionIncome).today/.month / employeeCount` | `employeeCount=0 → '--'` |

> 派生字段全部前端 `buildDisplay` 计算，不进接口；规避"加一个派生就改接口"的耦合。

---

## scope（市场/门店）过滤

| scope | sale_orders / sale_items / service_orders | client_wechat_users | staff_wechat_users |
|-------|------|------|------|
| 全部 | 不过滤 | 不过滤 | 不过滤 |
| 市场 | `store_id IN (SELECT s.store_id FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.parent_id=$market AND o.type='门店')` | 同左（列名 `bound_store_id`） | 同左（列名 `store_id`） |
| 门店 | `store_id = $store` | `bound_store_id = $store` | `store_id = $store` |

> **市场维度统一走 org_nodes 子查询，不用 `service_orders.market_name` 文本匹配**：org_nodes 是关系来源，市场改名不会让历史统计漂移。
> **提成两表无 store_id 列**：`sale_allocations` / `service_commissions` 不直接 scope，分别 JOIN `sale_items` → `sale_orders` / `service_items` → `service_orders` 后用其 store_id 命中 scope 子查询。

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
| `sale_items.sales_category` | order.create / createRepayment / createConversion / createRefund | `product_skus.sales_category`（转换/退款继承原销售行）|
| `service_items.is_shengmei` | service.create | `sale_items.is_shengmei` |
| `service_items.sales_category` | service.create | `sale_items.sales_category` |
| `client_wechat_users.old_member_level` | cronTask 升降级 SQL | 升级前的 `member_level` 值 |

---

## 数字格式化规则

| 类别 | 规则 | 示例 |
|------|------|------|
| 人数 / 计数 / 单数 | 整数 + 千分位 `,` | `12,000`、`4,000`、`600` |
| 金额（业绩 / 实耗 / 人均业绩 等） | 保留 2 位小数 + 千分位 `,` | `1,234,567.89`、`8,000.00` |
| 占比 | 保留 2 位小数 + `%` | `33.33%` |
| 防除零 / 数据缺失 | 一律 `--`（不显示 0） | — |

> 规则由 `fengyu-staff/miniprogram/utils/number.ts` 的 `formatAmount` / `formatCount` 实现。
> 已废弃旧"≥10000 折叠为 X.X 万"规则。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-04-25 | 初版：管理层数据中心首页 8 指标定义 |
| 2026-04-25 | 追加门店状况 3 项原始指标（会员/保有/员工）+ 11 项派生指标；新增 staff_wechat_users scope 行；新增数字格式化规则（废弃"万"折叠） |
| 2026-04-25 | 项目数定义落地：`SUM(service_items.session_used)` WHERE `sales_category IN ('自销自耗','他销自耗')` ∩ `status='已完成'`；新增 `service_items.sales_category` / `sale_items.sales_category` 快照依赖 |
| 2026-04-25 | 文案语义对齐（"今日/本月" → "当日/当月"）；门店状况/人效区追加过渡期角标；规划完整历史化（拆 5 子 ticket） |
| 2026-04-25 | 「销售提成收入 / 服务提成收入 / 人均提成收入」3 项指标定义；scope 走 JOIN sale_items / service_orders 拿 store_id |
| 2026-04-25 | T5 — 保有会员数切方案 B 实时计算：FROM service_orders 90 天窗口 + JOIN client_wechat_users + became_member_at 守卫；不再读 customer_status 列。已与 `selectedDate` 对齐 |
