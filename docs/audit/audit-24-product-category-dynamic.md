# 审计报告：品项分类动态字段 (24)

**审计时间**：2026-04-25
**域 ID**：24
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：product-categories-fully-dynamic / migration 0014_broad_thunderbolt
**Slug**：product-category-dynamic

> **2026-04-26 进度更新**：体验卡部分已通过 [ticket 2026-04-26-experience-card-as-sku-flag](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md) Round 1 落地（migration 0017 + admin/staff/client 三端代码切换至 `product_skus.is_experience` capability 列 + `sale_items.is_experience` 行级快照）。本报告中体验卡相关条目（P1-24-03 / P0-24-01 体验卡部分 / magic string '体验卡'）标 🟡 部分关闭。剩余 '充值卡' 字面量留 audit-24 单独 ticket 实施 S24-1（is_recharge_card capability 列）。

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/product.ts:18-31`（productCategories：含 4 个 capability 列 isCardKind/displayColor/displayIcon/requiresShengmeiFlag） | ↑ | ↑ |
| Migration | `db/migrations/0014_broad_thunderbolt.sql:1-28`（ADD COLUMN ×4 + 数据回填三段式 UPDATE） | ↑ | ↑ |
| Action / Route | `fengyu-admin/src/actions/products.ts:77-305`（getCategories / getProductKinds / getCardKindNamesFromDb / createProductKind / updateProductKind / createCategory / updateCategory） | `staffApi/routes/product.js:52-104`（_queryCategoryRows）`:248-305`（shopInit）`:313-318`（categories）`:452-470`（cardKinds）；`routes/order.js:113/125`（is_card_kind 业务 SQL） | `clientApi/routes/product.js:18-49`（getCategoriesList — 注意返回的是 mall_categories 而非 product_categories）`:148-167`（spuList JOIN 父级 display_color）`:359-380`（spuDetail 同上） |
| 类型 / 类型常量 | `src/lib/types.ts:215-237`（ProductCategory 接口含 4 capability + 4 parent\* 回填字段）；`src/lib/product-kind.ts:1-19`（CARD_PRODUCT_KINDS 常量保留为 fallback） | `staffApi/routes/product.js:29`（CARD_PRODUCT_KINDS = ['充值卡','体验卡']） | — |
| 前端 | `fengyu-admin/src/app/(main)/products/categories/page.tsx`（loader）+ `_components/categories-page.tsx`（二级 CRUD）+ `_components/product-kind-management-dialog.tsx`（一级 CRUD，唯一带 4 capability 字段的表单） | `miniprogram/packageService/product-detail/product-detail.{ts,wxml}`（消费 kindDisplayColor，缺失退化 type='primary'） | `miniprogram/utils/cart.ts:23` + `pagesShop/{shop,shopping-cart,service-detail}/*`（消费 kindDisplayColor，缺 fallback） |
| 测试 | `src/actions/products.test.ts:23-26, 419-518, 665`（capability 字段 + getCardKindNamesFromDb + 动态新建 kind）；`__tests__/products-getProductsByKind.test.ts:204-…`（"福利活动"动态一级行 → __normal__ 自动收纳） | `__tests__/routes/product.test.js:158-159, 370-389, 562-575, 586`（kind_display_color JOIN + cardKinds DB 优先 + 兜底常量）；`__tests__/routes/recalc-customer-type-sql.test.js:73-104`（is_card_kind=false / true SQL 反死分支锁定） | — |

> **关键观察**：admin 是 capability 字段的**唯一写入端**（且管理界面唯一）；staff 端是消费方（is_card_kind 在 order.js 业务 SQL、cardKinds API、shopInit 排除分支中读取）；**client 端完全不读取 4 个 capability 字段**，仅借助 admin 配好的 `display_color` 由 server 端拼成 `kind_display_color` 列下发到 cart/shop tag 渲染。

---

## 2. 数据流图

```
admin createProductKind(name, isCardKind?, displayColor?, displayIcon?, requiresShengmeiFlag?)
  └─> INSERT product_categories(productKind=NULL, …4 capability cols)
       └─> revalidatePath('/products')

admin updateProductKind(id, partial)
  ├─> Optimistic lock (updatedAt CAS)
  └─> tx.update self + 若改名级联 update children.product_kind

——— 消费链路 ———

admin SKU 表单 渲染 “是否生美” Radio
  └─ readsParentRequiresShengmeiFlag (LEFT JOIN parent in getCategories)

staff order.js 业务分支（小美客 / 体验客判定 / pickup 守卫）
  └─ JOIN product_categories pc_parent
       (pc_parent.is_card_kind = false / = true AND ≠ '充值卡')

staff product.js shopInit
  └─ kindNotIn = CARD_PRODUCT_KINDS（**JS 常量，不读 is_card_kind 列**）

staff product.cardKinds  ← 唯一从 DB 读 is_card_kind 的 staff API
  ├─ 成功：names = SELECT category_name WHERE product_kind IS NULL AND is_card_kind=true AND is_valid=true ORDER BY sort_order
  └─ 失败：names = CARD_PRODUCT_KINDS.slice() （兜底）

client clientApi/routes/product.js  ← **不存在读取 is_card_kind / requires_shengmei / display_icon 的代码路径**
  └─ 唯一动态字段消费：spuList / spuDetail  LEFT JOIN parent_pc 输出 kind_display_color
      （cart 标签 + 商品详情 tag 颜色）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### [P0-24-01] admin 一级 kind 行可被任意设为 `is_valid=false` / 物理修改父名，**无下游引用阻断**，可瞬间击穿 staff/client 视觉与 order 业务 SQL
- **文件**：
  - `fengyu-admin/src/actions/products.ts:229-305 updateProductKind`（仅做"重名校验 + 乐观锁 + 级联改子级 product_kind"，**不校验是否仍有二级分类 / SKU / 在售订单引用**）
  - 同文件 stop / 停用入口（`product-kind-management-dialog.tsx:141-163 handleDisable`）调 `updateProductKind(..., { isValid: false })`，无任何依赖检查
- **现象**：
  - admin 用户停用一级 kind 行（如 `护理项目`）后：
    - `staffApi/routes/product.js:317 categories` 仍返回 *二级行*（其 product_kind 文本指向已停用一级行），因为 `_queryCategoryRows` 只过滤 `child.is_valid=true`
    - 但 `shopInit` 的 `withParentJoin` 查询带 `parent.is_valid=true` 守卫 → 整组二级分类被静默从开单页消失（"商品突然全部不见"）
    - `order.js:113/125` 的 `pc_parent.is_card_kind = false / true` 业务 SQL 的 JOIN 仍命中（因 JOIN 条件不要求 parent.is_valid=true，见 `order.js:108-109`）→ 客户类型判定逻辑继续依赖一已停用的 kind，与 admin 视觉脱钩
  - 改名场景已有级联，但 hardcoded 文本 `<> '充值卡'` 在 staff/order.js 多处（lines 125 / 942 / 2084 / 2317 / 2340 / 2355）和 admin createOrder（lines 643/646/649/658/673/677）写死。**admin 把"充值卡"改名为"充值卡片"将瞬间击穿**：staff 端"小美客 vs 体验客"判定全部错乱，admin createOrder 充值卡守卫全部失效（充值卡可叠加优惠券、可作为内部单等）。
- **风险**：
  1. 业务 SQL 的"充值卡"硬编码与 admin 自由改名的 capability 互相矛盾；改名不阻断也不警告
  2. 停用一级行无前置依赖检查（"该 kind 下还有 N 个二级分类 / 在售 SKU"），仍可成功，导致开单页突然空
  3. real.md #4 状态单向 + spec "一级品项类型完全 DB 驱动" 之间的张力：**承诺 100% DB 驱动，实际多处仍硬编码字面量 "充值卡" 作为"非充值"判定的反向锚**
- **复现**：
  1. admin → 品项分类 → 品项类型管理 → 编辑「充值卡」改名为「充值卡片」→ 保存（成功）
  2. staff order.create 充值卡新单 → 客户类型应跃迁 `小美客` 但被误判为 `体验客`（业务规则倒挂）
  3. admin 开单页面/新增订单 → 充值卡守卫文本匹配失败 → 任意叠加优惠券通过
- **修复**：(L0/L7)
  - L0：把"充值卡"这个语义升格为新的 capability 列（如 `is_recharge_card boolean`），或扩展现有 `is_card_kind` → 三态（'非卡' / '体验卡' / '充值卡'）— 更彻底
  - L7：admin updateProductKind 改名前 grep "is the new name still '充值卡'-class?" 强制 capability 同步；改名/停用前查依赖（二级分类数 / SKU 数 / 在售订单数）展示给用户确认
  - L3：staff/order.js 全部 `<> '充值卡'` 替换为 capability 查询（如 `pc_parent.is_recharge_card = false` 或 `pc_parent.is_card_kind = true AND pc_parent.is_recharge_card = false`）

#### [P0-24-02] admin createCategory / updateCategory **不校验** `productKind` 文本是否与一级行 `category_name` 实时引用关系一致
- **文件**：`fengyu-admin/src/actions/products.ts:307-348 createCategory` / `:351-406 updateCategory`
- **现象**：
  - `createCategory` 校验"productKind 必须是有效一级行 category_name"（行 317-329 ✓）
  - 但 `updateProductKind` 改名时通过事务 `tx.update children` 级联同步 product_kind 文本（lines 293-299 ✓）。
  - **危险窗口**：当一级行 isValid 被设为 false 时，**已有二级行不会被级联停用**，仍 `is_valid=true`；同时 `getCategories` 对二级行 LEFT JOIN parent 时 JOIN 条件**不要求** parent.is_valid=true（actions/products.ts:96-98） → 父级停用后子级仍能拿到 parent.displayColor、parent.requiresShengmeiFlag 等回填值 → admin/staff 表单继续按"已停用"父级的 capability 渲染，与 cardKinds API（强制 is_valid=true）口径不一致
- **风险**：
  - admin SKU 创建表单按已停用 kind 的 requiresShengmeiFlag 渲染"是否生美"开关（`product-detail-page.tsx:56`），导致表单状态与 `getProductKinds()`（lists 时不滤 is_valid）一致但与 `cardKinds`（API 滤 is_valid）不一致 → 三处口径漂移
- **修复**：(L7)
  - `getCategories` LEFT JOIN parent 的 ON 条件加 `AND parent.is_valid = true`，与 `cardKinds`/`shopInit` 对齐
  - 或：`updateProductKind` 关闭一级行时事务内级联 `is_valid=false` 至所有子级，并在 admin 弹层确认（"将同时停用 N 个二级分类"）

### 3.2 P1（一致性 / 状态错乱）

#### [P1-24-03] staff `shopInit` 用 JS 常量 `CARD_PRODUCT_KINDS = ['充值卡','体验卡']` 排除卡类，**不读 `is_card_kind=true`**（与 spec 完全 DB 驱动违背）

> **🟡 部分关闭（2026-04-26 ticket Round 1）**：体验卡部分已通过 [ticket 2026-04-26-experience-card-as-sku-flag](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md) 修复。staff `routes/product.js` 删除 CARD_PRODUCT_KINDS 中的 '体验卡'，shopInit 改用 `WHERE NOT ps.is_experience`（capability 列）。剩余 '充值卡' 部分保留作为本条的未关闭项，等 [S24-1](./SCHEMA-CHANGES.md#s24-1-product_categories-加-is_recharge_card-capability-列) 实施后一并关闭。

- **文件**：`staffApi/routes/product.js:29, 248-253`（`kindNotIn: CARD_PRODUCT_KINDS`）
- **现象**：admin 通过 `product-kind-management-dialog.tsx` 新增第 5 个一级 kind 并勾 `isCardKind=true`（如"充值卡VIP"），shopInit 仍用 JS 字面量排除，新建的 kind 会**出现在普通商品 Tab 中**，违反 "卡类应走独立 Tab 流" 的产品意图。
- **风险**：spec 中"零代码变更新增 kind"的承诺被打破（PLAN §2 行 96 关键检查点失败）。`cardKinds` API 是从 DB 读，但 shopInit 没用它。
- **修复**：(L3) `shopInit` 改成先 `await _queryCardKindNames()` 取 DB 名单（带 try/catch fallback），再传给 `_queryCategoryRows({ kindNotIn })`。**或**：与 audit-24 S24-1 同步推进，最终改为 `WHERE NOT (is_experience OR is_recharge_card)` 双 capability 列模式。
- **CC9 命中**：动态字段未在三端"消费侧"完全落地，违反 DB 驱动 SSoT 原则

#### [P1-24-04] client 端**完全不消费** `is_card_kind` / `requires_shengmei_flag` / `display_icon` 三个动态字段
- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/product.js`（全文 grep 0 处引用 is_card_kind / requires_shengmei / display_icon；唯一动态字段消费是 `display_color → kind_display_color`，见 lines 156, 369）
- **现象**：
  - client product.categories 接口返回 `mall_categories`（**商城分类，非 product_categories**）— 完全跳过一级 kind capability
  - spuDetail / spuList 仅透传 `kind_display_color`；`displayIcon` 在 server 端从未 SELECT，前端 `cart.ts:23` 只声明 `kindDisplayColor`，无 displayIcon 字段
  - 顾客端"是否生美"标签和"卡类"标识完全不展示（client 没有 SKU 创建表单，但商品详情页本可以展示生美标签 / 卡类徽章）
- **风险**：
  - migration 0014 引入 4 个字段，但 client 实际仅消费 1 个（display_color），其余 3 个仅 admin 写、staff 读（且半 DB 驱动）→ "三端一致"承诺不成立
  - 顾客端未来想展示"卡类徽章"（如美团式的"次卡"标签）需要 server 改 SQL + 前端改 wxml + 测试 — 不再是 DB 驱动零代码
- **修复**：(L3) client product.spuList / spuDetail / hotList 的 SKU JOIN 同步附带 parent_pc 的 `is_card_kind` / `display_icon` / `requires_shengmei_flag`，前端按需消费；至少把 `display_icon` 透传以对齐 admin "保留可能性" 的设计意图。

#### [P1-24-05] migration 0014 数据回填**仅对存量 5 个字面量 kind 命中**，未来新建/改名 kind 的回填责任无 DB 兜底
- **文件**：`db/migrations/0014_broad_thunderbolt.sql:5-27`
- **现象**：回填 `is_card_kind` / `display_color` / `requires_shengmei_flag` 仅命中 `category_name IN ('组合套餐','护理项目','家居产品','充值卡','体验卡')`。一级行表 schema：
  - `is_card_kind` `NOT NULL DEFAULT false` ✓
  - `display_color` 可空 → 新建 kind 不填 displayColor 时 SKU 列表 `kind_display_color` 列直接 NULL
  - `requires_shengmei_flag` `NOT NULL DEFAULT false` ✓
- 前端 wxml 已预防 `kindDisplayColor` 缺失（`product-detail.wxml:23` `wx:if="{{spu.productKind && spu.kindDisplayColor}}"`），但 admin 新建时 form 默认值 `displayColor: ""`（`product-kind-management-dialog.tsx:38`）经 trim 后变 null（lines 98-101）→ 新建 kind 默认无颜色，开单页商品 tag 无视觉
- **风险**：admin 默认 UX 不强制 displayColor 必填，新建 kind 的"商品 tag 视觉"完全缺失，与"卡类徽章"/"分类色"产品意图脱钩
- **修复**：(L7) admin createProductKind 把 displayColor 标必填（或给"无颜色"明确默认 `#1989FA`），UI 层 ColorPicker 已默认 `#1989FA`（line 274），但状态空字符串与 input default 脱节

#### [P1-24-06] `getCategories` LEFT JOIN parent 时**不过滤 parent.is_valid**，已停用一级行的 capability 仍回填到二级行
- **文件**：`fengyu-admin/src/actions/products.ts:93-98`
- **现象**：
  ```ts
  .leftJoin(parent, and(
    isNull(parent.productKind),
    eq(parent.categoryName, productCategories.productKind),
  ))
  ```
  缺 `eq(parent.isValid, true)`
- **风险**：详见 P0-24-02。三个 capability getter 函数的 JOIN 守卫不一致（getCardKindNamesFromDb 滤 is_valid=true ✓，getCategories 不滤 ✗，getProductKinds 不滤 ✗）。
- **修复**：(L7) 三个 getter 统一守卫 `parent.is_valid = true`；二级行返回时 `isValid=false` 的 parent 应让回填字段返回 null

#### [P1-24-07] admin 缺 `deleteCategory` / `deleteProductKind` action（仅停用，无硬删除路径）
- **文件**：`fengyu-admin/src/actions/products.ts`（全文 grep `category.delete` 仅 `mall_category.delete` 命中 `:1294`，product_categories 无对应 action）
- **现象**：
  - admin UI 仅"停用"（`isValid=false`），没有"删除"按钮
  - 但 schema 上 `productSkus.categoryId` 有 NOT NULL FK 引用 `productCategories.categoryId`（`db/schema/product.ts:44-46`） → 即使有 delete action 也会被 FK 阻挡
  - 审计上需明确：**永不可硬删除**是设计决定，应该在 spec 文档中固化
- **风险**：
  - "停用"语义之外没有"归档"语义；停用的二级分类仍出现在 `getCategories`（admin 内部使用）但被 `_queryCategoryRows`（is_valid=true 守卫）排除 — 三个查询路径"停用过滤"不一致
- **修复**：(L7) 文档注释 schema：`productCategories` 永不硬删除；UI 把"停用"明确说明为"软停用，不影响历史订单 / 顾客类型 SQL"
- **CC9 命中**：枚举 / 动态行的"删除语义"不一致，跨域已多次出现

#### [P1-24-08] admin `productKind` 仍是 `text` 列、自由文本，但前端 `order-create-page.tsx` 硬编码 `PRODUCT_KIND_CHOICES = ['组合套餐','普通商品','体验卡','充值卡']`
- **文件**：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:42-44`
- **现象**：
  - admin 开单页 Step 1 "商品类型 4 选 1" 是 *硬编码* 4 个字面量
  - admin 内 `getProductsByKind('__bundle__'|'__normal__'|string)` 的 `__normal__` 分支用排除法（is_card_kind=false）✓ 真正 DB 驱动
  - 但前端 4 选 1 的 UI 写死，新建第 5 个 kind 不会出现
- **风险**：与 P1-24-03 同源，"DB 驱动"承诺在前端依然失效；spec 与代码再次脱节
- **修复**：(L9) admin 开单 Step 1 改成 await getProductKinds() + 按 isCardKind/isBundle 自动渲染 4-N 选项（"组合套餐"由 products.is_bundle 表达，"普通商品"= 非卡类聚合）

#### [P1-24-09] admin createProductKind 不校验 `displayColor` 格式
- **文件**：`fengyu-admin/src/actions/products.ts:174-223`
- **现象**：`displayColor` 字段直接 `data.displayColor ?? null` 入库，无 HEX 格式校验（`#RRGGBB` / `#RGB`）
- **风险**：admin 用户填入 `red` / `oklch(0.5 0.1 30)` / 任意字符串都能入库，前端 wxml `color="{{kindDisplayColor}}"` 直传 Vant `<van-tag>` 触发渲染异常
- **修复**：(L7) Zod schema 对 displayColor 加 `regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)` 校验

### 3.3 P2（代码质量 / 可维护）

#### [P2-24-10] CARD_PRODUCT_KINDS 常量在 admin/staff 双副本 + 测试 fixture，已 deprecated 但未清理
- **文件**：
  - `fengyu-admin/src/lib/product-kind.ts:16` （标 `@deprecated`）
  - `staffApi/routes/product.js:29`（标 `@deprecated PR-D 起改用 DB`）
- **现象**：双方都有"运行时兜底"理由，但 `staffApi/cardKinds` 的 try/catch 内 PG 异常已极小概率，常量保留必要性偏低；admin 端 lib/product-kind.ts 注释明确 "不要在新代码里直接引用此常量"，但 `staffApi/routes/product.js:253 shopInit` 仍直接用，未走 cardKinds 路径
- **修复**：(L3) staff shopInit 改走 cardKinds DB 路径；admin lib/product-kind.ts 在所有新代码切走后删除
- **CC9 命中**：deprecated 常量残留

#### [P2-24-11] `display_icon` 字段在 admin **写得到、读得到**，但**三端均无任何渲染消费**（dead column）
- **文件**：
  - admin write：`product-kind-management-dialog.tsx:289-296`（输入框 ✓）+ `actions/products.ts:212`（INSERT ✓）
  - admin read：`actions/products.ts:88, 112, 148`（getCategories / getProductKinds 返回 ✓）
  - staff read：`staffApi/routes/product.js` 全文未 SELECT display_icon ✗
  - client read：未 SELECT ✗
  - 前端：`cart.ts:23` 仅 `kindDisplayColor`，无 displayIcon ✗
- **风险**：列存在但全链路无消费，配置后用户看不到效果，等效暗坑（用户填了但永远看不见图标）
- **修复**：(L3/L9) 要么在 staff/client product.spuList 等接口透传 + 前端渲染 `<van-icon>{{kindDisplayIcon}}</van-icon>`；要么删除该列以避免误导

#### [P2-24-12] `recalc-customer-type-sql.test.js` 锁死了字面量 `<> '充值卡'`，让"充值卡改名"不可能通过测试
- **文件**：`staffApi/__tests__/routes/recalc-customer-type-sql.test.js:78, 104`
- **现象**：
  ```js
  expect(staffSql).toContain("pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'")
  ```
  这个测试是好心（防 PR-C 反死分支回归），但同时**也固化了"充值卡"作为 magic string** — 改名 → 测试挂掉 → 想绕开就要改测试。
- **风险**：测试约束本身阻碍 P0-24-01 的根本修复
- **修复**：(L0+L3) 把"充值卡"语义抽到 capability 列（如 `is_recharge_card`），测试改 expect SQL 含 capability 列名，不含字面量

#### [P2-24-13] migration 0014 注释"组合套餐"的 displayColor 回填仍存在，但 schema 已说明"组合套餐"概念已移除
- **文件**：`db/migrations/0014_broad_thunderbolt.sql:14-15`
- **现象**：UPDATE 给"组合套餐"行 displayColor=#C0322A，但 MEMORY.md 明确"v2.1 baseline reset 时从 product_kind 枚举中移除组合套餐"。0014 baseline 之后才执行，理论上"组合套餐"行不应存在。
- **风险**：迁移脚本对一个事实上已不存在的 category_name 做 UPDATE — 0 rows affected（无害）但留下"曾经存在过"的语义噪音
- **修复**：(L0) 注释里说明该分支为兜底，或移除（不影响任何 row）

#### [P2-24-14] 一级行 `salesCategory` 列**不会被使用**（一级行的 sales_category 永远是 NULL）
- **文件**：`db/schema/product.ts:22`
- **现象**：sales_category 仅在二级行有意义（决定 SKU 提成比例），一级行无对应业务
- **修复**：(L0) schema 注释明确 `sales_category` 仅二级行（productKind IS NOT NULL）写值，一级行强制 null；可加 CHECK `(product_kind IS NULL AND sales_category IS NULL) OR (product_kind IS NOT NULL)` 防误填

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| `is_card_kind` 写入 | ✓ createProductKind / updateProductKind | — | — | 单端写 | OK |
| `is_card_kind` 读取 | ✓ getCardKindNamesFromDb（DB）+ types `parentIsCardKind` | ✓ cardKinds API（DB）+ order.js 业务 SQL（DB）；**shopInit 用 JS 常量** | ✗ 不读 | "DB 驱动"承诺破裂 | **P0** |
| `display_color` 写入 | ✓ ColorPicker | — | — | OK | — |
| `display_color` 读取 | ✓ DataTable 颜色块展示 | ✓ kind_display_color JOIN 透传 | ✓ kind_display_color JOIN 透传至 cart tag | 三端 OK | OK |
| `display_icon` 写入 | ✓ Input | — | — | dead write | P2 |
| `display_icon` 读取 | ✓ types | ✗ 不 SELECT | ✗ 不 SELECT | 列写不消费 | P2 |
| `requires_shengmei_flag` 写入 | ✓ Switch | — | — | OK | — |
| `requires_shengmei_flag` 读取 | ✓ SKU 表单显隐 (`parentRequiresShengmeiFlag`) | ✗ 不读（staff 端 SKU 由 admin 维护） | ✗ 不读 | 单端消费即合理 | OK |
| 一级行 isValid=false 阻断下游 | ✗ 无依赖检查 | 不一致：shopInit 阻断 / categories 不阻断 / order 业务 SQL 不阻断 | N/A | 视觉与业务半阻断 | P0 |
| LEFT JOIN parent 时是否过滤 is_valid | ✗（getCategories / getProductKinds） | ✓（_queryCategoryRows withParentJoin） | N/A | 三个 getter 不一致 | P1 |
| 改名级联子级 product_kind | ✓（事务内） | N/A | N/A | 但下游硬编码 `'充值卡'` 文本不级联 | **P0** |
| "充值卡" 字面量硬编码 | ✓ orders.ts × 7 处 | ✓ order.js × 5 处 + recalc 测试 lock | — | 改名瞬间击穿业务 SQL | **P0** |
| `productKind` text 自由扩展 | ✓ schema text + admin createProductKind | ✓ shopInit kindNotIn 兜底 + cardKinds DB | client 不感知 productKind 集合 | OK（半 DB 驱动） | P1 |
| 前端商品类型 4 选 1 | ✗ 硬编码 PRODUCT_KIND_CHOICES（4 字面量） | ✗ shopInit kindNotIn 硬编码 | N/A | "零代码新增 kind" 承诺破裂 | P1 |
| `displayColor` HEX 格式校验 | ✗ | N/A | N/A | XSS 风险 / 渲染破坏 | P1 |
| 删除语义 | 仅 isValid=false（软停用），无 delete | N/A | N/A | "停用"含义在三个查询不一致 | P1 |

---

## 5. 横切检查（套用 §3 模板）

- [x] **CC1 数值精度**：本域不涉及金额
- [x] **CC2 并发幂等**：updateProductKind 用乐观锁（updatedAt CAS）+ 事务级联 ✓；createProductKind 重名校验 SELECT-then-INSERT TOCTOU（小范围风险，不致资损）
- [x] **CC3 组织域隔离**：本域是全局基础数据，无组织维度，不涉及；admin requirePermission('product:create'/'product:update') ✓
- [x] **CC4 后端鉴权**：admin 全部 requirePermission ✓；staff cardKinds requireStaffBound ✓；client product.categories 无 requirePhone（按设计允许匿名浏览，与 audit-09 一致）✓
- [ ] **CC5 错误码**：admin 用 `{ success: false, message: '...' }` 无前缀 / staff 用 `INVALID_PARAMS:` ✓；createCategory 用 `INVALID_PRODUCT_KIND:`（`actions/products.ts:328`）— 不在 4 项约定前缀（UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED）内 → 新前缀污染
- [x] **CC6 PII**：本域不涉及
- [x] **CC7 时间字段**：created_at / updated_at 由 Drizzle defaultNow / $onUpdate 管理 ✓
- [ ] **CC8 WXML/Vant**：staff `product-detail.wxml:23` `<van-tag color="{{kindDisplayColor}}">`，admin 写入 displayColor 无 HEX 校验时 Vant 渲染未定义；client wxml `cart.ts` 同问题
- [ ] **CC9 测试与残留**：
  - admin lib/product-kind.ts CARD_PRODUCT_KINDS deprecated 常量保留（与 staff 同 — P2-24-10）
  - migration 0014 注释里"组合套餐"已废弃概念残留（P2-24-13）
  - `display_icon` 写入但不消费（P2-24-11）
  - 测试用 magic string '充值卡' 锁死改名链（P2-24-12）
  - 已废弃枚举 big_category / workfine_source / 福利活动 全仓 grep 0 命中 ✓
  - 已废弃表 catalog_items / material_products / promotion_schemes 全仓 grep 仅 archive snapshot ✓

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/product.ts:18-31` | 评估新增 `is_recharge_card boolean DEFAULT false`（替代 staff/order.js 的 `category_name <> '充值卡'` 字面量）+ 注释 sales_category 仅二级行可填 | P0-24-01, P2-24-14 |
| L0 schema | `db/schema/product.ts:18-31` | 注释明确"product_categories 永不硬删除，仅软停用"；停用一级行级联停用子级 | P1-24-07, P0-24-02 |
| L0 migration | 新建迁移 | UPDATE is_recharge_card=true WHERE category_name='充值卡' AND product_kind IS NULL | P0-24-01 |
| L3 staff | `staffApi/routes/product.js:248-253 shopInit` | kindNotIn 改成 `await _queryCardKindNamesFromDb()`（带 try/catch fallback） | P1-24-03, P2-24-10 |
| L3 staff | `staffApi/routes/order.js:113/125/942/2084/2317/2340/2355` | `pc_parent.category_name <> '充值卡'` → `pc_parent.is_recharge_card = false`（联动 L0 schema 改） | P0-24-01, P2-24-12 |
| L3 client | `clientApi/routes/product.js:148-167 spuList` / `:359-380 spuDetail` / `:271-300 hotList` | LEFT JOIN parent_pc 并附带 is_card_kind / display_icon / requires_shengmei_flag 字段，前端按需消费 | P1-24-04, P2-24-11 |
| L7 admin | `actions/products.ts:93-98 getCategories` LEFT JOIN | `eq(parent.isValid, true)` 守卫，与 cardKinds 对齐 | P0-24-02, P1-24-06 |
| L7 admin | `actions/products.ts:128-153 getProductKinds` | 调用方按需选择是否过滤 isValid（增加 `includeDisabled` 入参） | P1-24-06 |
| L7 admin | `actions/products.ts:229-305 updateProductKind` | 改名/停用前查依赖（子级 + SKU + 在售订单），UI 弹层确认 | P0-24-01, P0-24-02 |
| L7 admin | `actions/products.ts:174-223 createProductKind` | Zod displayColor `regex(/^#([0-9a-fA-F]{6}\|[0-9a-fA-F]{3})$/)`；空字符串规范化为 null | P1-24-09 |
| L7 admin | `actions/products.ts:328` | INVALID_PRODUCT_KIND → INVALID_PARAMS（4 项约定前缀） | CC5 |
| L9 admin | `app/(main)/orders/_components/order-create-page.tsx:42-44` | PRODUCT_KIND_CHOICES 改为运行时 await getProductKinds() 派生（`组合套餐` 由 products.is_bundle 单独 Tab，`普通商品` = 非卡类聚合） | P1-24-08 |
| L9 staff | `miniprogram/packageService/product-detail/product-detail.{ts,wxml}` + client `pagesShop/*` | 消费 displayIcon 字段（如有）渲染分类徽章；displayColor 缺失 fallback 退化已 OK | P2-24-11 |

---

## 7. 验证 SQL（5434 EXPLAIN/SELECT 仅，禁止写入）

```sql
-- 1. 是否存在已停用一级行但仍有 is_valid=true 二级子级（P0-24-02 影响半径）
SELECT parent.category_name AS disabled_kind,
       count(*) FILTER (WHERE child.is_valid = true) AS active_children
FROM product_categories parent
LEFT JOIN product_categories child
  ON child.product_kind = parent.category_name
WHERE parent.product_kind IS NULL
  AND parent.is_valid = false
GROUP BY parent.category_name
HAVING count(*) FILTER (WHERE child.is_valid = true) > 0;

-- 2. 是否存在一级行 sales_category 非 NULL（违反语义；P2-24-14）
SELECT category_id, category_name, sales_category
FROM product_categories
WHERE product_kind IS NULL
  AND sales_category IS NOT NULL;

-- 3. 是否存在 displayColor 非 HEX（P1-24-09）
SELECT category_id, category_name, display_color
FROM product_categories
WHERE display_color IS NOT NULL
  AND display_color !~ '^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$';

-- 4. is_card_kind=true 的一级行 vs CARD_PRODUCT_KINDS 常量是否对齐（P1-24-03）
SELECT category_name
FROM product_categories
WHERE product_kind IS NULL
  AND is_card_kind = true
  AND is_valid = true
ORDER BY sort_order;
-- 期望 = ['充值卡', '体验卡']；若不一致则 staff shopInit 排除范围与 spec 不符

-- 5. display_icon 列实际有多少行被填了（P2-24-11，验证 dead column 程度）
SELECT count(*) FILTER (WHERE display_icon IS NOT NULL) AS filled,
       count(*) FILTER (WHERE display_icon IS NULL) AS empty
FROM product_categories;

-- 6. 二级行的 product_kind 文本是否都有匹配的有效一级行（孤儿 child 检查）
SELECT child.category_id, child.category_name, child.product_kind
FROM product_categories child
WHERE child.product_kind IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_categories parent
    WHERE parent.product_kind IS NULL
      AND parent.category_name = child.product_kind
      AND parent.is_valid = true
  );

-- 7. requires_shengmei_flag=true 的一级行下，SKU 是否真的填了 is_shengmei
SELECT pc.category_name AS kind, count(sk.sku_id) AS sku_count,
       count(sk.is_shengmei) AS filled_shengmei
FROM product_categories pc
JOIN product_categories child ON child.product_kind = pc.category_name
JOIN product_skus sk ON sk.category_id = child.category_id
WHERE pc.product_kind IS NULL AND pc.requires_shengmei_flag = true
GROUP BY pc.category_name;
```

---

## 8. 回归测试用例（建议）

1. **新建第 5 个 kind 零代码可见**：admin createProductKind('福利活动', isCardKind=false, displayColor='#3D8A5A') → staff shopInit 应自动收纳到普通商品分组（当前 P1-24-03 失败）
2. **改名"充值卡" → "充值卡片" 业务 SQL 不破裂**：UPDATE product_categories SET category_name='充值卡片' WHERE … → 顾客类型重算应仍判定该 kind 为充值卡语义（当前 P0-24-01 失败）
3. **停用一级行 → 二级行级联停用**：updateProductKind('护理项目', isValid=false) → 期望子级二级分类 isValid 同步置 false；getCategories/cardKinds/shopInit 三端口径一致（P0-24-02）
4. **getCategories LEFT JOIN parent.is_valid=true 守卫**：父级停用后子级 parentDisplayColor 应回 NULL（P1-24-06）
5. **displayColor 必填校验**：createProductKind 不传 displayColor → reject 或自动 fallback（当前 silent null）
6. **displayColor HEX 校验**：传入 `red` / `oklch(...)` → reject INVALID_PARAMS（P1-24-09）
7. **client cart 标签卡类徽章**：admin 配 isCardKind=true 的 kind 下购买 → client 购物车应显示"卡"徽章（当前 P1-24-04 失败 — client 不读 is_card_kind）
8. **dead column 验证**：admin 填 displayIcon='✨' → 三端任何页面应有可见消费（当前 P2-24-11 失败）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（P0-24-01 横跨 schema + admin actions + staff order.js + 测试 lock；P1-24-04 client 完全脱钩）
- 涉及历史数据：☑（migration 0014 仅命中字面量 5 行，新加 is_recharge_card 列需新迁移）
- 修复成本：M（schema + 4 处 staff order.js SQL + admin 表单校验 + client 接口扩展，单端独立可推进）

---

## 10. 后续待办

- [ ] 与 PM 对齐："充值卡 vs 体验卡" 语义升格为 capability 列（is_recharge_card）的可行性，或保留 magic string 接受改名风险
- [ ] 与 admin 用户对齐：停用一级行的 UX（弹层 "将同时停用 N 个二级分类，影响 M 个 SKU 与 K 笔在售订单"）
- [ ] 与 client 端 PM 对齐：是否需要在购物车 / 商品详情展示"卡类徽章"/ "生美标识" — 决定 P1-24-04 的修复范围
- [ ] dead column display_icon 决策：消费 OR 删除（建议先消费，与 displayColor 配套形成"完整分类徽章"）
- [ ] CROSS-CUTTING 命中：
  - CC9 deprecated 常量残留（admin/staff CARD_PRODUCT_KINDS 双副本）
  - CC9 dead column / dead config（display_icon）
  - CC8 Vant `<van-tag color="{{x}}">` 接收非 HEX 字符串的渲染兜底缺失
  - CC5 admin `INVALID_PRODUCT_KIND:` 自定义前缀污染 4 项约定
- [ ] SCHEMA-CHANGES 提议：
  - S24-1：新增 `product_categories.is_recharge_card boolean NOT NULL DEFAULT false`，配套 staff/order.js × 4 处 SQL 重构
  - S24-2：`getCategories` LEFT JOIN parent 加 `is_valid=true` 守卫
  - S24-3：updateProductKind 停用时事务内级联子级
  - S24-4：display_color 加 CHECK regex（HEX 格式）；或在 app 层 Zod 校验
- [ ] ENUM-AUDIT 命中：
  - E24-product-kind-dynamic：text 列非枚举，但前端 admin order-create-page 仍硬编码 4 选 1 → 需要"前端 enum 同步 DB" 规约（与 product_kind / sale_order_type 等所有 text 字段统一处理）
