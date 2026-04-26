# 审计报告：CC3 组织域数据隔离（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC3
**审计员**：claude-opus-4-7
**审计时长**：约 25 分钟
**关联 PR/Ticket**：—
**类型**：横切收官（cross-cutting closing），跨 25 业务域归集 + 全栈 scope 分布定量

---

## 1. 三端入口对照（CC3 是横切域，对照"scope 强制点"而非业务路由）

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema 锚点 | `db/schema/org.ts:17-34 orgNodes` + `:41-69 stores` + `db/schema/permission.ts:12-35 permissionRoles` | ↑ 同 | ↑ 同 |
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

## 3. 自身漏洞（横切汇总）

> CC3 域自身漏洞是"宏观结构"漏洞，每条都覆盖多个业务域。引用业务域报告时用 `audit-NN` 形式。

### 3.1 P0（阻断/资损/越权）

- **[P0-CC3-01]** `staffApi/utils/scope.js:139 buildStoreScopeCondition` 在 12 个 `routes/*.js` 中零调用（仅被 `__tests__/utils/scope.test.js` 测试）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/utils/scope.js:139, 165` + 全部 `routes/*.js`
  - 现象：项目唯一一个能正确处理"门店模式 vs 管理层模式"的 SQL 片段构造器，在所有业务路由中被绕开。15 个路由文件里 **0 处** `require('../utils/scope').buildStoreScopeCondition`（仅 `auth.js`/`middleware/auth.js` 各引用 `expandScopeStoreIds`）。所有 staff 业务路由只用 `ctx.auth.effectiveStoreId` 单值过滤。
  - 风险：管理层模式（多店店长 / 市场账号 / 总部账号）登录时 `effectiveStoreId=null`，所有 `WHERE store_id = $1` 立即不命中——已在 audit-05/06/07/12/17 各域命中"返回空集"。同时反向风险：路由作者完全可能忘记 effectiveStoreId 而拼空 SQL（参见 audit-10 P0-10-01：`detail/calendar/giftHistory/refundHistory/updateNotes` 完全裸 SQL 零 store_id）。
  - 复现：1) 多店店长以 `loginLevel=management` 登录 staff 端；2) 调 `service.list` / `appointment.list` / `allocation.pendingList` / `order.list`；3) 全部返回空数组（与"管理层应跨店看全集"的产品诉求相反）。
  - 修复：(L3) staff 路由层强制要求所有 `store_id` SQL 走 `buildStoreScopeCondition`；为新增 `assertCustomerInScope(ctx, userId)` / `assertEmployeeInScope(ctx, employeeId)` / `assertSaleOrderInScope(ctx, saleOrderId)` 三个守卫 helper（参见 P0-CC3-02/03/04）；CI 加 grep 反模式 lint：`/store_id\s*=\s*\$\d/` 出现且不在 `utils/scope.js` 文件即报错。

- **[P0-CC3-02]** Staff 业务路由"裸 SQL 零 scope 过滤"成系统性现象（5 路由文件 / 8 接口）
  - 文件：
    - `staffApi/routes/customer.js:242-342 detail` / `:146-237 calendar` / `:748-834 giftHistory` / `:675-741 refundHistory` / `:839-858 updateNotes` / `:892-920 assign`（首发 audit-10 P0-10-01/02/03/04，复现 audit-11 P0-11-05 + audit-19 P0-19-01/02）
    - `staffApi/routes/staff.js performanceDetail / todayCommission / monthlyCalendar`（首发 audit-18 P0-18-02）
    - `staffApi/routes/order.js createPickup`（首发 audit-20 P0-20-02 + P1-20-02：缺业务方向守卫）
  - 现象：完全没有 `store_id` / `bound_store_id` / `scopeStoreIds` 任一 WHERE 片段。`assign` / `createPickup` 仅 `requireStaffBound()` 而非 `requireManager()`。同模块内部双轨：`customer.paidOrders (425-433)` 强制 `o.store_id = $effectiveStoreId`，与 `customer.detail` 零 store 过滤形成"模块内分裂实现"。
  - 风险：员工拿到任意 `userId` / `employeeId` / `saleItemId` 即可读他店的 PII（手机号、消费明细、退款金额、储值卡余额）；assign 可跨店分配顾客（业绩资损）；createPickup 可代任意顾客在任意门店提货（双消费资损）。
  - 复现：1) 任意一线员工调 `customer.detail({userId: '他店顾客'})`；2) 直接拿到顾客全档案 + 12 月消费记录。
  - 修复：(L3) 引入 `assertCustomerInScope` + `assertEmployeeInScope` + `assertSaleOrderInScope` 三个 helper；把 `customer.*`（门店模式）路由收口到 `mgmtCustomer.*`（已实现 scope 校验，见 `mgmt-customer.js:217 顾客越权防护`）；admin/staff 双端建立"非 admin 入参 customerId/employeeId 必校验 scope"的硬规则。

- **[P0-CC3-03]** Admin server actions 9 个 0 scope 调用，"靠 PERMISSION_MATRIX 兜底"是隐式合约
  - 文件：经 grep 统计，`fengyu-admin/src/actions/` 下 28 个 .ts 文件中：
    - **scope 全无（仅 requirePermission）**：`commission.ts` / `coupons.ts` / `dashboard.ts`（手写 SQL 拼 IN 而非走 helper）/ `logs.ts` / `messages.ts` / `permissions.ts` / `positions.ts` / `products.ts` / `settings.ts` / `skill-tags.ts`（10 文件 0 处 scopeCondition）
    - **仅 1-3 处**：`points.ts` / `service-commissions.ts` / `card-transactions.ts` / `org.ts`
    - **scope 完整**：`orders.ts` 11 / `customers.ts` 12 / `services.ts` 8 / `refunds.ts` 8 / `appointments.ts` 7 / `employees.ts` 6
  - 现象：(1) `coupons.ts:106 getAvailableCoupons(clientUserId, totalAmount, storeId)` 零 scope（**首发 audit-13 P0-13-08**），可枚举任意顾客全部券模板真实面值；(2) `messages.ts:46-50 getMessagesPaginated` 注释明确"messages 表无 store_id，不走 scope 过滤"，全表 leftJoin client/staff PII（**首发 audit-16 P0-16-03**）；(3) `commission.ts` 提成矩阵全表对所有 `commission:list` 角色可见；(4) `products.ts` 商品表全表对所有 `product:list` 角色可见（这两个相对低风险，因为不含 PII，但**market_scope 在 product 域不复核**——audit-09 P0-09-02）。
  - 风险：每次扩展 PERMISSION_MATRIX（譬如让 finance 拿到 `coupon:list`）都会立刻让 finance 跨集团读全部顾客券模板。这是"隐式合约"：依赖矩阵不变。`orders.ts:1594` 和 `orders.ts:1531 recordPayment` 注释已明确警告（**首发 audit-02 P0-02-05**）。
  - 复现：grep `requirePermission` 但没有同函数内 `scopeCondition` / `isInScope` 的所有 server action。
  - 修复：(L7) 把 admin scope 默认安全设为"非 admin 必须显式 scope；admin 可显式 unscoped"——`requirePermission` 升级为返回 `{session, scope: SQL | typeof UNSCOPED}` 强制每个查询消费 scope，未消费立即 lint 错。

- **[P0-CC3-04]** Client 端无 scope helper / 无统一 user 校验，私域读路由 `requirePhone` 守卫覆盖率不全
  - 文件：
    - `clientApi/routes/order.js:51 scanDetail` 不调 `requirePhone()`，零 user 过滤（**首发 audit-02 §5 CC4**）；
    - `clientApi/routes/message.js list/read/unreadCount` 三接口全无 `requirePhone()`（**首发 audit-16 P0-16-01**）；
    - `clientApi/routes/points.js balance/history` 缺 `requirePhone()`（**首发 audit-15 P0-15-12**）；
    - `clientApi/routes/appointment.js list/cancel` 缺 `requirePhone()`（**首发 audit-06 P0-06-01**）；
    - `clientApi/routes/coupon.js available` 已加 ✅（**audit-13 §1 sweep**）；`card.js list/history` 已加 ✅。
  - 现象：clientApi/middleware 在未注册用户场景下 `userId: null`（`middleware/auth.js:53-61`）。任何路由直接 `const { userId } = ctx.auth` 而不先调 `requirePhone()(ctx, () => {})`，攻击者可以发空 OPENID 请求绕过；联合 client 端无 scope helper 的本质问题，全部隔离逻辑都在业务层手写 `WHERE client_user_id = $1`，每加一个路由都要 grep review。
  - 风险：`scanDetail` 已被业务利用作为"扫码看店长开的待支付订单"入口，缺 requirePhone 配合 audit-02 P0-02-04 的"待支付订单可被任意 OPENID 绑定"形成订单劫持链。
  - 修复：(L3) 在 `clientApi/index.js` 入口维护 `phoneRequiredRoutes` 集合（与 `publicActions` 对偶），自动 wrap `requirePhone()`；新增 `clientApi/utils/scope.js` 暴露 `assertOwnSaleOrder(ctx, saleOrderId)` / `assertOwnAppointment(ctx, apptId)` / `assertOwnUserCoupon(ctx, ucId)` 等 helper，强制业务路由调用。

- **[P0-CC3-05]** Mgmt-* 路由三副本 scope helper（`mgmt-customer.js` / `mgmt-dashboard.js` / `mgmt-traffic.js` 各自重写 buildScopeFilter）
  - 文件：
    - `staffApi/routes/mgmt-customer.js:49-90`（`buildSaleOrderScopeFilter` / `buildClientScopeFilter`）
    - `staffApi/routes/mgmt-dashboard.js:40-89`（同名函数，两个文件几乎逐行复制）
    - `staffApi/routes/mgmt-traffic.js:40-89`（同名函数，第三份复制）
  - 现象：mgmt-* 全家桶绕开 `utils/scope.js` 的 `buildStoreScopeCondition`，自己写 `IN (SELECT s.store_id FROM stores s WHERE s.org_node_id IN ...)`。三份逐行重复。市场级管理层进 mgmt-* 是按市场 id 反查 stores（"动态展开"），与 utils/scope 在 middleware 阶段一次性展开 + 缓存到 `ctx.auth.scopeStoreIds` 的策略**不一致**。
  - 风险：scope 实现漂移——若中间件改了 scope 展开规则（譬如调整"市场 → 门店"展开 SQL），mgmt-* 三副本会与 routes/* 单值实现产生不一致；任何一处补丁需改 4 处。
  - 修复：(L3) 立刻把 mgmt-* 三副本统一替换为 `buildStoreScopeCondition(auth, alias)`；删除三处 `buildSaleOrderScopeFilter` / `buildClientScopeFilter` 内联函数；mgmt-customer.js:217 的 `assertCustomerInScope` 抽到 utils/scope.js 全局共享。

### 3.2 P1（数据一致 / 状态错乱）

- **[P1-CC3-06]** Admin `searchEmployees` / `getCommissionRates` 等"选择器"系列 0 scope（与"主列表" `getEmployees` 双轨）
  - 文件：`fengyu-admin/src/actions/employees.ts:73-102 searchEmployees`（**首发 audit-25 P0-25-04**），同文件 `getEmployees`（line 52）有 ✅
  - 现象：列表查询有 scope，搜索/选择器没有；用户在表单里"选员工"时跨集团可见
  - 修复：(L7) 全 admin grep `search*` / `getXxxOptions` 函数补 `scopeCondition`，或独立 `searchInScope*` 命名

- **[P1-CC3-07]** Staff `mgmt-dashboard.loadAllMarkets` 5 分钟模块级 CACHE 是 HQ 全量视角（**首发 audit-17 P0-17-04**）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js`（已记 CROSS-CUTTING.md 但本次再次确认）
  - 现象：`scopeOptions` 事后过滤是干净的，但缓存窗口期内组织变更对市场账号可见性延迟；与 staff auth 中间件 5 分钟缓存（`middleware/auth.js:21-22`）配合时漂移窗口扩大到 10 分钟
  - 修复：(L3) 模块级 CACHE 必须按 ctx.auth 维度分桶，或在 admin 写入路径加 invalidate hook

- **[P1-CC3-08]** Staff `expandScopeStoreIds` cast `::uuid[]` 但 `org_nodes.id` 是 text（**首发 audit-21 P0-21-01**）
  - 文件：`staffApi/utils/scope.js:108-122`
  - 现象：`SELECT ... WHERE o.parent_id = ANY($1::uuid[])` 强制 cast，触发 PG 22P02 invalid_text_representation；所有市场级 manager 路由全部失效
  - 修复：(L3) 改 `ANY($1::text[])`

- **[P1-CC3-09]** Staff `auth.middleware` scopeType 缺失退化到 `roles.includes('manager')` 绕过门店约束（**首发 audit-22 P0-22-03**）
  - 文件：`staffApi/middleware/auth.js:259-272`
  - 现象：旧数据 scopeType=null 被退化为 manager，绕过"门店"约束
  - 修复：(L3) 移除退化逻辑或仅在显式 force 标志下启用

- **[P1-CC3-10]** Staff `staff.dashboard` newMember 漏 `bound_store_id` 过滤（双归属字段漂移：`assigned_employee_id` vs `bound_employee_id`）（**首发 audit-17 P0-17-06、复现 audit-18 P1-18-08**）
  - 文件：`staffApi/routes/staff.js:701-708`
  - 现象：5 指标 4 个限定 service_orders.store_id，唯独 newMember 仅 `c.bound_employee_id` 无 store_id；员工调店后历史顾客的 became_member_at 仍计入新店
  - 修复：(L3) `c.bound_store_id = $effectiveStoreId` 与其他 4 指标对齐

- **[P1-CC3-11]** Admin `permissions.assignRole` 非 admin 用 `includes(scopeId)` 集合相等而非子树（**首发 audit-22 P0-22-02**）
  - 文件：`fengyu-admin/src/actions/permissions.ts:184-201, 263-269`
  - 现象：admin 校验 scope.type，非 admin 不校验；hr 在自身子树内分配 scope 时被 includes 完全相等卡住
  - 修复：(L7) `assertScopeIsSubtreeOf(session, target_scope_id)`

- **[P1-CC3-12]** Admin `dashboard.ts` scope 用 sql.join 手拼 IN，未用 `scopeCondition` helper
  - 文件：`fengyu-admin/src/actions/dashboard.ts:93/99/105`
  - 现象：`WHERE store_id IN (${sql.join(scopeIds.map(id => sql\`${id}\`), sql\`, \`)})` 三处。手写比 scopeCondition 多了"`scopeIds.length === 0` 早返回"逻辑，但失去与 helper 同步的能力
  - 修复：(L7) 改 `db.execute(...)` 为 Drizzle ORM `.where(scopeCondition(session, saleOrders.storeId))`，或在 helper 中暴露 `buildScopeRawSql(session, columnName)` raw SQL 版本

- **[P1-CC3-13]** Admin `recordPayment` 隐式合约（**首发 audit-02 P0-02-05、复现 audit-03 §5 CC3**）
  - 文件：`fengyu-admin/src/actions/orders.ts:1531`
  - 现象：注释明确"非 admin 由权限矩阵拒绝；扩权限到 scoped 角色需在此处补 isInScope"
  - 修复：(L7) 立刻补 `isInScope(session, locked.store_id)` 校验，不依赖矩阵

- **[P1-CC3-14]** Admin `getAvailableCoupons` / `estimateRefundOverdraft` 接收 `clientUserId` 不校验 scope（**首发 audit-13 P0-13-08 + audit-11 P1-11-09**）
  - 文件：`fengyu-admin/src/actions/coupons.ts:106` + `actions/refunds.ts estimateRefundOverdraft`
  - 现象：枚举任意 clientUserId 即可读他人 PII / 券面值
  - 修复：(L7) `assertCustomerInScope(session, clientUserId)` helper

### 3.3 P2（代码质量 / 可维护）

- **[P2-CC3-15]** `expandScopeStoreIds` 双实现：`staffApi/utils/scope.js:82` 与 `fengyu-admin/src/lib/permissions.ts:108`（逐行重写 SQL）
  - 文件：两处
  - 现象：staff 用原生 pg + sql 字符串，admin 用 Drizzle ORM。逻辑等价但每次 schema 变更（如 org_nodes 类型枚举改名）需双改
  - 修复：(L0) 长期：把展开规则下沉为 `db/helpers/expand-scope.ts`（PG function 或 view）；短期：在两处都加注释 cross-reference + 加同步集成测试

- **[P2-CC3-16]** `__tests__/utils/scope.test.js` 只测 helper 本身正确性，不测"路由是否调用 helper"
  - 文件：`staffApi/__tests__/utils/scope.test.js`（246 行）
  - 现象：buildStoreScopeCondition 5 个 case 全 pass，但生产 routes 0 调用；测试给了"功能正常"假象
  - 修复：(L9) 加 grep-based 静态测试：`expect(grep('store_id = $', 'routes/').filter(not in mgmt-*)).toHaveLength(0)`

- **[P2-CC3-17]** 无 lint / CI 强制拦截"裸 store_id 过滤"
  - 文件：项目根 / `.eslintrc` / CI workflow
  - 现象：scope 是隐式合约，但不被 lint 拦截
  - 修复：(L9) 加 ESLint custom rule 或 grep-based pre-commit hook

- **[P2-CC3-18]** `staff_wechat_users.store_id` 是"档案默认门店"，不参与业务 SQL，但与 `effectiveStoreId` 命名相近易误用
  - 文件：`staffApi/middleware/auth.js`（注释已说明），但实际：`store.unbindRequests/approveUnbind/rejectUnbind` 用了 `ctx.auth.storeId` 而非 `scopeStoreIds`（**首发 audit-12 P1-12-08/09**）
  - 修复：(L3) 重命名为 `defaultStoreId` 或类似明示意图的字段

- **[P2-CC3-19]** clientApi 几乎 0 中间件 helper / 全量手写 user 过滤
  - 文件：`clientApi/middleware/auth.js`（仅 51-61 行处理 userId 解析）+ 13 个 `routes/*.js`
  - 现象：每路由 10+ 处 `WHERE client_user_id = $userId` 复制；订单数 1778 行的 order.js 出现 client_user_id 共 30+ 次
  - 修复：(L3) 抽 `clientApi/utils/scope.js` 暴露 `assertOwnSaleOrder` / `applySaleOrderUserFilter(query, ctx)`（参考 staff 但更轻量）

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| Scope helper 调用率 | 18/28 actions ✅ / 10/28 0 调用 | 0/15 routes 调用 `buildStoreScopeCondition` / 6 mgmt-* + 9 routes 全部裸 SQL | 0 helper 存在 | 隔离强度递减、强制力递减 | P0 |
| Scope 展开实现 | `lib/permissions.ts:108 expandScopeStoreIds`（Drizzle）| `utils/scope.js:82 expandScopeStoreIds`（原生 pg） | — | 双实现，schema 变更需双改 | P2 |
| 多店 / 管理层模式支持 | `scopeStoreIds[]` IN 过滤 ✅ 全支持 | `effectiveStoreId` 单值 + 部分路由用 `scopeStoreIds[]` | — | staff 90% 路由对管理层模式失效 | P0 |
| 越权 SQL 守卫策略 | 入参型校验 `isInScope(session, storeId)` 用在 5 处 | `requireManager()` / `requireStaffBound()` 守卫层级 + 业务 SQL 拼 store_id（双层） | `requirePhone()` + 手写 client_user_id WHERE | admin 强制点最多 / client 漏 requirePhone 即穿透 | P0 |
| Scope 缺失对 PII 影响 | 单点权限风险（messages/coupons.getAvailableCoupons） | 直接跨店读全部顾客 PII（customer.detail/giftHistory/refundHistory） | 单用户隔离失效（scanDetail/message.list/points.balance） | staff PII 暴露面最大 | P0 |
| 跨域校验（实体 ∈ session scope） | `isInScope` 5 处，部分入参（getAvailableCoupons/estimateRefundOverdraft）漏 | `mgmt-customer.js:217 assertCustomerInScope` 单点存在；其他模块无 | `order.js:622/749/1404` 手写 `if (order.client_user_id !== userId) throw` | 三套独立写法、可维护性差 | P1 |
| Scope 缓存策略 | session 内（每请求） | middleware 5 分钟缓存（**首发 audit-17 P1**）+ mgmt-dashboard `loadAllMarkets` 5 分钟模块级缓存 | — | staff 缓存窗口最长 10 分钟，组织变更可见性延迟 | P1 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [ ] CC1 数值：与 CC3 无关，已 audit-CC1 收官
- [ ] CC2 并发：与 CC3 解耦
- [x] **CC3 隔离：本报告主体；25 业务域中 11 个域命中 CC3 P0 / P1**
- [x] CC4 鉴权：CC3 与 CC4 高度耦合——scope 缺失的根因之一是 admin 缺统一 wrapper（audit-01 P0-AUTH-01）+ staff middleware 不强制业务路由调 helper（P0-CC3-01）+ client 缺 helper（P0-CC3-04）
- [ ] CC5 错误码：与 CC3 无关
- [x] CC6 PII：scope 缺失的最直接受害者就是 PII 暴露——audit-10 P0-10-01/02/03/04（staff customer 全裸）+ audit-16 P0-16-03（admin messages）+ audit-13 P0-13-08（admin coupons）
- [ ] CC7 时间：与 CC3 无关
- [ ] CC8 WXML/Vant：与 CC3 无关
- [x] CC9 测试：`__tests__/utils/scope.test.js` 测 helper 但不测 routes 调用；锁死了"功能正常但实际不被调用"假象（参见 P2-CC3-16）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | — | 无需 schema 改动 | — |
| L0.5 db/helpers/ | 新增 `db/helpers/scope.ts`（或 PG function `fn_expand_store_scope(role_bindings) RETURNS TEXT[]`） | 把 `expandScopeStoreIds` 收敛为单一权威实现 | P2-CC3-15 |
| L3 staff utils | `staffApi/utils/scope.js`（已存在） | (1) 新增 `assertCustomerInScope(ctx, userId)` / `assertEmployeeInScope(ctx, employeeId)` / `assertSaleOrderInScope(ctx, saleOrderId)`；(2) 新增 `buildClientScopeCondition(auth, alias)`（基于 bound_store_id）；(3) `expandScopeStoreIds` 内 `::uuid[]` → `::text[]` | P0-CC3-01/02 + P1-CC3-08 |
| L3 staff middleware | `staffApi/middleware/auth.js:259-272` | 移除 scopeType 缺失退化；`storeId` 字段重命名为 `defaultStoreId` | P1-CC3-09 + P2-CC3-18 |
| L3 staff routes | 10 routes 替换 `effectiveStoreId` 单值 SQL → `buildStoreScopeCondition(ctx.auth, alias)`；mgmt-* 三副本删除内联 helper 改用 utils/scope.js 主 helper；`customer.detail/calendar/giftHistory/refundHistory/updateNotes/assign` + `staff.performanceDetail/todayCommission/monthlyCalendar` + `order.createPickup` 加 assertXxxInScope | 全部 staff 业务路由 | P0-CC3-01/02 + P0-CC3-05 + P1-CC3-10 |
| L3 client | 新增 `clientApi/utils/scope.js`（含 `assertOwnSaleOrder` / `assertOwnAppointment` / `assertOwnUserCoupon`）；`clientApi/index.js` 加 `phoneRequiredRoutes` 自动 wrap requirePhone | client 全部业务路由 | P0-CC3-04 + P2-CC3-19 |
| L7 admin | (1) 10 个 0 scope 文件补 `scopeCondition`（commission/coupons/dashboard/logs/messages/permissions/positions/products/settings/skill-tags）；(2) `coupons.getAvailableCoupons` + `refunds.estimateRefundOverdraft` 加 `assertCustomerInScope`；(3) `orders.recordPayment` 补 `isInScope`；(4) `permissions.assignRole` 改集合相等为子树校验；(5) `searchEmployees` 加 scopeCondition；(6) `dashboard.ts:93/99/105` 改 Drizzle 风格 | 9 admin actions | P0-CC3-03 + P1-CC3-06/11/13/14 + P1-CC3-12 |
| L9 测试 | (1) 新增 grep-based 静态测试；(2) 新增 dashboard.consistency.test.ts 跨实现测试；(3) `__tests__/utils/scope.test.js` 加"路由集成测试"用例 | 测试套件 | P2-CC3-16/17 |
| L10 文档 / lint | (1) `.42cog/dev/sys.spec.md` 加"CC3 scope 强制点"清单；(2) ESLint custom rule 拦截"裸 store_id = $"；(3) CI grep gate | 项目根 | P2-CC3-17 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 验证 1: 检测 staff 端业务路由的 store_id 过滤是否对管理层模式正确（管理层 effectiveStoreId=NULL）
-- 模拟管理层一次查询：不应返回空结果
EXPLAIN
SELECT s.store_id FROM stores s
WHERE s.org_node_id = ANY(
  SELECT id FROM org_nodes WHERE parent_id = '<market-id>' AND type = '门店'
);

-- 验证 2: scopeStoreIds 一致性 — admin Drizzle expand 与 staff 原生 pg expand 是否吐同一集合
SELECT s.store_id
FROM stores s
JOIN org_nodes o ON s.org_node_id = o.id
WHERE o.parent_id = '<market-id>' AND o.type = '门店'
ORDER BY s.store_id;

-- 验证 3: 检测无 store_id 列但走 scope 过滤的查询路径（messages 表）
\d messages
-- 预期：无 store_id 列；admin 注释自洽但实际确实需要 join client/staff 才能过滤

-- 验证 4: 列出所有应受 scope 约束的业务表
SELECT table_name FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'store_id'
ORDER BY table_name;

-- 验证 5: customer scope 双轨 — bound_store_id 与 sale_orders.store_id 一致性
SELECT c.user_id, c.bound_store_id, COUNT(DISTINCT o.store_id) AS distinct_order_stores
FROM client_wechat_users c
JOIN sale_orders o ON o.client_user_id = c.user_id AND o.status = '已支付'
GROUP BY c.user_id, c.bound_store_id
HAVING COUNT(DISTINCT o.store_id) > 1
LIMIT 20;
-- 用途：观察跨店消费顾客占比，决定 staff customer scope 应按 bound_store_id 还是按订单 store_id 过滤
```

---

## 8. 回归测试用例（建议）

1. **管理层模式跨店读全集**：多店店长 loginLevel='management' 调 `service.list` / `appointment.list` / `allocation.pendingList` / `customer.search` / `order.list` 应返回 scope 内全部门店数据合集（当前全空）
2. **跨店 PII 越权**：一线员工调 `customer.detail({userId: '别店顾客'})` 应抛 `PERMISSION_DENIED`（当前直接返回完整档案）
3. **跨店分配 / 跨店提货**：店长调 `customer.assign({userId: '别店顾客'})` 与 `order.createPickup({saleItemId: '别店行'})` 应抛 `PERMISSION_DENIED`（当前可静默跨店写）
4. **未绑定手机号 client 路由 ghost**：不绑定手机号场景调 `appointment.list` / `message.list` / `points.balance` / `scanDetail` 应抛 `PHONE_REQUIRED:`（当前部分路由直接读 ctx.auth.userId=null）
5. **admin recordPayment 扩权安全网**：扩 `sale_order:record_payment` 给 manager / finance 后调用应自动校验 `isInScope(session, store_id)`（当前依赖矩阵兜底）
6. **admin getAvailableCoupons 跨集团枚举**：admin 用户 A（非 admin 角色）传任意 clientUserId 应抛 `PERMISSION_DENIED`（当前可枚举全集团）
7. **scope helper 一致性**：固定一组 fixture，admin `expandScopeStoreIds` 与 staff `utils/scope.js:82 expandScopeStoreIds` 应返回相同集合
8. **mgmt-* 三副本与主 helper 一致性**：固定 fixture，`mgmt-customer.js:49`、`mgmt-dashboard.js:40`、`mgmt-traffic.js:40` 三处 + `utils/scope.js:139 buildStoreScopeCondition` 主 helper 在管理层模式下生成等价 SQL
9. **scope 强制 lint**：grep `store_id\s*=\s*\$\d` 出现且不在 `utils/scope.js` 应失败

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB）：☑**
- 涉及历史数据：☐（仅修复运行时行为，不需要回填）
- 修复成本：**L**（涉及 staff 全部业务路由重构 + admin 10 actions 补 scope + client 新建 utils/scope）

---

## 10. 后续待办

- [ ] 与 audit-CC4-backend-auth 对齐：CC3 + CC4 联合修复（scope 守卫 + auth wrapper）
- [ ] 与 audit-CC6-pii 对齐：CC3 是 PII 泄露的最大来源
- [ ] 把 `__tests__/utils/scope.test.js` 升级为"路由层"集成测试（覆盖率检测）
- [ ] CROSS-CUTTING.md "CC3 组织域数据隔离"段落由本报告 P0-CC3-01~05 + P1-CC3-06~14 取代为正式收官表
- [ ] 写补丁迁移：无 schema 变更需求；若决定实施 PG function `fn_expand_store_scope` 则需 db/migrations/ 新文件
- [ ] 待 audit-CC4 / CC6 / CC9 收官后，由 SUMMARY.md 把本域 19 个发现接入 Top 10 P0 与"修复 roadmap"

---

## 全栈 CC3 健康定量

| 端 | 单元 | 总数 | 有 scope 守卫 | 无 scope 守卫 | 健康率 |
|----|------|------|----------------|----------------|--------|
| **admin** | server actions (.ts) | 28 | 18 | 10（commission/coupons/dashboard\*/logs/messages/permissions/positions/products/settings/skill-tags） | **64.3%** |
| **admin** | scope 入参校验（isInScope on 入参 customerId/storeId） | 必校验入口 ≥10 | 5 | ≥5（getAvailableCoupons / estimateRefundOverdraft / searchEmployees / recordPayment / 多处） | **<50%** |
| **staff** | 业务路由文件 | 15 | 0（buildStoreScopeCondition）+ 6 mgmt-* 自写副本 | 9（含 customer/staff/order/service/appointment/allocation 各类裸 SQL） | **0%（严格按 helper 调用率）** |
| **staff** | 管理层模式（loginLevel='management'）覆盖 | 全部业务接口 | mgmt-* 6 文件 ✅ | 90% 业务接口（取 effectiveStoreId 单值，管理层模式下空集） | **<10%** |
| **client** | 业务路由文件 | 13 | requirePhone 守卫：order/coupon/card/auth/appointment/service/staff（部分） | message(3)/points(2)/scanDetail/部分 appointment | **~70%（覆盖率）** |
| **client** | scope helper | 0（不存在） | — | 100% 业务路由手写 client_user_id WHERE | **N/A**（未模块化） |

**结论**：admin 有最强结构（helper 完整 + 18/28 调用）但仍漏 10 文件；staff 有 helper 但 0 路由调用，是"摆设型"基础设施；client 完全没有结构，全靠业务作者自觉。隔离强度从 admin → staff → client 递减，但 PII 暴露面恰好相反（staff 全场景接触跨店顾客最严重）。

---

**关键发现 1 句话总结**：staff 端 `buildStoreScopeCondition` helper 0 路由调用 + admin 端 10/28 actions 0 scope + client 端无 helper，是 11 个业务域 P0 越权/PII 泄露问题的同根来源。
