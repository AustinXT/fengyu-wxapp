# 统计指标定义表

> 所有业务统计指标的**唯一权威定义**。新增指标必须在此登记。
> 字段格式：`表名.列名`；筛选条件标准缩写见底部。
> **术语备注**：以下指标定义中出现的 `product_type='院装产品'` 字面量已于 2026-04-25 在 PG enum 中重命名为 `'家居产品'`，业务口径与代码同步。

---

## 业绩 / 实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 业绩（门店 / 市场 / 总部） | `SUM(spe.amount)` | `sale_order_performance_events spe` | `spe.status='已支付'` ∩ `spe.change_type IN ('首次支付','回款','退款')` ∩ `spe.sale_order_type IN ('销售单','转换单','充值单')` ∩ `spe.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[spe.performance_date]` |
| 生美业绩 | `SUM(sipe.amount)` | `sale_item_performance_events sipe` | JOIN sale_items + sale_orders；`sale_order_type IN ('销售单','转换单')` ∩ `status='已支付'` ∩ `is_shengmei=TRUE` ∩ `[sipe.performance_date]` |
| 实耗 | `SUM(unit_real_price * session_used)` | `service_items.unit_real_price` × `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `[service_date]` |
| 生美实耗 | `SUM(unit_real_price * session_used)` | 同上 | 加 `service_items.is_shengmei=TRUE` |

> **组织层级业绩的归属规则**：只统计状态为“已支付”的首次支付、回款和退款；`储值卡抵扣`不属于组织现金业绩，必须排除。首次支付的 `performance_date` 取订单 `performance_attribution_date`；回款/退款取自身 `paid_at` 的上海自然日。退款 `amount` 为负数，不回溯原订单归属日。不得用父订单 `status` 过滤，因此部分支付订单已到账的付款也计入。
>
> **订单日期与归属日期**：`performance_attribution_date` 默认等于原始订单的上海自然日。原始 `sale_order_datetime` 始终保留。有权人员可不受操作时间限制地调整一次，但新日期必须在原始订单日前后 7 天内（含）。
>
> **组织层级业绩 vs 生美 / 品项 / 员工归属为何不同**：现金流无法可靠拆到 SKU 或员工。生美业绩、品项统计、员工业绩和员工提成继续使用各自既有的订单/分配口径；充值现金只进入组织层级总业绩和分客型业绩，不进入生美或品项分类。

## 客流 / 客量 / 新会员

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流 | `COUNT(DISTINCT client_user_id)` | `service_orders.client_user_id` | `status='已完成'` ∩ `client_user_id IS NOT NULL` ∩ `[service_date]` |
| 客量 | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date]` |
| 新会员 | `COUNT(*)` | `client_wechat_users` | `became_member_at IS NOT NULL` ∩ `[became_member_at]` |
| 项目数 | `SUM(session_used)` | `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `[service_date]` |

> **项目数为何只算「自销自耗 / 他销自耗」**：项目数衡量的是"本店实际承接的服务次数"。`他销他耗` / `生态合作` 属于跨店或合作机构消耗，不计入本店项目数；与提成口径一致。
> **快照依赖**：`service_items.sales_category` 须在 `service.create` 时从 `sale_items.sales_category` 拷贝（与 `is_shengmei` 同思路），避免 sku 后续修改导致历史漂移。见下方"快照字段依赖"表。
> **新会员判定字段（2026-04-25 修正）**：从 `old_member_level IS NULL ∧ member_level IS NOT NULL ∩ [member_level_upgraded_at]` 切到 `became_member_at IS NOT NULL ∩ [became_member_at]`。原口径含等级跃迁（初钻→星钻 等任意 member_level 变更），与"首次成会员"语义偏离；`became_member_at` 与 `customer_type='会员客'` 跃迁严格同步维护，是"首次成为会员客时间戳"的权威字段。

## 提成

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 销售提成收入（salesCommissionIncome） | `SUM(spia.commission_amount)` | `sale_payment_item_allocations spia` | JOIN receipt + sale item/order + `sale_order_performance_events`；`is_void=FALSE` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `spe.status='已支付'` ∩ `[spe.performance_date]` |
| 服务提成收入（serviceCommissionIncome） | `SUM(commission_amount)` | `service_commissions.commission_amount` | JOIN service_items + service_orders；`role_type IN ('美容师','养生师')` ∩ `is_void=FALSE` ∩ `status='已完成'` ∩ `[service_date]` |

> **为何 role_type 限定美容师/养生师**：管理层观察的是"产能员工"的人均产出；推广师虽享提成但人头不计入「员工数」（`skills && ARRAY['美容师','养生师']`），分子分母口径必须一致。
> **销售提成是例外口径**：销售提成按员工分配流水归属，不随组织层级现金流业绩切换；它保留既有的销售单/转换单和分配规则，便于追踪员工应得提成。
> **为何服务提成对齐"实耗"口径**：服务提成（手工费 + 消耗提成）是实耗的下游分配，同理；`commission_amount` 已是 `fixed_fee + consume_amount` 之和，直接 SUM。
> **scope 走 JOIN 上游表**：`sale_allocations` / `service_commissions` 不直接持有 store_id，分别 JOIN `sale_items` → `sale_orders` / `service_items` → `service_orders` 拿 store_id 命中 scope 子查询。

## 员工排行榜归属

> 用于 `mgmtDashboard.staffRanking` 接口的归属字段约定（设计稿见 ticket [`mgmt-staff-ranking-INDEX`](../tickets/2026-04-25-mgmt-staff-ranking-INDEX.md)）。
> 时间锚点固定为 `NOW()`，period ∈ `month` / `lastMonth` / `year`（与门店排行榜一致，复用 `[paid_at_period]` / `[service_date_period]` / `[became_member_at_period]` 缩写）。

| 指标（员工层） | 公式 | 归属字段 | 时间窗口 | 备注 |
|------|------|---------|---------|------|
| 业绩 | `SUM(spia.allocated_amount)` | `sale_payment_item_allocations.employee_id` | `[spe.performance_date_period]` | JOIN receipt + `sale_order_performance_events`；`is_void=FALSE` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `spe.status='已支付'` |
| 实耗 | `SUM(service_items.unit_real_price * service_items.session_used)` | `service_items.employee_id` | `[service_date_period]` | `service_orders.status='已完成'` |
| 客流 | `COUNT(DISTINCT service_orders.client_user_id)` | `service_items.employee_id` | `[service_date_period]` | 员工内去重，跨员工不去重；`status='已完成'` ∩ `client_user_id IS NOT NULL` |
| 项目数 | `SUM(service_items.session_used)` | `service_items.employee_id` | `[service_date_period]` | `sales_category IN ('自销自耗','他销自耗')` ∩ `status='已完成'` |
| 新会员 | `COUNT(*)` | `client_wechat_users.bound_employee_id` | `[became_member_at_period]` | `became_member_at IS NOT NULL`；`bound_employee_id IS NULL` 的新会员不归属任何员工（与"无归属新会员"差额由监控关注） |
| 收入 | 销售提成 + 服务提成 | 销售=`sale_payment_item_allocations.employee_id`；服务=`service_commissions.employee_id` | 销售按 `[spe.performance_date_period]`；服务按 `[service_date_period]` | `is_void=FALSE`；销售使用 `commission_amount`；服务使用 `service_commissions.commission_amount` |

> **业绩 vs 收入区别**：业绩仅含销售部分（`sale_allocations`）；收入 = 销售 + 服务提成（`service_commissions`）。两者销售部分公式相同；收入因加服务提成而 ≥ 业绩。
>
> **产能员工范围**（`staff_wechat_users`）：`hired_at IS NOT NULL ∩ hired_at::date <= NOW()::date ∩ (resigned_at IS NULL OR resigned_at::date > NOW()::date) ∩ skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`）。锚点为 **NOW()**（员工排行榜本就是"当前在职产能员工"的 period 业绩，不随 selectedDate 历史化；与 employeeCount selectedDate 历史化口径**字段一致但锚点不同**）。
> 排行榜不含推广师（无产能技能）和管理者（虽可能 skills 命中但通常实际开单/服务记录少），与人均口径分母对齐。
> `is_resigned` 列在 staffApi 查询路径已退役（仅保留作档案当前态冗余字段），与 §"门店状况" T3 决议一致。
>
> **范围外**：员工无"保有会员"指标（保有会员是顾客状态，归属门店）；员工独有"收入"指标（销售提成 + 服务提成合计），门店层无对应。

## 门店状况 / 人效（按 `selectedDate` 历史化）

> **2026-04-25 起**：本节 4 项原始指标（会员数 / 保有会员 / 员工数 / 门店数）已全部完成历史化改造，
> 任意 `$date` 都可还原"那一天的状态值"（详见 ticket [`mgmt-dashboard-metrics-date-alignment.md`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)）。
> 完成项：T2 会员数 / T3 员工数 / T4 门店数 / T5 保有会员 / **T6 派生指标分母切换（双口径 day/month）**。阶段 1 过渡角标已移除。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 会员数（memberCount） | `COUNT(*)` | `client_wechat_users` | `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= $date` ∩ scope（`bound_store_id`）<br>_2026-04-25 T2 完成：从 `customer_type='会员客'`（实时快照）切到 `became_member_at` 时间戳（历史化）_ |
| 保有会员数（retainedMemberCount） | `COUNT(DISTINCT so.client_user_id)` | `service_orders` JOIN `client_wechat_users` | `so.status='已完成'` ∩ `so.client_user_id IS NOT NULL` ∩ `so.service_date BETWEEN ($date - 90 days) AND $date` ∩ `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= $date` ∩ scope（`c.bound_store_id`） |
| 员工数（employeeCount） | `COUNT(*)` | `staff_wechat_users` | `s.hired_at IS NOT NULL` ∩ `s.hired_at::date <= $date` ∩ (`s.resigned_at IS NULL` OR `s.resigned_at::date > $date`) ∩ `skills && ARRAY['美容师','养生师']` ∩ scope（`store_id`）<br>_2026-04-25 T3 完成：从 `is_resigned=FALSE`（实时快照）切到 `hired_at`/`resigned_at` 时间戳（历史化）_ |
| 门店数（storeCount） | `COUNT(*)` | `stores` JOIN `org_nodes` | `o.type='门店'` ∩ `o.is_active=TRUE` ∩ `s.opening_date IS NOT NULL` ∩ `s.opening_date::date <= $date` ∩ (`s.closed_at IS NULL` OR `s.closed_at::date > $date`) ∩ scope<br>_当前组织节点启用状态作用于全部历史区间；停用门店即使单店直达也计 0_ |

> **会员数（2026-04-25 T2 起）已切「按 `selectedDate` 历史化」**：
> - `WHERE c.became_member_at IS NOT NULL AND c.became_member_at::date <= $date`，任意 `$date` 都可还原"那一天的会员数"。
> - 跃迁路径：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（`recalcCustomerType`）+ `fengyu-client/cloudfunctions/payNotify/index.js`（重算路径）已与 `customer_type` 跃迁同事务写入 `became_member_at = NOW()`。
> - 历史回填：`db/scripts/backfill-became-member-at.js`（COALESCE `member_level_upgraded_at` / `updated_at` / `created_at` / `NOW()`），双库执行后 `customer_type='会员客' AND became_member_at IS NULL` 自检为 0。
>
> **员工数（2026-04-25 T3 起）已切「按 `selectedDate` 历史化」**：
> - `WHERE s.hired_at IS NOT NULL AND s.hired_at::date <= $date AND (s.resigned_at IS NULL OR s.resigned_at::date > $date)`，任意 `$date` 都可还原"那一天在职的员工数"。
> - 字段维护：admin 员工管理表单写入 `hired_at` / `resigned_at`（migration 0012 已部署 5433 + 5434 双库）；当前 `hired_at` 由 `created_at::date` 兜底（WorkFine 无入职日期源），`resigned_at` 由 `updated_at::date` 兜底。后续档案由管理后台维护。
> - `is_resigned` 列保留作为冗余的当前态字段，不再参与查询过滤。
>
> **门店数（2026-04-25 T4 起）已切「按 `selectedDate` 历史化」**：
> - `FROM stores s JOIN org_nodes o ON s.org_node_id = o.id WHERE o.type='门店' AND o.is_active=TRUE AND s.opening_date IS NOT NULL AND s.opening_date::date <= $date AND (s.closed_at IS NULL OR s.closed_at::date > $date)`，任意 `$date` 都可还原"那一天在营的门店数"。
> - `org_nodes.is_active` 没有历史时间轴，按当前状态过滤全部历史区间；`scopeType=store` 也执行真实计数，停用门店返回 0；`scopeType=market` 通过市场后代门店集合过滤。
> - 字段维护：admin 门店管理表单写入 `opening_date` / `closed_at`（migration 0012 已部署 5433 + 5434 双库）；`is_closed` 列保留作为冗余的当前态字段。
>
> **保有会员数（2026-04-25 T5 起）已切「方案 B 实时计算」**：基于 `service_orders` 90 天窗口聚合 + `became_member_at` 守卫。
> - 不再读 `client_wechat_users.customer_status` 列（该列由 cronTask 每日重算，是当前快照，无法反映历史日期）。
> - 任意 `$date` 都可还原"那一天的保有会员数"，已与 `selectedDate` 对齐。
> - 业务规则简化：合并「保有会员-稳定」(visits_90d≥1 ∧ total_visits≥6) 与「保有会员-有效」(visits_90d≥1 ∧ total_visits≤5) 为合并态「保有会员」= `visits_90d ≥ 1`（mgmt-dashboard 当前不区分细分子类）。
> - 性能：30 店 × 800 单/月 × 60 月 ≈ 130 万行 service_orders，90 天窗口扫描 ~7.2 万行，P95 估 200-400ms（落在 mgmt-dashboard.summary 的 800ms slow warn 阈值内）。如 EXPLAIN ANALYZE 慢可追加部分索引 `idx_svc_orders_completed_date_client(service_date, client_user_id) WHERE status='已完成' AND client_user_id IS NOT NULL`。
> - **子页 mgmt-traffic 仍读 customer_status 列**（5 档细分需要 total_visits 预聚合，cron 跑一次比每次请求都跑划算），与本指标口径同根但锚点不同（cron 03:00 vs NOW），详见 §3 注脚。

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
| 会员客（regMember） | `COUNT(*)` | `client_wechat_users` | `c.became_member_at IS NOT NULL` ∩ `c.became_member_at::date <= endDate` ∩ scope（`bound_store_id`）<br>_2026-04-25 起切到与 mgmt-dashboard.summary.memberCount 对齐口径，仅时间锚不同（period endDate vs $date 参数）_ |

> **小美客存量** 不在 UI 注册情况区显示，但同口径可由 `customer_type='小美客'` 派生。
> **历史化注意**：`created_at <= endDate` 仅是"截至该日期已存在"。`customer_type` 是当前快照，
> 不能反映"那一天此人是否已升级到 X"——属于和门店状况相同的快照漂移问题，与
> [`mgmt-dashboard-metrics-date-alignment`](../tickets/2026-04-25-mgmt-dashboard-metrics-date-alignment.md)
> 同根，本期暂以快照口径出数 + 角标提示。
> **regMember 例外（2026-04-25 起）**：会员客已切 `became_member_at::date <= endDate`，与首页 memberCount 严格对齐；
> regOnly/regTrial/regTotal 仍为 `customer_type` 当前快照 + `created_at <= endDate`，本期不切——流量客/体验客是非终态，
> 业务方对其历史化诉求弱；如有需要可后续新增 `became_trial_at` / `became_xiaomei_at` 时间戳字段统一切换。

### 2. 到店客流数据（区间维度）

> 4 列：总 / 体验客 / 小美客 / 会员客；每列 3 行：客流量（次）/ 对应人数 / 项目数（扣卡次数）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流量（次）（trafficCount） | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date_period]` ∩ scope（`store_id`）；按 `client_wechat_users.customer_type` 分列 |
| 对应人数（trafficUsers） | `COUNT(DISTINCT client_user_id)` | 同上 | 同上 |
| 项目数 / 扣卡次数（trafficSessions） | `SUM(service_items.session_used)` | `service_items.session_used` | JOIN service_orders；条件同上 ∩ `service_items.sales_category IN ('自销自耗','他销自耗')`（与首页项目数口径对齐）|

> **客流量 vs 客量**：本子页的"客流量（次）" = service_orders 行数，与首页的"客量"语义一致（均为单次）；
> "对应人数" = service_orders DISTINCT user，与首页的"客流"语义一致（均为人头）。
> **项目数与首页对齐**（2026-04-25 决策 D-trafficSessionsScope=B）：
> 限定 `sales_category IN ('自销自耗','他销自耗')`，跨店或合作机构消耗（`他销他耗` / `生态合作`）不计入；
> 与首页"项目数"指标完全等价，避免业务方在首页与子页之间看到两个不同的"项目数"。
> **customer_type 列归属**：以 `client_wechat_users.customer_type`（当前快照）为准；
> 同样存在历史漂移问题，与注册情况同议题。

### 3. 会员状态与客活（截面快照 + 区间客活）

> 状态来自 `client_wechat_users.customer_status`（cronTask 每日 03:00 重算；T0 修复后仅对会员客有值）。
> 区分"截面"与"区间"：5 项状态人数为截面快照；2 项客活与 3 项激活为区间统计。
>
> **与首页 retainedMemberCount 的关系**：retainedStable + retainedActive 在 cronTask 跑完后等价于首页 retainedMemberCount
> （两者均等于 `visits_90d ≥ 1` ∩ `became_member_at <= 锚点`）。存在最大 24 小时滞后（cron 03:00 跑日级聚合 vs 主页 NOW() 实时聚合）。
> 如差距远大于一天的新增到店量，请排查 cronTask 日志。本子页 5 档细分仍读 customer_status 列（因 5 档需要 total_visits
> 预聚合，cron 跑一次比每次请求都跑划算）；首页只要合并态 `visits_90d ≥ 1`，适合实时聚合。两者口径同根、锚点不同。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 保有会员-稳定（retainedStable） | `COUNT(*)` | `client_wechat_users` | `customer_status='保有会员-稳定'` ∩ scope |
| 保有会员-有效（retainedActive） | 同上 | 同上 | `customer_status='保有会员-有效'` |
| 沉睡人数（dormantWarn） | 同上 | 同上 | `customer_status='沉睡'` ∩ `customer_type='会员客'`<br>_2026-04-25 决策 D-6=B：schema 枚举已重命名 `'预警沉睡'`→`'沉睡'`（migration 0013），详见 ticket [`customer-status-rename-warn`](../tickets/2026-04-25-customer-status-rename-warn.md)_ |
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

> **D-act-status-mapping（已决 D-6=B）**：UI"沉睡 / 冰冻 / 休眠" 与 schema "沉睡 / 冰冻 / 休眠" 命名对齐。
> schema 枚举已通过 migration 0013 完成 `'预警沉睡'`→`'沉睡'` 重命名（独立 ticket [`customer-status-rename-warn`](../tickets/2026-04-25-customer-status-rename-warn.md)）；本表所有字面量已同步使用 `'沉睡'`。
>
> **D-react-source（已决 D-1=C，实时反推）**：与 T5 同思路（90 天到店窗口聚合），以 `anchor = startDate - 1` 天展开 customer_status 计算。
> T5 已上线但未抽公共函数；本指标在 SQL 内自包含展开 anchor 日的 5 档判定。
>
> **核心逻辑（以"本月激活-沉睡"为例，其余两档替换 anchor 状态判定子句）**：
>
> ```sql
> WITH visited_in_period AS (
>   SELECT DISTINCT so.client_user_id
>   FROM service_orders so
>   WHERE so.status='已完成' AND so.client_user_id IS NOT NULL
>     AND so.service_date BETWEEN $startDate AND $endDate
>     AND <scope on so.store_id>
> ),
> anchor_stats AS (   -- anchor=startDate-1 当日的到店历史聚合（T5 同思路）
>   SELECT
>     c.user_id,
>     MAX(so.service_date) AS last_dt,
>     COUNT(*) FILTER (
>       WHERE so.service_date BETWEEN ($startDate::date - 1 - INTERVAL '90 days')::date
>                                 AND $startDate::date - 1
>     ) AS visits_90d_prev
>   FROM client_wechat_users c
>   LEFT JOIN service_orders so
>     ON so.client_user_id = c.user_id
>    AND so.status = '已完成'
>    AND so.service_date <= $startDate::date - 1
>   WHERE c.became_member_at IS NOT NULL
>     AND c.became_member_at::date <= $startDate::date - 1
>   GROUP BY c.user_id
> )
> SELECT COUNT(*)
> FROM visited_in_period v
> JOIN anchor_stats a ON a.user_id = v.client_user_id
> JOIN client_wechat_users c ON c.user_id = v.client_user_id
> WHERE a.visits_90d_prev = 0                                                       -- anchor 非保有
>   AND a.last_dt IS NOT NULL
>   AND a.last_dt >= ($startDate::date - 1 - INTERVAL '6 months')::date             -- anchor 沉睡
>   AND <scope on c.bound_store_id>
> -- 冰冻：把 last_dt 区间换为 [($startDate-1 - 12m), ($startDate-1 - 6m))
> -- 休眠：a.last_dt < ($startDate-1 - 12m) OR a.last_dt IS NULL
> ```
>
> **复用提示**：建议把 `anchor_stats` 提炼为后端 `mgmt-dashboard.js` / `mgmt-traffic.js` 的共享 SQL helper，避免与 T5 的 retainedMember 子查询重复维护到店历史聚合逻辑。
> **D-6 落地耦合**：本月激活 3 档采用 anchor 直接计算（用 `last_dt` 区间，不读 `customer_status` 列字面量），D-6 重命名只影响 i18n 层不影响本 SQL。

### 4. 会员被经营情况（区间维度，仅 `customer_type='会员客'`）

> 6 个消费分桶 × 2 列（人数 / 消费金额）+ 1 项会员客单价。
> "消费金额"是会员被经营情况的订单层历史消费指标，不等同于本页定义的组织层级现金流业绩；本节保留既有订单口径：
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
> **D-4（已决 D-4=A）会员客时态**：分母会员客以 `customer_type` 当前快照 = '会员客' 为准（与"会员状态"区共用），
> 不要求"消费时刻就是会员客"。T2 历史化（按 `becameMemberAt::date <= endDate` 判定）落地后，本指标同步切换。

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
  AND c.customer_type IN ('体验客','小美客')   -- 已决 D-conv-denom=B
  AND <scope on so.store_id>
```

> **D-conv-denom（已决 D-2=B）**：分母 = 区间内到店的"体验客 + 小美客"。
> 与 `recalcCustomerType` 升级链路（流量客 → 体验客 → 小美客 → 会员客）完全对齐；
> 分母含义 = "区间内有到店但未达会员"的活跃池。
> **分子分母 store_id 来源不同**：分子用 `client_wechat_users.bound_store_id` 算 scope，
> 分母用 `service_orders.store_id` 算 scope。两者通常一致（顾客在绑定店产生服务），
> 但跨店服务时会形成微小漂移；接受当前精度。
> **D-newMemberSpend（已决 D-3=A）**：分子 `newMemberSpend` = 这群新增会员在区间内的**全部消费**，
> 不区分是"成为会员前"还是"成为会员后"的订单——UI 文案"新增会员对应消费"读作"对应这群人的整体经营贡献"。

## 派生指标

> **2026-04-25 T6 完成**：派生分母按时间维度区分双口径 — 日维度派生用 `selectedDate` 当日的 `employeeCount.day` / `storeCount.day`；月维度派生用 `selectedDate` 月末的 `employeeCount.month` / `storeCount.month`。
> 后端 `mgmtDashboard.summary` 接口返回 `storeCount: { day, month }` / `employeeCount: { day, month }` 双值；前端 `buildDisplay` 按日/月分别选用对应分母。

| 指标 | 公式 | 防除零 |
|------|------|--------|
| 月店均（monthlyAvgPerStore） | `本月数据 / storeCount.month` （月末口径，scope=单店时分母=1） | 分母=0 时返回 0 |
| 占比（memberRetainRate） | `retainedMemberCount / memberCount × 100%`（两者均按 `selectedDate` 历史化：`became_member_at` 守卫 + 90 天到店窗口） | `memberCount=0 → '--'` |
| 店均会员（avgMembersPerStore） | `memberCount / storeCount.day`（屏幕展示：当日截面） | `storeCount.day=0 → '--'` |
| 店均保有会员（avgRetainedPerStore） | `retainedMemberCount / storeCount.day` | 同上 |
| 人均会员数（avgMembersPerEmp） | `memberCount / employeeCount.day` | `employeeCount.day=0 → '--'` |
| 人均业绩 日/月 | `storeRevenue.today / employeeCount.day` ; `storeRevenue.month / employeeCount.month` | 各自分母=0 → '--' |
| 人均生美业绩 日/月 | `shengmeiRevenue.today / employeeCount.day` ; `shengmeiRevenue.month / employeeCount.month` | 同上 |
| 人均实耗 日/月 | `storeConsume.today / employeeCount.day` ; `storeConsume.month / employeeCount.month` | 同上 |
| 人均生美实耗 日/月 | `shengmeiConsume.today / employeeCount.day` ; `shengmeiConsume.month / employeeCount.month` | 同上 |
| 人均客流 日/月 | `footfall.today / employeeCount.day` ; `footfall.month / employeeCount.month` | 同上 |
| 人均客量 日/月 | `headcount.today / employeeCount.day` ; `headcount.month / employeeCount.month` | 同上 |
| 人均新客 日/月 | `newMembers.today / employeeCount.day` ; `newMembers.month / employeeCount.month` | 同上 |
| 人均项目数 日/月 | `projectCount.today / employeeCount.day` ; `projectCount.month / employeeCount.month` | 同上 |
| 人均提成收入 日/月 | `(salesCommissionIncome + serviceCommissionIncome).today / employeeCount.day` ; `(...).month / employeeCount.month` | 同上 |

> **为何月维度派生用月末分母**：月度业绩/实耗等数据是整月维度（`date_trunc('month', ...)`），分母选「月末在职/在营」与「整月承担产出」的口径对齐，避免月初新开店/新员工尚未产生业绩却被当作分母拉低人均/店均。
> **为何日维度派生与屏幕展示卡用 day 分母**：屏幕的"门店数 / 员工数"卡片展示的是 `selectedDate` 当日截面，对应的派生（店均会员、人均会员）用同一截面分母才能视觉自洽。
> **派生字段优先前端 `buildDisplay` 计算**：避免"加一个派生就改接口"的耦合。
> **例外**：`monthlyAvgPerStore`（4 项营收/实耗的月店均）由后端 `mgmtDashboard.summary` 预算返回（自 T6 起既成事实），
> 原因是该字段需要月末分母 `storeCount.month`，与后端聚合查询同事务内一次性算出可避免前端竞态；前端仅做格式化展示。
> 其余派生（人均 ×11 项、占比、店均会员、月店均人数等）继续走前端 `buildDisplay`。

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
| `[became_member_at]` | 在所选日期/月份范围内（按 `became_member_at::date`） — 新会员判定 |
| `[member_level_upgraded_at]` | 在所选日期/月份范围内（按 `member_level_upgraded_at::date`） — **已废弃用于"新会员"**，仅保留作为审计字段语义 |
| `[paid_at_period]` | 按 period 维度命中（`month` / `lastMonth` / `year`，锚点 `NOW()`） |
| `[service_date_period]` | 同上 |
| `[became_member_at_period]` | 同上 — 新会员排行榜（门店 / 员工）用 |
| `[member_level_upgraded_at_period]` | 同上 — **已废弃用于"新会员"** |

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
| 日历单元格金额标签（紧凑） | 整数 + 千分位（同计数规则） | `12,000`、`600` |
| 防除零 / 数据缺失 | 一律 `--`（不显示 0） | — |

> 规则由 `fengyu-staff/miniprogram/utils/number.ts` 的 `formatAmount` / `formatCount` / `formatPercent` 实现。
> 已废弃旧"≥10000 折叠为 X.X 万"规则。
> 日历金额标签亦不再使用"≥1000 折叠为 X.Xk"规则，统一回归整数千分位（`formatCount`）。
> 占比一律走 `formatPercent`，禁止前端硬编码 `.toFixed(2) + '%'`（`formatPercent` 期望输入 0-1 小数，内部乘 100）。

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
| 2026-04-25 | 客量数据子页 7 决策点拍板：D-1=C（本月激活实时反推，T5 已落地后自包含 anchor 展开）/ D-2=B（成交率分母=体验客+小美客）/ D-3=A（新增会员对应消费=区间内全部）/ D-4=A（会员客时态=当前快照，T2 后切）/ D-5=B（项目数限定 sales_category，与首页对齐）/ D-6=B（schema customer_status 枚举重命名 '预警沉睡'→'沉睡'，独立 ticket [`customer-status-rename-warn`](../tickets/2026-04-25-customer-status-rename-warn.md)）/ D-7=A（分包 packageMgmt） |
| 2026-04-25 | customer_status 枚举值 '预警沉睡' → '沉睡'（schema 与 UI 对齐，详见 ticket customer-status-rename-warn） |
| 2026-04-25 | 「新会员」判定字段从 `old_member_level IS NULL ∧ member_level IS NOT NULL ∩ [member_level_upgraded_at]` 切到 `became_member_at IS NOT NULL ∩ [became_member_at]`。原口径含会员等级内跃迁（初钻→星钻 等），与"首次成为会员客"业务语义偏离；统一改用 `became_member_at`（与 customer_type 跃迁同事务维护）。同步影响：`mgmtDashboard.summary.queryNewMembers`、`mgmtDashboard.storeRanking.rankingNewMember`、staff-ranking ticket、客量数据子页 §5 已对齐 |
| 2026-04-25 | T3 — 员工数切按 `selectedDate` 历史化：`COUNT(*) WHERE s.hired_at IS NOT NULL AND s.hired_at::date <= $date AND (s.resigned_at IS NULL OR s.resigned_at::date > $date)`，不再依赖 `is_resigned=FALSE` 实时快照。`staff_wechat_users` 新增 `hired_at` / `resigned_at` 列（migration 0012 双库部署），admin 员工管理表单已支持编辑；当前由 `created_at::date` / `updated_at::date` 兜底回填 |
| 2026-04-25 | T4 — 门店数切按 `selectedDate` 历史化：`COUNT(*) FROM stores s JOIN org_nodes o ON s.org_node_id=o.id WHERE o.type='门店' AND s.opening_date::date <= $date AND (s.closed_at IS NULL OR s.closed_at::date > $date)`，不再裸数 `org_nodes WHERE type='门店'`。`stores` 新增 `closed_at` 列（migration 0012），`opening_date` 已存在；admin 门店管理表单已支持编辑 |
| 2026-04-25 | T6 完成：C 类派生指标分母切换为 selectedDate 历史化（日/月双口径），移除阶段 1 过渡角标 |
| 2026-04-25 | 品项顾客周期子页 13 项指标定义（持卡人数+占比 2 项、体验/新增/复购各 3 项 = 11 项）；qualifying day 达标日 CTE 逻辑；同一天合并规则与"非首日不算复购"规则；5 决策点已全部拍板：持卡=截面快照（paid_sessions>0）/ 不限 item_direction / 复购业绩=客群全期收入 / entry_date 跨店合并 / 分包 packageMgmt；详见 ticket [`mgmt-product-cycle-page`](../tickets/2026-04-25-mgmt-product-cycle-page.md) |
| 2026-04-25 | `staff.dashboard.newMembers`（员工端单店数据看板）也切到 `became_member_at` 口径——店长按 `c.bound_store_id`、美容师按 `c.bound_employee_id` 归属。旧口径"首次消费达 system_configs.new_member_threshold"已废弃，原因：与 mgmt 看板/排行榜数字不一致导致店长/美容师困惑。同步移除 `staff.js` 中无用的 `getMemberThreshold` import。新增 `db/scripts/verify-new-member-cutover.sql` 双库验证脚本（出数对比 + 归属覆盖率 + 索引建议） |
| 2026-04-25 | 追加"员工排行榜归属"小节（6 指标按员工分组的字段映射 + 产能员工范围）；为 `mgmtDashboard.staffRanking` 接口服务（与 storeRanking 共享 period helper / 排序约定）。员工独有 income 指标（销售提成 + 服务提成）；员工无 retainedMember（保有会员归属门店） |
| 2026-04-25 | 复购口径修订：`fugou` CTE 去掉 `purchase_date <> entry_date` 约束。现"复购 = period 内有达标日的（已 entry）顾客"，threshold 与新增共用。三类关系由"新增 ∩ 复购 可有交集"改为"**新增 ⊆ 复购**"；动机见 ticket [`mgmt-product-repurchase-empty`](../tickets/2026-04-25-mgmt-product-repurchase-empty.md) |
| 2026-07-23 | 复购口径二次修订：周期统计以 `sale_items.received` 累计净实收达标为准，不要求订单 `status='已支付'`；时间轴改为 `COALESCE(sale_order_datetime, paid_at)::date`；复购必须来自本期进入 cohort 且在 entry_date 后再次达标，复购率分母改为品项进入人数（`repurchaseCount / newCount`）。 |
| 2026-04-25 | 跨接口/前后端口径审计补丁：(a) `payNotify` INSERT `sale_allocations` 补 `role_type` + `is_void` 列（按 `staff.skills[1]` 派生，兜底 `'美容师'`），新增 `db/scripts/backfill-allocations-roletype.js` 双库回填存量 NULL 行；(b) `service.js` INSERT `service_commissions` 显式写 `is_void=FALSE`（防 schema drift）；(c) `staffRanking.producer_employees` CTE 由 `is_resigned=FALSE` 切 `hired_at/resigned_at + NOW()` 锚点（`is_resigned` 在 staffApi 查询路径退役）；(d) `mgmt-traffic.regMember` 切 `became_member_at::date <= endDate` 与首页 `memberCount` 对齐；(e) §3 `retainedStable/retainedActive` 与首页 `retainedMemberCount` 等价关系与 24h 滞后明示；(f) §派生指标修订 `monthlyAvgPerStore` 由后端预算的现实；(g) 废弃 `mgmt-customer-detail` 日历"≥1000 → X.Xk"折叠规则；(h) 前端 `retainRate` / 持卡占比统一走 `formatPercent` |
| 2026-05-26 | admin 数据中心（`/data-center`）上线：新增 §「数据中心（admin）板块专属指标」+ 品项二级（category_name）粒度节。3 项用户拍板口径——流量客业绩=仅 `customer_type='流量客'`；单次客耗=`生美实耗÷服务人次`；店长人数=`在营门店数`（每店一店长，不依赖 position_name）。排名榜/区间指标统一走顶部 TimeRange（today/week/month/year/custom），同比环比仅作用 KPI 标量 |
| 2026-08-08 | 数据中心经营统计统一仅纳入 `org_nodes.is_active=TRUE` 的门店：门店数、全部区间指标、门店/员工排行榜及范围下拉同步过滤；单店范围不再固定计 1，停用门店返回零数据 |

---

## 销售数据页 — 分客型业绩 / 实耗 / 产品出库

> 时间轴：总业绩和分客型业绩按 `sale_order_payments.paid_at`；产品出库按订单 `paid_at`；实耗按 `service_date`。
> 时间口径：本月/本年截止今天，上月截止上月最后一天（见下方时间窗口补充）。

### 顾客分型过滤定义

| 分型 | 过滤条件 | JOIN 路径 |
|------|---------|-----------|
| 小美客 | `c.customer_type = '小美客'` | `sale_orders so JOIN client_wechat_users c ON c.user_id = so.client_user_id` |
| 新增会员 | `c.customer_type = '会员客' AND c.became_member_at::date >= [period_start]` | 同上（实耗改 `service_orders so JOIN client_wechat_users c`） |
| 老会员 | `c.customer_type = '会员客' AND c.became_member_at::date < [period_start]` | 同上 |

> **口径说明**：分型使用当前快照。新增会员 = `customer_type='会员客' AND became_member_at >= period_start`（入会时间晚于期间起始即归入，含期间结束后才入会的顾客）。例：3 月下单、4 月入会 → 看上月报表仍算新增会员。三类型之和 ≤ 总业绩（体验客/流量客不计入任何分型）。

### 分客型业绩

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客业绩 | `SUM(sop.amount)` | `sale_order_payments sop` JOIN `sale_orders so` JOIN `client_wechat_users c ON c.user_id = so.client_user_id` | 分型:小美客 ∩ `sop.status='已支付'` ∩ `sop.change_type IN ('首次支付','回款','退款')` ∩ `so.sale_order_type IN ('销售单','转换单','充值单')` ∩ `so.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[sop.paid_at_period]` |
| 新增会员业绩 | `SUM(sop.amount)` | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员业绩 | `SUM(sop.amount)` | 同上 | 分型:老会员 ∩ 同上 |
| 流量客业绩（admin 数据中心销售板块） | `SUM(sop.amount)` | 同上 | `c.customer_type = '流量客'` ∩ 同上（**仅纯流量客**，不含体验客/小美客；2026-05-26 用户拍板）|

### 分客型项目实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客项目实耗 | `SUM(sit.unit_real_price * sit.session_used)` | `service_items sit` JOIN `service_orders so` JOIN `client_wechat_users c ON c.client_user_id = so.client_user_id` | 分型:小美客 ∩ `so.status='已完成'` ∩ `[service_date_period]` |
| 新增会员实耗 | 同上 | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员实耗 | 同上 | 同上 | 分型:老会员 ∩ 同上 |

### 分客型产品出库

> **产品出库定义**：`SUM(si.received)` where `si.product_type = '院装产品'`，时间轴 `paid_at`。
> `product_type` 是 `sale_items` 上的快照列（order.create 写入时从 product_skus 拷贝），**无需额外 JOIN**。
> 院装产品 = 门店备货交付给顾客的实物产品（与疗程卡服务不同）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客产品出库 | `SUM(si.received)` | `sale_items si` JOIN `sale_orders so` JOIN `client_wechat_users c` | `si.product_type='院装产品'` ∩ 分型:小美客 ∩ `so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[paid_at_period]` |
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

## 品项顾客周期子页（mgmt-product-cycle）

> 入口：mgmt-dashboard 首页"品项数据"卡片（`entry === 'products'`）；
> 时间筛选本月/上月/本年/自定义日期区间，口径与 sales-data 页相同（见下方"时间窗口补充"）。
> scope 过滤通过 `so.store_id` 命中；持卡人数例外（截面快照）。

### 1. 持卡人数（截面快照，不随 period 变化）

> 以查询时刻（NOW()）为准；切换 period chip 不影响此数据，UI 加角标"截面"提示。
> **持卡 = 已解锁次数大于 0**（`paid_sessions > 0`），不按 `product_type` 过滤。
> 分母「总会员人数」同 `memberCount`（`client_wechat_users.became_member_at IS NOT NULL` ∩ scope by `bound_store_id`，T2 历史化口径；持卡为截面，本子页不带 `$date` 守卫）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 持卡人数（cardHolderCount）per product_kind | `COUNT(DISTINCT so.client_user_id)` | `sale_items si` JOIN `sale_orders so` JOIN `product_skus sk` JOIN `product_categories pc` | `si.paid_sessions > 0` ∩ `so.sale_order_type IN ('销售单','转换单','寄存单')` ∩ `so.status='已支付'` ∩ scope（`so.store_id`）；按 `pc.product_kind` 分组 |
| 占比（cardHolderRate）per product_kind | `cardHolderCount / memberCount × 100%` | 派生；`memberCount=0` → `--` | — |

### 2. 体验 / 品项进入 / 复购（区间维度，时间轴 `purchase_date`）

**核心术语**：

| 术语 | 定义 |
|------|------|
| **purchase_date（消费日期）** | `COALESCE(so.sale_order_datetime, so.paid_at)::date`；优先订单消费时间，缺失时回退付款时间 |
| **entry qualifying day（进入达标日）** | 销售单/转换单/寄存单的 `SUM(si.received)` 在 `(client_user_id, store_id, product_kind, purchase_date)` 分组下 ≥ `new_member_threshold`（从 `system_configs` 动态读取，默认 1980）|
| **repurchase qualifying day（复购达标日）** | 同一分组下仅汇总销售单/转换单的 `SUM(si.received)`，达到同一 threshold；寄存单金额不参与，不能触发复购 |
| **entry_date（首次进入日）** | 某 client 在某 product_kind 下，全历史（截至 $endDate）中最早的进入达标日（跨门店合并） |
| **品项进入（xinzeng/newEntry）** | entry_date 落在 `[startDate, endDate]` 内的顾客 |
| **复购（fugou）** | 本期品项进入 cohort 中，entry_date 后在 `[startDate, endDate]` 内再次有复购达标日的顾客（threshold 与进入共用） |
| **体验（tiyan）** | 在 `[startDate, endDate]` 内有销售单/转换单购买，但全历史（截至 endDate）从未有进入达标日的顾客 |

> **同一天合并规则**：同一顾客 + 同一门店 + 同一 product_kind + 同一日期的多笔消费先合并；进入基线汇总三类订单，复购达标仅汇总销售单/转换单，再分别对比 threshold。
> **金额口径**：直接使用 `sale_items.received` 累计净实收，回款已累计在该字段内；不再另查回款流水。寄存单只用于进入基线，不计入体验/进入/复购的区间业绩。
> **订单状态口径**：周期统计不要求 `so.status='已支付'`；排除 `已关闭/已作废/未审核/待审批/支付失败` 后，分别按进入金额列和真实购买金额列判断是否达标，部分支付订单也可能达标。
> **三类关系**：体验 ∩ 品项进入 = ∅，体验 ∩ 复购 = ∅；品项进入当天本身不算复购，必须存在 entry_date 之后的达标日。

**底层 CTE（三类指标共用）**：

```sql
WITH daily_agg AS (
  SELECT so.client_user_id, so.store_id,
         pc.product_kind,    COALESCE(so.sale_order_datetime, so.paid_at)::date AS purchase_date,
         SUM(si.received)                     AS day_received,
         COALESCE(
           SUM(si.received) FILTER (WHERE so.sale_order_type IN ('销售单','转换单')),
           0
         )                                    AS purchase_received
  FROM sale_items si
  JOIN sale_orders so ON si.sale_order_id  = so.sale_order_id
  JOIN product_skus sk ON si.sku_id        = sk.sku_id
  JOIN product_categories pc ON sk.category_id = pc.category_id
  WHERE so.sale_order_type IN ('销售单','转换单','寄存单')
    AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
    AND so.client_user_id IS NOT NULL
    AND COALESCE(so.sale_order_datetime, so.paid_at)::date <= $endDate
    AND <scope on so.store_id>
  GROUP BY so.client_user_id, so.store_id, pc.product_kind, COALESCE(so.sale_order_datetime, so.paid_at)::date
  HAVING SUM(si.received) > 0
),
qualifying_days AS (
  SELECT client_user_id, store_id, product_kind, purchase_date
  FROM daily_agg WHERE day_received >= $threshold
),
repurchase_qualifying_days AS (
  SELECT client_user_id, store_id, product_kind, purchase_date
  FROM daily_agg WHERE purchase_received >= $threshold
),
first_entry AS (                              -- entry_date：全历史最早进入达标日（跨店合并）
  SELECT client_user_id, product_kind, MIN(purchase_date) AS entry_date
  FROM qualifying_days
  GROUP BY client_user_id, product_kind
),
period_agg AS (                               -- 期内真实购买每日聚合（排除寄存金额）
  SELECT client_user_id, store_id, product_kind, purchase_date,
         purchase_received AS day_received
  FROM daily_agg
  WHERE purchase_date BETWEEN $startDate AND $endDate
    AND purchase_received > 0
),
xinzeng AS (                                  -- 新增：entry_date 在期内
  SELECT client_user_id, product_kind, entry_date FROM first_entry
  WHERE entry_date BETWEEN $startDate AND $endDate
),
fugou AS (                                    -- 复购：本期进入 cohort，entry_date 后期内真实购买再次达标
  SELECT DISTINCT q.client_user_id, q.product_kind
  FROM repurchase_qualifying_days q
  JOIN xinzeng x ON x.client_user_id = q.client_user_id
                AND x.product_kind   = q.product_kind
  WHERE q.purchase_date BETWEEN $startDate AND $endDate
    AND q.purchase_date > x.entry_date
),
tiyan AS (                                    -- 体验：期内有购买但全历史无达标日
  SELECT DISTINCT pa.client_user_id, pa.product_kind
  FROM period_agg pa
  WHERE NOT EXISTS (
    SELECT 1 FROM first_entry f
    WHERE f.client_user_id = pa.client_user_id
      AND f.product_kind   = pa.product_kind
  )
)
```

| 指标 | 公式 | 数据源 |
|------|------|--------|
| 体验人数（trialCount）per product_kind | `COUNT(DISTINCT tiyan.client_user_id)` | CTE `tiyan` |
| 体验业绩（trialRevenue）per product_kind | `SUM(period_agg.day_received)` WHERE client ∈ tiyan | `tiyan` JOIN `period_agg` ON (client_user_id, product_kind) |
| 体验客单价（trialAvgTicket） | `trialRevenue / trialCount` | 派生；防除零 → `--` |
| 品项进入人数（newCount）per product_kind | `COUNT(DISTINCT xinzeng.client_user_id)` | CTE `xinzeng` |
| 进入业绩（newRevenue）per product_kind | `SUM(period_agg.day_received)` WHERE client ∈ xinzeng | `xinzeng` JOIN `period_agg` |
| 进入客单价（newAvgTicket） | `newRevenue / newCount` | 派生；防除零 → `--` |
| 复购人数（repurchaseCount）per product_kind | `COUNT(DISTINCT fugou.client_user_id)` | CTE `fugou` |
| 复购业绩（repurchaseRevenue）per product_kind | `SUM(period_agg.day_received)` WHERE client ∈ fugou | `fugou` JOIN `period_agg` |
| 复购客单价（repurchaseAvgTicket） | `repurchaseRevenue / repurchaseCount` | 派生；防除零 → `--` |
| 复购率（repurchaseRate） | `repurchaseCount / newCount` | 派生；防除零 → `--` |

> **新增人数 = 品项进入总人数**：正常购买按"首次在该品项消费达标 | 首笔消费实收累计 ≥ new_member_threshold"；寄存单承载 WorkFine 历史实收时，只作为进入基线的兼容数据。
> **各类业绩口径**：为该客群在 period 内该 product_kind 的销售单/转换单购买 `SUM(received)`（非仅达标当日，排除寄存单），
> 体现"该客群对期内收入的贡献"。
> **性能注意**：`daily_agg` 全历史扫描（`purchase_date <= $endDate`，无下界），随运营时长增长。
> 建议追加面向 `sale_order_datetime/paid_at` 与 `client_user_id/status` 的复合索引；800ms slow warn 阈值。

### 3. 二级品项（category_name）粒度（admin 数据中心品项板块专用）

> **背景**：staff 端 `mgmtProduct.cardHolders` / `cycleStats` 只按一级品项 `product_kind` 出数。
> admin 数据中心「品项板块」额外支持**按一级筛选下钻到二级品项 `category_name`**，分组键随筛选层级切换：
>
> | 筛选层级 | 分组键 | 说明 |
> |---------|--------|------|
> | 都不选（默认） | `pc.product_kind` | 全部品项按一级汇总（与 staff 端 `cardHolders`/`cycleStats` 完全同构）|
> | 仅选一级（`productKind`） | `pc.product_kind` | WHERE `pc.product_kind = $productKind` 过滤后仍按一级聚合（单组）|
> | 选到二级（`categoryName`，附带其一级） | `pc.category_name` | WHERE `pc.product_kind = $productKind AND pc.category_name = $categoryName` 过滤后按二级聚合（单组）|
>
> **口径与一级完全同构**——所有 CTE（`daily_agg` / `qualifying_days` / `repurchase_qualifying_days` / `first_entry` / `period_agg` / `xinzeng` / `fugou` / `tiyan`）
> 与持卡截面查询的逻辑、阈值（`getMemberThreshold`，默认 1980）、达标日规则、复购必须晚于进入日的规则
> **均不变**，唯一差异是把分组键 `pc.product_kind` 整体替换为 `pc.category_name`（达标日聚合的 GROUP BY 维度
> 与 `first_entry` 跨店合并键同步替换）。即：
>
> - 持卡人数 / 占比：`COUNT(DISTINCT so.client_user_id)` GROUP BY 分组键，`si.paid_sessions > 0`；占比分母仍为 `memberCount`（不随分组键变化）。
> - 体验 / 新增 / 复购：`daily_agg` 与 `first_entry` 的 `(client_user_id [, store_id], 分组键, purchase_date)` 中的 `product_kind` 替换为 `category_name`。
>
> **达标日的分组维度语义**：一级筛选时「同一顾客 + 同门店 + 同一**一级品项** + 同日」≥ threshold 算达标；
> 二级筛选时收窄为「同一顾客 + 同门店 + 同一**二级品项** + 同日」≥ threshold 算达标——粒度越细，单组消费越分散，达标人数通常 ≤ 一级口径，符合"看某个具体二级品项的进入/复购"的业务诉求。
>
> **filterOptions 数据源**：`SELECT DISTINCT product_kind, category_name FROM product_categories WHERE product_kind IS NOT NULL`，
> 组装为 `[{ kind, categories: [...] }]`（一级 → 其下二级名列表）供前端两级联动下拉。
>
> **admin 实现位置**：`fengyu-admin/src/actions/data-center/product.ts`（`getProductBoard`）；
> 一致性守护：`fengyu-admin/src/actions/data-center/__tests__/consistency.product.test.ts`
> 对 staff `mgmt-product.js` 做关键口径字面量比对（一级 product_kind 口径同源，二级为 admin 独有扩展）。

---

## 时间窗口补充（sales-data 页专用口径）

| 维度 | period_start | period_end |
|------|-------------|------------|
| 本月 | `date_trunc('month', NOW()::date)` | `NOW()::date` |
| 上月 | `date_trunc('month', NOW()::date - INTERVAL '1 month')` | `date_trunc('month', NOW()::date) - INTERVAL '1 day'` |
| 本年 | `date_trunc('year', NOW()::date)` | `NOW()::date` |

> 过滤写法：`col::date BETWEEN [period_start] AND [period_end]`

---

## 数据中心（admin）板块专属指标（2026-05-26 用户拍板）

> admin `/data-center` 看板新增/重定义、且 staff 端无对端的指标。一致性守护见各
> `fengyu-admin/src/actions/data-center/__tests__/consistency.*.test.ts`。

| 指标 | 板块 | 公式 | 说明 |
|------|------|------|------|
| 流量客业绩 | 销售 | `SUM(sop.amount)` WHERE `c.customer_type = '流量客'` | 仅纯流量客（不含体验/小美客）；按组织层级现金流口径，详见上方「分客型业绩」表 |
| 单次客耗 | 客量 | `生美实耗 ÷ 服务人次` | 分子=`SUM(unit_real_price*session_used) WHERE is_shengmei`（已完成 ∩ service_date 区间）；分母=已完成 service_orders 行数（服务人次）。KPI 与明细表统一此口径（**不用** Excel 原稿"÷频率"，亦不用"÷会员人次"）|
| 店长人数 | 人效 | `COUNT(在营启用门店)` | 每店一店长口径：按 `stores` JOIN `org_nodes(type='门店', is_active=TRUE)` 在营计数（`opening_date<=区间末 ∩ (closed_at IS NULL OR closed_at>区间末)`），**不依赖** `position_name`。故 `店长人均X = 每店平均 X`（含 店长人均收入 = 门店全部产能员工提成合计 ÷ 门店数）|

> **时间口径**：数据中心排名榜与上述区间指标统一走顶部时间维度 `col::date BETWEEN current.start AND current.end`
> （TimeRange：今日/本周/本月/今年/自定义），而非 staff 端固定 month/lastMonth/year 锚 NOW()。
> **同比/环比**：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%），明细表与排名榜不做逐行对比。
