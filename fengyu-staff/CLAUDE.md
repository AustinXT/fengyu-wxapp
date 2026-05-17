# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

员工端小程序（B端），包含前端和云函数。

## 基本信息

- **appid**: `wxe3f5d9ee6a94d22d`
- **CloudBase envId**: `cloud1-9g3ydpg512eecc99`
- **云函数**: staffApi（API 网关）

## 开发者工具

微信开发者工具打开 **`fengyu-staff/miniprogram/`**（注意：project.config.json 在 miniprogram/ 内，不是父目录）。没有 `miniprogramRoot` 设置，miniprogram/ 本身就是项目根。

Vant Weapp 需在 DevTools 中执行"构建 npm"（packNpmManually 模式）。

## staffApi 路由表

从 `cloudfunctions/staffApi/index.js` 路由映射：

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone |
| store | list, unbindRequests, approveUnbind, rejectUnbind |
| staff | list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail, dashboard |
| customer | search, calendar, detail, paidOrders, stats, listByTag, giftHistory, refundHistory, updateNotes, assign, customerBalance |
| product | shopInit, categories, skuList, skuDetail, spuDetail, promotionList, promotionPlans |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail, createRefund, approveRefund, rejectRefund, createRepayment, createConversion, createPickup |
| allocation | save, deleteAllocation, getCommissionRates, pendingList, suggest |
| appointment | list, detail, confirm, checkin |
| coupon | available |
| service | create, start, complete, cancel, list, detail, counts |
| mgmtDashboard | scopeOptions, summary, storeRanking, staffRanking |

### 储值卡抵扣相关接口说明

- `customer.customerBalance` — 店长查顾客储值卡余额（跨店统一，一户一账户；仅店长角色可访问）。结算弹层展示顾客实时余额用
- `order.create` — 店长开单时若顾客选择预选储值卡抵扣，仅写入 `prepaid_card_amount` / `paid_amount` / `payment_method`（实付=0 落 `'无'`），**`prepaid_cards.balance` 不动**；真正扣卡发生在顾客扫码确认链路（clientApi / payNotify / confirmOffline）
- `order.confirmOffline` — 店长确认线下收款时，若订单有 `prepaid_card_amount > 0` 则事务内扣 balance + INSERT `card_transactions(type='扣款')` + 置已支付
- `order.approveRefund` — 退款审批通过时按 `floor(prepaid/total × refund, 2)` 比例拆分，储值卡部分 INSERT `type='充值'` 回冲 balance，返回 `{refundByCard, refundByOrigin}`

## 错误前缀约定

云函数 throw 必须使用 9 项官方白名单前缀（详见 `cloudfunctions/staffApi/utils/error-codes.js`）：
`UNAUTHORIZED` / `PHONE_REQUIRED` / `INVALID_PARAMS` / `PERMISSION_DENIED` /
`NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CONFLICT` / `INVALID_STATE` / `CLIENT_NOT_REGISTERED`

前端通过 `callStaffApi` 抛错时 `err.errorType` 字段保留前缀名（`PHONE_REQUIRED` 与 `PERMISSION_DENIED` 共用 -403，必须按 `errorType` 区分而非按 code）。

## 环境变量（云函数）

- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `CLIENT_SECRET` — 内部接口密钥
- `WXACODE_ENV_VERSION` — 小程序码环境版本

## 规范文档

- `.42cog/pm/staff.pr.spec.md` — 产品需求
- `.42cog/dev/staff.sys.spec.md` — 系统架构
- `.42cog/design/staff.ui.spec.md` — UI 设计

## 子目录文档

- `miniprogram/CLAUDE.md` — 前端详细文档（页面结构、状态管理、角色权限）
- `cloudfunctions/staffApi/CLAUDE.md` — API 网关详细文档（路由表、认证、业务流程）
