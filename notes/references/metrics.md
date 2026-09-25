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

> **组织层级业绩的归属规则**：只统计状态为“已支付”的首次支付、回款和退款；`储值卡抵扣`不属于组织现金业绩，必须排除。
>
> `spe.performance_date` **直读** `sale_order_payments.performance_attribution_date`，**查询侧不存在任何回退分支**（迁移 0040，2026-09-14 收口）。该列的取值规则全部下沉到写入侧的两个 trigger：
>
> - **`trg_sale_order_payments_performance_attribution`**
>   （`BEFORE INSERT OR UPDATE OF status, paid_at, performance_attribution_date` ON `sale_order_payments`，
>   FOR EACH ROW，函数 `initialize_payment_performance_attribution_date()`）——
>   首次支付镜像订单级 `sale_orders.performance_attribution_date`；同次混合支付的储值卡行跟随主流水；
>   其余按 `paid_at` → `created_at` 兜底。**注意是列限定的 UPDATE OF**，改其它列不会重算。
> - **`trg_sale_orders_sync_payment_attribution`**
>   （`AFTER UPDATE OF performance_attribution_date, performance_attribution_adjusted_at,
>   performance_attribution_adjusted_by` ON `sale_orders`，函数 `sync_order_performance_attribution_to_payments()`）——
>   订单级归属日期被调整时，同步更新首次支付行与同次卡行。
>
> 迁移 0040 给该列加了 **CHECK 约束** `chk_sop_attribution_date_present`（`... IS NOT NULL`），
> 因此 `performance_date` 恒有值。
> ⚠ 列本身**不是** `NOT NULL`（Drizzle schema 里仍是 nullable `date(...)`），
> 非空是靠 CHECK 保证的——判断「是否已迁库」要查约束，不要查列的 nullability。
> 退款 `amount` 为负数，按**退款自身**的归属日期入账，不回溯原订单归属日。不得用父订单 `status` 过滤，因此部分支付订单已到账的付款也计入。
>
> ⚠ **每一笔款项都有自己的归属日期**。2026-09-14 之前文档写的「回款/退款取自身 `paid_at` 的上海自然日」已失效——
> 迁移 0039 起首次支付行也回填了该列，0040 起视图直读且无回退，`paid_at` 只作为**写入侧** trigger 的兜底来源之一。
>
> **订单日期与归属日期**：`performance_attribution_date` 默认等于原始订单的上海自然日。原始 `sale_order_datetime` 始终保留。有权人员可不受操作时间限制地调整一次，但新日期必须在原始订单日前后 7 天内（含）。
>
> **组织层级业绩 vs 生美 / 品项 / 员工归属为何不同**：充值现金只进入组织层级总业绩和分客型业绩，
> **不进入**生美或品项分类（充值时尚未确定买什么）。
> ⚠ **2026-09-14 订正**：原文「现金流无法可靠拆到 SKU 或员工」已失效——
> `sale_item_performance_events` 经 `sale_payment_item_receipts` 把每笔款项拆到 `sale_item`，
> 员工层再经 `sale_payment_item_allocations` 拆到员工。现在生美业绩、品项统计、员工业绩/提成
> 都已走各自的**款项级**事件视图，而不是订单快照。
> ⚠ 但三者**并非只差统计粒度**，至少还有这些实打实的差异：
> 组织业绩排除 `储值卡抵扣` 与 WorkFine legacy；子项事件包含储值卡收款拆分及历史 residual，
> 且相关报表常按父订单状态过滤；员工销售指标只计 `spia.is_void=FALSE` 且已分配到员工的销售单/转换单款项；
> **服务提成根本不走款项事件**，走 `service_commissions` + `[service_date]`。

## 客流 / 客量 / 新会员

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 客流 | `COUNT(DISTINCT client_user_id)` | `service_orders.client_user_id` | `status='已完成'` ∩ `client_user_id IS NOT NULL` ∩ `[service_date]` |
| 客量 | `COUNT(*)` | `service_orders` | `status='已完成'` ∩ `[service_date]` |
| 新会员 | `COUNT(*)` | `client_wechat_users` | `became_member_at IS NOT NULL` ∩ `[became_member_at]` |
| 项目数 | `SUM(session_used)` | `service_items.session_used` | JOIN service_orders；`status='已完成'` ∩ `service_items.sales_category IN ('自销自耗','他销自耗')` ∩ `[service_date]` |

> **寄存单退款服务单的统一剔除**：寄存单退款专用服务单（备注 = `DEPOSIT_REFUND_REMARK`）
> 走正常服务单流程扣次数，但**是真到店、假消耗**。两端实现都套了 `excludeDepositRefundSql(alias)`，
> 展开为 `<alias>.remark IS DISTINCT FROM '<寄存单退款备注>'`（NULL 安全，禁用裸 `!=`——
> 绝大多数服务单 `remark` 为 NULL，用 `!=` 会把它们全误排除）。
>
> | | 指标 |
> |---|---|
> | **剔除** | 实耗、生美实耗、项目数、门店榜/员工榜的消耗与项目、品类拆分实耗、salesData 分客型实耗、`trafficSessions` |
> | **不剔除** | 客流、客量/到店、服务人次、保有会员、提成 |
>
> 单源：admin `src/lib/data-center/consume-filter.ts` / staff `utils/consume-filter.js`；
> 调用方 admin `data-center/{customer,efficiency,sales}.ts`（4 + 11 + 4 = **19** 处）、
> staff `routes/{mgmt-dashboard,mgmt-traffic}.js`（9 + 1 = 10 处）
> 与 staff `routes/{mgmt-customer,customer}.js` 顾客详情「年度实际消费」各 1 处（共 **12** 处）。
>
> ⚠ **守护范围有两层限制**，别把它当全覆盖：
> ① `consistency.deposit-refund-filter.test.ts` 只纳入**前 5 个文件**
>   （admin 3 + staff `mgmt-dashboard`/`mgmt-traffic`），即 31 处里守护 29 处；
>   staff 顾客详情那 2 处不在清单内，漏改不会报红。
> ② 它守护的是**每个文件里的调用次数**，不校验调用落在哪个指标查询上 ——
>   把过滤从「实耗」挪到「客流」上，计数不变、测试照样绿。
> 改这些查询时要手工对照上表的「剔除 / 不剔除」两栏。
> 此前本文档从未登记该过滤，照公式抄会多算。
> （2026-09-16 随 #142 补登记；非本批引入，属历史遗漏。）
>
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
> 时间锚点固定为 `NOW()`，period ∈ `month` / `lastMonth` / `year`（与门店排行榜一致，复用
> `[spe.performance_date_period]` / `[service_date_period]` / `[became_member_at_period]` 缩写）。
> ⚠ **2026-09-14 订正**：原写「复用 `[paid_at_period]`」已失效——员工业绩/收入的销售部分按款项归属日期（见下表）。

| 指标（员工层） | 公式 | 归属字段 | 时间窗口 | 备注 |
|------|------|---------|---------|------|
| 业绩 | `SUM(spia.allocated_amount)` | `sale_payment_item_allocations.employee_id` | `[spe.performance_date_period]` | JOIN receipt + `sale_order_performance_events`；`is_void=FALSE` ∩ `sale_order_type IN ('销售单','转换单')` ∩ `spe.status='已支付'` |
| 实耗 | `SUM(service_items.unit_real_price * service_items.session_used * service_commissions.allocation_ratio)` | `service_commissions.employee_id` | `[service_date_period]` | `sc.is_void=FALSE` ∩ `service_orders.status='已完成'`；2026-09-03 归属变更见下 |
| 客流 | `COUNT(DISTINCT service_orders.client_user_id)` | `service_commissions.employee_id` | `[service_date_period]` | 员工内去重，跨员工不去重；`sc.is_void=FALSE` ∩ `status='已完成'` ∩ `client_user_id IS NOT NULL` |
| 项目数 | `SUM(session_used)`（先按 `(sc.employee_id, service_item_id)` DISTINCT） | `service_commissions.employee_id` | `[service_date_period]` | `sc.is_void=FALSE` ∩ `sales_category IN ('自销自耗','他销自耗')` ∩ `status='已完成'`；计数指标**不乘** `allocation_ratio` |
| 新会员 | `COUNT(*)` | `client_wechat_users.bound_employee_id` | `[became_member_at_period]` | `became_member_at IS NOT NULL`；`bound_employee_id IS NULL` 的新会员不归属任何员工（与"无归属新会员"差额由监控关注） |
| 收入 | 销售提成 + 服务提成 | 销售=`sale_payment_item_allocations.employee_id`；服务=`service_commissions.employee_id` | 销售按 `[spe.performance_date_period]`；服务按 `[service_date_period]` | `is_void=FALSE`；销售使用 `commission_amount`；服务使用 `service_commissions.commission_amount` |

> **业绩 vs 收入区别**：业绩仅含销售部分（`sale_allocations`）；收入 = 销售 + 服务提成（`service_commissions`）。两者销售部分公式相同；收入因加服务提成而 ≥ 业绩。
>
> **2026-09-03 员工归属口径变更（实耗 / 客流 / 项目数）**：归属字段从 `service_items.employee_id`
> 改为 `service_commissions.employee_id`（`is_void=FALSE`），实耗额外乘 `allocation_ratio`。
> 缘由：`service_items.employee_id` 是开单时选定的负责美容师，**全仓无任何路径可修改**；门店事后用
> 「营业额分配-服务提成」纠正归属时改不动它，导致实耗长期记在没拿这单提成的人头上
> （2026-09 生产实测 103 项 / 7.7 万元错位，占当月实耗 23%）。改后与 admin 服务提成导出
> （`exportAllocationServiceOrders`）、`staff.js performanceDetail` 个人绩效页三处同源。
> - **所有 `role_type` 各算一份**（用户拍板，不做角色去重）：同一项目同时挂美容师 + 品项老师时两人各全额计入。
> - **门店榜 / 全局大卡实耗仍走 `service_items` 原口径**，不在本次变更范围；因此员工榜合计与门店实耗不再恒等。
>
> **2026-09-03 产能员工池同步放宽**（配套上条，两端镜像）：候选池由「`store_id ∈ 在营门店`」
> 改为「门店员工 ∪ 直挂组织节点员工」。否则品项公司的品项老师、各市场养生部的养生师
> （`store_id` 为空）拿到分配额却整体落榜（实测 22 人 / 约 2.6 万元）。三段口径：
> 1. **`store_id` 兜底** — 档案 `store_id` 为空但直挂的是**门店**节点时反查该门店（修 1 例档案缺失）；
> 2. **展示名兜底** — 「所属门店」列为空时显示直挂节点名（如「品项公司」「养生部」），不留空白；
> 3. **可见性锚 `anchor_market_id`** — 直挂节点自身是市场则取自身，否则取父节点（部门→市场，org 树最多一层）。
>    无门店员工按「锚定市场下是否有本账号可见的在营门店」判定可见性：
>    - 品项公司是总部直属市场节点、其下无门店 → **仅总部 / admin 可见**；
>    - 养生部 / 推广部 / 财智部锚到所属市场 → 该市场范围的账号可见（实测南昌凤御视角可见养生部 9 人、推广部 14 人，看不到品项公司）；
>    - admin 侧 UI 选具体门店时无门店员工一律不出现（不归属任何单店）。
>
> 实现：staff `producerEmployeesCte` + `buildOrgAnchorScope`；admin `producerCte` + `orgAnchorScopeSql`
> （`src/lib/data-center/scope-sql.ts`）。跨端字面量由 `consistency.efficiency.test.ts` 守护。
>
> **产能员工范围**（`staff_wechat_users`）：`hired_at IS NOT NULL ∩ hired_at::date <= NOW()::date ∩ (resigned_at IS NULL OR resigned_at::date > NOW()::date)` ∩ scope（2026-09-03 起 = 门店员工按 `store_id` ∪ 直挂组织节点员工按 `anchor_market_id`，见下）。<br>_历史：曾含 `skills && ARRAY['美容师','养生师']`（2026-05-20 去除）；曾强制 `store_id ∈ 在营门店`（2026-09-03 放宽）。_锚点为 **NOW()**（员工排行榜本就是"当前在职产能员工"的 period 业绩，不随 selectedDate 历史化；与 employeeCount selectedDate 历史化口径**字段一致但锚点不同**）。
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
| 产能技师数（employeeCount） | `COUNT(*)` | `staff_wechat_users` LEFT JOIN `org_nodes`×2 + `stores` | `sw.hired_at IS NOT NULL` ∩ `sw.hired_at::date <= $date` ∩ (`sw.resigned_at IS NULL` OR `sw.resigned_at::date > $date`) ∩ `skills && ARRAY['美容师','养生师']` ∩ **可见性二选一**（见下）<br>_2026-04-25 T3：从 `is_resigned=FALSE`（实时快照）切到 `hired_at`/`resigned_at` 时间戳（历史化）_<br>_2026-09-24 #320：分母从「只认 `store_id`」改为**双轨归属**，与 admin 人效板同源_ |
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
> **产能技师数（2026-09-24 #320 起）按「双轨归属」计**，与 admin 人效板
> （`fengyu-admin/src/lib/data-center/technician-sql.ts`）同源。员工组织归属有两条轨：
> `staff_wechat_users.store_id`（门店 FK）与 `org_node_id`（组织节点 FK，type 可为 部门/市场/门店）。
> 只认 `store_id` 会整体漏掉直挂市场/部门的人 —— 2026-09-24 生产实测漏 14 人（152 而非 166），
> 所有人均派生指标虚高 +9.2%。规则：
> - **归属**：`COALESCE(sw.store_id, ds.store_id)`，其中 `LEFT JOIN stores ds ON ds.org_node_id = sw.org_node_id`
>   —— 直挂**门店组织节点**的人回收进该门店；回收后仍为 NULL 的用
>   `anchor_market_id = CASE WHEN o.type='市场' THEN o.id WHEN op.type='市场' THEN op.id END` 锚到市场
> - **可见性二选一**：`(store_id IS NOT NULL AND <门店 scope>) OR (store_id IS NULL AND <市场锚 scope>)`
>   - 门店分支**仅计启用门店**（与同页其它指标的 `active_node.is_active = TRUE` 一致）
>   - 市场锚分支：单店 scope → **一律不计**（故「集团技师数 ≠ Σ门店技师数」，有意）；
>     市场 scope → 锚定市场相等才计；全部 → 计
>   - ⚠️ 市场锚分支**不带**启用门店过滤（直挂者不属于任何门店，无可判断启停的门店）；
>     与 admin 一致，属已知取舍 —— 代价是「门店全停的市场 + 直挂技师」人均偏低
> - ⚠️ 「全部」口径下 staff 与 admin **有一条已登记分叉**（#334）：admin 的 `all` 只对**超管**恒真，
>   非超管总部账号走「锚定市场下存在可见启用门店」的 EXISTS，看不到无门店市场（如品项公司）的人
> - 跨端一致性由 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-technician-denominator.test.js`
>   的字面量断言守护（抽取自检 + 要件 1~9 含 6b + 单源反向守护，共 12 个 `it`）；
>   两端是独立副本，改一端必同步另一端
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
| 一次客活（activeOnce） | `COUNT(*)` | `client_wechat_users` | `customer_status IN ('保有会员-稳定','保有会员-有效')` ∩ 区间内**到店天数** = 1 ∩ scope |
| 二次客活（activeTwice） | 同上 | 同上 | 同上但区间内**到店天数** ≥ 2 |
| 本月激活-沉睡（reactivatedFromWarn） | `COUNT(*)` | `client_wechat_users` + `service_orders` | 见下方"本月激活"决策点 |
| 本月激活-冰冻（reactivatedFromFrozen） | 同上 | 同上 | 同上 |
| 本月激活-休眠（reactivatedFromDeep） | 同上 | 同上 | 同上 |

**到店天数 SQL 模板（一次/二次客活共用）**（#298，2026-09-23 拍板按到店天数，2026-09-25 拍板日期轴）：

- **到店天数** = 区间内去重后的到店日期个数，**去重键 `(so.client_user_id, so.service_date)`**：同一顾客同一天开多张服务单、做多个项目只算 1 天。**不是**服务单行数（`COUNT(*)`）
- **日期轴 = `service_orders.service_date`**（服务日期，开单时确定的服务当天）。**不用**以下三条轴：
  - `completed_at`：顾客点确认的时刻，有滞后（prod 实测 15411 张已完成单里 1450 张与服务日不在同一天，最长滞后 23 天）
  - 预约日：只有 110/15411 张服务单挂了预约，不可用
  - 款项归属日期：是付款事件不是到店事件，且可人工改期
- 只计 `status='已完成'` 且 `client_user_id IS NOT NULL` 的服务单
- 与「客流量（次）」不同：客流量仍按服务单行数计（见 §2），两者不要混用

```sql
WITH visit_count AS (
  SELECT so.client_user_id, COUNT(DISTINCT so.service_date) AS days
  FROM service_orders so
  WHERE so.status='已完成' AND so.client_user_id IS NOT NULL
    AND so.service_date BETWEEN $startDate AND $endDate
    AND <scope on so.store_id>
  GROUP BY so.client_user_id
)
SELECT COUNT(*) FROM visit_count vc
JOIN client_wechat_users c ON c.user_id = vc.client_user_id
WHERE c.customer_status IN ('保有会员-稳定','保有会员-有效')
  AND vc.days = 1   -- 一次客活；二次客活改 vc.days >= 2
  AND <scope on c.bound_store_id>
```

实现位置（三处运行时实现同口径：admin 两个查询共用 `visitDaysSql`、staff 两个查询、cron 一个刷新函数；由 `fengyu-admin/src/actions/data-center/__tests__/consistency.customer.test.ts`「#298 跨定义」一组整段快照守护，任一侧漂移即红）：

| 实现 | 位置 |
|---|---|
| admin 数据中心 KPI + 市场/门店明细 | `fengyu-admin/src/lib/data-center/visit-days.ts` `visitDaysSql`（日期轴为白名单参数；#370 的「服务日 ∪ 支付日」并集轴需要把它改成按轴构造整段事件 SQL，输出列契约不变） |
| staff 管理层客量页 | `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js` `queryActiveOnce` / `queryActiveTwice`（独立副本） |
| 顾客列表「月度客活」筛选 | cron `refresh-monthly-activity.ts`（见下节 `monthly_activity`） |

#### 月度客活 `client_wechat_users.monthly_activity`（顾客列表筛选项）

> 枚举 `'二次客活' / '一次客活' / '0次客活'`，由 cron-worker STEP 3 `fengyu-admin/src/cron/steps/refresh-monthly-activity.ts` 每日重算（03:00 触发，先跑完数据库备份才执行 STEP，实际时点略晚于 03:00），
> admin 顾客列表与 staff 顾客列表都能按它筛选。**与上面一次/二次客活是同一个到店天数口径、同一条日期轴。**

| 取值 | 判定 |
|---|---|
| 二次客活 | **自然月**（`date_trunc('month', CURRENT_DATE)` 起到月底）内到店天数 ≥ 2 |
| 一次客活 | 当月到店天数 = 1 |
| 0次客活 | `customer_type='会员客'` 且当月没有到店 |
| NULL | 非会员客当月没有到店 |

与数据中心一次/二次客活的差别（口径相同，只是范围不同，数字对不上时先逐条查）：

1. **不限保有会员**：`monthly_activity` 对当月到店的所有顾客（含非会员）都打标；数据中心只数 `customer_status IN ('保有会员-稳定','保有会员-有效')` 的人
2. **不限门店**：cron 按全部门店（含已停用门店）的服务单数到店天数。admin 数据中心的 `scopeFilterSql` 即使选「全部」也恒带在营门店过滤（`org_nodes.is_active`），服务单侧按 `so.store_id`、顾客侧按 `bound_store_id` 各过滤一次；staff 管理层客量页选「全部」时不带在营门店过滤。所以在停用门店有服务单、或绑定在停用门店的顾客，三端可能分到不同档
3. **单店 scope 下跨店到店不计**：顾客绑定 A 店，1 号去 A、2 号去 B —— scope=A 时服务单侧只留 A 店的单，算「一次」；scope=全部时明细 A 行算「二次」（改口径前即如此）
4. **快照时点**：`monthly_activity` 是最近一次 cron 的快照，此后新完成的服务单要等下一次 cron 才计入；数据中心实时查。每月 1 号的快照里当月几乎全是 0次客活 / NULL
5. **区间长度**：`monthly_activity` 固定自然月；数据中心跟随顶部时间筛选。选「今日」这类单日区间时，到店天数最多 1 天，「二次」恒为 0（改口径前同日两单会被算成二次）

验证（prod，2026-09-25）：按当天 cron 快照时点（`completed_at` 早于 03:01:58）、全部在营门店、限保有会员复算，数据中心口径得一次 615 / 二次 922，与 `monthly_activity` **逐人比对 0 差异**（1537 人，双向 EXCEPT 均为空）。

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
>
> **2026-09-16（#138）起改为款项流水口径，与组织层级业绩同源**：
> `SUM(spe.amount)` ∩ `spe.status='已支付'` ∩ `spe.change_type IN ('首次支付','回款','退款')` ∩
> `spe.sale_order_type IN ('销售单','转换单')` ∩ `spe.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[spe.performance_date]`。
>
> ⚠ 与组织层级业绩的**唯一差异**：客量侧**不含 `充值单`**（充值是预存，不是消费）。
> ⚠ 旧实现是订单快照 `SUM(o.received - COALESCE(o.refunded_amount, 0)) @ o.paid_at::date` ∩ `o.status='已支付'`。
> **更早版本的本文档误记为 `paid_amount`**，而该列早已 DROP —— 文档与实现当时就不一致，
> 按旧文档复算差异会找不到可用的列。
> ⚠ 因含退款负行，某会员在区间内只有退款时 `spend` 可为**负数**——这是「本期净消费」的有效事实，
> 不做 clamp（clamp 会掩盖退款净流出，且与组织业绩失去可对账性）。

**底层会员消费聚合 CTE**（所有分桶共用）：

```sql
WITH member_spend AS (
  SELECT o.client_user_id,
         SUM(spe.amount::numeric) AS spend
  FROM sale_order_performance_events spe
  JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
  JOIN client_wechat_users c ON c.user_id = o.client_user_id
  WHERE <scope on o.store_id>
    AND spe.sale_order_type IN ('销售单', '转换单')
    AND spe.status = '已支付'
    AND spe.change_type IN ('首次支付', '回款', '退款')
    AND spe.legacy_source IS DISTINCT FROM 'workfine'
    AND spe.performance_date BETWEEN $startDate AND $endDate
    AND c.customer_type = '会员客'
  GROUP BY o.client_user_id
)
```

> 视图无 `client_user_id`，必须 JOIN `sale_orders` 取；该 JOIN 是主键等值，不放大行。
> 两端镜像实现：`fengyu-admin/src/actions/data-center/customer.ts`（5 处：3 个 KPI + 2 个门店/市场明细）
> 与 `fengyu-staff/.../routes/mgmt-traffic.js`（2 处），由
> `consistency.customer.test.ts` 的块级逐字快照守护，任一端漂移立即失败。

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
| 新增会员对应消费（newMemberSpend） | `SUM(spe.amount)` | `sale_order_performance_events spe` JOIN `sale_orders` | JOIN 上面的新增会员；`spe.sale_order_type IN ('销售单','转换单')` ∩ `spe.status='已支付'` ∩ `spe.change_type IN ('首次支付','回款','退款')` ∩ `spe.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[spe.performance_date]` ∩ scope（`store_id`）。**2026-09-16（#138）起同 §4 口径**，旧实现为 `SUM(o.received - COALESCE(o.refunded_amount,0)) @ o.paid_at::date` ∩ `o.status='已支付'`（旧文档误记为 `paid_amount`，该列已 DROP） |
| 新增会员客单价（newMemberAvgTicket） | `newMemberSpend / newMemberCount` | 派生；防除零 → `--` |
| 新增会员成交率（newMemberConvRate） | `newMemberCount / trialFootfall × 100%` | 派生；防除零 → `--` |

**新增会员成交率分母（trialFootfall）**：

```sql
SELECT COUNT(DISTINCT t.uid)
FROM (
  -- ① 本期到店 且 期初未达会员
  SELECT so.client_user_id AS uid
  FROM service_orders so
  JOIN client_wechat_users c ON c.user_id = so.client_user_id
  WHERE so.status='已完成'
    AND so.client_user_id IS NOT NULL
    AND so.service_date BETWEEN $startDate AND $endDate
    AND (c.customer_type IN ('体验客','小美客')                 -- 当前仍未达会员
         OR c.became_member_at::date BETWEEN $startDate AND $endDate)  -- 或本期内才转化
    AND <scope on so.store_id>
  UNION
  -- ② 本期全部新增会员（兜住本期无已完成服务单者）
  SELECT c.user_id AS uid
  FROM client_wechat_users c
  WHERE c.became_member_at IS NOT NULL
    AND c.became_member_at::date BETWEEN $startDate AND $endDate
    AND <scope on c.bound_store_id>
) t
```

> **D-conv-denom（2026-09-22 改判 1c，推翻原 D-2=B）**：分母 = 期初未达会员的到店活跃池
> **∪** 本期全部新增会员。
>
> **为什么推翻 B**：`customer_type` 是**只升不降的当前快照**（升级链 流量客 → 体验客 →
> 小美客 → 会员客）。本期成功转化的人当期已是「会员客」，被 `IN ('体验客','小美客')`
> 从分母整体剔除 —— **而他们正是分子**。实测集团 2026-09 有 141 人被抹掉：
> 35 家有新会员的门店全部虚高、12 家超真实值 1.5 倍、单店最高出到 800%，
> 分母归零的门店反而显示 '--'（#284）。
>
> **为什么是 1c 而不是「补回本期转化者」的 1a**：151 名本期新增会员里有 10 人本期
> 没有任何已完成服务单。1a 下他们**进分子不进分母**，单店成交率仍可能 > 100%。
> 分支 ② 的 UNION 让**分子成为分母的真子集**，上限 ≤ 100% 成立。
>
> ⚠️ **上限是「单查询内」成立，不是事务级保证**：KPI 侧分子（`queryNewMemberCount`）与
> 分母（`queryTrialFootfall`）是同一个 `Promise.all` 里的**两条连接、两个快照**。
> 分母先读、分子后读，期间若有人转化，KPI 卡可瞬时 > 100%（明细侧在单条 SQL 内算，不受影响，
> 因而两处可能对不上）。这是既有性质（旧口径同样是两次独立查询），刷新即恢复。
>
> **不含流量客**：维持升级链「体验客 + 小美客」这一层，只把本期已转化者补回。
> 含流量客的方案 2 实测分母 1861 / 成交率 8.11%，与升级链口径脱钩且量级突变，已否决。
>
> **判定时点**：期初判定（当前 `customer_type` 仍未达会员 **OR** `became_member_at` 落在本期），
> 不采用逐次到店日判定（方案 1b 实测只差 1.06pp，不值得引入 `service_date` 与
> `became_member_at` 的逐行比较）。
>
> 各口径实测（生产只读库，2026-09-01~09-30 集团，分子 151）：
> 现行 539 / 28.01%、1a 680 / 22.21%、1b 649 / 23.27%、**1c 690 / 21.88%（采纳）**、含流量客 1861 / 8.11%。
>
> **分子分母 store_id 来源不同**：分子用 `client_wechat_users.bound_store_id` 算 scope，
> 分母 ① 用 `service_orders.store_id`、② 用 `bound_store_id`（与分子同源）。
> ① 在跨店服务时仍会形成微小漂移；2026-09-22 核实「只在非绑定店到店的新增会员」本期为 **0 人**，
> 接受当前精度。**② 必须与分子同源**，子集关系全靠它成立。
> 明细表（byMarket/byStore）的合计因此 ≥ KPI：同一人可在「A 店（① 到店）」与
> 「B 店（② 绑定店）」各计一次。KPI 是全局 DISTINCT、明细是组内 DISTINCT，两者本就不该相等。

**三条使用限制（#284 起，看数前必读）**：

1. **该指标禁用同比/环比**。分母两分支的数据深度差 50 个月（① 取自 `service_orders`，最早
   **2026-07-08**；② 取自 `became_member_at`，回溯 **2022-08**）。基期一旦落在 2026-07-08 之前，
   ① 恒空而 ② 仍有数百人，delta 会变成 100% 由 ② 构成的假数。代码里 `trafficCustomers` 与
   `convRate` 的 `mom`/`yoy` 一律写死 `null`（前端 '--'）。
2. **「成交率分母」与「流量人次」不同口径，不可相互校验**。分母含「本期已转会员的人」
   （其到店行记在 `member_visits` 而非 `traffic_visits`）和「本期没到过店的新会员」（完全无人次行），
   所以同一行出现 `成交率分母 > 流量人次`、甚至 `流量人次 = 0 而成交率分母 > 0`，
   **是合法状态，不是数据 bug**。旧口径下这在数学上不可能，因此这是 #284 之后的新现象。
3. **两端数值在存在停用门店时不可比**。admin 的 `scopeFilterSql` 恒含
   `org_nodes.is_active = TRUE` 过滤，staff 的 `buildManagementStoreScope` 没有（`all` 档直接 `TRUE`）。
   绑定在停用门店的新增会员 admin 不计、staff 计；staff `all` 档还会计入 `bound_store_id IS NULL` 的会员。
   **各端内部分子/分母配对是自洽的**（同一个 scope helper 同时作用于分子与分母 ②），
   子集关系两端都成立；跨端对数时须先确认组织树里没有停用门店。

> ⚠️ **已知限制（待拍板，#284 遗留）**：① 分支的判定 `became_member_at::date BETWEEN start AND end`
> **带上界**，于是「在该区间之后才转化」的人会被排除出该历史区间的活跃池 —— 因为 `customer_type`
> 只升不降，他们今天已是会员客，两个分支同时为假。后果是**历史区间的分母随时间单调缩水、
> 成交率单调上飘，数字不可重算**。2026-09-23 实测：2026-07 漏 35 人（24%）、2026-08 漏 69 人（10%）、
> 当期为 0。直写形式 `(became_member_at IS NULL AND customer_type IN ('体验客','小美客'))
> OR became_member_at::date >= start` 可修复，但会纳入「区间内仍是流量客、之后才转化」的人
> （实测 2 人，< 0.3%），与「不含流量客」的拍板有张力，故**等业务裁决后再改**。
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

## 款项归属日期的适用范围（2026-09 收口）

> `performance_attribution_date`（款项业绩归属日期）与 `paid_at`（资金发生日）是**两个独立口径**。
> 前者可被有权人员在订单日 ±7 天内调整一次，用于业绩归属；后者是不可改写的资金事实。
> 本节登记哪些指标走归属日期、哪些**明确不走**，避免后续开发凭印象二选一。

### 走款项归属日期

| 端 / 页面 | 指标 | 落地 | 来源 |
|---|---|---|---|
| 组织层级业绩（门店/市场/总部） | 业绩、销售提成收入、员工排行榜业绩；员工排行榜**收入的销售提成部分** | `[spe.performance_date]` | #137 |
| 组织层级业绩 · 子项类 | **生美业绩** | `[sipe.performance_date]` | #137 |
| admin 数据中心 · **销售 / 人效**板块 | **业绩 / 现金流类**金额指标（⚠ 实耗、生美实耗、服务提成**除外**，见下表） | `[spe.performance_date]` | #137 |
| admin 数据中心 · **品项**板块 | 子项类金额指标 | `[sipe.performance_date]` | #137 |
| admin 数据中心 · **客量板块** | 会员被经营 6 档分桶、会员客单价、新会员对应消费、新会员客单价 | `[spe.performance_date]` | **#138** |
| staff 管理层 · 首页看板 / 销售数据 / 门店·员工排行 | **业绩 / 现金流类**金额指标（⚠ 同上，实耗与服务提成除外） | `[spe.performance_date]` | #137 |
| staff 管理层 · **mgmtTraffic 会员经营** | 同 admin 客量板块（镜像实现） | `[spe.performance_date]` | **#138** |
| staff · **订单列表、营业额分配列表** 的日期筛选 | 列表筛选区间 | `[performance_attribution_date]` | **#139** |
| admin · **工作台** | 今日实付、今日退款、昨日实付 | `[spe.performance_date]` | **#140** |
| staff · **顾客档案年度消费 / 列表年消费** | 本年净消费、tier 徽章分档 | `[performance_attribution_date]` | **#141** |
| admin / staff · 品项顾客周期（mgmt-product-cycle） | `purchase_date`（进入/复购达标日的时间轴） | `sale_item_performance_events.performance_date` | #137 |
| admin / staff · 分客型业绩、分客型产品出库、品项维度汇总 | 这三项的金额指标（⚠ 同页的**分客型项目实耗**走 `[service_date]`，不在此列） | `[spe.performance_date]` / `[sipe.performance_date]` | #137 |

### 明确**不**走归属日期（范围外）

| 指标 | 实际口径 | 原因 |
|---|---|---|
| 实耗 / 生美实耗 | `[service_date]` | 服务实际发生日，与款项无关 |
| 客流 / 客量 / 到店 / 项目数 | `[service_date]` | 同上 |
| 服务提成收入 | `[service_date]` | 实耗的下游分配 |
| 会员等级（滚动 12 月消费） | `paid_at` | 会员权益按资金事实，不随业绩归属改写 |
| 消费档位 `spending_tier` | **无日期窗口**（lifetime 全量，含 `paid_at IS NULL` 的历史单） | 终身累计快照，cronTask 每日重算 |
| 新会员判定 | `[became_member_at]` | 身份时间戳，非款项 |
| 顾客档案**月度消费日历** | `paid_at` | 实付现金流视图，与年度消费的归属口径**并存且有意**（#141） |
| `total_paid_amount`（累计实付） | 无日期条件 | 全量累计，不受任何日期口径影响 |

> ⚠ **财务提醒**：admin 工作台「今日实付 / 今日退款」自 #140 起按归属日期，
> **不再与银行/收款流水逐日对齐**。若财务需要资金发生日口径，应另开报表入口，
> 不要把 `paid_at` 改回这些指标上制造双口径。

### admin 工作台现金流指标（#140）

> 实现：`fengyu-admin/src/actions/dashboard.ts` 的 `payment_metrics` CTE（JS 变量名是 `orderStats`）。
> 与同卡片「今日业绩」`todayRevenue` 同口径，卡片内不再自相矛盾。

> CTE 级公共过滤（对下表全部指标生效）：`spe.store_id ∈ scope` ∩ `spe.legacy_source IS DISTINCT FROM 'workfine'`。

| 指标 | 公式 | 筛选条件（在公共过滤之上） |
|------|------|----------|
| 今日实付（todayPaidAmount） | `SUM(spe.amount)` | `spe.status='已支付'` ∩ `spe.change_type IN ('首次支付','回款')` ∩ `spe.amount > 0` ∩ `spe.sale_order_type IN ('销售单','转换单','充值单')` ∩ `spe.performance_date = today` |
| 今日退款（todayRefundedAmount） | `SUM(ABS(spe.amount))` | `spe.status='已支付'` ∩ `spe.change_type='退款'` ∩ 同订单类型 ∩ `spe.performance_date = today` |
| 昨日实付（yesterdayPaidAmount） | 同「今日实付」 | 同上，`spe.performance_date = today - 1` |
| 累计实付（totalPaidAmount） | 同「今日实付」 | 同上，**无日期条件**（全量累计，不受口径变更影响） |

> ⚠ 实付要求 `amount > 0` 且不含 `退款`；退款单列并取 `ABS()`——与 `chk_sop_amount_sign` 自洽。
> ⚠ 订单类型**含 `充值单`**（与组织层级业绩一致，与客量板块不同）。
> ⚠ 这四项**不按父订单 `status` 过滤**，部分支付订单已到账的款项同样计入。
> ⚠ 同一 CTE 里的 `today_revenue` / `yesterday_revenue` 含 `退款`（`change_type IN ('首次支付','回款','退款')`）
> 因此是净额；「实付」是毛额。两者口径不同但同一天窗口，卡片上并列展示时注意区分。

### staff 顾客档案消费指标（#141）

> 实现：`fengyu-staff/.../routes/mgmt-customer.js`（管理层视角）与 `customer.js`（店长视角）。
> ⚠ **副本关系要分清**：
> **两端「详情页」的年度消费查询互为语义副本**（常规款项分支 + legacy 分支都已逐字核对），改一端必同改另一端；
> **列表「年消费」只与详情共享落年口径**，金额公式本就不同（`SUM(o.total_amount)` vs `SUM(sop.amount)`）；
> **月度消费日历两端公式也本就不同**（见下表最后两行）。后两类都不要"对齐"。

> 三处年度口径统一用**半开年区间** `[yearStart, yearStart + 1 year)`，
> `yearStart` 由 `shanghaiDateStr().slice(0, 4)` 取上海当年（不依赖进程时区）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 年度消费 · 常规（详情页） | `SUM(sop.amount)` | `sale_order_payments sop` JOIN `sale_orders o` | `sop.status='已支付'` ∩ `o.sale_order_type IN ('销售单','转换单')` ∩ `o.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[sop.performance_attribution_date]` |
| 年度消费 · legacy(workfine) 分支 | 订单级，**有明细取明细**：`CASE WHEN EXISTS(sale_items) THEN SUM(si.received) ELSE o.received END` | `sale_orders o` | `o.status IN ('已支付','部分支付','已完成')` ∩ `o.sale_order_type IN ('销售单','转换单')` ∩ `o.legacy_source='workfine'` ∩ `[o.performance_attribution_date]` |
| 年消费（列表页，仅驱动 tier 徽章） | `SUM(o.total_amount)` | `sale_orders o` | `o.status='已支付'` ∩ `[o.performance_attribution_date]` ∩ scope |
| 月度消费日历 · 管理层版 | `SUM(o.received - COALESCE(o.refunded_amount,0))` | `sale_orders o`（**不** JOIN sale_items） | `o.status='已支付'` ∩ `[o.paid_at]`（按上海时区取日） |
| 月度消费日历 · 店长版 | `SUM(si.received)` | `sale_orders o` **INNER JOIN** `sale_items si` | 同上；明细行另展示 `o.total_amount` |

> ⚠ **年度消费可为负**：含退款负行，顾客当年只有退款时显示负数，表达「本年净消费」，不 clamp。
> ⚠ **常规分支没有 `change_type` 过滤** —— 与组织层级业绩「必须排除储值卡抵扣」的纪律不同，
> 这里的储值卡抵扣正行**会计入**年度消费（顾客视角：刷卡消费也是消费）。
> 这是有意的，**不要"顺手"补上 change_type 过滤**，否则两端副本立刻漂移。
> ⚠ 列表「年消费」与详情「年度消费」**落年口径一致、金额公式不同**：
> 详情是款项级**实收**（`sop.amount`），列表是订单级**应付总额**（`o.total_amount`）。
> 这是有意的——列表该值只驱动 tier 徽章（黑钻 ≥20000 / 铁粉 ≥5000 / 粉丝 >0），不展示金额，
> 故两处数字对不上属预期，不要"对齐"。
> ⚠ 三处查询都接 `utils/attribution-guard.js` 运行时守卫：未 apply 迁移 0039 时抛
> `INVALID_STATE: MIGRATION_REQUIRED`，而不是静默出错数。

---

## 时间窗口缩写约定

| 缩写 | 含义 |
|------|------|
| `[spe.performance_date]` | 在所选日期/月份范围内（按 `sale_order_performance_events.performance_date`，**款项业绩归属日期**，`date` 类型、闭区间） |
| `[spe.performance_date_period]` | 同上，按 period 维度命中（`month` / `lastMonth` / `year`，锚点 `NOW()`） |
| `[sipe.performance_date]` | 同上，但取自**子项**业绩事件视图 `sale_item_performance_events.performance_date`（品项 / 产品出库 / 品项顾客周期用） |
| `[sipe.performance_date_period]` | 同上，按 period 维度命中 |
| `[performance_attribution_date]` | 直读 `sale_order_payments.performance_attribution_date`（不经视图时用；语义同上） |
| `[paid_at]` | 在所选日期/月份范围内（按 `paid_at::date`）—— **资金发生日**，与归属日期是两个口径，勿混 |
| `[service_date]` | 在所选日期/月份范围内（按 `service_date`） |
| `[became_member_at]` | 在所选日期/月份范围内（按 `became_member_at::date`） — 新会员判定 |
| `[member_level_upgraded_at]` | 在所选日期/月份范围内（按 `member_level_upgraded_at::date`） — **已废弃用于"新会员"**，仅保留作为审计字段语义 |
| `[paid_at_period]` | 按 period 维度命中（`month` / `lastMonth` / `year`，锚点 `NOW()`）—— **本表内已无指标使用**：2026-09-14 起**业绩/现金流类**走 `[spe.performance_date_period]`、子项类走 `[sipe.performance_date_period]`、实耗与服务提成走 `[service_date_period]`；保留定义仅供会员等级等范围外口径引用 |
| `[service_date_period]` | 同上 |
| `[became_member_at_period]` | 同上 — 新会员排行榜（门店 / 员工）用 |
| `[member_level_upgraded_at_period]` | 同上 — **已废弃用于"新会员"** |

> **表别名前缀**：文中出现的 `[o.paid_at]` / `[o.performance_attribution_date]` /
> `[sop.performance_attribution_date]` 等带前缀写法，语义与去掉前缀的版本完全相同，
> 前缀只是标明该条件挂在哪张表上（`o` = `sale_orders`，`sop` = `sale_order_payments`，
> `spe` / `sipe` = 两个业绩事件视图）。

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
| 2026-09-22 | **D-conv-denom 改判 B → 1c（#284）**：成交率分母由「区间内到店的体验客 + 小美客」改为「期初未达会员的到店活跃池 ∪ 本期全部新增会员」。`customer_type` 只升不降，本期已转化者当期已是会员客、被从分母整体剔除，而他们正是分子 —— 35 家有新会员的门店全部虚高、单店最高 800%、分母归零反显 '--'。分支 ② 保证分子 ⊆ 分母，上限 ≤ 100% 恒成立（纯活跃池方案 1a 做不到，本期有 10 名新增会员无已完成服务单）。集团 2026-09 由 28.01%（151/539）改为 **21.88%（151/690）**。两端同步：`customer.ts::queryTrialFootfall` + 明细 `traffic_cust` CTE、`mgmt-traffic.js::queryTrialFootfall` |
| 2026-09-25 | **一次/二次客活改按到店天数（#298）**：由服务单行数 `COUNT(*)` 改为 `COUNT(DISTINCT service_date)`，去重键 `(client_user_id, service_date)`，日期轴拍板为 `service_date`；admin 数据中心（KPI + 明细）与 staff mgmt-traffic 同步。补登 `monthly_activity` 口径（此前在本文档完全缺席，是两套定义分叉的根因）。prod 2026-09-01~09-24 集团一次/二次 527/982 → 590/919，63 人由「二次」回到「一次」 |
| **2026-09-14** | **款项业绩归属日期收口（#137，迁移 0039 + 0040）**。视图 `sale_order_performance_events.performance_date` 改为**直读** `sale_order_payments.performance_attribution_date`，**查询侧不再有任何回退分支**；取值规则全部下沉到写入侧两个 trigger。0040 给该列加了 **CHECK 约束** `chk_sop_attribution_date_present`（列本身**不是** `NOT NULL`，Drizzle schema 里仍是 nullable）。<br>**影响面**：原文「首次支付取订单归属日、回款/退款取自身 `paid_at`」的表述在全文档失效——每一笔款项都有自己的归属日期。金额类指标按类型分流：**业绩/现金流类**（总业绩、分客型业绩、员工业绩、销售提成）走 `[spe.performance_date]`；**子项类**（生美业绩、产品出库、品项周期业绩）走 `[sipe.performance_date]`；**实耗 / 生美实耗 / 服务提成**仍走 `[service_date]`，不受本次收口影响。<br>⚠ **部署前置**：先 apply 0039 + 0040 再部署各端，否则未迁库时首次支付行归属日为 NULL，会被三值逻辑吞掉正数主体。 |
| **2026-09-16** | **口径变更登记（#138 / #139 / #140 / #141）**，四条均为「从 `paid_at` 切到归属日期」：<br>· **#138** 客量数据子页 §4/§5：会员被经营 6 档分桶、会员客单价、新会员对应消费改按款项流水归属（`SUM(spe.amount) @ performance_date`；旧实现为 `SUM(o.received - COALESCE(o.refunded_amount,0)) @ o.paid_at::date` ∩ `o.status='已支付'`，旧文档曾误记为 `paid_amount`，该列已 DROP）。dev 实测 2026-08 经营人数 321→324、会员总数 470→413、消费合计 +7.78 万；含退款负行故 `spend` 可为负（本期净消费，不 clamp）。<br>· **#139** staff 订单列表 / 营业额分配列表的日期筛选固定按 `performance_attribution_date`。<br>· **#140** admin 工作台「今日实付 / 今日退款 / 昨日实付」改按 `spe.performance_date`（`total_paid_amount` 无日期条件不受影响）。⚠ 财务注意：这三项不再与银行流水逐日对齐。<br>· **#141** staff 顾客档案「年度消费」/ 列表「年消费」改按 `performance_attribution_date`（半开年区间）；**月度消费日历仍按 `paid_at`**，两个口径并存且有意。<br>同轮订正三处存量滞后表述：销售数据页总述、分客型业绩 `[sop.paid_at_period]`、分客型产品出库与品项维度汇总的 `SUM(si.received) @ paid_at`（实现早已是 `SUM(sipe.amount) @ sipe.performance_date`）；员工排行榜「复用 `[paid_at_period]`」。<br>另补登记一条历史遗漏：实耗 / 生美实耗 / 项目数等**消耗类**指标两端都套了 `excludeDepositRefundSql()` 剔除寄存单退款专用服务单（admin 19 处 / staff 12 处，由 `consistency.deposit-refund-filter.test.ts` 守护 31 处中的 29 处，且只校验文件级调用次数）——**客流 / 到店 / 服务人次 / 保有会员 / 提成不剔除**（寄存退款是真到店、假消耗）。本文档此前从未登记，照公式抄会多算。 |
| **2026-09-22** | **环比基期（上期）长度首次登记（#283）**，见文末「数据中心（admin）板块专属指标」节。此前全文只登记了「上期」这个概念、从未定义其长度，`time-range.ts` 遂把本节「时间窗口补充」里 staff 端的**三选一并列维度**「上月=上月初~上月末」误当成环比分母，于是 `本周`/`本月` 两个 preset 拿 N 天的当期比整周/整月的基期（同文件 `今日`/`自定义` 恒等长，`今年` 另有跨闰年偏差）。现明确：**基期按日历同期对齐、不得无条件取完整上一周期**，`本周`→上周同一星期几、`本月`→上月同一日。同轮登记三条日历固有例外（`本月` 上月天数不足时 clamp 到上月末短 1~3 天；`今年` 的环比/同比基期跨闰年 ±1 天；`本周`/`自定义` 的**同比**基期跨闰年 ±1 天且星期漂移——后两条源自 `addYears` 的 2/29 归一化，**均尚未修复**）。并明确**同比基期与环比基期同受「不得长于当期」约束**（二者同走一个 `deltaPct`）。另补登记 `delta%` 的「算不出」情形含**基期 `<= 0`** 与**非有限值**（负基期会让符号翻转）。⚠ 「本月」与「自定义同起止日」的环比值本就不同，属语义差异非缺陷。 |
| **2026-09-22** | **「基期算不出」升级为跨站点规则（#307）**。`fengyu-analyst`（第 5 个子项目，独立部署的经营分析站，复用 admin 的库与认证）被发现有一份**完全独立**的增幅实现，同样只挡 `base === 0` 不挡 `base < 0`——它与 admin 无目录共享、无 snapshot 守护，纯粹因为上一行那条口径此前无人登记而把同一个符号翻转缺陷重写了一遍。现两边「算不出」判定已对齐（含非有限值），但**展示层刻意分叉**：admin 出 `--` 且徽章弃判方向，analyst 出「无基数」但**仍按 `current > prevYear` 判绿/红**（由负回正是真实的向好信息）。⚠ 该分叉是有意的，别当漏改去统一。详见文末基期章节的跨站点小节。 |
| **2026-09-23** | **负基期改为「由负转正 / 未转正」两态展示，取代一律 `--`（#310 #315，拍板）**。此前 `base <= 0` 一律压成灰色 `--`（PR #305），挡住了假数字但丢掉了店长最关心的「由负转正」——实测南昌梦祥店「本周」业绩基期 −2,646、当期 +264（已回正），店长只能翻明细表才知道。现立**全站统一矩阵**（见文末基期章节）：`base<0 && cur>0` → 「由负转正」绿、`base<0 && cur<=0` → 「未转正」红、`base===0` 与非有限值仍 `--` 灰；硬约束**不再输出任何基于负分母的百分比**。同轮把 **admin 首页看板 `TrendArrow`** 纳入本口径——它此前 `base<=0` 时把幅度吞成 0 却仍走涨跌分支，渲染出「↑ 0%」，且**生产正在触发**（`yesterdayRevenue` 退款计负无夹底，只读实测 1020 门店日中 67 天非正 = 6.6%）。并落**伪持平**口径：按展示精度舍入后为 0 的并入「持平」，不再出 `+0.00%`。⚠️ 三处展示精度不同（数据中心 2 位 / 首页看板整数 / analyst 1 位），阈值随之不同，别互抄。⚠️ admin 侧单一真相源改为 `src/lib/delta-display.ts`，数据中心与首页看板共用；原 `comparison.ts` 的 `deltaPct` **已删除**（生产零调用且语义分叉，留着是「第三份实现」的诱饵）。 |
| **2026-09-23** | **人效板「员工/技师人均业绩」分子改回门店现金流口径（#285）**，见文末「数据中心（admin）板块专属指标」节的「业绩两套口径」。原实现把 `SUM(spia.allocated_amount)` 跨员工求和当门店业绩用——`allocated_amount` 是**角色归属额**（写入侧按 `(sale_item_id, role_type)` 分池校验，单 receipt 的 ratio 合计 2.0/3.0 属正常形态），只在 `GROUP BY employee_id` 时才是钱。2026-09-01~09-21 集团实测虚高 **+32.30%**（4,867,397.55 vs 3,679,035.98），与同页「门店排名榜-业绩」差 111 万；另有 950 张零分配 receipt 反向漏计，**偏差不同向、无法用系数校正**。现分子改为 `SUM(spe.amount)`，与门店排名榜 / 销售板总业绩 / staff `queryStoreRevenue` 四处同源。<br>⚠ **恢复 role_type 白名单不是修法**（实测仍差 −4.45%，只是偶然的部分去重）。<br>⚠ 员工排行榜 / 按技师人效明细**维持** allocation 口径不变（分组到人时语义正确，见 §员工排行榜归属）。<br>**根因**：2026-07-27 `23405ddf` 换表时把全局大卡一并留在 allocation 口径，并把守护断言反向钉死；该断言是文件级 `toMatch`、分不清聚合粒度，两边都写 `spia` 时恒绿，缺陷存活两个月。现改为按 Part 分段断言 + Part A/B 的 WHERE 子句逐字相等。<br>**同轮修复分母**（评审抓出）：人均派生分母只按 `staff_wechat_users.store_id` 过滤，漏掉 13 名 `store_id IS NULL` 直挂市场/部门的在职产能技师（集团 150 vs 164，虚高 **+9.33%**；南昌凤御 +13.8%、南昌易大师 +5.3%；昭通凤御技师数少报 4 人；「品项公司」整个市场不出现在按市场表里）。现归属规则与 Part D `producer_base` 对齐。⚠️ 单店 scope 下直挂者仍不出现，`集团技师数 ≠ Σ门店技师数`（与员工榜同语义，非缺陷）。 |
| **2026-09-23** | **analyst 增幅文案两条本地例外落地（#314，拍板）**，见文末基期章节「analyst 的两条本地例外」小节。<br>· **`rate` 型零基期不再算「算不出」**：百分点差值走减法、不需要非零分母，两道基期守卫改排在 rate 分支之后，`0% → 30%` 出 `+30.0pct`。此前 `previous === 0` 排在前面，**只藏涨不藏跌**（`30% → 0%` 照常出 `-30.0pct`）。⚠️ **已知代价**：`service_orders` 最早 2026-07-08 而新客入口走首单（回溯 2022-08），2022–2025 的 1,352 个新客到店恒为 0，故**凡 `entry_date < 2026-07-08` 的基期新客其到店数都不可信**（观察窗 `[entry_date, +90天]` 完全早于割点=恒为 0 的假零基期、跨割点=可能低估；⚠️ 别写成固定失效日、也别写成「与割点重叠」或「割点前的基期都是 0」——分别忽略了同比平移 12 个月致 2027 上半年仍命中、漏掉最严重的恒零形态、把跨线的低估误说成归零），集团级到店率同比将显示约 `+86.7pct`。该代价在拍板时已量化告知并被接受（根因由 #289 跟踪），**不要据此回头推翻**。<br>· **伪持平并入「持平」**：`toFixed(1)` 舍成 `0.0` 的不再带符号输出 `+0.0%` / `-0.0%`，配色一并变灰；判据是印出来的那个数（`Number(scaled.toFixed(1)) === 0`）而非原始 delta。⚠️ 阈值随展示精度走，analyst 1 位、admin 数据中心 2 位、首页看板整数，**别互抄**。<br>· 同轮确立 **文案与配色同源**：tone 读实际渲染值，不再自己重算方向；没印出数字时才退而用两期差值补方向，而**四种成因（零基期 / 负基期 / 非有限入参 / 溢出）里只有负基期允许这么做**（#307 既定分叉不变），其余弃判置灰。<br>· 同轮把 AI 助手的 `assistant-answer.ts` `formatSignedRate`（与看板吃同一个 `kpi.delta` 的第二实现，曾各自判零、且不挡 `NaN`）**收敛到 `metric-delta` 的无前缀内核**，顺带修掉 #317 登记的 `NaNpct`。<br>⚠️ 决策 1（负基期「由负转正 / 未转正」矩阵）点名的 **analyst 侧尚未落地**，不在 #314 范围。 |

---

## 销售数据页 — 分客型业绩 / 实耗 / 产品出库

> 时间轴：总业绩和分客型业绩按 `[spe.performance_date]`；产品出库按 `sale_item_performance_events.performance_date`；实耗按 `[service_date]`。
> ⚠ **2026-09-14 订正**：原文「总业绩和分客型业绩按 `sale_order_payments.paid_at`；产品出库按订单 `paid_at`」已失效——
> #137 起这三项金额指标一律走款项/子项业绩归属日期（`mgmt-dashboard.js` SQL 1/2/5、`data-center/sales.ts`）。
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
| 小美客业绩 | `SUM(spe.amount)` | `sale_order_performance_events spe` JOIN `sale_orders so` JOIN `client_wechat_users c ON c.user_id = so.client_user_id` | 分型:小美客 ∩ `spe.status='已支付'` ∩ `spe.change_type IN ('首次支付','回款','退款')` ∩ `spe.sale_order_type IN ('销售单','转换单','充值单')` ∩ `spe.legacy_source IS DISTINCT FROM 'workfine'` ∩ `[spe.performance_date_period]`。**2026-09-14 订正**：原写 `sop.paid_at_period` 已失效 |
| 新增会员业绩 | `SUM(spe.amount)` | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员业绩 | `SUM(spe.amount)` | 同上 | 分型:老会员 ∩ 同上 |
| 流量客业绩（admin 数据中心销售板块） | `SUM(spe.amount)` | 同上 | `c.customer_type = '流量客'` ∩ 同上（**仅纯流量客**，不含体验客/小美客；2026-05-26 用户拍板）|

### 分客型项目实耗

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客项目实耗 | `SUM(sit.unit_real_price * sit.session_used)` | `service_items sit` JOIN `service_orders so` JOIN `client_wechat_users c ON c.client_user_id = so.client_user_id` | 分型:小美客 ∩ `so.status='已完成'` ∩ `[service_date_period]` |
| 新增会员实耗 | 同上 | 同上 | 分型:新增会员 ∩ 同上 |
| 老会员实耗 | 同上 | 同上 | 分型:老会员 ∩ 同上 |

### 分客型产品出库

> **产品出库定义**：`SUM(sipe.amount)` where `si.product_type = '家居产品'`，时间轴 `sale_item_performance_events.performance_date`。
> ⚠ **2026-09-14 订正**：原写「`SUM(si.received)`，时间轴 `paid_at`」已失效——
> 实现走子项业绩事件视图（`mgmt-dashboard.js` SQL 5），按归属日期逐笔入账，
> 跨月部分支付因此分摊到各自归属月，不再整单落在下单月。
> `product_type` 是 `sale_items` 上的快照列（order.create 写入时从 product_skus 拷贝），**无需额外 JOIN**。
> 家居产品（2026-04-25 前称「院装产品」）= 门店备货交付给顾客的实物产品（与疗程卡服务不同）。

| 指标 | 公式 | 数据源 | 筛选条件 |
|------|------|--------|----------|
| 小美客产品出库 | `SUM(sipe.amount)` | `sale_item_performance_events sipe` JOIN `sale_items si` JOIN `sale_orders so` JOIN `client_wechat_users c` | `si.product_type='家居产品'` ∩ 分型:小美客 ∩ `so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[sipe.performance_date_period]` |
| 新增会员产品出库 | 同上 | 同上 | 同上，分型:新增会员 |
| 老会员产品出库 | 同上 | 同上 | 同上，分型:老会员 |

---

## 品项维度汇总（销售数据页）

> 公式：`SUM(sipe.amount)`，时间轴 `sale_item_performance_events.performance_date`，
> 基础过滤：`so.sale_order_type IN ('销售单','转换单')` ∩ `so.status='已支付'` ∩ `[sipe.performance_date_period]`。
> ⚠ **2026-09-14 订正**：原写「`SUM(si.received)`，时间轴 `paid_at`」已失效（同产品出库）。
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
| **purchase_date（消费日期）** | `sale_item_performance_events.performance_date`（**子项业绩归属日期**）。<br>⚠ **2026-09-14 订正**：原写 `COALESCE(so.sale_order_datetime, so.paid_at)::date` 已失效——#137 起两端（`mgmt-product.js` / `data-center/product.ts`）都改走子项业绩事件视图，跨月部分支付因此按款项分摊到各自归属日 |
| **entry qualifying day（进入达标日）** | 销售单/转换单/寄存单的 `SUM(sipe.amount)` 在 `(client_user_id, store_id, product_kind, purchase_date)` 分组下 ≥ `new_member_threshold`（从 `system_configs` 动态读取，默认 1980）|
| **repurchase qualifying day（复购达标日）** | 同一分组下仅汇总销售单/转换单的 `SUM(sipe.amount)`，达到同一 threshold；寄存单金额不参与，不能触发复购 |
| **entry_date（首次进入日）** | 某 client 在某 product_kind 下，全历史（截至 $endDate）中最早的进入达标日（跨门店合并） |
| **品项进入（xinzeng/newEntry）** | entry_date 落在 `[startDate, endDate]` 内的顾客 |
| **复购（fugou）** | 本期品项进入 cohort 中，entry_date 后在 `[startDate, endDate]` 内再次有复购达标日的顾客（threshold 与进入共用） |
| **体验（tiyan）** | 在 `[startDate, endDate]` 内有销售单/转换单购买，但全历史（截至 endDate）从未有进入达标日的顾客 |

> **同一天合并规则**：同一顾客 + 同一门店 + 同一 product_kind + 同一日期的多笔消费先合并；进入基线汇总三类订单，复购达标仅汇总销售单/转换单，再分别对比 threshold。
> **金额口径**：使用 `sale_item_performance_events.amount` 逐笔子项业绩事件（该视图按 sale_item 汇总恒等于 `sale_items.received`，回款/退款已逐笔入账）。寄存单只用于进入基线，不计入体验/进入/复购的区间业绩。
> ⚠ **2026-09-14 订正**：原写「直接使用 `sale_items.received` 累计净实收」已失效——改走事件视图后，同一笔订单的跨月回款会分摊到各自归属日，而不是整单压在下单日。
> **订单状态口径**：周期统计不要求 `so.status='已支付'`；排除 `已关闭/已作废/未审核/待审批/支付失败` 后，分别按进入金额列和真实购买金额列判断是否达标，部分支付订单也可能达标。
> **三类关系**：体验 ∩ 品项进入 = ∅，体验 ∩ 复购 = ∅；品项进入当天本身不算复购，必须存在 entry_date 之后的达标日。

**底层 CTE（三类指标共用）**：

```sql
WITH daily_agg AS (
  SELECT so.client_user_id, so.store_id,
         pc.product_kind,    sipe.performance_date        AS purchase_date,
         SUM(sipe.amount::numeric)                        AS day_received,
         COALESCE(
           SUM(sipe.amount::numeric) FILTER (WHERE so.sale_order_type IN ('销售单','转换单')),
           0
         )                                                AS purchase_received
  FROM sale_item_performance_events sipe
  JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  JOIN product_skus sk ON sk.sku_id = si.sku_id
  JOIN product_categories pc ON pc.category_id = sk.category_id
  WHERE <scope on so.store_id>
    AND so.sale_order_type IN ('销售单','转换单','寄存单')
    AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
    AND so.client_user_id IS NOT NULL
    AND pc.product_kind IS NOT NULL
    AND sipe.performance_date <= $endDate
  GROUP BY so.client_user_id, so.store_id, pc.product_kind, sipe.performance_date
  HAVING SUM(sipe.amount::numeric) > 0
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
> **各类业绩口径**：为该客群在 period 内该 product_kind 的销售单/转换单购买 `SUM(sipe.amount)`（非仅达标当日，排除寄存单），
> 体现"该客群对期内收入的贡献"。
> ⚠ **2026-09-14 订正**：原写 `SUM(received)` 已失效，与本节其余部分一样改走子项业绩事件视图。
> **性能注意**：`daily_agg` 全历史扫描（`purchase_date <= $endDate`，无下界），随运营时长增长。
> 索引建议**只能建在底层表上**——`sale_item_performance_events` 是普通 `pgView`，不能直接建索引，
> 且 `sale_item_performance_events.performance_date` 的**底表来源有两个分支**：
> **receipt 分支**继承款项事件日期（→ `sale_order_payments.performance_attribution_date`）、
> **legacy residual 分支**直读 `sale_orders.performance_attribution_date`。
> 而 `client_user_id` / `status` **并不是该视图自身的列** —— 视图只输出
> `event_key / receipt_id / sale_payment_id / sale_order_id / sale_item_id / store_id /
> amount / sales_category / change_type / performance_date / is_initial_event / is_legacy_residual`；
> 顾客与状态过滤是消费方再 JOIN `sale_orders` 得到的。
> 跨多张表、分支日期来源又不同，无法组成单个复合索引。
> 按实际 JOIN/过滤路径分别考虑：`sale_order_payments(performance_attribution_date)`、
> `sale_orders(client_user_id, status)`、`sale_items(sale_order_id)`。800ms slow warn 阈值。
> ⚠ **2026-09-14 订正**：原建议面向 `sale_order_datetime/paid_at` 的复合索引，
> 时间轴改走子项业绩归属日期后已不适用。

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
| 流量客业绩 | 销售 | `SUM(spe.amount)` WHERE `c.customer_type = '流量客'` | 仅纯流量客（不含体验/小美客）；按组织层级现金流口径（`[spe.performance_date]`），详见上方「分客型业绩」表。**2026-09-14 订正**：原写 `SUM(sop.amount)` 的别名已随口径切换失效 |
| 单次客耗 | 客量 | `生美实耗 ÷ 服务人次` | 分子=`SUM(unit_real_price*session_used) WHERE is_shengmei`（已完成 ∩ service_date 区间）；分母=已完成 service_orders 行数（服务人次）。KPI 与明细表统一此口径（**不用** Excel 原稿"÷频率"，亦不用"÷会员人次"）|
| 店长人数 | 人效 | `COUNT(在营启用门店)` | 每店一店长口径：按 `stores` JOIN `org_nodes(type='门店', is_active=TRUE)` 在营计数（`opening_date<=区间末 ∩ (closed_at IS NULL OR closed_at>区间末)`），**不依赖** `position_name`。故 `店长人均X = 每店平均 X`（含 店长人均收入 = 门店全部产能员工提成合计 ÷ 门店数）|
| 员工/技师人均业绩分子 | 人效 | `SUM(spe.amount)`（门店现金流） | **2026-09-23 #285 订正**。`empAvgRevenue` 与 `byMarket.techAvgRevenue` 的分子 = 上方 §派生指标的 `storeRevenue`，与同页「门店排名榜-业绩」、销售板「总业绩」、staff `queryStoreRevenue` **四处同源**。详见下方「业绩两套口径」|
| 人均派生分母（技师数） | 人效 | 产能技师 ∩ 区间末在职 ∩ **含直挂市场/部门者** | **2026-09-23 #285 订正**。`skills && ARRAY['美容师','养生师']`，归属按 `COALESCE(sw.store_id, ds.store_id)`；回收后仍无门店的用 `anchor_market_id` 锚到市场。⚠️ **只按 `store_id` 过滤会漏人**：组织归属双轨（`store_id` + `org_node_id`），2026-09 实测 13 名在职产能技师 `store_id IS NULL`（12 人直挂各市场「养生部」、1 人直挂「品项公司」），产出进分子、人头不进分母 → 集团 150 vs 164、虚高 **+9.33%**。⚠️ **单店 scope 下直挂者不出现**（`orgAnchorScopeSql` 返回 FALSE），故 `集团技师数 ≠ Σ门店技师数`，与员工榜同语义。⚠️ 另有一条**潜在**缺口：「既无门店、又锚不到市场」的产能技师会进 KPI 总分母却进不了任何 byMarket 行（`orgAnchorScopeSql` 在 admin+scope=all 时返回 `TRUE`，不要求锚得到市场），即 `KPI 技师数 ≥ Σ byMarket 技师数`。2026-09-23 实测该类人数为 **0**，当前两数恒等；不收紧是有意的——收紧会把真实技师从集团口径整个抹掉，且与 `producer_employees` 人池定义分叉 |

> ### ⚠️ 业绩有两套口径，按**聚合粒度**分（2026-09-23 #285 订正）
>
> | 粒度 | 公式 | 用在哪 |
> |---|---|---|
> | 门店/全局（不分组到人） | `SUM(sale_order_performance_events.amount)` ∩ 已支付 ∩ `change_type IN ('首次支付','回款','退款')` ∩ `sale_order_type IN ('销售单','转换单','充值单')` ∩ `legacy_source IS DISTINCT FROM 'workfine'` ∩ `[spe.performance_date]` | 人效板 KPI 大卡、按市场人效、门店排名榜；销售板总业绩；staff 大卡 |
> | 员工（`GROUP BY employee_id`） | `SUM(sale_payment_item_allocations.allocated_amount)` ∩ `is_void=FALSE` ∩ 销售单/转换单 ∩ 已支付回款分配 | 员工排行榜、按技师人效明细（见上方 §员工排行榜归属） |
>
> **为什么不能混用**：`allocated_amount` 是**角色归属额**不是钱。写入侧按 `(sale_item_id, role_type)`
> **分池**校验「池内 Σratio ≤ 1」，单 receipt 挂几个角色就有几个独立的 100% 池 —— ratio 合计
> 2.0 / 3.0 是设计允许的正常形态。按 `employee_id` 分组时它是对的；**去掉 GROUP BY 跨员工求和，
> 同一笔钱就被算 2~3 次**。
>
> 2026-09-01~09-21 集团实测：跨员工求和 4,867,397.55 vs 门店业绩 3,679,035.98，**虚高 +32.30%**。
> 且同期 950 张 receipt 零分配、5.8 万反向漏计 → **偏差不同向，无法用统一系数校正**。
>
> **恢复 `role_type IN ('美容师','养生师')` 白名单不是修法**：同区间实测得 3,515,204.60，
> 仍差 −4.45%，且偏差幅度随品项老师/推广部业务占比漂移 —— 那只是一次偶然的部分去重。
>
> **故障史**：2026-07-27 `23405ddf` 换表（`sale_allocations` → `sale_payment_item_allocations`）时
> 把「全局大卡 / by store」一并留在了 allocation 口径，同时把 `consistency.efficiency.test.ts`
> 的守护断言从「保留 role_type 白名单」反向改成「不按白名单截断」。因该断言是**文件级**
> `toMatch`、分不清 Part A/B 与 Part D，两边都写 `spia` 时恒绿，缺陷存活两个月，
> 表现为 KPI 与同页门店榜差 111 万。现已改为按 Part 分段断言 + Part A/B 的 WHERE 子句逐字相等。

> **时间口径**：数据中心排名榜与上述区间指标统一走顶部时间维度 `col::date BETWEEN current.start AND current.end`
> （TimeRange：今日/本周/本月/今年/自定义），而非 staff 端固定 month/lastMonth/year 锚 NOW()。
> **同比/环比**：仅 KPI 卡片标量计算（本期/上期/去年同期 delta%），明细表与排名榜不做逐行对比。
>
> **基期长度口径 —— 日历同期对齐，且不得无条件取完整上一周期**（2026-09-22 登记，#283）：
>
> 环比基期（上期）与同比基期（去年同期）**都是比值的分母**，同走一个 `deltaPct`，
> 所以「基期不得长于当期」这条对二者同等适用（基期长于当期会把「当期尚未走完」误读成「下滑」）。

| preset | 当期 | 环比基期（上期） | 同比基期（去年同期） |
|---|---|---|---|
| 今日 | [今天, 今天] | [昨天, 昨天] — 恒等长 | [去年今天, 去年今天] — 恒等长 |
| 本周 | [本周一, 今天] | [上周一, **上周同一个星期几**] — 恒等长 | [去年同区间] — ⚠️ 跨闰年 **±1 天**（例外 2） |
| 本月 | [月初, 今天] | [上月 1 号, **上月同一日**] — 等长，**上月天数不足则截到上月末**，此时短 1~3 天（例外 1） | [去年同区间] — 恒等长 |
| 今年 | [年初, 今天] | [去年初, 去年同日] — ⚠️ 跨闰年 **±1 天**（例外 3） | 同环比基期 |
| 自定义 | [start, end] | 紧邻前一等长区间 — 恒等长 | [start/end 各减一年] — ⚠️ 跨闰年 **±1 天**（例外 2） |

> **三条已登记的例外**（都是日历固有，不是口径错，但别再声称"所有预设无例外"）。
> 例外 1 是 #283 修法自带的日历副作用（有意接受），例外 2、3 是既有缺陷、尚未修复：
> 1. **本月 clamp**（`previous`，#283 引入、有意接受）：3/31 看本月要的是「上月第 31 天」，
>    2 月没有 → 基期落到 2/28，短 3 天。每年只有 3/29~3/31、5/31、7/31、10/31、12/31
>    共约 6~7 天命中；**日均营收持平**时最坏 3/31 平年虚增约 +10.7pp（31 天比 28 天）。
>    **不得改成「按日均折算」**——那是拿估算值冒充实际值，与本节「数据缺失一律 `--`、
>    不做估算填补」相悖，且换算后的数字无法对账到任何一天的真实流水。
> 2. **本周 / 自定义的同比基期跨闰年**（`lastYear`，既有，**尚未修复**）：区间跨 2 月底时，
>    去年同区间可能多/少含一个 2/29。逐日扫描 5 个代表年份（2023/2024/2025/2026/2029）
>    共 1826 天，命中 **9 天**（+1 天 6 次、−1 天 3 次）。窗口极窄，但「本周」的当期在
>    月初只有 2~5 天，**1 天的差就是巨幅偏差**：
>    2024-03-01 当期 5 天 vs 基期 4 天 → 基期偏短、同比**虚高 +25%**（扫描集内最坏）；
>    2029-03-01 当期 4 天 vs 基期 5 天 → 基期偏长、同比**假下滑 −20%**。
>    扫描集**外**的近期锚点更坏：2028-03-01 当期 3 天 vs 基期 2 天 → **虚高 +50%**
>    （2028 不在上述 5 个代表年份里，却是从 2026 往后的下一次触发年）。
>    ⚠️ +50% 也**不是理论上界**——1900–2200 全历法最坏正偏差是 2044/2072-03-01 型的
>    「当期 2 天 vs 基期 1 天 = **+100%**」，负向最坏 −33%。
>    且此时同比基期的起止星期也漂了，「去年同周」并非同一周。
>    ⚠️ `自定义` 的输入是任意区间，**不能沿用上面的命中频率**——任何跨 2 月底的自定义区间
>    都可能命中，短区间的量级同样可以很大。
> 3. **今年跨闰年**（`previous` = `lastYear`，既有，**尚未修复**）：当年平年而上一年闰年时，
>    基期含 2/29 而当期没有，基期**长 1 天**（2025 / 2029 型，首例 2025-03-01：当期 60 天
>    vs 基期 61 天）；当年闰年则反向**短 1 天**（2024 / 2028 型，首例 2024-03-01：61 vs 60）。
>    每次命中 306/365 天（3 月起到年末）。最大绝对量级约 **1.7%**。
>    ⚠️ 从 2026 往后 **2028 先触发**（基期偏短、同比虚高），**2029 才是基期偏长**
>    （假下滑方向，即违反「基期不得长于当期」的方向）。
>    改它属同比口径变更（`year` 的环比与同比共用同一区间语义）。
>
> **例外 2、3 同源于 `addYears()` 的 2/29 归一化**（JS 把 2023-02-29 归一化成 2023-03-01）。
> 该归一化还会让**端点语义**漂移，且不限于长度会变的分支 —— 2024-02-29 当天：
>
> | preset | 当期 | 同比基期 | 长度 |
> |---|---|---|---|
> | 今日 | [02-29, 02-29] | [2023-**03-01**, 2023-03-01] | 1 对 1（比的是去年 3/1，非惯例的 2/28） |
> | 本月 | [02-01, 02-29] | [2023-02-01, 2023-**03-01**] | 29 对 29（长度守恒，但已不是"去年同月截至同日"） |
> | 今年 | [01-01, 02-29] | [2023-01-01, 2023-**03-01**] | 60 对 60 |
>
> 所以「本月的同比基期恒等长」这个断言不会红，但**别把"等长"误读成"端点语义也对齐"**。

> ⚠️ 基期**不是**「整段上一周/上一月」。上方「时间窗口补充（sales-data 页专用口径）」那张表里的
> 「上月 = 上月初~上月末」是 staff 端 `VALID_PERIODS=['month','lastMonth','year']` 的**三选一并列时间维度**
> （用户主动选「上月」看整月），**不是比值的分母**，不得搬来当环比基期 —— 那会拿 N 天的当期比整月的基期，
> 月初/周初徽章恒显巨幅下滑，且实测出现过方向翻转（#283：服务人次显示 −16.6% 下滑、真实 +16.8% 增长）。
>
> 「本月」与「自定义同起止日」的环比值**本就不同**（前者比上月同期、后者比紧邻前一等长区间），这是语义差异而非缺陷。
>
> **基期为负时 `(cur-base)/base` 符号会翻转** —— 2026-09-22 只读库实测（南昌梦祥店「本周」业绩）：
> 基期 −2,646.00、当期 +264.00（已从负回正），旧式算出 **−109.98%**，徽章渲染成红色下滑，方向恰好反了。
> 所以有一条**硬约束：不再输出任何基于负分母的百分比**，无论怎么包装都不能出数。
>
> #### 负基期 / 零基期展示矩阵（2026-09-23 拍板，#310 #315，**全站统一**）
>
> | 基期 | 当期 | 文案 | 配色 |
> |---|---|---|---|
> | `base > 0` | 任意 | 正常百分比 | 按 delta 正负 绿 / 红 / 灰 |
> | `base < 0` | `cur > 0` | **由负转正** | 🟢 绿 |
> | `base < 0` | `cur <= 0` | **未转正** | 🔴 红 |
> | `base === 0` | 任意 | `--` | ⚪ 灰 |
> | 当期/基期为空或非有限（`NaN` / `±Infinity`） | 任意 | `--` | ⚪ 灰 |
>
> 此前 admin 把 `base <= 0` 一律压成 `--`（PR #305），虽然挡住了假数字，但**丢失了店长最关心的
> 一类信息**：由负转正的巨大改善——上面那个实测案例里，店长只能靠翻明细表才知道本周已回正。
>
> 两处刻意的取舍（拍板时标注过，可回退）：
> 1. 文案用「未转正」而非「仍为负」——`base < 0 → cur === 0` 是从负数回到零，严格说不是「仍为负」；
>    「未转正」同时涵盖 `cur < 0` 与 `cur === 0`，措辞不会说谎。
> 2. `base = −1000 → cur = −500`（亏损减半但仍亏）归入「未转正」红。依据是**按当期值本身正负着色**。
>    已知代价：「亏损收窄」这个改善看不出来。
>
> **伪持平**（2026-09-23 拍板，#314 问题 2）：按展示精度舍入后为 0 的一律并入「持平」（灰），
> 不再输出带符号的 `+0.00%` / `↑ 0%` 这种「涨了、涨幅是 0」的自相矛盾展示。
> ⚠️ **实现状态不齐**：admin 两处（数据中心 + 首页看板）已落地；
> **analyst 尚未实现** —— `metric-delta.ts` 目前只处理真 `delta === 0`，
> 舍入后为 0 的仍输出 `+0.0%`。那属于 #314 问题 2 的范围，本轮未做，别当成已全站生效。
> ⚠️ 已知代价：真实值非 0 却显示「持平」，`500,010 vs 500,000` 与 `500,000 vs 500,000` 显示同一个词。
> ⚠️ **各站点展示精度不同，阈值随之不同，别互抄**：admin 数据中心 `toFixed(2)`、admin 首页看板整数、
> analyst `toFixed(1)`。同一个 `+0.4%` 在数据中心出数、在首页看板是「持平」。
>
> #### 三处实现与刻意分叉
>
> **⚠️ 本节是跨站点规则，不只管 admin 数据中心。** `fengyu-analyst`（独立部署的经营分析站，
> 复用 admin 的库与认证）有一份**完全独立**的实现，与 admin **没有目录共享、没有 snapshot 守护**，
> 当初就是因为无人登记这条口径而把同一个符号翻转缺陷重写了一遍（#307）。
>
> | 站点 / 模块 | 负基期展示 | 备注 |
> |---|---|---|
> | admin 数据中心 `lib/delta-display.ts` + `DeltaBadge` | 由负转正 / 未转正 | 精度 `toFixed(2)` |
> | admin 首页看板 `TrendArrow` | 同上（共用 `delta-display.ts`） | 精度整数；#315 纳入 |
> | analyst `src/lib/metric-delta.ts` | 文案「无基数」，**仍按 `current > prevYear` 判绿/红** | **有意分叉** |
>
> analyst 的分叉是有意的：两站点指标集不重叠（admin 是门店业绩等，analyst 是新客漏斗首单/年度贡献），
> 不会对同一现象给出相反结论。**别当漏改去"统一"。**
> （analyst 对齐到本矩阵属独立工作，**#314 未做**、仍待排期；但那边的 `rate` 型零基期与伪持平
> 已随 #314 落地，另有拍板，见下面的「analyst 的两条本地例外」。）
>
> ⚠️ **analyst 站内还有第二条渲染路径**：AI 助手回答 `src/lib/assistant-answer.ts` 的
> `formatSignedRate`，与看板吃**同一个** `repurchase.ts` 的 `kpi.delta`。它曾是逐字重写的第二实现
> （同一数值看板出「持平」、助手出 `+0.0pct`，且不挡 `NaN`），**2026-09-23（#314）已收敛**为消费
> `metric-delta.ts` 的无前缀内核 `formatPointDeltaValue`。**勿再抄第三份**——
> 占位文案可以各留各的（助手用「无同比」，是 AI 回答里的措辞），但数值渲染必须走同一个内核。
>
> ⚠️ **口径差（登记，非缺陷）**：admin 对 `unit === 'percent'` 的 KPI **也走除法**
> （相对变化 `%`），analyst 的 `rate` 型走**减法**（百分点 `pct`）；且 admin 零基期恒 `--`、
> analyst `rate` 零基期出数。两站点指标集不重叠，不会对同一现象给出相反结论。
> 另「持平」这个字面量在 analyst `metric-delta.ts` 与 admin `src/lib/delta-display.ts`
> **各有一份**（跨端共享目录已 veto），两边字面量须一致，靠各自的文案锚定测试守护。
>
> ##### analyst 的两条本地例外（2026-09-23 拍板，#314）
>
> **① `rate` 型（百分点差值）零基期照常出数，不算「算不出」。**
> 上面「基期 `<= 0` 算不出」那条的依据是**除法**会翻转符号 / 除零，而 `rate` 型走的是
> `current − previous` **减法**，不需要非零分母。所以 analyst 的两道基期守卫都排在 rate 分支之后：
> `0% → 30%` 出 `+30.0pct`（绿）、`30% → 0%` 出 `-30.0pct`（红），涨跌两侧对称。
> 此前 `previous === 0` 排在前面，导致**只藏涨、不藏跌**。
> 该例外**只管 analyst 的 `rate` 型**；analyst 自己的 `count` / `money` 型与 admin 全部指标不变。
>
> > ⚠️ **已知代价：同比 `rate` 徽章在相当长一段时间里显示的是割点伪影，不是经营变化。**
> > `service_orders`（已完成）最早只到 **2026-07-08**，而新客入口日期走首单
> > （`sale_orders` 回溯到 2022-08），分子分母不同源 → 2022–2025 共 **1,352 个新客到店恒为 0**。
> > 放开后**集团级到店率同比会渲染出约 `+86.7pct` 的绿色徽章**
> > （2026 年 3,156/3,639 = 86.7%）。这是**知情选择**——拍板人读过该数据后仍取本方案，
> > 理由是割点属全站问题、已由 **#289** 立案跟踪，不该由单个徽章承担。
> >
> > ⚠️ **别把失效日期写成某个固定日子**：同比基期是当期平移 12 个月，2027 年 1–6 月查询的
> > 同比基期落在 2026 年 1–6 月，**仍受割点影响**；「今年 / YTD」这类区间更会长期混入割点前月份。
> > 准确判据要按**到店观察窗**分三态——设该窗为 `[entry_date, entry_date + 90 天]`（两端闭）：
> > `window_end < 2026-07-08` → 到店**恒为 0**（**假零基期**；截至 2026-09 受影响区间全是这一形态
> > ——入客 2026-04-09 才是首个 `+90 天` 够得着割点的日子，同比对应 **2027-04-09** 起才会出现下一种）；
> > `window_start < 2026-07-08 <= window_end` → 到店**可能被低估**；
> > `window_start >= 2026-07-08` → 干净。
> > 合起来就是 **`entry_date < 2026-07-08` 的新客都不可信**（`entry_date` 恰为割点当日的则是干净的）。
> > ⚠️ 别写成「与 2026-07-08 重叠」（只覆盖跨线那一种，漏掉最严重的「恒为 0」），
> > 也别写成「落在割点前的基期都是 0」（跨线那一种是低估不是归零）。
> > 量化依据见 issue #314 评论 `issuecomment-5788019145`。**别拿这份数据回头推翻本条口径。**
>
> > ⚠️ **第二类零基期与割点无关，割点补齐后也不会消失。**
> > `safeRate(n, d) = d > 0 ? round4(n/d) : 0`（`new-customer-funnel-utils.ts`）把
> > 「**分母为 0，算不出**」与「**真实 0%**」压成同一个 `0`。于是
> > 「去年同期一个新客都没有」的门店 × 月窄切片（分母 0）、
> > 以及 `memberConversionRate`（分母是 `arrivedCount`）在「有新客但零到店」时，
> > 都会渲染成绿色的 `+X pct`。这类切片**长期存在**，割点过去后也不会消失。
> > 治本方案（`safeRate` 返回 `number | null`，三态区分「真实 0%」「算不出」「数据缺失伪影」）
> > 登记为未来选项——**在那之前，同比 rate 徽章的绿色不可直接当经营结论用。**
>
> **② 伪持平并入「持平」。** `toFixed(1)` 把极小的真实变化舍成 `0.0` 后仍带符号前缀，
> 会渲染出 `+0.0%` / `-0.0%`——「涨了、涨幅是 0」自相矛盾（`-0.0%` 不来自 `-0`，
> 来自 `(-0.0002).toFixed(1)`）。现一律并入「持平」且**配色跟着变灰**。
> 判据是**印出来的那个数**而非原始 delta：`Number(scaled.toFixed(1)) === 0`。
> ⚠️ 代价是精度损失：`500,100 vs 500,000`（真实 +0.02%）与 `500,000 vs 500,000` 显示同一个词。
> ⚠️ 阈值随展示精度走，**别跨站点互抄**：analyst 是 `toFixed(1)`，admin 数据中心 2 位、首页看板整数。
>
> **③ 文案与配色必须同源。** analyst 的 tone 读「实际印在徽章上的那个数」而不是自己重算方向，
> 否则会出现「持平 + 绿色」「`+30.0pct` + 灰色」这类自相矛盾组合。
> 没印出数字（文案「无基数」）时才退而用两期差值补方向，而**四种成因里只有负基期允许这么做**：
> 零基期、非有限入参、溢出一律弃判置灰。⚠️ 早先只按「有没有印出数字」判，
> 溢出会顺着负基期这条路径被涂成绿色（#314 闸门 2 揪出）。
>
> **再写第三个看板要算增幅时**：admin 内**一律 import `@/lib/delta-display`**（#310/#315 起它是
> admin 全站单一真相源，数据中心与首页看板共用，别再抄第三份）；analyst 内走 `metric-delta.ts`
> （AI 助手侧走它导出的 `formatPointDeltaValue` 内核）；
> 全新站点把本节矩阵先抄进它自己的模块头——本节是唯一的口径真相源。

## 顾客剩余卡项清单（admin 数据中心经营明细，#371）

> 当前快照，不设期间；按卡的**权益门店**（`sale_items.store_id`）归属 scope。取数 `fengyu-admin/src/lib/data-center/remaining-cards-query.ts`（单语句、同一快照），
> 格态 / 指标 / 搜索 / 排序 `remaining-cards.ts`。页面、取数 action、导出视图 `report-remaining-cards` 三处都要求
> `data_center:dashboard` + `data_center:customer_detail` 由同一条角色授权提供。☆ = 默认口径，交付前待甲方确认。

| 项 | 口径 |
|----|------|
| 卡行 | `lib/card-entitlement.ts` 基础集（购买行或转换单转入行 ∩ 订单 `已支付/部分支付/已完成` ∩ `疗程卡` ∩ 余次非空，与 /cards 卡包同源）∩ 未退完（同 `getCustomerHeldCards` 守卫）∩ 寄存单只计 `已支付`（待审批 / 已作废不计）∩ `legacy_source IS NULL`（WorkFine 历史单不产生格子）|
| 行 | 顾客 × 卡权益门店；全局没有任何计入卡行的顾客按 `bound_store_id` 出一行（无绑定门店的不出行）☆ |
| 列 | 当前范围内有人持卡的二级品项，按（一级 `sort_order`，二级 `sort_order`）排；一级行 = `product_categories.product_kind IS NULL`。卡行只取 `疗程卡`，家居不进矩阵。无分类 SKU 归「未分类」列 |
| 剩余次数 ☆ | Σ已付未用（`paidUnusedSessionsExpr`），剔除已退完、已过期（`expire_date < 上海今天`，#291）的卡行。不计欠款未付次数（原型原文为物理剩余） |
| 格态 ☆ | 未过期卡行：Σ已付未用 > 0 → 有剩余（✓）；否则 Σ物理剩余 > 0 → 待付清（#122）；否则 → 已服务完（含整格被折抵转出）。只剩过期卡行 → 已过期；没有卡行 → 未买过（留空）|
| 悬停 | 有剩余：剩余 N 次未服务（已服务 x 次）；待付清：未付 M 次；已服务完：已服务 x 次（有折抵附「已折抵转出 K 次」）。x = 已完成服务单 Σ`session_used`；K = 未关闭转换单转出行 Σ`quantity`。含寄存行附「含迁移寄存」；订单有待审批退款附「有在途退款，次数暂未扣减」并加「冻」角标（不扣数量）☆。不显示总次数 y ☆ |
| 指标卡 | 范围全量，不受搜索 / 显示范围影响：统计顾客数（去重）、有剩余卡项顾客（行剩余 > 0 去重，附占比）、待服务剩余次数（附涉及二级数）、有余额 / 已服务完（hint 带待付清）/ 未买过（含已过期）项次 |
| 勾稽 | 行合计 = 各格之和；表尾每列 = 当前筛选结果全部分页之和；无搜索时表尾总计 = 待服务剩余次数；四态项次之和 = 行数 × 列数 |
| 搜索 | 服务端：姓名 / 门店 / 会员等级（`member_level` 与 `customer_type` 都匹配）模糊；手机号只认 11 位完整号码、原值精确匹配（防从脱敏号码反推）|
| 排序 | 剩余次数（默认降序）→ 姓名（zh-CN collator）→ 顾客 id → 门店 id（#282）|
| 性能 | 只读事务内 `SET LOCAL jit = off` + `enable_nestloop = off`：prod 2026-09-25 全国 3.3s → 0.62s（执行时间）|
| 与品项板「持卡人数」的差异 | 品项板按 `paid_sessions > 0`（含已用完），约 5.0 千人；本页「有剩余」按已付未用 > 0，约 4.3 千人。续存页「持卡会员数」口径见 #287；另品项板 scope 按订单门店 `so.store_id`，本页按权益门店 `si.store_id` |
| 已知边界 | 只在已停用门店持卡的顾客：卡行被 scope 的在营门店条件剔除，又因「全局有卡」不按绑定门店出行，任何范围都看不到（prod 2026-09-25 实测 0 人）；一级分类名与「未分类」同名时，未分类列独立分组不合并；☆ 行口径的推论：绑定本店、但卡全在其它门店的顾客，在本店视角既无卡行也无兜底行（在卡所在门店视角可见），甲方确认行口径时一并说明 |
