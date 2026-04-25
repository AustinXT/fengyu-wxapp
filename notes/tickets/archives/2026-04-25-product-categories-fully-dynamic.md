# Ticket: 品项分类（一/二级）改为完全数据库驱动，剔除全局硬编码

> 生成日期：2026-04-25
> 严重级别：**P1**（业务规则与数据中心分组直接耦合；阻塞 4/17 会议"4 → 7 项品相"落地）
> 端：fengyu-admin（后台）+ fengyu-staff（员工端云函数 + 小程序）+ fengyu-client（顾客端，存量硬编码）+ db（schema/cog/spec）
> 前置 ticket：`archives/2026-04-24-normal-products-category-exclude-filter.md`（已落地：`product_kind` 列从 enum 改 text、admin 一级 kind 管理 UI 激活）
> 跨端面：是
> DB schema 变更：否（DB 层已是 text；本 ticket 不再改列类型）

---

## 0 一句话背景

DB 已经允许"一级品项类型 / 二级品项分类"完全数据驱动（`productKindEnum` 已删，`product_categories.product_kind` 是 text，admin 已可新建任意一级 kind），但**前端 / 云函数 / 类型定义 / 选项常量 / 标签着色逻辑里仍残留 5+ 处硬编码 `'护理项目' | '家居产品' | '充值卡' | '体验卡' | '组合套餐' | '福利活动'`**。这导致：

1. **4/17 会议 §6 "1 级品相 4→7（招牌/王牌/明星 + 家居产品 + 充值卡 + 体验卡）" 无法只靠 admin 后台改数据落地**——任何新增/拆分一级 kind 都要改三端代码。
2. 顾客端购物车标签、员工端商品详情 tag 颜色，对未在硬编码列表里的 kind **直接不渲染**，新 kind 进入后视觉降级。
3. `is_shengmei` 字段在商品创建/编辑页用 `selectedProductKind === '护理项目'` 字面量判断展示，未来"招牌/王牌/明星"分裂后必失效。
4. spec 文档 `.42cog/cog.md` / `.42cog/pm/staff.pr.spec.md` 仍把"四大品项"列为固定常量，与"DB 驱动"事实不符。

> 用户原话（2026-04-25）："品项分类（一级和二级）不是固定的枚举值，是需要从数据库获取的"。
> 隐含强约束：员工端开单仍要"分类稳定"——稳定不等于硬编码，**稳定靠 admin 不乱改 DB 行**，不靠代码常量。

---

## 1 现状盘点（差异报告）

### 1.1 DB / 数据层（已合规，**本 ticket 不动**）

| 维度 | 当前 | 是否合规 |
|---|---|---|
| `product_categories.product_kind` 列类型 | text（PG enum 已 DROP） | ✅ |
| 一级行约定 | `productKind IS NULL`，`category_name = kind 名` | ✅ |
| 二级行约定 | `productKind = 一级行的 category_name` | ✅ |
| `mall_categories.category_group` | text（NULL=一级分组） | ✅ |
| admin "一级品项管理" UI | `createProductKind` / `updateProductKind` 已激活 | ✅ |

### 1.2 残留硬编码清单（需逐项处理）

| # | 位置 | 行 | 现状 | 问题 |
|---|---|---|---|---|
| H1 | `fengyu-admin/src/lib/types.ts` | 183 | `export type ProductKind = '组合套餐' \| '护理项目' \| '家居产品' \| '充值卡' \| '体验卡'` | 文件级类型常量；新增 kind 需改类型定义 |
| H2 | `fengyu-admin/src/lib/product-kind.ts` | 12 | `export const CARD_PRODUCT_KINDS = ['充值卡', '体验卡'] as const` | 排除法卡名单——**有意保留为"硬编码三处常量"**（前置 ticket §2.9 折中），本 ticket 评估是否升级为 DB flag |
| H3 | `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` | 42-44 | `PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡']` | 顶部 Tab 的 4 选 1，未来"卡类扩列"时硬挂 |
| H4 | `fengyu-admin/src/app/(main)/products/[id]/_components/product-detail-page.tsx` | 110, 197 | `selectedProductKind === '护理项目' ? isShengmei : null` | 字面量等值判断；护理项目拆"招牌/王牌/明星"后该判断永远 false，is_shengmei 字段失展示 |
| H5 | `fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx` | 97, 153 | 同 H4 | 同 H4 |
| H6 | `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 25 | `const CARD_PRODUCT_KINDS = ['充值卡', '体验卡']` | 与 H2 重复，三处硬编码常量同步压力 |
| H7 | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | 16, 26 | `PRODUCT_KIND_CHOICES`, `CARD_PRODUCT_KINDS` | 与 H3+H6 重复 |
| H8 | `fengyu-staff/miniprogram/pages/order-create/order-create.wxml` | 18-19 | `wx:if="{{productKindChoice === '组合套餐'}}"` | 视图分支用字面量；本身不可避免（视图常量映射），但与 §1.3 文档冲突 |
| H9 | `fengyu-staff/miniprogram/packageService/product-detail/product-detail.wxml` | 22-26 | `<van-tag wx:if="{{spu.product_kind === '组合套餐'}}">…<wx:elif="{{spu.product_kind === '护理项目'}}">…<wx:elif="{{spu.product_kind === '家居产品'}}">…<wx:elif="{{spu.product_kind === '充值卡'}}">…<wx:elif="{{spu.product_kind === '体验卡'}}"…` | 5 个固定 tag + 5 种颜色；新 kind 完全不渲染 tag |
| H10 | `fengyu-client/miniprogram/pagesShop/shopping-cart/shopping-cart.wxml` | 56-58 | 仅匹配"护理项目/家居产品/充值卡"3 个 tag，遗漏体验卡，**新 kind 不渲染** | 同 H9 同质问题（顾客端） |
| H11 | `fengyu-staff/miniprogram/components/bundle-picker/bundle-picker.ts` | 179 | `productType: sku?.productType \|\| '组合套餐'` | 字面量兜底；可保留（仅 fallback） |
| H12 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 112, 123, 939, 2078, 2333, 2347 | `pc.product_kind <> '体验卡'` / `= '体验卡'` / `= '充值卡'` | 业务规则真挂在"卡 vs 非卡"二分上，与 H2 同源（语义=`is_card`） |
| H13 | `fengyu-client/cloudfunctions/payNotify/index.js` | 249, 407, 418 | 同 H12（`product_kind = '充值卡' / <> '体验卡' / = '体验卡'`） | 同 H12 |
| H14 | `fengyu-staff/cloudfunctions/staffApi/routes/card.js` | 41, 142 | `pc.product_kind = '充值卡'` | 充值卡虚拟 SKU 入口；可保留为业务字面量（特殊业务实体） |
| H15 | `db/scripts/sync-workfine.js` | 780-787 | `mapProductKind` 映射 raw → 4 字面量；同步脚本兜底 | 同步脚本可保留（WorkFine 数据迁移历史专用，非运行时路径） |

### 1.3 文档与事实冲突

| 位置 | 行 | 内容 | 冲突 |
|---|---|---|---|
| `.42cog/cog.md` | 35 | "商品类型（product_kind）：`福利活动` \| `护理项目` \| `家居产品` \| `充值卡`" | 写成定值，应说明"由 admin `product_categories.productKind IS NULL` 行驱动" |
| `.42cog/pm/staff.pr.spec.md` | 93 | "顶部 Tab：`福利活动 \| 护理项目 \| 家居产品 \| 充值卡`（`product_kind`）固定常量" | 同上；4/17 会议已要求 4→7 |
| `.42cog/pm/backend.pr.spec.md` | 112 | `product_kind` 描述列出 4 字面量 | 同 |
| `notes/meetings/meeting-20260417/article.md` | 223 | 待办 #4 "1 级品相拆为 7 项" 状态=待修改 | **本 ticket 是该项的工程依赖** |

---

## 2 期望行为

### 2.1 一级品项 / 二级品项的 SSoT

| 维度 | SSoT |
|---|---|
| 一级品项类型（kind）名单 | `product_categories WHERE productKind IS NULL AND isValid=true ORDER BY sortOrder` |
| 二级品项分类名单 | `product_categories WHERE productKind = $kind AND isValid=true ORDER BY sortOrder` |
| 排除法"卡类 vs 非卡" | 引入 `product_categories.is_card_kind boolean DEFAULT false` 列（详见 §3 PR-A），**取消三处硬编码 `CARD_PRODUCT_KINDS`** |
| 一级 kind 的颜色/图标（H9/H10） | 引入 `product_categories.display_color text` + `display_icon text`（一级行可填，二级行 NULL 时继承父级） |
| `is_shengmei` 表单显隐（H4/H5） | 改用 `selectedCategory.salesCategory != null`（生美/非生美约定挂 sales_category）或新增 `product_categories.requires_shengmei boolean`（保险方案，详见 §3 PR-B） |

### 2.2 期望的"新增一级 kind"零代码变更路径

```
admin →"商品 → 品项分类 → 一级品项管理"→ 新建"招牌"
       ↓ DB 写入 product_categories(category_name='招牌', productKind=NULL, sortOrder=2, isValid=true, isCardKind=false, displayColor='#C0322A')
       ↓ 全端立即可见：
         • staff/order-create 顶部 Tab "普通商品" 下侧边栏出现"招牌" group header
         • staff/product-detail tag 自动以 displayColor 渲染
         • client/shopping-cart tag 同上
         • admin/order-create 同 staff
```

---

## 3 修改计划（PR 拆分）

> **执行顺序**：PR-A → PR-B → PR-C → PR-D。PR-B 与 PR-D 在 PR-A 合并后可并行。
> 每个 PR 必须含单元测试 + 至少一处 E2E（admin 已有 21 spec）/ 集成（云函数 jest）覆盖。

### PR-A：DB 加 `is_card_kind` / `display_color` 列 + admin SSoT 改造

**目标**：把"卡 vs 非卡"和"一级 kind 颜色"从代码常量提升为 DB 列，admin UI 激活管理。

| 文件 | 改动 |
|---|---|
| `db/schema/product.ts` | `product_categories` 新增 `isCardKind boolean NOT NULL DEFAULT false`、`displayColor text`、`displayIcon text`（一级行用，二级行可 NULL 继承） |
| `db/migrations/00NN_*.sql`（drizzle-kit 生成 + 末尾追加 UPDATE） | 1) ADD COLUMN；2) `UPDATE product_categories SET is_card_kind=true WHERE product_kind IS NULL AND category_name IN ('充值卡','体验卡')`；3) 一次性补色：把现行硬编码颜色 (`护理项目=#C0322A` / `家居产品=#5AACA5` / `充值卡=#D4820A` / `体验卡=#8B5CF6` / `组合套餐=#C0322A`) UPDATE 落库 |
| **两库都跑**：5433/fengyu_wxapp + 5434/fengyu | 见 `db/CLAUDE.md` 强制流程 |
| `fengyu-admin/src/actions/products.ts` `getProductKinds()` | 返回值新增 `isCardKind` / `displayColor` / `displayIcon`；调用方按需消费 |
| `fengyu-admin/src/lib/product-kind.ts` | **保留文件作为兼容层**：`export const CARD_PRODUCT_KINDS` 改为 **deprecated**，新增 `getCardProductKinds(): Promise<string[]>` 走 DB 查询；admin 内部逐步迁移 |
| `fengyu-admin/src/lib/types.ts` | 删 `export type ProductKind = ...` 字面量联合类型；保留 `ProductKindForOrder` 但其字面量"虚标识符" `'__bundle__' \| '__normal__'` 不变（这两个是后端协议常量不是 kind） |
| `fengyu-admin/src/app/(main)/products/categories/_components/product-kind-management-dialog.tsx` | 一级 kind 表单加 `isCardKind` checkbox + `displayColor` color picker + `displayIcon` 文本 |
| `fengyu-admin/src/actions/products.ts` `getProductsByKind('__normal__')` | `notInArray(productCategories.productKind, CARD_PRODUCT_KINDS)` 改为 `WHERE NOT EXISTS (...) FROM product_categories parent WHERE parent.category_name = child.product_kind AND parent.is_card_kind = true` |

**验收**：
- `bun run test` 全绿；新增 5+ 测试覆盖 `getProductKinds` / `getProductsByKind('__normal__')` 的"卡名单从 DB 读"路径
- admin 一级品项管理弹窗能新建一个 `isCardKind=true` 的虚拟 kind"测试卡"，刷新开单页该 kind 应被普通商品分支排除
- E2E `orders-normal-products-groups.spec.ts` 改为不依赖字面量，断言 group header 是 `getProductKinds().filter(k => !k.isCardKind)` 序列

### PR-B：admin / staff 商品详情页 `is_shengmei` 显隐改为 capability flag

**目标**：剔除 H4/H5 字面量判断，改用 capability。

| 文件 | 改动 |
|---|---|
| `db/schema/product.ts` `productCategories` | 一级行新增 `requiresShengmeiFlag boolean NOT NULL DEFAULT false` |
| migration | UPDATE 把"护理项目"行的 `requires_shengmei_flag=true`；4/17 会议拆分后"招牌/王牌/明星"也同步 true（admin 内手动批量勾选） |
| `fengyu-admin/src/app/(main)/products/[id]/_components/product-detail-page.tsx` | `selectedProductKind === '护理项目' ? isShengmei : null` 改为 `selectedCategory.parentRequiresShengmei ? isShengmei : null` |
| `fengyu-admin/src/app/(main)/products/create/_components/product-create-page.tsx` | 同上 |
| `fengyu-admin/src/actions/products.ts` `getCategories(...)` 返回 | JOIN 一级行带出 `parentRequiresShengmei` |

**验收**：admin 创建 SKU，分类挂在 `requiresShengmeiFlag=false` 的一级 kind 下时表单不显示"是否生美" Radio；挂在 `=true` 的 kind 下显示。

### PR-C：staff `product_kind` 业务字面量收敛（H12/H13/H14）

**目标**：H12（`pc.product_kind = '体验卡' / '充值卡'`）这类**业务规则字面量**要分情况：

| 子项 | 决策 |
|---|---|
| **充值卡虚拟 SKU 入口**（H14 `staffApi/routes/card.js` / H13 `payNotify` 充值卡入账） | **保留字面量** + 在文件头加 `// REQUIRES product_kind='充值卡' 一级行存在；删除该 kind 行将破坏充值卡功能` 注释。理由：充值卡是独立业务实体，不只是品项分类的一个值 |
| **体验卡折抵分支**（H12 `order.js:2078, 2333, 2347` 单品体验卡折抵） | 改为 `WHERE pc.product_kind IN (SELECT category_name FROM product_categories WHERE is_card_kind=true AND category_name <> '充值卡')`，**或**等 PR-A 后改读 `is_card_kind=true AND special_capability='trial'` 列。本 PR 选第一种（最小改动） |
| **充值卡入账识别**（H13 `payNotify:249` `product_kind='充值卡'`） | 保留（同 H14） |

**验收**：staff 单元测试覆盖"新增一个 `is_card_kind=true` 的虚拟卡 kind 后，体验卡折抵不会误折抵该新卡 SKU"。

### PR-D：staff/client 视觉层去字面量（H8/H9/H10/H3/H7）

**目标**：UI 渲染不再用 `wx:if="{{x === '具体字面量'}}"` 判断 kind 类别。

| 文件 | 改动 |
|---|---|
| `fengyu-staff/miniprogram/packageService/product-detail/product-detail.wxml` | 5 个 `<van-tag wx:if/elif>` 替换为 `<van-tag wx:if="{{spu.kind_display_color}}" custom-style="background: {{spu.kind_display_color}}">{{spu.product_kind}}</van-tag>`；spu 数据从 staffApi.product.spuDetail 返回时 JOIN 父级 kind 行带出 `kind_display_color` |
| `fengyu-client/miniprogram/pagesShop/shopping-cart/shopping-cart.wxml` | 同上模式（`item.kindDisplayColor` 由 cart util 注入） |
| `fengyu-client/miniprogram/utils/cart.ts` | `addToCart` 时一并存 `kindDisplayColor`（来自 categories.shopInit 接口） |
| `fengyu-client/cloudfunctions/clientApi/routes/product.js` | shopInit / categories 返回结构补 `kind_display_color` |
| `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | `PRODUCT_KIND_CHOICES` 保留为视图常量（4 选 1 是产品交互层，不等于 kind 列表）；但 `CARD_PRODUCT_KINDS` 改为 onLoad 时调 `staffApi.product.cardKinds` 拉取（云函数读 `is_card_kind=true`），写入 page.data |
| `fengyu-staff/cloudfunctions/staffApi/routes/product.js` | 新增 `product.cardKinds` action 返回 `string[]`；删除文件顶 `const CARD_PRODUCT_KINDS = ['充值卡', '体验卡']`，改为运行时一次性查询缓存 |
| `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` | 同思路，`CARD_PRODUCT_KINDS` 改 server action 拉 |
| `fengyu-staff/miniprogram/pages/order-create/order-create.wxml` H8 | 保留（`'组合套餐'` 是视图状态枚举常量，不是数据驱动） |

**验收**：admin 新建一个 `isCardKind=true` 的"测试卡"一级 kind，**无需改任何代码**：
- staff 开单"普通商品"侧边栏不出现该 kind
- staff `product-detail` 该 kind 的 SKU 显示 tag（颜色取 admin 配置）
- client 购物车该 kind 的行显示 tag

---

## 4 文档同步（PR-A 同 PR）

| 文件 | 改动 |
|---|---|
| `.42cog/cog.md` L35 | 删去字面量列举；改为"`product_categories.productKind IS NULL` 行驱动；运营在 admin 增删；4/17 会议要求拆分护理项目→招牌/王牌/明星即在此操作" |
| `.42cog/pm/staff.pr.spec.md` L93 | "顶部 Tab：从 `product_categories WHERE productKind IS NULL AND isValid=true AND isCardKind=false` 动态渲染" |
| `.42cog/pm/backend.pr.spec.md` L112 | 同 cog.md |
| `MEMORY.md` 项目记忆 | 增 `project_product_kind_dynamic` 条目，记录"一级品项=DB 驱动 + isCardKind 列 + 不再硬编码三处"决策 |

---

## 5 横切关注点 checklist

- [ ] **权限**：admin "一级品项管理"操作 `permission_roles` 是否需新增 `product_kind_admin` 角色？当前是 `product` 角色——保持不变
- [ ] **审计日志**：`createProductKind` / `updateProductKind` 是否已 `logOperation`？查 `actions/products.ts` 确认
- [ ] **数据完整性**：`is_card_kind=true` 的一级行被删除前需阻断（FK 卡死或业务校验"先转移 SKU"）
- [ ] **WorkFine 同步**：`db/scripts/sync-workfine.js` 的 `mapProductKind` 不动（同步脚本是历史一次性数据通道，已停用）
- [ ] **seed 测试数据**：`fengyu-admin/src/db/seed.ts:130-151` 五个 `kind-*` 行需补 `isCardKind` / `displayColor`
- [ ] **存量数据**：生产 `product_categories` 已有的一级行需 admin 一次性补 `displayColor` / `isCardKind`，可写一个 `db/scripts/seed-product-kind-display.js` 兜底（migration 内联 UPDATE 也可）
- [ ] **类型回归**：`ProductKind` 字面量类型删除会让所有 `as ProductKind` cast 编译失败，需逐处改 string

---

## 6 风险点与缓解

| 风险 | 缓解 |
|---|---|
| `is_card_kind` 列加上后忘记 UPDATE 历史行 → 普通商品 group header 漏掉新行 | migration 末尾追加 UPDATE 兜底；admin 一级 kind 列表加红色徽章提示"未配置 is_card_kind" |
| H8 (`'组合套餐'` 视图常量) 反复被误判为硬编码 | PR-A 文档明确：**视图状态字面量** vs **业务规则字面量**——前者保留 |
| H12（体验卡折抵）改读 `is_card_kind` 后误把"充值卡"也纳入折抵 | SQL 显式 `category_name <> '充值卡'`，并在测试覆盖 |
| 4/17 拆分（护理项目→招牌/王牌/明星）与本 ticket 并行 | 拆分依赖本 ticket 完工——拆分时 admin UI 已能单点新建、删除原"护理项目"行，做完即上线 |
| client 购物车 H10 当前漏了"体验卡"颜色 | PR-D 一并修，且通过 displayColor DB 列保障未来不再漏 |

---

## 7 与已落地 ticket 的关系

- 前置 `archives/2026-04-24-normal-products-category-exclude-filter.md`：完成了 DB 层从 enum → text 的迁移、admin 一级 kind 的 CRUD UI 激活。本 ticket 是其逻辑延续：把"硬编码三处常量"折中（§2.9）真正消除。
- 4/17 会议待办 #4「1 级品相 4→7」：本 ticket 完成后，仅需 admin 操作 DB 行即可完成拆分，无代码改动。

---

## 8 落地后可见效果

1. **运营**：admin "商品 → 品项分类 → 一级品项管理"可任意增删一级 kind，配色 / 是否卡类 / 是否需要生美开关均在 UI 内完成。
2. **员工端开单**：新增非卡 kind 自动出现在"普通商品"侧边栏；新增卡类 kind 自动从"普通商品"排除（不再有遗漏穿透）。
3. **顾客端购物车**：所有 kind 都能渲染对应颜色 tag（不再因匹配不到字面量而无 tag）。
4. **后续 4/17 拆分**：仅在 admin 内执行：`DELETE 护理项目 + INSERT 招牌/王牌/明星` + 把原下属二级行的 `productKind` 批量更新（admin 已有级联 UPDATE 实现），全程零代码变更。

---

## 9 工时估算

| PR | 估算 |
|---|---|
| PR-A | 1.5 d（含 migration 双库 + admin UI + 类型清理） |
| PR-B | 0.5 d |
| PR-C | 0.5 d |
| PR-D | 1 d（双小程序前端 + 云函数新接口 + cart util） |
| 合计 | **~3.5 d** |

---

## 10 不在本 ticket 范围

- 商城分类（`mall_categories`）的 `category_group` 已是动态，不动。
- `productTypeEnum`（疗程卡/单品/院装产品）保持 PG enum，不在本 ticket 转 text（用户未提；属业务原子分类，扩展频率极低）。
- `salesCategoryEnum` / `customerTypeEnum` 等其他 enum 同上保留。
- 4/17 拆分本身（招牌/王牌/明星 数据写入）是后续 admin 运营动作，不在本工程 ticket 内。
