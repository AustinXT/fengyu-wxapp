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
| auth | login, bindPhone, bindStore（含来源渠道）, updateProfile, uploadAvatar, uploadStaffAvatar（HTTP 触发器跨 env 转上传） |
| store | list, detail, requestUnbind, getUnbindRequest, cancelUnbindRequest, geocode |
| product | categories, spuList, skuDetail, spuDetail, hotList, shopInit, experienceCardList |
| staff | list, default, detail |
| order | create, pay, alipayPay, offlinePay, list, detail, cancel, appointableItems, scanDetail, scanAdjust, confirmPrepaidFull, repay, queryLakalaStatus |
| appointment | create, list, cancel |
| service | detail, list, confirm, createReview |
| coupon | list, available |
| points | balance, history |
| message | list, read, unreadCount |
| card | list, history, balance, rechargeConfig, recharge |
| config | banners, fengyuguan, shareGift, invalidateConfig |

### 储值卡抵扣相关接口说明

- `card.balance` — 查当前用户储值卡余额（跨店统一，一户一账户；不接受 `storeId` 参数），下单页抵扣用
- `order.scanAdjust` — 员工生成二维码后，顾客扫码可调整预选抵扣方案（`useCard / prepaidCardAmount / paymentMethod`），后端重算 `prepaid_card_amount / paid_amount / payment_method`，订单保持 `'待支付'`，`prepaid_cards.balance` 不动
- `order.confirmPrepaidFull` — 顾客扫码确认支付且实付 = 0（全额抵扣）时调用；事务内扣 balance + INSERT `card_transactions(type='扣款')` + 置 `'已支付'`；不足返回 `INSUFFICIENT_BALANCE`

## 错误前缀约定

云函数 throw 必须使用 9 项官方白名单前缀（详见 `cloudfunctions/clientApi/utils/error-codes.js`，与 `payNotify/error-codes.js` 字节同义）：
`UNAUTHORIZED` / `PHONE_REQUIRED` / `INVALID_PARAMS` / `PERMISSION_DENIED` /
`NOT_FOUND` / `INSUFFICIENT_BALANCE` / `CONFLICT` / `INVALID_STATE` / `CLIENT_NOT_REGISTERED`

`callClientApi` 抛错时 `err.errorType` 字段保留前缀名（`PHONE_REQUIRED` 与 `PERMISSION_DENIED` 共用 -403，必须按 `errorType` 区分）。
`payNotify` 仍按微信支付/拉卡拉协议返回 `{code:'SUCCESS'|'FAIL'}` 外壳，但用 `parseErrorPrefix` 给日志做错误归类。

## 环境变量（云函数）

- `PG_CONNECTION_STRING` — PostgreSQL 连接串
- `TMAP_KEY` / `TMAP_SECRET` — 腾讯地图 API（门店定位/逆地理编码）

## 规范文档

- `.42cog/pm/client.pr.spec.md` — 产品需求
- `.42cog/dev/client.sys.spec.md` — 系统架构
- `.42cog/design/client.ui.spec.md` — UI 设计

## 自动化测试

四层覆盖，全部位于 `fengyu-client/tests/`：

| 层 | 路径 | 入口 | 速度 | IDE 依赖 |
|----|------|------|------|----------|
| L1 unit | `cloudfunctions/clientApi/__tests__/` | bun test | <1s/spec | 否 |
| **L2 e2e-cloudfn** | `tests/e2e-cloudfn/` | bun .../run-all.mjs | ~8 分钟全套 | 否（本地 require + 真 PG） |
| **L2X e2e-cross-end** | `tests/e2e-cross-end/` | bun .../run-all.mjs | ~30 秒 5 spec | 否（同进程 require client + staff，PG 5434）|
| **L3 e2e-miniprogram** | `tests/e2e-miniprogram/` | bun .../run-all.mjs | ~12 分钟 15 journey | 是（automator + IDE 9420） |

**L2 覆盖**：35 spec / ~190 用例，穷举所有 12 模块 53 个 action 的 happy + 边界 + 错误 + 并发 + 状态机 + 原子性分支。命名空间 `TE2L2_*`。

**L2X 覆盖**：5 spec / 16 用例 — 真跨端 staff→client 扫码支付链、HMAC HTTP 桥 7 项守卫矩阵、admin schema 桥 coupon 可见性、历史单 client 不可见、payNotify disabled guard。命名空间 `TE2X_*`。

**L3 覆盖**：15 条用户旅程（onboarding / shopping / checkout / order / appointment / scan-pay / prepaid-card / points-messages / coupon / store-switch / profile-edit / treatment-experience / search-filter / staff-detail-appointment / store-detail）。固定 `setTimeout` 已替换为 `helpers/wait-for-page.mjs` 轮询。命名空间 `TEST_E2E_L3_*`。

跑法见 `tests/README.md` 和各层 README。

### 改 client 代码后必做

1. 改 `cloudfunctions/clientApi/routes/<模块>.js` 后，跑该模块 L2 spec：
   ```bash
   bun fengyu-client/tests/e2e-cloudfn/run-all.mjs --module <模块名>
   ```
2. 改 `cloudfunctions/clientApi/index.js` HMAC 入口 / `auth.uploadStaffAvatar` 路由 → 跑 L2X：
   ```bash
   bun fengyu-client/tests/e2e-cross-end/hmac-bridge.spec.mjs
   ```
3. 改 `miniprogram/pages/*` 后，跑对应 L3 journey（前提 IDE 装 fengyu-client + IPv6 9420 ready）
4. 改 schema / 枚举：先 L2 + L2X 全套跑一次防回归

## 子目录文档

- `miniprogram/CLAUDE.md` — 前端详细文档（页面结构、状态管理、UI 主题）
- `cloudfunctions/clientApi/CLAUDE.md` — API 网关详细文档（认证、数据库、业务流程）
- `tests/README.md` — L2/L3 自动化测试总览
