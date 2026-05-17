---
ticket: admin orders.ts createOrder rawTotal/totalAmount round 收口（client 浮点修复的 admin 跟进）
date: 2026-05-17
severity: P1（防御性收口；admin 端 `.toFixed(2)` + 0.005 容差当前已掩盖资损，但破坏三端一致性）
端: fengyu-admin（主，本 ticket 唯一目标）
cost: XS（半小时实现 + 半小时测试 + 跑全套）
来源:
  - 拆出自 [2026-05-17-client-order-no-coupon-rounding.md](./2026-05-17-client-order-no-coupon-rounding.md) §5.2 + R2 修订 Warn 2
  - audit-CC1 跨端金额一致性 epic（client 端已修复，admin 跟进对齐）
关联:
  - 父 ticket [client-order-no-coupon-rounding](./2026-05-17-client-order-no-coupon-rounding.md)（已实施 2026-05-17）
  - staff `cloudfunctions/staffApi/routes/order.js` L446 聚合点 round（参考标准，本 ticket 不动）
状态: ✅ 已实施 2026-05-17
---

## 0 一句话背景

父 ticket `client-order-no-coupon-rounding` R2 修订把 admin 端修复**拆为独立 ticket**，原因有二：

1. **语义边界**：父 ticket 标题是 `client-...`，admin 修改混在一起会让 commit/diff 语义错位。
2. **测试风险评估**：当时复核认为「admin orders.ts L997 加 `Math.round` 后会破坏 L1042 `settledAmount + 0.005 < totalAmount` 边界 case」，需先跑 baseline、列失败 test、再实施。

本 ticket 落实 admin 端 round 收口，与 client/staff 三端聚合点 round 模式对齐。

---

## 1 修改范围

仅 `fengyu-admin/src/actions/orders.ts` 的 `createOrder` 函数（约 L900-1005）。

### 1.1 修改前关键代码

```ts
// L902-910：rawTotal / saleAmountTotal 无 round
const rawTotal = data.items.reduce((sum, item) => {
  const computed = Number(item.unitRealPrice) * item.quantity
  return sum + (item.received ? Number(item.received) : (item.saleAmount ? Number(item.saleAmount) : computed))
}, 0)
const saleAmountTotal = data.items.reduce((sum, item) => {
  return sum + (item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity)
}, 0)

// L994-997：couponDiscount / totalAmount 无 round
couponDiscount = calcCouponDiscount(coupon.couponType, String(coupon.discountValue), coupon.maxDiscount ?? null, saleAmountTotal)
const totalAmount = Math.max(0, rawTotal - couponDiscount)
```

### 1.2 修改后

```ts
// 行级 + 累加后双 round（与 staff order.js L446 / client order.js L267 三端对齐）
const rawTotal = Math.round(data.items.reduce((sum, item) => {
  const computed = Number(item.unitRealPrice) * item.quantity
  const itemAmount = item.received ? Number(item.received) : (item.saleAmount ? Number(item.saleAmount) : computed)
  return sum + Math.round(itemAmount * 100) / 100
}, 0) * 100) / 100

const saleAmountTotal = Math.round(data.items.reduce((sum, item) => {
  const itemSale = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
  return sum + Math.round(itemSale * 100) / 100
}, 0) * 100) / 100

// couponDiscount round + totalAmount 减券后再 round
couponDiscount = calcCouponDiscount(...)
couponDiscount = Math.round(couponDiscount * 100) / 100
const totalAmount = Math.round(Math.max(0, rawTotal - couponDiscount) * 100) / 100
```

### 1.3 未改动（已确认安全）

| 行号 | 代码 | 状态 |
|------|------|------|
| L1005 | `payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)` | 已 round |
| L1014 | `receivedAmount = Math.round(Number(data.receivedAmount) * 100) / 100` | 已 round |
| L1037 | `settledAmount = Math.round((receivedAmount + prepaidCardAmount) * 100) / 100` | 已 round |
| L1042 | `settledAmount + 0.005 < totalAmount` | 0.005 容差保留（兜底防御） |
| L1173 | `totalAmount: totalAmount.toFixed(2)` 等 | `.toFixed(2)` 串化掩盖保留 |
| L1326 | `logOperation(... totalAmount: totalAmount.toFixed(2))` | 同上 |

---

## 2 测试新增

`fengyu-admin/src/actions/orders.test.ts` 末尾追加 `describe('createOrder — 浮点 round 兜底（R2 真漂移 case）')`，5 case：

1. 无券 `0.1 × 3 = 0.30000000000000004` → 应聚合为 `'0.30'`
2. 无券 `1.1 × 3 = 3.3000000000000003` → 应聚合为 `'3.30'`
3. 无券 `0.29 × 100 = 28.999999999999996` → 应聚合为 `'29.00'`
4. 无券多商品 `0.1×3 + 0.2×3` → 应聚合为 `'0.90'`
5. 有券回归 `0.29 × 7 - 0.50` → totalAmount 严格 2 位

断言双面：
- `expectStringAt2Decimals(captured.order.totalAmount)` — DB 字符串严格 `/^-?\d+\.\d{2}$/`
- `expectAt2Decimals(Number(...))` — `(value * 100) % 1 === 0`

### 2.1 ⚠️ 测试 TDD 价值有限（诚实声明）

admin 端 `.toFixed(2)` 串化（L1173/L1326）+ `0.005` 容差（L1002/L1019/L1042）已在 DB 写入层 + 状态判定层完全掩盖浮点漂移。**新测试在修复前后均 pass**（与 client 端 TDD case 不同）。

| 测试用途 | 实际作用 |
|---------|---------|
| TDD 驱动 | ❌ 无 — `.toFixed(2)` 让 `Number('0.30') === 0.30` 永远成立 |
| 回归守护 | ✅ DB 字符串永远 ≤ 2 位 |
| 三端一致性守护 | ✅ admin/staff/client 三端聚合 round 行为对齐 |
| 未来 load-bearing | ✅ 若后续移除 `.toFixed(2)`（如改用 PG numeric 原生类型）或收紧 0.005 容差，测试自动 fail |

测试 docblock 已显式标注此性质。

---

## 3 验证 Checklist

### 3.1 单元测试

- [x] `bun run test --run src/actions/orders.test.ts`：108 case，4 fail（全部 pre-existing baseline，与 error-code-prefix 改造相关，与本 ticket 无关），104 pass，含 5 个新 round case 全 pass
- [x] 全套 `bun run test`：940 case，9 fail（全部 pre-existing，分布在 orders/cards/products），931 pass，**零新增回归**
- [x] `npx tsc --noEmit`：`orders.ts` 无新错误（pre-existing `card-transactions.ts:194` ts 错误与本次无关）

### 3.2 三端一致性

- [x] admin / staff / client 三端 `totalAmount` 聚合点全部走 `Math.round(... * 100) / 100`
- [ ] 同一商品组合（`19.99 × 7`），三端开单后 DB `sale_orders.total_amount` 完全一致（人工对账，未自动化）

---

## 4 风险与回滚

### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 改 admin rawTotal/saleAmountTotal 累加逻辑破坏已有 totalAmount 字符串断言（'200.00' / '495.00' / '980.00' 等 ~15 处） | 低 | 已确认全部 case 输入是整 2 位价档，round 不改变值 |
| L1042 `settledAmount + 0.005 < totalAmount` 边界被收紧 | 极低 | 改后 totalAmount 也是整 2 位，0.005 容差从"防漂移"变"冗余"，无害 |
| 改 couponDiscount round 让折扣券 `0.8` 折场景金额偏移 1 分 | 极低 | calcCouponDiscount 输出再 round 与 `.toFixed(2)` 串化结果等价 |

### 回滚

`git revert <commit>` 单一 commit 即可；不涉及 DB schema / cron / 后台批处理 / 幂等键 / 跨服务调用。

---

## 5 关联

| 关联项 | 关系 |
|--------|------|
| 父 ticket [`2026-05-17-client-order-no-coupon-rounding`](./2026-05-17-client-order-no-coupon-rounding.md) | 本 ticket 是其 R2 修订拆分而来 |
| audit-CC1 P0-CC1-v2-01 | 横切模式「应用层金额浮点漂移」三端最终收口 |
| staff `cloudfunctions/staffApi/routes/order.js` L446 | 参考标准（聚合点 round），本 ticket 不动 |
| client `cloudfunctions/clientApi/routes/order.js` L267 | 父 ticket 已修，行级 + 累加后双 round |

---

## 6 实施记录（2026-05-17）

| 步骤 | 结果 |
|------|------|
| baseline 跑 `bun run test --run src/actions/orders.test.ts` | 103 case，4 fail（pre-existing CLIENT_NOT_REGISTERED / MIXED_PAYMENT_NOT_SUPPORTED 错误前缀），99 pass |
| 扫 `0.005` / `0.001` / `Math.round` 在 test 中的引用 | 无任何边界 case 使用 `0.005` 容差测试 → 父 ticket 复核的 "L1042 0.005 边界 case 会失败" 风险**未兑现** |
| 实施 4 处 round 收口（rawTotal / saleAmountTotal / couponDiscount / totalAmount） | edit 完成 |
| 跑 orders.test.ts post-patch | 103 → 99 pass 不变（zero 新增回归） |
| 添加 5 个 round 测试 case | 108 case，4 fail（同 baseline），104 pass |
| TDD 反向验证（stash 还原 orders.ts） | 5 个新 case **依然 pass** → 确认 `.toFixed(2)` 完全掩盖；测试定位为回归守护而非 TDD |
| 跑全套 `bun run test` | 940 case，9 fail（全部 pre-existing），931 pass，零新增回归 |
| `npx tsc --noEmit` | 无新错误（card-transactions.ts:194 pre-existing） |
