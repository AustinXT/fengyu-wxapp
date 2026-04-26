# 审计报告：组织域数据隔离（CC3-vFinal）

**审计时间**：2026-04-25 初审 → 2026-04-26 重审 → 2026-04-26 合并终版
**域 ID**：CC3
**审计员**：claude-opus-4-7（初审）/ claude（重审合并）
**版本**：vFinal（合并初审 v1 + 重审 v2，排除已修复项，纳入 v2 新发现）
**基线**：对照 `audit-CC3-org-isolation.md`（v1，2026-04-25）和 `audit-CC3-org-isolation-v2.md`（v2，2026-04-26）

---

## 1. 三端入口对照（CC3 是横切域，对照"scope 强制点"而非业务路由）

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema 锚点 | `db/schema/org.ts:17-34 orgNodes` + `:41-69 stores` + `db/schema/permission.ts:12-35 permissionRoles` | 同上 | 同上 |
| Auth Session | `fengyu-admin/src/lib/auth.ts:12 getSession` + `actions/auth.ts:getSessionFromCookie` 注入 `permissions.scopeStoreIds` | `staffApi/middleware/auth.js:205 expandScopeStoreIds` 注入 `ctx.auth.{scopeStoreIds, loginLevel, effectiveStoreId, currentStoreId}` | `clientApi/middleware/auth.js` 仅注入 `ctx.auth.userId/phone/openid`，**完全没有 scope 概念**（顾客端按 user 自隔离） |
| Scope helper | `fengyu-admin/src/lib/permissions.ts:158 buildScopeWhere` + `:184 scopeCondition` + `:203 isInScope` + `:108 expandScopeStoreIds` + `:170 isAdminScope` | `staffApi/utils/scope.js:139 buildStoreScopeCondition` + `:82 expandScopeStoreIds` + `:25 deriveStaffLevel` + `:59 deriveAvailableLoginLevels` | **零 helper**；每个路由手写 `WHERE client_user_id = $1` |
| Mgmt 路由内联副本 | — | `routes/mgmt-customer.js:49-90` + `mgmt-dashboard.js:40-89` + `mgmt-traffic.js:40-89` 三处副本 `buildScopeFilter / buildClientScopeFilter`（**绕开 utils/scope 主 helper，自成一套**） | — |
| 测试 | `fengyu-admin/src/lib/permissions.test.ts` | `staffApi/__tests__/utils/scope.test.js`（**只测 helper，不测 routes 是否调用 helper**） | — |

---

## 2. 数据流图（隔离边界）

```
admin (manager/finance/customer_mgr)
   getSession → roles[].scopeId → expandScopeStoreIds → permissions.scopeStoreIds[]
       ↓ Drizzle .where(and(..., scopeCondition(session, table.storeId)))
       ↓ 如果 isAdminScope(session) → 返回 undefined（admin 不过滤）

staff (manager/staff)
   middleware/auth.js → roleBindings → expandScopeStoreIds → ctx.auth.scopeStoreIds
       ↓ deriveStaffLevel + loginLevel='store' → effectiveStoreId 单值
       ↓ deriveStaffLevel + loginLevel='management' → effectiveStoreId=null + scopeStoreIds 数组
       ↓ buildStoreScopeCondition(auth, column) ← 【零路由调用】
       ↓ 路由各自写 store_id = $1（取 effectiveStoreId）→ 管理层模式 NULL 命中空集

client (顾客)
   middleware/auth.js → ctx.auth.userId
       ↓ 路由手写 WHERE client_user_id = $1（无 helper、无 lint）
       ↓ 部分路由忘 requirePhone() 直接读 ctx.auth.userId（CC4 重灾区）

跨域逃逸点（PII 泄露 / 越权风险）：
  customerId / employeeId / clientUserId / saleOrderId / appointmentId / serviceOrderId / saleItemId
  作为 payload 入参时，三端各自决定是否校验"实体属于 session scope"
```

---

## 3. 发现问题（按优先级分节）

### 3.1 P0 — 阻断/资损/越权（OPEN 未修复）

> v1 首发标记，v2 重审确认仍 OPEN。

---

**[P0-01]** `customer.detail`：零 store_id 过滤，任意员工可读跨店顾客全档案

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:242-342`
- 代码：仅按 `customer_id` / `user_id` / `phone` 查找，无任何门店过滤；`getVisitInfo`/`getTopProduct`/`getConsumptionStats` 三个子查询也无 store_id 过滤
- 风险：员工传入任意 `id`/`clientUserId`/`phone`，可读取任意他店顾客的姓名、手机号（店长不脱敏）、皮肤类型、备注、消费统计
- 修复：(L3) 加 `assertCustomerInScope(ctx, pgUser.bound_store_id)`

---

**[P0-02]** `customer.giftHistory`：零 store_id 过滤，赠送记录跨店可读

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:823-909`
- 代码：WHERE 仅 `o.client_user_id = $1`，无 store_id 约束
- 风险：员工传入跨店顾客 `clientUserId`，可读其在全系统任意门店的赠送记录（received=0 行）

---

**[P0-03]** `customer.updateNotes`：零 store_id 过滤，可跨店修改任意顾客备注

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:914-933`
- 代码：`UPDATE client_wechat_users SET notes = $1 WHERE user_id = $2`（无归属校验）
- 风险：任意 `requireStaffBound` 员工（含一线员工）可修改任何门店顾客的备注字段

---

**[P0-04]** `customer.assign`：顾客归属未校验，可跨店分配顾客（业绩资损）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:967-995`
- 代码：验证了 employee 在本店，但未验证 `clientUserId` 是否属于本店
- 风险：店长可将其他门店顾客的 `bound_employee_id` 分配给自己门店员工，影响原店业绩归属

---

**[P0-05]** `customer.search`（phone 分支）：跨全系统查询，暴露他店顾客 PII

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:35-43`
- 代码：`WHERE c.phone = $1 AND c.bound_store_id IS NOT NULL`（无门店过滤）；keyword 分支和默认分支有 `bound_store_id = $effectiveStoreId`，phone 分支无
- 风险：任意员工用手机号精确搜索，可查到全系统任意绑店顾客姓名和手机号（店长不脱敏）
- 备注：phone 分支为开单场景设计，但 `isManagerRole` 判断后再不脱敏，存在店长查他店顾客路径；需业务确认设计意图

---

**[P0-06]** `staff.performanceDetail`（店长查他人）：无门店过滤，跨店读取他店员工业绩明细

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:435-530`
- 代码：
  ```js
  const targetEmployeeId = (isManager && queryEmployeeId) ? queryEmployeeId : ctx.auth.staffWfId
  // 后续查 sale_allocations / service_commissions 均仅 WHERE sa.employee_id = $1
  // 无 o.store_id = effectiveStoreId 约束
  ```
- 风险：店长传入他店员工的 `employeeId`，可读取该员工全部销售提成明细（含顾客姓名、手机号、金额）和服务提成明细
- v2 新发现：v1 仅泛泛提及 `staff.performanceDetail`，v2 逐行确认该越权路径

---

**[P0-07]** admin `coupons.ts getAvailableCoupons`：零 scope，可枚举任意顾客券面值

- 文件：`fengyu-admin/src/actions/coupons.ts:106`
- 代码：函数接收 `clientUserId`、`totalAmount`、`storeId` 但仅 `requirePermission`，无 `isInScope` 或 `scopeCondition`
- 风险：持有 `sale_order:create` 权限的任意管理员可传入任意 `clientUserId` 枚举其全部券模板实际面值

---

### 3.2 P1 — 数据一致 / 隔离不完整（OPEN 未修复）

**[P1-01]** `customer.calendar`：无 store_id 过滤，返回顾客全系统消费日历

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:146-237`
- 代码：WHERE 仅 `client_user_id = $3` 或 `client_phone = $3` + 日期范围，无任何 `store_id` 约束
- 风险：员工传入他店顾客 ID，可读到该顾客在全系统任意门店的月度消费日历（含订单金额、支付时间）

---

**[P1-02]** `staffApi utils/scope.js` `expandScopeStoreIds` 使用 `::uuid[]` 而 `org_nodes.id` 是 text

- 文件：`staffApi/utils/scope.js:112,120`
- 代码：`WHERE o.parent_id = ANY($1::uuid[]) AND o.type = '门店'`
- 风险：`org_nodes.id` 为 text 类型，强制 cast `::uuid[]` 在包含非 UUID 格式时触发 PG `22P02 invalid_text_representation`，导致所有市场级管理层账号 scope 展开失败，`scopeStoreIds=[]`，后续全部 mgmt-* 接口返回空集

---

**[P1-03]** `customer.search`（phone 分支 scope 风险）

- 同 P0-05，需业务决策是否允许跨店查询；若不允许，补 `bound_store_id = $effectiveStoreId`

---

### 3.3 P2 — 代码质量 / 可维护性

**[P2-01]** `buildStoreScopeCondition` 在所有业务路由中零调用（v1 **[P0-CC3-01]** / v2 **[P2-V2-14]**）

- 文件：`staffApi/utils/scope.js:139-160` vs `staffApi/routes/*.js`
- 验证：`grep -rn "buildStoreScopeCondition" routes/` 仅返回 `auth.js`（仅引用 `expandScopeStoreIds`）；routes 下 0 个文件调用该 helper
- 风险：管理层模式（loginLevel='management'，effectiveStoreId=null）下，全部 routes 的 `WHERE store_id = $null` 返回空集（非预期行为，管理层应跨店看全集）

---

**[P2-02]** mgmt-* 三路由各自复制 scope helper（v1 **[P0-CC3-05]** / v2 **[P2-V2-15]**）

- 文件：`mgmt-customer.js:61-90`、`mgmt-dashboard.js:158-191`、`mgmt-traffic.js:50-77`
- 均有本地 `buildSaleScope`/`buildClientScope`/`buildStaffScope`，与 `utils/scope.buildStoreScopeCondition` 策略不同
- 风险：三副本 scope 实现逻辑漂移，后续 org_nodes 结构变化需改 4 处；功能上三副本实现了正确的市场级展开（via `JOIN org_nodes WHERE parent_id = $scopeId`），优于 routes 层的裸单值逻辑，但维护成本高

---

**[P2-03]** `createPickup` 使用 `requireStaffBound` 而非 `requireManager`（v1 **[P0-CC3-02]** 提及，v2 降为 P2）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:2422-2423`
- 补偿措施：SQL WHERE 含 `store_id = effectiveStoreId`，权限缺口降级为 P2

---

**[P2-04]** clientApi 多函数缺 `requirePhone`（v1 **[P0-CC3-04]** / v2 **[P2-V2-16]**）

- 文件：`message.js`（3函数）、`points.js`（2函数）、`service.js`（list/detail）、`appointment.js`（list/cancel）、`order.js`（list/detail/pay/offlinePay/cancel）、`card.js`（list/history）
- 现状：`userId=null` 时 `WHERE client_user_id = $null` PG 等价于 `WHERE client_user_id IS NULL`，通常返回空集而非他人数据，实际越权风险低；但 null userId 场景下函数逻辑仍可被调用（如触发副作用）
- 已修复：`scanDetail` 有 ✅、`coupon.available` 有 ✅、`card.balance` 有 ✅

---

### 3.4 修复记录（v1 标记 → v2 确认已修复）

| 原 v1 ID | 描述 | 修复情况 | 备注 |
|---------|------|----------|------|
| P1-CC3-10 | staff.dashboard newMember 漏 bound_store_id | **已修复**：staff.js:714 加了 `c.bound_store_id = $1` | v2 确认 |
| P0-CC3-04（scanDetail 缺 requirePhone）| order.js:51 scanDetail | **已修复**：order.js:57 有 `await requirePhone()(ctx, ...)` | v2 确认 |
| P0-CC3-04（coupon.available 缺 requirePhone）| coupon.available | **已修复** | v1 已确认 |
| P0-CC3-04（card.list/history 缺 requirePhone）| card.list/history | **部分修复**：`card.balance` 有守卫；`card.list`/`card.history` 仍缺（归入 P2-04） | v2 确认 |
| P0-CC3-02（customer.refundHistory 零过滤）| customer.refundHistory | **部分修复**：加了 storeId 有无判断，但 null 绕过路径仍存在（归入 P1-V2-07） | v2 确认 |
| P0-CC3-02（order.createPickup 缺 requireManager）| order.createPickup | **补偿措施**：SQL WHERE 含 `store_id = effectiveStoreId`，降为 P2-03 | v2 确认 |

---

## 4. 跨端一致性与 v2 澄清对照

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| Scope helper 调用率 | ~18/25 actions ✅ / ~8/25 0 调用 | 0/15 routes 调用 buildStoreScopeCondition / 6 mgmt-* 自写副本 | 0 helper 存在 | 隔离强度递减、强制力递减 | P0 |
| Scope 展开实现 | `lib/permissions.ts:108 expandScopeStoreIds`（Drizzle）| `utils/scope.js:82 expandScopeStoreIds`（原生 pg，::uuid[] bug） | — | 双实现，schema 变更需双改 + 市场级账号全部失效 | P1 |
| 多店 / 管理层模式支持 | `scopeStoreIds[]` IN 过滤 ✅ | `effectiveStoreId` 单值 + mgmt-* 用市场级展开 | — | staff 90% 路由对管理层模式失效；mgmt-* 市场展开正确但与 routes 层分裂 | P0/P1 |
| 越权 SQL 守卫策略 | `isInScope` 部分覆盖入参 | `requireManager()` / `requireStaffBound()` + 裸 SQL | `requirePhone()` + 手写 client_user_id WHERE | staff PII 暴露面最大（6 接口裸 SQL） | P0 |
| Scope 缺失对 PII 影响 | 单点权限风险（coupons.getAvailableCoupons） | 6 接口裸 SQL 直接跨店读全部顾客 PII（detail/calendar/giftHistory/updateNotes/assign/search-phone） + performanceDetail 跨店员工业绩 | scanDetail 已修复；部分路由 null userId 实际风险低 | staff PII 暴露面最大 | P0 |
| 跨域校验（实体 ∈ session scope） | `isInScope` 少数覆盖 | `mgmt-customer.js:217 assertCustomerInScope` 仅 mgmt-*；业务路由 0 守卫 | 手写 `if (order.client_user_id !== userId) throw` | 三套独立写法、可维护性差 | P1 |

---

## 5. 横切检查

- [ ] CC1 数值：与 CC3 无关
- [ ] CC2 并发：与 CC3 解耦
- [x] **CC3 隔离：本报告主体；7 个 P0 + 3 个 P1 + 4 个 P2**
- [x] CC4 鉴权：CC3 与 CC4 高度耦合——scope 缺失根因之一是 staff middleware 不强制业务路由调 helper + client 缺 helper
- [ ] CC5 错误码：与 CC3 无关
- [x] CC6 PII：scope 缺失的最直接受害者——staff customer 全裸（6 接口）+ admin coupons 枚举券面值 + performanceDetail 跨店员工业绩
- [ ] CC7 时间：与 CC3 无关
- [ ] CC8 WXML/Vant：与 CC3 无关
- [x] CC9 测试：`__tests__/utils/scope.test.js` 测 helper 但不测 routes 调用（给"功能正常"假象）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L3 staff utils | `staffApi/utils/scope.js` | (1) 新增 `assertCustomerInScope(ctx, boundStoreId)` / `assertEmployeeInScope(ctx, employeeId)` / `assertSaleOrderInScope(ctx, saleOrderId)`；(2) `expandScopeStoreIds` 内 `::uuid[]` → `::text[]` | P1-02 + P0-01~04 |
| L3 staff routes | `routes/customer.js`（detail/calendar/giftHistory/updateNotes/assign/search-phone）、`routes/staff.js`（performanceDetail） | 各函数查询后加 `assertCustomerInScope` 或 `assertEmployeeInScope` 校验；phone 分支加门店过滤或业务确认 | P0-01~05 + P1-01 + P0-06 |
| L7 admin | `fengyu-admin/src/actions/coupons.ts:106` | `getAvailableCoupons` 加 `assertCustomerInScope` | P0-07 |
| L9 测试 | `staffApi/__tests__/utils/scope.test.js` | 加"路由是否调用 helper"静态检查；加 performanceDetail 跨店越权集成测试 | P2-01 |
| L10 文档/lint | 项目根 / `.eslintrc` | 加 ESLint custom rule 拦截"裸 store_id = $"；`.42cog/dev/sys.spec.md` 加 CC3 scope 强制点清单 | P2-01 |

---

## 7. 验证 SQL（SELECT/EXPLAIN only，禁止写入）

```sql
-- 验证 1: expandScopeStoreIds uuid cast——确认 org_nodes.id 数据类型
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'org_nodes' AND column_name = 'id';
-- 预期：data_type = 'text'（非 uuid），确认 ::uuid[] 风险存在

-- 验证 2: customer.detail 无 store_id 过滤——query plan 无 bound_store_id/store_id 条件
EXPLAIN
SELECT c.user_id, c.phone, c.name, c.bound_store_id
FROM client_wechat_users c
WHERE c.customer_id = 'SOME-CUSTOMER-ID' LIMIT 1;

-- 验证 3: performanceDetail 跨店员工业绩查询——确认无 store_id 过滤
EXPLAIN
SELECT sa.total_amount, o.store_id, o.client_phone
FROM sale_allocations sa
JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
WHERE sa.employee_id = 'SOME-OTHER-STORE-EMPLOYEE-ID'
  AND sa.is_void = false
  AND o.status = '已支付';

-- 验证 4: mgmt-* scope 展开等效 SQL（管理层模式）
EXPLAIN
SELECT s.store_id
FROM stores s
JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.parent_id = 'SOME-MARKET-ID' AND o.type = '门店';

-- 验证 5: customer.assign 顾客归属可越权确认
EXPLAIN
SELECT user_id, bound_store_id, bound_employee_id
FROM client_wechat_users
WHERE user_id = 'SOME-OTHER-STORE-USER-ID';
-- 预期：返回数据，说明 assign 可操作任意门店顾客
```

---

## 8. 回归测试用例（建议）

1. **跨店 PII 越权（6 接口）**：一线员工调 `customer.detail({id: '别店顾客'})` / `giftHistory({clientUserId: '别店顾客'})` / `updateNotes({clientUserId: '别店顾客', notes: 'x'})` / `assign({userId: '别店顾客'})` / `calendar({clientUserId: '别店顾客'})` / `search({phone: '别店顾客手机号'})` 应抛 `PERMISSION_DENIED`
2. **performanceDetail 跨店员工业绩**：店长传入他店 `employeeId` 查 `performanceDetail` 应抛 `PERMISSION_DENIED`
3. **admin getAvailableCoupons 跨集团枚举**：admin 用户 A（非 admin 角色）传任意 clientUserId 枚举其券模板应抛 `PERMISSION_DENIED`
4. **scope helper 一致性**：admin `expandScopeStoreIds` 与 staff `utils/scope.js:82 expandScopeStoreIds` 对同一 market scope 应返回相同 store_id 集合
5. **mgmt-* 三副本与主 helper 一致性**：固定 fixture，`mgmt-customer.js:49`/`mgmt-dashboard.js:40`/`mgmt-traffic.js:40` + `utils/scope.js:139 buildStoreScopeCondition` 在管理层模式下生成等价 SQL
6. **scope 强制 lint**：grep `store_id\s*=\s*\$\d` 出现且不在 `utils/scope.js` 应失败

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB）：☑**
- 涉及历史数据：☐（仅修复运行时行为，不需要回填）
- 修复成本：**L**（涉及 staff 6 接口 + staff performanceDetail + admin 1 action 补 scope守卫 + utils/scope.js fix）

---

## 10. 后续待办

- [ ] 与 audit-CC4-backend-auth 对齐：CC3 + CC4 联合修复（scope 守卫 + auth wrapper）
- [ ] 与 audit-CC6-pii 对齐：CC3 是 PII 泄露的最大来源
- [ ] 把 `__tests__/utils/scope.test.js` 升级为"路由层"集成测试（覆盖率检测）
- [ ] 待 audit-CC4 / CC6 / CC9 收官后，由 SUMMARY.md 把本域接入 Top 10 P0 与"修复 roadmap"

---

## 全栈 CC3 健康定量（vFinal）

| 端 | 单元 | 总数 | 有 scope 守卫 | 无 scope 守卫 | 健康率 |
|----|------|------|----------------|----------------|--------|
| **admin** | server actions (.ts) | ~25 | ~17（customers/employees/orders/services/appointments/refunds/stores/cards/store-unbind/allocations/dashboard/service-commissions/points） | ~8（coupons/commission/logs/messages/permissions/positions/products/settings/skill-tags/org） | **~68%** |
| **admin** | scope 入参校验（isInScope on 入参 customerId/storeId） | 必校验入口 ≥10 | 4（customers/detail/customers/list/refunds 部分/orders 部分） | ≥6（getAvailableCoupons/estimateRefundOverdraft/searchEmployees/recordPayment/permissions.assignRole/多处） | **<40%** |
| **staff** | 业务路由文件 | 9（customer/staff/order/service/appointment/allocation + 4 mgmt-*） | 0（buildStoreScopeCondition）+ 4 mgmt-* 自写副本（功能正确但维护风险高） | 5（customer/staff 部分/order 部分/service/appointment） | **0%（helper 调用率）** |
| **staff** | 具体接口（store_id WHERE） | ~35 | ~28 有 effectiveStoreId 过滤或 mgmt-* 市场级展开 | ~7（customer.detail/calendar/giftHistory/updateNotes/assign/search-phone[phone分支] + performanceDetail[跨员工]） | **~80%（接口级，有过滤）** |
| **staff** | 员工自身过滤（employee_id = $self） | ~20 | ~19 | 1（performanceDetail 跨员工可读） | **~95%** |
| **client** | requirePhone 守卫 | ~18 | ~8（create/scanDetail/scanAdjust/confirmPrepaidFull/card.balance/coupon.available/appointment.create） | ~10（list/detail/cancel + message系列 + points系列 + service系列 + card.list/history） | **~44%** |
| **client** | scope helper | 0（不存在） | — | 100% 业务路由手写 client_user_id WHERE | **N/A** |

**结论**：admin 有最强结构但仍漏 ~8 文件；staff 有 helper 但 0 路由调用（管理层面 mgmt-* 副本功能正确但维护成本高）；client 完全没有结构，全靠业务作者自觉。P0 越权集中于 staff customer 6 接口裸 SQL + performanceDetail 跨员工 + admin coupons 枚举；v2 新发现 performanceDetail 跨店越权是 v1 未细化的问题。

---

**关键发现 1 句话总结（vFinal）**：staff 端 `customer.detail/calendar/giftHistory/updateNotes/assign`（6 接口）+ `performanceDetail`（跨员工）共 7 接口裸 SQL 零 store_id 过滤构成直接跨店 PII 读写越权（P0），`utils/scope.js::uuid[]` cast bug 令市场级账号 scope 展开失败（P1），admin `coupons.getAvailableCoupons` 可枚举任意顾客券面值（P0）；v2 新发现 performanceDetail 跨店读他店员工业绩（含姓名手机号）是 v1 未细化的 P0；buildStoreScopeCondition 仍 0 路由调用，修复优先级高。