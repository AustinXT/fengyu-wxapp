# 审计报告：CC4 后端鉴权（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC4（横切，不是单一业务域）
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：— （归集 audit-01 P0-AUTH-01/02/03、audit-04 P0-04-01、audit-22 P0-22-01/02/03 + P1-22-07/08、audit-25 P0-25-03 等 25 个业务域 §5 CC4 命中）
**规范版本**：`real.md` v3.1.0 #5 后端统一鉴权 + #6 组织域隔离

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
│ exports.main(event) — 直接信任 event.{orderNo, transactionId, payAmount, paymentMethod}
│   ⚠ 0 行签名校验；0 行解密；0 行 NotifyURL 来源校验；0 行 NODE_ENV 守卫
│   ⚠ 任何同 envId 小程序页可调 wx.cloud.callFunction({name:'payNotify'}) 伪造支付落账
└────────────────────────────────────────────────────────────┘
```

---

## 3. 自身漏洞（横切归集 + 量化）

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-CC4-01]** payNotify 入口完全无鉴权 / 无微信签名校验（最严重 CC4 命中，全栈资损）
- **文件**：`fengyu-client/cloudfunctions/payNotify/index.js:38-46`（grep `signature|verify|crypto|aes|sha256|wechatpay|getWXContext|ctx\.auth` 全 0 命中；`package.json` 仅 `wx-server-sdk + pg`，无任何加解密库）
- **现象**：`exports.main = async (event) => { const { orderNo, transactionId, payAmount, paymentMethod } = event ... }` 直接把 event 当成"已验证的微信回调"。任何能调用此云函数的人（同 envId 小程序内任意页面）都可伪造一笔支付：
  ```js
  await wx.cloud.callFunction({ name:'payNotify', data:{ orderNo, transactionId:'forged', payAmount:1 }})
  ```
- **风险**：违反 real.md #3 支付幂等 + #5 后端鉴权双重硬约束。下游业绩 (sale_allocations) / 积分 (point_transactions) / 储值卡 (prepaid_cards / card_transactions) / 顾客等级 (customer_type / spending_tier) / share-gift (user_coupons + messages) 全链路触发。
- **首次发现**：audit-04 P0-04-01。本报告归集为 CC4 唯一一处"完全无鉴权第三方触发器"。
- **修复**：(L3) 接入真实回调时按微信支付 V3 规范：从 header 取 `Wechatpay-Signature/Serial/Timestamp/Nonce`，加载平台证书 RSA-SHA256 verify，AEAD_AES_256_GCM 解密 ciphertext，校验 mchid/appid。`process.env.NODE_ENV === 'production'` 时强制；非 production 才允许 mock event。

#### **[P0-CC4-02]** Admin 171 个 server action 无统一 wrapper，依赖每个 action 第一行手调 `requirePermission`，已确认 4 处漏调 + 双轨实现
- **文件**：`fengyu-admin/src/middleware.ts:9-65`（仅 JWT 存在性）+ `'(main)/layout.tsx:6-21`（仅 session 重定向，不校验权限） + 各 `actions/*.ts`
- **量化扫描结果**（grep `^export async function` vs `requirePermission|getSession`）：
  | 文件 | exports | 用 requirePermission 数 | 用 getSession 数 | 缺 perm 的具体 action |
  |------|---------|------------------------|-------------------|------------------------|
  | auth.ts | 7 | 0 | 4 | login / logout / getSessionFromCookie / checkMustChange ✅ 公共入口；**resetEmployeePassword:223 / resetToDefaultPassword:271 / changePassword:121** 用 `session.roles.some(r=>r.role==='admin')` 自检替代 requirePermission（**双轨实现，PERMISSION_MATRIX 无对应 action 项**） |
  | orders.ts | 11 | 10 | 10 | **`generateOrderWxacode:1850`** ⚠️ 无 session、无 perm、无 ownership — 任意已登录员工可生成任意 saleOrderId 的 wxacode（反向枚举订单存在性 + 可用作钓鱼链接） |
  | settings.ts | 8 | 7 | 7 | **`getPointsToYuanRate:375`** 无 session（低敏感，但与 settings 模块其它入口不一致） |
  | stores.ts | 5 | 4 | 4 | **`getMarketStoreIds:220`** ⚠️ 无 session、无 scope — 任意已登录员工可枚举任意 storeId 的同市场门店列表，泄露组织架构 |
  | products.ts | 36 | 35 | 35 | **`getCardKindNamesFromDb:159`** 无 session（公共配置，但 admin 域不应有公共入口） |
  | permissions.ts | 6 | 7（assignRole 内 if 分支双 perm） | 6 | OK，所有写路径均有 perm |
  | 其它 18 个文件 | 100 | 100 | 100 | 全覆盖 ✅ |
- **总量**：171 actions / 161 调 requirePermission / 4 漏调 / **0 处使用 withPermission HOF**（HOF 不存在，全靠开发者自觉）
- **风险**：admin 任何新增 action 第一行漏写一行 = 该 action 整路无鉴权；4 个已发现漏检中 generateOrderWxacode + getMarketStoreIds 是真实越权面。
- **首次发现**：audit-01 P0-AUTH-01。本报告完成全量量化。
- **修复**：(L7) 引入 `withPermission(action, fn)` HOF；(L0) lint 规则强制 server action 第一行调用 HOF 或 `requirePermission`。给 `auth.resetPassword` / `auth.resetToDefault` / `wxacode:generate` / `store:list` 等增补 PERMISSION_MATRIX 项。

#### **[P0-CC4-03]** Admin 非 admin 角色 scope 校验仅做"集合相等"而非"子树包含"，hr 角色实质失能
- **文件**：`fengyu-admin/src/actions/permissions.ts:184-188, 263-269`
- **现象**：`if (!userScopeIds.includes(data.scopeId)) reject` —— hr (scope=总部) 给某门店员工分配角色时 `data.scopeId=门店 org_node_id` 不在 `userScopeIds=[总部]` 里 → 拒绝。代码与 spec `admin.pr.spec.md:190` "hr 分配的 scope_id 须在其 scope 内"直接冲突。
- **风险**：hr / 市场 manager 完全无法分配下属 scope，所有授权必须走 admin → RBAC 设计被瓦解。
- **首次发现**：audit-22 P0-22-02。
- **修复**：(L7) 改为子树包含判定（`expandScopeStoreIds(session.roles)` 反向判断 `data.scopeId` 是否在子树内）。

#### **[P0-CC4-04]** Admin assignRole 不校验非 admin 角色的 scope.type，可绑 manager/finance/hr 角色到"部门"型 org_node
- **文件**：`fengyu-admin/src/actions/permissions.ts:192-201`
- **现象**：仅 `role==='admin'` 时校验 `node.type==='总部'`；其它 6 个 role 接受任何 type（含"部门"）。下游 `expandScopeStoreIds` 对部门 silently 返回 `[]` → admin scope 检查空集 → 看似"安全"但 `requirePermission` 仍允许执行。
- **首次发现**：audit-22 P0-22-01。
- **修复**：(L7) assignRole 按 role 校验允许的 scope.type 集合（admin → 总部；manager/finance/customer_mgr → 总部/市场/门店；hr/product → 总部/市场）。

#### **[P0-CC4-05]** Admin 撤销 admin 角色无"至少保留 1 个 admin"保护，可锁死系统
- **文件**：`fengyu-admin/src/actions/permissions.ts:241-286, employees.ts:439-444`
- **现象**：`revokeRole(自己 admin 行 id)` 或 `updateEmployee({isResigned:true})` 触发 DELETE permission_roles 时无 count 检查。一旦剩 0 个 admin → assignRole 自身需要 `permission:assign_admin` → 死锁。
- **首次发现**：audit-22 P0-22-03。
- **修复**：(L7) 撤删 `role='admin'` 前 `SELECT count(*) FROM permission_roles WHERE role='admin' AND employee_id != current` 至少 ≥1。

#### **[P0-CC4-06]** Staff 业务路由 store/scope 完全无过滤（cross-store 全局读改）—— audit-10/11/13/19/20 反复命中
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
- **首次发现**：audit-01 P0-AUTH-02 + audit-10 P0-10-01/02/03/04 + 20 域系统性扩散。
- **修复**：(L3 staff middleware) 强制 `scope assertion` — 路由未声明显式 `bypassScope=true` 必须经过 `buildStoreScopeCondition`；(L0) 引入 `assertCustomerInScope(session, clientUserId)` / `assertEmployeeInScope(session, employeeId)` helper 跨域统一调用；(L3) `routes/mgmt-customer.js:60-90` / `mgmt-dashboard.js:142-198` / `mgmt-traffic.js:40-74` 三副本 buildScopeFragment 收口到 `helpers/scope.js`。

#### **[P0-CC4-07]** Client 私域读接口 `requirePhone()` 守卫覆盖率不足 50%（业务层 ownership 唯一防线）
- **文件量化扫描**（基于 `grep -cE "requirePhone\("`）：
  | 文件 | exports | reqPhone 调用 | 业务层 user_id 守卫 | 漏检路由 |
  |------|---------|---------------|---------------------|---------|
  | order.js | 15 | 3 | ownership=36 | scanDetail 完全无 reqPhone（audit-02/06 CC4 命中），多个 list/detail 仅靠 SQL `WHERE client_user_id=$userId` |
  | appointment.js | 3 | 1 | ownership=6 | list/cancel 漏 reqPhone（audit-06 P0-06-01）|
  | service.js | 2 | 0 | ownership=2 | list/detail 完全无 reqPhone，仅 SQL `client_user_id` 兜底 |
  | points.js | 2 | 0 | ownership=2 | balance/history 漏 reqPhone（audit-15 已记） |
  | message.js | 3 | 0 | ownership=3 (recipient_id) | list/read/unreadCount 漏 reqPhone（audit-16 P0-16-01） |
  | card.js | 6 | 2 | ownership=8 | list/balance ✅ reqPhone；history/recharge/rechargeConfig 部分缺 |
  | coupon.js | 2 | 2 | ownership=4 | OK ✅ |
  | staff.js | 3 | 0 | ownership=1 | defaultStaff 仅 SQL `WHERE u.user_id=$1` 兜底；list/detail 公共信息可不要 reqPhone |
  | store.js | 6 | 0 | ownership=2 | requestUnbind/getUnbindRequest/cancelUnbindRequest 全无 reqPhone（audit-12 P0-12-01）|
- **总量**：60 路由 / 9 个调 reqPhone / 51 个未调（其中 `auth.*`/`config.*`/`store.list/detail`/`product.*`/`staff.list/detail` 共约 25 个为合理公共入口；其余 26 个均为私域读但缺守卫，仅靠 SQL ownership 兜底）
- **风险**：未绑定手机号 / 解绑后用户仍可调；攻击者获取一个空 phone 的 OPENID 仍能读自己 user_id 名下所有数据（业务上无意义但与"必须实名"语义不符）；个别业务路由若开发者忘记 SQL 加 `client_user_id = $userId` 即跨用户越权（audit-01 P0-AUTH-03）。
- **首次发现**：audit-06 P0-06-01 + audit-15 + audit-16 P0-16-01。本报告完成全量盘点。
- **修复**：(L3) 在 `clientApi/index.js` 路由层维护 `phoneRequiredRoutes` 集合（与 `publicActions` 对偶），自动 wrap requirePhone()；(L0) 引入 `requireOwnership(table, idColumn)` middleware，路由声明所要 ownership 维度，middleware 自动注入 SQL fragment。

#### **[P0-CC4-08]** Client `scanDetail` 类无鉴权"枚举式"接口
- **文件**：`clientApi/routes/order.js:51 scanDetail`
- **现象**：未 `requirePhone()`，仅校验 `order.opened_by IS NOT NULL`；任何已登录用户传 saleOrderId 即可看他人订单（含金额、商品、门店、顾客手机号尾号）。
- **首次发现**：audit-02 P0-02-x 单独条目。
- **修复**：(L3) `requirePhone()` + `assertOrderInOwnerOrScannableQuota(session, saleOrderId)`；只允许"未支付且距 created_at < 30 min" 的订单被陌生人扫码（spec 应明文）。

#### **[P0-CC4-09]** Admin estimateRefundOverdraft / getAvailableCoupons 接收 userId 入参不校验属于 session scope
- **文件**：`fengyu-admin/src/actions/refunds.ts estimateRefundOverdraft` + `actions/coupons.ts:106 getAvailableCoupons`
- **现象**：仅 `requirePermission(session, 'sale_order:create' or 'sale_order:refund')`，对 clientUserId 入参零校验。任何 admin 用户可枚举任意顾客 12 月消费 / member_level / user_coupons / face_value_override 真实面值。
- **首次发现**：audit-11 P1-11-09 + audit-13 P0-13-08。归集为 CC4 单独类。
- **修复**：(L7) 加 `assertCustomerInScope(session, clientUserId)` helper，所有 `clientUserId` 传参的 admin 查询路径强制调用。

#### **[P0-CC4-10]** Admin search* 选择器零 scope（与 list/getX 双轨）
- **文件**：`fengyu-admin/src/actions/employees.ts:73-102 searchEmployees`（同文件 `getEmployees` 有 scopeCondition ✅）
- **现象**：选择器搜索绕过 scope 过滤，跨集团零隔离；audit-25 P0-25-03 揭示 promoter 推荐场景已暴露面。
- **首次发现**：audit-25 P0-25-03。
- **修复**：(L7) grep `admin/src/actions/*.ts` 全部 `search*` 函数补 scopeCondition；或独立 `searchInScope*` 命名 + lint 强制。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-CC4-11]** Admin scope 隐式合约：依赖权限矩阵不维护就漏 isInScope
- **文件**：`fengyu-admin/src/actions/orders.ts:1531 recordPayment`（注释明确说"非 admin 由权限矩阵拒绝；扩权限到 scoped 角色需在此处补 isInScope"）
- **首次发现**：audit-02 P0-02-05 + audit-03 复核。
- **风险**：权限矩阵任何一次"开放给 scoped 角色"修改都会破坏此隐式合约。
- **修复**：(L7) 把 isInScope 校验从隐式合约改为显式 `scopeCondition` + 写测试断言。

#### **[P1-CC4-12]** Staff `requireManager()` 旧数据 fallback 越权
- **文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:259-272`
- **现象**：`scopeType` 缺失时 fallback 到 `roles.includes('manager')`，绕过"门店"约束；总部级 / 市场级 manager 误得开单权（开单本应仅门店店长）。
- **首次发现**：audit-22 P1-22-08。
- **修复**：(L3) 移除兜底；先 SQL 排查 `WHERE o.type IS NULL` 残留并清理。

#### **[P1-CC4-13]** Admin 与 Staff 两端权限矩阵两套真相源（audit-22 P1-22-07）
- **现象**：admin = `PERMISSION_MATRIX` 7 角色 × N action 代码常量；staff = 4 staffLevel + 硬编码 `requireManager` / `requireManagementLevel` 守卫。同一 `manager` 在 admin 有 22 actions，staff 仅靠 1 个守卫。
- **修复**：(L0/L3) 长期：PERMISSION_MATRIX 移至 DB（`system_configs.permission_matrix`），admin/staff/cron 共读；短期：staff 端把硬编码守卫显式化为 `STAFF_REQUIRED_ROLES` 常量。

#### **[P1-CC4-14]** Admin Server Action 错误处理用 `{success:false}` 而非 throw `PERMISSION_DENIED:`
- **现象**：`auth.resetEmployeePassword` 内 `isAdmin` 自检失败返回 `{success:false, message:'仅系统管理员可重置密码'}`；与 staff/client 抛 `PERMISSION_DENIED:` 前缀不一致。前端按前缀映射 toast 文案落入"未识别错误"分支。
- **修复**：(L7) admin 越权场景统一抛 `PERMISSION_DENIED:` 或在 `requirePermission` 失败路径上放置统一 wrapper。

#### **[P1-CC4-15]** Admin Server Action 用相邻动作权限项替代独立 cancel/reject 等
- **现象**：`appointments.ts:248-250 cancelAppointment` 用 `requirePermission(session, 'appointment:confirm')`；`refunds rejectRefund` 与 `approveRefund` 共用 `'sale_order:refund'`。"确认权"自动拥有"取消权"，权限语义错位。
- **首次发现**：audit-06 P0-06-05 + audit-11 §3.2。
- **修复**：(L0) PERMISSION_MATRIX 增补 `appointment:cancel` / `sale_order:reject_refund` 项；(L7) 替换。

### 3.3 P2

#### **[P2-CC4-16]** `permission_roles.role` 列裸 text 无 enum，可写入任意字符串
- **文件**：`db/schema/permission.ts:20`（audit-22 P1-22-06 同条）
- **修复**：(L0) 增 PG `roleEnum` 7 值。

#### **[P2-CC4-17]** Staff 端 5 min auth 缓存 vs admin 即时生效造成"撤角色后仍可工作 ≤5 min"窗口
- **首次发现**：audit-22 P1 + audit-17 P0-17-04 模块级 cache。
- **修复**：(L3) 关键写操作（开单 / 退款审批 / 角色撤销）触发 cache invalidate 跨进程广播；或将 TTL 缩为 1 min。

#### **[P2-CC4-18]** PERMISSION_MATRIX `staff` 角色 actions=[] 哑角色 vs staff 端正常派生 LEVEL_STORE_STAFF
- **首次发现**：audit-22 P1-22-05。
- **修复**：(L7) 显式给 staff 最低 actions（`['dashboard:view']`）或彻底从 RoleType 移除。

---

## 4. 跨端不一致（CC4 主表）

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| 路由门禁 | middleware.ts JWT 校验（仅 token 存在性） | `auth(ctx,...)` 全过 | `auth(ctx,...)` 4 publicActions 例外 | **0 校验** | payNotify 全栈最弱 | P0 |
| 鉴权信任 | action 自调 requirePermission（**171 中 4 漏**，0 个 HOF） | middleware 注入 + 路由作者自觉 | 业务层 SQL `client_user_id` 自觉 + 部分 requirePhone | — | admin 漏 = 整 action 失防；staff 漏 scope = 跨店；client 漏 user_id = 跨用户 | P0 |
| Roles 数据 | DB `permission_roles` JOIN org_nodes，每请求查 | 同 DB，5 min LRU | **无 roles** | 无 | client 端无角色概念，业务层硬编码"已登录"足够 | — |
| 权限矩阵 | PERMISSION_MATRIX 代码常量 7 角色 × ~50 action | 4 staffLevel + 3 守卫函数 | 1 守卫函数（reqPhone） | — | 同 manager 在 admin 22 actions / staff 1 守卫 = 两套真相源 | P1（已记 P1-CC4-13） |
| Scope 强度 | `scopeCondition()` Drizzle helper，所有 SQL 套 | `buildStoreScopeCondition` 路由作者自觉调；mgmt-* 三副本自实现 | **无 scope helper**，业务层手写 | — | client > staff > admin 风险递增；mgmt-* 三副本 = helper 双轨 | P0 |
| Ownership 强度 | scope 兜底（admin 角色无 scope） | scope 兜底 | 业务层 SQL `client_user_id = $userId` 手写 | — | 漏写即跨用户 | P0 |
| 错误前缀 | 多裸 `throw Error(中文)` 或 `{success:false}` | `UNAUTHORIZED:` / `PERMISSION_DENIED:` 4 类规范 | 4 类规范 | `FAIL/SUCCESS` 微信约定 | admin 不一致（已记 P1-CC4-14） | P1 |
| Session 缓存 | 无（每请求查 DB） | AUTH_CACHE 5 min/200 LRU | AUTH_CACHE 5 min/200 LRU | — | 角色变更后 staff/client 滞后 | P2（已记 P2-CC4-17） |
| 跨表 OPENID 唯一 | — | openid 表内 UNIQUE | openid 表内 UNIQUE | — | 无跨表唯一约束（audit-01 P0-SPLIT-04） | P0 |

---

## 5. 横切检查（套用 §3 模板）

本报告本身就是 CC4 收官。其他 CC 在本域无新增命中：

| CC | 状态 | 说明 |
|----|------|------|
| CC1 数值精度 | — | 与本域无关 |
| CC2 并发幂等 | — | 与 CC4 不耦合（payNotify uq_sop_txn 命中 CC2 已在 audit-04 记） |
| CC3 组织域隔离 | 同源 | CC3 的"scope 不强制"与 CC4 的"鉴权链路"是同一组防线，本报告 P0-CC4-06 段就是 CC3+CC4 双命中 |
| CC4 后端鉴权 | ✅ 收官 | 9 P0 / 5 P1 / 3 P2 |
| CC5 错误前缀 | 部分 | P1-CC4-14（admin 错误前缀不一致）与 CC5 收官时合并 |
| CC6 PII | — | audit-04 P0-04-04 console.log event PII 在 CC6 收口 |
| CC7 时间字段 | — | 与本域无关 |
| CC8 WXML/Vant | — | 与本域无关 |
| CC9 测试残留 | — | audit-23 收口"staffApi 全域审计日志缺位"与本域守卫缺失互补 |

---

## 6. real.md 7 条硬约束符合性（CC4 视角）

| # | 约束 | admin | staff | client | payNotify | 总体 |
|---|------|-------|-------|--------|-----------|------|
| 5 | **后端统一鉴权** | ❌ 无 wrapper / 4 漏 / 4 双轨自检 | ⚠️ middleware OK、路由信任、5 min cache 滞后、3 副本 helper | ❌ 无 roles / 26 私域路由缺 reqPhone / 无 ownership helper | ❌❌❌ 0 校验全开放 | 🔴🔴🔴 **严重不符** |
| 6 | 组织域隔离 | ✅ scope 全 SQL 套（admin 角色除外） | ⚠️ helper 存在但非强制 + mgmt-* 三副本 | ❌ 无 scope helper，业务层手写 | — | 🟡 部分（CC3 收口） |
| 3 | 支付幂等（与 CC4 共因） | — | — | — | ❌ 无签名校验 = 无幂等基础 | 🔴 不符（audit-04 收口） |

---

## 7. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/enums.ts` | 新增 `roleEnum` 7 值；`permission_roles.role` 列收紧 | P2-CC4-16 |
| L0 schema | `db/schema/user.ts` | 跨表 openid 唯一性（物化视图 + UNIQUE INDEX） | audit-01 P0-SPLIT-04 |
| L0 配置 | `system_configs.permission_matrix` | PERMISSION_MATRIX 移至 DB；admin/staff/cron 共读 | P1-CC4-13、audit-01 P1-PERM-07 |
| L0 helpers | `db/helpers/scope.ts`（新增） | 跨端共用 `assertCustomerInScope(session, clientUserId)` / `assertEmployeeInScope(session, employeeId)` / `assertOrderInScope(session, saleOrderId)` | P0-CC4-06 / P0-CC4-09 |
| L3 cloudfunctions | `fengyu-client/cloudfunctions/payNotify/index.js` | 接入真实回调时按 V3 规范签名校验 + AEAD_AES_256_GCM 解密 + mchid/appid 校验；NODE_ENV !== 'production' 才允许 mock event | P0-CC4-01 |
| L3 staff middleware | `staffApi/middleware/auth.js` + `index.js` | 增加 `scope assertion` 包裹 — 路由未声明显式 `bypassScope=true` 必须经过 `buildStoreScopeCondition`；移除 `requireManager()` 旧数据 fallback | P0-CC4-06 / P1-CC4-12 |
| L3 staff routes | `routes/mgmt-customer.js:60-90` + `mgmt-dashboard.js:142-198` + `mgmt-traffic.js:40-74` | 三副本 buildScopeFragment 收口到 `helpers/scope.js` 单一实现 | P0-CC4-06 |
| L3 client middleware | `clientApi/middleware/auth.js` + `index.js` | 引入 `phoneRequiredRoutes` 集合（与 `publicActions` 对偶）自动 wrap requirePhone()；引入 `requireOwnership(table, idColumn)` middleware | P0-CC4-07 / P0-CC4-08 |
| L3 admin lib | `fengyu-admin/src/lib/permissions.ts` | 新增 `withPermission(action, fn)` HOF；`auth.ts` resetEmployeePassword/resetToDefaultPassword/changePassword 改用 PERMISSION_MATRIX 项；增补 `auth:resetPassword` / `wxacode:generate` / `appointment:cancel` / `sale_order:reject_refund` action | P0-CC4-02 / P1-CC4-14 / P1-CC4-15 |
| L3 admin actions | `actions/orders.ts:1850 generateOrderWxacode` + `actions/stores.ts:220 getMarketStoreIds` + `actions/products.ts:159 getCardKindNamesFromDb` + `actions/settings.ts:375 getPointsToYuanRate` | 增补 session + requirePermission；wxacode 加 ownership/scope 限制 | P0-CC4-02 |
| L7 admin actions | `actions/permissions.ts:assignRole` | (a) 校验 `node.type !== '部门'` + role 与 type 配对；(b) "scope ⊆ session" 换为子树判定；(c) admin 角色撤销前保留 ≥1 | P0-CC4-03 / P0-CC4-04 / P0-CC4-05 |
| L7 admin actions | `actions/refunds.ts estimateRefundOverdraft` + `actions/coupons.ts:106 getAvailableCoupons` + `actions/employees.ts:73 searchEmployees` + 全部 `search*` | 加 `assertCustomerInScope` / scopeCondition | P0-CC4-09 / P0-CC4-10 |
| L7 admin actions | `actions/orders.ts:1531 recordPayment` | 把"非 admin 由权限矩阵拒绝"隐式合约改为显式 `scopeCondition` | P1-CC4-11 |
| L9 lint | ESLint custom rule | server action 第一行必须 `withPermission(...)` 或 `requirePermission(session,...)` | P0-CC4-02 |

---

## 8. 验证 SQL（5434/fengyu，仅 SELECT）

```sql
-- 8.1 跨表 OPENID 重叠（与 audit-01 P0-SPLIT-04 同验证）
WITH s AS (SELECT openid, employee_id FROM staff_wechat_users WHERE openid IS NOT NULL),
     c AS (SELECT openid, user_id     FROM client_wechat_users WHERE openid IS NOT NULL)
SELECT s.openid, s.employee_id, c.user_id
FROM s JOIN c USING (openid);
-- 预期：0 行；非 0 即跨表绑定问题

-- 8.2 部门型 scope 写入（P0-CC4-04）
SELECT pr.id, pr.employee_id, pr.role, pr.scope_id, o.type, o.name
FROM permission_roles pr
JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type = '部门';
-- 预期：0 行

-- 8.3 当前活跃 admin 角色数量（P0-CC4-05）
SELECT count(*) AS admin_count
FROM permission_roles pr
JOIN staff_wechat_users s ON s.employee_id = pr.employee_id
WHERE pr.role = 'admin' AND s.is_resigned = false;
-- 期望 ≥ 2

-- 8.4 permission_roles.role 是否含意外值（P2-CC4-16）
SELECT role, count(*) AS cnt FROM permission_roles GROUP BY role ORDER BY role;
-- 期望仅 admin/manager/finance/hr/product/customer_mgr/staff 7 值

-- 8.5 staff 端旧数据兜底命中（P1-CC4-12）
SELECT pr.id, pr.role, pr.scope_id, o.type
FROM permission_roles pr
LEFT JOIN org_nodes o ON o.id = pr.scope_id
WHERE o.type IS NULL OR o.id IS NULL;
-- 预期：0 行；非 0 即 staff requireManager 兜底分支可触发

-- 8.6 hr 角色当前 scope 与"可分配 scope"集合差距（P0-CC4-03）
SELECT pr.scope_id AS hr_scope, o.type, o.name
FROM permission_roles pr JOIN org_nodes o ON o.id = pr.scope_id
WHERE pr.role = 'hr';
-- 与 expandScopeStoreIds 子树展开比对，量化 hr 实际能/不能分配的 scope 比例
```

---

## 9. 回归测试用例（建议）

1. **payNotify 伪造攻击**：`wx.cloud.callFunction({name:'payNotify', data:{orderNo, transactionId:'forged', payAmount:0.01}})` → 接入真实签名后必须 reject
2. **admin generateOrderWxacode 越权**：finance 用户请求 `generateOrderWxacode(任意 saleOrderId)` → 应被 PERMISSION_DENIED:（修复后）
3. **admin getMarketStoreIds 越权**：跨集团 manager 请求 `getMarketStoreIds(他集团 storeId)` → 应被 scope 过滤为空（修复后）
4. **admin assignRole 部门 scope**：直接调 `assignRole({role:'manager', scopeId:<部门 org_node>})` → 应被拒绝
5. **admin hr 子树分配**：hr (scope=市场) 给市场内任一门店员工分配 manager → 应通过（当前会被拒）
6. **admin 唯一 admin 自删**：`revokeRole(自己 admin id)` 或 `updateEmployee({isResigned:true})` → 应被拒绝并提示"系统至少需保留 1 个 admin"
7. **staff requireManager 旧数据**：构造无 scopeType 的 manager 绑定，调 `order.create` → 应被拒（移除 fallback 后）
8. **staff mgmt-* 跨店枚举**：market manager A 调 `mgmtTraffic.summary({storeId: 跨市场 store})` → 应被 scope 过滤拒绝
9. **client scanDetail 枚举**：A 用户传 B 的 saleOrderId 调 `scanDetail` → 修复后应仅允许"未支付且 < 30 min" 订单
10. **client service.detail 跨用户**：A 用户传 B 的 serviceOrderId 调 `service.detail` → 应返回 NOT_FOUND（业务层 SQL 守卫已挡，本测试为回归保护）
11. **admin estimateRefundOverdraft 越权枚举**：跨集团 finance 传 clientUserId → 应被 assertCustomerInScope 拒绝（修复后）
12. **admin search* 跨集团选择器**：跨集团 admin 调 `searchEmployees('张')` → 修复后应仅返回 scope 内员工

---

## 10. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + payNotify）：☑
- 涉及历史数据：☑（需 8.1-8.5 SQL 跑生产 5434 验证脏数据）
- 修复成本：**XL**（涉及 schema 约束 + 三端 middleware 重构 + admin HOF 改造 + payNotify 签名接入 + lint 规则 + 历史数据迁移）
- **总 P0/P1/P2 计数**：**10 P0 / 5 P1 / 3 P2**（CC4 是审计中 P0 数量第二多的横切域，仅次于 CC2 并发幂等）

---

## 11. 后续待办

- [ ] 执行 §8 全部验证 SQL，量化生产 5434 实际越权风险
- [ ] 与 admin 团队对齐 `withPermission(action, fn)` HOF 实现策略 + lint 规则部署
- [ ] 与 PM 对齐 PERMISSION_MATRIX 移至 DB 的演进路径（audit-01 P1-PERM-07 + 本域 P1-CC4-13）
- [ ] 与运维对齐 payNotify 接入真实微信 V3 回调的部署节奏（NotifyURL + 平台证书 + APIv3Key 环境变量）
- [ ] 收口 `helpers/scope.ts` 跨端共用 helper（assertCustomerInScope / assertEmployeeInScope / assertOrderInScope），三副本 buildScopeFragment 整合
- [ ] 写一篇 `docs/playbook/cc4-auth-hardening.md`，把 10 P0 + 5 P1 修复编排成 5 期 epic（路由门禁 / scope 强制 / payNotify 签名 / admin HOF / cache 一致性）

---

## 12. 关联引用

- `.42cog/real.md` v3.1.0 #5 后端统一鉴权 + #6 组织域隔离
- audit-01 P0-AUTH-01/02/03 + P0-SPLIT-04 + P1-PERM-07
- audit-02 P0-02-05（admin scope 隐式合约） + scanDetail 类
- audit-04 P0-04-01（payNotify 全栈无鉴权）
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
- CROSS-CUTTING.md CC4 段（11 条已归集 + 本报告补 9 条新归集 — 全归并到本报告）
