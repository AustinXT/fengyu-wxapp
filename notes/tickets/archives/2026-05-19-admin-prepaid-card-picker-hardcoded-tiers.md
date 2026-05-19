# Ticket: admin 开单页充值卡 picker 档位硬编码，未读 is_recharge_card SKU

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | ✅ 已完成（2026-05-19，commit d5ad692）|
| 优先级 | **P1**（admin 端 SKU 维护体系无法落地：勾选了"充值卡 SKU"但开单页不展示）|
| 端 | fengyu-admin |
| 修复成本 | **M**（新 server action + picker 组件 SSR/CSR 改造，约 80 行 + 测试）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（T5 用户重新定义）|
| 决策 | **用户指定**：默认充值金额需要根据 SKU 中 `is_recharge_card=true` 的商品中选择 |
| 关联文件 | `src/app/(main)/orders/_components/order-create/prepaid-card-picker.tsx`（189 行）|

---

## 0 一句话

admin 开单页的"充值卡 picker"完全用 `@/lib/recharge` 硬编码档位（500/1000/5000），不从 `product_skus WHERE is_recharge_card = true` 查询；与 staff `card.rechargeSkus`（cloudfunctions L33-81 真实查 SKU）行为不一致；admin 给 SKU 勾选"充值卡 SKU"的能力无法在开单环节落地。

---

## 1 复现证据

### 1.1 当前 picker 实现

```tsx
// fengyu-admin/src/app/(main)/orders/_components/order-create/prepaid-card-picker.tsx
// L4-13 注释明确说"不再依赖真实 SKU 列表"
/**
 * 充值卡 picker（与 client `card.rechargeConfig` / `matchTier` 对齐）
 * 不再依赖真实 SKU 列表；档位与折扣逻辑完全复用 `@/lib/recharge`（与 client
 * `cloudfunctions/clientApi/routes/card.js` 同源）。
 */

// L23-29 仅导入硬编码常量
import {
  RECHARGE_TIERS,        // [{500,0.99}, {1000,0.98}, {5000,0.95}]
  RECHARGE_MIN_AMOUNT,   // 500
  RECHARGE_MAX_AMOUNT,   // 100000
  RECHARGE_VIRTUAL_SKU_ID,  // 'sku-recharge-virtual'
  matchTier,
} from "@/lib/recharge"

// L36-76 buildRechargeAddPayload — 永远生成虚拟 SKU
function buildRechargeAddPayload(faceValue: number): { product: Product; sku: ProductSku } {
  // ...
  const product: Product = {
    productId: RECHARGE_VIRTUAL_SKU_ID,  // 写死虚拟 SKU
    name: `预付充值卡 ¥${faceValue}`,
    // ...
  }
  // ...
}
```

### 1.2 对照 staff 真实查 SKU

```js
// fengyu-staff/cloudfunctions/staffApi/routes/card.js L33-81
async function rechargeSkus(ctx) {
  // capability 列 SSoT：is_recharge_card=true 才是充值卡
  const rows = await pg.query(`
    SELECT sk.sku_id, sk.spec_name, sk.price, sk.special_price, sk.sort_order, sk.product_type,
           pc.category_id, pc.category_name
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.is_recharge_card = true
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
      AND pc.is_valid = true
      AND sk.sku_id <> $1
    ORDER BY sk.price ASC, sk.sort_order ASC
  `, [RECHARGE_VIRTUAL_SKU_ID])
  // ...
}
```

### 1.3 用户期望

admin 已支持给 SKU 勾选 `is_recharge_card=true`（products.ts L283 互斥校验），但这些"运营自定义的充值卡 SKU"在 admin 开单页**根本看不到** — 与 staff 端"开单时显示真实 SKU 档位"行为不一致。

---

## 2 影响范围

| 场景 | 当前行为 | 期望行为 |
|------|---------|---------|
| admin 维护"特价档位"（如 800 充 850） | 在 admin SKU 编辑页能配但开单页看不到 | 在开单页 picker 顶部展示，点击即开单 |
| admin 维护"营销活动卡"（限时高折扣） | 同上 | 同上 |
| admin 维护"虚拟自定义档位" | ✓ 工作（虚拟 SKU + matchTier） | ✓ 保留作为底部"自定义金额"入口 |

实际业务：运营在 admin 配置的"充值卡 SKU"成了僵尸数据，仅在 staff 端开单时可用。

---

## 3 已决方案（用户指定）

### 3.1 新增 server action

`fengyu-admin/src/actions/cards.ts` 或 `products.ts` 中新增：

```ts
export const getRechargeCardSkus = withPermission(
  'sale_order:create',
  async (session): Promise<RechargeCardSku[]> => {
    const rows = await db.execute(sql`
      SELECT sk.sku_id, sk.spec_name, sk.price, sk.special_price, sk.product_type,
             pc.category_id, pc.category_name
      FROM product_skus sk
      JOIN product_categories pc ON sk.category_id = pc.category_id
      WHERE sk.is_recharge_card = true
        AND sk.is_enabled = true
        AND sk.deleted_at IS NULL
        AND pc.is_valid = true
        AND sk.sku_id <> ${RECHARGE_VIRTUAL_SKU_ID}
      ORDER BY sk.price ASC, sk.sort_order ASC
    `)
    return rows.map(r => ({...}))
  }
)
```

**关键**：SQL **字面对齐** staff `card.rechargeSkus` L37-48，由 cross-end snapshot 测试守护（参考 ticket T7）。

### 3.2 picker 改造

```tsx
// 改造后结构：
export function PrepaidCardPicker({ onAdd, rechargeSkus }: Props) {
  // 顶部：真实 SKU 档位（运营在 admin 配置的）
  // 中部：硬编码 fallback 档位（500/1000/5000）保留兜底
  // 底部：自定义金额输入
}
```

- 父组件（开单页 server component）在 SSR 阶段调 `getRechargeCardSkus` 获取列表，作为 props 传入
- 真实 SKU 列表为空时降级到硬编码 RECHARGE_TIERS 不影响现有流程
- 点击真实 SKU 时 `buildRechargeAddPayload` 用真实 sku_id（不再用 RECHARGE_VIRTUAL_SKU_ID）
- 自定义金额仍用虚拟 SKU + matchTier

### 3.3 后端 createOrder 兼容

`fengyu-admin/src/actions/orders.ts` L808-875 的充值卡识别块已经走 `isRechargeCard` capability 列（L813），**理论上**真实 SKU 也能识别。但需要验证：
- L829 `parseRechargeFaceValue(item.productName)` 是从 productName 解析"¥{faceValue}"
- 真实 SKU 的 `productName = spec_name`（如"888 元储值卡"），可能不含¥符号或格式不同
- 必须改为：**当 sku_id ≠ RECHARGE_VIRTUAL_SKU_ID 时直接读 product_skus.price 作 faceValue，跳过 productName 解析**

---

## 4 验证

### 4.1 单元测试

- 真实 SKU 选中后 createOrder 落 sale_items.is_recharge_card=true + sku_id=真实ID + faceValue=sku.price
- 虚拟 SKU + 自定义金额走原路径不变

### 4.2 e2e

`fengyu-admin/tests/e2e-chains/link-26-order-recharge-card.spec.ts` 扩展：
- 新增 case：真实 SKU 充值
- 保留：虚拟 SKU + 自定义金额

### 4.3 跨端 SQL 一致性

加入 cross-end-sql-snapshot 守护 `getRechargeCardSkus` 与 staff `card.rechargeSkus` 的 WHERE 子句字面一致（与 ticket T7 一起做）。

---

## 5 关联引用

- `fengyu-admin/src/app/(main)/orders/_components/order-create/prepaid-card-picker.tsx`
- `fengyu-staff/cloudfunctions/staffApi/routes/card.js` L33-81
- `fengyu-admin/src/lib/recharge.ts`（保留作 fallback 与 matchTier 工具）
- `fengyu-admin/src/actions/orders.ts` L806-875（充值卡识别块，需兼容真实 SKU）
- `fengyu-admin/src/actions/products.ts` L283（SKU 互斥校验，本 ticket 不动）
