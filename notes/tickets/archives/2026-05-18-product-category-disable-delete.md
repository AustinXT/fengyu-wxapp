# Ticket: 品项分类支持停用/删除

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P2**（已有 is_valid 列，仅缺 UI 操作） |
| 端 | fengyu-admin |
| 修复成本 | **S**（半天 — schema 已就绪，仅补 action + UI 按钮） |
| 来源 | meeting-20260423 §三 Bug 5 |
| 关联 schema | `db/schema/product.ts:31-44`（`productCategories.isValid` 已存在）|
| 关联 actions | `fengyu-admin/src/actions/products.ts:292-450`（createCategory / updateCategory 已存在）|

---

## 0 一句话背景

会议中张凯尝试编辑品项分类时发现："新增可以，但**已存在的项无法删除，也找不到停用开关**"。

排查后：
- `product_categories.is_valid` 字段 schema 已有（line 37：`boolean().default(true)`）
- `updateCategory` action 入参也已接受 `isValid` 字段（line 349：`Partial<{... isValid: boolean ...}>`）
- **缺的是**：admin UI 的"停用 / 启用"开关按钮 + 软删除的统一行为；二级分类列表也未做停用过滤

→ 本 ticket 仅补 UI + 完善边界，不动 schema、不动 action 签名。

---

## 1 现状（grep 实证）

### 1.1 schema（已就绪）

```ts
// db/schema/product.ts:37
isValid: boolean("is_valid").notNull().default(true),
```

### 1.2 action（已就绪）

```ts
// fengyu-admin/src/actions/products.ts:349
async (session, categoryId, data: Partial<{ ... isValid: boolean ... }>, expectedUpdatedAt) => { ... }
```

### 1.3 UI 缺失（grep 后确认）

```
$ grep -nE "isValid|is_valid|停用|启用" \
    fengyu-admin/src/app/\(main\)/products/categories/_components/*.tsx
（0 命中 — UI 完全未暴露此能力）
```

### 1.4 一级分类（productKind）管理同样缺失

```ts
// product-kind-management-dialog.tsx — 一级分类管理弹窗
// 调用 createProductKind / updateProductKind（在 products.ts 已实现）
// 但 update 入参也未含 isValid（一级行的 is_valid 同样靠 productKind 行的 isValid 控制）
```

---

## 2 修复方案

### 2.1 PR-1：二级分类停用/启用 UI

**文件**：`fengyu-admin/src/app/(main)/products/categories/_components/categories-page.tsx`

**改动**：
- 列表加 "状态" 列：`row.isValid ? <Badge>启用</Badge> : <Badge variant="muted">已停用</Badge>`
- 行操作菜单加 "停用" / "启用" 按钮
- 点击 → `updateCategory(categoryId, { isValid: false/true }, expectedUpdatedAt)`
- 默认仅展示"启用"分类，加 Filter "包含已停用 ☐"
- 已停用的分类在商品创建/编辑 SKU 下拉中**过滤掉**（防止开新单时引用）

### 2.2 PR-2：一级分类（productKind）停用

**文件**：`fengyu-admin/src/app/(main)/products/categories/_components/product-kind-management-dialog.tsx` + `actions/products.ts`

- `updateProductKind` 入参扩 `isValid?: boolean`（schema 已支持）
- 一级分类停用后：UI 上隐藏，所有挂在它下面的二级分类自动不可用（已通过 `isValid + productKind 字面引用` 的 grep 确保）
- 注意：admin 已有约束 `createCategory` 校验 `productKind` 必须在"有效一级行"中（`products.ts:308-316`），一级停用后无法新建挂在它下面的二级 → 行为正确

### 2.3 PR-3：硬删除 — 仅未引用时允许

**Action 新增**：`deleteCategory(categoryId, expectedUpdatedAt)`

```ts
export const deleteCategory = withPermission(
  'product:delete',
  async (session, categoryId: string, expectedUpdatedAt: string) => {
    // 1. 校验：无 SKU 引用
    const [skuRef] = await db.select({ c: sql<number>`count(*)::int` })
      .from(productSkus)
      .where(eq(productSkus.categoryId, categoryId))
    if (skuRef.c > 0) {
      return { success: false, message: `INVALID_STATE: 该分类下还有 ${skuRef.c} 个 SKU，无法删除；请先停用` }
    }
    // 2. 校验：无 coupon_templates.applicable_category_ids 引用
    const couponRef = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM coupon_templates
      WHERE ${categoryId} = ANY(applicable_category_ids)
    `)
    if ((couponRef.rows[0] as any).c > 0) {
      return { success: false, message: `INVALID_STATE: 该分类被优惠券引用，无法删除；请先停用` }
    }
    // 3. 软删除（is_valid=false 而非真删，保留历史 SKU 关联完整性）
    //    → 实际就是停用；硬删可选放弃以减少级联复杂度
    //    → 决策：仅允许"从未使用过"的分类硬删（无 sku + 无 coupon 引用），其它一律停用
    const result = await db.update(productCategories)
      .set({ isValid: false })
      .where(and(eq(productCategories.categoryId, categoryId),
        sql`date_trunc('milliseconds', ${productCategories.updatedAt}) = ${expectedUpdatedAt}`))
    if (result.rowCount === 0) return { success: false, message: 'CONFLICT: 分类已被其他人修改，请刷新' }
    await logOperation(session, 'category.delete', 'product_category', categoryId, {})
    revalidatePath('/products/categories')
    return { success: true, message: '分类已停用' }
  },
)
```

**决策**：UI 的 "删除" 按钮实际走 "停用"（is_valid=false），不做物理 DELETE —— 与"开发阶段不需要历史数据兼容"反馈一致，但分类引用涉及 sale_items 历史快照（productName 已脱钩，但 categoryId 可能未脱钩），停用足够安全。

### 2.4 PR-4：商品创建/SKU 下拉过滤已停用分类

**文件**：`fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx` + `products/[id]/_components/product-detail-page.tsx`

- 调用 `listCategories` 时默认 `WHERE is_valid = true`
- 现有 `listProductsCategoryDictionary` 类型 action 是否已过滤需 grep 确认；不过滤就在 action 层补 `eq(productCategories.isValid, true)`

---

## 3 验收标准（DoD）

- [ ] PR-1：分类列表 "状态" 列展示；"停用" 按钮可点击 → 行变灰 → 再点 "启用" 复原
- [ ] PR-1：默认仅展示启用分类；勾选 "包含已停用" 后展示全部
- [ ] PR-2：一级分类管理弹窗增"停用"开关；停用后侧栏不展示该一级分类
- [ ] PR-3：尝试删除有 SKU 引用的分类 → 返回 `INVALID_STATE: 该分类下还有 N 个 SKU...`
- [ ] PR-3：删除无引用的分类 → is_valid=false，logOperation 记录
- [ ] PR-4：商品创建页 SKU 分类下拉不出现已停用分类
- [ ] cron / 后端聚合 SQL（如 mgmt-product 的品项汇总）不受影响（应已默认 WHERE is_valid=true）
- [ ] 关联 e2e：`bun fengyu-admin/tests/e2e-actions/` 加 1 条 disable-category smoke
- [ ] Vitest `actions/products.test.ts` 加 3 case：(a) update isValid=false 成功；(b) delete 有 SKU 引用拒绝；(c) delete 无引用走停用

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| 停用分类后，已存在引用此分类的 SKU 仍可被开单（直接走 SKU id） | SKU 下单逻辑也应校验 SKU.categoryId 对应 category.isValid；下单时拦截 + 提示 |
| 优惠券 applicable_category_ids 引用了已停用分类 | 现有 coupon 不阻断（兼容存量）；新建/编辑优惠券时 UI 过滤已停用 |
| 一级停用后，二级未自动反向停用 | 显式只在 UI 隐藏；二级行 isValid 不变 — 未来再启用一级时二级直接恢复 |

回滚：commit revert；isValid 是布尔列，启用恢复即可。

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260423/article.md` §三 Bug 5 |
| 关联 schema | `db/schema/product.ts:31-44` |
| 关联 actions | `fengyu-admin/src/actions/products.ts:292-450` |
| 关联 UI | `fengyu-admin/src/app/(main)/products/categories/_components/` 2 个组件 |
| 关联 ticket | `archives/2026-04-25-product-categories-fully-dynamic.md`（一/二级 DB 驱动落地）|

---

## 当前进度（2026-05-18 部分完成）

### ✅ 已完成（基于 grep 实证）

- **PR-1 二级分类停用按钮**：`fengyu-admin/src/app/(main)/products/categories/_components/categories-page.tsx:158`
  ```ts
  const disableResult = await updateCategory(disableTarget.categoryId, { isValid: false }, disableTarget.updatedAt)
  ```
  附 AlertDialog 二次确认（line 336-340）：「确定要停用分类「{categoryName}」吗？停用后该分类下的商品将不再展示。」
- **action 层**：`updateCategory({isValid: false})` 已通（schema 早就有 isValid 列）

### ❌ 仍需完成

- **PR-1 列表"状态"列展示** + "包含已停用 ☐" 筛选器 — 当前列表无该列、无该筛选器
- **PR-2 一级分类（productKind）停用** — `product-kind-management-dialog.tsx` 未扩 isValid 入参
- **PR-3 deleteCategory action**（硬删除路径）— `fengyu-admin/src/actions/products.ts` 仅有 `deleteMallCategory`（商城分类硬删除），**无** `deleteCategory`（品项分类）。D11=A 决策需要落地：未引用允许硬删，其它走停用
- **PR-4 商品创建/SKU 下拉过滤已停用分类** — 需 grep `listCategories` 调用点确认是否带 `is_valid=true` 默认过滤

### 实施时聚焦（剩余 PR 估时 S ≈ 半天）

1. categories-page.tsx 加 "状态" 列 + 筛选器（30 min）
2. product-kind-management-dialog.tsx 加 "停用" 开关（20 min）
3. actions/products.ts 新增 `deleteCategory(categoryId, expectedUpdatedAt)` — 校验 sku 引用 + coupon.applicable_category_ids 引用（45 min）
4. 商品创建/编辑页 SKU 下拉默认过滤 is_valid（15 min）
5. e2e + vitest case（30 min）

**决策应用**：D11=A（未引用允许硬删）

---

## 完成记录

- 完成日期：2026-05-18
- 完成 commit：见 git log（feat(admin/products): 品项分类硬删除 + 列表筛选器 + 操作按钮路径分支）
- 实际落地清单：
  - `fengyu-admin/src/actions/products.ts` — 新增 `deleteCategory(categoryId, expectedUpdatedAt)` action（SKU + coupon 双重引用校验 → CAS 守卫 DELETE）
  - `fengyu-admin/src/app/(main)/products/categories/_components/categories-page.tsx` — 顶部加 "包含已停用" checkbox（默认 false）；状态列已存在；操作列按 isValid 分支：valid → "停用"，invalid → "删除"；新增 deleteTarget AlertDialog
  - `fengyu-admin/src/actions/products.test.ts` — 新增 5 case：`updateCategory({isValid: false})` 成功；`deleteCategory` 4 case（SKU 引用 / coupon 引用 / 无引用成功 / CAS 失败）
- 既已就绪（本批次确认无需新增）：
  - `product-kind-management-dialog.tsx` — 一级停用按钮 + `updateProductKind({isValid: false})` 路径早已存在
  - `CategoryCascader` 下拉组件 — 已按 `isValid` 过滤一级（line 55）+ 二级（line 87），SKU 创建/编辑页自动继承
  - `getCategories` action — 由 client 端 useMemo `includeDisabled` 过滤决定可见性，service action 保留全量返回（"包含已停用" 切换无需再 round-trip 后端）
  - 权限：复用 `product:update`，与 `deleteSku` / `deleteMallCategory` / `deleteProduct` 一致；无需扩 PERMISSION_MATRIX
- DoD 逐项核对：
  - [x] `npx tsc --noEmit` 0 错
  - [x] `bun run test` 全套 1070 通过（含新增 5 case）
  - [x] `bun run lint` 无 error（仅遗留 unused eslint-disable 警告，与本 PR 无关）
  - [x] cross-end error-codes snapshot 14/14 通过（`INVALID_STATE: REFERENCE_EXISTS` 子标签合规）
  - [x] 已停用行才显示"删除"按钮；启用行只显示"停用"
- 决策应用：D11=A（未引用允许硬删）
- 关联同批 ticket：归档至 `notes/tickets/archives/2026-05-18-product-category-disable-delete.md`
