---
type: fix
number: "006"
date: 2026-06-29
title: staff 开单页商品列表无条件展示划线标价+会员价（修正 #26 子项1 前轮误判）
tags: [staff, order-create, member-price, ui]
related: ["fix/004", "fix/005"]
---

# fix/006 staff 开单页商品列表无条件展示划线标价 + 会员价

> 关联 GitHub issue #26 子项 1。**更正前轮结论**：fix/004 处理时曾判定子项 1「dev 已实现待发版」，**该判断错误**——`price-dual` 双行 wxml 代码虽存在，但驱动它的 `specialPrice` 依赖 `isMember`，未选/非会员顾客时退化为单行，故用户「还是没看到双行」。本 PR 真正修复。

## 事件概述

- 发现时间：2026-06-29（用户反馈「还是没有按标价(划线)+会员价展示」）
- 影响范围：staff 端开单页普通商品列表、体验卡列表、购物车弹层（三处价格展示）
- 严重程度：中（核心营销信息在多数开单场景下不可见）

## 根因分析

`pages/order-create/order-create.ts` 的 `skuToDisplay`：

```ts
const useSpecial = isMember && special != null && special < list;
return { price: useSpecial ? special : list, specialPrice: useSpecial ? special : null, ... }
```

`specialPrice`（wxml 双行展示的驱动字段）用 `useSpecial`（含 `isMember`）→ **非会员或未选顾客时 `specialPrice=null`** → wxml 三处 `wx:if="{{item.specialPrice != null}}"` 落入 else 单行标价分支。

三处展示共用同一字段：体验卡列表（wxml L53-65）、普通商品列表（L156-167）、购物车弹层（L208-218）。`CartItem.specialPrice` 从 `DisplayItem` 复制，故根因统一在 `skuToDisplay`。

## 修复方案（一处改动，三处展示受益）

`specialPrice`（展示）与 `isMember` 解耦；`price`（计价）保持按身份：

```ts
const hasSpecial = special != null && special < list;
const useSpecial = isMember && hasSpecial;          // 计价：会员才享会员价
return {
  price: useSpecial ? special : list,               // 计价按身份（不变）
  specialPrice: hasSpecial ? special : null,        // 展示：有会员价即双行（解耦 isMember）← 实质改动
  ...
}
```

- **展示**：只要 SKU 存在会员价且 < 标价，三处始终双行（划线标价 + 会员价），**不论当前顾客是否会员**。`refreshForCustomer`（选/换顾客重算）走同一逻辑，故切任何顾客都保持双行。
- **计价**：`price`/`priceLine` + 云函数 `order.create` 定价保持按会员身份，`special_price` 仍会员专享（记忆 `project_member_price_split_special`）。

## 产品决策（用户拍板）

- ① **计价按身份**：非会员按划线标价收、会员按会员价。非会员列表看到会员价但加购/确认页/二维码按标价收——展示与计价对非会员不一致，系用户明确决策（营销展示目的）。
- ② **纯价格双行**：不加「会员价」文字标签，wxml 双行结构不动。

## 明确不改

- **计价层**：`price`、云函数定价、`special_price` 口径全部保持。
- **wxml**：双行结构已就位，不动。
- **client 端**：用户只说 staff 开单页；client 商城走另一套 `<wxs>` 分流（不同场景），不改。

## 验证

- TS：`npx tsc --noEmit`（fengyu-staff/miniprogram）order-create.ts 无错误。
- 真机（wxml 展示，不进自动门禁）：开发者工具 staff 开单页，**未选顾客 / 选非会员顾客 / 选会员顾客** 三种态，普通商品 + 体验卡列表都显示双行（划线标价 + 会员价）；购物车弹层单价双行；确认页 + 二维码页金额按身份（会员=会员价、非会员=标价）。

## 部署

仅前端（order-create.ts），无云函数/DB 改动。staff 小程序发版。

## 预防措施

- 商品列表价格展示统一由 `skuToDisplay` 的 `specialPrice`/`price` 驱动，新增展示位直接读这两个字段。
- 「展示」与「计价」字段分离后，后续若调整会员价展示策略，只动 `specialPrice` 计算即可，不影响计价口径。
