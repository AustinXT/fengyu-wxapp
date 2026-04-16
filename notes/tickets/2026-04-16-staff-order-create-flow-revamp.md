# Ticket: Staff 开单流程改版（对齐 admin — 商品类型驱动 + 转换单前端入口 + 差额转储值卡）

> 生成日期：2026-04-16
> 严重级别：P1（业务流程改版，影响店长日常开单与转换单核销，需要与 admin 保持语义一致）
> 归属页面：`fengyu-staff/miniprogram/pages/order-create/`（开单 Tab）+ 新增转换单入口
> 关联云函数：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（`create` / `createConversion`）、`routes/customer.js` 或新增 `routes/card.js`
> 对标 ticket：[2026-04-16-admin-order-create-flow-revamp.md](2026-04-16-admin-order-create-flow-revamp.md)（admin 侧已完成 PR-A/B/C 三段式改版 → commit 579e05e/d2b7761）
> 拆分方式：单 feature 分支，3 个 PR 串行 merge（A → B → C），每个 PR 对应 admin 同名 PR 的 staff 版平移

---

## 0 一句话背景

admin 端已于 2026-04-16 完成开单流程改版（Step 1 选商品类型 / Step 3 选订单类型 / 内部单自动半价 / 转换单支持差额转储值卡）。**staff 端作为同一业务的另一入口，必须与 admin 保持语义一致**，否则同一家门店从两端开出来的单会出现"admin 开的转换单把负差额入了储值卡、staff 开的转换单把负差额直接吞成了负 total_amount"的账务撕裂。

staff 当前开单 UI（`pages/order-create/order-create.ts:10-142`）把"正常单 / 体验单 / 内部单 / 组合套餐"作为**开单模式**放在 Step 1，已做了内部单半价（`routes/order.js:254-257`），但：

1. Step 1 的"开单模式"混合了**商品类型**（组合套餐/体验卡）与**订单类型**（内部单）两个维度，与 admin 改版后的语义分离背道而驰
2. **完全没有转换单入口**（前端全局 grep `createConversion` 零命中；云函数已有实现但无人调用）
3. 云函数 `createConversion`（`routes/order.js:1257-1427`）缺失"负差额转储值卡"段 — 现在 `priceDiff < 0` 会把负数直接写入 `sale_orders.total_amount`，不会触碰 `prepaid_cards`
4. 云函数 `createConversion` 入参签名与 admin 版发散（staff 用 `refSaleOrderId + convertOutItems[{saleItemId,convertQuantity}]`，admin 用 `clientUserId + convertOutSaleItemIds[]` 整张卡不带 qty），跨端联调时会出现"同一顾客的同一张卡在两端看到的折抵单位不同"
5. 组合套餐（`productType='组合套餐'`）走的是从商品详情页 `pendingCartItem` 回跳 + "清空购物车独占一单"的约束（`order-create.ts:168-216`），没有 admin 的 BundlePicker "N 选 M" UI

本 ticket 盘点现状—目标差异，按"云函数 → 选品 UI → 结算 UI"三层平移，最后给出验收清单。

---

## 1 现状 vs 目标对比

### 1.1 步骤映射

| 步骤 | staff 现状（`order-create.wxml:154-335`） | 目标（对齐 admin） |
|---|---|---|
| 主页面 | 三级导航（顶部大类 Tab × 5 / 左侧分类侧边栏 / 右侧 SKU 平铺）+ 内联购物车 → 结算按钮弹起 `van-popup` | 保留三级导航框架，但**顶部大类改为"商品类型 4 选 1"**（组合套餐 / 普通商品 / 体验卡 / 充值卡）；组合套餐切换到独立 BundlePicker 子视图 |
| Step 0 选顾客 | 手机号搜索 + 最近顾客快捷选择 | 同左（无变化）+ 转换单场景下必须落到 `client_user_id`（不允许仅手机号兜底） |
| Step 1 选开单模式 | 4 值：正常单 / 体验单 / 内部单 / 组合套餐（后 3 项 managerOnly） | **废除此 Step 的"开单模式"语义**；由 Step 0 下方的主页面"商品类型"决定选品视图，此 Step 位置留给结算（见下行） |
| Step 2 确认订单（staff 旧称） → Step 3（对齐 admin） | 商品清单 + 行优惠 + 优惠券 + 美容师 + 备注 + 合计 | 同左 + **新增"订单类型 3 选 1"**（销售单 / 内部单 / 转换单，managerOnly）+ 内部单半价展示 + 转换单切到 `<ConversionPanel>` 子视图 |
| Step 4 成功 | 订单创建后跳 `/packageOrder/order-qrcode/order-qrcode` 或确认线下收款 Toast | 同左 + 转换单成功文案差异（"差额 ¥X 已充入储值卡" / "请确认补差额收款"） |

### 1.2 商品类型与数据源（对齐 admin §1.2）

`product_kind` 枚举 4 值（`db/schema/enums.ts:3`）在 staff 云函数 `product.shopInit` 返回中已 passthrough，前端只是没有按此维度做 UI 隔离。

| Step 1 选择 | 顶部大类 Tab 显示 | SKU 列表数据源 | 备注 |
|---|---|---|---|
| 组合套餐 | "套餐" | `product.shopInit` 返回中 `productKind='护理项目' AND is_bundle=true` 的 SPU（需云函数新增 `is_bundle` 字段 passthrough）；点击进入 BundlePicker 子视图做"N 选 M" | 旧"组合套餐"大类概念（`BIG_CATEGORIES[0]`）映射到此，不再与其他大类平铺 |
| 普通商品 | "护理"/"家居" 二级 Tab | `productKind IN ('护理项目','家居产品') AND is_bundle != true` 的 SKU | **排除** 体验卡 / 充值卡 / 组合套餐 |
| 体验卡 | "体验" | `productKind='体验卡'` 的 SKU | 品项数量少，可平铺为 grid |
| 充值卡 | "充值卡" | `productKind='充值卡'` 的 SKU | 面值型 SKU，平铺为金额按钮组 |

> **staff 云函数改动**：`routes/product.js` 的 `shopInit` 需在 SKU 列表返回中添加 `isBundle` 字段（读 `products.is_bundle`，目前 `product_skus` 查询只 JOIN `product_categories`，需要再 JOIN `products`）。详见 §3 PR-A 的 A1。

### 1.3 订单类型（Step 3 暴露 3 值）

与 admin 对齐：UI 暴露 3 个（销售单 / 内部单 / 转换单），业务落库仍用 `sale_order_type` 枚举 5 值。staff 云函数 `create` 当前接受 `orderType: 'normal'|'experience'|'internal'|'promotion'` 并映射到 `销售单 / 内部单`，**本次重构直接用 DB 原生枚举值作为入参**（入参字段名改为 `saleOrderType: '销售单'|'内部单'|'转换单'`），不再维护旧映射。

| 订单类型 | 应付金额规则 | 实付/抵扣规则 | 落库结构 |
|---|---|---|---|
| 销售单 | `sum(sku.price × qty)`（套餐走 bundle 价） | `received = saleAmount - couponDiscount - itemDiscount`；走 `create` | `sale_orders.sale_order_type='销售单'` + N 行 `sale_items.item_direction='购买'` |
| 内部单 | **半价 = `sum × 0.5`**（云函数统一应用，前端禁用手工改价 + 隐藏优惠券） | `received = saleAmount`（不叠加优惠）；走 `create` | 同销售单，仅类型与金额减半 |
| 转换单 | `sum(sku.price × qty)` 全价计入转入 | 转出折抵额 = `sum(选中卡剩余次数 × unit_real_price)`；差额 `>0` 补现、`=0` 直接已支付、`<0` 充入顾客储值卡 | 走 `createConversion`，落库形态见 §2.3 |

> **旧 orderType 映射移除**：`experience` 的语义（体验卡 + 自定义价格）拆到 "Step 1 选体验卡商品类型 + Step 3 订单类型=销售单"；`customPrice` 作为行级改价能力保留（仅销售单可用，在 Step 3 行级 "优惠金额" 框生效）。`promotion` 的语义（组合套餐）拆到 "Step 1 选组合套餐商品类型 + Step 3 订单类型=销售单"。

---

## 2 设计决策

### 2.1 主页面顶部大类改为"商品类型 4 选 1"

**为什么不沿用现有"BIG_CATEGORIES[5]"**（`order-create.ts:8`）：

- 当前 5 值（组合套餐 / 护理项目 / 家居产品 / 充值卡 / 体验卡）是把 `product_kind` 枚举 4 值和 "组合套餐" 虚拟第 5 类平铺 — 语义上 "组合套餐" 与其他 4 个是正交维度（`is_bundle=true` 只是 `护理项目` 的一种特殊形态）
- 组合套餐需要 BundlePicker 的特殊 UI（N 选 M 分组），充值卡需要金额按钮组 UI，硬塞在同一个三级导航里 UI 体验分裂
- 普通商品视图应屏蔽掉卡类型，避免店长在"开一个普通护理"时刷到一堆充值卡面值 SKU

**实现层面**：`order-create.ts` 新增 `productKindChoice: '组合套餐' | '普通商品' | '体验卡' | '充值卡'` state（默认 `'普通商品'`），替换当前 `activeBigCategoryIndex`。顶部大类 Tab 渲染 4 个（`van-tabs` 4 tab）。

- "组合套餐" 激活时，主区域切到独立 BundlePicker 子视图（见 §2.2）
- 其他 3 个激活时，左侧 `van-sidebar` 按该 productKind 过滤 `_allCategories` 后渲染二级分类，右侧 SKU 列表按 `skuList.filter(s => s.productKind === productKindChoice)` 过滤
- 切换 `productKindChoice` 时 **清空购物车**（避免跨类型串购），弹确认 dialog 若购物车非空

> **组合套餐独占约束保留**：现有 `order-create.ts:169-189` 的"组合套餐清空购物车独占"逻辑不移除；BundlePicker 内选完 SKU 后统一 `updateCart(cart)` 覆盖式写入。

### 2.2 BundlePicker 子视图（新增）

当 `productKindChoice === '组合套餐'` 时，主区域改为：

- 左侧：`products WHERE is_bundle=true` 列表（每个套餐一张卡片，显示 cover_image / 名称 / 特价 / 原价）
- 右侧：选中套餐后展开 `mall_bundle_groups`（N 选 M 分组）+ 每组内 `mall_product_skus` 关联的 SKU 可勾选；底部 "加入购物车" 按钮一次性把选中的 SKU 集合打包成一个 bundleKey 写入 cart

**落库形态**：cart 中同一 bundleKey 的多行 `sale_items` 共享一个 `ref_bundle_id`（非 schema 字段，是前端临时标记；云函数 `create` 收到后按 `ref_bundle_id` 分组，若一组 SKU 总价 ≠ 套餐定价则按 **套餐价反比例分摊** 到各行的 `unit_real_price`）。

> **范围约束**：本 ticket 仅实现"N 选 M 基础形态"（即允许 `pickCount=null` 全选 + `pickCount=N` 精确选 N 个），不实现"任选 N 至 M 个"的区间选择；admin 侧 C1 同样留此 TODO。

### 2.3 内部单半价

staff 云函数 `create` 在 `routes/order.js:254-257` 已对 `内部单` 执行 `basePrice × 0.5`，**云函数行为与 admin 一致，无需改**。前端改动：

| 决策点 | 选定方案 |
|---|---|
| UI 位置 | Step 3 订单类型 3 选 1（`van-radio-group` 或 3 张卡片）；切到"内部单"后合计区域加"内部单 5 折"红底标签 + 显示划线原价 + 半价总计 |
| 价格覆盖 | 内部单**禁用手工改价**：Step 3 每行"优惠（¥0）"输入框灰掉 + readonly；如需特殊价格请走销售单 |
| 优惠券 | 内部单**不允许叠加优惠券**：隐藏"顾客优惠券"选择区（`order-create.wxml:293-304`） |
| 云函数守卫 | `create` 在入口补：`if (saleOrderType==='内部单' && couponId) throw new Error('INVALID_PARAMS: 内部单不允许叠加优惠券')`；现有云函数没有这条守卫，当前前端没传过来但重构后需补上 |
| `sale_items.unit_price` 快照 | 保持原价（`product_skus.price` / `special_price` 择一）；半价仅作用于 `unit_real_price / sale_amount / received` 三列，与 admin 一致 |

### 2.4 转换单（核心）

**业务流程**（对齐 admin §2.3）：

1. Step 0 选定顾客 → 已知 `clientUserId + storeId`（`ctx.auth.storeId`）
2. Step 1 选商品类型 → Step 2 加购转入项（走常规选品）
3. Step 3 切"订单类型=转换单"时：
   - 调用新 action **`order.customerHeldCards({ clientUserId, storeId })`** 拉取顾客在当前门店的可折抵卡
   - 右侧弹出 `<ConversionPanel>`（小程序用 `van-popup` 二级弹层或独立子视图）列出候选卡（每张 checkbox + 折抵金额预览）
4. 顾客可勾选**整张卡**（不允许选部分次数 / 部分数量；与 admin 一致）
5. 底部差额实时计算：
   - **应付 > 折抵** → "还需支付 ¥X"，选择支付方式（微信 / 线下）
   - **应付 = 折抵** → "无需补差额"，直接已支付
   - **应付 < 折抵** → "将充入储值卡 ¥X"（差额转顾客在当前门店的 prepaid_cards 余额）
6. 提交走新 action `order.createConversion`（保持同名，重构签名，见下）

**云函数改动（关键）**：`routes/order.js:1257-1427` 的 `createConversion` 需要 **重构 + 补段**：

| 改动点 | 现状 | 目标 |
|---|---|---|
| 入参签名 | `{ refSaleOrderId, convertOutItems[{saleItemId, convertQuantity}], convertInItems }` | `{ clientUserId, convertOutSaleItemIds: string[], convertInItems, paymentMethod, preferredStaffWfId?, remark? }`；移除 `refSaleOrderId`（不再绑定单一原订单），整张卡折抵不带 qty（与 admin 平齐）|
| 折抵候选范围 | 仅该 `refSaleOrderId` 下的 `sale_items` | 按 `client_user_id + store_id` 跨订单聚合候选卡（`sale_items WHERE client_user_id=$1 AND store_id=$2 AND item_direction='购买' AND ((product_type='疗程卡' AND remaining_sessions>0) OR (product_type='单品' AND product_categories.product_kind='体验卡' AND quantity - COALESCE(picked_up_quantity,0) > 0))`）|
| 折抵额计算 | `unit_real_price × req.quantity` | `unit_real_price × (product_type='疗程卡' ? remaining_sessions : quantity - picked_up_quantity)`（整张卡全折抵）|
| `priceDiff < 0` 处理 | 直接把负数写入 `sale_orders.total_amount` | **UPSERT `prepaid_cards` + INSERT `card_transactions(type='充值', amount=|priceDiff|, ref_order_id=新订单)`**；订单 `total_amount = 0`，状态 `'已支付'` |
| `priceDiff > 0` 处理 | 订单 `total_amount=priceDiff` 状态 `'已支付'`（硬编码，无支付方式字段处理） | 订单 `total_amount=priceDiff`，根据 `paymentMethod` 决定状态：`微信 → '待支付'`，`线下 → '待确认收款'` |
| 跨店守卫 | 无（靠 `origOrder.store_id = ctx.auth.storeId` 间接校验） | 显式 `WHERE store_id = $1` 过滤 + 校验每个 `convertOutSaleItemIds[i]` 都属于当前门店，否则拒绝 |
| 幂等 | `UPDATE remaining_sessions` 用 `remaining_sessions >= $1` 条件 | 同左 + 对单品/体验卡派生行补 `UPDATE picked_up_quantity = quantity WHERE quantity - COALESCE(picked_up_quantity,0) >= $1` |
| `convertOutItems` 旧字段兼容 | — | **不做兼容**，旧字段直接废弃（项目无历史兼容包袱，参见 `memory/feedback_no_legacy_compat.md`）|

### 2.5 新增 action：`order.customerHeldCards`

```javascript
// routes/order.js 新增（或放 customer.js）
/**
 * 查询顾客在当前门店可折抵的卡（转换单备选）
 * payload: { clientUserId: string }
 * 返回: { cards: [{ saleItemId, productName, skuSpecName, productType, remainingSessions, remainingQuantity, unitRealPrice, deductibleAmount, sourceSaleOrderId }] }
 */
async function customerHeldCards(ctx) {
  await requireManager()(ctx, async () => {})
  const { clientUserId } = ctx.event.payload || {}
  const storeId = ctx.auth.storeId
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')
  const rows = await pg.query(
    `SELECT si.sale_item_id, si.sale_order_id AS source_sale_order_id,
            si.product_name, si.sku_spec_name, si.product_type,
            si.remaining_sessions, (si.quantity - COALESCE(si.picked_up_quantity,0)) AS remaining_quantity,
            si.unit_real_price,
            CASE
              WHEN si.product_type='疗程卡' THEN si.unit_real_price * COALESCE(si.remaining_sessions,0)
              WHEN si.product_type='单品' AND pc.product_kind='体验卡' THEN si.unit_real_price * (si.quantity - COALESCE(si.picked_up_quantity,0))
              ELSE 0
            END AS deductible_amount
     FROM sale_items si
     JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
     JOIN product_skus ps ON si.sku_id = ps.sku_id
     JOIN product_categories pc ON ps.category_id = pc.category_id
     WHERE so.client_user_id = $1 AND si.store_id = $2 AND si.item_direction = '购买'
       AND so.status IN ('已支付','已完成')
       AND ((si.product_type='疗程卡' AND COALESCE(si.remaining_sessions,0) > 0)
            OR (si.product_type='单品' AND pc.product_kind='体验卡' AND (si.quantity - COALESCE(si.picked_up_quantity,0)) > 0))
     ORDER BY si.sale_order_id DESC`,
    [clientUserId, storeId]
  )
  ctx.result = { cards: rows }
}
```

注册到 `routes/order.js` 的 exports 中，并在 `staffApi/index.js` 路由表追加 `'order.customerHeldCards': ...`。

### 2.6 数据库改动

**结论：本 ticket 不动 schema**（与 admin ticket §2.4 一致）。

- `product_kind` / `sale_order_type` / `item_direction` 枚举齐全
- `prepaid_cards` / `card_transactions` 表已存在且被 admin 改版后的 `createConversionOrder` 使用
- `products.is_bundle` / `mall_bundle_groups` / `mall_product_skus` 齐全

零迁移负担，改动全部在云函数 + 前端。

---

## 3 实施计划（按 PR 拆分）

### PR-A：云函数对齐（数据层基座，先行 merge）

**目标**：把 staff 云函数 `create` / `createConversion` 与 admin 语义对齐，新增 `customerHeldCards`。

| # | 任务 | 文件 |
|---|------|------|
| A1 | `product.shopInit` 返回 SKU 列表时补 `isBundle` 字段：JOIN `products ON product_skus.product_id = products.product_id` 读 `is_bundle`；同时在返回的 spu 聚合中补 `mallBundleGroups[]`（若是 bundle）供前端 BundlePicker 使用 | `cloudfunctions/staffApi/routes/product.js` |
| A2 | 新增 action `order.customerHeldCards`（见 §2.5 SQL） | `cloudfunctions/staffApi/routes/order.js` + `index.js` 路由注册 |
| A3 | `order.create` 入参统一：废弃 `orderType: 'normal'|'experience'|'internal'|'promotion'` 映射，改为直接接受 `saleOrderType: '销售单'|'内部单'`；`customPrice` 保留为 item 级字段（仅 `saleOrderType='销售单'` 时生效）；补"内部单不允许 couponId"守卫；前端同步改（PR-C） | `routes/order.js:150-200` |
| A4 | `order.createConversion` 重构（§2.4）：入参改为 `{ clientUserId, convertOutSaleItemIds[], convertInItems, paymentMethod, preferredStaffWfId?, remark? }`；跨订单聚合候选卡；补"差额转储值卡"事务段（UPSERT prepaid_cards + INSERT card_transactions）；补跨店守卫 | `routes/order.js:1249-1427` |
| A5 | 云函数单测/集测（若存在测试框架）覆盖：`create` 内部单半价 / `createConversion` 差额=0/正/负 3 路径 / 跨店拒绝 / 已耗尽卡拒绝 | 项目当前 staff 云函数无 Jest 测试基建，A5 降级为"人工 Postman 联调 + 日志 trace" |
| A6 | 操作日志：`createConversion` 新增 `operation_logs` 写入（若该表在 staff 云函数侧可用；若无则记 console.log 供审计） | 查 `utils/*` 是否已有 log 工具 |

**A4 关键事务伪代码**（平移 admin 实现）：

```javascript
await pg.transaction(async (client) => {
  // 1. 锁候选卡 FOR UPDATE
  const heldCards = await client.query(
    `SELECT ... FROM sale_items si JOIN sale_orders so ON ... JOIN product_skus ps ... JOIN product_categories pc ...
     WHERE si.sale_item_id = ANY($1) AND si.store_id = $2 AND si.item_direction = '购买'
       AND ((si.product_type='疗程卡' AND COALESCE(si.remaining_sessions,0) > 0)
            OR (si.product_type='单品' AND pc.product_kind='体验卡' AND (si.quantity - COALESCE(si.picked_up_quantity,0)) > 0))
     FOR UPDATE OF si`,
    [convertOutSaleItemIds, storeId]
  )
  if (heldCards.rows.length !== convertOutSaleItemIds.length) {
    throw new Error('INVALID_PARAMS: 部分卡不属于当前门店或已耗尽')
  }
  // 2. 计算 totalOut / totalIn / priceDiff
  // 3. 生成订单号（FY-ABZH-WX-YYMMDDxxxx 保留，或改为 FY-ZHD-WX- 与 admin 对齐，需要和 admin 侧约定）
  // 4. INSERT sale_orders（total_amount = max(0, priceDiff)）
  // 5. INSERT 转出行 × N + UPDATE 原行（疗程卡扣 remaining_sessions；单品扣 picked_up_quantity）
  // 6. INSERT 转入行 × M
  // 7. if (priceDiff < 0) {
  //      INSERT INTO prepaid_cards (user_id, store_id, balance) VALUES ($1, $2, $3)
  //        ON CONFLICT (user_id, store_id) DO UPDATE SET balance = prepaid_cards.balance + EXCLUDED.balance
  //      INSERT INTO card_transactions(type='充值', amount=|priceDiff|, ref_order_id=新订单)
  //    }
  // 8. status = priceDiff > 0 ? (paymentMethod='微信' ? '待支付' : '待确认收款') : '已支付'
})
```

> **订单号前缀一致性**：现有 staff `createConversion` 用 `FY-ABZH-WX-`（转换单 A+B→Z 缩写）；admin 改版后用什么前缀需要核实，必要时两端统一为 `FY-ZHD-WX-`（转换单）。A4 实施前先 grep admin 确认。

### PR-B：主页面重构（商品类型 4 选 1 + BundlePicker）

| # | 任务 | 文件 |
|---|------|------|
| B1 | 顶部大类 Tab 从 `BIG_CATEGORIES[5]` 改为 `PRODUCT_KIND_CHOICES = ['组合套餐','普通商品','体验卡','充值卡']` 4 值；新增 state `productKindChoice`，删除 `activeBigCategoryIndex` | `pages/order-create/order-create.ts:8, 105-107` + `order-create.wxml:4-26` |
| B2 | SKU 过滤逻辑：切换 `productKindChoice` 时，`_allCategories` 按 productKind 过滤后写入 `categories`；`spuList` 按 productKind + `isBundle` 规则过滤；`_spuCache` key 改为 `${productKindChoice}:${categoryId}` | `order-create.ts:220-280`（loadShopInit 与 loadSpuList 改造） |
| B3 | 新增 `<bundle-picker>` 自定义组件（`components/bundle-picker/`）：props 为 `products[]`（bundles） + `onSelect(cartItems)`；内部实现"选中套餐 → 展开 N 选 M → 组装 cart items"；`productKindChoice==='组合套餐'` 时主区域渲染该组件，隐藏左侧侧边栏 | 新增 `components/bundle-picker/` |
| B4 | 切换 `productKindChoice` 时若购物车非空 → `wx.showModal` 确认清空；切充值卡 / 体验卡时右侧 SKU 列表 UI 简化为 grid（非平铺卡片） | `order-create.ts` onBigCategoryChange 改造 |
| B5 | 移除 Step 1 "选开单模式"整块 UI（`order-create.wxml:200-251`）；Step 0 下一步直接跳 Step 2（确认订单），旧 `checkoutStep=1` 语义废弃，`checkoutStep` 仍保留 0/1/2 三值但 1 改为空占位（后续 PR-C 填入订单类型） | `order-create.wxml:200-251`, `order-create.ts:472`（onStep0Next 逻辑调整） |
| B6 | 人工验收：登录 → 选顾客 → 切 4 种商品类型 → 分别加购到购物车 → 进入确认页看到正确商品；BundlePicker 选中 1 个套餐组 → cart 出现 N 行 ref_bundle_id 相同的 items | 无自动化 E2E（staff 端目前无 E2E 测试基建）|

### PR-C：结算重构（订单类型 3 选 1 + 转换单 Panel）

| # | 任务 | 文件 |
|---|------|------|
| C1 | Step 2（确认订单）顶部新增"订单类型" 3 选 1 卡片组（销售单 / 内部单 / 转换单），后 2 项 managerOnly；state `saleOrderType: '销售单'|'内部单'|'转换单'` 默认 `'销售单'` | `order-create.wxml:253-258` + `order-create.ts` 新增 onSelectSaleOrderType |
| C2 | 内部单 UI 联动：合计区域加"内部单 5 折"红底标签 + 划线原价 + 半价总计；每行"优惠"输入框 disabled + 显示半价后 itemTotal；优惠券控件 `wx:if="{{saleOrderType !== '内部单'}}"` 隐藏 | `order-create.wxml:259-309` + `cart-calc.ts` 新增 `calcHalfPriceTotal()` |
| C3 | 新增 `<conversion-panel>` 组件：`saleOrderType === '转换单'` 时渲染；内部调用 `order.customerHeldCards` 拉取卡列表 → 每张卡 checkbox + 折抵额预览；底部实时差额显示（"还需支付 ¥X" / "无需补差额" / "将充入储值卡 ¥X"）；支付方式 picker（差额>0 时显示） | 新增 `components/conversion-panel/` |
| C4 | 提交逻辑分支：`saleOrderType IN ('销售单','内部单')` → `order.create`；`saleOrderType='转换单'` → `order.createConversion`；成功后 Step 3 Toast 文案按差额方向差异化（"差额 ¥X 已充入储值卡" / "请确认补差额收款" / "已完成" ） | `order-create.ts` onSubmitOrder 改造 |
| C5 | 转换单守卫：`clientUserId` 必填（Step 0 必须落到已注册顾客，不允许仅手机号兜底）；未注册顾客场景 Step 2 的"转换单"卡片 disabled + tooltip"请先用手机号确认顾客身份" | `order-create.ts` checkoutStep 切换时校验 |
| C6 | 旧 `orderType: 'normal'|'experience'|'internal'|'promotion'` state 与 UI 彻底移除（`order-create.ts:10, 125` + `wxml:200-251`）；`customPrice` 单字段改为 Step 2 行级"自定义单价"输入（仅销售单可用）| 同 B5 衔接 |
| C7 | 人工验收：走通 3 种订单类型 + 转换单 3 种差额方向 = 共 5 条路径；其中转换单负差额后跳到顾客详情页（`packageCustomer/customer-detail`）应能看到新增的 prepaid_cards 余额（若该页已有展示 UI；否则本 ticket 不管 UI，只验数据落库） | — |

### 不在本 ticket 范围

- [ ] 客户端（fengyu-client）开单流程改版 — 客户端是 C 端自助下单，不涉及店长开单改版
- [ ] 回款单 / 退款单 / 提货单 的入口 — 走订单详情页二级操作，已有入口
- [ ] 顾客详情页展示 prepaid_cards 余额的 UI — 由 `packageCustomer/customer-detail` 独立 ticket 处理
- [ ] 优惠券分摊算法变更 — 复用现有 `create` 的分摊逻辑（`routes/order.js:371-386`）
- [ ] E2E 自动化测试基建 — staff 端目前没有 playwright 等，本 ticket 不引入

---

## 4 验收标准

### 云函数层

1. **`product.shopInit` 返回结构**：SKU 列表项新增 `isBundle: boolean` 字段；bundle 类 SPU 关联 `mallBundleGroups` 数组返回
2. **`order.customerHeldCards` 新 action**：POST `{ clientUserId }` 返回当前门店可折抵卡列表；跨店卡不出现；已耗尽卡不出现
3. **`order.create` 内部单半价**：`saleOrderType='内部单'` + 100 元 SKU × 2 → 返回订单 `total_amount=100`，`sale_items.unit_real_price=50`，`unit_price=100`（原价快照）
4. **`order.create` 内部单拒券**：`saleOrderType='内部单' + couponId=xxx` → 返回 `INVALID_PARAMS: 内部单不允许叠加优惠券`
5. **`order.createConversion` 差额=0**：顾客有 1 张剩 5 次的疗程卡（`unit_real_price=100`，折抵 500）+ 转入 500 元体验卡 → 新订单 `total_amount=0` 状态 `'已支付'`，原疗程卡 `remaining_sessions=0`
6. **`order.createConversion` 正差额**：折抵 300 + 转入 500 + `paymentMethod='线下'` → 新订单 `total_amount=200` 状态 `'待确认收款'`
7. **`order.createConversion` 负差额**：折抵 800 + 转入 500 → `prepaid_cards.balance += 300`，新增 1 条 `card_transactions(type='充值', amount=300, ref_order_id=新订单)`；新订单 `total_amount=0` 状态 `'已支付'`
8. **`order.createConversion` 跨店拒绝**：A 店顾客卡，staff 绑在 B 店开 → 返回空 heldCards 列表 / 提交时 `INVALID_PARAMS: 部分卡不属于当前门店或已耗尽`
9. **`order.createConversion` 并发已耗尽拒绝**：模拟在 `FOR UPDATE` 之前把卡剩余次数扣到 0 → 返回 `INVALID_PARAMS` 事务回滚，无 prepaid_cards 变动

### 前端 UI 层

10. **商品类型 4 选 1**：开单页顶部 4 个 Tab（组合套餐 / 普通商品 / 体验卡 / 充值卡）；切 Tab 时 SKU 列表相应过滤
11. **BundlePicker 基础可用**：切"组合套餐"后能看到 bundle 列表，选中任一套餐能进入 N 选 M 视图，选完加购到 cart
12. **Step 2 订单类型 3 选 1**：销售单 / 内部单 / 转换单（managerOnly）；切内部单合计区域显示 5 折标签
13. **内部单 UI 锁**：切内部单后 行"优惠"输入框 disabled + 优惠券区隐藏
14. **转换单 Panel**：切转换单后拉取顾客持卡列表，实时显示差额 / 支付方式选择；差额 ≤ 0 时不显示支付方式
15. **转换单成功 Toast 文案差异**：正差额 → "请补差额 ¥X"，零差额 → "转换成功"，负差额 → "差额 ¥X 已充入储值卡"
16. **未注册顾客拒绝转换单**：手机号未查到 `client_user_id` 时 Step 2 "转换单"卡片 disabled + tooltip

### 一致性检查

17. **与 admin 对比**：在同一家门店用同一顾客手机号，分别用 staff 开"转换单 负差额 ¥300" + admin 开"转换单 负差额 ¥200" → `prepaid_cards.balance` 应累加为 ¥500，`card_transactions` 2 条
18. **不动 schema**：`db/schema/*.ts` 零改动；无需跑 migration
19. **类型检查**：`cd fengyu-staff/miniprogram && bun run tsc --noEmit` 通过（若有该命令；否则 devtools 编译无红）
20. **无历史兼容代码**：旧 `orderType: normal|experience|internal|promotion` 入参从云函数 / 前端 state / wxml 彻底删除（`memory/feedback_no_legacy_compat.md`）

---

## 5 风险与决策点

| 风险 / 决策 | 处理 |
|---|---|
| BundlePicker 的"N 选 M" UI 在小程序原生 Vant Weapp 下的复杂度 | 本 ticket 只实现"pickCount=null 全选"与"pickCount=N 精确选 N 个"两种形态；"任选 N 至 M"后续迭代 |
| `customerHeldCards` 的"单次卡"识别口径 | 与 admin 一致：`product_type='单品' AND product_categories.product_kind='体验卡'`；若业务方认为"家居产品里的单品"也算可折抵卡，需产品确认后扩口径 |
| 转换单订单号前缀（`FY-ABZH-WX-` vs `FY-ZHD-WX-`） | A4 实施前 grep admin 的 `createConversionOrder` 确认前缀；两端对齐，避免同一事件日志 trace 不一致 |
| 差额转储值卡是否需要审批 | 当前实现：店长直接生效；如未来要求"超过 ¥X 需财务审批"，留 hook 但本 ticket 不做（与 admin 一致）|
| `prepaid_cards` UPSERT 并发 | 利用现有 UNIQUE(user_id, store_id) + `ON CONFLICT DO UPDATE`，事务内幂等 |
| staff 云函数 `createConversion` 入参签名变更 | **破坏性变更**：旧签名 `refSaleOrderId + convertOutItems[{saleItemId,convertQuantity}]` 无前端调用（grep 零命中），直接覆盖；无兼容包袱 |
| 体验单 `customPrice` 行为迁移 | 拆到"销售单 + 行级自定义单价"；体验卡 SKU 的 `special_price` 本身就可能低于 `price`，自定义单价仅作为店长兜底（Step 2 行级输入），**不再由订单类型触发** |
| 组合套餐独占约束 | 保留（组合套餐 cart 不允许混入其他 SKU），BundlePicker 选完后如用户切回其他商品类型再加购 → 弹确认清空 cart |
| 小程序端无 E2E 基建 | 本 ticket 验收降级为"人工跑 5 条路径 + 云函数 Postman 联调"；E2E 自动化另起 ticket |
| Step 标号改动对现有文档引用影响 | `.42cog/pm/staff.pr.spec.md` / `.42cog/design/staff.ui.spec.md` 若有引用"Step 1 选开单模式" 需同步更新（实施时一起改）|
| `product.shopInit` 返回结构变化对其他页面影响 | grep 所有调用点（`product.shopInit`），确认仅 `pages/order-create/` 使用；若 `packageService/product-detail` 也用，需同步兼容新字段（向前兼容，加字段不破坏）|

---

## 6 前置依赖与环境

- staff 云函数当前工作流（`fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`）
- 本 ticket **不改 schema**，故无 migration，无需双库操作
- 云函数部署走 `/cloudbase-deploy` skill；`tcb fn code update` 不重置环境变量（参 `memory/project_cloudbase_envvar_risk.md`）
- 本地开发走 mock 模式或真实 `staffApi` 云函数；`pg` 连接池 max 5 不变
- PR-A 可独立 deploy 上线（前端不调用新 action 不影响）；PR-B 前端结构性改动需与 PR-A deploy 同批上线（否则 SKU 过滤会拿不到 `isBundle` 字段）

---

## 7 相关引用

- 现页：`fengyu-staff/miniprogram/pages/order-create/order-create.ts`（679 行）、`order-create.wxml`（399 行）
- 云函数：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（1543 行，`create:161-499` / `createConversion:1257-1427`）+ `routes/product.js`（`shopInit`）
- Schema：`db/schema/order.ts`（saleOrders/saleItems/saleAllocations）、`db/schema/product.ts:11-159`（categories/skus/products/mallBundleGroups/mallProductSkus）、`db/schema/prepaid-card.ts:14-57`（prepaidCards/cardTransactions）、`db/schema/enums.ts:3,17,21`
- admin 对标实现：
  - Ticket：[2026-04-16-admin-order-create-flow-revamp.md](2026-04-16-admin-order-create-flow-revamp.md)
  - 页面：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx`（productKindChoice / orderType / ConversionPanel）
  - Server Action：`fengyu-admin/src/actions/orders.ts:733-1150`（`createConversionOrder`，含"差额转储值卡"段）+ `actions/customers.ts` 或 `actions/cards.ts` 的 `getCustomerHeldCards`
  - 相关 commit：579e05e（Step3 跳转 + 禁用手工改价）、d2b7761（`sale_items.storeId` 补齐 + `customerName` 兜底）、4341506（admin PR-C 主体：Step2/3 重构 + 转换单结算 + 内部单半价）
- 设计基线：`.42cog/cog.md`（"卡包"实体 / "转换单"业务流程）、`.42cog/pm/staff.pr.spec.md`
- 项目铁律：`memory/feedback_no_legacy_compat.md`（无历史兼容包袱）、`memory/project_cloudbase_envvar_risk.md`（云函数部署环境变量）、`memory/project_db_dual_env.md`（双库 — 本 ticket 不涉及）

---

## 8 对 admin ticket 的差异说明

相比 [2026-04-16-admin-order-create-flow-revamp.md](2026-04-16-admin-order-create-flow-revamp.md)，staff 端关键差异：

| 维度 | admin | staff |
|---|---|---|
| 起点 | 从"4 选 1 的 orderType" 改到"Step1 商品类型 + Step3 订单类型" | 从"4 选 1 的开单模式（混合语义）" 改到同一目标；路径更长（旧 UI 要删得更多）|
| 云函数 | 从零新增 `createConversionOrder`（Drizzle） | 已存在 `createConversion`（原生 pg SQL），要**重构入参 + 补差额转储值卡段** |
| 前端 | React Server Components + Server Actions | 小程序原生 + Vant Weapp + TS；BundlePicker / ConversionPanel 需写原生自定义组件 |
| 测试 | Vitest + Playwright E2E | 无自动化基建，本 ticket 降级为人工验收 |
| `client_user_id` 兜底 | admin 允许 `manualPhone` 开单，转换单强制落实名顾客 | staff 现有 `clientPhone + clientName` 兜底，转换单同样强制 `clientUserId`（Step 0 查不到则 disabled 转换单卡片）|
| schema | 零改动 | 零改动 |
| 发布策略 | admin 已完成 PR-A/B/C 三段式 merge | staff 跟随 admin 方案，3 个 PR 串行；PR-A 可单独上线 |

本 ticket 可视为 "admin 改版的 staff 平移版"，与 admin 做同构验收（§4 第 17 条）保证双端一致。
