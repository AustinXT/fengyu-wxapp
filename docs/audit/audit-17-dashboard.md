# 审计报告：数据看板（管理 + 员工） (17)

**审计时间**：2026-04-25
**域 ID**：17
**审计员**：claude-opus-4-7
**审计时长**：约 25 分钟
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff (mgmt) | staff (员工) | client |
|----|-------|--------------|--------------|--------|
| Schema | `db/schema/order.ts` (sale_orders/sale_items) + `service.ts` + `commission.ts` + `service-commission.ts` + `user.ts`（client_wechat_users）| 同左 | 同左 | — |
| Action/Route | `fengyu-admin/src/actions/dashboard.ts:38 getDashboardStats` | `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:516 summary` / `:895 storeRanking` / `:1183 staffRanking` / `:1242 salesData` / `:93 scopeOptions` | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:613 dashboard` | — |
| 前端 | `fengyu-admin/src/app/(main)/dashboard/page.tsx` + `_components/dashboard-page.tsx` | `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts:325` + `pages/sales-data/*` + `packageMgmt/mgmt-traffic-stats/*` + `packageMgmt/mgmt-product-cycle/*` + `packageMgmt/mgmt-customer-list/*` | `fengyu-staff/miniprogram/packageOrder/dashboard/*` | — |
| 测试 | `dashboard.test.ts:1-256` | 未发现专用测试 | 未发现专用测试 | — |
| 权威口径 | `notes/references/metrics.md`（核心定义表） | 同左 | 同左 | — |

## 2. 数据流图

```
admin.getDashboardStats(session)
   └→ requirePermission('dashboard:view')
   └→ if hasBusiness('data_center:dashboard'):
        SELECT FROM sale_orders WHERE store_id IN (scopeIds)
            ─ today_visitors = COUNT(DISTINCT client_user_id) [date(sale_order_datetime)=CURRENT_DATE, status NOT IN ('已关闭','支付失败')]
            ─ today_revenue  = SUM(total_amount)             [date(paid_at)=CURRENT_DATE]
            ─ today_paid_amount = SUM(paid_amount)           [date(paid_at)=CURRENT_DATE]
            ─ pending_orders/allocations …
        + COUNT(appointments WHERE status='待确认')
        + COUNT(service_orders WHERE status='服务中')
   └→ else: getAdminStats() — totalStores/Employees/Products/Customers (4 卡片)

staff.dashboard(payload {startDate, endDate})    -- 单店或单员工窗口看板（5 指标）
   └→ requireStaffBound (无 requireManager / 无 requireManagementLevel)
   └→ if isManager: scope = so.store_id = effectiveStoreId
       else:        scope = so.assigned_employee_id = staffWfId
   └→ footfall / headcount / revenue / consume / newMembers

staff.mgmtDashboard.summary(payload {date, scopeType, scopeId})  -- 管理层 30+ 指标
   └→ requireManagementLevel (staffLevel ∈ {hq,market} ∧ loginLevel='management')
   └→ validateScope(auth, scopeType, scopeId)
   └→ Promise.all([27 个并行 SELECT])
   └→ 详情见 metrics.md (业绩/实耗/客流/客量/新会员/项目数/销售提成/服务提成/会员数/保有会员/员工数/门店数 × today/month)
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-17-01] admin.getDashboardStats `today_revenue` 用 `total_amount` 而非 `paid_amount`，与 metrics.md 明确权威口径漂移
- **文件**：`fengyu-admin/src/actions/dashboard.ts:62-64` 与 `:84-86`
- **现象**：`today_revenue` / `yesterday_revenue` 用 `SUM(total_amount) WHERE date(paid_at)=CURRENT_DATE`；同函数 `today_paid_amount` / `yesterday_paid_amount` 才用 `SUM(paid_amount)`。前端 `dashboard-page.tsx:46-50` 把 `stats.todayRevenue` 标题为「今日业绩」直接展示给业务角色，却用了 `total_amount`（应付金额含未到账）。
- **权威口径**：`notes/references/metrics.md:13` 明确「业绩 = SUM(paid_amount)」；mgmt-dashboard `queryStoreRevenue` (`mgmt-dashboard.js:224`) 也用 `SUM(paid_amount)`。
- **风险**：admin 业务角色（manager/finance）首页业绩与员工端管理层看板**永久性**数字不一致；混合储值卡抵扣 / 部分支付等场景下 `total_amount > paid_amount`，admin 业绩偏高，财务以此对账会出错。`yesterday_revenue` / 同比箭头同样失真。
- **复现**：建一笔 total_amount=2000, paid_amount=800（其余 1200 储值卡抵扣未到账），同日比对 admin 与 mgmt summary 的业绩字段 → 差 1200。
- **修复（L7）**：admin actions 把 `today_revenue/yesterday_revenue` 切到 `SUM(paid_amount)`，并对 `total_amount` 字段重命名为 `today_total_amount` 或删除。
- **横切归类**：CC1 数值精度 / CC9 测试与残留（`metrics.md` 切换 paid_amount 时 admin 路径未跟进）

#### [P0-17-02] admin.getDashboardStats 业绩聚合 SQL 无 `sale_order_type` 过滤，退款单 / 内部单 / 回款单全部混入营业额
- **文件**：`fengyu-admin/src/actions/dashboard.ts:55-94`
- **现象**：整段 `FROM sale_orders WHERE store_id IN (...)` **不限 sale_order_type**。`saleOrderTypeEnum` 5 值（销售单 / 内部单 / 回款单 / 转换单 / 退款单），其中：
  - **退款单** `total_amount` 应为负，但 `paid_amount` 为正（payNotify 退款回写）→ today_paid_amount 把退款金额重算计入营收（资损：业绩看着只升不降）
  - **回款单 / 内部单** 不应计入业绩
  - mgmt-dashboard `queryStoreRevenue` 明确写 `sale_order_type IN ('销售单','转换单')`（`mgmt-dashboard.js:227`）
- **风险**：与 audit-11 P0-11-01 / audit-07 P0-07-02 «退款不冲销 sa/sc» 系列同源——admin 看板「业绩」对退款流入永远视而不见，业务角色看到的当日业绩偏大、月度业绩持续累计假数据。
- **修复（L7）**：所有 SUM 加 `AND sale_order_type IN ('销售单','转换单') AND status='已支付'`（与 metrics.md / mgmt-dashboard 对齐）；今日客流/昨日客流亦加 `sale_order_type` 守卫。
- **横切归类**：CC1 数值精度（口径漂移）

#### [P0-17-03] admin.getDashboardStats `today_visitors` 用 `sale_order_datetime` 而非 `paid_at`，与 metrics 中"客流"完全脱钩
- **文件**：`fengyu-admin/src/actions/dashboard.ts:57-61, 78-82`
- **现象**：`today_visitors` = `COUNT(DISTINCT client_user_id) WHERE date(sale_order_datetime) = CURRENT_DATE AND status NOT IN ('已关闭','支付失败')`。三个偏离：
  1. metrics.md `客流` 定义为 `service_orders WHERE status='已完成' [service_date]`（`metrics.md:24`），与"开单时间"无关
  2. 排除条件 `status NOT IN ('已关闭','支付失败')` 把"待支付"也算入客流，与"已完成消费"语义不符
  3. 退款单 `sale_order_datetime` 等于建退款单时间，会让退款日重复计入"客流"
- **风险**：admin 看板客流口径与员工端 mgmt-dashboard 完全不一致（mgmt-dashboard 走 service_orders）；同店 manager 在 admin 与员工端看到差距，质疑数据可信度。
- **修复（L7）**：切到 `service_orders WHERE status='已完成' AND service_date=CURRENT_DATE`，与 metrics.md 对齐。
- **横切归类**：CC1 数值精度 / CC9 测试与残留

#### [P0-17-04] mgmt-dashboard.scopeOptions 模块级 5 分钟缓存跨 OPENID 共享，离职/调店后旧账号仍可见全量市场
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:31-82 loadAllMarkets` + `:33-34 CACHE`
- **现象**：`CACHE` 是模块级单例，TTL 5 分钟，`loadAllMarkets()` 装载的是 HQ 视角全量 markets。`scopeOptions` 在第 99-107 行才按 `staffLevel='market'` 做事后过滤。但**云函数实例是冷启动后多请求共享**，CACHE 由首个请求填充。
- 实际安全性靠 `validateScope`（line 125-149）兜底：headquarters 放行；market 必须命中 roleBindings.scopeId；store 必须在 scopeStoreIds 内。**所以最终 SQL 不会越权**。
- **真正风险**：scopeOptions 返回的 markets 列表（含 stores 列表）即"信息泄露面"。`market` 账号收到的 markets[] 经过事后过滤是干净的；但 `__resetMarketsCache` 仅在测试导出（`:1503-1505`），**生产无主动失效路径**。如果业务把"市场名 / 门店列表"当 PII（公司组织树），缓存窗口期内组织变更（新建市场 / 关停门店）对 market 账号是延迟 5 分钟可见的。
- **额外风险**：和 staff auth 中间件的 5 分钟缓存（`middleware/auth.js:21-22`）配合时，admin 调店之后管理层账号在 0~10 分钟内可能看到自己原市场+新市场叠加视图。
- **修复（L3）**：scopeOptions 不缓存（每次查询轻量级，`org_nodes JOIN stores`），或缓存改为 `WeakMap` 按 OPENID 分桶 + invalidate 钩子。
- **横切归类**：CC3 组织域隔离

#### [P0-17-05] staff.dashboard 一线员工 newMembers 归属字段 `bound_employee_id` 但**业绩 / 客流 / 客量 / 实耗**用 `assigned_employee_id`，5 指标双口径
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:613-731`
- **现象**：5 指标里 4 个 SQL 用 `so.assigned_employee_id = staffWfId`（service_orders 担当员工），唯独 `newMembers` 切到 `c.bound_employee_id = $employeeId`。两字段语义截然不同：
  - `service_orders.assigned_employee_id` = 服务执行人（每单写入）
  - `client_wechat_users.bound_employee_id` = 顾客绑定的美容师（一对一长期关系，可能 NULL）
- **风险**：同一员工同一区间能出现「客流 5、新会员 0」（顾客没绑给我）或「客流 0、新会员 3」（绑给我但还没到我服务台）；店长同样存在 `o.store_id` vs `c.bound_store_id` 的对子。本身字段都对，但 5 指标共置一卡，业务方会以为是 bug。
- **审计判定**：metrics.md:56 明确员工新会员按 `bound_employee_id` 归属（与 mgmt staffRanking 一致），所以本设计合规——但**这个语义跳变没有任何 UI/注释提示**，对账时极易误读为 bug。
- **修复（L9）**：UI 卡片加角标「按绑定关系」+ tooltip 说明；`README` / metrics.md 已说明的事实需在前端 patch UI。或修改后端把 newMember 归属改为「员工服务过的、且区间内首次成为会员」更符合"我的指标"心智（但需业务侧决策）。
- **横切归类**：CC1 数值精度（同 metric 多归属）

#### [P0-17-06] staff.dashboard 美容师 newMembers SQL 缺 store_id scope，跨店挪卡场景下越权
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:706-722`
- **现象**：美容师分支 `newMemberFilter='c.bound_employee_id = $1'`，**没有任何门店过滤**。员工调店后 `staff_wechat_users.store_id` 切到 B 店，但 `client_wechat_users.bound_employee_id` 没解绑，A 店历史顾客的 became_member_at 仍然计入员工"新会员"统计——属"自己的旧客算自己"是合理的，但**多店店长以管理层 / 多店店长身份登录时**，store_id="A 店", `assigned_employee_id` 也只看 A 店，唯独 `newMembers` 跨全集（员工绑定无门店维度），呈现"newMembers 比客流大"的逆数关系。
- **修复（L3）**：员工分支 newMember SQL 应额外限定 `c.bound_store_id = effectiveStoreId`（管理层模式 NULL → 跳过加 `IS NOT NULL`），与其他 4 指标同店窗口对齐。或者保留全集但前端注脚说明跨店归属。
- **横切归类**：CC3 组织域隔离

### 3.2 P1（数据一致 / 状态错乱）

#### [P1-17-07] staff.dashboard 店长分支 revenue 用 `SUM(si.received)` 而非 metrics 权威 `SUM(paid_amount)`
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:664-672`
- **现象**：店长 revenue = `SUM(sale_items.received)`，与 mgmt-dashboard `queryStoreRevenue` 用 `SUM(sale_orders.paid_amount)` 不同；与 metrics.md:13「业绩 = SUM(paid_amount)」也不同（received 是 sale_items 行级实付小计）。
- **细节**：metrics.md:18 注脚有「门店业绩 vs 生美业绩为何用不同口径」，明确`paid_amount` 才是订单层（已含转换/回款抵消）。`SUM(received)` 不能反映 paid_amount 与 received 的差异（如优惠券）。
- **风险**：店长在工作台看到的"今日业绩"与同店 manager 在 admin / mgmt-dashboard summary 看到的不一致（差额 = 全店订单的 paid_amount - sum(received)，通常等于券抵扣 / 储值卡抵扣 / 退款冲销）。
- **修复（L3）**：店长分支同步切到 `SUM(o.paid_amount) WHERE o.sale_order_type IN ('销售单','转换单') AND o.status='已支付'`。

#### [P1-17-08] staff.dashboard / staff.todayCommission 等"今日"用 JS Date 边界 vs PG NOW，跨午夜窗口漂移
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:156-160` (todayCommission) + `:248-256` (monthlyCalendar) + `:445-447` (performanceDetail)
- **现象**：todayCommission 用 `new Date(now.getFullYear(), now.getMonth(), now.getDate())`（**云函数所在容器时区**）；monthlyCalendar 用 `monthStart.toISOString().slice(0, 10)`（UTC 强制）；mgmt-dashboard `summary` 用 PG `$date::date`（业务方传值）。三者在北京时间 00:00–08:00 跨午夜窗口可算出**三个不同的"今日"**。
- **关联**：与 audit-02 P0-02-02、audit-05 P1-05-14、audit-06 P1-06-07 同模式。
- **修复（L3）**：staff.js 全部时间窗口改为 `AT TIME ZONE 'Asia/Shanghai'` 或显式传 `selectedDate`，参考 mgmt-dashboard 实现。

#### [P1-17-09] mgmt-dashboard `salesData` 与 `summary` 顾客分型用 `customer_type` 当前快照，新会员/老会员历史漂移
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:1284-1357`
- **现象**：分客型业绩/实耗/产品出库三块 SQL 都 JOIN `client_wechat_users` ON `c.user_id = o.client_user_id`，按 `c.customer_type`（当前快照）+ `c.became_member_at`（历史化）混合判定。
  - `customer_type` 是 cron 跑的当前快照（与 audit-10 P0-10-05 同样问题）
  - 看历史月份时，去年 11 月以"流量客"身份消费、今年 4 月升级为"小美客"的顾客，会被归到"小美客业绩"列（按当前快照），与"那个时点的他/她"不一致
- **设计文档已知**：metrics.md `D-4=A`（line 280-281）已显式接受了这个不一致并标注"T2 历史化落地后切换"。但 T2 已落地（became_member_at 历史化），salesData 的 `customer_type` 仍未跟进。
- **修复（L3）**：把"小美客"也加 became_xiaomei_at 时间戳（schema 改动），或文档注脚明示当前快照口径，前端 UI 加角标。

#### [P1-17-10] admin.getDashboardStats `pending_allocations` 仅按 status='已支付'，未排除 sale_order_type='退款单' / '内部单'
- **文件**：`fengyu-admin/src/actions/dashboard.ts:74-77`
- **现象**：`pending_allocations` = `COUNT(*) WHERE status='已支付' AND allocation_status='待分配'` 不限 sale_order_type。退款单 paid 后 `allocation_status` 默认 `'待分配'`，会被计入 pending；内部单同理。
- **风险**：业务角色看到 pending_allocations 数字虚高，跳到 /allocations 页面发现"什么都不能分"或要手工跳过这些类型，体验差。
- **修复（L7）**：加 `AND sale_order_type IN ('销售单','转换单')`。

#### [P1-17-11] mgmt-dashboard `summary` 全程不含 `sa.allocation_status` 过滤，退款单 sa 可能被算入业绩提成收入
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:322-355 querySalesCommissionIncome / queryServiceCommissionIncome`
- **现象**：sql 已经写 `sale_order_type IN ('销售单','转换单')` 排除了退款单。但 audit-07 P0-07-02 揭示：当退款单审批时，**原销售单的 sa 行不冲销**。所以"销售提成收入" 永远 = 全部历史销售（含已退款）的 total_amount 之和。
- **风险**：销售提成口径在退款发生时**不会下降**（与 metrics.md:41 注脚"退款单 total_amount 为负数自动相互抵销"实际不成立——因为 audit-07 P0-07-02 的退款单本身没有 sa 行，原 sa 也没冲销）。
- **修复（L0+L3）**：依赖 audit-07 P0-07-02 修复（退款审批时把原 sa 标 is_void=TRUE 或写负值 sa）。本身 SQL 端无独立修复。

#### [P1-17-12] admin getDashboardStats 仅 `requirePermission('dashboard:view')`，业务分支无 isInScope 守卫
- **文件**：`fengyu-admin/src/actions/dashboard.ts:39-50`
- **现象**：业务分支判定靠 `session.permissions.actions.includes('data_center:dashboard')`，scopeIds 来自 `session.permissions.scopeStoreIds` 由 expandScopeStoreIds 解析。如果一个 admin 用户**同时**有 `'admin'` + 任意一个 manager 的 store-scope role binding（边角配置错误），`isAdminScope` 返回 true，但 hasBusiness 走业务分支（因为 actions 累积了 manager 的 'data_center:dashboard'）→ 进入业务分支后 scopeIds 是 manager 视图的子集，admin 用户看到了不完整数据，体验有 bug。
- **风险**：低概率，但 PERMISSION_MATRIX 不强制互斥，历史 / 错配账号可能踩到。
- **修复（L7）**：加 `if (isAdminScope(session)) return getAdminStats()` 优先级。

#### [P1-17-13] mgmt-dashboard.summary `queryNewMembers` 走 `bound_store_id` scope，未与 SQL2/4/5 的 `o.store_id` scope 对齐
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:366-377`
- **现象**：queryNewMembers 用 `buildClientScope` 按 `c.bound_store_id` 过滤；其他业绩/实耗 SQL 用 `buildSaleScope` 按 `o.store_id` / `so.store_id`。同一顾客在 A 店绑定但在 B 店开单时：
  - "新会员"归 A 店（顾客绑定店）
  - 这个新会员的"业绩"归 B 店（开单店）
- **风险**：店均"新会员转化业绩"等派生指标失真；跨店服务/挂客场景的业务诊断会困惑。已在 metrics.md:309-311 显式接受（"分子分母 store_id 来源不同... 接受当前精度"），但派生指标如 monthlyAvgPerStore 会有微小漂移。
- **修复（设计层）**：维持现状 + 文档注脚已有；建议把"新会员经营"页（metrics §5）的派生派生加角标提示。

### 3.3 P2（代码质量 / 可维护）

#### [P2-17-14] mgmt-dashboard scope helper `validateScope` 不返回市场账号 staffLevel='market' 时 scopeType='all' 的报错前缀缺 `PERMISSION_DENIED:` 全局规范前缀但拼接位置不一致
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:130, 137, 144`
- **现象**：错误前缀符合（用 `PERMISSION_DENIED:`），但 INVALID_PARAMS（line 522, 524, 528, 1249, 1252, 1255）未包含约束 path 信息（如「scopeType 必须是 all/market/store」无 received value）。前端调试不便。
- **修复（L3）**：在抛错时加 received: `INVALID_PARAMS: scopeType 必须是 all/market/store, received=...`。

#### [P2-17-15] mgmt-dashboard.summary 27 个并行 query 全部独立 connect，一次请求 27 次连接获取
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:551-579`
- **现象**：所有 query 都是 `pg.query(...)` 走连接池；`pg.js` 默认 `max:5`。27 个并行 → 5 个并行执行，22 个排队。`elapsed > 800` 时打 slow warn，没有直接性能 bug，但体感有可能突破 800ms 阈值。
- **缺**：无 EXPLAIN ANALYZE 实验数据；无 materialized view / cache；每次刷新页面都全量重算。
- **修复（L3）**：合并为更少的复合 SQL（CTE + 多 FILTER），或引入"今日聚合"materialized view + 24h 内增量更新。

#### [P2-17-16] staff.dashboard.todoList 店长分支 `from_store_id` 列名（line 368）属 v3 老 schema
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:367-371`
- **现象**：`store_unbind_requests WHERE from_store_id = $1`。schema 待 audit-12 已确认 `from_store_id` 是 schema 列，但 audit-12 P0-12-01 里 client `requestUnbind` 写不存在的 `from_store_name`。本路径列名正确，仅记录验证一致。

#### [P2-17-17] admin.getDashboardStats SQL 无参数化 `${ids.map(...)}` 直接拼接
- **文件**：`fengyu-admin/src/actions/dashboard.ts:93, 99, 105`
- **现象**：`store_id IN (${sql.join(scopeIds.map(id => sql`${id}`), sql`, `)})`。`sql\`${id}\`` 是 drizzle 的参数化构造（最终会变 $1, $2…），所以**实际是参数化**，不是字符串拼接。但模式不同于 `inArray(table.storeId, ids)` 风格（项目其他模块的标准），可读性差。
- **修复（L7）**：改为 `inArray(saleOrders.storeId, scopeIds)` 或直接用 `scopeCondition(session, saleOrders.storeId)`。

#### [P2-17-18] mgmt-dashboard.staffRanking `producer_employees` CTE 锚点固定 `NOW()`，与首页 employeeCount 历史化锚点 `$date` 不一致
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:953-968` vs `:442-455`
- **现象**：metrics.md:61 注脚已明确"锚点为 **NOW()**... 与 employeeCount selectedDate 历史化口径**字段一致但锚点不同**"。设计已知。但前端 UI 对此没有 tooltip 提示——业务方看 staffRanking 时如果搭配 history selectedDate 思考"那一天的产能员工"会得到错误结论。
- **修复（L9）**：mgmt-dashboard staffRanking tab 加角标"基于当前在职员工"。

#### [P2-17-19] admin dashboard 5 卡片中"待处理订单 / 待确认预约"在前端 metricCards 同时出现在小卡和待办列表，重复展示
- **文件**：`fengyu-admin/src/app/(main)/dashboard/_components/dashboard-page.tsx:36-72`
- **现象**：metricCards 4 张卡里第 3、4 张是 pendingOrders / pendingAppointments，下面 todoItems 又把同样数字重复展示。UX 冗余。
- **修复（L9）**：去重，或顶卡显示总览数字，待办列表只展示具体明细。

## 4. 跨端不一致

| 维度 | admin | staff (mgmt) | staff (员工) | 风险 | 优先级 |
|------|-------|--------------|--------------|------|--------|
| 业绩公式 | `SUM(total_amount)`（漂移）| `SUM(paid_amount) WHERE sale_order_type IN ('销售单','转换单')` | 店长 `SUM(received)`，美容师 `SUM(sa.total_amount)` | 三套公式 → 同店三处看到不同业绩 | P0 |
| 客流公式 | `COUNT DISTINCT client_user_id from sale_orders [date(sale_order_datetime)]` | `COUNT DISTINCT client_user_id from service_orders WHERE status='已完成'` | 同 mgmt（按 service_orders）| 客流定义两端不同，admin 把开单都计 | P0 |
| 时间窗口 | `CURRENT_DATE` (PG NOW) | `$date::date` (业务传) | `new Date(...)` JS 容器时区 + ISO UTC | 跨午夜窗口三端"今日"不同 | P1 |
| 退款单是否计入业绩 | 计入（漏过滤）| 不计入 | 美容师走 sa（依赖 sa is_void）| admin 业绩永久虚高 | P0 |
| 5 指标归属字段 | — | 多 SQL 用 store_id；newMember 用 c.bound_store_id（市场漂移）| 美容师 newMember 走 c.bound_employee_id；其他 4 走 service_orders.assigned_employee_id（双口径）| 同卡数据语义跳变 | P0 |
| 鉴权 | `requirePermission('dashboard:view')` 单层 | `requireManagementLevel` + validateScope（强）| `requireStaffBound`（最弱，非 manager 也能查所在店）| staff.dashboard 入参 effectiveStoreId 可能在管理层模式下为 null → revenue SQL `WHERE store_id IS NULL` 命中空集 | P1 |
| 缓存 | 无（每次实时算）| `loadAllMarkets` 5min 模块级 + auth 5min | 无 | mgmt 缓存跨账号 | P0 |
| 项目数 sales_category 过滤 | 无相关指标 | `sales_category IN ('自销自耗','他销自耗')`（一致）| 无该指标 | — | — |

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] **CC1 数值精度**：admin 业绩用 total_amount + 不过滤退款单（**P0-17-01 / P0-17-02**）；staff.dashboard 店长分支用 sale_items.received 与 metrics 不同（P1-17-07）；同 metric 多归属字段（P0-17-05）
- [x] **CC2 并发幂等**：mgmt 27 query Promise.all 内部无事务但全部 SELECT，幂等；admin SSR 每次 force-dynamic 重算无重复写入风险
- [x] **CC3 组织域隔离**：scopeOptions 模块级缓存跨 OPENID（P0-17-04）；staff.dashboard 美容师 newMember 缺 store_id（P0-17-06）；mgmt-dashboard newMember 用 bound_store_id 与业绩 store_id 不对齐（P1-17-13）
- [x] **CC4 后端鉴权**：admin 缺 isAdminScope 短路（P1-17-12）；mgmt-dashboard `validateScope` 显式三层校验（设计良好）；staff.dashboard 仅 requireStaffBound（无 manager-only / management-level 区分），属业务设计可接受
- [ ] **CC5 错误码**：所有错误前缀符合 4 项约定 ✅
- [ ] **CC6 PII**：dashboard 全程聚合数字不含 phone / openid，无 PII 泄露
- [x] **CC7 时间字段**：staff.js dashboard / todayCommission / monthlyCalendar 三端时区漂移（P1-17-08，与 audit-02 / audit-05 / audit-06 同源）
- [ ] **CC8 WXML/Vant**：dashboard 主页面与 packageMgmt 子页有 retainRate / 持卡占比统一走 formatPercent（metrics.md 已强制）；本审计抽样符合
- [x] **CC9 测试与残留**：dashboard.test.ts 256 行未发现"测试反向锁死错误行为"，但**也未覆盖 P0-17-01/02/03 的口径不一致**——即测试未断言 admin 与 mgmt 的口径必须一致；mgmt-dashboard 无独立测试（路由级与 audit-15/16 同模式：cron 与 admin 已测，staff 模块路由测试稀缺）

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L3 staff routes | `mgmt-dashboard.js:31-82` | scopeOptions 移除模块缓存或按 OPENID 分桶 | P0-17-04 |
| L3 staff routes | `staff.js:706-722` | 美容师 newMember SQL 加 `c.bound_store_id` 过滤 | P0-17-06 |
| L3 staff routes | `staff.js:664-672` | 店长 revenue 切到 `SUM(o.paid_amount)` 并加 sale_order_type 过滤 | P1-17-07 |
| L3 staff routes | `staff.js:156, 248, 445` | 时间窗口统一用 PG `NOW() AT TIME ZONE 'Asia/Shanghai'` 或 selectedDate 入参 | P1-17-08 |
| L7 admin actions | `dashboard.ts:62-91` | today/yesterday_revenue 切 `SUM(paid_amount)`；全 SQL 加 `sale_order_type IN ('销售单','转换单') AND status='已支付'` | P0-17-01 / P0-17-02 |
| L7 admin actions | `dashboard.ts:57-82` | today_visitors 切到 `service_orders WHERE status='已完成' AND service_date=CURRENT_DATE` | P0-17-03 |
| L7 admin actions | `dashboard.ts:74-77` | pending_allocations 加 `sale_order_type IN ('销售单','转换单')` | P1-17-10 |
| L7 admin actions | `dashboard.ts:43-48` | isAdminScope 优先短路，避免 admin + manager 双角色错配 | P1-17-12 |
| L7 admin actions | `dashboard.ts:93,99,105` | 改为 `inArray()` 或 `scopeCondition()` 风格 | P2-17-17 |
| L9 admin UI | `dashboard-page.tsx:36-72` | 去重待处理订单/预约的双展示 | P2-17-19 |
| L9 staff UI | `mgmt-dashboard.ts` rankings tab | 加 "基于当前在职员工" 角标 | P2-17-18 |
| L9 staff UI | dashboard 卡片 | newMembers 卡片加 "按绑定关系" 角标 | P0-17-05 |

## 7. 验证 SQL（仅 SELECT / EXPLAIN，目标 5434/fengyu）

```sql
-- 1. 验证 admin 业绩公式漂移（total_amount vs paid_amount 的差距规模）
SELECT
  COUNT(*) FILTER (WHERE total_amount <> paid_amount) AS diff_rows,
  SUM(total_amount - paid_amount) FILTER (
    WHERE date(paid_at) >= NOW()::date - INTERVAL '30 days'
  ) AS diff_sum_30d
FROM sale_orders
WHERE status = '已支付';

-- 2. 验证 admin 业绩漏过滤退款单的影响（同月)
SELECT
  sale_order_type,
  COUNT(*) AS cnt,
  SUM(paid_amount) AS sum_paid
FROM sale_orders
WHERE status = '已支付'
  AND date_trunc('month', paid_at) = date_trunc('month', NOW())
GROUP BY sale_order_type;

-- 3. 验证 staff.dashboard 店长 SUM(received) vs SUM(paid_amount) 漂移
SELECT
  COUNT(DISTINCT o.sale_order_id) AS orders,
  SUM(si.received) AS sum_received,
  SUM(o.paid_amount) AS sum_paid_amount,
  SUM(o.paid_amount) - SUM(si.received) AS gap
FROM sale_orders o
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
WHERE o.status = '已支付'
  AND o.sale_order_type IN ('销售单', '转换单')
  AND date(o.paid_at) = NOW()::date;

-- 4. 验证 today_visitors 用 sale_order_datetime 与 service_orders 客流的差异
WITH order_visits AS (
  SELECT COUNT(DISTINCT client_user_id) AS v
  FROM sale_orders
  WHERE date(sale_order_datetime) = NOW()::date
    AND status NOT IN ('已关闭', '支付失败')
),
service_visits AS (
  SELECT COUNT(DISTINCT client_user_id) AS v
  FROM service_orders
  WHERE service_date = NOW()::date
    AND status = '已完成'
)
SELECT
  (SELECT v FROM order_visits) AS by_orders,
  (SELECT v FROM service_visits) AS by_services;

-- 5. 验证 mgmt-dashboard newMember by bound_store_id vs by 业绩 store_id 漂移
WITH this_month AS (
  SELECT date_trunc('month', NOW())::date AS s, NOW()::date AS e
)
SELECT
  c.bound_store_id AS new_member_store,
  COUNT(*) AS new_member_cnt,
  COALESCE(SUM(
    (SELECT SUM(paid_amount) FROM sale_orders o
      WHERE o.client_user_id = c.user_id
        AND o.paid_at::date BETWEEN tm.s AND tm.e
        AND o.status = '已支付'
        AND o.sale_order_type IN ('销售单','转换单'))
  ), 0) AS new_member_revenue_anywhere
FROM client_wechat_users c, this_month tm
WHERE c.became_member_at IS NOT NULL
  AND c.became_member_at::date BETWEEN tm.s AND tm.e
GROUP BY c.bound_store_id
ORDER BY new_member_cnt DESC
LIMIT 10;

-- 6. 验证 EXPLAIN summary 27 query 是否有索引缺失（举例最重的 retainedMember）
EXPLAIN
SELECT COUNT(DISTINCT so.client_user_id) AS v
FROM service_orders so
JOIN client_wechat_users c ON c.user_id = so.client_user_id
WHERE c.bound_store_id = 'X'  -- 替换具体 store_id
  AND so.status = '已完成'
  AND so.client_user_id IS NOT NULL
  AND so.service_date BETWEEN (NOW()::date - INTERVAL '90 days') AND NOW()::date
  AND c.became_member_at IS NOT NULL
  AND c.became_member_at::date <= NOW()::date;
```

## 8. 回归测试用例（建议）

1. **admin 与 mgmt-dashboard 同店同日数据一致性**：在 5434/fengyu 任挑一店一日，确保 admin `getDashboardStats({manager scope})` 的 `today_paid_amount` 等于 mgmt-dashboard.summary 的 `storeRevenue.today`。当前必失败（P0-17-01/02/03 共因）。
2. **admin 业绩排除退款单**：建退款单 + paid_amount 写入 → admin 看板业绩值不变（P0-17-02 修复后）。
3. **staff.dashboard 店长 revenue 与 mgmt summary 一致**：同店同日两个接口 `revenue.today` / `storeRevenue.today` 必须 byte-equal（P1-17-07 修复后）。
4. **scopeOptions 缓存隔离**：market 账号 A 在 5min 内若 admin 给账号 A 加新市场，A 仍看不到（已知失败 → P0-17-04）。
5. **staff.dashboard 美容师跨店挪卡**：员工调店 B 后，A 店历史顾客不再计入 newMembers（P0-17-06 修复后）。
6. **跨午夜时区**：mock 系统时间到 2026-04-26 00:30 UTC（北京 08:30），三端"今日"应一致（P1-17-08 修复后）。
7. **5 指标归属语义**：UI 应显示 newMembers 角标，业务方理解"按绑定关系"vs"按服务记录"差异（P0-17-05 修复后）。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（admin + staff mgmt + staff 员工 + DB）：☑
- 涉及历史数据：☑（**修正 P0-17-01/02/03 后管理层看到的历史业绩数字会变化**——业务侧需提前沟通）
- 修复成本：M（admin 3 处 SQL 修改 + staff.dashboard 2 处 + scopeOptions 缓存改造 + 6 处测试新增/调整）

## 10. 后续待办

- [ ] 与 PM / 业务方对齐 admin 业绩从 `total_amount` 切到 `paid_amount` 后历史数据回看变小的影响
- [ ] 与 audit-07 P0-07-02（退款不冲销 sa）整合修复，确认管理层看板业绩与提成同步下降
- [ ] 与 audit-10 P0-10-05 + audit-15 customer_type 历史化整体方案打包
- [ ] 评估是否需要 dashboard summary materialized view（>30 店 + 60 月数据时 27 query Promise.all 单次 800ms+）
- [ ] 文档：metrics.md 新增"admin 业务角色看板"小节，明确 admin 必须复用 metrics.md 同口径，禁止再写"另一套 SQL"
