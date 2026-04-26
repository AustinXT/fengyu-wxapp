# 审计报告：CC6 PII / 敏感数据（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC6（横切）
**审计员**：claude-opus-4-7
**审计时长**：~15 分钟
**关联 PR/Ticket**：—

> 本报告是 **横切收官审计**，跨全部 25 业务域统一汇总 PII / 敏感数据保护现状。
> 不重复登记业务域已记录的 P0；以"指标量化 + helper 抽取计划"为主，把分散在 25 份业务报告 §5 CC6 中的命中点收口成统一治理项。

---

## 1. 三端入口对照（PII 敏感字段表层）

| 层 | admin | staff | client | payNotify / cron-worker |
|----|-------|-------|--------|--------------------------|
| Schema 敏感字段权威 | `db/schema/user.ts:18,20,102,104,108-109` — `openid` / `phone` / `id_card`（注释声明 AES-256-GCM 但**全仓零加解密 helper**）| ↑ | ↑ | ↑ |
| 错误兜底 | `src/lib/operation-log.ts:31-73`（无脱敏）| `staffApi/index.js:165 console.error('[${action}] Error:', error)` | `clientApi/index.js:116` 同款 | `payNotify/index.js:39 console.log('received event:', JSON.stringify(event))` + `:507 console.error('Error:', err)` |
| 脱敏 helper（已散落） | `fengyu-admin/src/lib/utils.ts:14 formatPhone()` 11 位定长；`employees/[id]/_components/employee-detail-page.tsx:90 maskIdCard()`（页内私函数） | `staffApi/routes/customer.js:496 maskPhone()` + `routes/mgmt-customer.js:105 maskPhone()`（**两份副本**） | `clientApi/utils/mask.js:10 maskPhone()` | — |
| 直显展示层 | 6 个列表 / 详情明文（见 §3.1）| 4 个 page.wxml 明文（见 §3.1）| `pages/profile profile.wxml:32` 用户自查自己 phone（OK）| — |

---

## 2. PII 暴露面分类（数据流图）

```
[1] OPENID
  ├─ payNotify/index.js:39   全量 JSON.stringify(event)  ← 真实回调含 payer.openid
  ├─ staffApi/index.js:165   throw 链可带 ctx.auth → openid 进 stack
  └─ clientApi/index.js:116  同款
[2] phone（11 位明文）
  ├─ admin operation_logs.detail（customers.ts:540 写入 phone 明文）
  ├─ admin 列表/详情 6+ 直显面（见 §3.1.B）
  ├─ staff 业务路由：order-detail / refund / allocation / service-detail 4 份 wxml 直显
  └─ payNotify 路径：share-gift logOperation.detail 不含 phone（合规）
[3] id_card（schema 注释声明 AES-256-GCM）
  ├─ 实际：全仓零 crypto / encrypt / decrypt 引用 → **plaintext 入库**
  ├─ admin employee-detail 编辑态明文回显（line 314-317）
  └─ logOperation update diff 把新旧 idCard 一起入 detail（lib/operation-log.ts:80-95 logUpdate）
[4] PG error 链
  ├─ 23505 'Key (phone)=(13812345678) already exists.'  ← admin employees.test.ts:217 实证
  ├─ admin 多数 23505 已捕获返回友好消息（customers/employees/skill-tags ...）
  └─ admin orders.ts:1021/1024/1882 直接 return err.message 给 client
```

---

## 3. 自身漏洞

> 量化前提：以下 **不重新编号 P0** —— 均为 `audit-01 / 04 / 10 / 11 / 16 / 18 / 19 / 23 / 25` 已记的命中点回收 + helper 缺失 + 量化收尾。新发现以 `[CC6-NN]` 编号。

### 3.1 P0（阻断 / 资损 / 越权）

#### **[CC6-01]** Schema 注释 vs 实现脱节：`id_card` 声明 AES-256-GCM 但全仓零加解密路径
- **文件**：`db/schema/user.ts:108-109`（`/** 身份证号码（AES-256-GCM 加密存储） */`）
- **现象**：grep `crypto|AES|encrypt|decrypt|createCipher` 跨 admin/staff/client 全仓 0 处与 idCard 关联的加解密；`fengyu-admin/src/actions/employees.ts:348` 直接把 `idCard` 字符串写入 PG；`employee-detail-page.tsx:316` 编辑态 `value={form.idCard}` 直接回显原始字符串。
- **风险**：
  - **合规风险**：PIPL/网安法对身份证号要求加密或去标识化存储；当前 admin 数据库泄露 = 全员工身份证泄露
  - 注释误导审计 / 安全评审，使治理项被低估
- **修复**：
  - (L0) 引入 `db/helpers/pii.ts`：`encryptIdCard(s)` / `decryptIdCard(s)`（用 Node `crypto.createCipheriv('aes-256-gcm', key, iv)`，密钥环境变量 `PII_AES_KEY`）
  - (L4 admin actions) employees.create/update 写入前 encrypt；查询返回前 decrypt（仅 finance/admin 角色）
  - (L0 schema) 字段添加 `_iv` / `_tag` 列或与 ciphertext 拼接（PIPL 推荐 envelope encryption）
  - (L9) 旧数据迁移脚本（一次性）

#### **[CC6-02]** 三端日志 helper 完全分裂 + 两端无脱敏（payNotify / cron-worker / staffApi 路由器 / clientApi 路由器）
- **文件**：
  - `fengyu-client/cloudfunctions/payNotify/index.js:39` — `console.log('[payNotify] received event:', JSON.stringify(event))`（接入真实回调含 payer.openid + 全部支付明细，`audit-04 P0-04-04` 已登记）
  - `fengyu-staff/cloudfunctions/staffApi/index.js:165` — `console.error('[${action}] Error:', error)`，error 可能含 `ctx.auth` 引用 / SQL 参数 / phone
  - `fengyu-client/cloudfunctions/clientApi/index.js:116` — 同款
  - `fengyu-client/cloudfunctions/clientApi/routes/store.js:249` — `console.error('[geocode] LBS API error:', JSON.stringify(json))`，腾讯地图返回包可能含逆地理坐标 + 用户 IP
- **现象**：
  - 三端 console.* 完全无 sanitize 层；CloudBase 控制台日志被同账号所有成员可读
  - mask helper **3 份副本不一致**：staff `customer.js:496` + staff `mgmt-customer.js:105` + client `utils/mask.js:10`；admin 用 `lib/utils.ts:14 formatPhone()`（11 位定长）
- **风险**：
  - 合规：日志保留期 30+ 天，PII 长尾累积；CloudBase 同账号成员越权读
  - 审计可追溯性：任何 SDK exception 把 phone/openid 进 errorMessage
- **关联**：横切 `CROSS-CUTTING.md` line 326–340 已立项；本域收口为统一 helper
- **修复**：
  - (L0) 新建 `db/helpers/pii.ts`（与 [CC6-01] 同文件）：`maskPhone(p)` / `maskOpenid(o)` / `maskIdCard(c)` / `safeStringify(obj, fields=['phone','openid','id_card','idCard','wechat_id','payer'])`
  - (L3 staff/client) `index.js` 全局 catch 内的 `console.error` 改用 `safeStringify(error)`，并替换 errorMessage 中匹配 `\d{11}` 的串
  - (L3 payNotify) 整个 `console.log('received event', ...)` 改用白名单：`{ orderNo, transactionId: txnId.slice(0,8)+'...', amount }`
  - (L9) 三处 maskPhone 副本删除，统一引用 helpers/pii.ts（云函数通过 `db/helpers/pii.js` 复制 build step 引入）

#### **[CC6-03]** operation_logs.detail 写入 PII 明文（admin / staffApi 双路径）
- **文件**：
  - `fengyu-admin/src/actions/customers.ts:540` — `logOperation(session, 'customer.create', 'customer', userId, { name: data.name, phone: data.phone })`（phone 11 位明文入 jsonb）
  - `fengyu-admin/src/actions/employees.ts:348` — `{ name: data.name }`（仅姓名，可接受）
  - `fengyu-admin/src/lib/operation-log.ts:80-95 logUpdate` — `before/after` diff 完整 dump，凡涉及 phone/idCard/openid 的字段更新会把新旧值入 detail
  - `fengyu-staff/cloudfunctions/staffApi/utils/points.js:114-118` — `JSON.stringify({ error: err.message, ... })` 写入 detail，err.message 可能含 SQL/PII
  - `fengyu-staff/cloudfunctions/staffApi/routes/service.js:419` 等 INSERT operation_logs 路径 — 已查证无直接 phone 入 detail（`audit-23 §5` 已记 staffApi 全域审计稀缺）
- **现象**：admin `logs-page.tsx:222` 直接 `JSON.stringify(detail)` 展示给 admin 角色；audit-23 P0-23-02 已登记
- **风险**：
  - audit log 出口（导出 / 备份 / 跨机器迁移）复制 PII
  - 一旦扩展 `operation_log:list` 给 finance / hr，PII 立刻越权
- **关联**：retain `audit-23 P0-23-02`、`audit-01 P0-PII-06`、`CROSS-CUTTING.md line 331`
- **修复**：
  - (L4 admin lib) `operation-log.ts` 写入前对 detail 做白名单 sanitize：phone→maskPhone、id_card→maskIdCard、openid→maskOpenid（参 §6 L4）
  - (L9) 一次性 migration 回填 `operation_logs.detail` 历史 PII 字段（按 jsonb path 模式匹配 11 位手机号 / 18 位身份证）
  - (L4 staff/client utils/points.js) 写 settleFailed 日志前对 err.message 做正则脱敏

#### **[CC6-04]** admin 列表 / 详情直显完整 phone（脱敏 helper 覆盖率 50%）
- **文件**（直显）：
  - `fengyu-admin/src/app/(main)/stores/_components/stores-page.tsx:255` — `{r.customerPhone ?? "—"}`（解绑申请列表）
  - `fengyu-admin/src/app/(main)/store-unbind/_components/store-unbind-page.tsx:116, 183` — `{req.customerPhone || "-"}`（两次直显）
  - `fengyu-admin/src/app/(main)/refunds/[id]/page.tsx:83` — `{refund.clientPhone || '-'}`
  - `fengyu-admin/src/app/(main)/messages/_components/messages-page.tsx:703` — `{c.phone || '—'}`（批量发送 customer 选择列表）
  - `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:506, 540` — `{c.phone}` / `{selectedCustomer.phone}`
  - `fengyu-admin/src/app/(main)/services/_components/service-create-page.tsx:235` — `{selectedCustomer.phone}`
  - `fengyu-admin/src/app/(main)/customers/[id]/_components/customer-detail-page.tsx:517, 550` — promoter `{name} ({phone})` 直显（首发 `audit-25 P0-25-03`）
  - `fengyu-admin/src/app/(main)/employees/[id]/_components/employee-detail-page.tsx:308` — `<Input value={employee.phone ?? ""} disabled />`（员工详情明文）
  - `fengyu-admin/src/app/(main)/coupons/_components/coupon-detail-page.tsx:947` — 批量发券失败列表 `{e.phone}` 直显
  - `fengyu-admin/src/app/(main)/pickup-records/_components/pickup-record-create-page.tsx:176` — `{customer.phone}` 直显
- **文件**（已脱敏作对照）：
  - `customers/_components/customers-page.tsx:157` `formatPhone(row.phone)` ✅
  - `pickup-records-page.tsx:129/273` `formatPhone(row.clientPhone)` ✅
  - `card-transactions-page.tsx:137`、`points-page.tsx:115`、`cards-page.tsx:121`、`employees-page.tsx:81` ✅
- **现象**：admin 全局 `formatPhone` 已存在但仅 6/16 命中点真用了；剩 10 处直显
- **量化**：admin 直显 phone 页面 = **10 处** / 已脱敏 = **6 处**（覆盖率 37.5%）
- **风险**：
  - 一线 manager / hr / finance 通过非顾客详情页（store-unbind / messages 批发 / refund / promoter 选择器）拉取顾客或员工 phone 全集
  - 与 `audit-12 P2-12-16`（admin store-unbind 不脱敏 vs staff 已脱敏）+ `audit-25 P0-25-03`（promoter 选择器跨集团）+ `audit-16 P0-16-03`（messages 批发） 三条同源
- **修复**：
  - (L4 admin lib/utils.ts) `formatPhone` 不变；新增 `formatPhoneSafe(phone, role)`：admin 全明文、其他角色一律 `formatPhone(phone)`；为后续按 PERMISSION_MATRIX 收紧打底
  - (L7 admin pages) 上述 10 处统一替换为 `formatPhone(row.xxx)`；store-unbind / messages / refund / coupon-detail / order-create / service-create / pickup-record-create / employee-detail / customer-detail 各文件 1-2 行改动
  - 与 [CC6-02] 同步：脱敏 helper 抽取到 `db/helpers/pii.ts`（admin 引用 `@db/helpers/pii`，云函数 build copy）

### 3.2 P1

#### **[CC6-05]** 三端 mask helper 副本漂移
- **文件**：staff `customer.js:496` + staff `mgmt-customer.js:105` + client `utils/mask.js:10` + admin `lib/utils.ts:14`（4 份不同实现 / 不同长度边界处理）
- **现象**：
  - admin `formatPhone`：`length !== 11` 直接返回原文（短串/长串都不脱敏）
  - staff `maskPhone`：分段处理 ≤4 / ≤7 / 其他三档
  - 边界差异：admin `12345678901`（12 位）→ 原文不脱敏；staff `12345678901` → `123****8901`
- **风险**：跨端测试断言不一致（staff customer.test.js:60 `138****1111`，admin utils.test.ts:41 同串结果一致仅在 11 位；其他长度结果分裂）
- **修复**：
  - (L0) helpers/pii.ts 实现 staff 版的三档逻辑作为唯一权威
  - (L9) 测试断言收敛

#### **[CC6-06]** admin 错误前缀缺 NOT_FOUND/PERMISSION_DENIED 区分（client 静默 success）
- **现象**：retain `audit-16 P2-16-12`（client message.read rowCount=0 静默 success） + admin orders.ts:1021/1024/1882 暴露 err.message 给前端
- **风险**：前端无法区分"不存在"和"他人的"，泄露资源存在性（侧信道）
- **修复**：建立 `NOT_FOUND` / `PERMISSION_DENIED` 错误码统一

#### **[CC6-07]** PG `23505` 错误链兜底覆盖率不全
- **文件**：
  - `fengyu-admin/src/actions/customers.ts:455, 534` ✅ / `employees.ts:339, 423` ✅ / `coupons.ts:335` ✅ / `skill-tags.ts:73, 105` ✅ / `positions.ts:76, 109` ✅ / `stores.ts` ✅ / `org.ts` ✅
  - `fengyu-admin/src/actions/orders.ts:1015-1036` 部分捕获（仅"该顾客已有待支付订单"等业务错误）；其他 23505 仍可触发 generic Error
- **现象**：staffApi / clientApi 路由层无 `error.code === '23505'` 类捕获 → PG 抛出 `duplicate key value violates unique constraint "uq_xxx" Key (phone)=(138...) already exists.` 经 index.js:165/116 `console.error` 全文落日志，再回到客户端的 errorMessage 在前缀匹配前就已经把 11 位手机号写到 logs
- **风险**：与 [CC6-02] 同源放大；正常入库失败路径泄露 PII
- **修复**：(L3) 三端云函数 / admin actions 封装 `pgErrorToBusiness(err)` —— 23505 → "字段冲突"、23503 → "关联数据不存在"、其他 → 通用错误，绝不透传 PG message

### 3.3 P2

- **[CC6-08]** `lib/operation-log.ts logUpdate` 不区分敏感字段：所有 changes 字段平等 dump 到 detail
- **[CC6-09]** admin `logs-page.tsx:222` 直接 `JSON.stringify(detail, null, 2)` 渲染（无前端 sanitize 层）— `audit-23 P0-23-02` 已记
- **[CC6-10]** schema 字段 docstring 与实现不同步治理：`id_card AES-256-GCM` 注释 + `monthly_activity 每日重算` 注释 + `points_balance cron 重算` 注释，应建立"docstring 实现完整性"扫描

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| 日志 PII sanitize | ❌ | ❌ | ❌ | ❌（最严重 - 全 event JSON） | 三端 + 触发器全量泄露 | P0 |
| mask helper 实现 | `formatPhone` 11 位定长 | `maskPhone` 三档 | `maskPhone` 三档 | — | 同名不同行为 | P1 |
| operation_logs.detail PII | 1 处 phone 明文（customers.create） + diff | INSERT 路径少 / err.message 入 detail | 同 staff | logOperation 仅 saleOrderId / userId | admin 唯一持续暴露面 | P0 |
| admin 直显 phone 覆盖率 | 6/16 命中（37.5% 用了 formatPhone） | 不分角色（manager 明文 / 员工脱敏） | 仅自查 | — | admin 比 staff 更弱 | P0 |
| id_card 加密 | 注释声明 AES / 实际明文 | 同 | 不涉及 | — | 注释误导 | P0 |
| 错误码 prefix | NOT_FOUND/INSUFFICIENT_BALANCE 已加 | 同 | 同 | — | 但路由层未全用 | P1 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] **CC1 数值精度**：本横切域无关联（金额非 PII）
- [x] **CC2 并发幂等**：本横切域无关联
- [x] **CC3 组织域隔离**：CC3 缺失 = PII 暴露的最大单一原因（admin/staff customer.* 全裸）；本域不重复登记，retain `audit-CC3 §3` 全部 P0
- [x] **CC4 后端鉴权**：retain `audit-CC4 P0-payNotify-1`（payNotify 全栈无鉴权），与 [CC6-02] 联动放大
- [x] **CC5 错误码**：retain；本域追加 [CC6-06] / [CC6-07]
- [x] **CC6 PII**：本域收口
- [x] **CC7 时间字段**：无关
- [x] **CC8 WXML/Vant**：staff 4 处 wxml 直显 phone（manager 分支）；client 仅自查
- [x] **CC9 测试与残留**：admin `formatPhone` test 覆盖完整；staff `maskPhone` 分散 3 副本测试也分散；retain"测试反向锁死"模式

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| **L0 helpers** | `db/helpers/pii.ts` (**新建**) | 抽取 4 个权威 helper：`maskPhone(s)` / `maskOpenid(s)` / `maskIdCard(s)` / `safeStringify(obj, sensitiveKeys[])` + `encryptIdCard / decryptIdCard`（envelope AES-256-GCM）+ `pgErrorToBusiness(err)`（23505/23503 兜底） | CC6-01/02/03/05 |
| **L0 schema** | `db/schema/user.ts:108-109` | id_card 字段拆为 `id_card_ciphertext` + `id_card_iv` 或加 GENERATED ALWAYS AS expression；docstring 修正 | CC6-01 |
| **L3 staff routes index** | `staffApi/index.js:165` | `console.error` 改 `safeStringify(error)`；正则 mask `\d{11}` | CC6-02 |
| **L3 client routes index** | `clientApi/index.js:116` | 同 | CC6-02 |
| **L3 payNotify entry** | `payNotify/index.js:39, 507` | event 白名单 `{orderNo, txnIdMasked, amount}`；error 用 safeStringify | CC6-02 |
| **L3 staff/client mask** | 删除 `staffApi/routes/customer.js:496` + `mgmt-customer.js:105` + `clientApi/utils/mask.js:10` 三份副本 | 改为 `require('@helpers/pii')` | CC6-05 |
| **L4 admin lib/operation-log.ts** | `lib/operation-log.ts:31-73` 写入前对 detail key in `[phone, id_card, idCard, openid, wechat_id]` 应用 mask | logUpdate 同样；并新增 `_v: 3` 标记已脱敏 | CC6-03 / CC6-08 |
| **L4 admin lib/utils.ts** | `lib/utils.ts:14` `formatPhone` 接受 length≠11 时也尝试脱敏（改用 helpers/pii） | CC6-05 |
| **L4 cron-worker / staff utils/points.js** | 写 settleFailed 前对 err.message 做 mask | CC6-03 |
| **L7 admin pages** | 10 处 raw `{phone}` → `formatPhone()`：stores-page / store-unbind-page / refunds/[id] / messages-page (line 703) / orders/order-create-page (506,540) / services/service-create-page (235) / customers/customer-detail (517,550) / employees/employee-detail (308) / coupons/coupon-detail (947) / pickup-record-create (176) | CC6-04 |
| **L9 一次性 migration** | `db/migrations/00NN_pii_redact_operation_logs.sql` 回填历史 detail（jsonb regex `\d{11}` / `\d{18}` 替换） | CC6-03 |
| **L9 一次性 migration** | id_card 历史明文加密（脚本 + dry-run 验证） | CC6-01 |
| **L10 测试** | 三端 mask helper 测试统一到 `helpers/pii.test.ts`；删除三份副本测试 | CC6-05 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- A. operation_logs.detail 含 11 位手机号文本扫描（已记 audit-23 §8 #C）
SELECT id, action, target_type, target_id,
  CASE WHEN detail::text ~ '"phone":"[1][3-9][0-9]{9}"' THEN 'phone'
       WHEN detail::text ~ '\d{18}' THEN 'idCard'
       WHEN detail::text ~ '"openid":"[a-zA-Z0-9_-]+"' THEN 'openid'
       ELSE 'other'
  END AS pii_kind,
  created_at
FROM operation_logs
WHERE detail::text ~ '"phone":"[1][3-9][0-9]{9}"|"id_card":|"openid":"o[A-Za-z0-9_-]'
ORDER BY created_at DESC
LIMIT 50;

-- B. id_card 字段是否真的 plaintext（按长度 18 + 数字判定）
SELECT employee_id, name,
  LENGTH(id_card) AS len,
  CASE WHEN id_card ~ '^\d{17}[0-9Xx]$' THEN 'plaintext' ELSE 'maybe-encrypted' END AS form
FROM staff_wechat_users
WHERE id_card IS NOT NULL
LIMIT 20;

-- C. client_wechat_users phone 列分布（检查格式校验缺失）
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE phone ~ '^1[3-9]\d{9}$') AS valid_cn,
  COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone !~ '^1[3-9]\d{9}$') AS invalid,
  COUNT(*) FILTER (WHERE phone IS NULL) AS null_phone
FROM client_wechat_users;

-- D. operation_logs 量级（评估回填迁移成本）
SELECT date_trunc('month', created_at) AS month, COUNT(*) AS rows
FROM operation_logs
GROUP BY 1 ORDER BY 1 DESC;
```

---

## 8. 回归测试用例（建议）

1. **logger sanitize**：`safeStringify({ phone: '13812345678', name: '张三', openid: 'oABC...123' })` → `{ phone: '138****5678', name: '张三', openid: 'oABC***123' }`
2. **operation_logs 写入脱敏**：`logOperation(session, 'customer.create', 'customer', uid, { name, phone: '138...' })` → 实际入库 detail.phone === '138****5678'
3. **id_card 加密往返**：`encryptIdCard('110101199001011234')` → ciphertext；`decryptIdCard(ciphertext)` → 原值
4. **admin 列表脱敏覆盖**：Playwright 抓 store-unbind / refunds / messages / coupons / pickup 五页 DOM，断言不出现 11 位连续数字
5. **payNotify 日志白名单**：mock 真实 V3 callback，断言 console.log 输出不含 `payer_openid` / `payer.openid` / `out_trade_no` 完整值
6. **PG 23505 兜底**：mock 触发 phone 唯一约束冲突，断言返回 `{ success: false, message: '该手机号已被其他顾客使用' }`，不含 PG 原文

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（admin + staff + client + payNotify + cron-worker + DB）**：☑
- **涉及历史数据**：☑（operation_logs 回填 + id_card 加密迁移）
- **修复成本**：**L**（4 端 + 1 cron + 10+ 页面 + 1 migration；建议拆 3 个 PR：① helpers/pii.ts + 替换 console.* / mask 副本；② operation_logs 脱敏 + 历史回填；③ id_card 加密 + employee 端改造）

---

## 10. 后续待办

- [ ] 与 `audit-01 P0-PII-06` 计划项"`db/helpers/phone.ts`"对齐（应升级为 `db/helpers/pii.ts`，覆盖更广）
- [ ] 与 `audit-23 P0-23-02` operation_logs detail 脱敏一并 PR
- [ ] 推动 SUMMARY.md 把 CC6 Top 4 P0（CC6-01/02/03/04）纳入"修复 roadmap L0/L4 优先级"
- [ ] 运营侧明确 PERMISSION_MATRIX 哪些角色可看 phone / idCard 明文，作为 `formatPhoneSafe` 的判定依据
- [ ] 将 schema docstring 与实现一致性扫描（id_card AES + monthly_activity cron + points_balance cron）作为 CC9 收尾项
- [ ] 治理项收口后，更新 `CROSS-CUTTING.md §CC6` 标注 ✅ closed by audit-CC6-pii.md
