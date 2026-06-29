---
type: fix
number: "004"
date: 2026-06-29
title: staff 开单确认页补疗程卡规定次数 + 二维码页充值卡单/转换单金额误显 0
tags: [staff, order-create, order-qrcode, staffApi, cloudfunction, ui]
related: []
---

# fix/004 staff 开单确认页补疗程卡规定次数 + 二维码页金额误显 0

> 关联 GitHub issue #26「staff 端的显示问题」子项 2、4（第一批；子项 3 转换单布局重构另记 fix/005，子项 1 会员价展示 dev 已实现待发版）。

## 事件概述

- 发现时间：2026-06-29（issue #26 上报）
- 影响范围：staff 端开单确认订单页（疗程卡次数展示缺失）、staff 端订单二维码页（充值卡单/转换单金额显示为 ¥0）
- 严重程度：中（前者信息缺失，后者误导顾客/店长以为无需付款，订单卡死无法结清）

## 根因分析

### 子项 2 — 确认页未显示疗程卡规定次数

`pages/order-create/order-create.wxml` 的确认步骤（`checkoutStep===2`）商品明细区，销售单/内部单、寄存单两种分支都从未渲染 `item.sessionCount`。该字段早已存在于 `CartItem.sessionCount`（`order-create.ts:42`，= DB `product_skus.session_count` 单卡总次数，数据就绪），仅是 wxml 漏展示。

### 子项 4 — 二维码页金额为 0

`staffApi/routes/order.js` 的 `qrcode()` 待支付（首付）分支计算 `actualPayable = Σ sale_items.pending_received − 储值卡抵扣`：

- **充值卡单**（`card.recharge`，`sale_order_type='充值单'`）：插入 **0 行 sale_items** → `sumItemReal=0` → 显示 ¥0（实际欠 `payable_amount`=充值实付）。
- **转换单**：sale_items INSERT 未写 `pending_received`，而该列是 `NOT NULL DEFAULT 0`（`db/schema/order.ts:244`）→ 原回退条件 `pending_received != null ? … : sale_amount` 的 `!= null` **永真**，回退到 `sale_amount` 的兜底**永不触发** → `sumItemReal=0` → 即使 `priceDiff>0` 真实补差也显示 ¥0。

根因是「逐行 pending_received 口径」只适用于两步式开单的普通销售单/内部单（received=0，pending_received 是逐行实付草稿），不适用于不写 pending_received 的充值卡单/转换单。

## 修复方案

### 子项 2 — wxml 补疗程卡规定次数行

在销售单/内部单与寄存单的 `confirm-item-header` 后插入（仅次数卡显示，复用购物车弹层 L211 的 `sessionCount+'次'` 拼法）：

```xml
<view wx:if="{{item.productType === '疗程卡' && item.sessionCount > 0}}" class="confirm-item-row">
  <text class="confirm-item-label">规定次数</text>
  <text class="confirm-item-value">{{item.sessionCount}} 次</text>
</view>
```

`productType === '疗程卡'` 判定次数卡（与 conversion-panel L40、购物车弹层一致）；`sessionCount > 0` 为纯比较（wxml `{{}}` 禁方法调用，合规）。转换单的次数展示随 fix/005 的商品明细一起补。

### 子项 4 — qrcode 按订单类型特判取 payable_amount

待支付分支新增 `充值单`/`转换单` 特判，直接取订单应付金额；销售单/内部单/寄存单维持逐行 pending_received 口径（寄存单创建即「已支付」不会走到此路径，销售单/内部单实付 0 时 actualPayable=0 是正确语义，不能用 payable_amount 替换）：

```js
} else if (order.sale_order_type === '充值单' || order.sale_order_type === '转换单') {
  // payable_amount 已扣储值卡；缺失（历史数据）时回退 total−储值卡，与部分支付分支对称，避免静默 ¥0
  const payable = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
  actualPayable = Math.max(0, Math.round(payable * 100) / 100)
} else { /* 销售单/内部单/寄存单：Σ pending_received − 储值卡（原逻辑不变）*/ }
```

部分支付（回款）分支用订单级 `payable_amount − netReceived`，各类通用，未改。

### 明确不改

- **未改用「数据驱动回退」**（sumItemReal=0 时一律回退 payable_amount）：会破坏销售单/内部单「店长填实付 0 = 不扫码付款」的正确语义。类型特判是正确深度。
- **跨端**：`order.qrcode` 是 staffApi 独有 action；admin 的二维码弹窗只展示小程序码图片不计算金额，client 无同口径副本，无需同步。

## 验证

- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` 新增 3 个回归用例（充值卡单 payable_amount=500、转换单 pending_received=0 payable_amount=150、充值卡单 payable_amount 缺失回退 total=800），连同原 8 个 `order.qrcode` 用例共 11 passed。
- 全量 `order.test.js` 138 passed / 0 failed（无回归）。
- 真机验证（wxml，不进自动门禁）：开发者工具打开 `fengyu-staff/miniprogram/`，开单走销售单/内部单/寄存单确认页看疗程卡次数；充值卡单、转换单（priceDiff>0）提交后跳二维码页看金额非 0。

## 部署

- 云函数（子项 4）：`scripts/use-env.sh <env>` → `scripts/deploy-cloudfunctions.sh`（先 dev 验证再 prod）。
- 前端（子项 2）：staff 小程序发版。

## 预防措施

- `order.qrcode` 已纳入单测守护，新增订单类型若不写 pending_received 需在此特判分支补字面量（或确保创建路径写 payable_amount）。
- 后续若新增 sale_order_type，复查其 sale_items / pending_received / payable_amount 写入口径是否与 qrcode 假设一致。
