# Ticket: 状态机 UPDATE 全量补 CAS 守卫（sale_orders / appointments / service_orders / sale_order_payments / store_unbind_requests）

> 生成日期：2026-05-17
> 实施状态：⚪ 未开始
> 严重级别：**P0**（事务并发下越级状态 — SUMMARY Top10 #8）
> 端：fengyu-admin + fengyu-staff + fengyu-client
> 修复成本：M（1–3 天）
> 来源：[SUMMARY §2 #8 + §3 横切热点](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-02 订单创建](../../docs/audit/audit-02-order-creation.md)、[audit-03 支付流程](../../docs/audit/audit-03-payment-flow.md)、[audit-04 支付回调](../../docs/audit/audit-04-pay-notify.md)、[audit-11 退款流水](../../docs/audit/audit-11-refunds.md)、[audit-05 服务单生命周期](../../docs/audit/audit-05-service-order.md)、[audit-06 预约 checkin](../../docs/audit/audit-06-appointment-checkin.md)、[audit-12 门店绑定](../../docs/audit/audit-12-store-binding.md)、[CC2 并发与幂等](../../docs/audit/audit-CC2-concurrency-idempotency.md)

---

## 📋 v2 修订摘要（2026-05-17 复核后）

| # | 类别 | 内容 |
|---|------|------|
| 1 | Block | 修正全文 audit 文件名引用至 `audit-02-order-creation` / `audit-03-payment-flow` / `audit-04-pay-notify` / `audit-11-refunds` / `audit-05-service-order` / `audit-12-store-binding`（旧引用 audit-02/03/04/12 名称错位） |
| 2 | Block | §7 关联表新增强前置依赖 ticket #10（`error-code-prefix-whitelist-and-admin-throw`），顶部加红色警告框 |
| 3 | Warn | §4.2 payNotify diff 补 `const updResult =`（原代码无变量名） |
| 4 | Warn | §5.2 lint 实现改 ripgrep `--multiline` 或 node 脚本；附录 CAS-EXEMPT 注释 patch 清单（精确行号） |
| 5 | Warn | §1.1 admin 行加注「保持现状，错误码迁移由 #10 处理」 |
| 6 | 改进 | §4.5 store.js approveUnbind 给出"调换 UPDATE 顺序"的完整新代码块 |

---

> ## ⚠️ 强前置依赖：必须先做 ticket #10
>
> 本 ticket 引入新错误前缀 `INVALID_STATE:`，**不在 CLAUDE.md 4 项官方白名单**（`UNAUTHORIZED / PHONE_REQUIRED / INVALID_PARAMS / PERMISSION_DENIED`）内。
>
> 若先于 [`2026-05-17-error-code-prefix-whitelist-and-admin-throw.md`](./2026-05-17-error-code-prefix-whitelist-and-admin-throw.md) 实施：
> - clientApi/payNotify 端 `knownTypes` 不识别 `INVALID_STATE:`
> - 会被吞为 HTTP 500 而非业务码 -400
> - 三端 errorType 路由失效，前端兜底文案触发不到
>
> **实施顺序硬约束**：先 ticket #10 把白名单扩到 8 项 + 三端 `knownTypes` 识别 → 再做本 ticket。

---

## 0 一句话背景

跨三端 + admin 的状态机推进 UPDATE 中，**11 处真实命中 + 4 处 `IN (...)` 受限范围**（审计估计 ~12 处与实际吻合），未携带 `AND status = $prev` 前置态守卫；事务并发场景下可被另一事务先行翻状态后再被这些 UPDATE 覆盖回去，导致越级状态（如：已支付 → 已关闭、已确认 → 待确认覆写等）和级联副作用错位。

---

## 1 grep 命中全表（按表分组，源文件+行号）

> 标记规则：
> - ✅ 已带 `AND status = $prev`（标量）
> - 🔶 已带 `AND status IN (...)` / `AND status = ANY($n::xxx[])` 多状态受限（次优，但已可挡越级）
> - ❌ 完全无前置态守卫 — **本 ticket 修复目标**

### 1.1 sale_orders.status

| # | 文件:行 | 路径 | 守卫 | 备注 |
|---|---------|------|------|------|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:949-955` | confirmOffline 主翻状态 | ✅ `AND status = $7` | 注释 "C4 合规" |
| 2 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1126-1127` | close 关单 | ✅ `AND status = $3` | |
| 3 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1187` | resetFailed 重置 | ✅ `AND status = '支付失败'` | |
| 4 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1586-1590` | approveRefund 累加 refunded_amount | N/A | 不翻 status，仅资金列 |
| 5 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1931-1935` | createRepayment 重算后翻状态 | ✅ `AND status = $7` | |
| 6 | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:94` | save 空集快路径 → allocation_status | ❌ | **本 ticket 修** |
| 7 | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:193` | save 正常路径 → allocation_status | ❌ | **本 ticket 修** |
| 8 | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:247` | deleteAllocation 重置 allocation_status | ❌ | **本 ticket 修** |
| 9 | `fengyu-client/cloudfunctions/payNotify/index.js:267-274` | 主翻 '已支付' / '部分支付' | ❌ | **本 ticket 修**（依赖 uq_sop_txn 幂等不足以阻挡越级覆写） |
| 10 | `fengyu-client/cloudfunctions/payNotify/index.js:280-286` | 回款凭证单同步翻 '已支付' | ❌ | **本 ticket 修** |
| 11 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:18` | closeExpiredOrder | ✅ `AND status = '待支付'` | |
| 12 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:777` | pay 自动绑定（仅写 client_user_id / payment_method） | N/A | 不翻 status |
| 13 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:782` | pay 仅设 payment_method | N/A | |
| 14 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:874-875` | offlinePay 翻 '待确认收款' | ❌ | **本 ticket 修**（仅 SELECT 预检后裸 UPDATE） |
| 15 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1157-1162` | cancel 关单 | 🔶 `AND status = ANY($4::order_status[])` | 注释 "audit-02 P0：cancel CAS 守卫" |
| 16 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1365` | alipayPay 仅设 payment_method | N/A | |
| 17 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1472-1480` | scanAdjust 调整抵扣 | ✅ `AND status = '待支付'` | |
| 18 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1583-1600` | confirmPrepaidFull 翻 '已支付' | ✅ `AND so.status = '待支付'` | |
| 19 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1758-1761` | repay 设 payment_method | N/A | |
| 20 | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1780-1788` | repay 重算后翻 '已支付' / '部分支付' | ❌ | **本 ticket 修**（仅 WHERE sale_order_id） |
| 21 | `fengyu-client/cloudfunctions/clientApi/routes/auth.js:155` | bindPhone 回写 client_user_id | N/A | 不翻 status，仅 PII 列 |
| 22 | `fengyu-client/cloudfunctions/clientApi/routes/card.js:170-172` | _closeExpiredPendingByUser | ✅ `AND status = '待支付'` | |
| 23 | `fengyu-admin/src/actions/orders.ts:2032-2039` | recordPayment 重算后翻状态 | ✅ `AND status = ${locked.status}` | admin 端保持现状；错误码（当前为 `CONCURRENT_CHANGED`）统一迁移到 `INVALID_STATE:` 由 ticket #10 处理，**不在本 ticket scope** |
| 24 | `fengyu-admin/src/actions/refunds.ts:784-792` | approveRefund 重算 refunded_amount | N/A | 不翻 status |

> **admin 端总体策略**：admin actions 已用 `expectedUpdatedAt` 乐观锁 + 部分 CAS（orders.ts L2039、refunds.ts L776/L940），本 ticket **不重构 admin 端**，仅在 ticket #10 中把它们抛出的 `CONCURRENT_CHANGED` / `INVALID_PARAMS:` 统一收口到 `INVALID_STATE:` 前缀。

### 1.2 appointments.status

| # | 文件:行 | 路径 | 守卫 | 备注 |
|---|---------|------|------|------|
| 25 | `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:205-206` | confirm 待确认 → 已确认 | ✅ `AND status = '待确认'` | |
| 26 | `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js:262` | checkin 仅写 checkin_at | N/A | 不翻 status |
| 27 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:378-384` | service.complete 内：扣减到 0 关闭相关预约 | 🔶 `AND status IN ('待确认', '已确认')` | |
| 28 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:464` | service.complete 内：关联预约翻 '已完成' | ✅ `AND status = '已确认'` | |
| 29 | `fengyu-client/cloudfunctions/clientApi/routes/appointment.js:209-213` | cancel 翻 '已取消' | ❌ | **本 ticket 修**（仅 SELECT 预检后裸 UPDATE） |
| 30 | `fengyu-admin/src/cron/steps/close-expired-appointments.ts:32-37` | cron 批量关闭超期预约 | 🔶 `WHERE status IN ('待确认','已确认') + 时间窗` | RETURNING 模式 |

### 1.3 service_orders.status

| # | 文件:行 | 路径 | 守卫 | 备注 |
|---|---------|------|------|------|
| 31 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:268` | start 待服务 → 服务中 | ✅ `AND status = '待服务'` | |
| 32 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:454` | complete 服务中 → 已完成 | ✅ `AND status = '服务中'` | 同步 commission_status |
| 33 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:752-753` | cancel 翻 '已取消' | ✅ `AND status = $3` | |
| 34 | `fengyu-admin/src/actions/services.ts:362-365` | complete（CTE 模式） | ✅ `AND status = '服务中'` | |

### 1.4 sale_order_payments.status

| # | 文件:行 | 路径 | 守卫 | 备注 |
|---|---------|------|------|------|
| 35 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1574-1578` | approveRefund 待审批 → 已支付 | ✅ `AND status = '待审批'` | |
| 36 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1697-1700` | rejectRefund 待审批 → 已作废 | ✅ `AND status = '待审批'` | |
| 37 | `fengyu-admin/src/actions/refunds.ts:770-777` | approveRefund 待审批 → 已支付 | ✅ `AND status = '待审批'` | |
| 38 | `fengyu-admin/src/actions/refunds.ts:933-940` | rejectRefund 待审批 → 已作废 | ✅ `AND status = '待审批'` | |

### 1.5 store_unbind_requests.status

| # | 文件:行 | 路径 | 守卫 | 备注 |
|---|---------|------|------|------|
| 39 | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:98-102` | approveUnbind 翻 '已通过' | ❌ | **本 ticket 修** |
| 40 | `fengyu-staff/cloudfunctions/staffApi/routes/store.js:129-132` | rejectUnbind 翻 '已拒绝' | ❌ | **本 ticket 修** |
| 41 | `fengyu-client/cloudfunctions/clientApi/routes/store.js:216` | cancelUnbindRequest 翻 '已取消' | ❌ | **本 ticket 修** |

---

### 命中汇总

| 表 | ✅ 已守卫 | 🔶 IN/ANY 受限 | ❌ 缺守卫（本 ticket 修） | N/A（不翻 status） |
|----|----------|----------------|---------------------------|---------------------|
| sale_orders | 8 | 1 | **6** | 9 |
| appointments | 2 | 2 | **1** | 1 |
| service_orders | 4 | 0 | 0 | 0 |
| sale_order_payments | 4 | 0 | 0 | 0 |
| store_unbind_requests | 0 | 0 | **3** | 0 |
| **合计** | 18 | 3 | **10** | 10 |

> **实际缺 CAS 守卫 10 处**（SUMMARY 审计估计 ~12 处略偏高，差异主要来自：①审计把 3 个 allocation_status 算作 status 状态机；②payNotify 的 2 处实际能用 uq_sop_txn 唯一索引提供"插入幂等"，但**不能阻止状态被覆盖回低位**，仍需补 CAS。如把🔶受限当"未严格防 race"看，则口径上限达 13 处）。

---

## 2 各状态机合法迁移图

> 状态枚举来源：`db/schema/enums.ts`；payment 迁移图补全自 `notes/tickets/archives/2026-04-26-sale-order-domain-refactor.md §1.4`。

### 2.1 sale_orders.status (`order_status`)

> 枚举值：`待支付 / 已支付 / 支付失败 / 已关闭 / 待审批 / 部分支付`
> （`待确认收款` 也出现在线下流程中，由生产 enum 提供；不在 schema 顶端列出但通过 `::order_status` 强转可见）

```
                         create
                            │
                            ▼
                       ┌──────────┐
            cancel/    │  待支付   │   pay (online success)
            close ◀────┤          ├──────────────────────────────┐
            timeout    └────┬─────┘                              │
                            │                                    │
              offlinePay    │     scanAdjust(仅资金列)            │
                            ▼                                    │
                     ┌─────────────┐    confirmOffline           │
                     │ 待确认收款   │────────────────────────────┐│
                     └─────────────┘                            ││
                                                                ▼▼
                       resetFailed                       ┌─────────────┐
                       (失败 → 待支付)         repay     │   已支付    │
                            ▲                  ┌──────▶ └──────┬──────┘
                            │                  │               │
                       ┌──────────┐            │       (整退后 refunded_amount
                       │ 支付失败 │            │        增加；status 不回退)
                       └──────────┘    ┌───────┴─────┐
                                        │  部分支付   │
                                        └─────────────┘
                                              ▲
                                              │ payNotify / repay 部分到账
                                              │
                                          (received < total)

                       ┌──────────┐
                       │  已关闭   │（cancel/closeExpired/手动）
                       └──────────┘   ← 终态，禁止再翻
```

合法迁移仅有：
- `待支付 → 已支付 / 部分支付 / 待确认收款 / 支付失败 / 已关闭`
- `待确认收款 → 已支付`
- `部分支付 → 已支付`
- `支付失败 → 待支付`（resetFailed）

**禁止**：`已支付 → *` / `已关闭 → *`（终态）。

### 2.2 appointments.status (`appointment_status`)

> 枚举值：`待确认 / 已确认 / 已完成 / 已取消 / 已关闭`

```
        create
           │
           ▼
      ┌─────────┐  confirm    ┌─────────┐  service.complete   ┌──────────┐
      │ 待确认  │────────────▶│ 已确认  │────────────────────▶│ 已完成   │
      └────┬────┘             └────┬────┘                     └──────────┘
           │  cancel               │  cancel
           ▼                       ▼
       ┌──────────┐           ┌──────────┐
       │ 已取消   │           │ 已取消   │
       └──────────┘           └──────────┘
           │                       │
           └──────┬────────────────┘
                  │ cron close-expired-appointments / 关联 sale_items 次数耗尽
                  ▼
              ┌──────────┐
              │ 已关闭   │
              └──────────┘
```

### 2.3 service_orders.status (`service_order_status`)

> 枚举值：`待服务 / 服务中 / 已完成 / 已取消`

```
                start                         complete
   ┌─────────┐ ─────▶ ┌─────────┐ ──────────────────────▶ ┌──────────┐
   │ 待服务  │        │ 服务中  │                          │ 已完成   │
   └────┬────┘        └────┬────┘                          └──────────┘
        │ cancel           │ cancel
        ▼                  ▼
    ┌──────────┐       ┌──────────┐
    │ 已取消   │       │ 已取消   │
    └──────────┘       └──────────┘
```

### 2.4 sale_order_payments.status (`payment_flow_status`)

> 枚举值：`待支付 / 待审批 / 已支付 / 已作废 / 已退款`
> 详见 2026-04-26 sale-order-domain-refactor §1.4。

```
                                          payNotify
                ┌─────────┐                到账
  线上 ─────▶  │ 待支付  │  ─────────────────────────▶ ┌──────────┐
                └────┬────┘                              │ 已支付   │ ◀──┐
                     │ 超时/手动                        └──────────┘    │
                     ▼                                       │           │
                ┌──────────┐                                 │ 整退冲销 │ approveRefund
                │ 已作废   │                                 ▼           │（退款行 amount<0
                └──────────┘                            ┌──────────┐    │  写'已支付'）
                                                        │ 已退款   │     │
                                                        └──────────┘     │
                                                                         │
   退款行 ──────▶ ┌──────────┐  approveRefund(amount<0)                  │
   (amount<0)     │ 待审批   │  ─────────────────────────────────────────┘
                  └────┬─────┘
                       │ rejectRefund
                       ▼
                  ┌──────────┐
                  │ 已作废   │
                  └──────────┘
```

合法迁移：
- `待支付 → 已支付`（payNotify 到账）
- `待支付 → 已作废`（超时 / 手动撤销）
- `待审批 → 已支付`（退款审批通过；退款行）
- `待审批 → 已作废`（退款驳回）
- `已支付 → 已退款`（首次支付/回款行被整退冲销，仅原行）

### 2.5 store_unbind_requests.status (`store_unbind_request_status`)

> 枚举值：`待处理 / 已通过 / 已拒绝 / 已取消`

```
   client.requestUnbind
            │
            ▼
       ┌──────────┐
       │ 待处理   │
       └────┬─────┘
       ┌────┼─────┐──────────┐
       │    │     │          │
       ▼    ▼     ▼          ▼
   approve reject cancel
       │    │     │
       ▼    ▼     ▼
   ┌──────┐┌──────┐┌──────┐
   │已通过││已拒绝││已取消│
   └──────┘└──────┘└──────┘
   （三个均终态，禁止再翻）
```

合法迁移仅一步：`待处理 → 已通过 / 已拒绝 / 已取消`。

---

## 3 修复模式（统一 CAS 模板）

### 3.1 标量前置态模板

```sql
UPDATE <table>
   SET status = $next, updated_at = $now, ...other cols
 WHERE <pk> = $pk
   AND status = $prev::<status_enum>
```

```js
const upd = await client.query(SQL, [..., pk, prevStatus])
if (upd.rowCount === 0) {
  throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:${tableName}:${pk}:${prevStatus}→${nextStatus}`)
}
```

### 3.2 多前置态模板（仅在业务允许多个 source state 同时收敛到一个 next state 时用）

```sql
UPDATE <table>
   SET status = $next, updated_at = $now, ...other cols
 WHERE <pk> = $pk
   AND status = ANY($allowed::<status_enum>[])
```

> 命名规范：`$allowed` 必须是显式枚举数组，**禁止 `WHERE status <> '终态'` 这种排除式写法**（无法防止未来新增态）。

### 3.3 错误码 + 操作日志

| 字段 | 值 |
|------|-----|
| 错误前缀 | `INVALID_STATE: STATE_TRANSITION_BLOCKED:` 后接 `<table>:<pk>:<prev>→<next>` |
| 前端文案 | "操作状态已变更，请刷新后重试"（沿用现有 `INVALID_PARAMS: 订单状态已变更...` 句式但改 code） |
| operation_logs | `action='state.transition_blocked'`，`detail={ table, pk, prev, next, expectedRowCount: 1, actualRowCount: 0 }` |

### 3.4 与现有错误码对齐

历史代码里 race 抛的是 `INVALID_PARAMS: ...状态已变更...`、`INVALID_STATE: ...`、`CONFLICT: ...`、`CONCURRENT_CHANGED` 共 4 种风格。本次统一改 / 新增用 `INVALID_STATE: STATE_TRANSITION_BLOCKED:...`，但保留各端前端兜底文案不变（仅服务端 code 收口）。

---

## 4 详细 patch（按文件 + 行号）

> 仅列 ❌ 需要修复的 10 处。每处给出"现状 SQL → 目标 SQL"对比。

### 4.1 `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js`

#### L94（save 空集分支）

```diff
- "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2"
+ "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status IN ('待分配', '已分配')"
```

幂等收敛允许重复 set，但仍要挡住后台脏数据（例如 `allocation_status IS NULL` 的历史行）。rowCount=0 时 throw `INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:allocation_status`。

#### L193（save 正常路径）

```diff
- "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2"
+ "UPDATE sale_orders SET allocation_status = '已分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status IN ('待分配', '已分配')"
```

#### L247（deleteAllocation）

```diff
- "UPDATE sale_orders SET allocation_status = '待分配', updated_at = $1 WHERE sale_order_id = $2"
+ "UPDATE sale_orders SET allocation_status = '待分配', updated_at = $1 WHERE sale_order_id = $2 AND allocation_status = '已分配'"
```

> 注：allocation_status 仅 2 值（`待分配 / 已分配`），属轻量级状态机；这里加 CAS 主要是为了挡"另一并发事务已在删 → 我又删"的双删，避免脏 voided_at 时间戳。

### 4.2 `fengyu-client/cloudfunctions/payNotify/index.js`

#### L266-275（主翻 '已支付' / '部分支付'）

> **⚠ 注意**：原代码 L266 是 `await client.query(...)`，**无变量名**。补丁必须同步把它改为 `const updResult = await client.query(...)`，否则下面的 `updResult.rowCount` 会 ReferenceError。

```diff
- await client.query(
+ const updResult = await client.query(
    `UPDATE sale_orders
     SET status = $1::order_status,
         received = $2,
         paid_at = CASE WHEN $1::text = '已支付' THEN $3 ELSE paid_at END,
         wechat_transaction_id = COALESCE(wechat_transaction_id, $4),
         updated_at = $3
-    WHERE sale_order_id = $5`,
+    WHERE sale_order_id = $5
+      AND status IN ('待支付', '部分支付', '待确认收款')`,
    [newStatus, newPaidSum, now, txnId, targetOrderNo]
  )
+ if (updResult.rowCount === 0) {
+   await client.query('ROLLBACK')
+   console.warn('[payNotify] state-transition-blocked:', targetOrderNo, '→', newStatus)
+   return { code: 'SUCCESS', message: '订单状态已变更（幂等）' }  // 不抛错，避免微信侧重试雪崩
+ }
```

#### L279-288（回款凭证单同步翻 '已支付'）

> **⚠ 注意**：原代码 L279 同样是 `await client.query(...)`，**无变量名**。补丁必须同步把它改为 `const credUpd = await client.query(...)`，否则下面 `credUpd.rowCount` 会 ReferenceError。

```diff
- await client.query(
+ const credUpd = await client.query(
    `UPDATE sale_orders
     SET status = '已支付'::order_status,
         paid_at = COALESCE(paid_at, $1),
         wechat_transaction_id = COALESCE(wechat_transaction_id, $2),
         updated_at = $1
-    WHERE sale_order_id = $3`,
+    WHERE sale_order_id = $3
+      AND status IN ('待支付', '部分支付', '待确认收款')`,
    [now, txnId, orderNo]
  )
+ if (credUpd.rowCount === 0) {
+   console.warn('[payNotify] credential state-transition-blocked:', orderNo)
+   // 凭证单允许延迟一致，仅记 warn 不 rollback
+ }
```

rowCount=0 时记录 warn 但不阻塞主单到账（凭证单可以延迟一致）。

### 4.3 `fengyu-client/cloudfunctions/clientApi/routes/order.js`

#### L874-875（offlinePay）

```diff
- "UPDATE sale_orders SET status = '待确认收款', client_user_id = COALESCE(client_user_id, $1), payment_method = '线下', updated_at = $2 WHERE sale_order_id = $3"
+ "UPDATE sale_orders SET status = '待确认收款', client_user_id = COALESCE(client_user_id, $1), payment_method = '线下', updated_at = $2 WHERE sale_order_id = $3 AND status = '待支付'"
```

rowCount=0 时 throw `INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${orderNo}:待支付→待确认收款`。

#### L1780-1788（repay 重算后翻状态）

```diff
  await client.query(
    `UPDATE sale_orders
     SET status = $1::order_status,
         received = $2,
         refunded_amount = $3,
         paid_at = CASE WHEN $1::text = '已支付' THEN COALESCE(paid_at, $4) ELSE paid_at END,
         updated_at = $4
-    WHERE sale_order_id = $5`,
+    WHERE sale_order_id = $5
+      AND status IN ('待支付', '部分支付', '待确认收款')`,
    [finalStatus, newReceived, newRefunded, now, saleOrderId]
  )
```

rowCount=0 时 throw `INVALID_STATE: STATE_TRANSITION_BLOCKED:...`。

### 4.4 `fengyu-client/cloudfunctions/clientApi/routes/appointment.js`

#### L209-213（cancel）

```diff
- await pg.query(
-   `UPDATE appointments
-    SET status = '已取消', cancelled_reason = $1, updated_at = $2
-    WHERE appointment_id = $3`,
-   [cancelledReason || '', now, appointmentId]
- )
+ const r = await pg.query(
+   `UPDATE appointments
+    SET status = '已取消', cancelled_reason = $1, updated_at = $2
+    WHERE appointment_id = $3
+      AND status IN ('待确认', '已确认')`,
+   [cancelledReason || '', now, appointmentId]
+ )
+ if (r.rowCount === 0) {
+   throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED:appointments:' + appointmentId + ':→已取消')
+ }
```

### 4.5 `fengyu-staff/cloudfunctions/staffApi/routes/store.js`

#### L91-103（approveUnbind 事务内调换 UPDATE 顺序 + 加 CAS）

**原代码（顺序：先解绑顾客 → 后改申请状态，CAS 缺）**：

```js
await pg.transaction(async (client) => {
  await client.query(
    `UPDATE client_wechat_users SET bound_store_id = NULL WHERE user_id = $1`,
    [req.user_id]
  )
  await client.query(
    `UPDATE store_unbind_requests
     SET status = '已通过', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
     WHERE request_id = $2`,
    [staffWfId, requestId]
  )
})
```

**目标代码（顺序调换：先 CAS 锁申请状态 → 命中后才解绑顾客；rowCount=0 抛 INVALID_STATE 自动回滚整个事务）**：

```js
await pg.transaction(async (client) => {
  // STEP 1: 先 CAS 锁状态行（命中失败立即 throw，事务整体 ROLLBACK，不会误解绑顾客门店）
  const upd = await client.query(
    `UPDATE store_unbind_requests
     SET status = '已通过', reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
     WHERE request_id = $2 AND status = '待处理'`,
    [staffWfId, requestId]
  )
  if (upd.rowCount === 0) {
    throw new Error(
      'INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:' + requestId + ':待处理→已通过'
    )
  }
  // STEP 2: CAS 命中后才执行顾客解绑（确保仅有一个并发分支成功）
  await client.query(
    `UPDATE client_wechat_users SET bound_store_id = NULL WHERE user_id = $1`,
    [req.user_id]
  )
})
```

> **要点**：事务内 throw 会触发 `pg.transaction` 自动 `ROLLBACK`，无需手动回滚 `client_wechat_users.bound_store_id` —— 因为顺序调换后 STEP 2 根本没机会执行。

#### L129-132（rejectUnbind）

```diff
- await pg.query(
-   `UPDATE store_unbind_requests
-    SET status = '已拒绝', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2, updated_at = NOW()
-    WHERE request_id = $3`,
-   [staffWfId, rejectReason || null, requestId]
- )
+ const r = await pg.query(
+   `UPDATE store_unbind_requests
+    SET status = '已拒绝', reviewed_by = $1, reviewed_at = NOW(), reject_reason = $2, updated_at = NOW()
+    WHERE request_id = $3 AND status = '待处理'`,
+   [staffWfId, rejectReason || null, requestId]
+ )
+ if (r.rowCount === 0) throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:' + requestId + ':→已拒绝')
```

### 4.6 `fengyu-client/cloudfunctions/clientApi/routes/store.js`

#### L216（cancelUnbindRequest）

```diff
- await pg.query(
-   `UPDATE store_unbind_requests SET status = '已取消', updated_at = NOW() WHERE request_id = $1`,
-   [requestId]
- )
+ const r = await pg.query(
+   `UPDATE store_unbind_requests SET status = '已取消', updated_at = NOW() WHERE request_id = $1 AND status = '待处理'`,
+   [requestId]
+ )
+ if (r.rowCount === 0) throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED:store_unbind_requests:' + requestId + ':→已取消')
```

---

## 5 验证 Checklist

### 5.1 并发 CAS 单元测试用例（每处 ❌ 修复必须配一条）

| 用例 ID | 文件 | 描述 |
|---------|------|------|
| CAS-01 | `staffApi/__tests__/routes/allocation.test.js` | 模拟 UPDATE rowCount=0 → 抛 `INVALID_STATE: STATE_TRANSITION_BLOCKED` |
| CAS-02 | 同上 deleteAllocation | 同上 |
| CAS-03 | `payNotify/__tests__/index.test.js` | 单调到账：主单已被 staff confirmOffline 翻 '已支付'，并发 payNotify rowCount=0 → 返回 SUCCESS 且不双发提货 |
| CAS-04 | 同上 凭证单 | 同上 |
| CAS-05 | `clientApi/__tests__/routes/order.test.js` | offlinePay：订单已被 cancel 翻 '已关闭'，并发 offlinePay rowCount=0 → 抛 INVALID_STATE |
| CAS-06 | 同上 repay | 订单已结清，并发 repay rowCount=0 → 抛 INVALID_STATE |
| CAS-07 | `clientApi/__tests__/routes/appointment.test.js` | cancel：预约已被店长 cron 关闭，rowCount=0 → 抛 INVALID_STATE |
| CAS-08 | `staffApi/__tests__/routes/store.test.js` | approveUnbind：并发 reject 已置 '已拒绝'，rowCount=0 → 抛 INVALID_STATE + 不解绑顾客 |
| CAS-09 | 同上 rejectUnbind | 同上 |
| CAS-10 | `clientApi/__tests__/routes/store.test.js` | cancelUnbindRequest 同上 |

### 5.2 仓库级 lint（node 脚本守门，跨平台稳定）

> **⚠ 不要用 `grep -E "...[\\s\\S]{0,400}..."` 跨行匹配**：grep BSD 版（macOS）与 GNU 版（Linux CI）对 `[\s\S]{0,N}` 的多行行为不一致，且 BSD `grep` 不支持 PCRE 跨行。**改用 ripgrep `--multiline` 或 node 脚本**。

#### 方案 A：ripgrep（推荐 CI）

```bash
#!/usr/bin/env bash
# scripts/lint-cas-guards.sh
set -euo pipefail
TABLES='sale_orders|appointments|service_orders|store_unbind_requests|sale_order_payments'

rg --multiline --multiline-dotall -n -t js -t ts \
   --glob '!**/__tests__/**' --glob '!**/*.test.*' \
   "UPDATE\s+($TABLES).*?SET.*?status" \
   fengyu-admin/src fengyu-staff/cloudfunctions fengyu-client/cloudfunctions \
| while IFS= read -r match; do
    # 行内含 CAS-EXEMPT 注释则跳过
    echo "$match" | grep -q 'CAS-EXEMPT' && continue
    # 校验是否含 AND ... status (= | IN | = ANY) 守卫
    if ! echo "$match" | rg --multiline -q 'AND[^;]{0,200}status\s*(=|IN|=\s*ANY)'; then
      echo "MISS-CAS-GUARD: $match"
      exit 1
    fi
  done
```

#### 方案 B：node 脚本（无 ripgrep 依赖）

```js
// scripts/lint-cas-guards.mjs
import { readFileSync } from 'node:fs'
import { globSync } from 'glob'

const TABLES = ['sale_orders', 'appointments', 'service_orders', 'store_unbind_requests', 'sale_order_payments']
const FILES = globSync([
  'fengyu-admin/src/**/*.{js,ts}',
  'fengyu-staff/cloudfunctions/**/*.js',
  'fengyu-client/cloudfunctions/**/*.js'
], { ignore: ['**/__tests__/**', '**/*.test.*'] })

const re = new RegExp(`UPDATE\\s+(${TABLES.join('|')})[\\s\\S]{0,400}?SET[\\s\\S]{0,400}?status`, 'g')
let failed = 0
for (const f of FILES) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(re)) {
    const ctx = src.slice(m.index, m.index + 600)
    if (ctx.includes('CAS-EXEMPT')) continue
    if (!/AND[\s\S]{0,200}status\s*(=|IN|=\s*ANY)/.test(ctx)) {
      const line = src.slice(0, m.index).split('\n').length
      console.error(`MISS-CAS-GUARD: ${f}:${line}`)
      failed++
    }
  }
}
process.exit(failed ? 1 : 0)
```

> CAS-EXEMPT 注释作为白名单逃生口，限于"仅更新资金/PII 列，不翻 status"的情况（详见 §1 N/A 行），人工 review 后加注释豁免。

#### 附录：CAS-EXEMPT 注释初始 patch 清单（首次跑 lint 前需先打的豁免补丁）

> 以下 9 处是 §1 表标 N/A 的实际行号（无 status 翻转，仅资金/PII 列）。**首次跑 lint 前必须先打这批 `// CAS-EXEMPT: ...` 注释，否则 CI 会全红**。

| # | 文件 | 行号 | 字段说明 | 建议注释 |
|---|------|------|----------|----------|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | L1586 | approveRefund：仅 `refunded_amount += ABS(amount)` | `// CAS-EXEMPT: 仅累加资金列 refunded_amount，不翻 status` |
| 2 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | L777 | pay 自动绑定：`client_user_id / payment_method` | `// CAS-EXEMPT: 仅写 PII + 支付方式，不翻 status` |
| 3 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | L782 | pay：`payment_method = '微信'` | `// CAS-EXEMPT: 仅设支付方式，不翻 status` |
| 4 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | L1365 | alipayPay：`payment_method = '支付宝' + client_user_id` | `// CAS-EXEMPT: 仅设支付方式 + PII，不翻 status` |
| 5 | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | L1758 | repay：`payment_method = $1` | `// CAS-EXEMPT: 仅设支付方式，不翻 status（后续 L1780 重算才翻）` |
| 6 | `fengyu-client/cloudfunctions/clientApi/routes/auth.js` | L155 | bindPhone 回写：`client_user_id` | `// CAS-EXEMPT: 仅回写顾客 user_id，不翻 status` |
| 7 | `fengyu-admin/src/actions/refunds.ts` | L784 | approveRefund：`refunded_amount` 累加 | `// CAS-EXEMPT: 仅累加 refunded_amount，status 由 L2032 另行 CAS` |
| 8 | `fengyu-staff/cloudfunctions/staffApi/routes/appointment.js` | L262 | checkin：仅写 `checkin_at` | `// CAS-EXEMPT: 仅写 checkin_at 时间戳，不翻 status` |
| 9 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | L1382 / L1539 | （注释行，文档不动）| 无需注释，正则匹配 `--` 注释会自动跳过；如误命中再加 |

> 建议把 `CAS-EXEMPT:` 注释统一放在 `await client.query(` 行的**上一行**，确保 lint 脚本的 600 字符上下文窗口能识别。

### 5.3 E2E 烟测（已有 link-* 套件复用）

- **link-1 order-allocation**：addCase「并发 save → 第二次 rowCount=0」
- **link-2 service-lifecycle**：addCase「cancel 与 complete 并发 → 仅一方成功」
- **link-4 refund-approval**：已覆盖 CAS（payment 4 处皆 ✅）— 仅回归
- **新增 link-12 state-machine-cas**：跨 5 张表的并发越级覆盖回归

### 5.4 手工验证

- [ ] 5 张状态表每处 ❌ 修复后，构造"另一会话先翻状态"并立即跑被修复路径，确认抛 `INVALID_STATE: STATE_TRANSITION_BLOCKED:` 错误
- [ ] payNotify 修复后，重放历史"并发 confirmOffline + 微信回调"场景，确认不会双发提货 / 双重业绩 / 双重积分
- [ ] store_unbind 三处修复后，approve + reject 并发，仅一方落地，另一方收到 INVALID_STATE
- [ ] `bun run lint:cas-guards`（新加） 全绿
- [ ] 三端测试 `bun run test`（admin） + `npm test`（staff + client + payNotify）全绿

---

## 6 风险与回滚

| 风险 | 缓解 |
|------|------|
| payNotify 修改后微信侧重试可能因 INVALID_STATE 误判失败 | rowCount=0 时返回 `code: 'SUCCESS'` + warn log（不抛 HTTP 500），微信不会重试 |
| allocation_status 加 CAS 后历史 NULL 行 update 失败 | 修复前跑数据修复脚本：`UPDATE sale_orders SET allocation_status='待分配' WHERE allocation_status IS NULL AND status IN ('已支付','部分支付')` |
| store_unbind approve 内事务顺序调整可能引入新 bug | 必须先 CAS 锁状态行、后写顾客解绑；新增 E2E 覆盖"approve 命中"和"reject 后再 approve 失败"双路径 |
| 错误码从 `INVALID_PARAMS` 改 `INVALID_STATE` 影响前端文案 | 各端前端 catch 统一兜底"操作状态已变更，请刷新后重试"，不依赖具体 code |

**回滚策略**：所有改动为纯 SQL WHERE 子句新增 + rowCount 检查，无 schema 变更、无数据迁移。如生产观测到误杀（rowCount=0 真实业务卡顿），单文件 revert + 重新发布即可（云函数 ~ 2 分钟，admin ~ 5 分钟）。

---

## 7 关联

| 项 | 说明 |
|----|------|
| **🔴 强前置** | [`notes/tickets/2026-05-17-error-code-prefix-whitelist-and-admin-throw.md`](./2026-05-17-error-code-prefix-whitelist-and-admin-throw.md) — **必须先做**：把 `INVALID_STATE:` 加入 8 项官方白名单 + 三端 `knownTypes` 识别。否则本 ticket 抛的 `INVALID_STATE:` 会被吞为 HTTP 500 而非 -400，前端兜底文案触发失败 |
| 前置 | 无 schema 变更 |
| 前置 | allocation_status NULL 历史数据修复（一次性 SQL） |
| 关联 | SUMMARY Top10 #8（本 ticket 直接对应） |
| 关联 | [audit-02 订单创建](../../docs/audit/audit-02-order-creation.md)（offlinePay 命中点） |
| 关联 | [audit-03 支付流程](../../docs/audit/audit-03-payment-flow.md)（offlinePay + repay 命中点） |
| 关联 | [audit-04 支付回调](../../docs/audit/audit-04-pay-notify.md)（payNotify 双 UPDATE） |
| 关联 | [audit-05 服务单生命周期](../../docs/audit/audit-05-service-order.md)（service_orders 4 处全 ✅，仅作为模式参考） |
| 关联 | [audit-06 预约 checkin](../../docs/audit/audit-06-appointment-checkin.md)（client cancel 命中点） |
| 关联 | [audit-11 退款流水](../../docs/audit/audit-11-refunds.md)（已合规，仅回归） |
| 关联 | [audit-12 门店绑定](../../docs/audit/audit-12-store-binding.md) — **直接关联**：本 ticket 修复的 store_unbind 三处（approveUnbind / rejectUnbind / cancelUnbindRequest）即此 audit 涵盖范围 |
| 关联 | [audit-CC2 并发与幂等](../../docs/audit/audit-CC2-concurrency-idempotency.md)（横切热点） |
| 参考 | `notes/tickets/archives/2026-04-26-sale-order-domain-refactor.md §1.4`（paymentFlowStatus 5 值定义） |
| 参考 | `db/schema/enums.ts`（5 个状态枚举权威定义） |
| 参考 | 已实现的良好 CAS 模式：`staffApi/routes/order.js:1574-1582`（approveRefund CAS + INVALID_STATE 抛错） |

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **关联 audit 文件名编号错位**：ticket 引用 `audit-02 订单状态机 / audit-03 支付/回款 / audit-04 退款流水 / audit-12 服务单生命周期`，但实际文件名为 `audit-02-order-creation / audit-03-payment-flow / audit-04-pay-notify / audit-12-store-binding`。退款/服务单实际对应 audit-11 / audit-05。读者按链接点会找不到对应文档，且 audit-12 实际是"门店绑定"而非"服务单生命周期"——这恰好和 ticket 修复的 store_unbind 三处相关却没指出来。建议修正引用。
2. **错误前缀 `INVALID_STATE:` 不在 CLAUDE.md 4 项官方白名单**：CLAUDE.md 全局规范只允许 `UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED`。ticket #10（error-code-prefix-whitelist）要求把白名单扩到 8 项含 `INVALID_STATE`，**本 ticket 必须声明 #10 为强前置**；当前文档未列入"7 关联"前置区，若先于 #10 实施，clientApi/payNotify 端 knownTypes 不识别 `INVALID_STATE:`，会被吞为 500 而非 -400。

**Warn 级问题**：
3. **payNotify 修复缺关键变量**：4.2 diff 写 `if (updResult.rowCount === 0)`，但原代码 L266 是 `await client.query(...)` 无赋值；如不一并改成 `const updResult = await client.query(...)`，diff 应用后会 ReferenceError。
4. **lint 正则的 False Positive 风险**：`grep -E "UPDATE\s+sale_orders" ... | grep -v "AND.*status\s*="` 会误命中只写资金/PII 列的 9 处 N/A（如 L777/L782/L874 auth.js bindPhone 等），需 `CAS-EXEMPT` 注释逐处豁免——ticket 提到了豁免口但未列出全 9 处需加注释的清单，实施时容易遗漏导致 CI 红。
5. **admin 与 ticket 改造路径的乐观锁双层冗余**：admin 已用 `expectedUpdatedAt` 乐观锁 + 部分 CAS（orders.ts:2039 `AND status=${locked.status}`、refunds.ts:776/940），ticket 第 1.1 表把它们都标 ✅，但未说明"admin 是否需要把错误码从 `CONCURRENT_CHANGED` 迁到统一 `INVALID_STATE:`"——这是 #10 ticket 的边界。建议明确"admin 端 ✅ 保持现状，不参与本 ticket"。
6. **payNotify "uq_sop_txn 已防 race"判定准确**：实证 `uq_sop_txn ON sale_order_payments(sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL` 只保证 payments 插入幂等，**不能**阻止 sale_orders 越级覆写——ticket §0/§1 命中汇总注脚论证正确。
7. **lint 跨行匹配靠 `[\s\S]{0,400}`**：grep `-E` 在 macOS BSD/GNU 下对多行兼容性不一致，建议改 `ripgrep --multiline` 或 node 脚本，否则 CI 跨平台不稳。

**OK**：
- §1 全表 41 处枚举与实证 grep 完全吻合，10 处 ❌ 抽样验证全部精确到行号 + 现状 SQL 一致。
- 抽样 ✅ 验证（staff order L949 confirmOffline、L1126 close、L1187 resetFailed、L1931 createRepayment）全部确认。
- service_orders 3 处确实已全 ✅，ticket 标记准确未漏。
- sale_orders.allocation_status 已被显式归入 §1.1 §3.1 模板，与 status 区分处理（用 `IN ('待分配','已分配')` 软幂等）。
- §6 回滚策略（纯 WHERE + rowCount 检查，无 schema 变更）成本与风险评估合理。

**改进建议**：
- 在 §7 关联表 "前置" 一栏明确加 `notes/tickets/2026-05-17-error-code-prefix-whitelist-and-admin-throw.md`（先白名单后 throw），否则三端 errorType 路由会失效。
- §4.2 payNotify diff 补 `const updResult =`，并加注 "原代码无变量需同步改造"。
- §5.2 lint 脚本附带初始 `CAS-EXEMPT` 注释 patch 清单（9 处 N/A 行的具体文件:行号），避免首次跑 lint 全红。
- 修正 §0 / 关联区中 audit-02/03/04/12 的文件名引用至实际 audit-02-order-creation / audit-03-payment-flow / audit-04-pay-notify / audit-11-refunds / audit-05-service-order。
- store.js approveUnbind §4.5 提示"调换 UPDATE 顺序"是对的，但需要在 patch 里**直接给出新顺序代码**，仅文字描述实施时易漏。
