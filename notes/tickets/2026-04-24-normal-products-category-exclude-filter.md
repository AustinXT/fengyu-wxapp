# Ticket: 开单"普通商品"分类目录改用排除法（admin + 员工端）

> 生成日期：2026-04-24
> 严重级别：P2（架构对齐 / 防扩展回归；不阻塞当前业务）
> 端：fengyu-admin（管理后台）+ fengyu-staff（员工端，云函数 + 小程序前端）
> 影响面：admin.actions.products（getProductsByKind 签名扩展）、admin.orders.order-create-page（kind 解析）、staffApi.product（shopInit/categories/skuList）、staff.miniprogram.order-create（前端 Tab 过滤器）
> 拆分方式：单 feature 分支，2 个 PR 并行 merge（A: admin、B: staff）。无相互依赖，但建议两端共同上线避免 spec 文档更新割裂
> 无 DB schema 变更 / 无 migration

---

## 0 一句话背景

当前 admin 与员工端开单页"普通商品"目录都用**白名单**（写死 `['护理项目', '家居产品']`）匹配 `product_kind`，且员工端云函数**完全不过滤**——分类侧边栏依赖前端二次过滤。

后续业务可能新增非卡类的 `product_kind`（例如未来"福利活动"或其他护理子类），白名单写法每次都要补丁两端代码、易漏；且员工端云函数把全部 category（含充值卡/体验卡的目录名）下发到客户端，存在**冗余传输 + 单点遗漏即穿透**的风险。

业务诉求：**统一改为排除法** `product_kind NOT IN ('充值卡','体验卡')`，且过滤上提到 SQL 层。未来新增非卡 kind 直接被纳入"普通商品"目录，无需改代码。

> 设计澄清（2026-04-24 与用户对齐）：
> 1. `product_categories` 表平坦无 parent_id，本次**不动表结构**；"二级品项分类"按现有数据模型理解为 **一级 = product_kind / 二级 = category_name**
> 2. 组合套餐继续走独立分支（`is_bundle=true`），"普通商品"在排除法之上**额外排除 `is_bundle=true`** 的 SKU
> 3. 排除名单**硬编码常量** `CARD_PRODUCT_KINDS = ['充值卡', '体验卡']`，不引入 db 元数据表
> 4. admin 和 staff 都需要改
> 5. **进入"普通商品"后，左侧侧边栏需要呈现"二级目录"结构**：以 `product_kind` 作为 **group header（不可点击）**，下面挂该 kind 的 `category_name`（可点击、参与选中态）。零 schema 改动，仅改前端渲染 + 后端 categories 排序保证同 kind 行连续。详见 §2.5、§7。

---

## 1 现状盘点

### 1.1 数据库（不改）

`db/schema/product.ts` `product_categories`：

| 列 | 类型 | 说明 |
|---|---|---|
| `category_id` | text PK | 分类 ID |
| `category_name` | text | 二级分类名（前端侧边栏显示项） |
| `product_kind` | enum | 一级分类，4 值：`护理项目 / 家居产品 / 充值卡 / 体验卡` |
| `sales_category` | enum | 销售类别（不影响本 ticket） |
| `sort_order` | int | 排序 |
| `is_valid` | bool | 是否有效 |

`db/schema/enums.ts` `product_kind` 枚举固定 4 值。组合套餐通过 `products.is_bundle = true` 表达，**不是 product_kind**。

### 1.2 Admin 现状

| 文件 | 行号 | 现状 | 目标 |
|---|---|---|---|
| `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` | `:50-55` `resolveBackendKinds()` | `'普通商品' → ['护理项目','家居产品']`（白名单数组），调用方 for 循环多次调 `getProductsByKind` 然后合并 | 改为返回**单一**排除标记（如新增 `'__normal__'` kind 或 `{ exclude: CARD_PRODUCT_KINDS }`），一次调用 |
| `fengyu-admin/src/actions/products.ts` | `:1270-1403` `getProductsByKind(kind)` | 接受单个 `ProductKindForOrder`；普通分支 `eq(productCategories.productKind, kind)` 单值匹配 | 函数签名扩展为同时支持单值匹配 + 排除模式；普通分支 SQL 改 `notInArray(productCategories.productKind, CARD_PRODUCT_KINDS)` + `isNotNull(productCategories.productKind)`，并要求 SKU 行 `is_bundle=false`（需 join `mall_product_skus → products`，或仅靠 `productSkus.isEnabled` 即足，需评估） |
| `fengyu-admin/src/components/ui/category-cascader.tsx` | 全文件 | 商品管理页用，列出 kind→category 联动 | **不在本 ticket 范围**；仅需扫描确认是否复用了 `resolveBackendKinds`，若有则同步迁移 |
| `fengyu-admin/src/app/(main)/orders/_components/order-create/normal-sku-picker.tsx` | `:36-123` | 左侧 `categories.map` **平铺**渲染 `cat.categoryName`（无父分组），右侧 SKU 网格 | 改为按 `productKind` 分组渲染：每个 productKind 一个不可点击的 group header（小字+底色），其下挂 `category_name` 子项（可点击、参与 `selectedCategoryId` 选中态）。仅"普通商品"分支需要分组；体验卡 / 充值卡分支保持平铺（同 kind 内不分组） |

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

### 2.6 是否在"普通商品"分类列表中过滤掉空分类

> 当前 admin 是 `INNER JOIN productSkus`，自然只返回有 SKU 的分类——不会出现空分类。
> 当前 staff `_queryCategoryRows` 不 join SKU，会出现"分类有效但下面没有 SKU"的空分类（理论上 is_valid=true 的分类应当至少有 SKU，但需防御）。

`shopInit` 改造时建议在 `_queryCategoryRows({ kindNotIn })` 内追加 `EXISTS` 子查询（限定有 `is_enabled=true` 且非套餐的 SKU），避免左侧侧边栏出现"点了没东西"的死分类。

---

## 3 影响传播扫描清单

实施者请按以下顺序 grep 全仓，确认所有点已覆盖：

### 3.1 Admin
1. `grep -rn "getProductsByKind(" fengyu-admin/src` — 所有调用点都改造为传单值（`__normal__` / `__bundle__` / 具体 kind）
2. `grep -rn "resolveBackendKinds" fengyu-admin/src` — 仅应在 `order-create-page.tsx` 出现；如果 cascader 也用了，同步迁移
3. `grep -rn "护理项目.*家居产品\|家居产品.*护理项目" fengyu-admin/src` — 找出其他白名单写死的位置
4. `grep -rn "ProductKindForOrder" fengyu-admin/src` — 联合类型扩展后，所有判别使用处需补 `'__normal__'` 分支或类型守卫
5. 商品管理页 `fengyu-admin/src/app/(main)/products/` — 不应受影响；但 `category-cascader.tsx` 需要确认其分类下拉是否依赖 `getProductsByKind`

### 3.2 Staff 云函数
1. `grep -rn "_queryCategoryRows" fengyu-staff/cloudfunctions/staffApi` — 该函数仅在 `routes/product.js` 内被 `shopInit` / `categories` 调用；改签名后两处行为均需复核
2. `grep -rn "product_kind" fengyu-staff/cloudfunctions/staffApi` — 找出其他可能硬编码 product_kind 的 SQL（service / order / coupon 等）
3. 不应影响：`order.js`（开单/退款/转换/回款），`service.js`，`appointment.js`，`coupon.js`

### 3.3 Staff 小程序
1. `grep -rn "护理项目.*家居产品\|productKind.*护理项目\|productKind.*家居产品" fengyu-staff/miniprogram` — 找出所有白名单写死的位置
2. `grep -rn "PRODUCT_KIND_CHOICES" fengyu-staff/miniprogram` — 仅 `order-create.ts` 使用，UI 4 选 1 不变
3. `grep -rn "filterSkusByKindChoice\|filterCategoriesByKindChoice" fengyu-staff/miniprogram` — 两个对称的过滤函数都要改

### 3.4 二级目录改造的额外扫描点

1. `grep -rn "OrderPickerCategory\|OrderPickerResult" fengyu-admin/src` — 类型增加 groups 字段后，所有消费方需重新对齐字段
2. `grep -n "van-sidebar\|sidebar-item" fengyu-staff/miniprogram/pages/order-create/order-create.wxml` — 确认仅替换"普通商品"分支的渲染
3. Admin `normal-sku-picker.tsx` 的"4 类 picker 中的主力"注释（文件开头）需更新——它现在是分组结构，不再是平铺
4. UI 设计规范 `.42cog/design/admin.ui.spec.md` 与 `.42cog/design/staff.ui.spec.md` 中"开单页 商品选择 侧边栏"的描述需要同步更新（标注：仅普通商品模式分组，其他模式平铺）

### 3.5 不受影响（不需改）
- 数据库 schema / migrations
- `db/schema/enums.ts` `product_kind` 枚举
- 充值卡 Tab、体验卡 Tab、组合套餐 Tab 的展示链路
- 订单创建（`order.create` / admin `createOrder`）—— SKU 校验只看 `product_skus.is_enabled`，与分类筛选无关
- 提成、积分、统计、营业额分配
- WorkFine 同步链路
- 其他 client / admin 功能

---

## 4 验证清单

### 4.1 Admin 单元测试（Vitest）

新增 `fengyu-admin/src/actions/__tests__/products-getProductsByKind.test.ts` 用例：

- `getProductsByKind('__normal__')` 返回 `kind: '__normal__'`，`categories[].productKind` 不含 `'充值卡'` 或 `'体验卡'`
- 准备测试 fixture：插入一条 `product_kind='福利活动'`（mock 一个非卡 kind，绕过枚举校验直接 SQL）的 category 行，断言它**自动出现在** `__normal__` 返回中
- `getProductsByKind('充值卡')` 返回值不变，仅含 `kind='充值卡'` 的 category
- `getProductsByKind('__bundle__')` 行为不变

### 4.2 Staff 云函数单元测试

`fengyu-staff/cloudfunctions/staffApi/__tests__/product.test.js`（如不存在则新建）：

- `shopInit` 返回 `categories[]` 中无 `productKind ∈ {充值卡, 体验卡}` 的 category
- `categories` action（无参）返回**全量**分类（包含充值卡/体验卡），证明老接口契约保留
- `_queryCategoryRows({ kindNotIn: ['充值卡','体验卡'] })` 直接断言

### 4.3 E2E 验证

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

### 4.4 回归
- 跑 `cd fengyu-admin && bun run test`（537 用例 + 新增）
- `cd fengyu-admin && npx tsc --noEmit`（联合类型扩展后的类型推断完整）
- 部署 staff 云函数后，调 `staffApi.product.shopInit` 检查 `categories` 数组

---

## 5 未决问题

| # | 问题 | 建议默认 |
|---|---|---|
| 5.1 | 是否将 `'空分类（无 SKU）'` 从 `shopInit` 返回的 categories 中剔除？ | 推荐**剔除**（用 `EXISTS` 子查询）。但若运营希望"空分类也展示，引导员工请总部维护 SKU"，则保留 |
| 5.2 | 共享常量 `CARD_PRODUCT_KINDS` 是否值得抽到 db/lib（admin 引用）+ staff 云函数 const 同名复制？ | 本 ticket 默认**各自 const**（详见 §2.2）。若后续频繁新增"卡类"再统一 |
| 5.3 | admin `OrderPickerResult.kind` 联合类型增加 `'__normal__'` 后，cascader / 商品管理页等下游的 `kind` 类型守卫是否需要补分支？ | 实施时 grep `OrderPickerResult` 用法清单，若仅 order-create 链路使用则无需扩散 |
| 5.4 | group header 顺序：是按数据库返回的 product_kind 出现顺序，还是固定"护理项目 → 家居产品 → 其他"？ | 推荐**按 product_kind 在 DB 中的枚举定义顺序**（即 `db/schema/enums.ts` `productKindEnum` 的声明顺序），自然稳定且未来新增 kind 直接在末尾追加 |
| 5.5 | group header 是否显示 kind 名称之外的元信息（例如该组 category 数量 `家居产品 (3)`）？ | 默认**只显示 kind 名**；运营有需求再补 |
| 5.6 | staff 端 `<van-sidebar>` 在"普通商品"模式下被自定义 view 替代，是否会影响 a11y / 触摸高亮等内置交互？ | 实施时手动验证；如有差距用 hover-class + active 状态补齐 |

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

按以下顺序提交两个 PR，可并行 review、串行 merge：

1. **PR-A（admin）**
   - 新增 `fengyu-admin/src/lib/product-kind.ts` 导出 `CARD_PRODUCT_KINDS`
   - 扩展 `ProductKindForOrder` 联合类型 + `getProductsByKind` 增加 `__normal__` 分支
   - 返回结构扩展：`'__normal__'` 模式下额外返回 `groups: [{ productKind, categories }]`，`SQL ORDER BY product_kind, sort_order`
   - 改 `resolveBackendKinds` 返回单值
   - `normal-sku-picker.tsx` 侧边栏改为按 `groups` 渲染：仅 `'__normal__'` 模式分组，其他 kind 仍平铺
   - 调用方一并改为单值传参
   - 单元测试 + Playwright E2E 断言侧边栏 group header 数量与不可点击性

2. **PR-B（staff）**
   - 云函数 `routes/product.js` 顶部加 `CARD_PRODUCT_KINDS` 常量
   - `_queryCategoryRows` 扩展可选 `{ kindIn, kindNotIn }`
   - `shopInit` 传 `kindNotIn` + EXISTS 过滤空分类，返回额外字段 `groupedCategories: [{ productKind, items }]`（保留 `categories` 平铺字段做兼容期）
   - 小程序 `order-create.ts` 顶部加常量；两个 filter 函数改排除法；data 层增加 `groupedCategories` 派生
   - `order-create.wxml` 增加 `wx:if="{{productKindChoice === '普通商品'}}"` 分支：用自定义 view 渲染分组列表；其他 Tab 保留 `<van-sidebar>`
   - `order-create.wxss` 加 `.group-header / .cat-item / .cat-item.active` 样式
   - 云函数单元测试 + 部署 + 开发者工具手动验证两种模式的侧边栏

两端不需要互相等待；spec 文档 `.42cog/pm/admin.pr.spec.md` 和 `.42cog/pm/staff.pr.spec.md` 中"普通商品"目录的描述同步更新（指明排除法语义）。
