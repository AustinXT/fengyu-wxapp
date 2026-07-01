---
type: fix
number: "008"
date: 2026-06-30
title: client 支付完成后订单状态不更新（拉卡拉回调偶发丢失无补偿 + 前端跳转不等回调 + 详情页频闪）
tags: [client, clientApi, payNotify, order, lakala, payment, cloudfunction]
related: []
---

# fix/008 client 支付完成订单状态不更新 + 详情页频闪

> 关联 GitHub issue #37「client 小程序端完成支付后，没有更新订单的状态（仍待支付），但用户已经完成支付、钱已扣；完成支付回到订单详情页会出现频闪」。实例订单 FY-XSD-WX-2606300001。

## 事件概述

顾客端扫码支付 / 订单详情页回款，微信 / 支付宝完成支付后，订单详情仍显示「待支付」，但款项已扣。回到详情页还出现频闪。

生产库普查（近 14 天）证明 payNotify 回调链路整体健康：10 单 `已支付 + received>0` 正常到账、5 单正常超时关闭；**仅 FY-XSD-WX-2606300001 这 1 笔** `lakala_out_order_no` 在（下单成功）、`received=0`、`sale_order_payments` 0 条流水——回调丢失，订单永久卡死。

## 根因分析

1. **回调偶发丢失 + 零补偿**（严重 · 偶发）：payNotify 异步回调天生非 100% 可靠（冷启动 / PG 瞬断 / 验签瞬态失败 / 网络抖动），系统却把它当成订单状态的唯一真理来源，丢失即「钱扣了订单待支付」。`order.queryLakalaStatus` 接口已存在却**前端零调用**，无主动对账、无定时补偿。
2. **前端支付成功立即跳转**（体验 · 必现）：`wx.requestPayment` 成功后 `scan-pay.ts` 6 处直接 `redirectTo`，不等回调（拉卡拉服务商回调典型延迟 2–5s），跳转瞬间必显示待支付；`order-detail.ts` 回款路径只 `setTimeout(loadDetail, 1200)` 查一次。
3. **详情页频闪**：`order-detail` 待支付时 `startCountdown` 每秒 `setData({countdown})`，叠加「付完款还卡在待支付」造成频闪观感。

## 修复方案

核心思路：**主动对账取代纯被动等回调**。

### A. 核心修复
- **clientApi 新增 `order.confirmPayment`**（`routes/order.js`，以 `queryLakalaStatus` 为模板）：查本地订单 → `resolveLakalaMerchant` + `lakalaClient.queryTrade` 查拉卡拉真实状态 → `tradeState==='SUCCESS'` 且本地待支付/部分支付时 `cloud.callFunction({name:'payNotify'})` 触发**与回调同款的幂等入账**（payNotify 的 `uq_sop_txn` / `uq_sop_first_payment` / CAS 守卫兜底重复入账），重查返回最新 status。全程 try/catch 降级返回本地 status（queryTrade / callFunction 失败不 throw，前端继续轮询）。对账决策抽成纯函数 `decideReconcile(localStatus, hasLakalaOrder, tradeState) → 'skip'|'wait'|'reconcile'`。**不凭前端入参入账，必先 queryTrade 验证**。
- **前端 `utils/payment-poll.ts`**：`pollPaymentConfirm` 递归 `setTimeout` 轮询 `order.confirmPayment`（1.5s 间隔 / 15s 上限），终止于已支付/部分支付、`no_lakala_order`/`terminal`（无需对账）或超时；返回 `{promise, clear}` 供 `onUnload/onHide` 清理防泄漏。
- **`scan-pay.ts`**：微信首付 / 回款微信成功 / 支付宝吱口令完成（`onAlipayShareDone`）改为 `confirmAndRedirect`（轮询确认再跳转，超时带 `?paid=1` 跳详情页兜底）；全额储值卡 / 线下 / 后端短路仍即时跳转（不轮询）。
- **`order-detail.ts`**：读 `?paid=1` 触发 `confirmAndRefresh` 兜底轮询；回款微信 / 支付宝成功改轮询确认；`confirmAndRefresh` 期间停 `startCountdown` + 置 `confirmingPayment=true`（隐藏倒计时防频闪）；补 `onHide` 清理轮询。
- **wxml/wxss**：`confirmingPayment` 时显示「支付结果确认中…」（品牌色 + 轻脉冲），替代倒计时区。

### B. 后端定时补偿（彻底兜底）
- **`payNotify/index.js` 新增 `runPaymentReconcile`**（CloudBase Timer 入口，复用现有每分钟 cron）：扫「`lakala_out_order_no` 非空 + `received=0` + 待支付/部分支付 + 90s~30min」的订单，逐单 `queryTrade`，SUCCESS 则 `cloud.callFunction({name:'payNotify'})` 自调 main（event 入口）触发幂等入账。窗口 90s 下界给正常回调留时间，30min 上界停止避免无限扫。`payNotify/utils/lakala-client.js` 为独立副本（与 clientApi 同源，no-shared-cloudfunctions）。
- main Timer 分流：`await runShippingBackfill(); return await runPaymentReconcile()`（两任务幂等互不干扰）。main 业务逻辑零改动（自调复用，降回归风险）。

A 覆盖「用户在线」，B 覆盖「用户付款后长时间不回订单页」；两者最终都走 payNotify 幂等入账，重复安全。

## 预防措施

- 异步回调不能作为资金状态的唯一真理来源，必须配「主动对账 + 定时补偿」双保险（本 PR 落地）。
- 前端支付成功后必须轮询确认订单状态再展示终态，不得跳过回调窗口立即跳转。
- `order.queryLakalaStatus` 这类「已写好但前端零调用」的兜底接口应纳入产品链路（本 PR 由 `confirmPayment` 承担实际补偿入账，比只读的 queryLakalaStatus 更进一步）。
- 测试覆盖：clientApi `confirmPayment` 6 用例 + `decideReconcile` 4 分支（含越权 / 终态跳过 / 非 SUCCESS 等待 / callFunction 失败降级）；payNotify `runPaymentReconcile` 8 用例（含 disabled / SUCCESS 入账 / 非 SUCCESS skip / 商户未配 / 异常隔离）；`scripts/verify-issue-37.mjs` red-green 守护 decideReconcile 决策。
