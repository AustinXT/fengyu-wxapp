# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

顾客端小程序（C端），包含前端和云函数。

## 基本信息

- **appid**: `wx811eb4ded3dfba3f`
- **CloudBase envId**: `cloud1-3gpht4b01ff88838`
- **云函数**: clientApi（API 网关）、payNotify（支付回调）

## 开发者工具

微信开发者工具打开 **`fengyu-client/`**（project.config.json 在此目录）。`miniprogramRoot` 指向 `miniprogram/`，`cloudfunctionRoot` 指向 `cloudfunctions/`。

Vant Weapp 需在 DevTools 中执行"构建 npm"（packNpmManually 模式）。

## clientApi 路由表

从 `cloudfunctions/clientApi/index.js` 路由映射：

| 模块 | 接口 |
|------|------|
| auth | login, bindPhone, bindStore, updateProfile |
| store | list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit |
| staff | list, default |
| order | create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail |
| appointment | create, list, cancel |
| service | detail, list |
| coupon | list, available |

## 环境变量（云函数）

- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `TMAP_KEY` / `TMAP_SECRET` — 腾讯地图 API（门店定位/逆地理编码）

## 规范文档

- `.42cog/pm/client.pr.spec.md` — 产品需求
- `.42cog/dev/client.sys.spec.md` — 系统架构
- `.42cog/design/client.ui.spec.md` — UI 设计

## 子目录文档

- `miniprogram/CLAUDE.md` — 前端详细文档（页面结构、状态管理、UI 主题）
- `cloudfunctions/clientApi/CLAUDE.md` — API 网关详细文档（认证、数据库、业务流程）
