---
type: fix
number: "002"
date: 2026-06-06
title: 优惠券全额抵扣（应付实金为 0）订单卡在「待支付」死循环
tags: [order, coupon, payment, prepaid-card, client, staff]
related: ["arch/006"]
---

# fix/002 优惠券全额抵扣（应付实金为 0）订单卡在「待支付」死循环

## 事件概述

- 发现时间：2026-06-05（用户上报，staff 端开单支付环节）
- 影响范围：clientApi（顾客自助下单）+ staffApi（店长开单）两端 `order.create`；凡"优惠券把应付实金抵到 0、且无储值卡"的订单
- 严重程度：高（订单无法推进、顾客端 UI 死循环、店长端展示无意义收款二维码）

## 现象

顾客用优惠券全额抵扣（如招牌体验券 −¥298 抵掉 ¥298 服务）下单后，订单卡在「待支付」：

- **顾客端**：点「去支付」→ 无法发起 0 元微信支付 → 回到待支付页，两个界面来回循环
- **店长端**：看到收款二维码「请顾客扫码完成支付」，但 0 元无款可付，永远不会变「已支付」

生产库（5433/fengyu_wxapp）问题单 `FY-XSD-WX-2605300004`：
`total_amount=0`、`payable_amount=0`、`prepaid_card_amount=0`、`payment_method='无'`、
`coupon_discount=298`、`opened_by` 为空（顾客自助）、`sale_items.paid_sessions=1`、无 payments 流水、
现为「已关闭」（用户最后手动取消）。

## 根因分析

两端 `order.create` 只对**「储值卡全额抵扣」**做了"创建即结清 → 已支付"特判，
**漏了「优惠券全额抵扣（应付实金 = 0 但无储值卡）」**：

- clientApi：`prepaidFullPaid = paidAmount === 0 && prepaidCardAmount > 0` → 券全额时 `prepaidCardAmount=0` → false → 落「待支付」
- staffApi：`isFullCardCoverage = payableAmount === 0 && prepaidCardAmount > 0` → 同理 → 落「待支付」

而应付实金为 0 时：① 0 元发不起微信/支付宝线上支付；② `payment_method='无'` 走不了店长 `confirmOffline`。
两条转「已支付」的通道都不通 → 永久卡死。

## 修复方案

把两端"全额储值卡抵扣"的判定布尔**泛化为"应付实金 = 0（zeroPayable）"**，
**扣卡动作仍仅在有储值卡时执行**（券全额单不写 amount=0 的 `储值卡抵扣` 流水，否则违 `chk_sop_amount_sign`）。

### clientApi `order.create`
- 新增 `zeroPayable = paidAmount === 0`（券/卡/二者叠加抵到 0 都命中）
- `initialStatus / initialReceived / paid_at` 由 `prepaidFullPaid` 泛化为 `zeroPayable`
- **扣卡块保持 `if (prepaidFullPaid)`**（= `zeroPayable && card>0`），券全额单跳过扣卡
- 零应付单就地补结算：`settlePointsSafe`（链净额=0 无写入）+ `recalcMemberLevel`
- 返回 `reason: card>0 ? 'prepaid_card_full' : 'coupon_full'`（保留老前端兼容）

### staffApi `order.create`（对称）
- 新增 `zeroPayable = payableAmount === 0`
- `effectivePaymentMethod / initialStatus / receivedColumn / paidAtValue / resolvedStatus` 泛化为 `zeroPayable`
- **扣卡 + paid_sessions recalc 保持 `if (isFullCardCoverage)`**（券全额走 per-item 摊次，`sale_amount<=0` 兜底 = `session_count`）
- 结算 `settlePaidByCardAtCreation` 改 `if (zeroPayable)`（券全额 `receivedAmount=0` → 积分净额=0、`grantShareGift` 自带 `paid>0` 门控跳过）

### 前端（仅文案，无功能改动）
两端前端原本已按 `status === '已支付'` 跳详情/Toast、不唤起支付，故返回 `'已支付'` 即修复死循环。
顺手把结清 Toast 按「有无储值卡」区分券/卡文案；client checkout 短路条件补 `reason==='coupon_full'`。

## 验证

- 新增 clientApi L1 回归用例「券全额抵扣 → 已支付 + reason=coupon_full + 不扣卡 + 不写 amount=0 流水」（通过）
- 既有「用卡全抵」用例仍 `已支付` + 扣卡流水（card 路径未回归）
- 跨端 `cross-end-sql-snapshot`(111) / `cross-end-error-codes-snapshot`(13) / `paid-sessions`(17) 全绿（本次只改 JS 分支条件，未触碰被守护 SQL 字面）

## 生产数据现状

当前 `status='待支付' AND payable_amount=0 AND prepaid_card_amount=0` 的卡死单数量 = **0**
（历史 3 张零元券单均被用户手动关闭，终态不复活）。**无需数据修复脚本。**

## 预防措施

- [ ] 部署 clientApi + staffApi 两端云函数后生效（staffApi 须切 staff 子账号）
- [ ] 后续若新增"非现金抵扣通道"（如积分抵扣），判定一律走"应付实金=0"而非具体抵扣手段，避免重蹈"只判某一种抵扣"的覆辙
