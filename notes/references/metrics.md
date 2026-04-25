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
| 会员数（memberCount） | `COUNT(*)` | `client_wechat_users` | `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= $date` ∩ scope（`bound_store_id`）<br>_2026-04-25 T2 完成：从 `customer_type='会员客'`（实时快照）切到 `became_member_at` 时间戳（历史化）_ |
| 保有会员数（retainedMemberCount） | `COUNT(DISTINCT so.client_user_id)` | `service_orders` JOIN `client_wechat_users` | `so.status='已完成'` ∩ `so.client_user_id IS NOT NULL` ∩ `so.service_date BETWEEN ($date - 90 days) AND $date` ∩ `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= $date` ∩ scope（`c.bound_store_id`） |
| 员工数（employeeCount） | `COUNT(*)` | `staff_wechat_users` | `is_resigned=FALSE` ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`） |

> **会员数（2026-04-25 T2 起）已切「按 `selectedDate` 历史化」**：
> - `WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date <= $date`，任意 `$date` 都可还原"那一天的会员数"。
> - 跃迁路径：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（`recalcCustomerType`）+ `fengyu-client/cloudfunctions/payNotify/index.js`（重算路径）已与 `customer_type` 跃迁同事务写入 `became_member_at = NOW()`。
> - 历史回填：`db/scripts/backfill-became-member-at.js`（COALESCE `member_level_upgraded_at` / `updated_at` / `created_at` / `NOW()`），双库执行后 `customer_type='会员客' AND became_member_at IS NULL` 自检为 0。
>
> **员工数**仍为"当前快照"，不与日历日期挂钩（员工档案纵向变更频率低，T3 历史化待后续 ticket）。
>
> **保有会员数（2026-04-25 T5 起）已切「方案 B 实时计算」**：基于 `service_orders` 90 天窗口聚合 + `became_member_at` 守卫。
> - 不再读 `client_wechat_users.customer_status` 列（该列由 cronTask 每日重算，是当前快照，无法反映历史日期）。
> - 任意 `$date` 都可还原"那一天的保有会员数"，已与 `selectedDate` 对齐。
> - 业务规则简化：合并「保有会员-稳定」(visits_90d≥1 ∧ total_visits≥6) 与「保有会员-有效」(visits_90d≥1 ∧ total_visits≤5) 为合并态「保有会员」= `visits_90d ≥ 1`（mgmt-dashboard 当前不区分细分子类）。
> - 性能：30 店 × 800 单/月 × 60 月 ≈ 130 万行 service_orders，90 天窗口扫描 ~7.2 万行，P95 估 200-400ms（落在 mgmt-dashboard.summary 的 800ms slow warn 阈值内）。如 EXPLAIN ANALYZE 慢可追加部分索引 `idx_svc_orders_completed_date_client(service_date, client_user_id) WHERE status='已完成' AND client_user_id IS NOT NULL`。

## 客量数据子页（注册 / 客流 / 客活 / 经营 / 新会员）

> 入口：mgmt-dashboard 首页"客量数据"卡片；时间筛选只支持 **本月 / 上月 / 本年** 三档，
> 一律走"period 锚 NOW"语义（见上方"时间窗口缩写约定"），后端入参 `period: 'month' | 'lastMonth' | 'year'`。
> 区间解析：
> - `month`：`startDate = date_trunc('month', NOW())::date`，`endDate = NOW()::date`
> - `lastMonth`：`startDate = date_trunc('month', NOW() - INTERVAL '1 month')::date`，`endDate = (date_trunc('month', NOW()) - INTERVAL '1 day')::date`
> - `year`：`startDate = date_trunc('year', NOW())::date`，`endDate = NOW()::date`
>
> 全部按当前选中 scope（全部 / 市场 / 门店）应用 `client_wechat_users.bound_store_id` 过滤；
> 服务/订单类指标走对应表的 `store_id` scope（同首页规则）。

### 1. 注册情况（截面快照，截至 `endDate` 23:59:59）

> "注册"以 `client_wechat_users.created_at` 为准（含微信登录与 WorkFine 同步两条创建路径）。
> 4 项加和不一定等于"总注册数"——`customer_type` 历史只升不降，分类即为当前态。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 总注册数（regTotal） | `COUNT(*)` | `client_wechat_users` | `created_at <= endDate` ∩ scope（`bound_store_id`）|
| 仅注册用户（regOnly） | 同上 | 同上 | 加 `customer_type='流量客'` |
| 体验客（regTrial） | 同上 | 同上 | 加 `customer_type='体验客'` |
| 会员客（regMember） | 同上 | 同上 | 加 `customer_type='会员客'` |

> **小美客存量** 不在 UI 注册情况区显示，但同口径可由 `customer_type='小美客'` 派生。
> **历史化注意**：`created_at <= endDate` 仅是"截至该日期已存在"。`customer_type` 是当前快照，
> 不能反映"那一天此人是否已升级到 X"——属于和门店状况相同的快照漂移问题，与
> [`mgmt-dashboard-metrics-date-alignment`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)
> 同根，本期暂以快照口径出数 + 角标提示。

### 2. 到店客流数据（区间维度）

> 4 列：总 / 体验客 / 小美客 / 会员客；每列 3 行：客流量（次）/ 对应人数 / 项目数（扣卡次数）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流量（次）（trafficCount） | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date_period]` ∩ scope（`store_id`）；按 `client_wechat_users.customer_type` 分列 |
| 对应人数（trafficUsers） | `COUNT(DISTINCT client_user_id)` | 同上 | 同上 |
| 项目数 / 扣卡次数（trafficSessions） | `SUM(service_items.session_used)` | `service_items.session_used` | JOIN service_orders；条件同上；**不限定 `sales_category`**（与首页项目数口径不同，见下方说明） |

> **客流量 vs 客量**：本子页的"客流量（次）" = service_orders 行数，与首页的"客量"语义一致（均为单次）；
> "对应人数" = service_orders DISTINCT user，与首页的"客流"语义一致（均为人头）。
> **本子页项目数 ≠ 首页项目数**：首页限定 `sales_category IN ('自销自耗','他销自耗')`，
> 本页"扣卡次数"含全部销售类别（业务希望统计本店实际承接到的"扣卡动作总量"）。
> 决策点 D-trafficSessionsScope（见 ticket）：若产品要求与首页对齐，再加 `sales_category` 过滤。
> **customer_type 列归属**：以 `client_wechat_users.customer_type`（当前快照）为准；
> 同样存在历史漂移问题，与注册情况同议题。

### 3. 会员状态与客活（截面快照 + 区间客活）

> 状态来自 `client_wechat_users.customer_status`（cronTask 每日 03:00 重算；T0 修复后仅对会员客有值）。
> 区分"截面"与"区间"：5 项状态人数为截面快照；2 项客活与 3 项激活为区间统计。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 保有会员-稳定（retainedStable） | `COUNT(*)` | `client_wechat_users` | `customer_status='保有会员-稳定'` ∩ scope |
| 保有会员-有效（retainedActive） | 同上 | 同上 | `customer_status='保有会员-有效'` |
| 沉睡人数（dormantWarn） | 同上 | 同上 | `customer_status='预警沉睡'` ∩ `customer_type='会员客'` |
| 冰冻人数（dormantFrozen） | 同上 | 同上 | `customer_status='冰冻'` |
| 休眠人数（dormantDeep） | 同上 | 同上 | `customer_status='休眠'` |
| 一次客活（activeOnce） | `COUNT(*)` | `client_wechat_users` | `customer_status IN ('保有会员-稳定','保有会员-有效')` ∩ 区间内到店次数 = 1 ∩ scope |
| 二次客活（activeTwice） | 同上 | 同上 | 同上但区间内到店次数 ≥ 2 |
| 本月激活-沉睡（reactivatedFromWarn） | `COUNT(*)` | `client_wechat_users` + `service_orders` | 见下方"本月激活"决策点 |
| 本月激活-冰冻（reactivatedFromFrozen） | 同上 | 同上 | 同上 |
| 本月激活-休眠（reactivatedFromDeep） | 同上 | 同上 | 同上 |

**到店次数 SQL 模板（一次/二次客活共用）**：

```sql
WITH visit_count AS (
  SELECT so.client_user_id, COUNT(*) AS n
  FROM service_orders so
  WHERE so.status='已完成' AND so.client_user_id IS NOT NULL
    AND so.service_date BETWEEN $startDate AND $endDate
    AND <scope on so.store_id>
  GROUP BY so.client_user_id
)
SELECT COUNT(*) FROM visit_count vc
JOIN client_wechat_users c ON c.user_id = vc.client_user_id
WHERE c.customer_status IN ('保有会员-稳定','保有会员-有效')
  AND vc.n = 1   -- 一次客活；二次客活改 vc.n >= 2
  AND <scope on c.bound_store_id>
```

> **决策点 D-act-status-mapping**：UI 标签"沉睡人数"对应数据库枚举 `预警沉睡`（介于活跃与冰冻之间）。
> 三档命名 UI 用"沉睡 / 冰冻 / 休眠"，schema 用"预警沉睡 / 冰冻 / 休眠"。前端由 i18n / 文案层完成对照。
> **决策点 D-react-source（本月激活）**：当前 schema 无 `customer_status_changed_at`，无法直接算"本月内由 X→保有"的人数。
> 候选实现：
> - **A. 区间到店反推**（不新增字段）：取区间内有到店且 endDate 当日 `customer_status IN ('保有会员-稳定','保有会员-有效')` 的人，
>   分别按 `becameMemberAt` 之外是否曾持有"沉睡/冰冻/休眠"判断——但前态不可考，方案不严密。
> - **B. 引入 `customer_status_history` 审计表**：cronTask 每日重算前对状态变化行 INSERT。
>   工程量同 [`metrics-date-alignment T5 原方案 A`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)
>   （已被否决），但若本指标必须，需重启此方案。
> - **C. 实时反推**（推荐落地，与 T5 同策略）：
>   `区间内到店至少 1 次 ∩ 区间起始日（startDate-1）那天的 customer_status='预警沉睡'/'冰冻'/'休眠'`。
>   依赖 T5 完成后"按 $date 实时算 customer_status"能力。
>
> 本期上线方案：3 项激活值显示 `--` + 区域角标"等待 T5 历史化能力"，留待 T5 后填值（与首页快照过渡同节奏）。

### 4. 会员被经营情况（区间维度，仅 `customer_type='会员客'`）

> 6 个消费分桶 × 2 列（人数 / 消费金额）+ 1 项会员客单价。
> "消费金额"对齐 metrics.md 已有的【业绩】口径（订单层）：
> `paid_amount` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `[paid_at_period]`。

**底层会员消费聚合 CTE**（所有分桶共用）：

```sql
WITH member_spend AS (
  SELECT o.client_user_id,
         SUM(o.paid_amount) AS spend
  FROM sale_orders o
  JOIN client_wechat_users c ON c.user_id = o.client_user_id
  WHERE o.sale_order_type IN ('销售单','转换单')
    AND o.status = '已支付'
    AND o.paid_at::date BETWEEN $startDate AND $endDate
    AND c.customer_type = '会员客'
    AND <scope on o.store_id>
  GROUP BY o.client_user_id
)
```

| 指标 | 公式 | 数据源 |
|------|------|--------|
| 当期消费 < 1990（人数 / 金额） | `COUNT(*)` / `SUM(spend)` | `member_spend` WHERE `spend < 1990` |
| 当期消费 ≥ 1990（人数 / 金额） | 同上 | WHERE `spend >= 1990 AND spend < 10000` |
| 当期消费 ≥ 1w（人数 / 金额） | 同上 | WHERE `spend >= 10000 AND spend < 30000` |
| 当期消费 ≥ 3w（人数 / 金额） | 同上 | WHERE `spend >= 30000 AND spend < 60000` |
| 当期消费 ≥ 6w（人数 / 金额） | 同上 | WHERE `spend >= 60000 AND spend < 100000` |
| 当期消费 10w+（人数 / 金额） | 同上 | WHERE `spend >= 100000` |
| 会员客单价（memberAvgTicket） | `SUM(spend) / COUNT(*)` | 整个 `member_spend`；防除零 → `--` |

> **分桶为何左闭右开 `[1990, 1w)`、`[1w, 3w)` ……**：UI 标签是 `≥ 1990`、`≥ 1w` 等"门槛式"措辞，
> 业务希望"每个客户落到唯一一个桶"。若改为"≥ 1990"含 ≥ 1w 客户，会重复计数 → 与"按桶相加 = 总数"的看板心智不符。
> 对照 `client_wechat_users.spending_tier` 枚举（`<1990 / 1990-1W / 1-3W / 3-6W / 6-10W / 10W+`）顺序一致。
> **不复用 `spending_tier` 列**：`spending_tier` 是"历史累计消费档"快照，cronTask 每日重算，
> 与"区间内消费分桶"语义不同（前者是 lifetime，后者是窗口）。
> **分母会员客的时态**：以 `customer_type` 当前快照 = '会员客' 为准（与"会员状态"区共用），
> 不要求"消费时刻就是会员客"。开发期暂行；阶段 2 历史化后再讨论是否切换。

### 5. 新会员经营（区间维度）

> 时段内"首次成为会员客"的人群及其经营数据。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 新增会员数（newMemberCount） | `COUNT(*)` | `client_wechat_users` | `became_member_at::date BETWEEN $startDate AND $endDate` ∩ scope（`bound_store_id`） |
| 新增会员对应消费（newMemberSpend） | `SUM(o.paid_amount)` | `sale_orders` | JOIN 上面的新增会员；`sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `paid_at::date BETWEEN $startDate AND $endDate` ∩ scope（`store_id`） |
| 新增会员客单价（newMemberAvgTicket） | `newMemberSpend / newMemberCount` | 派生；防除零 → `--` |
| 新增会员成交率（newMemberConvRate） | `newMemberCount / trialFootfall × 100%` | 派生；防除零 → `--` |

**新增会员成交率分母（trialFootfall）**：

```sql
SELECT COUNT(DISTINCT so.client_user_id)
FROM service_orders so
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE so.status='已完成'
  AND so.service_date BETWEEN $startDate AND $endDate
  AND c.customer_type IN ('体验客','小美客')   -- 决策点 D-conv-denom
  AND <scope on so.store_id>
```

> **决策点 D-conv-denom（成交率分母）**：候选三方案——
> - **A. 区间内到店的体验客**（仅 `customer_type='体验客'`）：与"体验 → 会员"链路对齐，但小美客被排除。
> - **B. 区间内到店的体验客 + 小美客**（推荐落地）：覆盖完整"未成会员的活跃客户"池，
>   与 `recalcCustomerType` 当前升级链路（流量客 → 体验客 → 小美客 → 会员客）匹配，
>   分母含义 ≈ "区间内有到店但未达会员"的活跃池。
> - **C. 区间内到店的所有非会员客**（含 `流量客`）：流量客占比小且通常无 service_orders，
>   与 B 差异极小，不必单设。
> 本期默认 B；若业务方坚持 A，前后端各调一处过滤即可。
> **分子分母 store_id 来源不同**：分子用 `client_wechat_users.bound_store_id` 算 scope，
> 分母用 `service_orders.store_id` 算 scope。两者通常一致（顾客在绑定店产生服务），
> 但跨店服务时会形成微小漂移；接受当前精度。

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
| `[paid_at_period]` | 按 period 维度命中（`month` / `lastMonth` / `year`，锚点 `NOW()`） |
| `[service_date_period]` | 同上 |
| `[member_level_upgraded_at_period]` | 同上 |

- 「今日」= `col::date = $date`
- 「本月」= `date_trunc('month', col) = date_trunc('month', $date::date)`
- 「本月（period 锚 NOW）」= `date_trunc('month', col) = date_trunc('month', NOW()::date)`
- 「上月（period 锚 NOW）」= `date_trunc('month', col) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
- 「本年（period 锚 NOW）」= `date_trunc('year', col) = date_trunc('year', NOW()::date)`

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
| 2026-04-25 | T2 — 会员数切按 `selectedDate` 历史化：`COUNT(*) WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date <= $date`，不再依赖 `customer_type='会员客'` 实时快照。跃迁路径（`recalcCustomerType` / `payNotify` 重算）已与 `customer_type` 同事务写入 `became_member_at`；新增 `db/scripts/backfill-became-member-at.js` 双库回填并自检 0 |
| 2026-04-25 | 追加 period 时间窗口缩写（month/lastMonth/year，锚 `NOW()`）；为 `mgmtDashboard.storeRanking` 接口服务 |
| 2026-04-25 | 客量数据子页 5 大类指标定义（注册情况 4 项 + 到店客流 12 项 + 会员状态与客活 10 项 + 会员被经营 13 项 + 新会员经营 4 项 = 43 项）；3 个待业务确认决策点（D-trafficSessionsScope / D-react-source / D-conv-denom）；详见 ticket [`mgmt-traffic-stats-page`](../tickets/2026-04-25-mgmt-traffic-stats-page.md) |

---

## 销售数据页 — 分客型业绩 / 实耗 / 产品出库

> 时间轴：业绩/产品出库 按 `paid_at`；实耗 按 `service_date`。
> 时间口径：本月/本年截止今天，上月截止上月最后一天（见下方时间窗口补充）。

### 顾客分型过滤定义

| 分型 | 过滤条件 | JOIN 路径 |
|------|---------|-----------|
| 小美客 | `c.customer_type = '小美客'` | `sale_orders so JOIN client_wechat_users c ON c.client_user_id = so.client_user_id` |
| 新增会员 | `c.became_member_at::date BETWEEN [period_start] AND [period_end]` | 同上（实耗改 `service_orders so JOIN client_wechat_users c`） |
| 老会员 | `c.customer_type = '会员客' AND c.became_member_at::date < [period_start]` | 同上 |

> **口径说明**：顾客分型使用 `client_wechat_users` 当前快照（无订单时点快照列），客型可能在历史订单发生后发生迁移，属已知偏差；开发阶段可接受。三类型之和不等于总业绩（体验客/流量客订单不计入任何分型），总业绩仍沿用已有定义。

### 分客型业绩

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客业绩 | `SUM(si.received)` | `sale_items si` JOIN `sale_orders so` JOIN `client_wechat_users c ON c.client_user_id = so.client_user_id` | 分型:小美客 ∩ `so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[paid_at_period]` |
| 新增会员业绩 | `SUM(si.received)` | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员业绩 | `SUM(si.received)` | 同上 | 分型:老会员 ∩ 同上 |

### 分客型项目实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客项目实耗 | `SUM(sit.unit_real_price * sit.session_used)` | `service_items sit` JOIN `service_orders so` JOIN `client_wechat_users c ON c.client_user_id = so.client_user_id` | 分型:小美客 ∩ `so.status='已完成'` ∩ `[service_date_period]` |
| 新增会员实耗 | 同上 | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员实耗 | 同上 | 同上 | 分型:老会员 ∩ 同上 |

### 分客型产品出库

> **产品出库定义**：`SUM(si.received)` where `pc.product_kind = '家居产品'`，时间轴 `paid_at`。
> JOIN 链：`sale_items si → product_skus sk (ON si.sku_id = sk.sku_id) → product_categories pc (ON sk.category_id = pc.category_id)`。
> `sale_items` 无 `product_kind` 快照列，需实时 JOIN。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客产品出库 | `SUM(si.received)` | `sale_items si` JOIN `sale_orders so` JOIN `product_skus sk` JOIN `product_categories pc` JOIN `client_wechat_users c` | `pc.product_kind='家居产品'` ∩ 分型:小美客 ∩ `so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[paid_at_period]` |
| 新增会员产品出库 | 同上 | 同上 | 同上，分型:新增会员 |
| 老会员产品出库 | 同上 | 同上 | 同上，分型:老会员 |

---

## 品项维度汇总（销售数据页）

> 公式：`SUM(si.received)`，时间轴 `paid_at`，基础过滤：`so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[paid_at_period]`。
> 一/二级品项 JOIN 链：`sale_items si → sale_orders so → product_skus sk (ON si.sku_id=sk.sku_id) → product_categories pc (ON sk.category_id=pc.category_id)`。

| 维度 | 分组依据 | 字段 | 说明 |
|------|---------|------|------|
| 经营类型汇总 | `si.sales_category` | `sale_items.sales_category`（快照列，无需 JOIN） | 4 值：自销自耗/他销自耗/他销他耗/生态合作 |
| 一级品项汇总 | `pc.product_kind` | `product_categories.product_kind` | 4 值：护理项目/家居产品/充值卡/体验卡 |
| 二级品项汇总 | `pc.category_name` | `product_categories.category_name` | 平面结构（无 parent_id），品项分类名 |

> scope 过滤通过 `so.store_id` 命中（同其他业绩指标）。

---

## 时间窗口补充（sales-data 页专用口径）

| 维度 | period_start | period_end |
|------|-------------|------------|
| 本月 | `date_trunc('month', NOW()::date)` | `NOW()::date` |
| 上月 | `date_trunc('month', NOW()::date - INTERVAL '1 month')` | `date_trunc('month', NOW()::date) - INTERVAL '1 day'` |
| 本年 | `date_trunc('year', NOW()::date)` | `NOW()::date` |

> 过滤写法：`col::date BETWEEN [period_start] AND [period_end]`
