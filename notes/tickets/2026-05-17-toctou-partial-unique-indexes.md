# Ticket: TOCTOU partial UNIQUE 索引一次性 migration（v2 修订：剩 7 项 + 1 项重设计）

> 创建日期：2026-05-17
> **v2 修订日期**：2026-05-17（R2 复核反馈落地）
> 实施状态：🔴 未启动（schema + 应用层均需改动）
> 严重级别：**P0**（SUMMARY v3 Top10 #9）
> 端：db / fengyu-staff / fengyu-client / fengyu-admin
> 修复成本：**M**（1-3 天，含三端 ON CONFLICT 改造 + 应用层错误捕获 + e2e 并发回归）
> 来源：[SUMMARY §2 #9](../../docs/audit/SUMMARY.md) + [SUMMARY §3「TOCTOU：事务外读 → 事务内 INSERT」横切](../../docs/audit/SUMMARY.md) + [audit-CC2-concurrency-idempotency §P1-CC2-13](../../docs/audit/audit-CC2-concurrency-idempotency.md)
> 关联 audit：03 / 05 / 06 / 12 / 13×2 / CC2

---

## v2 修订摘要（2026-05-17 R2 复核后）

**实际落地范围从原 10 项调整为 7 项 partial unique + 1 项幂等键列重设计：**

| 原编号 | 项 | v1 方案 | v2 调整 | 原因 |
|--------|----|----|---------|------|
| #1 | sale_order_payments 首次支付 | partial unique on (sale_order_id) | **保留 partial unique**，但 §5 改造范围扩大到 **6 处 INSERT**（不止 v1 列的 2 处）| v1 line 号偏移严重，遗漏 L626 / L962 / payNotify L235 等；ON CONFLICT 必须全覆盖 |
| #5 | appointments(employee_id, appointment_time) | partial unique | ❌ **移出本 ticket** | 业务真正约束是 2 小时槽位**重叠**，timestamp 精确相等的 partial unique 给错误安全感；正确方案是 `EXCLUDE USING gist + tstzrange`，另立 ticket |
| #7 | card_transactions(ref_order_id, type) | partial unique | 🔄 **重设计为 external_ref 幂等键列** | 现有 `cardTransactionTypeEnum` 只有 `['充值','扣款']` 2 值；退款回冲实写 `type='充值'` 但 ref_order_id 拼 `REPAY-{ts}` 会与原始充值撞死；UNIQUE(ref_order_id,type) 探伤必然非 0 行 |
| #10 | user_coupons(template_id, user_id) | partial unique（方案 A）| 🔄 **重设计为 external_ref 幂等键列** | 与 4 套现有业务路径直接打架：年度生日权益重发 / 月度感恩节权益重发 / 会员升降级权益重发 / share-gift 多订单受赠；方案 A 不可行 |
| 其余 #2/#3/#4/#6/#8/#9 | 保持 v1 方案 | — | — | 探伤前提仍需在生产 5434 实测行数 |

**Phase -1 新增**：探伤报告子任务（4 张高写入表实测 count + 业务方确认清洗策略），先于 schema 改动。

**§4 调整**：原 SQL 草稿降级为"目标态描述"，不再手写 `--> statement-breakpoint`，由 schema.ts → `db:generate` 产出。

**协同关系**：本 ticket = 三层防御的第三层（CAS + advisory + partial unique），与 ticket #8（state-machine-CAS）/ ticket #3（advisory-lock）同步规划，避免应用层重复实现 SELECT-then-INSERT 防重。

---

## 0 一句话背景

`uq_sop_status_audit`（migration 0018）落地后，"TOCTOU：事务外 SELECT → 事务内 INSERT 无 partial UNIQUE 兜底"原 11 项缺口剩 10 项。**v2 复核后再剔 1 项（appointment 槽位重叠）+ 2 项改走幂等键列方案**，本 ticket 实际交付 **7 项 partial unique + 2 项 external_ref 幂等键列**。

## 1 已落地 1 项参考（uq_sop_status_audit 设计与工作机制）

### DDL（migration 0018，`db/migrations/0018_black_madrox.sql:32`）

```sql
CREATE UNIQUE INDEX "uq_sop_status_audit"
  ON "sale_order_payments" USING btree ("sale_order_id","change_type")
  WHERE change_type = '退款' AND status = '待审批';
```

### Schema 声明（`db/schema/order.ts:301`）

```ts
uniqueIndex("uq_sop_status_audit")
  .on(table.saleOrderId, table.changeType)
  .where(sql`change_type = '退款' AND status = '待审批'`),
```

### 工作机制

1. **WHERE 谓词收窄**：只有 `change_type='退款' AND status='待审批'` 的活跃行进入唯一索引；终态行（已支付/已作废）天然不参与，不会与历史退款审计冲突
2. **DB 层兜底 TOCTOU**：staff/admin 双端 `createRefund` 在事务外 SELECT 是否存在 in-flight 退款；并发提交时第二笔 INSERT 命中 23505 (`unique_violation`)，由调用方 catch 翻译为 `CONFLICT: 已有待审批的退款`
3. **审批完成自动释放**：approveRefund / rejectRefund 将 status 翻为终态后，该行自动退出 partial 索引覆盖范围，下一笔退款可正常进入
4. **不依赖应用层 advisory lock**：纯 schema 守卫，跨端、跨进程、跨实例均生效

> 同模式还需复制到 7 项 partial unique；另 2 项（card_txn / user_coupons）走 external_ref 幂等键列。

## 2 待补清单（v2：7 项 partial unique + 2 项 external_ref 幂等键列）

### 2.1 sale_order_payments — 1 项（首次支付幂等）

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 1 | `sale_order_payments(sale_order_id)` WHERE `change_type='首次支付' AND status='已支付'` | 同一销售单只能有 1 笔已成功的"首次支付"行；后续款项必须落 `change_type='回款'` | `change_type='首次支付' AND status='已支付'` | **6 处 INSERT 全部需改造**（v1 仅列了 2 处，line 号已偏移，v2 实测如下）：<br>① `staffApi/routes/order.js:626`（order.create 现场收款，硬编码 `'首次支付'`）<br>② `staffApi/routes/order.js:931`（confirmOffline 储值卡抵扣分支，硬编码 `'储值卡抵扣'` — **不在 partial 覆盖**，但同事务内需注意 ON CONFLICT 不要误命中）<br>③ `staffApi/routes/order.js:962`（confirmOffline 主分支，`paymentChangeType` 取 L890 判定结果，可能为 `'首次支付'` 或 `'回款'`）<br>④ `staffApi/routes/order.js:1477`（createRefund 写退款行，change_type='退款'，**不在 partial 覆盖**）<br>⑤ `staffApi/routes/order.js:1889`（createRepayment 回款，`'回款'`，**不在 partial 覆盖**）<br>⑥ `staffApi/routes/order.js:1898`（createRepayment 储值卡抵扣分支，`'储值卡抵扣'`，**不在 partial 覆盖**）<br>⑦ `payNotify/index.js:235`（微信/支付宝回调写支付行；L229 SELECT 决定 `changeType` 为 `'首次支付'` 或 `'回款'`）<br>⑧ `payNotify/index.js:400`（同 notify 路径储值卡抵扣分支，`'储值卡抵扣'`，**不在 partial 覆盖**）<br>**实际命中 partial unique 的写入点为 ①③⑦（3 处），均需加 ON CONFLICT (sale_order_id) WHERE change_type='首次支付' AND status='已支付' DO NOTHING；其余 5 处虽不命中本 partial unique，但 §5 列表必须完整列出，避免遗漏其他索引（如 #1/#7 改造时漏改）** |

### 2.2 service_orders — 2 项

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 2 | `service_orders(appointment_id)` WHERE `appointment_id IS NOT NULL` | 同一预约只能关联 1 张服务单 | `appointment_id IS NOT NULL` | `staffApi/routes/service.js:64`（事务外 `SELECT service_order_id FROM service_orders WHERE appointment_id=$1`）→ `:175` INSERT；并发同一 appointmentId 双 create 产生多对一脏数据（audit-05 P0-05-03 / audit-06 P0-06-03） |
| 3 | `service_orders(client_user_id)` WHERE `status IN ('待服务','服务中')` | 同一顾客同时只能有 1 张活跃服务单 | `status IN ('待服务','服务中')` | `staffApi/routes/service.js:145`（事务外 `SELECT ... WHERE client_user_id=$1 AND status IN ('待服务','服务中') LIMIT 1`）→ INSERT；并发同顾客双 create 通过校验（audit-05 P0-05-03） |

### 2.3 appointments — 1 项（v2：原 2 项缩减为 1 项；#5 移出本 ticket）

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 4 | `appointments(sale_item_id)` WHERE `status IN ('待确认','已确认')` | 同一 sale_item 同时只能有 1 个活跃预约 | `sale_item_id IS NOT NULL AND status IN ('待确认','已确认')` | `clientApi/routes/appointment.js:83-87`（事务外 `SELECT appointment_id FROM appointments WHERE sale_item_id=$1 AND status IN ('待确认','已确认')`）→ `:108` INSERT；3 个 SELECT + INSERT 全是散查无事务（audit-06 NEW-P1-06-D / P0-06-03 衍生） |

> **❌ 原 #5 `appointments(employee_id, appointment_time)` 已移出本 ticket**：
> 业务真正约束是"同员工同时间段（2 小时槽位）不可重叠"（real.md），而非 timestamp 精确相等。`appointment_time` 精度可至秒，partial unique on (employee_id, appointment_time) **只在"两次 confirm 写完全相同的时间戳"时生效**，对常见"10:00 vs 10:30 重叠"无防护；同时 `appointment.js:204` 实际是 UPDATE 而非 INSERT，v1 描述"INSERT catch 23505"语义错配。
>
> **正确方案**：另立 ticket，使用 `EXCLUDE USING gist (employee_id WITH =, tstzrange(appointment_time, appointment_time + interval '2 hours') WITH &&)` 约束。本 ticket 不实施任何 partial unique 在这两列上，避免给错误安全感。

### 2.4 store_unbind_requests — 1 项

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 5 | `store_unbind_requests(user_id)` WHERE `status='待处理'` | 同一顾客同时只能有 1 条 pending 解绑申请（real.md #7 业务等价） | `status='待处理'` | `clientApi/routes/store.js:146-159`（事务外 `SELECT request_id FROM store_unbind_requests WHERE user_id=$1 AND status='待处理'`）→ INSERT；双击 / 弱网重试可写多行（audit-12 P0-12-05） |

### 2.5 card_transactions — 🔄 v2 重设计为 external_ref 幂等键列（原 partial unique 方案废弃）

| # | 表 / 列 | 业务语义 | 落地形态 | 当前 TOCTOU 代码 |
|---|--------|---------|---------|----------------|
| 6 | **新增列** `card_transactions.external_ref text` + `CREATE UNIQUE INDEX uq_card_txn_external_ref ON card_transactions (external_ref) WHERE external_ref IS NOT NULL` | 业务调用方传入幂等键（如 `card-deduct-{saleOrderId}` / `card-refund-{refundId}`）作为重试防重根据；与现有 `uq_point_txns_external_ref` 同一模式 | 列 NULL 时不参与索引（历史数据无影响） | 5 处 INSERT 全无幂等键：`staffApi/routes/order.js:925`（线下扣卡）/ `:1027`（扫码扣卡）/ `:1611`（退款回冲，type='充值' ref=REPAY-{ts}）/ `:1877`（管理后台调用，同 REPAY-{ts} 拼接，**与 :1611 撞同 ref_order_id 但不同时间戳**）/ `:2309`（充值） |

> **为什么不能走原 v1 方案 `UNIQUE(ref_order_id, type) WHERE ref_order_id IS NOT NULL`**：
>
> 1. **枚举矛盾**：`cardTransactionTypeEnum = ['充值','扣款']`（`db/schema/enums.ts:97`）只有 2 个值，v1 描述"同动作（充值/扣款/退款）"中的"退款"枚举不存在；退款回冲在代码里实际写 `type='充值'`（`order.js:1611/1877`）
> 2. **ref_order_id 冲突**：`order.js:1611` 退款回冲与 `:1877` 管理后台调用都构造 `REPAY-{refSaleOrderId}-{ts}`，两端可能在同一原单上各自触发，时间戳不同但前缀相同；UNIQUE(ref_order_id, type) 探伤会产生大量 `(REPAY-XXX-T1, '充值'), (REPAY-XXX-T2, '充值')` 这类合法重复行
> 3. **正向扣款 + 反向回冲撞死**：同 saleOrderId 下"线下扣卡 + 后续审批退款回冲"原本是两笔合法流水，但 UNIQUE(ref_order_id, type) 会判定为冲突
>
> **新方案**：调用方按场景生成 external_ref（如 `card-deduct-{saleOrderId}-{action}` / `card-refund-{refundPaymentId}` / `card-recharge-{rechargeOrderId}`），DB 仅在 external_ref 非空时强制唯一；保持现有 ref_order_id / type 完全自由，不动既有数据。

### 2.6 point_transactions — 1 项

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 7 | `point_transactions(user_id, ref_order_id, type)` WHERE `ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')` | 同订单同顾客同类型积分动作只能落 1 行流水 | `ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')` | `staffApi/utils/points.js:83` settlePoints INSERT 无幂等键；refund-cascade 通道 4 写"消费冲销"用 `NOT EXISTS` 防重（脆弱），audit-CC2 P1-v2-04 明确"先补约束再补 ON CONFLICT"；现有 `uq_point_txns_external_ref` 仅覆盖系统批量发放，业务流水的 `external_ref` 实际为 NULL，partial unique 完全失效 |

### 2.7 pickup_records — 1 项

| # | 表 / 列 | 业务语义 | partial WHERE | 当前 TOCTOU 代码 |
|---|--------|---------|---------------|----------------|
| 8 | `pickup_records(sale_item_id, idempotency_key)` | 同一 sale_item 同一幂等键只能落 1 条提货记录；需先 ALTER ADD COLUMN `idempotency_key text` | `idempotency_key IS NOT NULL` | `staffApi/routes/order.js:2452` INSERT 无幂等键字段；前端双击 / 网络重试可产生重复扣减 sale_items.picked_up_quantity（audit-CC2 P2-CC2-18 列表第一项） |

> **NULL 行为明确**：方案是 NULLABLE + partial unique（仅 idempotency_key 非空时强制唯一）。这意味着：
>
> - **不带 `idempotencyKey` 的旧前端调用方继续可以重复 INSERT**，partial unique **完全无防护**
> - 真正的防护要等三端前端发版传入 idempotencyKey 后才生效
> - **Phase 3 e2e 验证项必须假设"前端传 idempotencyKey"**，否则双发 INSERT 仍可写两行
> - 风险表（§7）和 e2e 用例需同步对齐这个前提，避免自相矛盾

### 2.8 user_coupons — 🔄 v2 重设计为 external_ref 幂等键列（原方案 A 不可行）

| # | 表 / 列 | 业务语义 | 落地形态 | 当前 TOCTOU 代码 |
|---|--------|---------|---------|----------------|
| 9 | **新增列** `user_coupons.external_ref text` + `CREATE UNIQUE INDEX uq_user_coupons_external_ref ON user_coupons (external_ref) WHERE external_ref IS NOT NULL` | 业务调用方传入幂等键（cron 已用的批次键如 `bday-{YYYY}-{userId}-{templateId}` / `thx-{YYYYMM}-{userId}-{templateId}` / `lvlup-{userId}-{templateId}-{level}` / `share-{orderId}-{recipientUserId}`）作为本次发放的唯一标识 | 与 `uq_point_txns_external_ref` 同一模式；列 NULL 时不参与索引（历史数据无影响） | admin 端 `fengyu-admin/src/actions/coupons.ts:527-535` issueCoupon + `:652-664` batchIssueCoupons 仍需 advisory lock + 事务内 recount（防超发，不防同人重复）；cron / share-gift 4 处用 external_ref 防重 |

> **❌ 原 v1 方案 A `UNIQUE(template_id, user_id)` 不可行**：
>
> 与现有 4 套业务路径**直接打架**：
>
> 1. `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:171` — 年度幂等键 `bday-{YYYY}-{userId}-{templateId}`，每年同模板同人重发，加 UNIQUE 后第 2 年起 23505
> 2. `fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts:173` — 月度幂等键 `thx-{YYYYMM}-{userId}-{templateId}`，每月重发同理
> 3. `fengyu-admin/src/cron/steps/refresh-member-levels.ts:308` — 升降级权益重发同模板
> 4. `fengyu-client/cloudfunctions/payNotify/share-gift.js:106`（staff + clientApi + payNotify 三处副本）— 礼包同一受赠人可被不同订单的不同分享对象同时给到同一模板
>
> 探伤 SELECT(原 #10) 在生产几乎必然非 0 行；方案 A "推荐"实际上不可行。
>
> **v2 改方案**（合并 R2 建议 #1 + #2 + #7 同一模式）：
>
> - **DB 层**：仅加 `external_ref` 列 + partial unique（不加 `(template_id, user_id)` 全行 UNIQUE）
> - **应用层**：admin issueCoupon / batchIssueCoupons 仍走 `pg_advisory_xact_lock(hashtext('coupon-issue-' + templateId))` + 事务内 recount 防超发（**这部分属于 ticket #3 advisory-lock 协同范围**）；cron 4 路径与 share-gift 各自构造 external_ref 走 ON CONFLICT (external_ref) DO NOTHING
> - **彻底删除"同模板同人不重复"业务约定**，与会员升级/生日/感恩节/分享四套业务的语义保持一致

## 3 一次性 migration 设计（v2）

**单文件 migration 名**（drizzle 自动编号，预留 0028 起）：`00NN_toctou_partial_unique_indexes.sql`

设计原则：
- 每个 UNIQUE 索引前先跑探伤 SELECT；**Phase -1 必须在 PR 描述里附 4 张高写入表的实测 count**（user_coupons / card_transactions / sale_order_payments / point_transactions）+ 业务方确认清洗策略后才能继续 Phase 0
- pickup_records / card_transactions / user_coupons 需先 ALTER ADD COLUMN external_ref（或 idempotency_key），再建索引
- 不使用 `CONCURRENTLY`：drizzle-kit 不支持在自有事务外执行；只能阻塞式建索引，需在低峰期执行。**阻塞窗口估算依据**：Phase -1 实测各表行数后估算（PG 16 btree 单核 ~100k 行/秒），<100k 行表预计 <1s
- schema 同步更新 `db/schema/order.ts` / `appointment.ts` / `service.ts` / `store-unbind.ts` / `prepaid-card.ts`（加 external_ref）/ `points.ts` / `pickup.ts`（加 idempotency_key）/ `coupon.ts`（加 external_ref），drizzle-kit `db:generate` 自动产出 SQL
- pickup_records 的 `idempotency_key` 列由前端在 `createPickup` 请求时传入（如 `pickup-{saleItemId}-{timestamp}` 或 UUID）
- card_transactions / user_coupons 的 `external_ref` 由各调用方按业务场景拼接（cron 用批次键 / 业务流水用 saleOrderId 维度）

## 4 目标态描述（不写 SQL 草稿，走 schema.ts → db:generate）

> ⚠️ **v2 修订**：v1 §4 给的 SQL 草稿（含手写 `--> statement-breakpoint`）违反 `db/CLAUDE.md` "禁止手写 .sql 塞进 db/migrations/" 的规则，已移除。正确流程：改 schema → `cd db && npm run db:generate` → 检查 drizzle-kit 产出 SQL 通过 e2e 行为校验。

### 目标态（7 项 partial unique）

| # | 表 | 索引名 | 列 | WHERE 谓词 |
|---|----|--------|----|----|
| 1 | sale_order_payments | uq_sop_first_payment | (sale_order_id) | change_type='首次支付' AND status='已支付' |
| 2 | service_orders | uq_so_appointment | (appointment_id) | appointment_id IS NOT NULL |
| 3 | service_orders | uq_so_client_active | (client_user_id) | status IN ('待服务','服务中') |
| 4 | appointments | uq_appt_sale_item_active | (sale_item_id) | sale_item_id IS NOT NULL AND status IN ('待确认','已确认') |
| 5 | store_unbind_requests | uq_store_unbind_pending | (user_id) | status='待处理' |
| 7 | point_transactions | uq_point_txn_order_user_type | (user_id, ref_order_id, type) | ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销') |
| 8 | pickup_records | uq_pickup_idempotency | (sale_item_id, idempotency_key) | idempotency_key IS NOT NULL |

### 目标态（2 项 external_ref 幂等键列 + partial unique，同 uq_point_txns_external_ref 模式）

| # | 表 | 新增列 | 索引名 | 列 | WHERE 谓词 |
|---|----|--------|--------|----|----|
| 6 | card_transactions | external_ref text | uq_card_txn_external_ref | (external_ref) | external_ref IS NOT NULL |
| 9 | user_coupons | external_ref text | uq_user_coupons_external_ref | (external_ref) | external_ref IS NOT NULL |

### 探伤 SELECT（Phase -1 在生产 5434 实测，全部应 0 行 + count 数量）

```sql
-- (1) sale_order_payments 首次支付重复行 + 总行数
SELECT COUNT(*) AS total_rows FROM sale_order_payments;
SELECT sale_order_id, COUNT(*) FROM sale_order_payments
WHERE change_type='首次支付' AND status='已支付'
GROUP BY sale_order_id HAVING COUNT(*) > 1;

-- (2) service_orders 同 appointment 多关联 + 总行数
SELECT COUNT(*) AS total_rows FROM service_orders;
SELECT appointment_id, COUNT(*) FROM service_orders
WHERE appointment_id IS NOT NULL
GROUP BY appointment_id HAVING COUNT(*) > 1;

-- (3) 同顾客多张活跃服务单
SELECT client_user_id, COUNT(*) FROM service_orders
WHERE status IN ('待服务','服务中')
GROUP BY client_user_id HAVING COUNT(*) > 1;

-- (4) 同 sale_item 多活跃预约 + appointments 总行数
SELECT COUNT(*) AS total_rows FROM appointments;
SELECT sale_item_id, COUNT(*) FROM appointments
WHERE sale_item_id IS NOT NULL AND status IN ('待确认','已确认')
GROUP BY sale_item_id HAVING COUNT(*) > 1;

-- (5) 同顾客多 pending 解绑申请
SELECT user_id, COUNT(*) FROM store_unbind_requests
WHERE status='待处理'
GROUP BY user_id HAVING COUNT(*) > 1;

-- (6) card_transactions 总行数（用于 ALTER ADD COLUMN external_ref 阻塞窗口估算）
SELECT COUNT(*) AS total_rows FROM card_transactions;

-- (7) point_transactions 总行数 + 同订单同顾客同类型多笔业务积分流水
SELECT COUNT(*) AS total_rows FROM point_transactions;
SELECT user_id, ref_order_id, type, COUNT(*) FROM point_transactions
WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
GROUP BY user_id, ref_order_id, type HAVING COUNT(*) > 1;

-- (8) pickup_records 列添加是新列，无需重复探伤

-- (9) user_coupons 总行数（v2：不再探伤 (template_id, user_id) 重复，业务上合法）
SELECT COUNT(*) AS total_rows FROM user_coupons;
```

## 5 应用层配合（命中 unique 后的错误捕获与友好提示）

每个 INSERT 调用点新增 `ON CONFLICT DO NOTHING` 或 catch 23505 翻译为业务错误。**禁止裸抛**，否则前端报"系统异常"。

> **双库说明**（v2 新增）：本 ticket 主跑生产业务库 **5434/fengyu**（admin + 全部云函数共用）；5433/fengyu_wxapp 自 2026-04-24 起为冷备，**可选双跑**用于灾备演练场景。若选择不双跑，5433 在下次灾备切换前需补跑同一 migration。

| # | 代码路径 | 改造方式 |
|---|---------|---------|
| 1 | sale_order_payments 共 8 处 INSERT（v2 实测）：<br>① `staffApi/routes/order.js:626`（'首次支付'）<br>② `staffApi/routes/order.js:931`（'储值卡抵扣'）<br>③ `staffApi/routes/order.js:962`（动态 paymentChangeType）<br>④ `staffApi/routes/order.js:1477`（'退款'）<br>⑤ `staffApi/routes/order.js:1889`（'回款'）<br>⑥ `staffApi/routes/order.js:1898`（'储值卡抵扣'）<br>⑦ `payNotify/index.js:235`（动态 changeType）<br>⑧ `payNotify/index.js:400`（'储值卡抵扣'）| **命中 partial unique (#1) 的 3 处（①③⑦）**：INSERT 加 `ON CONFLICT (sale_order_id) WHERE change_type='首次支付' AND status='已支付' DO NOTHING`，rowCount=0 抛 `CONFLICT: 订单已收款`<br>其余 5 处（②④⑤⑥⑧）保持原 INSERT，但 §5 列出避免遗漏（与 `uq_sop_status_audit` 等其他索引交互的回归点）|
| 2 | `staffApi/routes/service.js:175` | catch 23505 + `constraint='uq_so_appointment'` 抛 `CONFLICT: 该预约已关联服务单` |
| 3 | `staffApi/routes/service.js:175`（同上 try / 区分 constraint name）| catch 23505 + `constraint='uq_so_client_active'` 抛 `CONFLICT: 该顾客已有进行中的服务单` |
| 4 | `clientApi/routes/appointment.js:108` | catch 23505 + `constraint='uq_appt_sale_item_active'` 抛 `CONFLICT: 该订单明细已有待确认或已确认的预约` |
| 5 | `clientApi/routes/store.js:155` | INSERT 加 `ON CONFLICT (user_id) WHERE status='待处理' DO NOTHING`，rowCount=0 抛 `CONFLICT: 已有待审批的解绑申请` |
| 6 | `staffApi/routes/order.js` 5 处 card_transactions INSERT（:925/:1027/:1611/:1877/:2309） | 调用方按场景生成 external_ref（如 `card-deduct-{saleOrderId}` / `card-refund-{refundPaymentId}` / `card-recharge-{rechargeOrderId}`），INSERT 加 external_ref 列；加 `ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`；rowCount=0 静默（幂等成功）。**注意 :1611 与 :1877 同走 REPAY 路径但来源不同（订单审批 vs admin），external_ref 必须区分调用入口**|
| 7 | `staffApi/utils/points.js:83` + `helpers/refund-cascade.js:99-132` | 改 `ON CONFLICT (user_id, ref_order_id, type) DO NOTHING`；refund-cascade 通道 4 移除当前脆弱的 `NOT EXISTS` 检查 |
| 8 | `staffApi/routes/order.js:2452` + `cloudfunctions/staffApi/routes/order.js:createPickup` 入参 | payload 加 `idempotencyKey?: string`；INSERT `ON CONFLICT (sale_item_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`；前端 `confirmPickup` 调用点每次按钮点击生成 `pickup-{saleItemId}-{Date.now()}`。**未传 idempotencyKey 的旧前端无防护**（参见 §2.7 NULL 行为说明）|
| 9 | cron 4 处 + share-gift 3 副本：<br>① `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:171` — external_ref=`bday-{YYYY}-{userId}-{templateId}`<br>② `fengyu-admin/src/cron/steps/grant-thanksgiving-benefits.ts:173` — `thx-{YYYYMM}-{userId}-{templateId}`<br>③ `fengyu-admin/src/cron/steps/refresh-member-levels.ts:308` — `lvlup-{userId}-{templateId}-{level}`<br>④ `fengyu-client/cloudfunctions/payNotify/share-gift.js:106`（+ staff/clientApi 副本）— `share-{orderId}-{recipientUserId}`<br>⑤ `fengyu-admin/src/actions/coupons.ts:527-535` issueCoupon + `:652-664` batchIssueCoupons | 上述 4 路径 INSERT 加 external_ref + `ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`；rowCount=0 静默（幂等成功）<br>admin issueCoupon / batchIssueCoupons 维持 advisory lock + 事务内 recount 防超发（属 ticket #3 协同范围，本 ticket 不强求） |

## 6 验证 Checklist（v2）

### Phase -1：探伤报告子任务（v2 新增，前置于 schema 改动）

- [ ] 在生产业务库 5434/fengyu 跑 §4 全部探伤 SELECT，**PR 描述附 4 张高写入表实测 count**：user_coupons / card_transactions / sale_order_payments / point_transactions
- [ ] 如果某表 > 1M 行，需在 PR 评论评估"ALTER ADD COLUMN + CREATE UNIQUE INDEX"阻塞窗口（参考 PG 16 btree ~100k 行/秒经验值），决定是否走业务低峰执行
- [ ] 若任意探伤 SELECT 非 0 行（特别是 #1 sale_order_payments 首次支付，可能因历史 bug 真实产生重复行）：先在 PR 评论附原始行 + 清洗脚本，**业务方判定后再进入 Phase 0**
- [ ] 与 ticket #8 state-machine-CAS / ticket #3 advisory-lock 责任人对齐：本 ticket = 三层防御的第三层（CAS + advisory + partial unique），避免应用层 SELECT-then-INSERT 防重逻辑重复实现

### Phase 0：离线验证（drizzle-kit 流程）

- [ ] 改 `db/schema/*.ts` 7 个文件加 `uniqueIndex(...)`；pickup.ts 加 `idempotencyKey` 列；prepaid-card.ts 加 card_transactions.external_ref；coupon.ts 加 user_coupons.external_ref
- [ ] `cd db && npm run db:generate` 产出 migration SQL（**不要手写**）
- [ ] 起临时 docker PG 验证空库 migrate 成功：
  ```bash
  docker run -d --name drizzle-migrate-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 54399:5432 postgres:16
  DATABASE_URL="postgresql://postgres:test@localhost:54399/test" npm run db:migrate
  docker rm -f drizzle-migrate-test
  ```
- [ ] 对每个新 partial unique 在 docker PG 上构造冲突 INSERT 验证 23505 抛出（**用 e2e 行为校验代替 v1 的"产出 SQL 与 §4 草稿一致"**）

### Phase 1：上线前生产探伤（v2 已并入 Phase -1）

- [ ] **绝对禁止**直接 psql DDL，必须走 drizzle migrate

### Phase 2：上 5434 部署

- [ ] 业务低峰期执行 `cd db && DATABASE_URL="postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu" npm run db:migrate`
- [ ] 立即跑 `SELECT indexname FROM pg_indexes WHERE indexname LIKE 'uq_%' ORDER BY 1;` 验证 7 + 2 = 9 个新索引全部存在
- [ ] 部署 cloudbase 三端云函数（staffApi / clientApi / payNotify）+ admin 镜像
- [ ] cloudbase env 检查 PG_CONNECTION_STRING 未变（禁 `tcb fn deploy --force`）
- [ ] **5433 冷备库可选双跑**（灾备演练前必跑）

### Phase 3：并发压测验证

- [ ] e2e `Promise.all` 双发对每个场景验证 partial unique / external_ref 命中：
  - confirmOffline 双店长同订单 → 仅 1 行 '首次支付'（命中 uq_sop_first_payment）
  - service.create 同 appointmentId 双 staff → 仅 1 张 service_order
  - appointment.create 同 saleItemId 双 client → 仅 1 个预约
  - requestUnbind 同 userId 双发 → 仅 1 条 pending
  - card_transactions 重复 INSERT 同 external_ref → ON CONFLICT 静默
  - cron grant-birthday-benefits 重跑同年 → ON CONFLICT (external_ref) 静默
  - share-gift 同 orderId/recipient 双发 → 仅 1 张券
  - **pickup 双发必须带 idempotencyKey** 才能验证 unique 命中（不带不验证）
- [ ] e2e 复用 `fengyu-admin/tests/e2e-chains/link-*.spec.ts` 模式，新增 `link-12-toctou-partial-unique.spec.ts`

### Phase 4：snapshot 守护

- [ ] `db/migrations/meta/_journal.json` + `00NN_snapshot.json` 同步入仓
- [ ] 跨端 SQL snapshot 测试（`cross-end-sql-snapshot.test.js`）加 case：grep 三端代码不应再出现"事务外 SELECT 防重 → 事务内 INSERT 无 ON CONFLICT"模式

## 7 风险与回滚

| 风险 | 概率 | 应对 |
|------|------|------|
| 探伤命中脏数据无法清洗（业务真实双开） | 中 | 先在 PR 评论列出 + 业务方判定 → 选合并 / 取消重发 / 改 UNIQUE 含 status 维度 |
| `CREATE UNIQUE INDEX` 阻塞写入（无 CONCURRENTLY） | 低 | 业务低峰执行；Phase -1 实测行数后估算阻塞窗口（PG 16 btree ~100k 行/秒，<100k 行表预计 <1s）|
| 应用层未来某次 INSERT 漏改 → 23505 直抛前端 | 中 | 三端统一 catch 23505 → `CONFLICT:` 前缀；snapshot 测试守护 |
| pickup_records 历史无 idempotency_key 列，前端调用点未对齐 | 高（v2 上调）| 新列默认 NULL 不参与索引；旧路径仍可写入而不被保护；**两阶段必须严格执行**：阶段 1 = ALTER + 索引（DB 上线，无防护生效）；阶段 2 = 三端前端发版传 idempotencyKey（防护真正生效）。Phase 3 e2e 验证必须在阶段 2 之后跑 |
| card_transactions / user_coupons 旧 INSERT 未传 external_ref | 高 | 同 pickup 两阶段；DB 上线后仅"新代码路径走幂等保护"，旧路径仍可重复 INSERT；snapshot 测试 grep 兜底 |
| 回滚 migration 需 DROP INDEX | 低 | 单独写回滚 SQL `DROP INDEX IF EXISTS uq_...`，不影响数据；新增的 external_ref / idempotency_key 列保留即可 |

**回滚条件**：若生产部署后 30 分钟内三端任一域出现 23505 突增告警（> 平常 100×），立即 `DROP INDEX` 对应索引并回滚应用层 ON CONFLICT 改动。

## 8 关联

| 项 | 说明 |
|----|------|
| 关联 ticket | [2026-04-27-allocation-ratio-check-constraint.md](./archives/2026-04-27-allocation-ratio-check-constraint.md)（同属 L0 schema 不变量 epic）<br>**ticket #3 advisory-lock** — 本 ticket = 三层防御第三层，admin issueCoupon advisory lock 防超发归 #3 范围<br>**ticket #8 state-machine-CAS** — 本 ticket 与 #8 同为应用层 SELECT-then-INSERT 防重的替代方案，避免重复实现<br>**另立 ticket（待建）** — appointments 槽位重叠 `EXCLUDE USING gist + tstzrange` |
| 关联 migration | 0018 `uq_sop_status_audit`（参考实现）/ 0022 ratio CHECK / 0024 commission_rate CHECK |
| 关联 audit | [audit-CC2 §P1-CC2-13](../../docs/audit/audit-CC2-concurrency-idempotency.md)（8 项基线清单）/ audit-03 §P0-03v2-03（首次支付）/ audit-05 §P0-05-03（服务单×2）/ audit-06 §P0-06-03 + §P1-06-06（预约×2）/ audit-12 §P0-12-05（unbind）/ audit-13 §P0-13-03（优惠券）/ audit-CC2 §P2-CC2-18（pickup / point_txn / card_txn）|
| 关联 SUMMARY | §2 Top10 #9 / §3 横切「TOCTOU：事务外读 → 事务内 INSERT」/ §4 L0 P0 剩 5 项 + partial UNIQUE 10 项 |
| 后续工作 | (1) 抽出 `db/helpers/lock-keys.ts` 单源 advisory lock 常量（P1-CC2-12）；(2) audit-CC2 P2-CC2-18 列举 9 表的 `idempotency_key` 系统性补齐（与本 ticket 收尾后规划）；(3) appointment 槽位重叠 EXCLUDE USING gist 另立 ticket |

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**：
1. **#10 user_coupons UNIQUE(template_id, user_id) 与现有业务路径直接冲突**：
   - `fengyu-admin/src/cron/steps/grant-birthday-benefits.ts:171`（年度幂等 `bday-{YYYY}-{userId}-{templateId}`）— 每年同模板同人重发，加 UNIQUE 后第 2 年起 23505。
   - `grant-thanksgiving-benefits.ts:173` 同理（月度幂等键）。
   - `refresh-member-levels.ts:308` 升降级权益重发同模板。
   - `share-gift.js:106`（staff + clientApi + payNotify 三处副本）礼包同一受赠人可被不同订单的不同分享对象同时给到同一模板。
   - 探伤 SELECT(10) 在生产几乎必然非 0 行。方案 A "推荐"实际上**不可行**，必须改走方案 B（advisory lock + recount），或把 UNIQUE 范围缩到 cron 自己生成的幂等键（如新增 `external_ref`，复用已有 `uq_point_txns_external_ref` 模式）。

2. **#7 card_transactions UNIQUE(ref_order_id, type) WHERE ref_order_id IS NOT NULL 与现有 SQL/枚举矛盾**：
   - `cardTransactionTypeEnum = ['充值','扣款']`（`db/schema/enums.ts:97`）只有 2 个值，ticket "同动作（充值/扣款/退款）"的"退款"枚举不存在；退款回冲在代码里实际写 `type='充值'`（`order.js:1611/1877`）。
   - `(ref_order_id='REPAY-…', type='充值')` 与原始充值流水会在同一 ref_order_id 下因不同 `REPAY-` 前缀拼接，需手工核对生产数据；ticket 没识别这点。
   - `order.js:925` 同店并发同订单储值卡扣款会被合理拦截，但 `:1611` 退款回冲与 `:1877` 管理后台调用之间也会撞同 ref_order_id `'REPAY-{refSaleOrderId}-{ts}'`，加索引前必须探伤。

3. **#1 sale_order_payments(sale_order_id) WHERE change_type='首次支付' AND status='已支付' 与历史数据**：line 列号 `:847/:931` 已严重偏移（实际 `:880-890` 判定 + `:931`/`:962` INSERT；总文件 2656 行）。`order.js:626` 还有第三处 `'首次支付' '已支付'` INSERT 未在 ticket §5 列出，遗漏会导致 ON CONFLICT 改造不完整。

**Warn 级问题**：
1. **#5 (employee_id, appointment_time) UNIQUE 语义错误**：实际业务是 2 小时槽位重叠（real.md），不是 timestamp 精确相等；`appointment_time` 精度可至秒，UNIQUE 只在"两次 confirm 写完全相同的时间戳"时生效，对常见"10:00 vs 10:30 重叠"无效。应至少改为按"按小时取整"或承认本项需 `tsrange + EXCLUDE USING gist`。同时 ticket §5 #5 说"INSERT catch 23505"，confirm 实际是 UPDATE（`appointment.js:204`），描述错配。
2. **#9 pickup_records.idempotency_key 没说明 NULL 行为对历史调用方影响**：方案是 NULLABLE + partial index，意味着不带 `idempotencyKey` 的旧调用方继续可以重复 INSERT，partial unique **完全无防护**直到三端前端发版。这点风险表里有提"分两阶段"但 Phase 3 e2e 验证项却假设第二笔会被拦截，自相矛盾。
3. **drizzle-kit 是否会生成 `CREATE UNIQUE INDEX CONCURRENTLY`**：ticket 自己回答"不能"，但没给出"接受秒级写阻塞"的具体阻塞窗口估算依据；`sale_order_payments` / `card_transactions` / `point_transactions` 真实行数未查。生产业务库 5434 跑前应先 `SELECT count(*)`。
4. **§4 SQL 草稿与 drizzle-kit 实际产出会不一致**：草稿手写了 `--> statement-breakpoint`，但 db/CLAUDE.md 明令"禁止手写 .sql 塞进 db/migrations/"，正确流程是改 schema → `db:generate`。ticket §6 Phase 0 写对了步骤，但 §4 把 SQL 当成主交付物会让实施者直接写文件踩坑。
5. **未提到双库 5433 的处理**：db/CLAUDE.md 5433 仍未退役、可选双跑；ticket 仅写 5434，对灾备演练场景应至少注释一句"5433 可选"。

**OK**：
- 已存在 partial unique 8 项盘点正确（user.ts、sale_orders pending、sale_allocations、service_commissions、sop_status_audit、sop_txn、point_txns_external_ref、messages_idempotency_key）。
- pickup_records 当前 schema 确无 `idempotency_key` 列，ALTER ADD 判断成立。
- user_coupons schema 现状（无 (template_id, user_id) UNIQUE）核对一致。
- 应用层 23505 捕获 + `CONFLICT:` 前缀的统一错误模式与现有 staff/admin 错误约定吻合。
- Phase 0 临时 docker PG 验证流程与 db/CLAUDE.md 「临时 PG」节一致。
- 回滚方案（`DROP INDEX IF EXISTS`）正确，不影响数据。

**改进建议**：
1. **#10 必须改方案 B**（advisory lock + 事务内 recount），或重新定义为"同一发放批次幂等键"UNIQUE（仿 `uq_messages_idempotency_key`），删除"同模板同人不重复"约定（与会员升级/生日/分享四套业务直接打架）。
2. **#7 加 status 维度**：`UNIQUE(ref_order_id, type, ...)` 应包含足以区分"原始扣款 vs 退款回冲 vs 补充充值"的列，否则探伤会撞死。建议引入 `external_ref` 列承载幂等键，与现有 `uq_point_txns_external_ref` 同一模式。
3. **#1 line 号全部以 `git grep -n "INSERT INTO sale_order_payments"` 实测重写**，确保 §5 列出 5 处（不止 2 处）；payNotify 路径同步核对。
4. **#5 直接降级为"非本 ticket 范围，需另立 ticket 用 EXCLUDE USING gist + tstzrange"**，避免 partial unique 给错误安全感。
5. **§4 移除 SQL 草稿**，改为"目标态描述"，让实施走 schema.ts → db:generate；Phase 0 提到的"产出 SQL 与 §4 草稿一致"改为"通过 e2e 行为校验"。
6. **新增 Phase -1 探伤报告子任务**：在 PR 描述里附 10 个探伤 SELECT 的实际 count（特别是 user_coupons、card_transactions、sale_order_payments、point_transactions 这 4 张高写入表），由业务方确认清洗策略再生成 schema 改动。
7. **关联 ticket #8 state-machine-CAS / #3 advisory-lock**：建议显式声明本 ticket = 第三层防御，CAS + advisory + partial unique 三层应同步规划，避免应用层重复实现 SELECT-then-INSERT 防重逻辑。
