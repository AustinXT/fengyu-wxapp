# 审计报告：CC2 并发与幂等（横切收官版）

**审计时间**：2026-04-25（v1）/ 2026-04-26（v2 实时代码重审）
**域 ID**：CC2（横切检查域，非业务域）
**关联文档**：
- `docs/audit/audit-CC2-concurrency-idempotency.md`（v1，原始版）
- `docs/audit/audit-CC2-concurrency-idempotency-v2.md`（v2，实时代码重审）
**本版合并逻辑**：
- v1 Top 2 P0（退款5通道）→ v2 确认已修复 → 移入「修复记录」节，标注 commit hash
- v1 in-flight partial UNIQUE 缺口 → v2 确认新退款架构已消除 → 标注「架构性作废」
- v2 新发现 P0（payNotify DROP 字段残留）→ 单独列为「待解除守卫后修复」
- v1 其余保留项：service 单号 lock key 分裂、store_unbind 无 CAS、batchSendMessages 无幂等键、coupon 发放无 advisory lock、prepaid_cards 余额原子守卫缺失

---

## 修复记录（v2 验证关闭）

> 以下条目已通过 v2 实时代码扫描确认修复。

### [已修复] P0-CC2-07：退款审批不冲销 5 通道（staff + admin 双端）

- **修复前**：退款审批仅置 `sale_orders.status='已支付'`，不动 sale_allocations / service_commissions / user_coupons / point_transactions / pickup_records
- **v2 验证**：两端均已实现 `cascadeRefund`，5 通道在同一 pg.transaction / db.transaction 内执行
  - `helpers/refund-cascade.js`（staffApi）→ 被 `order.approveRefund` 调用（L1620）
  - `lib/refund-cascade.ts`（admin）→ 被 `actions/refunds.ts` 调用（L849）
- **commit**：受 `helpers/refund-cascade.js` 引入（2026-04-25 前）
- **状态**：**关闭**

### [已修复] P0-CC2-08：sale_allocations 硬删 vs admin 软删双轨

- **修复前**：staff 3 处用 `DELETE`；admin 用 `UPDATE is_void=true`
- **v2 验证**：staff 全部改为 `is_void=true, voided_at=NOW()`
- **补充修复**：`service_commissions.voided_at / voided_reason` 列由 migration 0018 添加
- **状态**：**关闭**

### [已修复] client.cancel 缺 CAS（P0-CC2-02 部分路径）

- **修复前**：`UPDATE sale_orders WHERE sale_order_id = $3`（无 status 约束）
- **v2 验证**：`clientApi/order.js:1128` → `AND status = ANY($4)` + rowCount 校验
- **状态**：**关闭**

### [架构性作废] v1 §1.1 末尾表第 a 项：sale_orders 退款单 in-flight 唯一性

- **修复前**：旧架构以 `sale_orders[type='退款单']` 独立行建模，in-flight 无 DB 约束
- **v2 验证**：新架构将退款改为 `sale_order_payments[change_type='退款']` 单行模型，migration 0018 引入 `uq_sop_status_audit (sale_order_id, change_type) WHERE change_type='退款' AND status='待审批'`，直接覆盖该缺口
- **2026-04-27 域重构收官**：sale_order_type_enum 5→3（'回款单'/'退款单' 移除），`paymentFlowStatusEnum` 新增 `'待审批'` 值，migration 0021 已生成并应用。退款审批并发保护由 `uq_sop_status_audit` partial unique index 完整覆盖，同订单不可能同时存在两笔 `status='待审批'` 的退款行
- **状态**：**架构性作废（v2 新架构已消除该风险场景）+ 2026-04-27 域重构收官确认**

---

## 修复建议（v2 新发现 P0）

### [待解除守卫后修复] P0-v2-01：payNotify 残留已 DROP 列，DISABLED 守卫移除后 42703 崩溃

- **文件:行**：`payNotify/index.js:128, 149, 195, 269, 271, 283`
- **问题**：migration 0018 已 DROP `sale_orders.paid_amount`、`wechat_transaction_id`、`alipay_transaction_id`；但 payNotify 代码仍包含：
  - `SELECT paid_amount`（L128, L149）
  - 注释引用 `paid_amount 列初值`（L195）
  - `UPDATE SET paid_amount = $2`（L269）
  - `wechat_transaction_id = COALESCE(...)`（L271, L283）
- **当前状态**：`PAYNOTIFY_DISABLED = true` 全守卫隔离，业务逻辑不执行
- **风险**：解除守卫（拉卡拉对接上线）后，整函数将因 `column "paid_amount" does not exist (42703)` 崩溃
- **修复**：在守卫解除前，将残留引用更新为新 schema（`received` / `sale_order_payments` 聚合）+ 加 CAS status 守卫（P0-v2-02）

### P0-v2-02：payNotify UPDATE sale_orders 缺 CAS status 约束（守卫隔离状态）

- **文件:行**：`payNotify/index.js:267-274, 280-287`
- **问题**：两处 `UPDATE sale_orders SET status = $1 WHERE sale_order_id = $5` 无 `AND status IN ('待支付','部分支付')` 约束
- **当前状态**：DISABLED 守卫隔离，实际风险为零；解除守卫后变为 P0
- **注**：`uq_sop_txn ON CONFLICT DO NOTHING` 提供幂等保护，但 sale_orders status 本身无 CAS，两者保护层不同

---

## 待修复清单（v1 保留项）

### P0-CC2-01 / P0-v2-04：Advisory lock 跨事务释放窗口（createConversion 子路径）

- **文件:行**：`staffApi/routes/order.js:2056`（`generateOrderNo()` 调用）+ `L2059`（主事务再持锁）
- **问题**：`createConversion` 先调 `generateOrderNo('FY-XSD-WX-')` 取 `convOrderId`，该函数内部 `pg.transaction` 持 advisory lock → COMMIT → 锁释放；随后外层 `pg.transaction(L2058)` 再持锁，但 `convOrderId` 在锁释放后已用于 INSERT。**两段之间存在竞争窗口**
- **注**：`createRefund`（重构后）不再使用 `generateOrderNo`，改为直接 INSERT `sale_order_payments`，此路径已消除；`createConversion` 子路径仍存在
- **修复**：将 `generateOrderNo()` 移除内层 `pg.transaction`，作为外层主事务内的查询函数（参考 admin CTE WITH lock 模式）

### P0-CC2-04 / P0-v2-03：service 单号 lock key 跨端不互斥

- **文件:行**：
  - `staffApi/routes/service.js:774` — `Buffer.from('svc_order_id').reduce(...)` → 私有整数 hash
  - `admin/actions/services.ts:522` — `hashtext('service_order_id_gen')`
- **问题**：两端 advisory lock key 不同，lock 池完全分裂；服务单号前缀不同（`HLD-WX-` vs `FY-FW-`）实际不会重号，但失去统一幂等保护语义
- **修复**：staff service.js 用 `hashtext('service_order_id_gen')` 对齐 admin；长期推荐 `db/helpers/lock-keys.ts` 单源常量

### P0-CC2-02 / P0-v2-05：store_unbind 三端 5 路径 CAS 缺失

- **文件:行**：
  - `staffApi/store.js:97-101`（approveUnbind）、`L128-133`（rejectUnbind）
  - `clientApi/store.js:213`（cancelUnbindRequest）
  - `admin/store-unbind.ts:84-91`（approveUnbind）、`L133-141`（rejectUnbind）
- **问题**：所有 5 路径先事务外 SELECT 状态判断，UPDATE 时不带 `AND status = '待处理'`；TOCTOU 窗口内双并发两人同时 approve/reject 同一申请，两次 UPDATE 均成功
- **后果**：用户被错误解绑（双次），或 approve/reject 竞态导致最终状态不确定
- **修复**：UPDATE 加 `AND status = '待处理'` + rowCount=0 → CONCURRENT_CHANGED

### P0-CC2-11 / P0-v2-07：admin batchSendMessages 无 idempotency_key

- **文件:行**：`admin/actions/messages.ts:461-474`
- **问题**：分片 INSERT `messages` 无 `idempotency_key` 字段，`uq_messages_idempotency_key` partial unique 因 NULL 值完全失效；网络超时重试将产生重复消息行
- **修复**：每行生成 `idempotency_key = 'batch-' + batchId + '-' + userId`，INSERT 加 `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`

### P0-CC2-03 / P0-v2-08：admin coupon issue / batchIssueCoupons 发放量无 advisory lock 保护

- **文件:行**：`admin/actions/coupons.ts:527-535`（issueCoupon）、`L652-664`（batchIssueCoupons）
- **问题**：`totalCount` 校验 `SELECT COUNT(*) ... WHERE templateId = $1` 在事务外执行；两个并发请求可同时通过上限校验，最终插入行数超过 `tpl.totalCount`
- **修复**：`pg_advisory_xact_lock(hashtext('coupon-issue-' + templateId))` + 事务内 recount

### P0-CC2-09 / P0-v2-06：prepaid_cards 余额扣减无原子守卫

- **路径**（5 处）：
  - `staffApi/order.js:confirmOffline:884`
  - `staffApi/order.js:approveRefund:1606`（充值回冲，方向相反，无超卖风险）
  - `clientApi/order.js:confirmPrepaidFull:1530`
  - `clientApi/order.js:repay:1706`
  - `payNotify/index.js:389`（有 FOR UPDATE + 应用层余额校验，抛 INSUFFICIENT_BALANCE）
- **问题**：所有扣款路径只做 `FOR UPDATE` 行锁 + 应用层条件检查，UPDATE 语句本身无 `AND balance >= $deductAmount` 条件；违反 real.md #1「单条 UPDATE + 条件判断」原子操作精神
- **缓解**：FOR UPDATE 保证事务串行，应用层检查在 FOR UPDATE 后执行，两路不能同时通过；但此写法不符合原子守卫最佳实践，一旦删掉 FOR UPDATE（代码 bug）就会超卖
- **修复**：所有扣款 UPDATE 加 `AND balance >= $deductAmount` 条件；FOR UPDATE 保留作为行锁补强

---

## P1 清单（数据一致 / 架构风险）

### P1-CC2-12：advisory lock key 无集中注册

- **现状**：18 处 advisory lock 调用分散 6 个文件，无 `db/helpers/lock-keys.ts` 单源常量
- **风险**：新开发者极易再写 `Buffer.reduce` 私有 hash 重蹈 P0-v2-03
- **修复**：新增 `db/helpers/lock-keys.ts` 导出常量，替换所有字符串字面量

### P1-CC2-13：partial UNIQUE 缺口 8 项仍存在

以下 8 项在 v1 和 v2 均无 DB 约束：
- `service_orders.appointment_id WHERE NOT NULL`
- `service_orders.client_user_id WHERE status IN ('待服务','服务中')`
- `appointments(sale_item_id) WHERE status IN ('待确认','已确认')`（应用层已有 SELECT 去重）
- `appointments(employee_id, appointment_time) WHERE status active`
- `store_unbind_requests(user_id) WHERE status='待处理'`（应用层已有 SELECT 去重）
- `card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`
- `point_transactions(user_id, ref_order_id, type) WHERE type IN ('消费赠送','消费冲销')`
- `pickup_records(sale_item_id, idempotency_key)`

> 注：v1 表中的「退款单 in-flight」已通过 `uq_sop_status_audit` 覆盖（见「架构性作废」），本次关闭。
>
> **FIXED 2026-04-27**：`uq_sop_status_audit` partial unique index 已在 migration 0021 中确认生效。`paymentFlowStatusEnum` 新增 `'待审批'` 值，退款审批并发保护完整覆盖。sale_order_type_enum 已从 5 值收窄为 3 值（'回款单'/'退款单' 不再存在），旧退款单行路径彻底消除。

### P1-CC2-14：prepaid_cards.balance 余额不变量无 cron 守护

- `balance ≡ SUM(card_transactions.amount)` 无 trigger / cron 校验
- 任何代码 bug 导致的漂移会沉默累积
- **修复**：新增 `audit-prepaid-balance.ts`（仿 `audit-points-balance.ts` 模式）

### P1-CC2-15：approveRefund 注释提到 split 算法链式依赖

- **文件:行**：`staffApi/order.js:createRefund:1425`
- **问题**：从 `origOrder.prepaid_card_amount` 实时读取，而非已审批快照；若同一订单有后续支付改变该值，第二次退款拆分比例失真
- **等级**：低概率场景，P1

### P1-v2-04：cascade 通道 4 point_transactions 反向流水幂等不完整

- **文件:行**：`helpers/refund-cascade.js:99-132` / `lib/refund-cascade.ts`
- **问题**：使用 `NOT EXISTS (SELECT 1 FROM point_transactions pt2 WHERE pt2.ref_order_id = $1 AND pt2.type = '消费冲销' AND pt2.amount = -pt2.amount)` 防重复；若因代码 bug 或事务部分重试导致同额多行，精确匹配可能漏判
- **根因**：P1-v2-01 partial UNIQUE 缺位是根因，先补约束再补 ON CONFLICT

---

## P2 清单（代码质量 / 可维护）

### P2-CC2-18：Idempotency-Key 字段化系统性缺位

- 仅 `messages.idempotency_key` 一表有应用层填充。`operation_logs / pickup_records / sale_orders / service_orders / appointments / sale_allocations / service_commissions / card_transactions / point_transactions` 都需要类似列才能让 DB partial unique 真正兜底
- **修复**：批量 ALTER 加列 + 批量 partial unique（一次迁移 10+ 表）

### P2-CC2-19：测试 fixture 锁死并发期望值

- **文件:行**：`staffApi/__tests__/routes/order.test.js`（9 处 mock `advisory_xact_lock` 返回固定 `rowCount`）
- **问题**：测试无法感知双事务模式（P0-CC2-01 的 generateOrderNo 场景）
- **修复**：改为 spy 校验「调用了 advisory_xact_lock」而非 mock 返回值

### P2-CC2-20：一致性 cron 仅告警不修复

- `audit-points-balance.ts` D7 决策只 log + preview，无 SLA；100 条偏差展示 5 条余下埋 jsonb
- **修复**：建立「仅告警 cron」SLA 机制，自动化工单回收路径

### P2-v2-03：client appointment.cancel 缺 CAS 已知但无优先级票

- **文件:行**：`clientApi/routes/appointment.js:209-214`
- UPDATE 仅 `WHERE appointment_id = $3`，无 status 约束；若并发 cancel 和 confirm，两者均可写入
- 相较 store_unbind 5 路径，appointment cancel 实际业务并发概率更高（顾客主动取消 vs 员工确认）
- **修复**：UPDATE 加 `AND status IN ('待确认','已确认')` + rowCount 校验

---

## 验证 SQL（SELECT/EXPLAIN only，禁止写入）

```sql
-- 1. 验证待支付订单唯一约束（uq_sale_orders_client_pending）
SELECT client_user_id, COUNT(*), ARRAY_AGG(sale_order_id) AS dups
FROM sale_orders
WHERE status = '待支付' AND client_user_id IS NOT NULL
GROUP BY client_user_id HAVING COUNT(*) > 1;
-- 预期：0 行

-- 2. 验证退款 in-flight 唯一（uq_sop_status_audit，migration 0018 新增）
SELECT sale_order_id, COUNT(*)
FROM sale_order_payments
WHERE change_type = '退款' AND status = '待审批'
GROUP BY sale_order_id HAVING COUNT(*) > 1;
-- 预期：0 行（uq_sop_status_audit 已生效）

-- 3. 验证 sale_order_payments 幂等重复行（uq_sop_txn）
SELECT sale_order_id, payment_method, external_txn_id, COUNT(*)
FROM sale_order_payments
WHERE external_txn_id IS NOT NULL
GROUP BY sale_order_id, payment_method, external_txn_id HAVING COUNT(*) > 1;
-- 预期：0 行

-- 4. 验证服务单号不重复（P0-v2-03 跨端分裂影响）
SELECT service_order_id, COUNT(*)
FROM service_orders
GROUP BY service_order_id HAVING COUNT(*) > 1;
-- 预期：0 行

-- 5. 验证 prepaid_cards.balance 与流水加总不一致（P1-CC2-14）
SELECT pc.user_id, pc.balance,
       COALESCE(SUM(ct.amount), 0) AS sum_tx,
       pc.balance - COALESCE(SUM(ct.amount), 0) AS drift
FROM prepaid_cards pc
LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
GROUP BY pc.user_id, pc.balance
HAVING ABS(pc.balance - COALESCE(SUM(ct.amount), 0)) > 0.01
ORDER BY ABS(pc.balance - COALESCE(SUM(ct.amount), 0)) DESC;
-- 预期：0 行；若有则 P1-CC2-14 已实际命中

-- 6. 验证退款审批后 sale_allocations 是否都已软删（cascade 通道 1 是否生效）
SELECT o.sale_order_id, COUNT(sa.id) AS active_alloc_on_refunded
FROM sale_order_payments sop
JOIN sale_orders o ON o.sale_order_id = sop.sale_order_id
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
WHERE sop.change_type = '退款' AND sop.status = '已支付'
  AND sa.is_void = false
GROUP BY o.sale_order_id
HAVING COUNT(sa.id) > 0;
-- 预期：0 行（若有则 cascadeRefund 通道 1 未执行）

-- 7. 验证 point_transactions 反向流水写入后 balance 不一致
SELECT u.user_id, u.points_balance,
       COALESCE(SUM(pt.amount), 0) AS computed,
       u.points_balance - COALESCE(SUM(pt.amount), 0) AS drift
FROM client_wechat_users u
LEFT JOIN point_transactions pt ON pt.user_id = u.user_id
GROUP BY u.user_id, u.points_balance
HAVING ABS(u.points_balance - COALESCE(SUM(pt.amount), 0)) > 0;
-- 预期：0 行；若有则 cascade 通道 4 balance 重算有 bug 或存在并发写入遗漏

-- 8. 验证 store_unbind 并发 race 是否存在（audit）
SELECT user_id, COUNT(*)
FROM store_unbind_requests
WHERE status = '待处理'
GROUP BY user_id HAVING COUNT(*) > 1;
-- 预期：0 行（应用层 SELECT 检查保证，但 CAS 缺失使 DB 约束无法兜底）

-- 9. payNotify 残留列存在性验证（schema 层面，非数据层）
EXPLAIN SELECT paid_amount FROM sale_orders LIMIT 1;
-- 预期：报错 42703（column does not exist）——确认残留引用 P0-v2-01 的运行时效果

-- 10. 探测「同订单首次支付重复行」
SELECT sale_order_id, COUNT(*) AS first_pay_rows
FROM sale_order_payments
WHERE change_type = '首次支付' AND status = '已支付'
GROUP BY sale_order_id HAVING COUNT(*) > 1;
-- 预期：0 行；非 0 即并发命中
```

---

## 修复优先级

### 优先级 A（立即修复，拦截拉卡拉对接风险）

| 编号 | 文件 | 修改内容 |
|------|------|---------|
| A1 | `payNotify/index.js` | 在 DISABLED 守卫解除前：将 `paid_amount` → `received`（聚合）、`wechat_transaction_id` 引用移到 `sale_order_payments.external_txn_id`，对齐 migration 0018 schema；UPDATE sale_orders 时加 `AND status IN ('待支付','部分支付')` CAS 守卫 |

### 优先级 B（P0，应在下一迭代修复）

| 编号 | 文件 | 修改内容 | 关联 |
|------|------|---------|------|
| B1 | `staffApi/routes/service.js:774` | 将 `Buffer.from('svc_order_id').reduce(...)` 替换为 `hashtext('service_order_id_gen')` 对齐 admin | P0-v2-03 |
| B2 | `staffApi/routes/order.js` createConversion | 消除 `generateOrderNo()` 内层 `pg.transaction`，将号码生成合并到主事务（参考 admin CTE WITH lock 模式） | P0-v2-04 |
| B3 | `staffApi/routes/store.js:approveUnbind/rejectUnbind` + `admin/store-unbind.ts:84-91,133-141` + `clientApi/routes/store.js:cancelUnbindRequest` | UPDATE 加 `AND status = '待处理'` + rowCount=0 → CONCURRENT_CHANGED | P0-v2-05 |
| B4 | `admin/actions/messages.ts:461-474` | 每行生成 `idempotency_key = 'batch-' + batchId + '-' + userId`，INSERT 加 `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` | P0-v2-07 |
| B5 | `admin/actions/coupons.ts` issueCoupon/batchIssueCoupons | `pg_advisory_xact_lock(hashtext('coupon-issue-' + templateId))` + 事务内 recount | P0-v2-08 |
| B6 | `staffApi/order.js` / `clientApi/order.js` / `clientApi/order.js:confirmPrepaidFull` / `clientApi/order.js:repay` | 所有 prepaid_cards 余额扣减 UPDATE 加 `AND balance >= $deductAmount` | P0-v2-06 |

### 优先级 C（P1，架构守护）

| 编号 | 文件 | 修改内容 |
|------|------|---------|
| C1 | 新增 `db/helpers/lock-keys.ts` | 导出 `LOCK_KEY_SALE_ORDER_ID = 'sale_order_id_gen'`、`LOCK_KEY_SERVICE_ORDER_ID = 'service_order_id_gen'`、`LOCK_KEY_EMPLOYEE_ID = 'gen_employee_id'` 等常量 |
| C2 | DB migration | 为 8 项 partial UNIQUE 缺口补约束（优先：`store_unbind_requests(user_id) WHERE pending`、`card_transactions(ref_order_id, type)` partial unique）|
| C3 | `clientApi/routes/appointment.js:cancel` | UPDATE 加 `AND status IN ('待确认','已确认')` + rowCount 校验 |
| C4 | `staffApi/helpers/refund-cascade.js` 通道 4 | 为 point_transactions 反向流水写入加 `ON CONFLICT DO NOTHING`（需先补 partial UNIQUE 约束）|
| C5 | 新增 `audit-prepaid-balance.ts` | 校验 `prepaid_cards.balance ≡ SUM(card_transactions.amount)`（仿 audit-points-balance.ts 模式）|

---

## 问题状态总表（v1 → v2 → 本版）

| 编号 | 描述 | v1 评级 | v2 结论 | 本版状态 |
|------|------|--------|--------|---------|
| P0-CC2-01 | Advisory lock 跨事务释放窗口 | P0 | P0-v2-04（createConversion 子路径仍存在）/ createRefund 路径已消除 | **待修复** |
| P0-CC2-02 | 状态机 UPDATE 缺 CAS | P0 | client.cancel 已修 ✅；store_unbind 5 路径仍存在；payNotify DISABLED 隔离 | **client.cancel 已修，其他仍待** |
| P0-CC2-03 | TOCTOU / 无 partial unique 兜底 | P0 | coupon issue 仍存在；退款 in-flight 架构性作废（uq_sop_status_audit）| **部分关闭** |
| P0-CC2-04 | Advisory lock 跨端 key 不一致 | P0 | 仍存在（staff Buffer.reduce vs admin hashtext）| **待修复** |
| P0-CC2-07 | 退款审批不冲销 5 通道 | **P0（Top 2）** | **已实现 refund-cascade.js + refund-cascade.ts** | **关闭 ✅** |
| P0-CC2-08 | 软删/硬删双轨 | P0 | 全部改为 is_void=true + migration 0018 添加 voided_at | **关闭 ✅** |
| P0-CC2-09 | 余额扣减无原子守卫 | P0 | 仍存在（FOR UPDATE 串行化缓解）| **待修复** |
| P0-CC2-11 | batchSendMessages 无 idempotency_key | P0 | 仍存在 | **待修复** |
| 新增 | payNotify 残留已 DROP 列（P0-v2-01）| — | 新发现 | **待解除守卫后修复** |
| 新增 | payNotify UPDATE 缺 CAS（P0-v2-02）| — | 新发现（DISABLED 隔离）| **待解除守卫后修复** |
| 新增 | cascade 通道 4 point_transactions 幂等不完整（P1-v2-04）| — | 新发现 | **P1 待修复** |

---

## 附：CC2 模式分类（A1-A10 收口）

为后续审计与代码 review 建立「模式语言」，CC2 全栈共 10 类问题模式：

| 编号 | 模式 | 典型现象 | 修复手段 |
|------|------|---------|---------|
| A1 | Advisory lock 跨事务释放窗口 | helper 自带 pg.transaction，外层主事务再开 | 移除内层事务 |
| A2 | 状态机 UPDATE 缺 CAS | `WHERE pk_only`，不带 status | 加 `AND status = $expected` + rowCount 校验 |
| A3 | TOCTOU：事务外读 → 事务内 INSERT | 决策 SELECT 不在 begin 后 | 移入事务 + partial UNIQUE 兜底 | **FIXED 2026-04-27**：退款 in-flight 场景已由 `uq_sop_status_audit` partial unique index 覆盖 |
| A4 | Advisory lock key 跨端不互斥 | 私有 hash vs `hashtext()` | 抽 `lock-keys.ts` 单源 |
| A5 | 状态级联缺失 | 关单/退款只改 sale_orders，不动流水/分配/券/积分 | 状态翻转事件触发器或同事务级联 | **FIXED 2026-04-27**：退款 5 通道 cascade 已实现（sa/sc/coupons/points/pickup），refund-cascade.js + refund-cascade.ts 双端落地 |
| A6 | 退款审批不冲销「次数等价物」| sa/sc/coupons/points/pickup 5 处不冲销 | approveRefund 同事务批量 UPDATE | **FIXED 2026-04-27**：5 通道全量回滚已实现（sale_allocations is_void, service_commissions voided_at, user_coupons restored, point_transactions reversed, pickup_records rolled back） |
| A7 | 跨端实现风格冲突（硬删 vs 软删）| staff DELETE / admin UPDATE is_void | 单端实现风格统一 |
| A8 | 余额扣减无 `AND balance >= $1` 守卫 | 仅 FOR UPDATE 行锁 | 加原子条件 |
| A9 | 流水类表 partial UNIQUE 缺位 | 应用层 SELECT-then-INSERT 幂等 | DB partial UNIQUE 兜底 |
| A10 | idempotency-key 应用层不填充 | partial unique on NULL 完全无效 | batchId UUID + 每行填充 |