# 审计报告：CC4 后端统一鉴权（合并终版）

**合并终版时间**：2026-04-26
**域 ID**：CC4（横切，不是单一业务域）
**审计员**：claude-opus-4-7（v1, 2026-04-25） + claude（v2 独立重审, 2026-04-26）
**v2 扫描覆盖**：branch `dev`，commit `0707bdc`，v2 不参考 v1 结论先行，独立扫描
**合并策略**：
- payNotify P0：v2 确认代码仍不存在，DISABLED 守卫已加入 → 🔶已封锁(临时)，未修复
- v2 新增 P0：staffApi `_testOpenid` 无环境变量门控 → 编号 P0-CC4-09
- admin 4 处漏鉴权：v1 结论，v2 独立确认全部未修复
- clientApi 12 个私域路由缺 requirePhone：保留 v1 评级，v2 补充精确化
- client order.scanDetail：v2 确认已有 requirePhone 守卫 → 已修复 ✅

**总 P0/P1/P2**：14 P0 / 9 P1 / 6 P2（含 v1 10 + v2 4 独立新发现）

---

## 1. 三端入口对照（鉴权层）

| 层 | admin | staff | client | payNotify |
|----|-------|-------|--------|-----------|
| 路由门禁 | `fengyu-admin/src/middleware.ts:9-65`（JWT 校验 cookie `fy-admin-token`，仅做 token 存在性 + mustChange 重定向，**不走 perm 校验**） | `staffApi/index.js:155-157`（`auth(ctx, async()=>handler(ctx))` 包裹全部路由，无 publicActions 例外） | `clientApi/index.js:99-108`（`auth(ctx, ...)`，`publicActions=['config.banners','config.fengyuguan','config.invalidateConfig','card.rechargeConfig']` 共 4 项跳过） | `payNotify/index.js:38-46` exports.main 直接 `event` 入口，**无 middleware、无 auth、无签名校验** |
| Session 注入 | `fengyu-admin/src/lib/auth.ts:164-218 getSessionFromCookie`（每请求 JOIN `permission_roles` + `org_nodes`） | `staffApi/middleware/auth.js:99-137`（OPENID → staff_wechat_users → permission_roles JOIN org_nodes，5 min LRU 200 上限） | `clientApi/middleware/auth.js:19-84`（OPENID → client_wechat_users，5 min LRU 200 上限，**无 roles**） | — |
| Roles 来源 | `permission_roles` 表 + `PERMISSION_MATRIX` 代码常量映射（`src/lib/permissions.ts:15-85`） | 同 admin 表 + `utils/scope.js:24-50` 派生 `staffLevel`（headquarters / market / store_manager / store_staff） | 无 roles 字段 | 无 |
| Scope 注入 | `session.roles[].scopeId` + `scopeCondition(session, table.storeId)` | `ctx.auth.scopeStoreIds` + `helpers/scope.js:139-159 buildStoreScopeCondition` | 仅 `ctx.auth.boundStoreId / userId` | — |
| Action 守卫 | `requirePermission(session, 'xxx:yyy')` 散落在各 server action 内 | `requireManager()` / `requireStaffBound()` / `requireManagementLevel()` 三类硬编码守卫 | `requirePhone()` 单一守卫 | — |

---

## 2. 数据流图（全栈鉴权强度对比）

```
┌──────────────────── admin (171 server actions) ────────────────────┐
│ Browser → cookie:fy-admin-token                                   │
│   middleware.ts: jwtVerify ✓ (仅 token 存在性 + mustChange)         │
│   '(main)/layout.tsx': getSession() → redirect /login               │
│   action handler: 必须自调 const session = await getSession()       │
│                   + requirePermission(session, '<key>')             │
│                   + scopeCondition(session, table.col) on each SQL  │
│   ⚠ 无 withPermission HOF；漏调即整 action 无防线                    │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────── staff (125 routes) ────────────────────┐
│ wx.cloud.callFunction → staffApi.index.js                  │
│   auth(ctx, next) 强制全过 ✓                                │
│     → ctx.auth.{roles, staffLevel, scopeStoreIds, …}         │
│   handler(ctx): 路由层各自挑                                  │
│     - requireManager() / requireStaffBound() / requireManagementLevel()
│     - SQL 是否调 buildStoreScopeCondition 完全看作者自觉        │
│   ⚠ middleware 注入信任 ≠ scope 强制；mgmt-* 三副本 buildScopeFragment 自实现
└────────────────────────────────────────────────────────────┘

┌──────────────────── client (60 routes) ────────────────────┐
│ wx.cloud.callFunction → clientApi.index.js                 │
│   auth(ctx, next) (4 publicActions 例外)                     │
│     → ctx.auth.{userId, phone, boundStoreId, …}              │
│   handler(ctx): 路由层各自挑                                  │
│     - requirePhone() (8 路由用) — 但 service / points / message 缺
│     - SQL 必须手写 AND client_user_id = $userId — 无 helper、无强制
│   ⚠ 无 roles；无 ownership 自动守卫；漏写即跨用户读
└────────────────────────────────────────────────────────────┘

┌──────────────────── payNotify (1 入口) ────────────────────┐
│ PAYNOTIFY_DISABLED = true  ← 🔶已封锁(临时)，未修复           │
│ exports.main(event) — 直接信任 event.{orderNo, transactionId, payAmount, paymentMethod}
│   ⚠ 0 行签名校验；0 行解密；0 行 NotifyURL 来源校验            │
│   ⚠ 解除 DISABLED 后若无签名校验 → 任何同 envId 小程序页可伪造支付落账
└────────────────────────────────────────────────────────────┘
```

---

## 3. 检查清单结果

| 检查项 | 结论 | 详情 |
|--------|------|------|
| **CC4-CK-1** 所有 staffApi/clientApi 路由先过 middleware | ✅ staffApi / ⚠️ clientApi | staffApi 全过，clientApi 有 4 publicActions 跳过（设计合理；`card.rechargeConfig` 是只读配置，不涉及 PII） |
| **CC4-CK-2** roles 数组从 DB 读取，不信任前端传参 | ✅ | staffApi auth 从 `permission_roles` 表读；clientApi 无 roles（合理，客户端无角色体系）；admin 从 DB 查 |
| **CC4-CK-3** 无权限记录降级为最低权限（仅自己相关记录） | ⚠️ 部分 | staffApi 未注册员工 roles=[] / staffWfId=null，后续路由 requireStaffBound 拦截；clientApi userId=null，SQL `WHERE client_user_id = $userId` 查 null 返回空集（有效降级）；**但 service/points/message 无 requirePhone，phone=null 用户仍可调** |
| **CC4-CK-4** admin 用 server actions 非裸 API，session 校验在 layout.tsx | ✅ | layout.tsx:6-19 调 getSession() + redirect；middleware.ts JWT 校验；全部 server actions 在 `src/actions/` 内 |
| **CC4-CK-5** payNotify 微信回调签名校验 | 🔶 已封锁(临时)，未修复 | `PAYNOTIFY_DISABLED = true` 守卫封锁所有调用（v2 确认存在，2026-04-26 加入）；底层业务逻辑仍无签名校验代码 |
| **CC4-CK-6** admin 关键 action 有 requirePermission 包裹 | ⚠️ 大部分有，4 处漏 | 25 个 action 文件扫描：4 处漏调（`generateOrderWxacode`、`getMarketStoreIds`、`getCardKindNamesFromDb`、`getPointsToYuanRate`）；详见下方 P0-CC4-02/03/04/05 |

---

## 4. 发现的问题

### P0（阻断 / 资损 / 越权）

#### **[P0-CC4-01]** payNotify 签名校验缺失 — 🔶已封锁(临时)，未修复

- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:54, 115-580`
- **现状**：
  1. `PAYNOTIFY_DISABLED = true`（line 54）硬编码守卫，2026-04-26 加入，拦截所有调用并写 operation_logs（v2 确认存在）。
  2. 守卫后"保留业务逻辑"（line 115-580）**完全无签名校验代码**：无 `Wechatpay-Signature` 验证、无 AEAD 解密、无 mchid/appid 校验，仅靠 `event.orderNo` 就执行 DB 写入。
  3. 解除守卫需满足 index.js:43-52 五项条件，均未实现。
- **风险**：若未来有人将 `PAYNOTIFY_DISABLED` 改为 `false` 而忘记补签名，整条支付链路立即无鉴权开放。
- **v2 状态**：✅ 守卫存在（缓解即时风险）；❌ 签名代码仍不存在；🔶 已封锁(临时)，未修复
- **file:line**：`payNotify/index.js:54`（DISABLED 常量）、`payNotify/index.js:115-580`（无签名业务逻辑）

#### **[P0-CC4-02]** Admin `generateOrderWxacode` 无 session / 无 requirePermission

- **文件**：`fengyu-admin/src/actions/orders.ts:1850`（v1）/ `orders.ts:2033`（v2 行号更新）
- **现状**：函数体直接调 `getClientAccessToken()` + `requestWxacode()`，无任何 `getSession()` / `requirePermission()` 调用。
- **风险**：任何能访问 admin Next.js 的已登录 session（含 cookie 窃取场景）均可枚举 saleOrderId 生成对应 wxacode，用于钓鱼；也可通过 Server Action 直接调用（Next.js Server Action 仅需 form 提交，无 CSRF 额外保护）。
- **v2 确认**：未修复 ✅
- **file:line**：`orders.ts:1850/2033-2067`

#### **[P0-CC4-03]** Admin `getMarketStoreIds` 无 session / 无 requirePermission，泄露组织架构

- **文件**：`fengyu-admin/src/actions/stores.ts:220`
- **现状**：直接执行 `db.execute(sql...)`，无任何鉴权。
- **风险**：任意已认证用户可枚举任意 storeId 的同市场门店列表，泄露业务组织架构。
- **v2 确认**：未修复 ✅
- **file:line**：`stores.ts:220-231`

#### **[P0-CC4-04]** Admin 非 admin 角色 scope 校验仅做"集合相等"而非"子树包含"，hr 角色实质失能

- **文件**：`fengyu-admin/src/actions/permissions.ts:184-188, 263-269`
- **现象**：`if (!userScopeIds.includes(data.scopeId)) reject` —— hr (scope=总部) 给某门店员工分配角色时 `data.scopeId=门店 org_node_id` 不在 `userScopeIds=[总部]` 里 → 拒绝。代码与 spec `admin.pr.spec.md:190` "hr 分配的 scope_id 须在其 scope 内"直接冲突。
- **风险**：hr / 市场 manager 完全无法分配下属 scope，所有授权必须走 admin → RBAC 设计被瓦解。
- **首次发现**：audit-22 P0-22-02；v2 确认未修复 ✅
- **修复**：(L7) 改为子树包含判定（`expandScopeStoreIds(session.roles)` 反向判断 `data.scopeId` 是否在子树内）。

#### **[P0-CC4-05]** Admin assignRole 不校验非 admin 角色的 scope.type，可绑 manager/finance/hr 角色到"部门"型 org_node

- **文件**：`fengyu-admin/src/actions/permissions.ts:192-201`
- **现象**：仅 `role==='admin'` 时校验 `node.type==='总部'`；其它 6 个 role 接受任何 type（含"部门"）。下游 `expandScopeStoreIds` 对部门 silently 返回 `[]` → admin scope 检查空集 → 看似"安全"但 `requirePermission` 仍允许执行。
- **首次发现**：audit-22 P0-22-01；v2 确认未修复 ✅
- **修复**：(L7) assignRole 按 role 校验允许的 scope.type 集合（admin → 总部；manager/finance/customer_mgr → 总部/市场/门店；hr/product → 总部/市场）。

#### **[P0-CC4-06]** Admin 撤销 admin 角色无"至少保留 1 个 admin"保护，可锁死系统

- **文件**：`fengyu-admin/src/actions/permissions.ts:241-286, employees.ts:439-444`
- **现象**：`revokeRole(自己 admin 行 id)` 或 `updateEmployee({isResigned:true})` 触发 DELETE permission_roles 时无 count 检查。一旦剩 0 个 admin → assignRole 自身需要 `permission:assign_admin` → 死锁。
- **首次发现**：audit-22 P0-22-03；v2 确认未修复 ✅
- **修复**：(L7) 撤删 `role='admin'` 前 `SELECT count(*) FROM permission_roles WHERE role='admin' AND employee_id != current` 至少 ≥1。

#### **[P0-CC4-07]** Staff 业务路由 store/scope 完全无过滤（cross-store 全局读改）

- **文件量化扫描**（基于 `grep -cE "buildStoreScopeCondition|effectiveStoreId"`）：
  | 文件 | exports | 用 require* 守卫 | 用 scope helper | 漏 scope 路由 |
  |------|---------|-----------------|-----------------|---------------|
  | customer.js | 14 | reqBound=9 reqMgr=2 | scopeUse=7 | detail/calendar/giftHistory/refundHistory/updateNotes 完全无 store_id 过滤；assign 只检查员工同店未检查顾客 bound_store ∈ scope（audit-10 P0-10-01/02/03/04, audit-19 P0-19-01/02） |
  | order.js | 19 | reqMgr=9 reqBound=7 | scopeUse=19 ✅ | createPickup 用 reqBound 而非 reqMgr，UPDATE 缺 `item_direction='购买'` 守卫（audit-20 P0-20-02） |
  | service.js | 8 | reqBound=7 | scopeUse=10 ✅ | OK（audit-05 已记） |
  | mgmt-customer.js | 11 | reqMgmt=6 | **scopeUse=0** ⚠️ | 自实现 `buildScopeFragment`（routes/mgmt-customer.js:60-90）非 helpers/scope.js — 与 mgmt-dashboard / mgmt-traffic 三副本（CC4 helper 双轨） |
  | mgmt-dashboard.js | 33 | reqMgmt=5 | **scopeUse=0** ⚠️ | 同上三副本之一；audit-17 P0-17-04 模块级 5 min CACHE 跨账号共享 |
  | mgmt-traffic.js | 15 | reqMgmt=1 | **scopeUse=0** ⚠️ | 14 路由完全无 reqMgmt + 自实现 scope；audit-25 P0-25-03 promoter 业绩链路全无 scope |
  | mgmt-product.js | 3 | reqMgmt=2 | scopeUse=0 | 1 路由 reqMgmt 缺 |
  | staff.js | 8 | reqBound=8 | scopeUse=3 | performanceDetail 不校验 employeeId 是否 ∈ scope（audit-18 P0-18-02） |
  | product.js | 11 | reqBound=8 | scopeUse=0 | 商品域无 store 维度，OK |
- **风险**：与"middleware scope 注入但 SQL 不调用 helper"是同源 CC3 + CC4 双命中；audit 1/10/11/13/14/15/16/17/18/19/20 每域都复现。
- **首次发现**：audit-01 P0-AUTH-02 + audit-10 P0-10-01/02/03/04 + 20 域系统性扩散；v2 确认未修复 ✅
- **修复**：(L3 staff middleware) 强制 `scope assertion`；(L0) 引入 `assertCustomerInScope` / `assertEmployeeInScope` helper；(L3) 三副本 buildScopeFragment 收口到 `helpers/scope.js`。

#### **[P0-CC4-08]** Client 私域读接口 `requirePhone()` 守卫覆盖率不足 50%

- **文件量化扫描**（基于 `grep -cE "requirePhone\("`）：
  | 文件 | exports | reqPhone 调用 | 业务层 user_id 守卫 | 漏检路由 |
  |------|---------|---------------|---------------------|---------|
  | order.js | 15 | 3 | ownership=36 | **scanDetail 已修复 ✅**（v2 确认 order.js:57 有 requirePhone）；多个 list/detail 仅靠 SQL `WHERE client_user_id=$userId` |
  | appointment.js | 3 | 1 | ownership=6 | **list/cancel 漏 reqPhone**（audit-06 P0-06-01）|
  | service.js | 2 | 0 | ownership=2 | **list/detail 完全无 reqPhone**，仅 SQL `client_user_id` 兜底 |
  | points.js | 2 | 0 | ownership=2 | **balance/history 漏 reqPhone**（audit-15 已记） |
  | message.js | 3 | 0 | ownership=3 (recipient_id) | **list/read/unreadCount 漏 reqPhone**（audit-16 P0-16-01） |
  | card.js | 6 | 2 | ownership=8 | **list 无 reqPhone**（balance/recharge 有）|
  | coupon.js | 2 | 2 | ownership=4 | OK ✅ |
  | staff.js | 3 | 0 | ownership=1 | defaultStaff 仅 SQL `WHERE u.user_id=$1` 兜底；list/detail 公共信息可不要 reqPhone |
  | store.js | 6 | 0 | ownership=2 | **requestUnbind/getUnbindRequest/cancelUnbindRequest 全无 reqPhone**（audit-12 P0-12-01）|
- **总量**：60 路由 / 9 个调 reqPhone / 51 个未调（其中 `auth.*`/`config.*`/`store.list/detail`/`product.*`/`staff.list/detail` 共约 25 个为合理公共入口；其余 26 个均为私域读但缺守卫，仅靠 SQL ownership 兜底）
- **v2 补充**：appointment.list/cancel（audit-06）、card.list（v2 P1-CC4v2-09 精确化）、service/points/message 全 7 个路由确认缺 requirePhone。
- **修复**：(L3) 在 `clientApi/index.js` 路由层维护 `phoneRequiredRoutes` 集合（与 `publicActions` 对偶），自动 wrap requirePhone()。

#### **[P0-CC4-09]** staffApi `_testOpenid` 无环境变量门控，生产环境可被任意覆盖（P2 新发现）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:103-104`
- **现状**：
  ```js
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  const effectiveOpenid = testOpenid || OPENID
  ```
  无任何环境变量保护，只要 payload 传入 `_testOpenid`，即可以任意 OPENID 身份通过 auth。
- **对比**：clientApi 同路径有 `if (process.env.ALLOW_TEST_OPENID === 'true')` 门控（`clientApi/middleware/auth.js:24-26`），生产环境不设此变量即自动关闭。staffApi 缺少同等保护。
- **风险**：员工端攻击者（任何能 callFunction 的人）可伪造任意员工 OPENID，以店长身份开单或读他人绩效。
- **file:line**：`staffApi/middleware/auth.js:103-104`

#### **[P0-CC4-10]** Admin estimateRefundOverdraft / getAvailableCoupons 接收 userId 入参不校验属于 session scope

- **文件**：`fengyu-admin/src/actions/refunds.ts estimateRefundOverdraft` + `actions/coupons.ts:106 getAvailableCoupons`
- **现象**：仅 `requirePermission(session, 'sale_order:create' or 'sale_order:refund')`，对 clientUserId 入参零校验。任何 admin 用户可枚举任意顾客 12 月消费 / member_level / user_coupons / face_value_override 真实面值。
- **首次发现**：audit-11 P1-11-09 + audit-13 P0-13-08。
- **修复**：(L7) 加 `assertCustomerInScope(session, clientUserId)` helper，所有 `clientUserId` 传参的 admin 查询路径强制调用。

#### **[P0-CC4-11]** Admin search* 选择器零 scope（与 list/getX 双轨）

- **文件**：`fengyu-admin/src/actions/employees.ts:73-102 searchEmployees`（同文件 `getEmployees` 有 scopeCondition ✅）
- **现象**：选择器搜索绕过 scope 过滤，跨集团零隔离；audit-25 P0-25-03 揭示 promoter 推荐场景已暴露面。
- **首次发现**：audit-25 P0-25-03；v2 确认未修复 ✅
- **修复**：(L7) grep `admin/src/actions/*.ts` 全部 `search*` 函数补 scopeCondition；或独立 `searchInScope*` 命名 + lint 强制。

### P1（数据一致 / 状态错乱）

#### **[P1-CC4-12]** Admin scope 隐式合约：依赖权限矩阵不维护就漏 isInScope

- **文件**：`fengyu-admin/src/actions/orders.ts:1531 recordPayment`（注释明确说"非 admin 由权限矩阵拒绝；扩权限到 scoped 角色需在此处补 isInScope"）
- **首次发现**：audit-02 P0-02-05 + audit-03 复核。
- **风险**：权限矩阵任何一次"开放给 scoped 角色"修改都会破坏此隐式合约。
- **修复**：(L7) 把 isInScope 校验从隐式合约改为显式 `scopeCondition` + 写测试断言。

#### **[P1-CC4-13]** Staff `requireManager()` 旧数据 fallback 越权

- **文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:259-272`
- **现象**：`scopeType` 缺失时 fallback 到 `roles.includes('manager')`，绕过"门店"约束；总部级 / 市场级 manager 误得开单权（开单本应仅门店店长）。
- **首次发现**：audit-22 P1-22-08。
- **修复**：(L3) 移除兜底；先 SQL 排查 `WHERE o.type IS NULL` 残留并清理。

#### **[P1-CC4-14]** Admin 与 Staff 两端权限矩阵两套真相源

- **现象**：admin = `PERMISSION_MATRIX` 7 角色 × N action 代码常量；staff = 4 staffLevel + 硬编码 `requireManager` / `requireManagementLevel` 守卫。同一 `manager` 在 admin 有 22 actions，staff 仅靠 1 个守卫。
- **修复**：(L0/L3) 长期：PERMISSION_MATRIX 移至 DB（`system_configs.permission_matrix`），admin/staff/cron 共读；短期：staff 端把硬编码守卫显式化为 `STAFF_REQUIRED_ROLES` 常量。

#### **[P1-CC4-15]** Admin Server Action 错误处理用 `{success:false}` 而非 throw `PERMISSION_DENIED:`

- **现象**：`auth.resetEmployeePassword` 内 `isAdmin` 自检失败返回 `{success:false, message:'仅系统管理员可重置密码'}`；与 staff/client 抛 `PERMISSION_DENIED:` 前缀不一致。前端按前缀映射 toast 文案落入"未识别错误"分支。
- **修复**：(L7) admin 越权场景统一抛 `PERMISSION_DENIED:` 或在 `requirePermission` 失败路径上放置统一 wrapper。

#### **[P1-CC4-16]** Admin Server Action 用相邻动作权限项替代独立 cancel/reject 等

- **现象**：`appointments.ts:248-250 cancelAppointment` 用 `requirePermission(session, 'appointment:confirm')`；`refunds rejectRefund` 与 `approveRefund` 共用 `'sale_order:refund'`。"确认权"自动拥有"取消权"，权限语义错位。
- **首次发现**：audit-06 P0-06-05 + audit-11 §3.2。
- **修复**：(L0) PERMISSION_MATRIX 增补 `appointment:cancel` / `sale_order:reject_refund` 项；(L7) 替换。

#### **[P1-CC4-17]** Admin `getCardKindNamesFromDb` 无 session（低敏感但不一致）

- **文件**：`fengyu-admin/src/actions/products.ts:159`
- **现状**：仅读 `product_categories.category_name`，无 PII；但与同文件其他 `product:*` 接口鉴权不一致，且 admin 域不应有无鉴权入口。
- **v2 确认**：未修复 ✅
- **file:line**：`products.ts:159-169`

#### **[P1-CC4-18]** Admin `getPointsToYuanRate` 无 session（系统配置只读，低敏感）

- **文件**：`fengyu-admin/src/actions/settings.ts:375`
- **现状**：读 `system_configs.points_to_yuan_rate`，非 PII；但与同文件 7 个 `requirePermission(session, 'system:config')` 接口不一致。
- **v2 确认**：未修复 ✅
- **file:line**：`settings.ts:375-386`

#### **[P1-CC4-19]** clientApi `store.requestUnbind/getUnbindRequest/cancelUnbindRequest` 无 requirePhone()

- **文件**：`clientApi/routes/store.js:138,167,198`
- **现状**：用 `if (!userId) throw UNAUTHORIZED`（手写判断），非标准 `requirePhone()`；phone=null 但 userId 非 null 的用户可提交解绑申请。
- **v2 确认**：未修复 ✅
- **file:line**：`store.js:140`

#### **[P1-CC4-20]** staffApi `_testOpenid` 与 `auth.login` 双入口 OPENID 不一致

- **文件**：`staffApi/routes/auth.js:105`（login 直接调 `cloud.getWXContext()`，不用 ctx.auth.openid）
- **现状**：auth.login 内用 `cloud.getWXContext().OPENID`，而 auth 中间件已注入 `ctx.auth.openid`（可能是 _testOpenid 覆盖后的值）。两者一致，**当前无漏洞**，但若 login 逻辑改用 ctx.auth.openid 会引入不一致。
- **file:line**：`routes/auth.js:105`（参考问题，低优先）

### P2（设计不一致 / 轻微风险）

#### **[P2-CC4-21]** Admin `requireManager()` 旧数据 scopeType 缺失 fallback 仍存在

- **文件**：`staffApi/middleware/auth.js:263-272`
- **现状**：当所有 roleBindings 均无 scopeType 时，回退到 `roles.includes('manager')`，总部/市场 manager 可以通过门店级守卫。
- **file:line**：`middleware/auth.js:263-272`

#### **[P2-CC4-22]** Admin session 无 TTL（每请求查 DB），staff/client 5 min 缓存角色变更滞后

- **文件**：`staffApi/middleware/auth.js:21-23`、`clientApi/middleware/auth.js:12-13`
- **现状**：AUTH_CACHE TTL=5 min，撤销员工角色后最多 5 min 内仍可使用旧权限操作。

#### **[P2-CC4-23]** PERMISSION_MATRIX `staff` 角色 actions=[]，但 staffLevel 体系正常工作

- **文件**：`fengyu-admin/src/lib/permissions.ts:85`
- **现状**：`staff: []` 哑角色，admin 侧员工角色即为无权限，staff 端靠 staffLevel 派生。两套真相源。

#### **[P2-CC4-24]** `permission_roles.role` 列裸 text 无 enum，可写入任意字符串

- **文件**：`db/schema/permission.ts:20`（audit-22 P1-22-06 同条）
- **修复**：(L0) 增 PG `roleEnum` 7 值。

#### **[P2-CC4-25]** Staff 端 5 min auth 缓存 vs admin 即时生效造成"撤角色后仍可工作 ≤5 min"窗口

- **首次发现**：audit-22 P1 + audit-17 P0-17-04 模块级 cache。
- **修复**：(L3) 关键写操作（开单 / 退款审批 / 角色撤销）触发 cache invalidate 跨进程广播；或将 TTL 缩为 1 min。

#### **[P2-CC4-26]** PERMISSION_MATRIX `staff` 角色 actions=[] 哑角色 vs staff 端正常派生 LEVEL_STORE_STAFF

- **首次发现**：audit-22 P1-22-05。
- **修复**：(L7) 显式给 staff 最低 actions（`['dashboard:view']`）或彻底从 RoleType 移除。

---

## 5. 跨端不一致（CC4 主表）

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| 路由门禁 | middleware.ts JWT 校验（仅 token 存在性） | `auth(ctx,...)` 全过 | `auth(ctx,...)` 4 publicActions 例外 | **🔶已封锁(临时)，未修复** | payNotify 全栈最弱 | P0 |
| 鉴权信任 | action 自调 requirePermission（**171 中 4 漏**，0 个 HOF） | middleware 注入 + 路由作者自觉 | 业务层 SQL `client_user_id` 自觉 + 部分 requirePhone | — | admin 漏 = 整 action 失防；staff 漏 scope = 跨店；client 漏 user_id = 跨用户 | P0 |
| Roles 数据 | DB `permission_roles` JOIN org_nodes，每请求查 | 同 DB，5 min LRU | **无 roles** | 无 | client 端无角色概念，业务层硬编码"已登录"足够 | — |
| 权限矩阵 | PERMISSION_MATRIX 代码常量 7 角色 × ~50 action | 4 staffLevel + 3 守卫函数 | 1 守卫函数（reqPhone） | — | 同 manager 在 admin 22 actions / staff 1 守卫 = 两套真相源 | P1 |
| Scope 强度 | `scopeCondition()` Drizzle helper，所有 SQL 套 | `buildStoreScopeCondition` 路由作者自觉调；mgmt-* 三副本自实现 | **无 scope helper**，业务层手写 | — | client > staff > admin 风险递增；mgmt-* 三副本 = helper 双轨 | P0 |
| Ownership 强度 | scope 兜底（admin 角色无 scope） | scope 兜底 | 业务层 SQL `client_user_id = $userId` 手写 | — | 漏写即跨用户 | P0 |
| 错误前缀 | 多裸 `throw Error(中文)` 或 `{success:false}` | `UNAUTHORIZED:` / `PERMISSION_DENIED:` 4 类规范 | 4 类规范 | `FAIL/SUCCESS` 微信约定 | admin 不一致（已记 P1-CC4-15） | P1 |
| Session 缓存 | 无（每请求查 DB） | AUTH_CACHE 5 min/200 LRU | AUTH_CACHE 5 min/200 LRU | — | 角色变更后 staff/client 滞后 | P2 |
| 跨表 OPENID 唯一 | — | openid 表内 UNIQUE | openid 表内 UNIQUE | — | 无跨表唯一约束（audit-01 P0-SPLIT-04） | P0 |

---

## 6. 验证 SQL（5434/fengyu，仅 SELECT）

```sql
-- 6.1 跨表 OPENID 重叠（与 audit-01 P0-SPLIT-04 同验证）
WITH s AS (SELECT openid, employee_id FROM staff_wechat_users WHERE openid IS NOT NULL),
     c AS (SELECT openid, user_id     FROM client_wechat_users WHERE openid IS NOT NULL)
SELECT s.openid, s.employee_id, c.user_id
FROM s JOIN c USING (openid);
-- 预期：0 行；非 0 即跨表绑定问题

-- 6.2 staffApi _testOpenid 风险量化：当前 test 模式是否暴露过（operation_logs 记录）
SELECT action, target_type, target_id, created_at
FROM operation_logs
WHERE detail::text LIKE '%_testOpenid%'
ORDER BY created_at DESC
LIMIT 20;

-- 6.3 admin generateOrderWxacode 越权枚举风险量化：操作日志是否有此 action
SELECT action, operator_employee_id, target_id, created_at
FROM operation_logs
WHERE action = 'order.generateWxacode'
ORDER BY created_at DESC
LIMIT 10;

-- 6.4 payNotify 守卫期间是否收到外部真实回调（operation_logs security_event）
SELECT target_id, detail->>'severity' AS severity,
       detail->>'event_keys'::text AS event_keys,
       created_at
FROM operation_logs
WHERE action = 'paynotify.disabled_invocation'
ORDER BY created_at DESC
LIMIT 20;
-- severity='HIGH' 表示疑似真实外部回调

-- 6.5 当前 permission_roles 是否有意外 role 值（非 7 值枚举）
SELECT role, count(*) AS cnt FROM permission_roles GROUP BY role ORDER BY role;
-- 期望仅 admin/manager/finance/hr/product/customer_mgr/staff

-- 6.6 permission_roles 是否有部门型 scope（admin scope 分配漏洞）
SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, o.type, o.name
FROM permission_roles pr
JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type = '部门';
-- 预期 0 行

-- 6.7 当前活跃 admin 角色数（防止锁死系统）
SELECT count(*) AS admin_count
FROM permission_roles pr
JOIN staff_wechat_users s ON s.employee_id = pr.employee_id
WHERE pr.role = 'admin' AND (s.is_resigned = false OR s.is_resigned IS NULL);
-- 期望 >= 2

-- 6.8 staff requireManager() fallback 可能命中的行（scopeType IS NULL）
SELECT pr.id, pr.role, pr.scope_id, pr.employee_id, o.type
FROM permission_roles pr
LEFT JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type IS NULL OR o.id IS NULL;
-- 预期 0 行；非 0 则 requireManager() fallback 分支可触发

-- 6.9 clientApi card.list 无 requirePhone 风险量化：有卡但无手机号的用户
SELECT pc.user_id, pc.balance, cwu.phone, cwu.openid
FROM prepaid_cards pc
JOIN client_wechat_users cwu ON cwu.user_id = pc.user_id
WHERE cwu.phone IS NULL;
-- 非 0 行意味着无手机号用户可通过 card.list 查到真实余额

-- 6.10 hr 角色当前 scope 与"可分配 scope"集合差距（P0-CC4-04）
SELECT pr.scope_id AS hr_scope, o.type, o.name
FROM permission_roles pr JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.role = 'hr';
-- 与 expandScopeStoreIds 子树展开比对，量化 hr 实际能/不能分配的 scope 比例
```

---

## 7. 修复建议

### 优先级 P0（立即处理）

| 问题 | 修复方案 | 估计成本 |
|------|----------|----------|
| P0-CC4-01 payNotify 签名缺失（🔶已封锁(临时)，未修复） | 对接拉卡拉/微信时：从 header 取 `Wechatpay-Signature`，RSA-SHA256 verify 平台证书，AEAD_AES_256_GCM 解密；满足 index.js:43-52 五项条件后解锁 PAYNOTIFY_DISABLED | XL |
| P0-CC4-02 admin `generateOrderWxacode` 无 session | 加 `const session = await getSession(); requirePermission(session, 'sale_order:update')` | XS |
| P0-CC4-03 admin `getMarketStoreIds` 无 session | 加 `const session = await getSession(); requirePermission(session, 'store:list')` + scopeCondition | XS |
| P0-CC4-09 staffApi `_testOpenid` 无环境变量门控 | 参照 clientApi 加 `if (process.env.ALLOW_TEST_OPENID === 'true')` 门控，确认生产环境不设此变量 | XS（10 min） |
| P0-CC4-04 admin hr scope 子树判定 | 改为子树包含判定（`expandScopeStoreIds(session.roles)` 反向判断 `data.scopeId` 是否在子树内） | S |
| P0-CC4-05 admin assignRole scope.type 校验 | 按 role 校验允许的 scope.type 集合；admin 撤销前保留 ≥1 | S |
| P0-CC4-06 admin 唯一 admin 删除无保护 | 撤删 `role='admin'` 前 SELECT count ≥1 | XS |
| P0-CC4-07 staff mgmt-* 三副本 scope helper | 三副本 buildScopeFragment 收口到 `helpers/scope.js` | M |
| P0-CC4-10 admin estimateRefundOverdraft / getAvailableCoupons 无 scope | 加 `assertCustomerInScope(session, clientUserId)` | S |
| P0-CC4-11 admin search* 选择器零 scope | grep 全部 `search*` 函数补 scopeCondition | M |

### 优先级 P1（本迭代修复）

| 问题 | 修复方案 |
|------|----------|
| P1-CC4-13 staff requireManager() 旧数据 fallback | 移除 legacyFallback；先 SQL 排查 `WHERE o.type IS NULL` 残留并清理 |
| P1-CC4-14 admin/staff 权限矩阵两套真相源 | PERMISSION_MATRIX 移至 DB；staff 端硬编码守卫显式化 |
| P1-CC4-15 admin 错误前缀不一致 | 统一抛 `PERMISSION_DENIED:` |
| P1-CC4-16 admin 权限项错位（cancel/reject 共用） | 增补 `appointment:cancel` / `sale_order:reject_refund` |
| P1-CC4-17/18 admin getCardKindNamesFromDb / getPointsToYuanRate 无 session | 加 session + requirePermission，或标注为允许匿名读的公共配置 |
| P1-CC4-19 clientApi store.requestUnbind 无 requirePhone | 改为标准 `requirePhone()(ctx, next)` |

### 优先级 P2

| 问题 | 修复方案 |
|------|----------|
| P2-CC4-21 requireManager() fallback | 移除 legacyFallback，先清理 `permission_roles WHERE scope_id IS NULL` 残留 |
| P2-CC4-22/25 5 min 缓存滞后 | 关键写操作后调 invalidateAuthCache；或 TTL 缩为 1 min |
| P2-CC4-23/26 staff role actions=[] | 显式给 staff 最低权限 ['dashboard:view']，或从 RoleType 移除 |
| P2-CC4-24 permission_roles.role 无 enum | 增 PG `roleEnum` 7 值 |

---

## 8. 回归测试用例（建议）

1. **payNotify 伪造攻击**：`wx.cloud.callFunction({name:'payNotify', data:{orderNo, transactionId:'forged', payAmount:0.01}})` → 当前应被 PAYNOTIFY_DISABLED 拦截；接入真实签名后必须 reject
2. **staffApi _testOpenid 越权**：payload 传 `_testOpenid=<目标员工 openid>` 调 `order.list` → 无 ALLOW_TEST_OPENID 时应被忽略（修复后）
3. **admin generateOrderWxacode 越权**：finance 用户请求 `generateOrderWxacode(任意 saleOrderId)` → 应被 PERMISSION_DENIED:（修复后）
4. **admin getMarketStoreIds 越权**：跨集团 manager 请求 `getMarketStoreIds(他集团 storeId)` → 应被 scope 过滤为空（修复后）
5. **admin assignRole 部门 scope**：直接调 `assignRole({role:'manager', scopeId:<部门 org_node>})` → 应被拒绝
6. **admin hr 子树分配**：hr (scope=市场) 给市场内任一门店员工分配 manager → 应通过（当前会被拒）
7. **admin 唯一 admin 自删**：`revokeRole(自己 admin id)` 或 `updateEmployee({isResigned:true})` → 应被拒绝并提示"系统至少需保留 1 个 admin"
8. **staff requireManager 旧数据**：构造无 scopeType 的 manager 绑定，调 `order.create` → 应被拒（移除 fallback 后）
9. **staff mgmt-* 跨店枚举**：market manager A 调 `mgmtTraffic.summary({storeId: 跨市场 store})` → 应被 scope 过滤拒绝
10. **client scanDetail 枚举**：A 用户传 B 的 saleOrderId 调 `scanDetail` → 应返回 NOT_FOUND（已修复 ✅）
11. **client service.detail 跨用户**：A 用户传 B 的 serviceOrderId 调 `service.detail` → 应返回 NOT_FOUND（业务层 SQL 守卫已挡，本测试为回归保护）
12. **admin estimateRefundOverdraft 越权枚举**：跨集团 finance 传 clientUserId → 应被 assertCustomerInScope 拒绝（修复后）
13. **admin search* 跨集团选择器**：跨集团 admin 调 `searchEmployees('张')` → 修复后应仅返回 scope 内员工

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + payNotify）：☑
- 涉及历史数据：☑（需 §6 SQL 跑生产 5434 验证脏数据）
- 修复成本：**XL**（涉及 schema 约束 + 三端 middleware 重构 + admin HOF 改造 + payNotify 签名接入 + lint 规则 + 历史数据迁移）
- **总 P0/P1/P2 计数**：**11 P0 / 9 P1 / 6 P2**（CC4 是审计中 P0 数量最多的横切域）

---

## 10. 后续待办

- [ ] 执行 §6 全部验证 SQL，量化生产 5434 实际越权风险
- [ ] 与 admin 团队对齐 `withPermission(action, fn)` HOF 实现策略 + lint 规则部署
- [ ] 与 PM 对齐 PERMISSION_MATRIX 移至 DB 的演进路径
- [ ] 与运维对齐 payNotify 接入真实微信 V3 回调的部署节奏（NotifyURL + 平台证书 + APIv3Key 环境变量）
- [ ] 收口 `helpers/scope.ts` 跨端共用 helper（assertCustomerInScope / assertEmployeeInScope / assertOrderInScope），三副本 buildScopeFragment 整合
- [ ] 写一篇 `docs/playbook/cc4-auth-hardening.md`，把 11 P0 + 9 P1 修复编排成 5 期 epic

---

## 11. 关联引用

- `.42cog/real.md` v3.1.0 #5 后端统一鉴权 + #6 组织域隔离
- audit-01 P0-AUTH-01/02/03 + P0-SPLIT-04 + P1-PERM-07
- audit-02 P0-02-05（admin scope 隐式合约） + scanDetail 类（**已修复** ✅）
- audit-04 P0-04-01（payNotify 全栈无鉴权）— 🔶已封锁(临时)
- audit-06 P0-06-01（client appointment.list/cancel 漏 reqPhone） + P0-06-05（admin cancelAppointment 错位权限项）
- audit-10 P0-10-01/02/03/04（staff customer.* 全无 scope）
- audit-11 P0-11-05 + P1-11-09（refundHistory 无 scope + estimateRefundOverdraft 无 isInScope）
- audit-13 P0-13-08（admin getAvailableCoupons 无 scope）
- audit-15 + audit-16 P0-16-01/03（client points/message 漏 reqPhone + admin getMessagesPaginated 无 scope）
- audit-17 P0-17-04（mgmt-dashboard 模块级 5 min cache 跨账号共享）
- audit-18 P0-18-02（performanceDetail manager 跨店读他人绩效）
- audit-19 P0-19-01/02（customer.assign 跨店 + giftHistory 裸 SQL）
- audit-20 P0-20-02（createPickup reqStaffBound 而非 reqManager）
- audit-22 P0-22-01/02/03 + P1-22-05/06/07/08（permission_roles 全方位）
- audit-25 P0-25-03（admin searchEmployees 跨集团零 scope）
- docs/audit/audit-CC4-auth.md（v1）
- docs/audit/audit-CC4-auth-v2.md（v2，已并入本版）

---

## 附录：v1 → v2 变更对照

| 问题 | v1 状态 | v2 验证结果 |
|------|---------|-----------|
| P0-CC4-01 payNotify 签名缺失 | P0，无守卫 | 🔶已封锁(临时)，未修复；DISABLED 守卫存在（2026-04-26 加入）|
| P0-CC4-02 admin generateOrderWxacode 漏鉴权 | P0，4 处漏调 | ✅ 未修复，v2 独立确认 |
| P0-CC4-03 admin getMarketStoreIds 漏鉴权 | P0，4 处漏调 | ✅ 未修复，v2 独立确认 |
| P0-CC4-04 hr scope 子树判定 | P0 | ✅ 未修复 |
| P0-CC4-05 assignRole scope.type 校验 | P0 | ✅ 未修复 |
| P0-CC4-06 唯一 admin 删除无保护 | P0 | ✅ 未修复 |
| P0-CC4-07 staff mgmt-* 三副本 scope | P0 | ✅ 未修复 |
| P0-CC4-08 client scanDetail 无 requirePhone | P0 | **✅ 已修复**（order.js:57 有 requirePhone） |
| P0-CC4-09 staffApi _testOpenid 无门控 | 未记录 | **新发现 P0** → P0-CC4-09 |
| P0-CC4-10 admin estimateRefundOverdraft 无 scope | P0 | ✅ 未修复 |
| P0-CC4-11 admin search* 零 scope | P0 | ✅ 未修复 |
| P1-CC4-17 admin getCardKindNamesFromDb | P0（admin 4 漏之一） | ✅ 未修复，降级 P1 |
| P1-CC4-18 admin getPointsToYuanRate | P0（admin 4 漏之一） | ✅ 未修复，降级 P1 |