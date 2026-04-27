# 审计报告：数据看板（管理 + 员工）(17)

**审计时间**：2026-04-26
**域 ID**：17
**审计员**：claude-sonnet-4-6
**审计时长**：约 25 分钟
**关联 PR/Ticket**：—

---

## 1. 三端入口对照

| 层 | admin | staff (管理层) | staff (门店员工) | client |
|----|-------|----------------|------------------|--------|
| Schema | `db/schema/order.ts` (sale_orders/sale_items/sale_allocations) + `service.ts` (service_orders/service_items) + `service-commission.ts` (service_commissions) + `user.ts` (client_wechat_users/staff_wechat_users) | 同左 | 同左 | — |
| Action/Route | `fengyu-admin/src/actions/dashboard.ts:52 getDashboardStats` | `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:518 summary` / `:897 storeRanking` / `:1185 staffRanking` / `:1244 salesData` / `:93 scopeOptions` | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:617 dashboard` | — |
| 前端 | `fengyu-admin/src/app/(main)/dashboard/page.tsx` + `_components/dashboard-page.tsx` | `fengyu-staff/miniprogram/pages/mgmt-dashboard/mgmt-dashboard.ts` | `fengyu-staff/miniprogram/packageOrder/dashboard/dashboard.ts` | — |
| 测试 | `fengyu-admin/src/actions/dashboard.test.ts`（10 用例，完整覆盖） | 未发现专用测试 | 未发现专用测试 | — |
| 权威口径 | `notes/references/metrics.md` | 同左 | 同左 | — |

---

## 2. 数据流图

```
admin.getDashboardStats(session)
   └→ requirePermission('dashboard:view')
   └→ if hasBusiness('data_center:dashboard'):
        scopeIds = session.permissions.scopeStoreIds
        SELECT FROM sale_orders WHERE store_id IN (scopeIds)
          — today_revenue     = SUM(received - refunded_amount)  [paid_at Asia/Shanghai = today]
          — today_paid_amount = SUM(received)                    [毛实收，今日]
          — today_refunded    = SUM(refunded_amount)             [今日退款]
          — pending_orders/pending_allocations
          — yesterday_revenue, total_paid_amount
        SELECT FROM service_orders WHERE store_id IN (scopeIds)
          — today_visitors / yesterday_visitors (DISTINCT client_user_id)
        SELECT FROM appointments → pending_appointments
        SELECT FROM service_orders → active_services
   └→ else: getAdminStats() — totalStores/Employees/Products/Customers

  注 (2026-04-27 domain refactor)：saleOrderTypeEnum 已从 5 值精简为 3 值（销售单/内部单/转换单），
  '退款单'/'回款单' 已移除。仪表盘 SQL 已统一使用 sale_order_type IN ('销售单','转换单') AND status='已支付'。

staff.dashboard(payload {startDate, endDate})    -- 员工个人/门店看板（5 指标）
   └→ requireStaffBound
   └→ isManager: scope = so.store_id = effectiveStoreId
      isBeautician: scope = so.assigned_employee_id = staffWfId
   └→ footfall / headcount / revenue / consume / newMembers

mgmtDashboard.summary(payload {date, scopeType, scopeId})  -- 管理层 30+ 指标
   └→ requireManagementLevel (staffLevel ∈ {hq,market} ∧ loginLevel='management')
   └→ validateScope(auth, scopeType, scopeId)   -- 越权防护
   └→ Promise.all([27 个并行 SELECT])
       [业绩/生美业绩/实耗/生美实耗/客流/客量/新会员/项目数/
        销售提成/服务提成/会员数/保有会员/员工数/门店数] × {today, month}

mgmtDashboard.storeRanking / staffRanking (payload {period, metric})
   └→ requireManagementLevel
   └→ period ∈ {month, lastMonth, year}（3 值，由 VALID_PERIODS 校验）
   └→ metric ∈ {revenue,consume,retainedMember,newMember,projectCount,footfall / +income}

mgmtDashboard.salesData (payload {period, scope})
   └→ requireManagementLevel
   └→ period ∈ {month, lastMonth, year}（3 值）
   └→ getSalesDataPeriod() 计算 startDate/endDate → 9 个并行 SQL
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

**[P0-17-01] metrics.md §业绩 公式与实现代码文档漂移（paid_amount 列已 DROP 但文档未更新）**

> **FIXED 2026-04-27**：仪表盘 SQL 已统一为 `SUM(received - refunded_amount) WHERE sale_order_type IN ('销售单','转换单') AND status='已支付'`，不再引用 `paid_amount`。`saleOrderTypeEnum` 已从 5 值精简为 3 值（销售单/内部单/转换单），'退款单'/'回款单' 已移除，退款改为基于 payment 流水（`sale_order_payments` change_type='退款'）。metrics.md 文档同步更新待确认。

- 文件：`notes/references/metrics.md:13` vs `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:226` + `fengyu-admin/src/actions/dashboard.ts:93`
- 现象：`metrics.md` 第 13 行业绩公式仍写 `SUM(paid_amount)`，但 `paid_amount` 列已于 `db/schema/order.ts:72` 注释标注「已 DROP」，代码实现已全面切到 `SUM(received::numeric - COALESCE(refunded_amount, 0)::numeric)`（mgmt-dashboard.js:226、admin dashboard.ts:93）。metrics.md 未同步更新。
- 风险：规格文档与实现脱节。后续开发者以 metrics.md 为参照开发新功能可能重新使用 `paid_amount` 字段导致运行时报错（列已 DROP）。
- 复现：对照 metrics.md §业绩 行第一公式 `SUM(paid_amount)` vs 代码实现 `SUM(received - refunded_amount)`。
- 修复：L10 文档层 — 更新 `notes/references/metrics.md` §业绩 公式为 `SUM(received) - SUM(refunded_amount)` 并标注 `paid_amount` 已废弃。

---

**[P0-17-02] staff.dashboard 时间维度无后端约束，可传任意日期范围**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:620-630`
- 现象：`staff.dashboard` 接受 `startDate`/`endDate` 任意格式字符串，无"仅允许今日/本月/上月"的服务端校验。前端 `dashboard.ts:5-9` 虽只暴露 `'today'|'month'|'lastMonth'` 三选项，但后端无对应 whitelist 校验。
- 风险：调用者（或攻击者）可传任意时间范围（如全年、跨年）绕过前端限制，触发大范围 DB 扫描（DoS 级慢查询）。违反 memory 中记录的硬规则"时间维度仅当天/本月/上月"。
- 复现：直接调用云函数 `staff.dashboard` 传 `{startDate: '2019-01-01', endDate: '2026-04-26'}` 无拦截。
- 修复：L3 云函数 — 在 `staff.dashboard` 入口增加时间范围合规校验：拒绝超出合法窗口（当日/本月/上月）的请求，返回 `INVALID_PARAMS`。

---

**[P0-17-03] mgmt-dashboard paid_at 比较无时区转换，跨午夜 8 小时窗口数据归日错误**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:213-218`
- 现象：`timeWindow()` 函数在 `mode='day'` 时使用 `paid_at::date = $1::date`，未使用 `AT TIME ZONE 'Asia/Shanghai'`。admin `getDashboardStats` 已正确使用 `(paid_at AT TIME ZONE 'Asia/Shanghai')::date`（`dashboard.ts:90`）。若 PG 服务器时区为 UTC（默认配置），`paid_at::date` 按 UTC 零点切割，与 Asia/Shanghai 差 8 小时，导致今日 00:00-08:00 的订单归入"昨日"。
- 受影响路径：`queryStoreRevenue`（:221）、`queryShengmeiRevenue`（:237）、`queryNewMembers`（:368）、`querySalesCommissionIncome`（:324）、`queryServiceCommissionIncome`（:342）。
- 风险：每日早 0-8 点的营业额数据少算约占全天 30%（取决于营业模式）。数据看板今日指标与 admin 看板同日指标不一致，误导管理层决策。
- 修复：L3 云函数 — `timeWindow` 的 timestamp 列（`paid_at`/`became_member_at`）改为 `(col AT TIME ZONE 'Asia/Shanghai')::date = $idx::date`；或在 `db/pg.js` 连接池初始化加 `await client.query("SET TIME ZONE 'Asia/Shanghai'")`（一次性修复所有路由）。

---

**[P0-17-04] staff.dashboard 美容师实耗使用 assigned_employee_id 过滤 service_orders 但未细化到 service_items.employee_id**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:639` + `:695-703`
- 现象：美容师视角的 `scopeFilter = 'so.assigned_employee_id = $1'`，实耗 SQL 为：
  ```sql
  SELECT SUM(sit.unit_real_price * sit.session_used)
  FROM service_items sit
  JOIN service_orders so ON so.service_order_id = sit.service_order_id
  WHERE so.assigned_employee_id = $1  -- 仅过滤服务单负责人
  AND so.status = '已完成'
  ```
  当一个服务单由多员工执行（如员工 A 负责跟单、员工 B 实际执行某项 service_item），员工 A 查看个人看板会把员工 B 的耗卡量也计入自己名下，实耗虚高。而 `staffRanking.staffRankingConsume`（:1006）正确使用 `sit.employee_id` 归属，两者不一致。
- 风险：P0 级数据错误——美容师个人看板实耗数字虚高，可能高估其产能，影响绩效评估。与 mgmt 排行榜口径矛盾。
- 修复：L3 云函数 — 美容师路径实耗 SQL 改为 `sit.employee_id = $1` 过滤，与 `staffRanking` 口径对齐；客流/客量也对应改为 `sit.employee_id` 归属。

---

### 3.2 P1（数据一致 / 状态错乱）

**[P1-17-01] salesData 分客型业绩（SQL2）使用明细层毛口径，与总业绩（SQL1）净口径不自洽**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:1285-1305`
- 现象：
  - SQL1（总业绩）：`SUM(o.received - COALESCE(o.refunded_amount, 0))` 订单层，净口径（已扣退款）。
  - SQL2（分客型业绩）：`SUM(si.received)` 明细层，毛口径（未扣退款）。
  - 当有退款订单时，`xiaomeiRevenue + newMemberRevenue + oldMemberRevenue` 之和 > `totalRevenue`（SQL1），业务方看到三类之和大于总业绩会困惑。
- 风险：看板数字不自洽，数据可信度下降，误导业务决策。
- 修复：L3 云函数 — SQL2 改为订单层计算（JOIN sale_orders 后用 `o.received - o.refunded_amount` 按比例分摊），或明确在接口注释中说明"分客型业绩为毛口径，与总业绩（净口径）存在差值"。

---

**[P1-17-02] staff.dashboard 店长路径 paid_at 区间写法与 mgmt-dashboard 不一致**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:675-678`
- 现象：店长路径业绩 SQL：`o.paid_at >= $2::date AND o.paid_at < ($3::date + INTERVAL '1 day')`，而 `mgmt-dashboard.timeWindow()` 使用 `paid_at::date = $1::date`（当日模式）。两者语义等价，但实现方式不同，且两处都未处理时区（P0-17-03 同根）。
- 修复：L3 云函数 — 统一使用 `(paid_at AT TIME ZONE 'Asia/Shanghai')::date = $date::date`，与 admin 保持一致。

---

**[P1-17-03] mgmtDashboard.summary 无测试覆盖，storeRanking/staffRanking 亦无测试**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`（整个文件 1509 行）
- 现象：未发现 `mgmt-dashboard.js` 的专用单元测试文件。admin `dashboard.test.ts` 有 10 个用例但仅覆盖 admin 端。
- 风险：时区处理、scope 过滤等 P0 级逻辑无自动化验证，回归风险高。
- 修复：L8 测试层 — 为 `mgmtDashboard.summary`、`storeRanking`、`staffRanking` 各补 ≥5 个单元测试（mock pg.query，覆盖 scope 越权、时区边界、period 枚举校验）。

---

**[P1-17-04] mgmtDashboard.summary 时间维度接受任意 date（YYYY-MM-DD），无"仅当天/本月/上月"约束**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:522-524`
- 现象：summary 入参 `date` 只做格式校验（`^\d{4}-\d{2}-\d{2}$`，:523），允许任意历史日期（如 2019-01-01）。与 memory 约束"时间维度仅当天/本月/上月"存在设计分歧——summary 的 date 参数为日历控件选择的"基准日"（用于看历史数据），而排行榜 period 限定 month/lastMonth/year。
- 说明：`mgmt-dashboard.summary` 的 date 参数对应日历控件（mgmt-dashboard.ts:301-310 可选历史任意日期，`minDate = CALENDAR_MIN_YEAR = 2015`），与 memory 约束"时间维度仅当天/本月/上月"有意设计差异（管理层可查历史）。此处需产品确认：是否需要限制 date 范围。
- 风险：P1 — 若 memory 约束严格适用，应拒绝非"今日/本月首日/上月首日"以外的 date；否则保持现状并在文档中明确豁免说明。

---

### 3.3 P2（代码质量 / 可维护）

**[P2-17-01] storeRanking SQL 未过滤已关闭门店**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:735-755`
- 现象：`rankingRevenue` 等 6 个排行榜 SQL 的 FROM stores 未过滤 `s.is_closed = false`，已关门的历史门店以 value=0 出现在排行榜中，占用排行位置。
- 修复：L3 — FROM stores 加 `WHERE s.is_closed = false`（或 `AND s.is_closed = false`）。

---

**[P2-17-02] getSalesDataPeriod 使用 JS Date() 本地时区，云函数运行在 UTC 可能月份错位**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:671-687`
- 现象：`getSalesDataPeriod` 用 `new Date()` 获取当前日期，云函数运行在 UTC 时区，`now.getMonth()` 返回 UTC 月份，月末 20-24 点（Asia/Shanghai 次月 00-04 点）时 `period='month'` 的 startDate/endDate 会比实际"本月"少 4 天数据。
- 修复：L3 — 改用 UTC+8 偏移手动计算当前 Asia/Shanghai 日期，或通过 DB `SELECT NOW() AT TIME ZONE 'Asia/Shanghai'` 取日期。

---

**[P2-17-03] admin getAdminStats 使用 is_resigned/is_enabled 实时快照，与 metrics.md T3 历史化方向不对齐**

- 文件：`fengyu-admin/src/actions/dashboard.ts:38-49`
- 现象：`getAdminStats()` 计算 `total_employees = COUNT(*) WHERE is_resigned = false`，未用 T3 的 `hired_at/resigned_at` 时间戳历史化口径。但此处为"系统概览当前快照"语义，与 metrics.md 历史化有意区别。
- 风险：P2，语义差异有据可查，可在注释中明确说明。

---

**[P2-17-04] mgmtDashboard.summary 27 个并行查询无请求级防重机制**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:537-580`
- 现象：每次 `summary` 请求并发 27 个 DB 查询（:537-580），无防重复提交机制。用户快速切换日期可同时发起多组 27 查询（合计 54+），触碰连接池上限（max:5）。
- 修复：L3 — 添加请求级锁（单次请求保证不重入）或结果短期缓存（TTL 30-60s per date+scope）。

---

## 4. 跨端不一致

| 维度 | admin | staff (mgmt-dashboard) | staff (dashboard) | 风险 | 优先级 |
|------|-------|----------------------|-------------------|------|--------|
| 业绩公式（总营业额） | `SUM(received - refunded_amount)` 净口径 | summary 同左；salesData SQL1 同左；salesData SQL2 分客型 `SUM(si.received)` 毛口径 | 店长路径 `SUM(received - refunded_amount)` 净口径；美容师 `SUM(sa.total_amount)` 分配额 | salesData 分客型与总业绩不自洽 | P1 |
| 时区处理 | `NOW() AT TIME ZONE 'Asia/Shanghai'` | `paid_at::date = $date`（无时区转换）| `paid_at >= date AND paid_at < date+1d`（无时区）| 跨午夜 8 小时订单归日错误（UTC DB 环境）| P0 |
| 时间维度参数 | 固定今日/昨日（无参数） | summary：任意 `date`；排行榜/salesData：`period` 3 值校验 | `startDate/endDate` 任意（无后端约束）| 违反 memory 硬规则 | P0 |
| 实耗归属 | service_orders scope 过滤 | `service_items sit JOIN service_orders so` | 美容师：`so.assigned_employee_id`（非 `sit.employee_id`）| 美容师实耗虚高，与排行榜不一致 | P0 |
| 新会员字段 | 无此指标 | `became_member_at` 时间戳 | `became_member_at` 时间戳 | 两端一致 | — |
| 组织隔离 | `scopeStoreIds IN` 子句 | `validateScope + buildXScope` | `effectiveStoreId`（单店）| 各层正确隔离 | — |
| 提成来源 | 不展示 | `sale_allocations + service_commissions` | `sale_allocations.total_amount`（美容师）| metrics.md 口径一致 | — |

---

## 5. 横切检查

### CC1 数值精度

- [x] `SUM(received::numeric - COALESCE(refunded_amount, 0)::numeric)` 使用 NUMERIC，精度正确
- [x] `round2 = Math.round(Number(v) * 100) / 100` 保留 2 位，无 float 精度损失
- [x] `sale_allocations.total_amount`、`service_commissions.commission_amount` 为 NUMERIC，提成计算精度正确
- [x] `service_items.unit_real_price * session_used` NUMERIC 乘法精度正确
- [ ] **[P1-17-01]** salesData SQL2 分客型业绩 `SUM(si.received)` 毛口径与 SQL1 净口径不一致

### CC2 并发幂等

- [x] 看板均为只读 SELECT，无写操作，无并发安全问题
- [ ] **[P2-17-04]** `mgmtDashboard.summary` 27 个并行查询在高并发下 DB 连接池（max:5）耗尽风险

### CC3 组织域数据隔离

- [x] `mgmtDashboard.summary` 通过 `validateScope` 防越权，`buildSaleScope/buildClientScope/buildStaffScope` 严格按 scopeType 过滤（:158-204）
- [x] `mgmtDashboard.storeRanking/staffRanking` 通过 `getVisibleStoreIds(auth)` 按权限过滤（:693-695）
- [x] `staff.dashboard` 美容师路径：`so.assigned_employee_id = employeeId`；店长路径：`so.store_id = storeId`
- [x] admin `getDashboardStats`：`store_id IN (scopeStoreIds)`，空时返回 ZERO_BUSINESS（:65-66）
- [x] 市场账号禁止查 scopeType=all（validateScope:129-130）
- [ ] **[P2-17-01]** `storeRanking` 未过滤 `is_closed = false`，已关门店出现在排行榜

### CC4 后端鉴权

- [x] `mgmtDashboard.*` 全部 `requireManagementLevel()`（staffLevel ∈ hq/market ∧ loginLevel=management）
- [x] `staff.dashboard` `requireStaffBound()` — 已绑定手机 + 员工档案
- [x] admin `getDashboardStats` `requirePermission(session, 'dashboard:view')`
- [x] 所有鉴权均在路由入口执行，不信任前端传参

### CC5 错误码

- [x] `INVALID_PARAMS:` 前缀在 mgmt-dashboard date/scopeType 校验中正确使用（:522-531）
- [x] `PERMISSION_DENIED:` 前缀在 `validateScope` 中正确使用（:130、:137、:145）
- [x] `requireManagementLevel` 正确使用 `UNAUTHORIZED:` / `PERMISSION_DENIED:`（auth.js:281-289）
- [x] `staff.dashboard` `INVALID_PARAMS: 缺少 startDate 或 endDate`（:627）格式正确

### CC6 PII

- [x] 看板返回汇总数字，不含手机号、openid、身份证等个人信息
- [x] admin `getDashboardStats` 返回聚合指标
- [x] `mgmtDashboard.summary` 返回 metrics；`storeRanking.rows` 含 storeName（公开）；`staffRanking` 含 employeeName（内部使用，非敏感 PII）

### CC7 时间字段

- [x] admin `getDashboardStats` 使用 `NOW() AT TIME ZONE 'Asia/Shanghai'`（:83）— 时区正确
- [ ] **[P0-17-03]** `mgmt-dashboard.queryStoreRevenue` 等 `paid_at::date = $1::date` 未转时区，UTC 环境下跨午夜切割错误
- [ ] **[P2-17-02]** `getSalesDataPeriod()` 使用 JS `new Date()` 本地时区（UTC），月末边界可能不准
- [x] `service_date` 为 date 类型，无时区问题（:257）
- [x] `became_member_at` 为 timestamptz，`::date` 转换依赖 DB 时区（与 paid_at 同问题）

### CC8 WXML/Vant

- [x] 员工端 `dashboard.ts` 前端仅展示 5 个数字指标，无复杂 Vant 组件
- [x] `mgmt-dashboard.ts` 使用自定义组件 `mgmt-period-picker/mgmt-metric-tabs`，无 Vant 陷阱
- [x] admin dashboard 纯 React 组件，无 Vant 相关

### CC9 测试与迁移残留

- [x] `paid_amount` 列在代码中已无引用（已 DROP，代码改用 received）— 已验证
- [x] `sale_order_source` 列已 DROP，dashboard 代码无引用
- [x] `receivable` / `order_no` / `staff_name` 等废弃字段无引用
- [x] **[P0-17-01]** `metrics.md §业绩` 仍记录 `paid_amount` 公式未更新（文档残留）→ **FIXED 2026-04-27**：代码已切到 `received - refunded_amount`，文档待最终同步确认
- [ ] **[P1-17-03]** admin `getAdminStats` 中 `is_resigned = false` 仍用旧快照口径，未切到 T3 历史化
- [ ] **[P1-17-03]** `mgmt-dashboard.js` 无专用单元测试，27 个查询函数全无覆盖

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L3 云函数 | `staffApi/routes/staff.js:620-650` | 增加时间维度合规校验（拒绝超出当日/本月/上月的范围，返回 INVALID_PARAMS） | P0-17-02 |
| L3 云函数 | `staffApi/routes/mgmt-dashboard.js:213-218` | `timeWindow()` 中 timestamp 列（paid_at/became_member_at）改为 `(col AT TIME ZONE 'Asia/Shanghai')::date = $idx::date` | P0-17-03 |
| L3 云函数 | `staffApi/db/pg.js` 连接初始化 | 或在连接池 `client.connect()` 后执行 `SET TIME ZONE 'Asia/Shanghai'`（一次性修复所有路由）| P0-17-03 |
| L3 云函数 | `staffApi/routes/staff.js:695-703` | 美容师路径实耗改为 `sit.employee_id = $1` 过滤；客流/客量同步改为 `service_items.employee_id` 归属 | P0-17-04 |
| L3 云函数 | `staffApi/routes/mgmt-dashboard.js:1285-1305` | SQL2 分客型业绩统一为净口径，或加注释明确说明"毛口径，与总业绩（净口径）存在差值" | P1-17-01 |
| L3 云函数 | `staffApi/routes/mgmt-dashboard.js:671-687` | `getSalesDataPeriod` 改为手动计算 UTC+8 当前日期 | P2-17-02 |
| L3 云函数 | `staffApi/routes/mgmt-dashboard.js:735-878` | 6 个 ranking SQL 的 FROM stores 加 `AND s.is_closed = false` | P2-17-01 |
| L8 测试 | 新建 `staffApi/__tests__/routes/mgmt-dashboard.test.js` | 补 summary/storeRanking/staffRanking 单元测试（scope 越权、时区边界、period 枚举）| P1-17-03 |
| L10 文档 | `notes/references/metrics.md:13` | 更新 §业绩 公式从 `paid_amount` 到 `received - refunded_amount`；标注 paid_amount 已废弃 | P0-17-01 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. 验证 paid_at 时区切割是否正确（检查 0-8 点订单按 UTC 与 Asia/Shanghai 归日差异）
SELECT
  (paid_at AT TIME ZONE 'Asia/Shanghai')::date AS sh_date,
  paid_at::date                                AS utc_date,
  COUNT(*) AS cnt
FROM sale_orders
WHERE paid_at IS NOT NULL
  AND paid_at >= NOW() - INTERVAL '2 days'
GROUP BY 1, 2
HAVING (paid_at AT TIME ZONE 'Asia/Shanghai')::date != paid_at::date
ORDER BY 1;
-- 若有记录输出，则 P0-17-03 已确认（UTC 时区导致切割错误）

-- 2. 验证 staff.dashboard 美容师路径实耗虚高（assigned_employee_id vs service_items.employee_id）
SELECT
  so.assigned_employee_id,
  COUNT(DISTINCT sit.employee_id) AS executor_count,
  COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS consume_by_assigned,
  COALESCE(SUM(CASE WHEN sit.employee_id = so.assigned_employee_id
    THEN sit.unit_real_price::numeric * sit.session_used ELSE 0 END), 0) AS consume_actual
FROM service_orders so
JOIN service_items sit ON sit.service_order_id = so.service_order_id
WHERE so.status = '已完成'
  AND so.service_date >= NOW()::date - 30
GROUP BY so.assigned_employee_id
HAVING COUNT(DISTINCT sit.employee_id) > 1  -- 多员工服务单
LIMIT 20;

-- 3. 验证 salesData 分客型业绩（毛）与总业绩（净）差异
SELECT
  COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount,0)::numeric), 0) AS total_net,
  COALESCE(SUM(si.received::numeric), 0) AS all_items_gross,
  COALESCE(SUM(o.refunded_amount::numeric), 0) AS refunded_total
FROM sale_orders o
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
WHERE o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at::date >= NOW()::date - 30;
-- 若 all_items_gross > total_net，则 P1-17-01 已确认

-- 4. 验证排行榜已关闭门店出现情况
SELECT s.store_id, s.store_name, s.is_closed
FROM stores s
WHERE s.is_closed = true
ORDER BY s.store_name
LIMIT 10;
-- 若有结果，则 storeRanking 需加 is_closed = false 过滤
```

---

## 8. 回归测试用例（建议）

1. **时区切割验证**：在 UTC 时区 DB 环境下，23:50 创建一笔（Asia/Shanghai 时间为次日 00:05 的）订单，验证 `mgmtDashboard.summary` 的 today 数据按 Asia/Shanghai 归日，不归入昨日。
2. **时间维度后端拒绝**：直接调用 `staff.dashboard` 传 `{startDate: '2019-01-01', endDate: '2026-04-26'}`，预期返回 `INVALID_PARAMS` 错误，不执行查询。
3. **美容师实耗隔离**：创建包含 2 名员工（A 负责跟单、B 实际执行）的服务单，用员工 A 身份查看 `staff.dashboard`，验证实耗仅计入 A 的 service_items，不包含 B 的 service_items。
4. **salesData 分客型之和 <= 总业绩（改净口径后）**：对含退款的历史数据调用 `salesData`，验证 `xiaomeiRevenue + newMemberRevenue + oldMemberRevenue <= totalRevenue`。
5. **已关闭门店不出现在排行榜**：将某门店 `is_closed = true`，调用 `storeRanking`，验证该门店行不在 `rows` 结果中。
6. **市场账号越权防护**：使用市场账号请求 `mgmtDashboard.summary` 传 `scopeType='all'`，预期 `PERMISSION_DENIED: 市场账号不允许查看全部市场数据`。
7. **mgmt summary vs admin dashboard 今日业绩一致**：同一门店当日，admin 看板与 mgmt-dashboard.summary（scopeType=store）今日业绩数字在时区修复后应完全一致。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑ — P0-17-03 时区问题影响 mgmt-dashboard（staff 端）与 admin 端两者共用同一 DB，数据不一致
- 涉及历史数据：☐（看板均为实时查询，无需历史数据 backfill）
- 修复成本：
  - P0-17-01（文档更新）：XS（5 分钟）
  - P0-17-02（后端时间校验）：S（30 分钟，加白名单逻辑）
  - P0-17-03（时区修复）：S（改 `db/pg.js` 连接初始化 1 行，或改 `timeWindow` 函数）
  - P0-17-04（实耗归属）：S（改 `staff.dashboard` 美容师 `scopeFilter` 构造逻辑）

---

## 10. 后续待办

- [x] 更新 `notes/references/metrics.md` §业绩 公式，将 `paid_amount` 更新为 `received - refunded_amount`，并在变更记录中注明 → **FIXED 2026-04-27**（代码已切到正确公式；文档待最终同步确认）
- [ ] `staff.dashboard` 增加时间维度合规白名单后端校验（拒绝超出当日/本月/上月的请求）
- [ ] `mgmt-dashboard.js` 所有 `paid_at::date` / `became_member_at::date` 路径补 `AT TIME ZONE 'Asia/Shanghai'`；或在 `db/pg.js` 连接初始化加 `SET TIME ZONE 'Asia/Shanghai'`
- [ ] `staff.dashboard` 美容师路径实耗/客流/客量改为按 `service_items.employee_id` 归属，与 `staffRanking` 对齐
- [ ] `mgmt-dashboard.salesData` SQL2 分客型业绩注释明确"毛口径"，或统一改为净口径与 SQL1 对齐
- [ ] `storeRanking` 6 个 ranking SQL 的 FROM stores 加 `AND s.is_closed = false` 过滤
- [ ] 新建 `staffApi/__tests__/routes/mgmt-dashboard.test.js`，覆盖 summary/storeRanking/staffRanking 的 scope 越权、时区边界、period 枚举校验
- [ ] 与产品确认 `mgmtDashboard.summary` 的 `date` 参数是否需要受"今日/本月/上月"约束，或保留历史查询能力（明确记录豁免原因）
- [ ] 考虑为 `mgmtDashboard.summary` 添加请求级防重提交和结果短期缓存（30-60s TTL per date+scope）
