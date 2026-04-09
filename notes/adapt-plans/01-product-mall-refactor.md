# 差异报告: 商品管理重构 + 商城管理职责分离

> **方法论来源**: `.claude/skills/wx-requirement-adapt/SKILL.md`（§3 代码路径追踪 + §4 差异报告模板）
> **输入会议**:
> - `notes/meetings/meeting-20260324/article.md` §一 商品管理重构 / §二 商城管理（新增板块）
> - `notes/meetings/meeting-20260407/article.md` §一 商品管理与商城管理职责分离（**覆盖版**） / §七 商品管理增加门店粒度支持
> **撰写时间**: 2026-04-09
> **作者**: wx-requirement-adapt skill（自动生成）
> **状态**: 待人工 review，不执行任何代码修改

---

## 0 概览

### 0.1 变更概念

| 要素 | 内容 |
|------|------|
| **变更概念** | 商品域的"管理入口 vs 展示入口"职责重分离，以及套餐从"展示端 N 选 M"下沉到"管理端几选几" |
| **当前行为** | 员工开单和顾客端商城都从 `mall_categories → products → mall_product_skus → product_skus` 链路拉数据；套餐分组（`mall_bundle_groups`）绑在 `products`（商城侧） |
| **期望行为** | ① 员工开单只走 `product_categories → product_skus`，完全不碰 `mall_*` 表 ② 顾客端商城首页只走 `mall_categories → products → mall_product_skus → product_skus`，分类由运营自由编辑 ③ 套餐的"几选几"结构下沉到商品管理层（`product_skus` 之上新增 `product_bundles` + `product_bundle_groups` + `product_bundle_items`）④ 商品管理支持门店粒度 `market_scope → store_scope` ⑤ 商品启用/展示分离：商品管理只关心 `is_enabled`（是否可被员工开单），商城展示由 `mall_product_skus` 的存在与否决定 ⑥ `product_categories` 支持店长/运营自定义编辑品项分类（已部分支持，需补 UI） |
| **受影响角色** | `admin`（商品管理专属，限张凯）、`product`（商品管理只读/写，限张凯一人）、**新增/收窄** `mall_mgr`（商城管理，商学院/企划部）、`manager`（店长开单、商品分类编辑）、普通员工（开单） |
| **受影响端** | `db/` / `fengyu-admin/` / `fengyu-staff/`（员工开单 + 商品管理入口）/ `fengyu-client/`（商城首页展示） |

### 0.2 重大里程碑差异

最重要的 3 个认知冲突（2026-03-24 与 2026-04-07 之间）：

1. **套餐归属层级**
   - 20260324 决议：套餐在商城管理层（`mall_bundle_groups` 挂在 `products.product_id`）
   - 20260407 **覆盖**：员工开单不走商城层，套餐必须在商品管理层就定义出来，否则店长无法卖套餐 → 需要**把 `mall_bundle_groups` 的结构下沉（或镜像）到商品管理层**

2. **小程序首页数据源**
   - 20260324 口径："员工端和客户端分别取数，但都接 shopInit"
   - 20260407 **覆盖**：员工开单直接读 `product_*`，客户端继续读 `mall_*`；`product.shopInit` 在两端的**语义不再对称**

3. **品项类别枚举扩展**
   - 20260324 仅提"四大类 + 体验卡"
   - 20260407 确认新增「组合套餐」为第 5 个品项类别（注意：当前 `product_kind` 已经是「组合套餐/护理项目/家居产品/充值卡/体验卡」5 值，0029 迁移已经完成）
   - 本项变更 **结构上已就绪**，但语义变了：「组合套餐」不再只是"福利活动换名"，而是**真正承载 N 选 M 的套餐商品**

---

## 1 代码路径追踪（三层）

### 1.1 数据库层

#### 1.1.1 已存在结构

**枚举** (`db/schema/enums.ts:3-5`)

```ts
// L0: 源头
productKindEnum: ["组合套餐", "护理项目", "家居产品", "充值卡", "体验卡"]  // 已 5 值
productTypeEnum: ["疗程卡", "单品", "院装产品"]
salesCategoryEnum: ["自采自销", "他销自耗", "他销他耗", "生态合作"]
```

**商品管理侧（张凯独占）** (`db/schema/product.ts:11-60`)

```ts
product_categories {             // L1: 品项分类
  category_id PK,
  category_name,
  product_kind (nullable),       // null → 一级分类（品项类型）；非 null → 二级分类
  sales_category,                // 由品相决定提成分类
  sort_order, is_valid,
}

product_skus {                   // L1: SKU（原子单元）
  sku_id PK,
  category_id FK → product_categories,
  product_type,                  // 疗程卡/单品/院装产品
  spec_name,                     // 完整名（"蜜语水润 10次卡"）
  price, special_price,
  session_count,
  sort_order, service_fee,
  is_shengmei,
  market_scope TEXT,             // 现状：null=全部可见；值为逗号分隔的市场 ID
  is_enabled,
}
```

**商城管理侧（企划部/商学院）** (`db/schema/product.ts:67-159`)

```ts
mall_categories {                // L1: 商城展示分类
  category_id PK,
  category_name,
  category_group TEXT,           // null=一级分组；非 null=二级分类，值 = 所属一级分组名
  sort_order,
}

products {                       // L1: 商城商品
  product_id PK,
  category_id FK → mall_categories,
  name, cover_image, detail_images, description,
  is_bundle,                     // 套餐标记
  price, special_price,
  manage_scope,
  market_scope,
  is_enabled,                    // 后台仍可查到
  is_visible,                    // 客户端可见性
}

mall_bundle_groups {             // L1: 套餐分组（N 选 M 的容器）
  id PK,
  product_id FK → products,
  group_name,
  pick_count,                    // N 选 M 的 M
}

mall_product_skus {              // L1: products ↔ product_skus 多对多
  id PK,
  product_id FK → products,
  sku_id FK → product_skus,
  bundle_group_id FK → mall_bundle_groups (nullable),
  bundle_price,                  // 套餐优惠价
}
```

#### 1.1.2 待新增/变更结构

**选项 A — 在商品管理层新建独立的套餐结构（推荐）**

```ts
product_bundles {                // NEW L1: 商品管理层的套餐主表
  bundle_id PK,
  category_id FK → product_categories,  // 归属一个品项分类，必须是 product_kind='组合套餐'
  name TEXT NOT NULL,
  bundle_no TEXT,                // 外部编号（导出用，和 sku_id 同级）
  total_price NUMERIC,           // 套餐固定总价（如 3980）
  description TEXT,
  is_enabled BOOLEAN,            // 员工端能否开单
  market_scope TEXT,             // 可见范围，支持门店 ID
  store_scope TEXT,              // NEW: 新增门店粒度
  sort_order INT,
  created_at, updated_at,
}

product_bundle_groups {          // NEW L1: 套餐分组
  id BIGSERIAL PK,
  bundle_id FK → product_bundles,
  group_name TEXT,
  pick_count INT,                // N 选 M 的 M
  sort_order INT,
  UNIQUE(bundle_id, group_name),
}

product_bundle_items {           // NEW L1: 套餐子项（引用 SKU）
  id BIGSERIAL PK,
  bundle_id FK → product_bundles,
  group_id FK → product_bundle_groups (nullable),
  sku_id FK → product_skus,      // 必须引用现有 SKU
  unit_price NUMERIC,             // 套餐内该子项单价（所有同组保持相同以确保任意组合金额一致）
  sort_order INT,
  UNIQUE(bundle_id, group_id, sku_id),
}
```

**选项 B — 复用 mall_bundle_groups 结构**（不推荐）

直接把 `mall_bundle_groups` 挂到 `product_categories` 或 `product_skus`。缺点：破坏现有商城层语义，查询复杂度高。

#### 1.1.3 字段扩展

在既有结构上追加：

| 表 | 新增/变更字段 | 说明 |
|----|--------------|------|
| `product_skus` | `store_scope TEXT nullable` | 新增：门店粒度 scope，逗号分隔 store_id 或 null。与 `market_scope` 并存（null=继承 market_scope） |
| `product_categories` | `editable_by_manager BOOLEAN NOT NULL DEFAULT false` | 可选：标记品相分类是否可由店长编辑。若采用全局权限，可省略 |
| `products` | — | 不新增 |

#### 1.1.4 迁移点（按顺序）

| 迁移序号 | 内容 | 备注 |
|---------|------|------|
| `0035_product_bundles.sql` | CREATE TABLE `product_bundles` / `product_bundle_groups` / `product_bundle_items` | 纯新增，无数据迁移 |
| `0036_product_skus_store_scope.sql` | `ALTER TABLE product_skus ADD COLUMN store_scope TEXT` | 门店粒度 |
| `0037_migrate_mall_bundles_to_product.sql` | （**可选**）把现有 `mall_bundle_groups` + `mall_product_skus(bundle_group_id IS NOT NULL)` 数据同步到新表 | 如不保留历史数据（开发阶段），可**直接跳过** |
| `0038_permissions_split.sql` | 新增 `mall_mgr` 角色 row 到 `permission_roles` seed（如有） | 见 §1.2.2 |

> **注意**：根据 MEMORY 中的反馈 `no-legacy-compat`，开发阶段不需要兼容历史数据，迁移 0037 可仅做 schema，不带数据搬迁。

---

### 1.2 后端逻辑层

#### 1.2.1 员工端云函数（`fengyu-staff/cloudfunctions/staffApi/routes/product.js`）

当前状态已经是 **"直接查 product_skus"**（符合新需求方向）：

| 行号 | 函数 | 当前行为 | 期望变更 |
|------|------|---------|---------|
| `product.js:19-26` | `_queryCategoryRows` | `SELECT FROM product_categories WHERE is_valid=true` | ✅ 已满足 |
| `product.js:40-83` | `_queryFormattedSkuList` | `JOIN product_categories` + filter by `categoryId` / `productKind` | 需支持按 `store_scope` 过滤（新字段） |
| `product.js:91-103` | `shopInit` | 返回 `categories + 第一个分类的 skuList` | 返回数据需追加「套餐」信息（见新增 handler） |
| `product.js:155-218` | `spuDetail` | **仍然查 `products` / `mall_product_skus` / `mall_bundle_groups`** | **废弃**：员工端不应再查商城表，改为查 `product_bundles` 系列（若套餐下沉） |
| — | **新增** `bundleList` / `bundleDetail` | — | 从 `product_bundles + product_bundle_groups + product_bundle_items` 拉套餐列表及"几选几"结构 |
| `product.js:224-232` | `promotionList` / `promotionPlans` | 返回空 | 废弃，改为前置到 `bundleList` |

**`order.create` 调整点** (`fengyu-staff/cloudfunctions/staffApi/routes/order.js:205-266`)

当前仅支持按 `skuId` 开单。套餐下沉后需要支持 `bundleId + 组内选项`：

```js
// 当前：
items: [{ skuId, quantity, customPrice?, discount? }]

// 期望（扩展）：
items: [
  { type: 'sku', skuId, quantity },
  {
    type: 'bundle',
    bundleId,
    quantity,
    selections: [
      { groupId: 1, skuIds: ['sku-xxx'] },   // 5 选 1
      { groupId: 2, skuIds: ['sku-yyy', 'sku-zzz'] },  // 5 选 2
    ],
  },
]
```

**原子套餐开单逻辑**：

1. 从 `product_bundles` 读 `total_price`
2. 校验每个 group 的 `selections` 数量等于 `pick_count`
3. 校验 `selections[].skuIds` 都在 `product_bundle_items` 中
4. 展开成 `sale_items` 行（每个选中的 SKU 一行），`unit_real_price = unit_price`（从 `product_bundle_items` 读）
5. `sum(sale_items.received) === product_bundles.total_price`（允许 ±1 分精度）
6. 套餐子项的 `sku_spec_name` / `product_name` 快照照写
7. 可选：新增 `sale_items.bundle_id` 字段用于追溯（见 §1.1.3 字段扩展）

**提成比例跟随子项 sales_category**：
当前 `order.create:210` 已经 `JOIN product_categories` 取 `sales_category`，套餐展开后每个 `sale_item` 依然走子项 sku 的 `sales_category`，**无需额外改动**。这也正是张凯 20260324 §1.1 强调的"销售分类跟随子项"。

#### 1.2.2 客户端云函数（`fengyu-client/cloudfunctions/clientApi/routes/product.js`）

| 行号 | 函数 | 当前行为 | 期望变更 |
|------|------|---------|---------|
| `product.js:18-49` | `getCategoriesList` | 查 `mall_categories` WHERE EXISTS有效 `products` + SKU | ✅ 保留 |
| `product.js:55-90` | `getCategoryGroups` | 查 `mall_categories` 一级分组 | ✅ 保留 |
| `product.js:192-217` | `shopInit` | 返回 `groups + categories + spuList` | ✅ 保留；**不要追加套餐进入员工端分支** |
| `product.js:316-395` | `spuDetail` | 查 `products + mall_product_skus + mall_bundle_groups` | ✅ 保留（客户端套餐仍走商城层） |

**关键**：客户端 `product.js` **基本无需变更**。它已经是"商城管理专属"。只需确保 `mall_bundle_groups` 不被移除。

> ⚠ 如果套餐决定**彻底下沉**（即 `mall_bundle_groups` 废弃），客户端需改为 JOIN `product_bundle_groups`。见 §5.1 风险点。

#### 1.2.3 Admin Server Actions（`fengyu-admin/src/actions/products.ts`）

现状结构：1191 行单文件，混合了商品管理 + 商城管理的 action。

| 行号 | Action | 角色归属 | 建议迁移 |
|------|--------|---------|---------|
| `products.ts:17-71` | `getMarkets`, `resolveManageScope` | 通用 | 保留 |
| `products.ts:75-306` | `getCategories`, `createCategory` (品项)， `updateCategory`, `createProductKind`, `updateProductKind` | **商品管理** | 保留于 `actions/products.ts` |
| `products.ts:310-552` | `getAllSkus`, `getSkuById`, `createSku`, `updateSku`, `deleteSku` | **商品管理** | 保留 |
| `products.ts:554-762` | `addSkuToProduct`, `removeSkuFromProduct`, `updateSkuBundlePrice`, `updateSkuBundleGroup`, `createBundleGroup`, `updateBundleGroup`, `deleteBundleGroup`, `getBundleGroupsByProductId` | **商城管理**（当前混在一起） | **拆分**到 `actions/mall.ts` |
| `products.ts:764-931` | `getMallCategories`, `getMallCategoryGroups`, `createMallCategoryGroup`, `updateMallCategoryGroup`, `deleteMallCategoryGroup` | **商城管理** | **拆分**到 `actions/mall.ts` |
| `products.ts:933-1191` | `getProducts`, `getProductById`, `createProduct`, `updateProduct`, `createMallCategory`, `updateMallCategory`, `deleteMallCategory` | **商城管理** | **拆分**到 `actions/mall.ts` |

**新增 actions**（商品管理侧套餐）：

```ts
// actions/products.ts 新增：
getProductBundles(): Promise<ProductBundle[]>
getProductBundleById(id): Promise<ProductBundleDetail | null>
createProductBundle(data): Promise<...>
updateProductBundle(id, data): Promise<...>
deleteProductBundle(id): Promise<...>
addBundleGroup(bundleId, data)
updateBundleGroup(groupId, data)
deleteBundleGroup(groupId)
addBundleItem(bundleId, groupId, skuId, unitPrice)
removeBundleItem(itemId)
updateBundleItem(itemId, data)
```

**权限调整**（`fengyu-admin/src/lib/permissions.ts:15-68`）

```diff
 PERMISSION_MATRIX = {
   admin: [
     ..., 'product:list', 'product:create', 'product:update',
+    'product:delete',              // 新增
+    'mall:list', 'mall:create', 'mall:update', 'mall:delete',   // 新增商城管理分离
   ],
-  product: [
-    'product:list', 'product:create', 'product:update',
-    'coupon:list', 'coupon:create', 'coupon:update',
-  ],
+  product: [   // 商品管理员（限张凯一人）
+    'dashboard:view',
+    'product:list', 'product:create', 'product:update', 'product:delete',
+  ],
+  mall_mgr: [  // 商城管理员（商学院/企划部）
+    'dashboard:view',
+    'mall:list', 'mall:create', 'mall:update', 'mall:delete',
+    'product:list',              // 只读品项信息（用于挑选 SKU 到商城）
+  ],
   manager: [
     ...,
+    'product_category:update',    // 店长可编辑品项分类（张凯要求）
   ],
 }
```

⚠ 需同步扩展 `RoleType` 联合类型 (`fengyu-admin/src/lib/types.ts`)，添加 `'mall_mgr'`。

**菜单分离**（`fengyu-admin/src/lib/menu.ts:63-64`）

```diff
-  { label: '商品管理', icon: Package, href: '/products', requiredRoles: ['admin', 'product'] },
-  { label: '商城管理', icon: ShoppingBag, href: '/mall', requiredRoles: ['admin', 'product'] },
+  { label: '商品管理', icon: Package, href: '/products', requiredRoles: ['admin', 'product'] },
+  { label: '商城管理', icon: ShoppingBag, href: '/mall', requiredRoles: ['admin', 'mall_mgr'] },
```

这样 `product` 角色只看到商品管理，`mall_mgr` 只看到商城管理。admin 两者都能进。

---

### 1.3 前端渲染层

#### 1.3.1 员工端（`fengyu-staff/miniprogram/pages/order-create/`）

**`order-create.ts`** 现有行为：

| 行号 | 内容 | 说明 |
|------|------|------|
| `:7` | `BIG_CATEGORIES = ['组合套餐', '护理项目', '家居产品', '充值卡', '体验卡']` | ✅ 已覆盖 5 大类 |
| `:34-48` | `SkuItem` 接口含 `productKind` | ✅ |
| `:105-110` | `bigCategories`, `activeBigCategoryIndex`, `categories`, `spuList` | ✅ 三级展示：大类 Tab → 侧边分类 → 商品 |
| `:220-247` | `loadShopInit` → `product.shopInit` → `categories + skuList` | ✅ 走员工端 product 云函数 |
| `:269-286` | 切换大类时按 `productKind === activeBig` 筛选 | ✅ |
| `:309-317` | `loadSpuList` → `product.skuList { categoryId }` | ✅ |
| `:329-356` | 加购逻辑：校验组合套餐不能和其他类混购 | ✅ |

**期望新增**：

1. **"组合套餐"Tab 下的特殊渲染**：当 `activeBig === '组合套餐'` 时，`spuList` 不再是 SKU 列表，而是 `product_bundles` 列表。点击后打开 **套餐选择弹层**，展示每组的 `pick_count` 约束，用户勾选后加入购物车。
2. **购物车数据结构扩展**：`CartItem` 需新增 `bundleId?` 和 `bundleSelections?[]`。
3. **结算时 payload**：`items` 按 `{ type: 'sku'|'bundle', ... }` 发给云函数。

**`product-detail.ts`** (`fengyu-staff/miniprogram/packageService/product-detail/`)

现状查 `product.spuDetail` → 商城商品详情。**需考虑**：员工端是否还需要商城商品详情页？若不需要，该页可废弃；若保留（例如店长想预览客户端展示效果），则保留现状云函数分支。

#### 1.3.2 客户端（`fengyu-client/miniprogram/pages/home/home.ts`）

| 行号 | 内容 | 说明 |
|------|------|------|
| `home.ts:356-397` | `loadShopInit` → `product.shopInit` → `groups + categories + spuList` | ✅ 已走商城层 |
| `home.ts:399-419` | `buildSidebarItems` | ✅ 分组/分类侧边栏 |

**期望**：**基本无变更**，只要 `mall_categories + products + mall_product_skus` 不动。

**`pagesShop/service-detail`** (套餐详情弹层) 继续使用 `product.spuDetail` + `bundleGroups`。

#### 1.3.3 Admin UI

**商品管理入口** (`fengyu-admin/src/app/(main)/products/`)

- `products/page.tsx` → SKU 列表
- `products/categories/` → 品项分类管理
- `products/create/` → 新建 SKU
- `products/[id]/` → SKU 详情

**需新增**：

- `products/bundles/` — 套餐列表（新建/编辑/删除组合套餐，与 SKU 同级）
- `products/bundles/[id]/` — 套餐详情（管理 group + items，"几选几"表单）
- `products/bundles/create/` — 新建套餐
- `products/categories/` — 增加 "支持店长编辑" 开关（如走该方案）

**商城管理入口** (`fengyu-admin/src/app/(main)/mall/`)

- `mall/page.tsx` → 商城商品列表
- `mall/categories/` → 商城分类（一级分组 + 二级分类，自由命名）
- `mall/create/` → 新建商城商品（从 `product_skus` 选取 SKU）
- `mall/[id]/` → 商城商品详情（挂 SKU、设 bundle_price 等）

**必须调整**：

- `mall/[id]/_components/product-detail-page.tsx` 当前有"套餐分组 N 选 M"编辑 UI，需**迁移到 `products/bundles/[id]/`**
- `mall/create/_components/product-create-page.tsx` 应简化为"选一个商品管理中的现有 SKU/套餐作为展示对象"
- `mall/categories/` 删除 `product_kind` 关联，完全自由命名（已是现状）

**admin 开单页** (`fengyu-admin/src/app/(main)/orders/create/`)
20260324 §3.1 已决定：**后台开单延后**。此处暂不修改。

---

## 2 差异分析表

| 维度 | 当前 | 期望 | 影响范围 |
|------|------|------|---------|
| 员工开单数据源 | `staffApi/product.js` 查 `product_skus + product_categories`，套餐走 `products + mall_*` | **完全只查 `product_* / product_bundles_*`**，不 JOIN 任何 `mall_*` 表 | `staffApi/routes/product.js`, `staffApi/routes/order.js`, `staff/miniprogram/pages/order-create/*` |
| 顾客首页数据源 | `clientApi/product.js` 查 `mall_categories + products + mall_product_skus + mall_bundle_groups` | 保持现状（但需保证 `mall_bundle_groups` 存活，或迁移至 `product_bundle_groups`） | `clientApi/routes/product.js`, `client/miniprogram/pages/home/*`, `pagesShop/*` |
| 套餐归属 | `mall_bundle_groups` 挂在 `products`（商城层） | 新增 `product_bundles + product_bundle_groups + product_bundle_items`（商品管理层） | `db/schema/product.ts`, `db/migrations/`, Admin UI 新增 `products/bundles/` |
| 套餐子项来源 | 来自 `mall_product_skus.sku_id` | 必须是 `product_skus.sku_id`（填充时带入 `spec_name + price`，但 ID 不强绑） | `product_bundle_items.sku_id FK → product_skus` |
| 品项类别枚举 | `[组合套餐, 护理项目, 家居产品, 充值卡, 体验卡]`（已就绪） | 同（无变更） | L0 无需动 |
| 销售分类决定提成 | `sale_items.sales_category` 从 `product_categories.sales_category` 快照（当前 `order.js:210` 已做） | 保持；套餐展开后每个子行仍按 sku→category→sales_category 快照 | `staffApi/routes/order.js` 小幅改 |
| 商品管理权限 | `product` 角色含 `product:list/create/update`，同时 `product` 也能进商城管理菜单 | `product` 角色**只能**进商品管理；新增 `mall_mgr` 角色**只能**进商城管理 | `permissions.ts`, `menu.ts`, `types.ts`, seed, e2e |
| 商品可见性 | `products.is_visible`（商城侧）+ `product_skus.is_enabled` | 保持；**同时 `product_skus.is_enabled` 是"员工能否开单"的唯一开关** | 现状 OK，注意 UI 文案 |
| 商品管理门店粒度 | `product_skus.market_scope`（市场级） | 新增 `product_skus.store_scope` 或复用 `market_scope` 存 store_id | L1 schema 新增列，L5 actions.createSku/updateSku 加校验 |
| 套餐总价/子项单价 | `mall_bundle_groups.pick_count` + `mall_product_skus.bundle_price` 实现 | `product_bundles.total_price` + `product_bundle_items.unit_price`，同组单价相等（运行时校验） | 新表 + 新 actions |
| 品项分类编辑入口 | `admin/products/categories/` 仅 admin+product 可编辑 | 增加 `manager`（店长）可编辑（张凯要求"品相分类支持自定义编辑"）| `permissions.ts` + `products/categories/page.tsx` 权限判断 |
| 开单 API 入参 | `items: [{ skuId, quantity, ... }]` | 扩展为 `items: [{ type: 'sku'\|'bundle', skuId?, bundleId?, selections?, ... }]` | `staffApi/routes/order.js create`, `staff/miniprogram/pages/order-create/order-create.ts` cartItem |

---

## 3 修改计划（按执行顺序）

### Phase A — 数据库层（L0 + L1 + L2）

> **结构性变更**，交接给 `/wx-change-propagation` 执行 10 层扫描。

#### A-1 新增套餐三表 → 交接 `/wx-change-propagation`

- **类型**: 字段/表新增
- **触发层**: L0 无需动（无新枚举值）；L1 `db/schema/product.ts` 新增 3 个 table 定义 + 类型导出；L2 生成迁移 `0035_product_bundles.sql`；L4 `admin/src/lib/types.ts` 新增 `ProductBundle` / `ProductBundleGroup` / `ProductBundleItem` 类型；L5 `actions/products.ts` 新增 CRUD；L6 `seed.ts` 补 demo 套餐；L7 `staffApi/routes/product.js` 新增 `bundleList/bundleDetail`，`order.js create` 支持 bundle 展开；L9 admin 新增 `products/bundles/*` 页面，staff `order-create` 支持套餐选择弹层；L10 补测试
- **直接指导**：
  ```sql
  CREATE TABLE product_bundles (
    bundle_id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES product_categories(category_id),
    name TEXT NOT NULL,
    bundle_no TEXT,
    total_price NUMERIC(10,2) NOT NULL,
    description TEXT,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    market_scope TEXT,
    store_scope TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (total_price >= 0)
  );
  CREATE TABLE product_bundle_groups (
    id BIGSERIAL PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES product_bundles(bundle_id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    pick_count INT,
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE (bundle_id, group_name)
  );
  CREATE TABLE product_bundle_items (
    id BIGSERIAL PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES product_bundles(bundle_id) ON DELETE CASCADE,
    group_id BIGINT REFERENCES product_bundle_groups(id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES product_skus(sku_id),
    unit_price NUMERIC(10,2) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    UNIQUE (bundle_id, group_id, sku_id),
    CHECK (unit_price >= 0)
  );
  CREATE INDEX idx_bundle_items_bundle ON product_bundle_items(bundle_id);
  CREATE INDEX idx_bundle_groups_bundle ON product_bundle_groups(bundle_id);
  ```

#### A-2 `product_skus` 增加 `store_scope` → 字段新增

- **类型**: 字段新增
- **触发层**: L1 schema 定义；L2 迁移 0036；L4 类型；L5 actions 的 createSku/updateSku/入参；L6 seed；L7 staffApi/clientApi product.js 的 SELECT + WHERE；L9 admin products/create/页面；L10 测试
- 迁移：`ALTER TABLE product_skus ADD COLUMN store_scope TEXT;`

#### A-3 （可选）废弃 `mall_bundle_groups` / `mall_product_skus.bundle_*` → 全 10 层扫描

> **风险最高**，建议**延后**到 Phase D，或**不执行**（保留给客户端使用）。见 §5.1。

### Phase B — 权限和菜单（L4 + L5 + L9）

#### B-1 新增 `mall_mgr` 角色

- `db/schema/permission.ts` 的 RoleType 扩展：添加 `'mall_mgr'`
- `fengyu-admin/src/lib/types.ts` 同步 `RoleType`
- `fengyu-admin/src/lib/permissions.ts` PERMISSION_MATRIX 新增 `mall_mgr` 条目；`product` 角色移除 `coupon:*`；admin 加 `mall:*` / `product:delete`
- `fengyu-admin/src/lib/menu.ts` 商城管理入口改为 `requiredRoles: ['admin', 'mall_mgr']`
- `fengyu-admin/src/app/(main)/permissions/` 页面需补 `mall_mgr` 选项
- `fengyu-admin/e2e/permissions.spec.ts` 和 `products.spec.ts` 补用例
- `seed.ts` 补一个 mall_mgr demo 用户

#### B-2 店长编辑品项分类

- `permissions.ts` `manager` 角色新增 `'product_category:update'` action（或直接复用 `product:update` 但加 scope 限制）
- `fengyu-admin/src/app/(main)/products/categories/page.tsx` 调整可见性判断

### Phase C — Actions 拆分（L5）

#### C-1 拆分 `actions/products.ts` → `actions/products.ts` + `actions/mall.ts`

- 创建 `fengyu-admin/src/actions/mall.ts`，迁移如下函数：
  - `getMallCategories`, `getMallCategoryGroups`, `createMallCategoryGroup`, `updateMallCategoryGroup`, `deleteMallCategoryGroup`
  - `createMallCategory`, `updateMallCategory`, `deleteMallCategory`
  - `getProducts`, `getProductById`, `createProduct`, `updateProduct`
  - `addSkuToProduct`, `removeSkuFromProduct`, `updateSkuBundlePrice`, `updateSkuBundleGroup`
  - `getBundleGroupsByProductId`, `createBundleGroup`, `updateBundleGroup`, `deleteBundleGroup`（商城层的）
- 权限从 `product:*` → `mall:*`
- 审计日志的 entityType 从 `product` 改为 `mall_product` 等（可选）
- 所有引用处（page.tsx）更新 import
- 测试文件同步拆分 `actions/products.test.ts` → `actions/mall.test.ts`

#### C-2 商品管理新增套餐 actions

- 在 `actions/products.ts` 新增 `getProductBundles` / `createProductBundle` / `updateProductBundle` / `deleteProductBundle` / `addBundleGroup` / `updateBundleGroup` / `deleteBundleGroup` / `addBundleItem` / `removeBundleItem`
- 校验规则：
  - `category_id` 对应的 `product_kind` 必须是 `'组合套餐'`
  - 同组内所有 `unit_price` 必须相等（保证任意组合总价一致）
  - 每组 `pick_count ≥ 1`，且 `pick_count ≤ items.length`

### Phase D — 云函数层（L7）

#### D-1 员工端 staffApi product.js

- 新增 `bundleList(ctx)`: 按 `categoryId` 或 `productKind='组合套餐'` 返回套餐列表
- 新增 `bundleDetail(ctx)`: 返回 `{ bundle, groups: [{ id, groupName, pickCount, items: [{skuId, specName, unitPrice}] }] }`
- `shopInit` 若 `firstCategory.productKind === '组合套餐'`，第一屏改为返回 bundleList
- 保留 `product.spuDetail` 以防员工想查商城商品详情；或直接删除

#### D-2 员工端 staffApi order.js

- `create` 参数扩展支持 `items[].type === 'bundle'`
- 套餐展开算法：
  ```js
  for (item of items) {
    if (item.type === 'bundle') {
      const bundle = await pg.query('SELECT * FROM product_bundles WHERE bundle_id=$1', [item.bundleId]);
      const groups = await pg.query('SELECT * FROM product_bundle_groups WHERE bundle_id=$1', [item.bundleId]);
      for (g of groups) {
        const sel = item.selections.find(s => s.groupId === g.id);
        if (!sel || sel.skuIds.length !== g.pick_count) throw INVALID_PARAMS;
        for (sid of sel.skuIds) {
          const bi = await pg.query('SELECT * FROM product_bundle_items WHERE bundle_id=$1 AND group_id=$2 AND sku_id=$3', [item.bundleId, g.id, sid]);
          saleItemRows.push({
            skuId: sid,
            unitPrice: bi.unit_price,
            quantity: item.quantity,
            unitRealPrice: bi.unit_price,
            saleAmount: bi.unit_price * item.quantity,
            received: bi.unit_price * item.quantity,
            bundleId: item.bundleId,  // 新字段
            ...
          });
        }
      }
      // 校验总价
      const expectedTotal = bundle.total_price * item.quantity;
      const actualTotal = saleItemRows.filter(r => r.bundleId === item.bundleId).reduce((s, r) => s + r.received, 0);
      if (Math.abs(actualTotal - expectedTotal) > 0.01) throw INVALID_PARAMS;
    } else {
      // 现状 SKU 分支
    }
  }
  ```
- `sale_items` 如果加了 `bundle_id` 列，`saleItems` schema L1 也要补

#### D-3 客户端 clientApi product.js

- **不变**。验证 `mall_bundle_groups` 仍然可查。
- 若执行 A-3 废弃商城套餐，需改为 JOIN `product_bundle_groups`

### Phase E — 前端渲染（L9）

#### E-1 Admin UI

- 新增 `app/(main)/products/bundles/page.tsx`（套餐列表）
- 新增 `app/(main)/products/bundles/create/page.tsx`（新建套餐表单，含"从 SKU 库填充"）
- 新增 `app/(main)/products/bundles/[id]/page.tsx`（详情 + 组管理）
- 调整 `app/(main)/products/categories/` 允许店长编辑
- 调整 `app/(main)/mall/[id]/` 移除套餐组编辑 UI（若套餐彻底下沉）
- 调整 `app/(main)/orders/create/page.tsx`（若支持后台套餐开单）

#### E-2 员工端小程序

- `pages/order-create/order-create.ts`：
  - `CartItem` 新增 `bundleId?`, `bundleSelections?: [{ groupId, skuIds: string[] }]`
  - 点击"组合套餐" tab 下的商品时，打开套餐选择弹层（新组件）
  - `submitOrder` 的 payload 按 type 构造
- 新增 `components/bundle-picker/`（套餐选择弹层，展示每组的 pick_count 约束和可选 SKU）

#### E-3 客户端小程序

- **不变**（除非 A-3 执行）

### Phase F — 测试与验证（L10）

- `actions/products.test.ts` + 新增 `actions/products-bundles.test.ts`
- `actions/mall.test.ts`（拆分后的）
- `staffApi/__tests__/routes/product.test.js` 补 `bundleList/bundleDetail`
- `staffApi/__tests__/routes/order.test.js` 补套餐开单用例
- `fengyu-admin/e2e/products.spec.ts` 增加 bundle CRUD spec
- `fengyu-admin/e2e/permissions.spec.ts` 增加 `mall_mgr` 角色验证

---

## 4 横切关注点检查清单

### 4.1 权限检查

- [x] **新增 `mall_mgr` 角色**：确认 `RoleType` 联合类型、PERMISSION_MATRIX、菜单、seed 数据、e2e 断言、permissions 页面的选项
- [x] **`product` 角色收窄**：移除商城权限；明确只有张凯一人持有
- [x] **`manager` 角色加品类编辑**：`product_category:update` action
- [x] **`product:delete`**：目前 PERMISSION_MATRIX 无此 action，但 `deleteSku` 使用的是 `product:update`。建议统一补上 `product:delete`
- [x] 云函数中间件不涉及（staffApi 无 admin 权限，只查店长身份）

### 4.2 审计日志

- [x] `logOperation(session, 'bundle.create', 'product_bundle', bundleId, ...)`
- [x] `logOperation(session, 'bundle.update', 'product_bundle', ...)`
- [x] `logOperation(session, 'bundle_group.create', 'product_bundle_group', ...)`
- [x] `logOperation(session, 'bundle_item.create', 'product_bundle_item', ...)`
- [x] 区分商品管理的 bundle 与商城管理的 mall_bundle 的 entityType，避免日志混淆

### 4.3 数据完整性

- [x] `product_bundle_items.sku_id FK → product_skus.sku_id`（必须，不能允许任意文本）
- [x] `product_bundles.category_id FK → product_categories.category_id`（约束为 `product_kind='组合套餐'`，PG 无原生约束，需 trigger 或 action 层校验）
- [x] `sale_items.bundle_id`（若加）可为 null
- [x] 删除 SKU 时检查 `product_bundle_items` 的引用（参考当前 `deleteSku` 对 `sale_items` 的检查 `products.ts:535-543`）
- [x] 级联删除 `product_bundles` → `product_bundle_groups` → `product_bundle_items` ON DELETE CASCADE
- [x] `product_skus.store_scope` 与 `market_scope` 同时为非 null 时的优先级？规则建议：**store_scope 非 null 优先**，否则回退到 market_scope

### 4.4 WorkFine 同步

- [x] `db/scripts/sync-workfine.js` 目前映射 `mapProductKind()` 已覆盖 5 值，**无需改动**
- [x] `db/scripts/sync-products-from-workfine.js`：套餐是手动维护（MEMORY 已指出"一次性导入后手动维护"），**不需要同步套餐**
- [x] 注意 MEMORY 的 `no-legacy-compat`：开发阶段，WorkFine 不需要同步新套餐表

### 4.5 seed 测试数据

- [x] `fengyu-admin/src/db/seed.ts` 需新增：
  - 2-3 个 demo 套餐（`product_bundles`）
  - 每个套餐 1-2 组（`product_bundle_groups`），每组 3-5 个 SKU
  - 一个 mall_mgr 测试账号
- [x] `seed.ts:165-168` 的 mall_categories 组合套餐分组名称可保留，但不再强关联商品管理的组合套餐

### 4.6 现有数据迁移

- [x] **开发阶段**：按 MEMORY `no-legacy-compat`，**不做**现有 mall_bundle_groups → product_bundle_groups 的数据搬迁
- [x] 线上未发布，`sale_items` 无套餐快照历史，不需要回溯
- [x] 如果 A-3 执行，需写一次性脚本清空 `mall_bundle_groups`

### 4.7 文档更新

- [x] `.42cog/pm/backend.pr.spec.md` — 新增 `product_bundles` 三表说明
- [x] `.42cog/pm/admin.pr.spec.md` — 新增 AC-19 套餐管理 / AC-20 角色拆分
- [x] `.42cog/cog.md` — 核心实体图补套餐
- [x] `CLAUDE.md`（根）— MEMORY 中的 staffApi 路由表追加 `bundleList/bundleDetail`
- [x] `fengyu-admin/CLAUDE.md` — 19 → 20 actions 模块（products + mall 分家）

---

## 5 风险点

### 5.1 【高】套餐从二级嵌套升三级对 `sale_items` 快照的影响

**风险描述**：
当前 `sale_items` 是二级结构（`sale_order → sale_item → sku 快照`）。套餐升三级后，一个套餐开单会展开成 N 个 `sale_items` 行（每组被选中的 SKU 一行）。问题：
1. 后续查询时如何把这些行**重新聚合**回"一个套餐"？
2. 分配营业额时，分配应该挂在"子项行"还是"套餐行"？
3. 提成计算按子项的 `sales_category` 走（张凯要求），但用户看到的是套餐总价

**缓解措施**：
- 加字段 `sale_items.bundle_id TEXT`（可 null），`sale_items.bundle_seq INT`（套餐内序号）
- 查询订单时 `GROUP BY bundle_id` 聚合展示
- 分配继续挂在子项行上，符合当前 `sale_allocations` 结构
- 提成自然按子项 sales_category 计算（当前实现已满足）
- 需在 `order.detail` 响应中构造嵌套结构给前端展示

### 5.2 【高】客户端商城首页数据源迁移路径

**风险描述**：
如果把套餐从 `mall_bundle_groups` 彻底迁到 `product_bundle_groups`（Phase A-3），那么：
- `clientApi/product.js` 需要 JOIN `product_bundle_groups`
- `mall_product_skus.bundle_group_id` 字段要删除
- 客户端 `pagesShop/service-detail` 展示套餐的逻辑要跟着改

**缓解措施**：
- **推荐方案**：**不做 A-3**。商城层保留 `mall_bundle_groups` 给客户端自由组合（客户端可自制展示套餐），商品管理层单独维护 `product_bundles` 给员工开单。两者是**独立**的套餐定义。张凯 20260407 明确"商城管理完全服务于顾客端首页展示"，这意味着**允许有差异**。
- **另一种方案**：彻底下沉，客户端改造。但风险更大，应放到独立迭代。

**待决策**：建议向张凯澄清——"员工开单的套餐，客户是否能在小程序商城里看到并自助下单？" 如果答案是"否，套餐仅员工代客开单"，则 A-3 可不做。

### 5.3 【中】品项类别枚举「组合套餐」的 10 层传播影响

**风险描述**：
当前 `product_kind` 已 5 值（0029 迁移），但「组合套餐」在 L5-L10 的语义可能还停留在"福利活动的换名"。

**扫描结果**（简要 Grep）：

| 层 | 路径 | 出现次数 | 语义状态 |
|----|------|---------|---------|
| L0 | `db/schema/enums.ts:3` | 1 | ✅ 已就绪 |
| L3 | `db/scripts/sync-workfine.js` | 1 | ✅ 已映射 |
| L4 | `fengyu-admin/src/lib/types.ts` | 1 | ✅ |
| L5 | `fengyu-admin/src/actions/products.ts`, `coupons.ts`, `data-center.ts` | 多处 | 大部分只作为字符串匹配，**未处理"套餐必须指向 bundle"的特殊逻辑** |
| L6 | `fengyu-admin/src/db/seed.ts` | 多处 | ⚠ 当前 seed 给「组合套餐」分类下建了 SKU（而非 bundle） |
| L7 | `staffApi/routes/order.js:270-274` | 1 | 仅做了"组合套餐 SKU 必须单独成单"的校验，**但未实现套餐展开** |
| L7 | `staff/product.js`, `client/product.js` | 多处 | 作为过滤条件，OK |
| L8 | `staff/formatters`, `client/format` | 需验证 | 可能未含「组合套餐」→ 显示时 fallback 到默认 |
| L9 | `staff/pages/order-create/order-create.ts:7` | 1 | ✅ 已在 `BIG_CATEGORIES` |
| L9 | `admin/src/app/(main)/products/_components/products-page.tsx:96` | 1 | OK |
| L10 | `fengyu-admin/e2e/products.spec.ts`, `staffApi/__tests__/routes/product.test.js` | 需验证 | 可能测试数据中未使用 |

**缓解措施**：
- Phase A 执行后，需立即 **交接 `/wx-change-propagation` 对「组合套餐」做一次全 10 层扫描**，确认每个出现点都已适配"组合套餐 = 真套餐（需要 bundle 结构）而非 SKU"的新语义
- 特别关注 `seed.ts` 和 `staffApi/routes/order.js:269-274`（已有 "promotion 单只允许组合套餐 SKU" 的校验，新规则下此逻辑需重写为"promotion 单只允许 product_bundles"）

### 5.4 【中】权限拆分导致的现有账号数据迁移

**风险描述**：
引入 `mall_mgr` 后，当前用 `product` 角色访问商城管理的用户会失去权限。

**缓解措施**：
- 开发阶段数据全清，影响为零（MEMORY 确认"不需要历史数据兼容"）
- 上线前在 permissions 页面手动给商学院/企划部账号分配 `mall_mgr`
- 迁移脚本（可选）：`UPDATE permission_roles SET role='mall_mgr' WHERE role='product' AND phone NOT IN (张凯手机号)`

### 5.5 【低】admin `actions/products.ts` 拆分引发的测试重写

**风险描述**：
当前 `actions/products.test.ts` 是 1 个大文件。拆分为 `products.test.ts + mall.test.ts` 需重组测试 + 维护覆盖率 ≥ 80%。

**缓解措施**：
- 拆分时保留原测试结构，仅调整 import 路径
- Vitest 覆盖率 gate 暂时可放宽 5%，等拆分完成后补齐

### 5.6 【低】store_scope vs market_scope 语义冲突

**风险描述**：
`product_skus` 同时有 `market_scope` 和新增 `store_scope`，运行时查询需要决定优先级。

**缓解措施**：
- 规则约定：`store_scope IS NOT NULL` 时优先；否则查 `market_scope`
- 在 SELECT 生成辅助函数 `buildScopeFilter(marketName, storeId)`：
  ```sql
  AND (
    (sk.store_scope IS NOT NULL AND sk.store_scope LIKE '%' || $1 || '%')
    OR (sk.store_scope IS NULL AND (sk.market_scope IS NULL OR sk.market_scope LIKE '%' || $2 || '%'))
  )
  ```
- 在 admin 编辑 SKU 的表单上分成两组 radio 互斥选择"整个市场" / "指定门店"

---

## 6 建议的后续动作

### 6.1 需要立即交接 `/wx-change-propagation` 的子任务

| 任务 | 层级 | 规模 | 建议顺序 |
|------|------|------|---------|
| `product_bundles` 三表新增 | L0→L2 先行，L4-L10 后续 | 大 | 第 1 批 |
| `product_skus.store_scope` 字段新增 | L1, L2, L4, L5, L6, L7, L9 | 中 | 第 2 批（可并行） |
| `sale_items.bundle_id / bundle_seq` 字段新增 | L1, L2, L4, L5, L7, L9 | 中 | 第 3 批（依赖第 1 批） |
| 新增 `mall_mgr` 角色到 `RoleType` 联合 | L4, L5, L6, L9, L10 | 小 | 第 4 批（独立） |

### 6.2 适合独立 worktree 并行的子任务

| Worktree 名 | 范围 | 负责层 |
|------------|------|-------|
| `feat/product-bundles-db` | Phase A-1（schema + 迁移 + actions CRUD + seed + unit test） | db + admin backend |
| `feat/product-bundles-admin-ui` | Phase E-1（`products/bundles/*` 页面） | admin frontend |
| `feat/product-bundles-staff-open` | Phase D-2 + E-2（order.js 改造 + order-create 弹层） | staff backend + frontend |
| `feat/product-mall-actions-split` | Phase C-1（actions 拆分 + 测试拆分） | admin 独立 |
| `feat/permissions-mall-mgr` | Phase B-1（权限/菜单/seed） | admin 独立 |
| `feat/product-store-scope` | Phase A-2（store_scope 字段 + UI） | 全栈，可并行 |

**依赖关系**：
```
feat/product-bundles-db (必须先做)
     ↓
feat/product-bundles-admin-ui ─── 并行 ──→ feat/product-bundles-staff-open
     ↓ (可并行)
feat/permissions-mall-mgr, feat/product-mall-actions-split, feat/product-store-scope
```

### 6.3 需要用户澄清的决策点

1. **【必决】客户端是否展示套餐？**
   - 场景 A：套餐仅在员工代客开单使用 → 保留 `mall_bundle_groups`（给客户端做"商城套餐"），新增 `product_bundles`（给员工"管理套餐"），两套独立
   - 场景 B：套餐也在客户端展示 → 彻底下沉 `mall_bundle_groups` → `product_bundle_groups`，客户端 JOIN 改造
   - **建议**: 采用 A（降风险），文档注明"商城套餐和管理套餐是两套独立定义"

2. **【建议决】店长能否编辑品项分类？**
   - 张凯 20260324 §1.1 原话："品相分类支持自定义编辑"。但未说是 admin 编辑还是店长编辑。
   - **建议**: 保守给 admin + product 角色，店长走工单申请。

3. **【建议决】商品管理门店粒度是新字段还是复用 market_scope？**
   - 选项 a：新加 `store_scope`，逻辑更清晰但多一列
   - 选项 b：`market_scope` 存 store_id（以 `store:` 前缀区分）
   - **建议**: 选项 a

4. **【必决】是否需要 `sale_items.bundle_id` 字段？**
   - 不加：套餐展开后无法重新聚合展示
   - 加：schema 扩展一个字段
   - **建议**: 加

5. **【必决】套餐总价与子项单价一致性如何保证？**
   - a. DB 触发器校验
   - b. Action 层校验
   - c. 运行时仅在 order.create 时校验，入库时不校验
   - **建议**: Action 层 + order.create 双重校验

### 6.4 下一步行动建议

1. **立即**：把本报告发给张凯（业务方）review §6.3 的 5 个决策点
2. **决策通过后**：启动 `feat/product-bundles-db` worktree（阻塞其他），一次性完成 A-1、A-2
3. **并行启动**：`feat/permissions-mall-mgr`、`feat/product-mall-actions-split`（独立，低风险）
4. **第二周**：前后端套餐开单打通 + admin UI 页面
5. **第三周**：回归 + E2E + seed 数据补齐 + QA 验证

---

## 7 附录：关键代码引用位置

| 主题 | 文件 | 行 |
|------|------|---|
| productKind 枚举定义 | `db/schema/enums.ts` | 3 |
| product_categories 表 | `db/schema/product.ts` | 11-20 |
| product_skus 表 | `db/schema/product.ts` | 29-60 |
| mall_categories 表 | `db/schema/product.ts` | 67-75 |
| products 表 | `db/schema/product.ts` | 84-106 |
| mall_bundle_groups 表 | `db/schema/product.ts` | 114-130 |
| mall_product_skus 表 | `db/schema/product.ts` | 138-159 |
| 0029 migration (productKind 枚举化) | `db/migrations/0029_product_kind_enum.sql` | — |
| 0021 migration (is_enabled/is_visible) | `db/migrations/0021_product_enabled_visible.sql` | — |
| 0012 migration (product_mall_split) | `db/migrations/0012_product_mall_split.sql` | — |
| PERMISSION_MATRIX | `fengyu-admin/src/lib/permissions.ts` | 15-68 |
| 菜单定义 | `fengyu-admin/src/lib/menu.ts` | 63-64 |
| 商品管理 actions (SKU) | `fengyu-admin/src/actions/products.ts` | 310-552 |
| 商城管理 actions (products) | `fengyu-admin/src/actions/products.ts` | 933-1191 |
| 套餐组 actions (mall) | `fengyu-admin/src/actions/products.ts` | 629-762 |
| Admin 商品页 | `fengyu-admin/src/app/(main)/products/page.tsx` | — |
| Admin 商城页 | `fengyu-admin/src/app/(main)/mall/page.tsx` | — |
| staffApi product.js | `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 1-234 |
| staffApi product.shopInit | `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 91-103 |
| staffApi product.spuDetail (要重构) | `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 155-218 |
| staffApi order.create | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 138-266 |
| staffApi 组合套餐验证 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 269-274 |
| clientApi product.js | `fengyu-client/cloudfunctions/clientApi/routes/product.js` | 1-404 |
| clientApi shopInit | `fengyu-client/cloudfunctions/clientApi/routes/product.js` | 192-217 |
| clientApi spuDetail (保留) | `fengyu-client/cloudfunctions/clientApi/routes/product.js` | 316-395 |
| 员工端开单 page | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | — |
| 员工端 BIG_CATEGORIES | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 7 |
| 员工端 shopInit 调用 | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 220-247 |
| 员工端 skuToDisplay | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 89-99 |
| 客户端首页 | `fengyu-client/miniprogram/pages/home/home.ts` | 356-419 |
| sale_items 表 | `db/schema/order.ts` | 108-155 |
| sale_items productType 快照 | `db/schema/order.ts` | 124 |
| sale_items salesCategory 快照 | `db/schema/order.ts` | 139 |
| seed.ts 品项分类 | `fengyu-admin/src/db/seed.ts` | 130-143 |
| seed.ts mall_categories | `fengyu-admin/src/db/seed.ts` | 158-168 |
| wx-change-propagation 10 层图 | `.claude/skills/wx-change-propagation/SKILL.md` | 41-58 |

---

## 8 总结

本次变更的**本质**是：
1. 把现有"商城分类驱动员工开单"的耦合，拆为"品项分类管员工开单 / 商城分类管客户展示"
2. 把套餐从"仅商城侧 N 选 M"扩展到"商品管理侧 N 选 M"，因为员工开单现在走商品管理层
3. 把商品管理的权限收窄到张凯一人，新增商城管理员角色给企划部
4. 商品管理层新增门店粒度字段

**技术上最关键**的是新增 3 个 `product_bundles_*` 表，并修改 `staffApi/order.create` 支持套餐展开逻辑。其余多为权限和 UI 拆分工作，风险低但工作量大。

**建议采用"保守双套餐"方案**（见 §5.2 缓解措施）：管理层套餐（员工开单） + 商城层套餐（客户展示）并存，最大程度降低迁移风险。

**最终产出物**：
- 3 张新表
- 1 个新迁移（可能 3 个）
- 2 个新 role
- ~10 个新 actions
- ~5 个新 admin 页面
- 2 个新云函数 handler（`bundleList / bundleDetail`）
- `order.create` 的 bundle 分支
- 员工端开单的套餐选择弹层组件
- seed + E2E 补充

建议分成 3 周迭代，每周一个 worktree 主题，并行度最多 3。

> 本报告由 `/wx-requirement-adapt` skill 生成，未修改任何代码。执行前请先与业务方确认 §6.3 的 5 个决策点，然后按 §6.1-6.2 的批次交接给 `/wx-change-propagation` 和独立 worktree 执行。
