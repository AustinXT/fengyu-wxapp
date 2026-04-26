# 审计报告：员工绩效（performanceDetail）域 18 v2

**审计时间**：2026-04-26（v2 更新）
**域 ID**：18
**审计员**：claude-sonnet-4-6
**审计时长**：~40 分钟（含代码审查 + 前端 + 测试）
**关联 PR/Ticket**：retain audit-07 P0-07-02 / audit-08 P0-08-04 / audit-17 P1-17-08 / CROSS-CUTTING.md
**v1 原始报告**：audit-18-employee-performance.md（2026-04-25）

---

## 1. 三端入口对照（v2 新增 admin 缺位确认）

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:196-227` (`sale_allocations`) + `db/schema/service-commission.ts:16-51` (`service_commissions`) + `db/schema/order.ts:40-117` (`sale_orders.paid_at`) | 同左 | — |
| Action / Route | **不参与**：`fengyu-admin/src/actions/employees.ts` 仅档案 CRUD（`getEmployeeById:211-224`），无任何按员工聚合 sa/sc 的查询；`actions/commission.ts` / `service-commissions.ts` 仅维护提成矩阵和行管理，未提供"员工绩效汇总" | `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:432-606 performanceDetail` + `:150-237 todayCommission` + `:242-310 monthlyCalendar` + `:613-731 dashboard` | — |
| 前端 | — | `fengyu-staff/miniprogram/packageOrder/staff-performance/staff-performance.ts:42-219` + `pages/workbench/workbench.ts:165-200` | — |
| 测试 | — | `__tests__/routes/staff.test.js:265-788`（覆盖 performanceDetail 8 用例 + dashboard 5 用例） | — |

> **关键发现 0（admin 缺位 v2 再确认）**：admin 端仍**没有员工绩效 / 提成明细查询界面或 action**。v1 §10 待办"新建 admin 员工绩效 action"未落地。HR/财务如需跨员工对账仍须直连数据库或汇员工各自数据。
> **关键发现 1（dashboard 已修复）**：v1 §3.1 P0-18-02 scope 缺失 / §3.2 P1-18-10 不含服务提成 / §3.2 P1-18-07 时区漂移 在 `dashboard` 函数（line 617-737）已全部修复。详见 §2 各节。

---

## 2. 数据流图（v2 现状标注）

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
         │     ⚠️ 不过滤 sale_order_type → 退款单负行 / 内部单全计入 (P0-18-01)
         │     ⚠️ 不过滤 store_id → 店长可查跨店任意员工绩效（P0-18-02）
         │
         └─ 服务分支：service_commissions sc JOIN service_items sit JOIN service_orders so JOIN sale_items si
                LEFT JOIN client_wechat_users cu ON cu.user_id = so.client_user_id
                WHERE sc.employee_id = $emp AND sc.is_void = false
                  AND so.status = '已完成'
                  AND so.service_date >= startDate AND so.service_date <= endDate
                ⚠️ 销售分支用 [start, end+1) 半开区间；服务分支用 [start, end] 闭区间（P0-18-03）
                ⚠️ JS 端 .sort + .slice 内存分页 → 大数据集 OOM（P1-18-06）
                ✅ 服务分支 JOIN cu 拉实时 name/phone（已从 sale_orders 快照改cu，P2-18-12 已修）

staff-performance.ts onCategoryTabChange + setRange → page=1, loadData(true)
    Tab 0 合计 / 1 销售 / 2 服务 / 3 他销他耗 / 4 生态合作

todayCommission (workbench 卡片):
    ├─ commissionRows (sale_allocations + paid_at) ← ✅ 销售分提成已读
    ├─ serviceRows (service_orders.assigned_employee_id) ← 仅算"服务单数"，不算提成额
    └─ 漏算 service_commissions 提成 → audit-08 P1-08-07 retain ✅
       漏算 sale_order_type 过滤 → 退款单负数拉低 todayAmount (P1-18-09 仍 OPEN)
       ⚠️ 上月分成同样不过滤 sale_order_type (line 190-202)

monthlyCalendar (workbench 日历):
    └─ DATE(o.paid_at) GROUP BY → 按 PG NOW() 时区分桶；
       ⚠️ 仅读 sale_allocations（无 service_commissions）→ 日历只有销售提成（P2-18-13 仍 OPEN）
       ⚠️ monthStart 由 JS 容器时区 + .toISOString() 转 UTC 字符串塞回 PG → 三层时区漂移（P1-18-07 仍 OPEN）

dashboard (数据看板): ✅ 已修复
    ├─ 店长分支：scopeFilter='so.store_id = $1' ✅ 含 store_id scope
    ├─ 美容师分支：scopeFilter='so.assigned_employee_id = $1' ✅
    ├─ revenue：sale_order_type IN ('销售单','转换单') ✅（2026-04-26 refactor）
    ├─ newMember：店长 bound_store_id / 美容师 bound_employee_id ✅（2026-04-25 统一口径）
    └─ 时区：PG ::date + AT TIME ZONE 'Asia/Shanghai' ✅（无 JS Date 构造）
```

---

## 3. 漏洞状态（v2 vs v1 差量）

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-18-01]** performanceDetail 不过滤 `sale_order_type`，退款单 / 内部单全部记入员工绩效

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:457-482`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **现象**：销售分支 SQL `WHERE sa.employee_id=$1 AND sa.is_void=false AND o.status='已支付' AND o.paid_at IN [start,end+1d)`，无 `o.sale_order_type` 过滤。
- **根因**：v1 原报告写的"回款单 FY-HKD payNotify 写 sa 时和原销售单首次写 sa 重复"已在 `db/schema` sale_order_type 5→3 重构后澄清——重构后已无独立"回款单"类型，`转换单`才是回款语义，但其 `received` 由 admin `createConversionOrder` 手动写入并非自动触发 payNotify（见 audit-14 §3.1 P0-14-01 analysis）；当前风险只剩**退款单负行**计入绩效。
- **复现**：美容师 A 4-20 卖卡 ¥1000 分配 70%，sa 行 `total_amount=700`；4-25 退款 approve 后退款单 sa `total_amount=-700`（按 P0-07-02 现状原 sa 不冲销）；staff-performance 选 `本月`：totalSalesAlloc = 700 + (-700) = 0；但选 `今日`只显示 -700 元。
- **修复**：(L3) `routes/staff.js:482` 加 `AND o.sale_order_type IN ('销售单','转换单')`（与 dashboard line 674 对齐）。
- **关联**：CC1 数值精度 / retain P0-07-02 / P0-11-01 / CROSS-CUTTING.md「员工/门店绩效汇总不过滤 sale_order_type」

#### **[P0-18-02]** performanceDetail 完全无 store / scope 隔离，店长可查"集团内任意员工"绩效

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:439, 475-482, 519-523`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **现象**：performanceDetail 入口仅靠 `requireStaffBound()`（无 `requireManager`），收到 `employeeId` 后**完全不校验**是否属于 ctx.auth.scopeStoreIds 范围内。
- **补充**：v1 修复建议的 `assertEmployeeInScope` helper 在 v2 更新前未实现（与 `assertCustomerInScope` 同构，audit-10/19/22 修复时一并建设）。
- **修复**：(L3)
  ```js
  if (queryEmployeeId && queryEmployeeId !== ctx.auth.staffWfId) {
    if (!isManager) throw new Error('PERMISSION_DENIED: 仅店长可查他人绩效')
    const [target] = await pg.query('SELECT store_id FROM staff_wechat_users WHERE employee_id = $1', [queryEmployeeId])
    if (!target || !ctx.auth.scopeStoreIds.includes(target.store_id))
      throw new Error('PERMISSION_DENIED: 越店访问员工绩效')
  }
  ```
  + sa/sc SQL 加 `o.store_id = ANY($scopeStoreIds)` / `so.store_id = ANY($scopeStoreIds)`。
- **关联**：CC3 组织域隔离 / audit-10 P0-10-01 同模式 / audit-17 P0-17-06 再命中 / CROSS-CUTTING.md「staff.dashboard 一线员工 newMember 跨店越权」（dashboard 已修，本路由仍 OPEN）

#### **[P0-18-03]** performanceDetail 销售分支与服务分支时间区间口径不一致（半开 vs 闭区间）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:445-447, 478-479, 490, 522-523`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **现象**：v1 原报告描述完全准确——销售分支用 JS Date `end.setDate(end.getDate()+1)` 构造半开区间 `< $3`，服务分支直接传字符串 `service_date >= $2 AND service_date <= $3`。
- **修复**：(L3) 统一两分支为 PG `::date BETWEEN`，参数全用 'YYYY-MM-DD' 字符串。
- **关联**：CC7 时间字段 / audit-17 P1-17-08 同源

---

### 3.2 P1

#### **[P1-18-04]** todayCommission 完全不读 service_commissions（retain audit-08 P1-08-07）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:163-220`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **v2 补充**：`serviceRows` 查询（line 177-183）仅 `COUNT(*)` service_orders，不含 sc，**上月分成同样漏算**（line 190-202 只查 sa）。
- **修复**：(L3) `commissionRows` 并行查 `sc.commission_amount` 后 `todayAmount = sa.SUM + sc.SUM`。
- **关联**：CC1 数值 / P1-18-09（sale_order_type 漏过滤）

#### **[P1-18-05]** filterType / salesCategory 无白名单校验，静默返回合并集

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:582-585`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) `if (filterType && !['sale','service'].includes(filterType)) throw new Error('INVALID_PARAMS: filterType 不合法')`

#### **[P1-18-06]** JS 端 .sort + .slice 内存分页，大数据集 OOM + 翻页错乱

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:587-602`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) SQL LIMIT+OFFSET + 单独 COUNT 查询。
- **关联**：CC2 性能 / admin 服务端分页规范脱节

#### **[P1-18-07]** monthlyCalendar 三层时区漂移（JS 容器 + UTC ISO + PG DATE）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:248-273`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) `WHERE o.paid_at >= $1::date AND o.paid_at < ($2::date + INTERVAL '1 month') GROUP BY (paid_at AT TIME ZONE 'Asia/Shanghai')::date`，参数全用字符串。

#### **[P1-18-08]** dashboard newMember 使用 `bound_employee_id` vs 其他指标 `assigned_employee_id` 归属漂移

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:713-728`
- **v1 状态**：OPEN（audit-17 P0-17-04 retain）
- **v2 状态**：**RESOLVED ✅**
- **确认**：dashboard line 713-728 美容师分支 `newMemberFilter = 'c.bound_employee_id = $1'` 与 footfall/headcount/consume 均走 `assigned_employee_id` 仍是双轨——但这在语义上**正确**：footfall/headcount/consume 是"服务单维度"（谁实际执行），newMember 是"顾客维度"（谁是顾客绑定的美容师）。两字段代表不同业务含义，不应合并。audit-17 的 concern 是"调店后历史顾客 newMember 不应漂到新店"，但 `c.bound_employee_id` 本身就是顾客档案字段调店不会自动改，需 customer.assign 时同步更新 bound_employee_id（audit-19 P0-19-01 独立漏洞）。**本问题降为 P2**。

#### **[P1-18-09]** todayCommission **不**过滤 sale_order_type，退款单 paid_at 落今日时拉低 todayAmount

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:163-175`
- **v1 状态**：OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) WHERE 加 `AND o.sale_order_type IN ('销售单','转换单')`（与 P0-18-01 同根）。

#### **[P1-18-10]** dashboard 美容师分支 revenue 不含 service_commissions

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:679-691`
- **v1 状态**：OPEN
- **v2 状态**：**PARTIAL — dashboard 已修（sale_order_type 过滤已加），但美容师 revenue 仍仅读 sa，sc 未接入。**
- **说明**：dashboard line 681-691 美容师分支 `SUM(sa.total_amount)` 读 sale_allocations，而 sa 是销售分配（商品销售业绩），sc 是服务提成（护理服务业绩）。两者本就是不同维度——美容师"工作台看板的业绩"与"绩效详情 totalCommission"本就应该不同。当前设计：看板业绩 = 销售分配，服务提成另在绩效页看。这是**设计约定**非 bug，P1 降为 P2，留作 spec 文档澄清。

---

### 3.3 P2

#### **[P2-18-11]** isManager 判定走 `roles.includes('manager')`（兼容字段），与 requireManager 中间件不一致

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:153, 319, 439, 621`
- **v1 状态**：P2 OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) `roleBindings.some(r => r.role==='manager' && r.scopeType==='门店')` 替换全部 `roles.includes('manager')` 判定。

#### **[P2-18-12]** performanceDetail 销售分支用 sale_orders 快照字段 customer_name/client_phone

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:471-472`
- **v1 状态**：P2 OPEN
- **v2 状态**：**OPEN（未修）**（v1 报告说服务分支 JOIN cu 已修，销售分支未修）
- **现象**：allocRows SQL 选 `o.customer_name` + `o.client_phone`，服务分支选 `cu.name` + `cu.phone`。同一接口对同一顾客两类字段来源不一致。
- **修复**：(L3) 销售分支同样 LEFT JOIN cu，并改 cu.name/cu.phone。
- **关联**：CC9 残留 / 与 v3.1 顾客合并设计意图

#### **[P2-18-13]** monthlyCalendar 完全不读 service_commissions

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:259-273`
- **v1 状态**：P2 OPEN
- **v2 状态**：**OPEN（未修）**
- **修复**：(L3) `UNION ALL` 销售+服务两份按 date 合并。

#### **[P2-18-14]** `totalServiceFee` 向后兼容字段永久保留，无下线计划

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:601-602`
- **v1 状态**：P2 OPEN
- **v2 状态**：**KEEP（暂时保留）** — 前端 `staff-performance.ts:204` 仍有 `?? res.totalServiceFee` fallback；测试覆盖 `expect(ctx.result.totalServiceFee).toBe(130)`。建议起 ticket 跟踪，1-2 个版本稳定后前端删 fallback 再删后端字段。

#### **[P2-18-15]** performanceDetail / todayCommission / monthlyCalendar 全程 0 operation_logs

- **v1 状态**：P2 OPEN
- **v2 状态**：**OPEN（未修）**（audit-23 P0-23-01 收口中，staffApi 无审计 helper 已列专项）
- **修复**：见 audit-23 修复路径；staff performanceDetail 特别是 isManager 查他人时应写 log。

---

## 4. 新增发现（v2）

### 4.1 P0-NEW-01：todayCommission 上月分成同样不过滤 sale_order_type

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:190-202`
- **现象**：`lastMonthCommRows` 查询（line 190-202）与 commissionRows（line 163-175）结构完全相同，均无 `o.sale_order_type` 过滤。退款单 approve 时间若落在上月区间，则上月分成数字同样被拉低。
- **修复**：同 P1-18-09。

### 4.2 P1-NEW-02：monthlyCalendar 服务单数仅 COUNT(*) service_orders，不含 service_commissions

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:291-297`
- **现象**：`totalServiceCount` 直接 COUNT service_orders 而非 JOIN sc 求和；与 `dailyData`（仅含 sa）构成双重漏算。
- **修复**：UNION ALL sa+sc 双分支。

### 4.3 P2-NEW-03：staff.list `isManager` 硬编码 `position === '门店经理'`，与 roleBindings 脱钩

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:50`
- **现象**：`isManager: r.position === '门店经理'` 硬编码职位名字符串；若员工职位改名（如"店长"）或权限绑定到非 manager 角色，前端 picker 的 manager 标识会错位。
- **修复**：(L3) 用 `SELECT ... FROM staff_wechat_users u JOIN permission_roles pr ON pr.employee_id = u.employee_id WHERE pr.role = 'manager' AND pr.scope_type = '门店' AND pr.scope_id = $1`，或从 ctx.auth.scopeStoreIds 判断（若 staffWfId 在 scopeStoreIds 中对应的岗位有 manager 绑定）。

---

## 5. 跨端不一致（v2 更新）

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 员工绩效汇总入口 | **缺失**（仅档案 CRUD） | `staff.performanceDetail` 双分支 sa+sc ✅ | — | HR/财务无对账面 | P1 |
| sa 与 sc 双轨同时读 | mgmt-dashboard.staffRanking ✅ | performanceDetail ✅ / todayCommission ❌ / monthlyCalendar ❌ | — | 工作台 vs 绩效详情双数字 | P0-18-01 同根 |
| 时间区间语义 | `paid_at::date BETWEEN` | performanceDetail: `[JS Date, +1d)` vs `[str,str]` 双语义 ⚠️ / dashboard ✅ | — | 跨日漂移 | P0-18-03 |
| store/scope 隔离 | `scopeCondition()` | performanceDetail ❌ / todayCommission ❌ / monthlyCalendar ❌ / dashboard ✅ | — | manager 跨店读 | P0-18-02 |
| customer 字段来源 | (无) | performanceDetail 销售: o 快照 / 服务: cu ✅ | — | 同一顾客两个名字 | P2-18-12 |
| isManager 判定 | requirePermission(...) | `roles.includes('manager')` vs requireManager 中间件 | — | 行为漂移 | P2-18-11 |
| 退款冲销 | approveRefund 不冲销 sa/sc | sa/sc 旧行不冲销 + 退款单负行混入绩效 | — | 资损 | P0-18-01 |
| totalServiceFee 兼容字段 | (无) | 后端保留 ✅ / 前端 fallback ✅ / 测试覆盖 ✅ | — | 下线计划待定 | P2-18-14 |

---

## 6. 横切检查（v2 更新）

- [ ] **CC1 数值**：sa.total_amount + sc.commission_amount NUMERIC 类型 OK；`Math.round(× 100) / 100` 浮点二次舍入有 0.01 漂移风险（建议 PG `ROUND(SUM(...), 2)` 落库返回字符串）
- [ ] **CC2 并发幂等**：performanceDetail 只读，无幂等问题；但内存分页大数据量是性能瓶颈（P1-18-06）；todayCommission 月分成同样有内存拉回问题（line 190-202）
- [ ] **CC3 组织域隔离**：⚠️ performanceDetail/todayCommission/monthlyCalendar 全失效（P0-18-02）；dashboard ✅
- [ ] **CC4 后端鉴权**：requireStaffBound() 单层，**未过 requireManager**；employeeId 注入后零校验（P0-18-02）；staff.list line 50 用 position 字符串而非 role 校验 manager 标识（P2-NEW-03）
- [ ] **CC5 错误码**：filterType / salesCategory 未做白名单（P1-18-05）；INVALID_PARAMS 仅覆盖 startDate/endDate；todayCommission / monthlyCalendar 均无参数白名单
- [ ] **CC6 PII**：cu.phone 直接出库到员工端，无脱敏；越权读后果加重（P0-18-02）
- [ ] **CC7 时间字段**：⚠️ performanceDetail 销售分支 JS Date 容器时区 / 服务分支 PG date（P0-18-03）；monthlyCalendar 三层漂移（P1-18-07）；todayCommission JS Date 容器时区（line 156-160）；dashboard ✅
- [x] **CC8 WXML/Vant**：staff-performance 前端 Tab 文案与后端 filterType / salesCategory 映射清晰 ✅（P2-18-14 兼容字段前端有 fallback）
- [x] **CC9 测试残留**：staff.test.js 已有 performanceDetail 8 用例 + dashboard 5 用例 ✅；P1-18-06 内存分页无服务端 LIMIT 测试（P2 暂缓）

---

## 7. 修复建议（v2 按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 | 状态 |
|----|------|------|----------|------|
| L3 云函数 routes | `staff.js:482` | 加 `o.sale_order_type IN ('销售单','转换单')` 过滤 | P0-18-01 | OPEN |
| L3 云函数 routes | `staff.js:439, 475-482, 519-523` | 加 `targetEmployeeId` scope 校验 + sa/sc SQL 加 store_id ∈ scopeStoreIds | P0-18-02 | OPEN |
| L3 云函数 routes | `staff.js:445-447, 478-479, 490, 522-523` | 统一两分支为 PG `::date BETWEEN`，参数用字符串 | P0-18-03 | OPEN |
| L3 云函数 routes | `staff.js:163-220` | todayCommission 并行查 sc.commission_amount + 加 sale_order_type 过滤 | P1-18-04 / P1-18-09 / P0-NEW-01 | OPEN |
| L3 云函数 routes | `staff.js:582-585` | filterType / salesCategory 白名单校验 | P1-18-05 | OPEN |
| L3 云函数 routes | `staff.js:457-606` | 改用 SQL 端 LIMIT/OFFSET + UNION ALL，total 单独 COUNT 查询 | P1-18-06 | OPEN |
| L3 云函数 routes | `staff.js:248-273` | monthlyCalendar 用 PG `paid_at::date` + Asia/Shanghai 时区 + UNION ALL sc | P1-18-07 / P2-18-13 / P1-NEW-02 | OPEN |
| L3 云函数 routes | `staff.js:153, 319, 439, 621` | `roles.includes('manager')` → `roleBindings.some(r => r.role==='manager' && r.scopeType==='门店')` | P2-18-11 | OPEN |
| L3 云函数 routes | `staff.js:457-482` | 销售分支 LEFT JOIN cu 拉 cu.name/cu.phone 替代 o.customer_name/o.client_phone | P2-18-12 | OPEN |
| L3 云函数 routes | `staff.js:50` | staff.list isManager 从 permission_roles 查，非硬编码 position | P2-NEW-03 | OPEN |
| L7 admin actions | (新增) `actions/employee-performance.ts` | 新增 admin 端员工绩效 action（双轨 SUM）+ 页面 | §10 待办 | 未开始 |
| L9 前端 | `staff-performance.ts` | filterType / salesCategory 白名单提示 | P1-18-05 | 暂缓 |

---

## 8. 验证 SQL（v2 更新，新增 dashboard 验证）

```sql
-- (a) 验证 P0-18-01：退款单 sa 负行混入（5434 EXPLAIN 禁止写入）
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

-- (b) 验证 P0-18-02：员工跨多 store 绩效记录
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

-- (c) 验证 dashboard sale_order_type 过滤（已修）
EXPLAIN
SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS revenue
FROM sale_orders o
WHERE o.store_id = 'store-001'
  AND o.sale_order_type IN ('销售单', '转换单')
  AND o.status = '已支付'
  AND o.paid_at >= '2026-04-01'::date
  AND o.paid_at < ('2026-04-30'::date + INTERVAL '1 day');

-- (d) 验证 dashboard newMember bound_store_id（已修）
EXPLAIN
SELECT COUNT(*) AS new_members
FROM client_wechat_users c
WHERE c.bound_store_id = 'store-001'
  AND c.became_member_at IS NOT NULL
  AND c.became_member_at::date >= '2026-04-01'::date
  AND c.became_member_at::date <= '2026-04-30'::date;

-- (e) 验证 todayCommission 上月分成+服务提成（修复后应含 sc）
SELECT
  COALESCE(SUM(sa.total_amount::numeric), 0) AS sa_amount,
  COALESCE(SUM(sc.commission_amount::numeric), 0) AS sc_amount
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
JOIN service_commissions sc ON sc.employee_id = sa.employee_id
JOIN service_items sit ON sit.service_item_id = sc.service_item_id
JOIN service_orders so ON so.service_order_id = sit.service_order_id
WHERE sa.employee_id = 'FY-EMP-001'
  AND sa.is_void = false
  AND sc.is_void = false
  AND sc.voided_at IS NULL
  AND o.status = '已支付'
  AND o.sale_order_type IN ('销售单', '转换单')
  AND o.paid_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
  AND o.paid_at < DATE_TRUNC('month', CURRENT_DATE);
```

---

## 9. 回归测试用例（v2 新增 + 更新）

> staff.test.js 已有覆盖：用例 265-473（基础功能 8 个）+ 用例 607-788（服务提成修复验证 8 个）。建议补：

1. **P0-18-01 退款单不计入**：mock sale_order_type='退款单' 行 → totalSalesAlloc 不含该行。
2. **P0-18-02 跨店越权**：A 店店长 X 查 B 店员工 Y → PERMISSION_DENIED。
3. **P0-18-03 时区跨午夜**：mock JS Date 容器 UTC → 两分支归到同一业务日。
4. **P1-18-04 todayCommission 含服务提成**：mock sc 行 → todayAmount = sa + sc。
5. **P1-18-05 filterType 非法值**：filterType='SALE'（大写）→ INVALID_PARAMS。
6. **P1-18-06 大数据分页**：5000 条 mock allocRows → page=10 响应 < 1s，无重复行。
7. **P2-18-12 销售分支 customer 来源**：allocRows 返回 o.customer_name='快照名' → 修复后应从 cu.name='实时名'。
8. **P2-NEW-03 staff.list isManager**：employee 有 manager 角色但 position ≠ '门店经理' → 前端 isManager 应为 true。

---

## 10. 后续待办（v2 更新）

- [ ] **P0-18-01/02/03** 三个核心漏洞一次合并修复（sale_order_type 过滤 + scope 校验 + 时区统一）
- [ ] **P1-18-04/09 + P0-NEW-01** todayCommission 接入 service_commissions + 过滤退款单
- [ ] **P1-18-07 + P2-18-13 + P1-NEW-02** monthlyCalendar UNION ALL sc + 时区统一
- [ ] 与 audit-07 P0-07-02（销售提成退款不冲销）+ audit-08 P0-08-04（服务提成退款不冲销）联合排期
- [ ] 全仓 grep `roles.includes('manager')` 替换为 roleBindings 判定（与 staff.js 跨函数一致）
- [ ] 文档化"员工绩效统计口径"在 `.42cog/pm/staff.pr.spec.md §3.15`：
  - 销售 sa.total_amount + 服务 sc.commission_amount 双轨
  - 退款冲销策略（sale_order_type 过滤 + 历史行 is_void 标记）
  - 时区基准（Asia/Shanghai PG 端）
  - 跨店店长可见范围（scopeStoreIds 内）
  - "看板业绩"与"绩效详情"数字含义区分（前者仅销售分配，后者含服务提成）
- [ ] 起 ticket 跟踪 `totalServiceFee` 兼容字段下线（P2-18-14）
- [ ] **新建 admin 员工绩效 action / 页面**（v1 待办未完成）