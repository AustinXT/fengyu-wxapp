# 审计报告：CC2 并发与幂等（横切收官）

**审计时间**：2026-04-25
**域 ID**：CC2（横切检查域，非业务域）
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

> 本报告是对 25 份业务域 audit-NN.md §5 CC2 节的系统性归集，并对 schema/三端代码做"全栈 CC2 健康"再扫描。**主要新增点：admin issueCoupon/batchIssueCoupons CC2 量化、admin store-unbind 双路径无 CAS 量化、admin appointment 三态有 CAS 的反例确认、prefix-and-counter 类号段生成器在 5 个表共 8 处入口的并发面板表、payNotify "事务内首次支付决策" 与 staff/admin "事务外读" 的修复模式对比矩阵、partial UNIQUE 现状清单与缺口表**。无新增前所未见的 P0 类型，全部为既有 9 类 CC2 模式的补强 / 量化收口。

---

## 1. CC2 入口对照（全栈 schema + 三端代码）

### 1.1 DB 层（partial UNIQUE / UNIQUE 约束 现状）

| # | 表 | 约束名 | 列 / 谓词 | 用途 | 文件 |
|---|----|--------|-----------|------|------|
| 1 | `sale_orders` | `uq_sale_orders_client_pending` | `client_user_id WHERE status='待支付' AND client_user_id IS NOT NULL` | real.md #7 待支付订单唯一（注册顾客）| `db/schema/order.ts:108` |
| 2 | `sale_orders` | `uq_sale_orders_phone_pending` | `(client_phone, store_id) WHERE status='待支付' AND client_user_id IS NULL` | real.md #7 待支付订单唯一（散客 phone-only）| `db/schema/order.ts:111` |
| 3 | `sale_orders` | `wechatTransactionId.unique()` | `wechat_transaction_id` 全局唯一 | 微信回调幂等 | `db/schema/order.ts:75` |
| 4 | `sale_orders` | `alipayTransactionId.unique()` | `alipay_transaction_id` 全局唯一 | 支付宝回调幂等 | `db/schema/order.ts:76` |
| 5 | `sale_order_payments` | `uq_sop_txn` | `(sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL` | 同订单同通道同三方流水号唯一 | `db/schema/order.ts:269` |
| 6 | `sale_allocations` | `uq_sale_alloc_item_emp_role` | `(sale_item_id, employee_id, role_type) WHERE is_void=false` | 同明细同员工同角色唯一活跃分配 | `db/schema/order.ts:222` |
| 7 | `service_commissions` | `uq_svc_comm_item_emp_role` | `(service_item_id, employee_id, role_type) WHERE is_void=false` | 同服务明细同员工同角色唯一活跃提成 | `db/schema/service-commission.ts:44` |
| 8 | `point_transactions` | `uq_point_txns_external_ref` | `external_ref WHERE external_ref IS NOT NULL` | 外部业务键幂等（cron 升级/生日/感恩）| `db/schema/points.ts:29` |
| 9 | `messages` | `uq_messages_idempotency_key` | `idempotency_key WHERE idempotency_key IS NOT NULL` | 消息发放幂等（cron 自动消息）| `db/schema/message.ts:33` |
| 10 | `client_wechat_users` | `uq_client_users_openid/phone/customer_id` | partial unique on each | 顾客身份字段 | `db/schema/user.ts:80-82` |
| 11 | `staff_wechat_users` | `uq_staff_users_openid/phone` | partial unique | 员工身份字段 | `db/schema/user.ts:129-130` |
| 12 | `permission_roles` | `uq_perm_roles_emp_role_scope` | (employee_id, role, scope_id) | 角色绑定唯一 | `db/schema/permission.ts:32` |
| 13 | `prepaid_cards` | `uq_prepaid_cards_user` | `user_id` | 一户一卡（v0003 由 (user_id, store_id) 改）| `db/schema/prepaid-card.ts:24` |
| 14 | `mall_product_skus` | `uq_mall_product_sku` | (product_id, sku_id) | 商品-SKU 关联唯一 | `db/schema/product.ts:168` |

**Partial UNIQUE 缺口（既有 SCHEMA-CHANGES.md 已记 8 项，本次确认无遗漏）**：

| # | 缺口 | 既有 SCHEMA-CHANGES 编号 | 影响域 |
|---|------|------------------------|-------|
| a | `sale_orders` 退款单 in-flight 唯一性（`ref_sale_order_id WHERE sale_order_type='退款单' AND status='待审批'`）| S11-2 / S02-? | 03 / 11 |
| b | `service_orders.appointment_id WHERE NOT NULL` | S05-2 / S06-1 | 05 / 06 |
| c | `service_orders.client_user_id WHERE status IN ('待服务','服务中')` | S05-2 | 05 / 06 |
| d | `appointments(sale_item_id) WHERE status IN ('待确认','已确认')` | S06-2 | 06 |
| e | `appointments(employee_id, appointment_time) WHERE status active` | S06-3 | 06 |
| f | `store_unbind_requests(user_id) WHERE status='待处理'` | S12-1 | 12 |
| g | `card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL` | S14-1 | 14 |
| h | `point_transactions(user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')` | S15-01 | 15 |
| i | `pickup_records(sale_item_id, idempotency_key)` | S20-? | 20 |
| j | `operation_logs(idempotency_key)` | S23-1 | 23 |
| k | `sale_orders.first_payment` 至多 1 行/订单（partial unique on `sale_order_payments` `WHERE change_type='首次支付'`）| S03-1 | 03 |

### 1.2 Advisory Lock 使用现状

| # | 调用点 | 文件:行 | Lock Key | 用途 | 持锁形态 |
|---|--------|---------|----------|------|---------|
| 1 | staff order.create | `staffApi/routes/order.js:507` | `hashtext('sale_order_id_gen')` | 销售单号 | xact_lock，外层主事务持锁 ✅ |
| 2 | staff order.create**Repayment** | `staffApi/routes/order.js:1394` | `hashtext('sale_order_id_gen')` | 回款凭证号 | xact_lock，外层主事务持锁 ✅ |
| 3 | staff order.create**Refund** generateOrderNo | `staffApi/routes/order.js:2460` (内层) + 主事务（外层）| `hashtext('sale_order_id_gen')` | 退款单号 | **❌ 双事务模式：generateOrderNo 自带 pg.transaction，commit 时锁释放；外层主事务再 INSERT。两段间存在窗口** |
| 4 | staff order.create**Conversion** | `staffApi/routes/order.js:2021` | `hashtext('sale_order_id_gen')` | 转换单号 | xact_lock ✅ |
| 5 | staff order.refundList helper generateOrderNo | `staffApi/routes/order.js:2452` | `hashtext('sale_order_id_gen')` | 通用 helper（被 createRefund 调用）| **❌ 自带 pg.transaction**，参考 #3 |
| 6 | staff card.recharge | `staffApi/routes/card.js:193` | `hashtext('sale_order_id_gen')` | 储值卡充值订单号 | xact_lock ✅ |
| 7 | staff service.complete | `staffApi/routes/service.js:776` | `$1` 动态（基于 service_order_id_gen 的 hash）| 服务单号生成 | xact_lock ✅，但 hash 与 admin `hashtext('service_order_id_gen')` 不互斥（**S05-3 已记**）|
| 8 | staff auth.bindPhone | `staffApi/routes/auth.js:33` | `hashtext('gen_employee_id')` | 员工号生成 | xact_lock ✅ |
| 9 | client order.create | `clientApi/routes/order.js:360` | `hashtext('sale_order_id_gen')` | 销售单号 | xact_lock ✅ |
| 10 | client order.create**Conversion** | `clientApi/routes/order.js:1544` | `hashtext('sale_order_id_gen')` | 客户端转换单号 | xact_lock ✅ |
| 11 | client card.recharge | `clientApi/routes/card.js:250` | `hashtext('sale_order_id_gen')` | 客户端储值卡充值 | xact_lock ✅ |
| 12 | client auth.bindPhone | `clientApi/routes/auth.js:181` | `hashtext('gen_client_user_id')` | 客户号生成 | xact_lock ✅ |
| 13 | admin createOrder | `fengyu-admin/src/actions/orders.ts:881` | `hashtext('sale_order_id_gen')` | admin 销售单号 | xact_lock ✅ |
| 14 | admin createConversionOrder | `fengyu-admin/src/actions/orders.ts:1280` | `hashtext('sale_order_id_gen')` | admin 转换单号 | xact_lock ✅ |
| 15 | admin createRepaymentOrder | `fengyu-admin/src/actions/orders.ts:1621` | `hashtext('sale_order_id_gen')` | admin 回款凭证号 | xact_lock ✅ |
| 16 | admin createRefundOrder | `fengyu-admin/src/actions/refunds.ts:622` | `hashtext('sale_order_id_gen')` | admin 退款单号 | xact_lock ✅ |
| 17 | admin gen employee_id | `fengyu-admin/src/actions/employees.ts:302` | `hashtext('employee_id_gen')` | 员工号 | xact_lock ✅ |
| 18 | admin createService | `fengyu-admin/src/actions/services.ts:501` | `hashtext('service_order_id_gen')` | 服务单号 | xact_lock ✅ |

**关键发现**：
- 18 个 advisory lock 调用点中，14 ✅、3 ❌（item #3 #5 双事务模式；#7 hash key 与 admin 不互斥）
- 3 端共享同一 `hashtext('sale_order_id_gen')` ✅（销售/回款/转换/退款/储值卡充值 5 类单号同 lock 池）
- 但 service_order_id_gen lock key 在 staff service.complete 用动态 `$1`（实际值 = `Buffer.reduce` 私有 hash）vs admin `hashtext('service_order_id_gen')` ❌ — **同资源两端 lock 不互斥**（S05-3 / CROSS-CUTTING.md "Advisory lock 跨端 key 不一致"已记）

### 1.3 三端 CAS UPDATE 现状（关键状态机字段）

| # | 文件:行 | UPDATE 目标 | WHERE 是否含 status / 等价 CAS | rowCount 校验 |
|---|---------|------------|----------------------------|--------------|
| 1 | `staffApi/routes/order.js:1073` | sale_orders close | ✅ `AND status = $3` | ✅ |
| 2 | `staffApi/routes/order.js:1134` | sale_orders resetFailed | ✅ `AND status = '支付失败'` | ✅ |
| 3 | `staffApi/routes/order.js:900` | sale_orders confirmOffline | ✅ `AND status = $7` | ✅ |
| 4 | `staffApi/routes/order.js:1534` | sale_orders approveRefund | ✅ `AND status = '待审批'` | ✅ |
| 5 | `staffApi/routes/order.js:1660` | sale_orders rejectRefund | ✅ `AND status = '待审批'` | ✅ |
| 6 | `staffApi/routes/order.js:1922` | sale_orders confirmConversion | ✅ `AND status = $7` | ✅ |
| 7 | `staffApi/routes/order.js:531` | user_coupons claim | ✅ `AND status = '未使用' AND expire_at > NOW()` | ✅ `claimResult.rowCount !== 1` |
| 8 | `staffApi/routes/service.js:268` | service_orders start | ✅ `AND status = '待服务'` | ✅ |
| 9 | `staffApi/routes/service.js:454` | service_orders complete | ✅ `AND status = '服务中'` | ✅ |
| 10 | `staffApi/routes/service.js:464` | appointments → '已完成' | ✅ `AND status = '已确认'` | （无 rowCount 校验，但允许 idempotent missing）|
| 11 | `staffApi/routes/service.js:752` | service_orders cancel | ✅ `AND status = $3` | ✅ |
| 12 | `staffApi/routes/appointment.js:205` | appointments confirm | ✅ `AND status = '待确认'` | ✅ |
| 13 | `clientApi/routes/order.js:18` | sale_orders close（cron 关单 helper）| ✅ `AND status = '待支付'` | ✅ |
| 14 | `clientApi/routes/order.js:457` | user_coupons claim | ✅ `AND status = '未使用' AND expire_at > NOW()` | ✅ |
| 15 | `clientApi/routes/order.js:1045` | sale_orders cancel | **❌ 仅 WHERE sale_order_id**（CC2 命中：audit-02 P0-02-03）| — |
| 16 | `clientApi/routes/order.js:781` | sale_orders offlinePay payment_method | **❌ 仅 WHERE sale_order_id** | — |
| 17 | `clientApi/routes/order.js:1251` | sale_orders alipayPay payment_method | **❌ 仅 WHERE sale_order_id** | — |
| 18 | `clientApi/routes/appointment.js:cancel` | appointments cancel | **❌ 仅 WHERE appointment_id**（audit-06 P0-06-02）| — |
| 19 | `payNotify/index.js:192-201` | sale_orders 翻 '已支付' | **❌ 仅 WHERE sale_order_id**（audit-04 P1-04-09）| — |
| 20 | `payNotify/index.js:204-214` | 凭证单 翻 '已支付' | **❌ 仅 WHERE sale_order_id**（audit-04 P1-04-09）| — |
| 21 | `admin/actions/orders.ts:1749` | sale_orders confirmOfflinePayment | ✅ `AND status = ${locked.status}` | ✅ CONCURRENT_CHANGED throw |
| 22 | `admin/actions/refunds.ts:841` | sale_orders approveRefund | ✅ `AND status = '待审批'` | ✅ CONCURRENT_CHANGED |
| 23 | `admin/actions/refunds.ts:1009` | sale_orders rejectRefund | ✅ `AND status = '待审批'` | ✅ |
| 24 | `admin/actions/services.ts:361-363` | service_orders complete | ✅ `AND status = '服务中'` | ✅ |
| 25 | `admin/actions/appointments.ts:184-198` | appointments confirm | ✅ `AND status = '待确认'` + scopeCondition | ✅ |
| 26 | `admin/actions/appointments.ts:222-236` | appointments checkin | ✅ `AND status = '已确认'` | ✅ |
| 27 | `admin/actions/appointments.ts:259-275` | appointments cancel | ✅ `AND status IN ('待确认','已确认')` | ✅ |
| 28 | `admin/actions/store-unbind.ts:84-90` | store_unbind_requests approve | **❌ 仅 WHERE requestId**（pre-read status check 替代 CAS）| — |
| 29 | `admin/actions/store-unbind.ts:133-141` | store_unbind_requests reject | **❌ 仅 WHERE requestId** | — |
| 30 | `staffApi/routes/store.js:approveUnbind` | store_unbind_requests | **❌ 仅 WHERE request_id**（audit-12 P0-12-04）| — |
| 31 | `staffApi/routes/store.js:rejectUnbind` | store_unbind_requests | **❌ 仅 WHERE request_id** | — |
| 32 | `clientApi/routes/store.js:cancelUnbindRequest` | store_unbind_requests | **❌ 仅 WHERE request_id** | — |

**统计**：32 处关键 status UPDATE，**含 CAS 22 处（69%）/ 缺 CAS 10 处（31%）**。缺 CAS 集中在 client cancel / payNotify 推进 / store_unbind 三端 5 个路径 / admin store-unbind 2 个路径，已被 audit-02 / 04 / 06 / 12 命中。

---

## 2. CC2 决策矩阵（横切核心）

```
                "首次支付决策" 在事务边界的位置
                       │
        ┌──────────────┴──────────────┐
        │                             │
   事务内 SELECT                  事务外 SELECT
   （payNotify ✅）             （staff confirmOffline ❌）
                                   （staff createRefund 事务外读 in-flight ❌）

           UNIQUE 索引兜底（uq_sop_txn）
        ✅ payNotify: ON CONFLICT DO NOTHING ack
        ❌ staff confirmOffline: 直接 INSERT 无 ON CONFLICT 二次保护
```

| 入口 | 事务内 SELECT 决策？ | UNIQUE 兜底？ | 评级 |
|------|--------------------|--------------|------|
| `payNotify/index.js:150-156` | ✅ 事务内（commit 前）| ✅ uq_sop_txn ON CONFLICT DO NOTHING | ✅ 修复模式 |
| `staffApi/routes/order.js:826-838 confirmOffline` | ❌ pg.query 事务外 | ❌ INSERT 无 ON CONFLICT；INSERT change_type='首次支付' 无 partial unique 兜底 | ❌ retain audit-03 P0-03-03 |
| `staffApi/routes/order.js:1352-1358 createRefund` | ❌ 事务外读 in-flight | ❌ 缺 `uq_sale_orders_refund_inflight` partial unique | ❌ retain audit-11 P0-11-02 |
| `admin/actions/refunds.ts createRefundOrder` | ❌ 事务外读 in-flight | ❌ 同上 | ❌ retain |
| `admin/actions/coupons.ts:527-535 issueCoupon` | ❌ count 在事务外（且无事务）| ❌ user_coupons 仅 PK couponId 唯一，totalCount 无 DB 约束 | ❌ retain audit-13 P0-13-06 |
| `admin/actions/coupons.ts:652-665 batchIssueCoupons` | ❌ 同上，且 200 个并发批处理放大 | ❌ 无 advisory lock | ❌ retain audit-13 P0-13-07 |
| `cron/refresh-member-levels.ts` 跳档发券 | 单进程 cron，无并发 | ✅ ON CONFLICT external_ref + idempotency_key | ✅ |
| `cron/grant-birthday-benefits.ts` | 单进程 cron | ✅ ON CONFLICT idempotency_key + external_ref + coupon_id 三层 | ✅（修复模式参考）|
| `cron/grant-thanksgiving-benefits.ts` | 单进程 cron | ✅ 同上 | ✅ |

---

## 3. 自身漏洞（CC2 收官）

> 本节为收官归集，**所有 P0 都是既有 audit-NN.md 已发现条目的重述 + 量化**。"原首发报告" 列即可在 CROSS-CUTTING.md CC2 段定位。本横切收官无新发现 P0；新增 1 条 P1（Lock-Key Audit Strategy 缺位）+ 2 条 P2（Idempotency-Key 字段化系统性缺位、TestFixture 锁死并发期望值）。

### 3.1 P0（阻断/资损/越权）— 11 条收口

| # | 标题 | 原首发 | 文件:行 | CC2 模式 |
|---|------|-------|---------|---------|
| **P0-CC2-01** | Advisory lock 跨事务释放窗口可生成重号 | audit-02 P0-02-01 + audit-11 P0-11-03 | `staffApi/routes/order.js:2452 generateOrderNo` 自带 `pg.transaction`，外层主事务再开新事务 | A1 锁释放窗口 |
| **P0-CC2-02** | 状态机 UPDATE 缺 CAS 守卫 — 5 路径 | audit-02 P0-02-03 / audit-06 P0-06-02 / audit-12 P0-12-04 | client.cancel / offlinePay / alipayPay / appointment.cancel + payNotify status 推进 + store_unbind 三端 5 路径 + admin store-unbind 2 路径 = **共 12 处缺 CAS** | A2 状态机崩坏 |
| **P0-CC2-03** | TOCTOU：事务外读决策 → 事务内 INSERT 无 partial unique 兜底 | audit-03 P0-03-03 + audit-05 P0-05-03 + audit-06 P0-06-03 + audit-12 P0-12-05 + audit-13 P0-13-06/07 | confirmOffline change_type 决策 / service.create 校验 / appointment.create / requestUnbind / coupon issue × 2 = **6 个域 7 处**| A3 TOCTOU + 缺 partial unique |
| **P0-CC2-04** | Advisory lock 跨端 key 不一致（service_order_id_gen）| audit-05 P0-05-02 | staff `Buffer.reduce` 私有 hash vs admin `hashtext('service_order_id_gen')` | A4 锁池分裂 |
| **P0-CC2-05** | 决策语句在事务外读，并发下产生重复主语义行 | audit-03 P0-03-03 | staff confirmOffline first-payment 决策 + staff createRefund in-flight 决策 | A3 同源（细化）|
| **P0-CC2-06** | 关单 / 取消未作废已写入流水 | audit-03 P0-03-05 + audit-07 P0-07-02 | staff.close / client.cancel / closeExpiredOrder 仅置 sale_orders.status='已关闭'，不动 sale_order_payments / card_transactions / sale_allocations | A5 状态级联 |
| **P0-CC2-07** | 退款审批不冲销已写入提成 / 分配（资损）| audit-07 P0-07-02 + audit-08 P0-08-04 + audit-11 P0-11-01 + audit-15 P0-15-01 + audit-20 P0-20-01 | 5 处不冲销（sale_allocations / service_commissions / user_coupons / point_transactions / pickup_records.picked_up_quantity）| A5 + A6 双重幂等违规 |
| **P0-CC2-08** | 同资源双写模式漂移：staff 硬 DELETE / admin 软 is_void=true | audit-07 P0-07-01 + audit-08 P0-08-05 | sale_allocations 软删 vs DELETE；service_commissions schema 缺 voided_at | A7 跨端实现风格冲突 |
| **P0-CC2-09** | 余额扣减 UPDATE 缺 `AND balance >= $1` 守卫 | audit-14 §4 表 | prepaid_cards 4 处扣减仅靠 FOR UPDATE 行锁，无原子条件守卫，违反 real.md #1 "原子操作"精神 | A8 单条 UPDATE 自身不防超卖 |
| **P0-CC2-10** | 流水表缺 (xxx_id, ref_xxx_id, type) partial UNIQUE 兜底 | audit-14 P0-14-02 + audit-15 P1-15-07 | card_transactions / point_transactions 应用层 SELECT-then-INSERT 幂等，无 DB 兜底 | A9 流水类表 partial UNIQUE 缺位 |
| **P0-CC2-11** | admin batchSendMessages 不写 idempotency_key（资损：重发翻倍）| audit-16 P0-16-02 | `actions/messages.ts:460-475` 循环 INSERT 无 idempotency_key，`uq_messages_idempotency_key` partial unique 因 NULL 完全无效 | A10 idempotency-key 字段化但无应用层填充 |

### 3.2 P1（数据一致 / 状态错乱）

| # | 标题 | 文件:行 | 现象 |
|---|------|---------|------|
| **P1-CC2-12** | Lock-Key Audit Strategy 缺位（架构治理）| 全栈 | 18 处 advisory lock 调用点散落于 6 个文件，无 const 集中定义；新人/AI 极易再写 `Buffer.reduce` 私有 hash 重蹈 P0-CC2-04（参 audit-05 P0-05-02）。建议 `db/helpers/lock-keys.ts` 集中导出 `LOCK_KEY_SALE_ORDER_ID = 'sale_order_id_gen'` 等常量 |
| **P1-CC2-13** | partial UNIQUE 缺口 11 项收口（与 SCHEMA-CHANGES 对齐）| schema/* | §1.1 末尾表 a-k 11 项缺口；当前唯有 `sale_orders` 待支付 / `sale_order_payments.uq_sop_txn` / `point_transactions.external_ref` / `messages.idempotency_key` / `service_commissions / sale_allocations is_void=false` 共 6 处覆盖。剩余流水类（card_transactions / pickup_records / store_unbind / refund-inflight / appointment / service-order）全无 partial unique 兜底 |
| **P1-CC2-14** | 余额对账不变量无 cron 守护 | audit-14 P0-14-04 + audit-15 P1-15-13 | `prepaid_cards.balance ≡ SUM(card_transactions.amount)` 无 trigger / cron 校验。STEP 5 仅校积分。任何代码 bug 漂移会沉默不被发现 |
| **P1-CC2-15** | 部分退款 split 算法分母漂移 | audit-11 P0-11-06 | approveRefund 第 2 次退款时 origPrepaidCardAmount 已被首次审批改写，比例失真 → 链式状态依赖原表当前值 |
| **P1-CC2-16** | 同业务工具 3-5 端副本漂移（修一处忘多处）| audit-15 P0-15-02 + audit-19 P1-19-06 + audit-20 P1-20-04 | settlePointsForOrder × 3 副本 + grantShareGift × 3 副本（含 1 dead code）+ `quantity - picked_up_quantity` × 5 副本 + roleType 推断 × 3 套（audit-08 P0-08-06）+ customer_type 跃迁 SQL × 2（audit-10 P1-10-08）|
| **P1-CC2-17** | bindPhone 重试不幂等 | audit-01 P1-PHONE-09 | client bindPhone 缺 idempotency_key，首次成功后超时重试报"已绑定"|

### 3.3 P2（代码质量 / 可维护）

| # | 标题 | 文件:行 | 现象 |
|---|------|---------|------|
| **P2-CC2-18** | Idempotency-Key 字段化系统性缺位 | schema/* | 仅 `messages.idempotency_key` 一表。`operation_logs / pickup_records / sale_orders / service_orders / appointments / sale_allocations / service_commissions / card_transactions / point_transactions(part)` 都需要类似列才能让 DB partial unique 真正兜底应用层重复写。建议批量 ALTER 加列 + 批量 partial unique（一次迁移 10+ 表）|
| **P2-CC2-19** | 测试 fixture 锁死并发期望值 | `staffApi/__tests__/routes/order.test.js:528, 2309, 2743, 3030, 3146, 3201, 3341, 4251, 4315` 等 9 处 mock | mock advisory_xact_lock 返回 `rowCount: 0/1` 锁死了"lock 行为永远成功"，对 P0-CC2-01 的"双事务模式"无任何感知能力；同 audit-08 §5 CC9 反模式（rate=0 静默写入测试反向锁死）|
| **P2-CC2-20** | 一致性 cron 仅告警不修复（偏差累积无回收路径）| audit-15 P1-15-13 | `audit-points-balance.ts` D7 决策只 notifyOps + 5 行 preview + log，无工单 / SLA / 自动修复路径；100 条偏差展示 5 条余下埋 jsonb |
| **P2-CC2-21** | admin 物理硬删 vs 软删双轨（金融级流水）| audit-15 + audit-16 P1-16-08 | point_transactions 软删与硬删不一致；admin deleteMessage 物理硬删 messages 无 deleted_at |
| **P2-CC2-22** | 状态级联缺失（parent isValid 关闭后子级未级联）| audit-24 P0-24-02 | updateProductKind 停用一级行不级联子级 isValid |

---

## 4. 跨端不一致（CC2 横切核心 — 同一并发场景在三端的处理差异）

| 并发场景 | admin | staff | client | payNotify | 风险 / 评级 |
|---------|-------|-------|--------|-----------|-----------|
| **订单号生成 advisory lock** | ✅ `hashtext('sale_order_id_gen')` 主事务持锁 | ❌ generateOrderNo 双事务模式（仅 createRefund/refundList helper 路径） / ✅ create/Repayment/Conversion 主事务持锁 | ✅ 主事务持锁 | n/a | P0：staff 1 个 helper 路径漏洞 |
| **服务单号 advisory lock** | ✅ `hashtext('service_order_id_gen')` | ❌ `Buffer.reduce` 私有 hash（不互斥）| n/a | n/a | P0：lock 池分裂 |
| **首次支付决策位置** | ✅ recordPayment 在事务内 SELECT FOR UPDATE | ❌ confirmOffline 事务外读 | n/a | ✅ 事务内 SELECT | P0：staff 与 admin/payNotify 不对齐 |
| **退款单 in-flight 唯一性** | ❌ 事务外读 | ❌ 事务外读 | n/a | n/a | P0：两端同模式漏洞 |
| **sale_orders status 推进 CAS** | ✅ 全部带 `AND status = ?` | ✅ 全部带 | ❌ cancel/offlinePay/alipayPay 漏 | ❌ 漏 | P0：client + payNotify 漏 |
| **appointments status 推进 CAS** | ✅ confirm/checkin/cancel 全带 + scopeCondition | ✅ confirm 带 | ❌ cancel 漏 | n/a | P0：client 漏 |
| **store_unbind_requests status 推进 CAS** | ❌ approve/reject 仅 WHERE requestId（pre-read 替代）| ❌ approve/reject 仅 WHERE request_id | ❌ cancelUnbindRequest 仅 WHERE | n/a | P0：三端 5 路径全漏 |
| **user_coupons claim CAS** | n/a（前端 admin 无下单优惠券 claim 路径）| ✅ `AND status = '未使用' AND expire_at > NOW()` | ✅ | n/a | ✅ |
| **prepaid_cards 余额扣减原子性** | ❌ FOR UPDATE 后非条件 UPDATE | ❌ 同 | ❌ 同 | ❌ 同 | P0：四端同语义漏，违反 real.md #1 "单条 UPDATE + 条件判断" 精神 |
| **service_orders status CAS** | ✅ complete `AND status = '服务中'` | ✅ start/complete/cancel | n/a | n/a | ✅ |
| **service_commissions / sale_allocations 软删模式** | ✅ is_void=true UPDATE | ❌ allocation 三处用 DELETE / sc 用 UPDATE | n/a | ✅ ON CONFLICT uq_*_emp_role DO NOTHING | P0：staff allocation.save / deleteAllocation 硬删导致审计断裂 |
| **退款审批冲销次数等价物** | ❌ 5 类不冲销（sa/sc/coupons/points/pickup）| ❌ 5 类同（注：staff 仅扣 remaining_sessions）| n/a | n/a | P0：两端同模式漏，5 命中域系统性资损 |
| **idempotency_key 字段化使用** | ✅ cron 三步全用（messages.idempotency_key + point_transactions.external_ref）／❌ batchSendMessages 缺 | ❌ share-gift 用 / 业务路由全无 | ❌ 同 | ✅ 用 ON CONFLICT uq_sop_txn 等价幂等 | P0：admin batch 路径漏；非 cron 路径全员未启用 idempotency_key |
| **「事务外 SELECT-then-INSERT」反模式** | ❌ issueCoupon × 2 / createRefundOrder | ❌ confirmOffline / service.create / createRefund / appointment.create-side | ❌ requestUnbind / appointment.create | n/a | P0：跨端共 8 处反模式，缺 partial unique 兜底 |
| **储值卡 ON CONFLICT 写法** | ❌ `ON CONFLICT (user_id, store_id)`（store_id 列已 DROP，运行时 42703）| ✅ `ON CONFLICT (user_id)` | ✅ | ✅ | P0：admin runtime crash（audit-14 P0-14-01 retain）|

---

## 5. 横切检查（套用 §3 模板，仅记录有问题项）

- [ ] CC1 数值：见 audit-CC1-numeric-precision，**金额符号 CHECK 缺位** 与 CC2 「流水表 partial UNIQUE 缺位」是双胞胎问题（schema 守卫缺位）。同源 PR 一并修
- [x] **CC2 并发幂等：本报告即收官**
- [ ] CC3 隔离：与 CC2 在 admin store-unbind / staff customer.* 互锁（route 缺 scope + UPDATE 缺 CAS 是同一处）
- [ ] CC4 鉴权：payNotify 完全无签名校验是 CC2 + CC4 双命中（伪造支付落账 = 失败的并发幂等）
- [ ] CC5 错误码：与 CC2 无强相关，但 P2-16-12 "rowCount=0 静默 success" 是 CC2 + CC5 双命中
- [ ] CC6 PII：与 CC2 无强相关
- [x] CC7 时间字段：影响订单号 dateStr 的并发面板（北京时间 00:00–08:00 跨午夜窗口可重号；audit-02 P0-02-02 同源）
- [ ] CC8 WXML/Vant：N/A
- [x] CC9 测试：P2-CC2-19 mock 锁死并发期望；audit-08 §5 CC9 同模式

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联 P0 |
|----|------|------|--------|
| **L0 schema/enums** | `db/schema/order.ts` | 加 `uq_sale_orders_refund_inflight` partial unique | P0-CC2-03 / P0-CC2-05 |
| L0 | `db/schema/order.ts` | 加 `uq_sop_first_payment` partial unique（同订单仅 1 行 '首次支付'）| P0-CC2-03 / P0-CC2-05 |
| L0 | `db/schema/service.ts` | 加 `uq_so_appointment` + `uq_so_client_active` partial unique | P0-CC2-03 |
| L0 | `db/schema/appointment.ts` | 加 `uq_appts_sale_item_active` + `uq_appts_employee_time_active` partial unique | P0-CC2-03 |
| L0 | `db/schema/store-unbind.ts` | 加 `uq_store_unbind_pending` partial unique | P0-CC2-03 |
| L0 | `db/schema/prepaid-card.ts` | 加 `uq_card_tx_ref_type` partial unique；balance CHECK | P0-CC2-09 / P0-CC2-10 |
| L0 | `db/schema/points.ts` | 加 `uq_pt_consumption` partial unique | P0-CC2-10 |
| L0 | `db/schema/operation-log.ts` | 加 `idempotency_key` 列 + partial unique | P0-CC2-11 / P2-CC2-18 |
| L0 | `db/schema/pickup.ts` | 加 `idempotency_key` 列 + partial unique | P0-CC2-11 / P2-CC2-18 |
| L0 | `db/schema/service-commission.ts` | 加 `voided_at` 列对齐 sale_allocations | P0-CC2-08 |
| L1 | 新增 `db/helpers/lock-keys.ts` | 导出 `LOCK_KEY_SALE_ORDER_ID / LOCK_KEY_SERVICE_ORDER_ID / LOCK_KEY_EMPLOYEE_ID / LOCK_KEY_COUPON_ISSUE = 'coupon-issue-' + templateId` 等常量 | P1-CC2-12 |
| L1 | 新增 `db/helpers/sale-item-availability.ts` | 收敛 `quantity - picked_up_quantity` 5 副本 | P1-CC2-16 |
| L1 | 新增 `db/helpers/role-resolve.ts` | 收敛 roleType 推断 3 套算法 | audit-08 P0-08-06 + P1-CC2-16 |
| L3 staff routes | `staffApi/routes/order.js:2452 generateOrderNo` | 移除内层 `pg.transaction`，作为外层 transaction 内的查询函数 | P0-CC2-01 |
| L3 staff | `staffApi/routes/order.js:826-838 confirmOffline` | "首次支付" 决策移入 pg.transaction 块内；INSERT 加 `ON CONFLICT uq_sop_first_payment DO NOTHING` | P0-CC2-03 / P0-CC2-05 |
| L3 staff | `staffApi/routes/order.js:1352-1358 createRefund` | in-flight 校验移入事务；INSERT 配合 `uq_sale_orders_refund_inflight` ON CONFLICT 兜底 | P0-CC2-03 |
| L3 staff | `staffApi/routes/service.js:776` | 用 `db/helpers/lock-keys.LOCK_KEY_SERVICE_ORDER_ID` 替换 `Buffer.reduce` | P0-CC2-04 |
| L3 staff | `staffApi/routes/allocation.js` | DELETE → UPDATE is_void=true, voided_at=NOW() 三处 | P0-CC2-08 |
| L3 staff/admin | order.close + order.cancel + closeExpiredOrder | 加状态级联：UPDATE sa is_void=true / UPDATE 待支付 payments → 已关闭 / 释放优惠券 / 回滚卡流水 | P0-CC2-06 / P0-CC2-07 |
| L3 client | `clientApi/routes/order.js:1045 cancel`、`:781 offlinePay`、`:1251 alipayPay` | UPDATE 加 `AND status = $expectedStatus` + rowCount 校验 | P0-CC2-02 |
| L3 client | `clientApi/routes/appointment.js:cancel` | 加 `AND status IN ('待确认','已确认') AND client_user_id = $userId` | P0-CC2-02 |
| L3 payNotify | `payNotify/index.js:192-214` | UPDATE sale_orders / 凭证单 加 `AND status IN ('待支付','部分支付')` | P0-CC2-02 |
| L3 + L7 | staff approveUnbind/rejectUnbind + admin approveUnbind/rejectUnbind + client cancelUnbindRequest | 5 路径全加 `AND status = '待处理'` CAS + rowCount=0 → CONCURRENT_CHANGED | P0-CC2-02 |
| L7 admin | `actions/coupons.ts:527-535 / :652-665` | 包 db.transaction + advisory_xact_lock(LOCK_KEY_COUPON_ISSUE+templateId) + SELECT FOR UPDATE template | P0-CC2-03 |
| L7 admin | `actions/messages.ts:460-475 batchSendMessages` | 每行 `idempotency_key = 'batch-' + batchId + '-' + userId` + ON CONFLICT DO NOTHING | P0-CC2-11 |
| L7 admin | `actions/orders.ts:91-98 / :1424-1430` | `ON CONFLICT (user_id, store_id)` → `ON CONFLICT (user_id)`（修正 v0003 残留）| audit-14 P0-14-01 / 跨端 ON CONFLICT 一致性 |
| L7 admin | `actions/refunds.ts approveRefund` | 补 sa/sc/coupons/points/pickup 五类冲销逻辑 | P0-CC2-07 |
| L3 staff | `routes/order.js approveRefund` | 同上 | P0-CC2-07 |
| L9 前端 | client cancelOrder / staff approveRefund 按钮 | UI loading + 后端 idempotency-key（新增 X-Idempotency-Key header）| P1-CC2-12 |
| L10 cron | 新增 `audit-prepaid-balance.ts` step | 仿 `audit-points-balance.ts` 校 prepaid_cards.balance ≡ SUM | P1-CC2-14 |
| L10 cron | 新增 `audit-allocation-vs-payment.ts` step | 校 sale_allocations 是否随 sale_orders.status='已关闭' 全部 is_void=true | P0-CC2-06 |

---

## 7. 验证 SQL（5434 EXPLAIN，禁止写入）

```sql
-- 1. 验证待支付订单唯一约束生效
SELECT client_user_id, COUNT(*)
FROM sale_orders
WHERE status = '待支付' AND client_user_id IS NOT NULL
GROUP BY client_user_id HAVING COUNT(*) > 1;
-- 预期：0 行（uq_sale_orders_client_pending 守护）

-- 2. 同 phone 散客待支付
SELECT client_phone, store_id, COUNT(*)
FROM sale_orders
WHERE status = '待支付' AND client_user_id IS NULL AND client_phone IS NOT NULL
GROUP BY client_phone, store_id HAVING COUNT(*) > 1;

-- 3. 探测「同订单首次支付重复行」(P0-CC2-05 现状)
SELECT sale_order_id, COUNT(*) AS first_pay_rows
FROM sale_order_payments
WHERE change_type = '首次支付' AND status = '已支付'
GROUP BY sale_order_id HAVING COUNT(*) > 1;
-- 预期：0 行；非 0 即并发命中

-- 4. 探测「服务单号跨端撞号」（P0-CC2-04）
SELECT service_order_id, COUNT(*)
FROM service_orders
GROUP BY service_order_id HAVING COUNT(*) > 1;

-- 5. 探测「同订单 refund inflight 多行」(P0-CC2-03)
SELECT ref_sale_order_id, COUNT(*)
FROM sale_orders
WHERE sale_order_type = '退款单' AND status = '待审批'
GROUP BY ref_sale_order_id HAVING COUNT(*) > 1;

-- 6. 探测「prepaid_cards.balance 与流水加总不一致」(P1-CC2-14)
SELECT pc.user_id, pc.balance,
       COALESCE(SUM(ct.amount), 0) AS sum_tx,
       pc.balance - COALESCE(SUM(ct.amount), 0) AS drift
FROM prepaid_cards pc
LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
GROUP BY pc.user_id, pc.balance
HAVING ABS(pc.balance - COALESCE(SUM(ct.amount), 0)) > 0.01;

-- 7. 探测「已关闭订单仍有未冲销 sa 行」(P0-CC2-06)
SELECT o.sale_order_id, COUNT(sa.id) AS active_alloc_after_close
FROM sale_orders o
JOIN sale_items si ON si.sale_order_id = o.sale_order_id
JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
WHERE o.status = '已关闭' AND sa.is_void = false
GROUP BY o.sale_order_id;

-- 8. 探测「退款已审批但 sa 未冲销」(P0-CC2-07)
SELECT o.sale_order_id AS refund_id, ref.sale_order_id AS orig_id,
       COUNT(sa.id) AS still_active_sa_on_orig
FROM sale_orders o
JOIN sale_orders ref ON o.ref_sale_order_id = ref.sale_order_id
JOIN sale_items si ON si.sale_order_id = ref.sale_order_id
JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
WHERE o.sale_order_type = '退款单' AND o.status = '已支付'
  AND sa.is_void = false
GROUP BY o.sale_order_id, ref.sale_order_id;

-- 9. card_transactions 同 ref_order_id 重复扣款探测（P0-CC2-10）
SELECT ref_order_id, type, COUNT(*)
FROM card_transactions
WHERE ref_order_id IS NOT NULL
GROUP BY ref_order_id, type HAVING COUNT(*) > 1;

-- 10. point_transactions 同 ref + type 重复（P0-CC2-10）
SELECT user_id, ref_order_id, type, COUNT(*)
FROM point_transactions
WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')
GROUP BY user_id, ref_order_id, type HAVING COUNT(*) > 1;
```

---

## 8. 回归测试用例（建议）

1. **并发开单（P0-CC2-01）**：同一店长在 0.5 秒内发起两次 staff order.create + 一次 staff createRefund，断言 sale_order_id 全部不重号
2. **并发首次支付（P0-CC2-03 / P0-CC2-05）**：staff confirmOffline 双进程同一 saleOrderId 调用，断言 sale_order_payments 仅 1 行 change_type='首次支付'
3. **并发取消（P0-CC2-02）**：client.cancel + payNotify 同步收到回调，断言 sale_orders.status 不会从 '已支付' 被覆盖回 '已关闭'
4. **批量发券超发（audit-13 P0-13-06/07 / P0-CC2-03）**：admin batchIssueCoupons 200 个手机号 + 模板 totalCount=100，断言至多 100 张被插入
5. **退款审批冲销（P0-CC2-07）**：admin approveRefund 后查 sa.is_void=true / sc.is_void=true / user_coupons.status 回归 '未使用' / point_transactions 写"消费冲销" / pickup_records.picked_up_quantity 不增长
6. **储值卡余额对账（P1-CC2-14）**：cron 跑 audit-prepaid-balance step，断言任意 user 的 prepaid_cards.balance == SUM(card_transactions.amount)
7. **store_unbind 三端 race（P0-CC2-02）**：同一 requestId 同时调用 staff approveUnbind + admin rejectUnbind，断言仅一方成功，另一方 rowCount=0 / CONCURRENT_CHANGED
8. **payNotify 重放攻击（P0-CC2-02）**：同一 transactionId 重复 5 次 callback，断言 sale_order_payments 仅 1 行（uq_sop_txn ON CONFLICT 命中），sale_orders.status 不再次推进
9. **service_orders 双端撞号（P0-CC2-04）**：staff service.complete + admin createService 在跨午夜窗口同时跑，断言生成不同 service_order_id（修复后）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB + payNotify + cron-worker）：☑**
- 涉及历史数据：☑（partial UNIQUE 创建前需先清理重复行；需先跑 §7 验证 SQL 1/3/5 探测既存重复）
- 修复成本：**L**（10+ schema migration + 14 个代码路径修改 + 6 个 helper 抽取 + 9 个回归测试）

---

## 10. 后续待办

- [ ] **P0 收口顺位（按"零代码改 → 代码改"切片）**：
  - Slice A（schema-only）：合并 11 项 partial UNIQUE 缺口（§1.1 末尾表 a-k）+ idempotency_key 字段化（pickup_records / operation_logs）+ voided_at 字段（service_commissions）→ 一个 PR 出 0 个新代码改动，但需先跑 §7 SQL 1/3/5/9/10 清理潜在重复行
  - Slice B（应用层最小修补）：staff confirmOffline / createRefund 移入事务 + admin batchSendMessages 加 idempotency_key + admin coupon issue/batch 加 advisory_xact_lock + admin/staff store-unbind 5 路径加 status CAS
  - Slice C（系统性收敛）：抽 `db/helpers/lock-keys.ts` + `sale-item-availability.ts` + `role-resolve.ts` + `settlePoints` 单源 + grantShareGift 单源 + status 级联（close 事件）+ 退款冲销 5 类（sa/sc/coupons/points/pickup）
  - Slice D（运维守护）：新增 `audit-prepaid-balance.ts` + `audit-allocation-vs-payment.ts` cron step；建立"仅告警 cron" SLA 机制（P2-CC2-20）

- [ ] 与 CC1 audit-CC1-numeric-precision §6 末"金额符号 CHECK 推广 chk_sop_amount_sign"合并发版（schema-only Slice A 一并）
- [ ] 与 CC3 audit（待）规划"店长 store_id × scopeType 过滤"+"UPDATE CAS"双闸 Linter
- [ ] 与 CC4 audit（待）payNotify 签名校验改造一同上线（P0-04-01 / 资金幂等的真正前置条件）
- [ ] 测试治理：把 P2-CC2-19 mock 锁死的 9 处 fixture 改为 spy 校验"调用了 advisory_xact_lock"而非 mock 返回值，让"双事务模式"重现
- [ ] 文档：把 §1.2 advisory lock 18 调用点表沉淀为 `docs/dev/lock-key-registry.md`，新增 lock 必须先注册

---

## 附：CC2 模式分类（A1-A10 收口）

为后续审计与代码 review 建立"模式语言"，CC2 全栈共 10 类问题模式：

| 编号 | 模式 | 典型现象 | 修复手段 |
|------|------|---------|---------|
| A1 | Advisory lock 跨事务释放窗口 | helper 自带 pg.transaction，外层主事务再开 | 移除内层事务 |
| A2 | 状态机 UPDATE 缺 CAS | `WHERE pk_only`，不带 status | 加 `AND status = $expected` + rowCount 校验 |
| A3 | TOCTOU：事务外读 → 事务内 INSERT | 决策 SELECT 不在 begin 后 | 移入事务 + partial UNIQUE 兜底 |
| A4 | Advisory lock key 跨端不互斥 | 私有 hash vs `hashtext()` | 抽 `lock-keys.ts` 单源 |
| A5 | 状态级联缺失 | 关单/退款只改 sale_orders，不动流水/分配/券/积分 | 状态翻转事件触发器或同事务级联 |
| A6 | 退款审批不冲销「次数等价物」| sa/sc/coupons/points/pickup 5 处不冲销 | approveRefund 同事务批量 UPDATE |
| A7 | 跨端实现风格冲突（硬删 vs 软删）| staff DELETE / admin UPDATE is_void | 单端实现风格统一 |
| A8 | 余额扣减无 `AND balance >= $1` 守卫 | 仅 FOR UPDATE 行锁 | 加原子条件 |
| A9 | 流水类表 partial UNIQUE 缺位 | 应用层 SELECT-then-INSERT 幂等 | DB partial UNIQUE 兜底 |
| A10 | idempotency-key 应用层不填充 | partial unique on NULL 完全无效 | batchId UUID + 每行填充 |

每个模式都已在 §3 / §4 标注了影响域 + 量化路径数。后续 audit / refactor 应按此分类直接定位修复手段，不再为同类问题二次发现。
