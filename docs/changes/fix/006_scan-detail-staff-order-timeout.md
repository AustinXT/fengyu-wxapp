---
type: fix
number: "006"
date: 2026-06-29
title: admin 开单顾客扫码即「已关闭」（admin 写 sale_order_datetime 的 UTC 时区 bug 致 closeExpiredOrder 误判，opened_by 守卫兜底）
tags: [client, clientApi, admin, order, timezone, closeExpiredOrder, cloudfunction]
related: ["fix/003"]
---

# fix/006 admin 开单顾客扫码立刻「已关闭」

> 关联 GitHub issue #27「admin 选择微信支付的订单，手机扫完码直接显示订单已关闭」。

## 事件概述

- 发现时间：2026-06-29（issue #27）
- 影响范围：admin 开单（微信/支付宝）→ 顾客扫码支付链路
- 严重程度：高（admin 开单生成二维码交顾客，顾客扫码后订单立刻变「已关闭」，无法继续支付）
- 实数据铁证：admin 开单 `FY-XSD-WX-2606290020` `sale_order_datetime=13:13:09` 与 `created_at=21:13:09` 差 **28800 秒（8 小时）**；顾客扫码后 24 秒订单静默关闭（无 operation_log）。

## 根因分析

**两端写入 `sale_order_datetime` 的时区语义不一致，导致 clientApi 的 `closeExpiredOrder` 把刚创建的 admin 单误判成「8 小时前超时」：**

1. **admin 端写入存 UTC 字面**：admin `createOrder`（drizzle + postgres.js，orders.ts L2002/2485/3097 `saleOrderDatetime: new Date()`）。postgres.js 把 JS Date 转 UTC ISO 发给 PG；列是 `timestamp` without tz → PG 丢弃时区，存 **UTC 字面**（真实 21:13:09 北京存成 13:13:09）。
2. **clientApi reader 假设北京字面**：clientApi pg.js `setTypeParser(1114, val => new Date(val + '+08:00'))` 把读到的字面当北京墙钟。对 admin 写的 UTC 字面 → 解析出比真实早 8 小时的 Date。
3. **closeExpiredOrder 误判**：`Date.now() - orderTime` 多算 8 小时 → 刚创建的 admin 单被判「>10 分钟超时」→ 顾客扫码触发 `scanDetail` → 触发 `closeExpiredOrder` → **静默关单（无日志）**。

**为什么 staff 开单不复现**：staffApi（原生 pg）写 `sale_order_datetime` 存**北京字面**（staffApi 单 0012：`sale_order_datetime` = `created_at`，差 0 秒），clientApi reader(+08:00) 读对了，不误判。只有 admin（postgres.js）写 UTC 字面才 mismatch——这解释了早期 staff 单数据混乱、直到用 admin 复现才暴露。

> 注：[[project_cloudfn_pg_timestamp_tz]] 记载的「四端 setTypeParser(1114) +08:00」只统一了**读取侧**；**写入侧** admin（postgres.js 存 UTC 字面）与 staffApi（原生 pg 存北京字面）仍不一致，是该 bug 的源头。

## 修复方案（兜底：员工/admin 单免疫懒清理）

核心：**`closeExpiredOrder` 只关顾客自助下单（`opened_by IS NULL`），员工/admin 开单订单永不懒清理。** 守卫下沉到 `closeExpiredOrder`，一处覆盖全部调用点。admin 写入时区 bug 的**根治（根因）作为独立 follow-up #2**，本轮用守卫兜底修复 #27。

### client 端（守卫 + 死代码清理 + 提示改善）

1. **`closeExpiredOrder`**：UPDATE 加 `AND opened_by IS NULL`，返回 `boolean`。
2. **`closeExpiredOrdersByUser`**：SELECT 加 `AND opened_by IS NULL`。
3. **4 个直调点**（pay/offlinePay/detail/alipayPay）：据返回值决定——员工/admin 单 `closed=false` → 跳过 `throw 已超时` / 置已关闭。
4. **scanDetail 删除死超时块**：scanDetail SQL 本就 `WHERE opened_by IS NOT NULL`（只服务员工单），其 10 分钟超时块对员工单永远 no-op，删除避免误导。
5. **order.create existingOrders 提示改善**：检查待支付单时区分员工单/自助单——员工单给「扫码完成支付或联系店员取消」引导。

### 为什么修复 #27

admin 单 `opened_by` 非空（0020=EMP-ADMIN-001）→ 守卫让其免疫 `closeExpiredOrder`，即使 admin 时区 bug 让 orderTime 算成 8h 前，admin 单也不再被关。顾客扫码 → scanDetail 正常返回订单 → 进入支付页（issue 期望达成）。

> 注：本轮只做 client 端守卫兜底，**未根治 admin 写入时区 bug**（根因仍在，`detail.expireAt` 等 clientApi 展示仍偏 8h）。曾尝试 admin `sale_order_datetime` 改 `sql\`NOW()\``（commit 6c94918f 早期版本），但 review 发现会引入**历史数据混合**（47 条旧 UTC 字面 vs 新北京字面，`orderBy` 排序错乱）+ **报表筛选偏移**（L373/376 `gte/lt(new Date())` 边界偏 8h），需配套历史回填 + 筛选适配，已 **revert**，留给 follow-up #2 统一做。

### 明确不改

- **不自动恢复历史误关单**：admin 单被误关的（如 0020）由 owner 决定是否人工核对。
- **不改 `uq_sale_orders_client_pending`**：同顾客仅 1 个待支付单（不区分 `opened_by`）是 pre-existing 业务约束，作 follow-up #1。
- **不根治 admin 写入时区**：admin `sale_order_datetime` 单独改 `sql\`NOW()\`` 会引入历史混合 + 报表筛选偏移（见上「注」），需全 timestamp 字段统一 + 历史回填 + 筛选适配，作为 follow-up #2 独立工单。

## 验证

- 新增 client L2 回归（`order/scan-flow.spec.mjs`，3 用例）：① 员工单超时 → `scanDetail` 不关、保持 `待支付`；② 员工单 → `offlinePay` 不抛超时；③ **自助单超时 → `order.detail` 仍懒清理关闭（`closed=true` 分支对照，防回归）**。
- order 全模块 e2e 核心 spec 全绿（scan-flow 16/16、create.spec 8/8）。
- 部署后复现 0020 场景（admin 开单 + 顾客扫码）确认订单保持待支付、能进入支付页。

## 部署

- **clientApi 云函数**：`scripts/use-env.sh <env>` → `scripts/deploy-cloudfunctions.sh`（先 dev 再 prod）。纯云函数，client 小程序无需发版。**仅 client 端改动，admin 无改动**。

## 预防措施

- `closeExpiredOrder` / `closeExpiredOrdersByUser` 加 `opened_by IS NULL` 守卫——后续新增懒清理调用点复用即自动免疫。
- `closeExpiredOrder` 返回 boolean，调用点据返回值决定副作用（避免「UPDATE 没命中仍标记关闭」假阳性）。
- **员工/admin 单无自动过期路径**：守卫后员工单不再被 10 分钟懒清理（设计如此——员工单无自助下单的 10 分钟语义），作废需 staff/admin 手动关闭；团队需确认无需自动过期。
- **follow-up（独立工单）**：
  - **#1 `uq_sale_orders_client_pending` 加 `opened_by` 维度**：partial unique 谓词加 `AND opened_by IS NULL`（只锁自助单），允许同顾客同时持员工单+自助单；clientApi existingOrders 同步改 `AND opened_by IS NULL`。
  - **#2 admin timestamp 全链路根治**：admin ~30 处 `new Date()` timestamp 写入（含 `sale_order_datetime`/`paidAt`/`usedAt`/`expireAt`，含 `cards.ts:699` 盲区）统一改北京字面 helper（`nowTs()`/`beijingTs()`）+ 报表筛选 L373/376 适配 + 历史 47 条 `sale_order_datetime`（精确锚定 `diff≈-28800`）等 UTC 字面回填。记录到 [[project_cloudfn_pg_timestamp_tz]]。
