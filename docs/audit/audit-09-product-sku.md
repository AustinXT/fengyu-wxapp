# 审计报告：商品 + SKU + 价格 + 有效期 (09)

**审计时间**：2026-04-26
**域 ID**：09
**审计员**：claude-sonnet-4-6（合并报告，v1 + v2 综合）
**报告版本**：v3（合并版，取代 v1/v2）
**参考**：v1 `docs/audit/audit-09-product-sku.md`（2026-04-25）；v2 `docs/audit/audit-09-product-sku-v2.md`（2026-04-26 第二轮独立审计）

---

## 元信息

| 项目 | 值 |
|------|---|
| 审计时长 | v1 ~25 分钟；v2 ~40 分钟 |
| 审计范围 | 商品浏览 + 开单定价 + SKU 生命周期 |
| 关联 Ticket | `notes/tickets/2026-04-26-experience-card-as-sku-flag.md`（Round 1，2026-04-26 已落地） |
| 跨端覆盖 | admin（Next.js 15）、staff（微信小程序）、client（微信小程序）、cloudfunctions（2 个云函数）、DB schema |

---

## v1 vs v2 差异摘要

| 问题 | v1 结论 | v2 独立验证 | 差异 |
|------|---------|------------|------|
| P0-09-01（is_enabled 未过滤） | 已发现 | **确认，代码未修复** | 一致 |
| P0-09-02（market_scope 未校验） | 已发现 | **确认，代码未修复** | 一致 |
| P0-09-03（deleteSku 无事务） | 已发现 | **确认，代码未修复** | 一致 |
| P1-09-04（unit_price 三端分裂） | 已发现 | **确认，补充 admin 侧细节** | 一致 + 细化 |
| P1-09-05（productType vs productKind） | 已发现 | **确认** | 一致 |
| P1-09-06（valid_start/valid_end 不存在） | 已发现 | **确认** | 一致 |
| P1-09-07（admin 信任前端价格） | 已发现 | **确认，补充：服务端查 fee/session/recharge 但不查 price** | 一致 + 细化 |
| P1-09-08（bundle_price 无上限） | 已发现 | **确认** | 一致 |
| P2-09-10（promotionList 死路由） | 已发现 | **确认，代码未清理** | 一致 |
| **新增** | — | **P2-09-13：clientApi README / 测试报告.md 引用已废弃表名字段** | v2 新增 |

### 正面进展（Round 1，2026-04-26）

2026-04-26 ticket Round 1 已完整落地，**不在待修复范围内**：

1. **`is_experience` / `is_recharge_card` capability 列三端全部一致**：staff / client `shopInit` 已统一切换至 `NOT (is_recharge_card OR is_experience)` 过滤，`sale_items` schema 已包含这两列快照，staffApi / clientApi 测试覆盖已更新。
2. **卡类展示逻辑**：staff `cardKinds()` action 已 DB 驱动（`getCardKindNamesFromDb`），与 admin/client 对齐。
3. **废弃枚举清理**：`组合套餐` 已从 `product_kind` 运行时值中移除（仅前端 UI label 映射到 `is_bundle=true`）。

---

## 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/product.ts:1-228` | ↑ | ↑ |
| Enum | `db/schema/enums.ts:3` `productTypeEnum`（疗程卡/单品/家居产品）；`product_kind` 为自由 text（DB 驱动，一级行） | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/products.ts:1-1000+`（27 个 server actions） | `staffApi/routes/product.js:1-499`（shopInit/categories/skuList/skuDetail/spuDetail/cardKinds/promotionList/promotionPlans）；`staffApi/routes/mgmt-product.js:1-397`（cardHolders/cycleStats） | `clientApi/routes/product.js:1-456`（categories/spuList/skuDetail/spuDetail/hotList/shopInit/experienceCardList） |
| 前端 | `fengyu-admin/src/app/(main)/products/`（page.tsx + [id] + create + categories + _components）；`(main)/mall/`（[id] + create + _components） | `fengyu-staff/miniprogram/pages/order-create/order-create.ts` | `fengyu-client/miniprogram/pagesShop/`；`pagesExperience/` |
| 测试 | `fengyu-admin/src/actions/products.test.ts` | `staffApi/__tests__/routes/product.test.js`（616 行） | `clientApi/__tests__/routes/product.test.js`（240 行） |

---

## 数据流图

```
=== 商品浏览（三端过滤策略）===

client.categories / spuList / shopInit / hotList
   └─> products (is_enabled+is_visible) + mall_product_skus + product_skus (is_enabled)
       + SKU_VALID_FILTER: NOT (sk.is_experience OR sk.is_recharge_card)   ← Round 1 统一
       + market_scope 过滤（boundMarketName）

staff.shopInit
   └─> product_categories (is_valid)
       + EXISTS 过滤：NOT (is_recharge_card OR is_experience) + NOT bundle
       └─> product_skus (is_enabled=true)

admin.getAllSkus / getSkuById / getSkusByProductId
   └─> product_skus + product_categories（无 is_enabled 过滤，列表全量）

=== 开单价格快照（三端不同语义！）===
staff.order.create
   └─> SELECT product_skus WHERE sku_id = $1
       ── 无 is_enabled 过滤 ── ← P0-09-01 CONFIRMED
       ── 无 market_scope 过滤 ── ← P0-09-02 CONFIRMED
       basePrice = special_price || price
       unitPrice = basePrice（实价写入标价字段）    ← P1-09-04 staff 模式
       unitRealPrice = basePrice

client.order.create
   └─> SELECT product_skus WHERE sku_id = ANY($1)
       ── 无 is_enabled 过滤 ── ← P0-09-01 CONFIRMED
       ── 无 market_scope 过滤 ── ← P0-09-02 CONFIRMED
       unitPrice = price（原价）                   ← P1-09-04 client 模式
       unitRealPrice = special_price || price（实价）

admin.createOrder
   └─> 前端传入 unitPrice / unitRealPrice
       ── 不重算价格 ── ← P1-09-07 CONFIRMED
       unitPrice = item.unitPrice（前端传）
       unitRealPrice = item.unitRealPrice（前端传）

=== sale_items 快照语义分裂（P1-09-04）===
staff:   unit_price = special_price||price（实价）
client:  unit_price = price（原价），unit_real_price = special_price||price
admin:   unit_price = 前端传值（不做服务端重算）
```

---

## P0（阻断 / 资损 / 越权）— 三端均未修复

### [P0-09-01] 三端 order.create 查询 SKU **不带 `is_enabled` 过滤**，已下架 SKU 仍可下单

- **文件（v2 独立验证）**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:253-255`：
    ```sql
    FROM product_skus s JOIN product_categories pc ON s.category_id = pc.category_id
    WHERE s.sku_id = $1
    ```
    无 `AND s.is_enabled = true`
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js:215-222`：
    ```sql
    FROM product_skus sk JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.sku_id = ANY($1)
    ```
    无 `AND sk.is_enabled = true`
  - `fengyu-admin/src/actions/orders.ts:997-1010`：服务端仅查 `serviceFee/sessionCount/isRechargeCard`，`inArray(productSkus.skuId, skuIdList)` 无 `eq(productSkus.isEnabled, true)`，前端传入的 `unitPrice/unitRealPrice` 直接写入

- **现象**：`product.shopInit` / `product.skuList` / `product.spuList` 全部带 `is_enabled=true`；但三端 `order.create` 不复核，已下架 SKU 只要 skuId 已知仍可落单。

- **风险**：
  1. 管理员下架后，仍持有缓存购物车的客户或已知 skuId 的调用方可绕过下架操作，以旧价格下单。
  2. `real.md #2 "价格快照不可变"` 在"下架-调价"操作序列中被绕过：调价触发快照失效后，下架无法阻挡缓存旧单。

- **复现**：
  1. admin 将 sku=`SKU-X` 设 `isEnabled=false`
  2. staff 或 client 缓存了旧 skuId，直接传 skuId=`SKU-X` 给 `order.create`
  3. 系统以旧价格成功下单（SKU 存在，仅 is_enabled=false，查询仍命中）

- **修复**：(L3) staff `order.js:255` 追加 `AND s.is_enabled = true`；client `order.js:222` 追加 `AND sk.is_enabled = true`；admin `orders.ts:997` Drizzle 查询追加 `.where(and(inArray(...), eq(productSkus.isEnabled, true)))`，匹配条数 < skuIdList.length 则抛 `INVALID_PARAMS: SKU ${id} 已下架`。

---

### [P0-09-02] 三端 order.create **不复核 `market_scope`**，跨市场 SKU 可下单

- **文件（v2 独立验证）**：
  - `staffApi/routes/order.js:253-255`：无 `AND (s.market_scope IS NULL OR s.market_scope = $marketName)`
  - `clientApi/routes/order.js:215-222`：无市场范围校验（`ctx.auth.boundMarketName` 已可用但未传入此 SQL）
  - `admin/src/actions/orders.ts:997-1010`：批量查 SKU 时完全无 marketScope 过滤

- **现象**：`shopInit` / `spuList` / `categories` 等展示层全部加 `AND (p.market_scope IS NULL OR p.market_scope = $marketName)` 过滤；但 `order.create` 下单阶段无此复核。

- **风险**：组织域隔离（`real.md #6`）在商品维度失守；跨市场顾客/员工可直接传入竞争市场专享 SKU 的 ID 落单，绕过市场专属定价/套餐策略。

- **复现**：A 市场专享低价 SKU-A，B 市场顾客调 `order.create({ skuId: 'SKU-A', ... })` → 成功以 A 市场价格在 B 市场生效。

- **修复**：(L3) 三端 `order.create` SKU 查询追加 `AND (sk.market_scope IS NULL OR sk.market_scope = $boundMarketName)`。staff 端从 `ctx.auth.currentStoreId` 关联取 marketName；client 端已有 `ctx.auth.boundMarketName`；admin 端从请求的 `storeId` 关联查取。

---

### [P0-09-03] admin `deleteSku` **两步硬删除不在事务内**，中断可留孤儿态

- **文件（v2 独立验证）**：`fengyu-admin/src/actions/products.ts:683-703`：
  ```ts
  // 先删关联（无事务包裹）
  await db.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))
  await db.delete(productSkus).where(eq(productSkus.skuId, skuId))
  ```
  v1 发现后**未修复**——代码完全一致。

- **现象**：第一步删 `mall_product_skus` 成功后，若第二步删 `product_skus` 因连接中断或约束失败，会形成：`mall_product_skus` 已无该 SKU 关联（商城 SPU 显示无 SKU）但 `product_skus` 行仍存在（管理页显示 SKU 存在）的不一致状态。

- **风险**：
  1. 数据完整性破坏，无法通过重试自愈（再次 delete 触发"SKU 被引用"拦截或重复删除）。
  2. 历史 `service_orders / sale_allocations` 通过 skuId 的文本引用失去 SKU 详情，报表无法 JOIN 补全名称。

- **修复**：(L7) 用 `db.transaction(async (tx) => { ... })` 包裹两步；参考 `updateProductKind` 的事务写法（`products.ts:278`）。

---

## P1（数据一致 / 状态错乱）

### [P1-09-04] sale_items.unit_price 三端写入语义分裂（v1 已发现，v2 独立验证确认）

- **文件**：
  - staff `order.js:263-308`：`basePrice = special_price || price`；`unitPrice = basePrice`（除了内部单 ×0.5 / customPrice 分支）；`saleAmount = unitPrice × quantity`
  - client `order.js:242-243`：`unitPrice = Number(sku.price)`（**原价**）；`unitRealPrice = special_price || price`（特价）；`saleAmount = unitRealPrice × quantity`
  - admin `orders.ts:1166`：`unitPrice: item.unitPrice`（直接用前端传入值）

- **现象**：同一 SKU（标价 1000，特价 800）三端写入同一表的 `sale_items.unit_price` 字段值不同：staff=800，client=1000，admin=前端传值。`unit_real_price` 含义在 staff 端语义等同 `unit_price`（相同值），在 client 端语义为实际单价。

- **影响**：BI 报表 `SUM(unit_price * quantity)` 折扣总额计算在混合数据集下不可信；`approveRefund` 按比例拆分储值卡部分时口径漂移。

- **修复建议**：(L0/L3) 统一约定：`unit_price = sku.price`（原价快照，只读不变）；`unit_real_price = special_price || price`（实际单价）；`sale_amount = unit_real_price × quantity`。三端均须重构 `order.create` 中的价格赋值逻辑（staff 端当前 `unitPrice` 赋 basePrice 行为需改为赋 `sku.price`）。

---

### [P1-09-05] productType 枚举 vs product_kind 自由文本语义重叠，无跨层一致性约束

- **文件**：
  - `db/schema/enums.ts:3`：`productTypeEnum`（PG 枚举，3 值）
  - `db/schema/product.ts:33`：`productCategories.productKind`（自由 text，DB 驱动；运行时 4 常见值：护理项目/家居产品/充值卡/体验卡）
  - `staffApi/routes/mgmt-product.js:174`：`si.product_type IN ('疗程卡','单品')` 判断"持卡"

- **现象**：两个维度同时用于过滤商品，但值域有重叠（"家居产品"同时存在于两个维度），且无任何跨层约束（`productKind='护理项目'` 的分类下可创建 `productType='家居产品'` 的 SKU）。

- **影响**：`mgmtProduct.cardHolders` 将 `product_type='单品'` 的家居商品也纳入"持卡"统计，若运营误配 `productType`，报表数据失真。

- **修复建议**：(L0/spec) 在 `product_skus` 上添加 CHECK 约束，限定 `productKind-productType` 合法组合（如 kind=充值卡/体验卡 → type 仅允许 单品；kind=护理项目 → type 仅允许 疗程卡/单品；kind=家居产品 → type=家居产品）。

---

### [P1-09-06] valid_start / valid_end 字段不存在（spec 与现实脱节，v1 已发现，v2 确认未修复）

- **文件**：`db/schema/product.ts:55-111`（productSkus）— 字段列表：skuId / categoryId / productType / specName / price / specialPrice / sessionCount / sortOrder / serviceFee / isShengmei / isExperience / isRechargeCard / marketScope / isEnabled。**无 valid_start / valid_end**。

- **现象**：三端浏览/开单代码均无有效期校验逻辑（因字段不存在）；限时活动只能靠人工切换 `is_enabled`。

- **现状评估**：目前功能上依赖 `is_enabled` 手动管理生命周期，缺乏自动定时上下架能力，是运营效率问题而非当前资损问题。

- **修复建议**：(L0，评估后决策) 若引入：加 migration 添加 `valid_start TIMESTAMPTZ` / `valid_end TIMESTAMPTZ`，三端 `order.create` 需增加 `NOW() BETWEEN valid_start AND valid_end` 校验；或继续用 cron 定时更新 `is_enabled`（已有 STEP 模式参考 `src/cron/run.ts`）。

---

### [P1-09-07] admin createOrder 信任前端传入 unitPrice / unitRealPrice，无服务端重算

- **文件**：`fengyu-admin/src/actions/orders.ts:1166`：`unitPrice: item.unitPrice`（直接取前端传）。

- **说明**：服务端确实查了 `serviceFee / sessionCount / isRechargeCard`（`orders.ts:997-1010`），但**价格**（unitPrice / unitRealPrice）仍完全信任前端传值，仅充值卡走服务端 `matchTier` 校验。

- **影响**：有 `product:update` 权限的管理员可在请求体改写 unitPrice，跳过商品维护页的调价审计，直接以任意价格开单。

- **修复**：(L7) 非充值卡 `createOrder` 服务端重算 unitPrice = `sku.price`，unitRealPrice = `sku.special_price || sku.price`，与前端差值超阈（5%）时至少记告警日志并写 `operation_log`。

---

### [P1-09-08] mall_product_skus.bundle_price 无上限校验（可填超过 sku.price 的"加价套餐"）

- **文件**：`fengyu-admin/src/actions/products.ts:756-778`（updateSkuBundlePrice）— 仅做格式检查，无 `<= productSkus.price` 校验。
- **影响**：bundle_price > special_price 时，client `priceFrom` 取 `Math.min(bundle_price || special || price)` 中 bundle_price 最大，导致"套餐反向更贵"但前端无提示。
- **修复**：(L7) 写入时服务端校验 `bundlePrice <= productSkus.price`；DB 加 CHECK `bundle_price >= 0 AND bundle_price <= (SELECT price FROM product_skus WHERE sku_id = ...)`（或应用层 trigger）。

---

### [P1-09-09] admin 开单 unit_price 语义与 staff/client 不一致（三端价格快照合约缺失）

- **说明**：延伸自 P1-09-04。admin `items` 结构中 `unitPrice` 是前端构造传入，其含义取决于调用者（order-create-page.tsx 按 spec 应传原价，但服务端不验证），与 staff 端的"实价写入 unit_price"字段形成历史遗留。
- **修复建议**：(L0/L3/L7) 统一 DTO 定义（`db/types/price-snapshot.ts`），明确"unit_price=原价快照，unit_real_price=实际单价，sale_amount=unit_real_price×qty"，三端各自实施。

---

## P2（代码质量 / 可维护）

### [P2-09-10] promotionList / promotionPlans 死路由仍注册（v1 已发现，未清理）

- **文件**：`staffApi/routes/product.js:482-490`（函数体仅返回空数组）；`staffApi/index.js:54-55`（仍注册路由）；`staffApi/miniprogram/mock/product.ts:222`（仍有 mock）。
- **现象**：路由持续消耗路由表空间，混淆接口文档，测试覆盖率产生干扰。
- **修复**：(L3) 从 `index.js` 注销两条路由；在 `product.js` 加 `@deprecated` 注释或删除函数；清理 `mock/product.ts`。

---

### [P2-09-11] `VALID_PRODUCT_TYPES` 常量与 PG enum 重复定义

- **文件**：`fengyu-admin/src/actions/products.ts:533`：`const VALID_PRODUCT_TYPES = ['疗程卡', '单品', '家居产品'] as const`。
- **修复**：(L7) 从 Drizzle schema 导入枚举值或与 `productTypeEnum` 保持一致（监测 PG enum 更改时同步）。

---

### [P2-09-12] client product 路由无显式 `requirePhone`（公开浏览合规，P2 仅备案）

- **文件**：`clientApi/routes/product.js:100-104`（`categories`）、`:195-199`（`spuList`）等 — 所有 product 路由均无 `requirePhone` 守卫，仅通过 `auth` 中间件注入 `ctx.auth`（可能含 userId=null 的未注册用户）。
- **现状**：商城公开浏览产品是产品需求，客户端在商品浏览时不要求手机号。`experienceCardList` 同样无 `requirePhone`，体验卡作为拉新工具允许匿名浏览。
- **记录理由**：市场范围过滤（`ctx.auth?.boundMarketName || null`）依赖 `boundMarketName`，未绑定门店用户 `boundMarketName=null`，此时走 `AND p.market_scope IS NULL`（全平台商品），可能误展示其他市场商品（若 `market_scope IS NULL` 代表"总部管理"）。
- **建议**：(P2) 确认 `market_scope IS NULL` 语义等同"全平台可见"时，匿名浏览行为符合预期，无需修复；否则对匿名用户添加"仅显示 market_scope IS NULL 商品"的明确注释。

---

### [P2-09-13] clientApi README.md / 测试报告.md 含已废弃字段文档（v2 新增）

- **文件**：
  - `fengyu-client/cloudfunctions/clientApi/README.md:156-157`：仍引用 `product_spu` / `product_spu_sku_map` 表名（已废弃，现为 `products` / `mall_product_skus`）
  - `fengyu-client/cloudfunctions/clientApi/测试报告.md:57,95`：引用 `big_category`（已废弃字段，现为 `product_kind`）
- **影响**：文档误导新开发者，认为废弃表仍存在；测试报告中 `big_category` 断言逻辑已实际失效（字段不存在），但报告未更新，形成"文档上的幽灵测试"。
- **修复**：(P2) 更新 README.md 与测试报告.md，替换为现行字段名；或标注 `[DEPRECATED]` 注释。

---

## 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| order.create SKU is_enabled 校验 | ✗（inArray，无过滤） | ✗（WHERE sku_id=$1，无过滤） | ✗（WHERE sku_id=ANY，无过滤） | 下架 SKU 三端皆可下单 | **P0** |
| order.create market_scope 校验 | ✗ | ✗ | ✗ | 跨市场 SKU 可购 | **P0** |
| sale_items.unit_price 语义 | 前端传值（实现相关） | special_price ∥ price（实价） | price（原价） | 三端同 SKU 写不同值 | P1 |
| sale_items.unit_real_price 语义 | 前端传值 | unitPrice - discount/qty | special_price ∥ price | 折扣计算口径漂移 | P1 |
| sale_items.sale_amount 计算 | unitRealPrice × qty | unitPrice × qty（折扣后） | unitRealPrice × qty | 报表口径不一致 | P1 |
| 价格服务端重算 | 仅充值卡 matchTier | ✓（从 SKU 取，不信任前端） | ✓（从 SKU 取，不信任前端） | admin 价格可篡改 | P1 |
| shopInit 卡类排除策略 | N/A | capability 列 NOT(is_recharge_card OR is_experience) | SKU_VALID_FILTER 同 | 2026-04-26 已统一 ✓ | OK |
| cardKinds 来源 | getCardKindNamesFromDb（DB 驱动） | product.cardKinds action（DB + CARD_PRODUCT_KINDS 兜底） | 无此概念（product 层用 display_color） | staff 兜底常量仍在 | P2 |
| deleteSku 事务保护 | ✗（两步裸 DELETE） | N/A | N/A | 孤儿态风险 | **P0** |
| client product 鉴权 | requirePermission ✓ | requireStaffBound ✓ | **无 requirePhone**（仅 auth 中间件） | 产品需求允许，P2 备案 | P2 |

---

## 横切检查（CC1-CC9）

- [x] **CC1 数值精度**：price/special_price/bundle_price NUMERIC(10,2) ✓；`db/schema/product.ts:66-67` CHECK `chk_sku_price >= 0`、`chk_sku_service_fee >= 0`；JS 端全部用 `Math.round(x * 100) / 100` 模式而非 Decimal 库；admin 信任前端 unitPrice → 命中 P1-09-07（CC1 后续命中：08 域 P1-08-14）。**CC1 总体 ✓，无新增 P0**。
- [ ] **CC2 并发幂等**：admin `deleteSku` 两步无事务（P0-09-03，再次命中 CC2）。staff/client `order.create` SKU 查询并发读后快照问题不影响最终一致性（价格快照已写入 `sale_items`，后续改价不影响历史订单）。
- [ ] **CC3 组织域隔离**：`order.create` 三端不复核 `market_scope`（P0-09-02，CC3 命中）；`product` 展示层全部正确过滤 ✓。
- [x] **CC4 后端鉴权**：staff 全部 `requireStaffBound` ✓；admin `requirePermission` ✓；client product 路由无 `requirePhone` 但合规（商城公开浏览）✓（P2 备案）。
- [ ] **CC5 错误码**：staff/client 路由使用 `INVALID_PARAMS:` 前缀 ✓；admin `products.ts` 返回 `{ success: false, message: '...' }`（部分无前缀，如 `:328` 的 `'INVALID_PRODUCT_KIND: ...'` 有自定义前缀，非 4 种标准前缀之一）→ P2（CC5 再次命中）。
- [x] **CC6 PII**：product 域不含 PII ✓。
- [x] **CC7 时间字段**：`product_categories / product_skus / products` 均用 Drizzle `defaultNow()` + `$onUpdate(() => new Date())` 自动维护 `created_at / updated_at` ✓。
- [x] **CC8 WXML/Vant**：本域无状态机 UI（商品展示无状态跳转）✓。
- [ ] **CC9 测试与残留**：
  - `promotionList / promotionPlans` 死路由仍在（P2-09-10，v1 未清理）
  - `clientApi/README.md` 引用废弃表 `product_spu / product_spu_sku_map`（P2-09-13）
  - `clientApi/测试报告.md` 引用废弃字段 `big_category`（P2-09-13）
  - 已废弃枚举 `big_category / workfine_source / 组合套餐`（作为 product_kind 枚举值）在运行时代码中 0 引用 ✓（`组合套餐` 仅在 admin UI label 中用作前端导航字符串，映射到 `products.is_bundle=true`，不是 DB 枚举值，符合规范）
  - 已废弃表 `product_spu / product_spu_sku_map / catalog_items / material_products / promotion_schemes` 在生产代码（非文档）中 0 引用 ✓
  - `is_experience / is_recharge_card` capability 列已全面引入（2026-04-26 Round 1 ticket），三端 `shopInit` 均已切换 ✓

---

## 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L3 staff | `staffApi/routes/order.js:255` | SQL WHERE 追加 `AND s.is_enabled = true AND (s.market_scope IS NULL OR s.market_scope = $marketName)` | P0-09-01, P0-09-02 |
| L3 client | `clientApi/routes/order.js:222` | SQL WHERE 追加 `AND sk.is_enabled = true AND (sk.market_scope IS NULL OR sk.market_scope = $marketName)` | P0-09-01, P0-09-02 |
| L7 admin | `fengyu-admin/src/actions/orders.ts:997-1010` | Drizzle 查询追加 `eq(productSkus.isEnabled, true)` + marketScope 过滤 | P0-09-01, P0-09-02 |
| L7 admin | `fengyu-admin/src/actions/products.ts:683-703` | `deleteSku` 用 `db.transaction` 包裹两步删除 | P0-09-03 |
| L0 DB helper | `db/helpers/price-snapshot.ts`（新建） | 抽统一 `snapshotItemPrice(sku, opts)` → `{ unitPrice, unitRealPrice, saleAmount, received }`，三端共用 | P1-09-04, P1-09-09 |
| L3 staff | `staffApi/routes/order.js:263-308` | `unitPrice = sku.price`（原价），`unitRealPrice = special_price || price`（实价），与 client 对齐 | P1-09-04 |
| L7 admin | `fengyu-admin/src/actions/orders.ts:1166` | 非充值卡路径服务端重算 unitPrice = `sku.price`，unitRealPrice = `sku.special_price || sku.price` | P1-09-07 |
| L7 admin | `fengyu-admin/src/actions/products.ts:756-778` | `updateSkuBundlePrice` 追加上限校验 `bundlePrice <= productSkus.price` | P1-09-08 |
| L3 staff | `staffApi/routes/product.js:482-490` + `index.js:54-55` | 删除 promotionList / promotionPlans 注册及函数体 | P2-09-10 |
| L7 admin | `fengyu-admin/src/actions/products.ts:533` | `VALID_PRODUCT_TYPES` 改从 Drizzle enum 导入 | P2-09-11 |
| 文档 | `clientApi/README.md:156-157` | 替换 `product_spu` → `products`，`product_spu_sku_map` → `mall_product_skus` | P2-09-13 |
| 文档 | `clientApi/测试报告.md:57,95` | 替换 `big_category` → `product_kind` | P2-09-13 |

---

## 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. 已下架 SKU 是否在近 30 天有销售（P0-09-01 影响半径量化）
SELECT sk.sku_id, sk.spec_name, sk.is_enabled, sk.market_scope,
       COUNT(si.sale_item_id) AS sold_count
FROM product_skus sk
JOIN sale_items si ON si.sku_id = sk.sku_id
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE sk.is_enabled = false
  AND so.created_at > NOW() - INTERVAL '30 days'
  AND so.status IN ('已支付','已完成','部分支付','待确认收款')
GROUP BY sk.sku_id, sk.spec_name, sk.is_enabled, sk.market_scope
ORDER BY sold_count DESC;

-- 2. market_scope 不匹配的订单行（P0-09-02 影响半径）
SELECT so.sale_order_id, so.store_id, sk.market_scope AS sku_market,
       sk.sku_id, sk.spec_name,
       o.name AS store_market
FROM sale_items si
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN stores st ON st.store_id = so.store_id
JOIN org_nodes sn ON sn.id = st.org_node_id
JOIN org_nodes o ON o.id = sn.parent_id AND o.type = '市场'
WHERE sk.market_scope IS NOT NULL
  AND sk.market_scope <> o.name
ORDER BY so.created_at DESC
LIMIT 50;

-- 3. unit_price 语义分裂量化（P1-09-04）
SELECT
  CASE
    WHEN sk.price IS NULL THEN 'no_sku'
    WHEN ABS(si.unit_price::numeric - sk.price::numeric) < 0.01 THEN 'price_match(client)'
    WHEN sk.special_price IS NOT NULL AND ABS(si.unit_price::numeric - sk.special_price::numeric) < 0.01 THEN 'special_match(staff)'
    ELSE 'mismatch'
  END AS price_class,
  COUNT(*)
FROM sale_items si
LEFT JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
WHERE so.created_at > NOW() - INTERVAL '60 days'
  AND so.sale_order_type = '销售单'
  AND si.is_recharge_card = false
GROUP BY 1;

-- 4. 孤儿 mall_product_skus（P0-09-03 历史 / 潜在孤儿）
SELECT mps.id, mps.product_id, mps.sku_id
FROM mall_product_skus mps
LEFT JOIN product_skus sk ON sk.sku_id = mps.sku_id
WHERE sk.sku_id IS NULL;

-- 5. bundle_price > sku.price 的反向加价行（P1-09-08）
SELECT mps.product_id, mps.sku_id, sk.price AS sku_price, mps.bundle_price
FROM mall_product_skus mps
JOIN product_skus sk ON sk.sku_id = mps.sku_id
WHERE mps.bundle_price IS NOT NULL
  AND mps.bundle_price::numeric > sk.price::numeric;

-- 6. productType vs productKind 矛盾组合（P1-09-05）
SELECT pc.product_kind, si.product_type, COUNT(*)
FROM sale_items si
JOIN product_skus sk ON sk.sku_id = si.sku_id
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE pc.product_kind IS NOT NULL
GROUP BY pc.product_kind, si.product_type
ORDER BY pc.product_kind, si.product_type;
```

---

## 回归测试用例（建议）

1. **下架 SKU 不可开单（三端）**：admin 设 `is_enabled=false` → staff/client/admin `order.create` 传旧 skuId → 期望 `INVALID_PARAMS: SKU ... 已下架`
2. **跨市场 SKU 不可购（三端）**：A 市场专享 SKU → B 市场 client/staff `order.create` → 期望 `INVALID_PARAMS: SKU 不在当前市场可售`
3. **deleteSku 事务原子性**：mock 第二步 `productSkus.delete` 抛错 → 期望 `mall_product_skus` 行被回滚（不产生孤儿）
4. **unit_price 三端语义一致**：同一 SKU（price=1000, special=800）三端开单 → 期望 `unit_price=1000, unit_real_price=800, sale_amount=800`（统一后）
5. **bundle_price 上限校验**：设 `bundle_price=10001` 给 `sku.price=1000` → 期望 `INVALID_PARAMS: 套餐价不能超过 SKU 原价`
6. **promotionList/promotionPlans 路由清理后不可调用**：调用已删除路由 → 期望 `INVALID_PARAMS: 未知 action`
7. **卡类排除（Round 1 回归）**：staff/client `shopInit` 不返回 `is_experience=true` 或 `is_recharge_card=true` 的 SKU

---

## 影响半径

- **单端**：☐
- **跨端（任意 2 端）**：☐
- **全栈（3 端 + DB）**：☑（P0-09-01/02/03 三端统一修复；P1-09-04 三端价格语义对齐）
- **涉及历史数据**：☑（P1-09-04 历史 `sale_items.unit_price` 分裂数据已存在，需量化后评估是否回填；SQL-3 可辅助）
- **修复成本**：M（P0 三项 L3/L7 修改 + P1-09-04 三端价格语义对齐为主要工作量）

---

## 后续待办

- [ ] **P0 优先**：三端 `order.create` 加 `is_enabled` + `market_scope` 双过滤（与 audit-02 order-creation 修复合并 epic）
- [ ] **P0 优先**：admin `deleteSku` 加事务（独立单点修复，改动小）
- [ ] **P1 对齐**：与产品/财务对齐 `unit_price` 语义（原价快照 vs 实价）后，统一三端 `order.create` 写入逻辑；回填历史脏数据
- [ ] **P1 评估**：`valid_start / valid_end` 引入决策（PM 确认后立 SCHEMA-CHANGES ticket）
- [ ] **P2 清理**：删除 promotionList / promotionPlans 死路由（低风险，可单独 PR）
- [ ] **P2 文档**：更新 clientApi README.md + 测试报告.md 中废弃字段引用
- [ ] **CROSS-CUTTING 命中**：CC2（deleteSku 非事务）、CC3（order.create 不复核 market_scope）— 已在对应 CROSS-CUTTING.md 域记录
- [ ] **与 audit-02-v2 关联**：P0-09-01/02 需与 audit-02-order-creation 的 SKU 校验修复合并，避免重复补丁

---

## 附：v1 vs v2 问题清单对照

| ID | 问题 | v1 | v2 | 最终状态 |
|----|------|----|----|---------|
| P0-09-01 | order.create 无 is_enabled 过滤 | 发现 | 确认未修复 | 维持 P0 |
| P0-09-02 | order.create 无 market_scope 校验 | 发现 | 确认未修复 | 维持 P0 |
| P0-09-03 | deleteSku 两步无事务 | 发现 | 确认未修复 | 维持 P0 |
| P1-09-04 | unit_price 三端分裂 | 发现 | 确认 + 补充 | 维持 P1 |
| P1-09-05 | productType vs productKind 重叠 | 发现 | 确认 | 维持 P1 |
| P1-09-06 | valid_start/valid_end 不存在 | 发现 | 确认 | 维持 P1 |
| P1-09-07 | admin 信任前端价格 | 发现 | 确认 + 细化 | 维持 P1 |
| P1-09-08 | bundle_price 无上限 | 发现 | 确认 | 维持 P1 |
| P1-09-09 | SKU DTO 碎片（v1 独立问题） | 独立问题 | 整合到 P1-09-04 附述 | 降为建议项 |
| P1-09-10 | productKind 硬编码（v1） | 独立问题 | 整合到 P1-09-05 附述 | 降为建议项 |
| P1-09-11 | sale_amount CHECK 缺失（v1） | 独立问题 | 整合到 P1-09-04 附述 | 降为建议项 |
| P2-09-10 | promotionList 死路由 | 发现 | 确认未清理 | 维持 P2 |
| P2-09-11 | VALID_PRODUCT_TYPES 重复（v1=P2-09-13） | 发现 | 确认 | 维持 P2 |
| P2-09-12 | client product 无 requirePhone | 发现 | 确认 | 维持 P2 |
| P2-09-13 | README 废弃表名字段（v2 新增） | — | 新增 | 新增 P2 |