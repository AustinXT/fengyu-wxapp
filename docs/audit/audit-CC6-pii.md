# 审计报告：CC6 PII / 敏感数据（合并终版）

**审计时间**：2026-04-25 ~ 2026-04-26
**域 ID**：CC6（横切）
**审计员**：claude-opus-4-7（v1）+ claude（v2 重审）
**版本**：v1+v2 合并终版，基于 dev 分支最新代码快照
**覆盖模块**：staffApi（15 路由 + 入口）+ clientApi（13 路由 + 入口）+ payNotify + admin（18 actions + ~30 页面组件）

---

## 1. 扫描覆盖范围

| 端 | 扫描路径 | 文件数 |
|----|---------|--------|
| staffApi 路由 | `fengyu-staff/cloudfunctions/staffApi/routes/*.js` | 15 个 |
| staffApi 入口 | `fengyu-staff/cloudfunctions/staffApi/index.js` | 1 个 |
| clientApi 路由 | `fengyu-client/cloudfunctions/clientApi/routes/*.js` | 13 个 |
| clientApi 入口 | `fengyu-client/cloudfunctions/clientApi/index.js` | 1 个 |
| payNotify | `fengyu-client/cloudfunctions/payNotify/index.js` + `points.js` | 2 个 |
| admin actions | `fengyu-admin/src/actions/*.ts` | 18 个 |
| admin pages | `fengyu-admin/src/app/(main)/*/` | ~30 个组件 |
| 脱敏 helper | `clientApi/utils/mask.js`、`staffApi/routes/customer.js:496`、`staffApi/routes/mgmt-customer.js:105` | 3 份副本 |

**新增覆盖（v1 未覆盖）**：`mgmt-traffic.js`、`mgmt-product.js`、`mgmt-customer.js`、`mgmt-dashboard.js`（staffApi）；`card.js`（clientApi 和 staffApi）；payNotify 新增 `PAYNOTIFY_DISABLED` 守卫。

---

## 2. PII 字段清单

| 字段 | 表来源 | 分类 | 出现在端 |
|------|--------|------|---------|
| `phone` | `client_wechat_users.phone`、`staff_wechat_users.phone`、`sale_orders.client_phone` | 手机号（11位） | admin/staff/client |
| `id_card` | `staff_wechat_users.id_card` | 身份证号（18位） | admin |
| `openid` | `client_wechat_users.openid`、`staff_wechat_users.openid` | 微信 OPENID | admin（序列化到前端）、staffApi bindPhone 内部查询 |
| `name` | 多表 | 真实姓名 | admin/staff/client（业务必要，低风险） |
| `birthday` | `staff_wechat_users.birthday` | 出生日期 | admin |

---

## 3. 检查清单结果

### 3.1 日志不包含完整手机号

**[CC6-CK-01]** `console.log`/`console.error` 含 `phone/mobile` ⚠️

- `staffApi/index.js:165` — `console.error(`[${action}] Error:`, error)` — `error` 可携带 PG `23505` 约束错误原文：`duplicate key value violates unique constraint "uq_xxx" Key (phone)=(13812345678) already exists.`；**当前 staffApi/clientApi 路由层均无 23505 专项捕获**，手机号必然进日志
- `clientApi/index.js:117` — 同款问题
- `staffApi/routes/order.js:740` — `console.error('[order.qrcode] 生成小程序码失败:', err)` — err 为微信 SDK 错误，**不含 PII**，✅
- `staffApi/routes/order.js:1041/1043` — `console.log('[staffApi/share-gift] granted/skipped', sgRes)` — sgRes 结构不含手机号，✅
- `clientApi/routes/store.js:249` — `console.error('[geocode] LBS API error:', JSON.stringify(json))` — 腾讯地图返回不含用户 PII，✅
- `payNotify/index.js:113` — `console.log('[payNotify] received event:', JSON.stringify(event))` — 当前 `PAYNOTIFY_DISABLED = true`，该行**不可达（死代码）**；但守卫一旦移除则全量 dump event（含 payer.openid），⚠️ 潜在

**结论**：⚠️ 三端全局 catch 打印 `error` 对象（含潜在 PG 原始错误消息），手机号明确进日志

### 3.2 日志不包含身份证号

**[CC6-CK-02]** ✅ 全仓无 `console.log`/`console.error` 直接打印 `id_card`/`idCard` 变量

### 3.3 日志不包含 openid

**[CC6-CK-03]** ⚠️ `staffApi/index.js:165`/`clientApi/index.js:117` 打印完整 `error` 对象；`ctx.auth` 含 `openid`，若业务层抛出携带 auth 信息的 Error，则 openid 可进入日志

### 3.4 错误信息不泄露 SQL / 表结构

**[CC6-CK-04]** ❌ 多处问题：

- **staffApi/clientApi routes**：无 `23505` 专项 catch，PG 原始错误（含字段值）经全局捕获后 `console.error` 打入 CloudBase 日志；返回给前端的 `displayMessage` 经前缀过滤，无已知前缀的 PG 错误 → `'服务器内部错误'`（✅ 正确），但日志已泄露
- **payNotify/index.js:578** — `return { code: 'FAIL', message: err.message }` — 直接透传 err.message（当前守卫关闭，死代码）
- **payNotify/points.js:88** — `JSON.stringify({ error: err.message, triggerSource })` 写入 `operation_logs.detail`（err.message 可含 PG 原文）
- **admin/actions/orders.ts:1202/1205** — return `err.message` 在业务错误字符串 match 后直接返回 —— 这些字符串由业务层 `throw new Error(...)` 控制，不含 SQL
- **admin/actions/orders.ts:2065** — return `err.message || '生成小程序码失败'` — 微信 API 错误原文，不含 PII

### 3.5 admin 列表展示遵循脱敏规则

**[CC6-CK-05]** ❌ admin 前端 `formatPhone()` 覆盖率 37%（7/19 命中点）：

已脱敏（✅）：
- `customers-page.tsx:157` — `formatPhone(row.phone)`
- `card-transactions-page.tsx:137` — `formatPhone(row.customerPhone)`
- `pickup-records-page.tsx:129/273` — `formatPhone(row.clientPhone)` × 2
- `cards-page.tsx:121` — `formatPhone(row.clientPhone)`
- `points-page.tsx:115` — `formatPhone(row.customerPhone)`
- `employees-page.tsx:81` — `formatPhone(row.phone)`

未脱敏（❌）共 12 处：
- `pickup-record-create-page.tsx:176` — `{customer.phone}` 明文（选人确认界面）
- `customers/[id]/customer-detail-page.tsx:469` — `{customer.phone ?? ""}` 明文（详情 Input disabled，编辑功能需要）
- `customers/[id]/customer-detail-page.tsx:550` — `{emp.name}{emp.phone ? ` (${emp.phone})` : ""}` 明文（促销员下拉列表）
- `messages-page.tsx:703` — `{c.phone || '—'}` 明文（批量发送顾客选择列表）
- `store-unbind-page.tsx:116/183` — `{req.customerPhone || "-"}` 明文 × 2
- `stores-page.tsx:255` — `{r.customerPhone ?? "—"}` 明文（门店顾客列表）
- `refunds/[id]/page.tsx:83` — `{refund.clientPhone || '-'}` 明文
- `orders/order-create-page.tsx:507/541` — `{c.phone}` / `{selectedCustomer.phone}` 明文 × 2
- `services/service-create-page.tsx:235` — `{selectedCustomer.phone}` 明文
- `employees/[id]/employee-detail-page.tsx:527` — `{employee.phone ?? "未绑定"}` 明文（详情 Info 文字）
- `coupons/coupon-detail-page.tsx:916/947` — `{c.phone || "—"}` / `{e.phone}` 明文 × 2

### 3.6 SELECT 返回不必要的敏感字段

**[CC6-CK-06]** ⚠️ 多处问题：

- **admin `customers.ts:39`**：`serializeCustomer()` 将 `openid` 序列化进 `Customer` 对象，通过 Server Component props 传递至前端 JSON（Network tab 可见）；当前无页面直接渲染，但字段存在
- **admin `employees.ts:27`**：`openid` 同样序列化进 `Employee` 对象，传递至 `employee-detail-page.tsx`（用于条件显示 Badge）；openid 仍在 JSON payload 中
- **staffApi `auth.js:219`**：`SELECT u.employee_id, u.openid, ...` 仅内部使用 `emp.openid` 进行换绑判断，**不写入 ctx.result**，✅
- **staffApi `order.list`**：返回 `o.client_phone` 原文（见 [CC6-09]），⚠️ 需确认员工角色过滤
- **clientApi `auth.js:63`**：返回 `users[0].phone` 给顾客自己（自查，✅ 合规）

---

## 4. 发现的问题（P0/P1/P2 分级）

### P0（高危）

#### [CC6-P0-01] id_card 全仓零加密，schema 注释"AES-256-GCM"与实现脱节
- **文件**：`db/schema/user.ts:108-109`（注释声明 AES）、`fengyu-admin/src/actions/employees.ts:323`（直接写 plaintext）、`employee-detail-page.tsx:316`（编辑态明文回显）
- **现状**：`grep -r "crypto\|AES\|encrypt\|decrypt"` 全仓零与 `idCard` 关联的加解密调用
- **风险**：PIPL 合规红线；DB 导出即全量身份证明文泄露
- **状态**：v1 已记 [CC6-01]，**代码无变化，仍未修复**

#### [CC6-P0-02] 三端全局 catch console.error 打印 error 对象，可携带 PG 原始错误消息（含手机号明文）
- **文件**：
  - `staffApi/index.js:165` — `console.error(`[${action}] Error:`, error)`
  - `clientApi/index.js:117` — 同款
- **现状**：staffApi/clientApi 路由层无 `error.code === '23505'` 专项捕获；PG 约束错误格式为 `Key (phone)=(13812345678) already exists.`，完整打入 CloudBase 日志
- **风险**：手机号明文进日志，CloudBase 控制台同账号可读；`23505` 在 phone 唯一约束冲突时必然触发
- **状态**：v1 已记 [CC6-02]，**代码无变化，仍未修复**

#### [CC6-P0-03] operation_logs.detail 写入 PII 明文
- **文件**：
  - `admin/src/actions/customers.ts:541` — `logOperation(..., { name, phone: data.phone })` — phone 明文写 detail
  - `admin/src/lib/operation-log.ts:90-93` — `logUpdate` 的 `changes` diff：若更新 phone/idCard，before/after 明文入 detail
  - `payNotify/points.js:88` — `JSON.stringify({ error: err.message, ... })` 写 detail（err.message 可含 PG 原文）
- **风险**：operation_logs 出口（导出/备份）复制 PII；finance/hr 若获日志权限即可读手机号/身份证
- **状态**：v1 已记 [CC6-03]，**代码无变化，仍未修复**

#### [CC6-P0-04] admin 前端 phone 直显（formatPhone 覆盖率 37%）
- **文件**：见 §3.5 — 12 处页面原文展示 phone
- **风险**：admin 角色（finance/hr）通过 store-unbind、messages 批量、refund、coupon 等页面获取顾客/员工全量手机
- **状态**：v1 已记 [CC6-04]，**代码无变化，仍未修复**

### P1（中危）

#### [CC6-P1-05] clientApi mask.js 存在但无任何路由 require（死代码）**[v2 新发现]**
- **文件**：`fengyu-client/cloudfunctions/clientApi/utils/mask.js`
- **现状**：grep 全 clientApi routes — 零处 `require('../utils/mask')`；client 端 phone 只返回给用户自己，风险较低，但该文件维护者易误以为已生效
- **状态**：v2 新增

#### [CC6-P1-06] 三份 maskPhone 副本实现不一致
- **文件**：
  - `staffApi/routes/customer.js:496` — 三档 `≤4 / ≤7 / other`
  - `staffApi/routes/mgmt-customer.js:105` — 与 customer.js 实现相同（copy-paste）
  - `clientApi/utils/mask.js:10` — `slice(0,3) + '****' + slice(-4)`（无三档逻辑）
  - `admin/src/lib/utils.ts:14 formatPhone()` — `length !== 11` 时返回原文
- **风险**：admin `formatPhone` 对非 11 位 phone 不脱敏；跨端测试断言结果不一致
- **状态**：v1 已记 [CC6-05]，**代码无变化，仍未修复**

#### [CC6-P1-07] admin Customer 和 Employee 序列化包含 openid 字段，无必要暴露给前端 **[v2 新发现]**
- **文件**：`admin/src/actions/customers.ts:39`、`admin/src/actions/employees.ts:27`
- **现状**：`openid` 出现在 Server Component → Client Component props JSON 中，浏览器 Network tab 可见
- **风险**：openid 是微信生态的长期稳定标识符，泄露可用于用户关联追踪
- **状态**：v2 新增

#### [CC6-P1-08] payNotify 守卫关闭后 console.log(JSON.stringify(event)) 仍为原始代码 **[v2 新发现]**
- **文件**：`payNotify/index.js:113`
- **现状**：`PAYNOTIFY_DISABLED = true`，line 113 当前不可达（✅）；但代码仍在，拉卡拉对接后若 guard 移除，event 含 payer.openid 全量 dump
- **缓解**：`PAYNOTIFY_DISABLED = true` 有效阻止了当前风险；但代码残留形成后续开发陷阱
- **状态**：v2 新增

### P2（低危）

#### [CC6-P2-09] staffApi order.list 返回 client_phone 原文给所有可调 list 的员工（含非 manager）**[v2 新发现]**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1207/1229`
- **现状**：list 接口在 detail 级做了 `!roles.includes('manager') && preferred_employee_id !== staffWfId` 的过滤保护；但 list 接口本身未过滤 `client_phone`，返回的 `orders` 数组含每条订单的 `client_phone`
- **影响**：店内非 manager 员工若绕过微信端直接调用 list，可见非自己订单的顾客手机
- **实际风险**：CloudBase 无 API 密钥概念，调用需微信登录，攻击面较低；但 list 不应返回 manager 专属字段
- **状态**：v2 新增

#### [CC6-P2-10] logs-page.tsx 对 operation_logs.detail 直接 JSON.stringify 渲染
- **文件**：`fengyu-admin/src/app/(main)/logs/_components/logs-page.tsx:100/222`
- **现状**：`detail` 含 `phone/idCard` 明文（见 [CC6-P0-03]），前端 `JSON.stringify(detail, null, 2)` 展示给 admin 角色
- **状态**：v1 已记 [CC6-09]，**代码无变化**

#### [CC6-P2-11] employee-detail 编辑态 id_card 明文回显（只读态已脱敏）
- **文件**：`employee-detail-page.tsx:314-316` — `isEditing` 时 `value={form.idCard}`（明文）；非 isEditing 时 `maskIdCard(employee.idCard)`（✅）
- **现状**：编辑时明文展示是功能需要（让用户核对后修改），属于可接受的设计取舍，但需确保同一 session 下只有 admin/hr 角色能进入编辑态

---

## 5. 新增模块扫描结论（v2 覆盖，v1 未涉及）

- `mgmt-traffic.js` — 无 PII 字段（聚合统计，不返回个人数据），✅
- `mgmt-product.js` — 无 PII 字段，✅
- `mgmt-customer.js` — 新增 `isMgmtFullPhone()` 函数（总部/市场层返回明文，门店层脱敏），设计合理；maskPhone 副本仍是问题（[CC6-P1-06]）
- `mgmt-dashboard.js` — 无 PII 字段，✅
- `staffApi/card.js` — `SELECT phone` 仅用于内部快照写入 sale_orders，不写入 ctx.result，✅
- `clientApi/card.js` — list/balance/history 均不返回 phone/openid/id_card，✅

---

## 6. 修复建议（按 L0→L10 传播层）

### 优先级 L0（全局 helper）

```
新建 db/helpers/pii.ts（或 pii.js 供云函数用）：
- maskPhone(s): string      → 统一三档逻辑
- maskOpenid(s): string     → 前 6 位 + *** + 后 4 位
- maskIdCard(s): string     → 前 4 位 + **** + 后 4 位
- safeStringify(obj, keys)  → 递归替换敏感 key 后 JSON.stringify
- pgErrorToBusiness(err)    → 23505 → "字段重复" | 23503 → "关联不存在" | else → "操作失败"
- encryptIdCard / decryptIdCard（AES-256-GCM，密钥 PII_AES_KEY env）
```

### 优先级 L3（云函数入口）

| 文件 | 修改 |
|------|------|
| `staffApi/index.js:165` | `console.error` 改为 `safeStringify(error)`；catch 块最前添加 `const pgBiz = pgErrorToBusiness(error); if (pgBiz) throw pgBiz` |
| `clientApi/index.js:117` | 同上 |
| `payNotify/index.js:113` | 改为白名单：`console.log('[payNotify] received event:', JSON.stringify({ orderNo: event.orderNo, keys: Object.keys(event) }))` |
| `payNotify/points.js:88` | `err.message` 写入前做 regex mask `\d{11}` |

### 优先级 L4（admin lib）

| 文件 | 修改 |
|------|------|
| `admin/src/lib/operation-log.ts` | `logOperation` 写入前对 detail 的 `phone/id_card/idCard/openid` 字段执行 maskPhone/maskIdCard/maskOpenid；`logUpdate` 同样；并新增 `_v: 3` 标记已脱敏 |
| `admin/src/actions/customers.ts:39` | 从 `serializeCustomer` 返回值移除 `openid` 字段（页面无需） |
| `admin/src/actions/employees.ts:27` | 从 serialize 返回值移除 `openid` 字段，仅保留 `hasOpenid: !!e.openid` 布尔值 |

### 优先级 L7（admin pages）

| 文件 | 行号 | 修改 |
|------|------|------|
| `pickup-record-create-page.tsx` | 176 | `{formatPhone(customer.phone)}` |
| `customer-detail-page.tsx` | 550 | `{emp.name}{emp.phone ? ` (${formatPhone(emp.phone)})` : ""}` |
| `messages-page.tsx` | 703 | `{formatPhone(c.phone) || '—'}` |
| `store-unbind-page.tsx` | 116/183 | `{formatPhone(req.customerPhone) || "-"}` |
| `stores-page.tsx` | 255 | `{formatPhone(r.customerPhone) ?? "—"}` |
| `refunds/[id]/page.tsx` | 83 | `{formatPhone(refund.clientPhone) || '-'}` |
| `orders/order-create-page.tsx` | 507/541 | `{formatPhone(c.phone)}` / `{formatPhone(selectedCustomer.phone)}` |
| `services/service-create-page.tsx` | 235 | `{formatPhone(selectedCustomer.phone)}` |
| `employees/[id]/employee-detail-page.tsx` | 527 | `{formatPhone(employee.phone) ?? "未绑定"}` |
| `coupons/coupon-detail-page.tsx` | 916/947 | `{formatPhone(c.phone) || "—"}` / `{formatPhone(e.phone)}` |

**注**：`customer-detail-page.tsx:469` — `{customer.phone ?? ""}` 作为 Input 编辑框 defaultValue，是编辑功能所需，保持明文（仅 admin/manager/customer_mgr 角色可见且有编辑权）

### 优先级 L9（一次性）

| 任务 | 说明 |
|------|------|
| `operation_logs` 历史回填 | `UPDATE operation_logs SET detail = jsonb_replace_phone(detail) WHERE ...`（regex 替换 11 位手机） |
| `id_card` 历史加密迁移 | 脚本 + dry-run；需 `PII_AES_KEY` 环境变量 |
| clientApi/utils/mask.js | 删除死文件，或改为 require 至 pii.js |
| staffApi routes 中 maskPhone 两份副本 | 替换为 `require('../utils/pii').maskPhone` |

---

## 7. 验证 SQL（只读，在 5434 执行）

```sql
-- A. operation_logs.detail 含手机号扫描
SELECT id, action, target_type, created_at,
  CASE
    WHEN detail::text ~ '"phone":"1[3-9][0-9]{9}"' THEN 'phone'
    WHEN detail::text ~ '\d{18}' THEN 'id_card'
    WHEN detail::text ~ '"openid":"o[A-Za-z0-9_-]{20,}"' THEN 'openid'
  END AS pii_kind
FROM operation_logs
WHERE detail::text ~ '"phone":"1[3-9][0-9]{9}"|"id_card":|"openid":"o[A-Za-z0-9_-]'
ORDER BY created_at DESC LIMIT 50;

-- B. staff_wechat_users id_card 是否明文
SELECT employee_id, name,
  LENGTH(id_card) AS len,
  CASE WHEN id_card ~ '^\d{17}[\dXx]$' THEN 'plaintext' ELSE 'maybe-encrypted' END
FROM staff_wechat_users WHERE id_card IS NOT NULL LIMIT 20;

-- C. sale_orders client_phone 非 manager 员工可查条数
SELECT COUNT(*) FROM sale_orders WHERE client_phone IS NOT NULL;
```

---

## 8. 影响半径

- **全栈（admin + staffApi + clientApi + payNotify + DB）**：☑
- **历史数据**：☑（operation_logs 回填 + id_card 加密迁移）
- **修复成本**：**L**（建议拆 3 个 PR）
  1. PR-A：`pii.ts` helper + staffApi/clientApi index.js catch 改造 + payNotify line 113 白名单
  2. PR-B：admin `serializeCustomer`/`serializeEmployee` 移除 openid + 12 处 admin 页面 formatPhone
  3. PR-C：operation_logs 写入脱敏 + id_card 加密实现 + 一次性历史回填

---

## 9. 审计总结

| 检查项 | 结论 |
|--------|------|
| 日志不含手机号 | ❌ 三端全局 error 对象打印含 PG 原始消息（含手机号） |
| 日志不含 id_card | ✅ 日志层无直接 id_card 打印 |
| 日志不含 openid | ⚠️ 全局 error 对象打印含隐性风险 |
| catch 块不泄露 SQL | ⚠️ 返回给前端已过滤 ✅，但日志层仍泄露 |
| admin 列表脱敏 | ❌ 37% 覆盖率（12 处未脱敏） |
| SELECT 不返回多余敏感字段 | ⚠️ admin Customer/Employee JSON 含 openid（P1） |
| id_card 加密存储 | ❌ 全仓零实现，注释与代码不符 |

**P0**：4 项（CC6-P0-01/02/03/04），全部为 v1 已记未修复项
**P1 新增**：3 项（CC6-P1-05/07/08，v2 新发现 CC6-P1-06 继承自 v1）
**P2**：3 项（CC6-P2-09/10/11，v2 新发现 CC6-P2-09）

---

## 10. 后续待办

- [ ] 新建 `db/helpers/pii.ts`（覆盖 CC6-P0-01/02/03 + CC6-P1-05/06）
- [ ] operation_logs detail 脱敏 [CC6-P0-03] 与历史回填一并 PR
- [ ] admin `serializeCustomer`/`serializeEmployee` 移除 openid [CC6-P1-07]
- [ ] payNotify line 113 改白名单日志 [CC6-P1-08]
- [ ] staffApi order.list client_phone 角色过滤 [CC6-P2-09]
- [ ] 推动 SUMMARY.md 把 CC6 Top 4 P0 纳入修复 roadmap
- [ ] 运营侧明确 PERMISSION_MATRIX 哪些角色可看 phone/idCard 明文
