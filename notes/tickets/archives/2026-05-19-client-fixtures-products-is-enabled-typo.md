# Ticket: client-fixtures.mjs INSERT products 表时拼错字段名 is_enabled（应为 is_visible）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | 已实施（2026-05-19）|
| 优先级 | **P3**（不影响生产；仅阻塞 `tests/e2e-cloudfn/order/create.spec.mjs` 跑批；T2 实施时被发现）|
| 端 | fengyu-client（仅 e2e 测试 fixture）|
| 修复成本 | **XS**（删一行 / 改一行）|
| 来源 | 2026-05-19 T2 实施（scanAdjust 版本号）跑 L2 e2e 时发现 |
| 决策 | **直接修复**，无需选方案（实际不是 schema drift，是 fixture 字段名拼错）|
| 关联文件 | `fengyu-client/tests/e2e-cloudfn/helpers/client-fixtures.mjs` L73-80 |

---

## 0 一句话

`client-fixtures.mjs` 的 `ensureTestProduct()` 在对 `products` 表 INSERT 时写了 `is_enabled` 列，但 schema (`db/schema/product.ts` L147-183) 显示 `products` 表只有 `is_visible`、`deleted_at`、**没有 `is_enabled`**（is_enabled 只存在于 `product_skus` 表 L93）。

---

## 1 证据

### 1.1 products 表 schema（无 is_enabled）

```ts
// db/schema/product.ts L147-183
export const products = pgTable("products", {
  productId: text("product_id").primaryKey(),
  categoryId, name, coverImage, detailImages, description,
  isBundle, price, specialPrice, manageScope, marketScope,
  sortOrder, isVisible,  // ← 这才是"启用状态"的字段
  createdAt, updatedAt, deletedAt, deletedBy,
})
```

**没有 isEnabled / is_enabled。**

### 1.2 fixture 错误代码

```js
// fengyu-client/tests/e2e-cloudfn/helpers/client-fixtures.mjs L72-82
await pgQuery(
  `INSERT INTO products (
     product_id, category_id, name, price, is_bundle,
     sort_order, is_enabled, is_visible      // ← is_enabled 不存在
   )
   VALUES ($1, $2, $3, $4::numeric, $5, 0, true, $6)
   ON CONFLICT (product_id) DO UPDATE
     SET name = EXCLUDED.name, price = EXCLUDED.price,
         is_visible = EXCLUDED.is_visible, is_enabled = true`,   // ← 同样
  [productId, TEST_MALL_CATEGORY_ID, name, price, isBundle, isVisible]
)
```

### 1.3 报错现场

```
ERROR: column "is_enabled" of relation "products" does not exist
```

`fengyu-client/tests/e2e-cloudfn/order/create.spec.mjs` 跑批时会先调 fixture 设置测试商品，命中此 INSERT 失败 → 整个 spec 失败。

### 1.4 product_skus 表确实有 is_enabled

```ts
// db/schema/product.ts L93
isEnabled: boolean("is_enabled").notNull().default(true),
```

所以 fixture 作者大概率是把 `product_skus.is_enabled` 误带到 products 表 INSERT 里了。

---

## 2 修复

### 方案：删 is_enabled 字段（products 表只有 is_visible 控制可见性）

```js
// L73-80 改后：
await pgQuery(
  `INSERT INTO products (
     product_id, category_id, name, price, is_bundle,
     sort_order, is_visible
   )
   VALUES ($1, $2, $3, $4::numeric, $5, 0, $6)
   ON CONFLICT (product_id) DO UPDATE
     SET name = EXCLUDED.name, price = EXCLUDED.price,
         is_visible = EXCLUDED.is_visible`,
  [productId, TEST_MALL_CATEGORY_ID, name, price, isBundle, isVisible]
)
```

注意删除三处：列名 / VALUES / ON CONFLICT SET。

---

## 3 验证

```bash
bun /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-client/tests/e2e-cloudfn/run-all.mjs --module order --filter create
```

修复后 `create.spec.mjs` 应能通过（或暴露真正的业务测试失败，与本 fixture bug 无关）。

---

## 4 关联引用

- `fengyu-client/tests/e2e-cloudfn/helpers/client-fixtures.mjs` L73-80
- `db/schema/product.ts` L93 (product_skus.is_enabled) vs L147-183 (products 无 is_enabled)
- 发现来源：2026-05-19 T2 实施过程跑 L2 e2e 时的连带 unrelated 失败
