# 审计报告：CC1 数值精度与金额计算（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC1（横切收官）
**审计员**：claude-opus-4-7
**审计时长**：~15 分钟
**关联 PR/Ticket**：—
**说明**：本报告**不是单一业务域审计**，而是对 25 份业务域报告 §5 CC1 节 + DB schema 全量金额/比例字段定义的"全栈金额健康度收官"。

---

## 1. 三端入口对照（金额/比例计算口径汇总）

### 1.1 DB Schema 层（NUMERIC 字段全清单）

| 字段路径 | 类型 | CHECK | 备注 |
|----------|------|-------|------|
| `db/schema/order.ts:60 sale_orders.totalAmount` | NUMERIC(10,2) | ❌ 无符号 CHECK（与 sale_order_type 联动 — 见 SCHEMA-CHANGES S03-4 / S11-4 已建议） | 退款单写负数依赖应用层 |
| `db/schema/order.ts:62 sale_orders.prepaidCardAmount` | NUMERIC(10,2) | ❌ 无 CHECK | 退款单写负 |
| `db/schema/order.ts:64 sale_orders.payableAmount` | NUMERIC(10,2) | ❌ 无 CHECK | total - prepaid 不变量无 DB 守护 |
| `db/schema/order.ts:70 sale_orders.paidAmount` | NUMERIC(10,2) | ❌ 无 CHECK | sop 冗余快照 |
| `db/schema/order.ts:83 sale_orders.couponDiscount` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/order.ts:90 sale_orders.handlingFee` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/order.ts:98 sale_orders.overdraftDeduction` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/order.ts:155 sale_items.unitPrice` | NUMERIC(10,2) | ✅ `chk_item_unit_price >= 0` |  |
| `db/schema/order.ts:158 sale_items.unitRealPrice` | NUMERIC(10,2) | ✅ `chk_item_unit_real_price >= 0` |  |
| `db/schema/order.ts:159 sale_items.saleAmount` | NUMERIC(10,2) | ❌ 无 `=unitPrice×quantity` 不变量 CHECK（S09-3 建议中）|  |
| `db/schema/order.ts:161 sale_items.received` | NUMERIC(10,2) | ❌ 退款行写负数依赖应用层 |  |
| `db/schema/order.ts:168 sale_items.serviceFee` | NUMERIC(10,2) | ✅ `chk_item_service_fee >= 0` |  |
| `db/schema/order.ts:206 sale_allocations.allocationRatio` | **NUMERIC(5,2)** ⚠️ | ❌ 无 CHECK | **PLAN 写 (5,4)，实际是 (5,2)**；取值约定 0.10..1.00 但 schema 允许 0.00..999.99（S07-1 建议加 IN 集合 CHECK）|
| `db/schema/order.ts:212 sale_allocations.totalAmount` | NUMERIC(10,2) | ❌ 无 CHECK | 退款写负依赖应用层；语义实为"分配业绩营业额"（建议 S07-2 重命名 `allocated_revenue`）|
| `db/schema/order.ts:250 sale_order_payments.amount` | NUMERIC(10,2) | ✅ **`chk_sop_amount_sign`**（按 changeType 联动）+ `chk_sop_method_txn` | **唯一已落地的"金额符号"DB 守卫**，值得作为模板推广 |
| `db/schema/commission.ts:21 commission_rate_matrix.amountTierMin` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/commission.ts:23 commission_rate_matrix.amountTierMax` | NUMERIC(10,2) | ❌ 无 `min < max` CHECK |  |
| `db/schema/commission.ts:25 commission_rate_matrix.commissionRate` | **NUMERIC(5,4)** | ❌ 无 `0 <= rate <= 1` CHECK | 唯一对齐 PLAN(5,4) 的字段 |
| `db/schema/service-commission.ts:29 service_commissions.allocationRatio` | NUMERIC(5,2) | ❌ 无 CHECK（S08-3 建议中）| 与 sale_allocations 同精度问题 |
| `db/schema/service-commission.ts:31 service_commissions.commissionRate` | NUMERIC(5,4) | ❌ 无 CHECK |  |
| `db/schema/service-commission.ts:33 service_commissions.fixedFee` | NUMERIC(10,2) | ✅ `chk_svc_comm_fixed_fee >= 0` |  |
| `db/schema/service-commission.ts:35 service_commissions.consumeAmount` | NUMERIC(10,2) | ✅ `chk_svc_comm_consume_amount >= 0` |  |
| `db/schema/service-commission.ts:37 service_commissions.commissionAmount` | NUMERIC(10,2) | ❌ 无 `= fixedFee + consumeAmount` 不变量 CHECK |  |
| `db/schema/prepaid-card.ts:19 prepaid_cards.balance` | NUMERIC(10,2) | ❌ 无 `>= 0` CHECK 也无 `= SUM(card_transactions.amount)` 触发器（参见 audit-14 P0-14-04）|  |
| `db/schema/prepaid-card.ts:40 card_transactions.amount` | NUMERIC(10,2) | ❌ **缺符号 CHECK**（audit-14 P0-14-05；S14-02 已建议）|  |
| `db/schema/coupon.ts:16 coupon_templates.discountValue` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/coupon.ts:18 coupon_templates.minSpend` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/coupon.ts:20 coupon_templates.maxDiscount` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/coupon.ts:65 user_coupons.faceValueOverride` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/product.ts:51 products.price` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/product.ts:52 products.specialPrice` | NUMERIC(10,2) | ❌ 无 `<= price` CHECK |  |
| `db/schema/product.ts:56 products.serviceFee` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| `db/schema/product.ts:106 product_skus.price` | NUMERIC(10,2) | ✅ `chk_sku_price >= 0` |  |
| `db/schema/product.ts:107 product_skus.specialPrice` | NUMERIC(10,2) | ❌ 无 `<= price` CHECK | S09-4 已建议 trigger |
| `db/schema/product.ts:162 mall_product_skus.bundlePrice` | NUMERIC(10,2) | ❌ 无 `<= sku.price` CHECK | S09-4 已建议 trigger |
| `db/schema/service.ts:60 service_items.unitRealPrice` | NUMERIC(10,2) | ❌ 无 CHECK |  |
| **`db/schema/points.ts:20 point_transactions.amount`** | **integer** ⚠️ | ❌ 无符号 CHECK 也无 `>= 0 OR type='消费冲销'` 联动 CHECK | **唯一一个不用 NUMERIC 的"金额"列**；audit-15 P2-15-18 + S15-02 已建议切 bigint + sign CHECK |

**结论**：
- 32+ 个金额/价格/费率字段，**31 个用 NUMERIC** ✅，**1 个用 integer**（积分 amount，按"积分=整数颗"语义合理但仍建议 bigint 防长尾溢出）。
- **0 个使用 FLOAT / DOUBLE PRECISION / REAL**（CC1 PLAN 第 1 项检查通过）。
- **CHECK 约束严重不足**：33 个金额/比例列，仅 9 个有非负 CHECK + 1 个有联动符号 CHECK + 0 个有不变量 CHECK。chk_sop_amount_sign 是当前唯一"按业务语义"的 CHECK 范例。

### 1.2 三端代码层（金额计算热点）

| 计算点 | 文件:行 | 模式 |
|--------|---------|------|
| 开单总价 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:411` | `Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100` |
| 开单内部单半价 | `staffApi/routes/order.js:279` | `Math.round(basePrice * 50) / 100` |
| 服务费快照 | `staffApi/routes/order.js:303` | `Math.round(Number(sku.service_fee || 0) * quantity * 100) / 100` |
| 券折扣分摊 | `staffApi/routes/order.js:399` 与 `clientApi/routes/order.js:322` | `Math.round(couponDiscount * (item.received / eligibleTotal) * 100) / 100`，**最后一项尾差吸收** |
| 储值卡抵扣校验 | `staffApi/routes/order.js:437` / `clientApi/routes/order.js:394` | `Math.round(v * 100) / 100` |
| 应付金额 | `staffApi/routes/order.js:447` / `clientApi/routes/order.js:401` / `payNotify/index.js:122-123` | `Math.round((totalAmount - prepaidCardAmount) * 100) / 100` |
| 部分支付剩余 | `staffApi/routes/order.js:805` / `clientApi/routes/order.js:586` / `payNotify/index.js:134` | `Math.round((orderPayable - orderPaid) * 100) / 100` |
| 服务提成（消耗 + 手工费） | `staffApi/routes/service.js:398-414` | `Math.round(unit_real_price × session_used × rate × 100)/100 + Math.round(service_fee × session_used × 100)/100` |
| 销售提成分配 | `staffApi/routes/allocation.js:114-119`（save 主路径）+ `:450`（suggest）| `Number(allocationRatio).toFixed(2)` 后 `Math.round(received * Number(ratioStr) * 100) / 100` |
| admin 分配批量保存 | `fengyu-admin/src/actions/allocations.ts:220, 271` | `(received * Number(a.allocationRatio)).toFixed(2)` — **无 Math.round 兜底**，依赖 toFixed 自带 banker 舍入 |
| admin 退款拆分 | `fengyu-admin/src/actions/refunds.ts:202, 420-436, 558, 602` | `Math.round(... * 100) / 100` 串联多次（**多次部分退款分母漂移见 P0-11-06**）|
| admin 转换单差价 | `fengyu-admin/src/actions/orders.ts:1220, 1225, 1269, 1271, 1275` | `Math.round(... * 100) / 100` |
| 微信支付下单分 | `clientApi/routes/order.js:715, 1747` / `payNotify/index.js` | `Math.round(thisPayAmount * 100)`（转分，整数）|
| 浮点 ε 比较散落 | `staffApi/routes/order.js:377,463,549,638,815,824,1803,1818,1913` + `clientApi/routes/order.js:298,388,391,678,1242,1330,1333,1425,1594,1606,1699` | `x + 0.001 < y` / `x + 0.001 >= y` ≥ 20 处 |

**关键观察**：
- 三端**均未引入 Decimal.js / big.js 等十进制库**，统一靠 `Math.round(x * 100) / 100` 兜底两位精度。
- 浮点 ε 比较 `+ 0.001` 在 staff/client order 多达 20+ 处，跨函数复制粘贴；ε 选取 0.001（即 0.1 分）安全（≪ 0.01 元业务最小粒度），但散落且未集中常量化。
- staffApi/routes/allocation.js:450 一处用 `(received * commRate).toFixed(2)` **未 Math.round**，与 :114-119 主路径不一致。
- admin actions 大量直接 `.toFixed(2)` 持久化，依赖 Number toFixed 自带半偶舍入；**与 staff/client `Math.round` 半数远离零**舍入语义**不同**——同一笔金额跨端重算可能差 0.01 元（IEEE 754 toFixed 不全是 banker 舍入但与 Math.round 也不全等价）。
- payNotify (`fengyu-client/cloudfunctions/payNotify/index.js`) 与 staffApi/clientApi 用相同 `Math.round` 模式；**金额计算在三端口径基本一致**。

---

## 2. 数据流图（金额传递的层级）

```
product_skus.price/special_price (NUMERIC)
   │ 锁定 unitPrice 快照
   ↓
sale_items.unitPrice / unitRealPrice (NUMERIC, CHECK ≥0)
   │ saleAmount = unitPrice × quantity        ← S09-3 缺不变量 CHECK
   │ received   = unitRealPrice × quantity − couponShare
   ↓
sale_orders.totalAmount = Σ items.received   ← Math.round 在 JS 层
   │ couponDiscount  ← 三端 Math.round 模式一致
   │ prepaidCardAmount  ← Math.round + ε 校验
   │ payableAmount = total − prepaid
   ↓
sale_order_payments.amount (CHECK 符号联动 ✓)
   │ → 冗余双写 sale_orders.paidAmount
   ↓
sale_allocations.totalAmount = received × allocationRatio  ← staff Math.round / admin toFixed
   │ allocation_ratio NUMERIC(5,2) ⚠️ 无取值 CHECK
   ↓
service_commissions.commissionAmount = fixedFee + consumeAmount
   │ consumeAmount = unit_real_price × session_used × commission_rate  (NUMERIC(5,4))
```

退款链反向：所有上述字段在 `sale_order_type='退款单'` 时写负数，**仅 sop.amount 有 CHECK 守护**，其他字段（total/paid/prepaid/sa.totalAmount/sc.commissionAmount）符号约束完全在应用层。

---

## 3. 自身漏洞（CC1 收官归集 + 新发现）

### 3.1 P0（阻断/资损）

#### **[P0-CC1-01] sale_allocations.allocationRatio 类型与 PLAN 不符且无 CHECK**
- **文件**：`db/schema/order.ts:206` + `db/schema/service-commission.ts:29`
- **现象**：PLAN §3 CC1 写"提成比例 NUMERIC(5,4) 或 (3,4)"，schema 实为 `numeric(5,2)`（取值范围 ±999.99）。业务约定仅允许 `IN (0.10, 0.20, ..., 1.00)` 但无 DB CHECK。
- **风险**：admin `allocations.ts:220` 接收前端 ratio 字符串后直接 `Number(a.allocationRatio)` 写入；前端 BUG 或恶意请求传 `9.99` → 单笔分配业绩瞬间 ×10 倍。staff `allocation.js:114` 同模式无后端二次校验。
- **修复**：参考 SCHEMA-CHANGES S07-1 + S08-3：`CHECK (allocation_ratio IN (0.10,0.20,...,1.00))`。本报告把它升级为 P0（资损直接相关）。
- **关联**：retain audit-07 P1-07-11；现升级为 P0-CC1-01。

#### **[P0-CC1-02] card_transactions.amount 缺符号 CHECK（流水类表）**
- **文件**：`db/schema/prepaid-card.ts:40`
- **现象**：与 `chk_sop_amount_sign`（已落地）反差。`amount` 任意正负，应用层一旦写反，admin balance summary `SUM(amount)` 静默错账。
- **修复**：S14-02 已建议 `CHECK ((type='充值' AND amount>0) OR (type='扣款' AND amount<0))`。
- **关联**：retain audit-14 P0-14-05。

#### **[P0-CC1-03] sale_orders 退款单字段无符号联动 CHECK**
- **文件**：`db/schema/order.ts:60-98`（totalAmount / paidAmount / prepaidCardAmount / overdraftDeduction）
- **现象**：四个金额列无任何 CHECK；按 `sale_order_type` 联动符号的不变量（退款单 ≤0 / 销售单 ≥0）完全靠应用层。staff `order.js:1530-1535` 与 admin `refunds.ts:838-839` approveRefund 写负值，schema 不拦不漏。
- **修复**：参考 S03-4 + S11-4 联合 CHECK：
  ```sql
  ALTER TABLE sale_orders ADD CONSTRAINT chk_sale_orders_amount_sign CHECK (
    (sale_order_type = '退款单' AND total_amount <= 0 AND paid_amount <= 0 AND prepaid_card_amount <= 0)
    OR (sale_order_type <> '退款单' AND total_amount >= 0 AND paid_amount >= 0 AND prepaid_card_amount >= 0)
  );
  ```
- **关联**：retain audit-03 / audit-11，现汇总为 P0-CC1-03。

#### **[P0-CC1-04] admin batchSaveServiceCommissions 信任前端 commissionAmount**
- **文件**：`fengyu-admin/src/actions/service-commissions.ts`（与 audit-08 P1-08-14 同源）
- **现象**：admin 把前端计算后的 `commissionRate` / `commissionAmount` 直接持久化，不在后端按 commission_rate_matrix + service_items.unit_real_price + session_used 二次重算。前端 BUG 或脚本可写任意金额。
- **风险**：违反 real.md #5 后端统一鉴权（"信任前端值"形态）。同模式：admin `orders.ts:690-694` createOrder 信任前端 `unitPrice` / `unitRealPrice`（audit-09 P1-09-07）。
- **修复**：S08-6 / S09-5 已建议抽 `db/helpers/price-snapshot.ts` + `commission-recalc.ts` 收敛。
- **影响域**：08, 09，本报告升级为 P0-CC1-04。

#### **[P0-CC1-05] point_transactions.amount 用 integer 且无 CHECK**
- **文件**：`db/schema/points.ts:20`
- **现象**：唯一一个"金额"列不用 NUMERIC，type='消费冲销' 时应为负，'消费赠送' 等应为正，无任何 CHECK。int4 范围 ±21 亿，长尾业务理论可触底（积分通胀场景）。
- **风险**：与 audit-15 P0-15-04 / P0-15-05 / P2-15-18 联动；任何 settle 副本（5 处）漏判符号或重复发放，DB 不会拦。
- **修复**：S15-02 已建议加联动 CHECK + 切 bigint。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-CC1-06] admin toFixed vs staff/client Math.round 舍入语义跨端不一致**
- **文件**：`fengyu-admin/src/actions/allocations.ts:220,271` vs `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:114-119` vs admin `refunds.ts` / `orders.ts` 多处
- **现象**：admin 在 sa.totalAmount 持久化用 `(received * ratio).toFixed(2)`，staff 用 `Math.round(received * Number(ratioStr) * 100) / 100`。Number.prototype.toFixed 在 V8 实现为"四舍五入到偶数（banker rounding）边界例外"，与 `Math.round` 的"半数远离零"在 0.005 边界差 1 分。
- **风险**：同一笔订单同一比例，admin 修改后保存与 staff 自动写入的金额可差 0.01 元。员工总绩效跨端汇总不可对账。
- **修复**：抽 `db/helpers/money.ts`（roundCNY = `(Math.round(x * 100) / 100).toFixed(2)`）三端统一引用，或 PG 端用 `ROUND(... ::numeric, 2)` 统一在数据库层落库。

#### **[P1-CC1-07] saleAmount = unitPrice × quantity 无 DB 不变量 CHECK**
- **文件**：`db/schema/order.ts:159`
- **现象**：schema 注释暗含 `sale_amount = unit_price × quantity`，但无 CHECK；admin `orders.ts:978` 显式写 `(Number(item.unitRealPrice) * item.quantity).toFixed(2)` 但客户端 `clientApi/routes/order.js` 与 staff `routes/order.js` 各自构造，三端口径必须保持一致。
- **修复**：S09-3 已建议 `CHECK (ABS(sale_amount - unit_price * quantity) < 0.02)` 容忍分级精度。

#### **[P1-CC1-08] 浮点 ε 比较散落 20+ 处，常量未抽取**
- **文件**：staff `routes/order.js:377,463,549,638,815,824,1803,1818,1913` + client `routes/order.js:298,388,391,678,1242,1330,1333,1425,1594,1606,1699`
- **现象**：`x + 0.001 < y` / `x + 0.001 >= y` 散落两端 20+ 处，0.001（即 0.1 分）数值合理但未常量化；任何手抖打成 `0.01` 或 `0.0001` → 边界判断翻转。
- **修复**：抽 `MONEY_EPSILON = 0.001` 常量到 `cloudfunctions-shared/money.js` 三端共用；或全部改为整数分比较（`Math.round(x * 100) >= Math.round(y * 100)`）。

#### **[P1-CC1-09] 折扣计算顺序（券→卡→积分）口径未在 spec 锁定**
- **文件**：staff `routes/order.js:326-411` / client `routes/order.js:296-401`
- **现象**：实际三端实现都是 **券先扣（按 received 比例分摊）→ 储值卡抵扣 prepaidCardAmount → 应付金额**；积分目前不参与下单时直接扣减（按"消费赠送"事后发放）。但 spec / metrics.md 未明文锁定此顺序。一旦未来加积分抵扣 / VIP 折扣，三端实现可能各走各路（参考 audit-08 / audit-15 settlePoints 三副本漂移先例）。
- **修复**：在 `.42cog/pm/backend.pr.spec.md` 增加"折扣计算顺序"明文条款 + 抽 `db/helpers/discount-pipeline.ts` 三端共用。

#### **[P1-CC1-10] commission_rate_matrix.commissionRate 缺 [0,1] CHECK**
- **文件**：`db/schema/commission.ts:25` + `db/schema/service-commission.ts:31`
- **现象**：NUMERIC(5,4) 允许 ±9.9999；业务费率必须 0..1。admin 矩阵管理 UI 校验，但无 DB 兜底。
- **修复**：`CHECK (commission_rate >= 0 AND commission_rate <= 1)`。

#### **[P1-CC1-11] amount_tier_min < amount_tier_max 无不变量 CHECK**
- **文件**：`db/schema/commission.ts:21-23`
- **现象**：矩阵 tier 区间允许逆序（min=10000 max=1000），matrix lookup 永空；audit-08 已发现 lookup 逻辑 bug 但 schema 没拦。
- **修复**：`CHECK (amount_tier_max IS NULL OR amount_tier_min < amount_tier_max)`。

### 3.3 P2（代码质量 / 可维护）

#### **[P2-CC1-12] specialPrice 无 `<= price` CHECK**
- **文件**：`db/schema/product.ts:107` + `db/schema/product.ts:52`
- **现象**：特惠价高于原价的脏数据可悄悄写入，前端展示成"原价 99 特惠价 199"。
- **修复**：trigger / `CHECK (special_price IS NULL OR special_price <= price)`。

#### **[P2-CC1-13] commissionAmount = fixedFee + consumeAmount 不变量未 CHECK**
- **文件**：`db/schema/service-commission.ts:33-37`
- **现象**：schema 注释明确两段加和，无 CHECK 兜底应用层 BUG。
- **修复**：`CHECK (ABS(commission_amount - fixed_fee - consume_amount) < 0.02)`。

#### **[P2-CC1-14] payable_amount = total - prepaid 不变量未 CHECK**
- **文件**：`db/schema/order.ts:64`
- **现象**：冗余列 + 应用层双写 + 退款链负数 + 部分支付各种 UPDATE，零 DB 守护。
- **修复**：trigger 实现（CHECK 不允许子查询，但允许同行列）：`CHECK (ABS(payable_amount - (total_amount - prepaid_card_amount)) < 0.02)`（仅销售/转换单）。

#### **[P2-CC1-15] couponDiscount 分摊"最后一项尾差吸收"逻辑三端复制**
- **文件**：staff `routes/order.js:393-405` 与 client `routes/order.js:316-326`
- **现象**：尾差吸收逻辑 `i === items.length - 1 ? couponDiscount - distributedTotal : Math.round(...)` 在两端复制实现，admin createOrder 内有第三份变体；任一端漂移，券分摊就会出现 0.01 元 ε。
- **修复**：抽 `cloudfunctions-shared/coupon-allocation.js`。

#### **[P2-CC1-16] dashboard / 绩效 SUM 入口 SUM 后再 Number() 隐患**
- **文件**：`fengyu-admin/src/actions/dashboard.ts:115,122,123` + `card-transactions.ts:172`
- **现象**：PG numeric → driver 默认返回字符串 → `Number()` 转 JS 浮点；金额量级 `< 2^53 ≈ 9e15` 完全安全（百亿元级才有问题），但 audit-18 P1-CC1 已点出 `Math.round(× 100) / 100` 二次舍入有 ε 风险。建议数据库端用 `ROUND(SUM(...), 2)::text` 返回字符串避免转浮点。

---

## 4. 跨端不一致（CC1 收官核心节）

| 维度 | admin (Next.js) | staff (staffApi) | client (clientApi) | payNotify | 风险 | 优先级 |
|------|-----------------|------------------|--------------------|-----------|------|--------|
| 金额持久化舍入 | `.toFixed(2)`（V8 banker） | `Math.round(* 100) / 100` 后 PG implicit cast | 同 staff | 同 staff | **0.005 边界差 1 分** | P1 |
| sa.totalAmount 计算 | `(received * Number(ratio)).toFixed(2)` | `Math.round(received * Number(ratio.toFixed(2)) * 100) / 100` | — | 同 staff | 跨端值漂移 | P1 |
| sa.totalAmount 不重算 | 信任前端 ratio | suggest 路径 `commRate.toFixed(2)` 无 round | — | — | 同 staff 内部分裂 | P2 |
| commission_amount 计算源 | 信任前端 commissionAmount（P0-CC1-04） | `Math.round(unit_real_price * session * rate * 100) / 100` 后端重算 | — | 同 staff | admin 写入可任意篡改 | P0 |
| 内部单半价 | createOrder 半价规则 admin 端实现位置不明 | `Math.round(basePrice * 50) / 100` | 不支持内部单 | 同 staff | 三端实现位置漂移 | P2 |
| 转换单差价 | `Math.round((totalIn - totalOut) * 100) / 100` | `routes/order.js:2085` 等 | 不支持 | — | OK | — |
| 退款拆分（原通道 vs 储值卡） | 多次 `Math.round` 串联（refunds.ts:558,602,710,723） | `routes/order.js:1547-` 类似模式 | — | — | P0-11-06 多次部分退款分母漂移 | P0 |
| 浮点 ε 比较 | 极少用（依赖 PG numeric） | `+ 0.001` 9 处 | `+ 0.001` 11 处 | — | 散落易漂移 | P1 |
| 微信支付下单分 | — | 不直接发起 | `Math.round(thisPayAmount * 100)` | 同 client | OK | — |
| 券分摊"最后一项尾差吸收" | createOrder 自有 | order.js:397 (`distributedTotal` 累加) | order.js:319 (相同模式) | — | 三副本 | P2 |
| 储值卡余额比较 | `prepaid_cards.balance >= ${prepaidCardAmount}` 直接 SQL | `currentBalance + 0.001 < prepaidCardAmount` JS | `cardBalance + 0.001` JS | `Number(...balance) < prepaidAmount` | **PG numeric vs JS float vs JS float** 三套口径 | P1 |
| `Number()` 转换金额时机 | DB 字符串 → Number（dashboard） | 全程 `Number(row.field)` | 同 staff | 同 staff | 量级安全但语义分裂 | P2 |

---

## 5. 横切检查（套用 §3 模板，本身就是 CC1 收官 → 各项映射）

CC1 自身 6 项检查回归：

| PLAN §3 CC1 检查项 | 状态 | 关联问题 |
|--------------------|------|----------|
| 金额字段 NUMERIC(N,2) 而非 FLOAT | ✅ 31/32 列；point_transactions.amount = integer 是历史决策（P0-CC1-05） | 仅 1 例外 |
| JS 端用字符串/Decimal 库，不用 Number 直接相加 | ⚠️ **三端无 Decimal 库**，全靠 `Number() + Math.round(× 100)/100` 兜底；admin `.toFixed(2)` 与 staff `Math.round` 语义分裂 | P1-CC1-06 / P2-CC1-15 |
| 提成比例 NUMERIC(5,4) 或 (3,4)，舍入策略一致 | ❌ commission_rate=(5,4) ✓，但 **allocation_ratio=(5,2)** 与 PLAN 不符 + 无 IN CHECK | P0-CC1-01 / P1-CC1-10 |
| 退款 amount 为负的符号约束 chk_sop_amount_sign | ✅ sale_order_payments 已加；❌ sale_orders / sale_allocations / card_transactions / point_transactions / sale_items.received 全无 | P0-CC1-02 / P0-CC1-03 / P0-CC1-05 |
| 折扣计算顺序（券→卡→积分）三端一致 | ⚠️ 实际三端都是"券→卡（积分不直扣）"，但 spec 未锁定 | P1-CC1-09 |
| 总价 = sum(unit_real_price × quantity) 在三端口径一致 | ⚠️ 公式一致，但**admin toFixed vs staff/client Math.round 舍入语义不同** | P1-CC1-06 / P1-CC1-07 |

CC1 之外的横切关联（这是收官，归集已发现）：
- **CC2 并发**：金额冗余双写（`sale_orders.paid_amount = Σ sop.amount`）无 cron 守护；audit-14 / audit-15 也是同模式；
- **CC3 隔离**：commission_rate_matrix lookup 缺 org_id（audit-08 P0-08-01）→ 跨市场金额错算；
- **CC9 测试**：dashboard 测试不断言"三端口径一致"（CROSS-CUTTING.md 已记录）。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/order.ts | `sale_allocations` + `sale_orders` + `sale_items.saleAmount` | 加多个 CHECK：allocation_ratio IN 集合、sale_orders 符号联动、saleAmount 不变量 | P0-CC1-01 / P0-CC1-03 / P1-CC1-07 |
| L0 schema/prepaid-card.ts | `card_transactions.amount` | 加符号联动 CHECK | P0-CC1-02 |
| L0 schema/points.ts | `point_transactions.amount` | 切 bigint + 加符号联动 CHECK | P0-CC1-05 |
| L0 schema/commission.ts + service-commission.ts | `commissionRate` + `amount_tier` | 加 [0,1] CHECK + min<max CHECK + commissionAmount 不变量 CHECK | P1-CC1-10 / P1-CC1-11 / P2-CC1-13 |
| L0 schema/product.ts | `products.specialPrice` + `product_skus.specialPrice` + `mall_product_skus.bundlePrice` | trigger 加 `<= price` 上限 | P2-CC1-12 |
| L1 db/helpers | 新建 `db/helpers/money.ts` + `commission-recalc.ts` + `discount-pipeline.ts` + `coupon-allocation.ts` | 三端共用舍入 + 重算 + 折扣顺序 + 分摊 | P1-CC1-06 / P0-CC1-04 / P1-CC1-09 / P2-CC1-15 |
| L1 cloudfunctions-shared | 新建 `money.js`（exports `MONEY_EPSILON=0.001` + `roundCNY`） | 三端共用浮点 ε 与舍入 | P1-CC1-08 |
| L3 staffApi/routes/order.js + allocation.js + service.js | 引入 helpers/money 替换散落 `Math.round` 与 `+ 0.001`；allocation suggest 用统一 round | 跨函数收敛 | P1-CC1-08 / P2-CC1-15 |
| L3 clientApi/routes/order.js + payNotify/index.js | 同上 | 跨函数收敛 | P1-CC1-08 |
| L7 admin actions/orders.ts + allocations.ts + service-commissions.ts + refunds.ts | 1) 替换 `.toFixed(2)` 为 `roundCNY()`；2) batchSaveServiceCommissions 后端二次重算 | 舍入对齐 + 价格快照不可变 | P0-CC1-04 / P1-CC1-06 |
| L9 三端前端 | 仅展示用 `formatCurrency`，禁止参与计算 | 无新增 | — |
| L11 cron-worker | 新建 `audit-money-invariants.ts` step：定期 SELECT 校验 paid_amount = SUM(sop.amount) / saleAmount = unitPrice×quantity / commissionAmount = fixed+consume / balance = SUM(card_tx) / spending_tier 一致性 | 不变量自动告警 | retain audit-14 P0-14-04 / audit-15 P1-15-13 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1) 验证当前生产数据是否已违反预期符号约定
SELECT sale_order_type, COUNT(*),
       SUM(CASE WHEN total_amount < 0 THEN 1 ELSE 0 END) AS neg_total,
       SUM(CASE WHEN paid_amount < 0 THEN 1 ELSE 0 END) AS neg_paid,
       SUM(CASE WHEN prepaid_card_amount < 0 THEN 1 ELSE 0 END) AS neg_prepaid
FROM sale_orders GROUP BY sale_order_type;
-- 期望：仅 '退款单' 行有 neg_*；其他类型 neg_* 应为 0

-- 2) 验证 sale_items.sale_amount = unit_price × quantity 不变量
SELECT sale_item_id, unit_price, quantity, sale_amount,
       ABS(sale_amount - unit_price * quantity) AS diff
FROM sale_items
WHERE ABS(sale_amount - unit_price * quantity) > 0.02
LIMIT 50;

-- 3) 验证 sa.allocation_ratio 是否在合法集合内
SELECT allocation_ratio, COUNT(*)
FROM sale_allocations
WHERE allocation_ratio NOT IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00)
GROUP BY allocation_ratio;
-- 期望 0 行；非空即应用层已写入越界比例

-- 4) 验证 service_commissions.commission_amount = fixed_fee + consume_amount
SELECT id, fixed_fee, consume_amount, commission_amount,
       ABS(commission_amount - fixed_fee - consume_amount) AS diff
FROM service_commissions
WHERE ABS(commission_amount - fixed_fee - consume_amount) > 0.02 AND is_void = false
LIMIT 50;

-- 5) 验证 sale_orders.paid_amount 与 sop 流水冗余双写一致
SELECT so.sale_order_id, so.paid_amount,
       COALESCE(SUM(sop.amount) FILTER (
         WHERE sop.status='已支付' AND sop.change_type IN ('首次支付','回款','退款')
       ), 0) AS computed_paid
FROM sale_orders so
LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
GROUP BY so.sale_order_id, so.paid_amount
HAVING ABS(so.paid_amount - COALESCE(SUM(sop.amount) FILTER (
  WHERE sop.status='已支付' AND sop.change_type IN ('首次支付','回款','退款')
), 0)) > 0.02
LIMIT 50;

-- 6) 验证 prepaid_cards.balance ≡ SUM(card_transactions.amount)
SELECT pc.card_id, pc.balance,
       COALESCE(SUM(ct.amount), 0) AS sum_amount
FROM prepaid_cards pc
LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
GROUP BY pc.card_id, pc.balance
HAVING ABS(pc.balance - COALESCE(SUM(ct.amount), 0)) > 0.02
LIMIT 50;

-- 7) 验证 commission_rate 范围 [0, 1]
SELECT commission_rate, COUNT(*)
FROM commission_rate_matrix
WHERE commission_rate < 0 OR commission_rate > 1
GROUP BY commission_rate;

-- 8) 验证 amount_tier_min < amount_tier_max 不变量
SELECT id, amount_tier_min, amount_tier_max
FROM commission_rate_matrix
WHERE amount_tier_max IS NOT NULL AND amount_tier_min >= amount_tier_max;
```

---

## 8. 回归测试用例（建议）

1. **Money helper 单元测试**：`roundCNY(0.005) === 0.01`（半数远离零） vs `(0.005).toFixed(2) === '0.00'`（banker），断言三端一致。
2. **券折扣分摊一致性测试**：固定 5 件商品 + 50 元券，断言 staff/client/admin 三端 received 数组完全相同。
3. **批量保存提成 server-side 重算测试**：admin 提交 commissionAmount=999 但实际 unit×session×rate=80，断言后端持久化 80（拒绝前端值）。
4. **CHECK 约束 migration apply 测试**：在临时 PG 跑全量 baseline + 新 CHECK migration，对历史脏数据 sandbox 验证。
5. **sale_allocations.allocationRatio 越界拒绝测试**：admin POST `allocationRatio=9.99`，断言 DB 拒绝（CHECK violation）+ 前端兜底拦截。
6. **退款链符号 CHECK 测试**：approveRefund 写入 `sale_orders.total_amount = -100`，断言 sale_order_type='退款单' 通过 + sale_order_type='销售单' 拒绝。
7. **三端 dashboard 业绩 SUM 一致性**：固定 fixture 跑 admin getDashboardStats / mgmt-dashboard.summary / staff.dashboard.revenue，断言三个数字精确相等。

---

## 9. 影响半径

- **DB 层**：22 schema / 33 NUMERIC 列 / 9 CHECK；本报告建议新增 12 个 CHECK / trigger
- **三端代码**：staff order.js + allocation.js + service.js + payNotify + client order.js + admin orders.ts + allocations.ts + refunds.ts + service-commissions.ts + dashboard.ts，共 10+ 文件
- **修复成本**：S（CHECK migration 单独 PR）+ M（helpers 抽取 + 三端 import 替换）+ L（admin commission/order 后端重算改造）
- **涉及历史数据**：CHECK 上线前需先 SELECT 验证脏数据 → 数据修复 → 再 ALTER TABLE。
- **跨端依赖**：cloudfunctions-shared 新模块 + L0/L1 helpers 同步上线

---

## 10. 后续待办

- [ ] 与产品 / 财务确认 sale_allocations.allocationRatio 是否真的限制在 0.10..1.00（如允许其他值需调整 CHECK）
- [ ] 汇编「金额计算口径」spec 章节：折扣顺序、舍入策略、退款拆分算法、价格快照规则
- [ ] 在 cron-worker 增加 `audit-money-invariants.ts` step（不变量校验 5 项）
- [ ] 三端引入 `cloudfunctions-shared/money.js`（roundCNY、MONEY_EPSILON、formatCurrency）
- [ ] admin batchSaveServiceCommissions / createOrder 后端二次重算（修 P0-CC1-04）
- [ ] PLAN §3 CC1 第 3 项更正：commissionRate 已是 NUMERIC(5,4)，**allocationRatio 现状是 (5,2)**，需要 PLAN 与代码二选一对齐

---

## 附录 A：业务域报告 §5 CC1 节归集（25 域全扫描）

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
| 14 | ⚠️ toFixed(2) 与 number 混用 → P2-14-17；缺 CHECK amount sign → P0-14-05（→ 本报告 P0-CC1-02）|
| 15 | ✗ amount integer + 无 CHECK → P2-15-18 / P0-15-06（→ 本报告 P0-CC1-05）|
| 16 | N/A |
| 17 | ✗ admin 业绩用 total_amount + 不过滤退款单 → P0-17-01/02；staff.dashboard sale_items.received 与 metrics 不同 → P1-17-07 |
| 18 | ⚠️ Math.round 浮点二次舍入 0.01 漂移风险 |
| 19 | ✓ face_value Math.round + clamp |
| 20 | ✓ pickup_quantity = integer 完整 |
| 21 | N/A |
| 22 | N/A |
| 23 | N/A |
| 24 | ⏳ pending（与 CC1 无关）|
| 25 | ⏳ pending（与 CC1 无关，但推广员业绩归属可能涉及 sa.totalAmount）|

**统计**：13 域有 CC1 命中，10 域 N/A，2 域 pending 未审。13 命中域中：
- 4 个升级为本报告 P0（07/08/14/15 各一条）
- 5 个 P1 集中在 admin/staff 舍入语义不一 + 浮点 ε 散落
- 4 个 P2 是 toFixed/Math.round 混用
