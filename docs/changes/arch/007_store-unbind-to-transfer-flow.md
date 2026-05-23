---
type: arch
number: "007"
date: 2026-05-23
title: 门店解绑流程改为「转店」（前置选新门店）+ 修复审批后约半小时才生效的缓存陈旧 bug
tags: [store, unbind, transfer, client, staff, cache, db, cross-end]
related: []
---

# arch/007 门店解绑流程改为「转店」+ 修复审批缓存陈旧 bug

## 背景与动机

线上反馈：顾客申请解绑、店长已确认通过，但**顾客端仍显示未解绑**，在原门店（蓝茉店）还能正常下单/预约，约半小时后刷新才生效。

暴露两个问题：

1. **流程缺陷**：原 `approveUnbind` 审批通过后把 `client_wechat_users.bound_store_id` 置 `NULL`，顾客进入「悬空未绑定」中间态，需再手动绑新店。
2. **缓存陈旧 bug**：staffApi（独立云函数）审批后 `UPDATE client_wechat_users`，但 clientApi 的 `middleware/auth.js` 有进程内 `AUTH_CACHE`（5 分钟 TTL，缓存了 `bound_store_id`），staffApi 无法清除 clientApi 内存缓存。多个温实例各自缓存 + 客户端 `globalData`/localStorage 缓存，叠加表现为「约半小时才生效」。

## 已拍板决策

1. **彻底改为「转店」**：顾客申请时**前置选好要绑的新门店**，审批通过后 `bound_store_id` 直接从原店改为新店，**永不出现悬空未绑定态**。
2. **完全移除纯解绑**（不绑新店）入口——顾客只能转店。
3. **由原门店店长审核**（维持现状，新门店店长无需操作）。
4. **一并修复缓存 bug**。

## 数据模型

`store_unbind_requests` 表**新增 `to_store_id`**（目标门店，FK `stores.store_id`）：

- DB 层**可空**（避免对存量行的 NOT NULL 迁移失败），**应用层强制必填**。
- 审批通过：`bound_store_id = to_store_id`（而非 `NULL`），并把 `customer_source` 标记为 `'转店'`。
- 保留表名与 action 名（`requestUnbind/approveUnbind/...`）以降低跨端 snapshot / 测试 churn，语义转为「转店」在注释与 spec 中说明。
- 唯一 partial index `uq_store_unbind_pending`（同顾客同时仅 1 条 `待处理`）不变。

迁移：`db/migrations/0054_keen_the_spike.sql`（`ADD COLUMN to_store_id text` + FK，纯增量）。

## 架构设计

### 流程
顾客在**想去的新门店**详情页点「申请转绑到本店」→ `store.requestUnbind({ toStoreId, note? })`（from = 当前绑定店，to = 当前页门店）→ 原门店店长在「转店申请审批」列表看到「原门店 → 转往门店」→ `approveUnbind` 事务内 CAS 翻状态 + 把 `bound_store_id` 改绑到 `to_store_id`。

### 客户端 UI 状态
`bindState` 简化为纯绑定关系三值：`no-binding` / `is-current` / `other-bound`；审批态统一由 `pendingRequest` 是否存在表达——只要有待审批转店申请，任意门店页都展示「审批中 + 取消」横幅（同顾客仅 1 条 pending，天然互斥）。

### 缓存修复（低风险组合）
- `clientApi/middleware/auth.js`：`AUTH_CACHE` TTL `5min → 60s`，把跨函数陈旧窗口收敛到 ≤60s（转店为低频操作，足够）。
- `client/store-detail` 新增 `onShow` 重新 `app.syncLoginState()` + `loadAll`（首进由 onLoad 已加载，跳过首次 onShow 避免重复请求），审批生效后切回页面即刷新。
- 注：`appointment.create` 本就实时读 `bound_store_id`；`order.create` 不 gate 绑定门店（纯前端 UI 驱动），故主要修复点为 UI 同步 + TTL。

## 相关文件

- `db/schema/store-unbind.ts`、`db/migrations/0054_keen_the_spike.sql` — 新增 `to_store_id`
- `fengyu-client/cloudfunctions/clientApi/routes/store.js` — `requestUnbind`（toStoreId 必填校验 + INSERT）、`getUnbindRequest`（返回 toStore）
- `fengyu-client/cloudfunctions/clientApi/middleware/auth.js` — TTL 60s
- `fengyu-client/miniprogram/pagesStore/store-detail/{ts,wxml,wxss}` — 转店 UI + onShow 同步
- `fengyu-staff/cloudfunctions/staffApi/routes/store.js` — `approveUnbind` 改绑 to_store_id + customer_source='转店'；`unbindRequests` 返回目标店
- `fengyu-staff/miniprogram/packageService/unbind-requests/{ts,wxml}` — 列表「原门店 → 转往门店」+ 审批文案
- 测试：client/staff `__tests__/routes/store.test.js`、`fengyu-client/tests/e2e-cloudfn/store/unbind-flow.spec.mjs`（+ `ensureTestStore2` 夹具）

## 部署注意

- `db:migrate` 应用 0054 到业务库（先于 L2 e2e）。
- clientApi + staffApi 两个云函数需重新部署（`tcb fn code update`，**禁用 `--force`**）。
