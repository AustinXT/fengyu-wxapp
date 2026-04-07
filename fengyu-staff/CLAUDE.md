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
| customer | search, calendar, detail, paidOrders, stats, listByTag, giftHistory, refundHistory, updateNotes, assign |
| product | shopInit, categories, skuList, skuDetail, spuDetail, promotionList, promotionPlans |
| order | create, qrcode, confirmOffline, close, resetFailed, list, detail, createRefund, approveRefund, rejectRefund, createRepayment, createConversion, createPickup |
| allocation | save, deleteAllocation, getCommissionRates, pendingList, suggest |
| appointment | list, detail, confirm, checkin |
| coupon | available |
| service | create, start, complete, cancel, list, detail, counts |

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
