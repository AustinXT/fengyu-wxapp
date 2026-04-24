# Ticket: 开单"普通商品"分类目录改用排除法（admin + 员工端）

> 生成日期：2026-04-24
> 严重级别：**P1**（涉及 DB schema 变更 + admin 商品管理半成品激活 + 双端开单流程联动）
> 端：fengyu-admin（管理后台）+ fengyu-staff（员工端，云函数 + 小程序前端）+ db（schema + migration）
> 影响面：
>   - **db**: `productKindEnum` 删除、`product_categories.product_kind` 改 text、新增 migration
>   - **admin**: `getProductsByKind` 改造、`createCategory/updateCategory` 业务校验、`ProductKindManagementDialog` 实质激活、order-create-page 二级目录渲染
>   - **staffApi**: `product.shopInit/categories/skuList` 排除法 + 分组返回
>   - **staff 小程序**: order-create 二级目录侧边栏 + 排除法
> 拆分方式：3 PR 串行（PR-0 db+admin schema → PR-A admin 开单 → PR-B staff），PR-A 与 PR-B 在 PR-0 合并后可并行
> **DB schema 变更**：是（productKindEnum → text + 新增 migration 0003）

---

## 0 一句话背景

当前 admin 与员工端开单页"普通商品"目录都用**白名单**（写死 `['护理项目', '家居产品']`）匹配 `product_kind`，且员工端云函数**完全不过滤**——分类侧边栏依赖前端二次过滤。

后续业务可能新增非卡类的 `product_kind`（例如未来"福利活动"或其他护理子类），白名单写法每次都要补丁两端代码、易漏；且员工端云函数把全部 category（含充值卡/体验卡的目录名）下发到客户端，存在**冗余传输 + 单点遗漏即穿透**的风险。

业务诉求：**统一改为排除法** `product_kind NOT IN ('充值卡','体验卡')`，且过滤上提到 SQL 层。未来新增非卡 kind 直接被纳入"普通商品"目录，无需改代码。

> 设计澄清（2026-04-24 与用户多轮对齐）：
> 1. **数据模型**：保留 admin 现有"两类行"约定——`product_categories` 表里 `productKind IS NULL` 的行 = 一级 kind 定义（categoryName 即 kind 名）；`productKind IS NOT NULL` 的行 = 二级品项分类。**不引入新表**。
> 2. **取消 productKindEnum**：把 `product_categories.product_kind` 列从 PG 原生 enum 改为 text。让 admin 已有的 `ProductKindManagementDialog` / `createProductKind` / `updateProductKind`（半成品 UI 已存在但被 enum 卡住）真正能新建任意 kind。详见 §2.7。
> 3. **业务校验取代 enum 约束**：`createCategory` / `updateCategory` 强制校验 `productKind` 必须存在于"一级行"集合，避免误打字产生孤点。详见 §2.8。
> 4. **排除法**：`product_kind NOT IN ('充值卡','体验卡')`；卡名单**硬编码三处常量**（不在 db 加 is_card 字段）。代价是未来运营新建"赠送卡"类时**必须工程师同步加常量**——已记录为已知折中。
> 5. **组合套餐**：继续走独立分支（`is_bundle=true`），"普通商品"额外排除 `is_bundle=true` 的 SKU。
> 6. **二级目录**：进入"普通商品"后左侧侧边栏按 productKind 分组渲染——group header（不可点击）+ 子项（可点击）；group 顺序按一级行的 `sortOrder` 派生（不写死）。
> 7. **空分类 EXISTS 过滤**：分类下若没有 `is_enabled=true` 的非 bundle SKU，不出现在侧边栏。
> 8. **三端都要改**：db / admin / staff。详见 §7 PR 拆分。

---

## 1 现状盘点

### 1.1 数据库现状与目标

**`db/schema/product.ts` `product_categories`（两类行同表）**：

| 列 | 类型（现状） | 类型（目标） | 说明 |
|---|---|---|---|
| `category_id` | text PK | 不变 | 分类 ID |
| `category_name` | text | 不变 | 一级行时：kind 名；二级行时：分类名 |
| `product_kind` | **enum**（4 值） | **text**（可空） | NULL=一级行；非 NULL=二级行，值为某个一级行的 categoryName |
| `sales_category` | enum | 不变 | 销售类别（不影响本 ticket） |
| `sort_order` | int | 不变 | 排序；一级行的 sort_order 决定 group 顺序 |
| `is_valid` | bool | 不变 | 是否有效 |

**`db/schema/enums.ts` 目标**：删除 `productKindEnum`。所有 TS 类型从 `db/schema` 推断的位置自动变为 `string | null`。

**Migration 新增**：`db/migrations/0003_product_kind_to_text.sql`：
```sql
ALTER TABLE product_categories
  ALTER COLUMN product_kind TYPE text
  USING product_kind::text;
DROP TYPE product_kind;
```
按 `project_db_dual_env` memory：需在 5433（fengyu_wxapp，云函数用）+ 5434（fengyu，admin 用）双库都执行。

组合套餐通过 `products.is_bundle = true` 表达，**不是 product_kind**。

### 1.2 Admin 现状

| 文件 | 行号 | 现状 | 目标 |
|---|---|---|---|
| `fengyu-admin/src/actions/products.ts` | `:99-119` `getProductKinds()` | `WHERE productKind IS NULL` 取一级行；已实现 | 不动逻辑；类型签名因 enum 删除自动变为 string |
| `fengyu-admin/src/actions/products.ts` | `:124-161` `createProductKind()` | 写入 `productKind: null` 的一级行；**当前能跑**（写 null 不触 enum） | 不动 |
| `fengyu-admin/src/actions/products.ts` | `:167-236` `updateProductKind()` | 改 categoryName 时级联 `set({ productKind: newName as ProductKind })` 用 `as ProductKind` cast 绕开类型检查；**enum 还存在时这是个 bug**——若新名不在 4 枚举值内，DB 会报 `invalid input value for enum`；当前只有 4 个一级行没人改名所以没爆 | enum 删除后 cast 改为 `as string` 或干脆去掉 cast；级联 SQL 不变，运行时不再受 enum 约束 |
| `fengyu-admin/src/actions/products.ts` | `:238-308` `createCategory` / `updateCategory` | 直接接受 `productKind: string` 写入；当前依赖 enum 拦截非法值 | enum 删除后**业务校验**取代 DB 校验：写入前查 `WHERE productKind IS NULL AND categoryName = $kind AND isValid = true`，不存在则返回 `INVALID_PRODUCT_KIND: 一级品项类型不存在` |
| `fengyu-admin/src/actions/products.ts` | `:1210` `ProductKindForOrder` 联合类型 | `'护理项目' \| '家居产品' \| '体验卡' \| '充值卡' \| '__bundle__'` | 改为 `string \| '__bundle__' \| '__normal__'`（或保留具体字面量但不再依赖 enum）。具体见 §2.3 |
| `fengyu-admin/src/actions/products.ts` | `:1270-1403` `getProductsByKind(kind)` | 接受单个 `ProductKindForOrder`；普通分支 `eq(productCategories.productKind, kind)` 单值匹配 | 增加 `'__normal__'` 分支：`notInArray(productCategories.productKind, CARD_PRODUCT_KINDS) AND isNotNull(productCategories.productKind)`；返回结构增加 `groups: [{ productKind, categories: [...] }]`，按 (一级行的 sortOrder, 二级行的 sortOrder) 排序 |
| `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` | `:50-55` `resolveBackendKinds()` | `'普通商品' → ['护理项目','家居产品']`（白名单数组），调用方 for 循环多次调 `getProductsByKind` 然后合并 | 改为返回**单一**值 `'__normal__'`，一次调用即可拿到 groups 结构 |
| `fengyu-admin/src/app/(main)/orders/_components/order-create/normal-sku-picker.tsx` | `:36-123` | 左侧 `categories.map` **平铺**渲染 `cat.categoryName`（无父分组），右侧 SKU 网格 | 改为按 `groups` 渲染：每个 productKind 一个不可点击的 group header（小字+灰底），其下挂 `category_name` 子项（可点击、参与 `selectedCategoryId` 选中态）。仅"普通商品"分支用分组；体验卡 / 充值卡分支保持平铺 |
| `fengyu-admin/src/app/(main)/products/categories/_components/categories-page.tsx` | 全文件 | 已实现"两类行 Tab"UI；当前因为 enum 限制 `createProductKind` 只能新建 4 个固定 kind | enum 删除 + createCategory 业务校验后**实质激活**：用户可新建任意 kind，新 kind 出现在 Tab 列表 + 普通商品分组 |
| `fengyu-admin/src/app/(main)/products/categories/_components/product-kind-management-dialog.tsx` | 全文件 | 半成品 UI 已存在 | 同上，自动激活；不需要改 |
| `fengyu-admin/src/components/ui/category-cascader.tsx` | 全文件 | 商品管理页用，列出 kind→category 联动 | 扫描确认 `productKind` 类型用法是否依赖 enum 字面量；若有则改为从 `getProductKinds()` 动态获取 |
| `fengyu-admin/src/lib/types.ts` 等 | 全文件 | 引用 `productKindEnum` 推断的类型 | enum 删除后类型变为 string；需逐处确认无运行时差异 |

### 1.3 Staff 现状

| 文件 | 行号 | 现状 | 目标 |
|---|---|---|---|
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | `:19-26` `_queryCategoryRows()` | `SELECT ... WHERE is_valid = true ORDER BY sort_order ASC`（**全量**，无 product_kind 过滤） | 扩展签名 `_queryCategoryRows({ kindIn?, kindNotIn? } = {})`；SQL 增加 `AND product_kind = ANY($x)` 或 `AND product_kind <> ALL($x)`；保留默认行为（无参=全量），避免影响其他 action |
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | `:163-177` `shopInit()` | 调 `_queryCategoryRows()` → 取首分类 → `_queryFormattedSkuList(categories[0].id, null)` → 套餐分组 | 调 `_queryCategoryRows({ kindNotIn: CARD_PRODUCT_KINDS })`，并要求所返回分类下存在 `is_bundle=false` 的有效 SKU（`EXISTS` 子查询；防止空分类残留） |
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | `:182-186` `categories(ctx)` | 直接返回 `_queryCategoryRows()` 全量 | **保留全量行为**；如果前端需要"普通商品"专用列表，请通过 `shopInit` 或新增参数 `payload.kindNotIn`，不破坏 `categories` 现有契约 |
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | `:188-195` `skuList(ctx)` | `_queryFormattedSkuList(categoryId, productKind)` | 评估：`shopInit` 后续切换分类是直接传 `categoryId`，由于分类已被排除，自然不会请求到充值卡/体验卡的 categoryId；保持函数签名不变 |
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 顶部 | 无相关常量 | 顶部新增 `const CARD_PRODUCT_KINDS = ['充值卡', '体验卡']` |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | `:15` | `PRODUCT_KIND_CHOICES = ['组合套餐','普通商品','体验卡','充值卡']`（4 Tab） | 不变（UI 4 选 1 保留） |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | `:152-159` `filterSkusByKindChoice()` | `'普通商品'` 走白名单 `productKind IN {护理项目, 家居产品} && !isBundle` | 改排除法：`!CARD_PRODUCT_KINDS.includes(s.productKind) && !s.isBundle`；其他 Tab 保持精确匹配 |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | `:161-168` `filterCategoriesByKindChoice()` | `'普通商品'` 走白名单 `productKind IN {护理项目, 家居产品}` | 改排除法：`!CARD_PRODUCT_KINDS.includes(c.productKind)`；其他 Tab 保持精确匹配 |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 顶部 | 无相关常量 | 顶部新增 `const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const` |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | data + onLoad | data.categories 是平坦 `Category[]`，直接喂 `<van-sidebar>` | "普通商品"模式下需要派生 `groupedCategories: { kind: string; items: Category[] }[]`：按 `productKind` 分组、组内按 `sortOrder` 排，组间按 kind 出现顺序（或固定护理项目优先）排序。其他 Tab 仍用平坦 categories |
| `fengyu-staff/miniprogram/pages/order-create/order-create.wxml` | `:32-39` | 单层 `<van-sidebar>` + `<van-sidebar-item wx:for="{{categories}}">`，自带选中态 | "普通商品"模式下放弃 `<van-sidebar>`（其不支持分组），改为 `<scroll-view><view wx:for="{{groupedCategories}}"><view class="group-header">{{kind}}</view><view wx:for="{{item.items}}" class="cat-item {{activeCategoryId === sub.id ? 'active' : ''}}" bindtap>{{sub.name}}</view></view></scroll-view>` 结构。其他 Tab 保留 van-sidebar |
| `fengyu-staff/miniprogram/pages/order-create/order-create.wxss` | 新增 | 无 | 加 `.group-header`（背景灰、12px、不可点击、padding 8px 16px）、`.cat-item`（padding、字号）、`.cat-item.active`（左侧红色竖条 + 白底，参考 van-sidebar 视觉） |

---

## 2 设计决策

### 2.1 排除集合 vs 白名单——为什么不维持现状

| 方案 | 优点 | 缺点 | 采用 |
|---|---|---|---|
| 维持现状（白名单 `['护理项目','家居产品']`） | 改动 0 | 新增非卡 kind 时四处补丁；admin/staff 容易不一致 | ❌ |
| 排除法 `NOT IN ('充值卡','体验卡')` | 未来新增 kind 自动归入；语义直接表达"普通商品 = 非卡" | 若引入"既非卡又不归普通商品"的第 5 类，需要再扩展集合 | ✅ |
| 加 `product_kind_meta.is_card` 标志位 | 业务维度可配置；可扩展"卡类"概念 | 表结构改动 + 数据回填 + admin 维护页，本次范围太大 | ❌ 留作后续 |

**采用排除法 + 硬编码常量**。约定：以后新增"卡类" `product_kind`（例如赠送卡）时，只需把新值加入 `CARD_PRODUCT_KINDS` 常量；新增非卡 kind 时**零代码变更**。

### 2.2 共享常量放哪里

| 方案 | 实现 | 评价 |
|---|---|---|
| A: 各端各自 `const` | admin `src/lib/product-kind.ts`、staff 云函数 `routes/product.js` 顶部、staff 小程序 `order-create.ts` 顶部各写一份 | ✅ 推荐：staff 云函数纯 JS、不便从 db package 导入 TS；3 处复制成本低；新增"卡 kind"时 grep 关键字定位即可 |
| B: db package 导出 + staff 云函数 require | `db/lib/product-kind.ts` 导出，admin import；staff 云函数 require `../../../db/lib/...` | ❌ db 是 TS 包，云函数 deploy 时不会打包；需要为云函数另维护一份 JS 镜像，反而更乱 |
| C: 写在 cog/spec 文档由人工同步 | 不在代码 | ❌ 无强约束 |

**采用 A**。三处复制时给 `// 与 db 枚举 product_kind 中的"卡"类对齐` 短注释指明语义来源。

### 2.3 Admin `getProductsByKind` 签名设计

当前签名 `getProductsByKind(kind: ProductKindForOrder)` 接收单值。两种重构思路：

**方案 1（推荐）**：扩展 `ProductKindForOrder` 联合类型增加 `'__normal__'`：
```ts
type ProductKindForOrder = '护理项目' | '家居产品' | '体验卡' | '充值卡' | '__bundle__' | '__normal__'

export async function getProductsByKind(kind: ProductKindForOrder): Promise<OrderPickerResult> {
  if (kind === '__bundle__') { /* 现状不变 */ }
  if (kind === '__normal__') {
    // SQL: WHERE product_kind NOT IN CARD_PRODUCT_KINDS AND product_kind IS NOT NULL
    //      AND productSkus.isEnabled AND categories.isValid
    //      AND 该 SKU 不在 mall_product_skus 关联 is_bundle=true 的 products 中（否则会让套餐 SKU 重复出现在普通商品目录）
  }
  // 单一 kind 分支：保留旧逻辑（用于"体验卡" / "充值卡" 单 Tab，类型上仍能传单值）
}

function resolveBackendKinds(choice: ProductKindChoice): ProductKindForOrder {
  if (choice === '组合套餐') return '__bundle__'
  if (choice === '普通商品') return '__normal__'
  if (choice === '体验卡') return '体验卡'
  return '充值卡'
}
```
返回值类型 `OrderPickerResult` 的 `kind` 域增加 `'__normal__'` 字面量。调用方 `resolveBackendKinds` 返回单值（不再是数组），消除前端"多次调用合并"的复杂度。

**方案 2**：参数对象 `getProductsByKind({ kind?, excludeKinds? })`。更灵活但调用点改造面更大。

**采用方案 1**：与现有 `__bundle__` 占位风格一致；调用面最小。

### 2.4 侧边栏二级目录的渲染方案（仅"普通商品"模式）

**结构**：
```
[普通商品 模式]
┌─────────────────┐  ┌──────────────┐
│ 护理项目         │  │  SKU 网格    │
│   面部护理 ←选中 │  │              │
│   身体护理       │  │              │
│   眼部护理       │  │              │
│ 家居产品         │  │              │
│   洗护           │  │              │
│   美妆           │  │              │
└─────────────────┘  └──────────────┘
```

**实现要点**：
- group header（productKind 名）= **不可点击**、视觉上比子项弱（小字号、灰底或无底色）
- 子项（categoryName）= 唯一可点击元素，参与选中态
- 选中态（active）保持现有视觉（左侧红色竖条 + 白底，参考 van-sidebar 默认样式）
- 默认选中：第一个 productKind 下的第一个 category（即 `groupedCategories[0].items[0]`）
- 切换商品类型 Tab 时，重置选中到当前 Tab 第一个有效 category（已有逻辑，不变）

**后端排序约定**：`getProductsByKind('__normal__')` 与 `_queryCategoryRows({ kindNotIn })` 必须保证 categories 按 `(product_kind, sort_order)` 排序——同 kind 行连续。这样前端按 productKind 顺序遍历分组即可，无需先全表打散再聚合。

**简化方案**：后端可直接返回**已分组结构** `{ groups: [{ kind, items: [{categoryId, categoryName, ...}] }] }`，省掉前端的 group-by 逻辑：
- Admin `getProductsByKind('__normal__')` 返回 `{ kind: '__normal__', groups: [{ productKind, categories: OrderPickerCategory[] }] }`（在原 `categories` 平铺基础上多一层）
- Staff 云函数 `shopInit` 在返回时同时给 `categories`（平坦，兼容老前端）+ `groupedCategories`（分组，新前端用）

**采用前者（已分组结构）**——契约更清晰，避免前端两端各做一次相同的 group-by。

### 2.5 体验卡 / 充值卡 Tab 是否也分组

不分组。这两个 Tab 在排除法之外（精确 productKind 匹配），其下的 category 全部属于同一个 productKind，本来就只有一组——加 group header 反而冗余。**仅"普通商品"模式启用分组**渲染。

### 2.6 group 顺序如何派生

`getProductsByKind('__normal__')` 与 `staffApi.product.shopInit` 返回的 `groups[]` 顺序由 SQL 决定：

```sql
SELECT
  child.*,
  parent.category_name AS kind_name,
  parent.sort_order   AS kind_sort_order
FROM product_categories child
JOIN product_categories parent
  ON parent.product_kind IS NULL
  AND parent.category_name = child.product_kind
WHERE child.product_kind IS NOT NULL
  AND child.product_kind NOT IN ('充值卡', '体验卡')
  AND child.is_valid = true
  AND parent.is_valid = true
  AND EXISTS (
    SELECT 1 FROM product_skus sk
    WHERE sk.category_id = child.category_id
      AND sk.is_enabled = true
      -- 排除 bundle SKU
      AND NOT EXISTS (
        SELECT 1 FROM mall_product_skus mps
        JOIN products p ON p.product_id = mps.product_id
        WHERE mps.sku_id = sk.sku_id AND p.is_bundle = true
      )
  )
ORDER BY parent.sort_order, child.sort_order
```

**group 顺序 = 一级行 sort_order**；**组内顺序 = 二级行 sort_order**。两者均由运营在 admin 商品分类管理页维护，前端零硬编码。

### 2.7 productKindEnum → text migration 方案

**Migration 文件**：`db/migrations/0003_product_kind_to_text.sql`（编号沿用现有 0001/0002 的递增）

```sql
-- 0003_product_kind_to_text.sql
ALTER TABLE product_categories
  ALTER COLUMN product_kind TYPE text
  USING product_kind::text;

DROP TYPE product_kind;
```

**回滚预案**（仅用于本地开发误执行；生产不准回滚）：
```sql
CREATE TYPE product_kind AS ENUM ('护理项目', '家居产品', '充值卡', '体验卡');
ALTER TABLE product_categories
  ALTER COLUMN product_kind TYPE product_kind
  USING product_kind::product_kind;
```
注：回滚时如已新建 enum 之外的 kind，回滚会报错。一旦 PR-0 合并并跑生产 migration，该决策**单向**。

**双库执行**：参考 `project_db_dual_env` memory，5433（fengyu_wxapp）+ 5434（fengyu）都要跑 `bunx drizzle-kit migrate`。建议：先在 5434（admin 用，写多）跑、再 5433（云函数用，读多）跑、跑完两侧 grep `\dT product_kind` 确认 enum 已删。

**Drizzle schema 同步**：
- `db/schema/enums.ts`：删除 `export const productKindEnum = pgEnum(...)` 整行
- `db/schema/product.ts:14`：`productKind: productKindEnum('product_kind')` → `productKind: text('product_kind')`
- 然后 `bun run db:generate` 应该会自动检测并产生 0003 migration（人工核对/调整）

### 2.8 业务层校验取代 enum 约束

enum 删除后，`product_categories.product_kind` 列允许任意 text。需要 admin 业务层守卫，避免运营/工程师误打字（"护理项目" vs "护理项目"看起来一样但字符不同）。

**校验点**：
1. `createCategory(data)`：插入二级行前查
   ```ts
   const exists = await db.select().from(productCategories)
     .where(and(
       isNull(productCategories.productKind),
       eq(productCategories.categoryName, data.productKind),
       eq(productCategories.isValid, true)
     )).limit(1)
   if (!exists[0]) return { success: false, message: 'INVALID_PRODUCT_KIND: 一级品项类型不存在或已停用' }
   ```
2. `updateCategory(id, data)`：同上，仅在 `data.productKind !== undefined` 时校验
3. `updateProductKind(id, data)` 的级联更新：当一级行被改名时，自动 `UPDATE product_categories SET product_kind = newName WHERE product_kind = oldName`——保持现有逻辑，cast `as ProductKind` 删除

**不强校验**的位置：
- 二级行 `createCategory` 时新建一级行的"先有鸡先有蛋"流程：admin UI 已强制先创建一级 Tab 才能新建二级；CLI/直连 DB 的非常规路径不防御
- staff 云函数读侧（仅 SELECT）

### 2.9 卡类硬编码 vs 自由新建 kind 的折中

**已知风险**：`CARD_PRODUCT_KINDS = ['充值卡', '体验卡']` 是工程层硬编码三处。运营在 admin 新建一个名为"赠送卡"的一级 kind 后：
- 系统**不会**把"赠送卡"识别为卡
- "赠送卡"会被错误归入"普通商品"目录（因为 NOT IN 不匹配）
- 必须工程师手动把 `'赠送卡'` 加入三处常量并重新部署 admin / staff 云函数 / staff 小程序

**用户已知晓并接受**（2026-04-24 决策）。本 ticket 不引入 `is_card` 字段，也不抽 lookup 表。如果未来"卡类"成为高频运营动作，再独立 ticket 升级为元数据驱动。

**实施约定**：
- 三处常量同名 `CARD_PRODUCT_KINDS`，值完全一致
- 在 admin `src/lib/product-kind.ts` 文件头部加注释提醒：
  ```ts
  // 注意：这是硬编码常量。新增"卡"类 product_kind 时必须同步更新：
  // - fengyu-admin/src/lib/product-kind.ts (本文件)
  // - fengyu-staff/cloudfunctions/staffApi/routes/product.js 顶部
  // - fengyu-staff/miniprogram/pages/order-create/order-create.ts 顶部
  export const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const
  ```

### 2.10 是否在"普通商品"分类列表中过滤掉空分类

> 当前 admin 是 `INNER JOIN productSkus`，自然只返回有 SKU 的分类——不会出现空分类。
> 当前 staff `_queryCategoryRows` 不 join SKU，会出现"分类有效但下面没有 SKU"的空分类（理论上 is_valid=true 的分类应当至少有 SKU，但需防御）。

`shopInit` 改造时建议在 `_queryCategoryRows({ kindNotIn })` 内追加 `EXISTS` 子查询（限定有 `is_enabled=true` 且非套餐的 SKU），避免左侧侧边栏出现"点了没东西"的死分类。

---

## 3 影响传播扫描清单

实施者请按以下顺序 grep 全仓，确认所有点已覆盖：

### 3.1 DB / schema
1. `grep -rn "productKindEnum\|product_kind" db/schema/` — 所有引用点（仅 enums.ts + product.ts，需要修改）
2. `grep -rn "productKindEnum" db/` — 包括 seed.ts、scripts/
3. `bun run db:generate` 后人工核对 0003 migration 内容
4. 5433 + 5434 双库分别跑 `bunx drizzle-kit migrate`，并 `\dT product_kind` 验证 enum 已删

### 3.2 Admin
1. `grep -rn "productKindEnum" fengyu-admin/src` — 任何依赖 enum 类型推断的位置（types.ts、actions/products.ts、cards.ts、coupons.ts 等已知有引用）
2. `grep -rn "getProductsByKind(" fengyu-admin/src` — 所有调用点改造为传单值
3. `grep -rn "resolveBackendKinds" fengyu-admin/src` — 仅应在 `order-create-page.tsx` 出现
4. `grep -rn "护理项目.*家居产品\|家居产品.*护理项目" fengyu-admin/src` — 找出其他白名单写死的位置
5. `grep -rn "ProductKindForOrder\|OrderPickerResult" fengyu-admin/src` — 联合类型扩展后，所有判别使用处需补 `'__normal__'` 分支
6. `grep -rn "as ProductKind\b" fengyu-admin/src` — 行 225 cast hack 删除；其他 cast 位置一并清理
7. `grep -rn "'护理项目'\|'家居产品'\|'充值卡'\|'体验卡'" fengyu-admin/src` — 找出硬编码 kind 字面量的位置（除 CARD_PRODUCT_KINDS 外应清零）
8. `category-cascader.tsx` — 检查 kind 下拉来源是否需要改为 `getProductKinds()`
9. `actions/cards.ts` / `actions/coupons.ts` — grep `productKind` 引用，如果有 enum 字面量过滤要改 string 比较

### 3.3 Staff 云函数
1. `grep -rn "_queryCategoryRows" fengyu-staff/cloudfunctions/staffApi` — 该函数仅在 `routes/product.js` 内被 `shopInit` / `categories` 调用
2. `grep -rn "product_kind" fengyu-staff/cloudfunctions/staffApi` — 找出其他可能硬编码 product_kind 的 SQL（service / order / coupon 等）
3. 注意所有现有 SQL `product_kind = $x` 不需要改（text 字段直接比较）；但**所有"取二级分类"的查询都要带 `product_kind IS NOT NULL`** 否则会把"一级行"误返回
4. 不应影响：`order.js`（开单/退款/转换/回款），`service.js`，`appointment.js`，`coupon.js`——除非这些表/查询里也按 kind 过滤

### 3.4 Staff 小程序
1. `grep -rn "护理项目.*家居产品\|productKind.*护理项目\|productKind.*家居产品" fengyu-staff/miniprogram` — 找出所有白名单写死的位置
2. `grep -rn "PRODUCT_KIND_CHOICES" fengyu-staff/miniprogram` — 仅 `order-create.ts` 使用，UI 4 选 1 不变
3. `grep -rn "filterSkusByKindChoice\|filterCategoriesByKindChoice" fengyu-staff/miniprogram` — 两个对称的过滤函数都要改

### 3.5 二级目录改造的额外扫描点

1. `grep -rn "OrderPickerCategory\|OrderPickerResult" fengyu-admin/src` — 类型增加 groups 字段后，所有消费方需重新对齐字段
2. `grep -n "van-sidebar\|sidebar-item" fengyu-staff/miniprogram/pages/order-create/order-create.wxml` — 确认仅替换"普通商品"分支的渲染
3. Admin `normal-sku-picker.tsx` 的"4 类 picker 中的主力"注释（文件开头）需更新——它现在是分组结构，不再是平铺
4. UI 设计规范 `.42cog/design/admin.ui.spec.md` 与 `.42cog/design/staff.ui.spec.md` 中"开单页 商品选择 侧边栏"的描述需要同步更新（标注：仅普通商品模式分组，其他模式平铺）

### 3.6 文档同步
1. `.42cog/pm/admin.pr.spec.md` — 商品分类管理章节：从"4 个固定 product_kind"改为"运营可自由新建一级品项类型"
2. `.42cog/pm/backend.pr.spec.md` v2.1.0 商品表说明：增加"取消 productKindEnum"
3. `.42cog/pm/staff.pr.spec.md` — 开单"普通商品" Tab 描述：从"护理项目 + 家居产品 合并"改为"排除卡类外的所有 product_kind"
4. CLAUDE.md（根目录）— 全局规范的 product_kind 4 值描述需要更新为"动态、不限值"

### 3.7 不受影响（不需改）
- 数据库 schema / migrations
- `db/schema/enums.ts` `product_kind` 枚举
- 充值卡 Tab、体验卡 Tab、组合套餐 Tab 的展示链路
- 订单创建（`order.create` / admin `createOrder`）—— SKU 校验只看 `product_skus.is_enabled`，与分类筛选无关
- 提成、积分、统计、营业额分配
- WorkFine 同步链路
- 其他 client / admin 功能

---

## 4 验证清单

### 4.1 PR-0 Migration / Admin schema 验证

- 双库执行 `bunx drizzle-kit migrate`，`\dT product_kind` 应显示 type 不存在
- 现有 4 个一级行 + N 个二级行数据完整保留，`SELECT product_kind, count(*) FROM product_categories GROUP BY product_kind ORDER BY 1` 与 migration 前一致
- admin 登录商品分类管理页 → 新建一级 kind"测试 kind X" → 在 X 下挂二级 → 切换 Tab 能看到 → 编辑 X 改名为"测试 kind Y"，二级行 productKind 自动跟随
- `createCategory` 校验：传 `productKind: '不存在的 kind'` 应返回 `INVALID_PRODUCT_KIND`

### 4.2 Admin 单元测试（Vitest）

新增 `fengyu-admin/src/actions/__tests__/products-getProductsByKind.test.ts` 用例：

- `getProductsByKind('__normal__')` 返回 `kind: '__normal__'`，`groups[].productKind` 不含 `'充值卡'` 或 `'体验卡'`
- 准备测试 fixture：插入一条一级行 `productKind=null, categoryName='福利活动'` + 一条二级行 `productKind='福利活动'` + 关联非 bundle SKU；断言**自动出现在** `__normal__` 返回中
- 断言 groups 顺序按一级行 sortOrder
- 断言空分类（无有效非 bundle SKU）不出现
- `getProductsByKind('充值卡')` 返回值不变，仅含 `productKind='充值卡'` 的 category
- `getProductsByKind('__bundle__')` 行为不变
- `createCategory({ productKind: '不存在的 kind' })` 返回 `INVALID_PRODUCT_KIND`

### 4.3 Staff 云函数单元测试

`fengyu-staff/cloudfunctions/staffApi/__tests__/product.test.js`（如不存在则新建）：

- `shopInit` 返回 `categories[] / groupedCategories[]` 中无 `productKind ∈ {充值卡, 体验卡}` 的 category
- `categories` action（无参）返回**全量**分类（包含充值卡/体验卡 + **不含**一级行），证明老接口契约保留 + 一级行被 `productKind IS NOT NULL` 过滤掉
- `_queryCategoryRows({ kindNotIn: ['充值卡','体验卡'] })` 直接断言
- 准备 fixture：插入一级行"福利活动" + 二级 + SKU，断言 `shopInit` 返回的 `groupedCategories` 包含"福利活动"组

### 4.4 E2E 验证

**Admin（Playwright）**：
- 进入"开单"页 → Step 1 选"普通商品" → 进入 Step 2 商品选择 → 左侧侧边栏**断言不出现**任何 `product_kind ∈ {充值卡, 体验卡}` 的 category_name
- 左侧侧边栏**断言出现至少 2 个 group header**（"护理项目" + "家居产品"），且 group header 不可点击（`role` 非 button、点击不触发 SKU 列表刷新）
- 选中第一个 group 第二个子项 → 右侧 SKU 网格刷新；选中第二个 group 第一个子项 → SKU 网格再次刷新；两次选中都生效
- 切换到"充值卡" / "体验卡" 单选 → 侧边栏**回到平铺**模式（无 group header），仍能看到对应分类
- 切换到"组合套餐" → BundlePicker 仍工作

**Staff（开发者工具手动）**：
- 工作台 → 开单 Tab → 顶部"普通商品"Tab → 左侧侧边栏分类列表**不出现**充值卡/体验卡的目录名
- **出现 ≥2 个 group header**（"护理项目" + "家居产品"），group header 视觉弱化（小字号/灰底）且 tap 无响应
- 子项可点击，选中态正常切换、右侧 SKU 网格刷新
- 切换到"充值卡" / "体验卡" Tab → 侧边栏回到 `<van-sidebar>` 平铺模式
- 切换到"组合套餐" Tab → BundlePicker 仍工作

**API 契约验证**：
- `getProductsByKind('__normal__')` 返回 `{ kind: '__normal__', groups: [{ productKind, categories: [...] }] }`，groups 非空且每组 categories 非空
- `staffApi.product.shopInit` 返回 `groupedCategories: [{ productKind, items: [...] }]`，老字段 `categories` 仍保留（兼容期）或移除（取决于 staff 端是否一并迁移）

### 4.5 回归
- 跑 `cd fengyu-admin && bun run test`（537 用例 + 新增）
- `cd fengyu-admin && npx tsc --noEmit`（联合类型扩展 + enum 删除后的类型推断完整）
- `cd fengyu-admin && bun run build`（生产构建无 enum 残留报错）
- 部署 staff 云函数后，调 `staffApi.product.shopInit` 检查 `groupedCategories` 数组

---

## 5 决策记录（已对齐）

| # | 议题 | 决策 |
|---|---|---|
| 5.1 | "普通商品"模式下空分类（无有效 SKU）是否剔除 | **剔除**——SQL 层 EXISTS 子查询过滤（含排除 bundle SKU），见 §2.6 SQL |
| 5.2 | 共享常量 `CARD_PRODUCT_KINDS` 定义位置 | **三处各自 const**——admin lib + staff 云函数顶部 + staff 小程序顶部，加同步提醒注释 |
| 5.3 | admin `ProductKindForOrder` 联合类型增加 `'__normal__'` 后下游波及 | **实施时 grep**—— `OrderPickerResult` / `ProductKindForOrder` 用法逐处补；预计仅 order-create 链路 |
| 5.4 | group header 顺序如何派生 | **不写死**——按"一级行 sortOrder"派生（SQL JOIN 自身）；运营在 admin 商品分类管理页可调整 |
| 5.5 | group header 是否显示数量徽标（如 `护理项目 (5)`） | **不显示**，只显 kind 名 |
| 5.6 | staff 自定义 view 替代 `<van-sidebar>` 的交互细节 | **只补 hover-class + active 高亮**；scrollIntoView / 点击波纹等不实现 |
| 5.7 | productKindEnum 是否一并改 text | **是**——本 ticket 一并做，激活 admin 现有半成品 UI；详见 §2.7 |
| 5.8 | enum 删除后如何防止误打字 | createCategory / updateCategory 业务校验 productKind 必须在一级行集合；详见 §2.8 |
| 5.9 | "卡类"是否升级为 db 元数据 | **不升级**——继续硬编码常量；接受"运营新建卡类时需工程师同步"的折中；详见 §2.9 |
| 5.10 | 一级 kind 定义的存放模型 | **保留现状**——product_categories 同表，`productKind IS NULL` 标识一级行 |

---

## 6 UI 规格补充（侧边栏二级目录）

### 6.1 ASCII mock（"普通商品"模式）

```
┌──────────────┬────────────────────────────────────┐
│ 护理项目      │  ┌──────┐ ┌──────┐ ┌──────┐       │
│   面部护理 ●  │  │ SKU1 │ │ SKU2 │ │ SKU3 │       │
│   身体护理    │  └──────┘ └──────┘ └──────┘       │
│   眼部护理    │  ┌──────┐ ┌──────┐                │
│ 家居产品      │  │ SKU4 │ │ SKU5 │                │
│   洗护        │  └──────┘ └──────┘                │
│   美妆        │                                    │
│   保健        │                                    │
└──────────────┴────────────────────────────────────┘
```
- `护理项目` / `家居产品` 为 group header（不可点击、灰底/小字、左边无竖条）
- `面部护理 ●` 为当前选中态（左侧红色竖条 + 白底 + 加粗）
- 选中态在 group 子项级别，不在 group header

### 6.2 视觉规则

| 元素 | 颜色 / 字号 | 交互 |
|---|---|---|
| group header | 14px / `#888888` / 背景 `#F7F7F7` | 不可点击；`pointer-events: none` 或 wxml 不绑事件 |
| 子项（默认） | 14px / `#333333` / 背景白 | tap 切换 activeCategoryId |
| 子项（active） | 14px / 品牌红 `#C0322A` / 背景白 / 加粗 / 左侧 4px 红色竖条 | — |
| 分组之间 | 无显式分隔线（靠 group header 的灰底自然分隔） | — |

### 6.3 边界

- 当某个 productKind 下没有任何 category（理论上不会发生，但需防御）→ 该 group **整体不渲染**（连 header 也不显示）
- 当 categories 全空（运营失误）→ 显示当前已有的 empty 提示（"暂无商品分类"），不渲染分组结构

---

## 7 实施步骤建议

3 个 PR 串行 merge：PR-0 必须先合并（schema + 业务校验是后续两端依赖的基础），PR-A / PR-B 在 PR-0 后可并行。

### PR-0（db + admin schema 基础）—— 必须先合并

- `db/schema/enums.ts`：删除 `productKindEnum` 导出
- `db/schema/product.ts:14`：`productKind: productKindEnum(...)` → `productKind: text('product_kind')`
- `bun run db:generate` → 人工核对生成的 `0003_product_kind_to_text.sql`
- 双库执行 migration（5433 + 5434）；`\dT product_kind` 验证 enum 已删
- `actions/products.ts:225` 删除 `as ProductKind` cast；`updateProductKind` 级联 SQL 改为传 string
- `actions/products.ts:238/268` `createCategory` / `updateCategory` 增加 productKind 业务校验（先查一级行存在）
- 全仓 grep `productKindEnum` / `as ProductKind` 清理类型推断点
- 部署到 staging 验证 admin 商品分类管理页能新建任意一级 kind（例如建一个"福利活动"测试 kind，confirm 能挂二级 + 能编辑 + 能停用）
- 单元测试：`createCategory` 校验失败用例、新建一级 kind 后能挂二级、改名级联生效

### PR-A（admin 开单二级目录 + 排除法）

- 新增 `fengyu-admin/src/lib/product-kind.ts` 导出 `CARD_PRODUCT_KINDS`（含同步提醒注释）
- 扩展 `ProductKindForOrder` 联合类型增加 `'__normal__'`
- `getProductsByKind('__normal__')` 实现：JOIN 一级行 + 排除卡 + EXISTS 非 bundle SKU + ORDER BY (parent.sort_order, child.sort_order)
- 返回结构扩展：`'__normal__'` 模式下返回 `{ kind: '__normal__', groups: [{ productKind, categories }] }`
- 改 `resolveBackendKinds` 返回单值 `'__normal__'`
- `order-create-page.tsx` 调用方一并改为单值传参 + 消费 groups
- `normal-sku-picker.tsx` 侧边栏按 `groups` 渲染：group header 不可点击（小字 + 灰底）+ 子项可点击；非 `'__normal__'` 模式保持平铺
- 单元测试 + Playwright E2E 断言侧边栏 group header 数量、不可点击性、跨组选中切换

### PR-B（staff 云函数 + 小程序）

- 云函数 `routes/product.js` 顶部加 `CARD_PRODUCT_KINDS` 常量
- `_queryCategoryRows` 扩展可选 `{ kindIn, kindNotIn, withParentJoin }`
- `shopInit` 传 `kindNotIn` + EXISTS 过滤空分类 + 一级行 JOIN，返回额外字段 `groupedCategories: [{ productKind, items, kindSortOrder }]`（保留 `categories` 平铺字段做兼容期或一并迁移）
- 所有"取二级分类"的 SQL 增加 `product_kind IS NOT NULL`，避免误把一级行当二级返回
- 小程序 `order-create.ts` 顶部加常量；两个 filter 函数改排除法；data 层增加 `groupedCategories` 派生
- `order-create.wxml` 增加 `wx:if="{{productKindChoice === '普通商品'}}"` 分支：用自定义 view 渲染分组列表（含 hover-class + active 高亮）；其他 Tab 保留 `<van-sidebar>`
- `order-create.wxss` 加 `.group-header / .cat-item / .cat-item-hover / .cat-item.active` 样式
- 云函数单元测试 + 部署 + 开发者工具手动验证两种模式的侧边栏

### 上线节奏建议
- PR-0 合并后**先观察 admin 商品分类页 24-48h**（确认运营没踩到 enum 残留 bug）
- 再合并 PR-A 和 PR-B（可同日上线）
- spec 文档 + CLAUDE.md 同步更新可放到任一 PR 的 docs 提交里（推荐 PR-0）

两端不需要互相等待；spec 文档 `.42cog/pm/admin.pr.spec.md` 和 `.42cog/pm/staff.pr.spec.md` 中"普通商品"目录的描述同步更新（指明排除法语义）。
