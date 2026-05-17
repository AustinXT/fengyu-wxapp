---
ticket: client order.create 无券路径 totalAmount 未 Math.round — 浮点漂移 ±0.005
date: 2026-05-17
severity: P0
端: fengyu-client（主） / fengyu-admin（次，rawTotal 同源风险） / fengyu-staff（参考，已正确）
cost: S（半天）
来源:
  - SUMMARY v3 Top10 #5（`.42cog/pm/...` / `docs/audit/SUMMARY.md` §2）
  - audit-CC1 P0-CC1-v2-01（金额浮点漂移横切模式）
关联:
  - audit-CC1 跨端金额一致性 epic
  - 同 ticket 2026-04-27 sale-order-domain-refactor（received/payable_amount 引入）
状态: 🔴 待实施
---

## v2 修订摘要（2026-05-17 R2 复核后）

本次修订根据 §复核反馈（R2）对 Block / Warn 级问题进行 inline 修订：

- **Block 1+2（§5.3 / §6.3 测试 case 重写）**：删除虚构浮点 case（`5.55*3` / `35.50*3` / `19.99*7` 实测均精确或方向相反），改用 Node 实测真漂移 case：
  - `0.1 + 0.2 = 0.30000000000000004`
  - `1.1 * 3 = 3.3000000000000003`
  - `0.1 * 3 = 0.30000000000000004`
  - `0.2 * 3 = 0.6000000000000001`
  - `0.3 * 3 = 0.8999999999999999`
  - `0.29 * 100 = 28.999999999999996`
  - 断言改为 `expect(Number.isInteger(totalAmount * 100)).toBe(true)` / `expect((totalAmount * 100) % 1).toBe(0)`，不再 `toBe(具体值)`。
- **Warn 1（staff L285 行级一致性）**：§1 / §4 升格补述「staff L285 行级 `saleAmount = unitPrice * quantity` 同样未 round，但 L446 聚合 round 兜住，DB 写入端等价；本 ticket 的客户端目标对齐 staff L446 聚合模式即可」。
- **Warn 2（admin 修复拆 ticket）**：原 §5.2 admin 变更（变更 4-5）会破坏 admin orders.test.ts 的 0.005 边界 case，与本 ticket 标题 `client-…` 语义不符。**admin 修复另立独立 ticket** `notes/tickets/2026-05-17-admin-order-rounding-followup.md`（待创建），本 ticket 仅修 client。§5.2 标记为「拆出」。
- **Warn 3（payNotify / confirmOffline 显式声明）**：§4 补述「已审计 `clientApi/routes/order.js` payNotify L660-680 / L737-769 / L1340-1372 与 confirmOffline 路径，读 PG 已 round 的字符串后 `Number()` 不引入新漂移，无同类漏 round」。
- **改进 4（DB 校验 SQL 扩表）**：§6.2 校验 SQL 增加 `sale_allocations.total_amount`（注意：该表金额列名为 `total_amount` 而非 `amount`）、`sale_order_payments.amount`、`card_transactions.amount` 三表扫描（实际表名经 `db/schema/order.ts` / `db/schema/prepaid-card.ts` 校对）。
- **改进 5（来源行 SHA）**：原 `docs/audit/SUMMARY.md` 引用未验证存在；保留行级引用，建议执行 PR 时附实际 commit SHA。

---

## 0 一句话背景

`clientApi/routes/order.js` 在累加订单总金额 `totalAmount` 时，**仅在 `if (couponInfo)` 块内做了 `Math.round` 兜底**（L391-392）；当顾客下单未使用优惠券时，`totalAmount` 保留浮点累加结果，未经 round 直接写入 `sale_orders.total_amount`，并作为 `cap` 参与储值卡抵扣校验、作为 `finalPaidAmount` 兜底返回前端。

---

## 1 当前代码（精确行号）

### 1.1 累加点（无券路径漏 round）

`fengyu-client/cloudfunctions/clientApi/routes/order.js` L240-264：

```js
// 预计算明细数据
let totalAmount = 0
const itemsData = items.map(item => {
  const sku = skuMap[item.skuId]
  const unitPrice = Number(sku.price)
  const unitRealPrice = Number(sku.special_price || sku.price)
  const quantity = item.quantity || 1
  const saleAmount = unitRealPrice * quantity           // ← 浮点乘法
  totalAmount += saleAmount                              // ← 浮点累加，未 round
  return { /* ... saleAmount, received: saleAmount ... */ }
})
```

### 1.2 有券路径 round 兜底（仅此一处）

L391-392（在 `if (inputCouponId)` 块的末尾）：

```js
    totalAmount = itemsData.reduce((s, d) => s + d.received, 0)
    totalAmount = Math.round(totalAmount * 100) / 100   // ← 仅有券路径走到这里
  }                                                      // ← end if (inputCouponId)
```

无券路径直接跳过这段，`totalAmount` 保持 L247 累加后的原始浮点值。

### 1.2.a staff 三端基准的等价性补述（R2 修订）

> staff `fengyu-staff/cloudfunctions/staffApi/routes/order.js` **L285 行级** `const saleAmount = unitPrice * quantity` 同样**没有 round**（与 client L247 同症状）；但 staff 在 L446 单一聚合点
> `const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100`
> 做了一次"累加后 round"，使 DB 写入 `sale_orders.total_amount` 时是干净 2 位小数。
>
> 行级 `sale_items.sale_amount` 仍由 PG `numeric(10,2)` 兜底 — 这一点与 client 相同。所以 staff **不是行级也 round 的理想范例**，只是**聚合点 round 已经足以让 DB 写入侧三端等价**。本 ticket 给 client 选方案 A（行级 + 聚合后双 round）是更严格的实现，但与 staff "聚合点 round" 的下游 DB 形态等价。

### 1.3 浮点 totalAmount 的后续流转

| 行号 | 代码 | 问题 |
|------|------|------|
| L410 | `if (totalAmount >= threshold) documentType = '售后'` | 阈值边界判定可能偏移 |
| L416 | `let finalPaidAmount = totalAmount` | 浮点污染回参 |
| L441 | `const cap = Math.round(totalAmount * 100) / 100` | 这里 round 了 cap，但 totalAmount 自身没改 |
| L453 | `if (v > cap + 0.001) throw '储值卡抵扣金额超过应付金额'` | cap 由浮点 round 而来，边界可能差一分 |
| L463 | `const paidAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100` | paidAmount 自己 round 了，但减数仍是浮点 |
| L542 | `INSERT INTO sale_orders ... ($..., totalAmount, ...)` | **直写库**：PG numeric(10,2) 会隐式 round，但应用层不应依赖 |
| L620 / L634 | `ctx.result = { ..., totalAmount, ... }` | 返回前端，可能出现 `99.99999999` / `100.00000001` 等 |

### 1.4 DB 列类型（PG 会兜底但应用层不应依赖）

`db/schema/order.ts:59`：

```ts
totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
```

PG 写入 `numeric(10, 2)` 时会按银行家舍入裁到 2 位 — 但：
1. 应用层在 L416 / L620 / L634 把原始浮点 `totalAmount` 直接返回给前端（**未走 PG round**）
2. cap、阈值、document_type 等纯内存判定不经过 PG，浮点偏差直接生效
3. 强依赖 PG 隐式行为属于反模式（不便于未来切库 / cache 层）

---

## 2 影响

### 2.1 资损量级（R2 修订：替换为 Node 实测漂移 case）

> **R2 复核纠正**：原版引用的 `5.55*3 = 16.65` / `35.50*3 = 106.5` 实测精确，**不漂移**；`19.99*7` 实测为 `139.92999999999998`（方向 `-2e-14`），与原 ticket 写的 `139.93000000000004` 方向反。下面替换为 Node 实测真漂移 case：
>
> ```
> 0.1 + 0.2     = 0.30000000000000004
> 0.1 * 3       = 0.30000000000000004
> 1.1 * 3       = 3.3000000000000003
> 0.2 * 3       = 0.6000000000000001
> 0.3 * 3       = 0.8999999999999999
> 0.29 * 100    = 28.999999999999996
> 19.99 * 7     = 139.92999999999998       （方向 -2e-14）
> ```

`0.1 + 0.2 = 0.30000000000000004` 这类浮点漂移幅度通常 `±5e-15 ~ ±5e-14`，单笔无感；但：

| 场景 | 表现 |
|------|------|
| 顾客无券下单 `unitRealPrice = 0.1, quantity = 3`（罕见但夹具/mock 可复现） | `saleAmount = 0.30000000000000004` 写库 → PG 裁为 `0.30`；前端 `ctx.result.totalAmount` 返回 `0.30000000000000004`，前端 toFixed(2) 显示一致 |
| 顾客无券下单 `unitRealPrice = 0.29, quantity = 100`（积分换购 / 营销 SKU） | `0.29 * 100 = 28.999999999999996` 写库 → PG 裁为 `29.00`（注意 round 半奇偶）；前端返回浮点 |
| 顾客无券下单 `unitRealPrice = 1.1, quantity = 3` | `1.1 * 3 = 3.3000000000000003`，同上 |
| **边界踩雷**：threshold 卡边 `totalAmount = 1000.0000000000001` vs `threshold = 1000` | `>=` 判定为 `true` → document_type 从`售前`变`售后`（影响会员归类） |
| **边界踩雷**：储值卡余额 `100.00`，无券订单 `totalAmount = 100.00000000000001` | `cap = 100.00`（L441 round），但 `prepaidCardAmount = Math.min(cardBalance, cap) = 100.00`，OK；但若用户主动传 `prepaidCardAmount = 100.00`，L453 `v > cap + 0.001` 不触发，OK；**真实风险**在 returnPayload 给前端展示的 `totalAmount` 仍带浮点 |
| **回归一致性**：admin createOrder L1173/L1326 用 `totalAmount.toFixed(2)` 写库（字符串化掩盖），staff L446 显式 `Math.round`；client 是三端中唯一直接写浮点的 | 三端 SUMMARY 对账时同一商品三端 totalAmount 不一致 |

### 2.2 累计偏差风险

| 维度 | 估算 |
|------|------|
| 单笔偏差 | ±5e-15（IEEE 754 双精度浮点累积误差） |
| 单日订单量 × 偏差 | 若日单量 1000，理论累计 ±5e-12（实际被 PG numeric 截断） |
| **真实损失** | **资损为 0**（PG numeric 兜底），但**对账偏差**和**前端展示异常**真实存在 |

### 2.3 隐性风险（应用层依赖 DB 类型）

- 若未来 `total_amount` 改 `decimal(12, 4)` 或 cache 层接入（绕过 PG 直读），浮点会立刻显形
- 三端实现漂移（staff/admin 已显式 round，client 没有）→ 长期审计成本

---

## 3 修复方案

### 方案 A（推荐）：累加点即时 round（L247）

```js
// L240-247 修改后
let totalAmount = 0
const itemsData = items.map(item => {
  const sku = skuMap[item.skuId]
  const unitPrice = Number(sku.price)
  const unitRealPrice = Number(sku.special_price || sku.price)
  const quantity = item.quantity || 1
  const saleAmount = Math.round(unitRealPrice * quantity * 100) / 100  // ← 行级 round
  totalAmount += saleAmount
  return {
    skuId: item.skuId,
    productName: sku.spec_name,
    // ...
    saleAmount,
    received: saleAmount,
    // ...
  }
})
totalAmount = Math.round(totalAmount * 100) / 100  // ← 累加后再 round 一次
```

**优点**：与 staff L446 `Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100` 行为对齐；`saleAmount` / `received` 行级也是 round 过的，下游所有路径（无券/有券/cap/paidAmount）都拿到干净的 2 位小数。

**缺点**：3 处改动（行级 + 累加后），但侵入小。

### 方案 B：单点兜底（在 L393 之后追加无券分支）

```js
  }  // end if (inputCouponId)
  // 无论是否走券路径，统一兜底 round
  totalAmount = Math.round(totalAmount * 100) / 100
```

**优点**：1 处改动，最小侵入。

**缺点**：行级 `saleAmount` / `received` 仍是浮点 → 写入 `sale_items.sale_amount` 列时仍依赖 PG round；与 staff 实现细节有差异。

### 方案 C（兜底加固）：写库前最后兜底

在 L538 / L542 INSERT 调用前显式 `Math.round`：

```js
const totalAmountForDb = Math.round(totalAmount * 100) / 100
// 同时修正 finalPaidAmount = totalAmountForDb（L416 已经覆写）
// 同时修正 ctx.result.totalAmount = totalAmountForDb（L620 / L634）
```

**结论**：采用 **方案 A + 方案 C 兜底**。方案 A 解决根因（与 staff 完全一致），方案 C 提供"写库前最终防线"（防御未来代码漂移）。

---

## 4 三端一致性

| 端 | 文件 | 当前实现 | 状态 |
|----|------|---------|------|
| **client**（本 ticket） | `fengyu-client/cloudfunctions/clientApi/routes/order.js` L240-247 / L391-392 | `totalAmount += saleAmount` 累加；仅有券路径 round | ❌ **修复目标** |
| **admin** | `fengyu-admin/src/actions/orders.ts` L902-997 | `rawTotal = items.reduce((sum, item) => sum + ...)` 无行级 round；最终 `Math.max(0, rawTotal - couponDiscount)` 也无 round；但 L1173 / L1326 用 `totalAmount.toFixed(2)` 字符串化写库 | ⚠️ **次要修复**：toFixed 掩盖了 DB 层，但内存中 `totalAmount` 仍是浮点（L1037 `settledAmount = Math.round((receivedAmount + prepaidCardAmount) * 100) / 100` vs L1042 `settledAmount + 0.005 < totalAmount` 比较时浮点污染） |
| **staff** | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` L446 | `const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100`（注：L285 行级 `saleAmount = unitPrice * quantity` 同样**未 round**，但 L446 聚合 round 兜住 → DB 写入端等价） | ✅ **聚合点 round 已正确**（参考标准；行级仍由 PG `numeric(10,2)` 兜底，与 client 同症状） |

### 三端比较关键发现（R2 修订）

1. **staff 在聚合点显式 round**（L446）— 应作为基准模式；但 L285 行级与 client 同样未 round（DB 写入端因聚合 round 等价）
2. **admin** 靠 `.toFixed(2)` 字符串化掩盖，但内存比较点（如 L1042 `settledAmount + 0.005 < totalAmount`）仍读浮点 totalAmount → 需在 L997 加 `Math.round`（**已拆为独立 ticket，见 §5.2**）
3. **client** 是唯一 DB 写入用裸浮点的（既无行级也无聚合 round）— **最严重，本 ticket 主修**
4. 三端 `saleAmount` 行级一致性：staff L285 / client L247 都是浮点；staff L446 聚合 round → DB 等价；client 无聚合 round → DB 依赖 PG numeric 兜底，且 returnPayload 直接漏浮点给前端

### payNotify / confirmOffline 路径审计（R2 新增）

为避免读者误以为这两条路径遗漏：已审计 `fengyu-client/cloudfunctions/clientApi/routes/order.js` 的以下行号，**未发现同类漏 round**：

| 路径 | 行号区间 | 数据流 | 结论 |
|------|----------|--------|------|
| payNotify（微信支付回调） | L660-680 / L737-769 / L1340-1372 | 从 PG `sale_orders.total_amount`（已被 `numeric(10,2)` 裁过的字符串）读出 → `Number(row.total_amount)` | 字符串 → Number 不引入新漂移；安全 |
| confirmOffline（线下确认收款） | L803 `Math.round(thisPayAmount * 100) / 100` 等 | thisPayAmount 已 round | 安全 |

→ 本 ticket 的 client 修复**只需收口 `order.create` 的累加点**，无需扩展到 payNotify / confirmOffline。

---

## 5 详细 patch

### 5.1 `fengyu-client/cloudfunctions/clientApi/routes/order.js`

**变更 1（L240-264，行级 + 累加后 round）**：

```diff
   // 预计算明细数据
   let totalAmount = 0
   const itemsData = items.map(item => {
     const sku = skuMap[item.skuId]
     const unitPrice = Number(sku.price)
     const unitRealPrice = Number(sku.special_price || sku.price)
     const quantity = item.quantity || 1
-    const saleAmount = unitRealPrice * quantity
+    const saleAmount = Math.round(unitRealPrice * quantity * 100) / 100
     totalAmount += saleAmount
     return {
       skuId: item.skuId,
       productName: sku.spec_name,
       skuSpecName: sku.spec_name,
       productType: sku.product_type,
       sessionCount: sku.session_count,
       remainingSessions: sku.session_count,
       unitPrice,
       unitRealPrice,
       quantity,
       saleAmount,
       received: saleAmount,
       salesCategory: sku.sales_category || null,
       isRechargeCard: !!sku.is_recharge_card,
       isExperience: !!sku.is_experience
     }
   })
+  // 统一兜底（与有券路径 L391-392 对齐 + 与 staff order.js L446 对齐）
+  totalAmount = Math.round(totalAmount * 100) / 100
```

**变更 2（L391-392 不变，但确认 round 路径仍存在 — 防御未来重构）**：

保留 L391-392 现状即可（变更 1 已让无券路径走 round；有券路径在重算后仍 round 一次）。

**变更 3（ctx.result 显式 round 兜底，L620 / L634，防御漂移）**：

```diff
   if (prepaidFullPaid) {
     ctx.result = {
       orderNo,
       saleOrderId: orderNo,
-      totalAmount,
+      totalAmount: Math.round(totalAmount * 100) / 100,
       prepaidCardAmount: finalPrepaidCardAmount,
       paidAmount: finalPaidAmount,
       paymentMethod: finalPaymentMethod,
       status: '已支付',
       reason: 'prepaid_card_full',
       paymentParams: null,
     }
     return
   }

   ctx.result = {
     orderNo,
     saleOrderId: orderNo,
-    totalAmount,
+    totalAmount: Math.round(totalAmount * 100) / 100,
     prepaidCardAmount: finalPrepaidCardAmount,
     paidAmount: finalPaidAmount,
     paymentMethod: finalPaymentMethod,
     status: '待支付'
   }
```

> 注：变更 1 已经让 `totalAmount` 在写库前是干净 2 位小数，变更 3 是冗余防御，可选。如不做则保持 L620/L634 现状。

### 5.2 `fengyu-admin/src/actions/orders.ts`（**已拆出，本 ticket 不再覆盖**）

> **R2 修订**：原变更 4-5（admin orders.ts L902 / L997 加 `Math.round`）会破坏现有 `fengyu-admin/src/actions/__tests__/orders.test.ts` 中 L1042 `settledAmount + 0.005 < totalAmount` 的 0.005 浮点容差 case（admin 89% 覆盖率套件大概率回归），且与本 ticket 标题 `client-order-no-coupon-rounding` 语义不符。
>
> **拆为独立 ticket**：`notes/tickets/2026-05-17-admin-order-rounding-followup.md`（待创建）— 含以下子任务：
> 1. 先跑一次 `cd fengyu-admin && bun run test` 取 baseline
> 2. 列出会失败的具体 test name（预计 L1042 边界相关 case）
> 3. 同步调整 0.005 阈值或新增 mock 让"先 round 后比较"语义可被测试
> 4. 再实施 L902 / L997 / L1037 / L1042 的 round 收口
>
> staff 端无需改（聚合点已 round；L285 行级未 round 与 client 同症，但 DB 写入端等价 — 见 §4 修订）。

### 5.3 测试新增（R2 完全重写：用 Node 实测漂移 case + 不依赖具体值断言）

> **R2 修订**：原版三个 case（`5.55*3` / `35.50*3` / `19.99*7`）经 Node 实测**精确无漂移**（`5.55*3 === 16.65` / `35.50*3 === 106.5`）或方向错误（`19.99*7 === 139.92999999999998`，非 ticket 原写的 `139.93000000000004`）。若按 `toBe(16.65)` 写无券断言，**修复前就 toBe 通过**，证明不了浮点漂移、无法做 TDD 守护。下面用 Node 实测漂移 case 重写。

**Node 实测漂移基线**（断言依据）：

```
0.1 + 0.2     === 0.30000000000000004
0.1 * 3       === 0.30000000000000004
1.1 * 3       === 3.3000000000000003
0.2 * 3       === 0.6000000000000001
0.3 * 3       === 0.8999999999999999
0.29 * 100    === 28.999999999999996
```

新增 `fengyu-client/cloudfunctions/clientApi/__tests__/routes/order.rounding.test.js`：

```js
const { invoke } = require('../helpers')
const pg = require('../../db/pg')

jest.mock('../../db/pg')

/**
 * 断言原则（R2）：
 *   不使用 toBe(具体值)（虚构数值已被纠错，且业务夹具无 0.1 价档）；
 *   改用「小数位数 ≤ 2」语义断言：(value * 100) 必须是整数。
 *   覆盖 ctx.result.totalAmount + INSERT sale_orders.total_amount 参数双面。
 */
function expectAt2Decimals(value) {
  // value 必须是 number 且小数位 ≤ 2
  expect(typeof value).toBe('number')
  expect(Number.isInteger(Math.round(value * 100))).toBe(true)
  expect((value * 100) % 1).toBe(0) // 严格 0，浮点漂移会 fail
}

describe('order.create 浮点 round 兜底（R2 case）', () => {
  beforeEach(() => { /* mock pg.query / pg.transaction，注入 sku.special_price 为下方驱动值 */ })

  // case 1：经典 0.1 累加（mock sku.special_price = 0.1, quantity = 3）
  test('无券 0.1×3 ─ 浮点 saleAmount=0.30000000000000004 应 round 到 0.30', async () => {
    const ctx = await invoke('order.create', {
      items: [{ skuId: 'sku-mock-01', quantity: 3 }], // mock sku.special_price=0.1
    })
    expectAt2Decimals(ctx.result.totalAmount)
    // 修复前：ctx.result.totalAmount === 0.30000000000000004，会 fail
    // 修复后：=== 0.3
  })

  // case 2：1.1 × 3 = 3.3000000000000003
  test('无券 1.1×3 ─ 漂移 +3e-16', async () => {
    const ctx = await invoke('order.create', {
      items: [{ skuId: 'sku-mock-11', quantity: 3 }], // mock sku.special_price=1.1
    })
    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 3：0.2 × 3 = 0.6000000000000001
  test('无券 0.2×3 ─ 漂移 +1e-16', async () => {
    const ctx = await invoke('order.create', {
      items: [{ skuId: 'sku-mock-02', quantity: 3 }], // mock sku.special_price=0.2
    })
    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 4：0.3 × 3 = 0.8999999999999999（向 -∞ 漂）
  test('无券 0.3×3 ─ 反向漂移 -1e-16', async () => {
    const ctx = await invoke('order.create', {
      items: [{ skuId: 'sku-mock-03', quantity: 3 }], // mock sku.special_price=0.3
    })
    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 5：0.29 × 100 = 28.999999999999996（大整数 quantity 模拟批量）
  test('无券 0.29×100 ─ 大 quantity 累加漂移', async () => {
    const ctx = await invoke('order.create', {
      items: [{ skuId: 'sku-mock-29', quantity: 100 }], // mock sku.special_price=0.29
    })
    expectAt2Decimals(ctx.result.totalAmount)
  })

  // case 6：INSERT 参数同步断言（修复后 PG 收到的也应是干净 2 位）
  test('无券 1.1×3 ─ INSERT sale_orders.total_amount 第 11 参数 ≤ 2 位小数', async () => {
    await invoke('order.create', {
      items: [{ skuId: 'sku-mock-11', quantity: 3 }],
    })
    // pg.transaction.mock.calls[i] 的 INSERT 调用第 11 个参数（totalAmount）
    const insertCall = pg.transaction.mock.calls.find(c => /INSERT INTO sale_orders/.test(c[0]))
    const totalAmountParam = insertCall[1][10] // 第 11 个参数（索引 10）
    expectAt2Decimals(Number(totalAmountParam))
  })

  // case 7：有券路径不回归
  test('有券：原 L391-392 round 路径仍生效（回归）', async () => {
    /* mock couponInfo，断言 ctx.result.totalAmount 仍 ≤ 2 位 */
  })
})
```

**关键断言变更对比**：

| 项目 | 原版（R1） | 新版（R2） |
|------|-----------|-----------|
| 数值 case | `5.55*3` / `35.50*3` / `19.99*7`（虚构或方向反） | `0.1*3` / `1.1*3` / `0.2*3` / `0.3*3` / `0.29*100`（Node 实测漂移） |
| 断言方式 | `toBe(0.30)` / `toBe(16.65)` | `expectAt2Decimals()` = `(value*100) % 1 === 0` |
| 是否能在修复前 fail | ❌ 部分 case 修复前就 pass，无 TDD 价值 | ✅ 所有 case 修复前必 fail（漂移值 × 100 非整数） |
| 是否依赖具体 SKU 价档 | 要求 19.99 这种业务价档 | mock 注入 0.1/0.2/0.3 等纯测试驱动值，不污染业务夹具 |

---

## 6 验证 Checklist

### 6.1 单元测试（R2 修订）

- [ ] 新增 `client order.rounding.test.js`：覆盖 §5.3 R2 case（`0.1×3` / `1.1×3` / `0.2×3` / `0.3×3` / `0.29×100`，≥5 case）
- [ ] 断言用 `expectAt2Decimals()` 即 `(value * 100) % 1 === 0`，**不**用 `toBe(具体值)` 也不用 `toBeCloseTo`
- [ ] 断言 INSERT 参数 + ctx.result 双面验证
- [ ] admin `orders.test.ts` 补 case **已拆出独立 ticket**（见 §5.2）
- [ ] 全量 `cd fengyu-client/cloudfunctions/clientApi && npm test` 零回归
- [ ] 全量 `cd fengyu-staff/cloudfunctions/staffApi && npm test` 零回归（不改动但验证 baseline）
- [ ] 修复前应有 ≥5 case **fail**（验证 TDD 守护有效）；修复后应全部 pass

### 6.2 DB 校验 SQL（R2 扩表至四张金额表）

> **R2 修订**：经 `db/schema/order.ts` / `db/schema/prepaid-card.ts` 校对，扩展至全部金额表。注意 `sale_allocations` 表的金额列名是 **`total_amount`**（不是 `amount`）。
>
> 部署后跑（应均为 0 行）：

```sql
-- 1) sale_orders.total_amount / received / refunded_amount / prepaid_card_amount / payable_amount
SELECT sale_order_id, total_amount, total_amount::text AS raw_text
FROM sale_orders
WHERE total_amount::text ~ '\.\d{3,}'
   OR received::text ~ '\.\d{3,}'
   OR refunded_amount::text ~ '\.\d{3,}'
   OR prepaid_card_amount::text ~ '\.\d{3,}'
   OR payable_amount::text ~ '\.\d{3,}';

-- 2) sale_items.sale_amount / received / unit_real_price / unit_price
SELECT sale_item_id, sale_amount, received
FROM sale_items
WHERE sale_amount::text ~ '\.\d{3,}'
   OR received::text ~ '\.\d{3,}'
   OR unit_real_price::text ~ '\.\d{3,}'
   OR unit_price::text ~ '\.\d{3,}';

-- 3) sale_allocations.total_amount（列名 total_amount，不是 amount）
SELECT id, sale_item_id, employee_id, total_amount
FROM sale_allocations
WHERE total_amount::text ~ '\.\d{3,}';

-- 4) sale_order_payments.amount
SELECT id, sale_order_id, change_type, amount
FROM sale_order_payments
WHERE amount::text ~ '\.\d{3,}';

-- 5) card_transactions.amount（充值卡流水，db/schema/prepaid-card.ts L40）
SELECT id, card_id, type, amount
FROM card_transactions
WHERE amount::text ~ '\.\d{3,}';
```

> 预期：修复前可能均为空（PG `numeric(10,2)` 强制兜底，DB 不会存 3 位以上小数）；本 SQL 真正价值是审计**应用层是否曾把 ROUND 责任完全推给 DB 列类型**（与 audit-CC1 epic 同步），扫描结果同样应归档到 `notes/audit/CC1-floating-point-scan-2026-05-17.md`。

### 6.3 端到端冒烟（R2 修订：移除 0.10 SKU 假设）

> **R2 修订**：客户端业务夹具无 `0.1` / `0.29` 价档 SKU，原 `0.1 × 1 → 0.10` E2E case 移除；改用真实存量 SKU + 大 quantity 边界。

- [ ] client 下单 `unitRealPrice = 19.99 × quantity = 7` 无券（实测 `19.99 * 7 = 139.92999999999998`），确认返回 `totalAmount` 通过 `expectAt2Decimals()`（即 `(v*100)%1===0`，应等于 `139.93`）
- [ ] client 下单 `unitRealPrice = 99.99 × quantity = 10`（实测 `999.9000000000001`），确认 `totalAmount` 通过 `expectAt2Decimals()`
- [ ] 储值卡余额 `100.00`，无券订单 `unitRealPrice = 33.33 × quantity = 3` → `totalAmount = 99.99`，全额抵扣 → `prepaidCardAmount = 99.99, paidAmount = 0.00`
- [ ] manual-e2e/link-7-order-amount-check.spec.ts 增加 quantity ≥ 7 的浮点 case 并通过

### 6.4 三端一致性

- [ ] 同一商品组合（`19.99 × 7`），client / staff / admin 三端开单后 DB `sale_orders.total_amount` 完全一致
- [ ] 三端 returnPayload `totalAmount` 字段严格 toBe 相等

---

## 7 风险与回滚

### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| `Math.round` 银行家舍入与 PG numeric 半奇偶舍入差异 | 低 | JS `Math.round(x * 100) / 100` 是四舍五入到 +∞；PG numeric 是 half-even；理论 `.005` 边界 1/1000 单分歧；与 staff 一致即可 |
| 测试 mock 中浮点 SKU 价格触发 NaN/Infinity | 低 | Number.isFinite 校验已在 L444 / L463 上下文存在 |
| 行级 `saleAmount` round 改变 INSERT `sale_items.sale_amount` 列值 | 低 | PG 列 `numeric(10,2)` 本就会裁；改后是显式 round，语义更清 |
| 有券路径的 `received` 分摊（L375-389）依赖 `saleAmount` 比例 | 低 | `saleAmount` round 后比例分母变化 `5e-15` 级，分摊结果不变（且 L388 已有 `Math.round` 兜底） |

### 回滚

git revert 单一 commit 即可；不涉及 DB schema 变更、不涉及 cron / 后台批处理、无幂等键。

---

## 8 关联

| 关联项 | 关系 |
|--------|------|
| **SUMMARY v3 Top10 #5** | 本 ticket 来源 |
| **audit-CC1 P0-CC1-v2-01** | 横切模式"应用层金额浮点漂移"，本 ticket 是其 client 端实例 |
| **2026-04-26 sale-order-domain-refactor** | 引入了 `received` / `payable_amount`，本 ticket 修的是更上游的 totalAmount 累加 |
| **staff order.js L446** | 参考实现（已正确） |
| **admin orders.ts L997** | 次要修复目标（同源问题，受 toFixed 掩盖） |
| **manual-e2e/link-7-order-amount-check.spec.ts** | 验证脚本归属，应增加浮点 case |
| **db/schema/order.ts:59** | `total_amount numeric(10, 2)` 列定义（PG 兜底，但应用层不可依赖） |

---

## 复核反馈（R2，2026-05-17）

```
**Block 级问题**：
1. **测试 case 数值错误（会导致测试一开始就失败）**。ticket §2.1 与 §6.1 列出的浮点示例多数虚构：实测 `5.55*3 === 16.65`（精确，不漂移）、`35.50*3 === 106.5`（精确）、`19.99*7 === 139.92999999999998`（方向是"-2e-14"，不是 ticket 写的 `139.93000000000004`）。若按 §5.3 用 `toBe(16.65)` 写无券断言，**修复前就 toBe 通过**，证明不了浮点漂移、也无法做 TDD 守护。可用的真实漂移 case 是 `0.1+0.2`、`1.1*3=3.3000000000000003`、`0.1*8=0.8000000000000007` 等，必须重列。
2. **§5.3 测试断言 "toBe(0.30)" 与 §6.3 "totalAmount: 0.10" 站不住**：客户端没有 0.1 这个 SKU 价档，mock 强行注入也违背 product_kind 价表语义；新建 rounding 测试需用真实/夹具内能复现漂移的 quantity×price 组合（建议改用整型 quantity 大数 + `0.1` 型 special_price mock，写 `expect(Number.isInteger(totalAmount*100)).toBe(true)` 而非 toBe 具体值）。

**Warn 级问题**：
1. **staff 引用行号偏差**：ticket 写 staff L446，实测命中，但 staff L285 行级 `saleAmount = unitPrice * quantity` 也未 round（与 client 一样），ticket §4 表格脚注承认但 §1 表述"staff 已正确"会让读者忽略——admin 的"次要修复"成立时，staff 行级写入 `sale_items.sale_amount` 同样依赖 PG numeric 兜底，结论不一致。
2. **admin §5.2 变更 4-5 会破坏现有测试**：admin orders.ts L997 改为 `Math.round((rawTotalRounded - couponDiscount)*100)/100` 后，L1042 `settledAmount + 0.005 < totalAmount` 的边界从 `≥0.005` 收紧到精确 2 位差，admin 测试套（89% 覆盖率，含 orders.test.ts 边界 case）大概率回归。ticket 未提如何同步调 0.005 阈值或新增 mock。
3. **payNotify / confirmOffline 同源问题未列**：`clientApi/routes/order.js` L660-680 / L737-769 / L1340-1372 读 `order.total_amount`（PG 已 round 过的字符串）→ `Number()` 不会漂移；但 L803 `Math.round(thisPayAmount*100)` 这条线没问题。结论是 payNotify 不受同类问题影响，ticket 应显式声明"已审计 payNotify / confirmOffline 路径无同类漏 round"，避免读者误以为遗漏。

**OK**：
- client L240-247、L391-392 行号与代码内容**完全准确**。
- admin L902、L997、L1037、L1042、L1173、L1326 行号**完全准确**，`.toFixed(2)` 字符串化写库描述属实。
- staff L446 单一聚合点 round 描述属实。
- 方案 A（行级 round + 累加后 round）技术正确，不破坏 `finalPaidAmount = totalAmount`（L416）和 L463 `paidAmount` 计算语义——后者本已 `Math.round`，前者赋值的是已 round 的 `totalAmount`，无副作用。
- §1.4 关于"PG numeric(10,2) 隐式兜底，但应用层不可依赖"的论证充分（L416/L620/L634 直接 return 浮点给前端，确实绕开 PG）。
- §6.2 给的 DB 校验 SQL 思路对（用 `total_amount::text ~ '\.\d{3,}'` 扫漏），可用于 ticket §3 结尾要求的"历史数据扫漏"。

**改进建议**：
1. 重写 §5.3 与 §6.3 的浮点 case 表，用 Node 实测漂移的乘法（如 `0.1`/`1.1`/`2.2` 类小数 × 大整数），并把断言从 `toBe(具体值)` 改为 `expect((totalAmount*100) % 1).toBe(0)` 或快照 INSERT 第 11 个参数的 typeof / 小数位数。
2. §5.2 admin 变更必须先跑一遍 `cd fengyu-admin && bun run test` baseline，列出会失败的具体 test name，方案里给出对应 fixture 修改；或将 admin 修复拆为独立 ticket，本 ticket 仅修 client（与 ticket 标题"client-…"语义一致）。
3. §4 表格中 staff 行级 `saleAmount` 也无 round 的事实应升格到 §1，避免"staff 是参考标准"的过度断言；至少补一行"staff L285 行级未 round，但 L446 聚合 round 兜住，DB 写入端等价"。
4. §6.2 DB 校验 SQL 应同时加 `sale_allocations.amount`、`prepaid_card_transactions.amount`、`order_payments.amount` 三表扫描，便于一次性确认存量数据是否真的没漏（与 audit-CC1 epic 同步）。
5. 关联文档链接修正：`docs/audit/SUMMARY.md` 在仓内未验证存在，建议 ticket 头部"来源"行引用具体 SHA 或路径，避免后续 grep 不到失链。
```

### R2 处置记录

| 反馈项 | 处置 | 落点 |
|--------|------|------|
| Block 1 | 替换 §2.1 / §5.3 / §6.3 全部浮点示例为 Node 实测漂移 case | §2.1 新表 / §5.3 完全重写 / §6.3 删 0.10 SKU 假设 |
| Block 2 | 断言改为 `expectAt2Decimals()` = `(v*100)%1===0`，不再 `toBe(具体值)` | §5.3 |
| Warn 1 | staff L285 行级未 round 事实升格到 §1.2.a + §4 | §1.2.a 新增 / §4 表注 + 关键发现修订 |
| Warn 2 | admin 修复拆独立 ticket `2026-05-17-admin-order-rounding-followup.md`（待创建） | §5.2 改为"已拆出"说明块 |
| Warn 3 | payNotify / confirmOffline 路径显式声明已审计无同类漏 round | §4 新增"路径审计"块 |
| OK | 保持 §1 行号 / §4 staff L446 / 方案 A / §1.4 论证 / §6.2 SQL 思路 — 全部不动 | — |
| 改进 1 | 同 Block 1+2 | — |
| 改进 2 | 同 Warn 2（拆独立 ticket） | — |
| 改进 3 | 同 Warn 1 | — |
| 改进 4 | §6.2 扩展为 5 张表（注：`sale_allocations` 列名是 `total_amount` 不是 `amount`；`prepaid_card_transactions` 实际表名是 `card_transactions`；admin/order 不存在独立 `order_payments` 表，实际是 `sale_order_payments`） | §6.2 |
| 改进 5 | 头部"来源"行保留，建议执行 PR 时附实际 commit SHA（v2 摘要块说明） | v2 摘要 |
