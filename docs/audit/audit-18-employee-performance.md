# 审计报告：员工绩效（performanceDetail）(18)

**审计时间**：2026-04-25
**域 ID**：18
**审计员**：claude-opus-4-7（Opus 4.7 1M context）
**审计时长**：~25 分钟
**关联 PR/Ticket**：retain audit-07 P0-07-02 / audit-08 P0-08-04 / audit-08 P1-08-07 / audit-17 P1-17-08

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:196-227` (`sale_allocations`) + `db/schema/service-commission.ts:16-51` (`service_commissions`) + `db/schema/order.ts:40-117` (`sale_orders.paid_at`) | ↑ | — |
| Action / Route | **不参与**：`fengyu-admin/src/actions/employees.ts` 仅档案 CRUD（`getEmployeeById:211-224`），无任何按员工聚合 sa/sc 的查询；`actions/commission.ts` / `service-commissions.ts` 仅维护提成矩阵和服务提成行管理，未提供"员工绩效汇总" | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:432-606 performanceDetail` + `:150-237 todayCommission` + `:242-310 monthlyCalendar` + `:613-731 dashboard` | — |
| 前端 | — | `fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts:42-219` + `pages/workbench/workbench.ts:165-200` | — |
| 测试 | — | — | — |

> **关键发现 0（admin 缺位）**：admin 端**没有员工绩效 / 提成明细查询界面或 action**。`fengyu-admin/src/app/(main)/employees/[id]/page.tsx` 仅展示档案 + 角色 + 门店 + 部门 + 职位 + 技能，无绩效 Tab；HR/财务想跨员工对账，必须直接进数据库或汇总 staff 端各人各自查询的数字。这本身不是 P0 漏洞，但与 audit-08 §2 中 admin batchSaveServiceCommissions / mgmt-dashboard.staffRanking 已有局部入口形成"职责真空"——本审计针对此项仅记入 §10 后续待办。

## 2. 数据流图

```
staff-performance/staff-performance.ts (UI)
    │  startDate / endDate / filterType: 'sale'|'service'|undefined
    │  salesCategory: '他销他耗' | '生态合作' (Tab 3/4)
    │  employeeId: 仅 isManager() 时由 picker 注入；否则后端兜底为 ctx.auth.staffWfId
    └→ staffApi.staff.performanceDetail
         ├─ 销售分支：sale_allocations sa JOIN sale_items si JOIN sale_orders o
         │     WHERE sa.employee_id = $emp AND sa.is_void = false
         │       AND o.status = '已支付'
         │       AND o.paid_at >= [JS Date 解析的 start, +1day)
         │     ⚠️ 不过滤 sale_order_type → 退款单负行 / 内部单 / 回款单全部计入
         │     ⚠️ 不过滤 store_id → 店长可查跨店任意员工绩效（manager scope 全集团）
         │
         └─ 服务分支：service_commissions sc JOIN service_items sit JOIN service_orders so JOIN sale_items si
                LEFT JOIN client_wechat_users cu ON cu.user_id = so.client_user_id
                WHERE sc.employee_id = $emp AND sc.is_void = false
                  AND so.status = '已完成'
                  AND so.service_date >= startDate AND so.service_date <= endDate
                ⚠️ 销售分支用 [start, end+1) 半开区间；服务分支用 [start, end] 闭区间 → 跨日边界双口径
                ⚠️ JS 端 .sort + .slice 内存分页 → 大数据集 OOM；total = allItems.length 仅本次集合

staff-performance.ts onCategoryTabChange + setRange → page=1, loadData(true)
    Tab 0 合计 / 1 销售 / 2 服务 / 3 他销他耗 / 4 生态合作

todayCommission (workbench 卡片):
    ├─ commissionRows (sale_allocations + paid_at) ← ✅ JS Date 容器时区
    ├─ serviceRows (service_orders.assigned_employee_id) ← 仅算"服务单数"，**不算提成额**
    └─ 漏算 service_commissions 提成 → audit-08 P1-08-07 retain
       漏算 sale_order_type 过滤 → 退款单负数已支付时间在今日会拉低 todayAmount

monthlyCalendar (workbench 日历):
    └─ DATE(o.paid_at) GROUP BY → 按 PG NOW() 时区分桶；
       monthStart 由 JS 容器时区 + .toISOString() 转 UTC 字符串塞回 PG → ⚠️ 服务时区漂移 (audit-17 P1-17-08 同源)
```

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-18-01]** performanceDetail 不过滤 `sale_order_type`，退款单 / 回款单 / 内部单全部记入员工绩效（资损 + 数据失真）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:457-482`
- **现象**：销售分支 SQL `WHERE sa.employee_id=$1 AND sa.is_void=false AND o.status='已支付' AND o.paid_at IN [start,end+1d)`，无 `o.sale_order_type` 过滤。
- **风险**：
  1. **退款单（FY-TKD）资损链路**：退款单 `total_amount<0` + sa 行复制时 `total_amount` 也是负数（schema `db/schema/order.ts:212` 注释明确"退款业绩 total_amount 为负数"）。当退款 approve 后 admin 不冲销原单 sa（audit-07 P0-07-02 / audit-11 P0-11-01），但**退款单本身的 sa 行**会以 `paid_at = approveRefund 时间` 进入 paid_at 区间。结果：员工今天的 totalSalesAlloc = SUM(原单正向已分配的旧业绩) + SUM(退款单负行)，**分子可能漂负 / 抵消错位**。
  2. **回款单（FY-HKD）双计**：原单已支付时已写过一次 sa（首次支付 → allocation.save），回款单 paid_at 触达后又写一次（payNotify 在回款 status='已支付' 时写 sa，retain audit-07 P0-07-04）→ 同笔业绩在月度合计里出现两次。
  3. **内部单**：spec §3.13 要求"`不算顾客数`、`不计入会员等级`升级消费"，但当前 SUM(total_amount) 已计入员工绩效。store ranking 同卡漂高。
- **复现**：1) 美容师 A 4-20 卖卡 ¥1000 分配 70%，sa 行 `total_amount=700`；2) 4-25 全额退款 approve，写 FY-TKD-WX-* 一行 sa `total_amount=-700`（按 P0-07-02 现状原 sa 不冲销）；3) staff-performance 选 `本月`：totalSalesAlloc = 700 + (-700) = 0（如果原单 4-20 也在窗口内，此时巧合"正确"），但**4-25 单日**只看到 -700；4) 选 `今日` → 显示员工今天分成 -700 元。
- **修复**：(L3) `routes/staff.js:475-482` 加 `AND o.sale_order_type IN ('销售单','回款单')` 或显式列举。配合 retain audit-07 P0-07-02 与 audit-08 P0-08-04 整体冲销修复后才能精确。**短期 hotfix**：仅过滤掉退款单和内部单，让员工绩效只展示"销售/回款"双路径净额。
- **关联**：CC1 数值精度 / CC9 测试残留 / retain P0-07-04 / retain P0-08-04

#### **[P0-18-02]** performanceDetail / dashboard / todayCommission / monthlyCalendar **完全无 store / scope 隔离**，店长可查"集团内任意员工"绩效（越权 + PII 泄露）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:439`（`targetEmployeeId`）+ `:475-479`（无 `o.store_id` 过滤）+ `:519-523`（无 `so.store_id` 过滤）
- **现象**：performanceDetail 入口仅靠 `requireStaffBound`（无 `requireManager`），管理者权限来自 `roles.includes('manager')` ——`staff.list` (line 23-40) 已经允许任意 `payloadStoreId`，前端 picker 能列出店内员工列表，但 `performanceDetail` 接收 `employeeId` 后**完全不校验**：
  - 不查询 employeeId 是否在 ctx.auth.scopeStoreIds 范围内的某门店
  - 不查询 sa.store_id / so.store_id ∈ ctx.auth.scopeStoreIds
  - 即店长 X（A 店）只要拿到员工 Y 的 employeeId（FY-XXXXXX-NNN，可枚举或泄露），就能读到 Y 在任何店历史的全部 sa / sc 明细，含**顾客手机号 + 顾客姓名 + 订单号 + 商品价格**
- **风险**：
  - 越权读所有门店所有员工绩效；
  - 顾客 PII（姓名 + 手机号 cu.phone）外泄到非本店店长；
  - 与 customer.detail / giftHistory / refundHistory 同模式（参 audit-10 P0-10-01）的"manager 全局可读"扩展面。
- **复现**：1) X 是 A 店店长；2) 通过 staff.list 拿到 B 店员工 Y 的 staffWfId（`payloadStoreId=B`）；3) callStaffApi('staff.performanceDetail', {startDate, endDate, employeeId: Y_employeeId}) → 返回 Y 在 B 店的全部绩效明细 + 顾客信息。
- **修复**：(L3)
  ```
  if (queryEmployeeId && queryEmployeeId !== ctx.auth.staffWfId) {
    if (!isManager) throw new Error('PERMISSION_DENIED: 仅店长可查他人绩效')
    const [target] = await pg.query('SELECT store_id FROM staff_wechat_users WHERE employee_id = $1', [queryEmployeeId])
    if (!target || !ctx.auth.scopeStoreIds.includes(target.store_id))
      throw new Error('PERMISSION_DENIED: 越店访问员工绩效')
  }
  ```
  + 在 sa / sc SQL `WHERE` 加 `o.store_id = ANY($scopeStoreIds)` / `so.store_id = ANY($scopeStoreIds)`
- **关联**：CC3 组织域隔离 / CC6 PII / CROSS-CUTTING.md「Staff 业务路由 store/scope 完全无过滤」+ audit-10 P0-10-01 同模式

#### **[P0-18-03]** performanceDetail 销售分支与服务分支**时间区间口径不一致**（半开区间 vs 闭区间），跨月末双计 / 漏计

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:445-447, 478-479, 490, 522-523`
- **现象**：
  ```
  // 销售：JS Date 解析 + +1day → o.paid_at >= start AND o.paid_at < end+1
  const start = new Date(startDate.replace(/-/g, '/'))   // 容器时区 00:00
  const end   = new Date(endDate.replace(/-/g, '/'))
  end.setDate(end.getDate() + 1)
  ... AND o.paid_at >= $2 AND o.paid_at < $3
  // 服务：直接传字符串 startDate / endDate.replace(/-/g, '/')
  ... AND so.service_date >= $2 AND so.service_date <= $3
  ```
  服务分支在 PG 端把字符串转 date 后 `service_date <= '2026-04-25'`（闭区间含当日），销售分支用 timestamp 半开区间 `< 2026-04-26 00:00 容器时区`。
- **风险**：
  1. **跨日边界**：4-25 23:59 已支付订单 paid_at 落在销售半开区间末尾被算入；同日完成的服务单 service_date='2026-04-25' 也被服务分支算入——单看本地时区似乎一致。但容器时区若是 UTC，`new Date('2026-04-25')` = 2026-04-25T00:00Z（北京 8:00），4-25 0-8 点北京时间下的 paid_at 会被算到 4-24 那行 → totalSalesAlloc 与 totalServiceCommission 各自按不同时区抽样数据，最终汇总不可对账。
  2. 与 audit-17 P1-17-08（dashboard 三时区漂移）同源，但本域更恶劣：**同一函数内**两个分支两种区间语义。
- **复现**：1) 容器时区 UTC，员工 4-25 北京时间 8 点服务完成 + paid_at=4-25 00:30Z（=北京 8:30 当天）；2) 选 startDate=endDate='2026-04-25'：销售分支 paid_at >= 2026-04-25T00:00Z 命中；服务分支 service_date <= '2026-04-25' 命中。3) 但当 paid_at=2026-04-24T16:30Z（北京 4-25 00:30），销售分支判定"不在 4-25 区间"，服务分支因 service_date 是业务日"2026-04-25" 仍命中 → 顾客同笔卡的销售 vs 服务提成跨日漂移。
- **修复**：(L3) 统一两分支为 `paid_at::date BETWEEN $start::date AND $end::date` 与 `service_date BETWEEN $start::date AND $end::date`，使用 PG `Asia/Shanghai`（或部署时区）做日期截断；同时 todayCommission/monthlyCalendar 也对齐到 PG 端 `::date` 转换，避免 JS Date 容器时区漏洞。
- **关联**：CC7 时间字段 / retain audit-17 P1-17-08 / audit-02 / audit-05 / audit-06 时区族系

### 3.2 P1

#### **[P1-18-04]** todayCommission 完全不读 service_commissions（retain audit-08 P1-08-07，再确认未修）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:163-220`
- **现象**：`commissionRows` / `lastMonthCommRows` 只查 sale_allocations。员工工作台 Tab 1"今日分成"卡片显示金额永久缺服务提成。
- **风险**：员工实际今日完成 5 单服务（每单 ¥30 提成 = ¥150），开单零销售分配 → 工作台显示 ¥0，与 staff-performance 详情页 totalCommission ¥150 数字割裂。
- **修复**：(L3) commissionRows 并行查 sc.commission_amount 然后 todayAmount = sa.SUM + sc.SUM。
- **关联**：retain audit-08 P1-08-07 / CC1 数值

#### **[P1-18-05]** filterType 无白名单校验，未识别值时**静默返回合并集**

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:582-585`
- **现象**：
  ```js
  let allItems
  if (filterType === 'sale') allItems = saleItems
  else if (filterType === 'service') allItems = serviceItems
  else allItems = [...saleItems, ...serviceItems]   // ← 任何其他值（'sales' 拼写错 / 注入）都走这里
  ```
  没有 `INVALID_PARAMS:` 抛出。前端虽传严格 'sale'/'service'，但中间人 / 自定义客户端可传任意字符串。
- **风险**：API 契约不明确；与 admin 端的 Zod 校验风格脱节（CC5）。
- **修复**：(L3) `if (filterType && !['sale','service'].includes(filterType)) throw new Error('INVALID_PARAMS: filterType 不合法')`。同样校验 `salesCategory ∈ saleAllocations 枚举（自销自耗/他销自耗/他销他耗/生态合作）`。
- **关联**：CC5 错误码

#### **[P1-18-06]** JS 端 .sort + .slice 内存分页，total 为本批次数（性能 + 翻页错乱）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:587-602`
- **现象**：
  ```js
  allItems.sort((a, b) => new Date(b.date) - new Date(a.date))
  const offset = (page - 1) * pageSize
  const paged = allItems.slice(offset, offset + pageSize)
  ...
  total: allItems.length,  // ← 这是 sa+sc 全集（不分页）的总长度
  ```
  无 LIMIT/OFFSET 落库，每次翻页都把员工**全期间**所有 sa+sc 行拉回云函数。员工年度万级订单时云函数内存 + 序列化时间炸裂；前端 `onReachBottom` 每次都拉相同的全集只是 slice 不同区段。
- **风险**：
  1. 性能：CloudBase 函数 256M 内存，员工 5000 条 sa + 3000 条 sc → 每次请求 8000 行往返，触发函数超时（默认 3s）。
  2. 翻页：同一员工跨多次 onReachBottom，每次重新做 `.sort` 不稳定（JS sort 在 Date 相等时不保证 stable order，跨次请求顺序可能漂移）→ 翻页可见同一行重复 / 跳行。
- **修复**：(L3) 分两次 LIMIT+OFFSET 分别拉 sa 和 sc，由前端组合或后端 `UNION ALL ... ORDER BY date DESC LIMIT ... OFFSET ...`；total 单独 `SELECT COUNT(*) FROM ... WHERE ...` 算两条相加。
- **关联**：CC2 性能 / 与 admin 服务端分页规范脱节（admin.sys.spec.md §5）

#### **[P1-18-07]** monthlyCalendar 同时混用 JS 容器时区 + UTC ISO + PG DATE()，三层时区漂移（audit-17 同源）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:248-273`
- **现象**：
  ```js
  const monthStart = new Date(y, m - 1, 1)        // ← JS 容器时区
  const monthStartStr = monthStart.toISOString().slice(0, 10)   // ← 强转 UTC
  ...
  WHERE sa.employee_id = $1 ... AND o.paid_at >= $2 AND o.paid_at < $3
  GROUP BY DATE(o.paid_at)   // ← PG 默认时区分桶（PG 容器时区 / Asia/Shanghai 取决于 connection）
  ```
  云函数容器时区 = UTC 时，`new Date(2026, 3, 1)` 实际是 2026-04-01T00:00Z 而不是北京 4-01 00:00；GROUP BY DATE(paid_at) 返回的"date"按 PG session 时区分桶；前端再 `.slice(0,10)` ISO 截取——三层时区漂移。
- **风险**：retain audit-17 P1-17-08 同模式；月初/月末窗口跨天数据可能"提前一天显示"或"延迟一天显示"。北京 0-8 时支付的订单可能被算到上一日。
- **修复**：(L3) `WHERE o.paid_at >= $1::date AND o.paid_at < ($2::date + INTERVAL '1 month') GROUP BY (paid_at AT TIME ZONE 'Asia/Shanghai')::date`，参数全用 'YYYY-MM-DD' 字符串，云函数代码不构造 Date 对象。
- **关联**：CC7 时间字段 / retain audit-17 P1-17-08 / 同模式 audit-02 / audit-05 / audit-06

#### **[P1-18-08]** dashboard 美容师分支 newMember 使用 `bound_employee_id` 而其他 4 指标走 `assigned_employee_id`，绩效页/看板归属漂移（retain audit-17）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:705-722`（与 audit-17 P0-17-04 同行）
- **现象**：performanceDetail / dashboard 都被同一员工查看，但 dashboard 的 newMember 走的是 client_wechat_users.bound_employee_id（顾客绑定的美容师），其他 4 指标（footfall / headcount / revenue / consume）走的是 service_orders.assigned_employee_id（实际执行美容师）。员工调店或顾客被分配后，"我有几个新会员"和"我服务过几个客"分母不同。
- **风险**：retain audit-17 P0-17-04（同行重述，本域为绩效视角再确认未修）。
- **修复**：见 audit-17 P0-17-04。

#### **[P1-18-09]** todayCommission **不**过滤 sale_order_type，退款单 paid_at 落今日时拉低 todayAmount

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:163-175`
- **现象**：与 P0-18-01 同根但作用范围更小（仅"今日"卡片）。退款单 approveRefund 时间是审批时间，paid_at 写当天 → 当天 todayAmount = 销售业绩 - 退款负值 + 漏算服务提成。
- **修复**：(L3) WHERE 加 `o.sale_order_type='销售单'`（更严格也可只允许销售/回款）。
- **关联**：与 P0-18-01 同根

#### **[P1-18-10]** dashboard 不查 service_commissions（员工"业绩"指标只算 sale_allocations）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:660-686`
- **现象**：dashboard 美容师分支 revenue 直接 `SUM(sa.total_amount)`，不含 service_commissions。员工想知道"今日实际拿到手提成总额"必须切到 staff-performance 才能拿全 totalCommission。看板"业绩"和 staff-performance "总分成"为两个数字。
- **风险**：员工困惑指标含义；与 spec §3.12 "业绩 = 收款金额汇总" 字面一致（业绩本就是销售口径），但**店长 isManager 分支**直接 SUM(si.received) 是营业额（含未分配 / 含其他员工分配），数字与"美容师业绩 = 自己 sa.total_amount"完全不可比。
- **修复**：(L3) 文档化指标含义；或者新增 dashboard.commission 指标（fixed + consume）。
- **关联**：CC5 / 与 spec §3.12 / §3.15 双轨

### 3.3 P2

#### **[P2-18-11]** isManager 判定走 `roles.includes('manager')`（兼容字段），与 middleware/auth.js requireManager 用 `(role='manager', scopeType='门店')` 不一致

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:153, 318, 436, 617`
- **现象**：staff.js 大量用 `ctx.auth.roles.includes('manager')`，而 middleware/auth.js requireManager 已升级为 roleBindings.scopeType='门店' 判定。HQ 临时账号若被授予 manager + scopeType='市场' 角色，roles 仍包含 'manager' → 在 staff.todayCommission / dashboard / performanceDetail 内会被识别为 manager（看整店指标），但 requireManager 中间件会拒绝。
- **风险**：行为不一致；scope drift。
- **修复**：(L3) 用 `roleBindings.some(r => r.role==='manager' && r.scopeType==='门店')` 替换全部 `roles.includes('manager')` 判定。
- **关联**：与 auth middleware 双轨

#### **[P2-18-12]** performanceDetail SQL 使用 `o.customer_name` / `o.client_phone`（已被 v3.1 顾客合并废弃，但 sale_orders 仍保留快照列）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:468-469, 549-562`
- **现象**：sale_orders.customer_name + client_phone 是开单时的快照字段（schema 仍存在 `db/schema/order.ts:57-58`），但**顾客后续改名 / 改手机号**后，绩效列表展示的是开单时的旧值，与 customer.detail Tab 展示新值漂移。
- **风险**：员工看绩效顾客姓名 ≠ 顾客详情页显示；轻微 UX 漂移。
- **修复**：(L3) 改 `LEFT JOIN client_wechat_users cu ON cu.user_id = o.client_user_id`，取 cu.name + cu.phone（与服务分支一致）。
- **关联**：CC9 残留 / 与 v3.1 顾客合并设计意图

#### **[P2-18-13]** monthlyCalendar **完全不读 service_commissions**，日历只反映销售提成

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:259-273`
- **现象**：月度日历 GROUP BY DATE(paid_at) 仅基于 sa。员工"4-25 没销售只服务" → 日历显示 0；与 staff-performance 选 4-25 当天显示 totalCommission > 0 矛盾。
- **修复**：(L3) UNION ALL 两份按 date 合并，与 todayCommission 同步修复。
- **关联**：与 P1-18-04 同根

#### **[P2-18-14]** performanceDetail 返回 `totalServiceFee` 别名永久保留，无下线计划

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:597-598`
- **现象**：注释写 "1-2 发布周期后下线"，但项目无 ticket 跟踪；前端 `staff-performance.ts:204` 仍 fallback `?? res.totalServiceFee`。
- **修复**：起 ticket 跟踪下线时间；或前端发布版本检查后端 minVersion 启用新字段名。

#### **[P2-18-15]** staff.list / departments / dashboard / performanceDetail / todayCommission 全程**0 operation_logs**

- **现象**：员工绩效查询是审计敏感操作（PII 泄露面），没有任何审计日志写入。
- **风险**：与 admin AC-11 全覆盖、CC4 后端鉴权双重审计原则脱节；与 audit-11 P1-11-09 / audit-12 同模式（staff 路径全程 0 operation_logs）。
- **修复**：(L3) 在 performanceDetail 入口（特别是 isManager 查他人时）写 operation_log。
- **关联**：retain audit-11 / audit-12 / CC4

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 员工绩效汇总入口 | **缺失**（仅档案 CRUD） | `staff.performanceDetail` 双分支 sa+sc | — | HR/财务无对账面 | P1 |
| sa 与 sc 双轨同时读 | mgmt-dashboard.staffRanking 已对齐双轨 | performanceDetail ✅ / todayCommission ❌ / monthlyCalendar ❌ / dashboard ❌ | — | "今日分成"vs"绩效详情"双数字 | P0 |
| 时间区间语义 | `paid_at::date BETWEEN` | `paid_at >= [JS Date, +1d)` 与 `service_date BETWEEN [str,str]` 双语义 | — | 跨日漂移 | P0 |
| store/scope 隔离 | `scopeCondition()` 强制 | performanceDetail / dashboard / todayCommission / monthlyCalendar 无 store_id 过滤 | — | manager 全集团可读 | P0 |
| customer 字段来源 | (无) | sale_orders 快照 vs service 分支 cu LIVE | — | 同一顾客两个名字 | P2 |
| isManager 判定 | requirePermission(...) | `roles.includes('manager')`（兼容字段） vs requireManager 中间件 | — | 行为漂移 | P2 |
| 退款冲销 | approveRefund 不冲销 sa/sc | sa/sc 旧行不冲销 + 退款单负行混入绩效 | — | 资损 | P0 |

## 5. 横切检查（套用 §3 模板）

- [ ] **CC1 数值**：sa.total_amount + sc.commission_amount NUMERIC 类型 OK；`Math.round(× 100) / 100` 浮点二次舍入有 0.01 漂移风险（建议 PG `ROUND(SUM(...), 2)` 落库返回字符串）
- [ ] **CC2 并发幂等**：performanceDetail 是只读，无幂等问题；但内存分页大数据量是性能瓶颈（P1-18-06）
- [ ] **CC3 组织域隔离**：⚠️ 全失效（P0-18-02），manager 全集团可读
- [ ] **CC4 后端鉴权**：requireStaffBound() 单层，**未过 requireManager**；employeeId 注入后零校验（P0-18-02）
- [ ] **CC5 错误码**：filterType / salesCategory 未做白名单（P1-18-05）；INVALID_PARAMS 仅覆盖 startDate/endDate
- [ ] **CC6 PII**：cu.phone 直接出库到员工端，无脱敏；越权读后果加重（P0-18-02）
- [ ] **CC7 时间字段**：⚠️ JS Date 容器时区 + UTC ISO + PG DATE() 三层漂移（P0-18-03 / P1-18-07，retain audit-17）
- [x] CC8 WXML/Vant：staff-performance 前端 Tab 文案与后端 filterType / salesCategory 映射清晰
- [ ] **CC9 测试残留**：performanceDetail / todayCommission / monthlyCalendar / dashboard 全无 unit / E2E 测试；customer_name / client_phone 用 sale_orders 快照而非 cu 实时（P2-18-12）

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | — | 暂无；service_commissions 缺 service_order_id / store_id 已在 audit-08 P1-08-13 提；本域不重复 | — |
| L3 云函数 routes | `staff.js:475-482` | 加 `o.sale_order_type IN ('销售单','回款单')` 过滤 | P0-18-01 |
| L3 云函数 routes | `staff.js:439, 475-482, 519-523` | 加 `targetEmployeeId` scope 校验 + sa.store_id / sc 关联 store_id ∈ scopeStoreIds | P0-18-02 |
| L3 云函数 routes | `staff.js:445-447, 478-479, 490, 522-523` | 统一两分支为 PG `::date BETWEEN`，参数用字符串不构造 JS Date | P0-18-03 |
| L3 云函数 routes | `staff.js:163-220` | todayCommission 并行查 sc.commission_amount + 加 sale_order_type 过滤 | P1-18-04 / P1-18-09 |
| L3 云函数 routes | `staff.js:582-585` | filterType / salesCategory 白名单校验 | P1-18-05 |
| L3 云函数 routes | `staff.js:457-606` | 改用 SQL 端 LIMIT/OFFSET + UNION ALL，total 单独 COUNT 查询 | P1-18-06 |
| L3 云函数 routes | `staff.js:248-273` | monthlyCalendar 用 PG `paid_at::date` + Asia/Shanghai 时区，避免 JS Date 构造 | P1-18-07 |
| L3 云函数 routes | `staff.js:153, 318, 436, 617` | `roles.includes('manager')` → `roleBindings.some(r => r.role==='manager' && r.scopeType==='门店')` | P2-18-11 |
| L3 云函数 routes | `staff.js:457-482` | LEFT JOIN cu 拉 cu.name/cu.phone 替代 o.customer_name/o.client_phone | P2-18-12 |
| L3 云函数 routes | `staff.js:259-273` | monthlyCalendar UNION ALL service_commissions | P2-18-13 |
| L7 admin actions | (新增) `actions/employee-performance.ts` | 新增 admin 端员工绩效 action（双轨 SUM）+ 列表页 `/employees/[id]/performance` Tab | §10 |
| L9 前端 | `staff-performance.ts:182-200` | 加 filterType / salesCategory 白名单提示 + 加 totalCommission 与 dashboard 数字一致校验 | P1-18-10 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (a) 验证 retain P0-18-01：是否有员工同期 sa 行混入了退款单 / 内部单
SELECT
  o.sale_order_type,
  count(*) AS rows,
  SUM(sa.total_amount::numeric) AS sum_amount
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE sa.is_void = false
  AND o.status = '已支付'
  AND o.paid_at >= NOW() - INTERVAL '60 days'
GROUP BY o.sale_order_type
ORDER BY 1;

-- (b) 验证 P0-18-02：sa 中是否存在跨多个 store_id 的同一员工记录
SELECT
  sa.employee_id,
  count(DISTINCT o.store_id) AS distinct_stores,
  array_agg(DISTINCT o.store_id) AS stores
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE sa.is_void = false
GROUP BY sa.employee_id
HAVING count(DISTINCT o.store_id) > 1
ORDER BY distinct_stores DESC
LIMIT 10;

-- (c) 验证 P0-18-03：销售/服务时间窗口跨日漂移可能性
SELECT
  date(o.paid_at) AS paid_date,
  count(*) AS sa_rows
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE o.paid_at::date >= NOW()::date - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;

SELECT
  so.service_date,
  count(*) AS sc_rows
FROM service_commissions sc
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN service_orders so ON so.service_order_id = sit.service_order_id
WHERE sc.is_void = false
  AND so.service_date >= NOW()::date - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;

-- (d) 验证退款单 sa 行（应被冲销 + 当前未冲销）
SELECT
  o.sale_order_type,
  o.status,
  count(*),
  SUM(sa.total_amount::numeric) AS amount
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE sa.is_void = false
  AND o.sale_order_type = '退款单'
GROUP BY 1, 2;

-- (e) EXPLAIN performanceDetail 销售分支
EXPLAIN
SELECT sa.total_amount, sa.allocation_ratio, si.product_name, si.received, o.paid_at
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE sa.employee_id = 'FY-XXX-001'
  AND sa.is_void = false
  AND o.status = '已支付'
  AND o.paid_at >= '2026-04-01' AND o.paid_at < '2026-05-01'
ORDER BY o.paid_at DESC;
-- 期望：使用 idx_sale_alloc_employee_id；JOIN saleItems / saleOrders 走 PK
```

## 8. 回归测试用例（建议）

1. **P0-18-01 退款单不计入绩效**：员工 4-20 卖 ¥1000 / 4-25 退款 → totalSalesAlloc(4-25) 应仅含 4-25 真正销售，不含 -700 退款负行。
2. **P0-18-01 内部单不计入**：开内部单（sale_order_type='内部'，price × 0.5）→ 不进绩效汇总。
3. **P0-18-02 跨店越权**：A 店店长 X 携 B 店员工 Y 的 employeeId 调用 performanceDetail → 应返回 PERMISSION_DENIED 而非数据。
4. **P0-18-02 美容师查他人**：非 manager 美容师携 employeeId=others → 应被强制改为 staffWfId（而非读到他人数据，**当前代码已 OK**，line 439）。
5. **P0-18-03 时区跨午夜**：mock 容器时区 UTC，员工 paid_at=2026-04-24T16:30Z（=北京 4-25 00:30），选 startDate=endDate='2026-04-25' → 销售分支与服务分支应一致归到 4-25。
6. **P1-18-04 todayCommission 含服务提成**：今日仅 5 单服务（每单 ¥30 提成）零销售 → todayAmount = 150。
7. **P1-18-05 filterType 非法值**：filterType='SALE'（大写）/ 'foo' → INVALID_PARAMS。
8. **P1-18-06 大数据分页**：员工 5000+ sa 行 → page=1 / page=10 翻页响应 < 1s 且无重复行。
9. **P1-18-08 newMember 归属**：员工调店后，原门店历史顾客的 newMember 不应漂到新门店 dashboard。
10. **P2-18-11 manager scope 类型**：HQ 临时账号 manager + scopeType='市场' → todayCommission 不应触发 isManager=true 分支去算 storeTodayRevenue。

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（admin 缺位 + staff 双轨双时区漂移 + 与 audit-07/08/11/17 横向耦合）
- 涉及历史数据：☑（既有 sa/sc 行未冲销 → 历史绩效已包含退款负行 / 重复回款行 / 跨店混入；修复后报表数字会变，需配合数据回填策略）
- 修复成本：M（store/scope 加固 + 时区统一 + 退款冲销 + service_commissions 接入 todayCommission/monthlyCalendar 各 30-60 分钟一处，集中改 routes/staff.js 与同 audit-08 P0-08-04/audit-07 P0-07-02 联动一次性发版）

## 10. 后续待办

- [ ] **新建 admin 员工绩效 action / 页面**：在 `(main)/employees/[id]` 新增"绩效"Tab，复用 staff.performanceDetail 的 SQL 但加 admin scopeCondition；HR/财务对账急需。
- [ ] 与 audit-07 P0-07-02（销售提成退款不冲销）+ audit-08 P0-08-04（服务提成退款不冲销）联合排期发版。
- [ ] 全仓 grep `roles.includes('manager')` 替换为 roleBindings 判定（与 staff.js 跨函数一致）。
- [ ] 文档化"员工绩效统计口径"在 `.42cog/pm/staff.pr.spec.md §3.15`：明确销售 sa.total_amount + 服务 sc.commission_amount 双轨、退款冲销策略、时区基准（Asia/Shanghai PG 端）、跨店店长可见范围。
- [ ] 与 audit-17 时区漂移族系统一规划修复（dashboard / todayCommission / monthlyCalendar / performanceDetail / orders.dateStr / service.dateStr）一次性切到 PG ::date AT TIME ZONE。
- [ ] 起 ticket 跟踪 `totalServiceFee` 兼容字段下线（P2-18-14）。
