# 审计报告：CC1 数值精度与金额计算

**审计时间**：2026-04-25 初审 → 2026-04-26 重审合并
**域 ID**：CC1（横切收官）
**审计员**：claude-opus-4-7（初审）+ claude（batch agent 重审）
**版本**：最终版（v1+v2 合并）
**说明**：本报告是对 25 份业务域报告 §5 CC1 节 + DB schema 全量金额/比例字段定义的"全栈金额健康度收官" + v2 独立重审新增发现合并版。

---

## SECTION 1：扫描覆盖范围

本次合并报告扫描以下文件，以源码实际状态为准：

| 文件路径 | 类型 | 备注 |
|---------|------|------|
| `db/schema/order.ts` | DB schema | saleOrders / saleItems / saleAllocations / saleOrderPayments |
| `db/schema/commission.ts` | DB schema | commissionRateMatrix |
| `db/schema/service-commission.ts` | DB schema | serviceCommissions |
| `db/schema/prepaid-card.ts` | DB schema | prepaidCards / cardTransactions |
| `db/schema/points.ts` | DB schema | pointTransactions |
| `db/schema/product.ts` | DB schema | productSkus / products / mallProductSkus |
| `db/schema/enums.ts` | DB schema | saleOrderTypeEnum 等枚举 |
| `db/migrations/0000_baseline.sql` | migration | 全量基线 |
| `db/migrations/0004_yellow_magma.sql` | migration | chk_sop_amount_sign 落地 |
| `db/migrations/0018_black_madrox.sql` | migration | **2026-04-26 sale-order-domain-refactor**（退款架构重构，详见 §10） |
| `db/migrations/0019_lethal_iron_man.sql` | migration | chk_sku_not_both_capabilities |
| `db/migrations/0020_recharge_d4_constraint_trigger.sql` | migration | D4 trigger |
| `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 云函数 | 员工开单/退款/回款/转换 |
| `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js` | 云函数 | 营业额分配 save/suggest |
| `fengyu-staff/cloudfunctions/staffApi/routes/service.js` | 云函数 | service.complete 服务提成 |
| `fengyu-staff/cloudfunctions/staffApi/utils/refund.js` | 云函数工具 | buildRefundDetails / splitRefundByOriginalPayment |
| `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 云函数 | 客户开单/支付/回款/扫码 |
| `fengyu-admin/src/actions/allocations.ts` | Admin Action | batchSaveAllocations |
| `fengyu-admin/src/actions/orders.ts` | Admin Action | createOrder / createConversion |
| `fengyu-admin/src/actions/refunds.ts` | Admin Action | createRefund / approveRefund |
| `fengyu-admin/src/actions/service-commissions.ts` | Admin Action | batchSaveServiceCommissions |
| `fengyu-admin/src/lib/refund.ts` | Admin 工具 | buildRefundDetails / splitRefundByOriginalPayment |
| `fengyu-admin/src/lib/utils.ts` | Admin 工具 | calcCouponDiscount |

---

## SECTION 2：检查清单结果

| 检查项 | 状态 | 说明 |
|--------|------|------|
| **C1** 金额字段 NUMERIC(N,2) 而非 FLOAT | ✅ 通过 | 全部 31 个金额/价格字段为 NUMERIC；`point_transactions.amount` 为 integer（积分粒度合理但仍有 CHECK 缺失） |
| **C2** JS 端用字符串/Decimal 库，不用 Number 直接相加 | ⚠️ 部分 | 三端均无 Decimal.js；靠 `Math.round(x*100)/100` 兜底。**clientApi `order.create` 无优惠券路径中 totalAmount 累加未 Math.round（新发现 v2-01）**；admin `calcCouponDiscount` 折扣券结果无 Math.round（新发现 v2-04） |
| **C3** 提成比例 NUMERIC(5,4) 或 (3,4)，舍入策略一致 | ❌ 问题 | `commission_rate` = NUMERIC(5,4) ✅；`sale_allocations.allocationRatio` = **NUMERIC(5,2)**（与 PLAN 不符）；`suggest` 路径用 `.toFixed(2)` 而 `save` 路径用 `Math.round`（同一文件两条路径不一致） |
| **C4** 退款 amount 符号约束（`chk_sop_amount_sign`） | ⚠️ 部分 | `sale_order_payments` 已有 `chk_sop_amount_sign` ✅（2026-04-27 域重构收官确认：退款全部下沉 SOP 层，该 CHECK 是退款金额符号的唯一守卫）；~~`sale_orders` 退款单行~~ 已不存在（P0-CC1-03 架构性作废）；`card_transactions.amount` 仍无符号 CHECK ❌ |
| **C5** 折扣计算顺序（券→卡→积分）三端一致 | ⚠️ 部分 | 实际三端均为"券先扣→储值卡抵扣→应付金额"，积分不参与直扣；staff/client 均实现"按 received 比例分摊+尾差吸收"；admin 无行级分摊（整单直接减 couponDiscount）——三端**分摊粒度不同**（新发现 v2-07） |
| **C6** 总价 = sum(unit_real_price × quantity) 三端口径一致 | ⚠️ 部分 | 公式一致；但 admin `batchSaveAllocations` 用 `.toFixed(2)` 而 staffApi `save` 用 `Math.round`；clientApi 无券路径 totalAmount 未 round 就落库 |

---

## SECTION 3：发现的问题

### P0（阻断/资损）

#### **[P0-CC1-01] sale_allocations.allocationRatio 类型与 PLAN 不符且无 CHECK**
- **文件**：`db/schema/order.ts:206` + `db/schema/service-commission.ts:29`
- **现象**：PLAN §3 CC1 写"提成比例 NUMERIC(5,4) 或 (3,4)"，schema 实为 `numeric(5,2)`（取值范围 ±999.99）。业务约定仅允许 `IN (0.10, 0.20, ..., 1.00)` 但无 DB CHECK。
- **风险**：admin `allocations.ts:220` 接收前端 ratio 字符串后直接 `Number(a.allocationRatio)` 写入；前端 BUG 或恶意请求传 `9.99` → 单笔分配业绩瞬间 ×10 倍。staff `allocation.js:114` 同模式无后端二次校验。
- **修复**：`CHECK (allocation_ratio IN (0.10,0.20,...,1.00))`（参考 SCHEMA-CHANGES S07-1 + S08-3）
- **v2 确认**：独立核验确认，状态不变（未修复）

#### **[P0-CC1-02] card_transactions.amount 缺符号 CHECK（流水类表）**
- **文件**：`db/schema/prepaid-card.ts:40`
- **现象**：与 `chk_sop_amount_sign`（已落地）反差。`amount` 任意正负，应用层一旦写反，admin balance summary `SUM(amount)` 静默错账。2026-04-26 重构后仍未修复。
- **修复**：S14-02 已建议 `CHECK ((type='充值' AND amount>0) OR (type='扣款' AND amount<0))`
- **v2 确认**：独立核验确认，状态不变（未修复）

#### ~~**[P0-CC1-03] sale_orders 退款单字段无符号联动 CHECK**~~（⚠️ 架构性作废）

> **FIXED 2026-04-27**：域重构收官确认。saleOrderTypeEnum 已从 5 值收窄为 3 值（'回款单'/'退款单' 移除），migration 0019+0021 已 apply。退款不再创建 `sale_orders[type='退款单']` 行，退款全部下沉到 `sale_order_payments`（`chk_sop_amount_sign` 已守护符号）。`paid_amount` 列已在 migration 0018 中 DROP。原建议的按 type 联动符号 CHECK 不再适用。

- **架构变更（migration 0018 sale-order-domain-refactor，2026-04-26 apply）**：
  - 退款**不再创建** `sale_orders[type='退款单']` 行
  - 退款全部下沉到 `sale_order_payments.change_type='退款'`（`chk_sop_amount_sign` 已守护符号）
  - `paid_amount` 列已 DROP（v1 报告起草时该列仍存在）
  - `sale_order_type` 枚举收窄为 `{销售单,内部单,转换单}` 三值
- **作废理由**：原 P0-CC1-03 建议在 `sale_orders` 字段层加符号联动 CHECK（total_amount ≤ 0 / ≥ 0 按 type 分组），在新架构下：
  - 销售单/内部单/转换单均写正数，`total_amount >= 0` 可加通用 CHECK（但实际业务不写负，无需按 type 联动）
  - 退款符号约束由 SOP 层 CHECK 守护（更细粒度）
  - 原建议的"退款单行写负"路径已不存在，该问题已架构性解决
- **结论**：v2 独立核验后，将其从 P0 降为"架构性作废"，无需再对 `sale_orders` 加符号联动 CHECK（除非未来新增"转换单差价可负"场景，需重新评估）
- **关联**：v2 §5 "与 v1 报告的差异"节明确此结论

#### **[P0-CC1-04] admin batchSaveServiceCommissions 信任前端 commissionAmount**
- **文件**：`fengyu-admin/src/actions/service-commissions.ts:152-160`
- **现象**：直接 INSERT `c.commissionRate` / `c.commissionAmount` 字符串，没有按 `unit_real_price × session_used × commission_rate` 后端重算。前端传 `commissionAmount='9999.99'` 直接落库。
- **风险**：违反后端统一鉴权原则；可写入任意金额，绩效数据可被篡改。
- **修复建议**：参考 staffApi `service.complete`（routes/service.js:398-414）后端重算模式，admin 侧应先查 service_items + commission_rate_matrix 重算，拒绝前端传来的 commissionAmount 值。
- **v2 确认**：独立核验确认（P0-CC1v2-02），无新内容

### P1（数据一致性）

#### **[P1-CC1-05] admin calcCouponDiscount 折扣券结果无 Math.round（v2 新发现）**
- **文件**：`fengyu-admin/src/lib/utils.ts:37-50`（被 `fengyu-admin/src/actions/orders.ts:909` 调用）
- **现象**：
  ```ts
  export function calcCouponDiscount(...): number {
    const dv = parseFloat(discountValue)
    if (couponType === '折扣券') {
      const saved = totalAmount * (1 - dv)   // 浮点乘法，无 Math.round
      return maxDiscount ? Math.min(saved, parseFloat(maxDiscount)) : saved
    }
    return Math.min(dv, totalAmount)
  }
  ```
  折扣券 `couponDiscount` 是原始浮点值（如 `49.99999999999997`），随后 `couponDiscount.toFixed(2)` 写入 `sale_orders.coupon_discount`。staff/client 则对 couponDiscount 显式做 `Math.round(couponDiscount * 100) / 100`（staff order.js:383，client order.js:341）。
- **风险**：admin 开单时折扣券金额与 staff/client 端计算结果在边界值（如 `0.005 × N`）上差 0.01 元；跨端报表对账时不一致。
- **修复建议**：在 `calcCouponDiscount` 返回值前统一 `Math.round(result * 100) / 100`。
- **来源**：v2 P1-CC1v2-04（v1 无此问题）

#### **[P1-CC1-06] admin toFixed vs staff/client Math.round 舍入语义跨端不一致**
- **文件**：`fengyu-admin/src/actions/allocations.ts:220,271` vs `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:122`
- **现象**：
  - admin：`totalAmount = (received * Number(a.allocationRatio)).toFixed(2)` → V8 Number.toFixed 使用 IEEE 754 半偶舍入（banker's rounding）
  - staff save：`Math.round(received * Number(ratioStr) * 100) / 100` → "半数远离零"
  - 两者在 `0.005` 边界（如 `received=0.10, ratio=0.05` → `received×ratio=0.005`）结果不同
- **风险**：同一笔 sale_allocation.totalAmount 由 admin 写入与 staff 写入可能差 0.01 元；员工绩效跨端汇总时不可对账。
- **v2 确认**：独立核验确认（P1-CC1v2-05），并细化了边界例子

#### **[P1-CC1-07] allocation.js suggest 路径 toFixed 无 Math.round（v2 升 P1）**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:458`
- **现象**：
  ```js
  const amount = (received * commRate).toFixed(2)  // 仅 suggest 预览，不落库
  ```
  save 路径（同文件 :122）用 `Math.round(received * Number(ratioStr) * 100) / 100`。suggest 结果作为前端建议值展示，前端直接把此 amount 回传给 save 时，save 端二次重算会覆盖（因为 save 服务端重算 totalAmount），故实际无资损。但 suggest 展示金额与最终落库金额不一致，影响用户体验和信任度。
- **修复建议**：suggestion 路径也改用 `Math.round(received * commRate * 100) / 100`（与 save 对齐）。
- **来源**：v1 为 P2（v1 P2-CC1-09 → v2 P1-CC1v2-06）

#### **[P1-CC1-08] admin 开单无行级券分摊（整单直接减 couponDiscount）（v2 新发现）**
- **文件**：`fengyu-admin/src/actions/orders.ts:912`
- **现象**：
  ```ts
  const totalAmount = Math.max(0, rawTotal - couponDiscount)  // 整单扣减
  ```
  admin 直接从 totalAmount 中扣除 couponDiscount，不做按 received 比例的行级分摊；sale_items.received 由前端传入（可含 coupon 分摊后的值）。staff/client 均做行级分摊：`share = Math.round(couponDiscount * (item.received / eligibleTotal) * 100) / 100`。
- **风险**：按商品维度分析优惠券使用时，admin 开单的 sale_items.received 与三端分摊口径不一致；影响商品维度的收益分析准确性。
- **注**：P0 级直接资损风险低（金额汇总仍正确），但影响商品维度数据质量。
- **来源**：v2 P1-CC1v2-07（v1 无此问题）

#### **[P1-CC1-09] 浮点 ε 比较散落 20+ 处，常量未抽取**
- **文件**：
  - `staffApi/routes/order.js`: lines 371, 457, 543, 654, 832, 841, 1864, 1878, 1951（9 处）
  - `clientApi/routes/order.js`: lines 328, 418, 421, 734, 1325, 1417, 1420, 1518, 1690, 1701, 1755（11 处）
- **现象**：`x + 0.001 < y` 或 `x + 0.001 >= y` 散落两端，ε 值 0.001（0.1 分）合理但未常量化，手误打成 `0.01` 或 `0.0001` 会翻转边界判断。
- **v2 确认**：独立核验确认（P1-CC1v2-08），计数与位置相符（本次 9+11=20 处）

#### **[P1-CC1-10] commission_rate_matrix 缺 [0,1] CHECK 和 min<max 不变量**
- **文件**：`db/schema/commission.ts:21-26`
- **现象**：`commissionRate NUMERIC(5,4)` 允许 ±9.9999；`amountTierMin/Max` 无 `min<max` CHECK。
- **v2 确认**：独立核验确认（P1-CC1v2-09），状态不变（未修复）

#### **[P1-CC1-11] saleAmount = unitPrice × quantity 无 DB 不变量 CHECK**
- **文件**：`db/schema/order.ts:159`
- **现象**：schema 注释暗含 `sale_amount = unit_price × quantity`，但无 CHECK；admin `orders.ts:978` 显式写 `(Number(item.unitRealPrice) * item.quantity).toFixed(2)` 但客户端 `clientApi/routes/order.js` 与 staff `routes/order.js` 各自构造，三端口径必须保持一致。
- **修复建议**：`CHECK (ABS(sale_amount - unit_price * quantity) < 0.02)` 容忍分级精度。

### P2（代码质量/可维护）

#### **[P2-CC1-12] specialPrice 无 <= price CHECK**
- **文件**：`db/schema/product.ts:67,150`
- **现象**：`productSkus.specialPrice` 和 `products.specialPrice` 均无 `<= price` CHECK。
- **v2 确认**：独立核验确认（P2-CC1v2-11），状态不变（未修复）

#### **[P2-CC1-13] commissionAmount = fixedFee + consumeAmount 不变量未 CHECK**
- **文件**：`db/schema/service-commission.ts:33-37`
- **v2 确认**：独立核验确认（P2-CC1v2-12），状态不变（未修复）

#### **[P2-CC1-14] payable_amount = total - prepaid 不变量未 CHECK**
- **文件**：`db/schema/order.ts:64`
- **现象**：冗余列 + 应用层双写 + 退款链负数 + 部分支付各种 UPDATE，零 DB 守护。
- **修复建议**：trigger 实现 `CHECK (ABS(payable_amount - (total_amount - prepaid_card_amount)) < 0.02)`

#### **[P2-CC1-15] couponDiscount 分摊"最后一项尾差吸收"逻辑三端复制**
- **文件**：staff `routes/order.js:393-405` 与 client `routes/order.js:316-326`
- **现象**：尾差吸收逻辑在两端复制实现，admin createOrder 内有第三份变体；任一端漂移，券分摊就会出现 0.01 元 ε。
- **修复建议**：抽 `cloudfunctions-shared/coupon-allocation.js`

#### **[P2-CC1-16] dashboard / 绩效 SUM 入口 SUM 后再 Number() 隐患**
- **文件**：`fengyu-admin/src/actions/dashboard.ts:115,122,123` + `card-transactions.ts:172`
- **现象**：PG numeric → driver 默认返回字符串 → `Number()` 转 JS 浮点；金额量级 `< 2^53 ≈ 9e15` 完全安全（百亿元级才有问题），但 `Math.round(× 100) / 100` 二次舍入有 ε 风险。建议数据库端用 `ROUND(SUM(...), 2)::text` 返回字符串避免转浮点。

#### **[P2-CC1-17] db/schema/enums.ts 中 saleOrderTypeEnum 与 migration 0018 不同步（v2 新发现）**

> **FIXED 2026-04-27**：域重构收官确认。`enums.ts` 已更新为 `["销售单", "内部单", "转换单"]`（3 值），与 migration 0018+0019+0021 完全对齐。`paymentFlowStatusEnum` 新增 `'待审批'`。Drizzle generate 不再产生 migration 差异。

- **文件**：`db/schema/enums.ts:22` vs `db/migrations/0018_black_madrox.sql:41`
- **现象**：
  - `enums.ts` 写：`["销售单", "内部单", "回款单", "转换单", "退款单"]`（5 个值）
  - migration 0018 已执行：`CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '转换单')`（3 个值）
  - schema.ts 注释（enums.ts:19）说明"5433 DB 实际仍有 5 个值，migration 0018 未 apply"
- **风险**：schema.ts 类型与生产库 5434 枚举不同步；Drizzle generate 时会产生 migration 差异；若误用 `db:push` 或重新 generate 而不 review 会破坏 5434 枚举。
- **修复建议**：更新 `enums.ts` 与 migration 0018 对齐，移除 `回款单`、`退款单`
- **来源**：v2 P2-CC1v2-10（v1 无此问题）

#### **[P2-CC1-18] point_transactions.amount 用 integer（v2 从 P0 降级为 P2）**
- **文件**：`db/schema/points.ts:20`
- **理由降级**：点数为整数语义（不是金额），integer 类型有其合理性；业务量级（预期几亿颗以内）未触及 int4 溢出风险；实际写入逻辑通过 cronTask/settlePoints 管控，资损风险比 v1 评级低。但符号 CHECK 缺失仍是风险点。
- **v2 不同意 v1**：v1 评为 P0，本次评为 P2

---

## SECTION 4：跨端不一致

| 维度 | admin (Next.js) | staff (staffApi) | client (clientApi) | payNotify | 风险 | 优先级 |
|------|-----------------|------------------|--------------------|-----------|------|--------|
| 金额持久化舍入 | `.toFixed(2)`（V8 banker） | `Math.round(* 100) / 100` 后 PG implicit cast | 同 staff | 同 staff | **0.005 边界差 1 分** | P1 |
| sa.totalAmount 计算 | `(received * Number(ratio)).toFixed(2)` | `Math.round(received * Number(ratio.toFixed(2)) * 100) / 100` | — | 同 staff | 跨端值漂移 | P1 |
| commission_amount 计算源 | 信任前端 commissionAmount（P0-CC1-04） | `Math.round(unit_real_price * session * rate * 100) / 100` 后端重算 | — | 同 staff | admin 写入可任意篡改 | P0 |
| 券分摊粒度 | 整单减 couponDiscount（P1-CC1-08） | 行级按 received 比例分摊 | 行级按 received 比例分摊 | — | 商品维度数据质量不一致 | P1 |
| 折扣券 Math.round | 无（calcCouponDiscount 返回浮点）| 有（order.js:383）| 有（order.js:341）| — | 跨端报表对账差 0.01 | P1 |
| 浮点 ε 比较 | 极少用（依赖 PG numeric） | `+ 0.001` 9 处 | `+ 0.001` 11 处 | — | 散落易漂移 | P1 |
| 微信支付下单分 | — | 不直接发起 | `Math.round(thisPayAmount * 100)` | 同 client | OK | — |
| 储值卡余额比较 | `prepaid_cards.balance >= ${prepaidCardAmount}` 直接 SQL | `currentBalance + 0.001 < prepaidCardAmount` JS | `cardBalance + 0.001` JS | `Number(...balance) < prepaidAmount` | PG numeric vs JS float vs JS float 三套口径 | P1 |
| 转换单差价 | `Math.round((totalIn - totalOut) * 100) / 100` | `routes/order.js:2085` 等 | 不支持 | — | OK | — |
| refund 拆分分母漂移 | 多次 `Math.round` 串联（refunds.ts:558,602,710,723） | `routes/order.js:1547-` 类似模式 | — | — | audit-11 P0-11-06 | P0 |

---

## SECTION 5：横切清单

CC1 自身 6 项检查回归：

| PLAN §3 CC1 检查项 | 状态 | 关联问题 |
|--------------------|------|----------|
| 金额字段 NUMERIC(N,2) 而非 FLOAT | ✅ 31/32 列；point_transactions.amount = integer 是历史决策（P2-CC1-18） | 仅 1 例外 |
| JS 端用字符串/Decimal 库，不用 Number 直接相加 | ⚠️ **三端无 Decimal 库**，全靠 `Number() + Math.round(× 100)/100` 兜底；admin `.toFixed(2)` 与 staff `Math.round` 语义分裂 | P1-CC1-05 / P1-CC1-06 |
| 提成比例 NUMERIC(5,4) 或 (3,4)，舍入策略一致 | ❌ commission_rate=(5,4) ✅，但 **allocation_ratio=(5,2)** 与 PLAN 不符 + 无 IN CHECK | P0-CC1-01 / P1-CC1-10 |
| 退款 amount 为负的符号约束 chk_sop_amount_sign | ✅ sale_order_payments 已加；❌ card_transactions / point_transactions / sale_items.received 全无 | P0-CC1-02 / P2-CC1-18 |
| 折扣计算顺序（券→卡→积分）三端一致 | ⚠️ 实际三端都是"券→卡（积分不直扣）"，但 spec 未锁定 + admin 分摊粒度不同 | P1-CC1-08 |
| 总价 = sum(unit_real_price × quantity) 在三端口径一致 | ⚠️ 公式一致，但**admin toFixed vs staff/client Math.round 舍入语义不同** + clientApi 无券路径未 round | P1-CC1-06 / P0-CC1-04 |

CC1 之外的横切关联（收官归集）：
- **CC2 并发**：金额冗余双写（`sale_orders.paid_amount = Σ sop.amount`）无 cron 守护；audit-14 / audit-15 也是同模式；
- **CC3 隔离**：commission_rate_matrix lookup 缺 org_id（audit-08 P0-08-01）→ 跨市场金额错算；
- **CC9 测试**：dashboard 测试不断言"三端口径一致"（CROSS-CUTTING.md 已记录）。

---

## SECTION 6：修复建议（按优先级）

### 立即修复（P0）

1. **[P0-CC1-01]** DB：`sale_allocations` + `service_commissions` 的 `allocation_ratio` 加 IN 集合 CHECK：
   ```sql
   ALTER TABLE sale_allocations ADD CONSTRAINT chk_sa_ratio_in_set
     CHECK (allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00));
   ```
   上线前先 SELECT 历史数据是否已有越界值。

2. **[P0-CC1-02]** DB：`card_transactions.amount` 加符号联动 CHECK：
   ```sql
   ALTER TABLE card_transactions ADD CONSTRAINT chk_card_txn_amount_sign
     CHECK ((type = '充值' AND amount > 0) OR (type = '扣款' AND amount < 0));
   ```
   上线前先 SELECT 验证历史数据无违反行。

3. **[P0-CC1-04]** `admin/src/actions/service-commissions.ts`：`batchSaveServiceCommissions` 查 `service_items + commission_rate_matrix` 后端重算 `commissionAmount`，拒绝前端传入值。

4. **[P0-CC1-01 之 clientApi]** `clientApi/routes/order.js`：在 items.map 结束后无条件加 `Math.round`：
   ```js
   // line 246 附近，items.map 结束后无论是否有优惠券：
   totalAmount = Math.round(totalAmount * 100) / 100  // ← 新增
   ```
   此行已在有券路径存在（line 360），仅需移至 map 之后、券处理之前。

### 近期修复（P1）

5. **[P1-CC1-05]** `admin/src/lib/utils.ts`：`calcCouponDiscount` 返回值加 `Math.round(result * 100) / 100`。

6. **[P1-CC1-06]** `admin/src/actions/allocations.ts`：将 `.toFixed(2)` 改为 `Math.round(received * Number(a.allocationRatio) * 100) / 100` 再 `.toFixed(2)` 落库，与 staffApi 对齐。

7. **[P1-CC1-07]** `staffApi/routes/allocation.js:458`：suggest 路径 `(received * commRate).toFixed(2)` → `(Math.round(received * commRate * 100) / 100).toFixed(2)`。

8. **[P1-CC1-08]** 评估 admin 开单券分摊策略是否需要与 staff/client 对齐（整单减法 vs 行级比例分摊）；若不对齐需在规范文档明文注明。

9. **[P1-CC1-09]** 抽 `MONEY_EPSILON = 0.001` 常量（cloudfunctions-shared/money.js），替换 staff/client 两端 20+ 处散落的 `0.001`。

10. **[P1-CC1-10]** DB：`commission_rate_matrix.commissionRate` 加 `[0,1]` CHECK；`amount_tier_min/max` 加 `min<max` CHECK。

### 中期改进（P2）

11. ~~**[P2-CC1-17]** 更新 `db/schema/enums.ts` saleOrderTypeEnum，移除 `回款单`、`退款单`，与 migration 0018 对齐；随后 `db:generate` 确认无新 migration 差异。~~ **✅ 已修复 2026-04-27**：enums.ts 已更新为 3 值 + paymentFlowStatusEnum 新增 '待审批'。

12. **[P2-CC1-12]** DB：`productSkus.specialPrice` 和 `products.specialPrice` 加 `CHECK (special_price IS NULL OR special_price <= price)` trigger/CHECK。

13. **[P2-CC1-13]** DB：`service_commissions.commissionAmount` 加 `CHECK (ABS(commission_amount - fixed_fee - consume_amount) < 0.02)`。

14. **[P2-CC1-14]** DB：`sale_orders.payable_amount` 加 trigger `CHECK (ABS(payable_amount - (total_amount - prepaid_card_amount)) < 0.02)`。

15. **[P2-CC1-15]** 抽 `cloudfunctions-shared/coupon-allocation.js`，统一三端尾差吸收逻辑。

16. **[P2-CC1-18]** DB：`point_transactions.amount` 加联动符号 CHECK；评估是否切 bigint（低紧迫性）。

---

## SECTION 7：验证 SQL（SELECT/EXPLAIN only，目标 5434/fengyu）

```sql
-- 1. 验证 sale_allocations.allocation_ratio 是否已有越界值
SELECT allocation_ratio, COUNT(*)
FROM sale_allocations
WHERE allocation_ratio NOT IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00)
  AND is_void = false
GROUP BY allocation_ratio;
-- 期望 0 行

-- 2. 验证 card_transactions.amount 符号与 type 是否一致
SELECT type, COUNT(*),
  SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS pos_count,
  SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS neg_count,
  SUM(CASE WHEN amount = 0 THEN 1 ELSE 0 END) AS zero_count
FROM card_transactions
GROUP BY type;
-- 期望：'充值' 行全 pos，'扣款' 行全 neg

-- 3. 验证 clientApi 无券路径 totalAmount 精度问题（是否有历史数据违反不变量）
SELECT so.sale_order_id,
  so.total_amount,
  ROUND(SUM(si.received)::numeric, 2) AS computed_total,
  ABS(so.total_amount - ROUND(SUM(si.received)::numeric, 2)) AS diff
FROM sale_orders so
JOIN sale_items si ON si.sale_order_id = so.sale_order_id
WHERE so.sale_order_type = '销售单'
  AND si.item_direction = '购买'
GROUP BY so.sale_order_id, so.total_amount
HAVING ABS(so.total_amount - ROUND(SUM(si.received)::numeric, 2)) > 0.01
LIMIT 50;
-- 期望 0 行；非空说明 totalAmount 累加精度问题已产生脏数据

-- 4. 验证 sale_order_payments amount 符号约束（chk_sop_amount_sign）运行效果
SELECT change_type, status, COUNT(*),
  SUM(CASE WHEN (change_type IN ('首次支付','回款','储值卡抵扣') AND amount <= 0) THEN 1 ELSE 0 END) AS wrong_sign
FROM sale_order_payments
GROUP BY change_type, status
HAVING SUM(CASE WHEN (change_type IN ('首次支付','回款','储值卡抵扣') AND amount <= 0) THEN 1 ELSE 0 END) > 0
   OR  SUM(CASE WHEN change_type = '退款' AND amount >= 0 THEN 1 ELSE 0 END) > 0;
-- 期望 0 行（CHECK 已落地，理论不可能有符号违反数据）

-- 5. 验证 commission_rate 在合法范围 [0,1] 内
SELECT 'commission_rate_matrix' AS src, commission_rate, COUNT(*)
FROM commission_rate_matrix
WHERE commission_rate < 0 OR commission_rate > 1
GROUP BY commission_rate
UNION ALL
SELECT 'service_commissions', commission_rate, COUNT(*)
FROM service_commissions
WHERE commission_rate < 0 OR commission_rate > 1
GROUP BY commission_rate;

-- 6. 验证 enums.ts 与生产库 sale_order_type 枚举值是否对齐
SELECT enum_range(NULL::sale_order_type);
-- 期望：{销售单,内部单,转换单}（✅ 2026-04-27 已确认：migration 0019+0021 apply 后 enum 3 值）

-- 7. 验证 sale_items.sale_amount = unit_real_price * quantity 不变量
SELECT sale_item_id, unit_real_price, quantity, sale_amount,
  ABS(sale_amount - unit_real_price * quantity) AS diff
FROM sale_items
WHERE ABS(sale_amount - unit_real_price * quantity) > 0.02
  AND item_direction = '购买'
LIMIT 50;
-- 期望 0 行

-- 8. 验证 sale_orders.paid_amount 与 sop 流水冗余双写一致（注意：paid_amount 列在 0018 后可能已 DROP）
-- SELECT so.sale_order_id, so.paid_amount,
--        COALESCE(SUM(sop.amount) FILTER (WHERE sop.status='已支付' AND sop.change_type IN ('首次支付','回款','退款')), 0) AS computed_paid
-- FROM sale_orders so
-- LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
-- GROUP BY so.sale_order_id, so.paid_amount
-- HAVING ABS(so.paid_amount - COALESCE(SUM(sop.amount) FILTER (...), 0)) > 0.02
-- LIMIT 50;
```

---

## SECTION 8：回归测试用例（建议）

1. **Money helper 单元测试**：`roundCNY(0.005) === 0.01`（半数远离零） vs `(0.005).toFixed(2) === '0.00'`（banker），断言三端一致。
2. **券折扣分摊一致性测试**：固定 5 件商品 + 50 元券，断言 staff/client/admin 三端 received 数组完全相同。
3. **批量保存提成 server-side 重算测试**：admin 提交 commissionAmount=999 但实际 unit×session×rate=80，断言后端持久化 80（拒绝前端值）。
4. **CHECK 约束 migration apply 测试**：在临时 PG 跑全量 baseline + 新 CHECK migration，对历史脏数据 sandbox 验证。
5. **sale_allocations.allocationRatio 越界拒绝测试**：admin POST `allocationRatio=9.99`，断言 DB 拒绝（CHECK violation）+ 前端兜底拦截。
6. **sale_order_type 枚举范围测试**：断言 0018 后 '退款单' / '回款单' 不再可写入 sale_orders。
7. **三端 dashboard 业绩 SUM 一致性**：固定 fixture 跑 admin getDashboardStats / mgmt-dashboard.summary / staff.dashboard.revenue，断言三个数字精确相等。

---

## SECTION 9：影响半径

- **DB 层**：22 schema / 33 NUMERIC 列 / 9 CHECK；本报告建议新增 12 个 CHECK / trigger
- **三端代码**：staff order.js + allocation.js + service.js + payNotify + client order.js + admin orders.ts + allocations.ts + refunds.ts + service-commissions.ts + dashboard.ts，共 10+ 文件
- **修复成本**：S（CHECK migration 单独 PR）+ M（helpers 抽取 + 三端 import 替换）+ L（admin commission/order 后端重算改造）
- **涉及历史数据**：CHECK 上线前需先 SELECT 验证脏数据 → 数据修复 → 再 ALTER TABLE。
- **跨端依赖**：cloudfunctions-shared 新模块 + L0/L1 helpers 同步上线
- **v2 新增影响**：P1-CC1-05（admin calcCouponDiscount）+ P1-CC1-08（admin 开单无行级券分摊）均为 admin 侧新增修复点，不涉及 staff/client 回归

---

## SECTION 10：修复记录

| 问题编号 | 状态 | 说明 |
|---------|------|------|
| P0-CC1-03（sale_orders 退款单字段无符号联动 CHECK） | ⚠️ 架构性作废 → **2026-04-27 域重构收官确认** | migration 0018（2026-04-26）退款架构重构后，退款不再写 sale_orders[type='退款单'] 行，退款全部下沉到 sale_order_payments（chk_sop_amount_sign 已守护符号）。sale_order_type 枚举收窄为 3 值（migration 0019+0021 已 apply，'回款单'/'退款单' 移除）。P0-CC1-03 建议的 ALTER TABLE 在新架构下不再适用（通用 non-negative CHECK 可加，但按 type 联动符号的场景已不存在）。 |
| P0-CC1-05（point_transactions integer 作为 P0） | 📉 降级为 P2（v2 不同意 v1 的 P0 定级） | 积分为整数粒度语义合理，int4 上限 ~21 亿颗积分（按每元1分计算，需累计消费 2100 万元才触底），当前业务规模极低风险。CHECK 缺失仍是 P2 缺陷。 |
| P2-CC1-17（enums.ts saleOrderTypeEnum schema drift） | ✅ **已修复 2026-04-27** | enums.ts 已更新为 3 值（'销售单','内部单','转换单'），与 migration 0018+0019+0021 完全对齐。paymentFlowStatusEnum 新增 '待审批'。 |
| chk_sop_amount_sign（sale_order_payments 符号约束） | ✅ **已生效，域重构收官后为退款唯一符号守卫** | 2026-04-27 域重构后，退款全部下沉 SOP 层，该 CHECK 是退款金额符号的唯一 DB 级守卫。退款金额使用 NUMERIC(10,2) 精度，与销售金额一致。 |

---

## 附录 A：v1 → v2 发现编号映射

| v1 编号 | v2 编号 | 变化 |
|---------|---------|------|
| P0-CC1-01 | P0-CC1-01（保留） | ✅ 确认，未修复 |
| P0-CC1-02 | P0-CC1-02（保留） | ✅ 确认，未修复 |
| P0-CC1-03 | 架构性作废 | ⚠️ migration 0018 架构重构，CHECK 建议不再适用 |
| P0-CC1-04 | P0-CC1-04（保留） | ✅ 确认，未修复 |
| P0-CC1-05 | P2-CC1-18（降级） | 📉 v2 不同意 P0 定级 |
| P1-CC1-06 | P1-CC1-06（保留） | ✅ 确认，细化边界例子 |
| P1-CC1-07 | P1-CC1-11（保留） | ✅ 确认，未修复 |
| P1-CC1-08 | P1-CC1-09（保留） | ✅ 确认，20+ 处计数相符 |
| P1-CC1-09 | P1-CC1-08（升 P1） | ⬆️ v2 认为 suggest/配置不一致影响绩效口径，定 P1 |
| P1-CC1-10/11 | P1-CC1-10（合并保留） | ✅ 确认，未修复 |
| P2-CC1-12/13 | P2-CC1-12/13（保留） | ✅ 确认，未修复 |
| P2-CC1-14/15/16 | P2-CC1-14/15/16（保留） | ✅ v2 无新内容 |
| — | P0-CC1-01（新发现 clientApi） | v1 未覆盖，v2 新发现 |
| — | P1-CC1-05（admin calcCouponDiscount） | v1 未覆盖，v2 新发现 |
| — | P1-CC1-08（admin 开单无行级券分摊） | v1 未覆盖，v2 新发现 |
| — | P2-CC1-17（enums.ts schema drift） | v1 未覆盖，v2 新发现 |

---

## 附录 B：业务域报告 §5 CC1 节归集（25 域全扫描）

| 域 ID | CC1 状态 | 关键引用 |
|-------|----------|---------|
| 01 | N/A | 与本域无关 |
| 02 | ⚠️ Math.round 风险面有限但不规范 → P1-02-12 |
| 03 | ⚠️ +0.001 浮点比较散落多处（11 处） → P2 |
| 04 | ✓ NUMERIC + Math.round；P0-04-02 payAmount 无上限 |
| 05 | ✓ Math.round + NUMERIC(10,2)/(5,4) 合规 |
| 06 | N/A 无金额 |
| 07 | ✗ NUMERIC(5,2) 允许任意 0.00..9.99 + JS Math.round 拼凑（→ 本报告 P0-CC1-01）|
| 08 | ⚠️ admin batchSave 不二次校验金额 → P1-08-14（→ 本报告 P0-CC1-04）|
| 09 | ⚠️ admin 信任前端 unitPrice → P1-09-07 |
| 10 | ✓ member_level 阈值 JS Number 比较安全（业务量级 < 2^53）|
| 11 | ⚠️ split / handlingFee / overdraftDeduction 用 Math.round 兜底；P0-11-06 分母漂移 |
| 12 | N/A |
| 13 | ✓ couponTemplates NUMERIC + 尾差吸收 + parseFloat 前置归一化 |
| 14 | ⚠️ toFixed(2) 与 number 混用 → P2-14-17；缺 CHECK amount sign → P0-CC1-02 |
| 15 | ⚠️ amount integer + 无 CHECK → P2-CC1-18（v2 降级）|
| 16 | N/A |
| 17 | ✗ admin 业绩用 total_amount + 不过滤退款单 → P0-17-01/02；staff.dashboard sale_items.received 与 metrics 不同 → P1-17-07 |
| 18 | ⚠️ Math.round 浮点二次舍入 0.01 漂移风险 |
| 19 | ✓ face_value Math.round + clamp |
| 20 | ✓ pickup_quantity = integer 完整 |
| 21-25 | N/A / pending（与 CC1 无关，但 25 可能涉及 sa.totalAmount）|

**统计**：13 域有 CC1 命中，10 域 N/A，2 域 pending 未审。13 命中域中：
- 4 个升级为本报告 P0（07/08/14/15 各一条）
- 5 个 P1 集中在 admin/staff 舍入语义不一 + 浮点 ε 散落
- 4 个 P2 是 toFixed/Math.round 混用