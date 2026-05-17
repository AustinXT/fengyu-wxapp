> 生成日期：2026-05-18
> 严重级别：P0（Top10 #7 — PII 不脱敏 + 物理硬删；SUMMARY v4 §6.3 + audit-CC6 P0 4 条）
> 端：**三端 + admin 单端**（fengyu-admin / fengyu-staff / fengyu-client）
> 影响面：
> - 三端 helper（按 feedback `no-shared-cloudfunctions` 各自一份副本 + cross-end snapshot 守护）：
>   - `fengyu-admin/src/lib/pii.ts`（新建，TS）
>   - `fengyu-staff/cloudfunctions/staffApi/utils/pii.js`（新建，CJS）
>   - `fengyu-client/cloudfunctions/clientApi/utils/pii.js`（新建，CJS — 复用现有 `utils/mask.js` 升级而非新建）
> - admin lib：`src/lib/operation-log.ts` 写入前 sanitizeDetail；`src/lib/format.ts` 新建（暴露 formatPhoneSafe 给 UI）
> - admin actions：deleteSku / deleteMessage 改"软删 + 操作日志前置"；point_transactions 当前**无物理删 action**，不动（已确认 grep 2026-05-18）
> - db schema：`messages` + `product_skus` 加 `deleted_at` / `deleted_by` 列（migration 0033）
> - cross-end snapshot：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-pii-snapshot.test.js`（新建，与 error-codes 同模式）
> 修复成本：M（5–7 天，含三端 helper + 软删迁移 + snapshot 守护）
> 前置：`fengyu-client/cloudfunctions/clientApi/utils/mask.js` 已有 maskPhone 单函数（升级而非废弃）；`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:512` 内置三档 maskPhone（提取到 utils/pii.js）
> 来源：Top10 #7（SUMMARY.md v4 §2）+ audit-CC6 P0-01/02/03/04 + SUMMARY v4 §6.3 中期

**一句话目标**：把 PII 脱敏（maskPhone/maskName/maskIdCard/maskEmail）抽成三端各 1 份副本（不共享目录，参考 feedback `no-shared-cloudfunctions`）+ cross-end snapshot 守护一致性；admin `logOperation` 写入前对 detail 跑 sanitize；admin 三个物理硬删（deleteSku / deleteMessage / point_transactions）改软删（实际 grep 后 point_transactions 无 delete action，仅 2 处需要改）。

---

## 0 一句话背景

audit-CC6（2026-04-26 v1+v2 合并版）已列 PII 4 条 P0，截至 2026-05-18 v4 SUMMARY 复核**全部未关闭**。Top10 #7 在 v4 RoadMap 标为剩余 P0。本 ticket 同时覆盖三件事：

1. **L1 helpers**：三端 pii.js/pii.ts 副本（与 error-codes / refund-cascade / settlePoints 同模式，单源不可行因 feedback `no-shared-cloudfunctions` 禁止共享目录）
2. **L7 operation-log sanitize**：admin `logOperation` / `logUpdate` 在 INSERT 前对 detail 跑 sanitize（CC6-P0-03）
3. **L7 软删迁移**：admin deleteSku / deleteMessage 改软删 + 操作日志前置；point_transactions 当前 grep 实证**无物理 delete action**，本 ticket 不动（不预防性新增软删列）

> grep 实证 2026-05-18：
> - `fengyu-admin/src/actions/points.ts` 全文 0 处 `delete` / `DELETE`（仅 history listing）
> - `fengyu-admin/src/actions/messages.ts:180` `await db.delete(messages).where(eq(messages.id, id))` — 是
> - `fengyu-admin/src/actions/products.ts:714-715` `db.delete(mallProductSkus)` + `db.delete(productSkus)` — 是

---

## 1 现状盘点

### 1.1 三端现有 mask 副本（grep 实证 2026-05-18）

| 文件 | 函数 | 实现 |
|---|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:512` | `maskPhone` 内置 | 三档（≤4 / ≤7 / other） |
| `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:105` | `maskPhone` 内置 | 与 customer.js 一致（copy-paste） |
| `fengyu-client/cloudfunctions/clientApi/utils/mask.js:10` | `maskPhone` 导出 | `slice(0,3) + '****' + slice(-4)`（无三档）— audit-CC6 P1-05 称 0 处 require（死代码） |
| `fengyu-admin/src/lib/utils.ts:14` | `formatPhone` | `length !== 11` 时返回原文 — audit-CC6 P1-06 称与 staff 副本不一致 |
| `fengyu-admin/src/lib/format.ts` | — | **不存在** |

### 1.2 三端现有 sanitize / safeStringify

无任何 helper 抽出。`admin/src/lib/operation-log.ts` 直接把 `detail` 入参传给 `db.insert(operationLogs).values({detail})`，无脱敏（CC6-P0-03 主证据）。

### 1.3 admin 物理硬删 grep（2026-05-18 实测）

| 文件:行 | 表 | 当前 |
|---|---|---|
| `fengyu-admin/src/actions/products.ts:714-715` | mallProductSkus + productSkus | `db.delete(...)` 物理 DELETE（含先查 saleItems 引用 guard）|
| `fengyu-admin/src/actions/messages.ts:180` | messages | `db.delete(messages).where(eq(id, id))` 物理 DELETE |
| `fengyu-admin/src/actions/points.ts` | point_transactions | **无 delete action**（仅 list / stats / export）|

ticket 范围**调整**：原任务描述列了 3 处，实测仅 2 处。

### 1.4 db schema 软删列现状

| 表 | 当前 |
|---|---|
| `db/schema/product.ts` (product_skus) | 无 `deleted_at` / `is_deleted` |
| `db/schema/product.ts` (mall_product_skus) | 无 |
| `db/schema/message.ts` (messages) | 无 |
| `db/schema/order.ts` sale_allocations (L220) | ✅ 已有 `is_void: boolean` + partial unique `WHERE is_void=false` — 软删模式样板 |
| `db/schema/order.ts` sale_orders | 无（订单不允许删，状态机控制） |

**软删字段惯例**（按 sale_allocations 样板）：

- 推荐 `deleted_at: timestamp` 而非 `is_void: boolean`，因为 deleted_at 同时承载"何时删"+"是否删"，更利于审计 + 排序
- 加 `deleted_by: text` 记录操作人
- 所有"看得到 SKU/message"的查询补 `WHERE deleted_at IS NULL`（grep 全 admin actions + 三端云函数 routes）

### 1.5 既有 cross-end snapshot 蓝本

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`（169 行）— 已成熟模式：

- `loadCjsPrefixes(modulePath)` 直接 require staff/client/payNotify 三端 .js
- `loadTsPrefixesFromSource(tsPath)` regex 从 admin api-error.ts 提取
- describe block 两两比对

本 ticket pii snapshot 完全套此模板。

---

## 2 关键架构决策

### 2.1 helper 分布：单源 vs 三副本 + snapshot

按 feedback `no-shared-cloudfunctions` 决策：

- 三端各 1 副本（admin .ts + staff .js + client .js）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-pii-snapshot.test.js` 字面量守护

**3 副本所在路径**：

| 端 | 路径 |
|---|---|
| admin | `fengyu-admin/src/lib/pii.ts` |
| staff | `fengyu-staff/cloudfunctions/staffApi/utils/pii.js`（与 error-codes.js 并排） |
| client | `fengyu-client/cloudfunctions/clientApi/utils/pii.js`（**升级**现有 `utils/mask.js` —— 改文件名 + 加函数 + 删 mask.js）|

> 选项：保留 `mask.js` 作为 backwards-compat re-export `module.exports = require('./pii')`。**不推荐**（feedback `no-legacy-compat`，开发阶段无需历史兼容），直接删 mask.js + 全仓 grep 已无 require（audit-CC6 P1-05 确认）。

### 2.2 三档 maskPhone 标准

```js
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return ''
  const s = phone.trim()
  if (s.length <= 4) return '*'.repeat(s.length)
  if (s.length <= 7) return s.slice(0, 1) + '*'.repeat(s.length - 2) + s.slice(-1)
  // 8+ 位（含 11 位标准手机号）：前 3 后 4
  return s.slice(0, 3) + '*'.repeat(Math.max(4, s.length - 7)) + s.slice(-4)
}
```

11 位标准手机号 → `138****1234`，非 11 位仍走脱敏（与 admin formatPhone 行为不同 — 后者非 11 位返回原文，本 ticket 收敛到三端一致的"全脱敏"路径）。

### 2.3 maskName

```js
function maskName(name) {
  if (!name || typeof name !== 'string') return ''
  const s = name.trim()
  if (s.length === 0) return ''
  if (s.length === 1) return '*'
  if (s.length === 2) return s[0] + '*'  // 张三 → 张*
  // 3+: 首字 + 中间 * + 尾字（外国名/带空格按字符算）
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
}
```

### 2.4 maskIdCard

```js
function maskIdCard(id) {
  if (!id || typeof id !== 'string') return ''
  const s = id.trim()
  if (s.length < 8) return '*'.repeat(s.length)
  // 18 位身份证：前 4 + 中间 *** + 后 4 → 110**********1234
  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4)
}
```

### 2.5 maskEmail

```js
function maskEmail(email) {
  if (!email || typeof email !== 'string') return ''
  const at = email.indexOf('@')
  if (at < 0) return maskName(email)  // 退化为 name 脱敏
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return local[0] + '*' + domain
  return local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] + domain
}
```

### 2.6 sanitizeDetail（递归对象脱敏）

```js
const SENSITIVE_KEYS = new Set([
  'phone', 'mobile', 'tel',
  'name', 'realName', 'real_name',  // ⚠ 名字脱敏争议大 — 见 §2.7
  'idCard', 'id_card', 'idNumber',
  'email',
  'openid', 'open_id',
])

function sanitizeDetail(input) {
  if (input == null) return input
  if (typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(sanitizeDetail)
  const out = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && SENSITIVE_KEYS.has(k)) {
      if (k === 'phone' || k === 'mobile' || k === 'tel') out[k] = maskPhone(v)
      else if (k === 'idCard' || k === 'id_card' || k === 'idNumber') out[k] = maskIdCard(v)
      else if (k === 'email') out[k] = maskEmail(v)
      else if (k === 'openid' || k === 'open_id') out[k] = maskOpenid(v)
      else out[k] = maskName(v)  // name / realName
    } else {
      out[k] = sanitizeDetail(v)
    }
  }
  return out
}
```

### 2.7 name 字段是否脱敏的争议

`operation_logs.detail` 在 admin /logs 页给 admin 自己看，**显示员工/客户姓名是业务必要**（不然审计无法追溯"小张改了小王的手机号"）。

**最终方案**：

- `name` 字段**默认 NOT 脱敏**（从 SENSITIVE_KEYS 中移除 name/realName）
- 但 `phone` / `id_card` / `email` / `openid` 强制脱敏
- 调用方需要全脱敏时显式调 `sanitizeDetail(detail, { maskNames: true })`（option flag）

这与 audit-CC6 §6 L4 建议一致（"masks phone/id_card/openid"，未列 name）。

### 2.8 软删迁移 schema 设计

```sql
-- migration 0033_soft_delete_messages_skus.sql
ALTER TABLE messages ADD COLUMN deleted_at timestamp;
ALTER TABLE messages ADD COLUMN deleted_by text;
CREATE INDEX idx_messages_active ON messages (created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE product_skus ADD COLUMN deleted_at timestamp;
ALTER TABLE product_skus ADD COLUMN deleted_by text;
-- product_skus 已有 valid_start/valid_end 控下架；这里软删用于"误创建"清理场景
-- mall_product_skus 是关联表，物理删可保留（无 PII）
```

drizzle schema 同步：

```ts
// db/schema/message.ts
deletedAt: timestamp('deleted_at'),
deletedBy: text('deleted_by'),

// db/schema/product.ts (product_skus)
deletedAt: timestamp('deleted_at'),
deletedBy: text('deleted_by'),
```

### 2.9 软删 vs 状态机

`messages.status` 已存在（draft/sent/...）— 是否新增 `status='deleted'` 比 `deleted_at` 更合理？

**结论**：`deleted_at IS NOT NULL` 是 cross-cutting 软删模式（与 sale_allocations.is_void 同模式），不挤占 status 业务语义。两者并存：

- `status` 表"业务状态"（草稿/已发送/已读）
- `deleted_at` 表"运营撤销"（误发后撤回）

### 2.10 logOperation 前置（删除前先 log）

```ts
export const deleteMessage = withPermission(
  'message:delete',
  async (session, id) => {
    const [target] = await db.select(/* 含 PII */).from(messages).where(eq(messages.id, id)).limit(1)
    if (!target) return { success:false, message:'消息不存在' }
    await logOperation(session, 'message.delete', 'message', String(id), { snapshot: sanitizeDetail(target) })  // 脱敏后入 log
    await db.update(messages).set({ deletedAt: new Date(), deletedBy: session.employeeId }).where(eq(messages.id, id))
    revalidatePath('/messages')
    return { success: true }
  },
)
```

---

## 3 设计目标

### 3.1 三端 pii 模块导出对照表

| 函数 | admin TS | staff JS | client JS |
|---|---|---|---|
| maskPhone | ✅ | ✅ | ✅ |
| maskName | ✅ | ✅ | ✅ |
| maskIdCard | ✅ | ✅ | ✅ |
| maskEmail | ✅ | ✅ | ✅ |
| maskOpenid | ✅ | ✅ | ✅ |
| sanitizeDetail | ✅ | ✅ | ✅ |
| SENSITIVE_KEYS | ✅ | ✅ | ✅ |

snapshot 守护两件事：
1. 函数签名列表一致（不允许某端漏导出）
2. 单元测试样例（mask*('13812345678') === '138****5678' 等）跨端结果一致

### 3.2 admin lib/format.ts（新建）

```ts
// fengyu-admin/src/lib/format.ts
import { maskPhone, maskIdCard } from './pii'
export { maskPhone as formatPhoneSafe }
export { maskIdCard as formatIdCardSafe }
export function formatPhoneDisplay(phone: string | null | undefined, opts?: { full?: boolean }): string {
  if (!phone) return '—'
  if (opts?.full) return phone
  return maskPhone(phone)
}
```

> 既存 `lib/utils.ts:14` formatPhone 保留（向后兼容当前 13 处调用），但**新增**:
> - `formatPhoneSafe` 在 audit-CC6 P0-04 列出的 12 处未脱敏页面统一引用
> - 12 处页面替换 grep 列表见 `audit-CC6-pii.md §3.5`

### 3.3 admin operation-log.ts 改造

```ts
// fengyu-admin/src/lib/operation-log.ts
import { sanitizeDetail } from './pii'

export async function logOperation(session, action, targetType, targetId, detail?) {
  const sanitized = detail ? sanitizeDetail(detail) : null
  // ... 现有 orgNodeId/orgNodeName 解析 ...
  await db.insert(operationLogs).values({
    operatorEmployeeId: session.employeeId,
    ...
    detail: sanitized,  // 入库前 mask
    source: 'adminApi',
  })
}

export async function logUpdate(session, action, targetType, targetId, before, after) {
  const changes = computeChanges(before, after)
  if (!changes) return
  await logOperation(session, action, targetType, targetId, {
    _v: 3,  // 升级版本号，标记"已 sanitize"
    _t: 'update',
    changes,
  })
}
```

> 历史数据回填：参考 audit-CC6 §6 L9，单独 ticket（不在本 ticket 范围）。

### 3.4 软删迁移：admin actions 修改

#### deleteMessage

```ts
// fengyu-admin/src/actions/messages.ts:173
export const deleteMessage = withPermission(
  'message:delete',
  async (session, id: number): Promise<{success:boolean;message:string}> => {
    // 1. 查 snapshot 用于审计
    const [target] = await db.select({...所有字段}).from(messages).where(eq(messages.id, id)).limit(1)
    if (!target) return { success:false, message:'消息不存在' }
    if (target.deletedAt) return { success:false, message:'消息已被删除' }
    // 2. 软删
    const result = await db.update(messages)
      .set({ deletedAt: new Date(), deletedBy: session.employeeId })
      .where(and(eq(messages.id, id), sql`deleted_at IS NULL`))
    if ((result as any).count === 0) return { success:false, message:'并发冲突，请刷新重试' }
    // 3. log（已 sanitize）
    await logOperation(session, 'message.delete', 'message', String(id), { snapshot: target })
    revalidatePath('/messages')
    return { success: true, message: '消息已删除' }
  },
)
```

所有现存读取 messages 的查询（list / detail / unreadCount 等）补 `WHERE deleted_at IS NULL` — grep 实证：

```bash
grep -rn "from(messages)" fengyu-admin/src/actions/
grep -rn "FROM messages" fengyu-staff/cloudfunctions/staffApi/routes/
grep -rn "FROM messages" fengyu-client/cloudfunctions/clientApi/routes/
```

#### deleteSku

```ts
// fengyu-admin/src/actions/products.ts:700
export const deleteSku = withPermission(
  'product:update',
  async (session, skuId: string) => {
    // 1. 引用 guard（保留）
    const [ref] = await db.select(...).from(saleItems).where(eq(saleItems.skuId, skuId)).limit(1)
    if (ref) return { success:false, message:'该商品已被订单引用，无法删除。可通过设置有效期下架' }
    // 2. 软删 product_skus；mall_product_skus 仍物理删（无 PII，且只是关联表）
    const [snap] = await db.select(...).from(productSkus).where(eq(productSkus.skuId, skuId)).limit(1)
    if (!snap) return { success:false, message:'规格不存在' }
    if (snap.deletedAt) return { success:false, message:'规格已被删除' }
    await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))  // 关联表保持物理
    await db.update(productSkus)
      .set({ deletedAt: new Date(), deletedBy: session.employeeId })
      .where(and(eq(productSkus.skuId, skuId), sql`deleted_at IS NULL`))
    await logOperation(session, 'sku.delete', 'product_sku', skuId, { snapshot: snap })
    revalidatePath('/products')
    return { success: true, message: '商品已删除' }
  },
)
```

product_skus 不含 phone 等强 PII（含 spec_name / price / capability flags），sanitizeDetail 对该 snapshot 几乎不影响内容。

读取查询补 `WHERE deleted_at IS NULL` 的位置（grep 实证）：

```bash
grep -rn "from(productSkus)" fengyu-admin/src/actions/
grep -rn "FROM product_skus" fengyu-staff/cloudfunctions/staffApi/routes/
grep -rn "FROM product_skus" fengyu-client/cloudfunctions/clientApi/routes/
```

> 影响面大（product_skus 是热表）。**估算**：admin ~15 处，staff ~8 处，client ~10 处。grep 完整列表见 §4。

#### point_transactions

**调整任务范围**：grep 实证 `fengyu-admin/src/actions/points.ts` 无 delete action（仅 list / stats / export），本 ticket **不动**。如果未来运营要"撤销错误积分流水"，独立 ticket 加 `point_transactions.deleted_at` + reversal 流程（与"消费冲销"语义并存）。

### 3.5 三端各端 sanitize 接入点

| 端 | 现有日志 / log 入口 | 改造 |
|---|---|---|
| admin | `lib/operation-log.ts:31` logOperation | sanitizeDetail(detail) before insert |
| staff | `staffApi/routes/*` console.error / 无 operation log（业务侧）| 全局 catch 用 sanitizeDetail(err.message + sql params) — 独立 ticket |
| client | 同 staff | 同上 — 独立 ticket |

本 ticket **不**改 staff/client 全局 catch（audit-CC6 P0-02），那是 L3 横切 patch，独立 ticket 处理（与 payNotify 解锁批次合并）。staff/client 的 pii.js 副本本期仅提供 helper，供后续接入。

---

## 4 详细变更清单（按层）

### 4.1 L0 — DB schema / migration

新建 `db/migrations/0033_soft_delete_messages_and_skus.sql`：

```sql
ALTER TABLE messages ADD COLUMN deleted_at timestamp;
ALTER TABLE messages ADD COLUMN deleted_by text;
CREATE INDEX idx_messages_active ON messages (created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE product_skus ADD COLUMN deleted_at timestamp;
ALTER TABLE product_skus ADD COLUMN deleted_by text;
CREATE INDEX idx_product_skus_active ON product_skus (sku_id) WHERE deleted_at IS NULL;
```

schema 同步：`db/schema/message.ts` + `db/schema/product.ts`。

### 4.2 L1 — pii helper 三端

| 文件 | 内容 |
|---|---|
| `fengyu-admin/src/lib/pii.ts`（新建）| 7 个 mask 函数 + sanitizeDetail + SENSITIVE_KEYS export |
| `fengyu-staff/cloudfunctions/staffApi/utils/pii.js`（新建）| 同上，CJS module.exports |
| `fengyu-client/cloudfunctions/clientApi/utils/pii.js`（新建）| 同上，删 utils/mask.js |
| `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:512` | 删内置 maskPhone，改 `require('../utils/pii').maskPhone` |
| `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:105` | 同上 |

### 4.3 L7 — admin lib

| 文件 | 修改 |
|---|---|
| `fengyu-admin/src/lib/format.ts`（新建）| formatPhoneSafe / formatIdCardSafe / formatPhoneDisplay |
| `fengyu-admin/src/lib/operation-log.ts:31, 90` | logOperation / logUpdate 入库前 sanitizeDetail; _v 升到 3 |
| `fengyu-admin/src/lib/utils.ts:14` formatPhone | 保留（向后兼容），但 jsdoc 加 `@deprecated 新代码用 formatPhoneSafe` |

### 4.4 L7 — admin actions

| 文件 | 修改 |
|---|---|
| `fengyu-admin/src/actions/messages.ts:173` deleteMessage | 改软删 + snapshot log（§3.4） |
| `fengyu-admin/src/actions/products.ts:700` deleteSku | 改软删 + snapshot log（§3.4） |
| `fengyu-admin/src/actions/messages.ts` list / detail / unreadCount | WHERE deleted_at IS NULL |
| `fengyu-admin/src/actions/products.ts` list / detail（含 mallProductSkus 关联）| WHERE deleted_at IS NULL |

### 4.5 L3 — staff / client 软删过滤

| 端 | 文件 | 修改 |
|---|---|---|
| staff | `cloudfunctions/staffApi/routes/product.js` SKU 查询 | WHERE deleted_at IS NULL |
| staff | `cloudfunctions/staffApi/routes/order.js` SKU 价格查 | WHERE deleted_at IS NULL |
| client | `cloudfunctions/clientApi/routes/product.js` | 同 |
| client | `cloudfunctions/clientApi/routes/order.js` | 同 |
| 三端 messages 读取 | — | 三端 messages 读取 grep 实证（client routes/message.js）补 WHERE deleted_at IS NULL |

具体 grep 列表实施时产出。

### 4.6 L9 — cross-end snapshot 守护

新建 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-pii-snapshot.test.js`，套用 cross-end-error-codes-snapshot 模板：

```js
const FILES = {
  staffJs: path.resolve(__dirname, '../../utils/pii.js'),
  clientJs: path.resolve(REPO_ROOT, 'fengyu-client/cloudfunctions/clientApi/utils/pii.js'),
  adminTs: path.resolve(REPO_ROOT, 'fengyu-admin/src/lib/pii.ts'),
}

// 1. 导出函数列表一致
describe('三端 pii 模块导出一致', () => {
  test('每端都暴露 maskPhone/maskName/maskIdCard/maskEmail/maskOpenid/sanitizeDetail', () => { ... })
})

// 2. 行为快照（统一 fixture）
describe('mask 行为字面量一致', () => {
  const fixtures = [
    { fn: 'maskPhone', input: '13812345678', expect: '138****5678' },
    { fn: 'maskPhone', input: '12345', expect: '1***5' },
    { fn: 'maskName', input: '张三', expect: '张*' },
    { fn: 'maskName', input: '王小明', expect: '王*明' },
    { fn: 'maskIdCard', input: '110101199001011234', expect: '1101**********1234' },
    { fn: 'maskEmail', input: 'foo@bar.com', expect: 'f*o@bar.com' },
    ...
  ]
  for (const f of fixtures) {
    test(`staff ${f.fn}(${f.input})`, () => expect(staffPii[f.fn](f.input)).toBe(f.expect))
    test(`client ${f.fn}(${f.input})`, () => expect(clientPii[f.fn](f.input)).toBe(f.expect))
  }
})

// 3. admin TS 端因 ts-node 依赖问题用 regex 提取函数定义 + 直接 import test
// （在 admin 侧独立 vitest spec：fengyu-admin/src/lib/__tests__/pii.test.ts 测同样 fixture）
```

### 4.7 L9 — tests

| 文件 | 增量 |
|---|---|
| `fengyu-admin/src/lib/__tests__/pii.test.ts`（新建）| 7 个 mask 函数 happy + 边界 + sanitizeDetail 递归 |
| `fengyu-admin/src/lib/operation-log.test.ts`（已存在）| 加 case "logOperation detail.phone 入库时被 mask" |
| `fengyu-admin/src/actions/__tests__/messages.test.ts`（已存在）| deleteMessage 改为软删后断言 deleted_at 非 null |
| `fengyu-admin/src/actions/__tests__/products.test.ts`（已存在）| deleteSku 改为软删后断言 deleted_at 非 null |
| staff: `cloudfunctions/staffApi/__tests__/utils/pii.test.js`（新建）| 同上 fixture |
| client: `cloudfunctions/clientApi/__tests__/utils/pii.test.js`（新建）| 同上 fixture |

---

## 5 迁移策略（按 Stage）

| Stage | 内容 | 工期 |
|---|---|---|
| **S1（L1 三端 helper）** | admin/staff/client 各新建 pii 文件 + 单测；删 client mask.js；staff routes/customer.js 改 require | 1 天 |
| **S2（L0 migration）** | 0033 schema + 临时 docker PG 跑 migrate 验证；5434 + 5433 双跑 | 0.5 天 |
| **S3（L7 admin operation-log）** | sanitizeDetail 接入 logOperation/logUpdate + tests | 0.5 天 |
| **S4（L7 admin 软删）** | deleteMessage / deleteSku 改造 + 读取查询全 grep 补 WHERE | 1.5 天 |
| **S5（L3 三端读取补 WHERE deleted_at IS NULL）** | staff/client routes 补过滤；reproduces 测试 | 1 天 |
| **S6（L9 cross-end snapshot）** | snapshot test + 跨端 fixture 守护 | 0.5 天 |
| **S7（admin lib/format.ts + 12 处页面替换）** | formatPhoneSafe 接入 audit-CC6 §3.5 列表的 12 处 | 1 天 |

**总工期：6 天**

可拆 3 个 PR（与 audit-CC6 §6 建议一致）：
- PR-A：L1 helper + L9 snapshot + admin/staff utils 替换内置 mask
- PR-B：L7 operation-log sanitize + L0 migration + admin 软删 + 三端读取补 WHERE
- PR-C：admin 12 处页面 formatPhoneSafe

---

## 6 验证 Checklist

### 6.1 后端

- [ ] `cd db && bun run db:generate` 产出 0033，diff 仅含 messages + product_skus 2×deleted_at/deleted_by + 2 partial index
- [ ] 临时 docker PG migrate 通过
- [ ] 5434 主库 + 5433 冷备双跑 migrate
- [ ] `cd fengyu-admin && npx tsc --noEmit` 0 错
- [ ] `bun run test` Vitest 全绿（含新增 ~30 用例）
- [ ] `bun run build` 通过
- [ ] staff/client `bun test cloudfunctions/*/utils/pii.test.js` 全绿

### 6.2 跨端守护

- [ ] `cd fengyu-staff && bun test __tests__/routes/cross-end-pii-snapshot.test.js` 全绿
- [ ] 故意改 client pii.js 让某函数偏移 → snapshot test 立即报错
- [ ] error-codes snapshot 不漂移

### 6.3 mask 输出 fixture（snapshot 锁定）

| 函数 | 输入 | 期望输出 |
|---|---|---|
| maskPhone | "13812345678" | "138****5678" |
| maskPhone | "12345" | "1***5" |
| maskPhone | "" | "" |
| maskName | "张三" | "张*" |
| maskName | "王小明" | "王*明" |
| maskName | "李四五六" | "李**六" |
| maskIdCard | "110101199001011234" | "1101**********1234" |
| maskEmail | "foo@bar.com" | "f*o@bar.com" |
| maskEmail | "a@b.c" | "a*@b.c" |
| sanitizeDetail({phone:'13812345678',name:'张三'}) | — | `{phone:'138****5678', name:'张三'}` （name 默认不脱敏，§2.7）|

### 6.4 软删

- [ ] admin /messages 删一条 → SELECT * FROM messages WHERE id=X → deleted_at 非 null
- [ ] admin /messages 列表不再显示已删
- [ ] client miniprogram message.list 不再返回已删（grep 补 WHERE 验证）
- [ ] admin /products SKU 删 → 同样
- [ ] staff/client miniprogram product list / order create 不再加载已删 SKU
- [ ] 已删 SKU 的旧订单详情仍能 JOIN 出 SKU 信息（不加 WHERE deleted_at IS NULL 的 JOIN 应保留 — order 详情按订单快照，不按当前 SKU）

### 6.5 operation_logs sanitize

- [ ] admin 改顾客手机号 → operation_logs 最新行 `detail->changes->phone->to` = "138****1234"（不是明文）
- [ ] sanitize 不影响非 PII 字段（amount / id / status 等保持原文）

---

## 7 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| **product_skus 加 WHERE deleted_at IS NULL 漏一处** | 客户端能加购已删 SKU → 下单失败 | grep 全仓 `from(productSkus)` + `FROM product_skus`；CI 加 ESLint 规则禁止 `SELECT * FROM product_skus` 不带 WHERE deleted_at IS NULL（可选） |
| **sanitizeDetail 误伤业务字段**（如 description 字段含中文姓名）| 业务展示乱码 | 仅按 key 名匹配（SENSITIVE_KEYS 显式列表），不做 value 启发式扫描 |
| **历史 operation_logs.detail 含 PII 明文** | DB 导出仍泄露 | 历史回填独立 ticket（audit-CC6 §6 L9）|
| **maskPhone 三档逻辑跨端微差** | snapshot 失败 | 三端字面量复制（不抽象）+ fixture 强校验 |
| **client mask.js 删后某测试隐式依赖**（虽然 audit-CC6 称 0 引用）| 引用报错 | 删前 grep；保留 1 天观察；不行 re-export shim |
| **deleteSku 软删后 admin /products 列表查询 N+1** | 加载慢 | partial index `WHERE deleted_at IS NULL` 已建 |

**回滚策略**：
- L0 migration 已 apply 后不回滚（deleted_at 可空，留空即可）
- L7 actions 回滚：deleteMessage / deleteSku 直接 revert commit → 临时回到物理删（不影响业务）
- L1 helper 回滚：revert 后 customer.js 内置 maskPhone 复活；snapshot test 不再 import pii.js
- 三端 routes WHERE deleted_at IS NULL 漏一处 → 立即 hotfix 单一 SQL

---

## 8 关联

- **审计来源**：
  - `docs/audit/SUMMARY.md` Top10 #7 + §6.3 中期 PII 与权限收尾
  - `docs/audit/audit-CC6-pii.md` P0-01/02/03/04（id_card 加密本 ticket 不含，独立 ticket）+ P1-05/06/07
- **既有蓝本**：
  - `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js`（169 行）— snapshot 测试模板
  - `db/schema/order.ts:220` `sale_allocations.is_void`（软删样板）
  - `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:512` 三档 maskPhone（复刻）
- **不在范围**：
  - id_card AES-256 加密（audit-CC6 P0-01，独立 ticket，需 PII_AES_KEY 环境变量 + 历史数据迁移）
  - staff/client 全局 catch sanitize（audit-CC6 P0-02，与 payNotify 解锁批次合并独立 ticket）
  - admin Customer/Employee serialize 移除 openid（audit-CC6 P1-07，独立小 ticket）
  - operation_logs 历史回填（audit-CC6 §6 L9，独立 ticket）
  - point_transactions 软删（grep 实证当前无 delete action）
- **相关 memory**：
  - feedback `no-shared-cloudfunctions`（三端各 1 副本）
  - feedback `no-legacy-compat`（删 mask.js 不留 shim）

---

## 9 复核反馈区（R1 待填）

> 实施前/中由 code reviewer 在此追加反馈块。重点复核：
>
> 1. SENSITIVE_KEYS 是否漏（grep 实际 operation_logs.detail 历史出现的 key 列表）
> 2. maskName 是否需"是否含中间字"option（业务侧反馈姓名直接看名字更友好）
> 3. product_skus 软删后已下单订单详情链路验证（admin orders/[id] 应能展示已删 SKU 名）
> 4. snapshot fixture 是否要扩到 100+ case（覆盖空串 / 全角字符 / emoji）
> 5. utils/mask.js 删除策略：直接删 vs 留 re-export shim 一周（按 no-legacy-compat 推荐直接删）
