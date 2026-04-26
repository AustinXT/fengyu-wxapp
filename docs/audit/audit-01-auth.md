# 审计报告：认证 / 鉴权 / 双端用户表隔离 (01)

**审计时间**：2026-04-26
**域 ID**：01
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—
**规范版本**：`real.md` v3.1.0 / `backend.pr.spec.md` v4.0.0

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/user.ts:12-133` (双端用户表) + `db/schema/admin-auth.ts:10-28` (admin_passwords) + `db/schema/permission.ts:12-35` (permission_roles) | ↑ | ↑ |
| Middleware | `fengyu-admin/src/middleware.ts:1-65` (JWT 校验) | `staffApi/middlewares/auth.js:99-137` + `staffApi/middlewares/scope.js:25-159` | `clientApi/middlewares/auth.js:19-84` |
| Session/Auth | `fengyu-admin/src/lib/auth.ts:164-218` (`getSessionFromCookie`) + `fengyu-admin/src/lib/permissions.ts:90-220` | `staffApi/index.js:99-160` (auth wrap) + `helpers/scope.js:139-159` (`buildStoreScopeCondition`) | `clientApi/index.js:71-114` |
| Login/Bind | `(auth)/login/*` + `actions/auth.ts` | `routes/auth.js` (login/bindPhone) | `routes/auth.js` (login/bindPhone/bindStore/updateProfile) |
| 测试 | (待补) | (待补) | (待补) |

**身份载体差异**：admin = JWT(HS256) httpOnly cookie `fy-admin-token` (24h)；staff/client = OPENID + 5min 内存缓存（`AUTH_CACHE`，200 上限）。

---

## 2. 数据流图

```
admin login
  POST /(auth)/login → actions/auth.ts
    → bcrypt 校验 admin_passwords
    → JWT sign(employeeId, 24h)
    → Set-Cookie fy-admin-token (httpOnly)

admin request
  middleware.ts
    → jwtVerify(token)
    → 401/redirect-to-login if invalid
  → Server Action
    → getSessionFromCookie() 二次查 DB（staff_wechat_users + permission_roles + org_nodes）
    → requirePermission(session, action)
    → SQL with scopeCondition(session, store_id_column)

staff/client request
  index.js → auth(ctx, next)
    → cloud.getWXContext() → OPENID
    → AUTH_CACHE 命中？是→ctx.auth；否→loadAuthBase(openid)
    → 路由 handler(ctx)
      → requireStaffBound() / requireManager() / requirePhone() 等守卫
      → SQL with buildStoreScopeCondition(ctx.auth, column)  [仅 staff]
                  AND client_user_id = ctx.auth.userId      [仅 client，业务层]

bindPhone (staff)
  接收 cloudId → cloud.getOpenData → purePhoneNumber
  → SELECT staff_wechat_users WHERE phone = $1
    ├─ 命中：UPDATE openid (按 phone 找同步行，v3.3 模式)
    └─ 未命中：INSERT 新员工档案行（bind 时建）
  → 返回 roles 数组

bindPhone (client)
  接收 cloudId → cloud.getOpenData → purePhoneNumber
  → SELECT client_wechat_users WHERE openid = $1
  → if users[0].phone 已存在：throw "已绑定..."
  → UPSERT phone（openid 映射 phone）
  → 返回 user info
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-AUTH-01]** Admin Server Action 缺统一鉴权 wrapper，依赖每个 action 自检
- **文件**：`fengyu-admin/src/middleware.ts:9-65` + 各 `actions.ts` 散落
- **现象**：`middleware.ts` 仅在路由级挡 token 缺失；Server Action 内部逐个调用 `requirePermission(session, action)`。无统一 wrapper，依赖开发者每次 action 都写。
- **风险**：单个 action 漏写 `requirePermission()`，即资损（退款/订单重置/权限赋予）越权。无第二道防线。
- **复现**：grep `await requirePermission` vs server action 总数，差值即风险面。
- **修复**：(L7) 引入 `withPermission(action, fn)` HOF；(L0) lint 规则强制 server action 第一行调用之。

#### **[P0-AUTH-02]** Staff 路由层 scope 过滤非全覆盖
- **文件**：`staffApi/middlewares/auth.js:99-137`（middleware 仅注入 `ctx.auth.scopeStoreIds`，不强制使用） + 各 `routes/*.js`
- **现象**：middleware 注入 scope 信息，但 SQL 是否调用 `buildStoreScopeCondition(ctx.auth, 'store_id')` 完全靠路由作者自觉。一个忘加 = 全网门店数据可见。
- **风险**：员工查全网订单 / 客户 / 服务单（信息泄露 + 越权操作）。real.md 第 6 条硬约束破损。
- **复现**：`grep -rL "buildStoreScopeCondition" staffApi/routes/*.js` 列出所有未调用此 helper 的路由，逐个核实 SQL 是否含 `store_id IN (...)`。
- **修复**：(L3) 给所有写库/查库 SQL 强制套 helper；(L0) middleware 加 "scope assertion"，未声明显式 `bypassScope=true` 的路由必须传过 helper。

#### **[P0-AUTH-03]** Client 端无 roles，业务隔离 100% 依赖业务层 `userId === ctx.auth.userId` 自检
- **文件**：`clientApi/middlewares/auth.js:19-84` + 各 `routes/*.js`
- **现象**：middleware 仅暴露 `{userId, phone, boundStoreId, ...}`，无任何 scope 注入。任意路由若 SQL 是 `WHERE sale_order_id = $1`（少了 `AND client_user_id = $2`），则顾客 A 可查 B 的订单。
- **风险**：跨用户越权 / PII 泄露（client 端订单含手机号、地址、消费金额）。real.md 第 6 条破损。
- **复现**：手抓任一 detail/list 接口，篡改 ID 重放，看是否拒绝。
- **修复**：(L3) 所有 client 路由 SQL 强制带 `AND client_user_id = $n`；(L0) 引入 `requireOwnership(table, id)` middleware；(L9) 测试覆盖跨用户重放。

#### **[P0-SPLIT-04]** 同一 OPENID 可同时存在于 `staff_wechat_users` 和 `client_wechat_users`
- **文件**：`db/schema/user.ts:18`(client.openid UNIQUE) + `db/schema/user.ts:129`(staff.openid UNIQUE)
- **现象**：两表 openid 各自 UNIQUE，**无跨表全局唯一约束**。员工微信号若同时进客户端 login + bindPhone 不同手机号，会形成跨表绑定。
- **风险**：身份混乱、权限错配、支付回调/同步脚本误入错表。
- **复现**：见 §7 SQL 验证 #2。
- **修复**：
  - (L0) 加 EXCLUDE 约束或物化视图 + UNIQUE INDEX 实现跨表唯一
  - (L3) bindPhone 前显式查对端表是否已绑该 openid，命中则拒绝并返回 `ROLE_CONFLICT:`
  - (L9) 文档明确"员工微信号不可作顾客端使用"

#### **[P0-PHONE-05]** 三端均缺中国手机号格式校验
- **文件**：`staffApi/routes/auth.js:193-195` + `clientApi/routes/auth.js:100` + `fengyu-admin/src/actions/auth.ts:64-68`
- **现象**：直接使用 `purePhoneNumber`（来自微信 cloudId 解密）或 admin 端 `phone` 入参，未做 `/^1[3-9]\d{9}$/` 二次验证。
- **风险**：伪造/异常 phone 写入 DB；后续 WorkFine 同步按 phone 匹配可能误匹配。
- **修复**：(L0) `db/helpers/phone.ts` 统一 util；(L3) 三端 bindPhone 入口前置校验；DB 层加 CHECK 约束 `phone ~ '^1[3-9][0-9]{8}$'`。

#### **[P0-PII-06]** 日志/错误信息含完整 OPENID / 手机号 / 身份证
- **文件**：`staffApi/routes/auth.js:141-144`（updateLastLogin） + `clientApi/routes/auth.js:55-58` + admin `lib/operation-log.ts`
- **现象**：`operation_logs.detail` 可能含完整 phone/openid；错误堆栈带原始参数。
- **风险**：合规风险（PII 泄露）；audit log 被读取即数据泄露。
- **修复**：
  - (L0) 引入 `mask(phone)` / `maskOpenid(o)` / `maskIdCard(c)`
  - (L3) 三端 logOperation 调用前过 mask
  - (L9) 已有日志做一次性回填脱敏（追加 migration）

### 3.2 P1

#### **[P1-PERM-07]** Admin 权限矩阵代码常量，与 staff/client DB 驱动模型不一致
- **文件**：`fengyu-admin/src/lib/permissions.ts:15-85`（PERMISSION_MATRIX 写死）
- **风险**：调权限需发版；与 staff 的 `permission_roles` 表两套体系，认知割裂。
- **修复**：(L0) 长期迁至 DB；(L3) 短期至少做 envvar override。

#### **[P1-OPENID-08]** Staff bindPhone 未前置检查 openid 是否已绑其他员工
- **文件**：`staffApi/routes/auth.js:176-250`
- **现象**：仅按 phone 查同步行，若 openid 已绑别的 employee 会触发 UNIQUE 冲突错误，返回不友好。
- **修复**：(L3) bindPhone 前 `SELECT employee_id FROM staff_wechat_users WHERE openid = $1`；命中且 ≠ 当前匹配行 → 抛 `OPENID_CONFLICT:`。

#### **[P1-PHONE-09]** Client bindPhone 不幂等：首调成功后超时重试报"已绑定"
- **文件**：`clientApi/routes/auth.js:127-129`
- **现象**：`if (users[0].phone) throw '已绑定...'`，无 idempotency_key。网络重试 → 用户体验差。
- **修复**：(L3) 加 `request_id` 入参，DB 维护 24h 幂等表；或客户端首次成功后切到只读路径。

#### **[P1-MODEL-10]** v3.3 后 `operation_logs.operator_user_id` 是否完全迁移到 `operator_employee_id` 待验证
- **文件**：`db/schema/operation-log.ts`（待读） + 三端 `logOperation` 调用
- **风险**：若有遗留写 `operator_user_id`，FK 链断裂。
- **修复**：见 §7 SQL 验证 #1；若有残留路由，集中修复。

### 3.3 P2

#### **[P2-BINDSTORE-11]** Client `bindStore` 是否要求已 `bindPhone` 未文档化
- **文件**：`clientApi/routes/auth.js:201-250`
- **现象**：spec 未明确，代码亦无 `requirePhone()` 守卫。
- **修复**：(L9) 在 `backend.pr.spec.md` 明确；(L3) 加 middleware 守卫。

#### **[P2-ERROR-12]** Admin 端 throw Error 不带前缀，与 staff/client 不一致
- **文件**：`middleware.ts:54-57` + 各 actions
- **现象**：staff/client 用 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`；admin 多为裸 `throw new Error(msg)`。
- **修复**：(L3) admin 也统一前缀。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 身份载体 | JWT cookie 24h | OPENID + 5min 缓存 | OPENID + 5min 缓存 | 设计差异，可接受 | — |
| 权限来源 | PERMISSION_MATRIX 代码常量 | permission_roles 表 | 无 roles | admin 需发版才能调权 | P1 |
| Roles 数据结构 | `{role,scopeId,scopeType}[]` → actions[] | 同 admin → staffLevel 派生 | N/A | 形态接近，OK | — |
| Scope 强制 | `scopeCondition()` 全 SQL 套 | `buildStoreScopeCondition()` 路由作者自觉调用 | **无 scope helper**，业务层手写 | client > staff > admin 风险递增 | P0 |
| 错误前缀 | 无前缀 | 4 种规范前缀 | 4 种规范前缀 | admin 不一致 | P2 |
| 手机号校验 | 仅按 phone 查 DB | 直接信任 cloudId 解密 | 直接信任 cloudId 解密 | 三端均无格式校验 | P0 |
| Session 缓存 | 无（每次查 DB） | AUTH_CACHE 5min/200 | AUTH_CACHE 5min/200 | 合理 | — |
| PII 处理 | 无脱敏 | 无脱敏 | 无脱敏 | 三端一致缺陷 | P0 |
| 双端用户表唯一性 | — | openid 表内 UNIQUE | openid 表内 UNIQUE | 无跨表唯一约束 | P0 |

---

## 5. 横切检查（CC1-CC9）

| CC | 域 | 命中 | 简述 |
|----|----|------|------|
| CC1 | 数值精度 | — | 与本域无关 |
| CC2 | 并发幂等 | ⚠️ P1 | client bindPhone 非幂等（P1-PHONE-09） |
| CC3 | 组织域隔离 | 🔴 P0 | staff 路由 scope 非强制（P0-AUTH-02）+ client 无 scope（P0-AUTH-03） |
| CC4 | 后端鉴权 | 🔴 P0 | admin 缺 wrapper（P0-AUTH-01） |
| CC5 | 错误码前缀 | 🟡 P2 | admin 不一致（P2-ERROR-12） |
| CC6 | PII | 🔴 P0 | 日志/错误均含完整敏感数据（P0-PII-06） |
| CC7 | 时间字段 | — | last_login_at 由 DB DEFAULT，OK |
| CC8 | WXML/Vant | — | 与本域无关 |
| CC9 | 测试与残留 | ⚠️ P1 | v3.3 `operator_user_id` → `operator_employee_id` 迁移完整性待验（P1-MODEL-10） |

---

## 6. real.md 7 条硬约束符合性

| # | 约束 | admin | staff | client | 总体 |
|---|------|-------|-------|--------|------|
| 1 | 次数防超卖 | 与本域无关 | — | — | — |
| 2 | 价格快照不可变 | — | — | — | — |
| 3 | 支付幂等 | — | — | — | 留待域 04 |
| 4 | 状态单向推进 | — | — | — | — |
| **5** | **后端统一鉴权** | ❌ 无 wrapper | ⚠️ middleware OK 但路由信任 | ❌ 无 roles | 🔴 **不符** |
| **6** | **组织域隔离** | ✅ scope 全 SQL 套 | ⚠️ helper 存在但非强制 | ❌ 无 scope helper | 🟡 **部分** |
| 7 | 待支付订单唯一 | — | — | — | 留待域 02 |

---

## 7. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/user.ts` | phone 列加 CHECK 约束 `phone ~ '^1[3-9][0-9]{8}$'` | P0-PHONE-05 |
| L0 schema | `db/schema/user.ts` | 跨表 openid 唯一性（物化视图 + UNIQUE INDEX） | P0-SPLIT-04 |
| L0 helpers | `db/helpers/phone.ts` (新增) | `validatePhone(s)` / `mask(s)` / `maskOpenid(s)` / `maskIdCard(s)` | P0-PHONE-05, P0-PII-06 |
| L3 staff middleware | `staffApi/middlewares/scope.js` | 增加 "scope assertion"，路由未声明 `bypassScope=true` 必须经过 buildStoreScopeCondition | P0-AUTH-02 |
| L3 client middleware | `clientApi/middlewares/auth.js` | 注入 `ctx.scope.requireOwn('client_user_id')`，路由调用此守卫强制 SQL 含 `AND client_user_id = $auth.userId` | P0-AUTH-03 |
| L3 staff routes | `staffApi/routes/auth.js:176` | bindPhone 前查 openid 是否已绑别人 | P1-OPENID-08 |
| L3 client routes | `clientApi/routes/auth.js:127` | bindPhone 加 idempotency_key | P1-PHONE-09 |
| L3 admin lib | `fengyu-admin/src/lib/permissions.ts` | 新增 `withPermission(action, fn)` HOF；逐步替换裸 `requirePermission()` | P0-AUTH-01 |
| L3 三端 ops 日志 | `lib/operation-log.ts` + staff/client 等价文件 | logOperation 内部 mask phone/openid/id_card | P0-PII-06 |
| L7 admin actions | `src/app/(main)/**/actions.ts` | 错误统一前缀 | P2-ERROR-12 |
| L9 spec | `.42cog/pm/backend.pr.spec.md` | 明确 bindStore 是否要求 phone | P2-BINDSTORE-11 |

---

## 8. 验证 SQL（5434/fengyu，仅 SELECT）

```sql
-- #1 v3.3 迁移完整性：operation_logs.operator_user_id 应已不存在或已置空
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'operation_logs'
  AND column_name IN ('operator_user_id', 'operator_employee_id');
-- 预期：仅 operator_employee_id；若 operator_user_id 仍存在，需排查写入路径

-- #2 跨表 openid 重叠（P0-SPLIT-04 验证）
WITH s AS (SELECT openid, employee_id FROM staff_wechat_users WHERE openid IS NOT NULL),
     c AS (SELECT openid, user_id     FROM client_wechat_users WHERE openid IS NOT NULL)
SELECT s.openid, s.employee_id, c.user_id
FROM s JOIN c USING (openid);
-- 预期：0 行

-- #3 permission_roles FK 完整性
SELECT pr.employee_id
FROM permission_roles pr
LEFT JOIN staff_wechat_users sw USING (employee_id)
WHERE sw.employee_id IS NULL;
-- 预期：0 行

-- #4 scope_id 是否都指向有效 org_node
SELECT pr.employee_id, pr.scope_id
FROM permission_roles pr
LEFT JOIN org_nodes o ON pr.scope_id = o.id
WHERE pr.scope_id IS NOT NULL AND o.id IS NULL;
-- 预期：0 行

-- #5 admin_passwords FK 完整性
SELECT ap.employee_id
FROM admin_passwords ap
LEFT JOIN staff_wechat_users sw USING (employee_id)
WHERE sw.employee_id IS NULL;
-- 预期：0 行

-- #6 phone 格式异常（P0-PHONE-05）
SELECT 'staff' AS src, employee_id, phone FROM staff_wechat_users
  WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{8}$'
UNION ALL
SELECT 'client', user_id::text, phone FROM client_wechat_users
  WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{8}$'
LIMIT 50;
-- 预期：0 行；若有则需清洗
```

---

## 9. 回归测试用例（建议）

1. **跨用户重放**（client）：用 A 的 OPENID 调 `order.detail({orderId: B 的订单 id})`，期望 `PERMISSION_DENIED:`。
2. **跨门店越权**（staff）：店员 A（绑定 store_X）调 `customer.search({storeId: store_Y})`，期望仅返回 store_X 的客户或 `PERMISSION_DENIED:`。
3. **Admin action 漏权限**：随机抽 5 个 action，断言入口第一行调用 `requirePermission` 或 `withPermission`。
4. **跨表 openid 冲突**：用员工 A 的 openid 注册 client，期望 `ROLE_CONFLICT:` 或 schema 约束阻断。
5. **手机号格式注入**：`bindPhone({phone: 'INVALID'})`，期望 `INVALID_PARAMS:`。
6. **OPENID 已绑他人重绑**（staff）：A 已绑 phone1，用 A 的 openid 尝试 `bindPhone(phone2)`，期望 `OPENID_CONFLICT:`。
7. **client bindPhone 重试**：首次成功后立即重放，期望 200 + 同 user_id（幂等）。
8. **token 过期**：admin 持过期 JWT 访问 server action，middleware 应 redirect login，**不进入 action**。

---

## 10. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（PII 已写入 operation_logs，需回填脱敏）
- 修复成本：**L**（涉及 schema 约束 + 三端 middleware 重构 + 历史数据迁移）

**P0 计数**：6（AUTH-01/02/03、SPLIT-04、PHONE-05、PII-06）
**P1 计数**：4（PERM-07、OPENID-08、PHONE-09、MODEL-10）
**P2 计数**：2（BINDSTORE-11、ERROR-12）

---

## 11. 后续待办

- [ ] 验证 SQL #1-#6 在生产 5434 上跑一遍，确认实际数据风险
- [ ] 与团队对齐 P0-SPLIT-04 的处理策略（DB 约束 vs 应用层）
- [ ] 制定 PII 历史数据脱敏迁移计划（影响 operation_logs 全部历史行）
- [ ] 域 04 (payNotify 幂等) 审计时复用本报告 §6 表的 #3（支付幂等）槽位
- [ ] 域 22 (权限矩阵) 审计时深入 admin PERMISSION_MATRIX 的 DB 化方案
