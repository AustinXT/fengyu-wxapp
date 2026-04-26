# 审计报告：认证 / 鉴权 / 双端用户表隔离 (01) — v3 合并版

**审计时间**：2026-04-26
**域 ID**：01
**审计员**：claude-sonnet-4-6
**审计时长**：~45 分钟（合并 v1 + v2 独立审计）
**关联 PR/Ticket**：—
**规范版本**：`real.md` v3.1.0 / `backend.pr.spec.md` v2.1.0 / `db/schema/enums.ts` (28 枚举)
**合并说明**：v1 (claude-opus-4-7) + v2 (claude-sonnet-4-6) → v3

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/user.ts` (client_wechat_users + staff_wechat_users) + `db/schema/admin-auth.ts` (admin_passwords) + `db/schema/permission.ts` (permission_roles) | 同上 | 同上 |
| Middleware | `fengyu-admin/src/middleware.ts:1-65` (JWT jwtVerify) | `staffApi/middleware/auth.js:99-137` (auth + guards) | `clientApi/middleware/auth.js:19-84` (auth + requirePhone) |
| Session/Auth | `fengyu-admin/src/actions/auth.ts:55-113` (getSessionFromCookie → JWT+DB) + `fengyu-admin/src/lib/permissions.ts` | `staffApi/utils/scope.js` (deriveStaffLevel / expandScopeStoreIds / buildStoreScopeCondition) | clientApi 无 scope helper |
| Login/Bind | `(auth)/login/page.tsx` + `actions/auth.ts` | `routes/auth.js:104-166` (login) + `:176-298` (bindPhone) | `routes/auth.js:15-72` (login) + `:81-167` (bindPhone) + `:201-290` (bindStore) + `:295-341` (updateProfile) |
| 测试 | `(auth)/login/login.test.tsx` | `__tests__/middleware/auth.test.js` | `__tests__/index.test.js` |
| 审计覆盖 | `admin/src/app/(main)/layout.tsx` (session guard) | `staffApi/index.js` (middleware chain) | `clientApi/index.js` (middleware chain + publicActions) |

**身份载体差异**：admin = JWT(HS256) httpOnly cookie `fy-admin-token` (24h)；staff/client = OPENID + 5min 内存缓存（AUTH_CACHE，200 上限，LRU 简版）。

---

## 2. v1 vs v2 评审摘要

v1 由 claude-opus-4-7 独立完成，着眼整体架构层面，识别出 6 个 P0（含 scope 非强制、PII 处理、跨表 openid、手机号校验）；v2 由 claude-sonnet-4-6 独立复核，精确定位到代码行，在 v1 基础上新发现 3 个 v1 未覆盖的 P0：`testOpenid` 无环境变量门禁（生产可被任意伪造员工身份）、JWT_SECRET 已知硬编码 fallback（可伪造 admin token）、admin 内存登录锁随部署重置（暴力破解窗口）。两版核心差异在于：v2 发现 staff/client 的 `_testOpenid` 对称性不对称（client 受 env 保护，staff 无门禁），以及 admin JWT 密钥缺乏生产强校验机制。v1 高估了手机号格式问题（P0→P1，DB UNIQUE 约束已提供基础防护），低估了 scope 强制覆盖率（`customer.search` phone 分支实际存在路径性漏过滤）。

---

## 3. P0 清单（按优先级；CLOSED 放最后）

### P0-01（最高优先）

#### **[P0-01]** `staffApi` `_testOpenid` 无环境变量保护，生产可被任意伪造员工身份
- **来源**：v2 独立发现（v1 未独立标出，混合在 P0-AUTH-02 中）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:103-104`
- **现象**：
  ```js
  // staffApi/middleware/auth.js:103-104
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  const effectiveOpenid = testOpenid || OPENID
  ```
  clientApi 的对等代码受 `process.env.ALLOW_TEST_OPENID === 'true'` 保护（`clientApi/middleware/auth.js:22-26`），staffApi **完全没有**此环境变量门禁。
- **风险**：任意调用方在 payload 中传入 `_testOpenid: 'known-employee-openid'`，即可任意员工身份（含店长）操作 staffApi 所有路由（开单、确认收款、退款审批、分配等），造成资损。real.md 第 5 条"后端统一鉴权"直接破损。
- **复现**：
  1. 调用 `staffApi({action:'auth.login'})` 获得任意已知员工的 openid
  2. 调用 `staffApi({action:'order.create', payload: { _testOpenid: 'emp-openid-xxx', ... }})`
  3. 验证订单以店长身份创建
- **修复**：(L3) `staffApi/middleware/auth.js:103` 前加环境变量门禁，与 clientApi 对称：
  ```js
  if (process.env.ALLOW_TEST_OPENID === 'true') {
    const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
    if (testOpenid) effectiveOpenid = testOpenid
  }
  ```

---

#### **[P0-02]** Admin JWT_SECRET 有已知硬编码 fallback，生产未设环境变量可伪造 token
- **来源**：v2 独立发现（v1 未提及）
- **文件**：`fengyu-admin/src/actions/auth.ts:16-17` + `fengyu-admin/src/middleware.ts:4-5` + `fengyu-admin/src/app/api/upload/route.ts:9`（三处共用同一 fallback）
- **现象**：
  ```ts
  // actions/auth.ts:16-17
  const JWT_SECRET = new TextEncoder().encode(
    process.env.JWT_SECRET || 'fengyu-admin-jwt-secret-dev-only'
  )
  ```
  若生产未设置 `JWT_SECRET`（或被误删），系统静默回退到公开已知字符串。
- **风险**：攻击者用此 fallback secret 签发任意 admin JWT，越权访问所有管理后台 Server Actions（退款审批、权限分配、员工管理等）。
- **修复**：(L3) 启动时强校验：
  ```ts
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET env var is required')
  const JWT_SECRET = new TextEncoder().encode(secret)
  ```
  部署文档 / `docker-compose.yml` 明确此变量为必填项。

---

#### **[P0-03]** `customer.search` phone 分支无门店 scope 过滤，任意员工可跨店读取顾客 PII
- **来源**：v2 独立发现，v1 P0-AUTH-02 部分涉及但未精确定位
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:36-43`
- **现象**：
  ```js
  // customer.js:36-43 (phone 分支)
  rows = await pg.query(
    `SELECT ... FROM client_wechat_users c
     LEFT JOIN stores s ON s.store_id = c.bound_store_id
     WHERE c.phone = $1 AND c.bound_store_id IS NOT NULL${typeFilter}`,
    [phone.trim()],   // ← 无 effectiveStoreId 过滤！
  )
  ```
  keyword 分支（line 50）有 `AND c.bound_store_id = $2`；phone 分支完全漏掉门店过滤。
- **风险**：任意员工（仅有本店权限）知道手机号后可读取任意门店顾客姓名、会员等级、绑定门店等信息（PII 泄露 + 越权跨店）。real.md 第 6 条"组织域数据隔离"破损。
- **修复**：(L3) phone 分支加门店 scope 过滤，使用 `buildStoreScopeCondition` 工具函数。

---

#### **[P0-04]** 跨表 OPENID 无全局唯一约束，员工可同时在 client_wechat_users 出现
- **来源**：v1 P0-SPLIT-04 = v2 P0-01-V2-03，高度一致
- **文件**：`db/schema/user.ts:80` (client UNIQUE INDEX) + `db/schema/user.ts:129` (staff UNIQUE INDEX) + `clientApi/routes/auth.js:33-45` (login INSERT)
- **现象**：两表各有表内 UNIQUE INDEX，但无跨表约束。`clientApi/routes/auth.js:login` 新用户路径直接 INSERT，不查询 `staff_wechat_users.openid`。
- **风险**：支付回调/同步脚本按 openid 路由身份时可能误入错表；payNotify 解锁后按 openid 找 client_user_id 可能走到错行；充值卡/积分被错误账户访问。
- **修复**：
  - (L3) `clientApi/routes/auth.js:login` INSERT 前查询 `staff_wechat_users WHERE openid=$1`，命中则拒绝
  - (L3) `staffApi/routes/auth.js:bindPhone` 对称查 `client_wechat_users WHERE openid=$1`
  - (L0 可选) 物化视图 + UNIQUE INDEX 实现跨表硬约束

---

#### **[P0-05]** Admin 内存登录锁状态在每次部署后重置，暴力破解窗口可被利用
- **来源**：v2 独立发现（v1 未提及）
- **文件**：`fengyu-admin/src/actions/auth.ts:23-50`
- **现象**：
  ```ts
  const loginAttempts = new Map<string, { count: number; lockedUntil: number }>()
  const MAX_ATTEMPTS = 5
  const LOCK_DURATION = 15 * 60 * 1000
  ```
  Map 在 Next.js 进程重启（部署、容器重建、OOM）后清零。
- **风险**：攻击者在部署间隙暴力破解（每次部署重置计数器），针对 admin 帐号可越权访问整个管理后台。
- **修复**：(L3) 登录失败计数持久化到 PG（`auth_login_attempts` 表）或 Redis。

---

### [CLOSED from v1] P0-AUTH-01（Admin Server Action 缺统一鉴权 wrapper）
- **来源**：v1 P0-AUTH-01
- **状态**：v3 合并审计时，v1 此条保留在 P0 清单；v2 未独立重评此项
- **说明**：v1 指出 admin 每个 Server Action 需显式调用 `requirePermission()`，无统一 wrapper。v2 在 `P2-01-V2-10` 中确认 `resetEmployeePassword` / `resetToDefaultPassword` 仍通过自检而非 `requirePermission()` 框架。风险仍然存在（未完全闭合），但 v2 将其降至 P2，说明核心问题已部分缓解（大多数 actions 已覆盖）。**建议：合并至 P2 待办，重新评估修复方案。**

---

### [降级说明] P0-PHONE-05（手机号格式校验）→ P1-01-V2-06
- **来源**：v1 P0-PHONE-05
- **降级原因**（v2 理由）：DB 层 phone 列有 UNIQUE INDEX 约束作为基础防线；v1 列为 P0 属高估危害性，实际风险为"异常号码入库后 WorkFine 同步可能误匹配"，属于数据一致性问题而非阻断/资损/越权。v2 将其降为 P1。
- **v3 采纳**：以 v2 为准，降为 P1。

---

## 4. P1 清单

#### **[P1-01]** 三端均未验证手机号格式，DB 无 CHECK 约束
- **来源**：v1 P0-PHONE-05（降级）= v2 P1-01-V2-06
- **文件**：`staffApi/routes/auth.js:192-201` + `clientApi/routes/auth.js:89-113` + `db/schema/user.ts:20,103`；admin 登录页 `page.tsx:27` 前端校验过宽 `/^1\d{10}$/`
- **现象**：bindPhone 依赖微信 CloudID 解密或直接 `phoneNumber` 入参，无 `/^1[3-9]\d{9}$/` 格式校验；DB phone 列无 CHECK 约束（仅 UNIQUE INDEX）；admin 前端正则允许 `10000000000` 等不合法号码。
- **修复**：(L0) schema 加 `CHECK (phone ~ '^1[3-9][0-9]{9}$')` + migration；(L3) 三端 bindPhone 入口前置校验；(L7) admin 前端正则改为 `/^1[3-9]\d{9}$/`。

#### **[P1-02]** 内存认证缓存与 `invalidateAuthCache` 覆盖范围不完整
- **来源**：v2 P1-01-V2-07（v1 未提及）
- **文件**：`staffApi/middleware/auth.js:21-125` + `clientApi/middleware/auth.js:11-84`
- **现象**：admin 端 `resetEmployeePassword` 不清 staff 缓存；admin 端调整 `permission_roles` 也不触发 staff 缓存失效。
- **风险**：员工被撤销权限后最多 5 分钟内仍可操作；手机解绑后 5 分钟内 `requirePhone()` 守卫仍可通过。
- **修复**：(L3) admin 端权限变更后通过 CloudBase SDK 或消息队列通知 staffApi 失效指定 openid 缓存；或接受 5 分钟延迟作为已知风险并文档化。

#### **[P1-03]** `client_wechat_users.customer_type` 与 `customer.search` 过滤逻辑不对齐
- **来源**：v2 P1-01-V2-08（v1 未提及）
- **文件**：`db/schema/user.ts:51` + `db/schema/enums.ts:116` + `staffApi/routes/customer.js`
- **现象**：`customer_type DEFAULT '流量客'`；`customer.search` 的 `customerType` 过滤传入 `'member'`/`'flow'` 对应 `customer_id IS NOT NULL/NULL`，不是 `customer_type` 枚举值。
- **风险**：前端筛选"会员客"与后端过滤逻辑可能产生展示不一致。
- **修复**：(L3) 明确 `customer.search.customerType` 参数语义，统一以 `customer_type` 枚举为基准。

#### **[P1-04]** `clientApi/routes/auth.js:bindPhone` 存在 TOCTOU 竞态，PG 错误泄露 DB 细节
- **来源**：v1 P1-PHONE-09 = v2 P1-01-V2-09，一致
- **文件**：`clientApi/routes/auth.js:135-142`
- **现象**：phone 检查（SELECT）与 UPDATE 之间无事务保护，并发时触发 PG 23505 UNIQUE 约束违反错误，error 信息含 `client_wechat_users_phone_key` 表名。
- **修复**：(L3) 检查和 UPDATE 包入事务，捕获 PG 23505 错误转为 `INVALID_PARAMS: 该手机号已被绑定`。

#### **[P1-05]** `staffApi` bindPhone 未前置检查 openid 是否已绑其他员工
- **来源**：v1 P1-OPENID-08，v2 未重新独立验证（但 P0-01-V2-03 修复建议中提及对称性检查）
- **文件**：`staffApi/routes/auth.js:176-250`
- **现象**：仅按 phone 查同步行，若 openid 已绑别的 employee 会触发 UNIQUE 冲突错误，返回不友好（但 v2 确认代码中已有 openid 预检步骤①）。
- **修复**：(L3) `staffApi/routes/auth.js:bindPhone` 第 206-214 行已实现 openid 预检，建议确认该逻辑已覆盖所有路径。

#### **[P1-06]** v3.3 后 `operation_logs.operator_user_id` 是否完全迁移到 `operator_employee_id` 待验证
- **来源**：v1 P1-MODEL-10，v2 CC9 中确认 `db/schema/operation-log.ts` 已完成迁移
- **文件**：`db/schema/operation-log.ts`
- **风险**：若有遗留写 `operator_user_id`，FK 链断裂。
- **修复**：见 §7 验证 SQL #6；若仍有残留路由，集中修复。**v2 CC9 已通过代码审查确认 schema 迁移完成，剩余动作仅为生产数据验证。**

---

## 5. P2 清单

#### **[P2-01]** `auth.ts` 中 `resetEmployeePassword` / `resetToDefaultPassword` 无 `requirePermission` 调用
- **来源**：v2 P2-01-V2-10（v1 未提及）
- **文件**：`fengyu-admin/src/actions/auth.ts:223-324`
- **现象**：两个函数通过 `session.roles.some(r => r.role === 'admin')` 自检权限，未使用统一的 `requirePermission()` 框架，无法被 grep/lint 覆盖。
- **修复**：(L7) 在 `PERMISSION_MATRIX.admin` 添加 `'auth:reset_password'` action，改用 `requirePermission(session, 'auth:reset_password')`。

#### **[P2-02]** Admin 登录页手机号格式校验过宽（`/^1\d{10}$/` vs `/^1[3-9]\d{9}$/`）
- **来源**：v2 P2-01-V2-11（v1 P2-ERROR-12 部分涉及 admin 不规范）
- **文件**：`fengyu-admin/src/app/(auth)/login/page.tsx:27`
- **现象**：`!/^1\d{10}$/.test(phone)` 允许 `10000000000` 等不合法号码通过前端校验。
- **修复**：(L9) 改为 `/^1[3-9]\d{9}$/`。

#### **[P2-03]** `sourceChannel` 写入 `customer_source` 枚举列无应用层校验，依赖 DB 报错
- **来源**：v2 P2-01-V2-12（v1 未提及）
- **文件**：`clientApi/routes/auth.js:241-243`
- **现象**：`bindStore` 直接将前端传入的 `sourceChannel` 作为 `customer_source` 枚举值写入，若值不合法则触发 PG 枚举约束错误，暴露错误细节。
- **修复**：(L3) 入参校验：`const VALID_SOURCES = ['美团','抖音','小程序',...]; if (!VALID_SOURCES.includes(sourceChannel)) throw 'INVALID_PARAMS'`。

#### **[P2-04]** Client `bindStore` 是否要求已 `bindPhone` 未文档化
- **来源**：v1 P2-BINDSTORE-11，v2 未重新独立验证
- **文件**：`clientApi/routes/auth.js:201-250`
- **现象**：spec 未明确，代码亦无 `requirePhone()` 守卫。
- **修复**：(L9) 在 `backend.pr.spec.md` 明确；(L3) 加 middleware 守卫。

#### **[P2-05]** Admin throw Error 不带前缀，与 staff/client 不一致
- **来源**：v1 P2-ERROR-12，v2 在 P1-01-V2-09 中确认 client bindPhone 竞态时仍暴露 PG 约束错误（无 INVALID_PARAMS 前缀）
- **文件**：`middleware.ts:54-57` + 各 actions
- **现象**：staff/client 用 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`；admin 多为裸 `throw new Error(msg)`。
- **修复**：(L7) admin 统一前缀；(L3) client bindPhone 竞态错误捕获转前缀。

---

## 6. 跨端不一致（表格）

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| `_testOpenid` 门禁 | N/A（无 testOpenid）| **无 env guard，任意启用** | 受 `ALLOW_TEST_OPENID` 保护 | 员工端越权冒充 | P0 |
| JWT_SECRET fallback | `'fengyu-admin-jwt-secret-dev-only'`（已知字符串）| N/A | N/A | token 伪造 | P0 |
| 登录失败锁 | **内存锁（重启清零）** | N/A | N/A | 暴力破解 | P0 |
| 跨表 openid 唯一性 | — | 表内 UNIQUE，**无跨表约束** | 表内 UNIQUE，**无跨表约束** | 身份混乱/支付路由错误 | P0 |
| Scope 过滤覆盖 | `scopeCondition()` 全 actions 套 | `effectiveStoreId` 大多路由使用；phone 搜索**缺失** | 无 scope helper，依赖业务层 userId 隔离 | customer.search phone 路径跨店泄露 | P0 |
| 手机号格式校验 | 前端 `/^1\d{10}$/`（过宽），后端无校验 | 无格式校验 | 无格式校验 | 异常号码入库/WorkFine 误匹配 | P1 |
| auth 缓存失效 | 权限变更**不通知** staff/client 缓存 | 5min TTL | 5min TTL | 权限撤销延迟生效 | P1 |
| 错误前缀规范 | 无规范前缀 | 4 种前缀规范 | 4 种前缀规范，race condition 时暴露 PG 错误 | 不一致/错误信息泄露 | P1/P2 |
| 权限来源 | PERMISSION_MATRIX 代码常量 | permission_roles 表 | 无 roles | admin 调权限需发版 | P1 |
| Session 缓存 | 无（每次查 DB） | AUTH_CACHE 5min/200 | AUTH_CACHE 5min/200 | 合理 | — |
| PII 处理 | 无脱敏 | 无脱敏 | 无脱敏 | 三端一致缺陷 | P2 |

---

## 7. 横切检查（CC1-CC9）

| CC | 域 | 命中 | 简述 |
|----|----|------|------|
| CC1 数值精度 | — | 与本域无关 | — |
| CC2 并发幂等 | ⚠️ P1 | client bindPhone 无 advisory lock（P1-04）；staff bindPhone 事务内有 advisory lock ✓ | P1-04 |
| **CC3** 组织域隔离 | 🔴 P0 | `customer.search` phone 分支无 scope filter（P0-03）；client 端无 scope helper，依赖业务层 userId ✓ | P0-03 |
| **CC4** 后端鉴权 | 🔴 P0 | staffApi testOpenid 无门禁（P0-01）；JWT_SECRET fallback（P0-02）| P0-01, P0-02 |
| CC5 错误码前缀 | ⚠️ P1 | client bindPhone race condition 时 PG 约束错误无 INVALID_PARAMS 前缀（P1-04）；sourceChannel 枚举错误暴露 DB 细节（P2-03）| P1-04, P2-03 |
| CC6 PII | ⚠️ P2 | 三端 auth 路由均无直接日志 PII；`customer.search` 已对非店长手机号脱敏 ✓；但整体 PII 处理缺失 | P2 |
| CC7 时间字段 | ✅ | last_login_at 由应用层写入；created_at/updated_at DB DEFAULT ✓ | — |
| CC8 WXML/Vant | — | 与本域无关 | — |
| CC9 测试与残留 | ✅ | `operator_user_id` → `operator_employee_id` 迁移已确认完成 ✓（v2 CC9）；session_key 列冗余但无害 | P1-06 |

---

## 8. real.md 7 条硬约束符合性

| # | 约束 | admin | staff | client | 总体 |
|---|------|-------|-------|--------|------|
| 1 | 次数防超卖 | — | — | — | 与本域无关 |
| 2 | 价格快照不可变 | — | — | — | 与本域无关 |
| 3 | 支付幂等 | — | — | — | 留待域 04 |
| 4 | 状态单向推进 | — | — | — | 与本域无关 |
| **5** | **后端统一鉴权** | ⚠️ JWT_SECRET fallback | ❌ testOpenid 无门禁（P0-01）；P0-AUTH-01 未完全闭合 | ✅ ALLOW_TEST_OPENID 保护 | 🔴 **不符（staff P0）** |
| **6** | **组织域数据隔离** | ✅ scopeCondition 全覆盖 | ⚠️ customer.search phone 路径漏过滤（P0-03）| ✅ userId 隔离 | 🟡 **部分（staff P0）** |
| 7 | 待支付订单唯一 | — | — | — | 留待域 02 |

---

## 9. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联 |
|----|------|------|------|
| L0 schema | `db/schema/user.ts` | 两表 phone 列加 `CHECK (phone ~ '^1[3-9][0-9]{9}$')` + migration | P1-01 |
| L0 schema | `db/schema/user.ts` | 跨表 openid 唯一性（物化视图 + UNIQUE INDEX，可选） | P0-04 |
| L0 helpers | `db/helpers/phone.ts`（新增） | `validatePhone(s)` / `mask(s)` / `maskOpenid(s)` / `maskIdCard(s)` | P1-01, P2 |
| L3 staff middleware | `staffApi/middleware/auth.js:103` | 添加 `if (process.env.ALLOW_TEST_OPENID === 'true')` 环境变量门禁（**最高优先，热修复**） | **P0-01** |
| L3 admin auth | `fengyu-admin/src/actions/auth.ts:16-17` | JWT_SECRET 无 fallback，启动时 throw if missing | **P0-02** |
| L3 admin auth | `fengyu-admin/src/actions/auth.ts:23-50` | loginAttempts 持久化到 PG 或 Redis | **P0-05** |
| L3 client auth | `clientApi/routes/auth.js:login` INSERT 前 | SELECT staff_wechat_users WHERE openid=$1，命中拒绝 | **P0-04** |
| L3 staff auth | `staffApi/routes/auth.js:bindPhone` | SELECT client_wechat_users WHERE openid=$1，命中拒绝（对称性检查） | **P0-04** |
| L3 staff customer | `staffApi/routes/customer.js:36-43` | phone 搜索路径加门店 scope 过滤 | **P0-03** |
| L3 client auth | `clientApi/routes/auth.js:135-145` | bindPhone phone 检查与 UPDATE 包入事务，捕获 23505 转 INVALID_PARAMS | P1-04 |
| L3 client auth | `clientApi/routes/auth.js:241-243` | sourceChannel 枚举值校验 | P2-03 |
| L7 admin actions | `fengyu-admin/src/actions/auth.ts:223,271` | 改用 `requirePermission(session, 'auth:reset_password')` | P2-01 |
| L7 admin actions | `src/app/(main)/**/actions.ts` | 错误统一前缀 | P2-05 |
| L9 admin 前端 | `(auth)/login/page.tsx:27` | 正则改为 `/^1[3-9]\d{9}$/` | P2-02 |
| L9 文档 | 部署文档 / docker-compose | 明确 `JWT_SECRET` / `ALLOW_TEST_OPENID` 环境变量配置 | P0-01, P0-02 |
| L9 spec | `backend.pr.spec.md` | 明确 bindStore 是否要求 phone | P2-04 |

---

## 10. 验证 SQL（5434/fengyu，仅 SELECT / EXPLAIN，禁止写入）

```sql
-- #1 跨表 openid 重叠验证（P0-04）
WITH s AS (SELECT openid, employee_id FROM staff_wechat_users WHERE openid IS NOT NULL),
     c AS (SELECT openid, user_id     FROM client_wechat_users  WHERE openid IS NOT NULL)
SELECT s.openid, s.employee_id, c.user_id
FROM s JOIN c USING (openid);
-- 预期：0 行；若有则为高危身份混乱

-- #2 phone 格式异常（P1-01）
SELECT 'staff' AS src, employee_id, phone
  FROM staff_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{9}$'
UNION ALL
SELECT 'client', user_id, phone
  FROM client_wechat_users WHERE phone IS NOT NULL AND phone !~ '^1[3-9][0-9]{9}$'
LIMIT 50;
-- 预期：0 行；若有则需清洗

-- #3 permission_roles FK 完整性
SELECT pr.id, pr.employee_id
FROM permission_roles pr
LEFT JOIN staff_wechat_users sw USING (employee_id)
WHERE sw.employee_id IS NULL;
-- 预期：0 行

-- #4 scope_id 有效性
SELECT pr.id, pr.employee_id, pr.scope_id
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

-- #6 operation_logs.operator_user_id 列是否仍存在（P1-06）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'operation_logs'
  AND column_name = 'operator_user_id';
-- 预期：0 行（v3.3 已迁移）

-- #7 生产环境 JWT_SECRET 设置确认（仅在 admin 容器内）
-- echo $JWT_SECRET | wc -c （> 32 bytes 为合格）
```

---

## 11. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☑（P0-01 testOpenid 跨端越权，P0-04 跨表身份混乱，P0-02 admin token 伪造影响全后台）
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（phone 格式异常数据可能已存在；operation_logs 历史 PII 待回填脱敏）
- 修复成本：**L**（涉及 schema CHECK 约束 + staffApi/clientApi middleware + admin JWT 重构 + 可选跨表唯一约束）

**v3 P0 计数**：5（活跃）+ 1（待重新评估降级）+ 1（降级）= **7 项原始 → 5 活跃 P0**

| ID | 状态 | 说明 |
|----|------|------|
| P0-01（testOpenid 无门禁）| 活跃 | **最高优先，热修复** |
| P0-02（JWT_SECRET fallback）| 活跃 | 生产必填项 |
| P0-03（customer.search phone 漏 scope）| 活跃 | 精确定位代码行 |
| P0-04（跨表 openid）| 活跃 | 两版一致确认 |
| P0-05（内存锁重置）| 活跃 | v2 新发现 |
| P0-AUTH-01（Admin wrapper）| 待降级→P2 | v2 已将其降至 P2-01-V2-10，建议合并处理 |
| P0-PHONE-05（phone 格式）| 降级→P1 | 以 v2 为准（P1-01） |

**P1 计数**：6（P1-01~P1-06）
**P2 计数**：5（P2-01~P2-05）

---

## 12. 后续待办

- [ ] **P0-01 热修复**：staffApi 中间件添加 `ALLOW_TEST_OPENID` env 门禁（可零停机部署）
- [ ] **P0-02 修复**：admin JWT_SECRET 启动强校验 + 部署文档明确必填项
- [ ] 验证 SQL #1-#7 在生产 5434 上执行，确认实际数据风险
- [ ] 部署文档明确 `JWT_SECRET` / `ALLOW_TEST_OPENID` 环境变量配置
- [ ] 与团队确认 P0-04 跨表 openid 冲突的处理策略（应用层 vs DB 约束）
- [ ] P0-05 登录锁持久化方案评估（与 payNotify 解锁并行排期）
- [ ] P0-03 `customer.search` phone 路径 scope 过滤修复
- [ ] 制定 PII 历史数据脱敏迁移计划（影响 operation_logs 全部历史行）
- [ ] 域 04（payNotify 幂等）审计时复用本报告 §8 表的 #3（支付幂等）槽位
- [ ] 域 22（权限矩阵）审计时深入 admin PERMISSION_MATRIX 的 DB 化方案
- [ ] P0-AUTH-01 正式降级为 P2，与 P2-01-V2-10 合并处理
