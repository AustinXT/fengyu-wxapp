# Ticket: 优惠券核销范围校验（store/market/category/product）三端补齐

> 生成日期：2026-04-27
> 实施状态：🔴 待实施
> 严重级别：**P0**（资损 + 越权 — SUMMARY Top10 #4）
> 端：fengyu-admin / fengyu-staff / fengyu-client
> 来源：[SUMMARY §2 #4](../../docs/audit/SUMMARY.md) / [P0-13-01](../../docs/audit/audit-13-coupons.md) / P0-13-02
> 关联 audit：[audit-13 优惠券](../../docs/audit/audit-13-coupons.md)、横切域 scope 全覆盖（E4）

---

## 0 一句话背景

`coupon_templates` 定义了 4 个适用范围列（`applicable_store_ids` / `applicable_market_ids` / `applicable_category_ids` / `applicable_product_ids`），但三端 `order.create` 在核销优惠券时**未完整校验**这些范围，导致：

1. **admin createOrder 完全跳过**全部 4 项范围校验 — 管理员可将"限 A 店护理项目"的券用于 B 店家居商品
2. **client/staff 跳过** `applicable_product_ids` 和 `applicable_market_ids` — 仅校验了 store + category
3. **face_value_override** admin/staff 端未 COALESCE，分享gift 券核销时用模板默认面值而非动态面值
4. **admin closeOrder 不释放**已核销优惠券（P0-13-01）

## 1 现状矩阵

| 范围字段 | Admin `createOrder` | Client `order.create` | Staff `order.create` |
|----------|--------------------|-----------------------|----------------------|
| `applicable_store_ids` | ❌ 不校验 | ✅ L298 | ✅ L340 |
| `applicable_category_ids` | ❌ 不校验 | ✅ L313 | ✅ L356 |
| `applicable_product_ids` | ❌ 不校验 | ❌ 不校验 | ❌ 不校验 |
| `applicable_market_ids` | ❌ 不校验 | ❌ 不校验 | ❌ 不校验 |
| `face_value_override` COALESCE | ❌ 用模板值 | ✅ COALESCE | ❌ 用模板值 |
| `closeOrder` 释放券 | ❌ 不释放 | ✅ cancel 释放 | ✅ close 释放 |

> `NULL` 表示不限制（全适用），校验逻辑为：字段非 NULL 且非空数组时，必须匹配。

## 2 资损场景

| 场景 | 端 | 资损 |
|------|----|------|
| 管理员用"限 A 店满 500 减 100"券核销 B 店订单 | admin | 券面值 × 滥用频次 |
| 分享gift 券动态面值 200，admin/staff 端按模板默认 50 核销 | admin/staff | 差额 150 元/单 |
| 品项券限定"护理类"，被用于家居商品核销 | 全三端 | 实际折扣偏离预期 |
| admin closeOrder 不释放券 → 顾客永久丢失该券 | admin | 券面值 / 顾客投诉 |

## 3 关键代码路径

### 3.1 Schema

```
db/schema/coupon.ts:24-30
  applicableProductIds  text('applicable_product_ids').array()
  applicableCategoryIds text('applicable_category_ids').array()
  applicableStoreIds    text('applicable_store_ids').array()
  applicableMarketIds   text('applicable_market_ids').array()
```

### 3.2 Admin createOrder（缺全部校验）

```
fengyu-admin/src/actions/orders.ts:882-910
  SELECT 仅取 status/expireAt/userId/couponType/discountValue/maxDiscount/minSpend/isActive
  → 未取 applicableStoreIds / applicableCategoryIds / applicableProductIds / applicableMarketIds
  → 未取 face_value_override（应 COALESCE(uc.face_value_override, ct.discount_value)）
```

### 3.3 Admin closeOrder（不释放券）

```
fengyu-admin/src/actions/orders.ts:611-635
  仅作废 sale_allocations，未 UPDATE user_coupons 归还
```

### 3.4 Client order.create（缺 product/market）

```
fengyu-client/cloudfunctions/clientApi/routes/order.js:278-284
  SELECT ct.applicable_category_ids, ct.applicable_store_ids
  → 缺 applicable_product_ids, applicable_market_ids
```

### 3.5 Staff order.create（缺 product/market + COALESCE）

```
fengyu-staff/cloudfunctions/staffApi/routes/order.js:323-332
  SELECT ct.applicable_category_ids, ct.applicable_store_ids, ct.discount_value
  → 缺 applicable_product_ids, applicable_market_ids
  → 缺 COALESCE(uc.face_value_override, ct.discount_value)
```

### 3.6 已有的完整范围校验（admin coupon listing，可参考但需重构共享）

```
fengyu-admin/src/actions/coupons.ts:122-173  getAvailableCoupons
  → 检查了 store / market / product / category 四维度
  → 但未抽取为共享 helper，createOrder 未复用
```

## 4 修复计划

### Phase 1：Admin createOrder 范围校验（P0，S 量级）

**文件**：`fengyu-admin/src/actions/orders.ts`

1. SELECT 补取 4 个 scope 字段 + `face_value_override`：
   ```sql
   ct.applicable_store_ids, ct.applicable_category_ids,
   ct.applicable_product_ids, ct.applicable_market_ids,
   COALESCE(uc.face_value_override, ct.discount_value) AS discount_value
   ```

2. 校验逻辑（`NULL`/空数组 = 不限制）：
   - `applicable_store_ids`：`data.storeId` 必须在数组内
   - `applicable_market_ids`：`data.storeId` → 查门店所属市场 → 市场必须在数组内
   - `applicable_category_ids`：订单 items 的 category_id 必须有交集
   - `applicable_product_ids`：订单 items 的 product_id 必须有交集
   - scope 内 items 的金额合计作为 `minSpend` 和折扣计算的基数（而非 totalAmount）

3. 关闭订单释放券 — `closeOrder` 事务内追加：
   ```sql
   UPDATE user_coupons
      SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
    WHERE used_sale_order_id = $saleOrderId
   ```

### Phase 2：Client/Staff 补齐 product + market 校验（P0，S 量级）

**文件**：
- `fengyu-client/cloudfunctions/clientApi/routes/order.js`
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js`

1. SELECT 补取 `applicable_product_ids` 和 `applicable_market_ids`
2. Staff 补 COALESCE：`COALESCE(uc.face_value_override, ct.discount_value) AS discount_value`
3. 新增 `applicable_product_ids` 校验：items 中 product_id 必须有交集
4. 新增 `applicable_market_ids` 校验：storeId → 市场匹配
5. `eligibleItems` 过滤逻辑需同时考虑 category + product 两个维度

### Phase 3：抽取共享 helper（P1，与 E7 epic 协同）

**目标**：抽取 `validateCouponScope(coupon, orderContext)` 到共享位置，避免三端副本漂移。

可选方案：
- A) `db/helpers/coupon-scope.ts`（admin 用，Drizzle）
- B) `cloudfunctions-shared/coupon-scope.js`（云函数用，原生 SQL）
- 两份共享 helper 由 diff 守卫保持同步

## 5 验收标准

- [ ] Admin createOrder：4 个 scope 字段全部校验，`NULL`/空数组 = 不限制
- [ ] Admin createOrder：`face_value_override` COALESCE 生效
- [ ] Admin closeOrder：释放已核销优惠券
- [ ] Client order.create：补齐 `applicable_product_ids` + `applicable_market_ids` 校验
- [ ] Staff order.create：补齐 `applicable_product_ids` + `applicable_market_ids` + COALESCE
- [ ] 三端 `eligibleItems` 同时按 category + product 过滤，折扣计算基数为 scope 内 items 金额合计
- [ ] 测试：三端各覆盖"scope 匹配 / 不匹配 / NULL(不限)" 3 × 4 = 12 组场景
- [ ] tsc --noEmit 零新增错误（admin）
- [ ] 云函数 SQL 参数化查询（$1, $2），无拼接

## 6 前置 / 关联

| 项 | 说明 |
|----|------|
| 前置 | 无 schema 变更（字段已存在，只是代码未读） |
| 关联 | E4 scope 全覆盖 epic |
| 关联 | P0-13-03 发放量 TOCTOU（另开 ticket） |
| 关联 | P0-CC4-02 admin 鉴权 wrapper（scope 校验需在鉴权后执行） |
| 参考 | admin `getAvailableCoupons` 已有四维度逻辑（`coupons.ts:122-173`） |
