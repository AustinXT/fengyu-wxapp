# Ticket: Staff 开单 vs Admin 开单（基准）差异分析与修改清单

> 生成日期：2026-04-16
> 严重级别：P1/P2/P3 混合（见下方分类）
> 归属页面：`fengyu-staff/miniprogram/pages/order-create/` + `fengyu-staff/cloudfunctions/staffApi/routes/order.js`
> 对标基准：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx` + `fengyu-admin/src/actions/orders.ts`
> 前置 ticket：
>   - [2026-04-16-admin-order-create-flow-revamp.md](2026-04-16-admin-order-create-flow-revamp.md)（admin 基准方案，已完成）
>   - [2026-04-16-staff-order-create-flow-revamp.md](2026-04-16-staff-order-create-flow-revamp.md)（早先的 staff 重构计划，**内容已大部分落地，不再准确**）

---

## 0 为什么要再写一份差异分析？

`2026-04-16-staff-order-create-flow-revamp.md` 起草时，staff 端还是旧版（4 选 1 开单模式 + 无转换单入口 + createConversion 缺差额转储值卡）。本次实际读代码后发现：

> **staff 端已经完成了 admin 平移的 PR-A / PR-B / PR-C 核心内容**。
> 前端有 `productKindChoice` 4 选 1 + BundlePicker + ConversionPanel + 订单类型 3 选 1 + 内部单半价 + 转换单闭环；
> 云函数有 `saleOrderType` 原生枚举入参 + 内部单半价守卫 + createConversion 跨订单聚合 + 差额转 prepaid_cards + `order.customerHeldCards` 新 action + 订单号前缀 `FY-XSD-WX-` 与 admin 对齐；
> 测试有"内部单半价"与"转换单差额>0"路径。

原 ticket §3 列举的 A1–A6 / B1–B6 / C1–C7 任务**绝大部分已 merge**。本 ticket 聚焦"对齐之后的残差"，避免再按已过时的任务清单下手。

**本 ticket 的定位**：以 admin 当前代码为基准，扫描 staff 仍然存在的**行为差异 / 测试缺口 / 技术债**，按 P1/P2/P3 给出精确的修改清单。

---

## 1 现状确认（对齐度清单）

以下项目 admin / staff 行为**已完全一致**，无需再动：

| # | 维度 | admin 位置 | staff 位置 | 一致 |
|---|------|-----------|-----------|------|
| 1 | Step 1 商品类型 4 选 1 | `order-create-page.tsx:40-54,125,417-437` | `order-create.ts:15-16,175-176,375-405` + `order-create.wxml:5-13` | ✅ |
| 2 | 商品类型 → 数据源映射 | `resolveBackendKinds` / Server Action `getProductsByKind` | `filterCategoriesByKindChoice`/`filterSkusByKindChoice` + 云函数 `product.shopInit` 返 `isBundle` | ✅ |
| 3 | BundlePicker "N 选 M"基础形态 | `_components/order-create/bundle-picker.tsx` | `components/bundle-picker/` | ✅ |
| 4 | Step 3 订单类型 3 选 1（销售/内部/转换） | `order-create-page.tsx:44-46,123,700-735` | `order-create.ts:24,200,673-705` + `wxml:230-256` | ✅ |
| 5 | 内部单自动半价（后端入口统一应用） | `orders.ts:460-476`（action 入口 ×0.5） | `order.js:267-269`（逐 item ×0.5） | ✅（口径相同，落位稍有差异，结果一致） |
| 6 | 内部单拒优惠券 | `orders.ts:461-462` | `order.js:206-208` | ✅ |
| 7 | 内部单 UI 禁手工改价 + 隐藏优惠券 | `order-create-page.tsx:383,861,780` | `order-create.wxml:299-306,343` + `order-create.ts:546,697-702` | ✅ |
| 8 | 内部单合计区 5 折标签 + 划线原价 | `order-create-page.tsx:847-854,927-929` | `order-create.wxml:327-339` + `cart-calc.calcHalfPriceTotal` | ✅ |
| 9 | 转换单：整张卡折抵（不带 qty） | `convertOutSaleItemIds: string[]` | `convertOutSaleItemIds: string[]` | ✅ |
| 10 | 转换单：跨订单聚合候选卡 + 跨店守卫 | `orders.ts:818-917` + `cards.ts:265-283` | `order.js:1320-1407,1607-1661` | ✅ |
| 11 | 转换单：差额>0 补现 / =0 直接已支付 / <0 UPSERT prepaid_cards | `orders.ts:980-1116` | `order.js:1442-1580` | ✅（语义一致） |
| 12 | 转换单订单号前缀 | `FY-XSD-WX-`（`orders.ts:958`） | `FY-XSD-WX-`（`order.js:1315`） | ✅ |
| 13 | 转换单 item 转出行 service_fee 比例扣减 | `orders.ts:898-901` | `order.js:1389-1391` | ✅ |
| 14 | `order.customerHeldCards` action | `cards.ts:238-312` | `order.js:1607-1661` + 路由注册 `index.js:68` | ✅ |
| 15 | ConversionPanel 差额实时计算 + UI 三分支 | `conversion-panel.tsx:51-160` | `components/conversion-panel/conversion-panel.ts:147-162` + `.wxml` | ✅ |
| 16 | 转换单需实名顾客（`clientUserId` 必填） | `orders.ts:781-783` + UI 禁用 tab | `order.js:1293` + `order-create.ts:680-682` + wxml `order-type-card--disabled` | ✅ |
| 17 | 内部单 UI 禁手工改价（云函数守卫 + 前端 UI） | `suppressOverride` + Server 半价 | `order-create.ts:211-216`（云函数守卫）+ `wxml:299-306`（disabled） | ✅ |
| 18 | 行级 customPrice 仅销售单生效 | N/A（admin 用 saleAmount 覆盖） | `order-create.ts:562-575` + `order.js:272-274` | ✅（语义等价） |

**结论**：staff 端主干工作已完成，PR-A/B/C 所列核心可交付全部落地。

---

## 2 仍存在的差异（按优先级）

### 2.1 P1 — 业务行为差异（影响功能/用户体验）

#### P1-1 ❗ `paymentMethod` 前端硬编码 `'微信'`，店长无法选"线下收款"做销售/内部单

**现象**：`fengyu-staff/miniprogram/pages/order-create/order-create.ts:878`：

```typescript
const res = await callStaffApi<OrderCreateResponse>('order.create', {
  ...
  paymentMethod: '微信',  // ❗ 硬编码
  ...
})
```

**对比 admin**：`order-create-page.tsx:138,746-750` 有支付方式下拉（微信/支付宝/线下），`paymentMethod` state 贯穿 createOrder / createConversionOrder 两个入口。

**影响**：
- staff 店长只能以"微信支付"状态创建销售/内部单（订单状态 `待支付`），无法直接创建"线下收款待确认" 单。
- 转换单路径倒是有支付方式选择（ConversionPanel 内 `paymentMethodOptions = ['微信','线下']`），但销售/内部单无此控件。
- 业务上：某些顾客当面现金/刷卡结算，需要店长开"线下收款"订单，当前流程必须先开微信待支付单再走 `confirmOffline` — 多一步。

**修改方案**：
1. `order-create.wxml` Step 2 结算栏（与"指定美容师" / "备注" 同级）加支付方式选择：
   - 销售单 / 内部单：微信 / 线下（是否加支付宝待业务确认，见 P1-2）
   - 转换单保持 ConversionPanel 内部的 picker（因为差额<=0 时隐藏）
2. `order-create.ts` 新增 `paymentMethod` state（默认 `'微信'`），`onSubmitOrder` 改用此 state 替代硬编码
3. 云函数 `order.js:165-201` 补白名单校验 `if (!['微信','线下','支付宝'].includes(paymentMethod)) throw ...`（当前云函数仅要求非空，未校验枚举）

**验收**：店长在 staff 端开内部单选"线下" → 云函数返回 `status='待确认收款'`（与 admin 对齐）。

---

#### P1-2 ⚠️ 支付宝支持 — staff 两端都不支持，admin 支持

**现象**：
- admin createOrder 签名 `paymentMethod: '微信' | '支付宝' | '线下'`（`orders.ts:427`）
- admin createConversionOrder 同签名（`orders.ts:750`）
- admin UI 下拉有 3 个选项（`order-create-page.tsx:747-749`）
- staff createConversion 白名单仅 `['微信','线下']`（`order.js:1300-1302`）
- staff create 未做白名单校验
- staff ConversionPanel `PAYMENT_METHODS = ['微信','线下']`（`conversion-panel.ts:33`）

**是否差异**：**业务决策，非 bug**。
- 如果业务确认"员工端暂不支持支付宝收款"（例如扫码设备仅微信），则保持现状；但需在 ticket 中显式标注为"有意差异"。
- 如果业务希望 staff 端也能开支付宝单，则要改 3 处（staff create 白名单 / staff createConversion 白名单 / ConversionPanel 选项）。

**建议动作**：先与产品/业务确认口径，再决定是否改。**不建议盲改**（支付宝接入有清算/对账依赖）。

---

### 2.2 P2 — 测试覆盖差异（影响可信度）

#### P2-1 ❗ `order.createConversion` 差额=0 / 差额<0 路径零覆盖

**现状**（`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js:1801-1920`）：

| 路径 | 现有覆盖 |
|------|---------|
| priceDiff > 0 → 待确认收款（线下） | ✅ line 1804-1866 |
| priceDiff = 0 → 已支付 | ❌ 无 |
| priceDiff < 0 → UPSERT prepaid_cards + INSERT card_transactions | ❌ 无 |
| 跨店卡拒绝（CARD_STORE_MISMATCH） | ❌ 无 |
| 已耗尽卡拒绝（remaining_sessions=0 / quantity-picked_up<=0） | ❌ 无 |
| 体验卡单品折抵分支 | ❌ 无（只测了疗程卡） |
| 并发 UPDATE rowCount=0 抛 "卡状态变化，请重试" | ❌ 无 |
| 缺 clientUserId / 空 convertOutSaleItemIds / 空 convertInItems / 非法 paymentMethod / 非店长 | ✅ line 1868-1919 |

**对比 admin**（`fengyu-admin/src/actions/orders.test.ts:846-1184`）：
- 三差额路径全覆盖（line 982-1064）
- 异常路径完整（line 1070-1184 共 5 种错误标签）

**补全清单**（按现有 `order.test.js` 风格补充，预计 +250 行）：
- `priceDiff = 0`：mock `totalOut === totalIn`，断言 `ctx.result.priceDiff === 0` + `status === '已支付'` + `prepaidCardCredit === 0`
- `priceDiff < 0`：mock `totalOut > totalIn`，断言主事务 tx.query 调用序列中包含：
  - INSERT prepaid_cards ... ON CONFLICT (user_id, store_id) DO UPDATE
  - INSERT card_transactions 行包含 `'充值'` + ref_order_id
  - `ctx.result.prepaidCardCredit` 为差额绝对值
- 跨店拒绝：held 行 `store_id !== ctx.auth.storeId` → throws `INVALID_PARAMS.*门店`
- 已耗尽卡拒绝：`remaining_sessions=0` → throws `INVALID_PARAMS.*耗尽`
- 体验卡单品分支：`product_type='单品' AND product_kind='体验卡'` + `(quantity - picked_up_quantity) > 0` 正常折抵
- 并发拒绝：UPDATE `remaining_sessions` rowCount=0 → throws `INVALID_PARAMS.*卡状态变化`

#### P2-2 ❗ `order.customerHeldCards` 零测试

**现状**：`fengyu-staff/cloudfunctions/staffApi/__tests__/` 全目录 grep `customerHeldCards` 零命中。

**对比 admin**：`cards.test.ts` 已覆盖 `getCustomerHeldCards`（跨店 / 已耗尽 / 疗程卡/单品体验卡双分支）。

**补全清单**：在 `order.test.js` 末尾新增 `describe('order.customerHeldCards', ...)`：
- 正常返回（疗程卡 + 体验卡单品 mixed list）
- 跨店卡不出现（`store_id=A`, `ctx.auth.storeId=B`）
- `item_direction != '购买'` 不出现
- `status NOT IN ('已支付','已完成')` 不出现
- `remaining_sessions=0` 的疗程卡不出现
- `quantity - picked_up_quantity = 0` 的体验卡单品不出现
- 权限：beautician 调用 → 拒绝（requireManager）
- `deductibleAmount` 计算正确：疗程卡 = `unit_real_price × remaining_sessions`，体验卡单品 = `unit_real_price × (quantity - picked_up_quantity)`

#### P2-3 ⚠️ `product.shopInit` 的 `isBundle` 字段新增无测试

**现状**：`product.js:67-73` 加了 `bool_or(p.is_bundle)` 聚合返回 `isBundle`，但 `__tests__/routes/product.test.js` 没覆盖这个返回字段。

**补全清单**：
- mock `product_skus` 查询返回带 `is_bundle: true/false` 的行 → 断言 `skuList[i].isBundle` 匹配
- `mallBundleGroups` 分支：bundle 商品关联 `mall_bundle_groups` 有正确 `pickCount` / `skuIds` 返回

---

### 2.3 P3 — 技术债清理（不影响功能，但影响可读性/可维护性）

#### P3-1 🧹 死码：Step 1 空占位（checkoutStep=1）

**现状**：
- `order-create.ts:193` `checkoutStep: 0, // 0=选顾客 1=选类型 2=确认`
- `order-create.wxml:219-222`：
  ```xml
  <!-- Step 1（死码）—— PR-B 废除"选开单模式"；PR-C 将订单类型挪到 Step 2 顶部 -->
  <view wx:if="{{checkoutStep === 1}}" class="checkout-body">
    <!-- intentionally empty -->
  </view>
  ```
- `order-create.ts:663` `onStep0Next` 直接 `setData({ checkoutStep: 2 })`，跳过 Step 1
- 步骤条仍显示"选顾客 → 开单类型 → 确认"三步（`wxml:164-170`），但中间一步永远不会渲染任何内容

**建议修改**：
1. 将步骤条从 3 步简化为 2 步：「选顾客 → 确认订单」
2. 删除 `checkoutStep === 1` 的死码 block（`wxml:219-222`）
3. 保留 `checkoutStep=2` 的编号（避免重命名带来的 git blame 噪声），但在注释中标明"Step 1 历史遗留"

**影响面**：仅影响开单页弹层，无跨页引用，无需 grep 扩散。

---

#### P3-2 ⚠️ Advisory lock key 不一致（极端并发风险）

**现状**：

| 文件 | 锁 key |
|------|--------|
| admin `orders.ts:583` createOrder | `hashtext('sale_order_id_gen')` |
| admin `orders.ts:956` createConversionOrder | `hashtext('sale_order_id_gen')` |
| staff `order.js` create 的 generateOrderNo | `'sale_item_id_gen'`（grep `generateOrderNo` 定义后可确认） |
| staff `order.js:1318` createConversion | `'sale_item_id_gen'` |

两端用不同 key，**advisory lock 不互斥**。极端情况：同一秒 admin 后台店长开一单 + staff 小程序店长开一单，两侧同时查 `MAX(sale_order_id)` 得到同一个序号 → advisory_xact_lock 不互斥 → 主键冲突（PG 唯一约束会拦住一个，但另一端收到 `23505` 错误）。

**修改方案**：
- staff `order.js` 的 `generateOrderNo` + createConversion 的 advisory_xact_lock 统一改为 `hashtext('sale_order_id_gen')`
- 两库都要验证（5433 + 5434），确认云函数与 admin 用同一 key（advisory lock 是 DB 级别的，同库共享）

**验收**：
- 单元测试确认 staff 云函数的 lock key 文本
- 人工并发联调（可选）：admin + staff 同秒发请求，两端都成功落单，订单号 +1 递增无冲突

---

#### P3-3 🧹 saleItemId 命名格式不一致

**现状**：

| 端 | 格式 | 示例 |
|----|------|------|
| admin | `${saleOrderId}-${idx 2位}` | `FY-XSD-WX-2604160001-01` |
| staff | `XSLSH-WX-${YYMMDD}${seq 4位}` | `XSLSH-WX-26041600001` |

**影响**：
- 对账：同一订单的 item 行，admin 侧是 `FY-XSD-WX-XX-01/02/03`，staff 侧是完全不同的独立序号 — 做 join 分析、日志 trace 时体验很差
- 审计：staff 的 XSLSH 序号跨订单递增，看 item 无法直接推断归属订单

**修改方案**（推荐，但**需要业务确认是否愿意改变 staff 历史格式**）：
- staff `order.js:472` 的 `saleItemId` 生成改为 `${saleOrderId}-${String(i+1).padStart(2, '0')}`
- 同步改 createConversion（`order.js:1490,1537`）
- 已存在的历史 `XSLSH-WX-*` 数据不迁移（`memory/feedback_no_legacy_compat.md` 项目无历史兼容包袱，但生产真实流水仍可能存在；**务必与业务确认可否切断旧格式**）
- 相关测试 `order.test.js:597` 有 `expect(ctx.result.saleOrderId).toMatch(/^FY-XSD-WX-/)` — 不涉及 saleItemId 断言，改动无回归
- 前端 grep `XSLSH-WX-` 确认无强依赖该前缀

**替代方案（保守）**：不改，在文档里显式标注"staff/admin item_id 前缀不同，是历史遗留，跨端查询用 `sale_order_id` 关联"。

---

#### P3-4 ⚠️ ConversionPanel 无 race 保护

**现状**：`components/conversion-panel/conversion-panel.ts:89-108`：

```typescript
async loadCards(clientUserId: string) {
  this.setData({ loading: true, errorMsg: '' });
  try {
    const data = await callStaffApi<HeldCardsResponse>('order.customerHeldCards', { clientUserId });
    // ...setData(cards)
  } catch { ... }
}
```

observer 在 `clientUserId` 变化时触发 loadCards；快速切换顾客或切换订单类型 tab 导致 Panel 反复挂载时，**旧请求回包可能覆盖新请求**。

**对比 admin**（`order-create-page.tsx:249-274`）：
```typescript
let cancelled = false
getCustomerHeldCards(...)
  .then((rows) => { if (cancelled) return; setHeldCards(rows) })
return () => { cancelled = true }
```

**修改方案**：
- ConversionPanel 实例级加 `_requestSeq` 计数器
- loadCards 开头 `const seq = ++this._requestSeq`，回包时检查 `if (seq !== this._requestSeq) return`

影响面：单组件内部改动，无对外接口变更。

---

#### P3-5 🧹 错误码风格不统一

**现状**：
- admin `createConversionOrder`（`orders.ts:1126-1138`）用标签式错误码（`CARD_NOT_FOUND` / `CARD_STORE_MISMATCH` / `CARD_OWNER_MISMATCH` / `CARD_DIRECTION_INVALID` / `CARD_ORDER_STATUS_INVALID` / `CARD_EXHAUSTED` / `CARD_TYPE_INVALID` / `CARD_CONCURRENT_CHANGED` / `PREPAID_CARD_UPSERT_FAILED`），在 catch 处翻译为友好中文
- staff `createConversion`（`order.js:1350-1532`）直接 throw `INVALID_PARAMS: 中文描述` 字符串

**影响**：
- 日志聚合/告警：admin 侧可以按 `CARD_STORE_MISMATCH` 这样的稳定字符串聚合，staff 侧要按中文正则匹配
- 国际化：admin 做多语言切文案不影响错误码；staff 混在一起要重构
- 前端 UX：admin 错误统一翻译，staff 把后端中文直接透传给 Toast（当前够用但不稳）

**修改方案**（非紧急）：将 staff createConversion / create 的错误改造为标签式：
```javascript
throw new Error('CARD_STORE_MISMATCH')
// 在 index.js 的全局错误处理器里翻译（或在 staff route 的 catch 封装）
```

**影响面**：staff 云函数错误处理器 + 前端 Toast 展示逻辑都要同步改。**建议单独开 ticket，不强求本次完成**。

---

### 2.4 P4 — 可选优化（非必须，记录备查）

#### P4-1 staff `order.create` 的 `saleOrderType` 白名单

**现状**（`order.js:201-203`）：仅接受 `['销售单','内部单']`。

**对比 admin**：`createOrder` 签名接受 5 值（`'销售单' | '内部单' | '回款单' | '转换单' | '退款单'`），但 UI 只暴露 3 个，其他类型由订单详情页二级操作（如退款）创建。

**评估**：
- 当前 staff create 的白名单是防御性设计（转换单走 createConversion / 回款单走 createRepayment / 退款单走 createRefund，都有独立路由）
- 不算差异，属于"各自端的 API 契约边界"

不建议动。

#### P4-2 admin createOrder 未守卫"内部单禁 saleAmount 手工改价"

**现状**：admin 前端用 `suppressOverride` 禁用输入（`order-create-page.tsx:383,861`），但 Server Action `createOrder`（`orders.ts:460-476`）只 ×0.5 了 saleAmount/received，**没有拒绝**内部单携带 saleAmount 的请求。

理论上若绕过前端直接 POST `{saleOrderType:'内部单', items:[{saleAmount:'0.01'}]}` 可以任意改价。但攻击者还需要有 `sale_order:create` 权限，可接受。

**这是 admin 的潜在瑕疵，不是 staff 的问题**。staff 已在云函数补了拒 customPrice（`order.js:211-216`），反而比 admin 严格。

记录给 admin 后续补。

#### P4-3 staff 不支持 manualPhone 开单场景下的完整信息快照

admin 支持"未搜到顾客时以手机号直接开单"（`manualPhone`，`order-create-page.tsx:119,526-540`），staff `customer.search` 查不到时前端也给 `customerInfo = {id:'', name:'', phone}` 兜底（`order-create.ts:640-641`），但：
- staff 转换单明确 disabled（未注册顾客 `customerInfo.id=''` 时 `order-type-card--disabled`），与 admin 行为一致 ✅
- staff 销售/内部单在 manualPhone 场景下会把 `customerName = phone`（`order-create.ts:877: customerInfo.name || customerInfo.phone`）— admin 同样兜底 `selectedCustomer?.name?.trim() || manualPhone.trim() || (selectedCustomer?.phone ?? '')` ✅

无需改。

---

## 3 实施计划（按 PR 拆分）

### PR-D1：修 paymentMethod 硬编码 + 补白名单守卫（P1）

| # | 任务 | 文件 |
|---|------|------|
| D1.1 | 前端加 `paymentMethod` state + UI（Step 2 结算栏下拉 `微信/线下`，转换单保持 ConversionPanel 内部 picker） | `order-create.ts` + `order-create.wxml` |
| D1.2 | `order-create.ts:878` 改用 state 替换硬编码 `'微信'` | 同上 |
| D1.3 | 云函数 `order.js:192-194` 补白名单 `if (!['微信','线下'].includes(paymentMethod)) throw` | `order.js` |
| D1.4 | 测试：`order.test.js` 新增 "支付方式=线下 → status=待确认收款" + "非法支付方式拒绝" | `order.test.js` |
| D1.5 | （若业务确认支持支付宝）放开白名单为 `['微信','支付宝','线下']` + UI 加支付宝选项 + ConversionPanel 加 | 同上 |

### PR-D2：补测试覆盖（P2）

| # | 任务 | 文件 |
|---|------|------|
| D2.1 | `createConversion` 差额=0 路径（`status='已支付'` + `prepaidCardCredit=0`） | `order.test.js:1920+` |
| D2.2 | `createConversion` 差额<0 路径（断言 UPSERT prepaid_cards + INSERT card_transactions + `prepaidCardCredit>0`） | 同上 |
| D2.3 | `createConversion` 跨店拒绝 / 已耗尽拒绝 / 并发拒绝 | 同上 |
| D2.4 | `createConversion` 体验卡单品折抵分支（`product_type='单品' AND product_kind='体验卡'`） | 同上 |
| D2.5 | 新增 `describe('order.customerHeldCards')` 覆盖正常/跨店/已耗尽/权限 | 同上 |
| D2.6 | `product.shopInit` 返回 `isBundle` 字段 + `mallBundleGroups` 聚合测试 | `product.test.js` |

### PR-D3：技术债清理（P3）

| # | 任务 | 文件 |
|---|------|------|
| D3.1 | 清理 Step 1 死码 + 步骤条简化为 2 步 | `order-create.wxml:164-222`, `order-create.ts:193,663` |
| D3.2 | advisory lock key 统一为 `'sale_order_id_gen'` | `order.js` 的 generateOrderNo + createConversion |
| D3.3 | ConversionPanel 加 `_requestSeq` race 保护 | `components/conversion-panel/conversion-panel.ts` |
| D3.4 | （**需业务确认**）saleItemId 格式切换为 `${saleOrderId}-${idx2}` | `order.js:472,1490,1537` |
| D3.5 | （单独 ticket，不在本轮）错误码标签化 | `order.js` + `index.js` 全局错误处理 |

---

## 4 验收清单

### P1 验收
1. staff 开单页 Step 2 能切"微信 / 线下"支付方式；销售单 + 线下 → 云函数返回 `status='待确认收款'`
2. 转换单差额>0 仍能在 ConversionPanel 内选支付方式（与 admin 对齐）
3. 云函数 `order.create` / `createConversion` 白名单拒绝非法 paymentMethod

### P2 验收
4. `bun test fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` 通过，新增 7+ 个 test case（差额=0/<0、跨店、已耗尽、并发、体验卡单品、customerHeldCards 全套）
5. 覆盖率报告：`createConversion` 分支覆盖从当前（仅差额>0）提升到 ≥90%

### P3 验收
6. 死码 Step 1 空占位移除后 Step0Next → 直跳 Step2 体验不变；步骤条显示 2 步
7. staff 云函数的 advisory_xact_lock 所有 key 为 `'sale_order_id_gen'`（grep 验证）
8. ConversionPanel 快速切换 `clientUserId` 时不会出现旧请求覆盖新请求（手工验证 + 可选 unit test）
9. （若 D3.4 落地）新生成的 sale_item 流水号符合 `^FY-XSD-WX-\d{10}-\d{2}$` 正则

### 一致性验收
10. 在同一门店用同一顾客 X，分别用 staff 开"转换单 负差额 ¥100" 和 admin 开"转换单 负差额 ¥200" → `prepaid_cards.balance` 累加为 ¥300，`card_transactions` 2 条，两条的 `ref_order_id` 都指向对应订单
11. `cd fengyu-admin && bun run build` 通过 + `cd fengyu-staff/miniprogram` 无 TS 红
12. admin / staff 两端开单后订单号序列连续递增（`FY-XSD-WX-2604160001 / 0002 / 0003 ...` 不跳号不冲突）

---

## 5 风险与决策点

| 风险 / 决策 | 处理 |
|---|---|
| **"业务是否要 staff 支持支付宝"** | PR-D1 前先确认；不支持则注释标注为"有意差异" |
| saleItemId 格式切换影响存量对账报表 | D3.4 实施前先确认：① 有没有"按 XSLSH-WX- 前缀筛 staff 渠道订单"的财务报表；② 存量 sale_items 不改，只改新增；③ 与财务/对账方确认 |
| 修 advisory lock key 需跑 5433 + 5434 双库验证 | 两库都有 PG advisory_xact_lock（DB 实例级别），只要云函数代码一致即可；无需 migration |
| 清死码影响 UI 单测 | staff 端前端无单测基建，影响仅限人工回归 |
| ConversionPanel race 保护 | 纯组件内改动，不影响外部 API |
| P2 测试补全的 mock 复杂度 | 参考现有 `test('创建转换单成功（差额>0 → 待确认收款）'` 的 mock 模式，按 pg.transaction.mockImplementationOnce 链式 vi.fn() 响应序列复用 |
| admin saleAmount 未守卫（P4-2） | 记录给 admin 后续补，不在本 ticket 范围 |

---

## 6 前置依赖与环境

- staff 云函数当前工作流（`fengyu-staff/cloudfunctions/staffApi/CLAUDE.md`）
- 本 ticket **不改 schema**，无 migration
- 云函数部署走 `/cloudbase-deploy` skill（`memory/project_cloudbase_envvar_risk.md`：禁用 `tcb fn deploy --force`）
- staff 前端用微信开发者工具打开 `fengyu-staff/miniprogram/`
- 测试：`cd fengyu-staff/cloudfunctions/staffApi && bun test routes/order`（Vitest，项目已有基建）
- PR-D1 / PR-D2 / PR-D3 可并行开发（无相互依赖）；可独立 merge

---

## 7 相关引用

### admin 基准
- 页面：`fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx`（1264 行）
- 子组件：`fengyu-admin/src/app/(main)/orders/_components/order-create/{bundle-picker,normal-sku-picker,trial-card-picker,prepaid-card-picker,conversion-panel}.tsx`
- Server Action：`fengyu-admin/src/actions/orders.ts`（1259 行，createOrder:421 / createConversionOrder:745）
- Server Action：`fengyu-admin/src/actions/cards.ts:238`（`getCustomerHeldCards`）
- Server Action：`fengyu-admin/src/actions/products.ts`（`getProductsByKind` / 组合套餐分支）
- 测试：`fengyu-admin/src/actions/orders.test.ts:846-1184`（createConversionOrder 三路径 + 异常）

### staff 现状
- 页面：`fengyu-staff/miniprogram/pages/order-create/order-create.ts`（1003 行）+ `order-create.wxml`（450 行）
- 子组件：`fengyu-staff/miniprogram/components/bundle-picker/` + `conversion-panel/`
- 云函数：`fengyu-staff/cloudfunctions/staffApi/routes/order.js`（1778 行，create:165 / createConversion:1279 / customerHeldCards:1607）
- 云函数：`fengyu-staff/cloudfunctions/staffApi/routes/product.js:67-176`（shopInit 返 isBundle + mallBundleGroups）
- 云函数路由：`fengyu-staff/cloudfunctions/staffApi/index.js:67-68`
- 测试：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js`（1-1944 行）

### Schema
- `db/schema/order.ts`（saleOrders / saleItems）
- `db/schema/product.ts`（products / productSkus / productCategories / mallBundleGroups / mallProductSkus）
- `db/schema/prepaid-card.ts`（prepaidCards / cardTransactions）
- `db/schema/enums.ts:3,17,21`（productKind / saleOrderType / itemDirection）

### 设计基线
- `.42cog/cog.md`（"卡包"实体、"转换单"业务流程）
- `.42cog/pm/admin.pr.spec.md` / `staff.pr.spec.md`
- `memory/feedback_no_legacy_compat.md`（无历史兼容包袱）
- `memory/project_cloudbase_envvar_risk.md`（云函数部署）

### 前置 ticket
- [2026-04-16-admin-order-create-flow-revamp.md](2026-04-16-admin-order-create-flow-revamp.md)（admin 基准方案，已完成）
- [2026-04-16-staff-order-create-flow-revamp.md](2026-04-16-staff-order-create-flow-revamp.md)（staff 重构计划，**主体已落地，细节由本 ticket 收尾**）

---

## 8 一句话总结

> staff 开单已经跟着 admin 走到了 PR-C 完成状态，剩下的差异是 **3 项 P1 业务 gap（paymentMethod 硬编码 + 支付宝决策）**、**3 项 P2 测试缺口（差额=0/<0/customerHeldCards）**、**5 项 P3 技术债（死码 / lock key / saleItemId 格式 / race 保护 / 错误码风格）**。按 3 个 PR 串行（D1 业务 → D2 测试 → D3 债务）即可全部闭环。
