---
type: fix
number: "005"
date: 2026-06-29
title: staff 转换单确认页对齐销售单（补商品明细/活动勾选/支付方式卡片+支付宝）
tags: [staff, order-create, conversion-panel, component, cloudfunction, ui]
related: ["fix/004"]
---

# fix/005 staff 转换单确认页对齐销售单/内部单（方案 B 折中）

> 关联 GitHub issue #26「staff 端的显示问题」子项 3（第二批；子项 2/4 见 fix/004，子项 1 会员价 dev 已实现待发版）。

## 事件概述

- 发现时间：2026-06-29（issue #26 子项 3）
- 影响范围：staff 端开单-确认订单页的转换单分支
- 严重程度：中（转换单确认页体验与销售单/内部单割裂：转入商品清单不可见、无活动勾选、支付方式只有微信/线下 2 选 1 且用 picker 样式不一致、缺支付宝）

## 根因分析

转换单确认页用独立的 `conversion-panel` 子组件接管整个内容区（`order-create.wxml` L361-368），其设计目标是「折抵卡选择 + 差额汇总」，因此**完全跳过了销售单/内部单 else 分支的完整链路**（confirm-items 商品明细 → activity-section → prepaid-card-section → order-type-cards 3 卡片支付方式）。子组件内部把充值卡抵扣/支付方式按「补差额」场景内化（仅 `priceDiff>0` 时出现），且支付方式用 `van-picker`（微信/线下 2 选 1，**缺支付宝**），完全无商品明细、无活动勾选。

## 修复方案（方案 B 折中）

保留 `conversion-panel` 管折抵卡选择的核心职责，在其**内部**补齐缺失项 + 支付/抵扣样式对齐销售单：

1. **转入商品明细**：组件 properties 加 `cartItems`（主页传 `cart`），wxml 顶部渲染 `confirm-items`（名称/spec/价格 + 疗程卡规定次数 + 转入合计），对齐销售单。
2. **活动勾选**：组件 data 加 `isActivity`（自管），末尾 `activity-section` van-switch，经 `change` 事件单向上报主页 `conversionIsActivity`。
3. **支付方式**：`van-picker` → `order-type-cards` 3 卡片组（微信/支付宝/线下），对齐销售单样式；新增 `onPaymentMethodTap`（读 `dataset.method` 白名单校验）。
4. **充值卡抵扣**：从 `conv-summary` 内的行改为独立 `prepaid-card-section` 块，对齐销售单。
5. **样式渗透**：组件 json 设 `styleIsolation: apply-shared`，让 `order-create.wxss` 的 `confirm-item-*`/`order-type-card*`/`prepaid-card-*`/`activity-*` 类单向渗透到组件，避免拷贝重复样式。

### 云函数 createConversion

- payment_method 白名单加 `'支付宝'`（L2824）：支付宝链路（clientApi `order.alipayPay` + payNotify）按 `sale_order_id` 无差别处理，转换单可走。
- INSERT sale_orders 补 `is_activity` 列 + `$19` 占位 + 参数 `isActivity === true`（原 23 列 23 值 → 24 列 24 值，对齐 order.create）。
- 解构补 `isActivity`。

### 主页 order-create

- data 加 `conversionIsActivity`（与销售/内部单 `isActivity` 独立，避免串扰）；3 处 reset + `onSelectSaleOrderType` 切出转换单时清空。
- `onConversionPanelChange` 汇聚 `isActivity`；`_submitConversion` payload 带 `isActivity`、paymentMethod 类型扩支付宝、Toast 文案改为 `paymentMethod === '线下'` 判断（微信/支付宝走线上扫码文案）。

### 明确不改

- **未把 conversion-panel 逻辑搬回主页**（方案 A）：会破坏转换单折抵卡选择的核心流程，且需重构组件职责 + 提交链路，风险高。方案 B 保留组件边界。
- **priceDiff<=0 分支**：抵扣区/支付卡片组全程 `wx:if="{{priceDiff > 0}}"` 守护，`isActivity` 仍正常上报写入，不破坏「差额<0 充入储值卡」逻辑。

## 验证

- TS 类型检查：`npx tsc --noEmit`（fengyu-staff/miniprogram）order-create.ts / conversion-panel.ts 无错误。
- 云函数：全量 `order.test.js` 136 passed / 0 failed（createConversion 主流程测试含 INSERT mock 隐式覆盖 is_activity 参数对齐；支付宝走与微信同代码路径，靠真机端到端验证）。
- 真机验证（wxml 重构，不进自动门禁）：开发者工具打开 `fengyu-staff/miniprogram/`，转换单确认页看转入商品明细 + 疗程卡次数 + 活动勾选 + 3 卡片支付方式（含支付宝）；priceDiff>0 选支付宝→顾客 alipayPay→回调结清；priceDiff<=0 仍「充入储值卡」。

## 部署

- 云函数：`scripts/use-env.sh <env>` → `scripts/deploy-cloudfunctions.sh`（先 dev 再 prod）。
- 前端：staff 小程序发版。

## 预防措施

- 转换单确认页现已与销售单/内部单共用样式类（经 apply-shared），后续销售单明细样式调整自动同步到组件（结构 wxml 仍需手动同步）。
- 新增 sale_order_type 若需在确认页展示，参考转换单的「组件内补齐 + apply-shared」模式。
- 索引注意：本批与 fix/004 同日追加 fix 索引行，合并时若冲突需保留 004+005 两行。
