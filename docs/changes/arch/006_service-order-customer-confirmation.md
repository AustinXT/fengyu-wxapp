---
type: arch
number: "006"
date: 2026-05-23
title: 服务单新增「顾客确认」步骤（待客户确认 中间态）
tags: [service, state-machine, enum, commission, cross-end, client, staff, admin]
related: ["004"]
---

# arch/006 服务单新增「顾客确认」步骤（待客户确认 中间态）

## 背景与动机

服务单原状态机为 `待服务 → 服务中 → 已完成`。员工点「完成服务」那一刻**原子**做三件不可逆的事：扣减卡剩余次数、计算并写入美容师提成（`service_commissions`）、关闭关联预约，并直接置 `已完成`。顾客全程无参与确认环节。

业务要求：**服务单必须经顾客确认才算完成**。员工点「完成」只表示服务做完、等待确认；只有顾客（或店长 / 后台代）确认后服务单才真正完成。

## 已拍板决策

1. **副作用时机 = 顾客确认后才发生**：员工点「完成」→ `待客户确认`，此时不扣次数 / 不计提成 / 不关预约；三者全部推迟到「确认」原子执行。
2. **兜底机制 = 店长 / 后台可代确认**（不做超时自动确认，不做顾客拒绝 / 反馈）。
3. **新枚举值命名 = `待客户确认`**（避免与 appointment 域 `待确认` 歧义）。

## 状态机

```text
待服务 → 服务中 → 待客户确认 → 已完成
                ↑ 员工「完成」(轻量翻状态 + staff_completed_at)
                             ↑ 顾客/店长/后台「确认」(扣次数+计提成+关预约)
```

## 技术实现

### 数据库（migration 0053）
- `service_order_status` 枚举插入 `待客户确认`（`服务中` 与 `已完成` 之间）。
- `service_orders` 加 `staff_completed_at`（员工标记完成时间，区别于 `completed_at`=确认完成时间）。
- `uq_so_client_active` 部分唯一索引谓词由 `IN ('待服务','服务中')` 改为 **`NOT IN ('已完成','已取消')`**。
  - **关键**：用 `NOT IN 终态` 而非正列表，使索引 DDL **不引用新枚举值**，规避「`ALTER TYPE ADD VALUE` + 索引引用新值」同事务触发 `55P04`（drizzle migrate 把全部 pending migration 包进单事务）。已用临时 PG 实测验证。

### finalize 副作用三端入口
「确认」可由三入口触发，各执行同一套 finalize（扣次数 + 计提成 + 关预约 + 翻 `已完成`）：

| 入口 | 端 | action | 触发者 |
|------|-----|--------|--------|
| 顾客本人 | clientApi | `service.confirm`（新） | 顾客 |
| 店长代确认 | staffApi | `service.confirm`（新，`requireManager`） | manager |
| 后台代确认 | admin | `confirmServiceOrder`（新） | admin / manager |

- staffApi：原 `complete` 事务体抽出为 `finalizeServiceOrder` helper；`complete` 改轻量（仅翻 `待客户确认` + `staff_completed_at`）。
- clientApi：新增 `utils/service-finalize.js` 独立副本（首次把「扣次数 + 算提成」SQL 引入客户端云函数）。
- admin：`completeServiceOrder` 改轻量翻 `待客户确认`；新增 `confirmServiceOrder` 走原 CTE 扣减（admin 历史不自动计提成，沿用其既有口径）。

### 跨端一致性守护
staffApi `finalizeServiceOrder` 与 clientApi `service-finalize.js` 的三条核心 SQL（扣减 UPDATE / `commission_rate_matrix` 查率 / `service_commissions` 写入）字节同义，新增 `cross-end-sql-snapshot.test.js` 块守护（禁止 `cloudfunctions-shared`，靠 snapshot）。`operation_logs` 缺率告警 INSERT 因 operator/source 不同不纳入比对。

### 并发幂等
finalize 状态翻转 `WHERE status='待客户确认'`，`rowCount=0` 视为已被其它入口确认 → 幂等返回，避免顾客 + 店长同时确认导致重复扣次数 / 提成。

### 前端
- 员工端：护理 Tab 增「待确认」Tab；标记完成文案改「已完成，待顾客确认」；待确认单店长见「代客户确认」按钮。
- 客户端：服务记录列表对 `待客户确认` 单显示「确认服务完成」按钮，确认后方可评价。
- admin：服务单列表状态筛选 / 徽章加 `待客户确认` + 「代客户确认」按钮。

## 影响文件

- `db/schema/{enums,service}.ts` + `db/migrations/0053_complete_drax.sql`
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js` + `index.js`
- `fengyu-client/cloudfunctions/clientApi/routes/{service,appointment}.js` + `index.js` + `utils/service-finalize.js`（新）
- `fengyu-admin/src/actions/services.ts`、`app/(main)/services/_components/services-page.tsx`、`lib/types.ts`、`components/ui/badge.tsx`
- `fengyu-staff/miniprogram/pages/service/*` + `packageService/service-detail/*` + `app.wxss`
- `fengyu-client/miniprogram/pagesOrder/service-records/*`
- `cross-end-sql-snapshot.test.js`（+ snap）、`service.test.js`、`.42cog/pm/{backend,staff,client}.pr.spec.md`、`.42cog/dev/staff.sys.spec.md`

## 验证

- migration：临时 docker PG 从零 apply 通过（54 migration），`NOT IN` 索引 + 单事务 `ADD VALUE` 实测无 55P04。
- staffApi 单测：`service.test.js` 68/68；`cross-end-sql-snapshot.test.js` 107/107（含新 finalize 守护）。
- admin：`npx tsc --noEmit` 通过。

## 待办（follow-up）

- clientApi `service.confirm` 的 L2 e2e（扣次数 / 计提成 / 幂等 / 鉴权全链路）。
- admin `link-2-service-lifecycle.spec.ts` 更新为 4 态流转 + 代确认。
- **部署注意**：0053 含 `ALTER TYPE ADD VALUE`；本 migration 因索引谓词改 `NOT IN` 已规避同事务 55P04，可正常 `db:migrate`。
