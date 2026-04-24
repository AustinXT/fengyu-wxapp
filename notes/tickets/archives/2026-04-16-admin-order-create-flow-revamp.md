# Ticket: Admin 开单流程改版（商品类型驱动 + 转换单 + 内部单半价）

> 生成日期：2026-04-16
> 严重级别：P1（业务流程改版，影响店长/财务日常开单与转换单核销）
> 归属页面：`fengyu-admin/src/app/(main)/orders/create/`
> 关联模块：`fengyu-admin/src/actions/orders.ts`、`actions/products.ts`、`actions/customers.ts` + 新增 cards/conversion 子模块
> 复用后端能力：staffApi 的 `order.createConversion` 已实现转出/转入两段式逻辑（`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1257-1426`），admin 侧需要平移到 Drizzle Server Action 并扩展"差额转储值卡"
> 拆分方式：单 feature 分支，3 个 PR 串行 merge（A → B → C）

---

## 0 一句话背景

当前 admin 开单页（`OrderCreatePageClient`）把"销售单/内部单"的订单类型放在 Step 1，把所有 SKU 用品项分类（`product_kind`）二级分类全部混在 Step 2 一起选；下单出来的全部是 `销售单` 或 `内部单` 走 `createOrder` 普通路径，没有转换单入口，也没有按商品类型隔离选品（疗程项目、家居产品、体验卡、充值卡 SKU 全堆在一个分类树里）。

业务实际诉求：

1. **入口收窄**：Step 1 先让操作员选**商品类型**（组合套餐 / 普通商品 / 体验卡 / 充值卡），其后整个 Step 2 按这一选择走完全不同的选品 UI 与数据源
2. **转换单入口前置**：Step 3 暴露"销售单 / 内部单 / 转换单"三选一，转换单专用结算流（顾客手里的疗程卡/单次卡作"折抵筹码"，差额补现/退余额到储值卡）
3. **内部单半价**：自动按 50% 计算应付，不依赖人工改价
4. **取消订单类型 step1 选择**：订单类型迁到 Step 3，与最终结算策略绑定

本 ticket 用四象限表格盘点现状—目标差异，再按"DB → Server Actions → 选品 UI → 结算 UI"四层逐项落地，最后给出验收清单与边界。

---

## 1 现状 vs 目标对比

### 1.1 步骤映射

| 步骤 | 现状（fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx） | 目标 |
|---|---|---|
| Step 1 选顾客 | 顾客搜索 + **订单类型（销售单/内部单）** + 顾客选中卡 | 顾客搜索 + **商品类型（组合套餐/普通商品/体验卡/充值卡）** + 顾客选中卡 |
| Step 2 选商品 | 一级 `productKind`（4 值）展开 → 二级 `categoryName` → product → SKU 加购 | 按 Step 1 商品类型四分支：① 组合套餐 → 商城套餐 SPU；② 普通商品 → SKU（仅 `productKind in ('护理项目','家居产品')`）；③ 体验卡 → 体验卡 SKU；④ 充值卡 → 充值卡 SKU |
| Step 3 确认订单 | 顾客 / 订单类型显示 / 支付方式 / 门店 / 美容师 / 备注 / 优惠券 + 商品清单 + 价格调整 | **订单类型选择（销售单/内部单/转换单）** 在此暴露；销售/内部走原结算 + 内部单自动半价；转换单切到"折抵筹码 + 差额结算"专用面板 |
| Step 4 完成 | 订单创建成功 + 二维码/确认收款 | 同左（无变化） |

### 1.2 商品类型与数据源

`product_kind` 枚举已是 `['护理项目','家居产品','充值卡','体验卡']`（`db/schema/enums.ts:3`），无需改 DDL。`products.is_bundle`（套餐标记）与 `mall_product_skus`（套餐 SKU 关联）已存在（`db/schema/product.ts:84-159`），无需改 DDL。

| Step 1 选择 | Step 2 列表数据源 | 关键过滤条件 |
|---|---|---|
| 组合套餐 | **商城管理 SPU**：`products WHERE is_bundle = true AND is_enabled AND is_visible`；展示 cover_image / price / specialPrice；选中后通过 `mall_product_skus` + `mall_bundle_groups` 展开"N 选 M"；最终落到加入购物车的是若干 SKU + 一个 bundle 标识（同一 SPU 下选中的 SKU 在结算时按整套定价） | `is_bundle=true` |
| 普通商品 | **商品管理 SKU**：`product_skus JOIN product_categories WHERE pc.product_kind IN ('护理项目','家居产品')`；左侧 nav 二级分类按 `product_kind` 分组展示 | `product_kind IN ('护理项目','家居产品')`，**排除** `'体验卡','充值卡'` |
| 体验卡 | **体验卡 SKU**：`product_skus JOIN product_categories WHERE pc.product_kind = '体验卡'`；通常品类较少，可平铺单页 grid | `product_kind='体验卡'` |
| 充值卡 | **充值卡 SKU**：`product_skus JOIN product_categories WHERE pc.product_kind = '充值卡'`；面值型 SKU 平铺；下单成功后 `clientApi/order.js` 支付回调侧已有"充值卡入账"逻辑参考（本 ticket 不动支付回调） | `product_kind='充值卡'` |

### 1.3 订单类型（Step 3）

`sale_order_type` 枚举已含 `['销售单','内部单','回款单','转换单','退款单']`（`db/schema/enums.ts:17`），admin 开单 UI 暴露 **3 个**：销售单 / 内部单 / 转换单。`回款单 / 退款单` 由其它入口（订单详情页操作）创建，不在本 ticket。

| 订单类型 | 应付金额规则 | 实付/抵扣规则 | 落库结构 |
|---|---|---|---|
| 销售单 | `sum(sku.price × qty)`（套餐用 bundle 价） | `received = saleAmount - couponDiscount`；走原 `createOrder` | 单条 `sale_orders.sale_order_type='销售单'` + N 行 `sale_items.item_direction='购买'` |
| 内部单 | **半价 = `sum × 0.5`**（自动，不允许手工改价） | 走原 `createOrder` | 同销售单，仅 `sale_order_type='内部单'` 与金额减半 |
| 转换单 | `sum(sku.price × qty)`（按全价计入转入金额） | 转出折抵金额 = `sum(选中卡剩余次数 × unit_real_price)`；差额 = 应付 - 折抵；正差顾客补现，负差转入储值卡 | 调用新增 `createConversionOrder`，落库形态见 §2.3 |

---

## 2 设计决策

### 2.1 商品类型放在 Step 1 + 整流到 Step 2

**为什么不沿用现有"全分类树"**：

- 4 个 `product_kind` 业务语义差异很大，组合套餐与单 SKU 的展示形式根本不同（套餐要"按组分组+N 选 M"，SKU 是"一价一加购"）
- 充值卡只有"面值"维度，没有数量/规格选择，UI 应平铺成"金额按钮组"
- 体验卡品项少且不参与折扣，UI 简化即可
- 混在一起会让普通商品视图 90% 的时间淹没在不相关的卡类型里

**实现层面**：Step 1 引入 `productKindChoice: '组合套餐' | '普通商品' | '体验卡' | '充值卡'` 状态变量。`组合套餐` 不映射到 DB 枚举，是 admin 前端虚拟的"第 5 类"，对应 `products.is_bundle=true`；其他 3 个直接映射到 `product_kind` 枚举。Step 2 渲染按这个 state 选择 4 个不同的 React 子组件（`<BundlePicker />`、`<NormalSkuPicker />`、`<TrialCardPicker />`、`<PrepaidCardPicker />`），共享同一个 `cart` state 和 `priceOverrides`。

### 2.2 内部单半价

| 决策点 | 选定方案 |
|---|---|
| 半价应用层级 | **在 Server Action 入口统一应用**：`createOrder` 收到 `saleOrderType='内部单'` 时，遍历 `items` 把 `unitRealPrice` / `saleAmount` / `received` 全部 ×0.5 后再走后续逻辑；不依赖前端传值 |
| UI 是否显示半价 | Step 3 显示"内部单 5 折"标签 + 半价后的合计；`sale_amount` 也按半价持久化（落库即半价，财务核对一致） |
| 价格覆盖（`priceOverrides`） | 内部单**禁用手工改价**，灰掉"应付/实付"输入框；如需特殊价格请走销售单 |
| 优惠券 | 内部单**不允许叠加优惠券**，前端隐藏券选择控件 |
| `sale_items.unit_price` 快照 | 仍用原价（即 `product_skus.price`），半价只反映在 `unit_real_price` / `sale_amount` / `received`，避免日后回溯丢失原价基线 |

> 服务费 (`sale_items.service_fee`) 是否半价：**不变**。手工费按原 SKU 配置快照，内部单不影响员工提成基础。

### 2.3 转换单（核心）

**业务流程**：

1. 选定顾客后已知 `clientUserId` + `selectedStoreId`
2. Step 1 选 商品类型（组合套餐/普通/体验卡/充值卡），Step 2 加购转入项；
3. Step 3 切到 `转换单` → 拉取该顾客**在当前门店**已购、`item_direction='购买'`、`product_type IN ('疗程卡','单品')` 且 `(remaining_sessions > 0 OR product_type='单品' AND quantity - picked_up_quantity > 0)` 的 `sale_items`
   - 这里"单次卡"按 cog 模型映射到 `product_type='单品' AND product_kind='体验卡'` 的体验卡 SKU 派生行（一次性消费）；和"疗程卡"（`product_type='疗程卡' AND remaining_sessions>0`）合并为同一个折抵候选列表
   - **不包含**充值卡：充值卡是金额账户在 `prepaid_cards` 表里，不是 `sale_items` 行，业务上储值余额不参与"折抵"操作（充值卡只能消费抵扣）
4. 顾客可勾选**整张卡**（不允许选部分次数）：勾选 = 该卡剩余全部转出；不勾选 = 该卡保留
5. 每张卡的"折抵金额" = `unit_real_price × (remaining_sessions || 剩余 quantity)`
6. 应付（转入合计） vs 折抵合计：
   - **应付 > 折抵**：差额顾客补现（走 `paymentMethod`）
   - **应付 = 折抵**：直接 `已支付`，不收款
   - **应付 < 折抵**：差额（折抵 - 应付）写入顾客在当前门店的 `prepaid_cards` 账户余额（不存在则 INSERT，存在则 `balance += 差额`），同步插入 `card_transactions(type='充值', amount=差额, ref_order_id=新转换单)`

**落库结构（一次事务）**：

```
sale_orders (sale_order_type='转换单', total_amount=应付-折抵, payment_method, status, ref_sale_order_id=null)
├── sale_items (item_direction='转出', ref_sale_item_id=被勾选的卡 saleItemId, sale_amount=负折抵, received=负折抵)  × 选中卡数量
└── sale_items (item_direction='转入', sku_id=新选 SKU, sale_amount=应付, received=应付)               × 转入项数量
```

加上：

- 每个"转出"行同步 `UPDATE sale_items SET remaining_sessions = 0 WHERE sale_item_id = ref_sale_item_id AND store_id = ctx.storeId`（疗程卡）
- 单品/体验卡派生的折抵行：`UPDATE sale_items SET picked_up_quantity = quantity WHERE sale_item_id = ref_sale_item_id AND store_id = ctx.storeId`（标记已耗尽）
- 若 `应付 < 折抵`：UPSERT `prepaid_cards` + INSERT `card_transactions`
- `total_amount` 取 **顾客实际需要补现的金额**（即 `max(0, 应付 - 折抵)`），与现金支付的 `received` 对齐；折抵部分通过转出行表达

> 现有 staffApi `createConversion`（`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1257-1426`）已实现"两段式 sale_items + 原子扣减次数"，但**没有**"差额转储值卡"。本 ticket 的 admin 版要在它的基础上补这一段；后续可拉平到 staffApi（不在本 ticket 范围）。

### 2.4 数据库改动

**结论：本 ticket 不动 schema**。

- `product_kind` 枚举 4 值齐全
- `sale_order_type` 枚举 5 值齐全（仅 admin UI 暴露 3 个）
- `sale_items.item_direction` 枚举含 `'转出','转入'`
- `prepaid_cards` 表已存在，UNIQUE(user_id, store_id) 已经约束"一户一店一账户"
- `card_transactions` 表已存在，`type` 含 `'充值'`

避免任何 `db/schema/*.ts` 修改 = **零迁移负担**，直接在 Server Action 层落地。

---

## 3 实施计划（按 PR 拆分）

### PR-A：Server Actions（数据层基座，先行 merge）

**目标**：把"按商品类型查 SKU/SPU"、"查顾客在当前店的可折抵卡"、"创建转换单"三个 action 落地，UI 后续基于此重构。

| # | 任务 | 文件 |
|---|------|------|
| A1 | `getProductsByKind(kind)` — 按 `product_kind` 返回过滤后的 product_categories + product_skus；新增 `kind='__bundle__'` 特殊分支返回 `products WHERE is_bundle=true` + 关联 `mallBundleGroups` + `mallProductSkus` | `fengyu-admin/src/actions/products.ts` |
| A2 | `getCustomerHeldCards(clientUserId, storeId)` — 查 `sale_items WHERE store_id=$2 AND item_direction='购买' AND ((product_type='疗程卡' AND remaining_sessions>0) OR (product_type='单品' AND product_category.product_kind='体验卡' AND (quantity - COALESCE(picked_up_quantity,0))>0))`；返回 `{saleItemId, productName, skuSpecName, productType, remainingSessions or remainingQty, unitRealPrice, deductibleAmount}[]` | `fengyu-admin/src/actions/customers.ts`（或新建 `actions/cards.ts`） |
| A3 | `createConversionOrder(data)` — 平移 staffApi 转换单逻辑 + 新增"差额转储值卡"事务段；签名见下方 | `fengyu-admin/src/actions/orders.ts` |
| A4 | `createOrder` 内部单半价：`if (saleOrderType==='内部单')` 在最前面把 items 的 `unitRealPrice/saleAmount/received` ×0.5 后再走后续；同时拒绝传入 `couponId`（`return {success:false,message:'内部单不允许叠加优惠券'}`） | `fengyu-admin/src/actions/orders.ts:420` |
| A5 | 单元测试：A2/A3 覆盖（含"差额=0/正/负"3 路径 + "选了不属于本店的卡"拒绝 + "选了已耗尽的卡"拒绝） | `fengyu-admin/src/actions/orders.test.ts` + `customers.test.ts` |
| A6 | 操作日志：`createConversionOrder` 写 `logOperation(session,'order.create_conversion',...)`；内部单 createOrder 已经会写 `order.create`，不必区分 | `fengyu-admin/src/lib/operation-log.ts` 现有工具 |

**A3 函数签名草案**：

```typescript
export async function createConversionOrder(data: {
  storeId: string
  marketName: string
  clientUserId: string  // 转换单必须实名顾客（要写入储值卡），不允许 manualPhone
  paymentMethod: '微信' | '支付宝' | '线下'
  preferredEmployeeId?: string
  remark?: string | null
  /** 转出选项：整张卡，不带数量 */
  convertOutSaleItemIds: string[]
  /** 转入项目（来自 Step 2 的购物车） */
  convertInItems: Array<{
    skuId: string
    productName: string
    skuSpecName: string
    productType: '疗程卡' | '单品' | '院装产品'
    sessionCount: number | null
    unitPrice: string
    quantity: number
  }>
}): Promise<{
  success: boolean
  message: string
  saleOrderId?: string
  /** 应付（转入合计） */
  totalIn?: number
  /** 折抵（转出合计） */
  totalOut?: number
  /** 差额，正=补现，负=转储值卡 */
  priceDiff?: number
  /** 若负差额，本次充入的储值卡余额 */
  prepaidCardCredit?: number
}>
```

**A3 关键事务伪代码**：

```typescript
await db.transaction(async (tx) => {
  // 1. 锁顾客 + 当前店的所有候选卡（FOR UPDATE）防并发服务核销
  const heldCards = await tx.execute(sql`
    SELECT sale_item_id, product_type, remaining_sessions, quantity, picked_up_quantity, unit_real_price
    FROM sale_items
    WHERE sale_item_id = ANY(${convertOutSaleItemIds})
      AND store_id = ${storeId}
      AND item_direction = '购买'
    FOR UPDATE
  `)
  if (heldCards.length !== convertOutSaleItemIds.length) throw new Error('部分卡不属于当前门店或已不存在')
  // 校验每张卡都还有可折抵余量
  for (const c of heldCards) {
    if (c.product_type === '疗程卡' && (c.remaining_sessions ?? 0) <= 0) throw new Error(...)
    if (c.product_type === '单品' && (c.quantity - (c.picked_up_quantity ?? 0)) <= 0) throw new Error(...)
  }
  const totalOut = heldCards.reduce((s, c) =>
    s + Number(c.unit_real_price) * (c.product_type === '疗程卡' ? c.remaining_sessions : (c.quantity - (c.picked_up_quantity ?? 0))), 0)
  const totalIn = convertInItems.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0)
  const priceDiff = totalIn - totalOut  // 正=补现，负=转储值卡

  // 2. 生成订单号 + INSERT sale_orders（total_amount = max(0, priceDiff)）
  // 3. INSERT 转出行 (item_direction='转出', sale_amount=负折抵, ref_sale_item_id)
  //    + UPDATE 原行 remaining_sessions=0 / picked_up_quantity=quantity（按 product_type 分支）
  //    + 必须校验 rowCount === 1，否则抛"卡状态变化，请重试"
  // 4. INSERT 转入行 (item_direction='转入', sale_amount=应付)
  // 5. if (priceDiff < 0) {
  //      UPSERT prepaid_cards (user_id, store_id) DO UPDATE SET balance = balance + |priceDiff|
  //      INSERT card_transactions(type='充值', amount=|priceDiff|, ref_order_id=新订单)
  //    }
  // 6. status = priceDiff > 0 ? '待支付'/'待确认收款' : '已支付'
})
```

### PR-B：Step 1 重构（顾客 + 商品类型）

| # | 任务 | 文件 |
|---|------|------|
| B1 | Step 1 移除"订单类型"块，新增"商品类型"4 选 1（默认"普通商品"） | `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:256-393` |
| B2 | 顾客搜索逻辑保持，但选中顾客后**预拉**Step 2 所需数据（按当前 productKindChoice 拉对应 SKU/SPU 列表，使用 SWR-like cache 避免切换 kind 时重复请求） | 同上 |
| B3 | 新增 state：`productKindChoice`、`heldCards`（转换单备用） | 同上 |
| B4 | 进入 Step 2 之前清空 `cart` + `priceOverrides`（避免跨 kind 加购） | 同上 |
| B5 | E2E：登录 → 选顾客 → 切 4 种商品类型 → 进入 Step 2 看到正确数据源 | `fengyu-admin/e2e/orders-create-flow.spec.ts`（新建） |

### PR-C：Step 2/3 重构（按商品类型 + 转换单结算）

| # | 任务 | 文件 |
|---|------|------|
| C1 | 抽 4 个子组件 `<BundlePicker />`、`<NormalSkuPicker />`、`<TrialCardPicker />`、`<PrepaidCardPicker />`，从原 Step 2 大块代码拆分；`<BundlePicker />` 实现"N 选 M"分组 UI | `_components/order-create/` 新目录 |
| C2 | Step 3 订单类型 3 选 1（销售单/内部单/转换单）；切到内部单时灰掉"应付/实付"输入框 + 隐藏优惠券；切到转换单时切到 `<ConversionPanel />` | 同上 |
| C3 | `<ConversionPanel />`：左列显示 `getCustomerHeldCards` 返回的卡（每张一个 checkbox + 折抵金额预览），右列显示当前购物车 + 应付合计 + 实时差额；底部按差额正负展示"还需支付 ¥X" 或"将充入储值卡 ¥X" | 新增 |
| C4 | 提交逻辑分支：销售/内部 → `createOrder`；转换 → `createConversionOrder`；成功后 Step 4 显示提示文案差异（转换单显示"差额 ¥X 已充入储值卡"或"请确认补差额收款"） | 同 `order-create-page.tsx` |
| C5 | 内部单半价显示：合计区域加"内部单 5 折"灰色 tag + 显示原价 → 划线 → 半价 | 同 |
| C6 | E2E：完整跑通"选顾客 → 普通商品 → 销售单"、"组合套餐 → 内部单半价"、"普通商品 → 转换单（差额=0/正/负 三条）" | `fengyu-admin/e2e/orders-create-flow.spec.ts` |

### 不在本 ticket 范围

- [ ] staffApi 同步对齐"差额转储值卡"（员工端转换单也走该规则）— 后续 ticket
- [ ] 客户端展示"商品类型"（仅 admin 开单 UI，客户端选品仍按现有商城逻辑）
- [ ] 回款单 / 退款单的入口（仍在订单详情页操作，不在开单流）
- [ ] 充值卡支付回调对账（已存在，未变化）
- [ ] 套餐 SPU 的"N 选 M"复杂校验（B 阶段留 TODO，C2 实现一版基础选择，复杂校验后续优化）

---

## 4 验收标准

1. **Step 1 改版**：admin 开单页 Step 1 无"订单类型"控件；新增"商品类型"4 选 1，默认"普通商品"
2. **Step 2 数据隔离**：
   - "组合套餐"列表仅出现 `products WHERE is_bundle=true`
   - "普通商品"列表仅出现 `product_kind IN ('护理项目','家居产品')` 的 SKU；体验卡/充值卡 SKU 不出现
   - "体验卡"/"充值卡"分别只出现对应 `product_kind` 的 SKU
3. **Step 3 订单类型 3 选 1**：销售单 / 内部单 / 转换单
4. **内部单半价**：选"内部单"+ 普通 100 元 SKU × 2 → 总价显示 ¥100；落库 `sale_amount`=100；优惠券控件不可见
5. **转换单 差额=0**：顾客有 1 张剩 5 次的疗程卡（折抵 500），选 1 个 500 元体验卡转入 → 提交后无补现，订单状态 `已支付`，原疗程卡 `remaining_sessions=0`
6. **转换单 正差额**：折抵 300 + 转入 500 → 提交时弹支付方式或确认线下收款，订单 `total_amount=200`
7. **转换单 负差额**：折抵 800 + 转入 500 → `prepaid_cards.balance += 300` + 1 条 `card_transactions(type='充值', amount=300, ref_order_id=新订单)`；订单 `total_amount=0`，状态 `已支付`
8. **转换单 跨店拒绝**：顾客在 A 店有卡，admin 切 B 店开转换单 → `getCustomerHeldCards` 返回空列表
9. **转换单 选已耗尽卡拒绝**：模拟并发把卡剩余次数扣到 0 后，提交转换单 → 返回 `卡状态变化，请重试`，事务回滚
10. **审计日志**：`order.create_conversion` 在 `operation_logs` 有完整记录（含 storeId / 选中卡 ID / 差额）
11. **类型检查**：`cd fengyu-admin && bun run build` 通过；`bun run test` 全绿
12. **E2E**：3 条新增 spec 通过

---

## 5 风险与决策点

| 风险 / 决策 | 处理 |
|---|---|
| 套餐"N 选 M"在 Step 2 的 UI 复杂度被低估 | C1 先实现"全选"基础形态（即把 `mallBundleGroups.pickCount=null` 的全部 SKU 加入），N 选 M 在阶段二增量；本 ticket 验收只要求基础形态 |
| `getCustomerHeldCards` 的"单次卡"识别口径模糊（业务说"单次卡"，DB 没有显式标志） | 选用：`product_type='单品' AND product_categories.product_kind='体验卡'`；如顾客业务方有不同口径，验收前与产品确认 |
| 内部单半价是否含税/服务费 | 服务费 (`service_fee`) 不变；半价仅作用于 `unitRealPrice/saleAmount/received` 三列；与会计沟通确认 |
| 转换单"差额转储值卡"是否需要审批 | 当前实现：店长直接生效；如未来要求"超过 ¥X 需财务审批"，留 hook 但本 ticket 不做 |
| `prepaid_cards` UPSERT 的并发安全 | 利用现有 UNIQUE(user_id, store_id) + `INSERT ... ON CONFLICT DO UPDATE`，事务内即可幂等 |
| staffApi 旧版 `createConversion` 逻辑分歧 | 本 ticket 不动 staffApi；admin 自己一份 Drizzle 实现，注释里指明"等业务侧确认 admin 版稳定后回灌 staffApi" |
| 转换单 `clientUserId` 必填（manualPhone 不允许） | 转换单依赖顾客在 PG 有行才能查 heldCards 与挂储值卡；Step 1 选了"未注册手机号开单"路径时，Step 3 的"转换单"按钮置灰 + 提示"请先用搜索确认顾客身份" |
| 商品类型切换时购物车清空，体验差 | 已在 PR-B B4 处理；额外加"切换前若 cart 非空 → 弹确认"对话框（C 阶段加） |
| 内部单 sale_items.unit_price 是否半价 | 不半价。`unit_price` 始终保持原 SKU 价；`unit_real_price` 才是半价后的实际成交价。这与现有"促销价"语义一致 |

---

## 6 前置依赖与环境

- 现有 admin Server Actions / Drizzle 工作流（`fengyu-admin/CLAUDE.md`）
- 两库同步 — 本 ticket **不改 schema**，故无 migration，无需双库迁移
- 测试库 5434/fengyu（admin 默认连接）已有完整商品 + 顾客样本数据
- E2E：`bun run test:e2e` 需 dev server 在跑

---

## 7 相关引用

- 现页：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx`
- Server Action：`fengyu-admin/src/actions/orders.ts:420`（`createOrder`）、`actions/products.ts:75-310`（categories/SKU/products）
- Schema：`db/schema/order.ts:36-207`（saleOrders / saleItems / saleAllocations）、`db/schema/product.ts:11-159`（categories / skus / products / mallBundleGroups / mallProductSkus）、`db/schema/prepaid-card.ts:14-57`（prepaidCards / cardTransactions）、`db/schema/enums.ts:3,17,21`（productKind / saleOrderType / itemDirection）
- 参考实现：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1257-1426`（`createConversion`，admin 版以此为蓝本 + 加"差额转储值卡"段）
- 设计基线：`.42cog/cog.md`（"卡包"实体）、`.42cog/pm/admin.pr.spec.md`（开单 AC）
- 项目铁律：`memory/feedback_no_legacy_compat.md`（无历史兼容包袱）、`memory/project_db_dual_env.md`（双库一致 — 本 ticket 不涉及）
