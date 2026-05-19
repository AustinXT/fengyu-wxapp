# Ticket: staff card.js 文件头注释提及废弃的 product_kind='充值卡' 字面量

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | 待实施 |
| 优先级 | **P3**（仅注释噪音；不影响运行时；可能误导阅读者）|
| 端 | fengyu-staff |
| 修复成本 | **XS**（1 行注释编辑）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（C3）|
| 决策 | **直接改注释**，无需选方案 |
| 关联文件 | `fengyu-staff/cloudfunctions/staffApi/routes/card.js` L7-13（文件头注释）|

---

## 0 一句话

`fengyu-staff/cloudfunctions/staffApi/routes/card.js` 文件头注释 L29-30 提到 "tiers 来自 product_skus（product_kind='充值卡'）"，但 2026-04-26 capability 化重构后该判定已改为 `is_recharge_card=true` 列；注释陈旧会误导后续维护者。

---

## 1 证据

### 1.1 陈旧注释

```js
// fengyu-staff/cloudfunctions/staffApi/routes/card.js L27-31（rechargeSkus 函数头）
/**
 * 返回店长可售的充值卡档位 + 自定义金额配置
 *
 * tiers 来自 product_skus（product_kind='充值卡'），price=面值，special_price=实付。
 * customConfig 提供前端即时校验所需的边界 + tier 断点。
 */
```

### 1.2 实际代码已迁移

```js
// fengyu-staff/cloudfunctions/staffApi/routes/card.js L36-48
// capability 列 SSoT：is_recharge_card=true 才是充值卡（与 product_kind='充值卡' 分类标签解耦）
const rows = await pg.query(`
  SELECT sk.sku_id, sk.spec_name, sk.price, sk.special_price, sk.sort_order, sk.product_type,
         pc.category_id, pc.category_name
  FROM product_skus sk
  JOIN product_categories pc ON sk.category_id = pc.category_id
  WHERE sk.is_recharge_card = true
    ...
`, [RECHARGE_VIRTUAL_SKU_ID])
```

---

## 2 修复内容

将 L30 改为：

```js
* tiers 来自 product_skus（is_recharge_card=true capability 列），price=面值，special_price=实付。
```

或更简洁：

```js
* tiers 来自 product_skus.is_recharge_card=true 行，price=面值，special_price=实付。
```

---

## 3 顺手检查（可选）

全仓 grep 是否还有其它 `product_kind='充值卡'` 字面量注释残留：

```bash
grep -rn "product_kind.*充值卡\|充值卡.*product_kind" --include="*.js" --include="*.ts" \
  fengyu-admin/src fengyu-staff/cloudfunctions fengyu-client/cloudfunctions \
  | grep -v "_archive_" | grep -v node_modules
```

预期命中 ≤ 3 处（都是注释或迁移脚本里的历史说明），若发现新的活跃判定代码再开单独 ticket。

---

## 4 关联引用

- `fengyu-staff/cloudfunctions/staffApi/routes/card.js` L27-31
- 2026-04-26 ticket：sale-order-domain-refactor（capability 化背景）
- `db/schema/product.ts` L78-119（is_recharge_card / is_experience 互斥 CHECK）
