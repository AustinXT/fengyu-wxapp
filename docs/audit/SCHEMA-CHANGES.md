# Schema 修改建议归集（SCHEMA-CHANGES）

每轮审计中提出的 schema / migration 级修改建议汇总。最终评审后批量产出迁移。

---

## 来自域 01（认证 / 鉴权）

### S01-1 phone 列加 CHECK 约束（中国手机号）
- **表**：`staff_wechat_users`、`client_wechat_users`
- **DDL**：
  ```sql
  ALTER TABLE staff_wechat_users
    ADD CONSTRAINT chk_swu_phone_format
    CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{8}$');
  ALTER TABLE client_wechat_users
    ADD CONSTRAINT chk_cwu_phone_format
    CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{8}$');
  ```
- **前置**：先跑 audit-01 §8 #6 找出违规行并清洗
- **关联**：P0-PHONE-05

### ~~S01-2 跨表 OPENID 全局唯一~~（2026-04-26 OBSOLETE）

> **作废说明**：OPENID 是 appid scoped，client appid 与 staff appid 对同一微信用户签发的 OPENID 物理不同。跨表唯一性自动成立，无需 DB 约束。详见 [SUMMARY.md §5.1 D-Q2-2026-04-26](./SUMMARY.md)。
>
> 原方案保留如下仅供归档参考：

#### S01-2-archived 跨表 OPENID 全局唯一
- **表**：`staff_wechat_users` + `client_wechat_users`
- **方案 A（物化视图）**：
  ```sql
  CREATE MATERIALIZED VIEW openid_registry AS
    SELECT openid, 'staff' AS realm FROM staff_wechat_users WHERE openid IS NOT NULL
    UNION ALL
    SELECT openid, 'client' FROM client_wechat_users WHERE openid IS NOT NULL;
  CREATE UNIQUE INDEX uniq_openid_global ON openid_registry(openid);
  -- 触发器在两表写入后 REFRESH
  ```
- **方案 B（推荐：触发器）**：在两表 INSERT/UPDATE 触发器中查对端表，命中则 RAISE EXCEPTION
- **前置**：先跑 audit-01 §8 #2 验证当前是否已存在跨表重叠数据
- **关联**：P0-SPLIT-04

---

## 来自域 02（开单 + 状态机 + 订单号唯一）

### S02-1 `uq_sale_orders_phone_pending` 索引去掉 store_id 维度
- **表**：`sale_orders`
- **现状**：`db/schema/order.ts:111-113`
  ```ts
  uniqueIndex("uq_sale_orders_phone_pending")
    .on(table.clientPhone, table.storeId)
    .where(sql`status = '待支付' AND client_user_id IS NULL`)
  ```
- **建议 DDL**：
  ```sql
  DROP INDEX uq_sale_orders_phone_pending;
  CREATE UNIQUE INDEX uq_sale_orders_phone_pending
    ON sale_orders (client_phone)
    WHERE status = '待支付' AND client_user_id IS NULL;
  ```
- **关联**：[P1-02-11]
- **风险**：一日内同一手机号在 A 店未注册下单 + B 店注册下单可形成两单待支付。

### S02-2 `sale_orders.allocation_status` 加默认值 `'待分配'`
- **表**：`sale_orders`
- **现状**：`db/schema/order.ts:79` 无 `.default()`，staff.create 不显式写时落 NULL。
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_orders
    ALTER COLUMN allocation_status SET DEFAULT '待分配';
  -- 数据修复：
  UPDATE sale_orders SET allocation_status = '待分配' WHERE allocation_status IS NULL;
  ```
- **关联**：[P1-02-09]

### S02-3 PG 集群级 `SET timezone = 'Asia/Shanghai'`
- **范围**：5434/fengyu 主库；5433 冷备
- **建议 SQL**：
  ```sql
  ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
  -- 然后重连：每个 application 进程下次连接生效
  ```
- **配套 application 改动**：所有 `new Date().toISOString().slice(...)` 统一改用 `dayjs().tz('Asia/Shanghai').format('YYMMDD')`
- **关联**：[P0-02-02]
- **风险评估**：会影响所有 `NOW()` / `CURRENT_DATE` 返回值。pre-flight：跑域 17（数据看板时间维度）和域 06（appointment.checkin_at）回归测试。

---

## 来自域 03（款项流水 sale_order_payments）

### S03-1 `'首次支付'` 至多 1 行/订单 partial unique
- **表**：`sale_order_payments`
- **现状**：仅有 `uq_sop_txn (sale_order_id, payment_method, external_txn_id) WHERE external_txn_id IS NOT NULL`；'首次支付' 唯一性靠应用层（且事务外）SELECT，并发可重。
- **建议 DDL**：
  ```sql
  CREATE UNIQUE INDEX uq_sop_first_payment
    ON sale_order_payments (sale_order_id)
    WHERE change_type = '首次支付';
  ```
- **前置**：先跑 audit-03 §7 #3 验证当前是否已存在多 '首次支付' 行
- **关联**：[P0-03-03]

### S03-2 退款单 in-flight 唯一性 ✅ 已完成（2026-04-27 域重构收官）
- **表**：~~`sale_orders`~~ → `sale_order_payments`
- **现状**：~~staffApi/routes/order.js:1352 应用层 SELECT 校验同原单不能有两笔 '待审批' FY-TKD，但事务外读，并发不安全~~ → **已解决**：退款架构重构后，退款改为 `sale_order_payments[change_type='退款']` 行，migration 0018+0021 引入 `uq_sop_status_audit (sale_order_id, change_type) WHERE change_type='退款' AND status='待审批'` partial unique index，直接覆盖该缺口。sale_order_type_enum 已从 5 值收窄为 3 值，旧退款单路径不再存在。
- **建议 DDL**：~~`CREATE UNIQUE INDEX uq_sale_orders_refund_inflight ...`~~ → **不再需要**，由 `uq_sop_status_audit` 替代
- **关联**：[P0-03-04] → **已关闭**

### S03-3 sale_order_payments 加 `metadata jsonb` 列
- **表**：`sale_order_payments`
- **现状**：`note` text 被当成软结构化键（`'FY-TKD=...; reason=...; fee=...'`），applyRefund 用 `note LIKE 'FY-TKD=...%'` 字符串匹配翻转状态，脆弱。
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_order_payments
    ADD COLUMN metadata jsonb;
  -- 后续：迁移 createRefund / approveRefund 用 metadata->>'refundOrderId' 替代 note LIKE
  CREATE INDEX idx_sop_metadata_refund
    ON sale_order_payments ((metadata->>'refundOrderId'))
    WHERE change_type = '退款';
  ```
- **关联**：[P2-03-16, P2-03-17]

### S03-4 sale_orders 列符号与 sale_order_type 联动 CHECK — ⚠️ 架构性作废（2026-04-27）
- **表**：`sale_orders`
- **现状**：~~staffApi/routes/order.js:1530-1535 approveRefund UPDATE FY-TKD 把 prepaid_card_amount 写负数，paid_amount 写负数。schema 未约束符号；下游报表如 SUM(paid_amount) 会被退款单负数干扰。~~ → **已解决**：退款不再创建 `sale_orders[type='退款单']` 行（sale_order_type_enum 已收窄为 3 值，不含'退款单'/'回款单'），退款全部下沉到 `sale_order_payments`（`chk_sop_amount_sign` 已守护符号）。`paid_amount` 列已在 migration 0018 中 DROP。销售单/内部单/转换单均写正数，原建议的按 type 联动符号 CHECK 不再需要。
- **建议 DDL**：~~原建议的联动 CHECK~~ → **不再适用**。可选加 `CHECK (total_amount >= 0)` 通用非负约束（P2 优先级）。
- **关联**：[P1-03-11] → **架构性作废**

### S03-5 schema 注释刷新：`'储值卡抵扣'` 启用范围
- **文件**：`db/schema/order.ts:235`
- **现状注释**：`本 PR（partial-payment foundation）阶段只启用前三类；储值卡抵扣行留待后续 ticket 启用`
- **修订**：删除"留待后续 ticket"，改为"已在 staff.confirmOffline / staff.createRepayment / admin.recordPayment / client.repay 启用；client.create 全额抵扣 + client.confirmPrepaidFull 待补 (P0-03-02)"
- **关联**：[P2-03-20]

---

## 来自域 04（支付回调 payNotify 幂等）

### S04-1 评估删除 sale_orders.wechat_transaction_id 列（与 sale_order_payments.external_txn_id 重叠）
- **表**：`sale_orders`
- **现状**：`db/schema/order.ts:75` `wechatTransactionId: varchar(...).unique()`；`payNotify/index.js:197` 用 `COALESCE(wechat_transaction_id, $4)` 写入 → 部分支付场景仅记第一笔
- **建议 DDL**（方案 A：删除）：
  ```sql
  ALTER TABLE sale_orders DROP CONSTRAINT IF EXISTS sale_orders_wechat_transaction_id_unique;
  ALTER TABLE sale_orders DROP COLUMN wechat_transaction_id;
  ALTER TABLE sale_orders DROP COLUMN alipay_transaction_id; -- 同样冗余
  -- 后续：payNotify / staffApi / clientApi / admin 所有 SELECT wechat_transaction_id 改为 JOIN sale_order_payments
  ```
- **建议 DDL**（方案 B：保留但语义化）：仅作为"首笔交易号"快照，加注释；UNIQUE 索引降级为 INDEX
- **关联**：[P1-04-08]
- **风险评估**：删除前先 grep 三端 wechat_transaction_id 的所有读取点

### S04-2 uq_sop_txn 唯一索引限定 change_type 范围
- **表**：`sale_order_payments`
- **现状**：`db/schema/order.ts:269-271`
  ```ts
  uniqueIndex("uq_sop_txn")
    .on(table.saleOrderId, table.paymentMethod, table.externalTxnId)
    .where(sql`external_txn_id IS NOT NULL`)
  ```
- **风险**：未限定 change_type，理论上同 (orderId, method, txn) 跨 '首次支付' / '回款' / '退款' 也是同一行，但若 mock 调用刻意制造 change_type='退款' 的伪行（amount 必须 < 0 满足 chk_sop_amount_sign），同 (orderId, method, txn) 仍会 ON CONFLICT — 当前形式可能是预期行为。**重新审议**：实际上唯一性应是 "同订单同 txn 仅 1 行"（不分 method）。
- **建议 DDL**：
  ```sql
  DROP INDEX uq_sop_txn;
  CREATE UNIQUE INDEX uq_sop_txn
    ON sale_order_payments (sale_order_id, external_txn_id)
    WHERE external_txn_id IS NOT NULL;
  ```
- **关联**：[P0-04-02]（method 任意改写绕开当前键）

### S04-3 payNotify 函数 RAM / 触发器隔离
- **范围**：CloudBase 配置（非 schema，但归类此处便于追踪）
- **现状**：payNotify 默认对小程序前端开放调用（同 envId）
- **建议**：
  ```bash
  tcb fn config update payNotify --triggers '<HTTP-trigger-with-IP-whitelist>'
  # 或：在云函数代码内首行校验 cloud.getWXContext().SOURCE === 'WX_HTTP_TRIGGER'
  ```
  + 微信支付商户后台配置 NotifyURL 为 CloudBase HTTP 触发器 URL
- **关联**：[P0-04-01] — 安全网外层兜底，不能替代签名校验

---

---

## 来自域 05（服务单 + 扣次原子性）

### S05-1 `service_items` schema vs staff INSERT 失配，决策保留 / 移除 sku_id
- **表**：`service_items`
- **现状**：`db/schema/service.ts:52-80` 不含 skuId；`fengyu-staff/cloudfunctions/staffApi/routes/service.js:207-224` INSERT 列清单含 `sku_id` 与 `$5` 占位（PG 报 42703 column does not exist）
- **方案 A（补 schema，建议）**：因 admin 已不读 sku_id，且 sale_items.sku_id 已可一跳查到，**移除 staff INSERT 的 sku_id 列**（无 schema 变更，仅 L3 修复）
- **方案 B**：补 migration `ALTER TABLE service_items ADD COLUMN sku_id text REFERENCES product_skus(sku_id);` + schema 同步加 `skuId` 字段。仅当后续报表确实需要 service_items.sku_id 时采纳
- **关联**：P0-05-01

### S05-2 service_orders 增加 partial unique 防 TOCTOU 重复
- **表**：`service_orders`
- **DDL**：
  ```sql
  CREATE UNIQUE INDEX uq_so_appointment
    ON service_orders(appointment_id)
    WHERE appointment_id IS NOT NULL;
  CREATE UNIQUE INDEX uq_so_client_active
    ON service_orders(client_user_id)
    WHERE status IN ('待服务','服务中');
  ```
- **前置**：先跑 audit-05 §8 #3/#4 找出已存在的违规行并清洗
- **关联**：P0-05-03

### S05-3 service_orders ID 前缀对齐 + advisory lock key 收敛
- **表**：`service_orders`
- **现状**：staff 用 `HLD-WX-{YYMMDD}NNNN`，admin 用 `FY-FW-{YYMMDD}NNNN`，spec 全局规范要 `FY-XSD-WX-` 但销售单和服务单需区分语义
- **建议**：统一 `FY-FW-{YYMMDD}NNNN`（与销售单 `FY-XSD-WX-` 区分）；advisory lock key 收敛为 `hashtext('service_order_id_gen')`（PG 内置，跨语言一致）
- **关联**：P0-05-02

### S05-4 service_commissions 增加 status 列支持 rate=0 重算
- **表**：`service_commissions`
- **现状**：`db/schema/service-commission.ts:16-51` 只有 `is_void` 软删除标记，无"待重算 / 已重算"语义；rate=0 写入后无补救机制
- **方案 A（推荐）**：rate=0 时不写 service_commissions，而是把 service_orders.commission_status 设为 '待分配'，admin 控制台展示并允许补单 + 重算
- **方案 B**：增加 `recalc_status` 列：'pending'/'final'/'voided'；rate=0 时记 'pending'，运维补矩阵后定时回扫
- **关联**：P0-05-05, P0-05-06

### S05-5 service_items.sku_id（如保留）与 sales_category / is_shengmei 一致来自 sale_items 快照
- **表**：`service_items`
- **现状**：is_shengmei (0008)、sales_category (0011) 均已为快照列；若决策 S05-1 方案 B 保留 sku_id，应同样从 sale_items 快照一份（避免 product_skus 改动后语义漂移）
- **关联**：P1-05-09

---

## 来自域 06（预约 + 签到 → 服务单流转）

### S06-1 service_orders.appointment_id 加 partial UNIQUE
- **表**：`service_orders`
- **现状**：`db/migrations/0000_baseline.sql:547` 仅有 FK；`staffApi/routes/service.js:55-69` 事务外读判重，并发可重复关联同一 appointment_id
- **DDL**：
  ```sql
  CREATE UNIQUE INDEX uq_so_appointment
    ON service_orders(appointment_id)
    WHERE appointment_id IS NOT NULL;
  ```
- **前置**：先跑 audit-06 §7 #1 验证当前是否已存在多对一脏数据；与 audit-05 S05-2 同款，本域复用
- **关联**：P0-06-03

### S06-2 appointments 加 (sale_item_id) 活跃唯一约束
- **表**：`appointments`
- **现状**：client.appointment.create 校验"该 saleItemId 不存在 (待确认,已确认) 预约"（`clientApi/routes/appointment.js:83-91`）但事务外读，无 partial unique 兜底
- **DDL**：
  ```sql
  CREATE UNIQUE INDEX uq_appts_sale_item_active
    ON appointments(sale_item_id)
    WHERE sale_item_id IS NOT NULL AND status IN ('待确认','已确认');
  ```
- **前置**：先跑 audit-06 §7 #2 找出已存在的多对一脏数据并清洗
- **关联**：P0-06-03 / P2-06-15

### S06-3 appointments 加 (employee_id, appointment_time) 时段冲突约束
- **表**：`appointments`
- **现状**：`db/schema/appointment.ts:45 idx_appts_employee_time` 仅是 btree 普通索引；三端 create / confirm 均不校验同员工同时段重叠
- **DDL（方案 A，简化 partial unique，相同精确时刻冲突）**：
  ```sql
  CREATE UNIQUE INDEX uq_appts_employee_time_active
    ON appointments(employee_id, appointment_time)
    WHERE status IN ('待确认','已确认');
  ```
- **DDL（方案 B，时间区间冲突需 btree_gist 扩展）**：
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE appointments ADD CONSTRAINT excl_appts_employee_overlap
    EXCLUDE USING gist (
      employee_id WITH =,
      tsrange(appointment_time, appointment_time + interval '2 hour', '[)') WITH &&
    ) WHERE (status IN ('待确认','已确认'));
  ```
- **关联**：P1-06-06
- **风险评估**：方案 B 需要决定时段长度（每商品 SKU 不同？或固定 2h）；先用方案 A 兜底相同精确时刻并发预约

### S06-4 admin PERMISSION_MATRIX 增加 appointment:cancel
- **范围**：`fengyu-admin/src/lib/permissions.ts:48`
- **现状**：仅 `'appointment:list', 'appointment:confirm', 'appointment:checkin'`，cancelAppointment 错用 confirm 权限
- **修改**：
  ```ts
  manager: [
    ...
    'appointment:list', 'appointment:confirm', 'appointment:checkin', 'appointment:cancel',
    ...
  ]
  ```
- **配套**：`admin/actions/appointments.ts:250` 改用 `requirePermission(session, 'appointment:cancel')`
- **关联**：P0-06-05

### S06-5 cron close-expired-appointments STEP（业务实现，非 schema 但归类此处）
- **范围**：新建 `fengyu-admin/src/cron/steps/close-expired-appointments.ts`
- **建议代码骨架**：
  ```ts
  // STEP 6: 关闭超过 24 小时未到店的预约
  await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE appointments
      SET status = '已关闭', updated_at = NOW()
      WHERE status IN ('待确认','已确认')
        AND appointment_time < NOW() - INTERVAL '1 day'
      RETURNING appointment_id
    `)
    // 写 operation_logs source='cronTask' action='appointment.close.expired'
  })
  ```
- **关联**：P0-06-04

---

## 来自域 07（销售提成分配）

### S07-1 `sale_allocations.allocation_ratio` 加 CHECK 约束限制取值
- **表**：`sale_allocations`
- **现状**：`db/schema/order.ts:206` `numeric("allocation_ratio", { precision: 5, scale: 2 })`，schema 不阻止 0.05 / 2.50 等非法值
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_allocations
    ADD CONSTRAINT chk_alloc_ratio_decile
    CHECK (allocation_ratio IN (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00));
  ```
- **配套**：与应用层 `VALID_RATIOS` 集合（staff:17 / admin:172）严格一致
- **关联**：P1-07-11、P0-07-03（前端把 commission_rate 当 ratio 提交时 DB 兜底拒绝）

### S07-2 `sale_allocations.total_amount` → 重命名 `allocated_revenue` 消歧
- **表**：`sale_allocations`
- **现状**：`db/schema/order.ts:212` 字段名 `total_amount`，但实际语义是"received × allocation_ratio = 分配业绩营业额"，与 `service_commissions.commission_amount`（实际提成金额）语义截然不同
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_allocations RENAME COLUMN total_amount TO allocated_revenue;
  ```
- **影响**：3 端共 ~10 处 SQL（admin/staff/payNotify/staff.todayCommission/performanceDetail/mgmt-dashboard）需同步
- **关联**：P2-07-16

### S07-3 backend.pr.spec.md §2.10 unique key 描述与实现对齐
- **范围**：spec 文档（非 DDL）
- **现状**：spec L267 `UNIQUE(sale_item_id, employee_id) WHERE is_void = false`；实现 `uq_sale_alloc_item_emp_role` 是 3 列 (sale_item_id, employee_id, role_type)
- **建议**：文档改为 3 列（实现优先，多角色场景合理）；同步 cog.md 关于"同员工对同 sale_item 多角色业绩"的语义说明
- **关联**：P1-07-12

### S07-4 staff allocation.js 三处 DELETE → UPDATE is_void=true
- **范围**：仅业务代码（非 DDL，列入 schema 改造是因为它影响 schema 软删除字段的语义遵守）
- **现状**：`staffApi/routes/allocation.js:86, 163, 234` 三处 `DELETE FROM sale_allocations WHERE ...`
- **建议代码**：
  ```js
  await client.query(
    `UPDATE sale_allocations
       SET is_void = true, voided_at = $1, updated_at = $1
     WHERE sale_item_id = ANY($2) AND is_void = false`,
    [now, itemIds]
  )
  ```
- **关联**：P0-07-01

### S07-5 退款审批流补：原销售单 sale_allocations 按比例缩减 ✅ 已完成（2026-04-26/27）
- **范围**：业务代码（多端 + DB；列入 schema 是因为可能涉及新增"退款拆分行"模式）
- **现状**：~~`staffApi/routes/order.js:1488-1636 approveRefund`：完全不动原单 sa~~ → **已解决**：退款 cascade 已实现 `UPDATE sale_allocations SET is_void=true, voided_at=NOW()` 同事务原子操作。`fengyu-admin/src/actions/refunds.ts` 同步实现。5 通道 cascade（sa/sc/coupons/points/pickup）已在 refund-cascade.js/ts 双端落地。
- **关联**：P0-07-02 → **已关闭**

## 来自域 08（服务提成 service_commissions）

### S08-1 service_commissions 增加 voided_at / voided_by / void_reason 三列（审计断裂修复）
- **范围**：schema + migration + admin/staff 写入路径
- **现状**：
  - schema `db/schema/service-commission.ts:16-51` 仅有 `is_void boolean default false`
  - admin `service-commissions.ts:144-149` 在 tx 内 `UPDATE ... SET is_void = true`，**没有 voided_at**
  - 与 sale_allocations 设计对比：`db/schema/order.ts:213-214` 已显式声明 `is_void` + `voided_at`，admin allocations.ts:279 写 `voided_at = NOW()`
- **建议 schema**：
  ```ts
  voidedAt: timestamp('voided_at'),
  voidedBy: varchar('voided_by', { length: 30 })
    .references(() => staffWechatUsers.employeeId),
  voidReason: varchar('void_reason', { length: 20 }),  // '重新分配' | '退款冲销' | '订单取消'
  ```
- **关联**：P0-08-05, P1-08-10

### S08-2 service_commissions 增加 service_date / store_id / org_id 快照列（跨期对账加速）
- **范围**：schema + migration + staff.complete 写入快照
- **现状**：sc 表无任何 store/org/date 列，所有 dashboard / 绩效查询都需 3 跳 JOIN（sc → service_items → service_orders）
- **建议 schema**：
  ```ts
  serviceDate: date('service_date'),
  storeId: text('store_id').references(() => stores.storeId),
  orgId: text('org_id').references(() => orgNodes.id),
  ```
- **关联**：P1-08-13；含跨期归属"事件时点"语义保护

### S08-3 service_commissions.allocation_ratio CHECK 约束
- **范围**：schema + migration
- **现状**：`numeric('allocation_ratio', { precision: 5, scale: 2 })` 不限值域；staff.complete 永远写 1.00，admin batchSave 写 0.10..1.00 整十值；schema 层无约束
- **建议**：
  ```sql
  ALTER TABLE service_commissions
    ADD CONSTRAINT chk_svc_comm_ratio
    CHECK (allocation_ratio IS NULL OR allocation_ratio IN (0.10,0.20,0.30,0.40,0.50,0.60,0.70,0.80,0.90,1.00));
  ```
- **关联**：P1-08-12

### S08-4 commission_status 拆出独立枚举（区分服务/销售提成的状态语义）
- **范围**：schema + migration + admin/staff 写入路径
- **现状**：
  - `db/schema/service.ts:38` `commissionStatus: allocationStatusEnum('commission_status')` 与 sale_orders.allocation_status 共用枚举
  - 缺少"无需分配"/"待重算"等服务提成专属语义
- **建议**：新建 `serviceCommissionStatusEnum('待分配','已分配','部分分配','待重算')`
- **关联**：P1-08-09

### S08-5 commission_rate_matrix varchar → enum 迁移（数据完整性）
- **范围**：schema + migration（与 audit-07 ENUM-AUDIT E07-sales-category 同诉求合并）
- **现状**：`db/schema/commission.ts:17-19` 三列（order_type/role_type/sales_category）全是 varchar(20)，无 DB 层 enforce
- **建议**：分别转为 `saleOrderTypeEnum`（subset：销售单/服务单/转换单）+ `salesCategoryEnum` + 新建 `roleTypeEnum('美容师','养生师','推广师')`
- **风险**：转换需要先做 backfill 校验，可能存在历史脏值
- **关联**：P2-08-16

### S08-6 staff.complete 提成计算抽 db helper（跨端复用）
- **范围**：业务代码（不是 schema，但属于应该共享的 DB 层操作）
- **现状**：staff `routes/service.js:388-450` 里 60 行 commission 计算逻辑硬编码；admin `services.ts:333-396 completeServiceOrder` 完全没有
- **建议**：抽 `db/helpers/service-commission.ts`：
  ```ts
  export async function writeServiceCommissions(
    tx: PgTx,
    serviceOrderId: string,
    items: ServiceItem[],
    auth: { staffWfId: string; marketName?: string }
  ): Promise<{ rateMissingItems: string[] }>
  ```
  admin/staff 共用；rate=0 时返回 rateMissingItems → 调用方决定是否阻塞或置 commission_status='待分配'
- **关联**：P0-08-02, P0-08-06, P2-08-15

### S08-7 退款审批 + 服务取消 联动作废 sc（修复退款资损）✅ 已完成（2026-04-26/27）
- **范围**：业务代码
- **现状**：~~`refunds.ts:830-960 approveRefund` + `staffApi/routes/order.js approveRefund` 都不动 sc~~ → **已解决**：退款 cascade 通道 2 已实现 `UPDATE service_commissions SET is_void=true, voided_at=NOW()` 同事务原子操作。`service_commissions.voided_at` 列由 migration 0018 添加。5 通道 cascade 已双端落地。
- **关联**：P0-08-04 → **已关闭**（与 S07-5 同步关闭）

## 来自域 09（商品 + SKU + 价格 + 有效期）

### S09-1 product_skus.market_scope 是否需要 NOT NULL + 默认值
- **表**：`product_skus`
- **现状**：`db/schema/product.ts:60` `marketScope: text('market_scope')`（可 NULL，注释 "null=全部可见"）
- **风险**：order.create 需要 `WHERE (market_scope IS NULL OR market_scope = $market)` 才能正确隔离；当前实现完全漏校（P0-09-02）
- **建议**：保持 NULL 语义不变，但在 schema 文档显式标记"必读"+ 业务代码补加 helper `isInMarketScope(sku, boundMarketName)`
- **关联**：P0-09-02

### S09-2 valid_start / valid_end 字段去留决策
- **表**：`products` / `product_skus`
- **现状**：baseline reset 之前 `_archive_pre_baseline_2026_04/snapshots/0010_snapshot.json:423-435` 显示有 valid_start / valid_end 列；当前 schema 已删除
- **PLAN 检查点**：仍要求验证"当前时间在有效期内才可下单"
- **决策选项**：
  - **方案 A**（推荐）：保持现状（仅 isEnabled 二值），从 PLAN 中删除 valid_start / valid_end 项
  - **方案 B**：补 schema：
    ```sql
    ALTER TABLE product_skus ADD COLUMN valid_start timestamp;
    ALTER TABLE product_skus ADD COLUMN valid_end timestamp;
    ALTER TABLE product_skus ADD CONSTRAINT chk_sku_valid_range
      CHECK (valid_start IS NULL OR valid_end IS NULL OR valid_start < valid_end);
    -- 配套：cron STEP 6 定时按 valid_end 自动 isEnabled=false
    ```
- **关联**：P1-09-06

### S09-3 sale_items 加 sale_amount 不变量 CHECK
- **表**：`sale_items`
- **现状**：`db/schema/order.ts:159` `saleAmount = numeric(...)`，无 CHECK
- **业务约定**：`sale_amount = unit_price * quantity`（schema 注释暗含）
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_items
    ADD CONSTRAINT chk_item_sale_amount
    CHECK (ABS(sale_amount - unit_price * quantity) < 0.02);  -- 容忍分级精度
  ```
- **前置**：先跑 audit-09 §7 #4 找出违规行（client 端历史脏数据）并回填
- **关联**：P1-09-11

### S09-4 mall_product_skus.bundle_price CHECK 上限
- **表**：`mall_product_skus`
- **现状**：`db/schema/product.ts:162` 仅声明字段，无 CHECK
- **建议 DDL**（trigger 实现，CHECK 不能跨表）：
  ```sql
  CREATE OR REPLACE FUNCTION trg_mps_bundle_price_limit() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.bundle_price IS NOT NULL THEN
      IF NEW.bundle_price < 0 THEN
        RAISE EXCEPTION 'bundle_price must be non-negative';
      END IF;
      IF NEW.bundle_price > (SELECT price FROM product_skus WHERE sku_id = NEW.sku_id) THEN
        RAISE EXCEPTION 'bundle_price cannot exceed sku.price';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER tr_mps_bundle_price_limit
    BEFORE INSERT OR UPDATE ON mall_product_skus
    FOR EACH ROW EXECUTE FUNCTION trg_mps_bundle_price_limit();
  ```
- **关联**：P1-09-08

### S09-5 抽 db/helpers/price-snapshot.ts 收敛三端价格快照写入
- **范围**：业务代码（不是 schema，但对 sale_items 数据语义有决定作用）
- **现状**：staff `routes/order.js:271-291` / client `routes/order.js:222-227` / admin `actions/orders.ts:613-740` 三端各自实现 unitPrice / unitRealPrice / saleAmount / received 计算逻辑，语义已分裂（特价 vs 原价）。
- **建议**：
  ```ts
  // db/helpers/price-snapshot.ts
  export function snapshotItemPrice(
    sku: ProductSku,
    options: { quantity: number; customPrice?: number; isInternal?: boolean; discount?: number }
  ): { unitPrice: number; unitRealPrice: number; saleAmount: number; received: number; serviceFee: number; isShengmei: boolean | null }
  ```
  统一约定：`unitPrice = sku.price`（原价快照）；`unitRealPrice = customPrice ?? (isInternal ? sku.price * 0.5 : (sku.special_price || sku.price))`；`saleAmount = unitPrice × quantity`（**原价 × 数量**）；`received = unitRealPrice × quantity - discount`
- **关联**：P1-09-04, P1-09-11

### S09-6 admin deleteSku 包事务（非 schema，归类此处便于追踪）
- **现状**：`fengyu-admin/src/actions/products.ts:633-654` 两步 `db.delete` 无 transaction
- **建议代码**：
  ```ts
  await db.transaction(async (tx) => {
    await tx.delete(mallProductSkus).where(eq(mallProductSkus.skuId, skuId))
    await tx.delete(productSkus).where(eq(productSkus.skuId, skuId))
  })
  ```
- **配套**：审计 deleteCategory / deleteCoupon 等所有 admin "先删关联+再删主体" 模式
- **关联**：P0-09-03

## 来自域 10（顾客 + 会员等级）

### S10-1 monthly_activity 列：决策保留还是 DROP
- **表**：`client_wechat_users`
- **现状**：`db/schema/user.ts:57` docstring 声明每日 cron 重算，但 cron 6 STEP 无任何写入路径（P0-10-05）
- **方案 A（保留）**：补 `src/cron/steps/refresh-monthly-activity.ts`：
  ```sql
  WITH monthly AS (
    SELECT client_user_id, COUNT(DISTINCT service_date) AS visits
    FROM service_orders
    WHERE status = '已完成'
      AND service_date >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY client_user_id
  )
  UPDATE client_wechat_users u
     SET monthly_activity = CASE
           WHEN m.visits >= 2 THEN '二次客活'::monthly_activity
           WHEN m.visits = 1 THEN '一次客活'::monthly_activity
           ELSE '0次客活'::monthly_activity
         END
    FROM monthly m
   WHERE u.user_id = m.client_user_id;
  -- 未在 service_orders 出现的会员客置 '0次客活'
  ```
- **方案 B（DROP）**：DROP COLUMN + 删 admin filter `customers.ts:195-197` + 测试同步删
- **关联**：P0-10-05

### S10-2 spending_tier vs member_level 口径统一
- **表**：`client_wechat_users`
- **决策**：两 metric 现行口径
  - member_level（cron）：`SUM(paid_amount::numeric)` + `paid_at >= NOW() - INTERVAL '12 months'` + `sale_order_type='销售单'`
  - spending_tier（staff order / payNotify）：`SUM(total_amount)` 累计无窗口 + `status IN ('已支付','已完成')`
- **方案**：spending_tier 改为按 paid_amount 12 月滚动；同时迁出至 cron（不再放在 order.create 事务内）；新建 `src/cron/steps/refresh-spending-tier.ts`
- **回填**：一次性脚本重算所有 spending_tier
- **关联**：P0-10-06

### S10-3 客户分类 SQL 单一权威源
- **表**：—（应用层）
- **现状**：staffApi/routes/order.js:73-156 与 payNotify/index.js:358-463 的 customer_type 跃迁 SQL 完全重复（90 行）
- **方案**：抽 `db/scripts/recalc-customer-classification.sql` 作为权威源 + 在 cron 加 STEP `refresh-customer-type` 每日批量重算（取代 inline trigger）
- **关联**：P1-10-08

### S10-4 inviter_user_id 校验机制
- **表**：`client_wechat_users` `inviter_user_id` 列
- **现状**：仅 `chk_inviter_not_self` CHECK 约束 + 应用层前缀校验，可被前端枚举其他真实 userId 越权写入（P1-10-09）
- **方案 A**：引入 `inviter_token`（短期签名）替换 inviter_user_id 接收前端值
- **方案 B**：DB 触发器校验 inviter 自身 `bound_store_id IS NOT NULL`
- **关联**：P1-10-09

## 来自域 11（退款 / 退换货）

### S11-1 orderStatusEnum 增加 '已驳回'（独立审批语义）
- **范围**：`db/schema/enums.ts:5-14`
- **现状**：rejectRefund 写入 `'已关闭'` 复用，与 close 超时关闭/cancel 取消混淆。`orderStatusEnum` 现有 8 值，无 '已驳回'。
- **建议 DDL**：
  ```sql
  ALTER TYPE order_status ADD VALUE '已驳回';
  -- 数据回填：
  UPDATE sale_orders SET status = '已驳回'
    WHERE sale_order_type = '退款单'
      AND status = '已关闭'
      AND rejected_reason IS NOT NULL;
  ```
- **配套**：admin / staff `rejectRefund` 改写、admin refunds 列表筛选枚举、UI 文案
- **关联**：[P0-11-07]

### S11-2 sale_orders 退款单 in-flight 唯一性 partial unique ✅ 已完成（2026-04-27 域重构收官）
- **表**：~~`sale_orders`~~ → `sale_order_payments`
- **现状**：~~staffApi/routes/order.js:1352 + admin/refunds.ts:503 均事务外读，无 DB 兜底~~ → **已解决**：退款改为 `sale_order_payments[change_type='退款']` 行，`uq_sop_status_audit` partial unique index 已覆盖。sale_order_type_enum 不再包含'退款单'。
- **建议 DDL**：~~原建议的 `uq_sale_orders_refund_inflight`~~ → **不再需要**，由 `uq_sop_status_audit` 替代
- **关联**：[P0-11-02] → **已关闭**（与 S03-2 同源合并关闭）

### S11-3 sale_orders 加 original_prepaid_ratio 快照（多次退款不漂移）
- **表**：`sale_orders`
- **现状**：approveRefund 用 `prepaid_card_amount / total_amount` 作为 split 分母，但 prepaid_card_amount 在第 1 次退款 approve 后被重算（重算来源是 SUM payments，含负数退款行）
- **建议 DDL**：
  ```sql
  ALTER TABLE sale_orders ADD COLUMN original_prepaid_ratio numeric(8,6);
  -- 创建销售单时填充：
  --   ratio = prepaid_card_amount / NULLIF(total_amount, 0)
  -- approveRefund 用 original_prepaid_ratio 而非动态 prepaid_card_amount/total_amount
  ```
- **关联**：[P0-11-06]

### S11-4 sale_orders 退款单金额符号 CHECK — ⚠️ 架构性作废（2026-04-27）
- **表**：`sale_orders`
- **现状**：~~staff/admin approveRefund 都把 FY-TKD 的 prepaid_card_amount / paid_amount 写负数；schema 未约束。`payable_amount=0` 与 `total - prepaid` 不变量也破坏。~~ → **已解决**：退款不再写 `sale_orders[type='退款单']` 行（sale_order_type_enum 已收窄为 3 值），退款全部下沉到 `sale_order_payments`（`chk_sop_amount_sign` 已守护符号）。`paid_amount` 列已 DROP。
- **建议 DDL**：~~原建议的联动符号 CHECK~~ → **不再适用**（与 S03-4 同理）。
- **关联**：[P1-11-10, P1-11-11] → **架构性作废**（与 S03-4 合并）

### S11-5 sale_order_payments.note 退款 metadata 结构化
- **表**：`sale_order_payments`
- **现状**：approveRefund / rejectRefund 用 `note LIKE 'FY-TKD=...%'` 字符串匹配翻状态，脆弱（同源 S03-3）
- **建议 DDL**：（与 S03-3 合并）追加 metadata jsonb，replaced note LIKE
- **关联**：[与 S03-3 合并]

### S11-6 sale_allocations 退款冲销补丁 ✅ 已完成（2026-04-26/27）
- **范围**：业务代码（接 schema 不变）
- **关联**：[P0-11-01] → **已关闭**（与 S07-5 / S08-7 同诉求合并关闭）

## 来自域 12（门店绑定 / 解绑）

### S12-1 store_unbind_requests 加 partial UNIQUE 防同顾客并发多 pending
- **表**：`store_unbind_requests`
- **现状**：`db/schema/store-unbind.ts:6-21` 仅 PK `request_id`，无任何复合 unique；client `requestUnbind` 用 SELECT-then-INSERT（`routes/store.js:146-159`）防重复，无锁、无事务、无 partial unique 兜底；并发提交 / 弱网重试可写多行 pending。
- **建议 DDL**：
  ```sql
  -- 先清理生产现有重复 pending（如有）
  -- 再创建索引
  CREATE UNIQUE INDEX uq_store_unbind_pending
    ON store_unbind_requests (user_id)
    WHERE status = '待处理';
  ```
- **应用层配套**：requestUnbind INSERT 加 `ON CONFLICT (user_id) WHERE status='待处理' DO NOTHING`，rowCount=0 时返回 idempotent success 或抛 INVALID_PARAMS（参考 audit-06 P2-06-15 同诉求）
- **关联**：[P0-12-05](./audit-12-store-binding.md#p0-12-05)

### S12-2 store_unbind_requests note / reject_reason 加长度上限
- **表**：`store_unbind_requests`
- **现状**：`note text` / `reject_reason text` 无长度上限；client / staff 应用层均无 substring；顾客可恶意写超长字符串（DoS 表存储）或 PII / 辱骂内容（admin 列表展示无脱敏）
- **建议 DDL**：
  ```sql
  ALTER TABLE store_unbind_requests
    ALTER COLUMN note TYPE varchar(500),
    ALTER COLUMN reject_reason TYPE varchar(500);
  ```
- **应用层配套**：staff/admin 后端补 trim + length(<=500) 校验
- **关联**：[P1-12-11](./audit-12-store-binding.md#p1-12-11)

### S12-3 client_wechat_users bindStore 守卫表达式（非 schema，记录约束契约）
- **表**：`client_wechat_users`（不改 schema，仅记契约）
- **现状**：`bound_store_id` 列无任何"换店守卫"约束；`auth.bindStore` `routes/auth.js:239 UPDATE bound_store_id=$1` 可在已绑定状态下任意覆盖，绕过 store_unbind_requests 审批流（real.md #4 状态单向违背）
- **建议（应用层 + 可选 DDL）**：
  - 应用层（必须）：bindStore 加 `if (users[0].bound_store_id && users[0].bound_store_id !== storeId) throw 'PERMISSION_DENIED: 已绑定门店，请先发起解绑申请'`
  - DDL（可选，纵深防御）：触发器禁止 UPDATE 时 bound_store_id 从 NOT NULL 直接改为另一 NOT NULL 值（除 admin SoT）
- **关联**：[P0-12-02](./audit-12-store-binding.md#p0-12-02)

### S12-4 store_unbind_requests requestId 改业务前缀格式（与项目惯例一致）
- **表**：`store_unbind_requests`
- **现状**：client `routes/store.js:154` 用 `crypto.randomUUID()` 生成裸 UUID；项目其他单据（订单 FY-XSD / 退款 FY-TKD / 服务单等）均用业务前缀 + 序号
- **建议**：改为 `FY-UNB-WX-{YYMMDD}{4位序号}`，参考 staff `routes/order.js:2452 generateOrderNo` advisory_xact_lock 模式
- **关联**：[P2-12-17](./audit-12-store-binding.md#p2-12-17)

## 来自域 13（优惠券）

### S13-1 决策 `applicable_product_ids` 是否启用：DROP 或三端补 product 过滤
- **表**：`coupon_templates`
- **现状**：`db/schema/coupon.ts:24 applicableProductIds text[]` — admin createTemplate 写入、admin getAvailableCoupons 在 SELECT 列表里读但**没有 WHERE 过滤**；admin createOrder + staff/client order.create 完全不读。运营若配置该字段则下单方完全失效（设计→实现断裂）
- **方案 A（DROP）**：
  ```sql
  -- 量化前置：SELECT count(*) FROM coupon_templates WHERE applicable_product_ids IS NOT NULL
  ALTER TABLE coupon_templates DROP COLUMN applicable_product_ids;
  ```
  + admin types/UI/createTemplate/updateTemplate 移除该字段
- **方案 B（启用）**：三端 order.create + admin getAvailableCoupons + admin createOrder coupon 校验段补 product_id 过滤逻辑（见 audit-13 §6 修复表）
- **关联**：[P0-13-03](./audit-13-coupons.md#p0-13-03)

### S13-2 user_coupons.face_value_override 三端读取契约（非 schema，记契约）
- **表**：`user_coupons`（不改 schema，仅记契约）
- **现状**：`face_value_override numeric(10,2)` 列存在用于"分享礼/动态面值"运行时覆盖；client coupon.list/available + order.create 用 `COALESCE(face_value_override, ct.discount_value)` ✅；staff coupon.available 已用 ✅，但 staff `routes/order.js:331` 漏掉；admin 全链路（coupons.ts:157 / orders.ts:755）均直接读 `couponTemplates.discountValue`
- **建议**：约定凡 SELECT discount_value 的 SQL 必须 COALESCE；抽 `helpers/coupon-discount-value.js` 共享函数；schema 加 SQL 注释 `-- ALWAYS read via COALESCE(face_value_override, ct.discount_value)`
- **关联**：[P0-13-05](./audit-13-coupons.md#p0-13-05)

### S13-3 coupon_templates 总量 totalCount 强制约束（防超发）
- **表**：`coupon_templates` + `user_coupons`
- **现状**：admin issueCoupon `:527-535` + batchIssueCoupons `:652-665` 用 SELECT count + 立即 INSERT，无锁；cron 三类自动发放完全不验 totalCount
- **建议（应用层 + DDL 双轨）**：
  - 应用层：发放前 `SELECT pg_advisory_xact_lock(hashtext('coupon-issue-' || templateId))` + `SELECT count(*) FROM user_coupons WHERE template_id=$1` 在事务内
  - DDL（纵深防御）：触发器或约束（PG 原生不支持复杂 CHECK 跨表，需 trigger function）
- **关联**：[P0-13-06](./audit-13-coupons.md#p0-13-06) + [P0-13-07](./audit-13-coupons.md#p0-13-07)

### S13-4 user_coupons coupon_id 命名规范（中央生成器）
- **表**：`user_coupons`（不改 schema，仅记契约）
- **现状**：5 种生成模式
  - admin issueCoupon: `cpn-${Date.now()}-${random36(4)}`
  - admin batchIssueCoupons: `cpn-${now}-${random36(4)}-${i}`
  - cron 升级: `cpn-up-${userId}-${level}-${tplId}`
  - cron 生日: `bday-${YYYY}-${userId}-${tplId}`
  - cron 感恩节: `thx-${YYYY}-${MM}-${userId}-${tplId}`
- **依赖**：`fengyu-admin/src/actions/refunds.ts:378` 用 `LIKE 'cpn-up-...-%'` 查升级权益用券；任一前缀变更破坏统计
- **建议**：抽 `lib/coupon-id.ts` 中央生成器 + 单元测试 + 全文档化命名表
- **关联**：[P2-13-21](./audit-13-coupons.md#p2-13-21)

### S13-5 toggleTemplateActive 影响传播（schema 注释 + 应用层选择）
- **表**：`coupon_templates` / `user_coupons`（不改 schema）
- **现状**：admin toggleTemplateActive `is_active=false` 后，已发未用 user_coupons 仍存在；client coupon.list `:35-53` 不过滤 is_active，顾客看到券但下单被拒
- **建议（A/B 二选一）**：
  - A：client coupon.list SQL 加 `AND ct.is_active = true` 过滤 → UX 一致
  - B：admin toggle 时同步 `UPDATE user_coupons SET status='已过期' WHERE template_id=$1 AND status='未使用'` → 顾客侧自动消失
- **关联**：[P1-13-15](./audit-13-coupons.md#p1-13-15)

---

## S14 充值卡 + 卡流水（audit-14）

### S14-01 card_transactions 加 (ref_order_id, type) 部分唯一索引
- **优先级**：P0
- **来源**：[P0-14-02](./audit-14-prepaid-card.md#p0-14-02)
- **表**：`card_transactions`
- **现状**：所有 11+ 处 INSERT 路径用"先 SELECT 1 WHERE ref_order_id=$1 AND type=$2 + INSERT"幂等去重；无 DB 兜底
- **建议**：
  ```sql
  CREATE UNIQUE INDEX uq_card_tx_ref_type
    ON card_transactions(ref_order_id, type)
    WHERE ref_order_id IS NOT NULL;
  ```
- **drizzle 写法**：`uniqueIndex('uq_card_tx_ref_type').on(table.refOrderId, table.type).where(sql\`ref_order_id IS NOT NULL\`)`
- **风险**：上线前先跑 `SELECT ref_order_id, type, COUNT(*) FROM card_transactions WHERE ref_order_id IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1` 清理重复数据

### S14-02 card_transactions.amount 加符号 CHECK
- **优先级**：P0
- **来源**：[P0-14-05](./audit-14-prepaid-card.md#p0-14-05)
- **表**：`card_transactions`
- **建议**：
  ```sql
  ALTER TABLE card_transactions
    ADD CONSTRAINT chk_card_tx_amount_sign
    CHECK ((type = '充值' AND amount > 0) OR (type = '扣款' AND amount < 0));
  ```
- **风险**：上线前清理违反约束的脏行

### S14-03 card_transactions 加 created_at 索引（admin 流水分页性能）
- **优先级**：P2
- **来源**：[P2-14-16](./audit-14-prepaid-card.md#p2-14-16)
- **表**：`card_transactions`
- **建议**：
  ```sql
  CREATE INDEX idx_card_tx_created ON card_transactions(created_at DESC);
  ```

### S14-04 admin SQL 同步 prepaid_cards schema（drift 修复，非 schema 改动）
- **优先级**：P0
- **来源**：[P0-14-01](./audit-14-prepaid-card.md#p0-14-01)
- **表**：`prepaid_cards`（schema 不改）
- **现状**：admin `applyRechargeOnOrderPaid` / `createConversionOrder` 仍引用 migration 0003 删除的 `store_id` 列
- **建议**（非 schema 改，列在此提醒同步）：
  ```diff
  - INSERT INTO prepaid_cards (card_id, user_id, store_id, balance) VALUES (...)
  - ON CONFLICT (user_id, store_id) DO UPDATE
  + INSERT INTO prepaid_cards (card_id, user_id, balance) VALUES (...)
  + ON CONFLICT (user_id) DO UPDATE
  ```

## 来自域 15（积分 + 等级跳档）

### S15-01 point_transactions 加 (user_id, ref_order_id, type) partial UNIQUE
- **优先级**：P1
- **来源**：[P1-15-07](./audit-15-points-member-level.md#p1-15-07)
- **表**：`point_transactions`
- **建议**：
  ```sql
  CREATE UNIQUE INDEX uq_pt_consumption ON point_transactions(user_id, ref_order_id, type)
    WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销');
  ```
- **drizzle 写法**：`uniqueIndex('uq_pt_consumption').on(table.userId, table.refOrderId, table.type).where(sql\`ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')\`)`
- **风险**：上线前 `SELECT user_id, ref_order_id, type, COUNT(*) FROM point_transactions WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销') GROUP BY 1,2,3 HAVING COUNT(*)>1` 清重

### S15-02 point_transactions.amount 加符号 + 类型 CHECK
- **优先级**：P2
- **来源**：[P2-15-18](./audit-15-points-member-level.md#p2-15-18)
- **表**：`point_transactions`
- **建议**：
  ```sql
  ALTER TABLE point_transactions
    ADD CONSTRAINT chk_pt_amount_sign
    CHECK (
      (type IN ('消费赠送','等级升级奖励','生日积分','感恩回馈','手动调整') AND amount > 0)
      OR (type = '消费冲销' AND amount < 0)
    );
  ```
- **风险**：脏数据清理 + 必须先做 S15-04（type 转 enum）；与 audit-14 S14-02 同模式

### S15-03 point_transactions.amount 改 bigint（同步 client_wechat_users.points_balance）
- **优先级**：P2
- **来源**：[P2-15-18](./audit-15-points-member-level.md#p2-15-18)
- **表**：`point_transactions` + `client_wechat_users`
- **建议**：从 integer (int4, ±21 亿) 切 bigint (int8)；防御长尾累积 / 错误回放
- **风险**：业务无感；drizzle schema 同步 + 三端 utils/points.js 不需改（已用 `Number(rows[0]?.spend ?? 0)`）

### S15-04 point_transactions.type 升级为 PG enum
- **优先级**：P0
- **来源**：[P0-15-02](./audit-15-points-member-level.md#p0-15-02)
- **表**：`point_transactions`
- **建议**：
  ```sql
  CREATE TYPE point_transaction_type AS ENUM
    ('消费赠送','消费冲销','等级升级奖励','生日积分','感恩回馈','手动调整');
  ALTER TABLE point_transactions
    ALTER COLUMN type TYPE point_transaction_type USING type::point_transaction_type;
  ```
- **风险**：先清理 type 列任何脏值；admin `actions/points.ts:14-18` 自由文本注释也需更新；ENUM 加固让三端副本漂移立即失败（与 P0-15-02 同根因）

### S15-05 sale_orders.paid_amount NOT NULL
- **优先级**：P0
- **来源**：[P0-15-06](./audit-15-points-member-level.md#p0-15-06)
- **表**：`sale_orders`
- **现状**：列声明 `numeric default 0` 但未 NOT NULL；任何路径意外写 null → cron 跳档 SUM 会静默忽略
- **建议**：`ALTER TABLE sale_orders ALTER COLUMN paid_amount SET NOT NULL;` 或加 `CHECK (paid_amount IS NOT NULL)`
- **风险**：先确认现存 null 数据是否需要回填为 0

## 来自域 16（消息中心）

### S16-1 messages 表 idempotency_key partial unique 维度收紧
- **优先级**：P1
- **来源**：[P1-16-10](./audit-16-message-center.md#p1-16-10)
- **表**：`messages`
- **现状**：`db/schema/message.ts:33-35`
  ```ts
  uniqueIndex('uq_messages_idempotency_key')
    .on(table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`)
  ```
  全表全局唯一。当前 5 类幂等键（cron 三步 + share-gift × 2）均在 key 内已隐含 userId，未撞；但限制了"全员系统公告"用同一幂等键（第 2+ 收件人会被吞）。
- **建议 DDL**：
  ```sql
  DROP INDEX uq_messages_idempotency_key;
  CREATE UNIQUE INDEX uq_messages_idempotency_key
    ON messages (idempotency_key, recipient_type, recipient_id)
    WHERE idempotency_key IS NOT NULL;
  ```
- **风险**：现有 5 类幂等键全部兼容；为 admin batchSend 新方案 (`batch-${batchId}-${userId}`) 奠定基础

### S16-2 messages.deleted_at 软删字段
- **优先级**：P1
- **来源**：[P1-16-08](./audit-16-message-center.md#p1-16-08)
- **表**：`messages`
- **现状**：admin `deleteMessage` 物理硬删；与 audit-15 point_transactions 软删/硬删双轨同模式
- **建议 DDL**：
  ```sql
  ALTER TABLE messages ADD COLUMN deleted_at timestamp;
  CREATE INDEX idx_messages_recipient_alive
    ON messages (recipient_type, recipient_id, is_read)
    WHERE deleted_at IS NULL;
  -- 同时把现有 idx_messages_recipient 替换为 partial（无 deleted_at 列前提下）
  ```
- **配套**：`actions/messages.ts:173 deleteMessage` 改 `UPDATE messages SET deleted_at=NOW()`；client list/read/unreadCount 全部加 `AND deleted_at IS NULL`

### S16-3 messageTypeEnum 收敛
- **优先级**：P2（待业务收敛）
- **来源**：[P1-16-05](./audit-16-message-center.md#p1-16-05)
- **现状**：message_type varchar(50) 自由文本；client 仅识别 `appointment / order / system` 三值，cron+share-gift 实写 `'system'`
- **建议**：先 SELECT DISTINCT 实际取值（已在 audit-16 §7 ④ SQL 提供），与产品对齐后定义 enum：
  ```sql
  CREATE TYPE message_type AS ENUM
    ('appointment','order','service','system','promotion','refund','coupon','points');
  -- 数据回填
  UPDATE messages SET message_type = 'system' WHERE message_type IS NULL OR message_type = '';
  -- ALTER COLUMN
  ALTER TABLE messages ALTER COLUMN message_type TYPE message_type USING message_type::message_type;
  ```
- **风险**：admin batchSend UI 改 select；与 client TYPE_COLOR_MAP 同步扩展配色

### S16-4 messageRecipientTypeEnum 决策（保留 vs 删除"员工"）
- **优先级**：P0（决策）/ P1（执行）
- **来源**：[P0-16-04](./audit-16-message-center.md#p0-16-04)
- **现状**：`db/schema/enums.ts:87` `messageRecipientTypeEnum = ['客户','员工']`，但 staffApi 0 路由 0 写入；spec 标"未实现"
- **方案 A（保留员工，补 staff route）**：
  - 新建 `fengyu-staff/cloudfunctions/staffApi/routes/message.js`（list/read/unreadCount）
  - 新建 admin batchSendMessages 类似的"对员工批量发"动作
  - 不需要 schema 改动
- **方案 B（删员工）**：
  ```sql
  -- 必须先确认 messages 表无 recipient_type='员工' 行（audit-16 §7 ① SQL 已验证）
  ALTER TYPE message_recipient_type RENAME TO message_recipient_type_old;
  CREATE TYPE message_recipient_type AS ENUM ('客户');
  ALTER TABLE messages
    ALTER COLUMN recipient_type TYPE message_recipient_type
    USING recipient_type::text::message_recipient_type;
  DROP TYPE message_recipient_type_old;
  ```
- **风险**：方案 B 不可逆；建议先做方案 A 6 个月观察

## 来自域 16（消息中心，admin batch 端）

### S16-5 admin batchSendMessages 必带 idempotency_key
- **优先级**：P0（资损）
- **来源**：[P0-16-02](./audit-16-message-center.md#p0-16-02)
- **现状**：`actions/messages.ts:460-475` 循环构造 values 不写 idempotency_key
- **修复**：app 层（不需要 schema 修改）
  ```ts
  import { randomUUID } from 'node:crypto'
  const batchId = randomUUID()
  const values = recipientIds.map((userId) => ({
    recipientType: '客户' as const,
    recipientId: userId,
    title, body, messageType, isRead: false, createdAt: now,
    idempotencyKey: `batch-${batchId}-${userId}`,
  }))
  // INSERT 用 ON CONFLICT (idempotency_key, recipient_type, recipient_id) DO NOTHING
  ```
- **依赖**：S16-1 复合 unique 索引落地后启用

## 来自域 17（数据看板）

### S17-1 admin dashboard SQL 重构以复用 metrics.md 权威口径
- **优先级**：P0（口径资损）
- **来源**：[P0-17-01](./audit-17-dashboard.md#p0-17-01) + [P0-17-02](./audit-17-dashboard.md#p0-17-02) + [P0-17-03](./audit-17-dashboard.md#p0-17-03)
- **范围**：`fengyu-admin/src/actions/dashboard.ts:55-94`（**非 schema 修改**，但记此处便于跨域追踪）
- **现状**：admin 业务角色看板 today_revenue 用 SUM(total_amount)，缺 `sale_order_type IN ('销售单','转换单')` 过滤；today_visitors 走 sale_orders 而非 service_orders
- **建议**：
  - 把全部 SQL 替换为参考 mgmt-dashboard `queryStoreRevenue` / `queryFootfall` 等纯口径
  - 进一步：抽 `db/helpers/dashboard-metrics.ts`，admin / staff mgmt-dashboard / staff.dashboard 共享同一组聚合 SQL；3 端禁止再写"另一套口径"
- **风险**：修改后历史业绩数字会变小（去掉退款单 + total_amount→paid_amount）；先与 PM 沟通

### S17-2 mgmt-dashboard scopeOptions 缓存按 OPENID 分桶或移除
- **优先级**：P0（隔离）
- **来源**：[P0-17-04](./audit-17-dashboard.md#p0-17-04)
- **范围**：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:31-82` (非 schema)
- **现状**：模块级单例 5 分钟缓存，HQ 视角全量；与 staff auth 缓存（`middleware/auth.js:21-22`）配合时，admin 调店后 0~10 分钟内可能看到组织树漂移
- **建议**：
  ```js
  // 方案 A：完全移除缓存（每次查询轻量级 org_nodes JOIN stores）
  // 方案 B：把 CACHE 改为 Map<OPENID, {data, ts}> + invalidate hook
  // 方案 C：保留缓存但强制 listening on org_nodes / stores UPDATE，触发 invalidate
  ```

### S17-3 staff.dashboard 美容师 newMember 口径加 store_id
- **优先级**：P0（隔离）
- **来源**：[P0-17-06](./audit-17-dashboard.md#p0-17-06)
- **范围**：`fengyu-staff/cloudfunctions/staffApi/routes/staff.js:706-722` (非 schema)
- **建议**：美容师分支加 `c.bound_store_id = effectiveStoreId` 与其他 4 指标对齐

### S17-4 dashboard 性能 — 评估 materialized view（如果 30+ 店上线后 mgmt summary > 800ms）
- **优先级**：P2
- **来源**：[P2-17-15](./audit-17-dashboard.md#p2-17-15)
- **范围**：5434/fengyu
- **建议**：在 `fengyu-admin/src/cron/steps/refresh-dashboard-mv.ts` 新建按"日 / 月"双粒度物化的 sale / service / customer 聚合视图；mgmt-dashboard.summary 的"month" 维度可走 MV，"today" 维度走实时
  ```sql
  CREATE MATERIALIZED VIEW mv_dashboard_daily_store AS
    SELECT store_id, paid_at::date AS d, sale_order_type,
           SUM(paid_amount) AS revenue, COUNT(*) AS orders
      FROM sale_orders
     WHERE status = '已支付'
     GROUP BY 1,2,3;
  CREATE UNIQUE INDEX ON mv_dashboard_daily_store(store_id, d, sale_order_type);
  -- cron STEP 6: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_daily_store
  ```

## audit-18 员工绩效

### S18-1 admin 端缺员工绩效 action / 页面（功能补齐而非 schema 变更）
- **优先级**：P1（功能缺位 + HR/财务对账盲区）
- **来源**：[audit-18 §1 关键发现 0 + §10 后续待办](./audit-18-employee-performance.md)
- **范围**：`fengyu-admin/src/actions/`（新增 `employee-performance.ts`）+ `fengyu-admin/src/app/(main)/employees/[id]/`（新增 performance Tab）
- **建议**：
  ```ts
  // actions/employee-performance.ts
  export async function getEmployeePerformance(employeeId: string, range: { start: string; end: string }) {
    const session = await getSession()
    requirePermission(session, 'employee:list')
    // scope 校验：HR 角色 limited to scopeStoreIds
    const [emp] = await db.select({ storeId: staffWechatUsers.storeId })
      .from(staffWechatUsers).where(eq(staffWechatUsers.employeeId, employeeId))
    if (emp && session.role !== 'admin' && !session.scopeStoreIds.includes(emp.storeId))
      throw new Error('PERMISSION_DENIED')
    // 双轨 SUM(sa) + SUM(sc)，过滤 sale_order_type，使用 PG `paid_at::date BETWEEN`
    ...
  }
  ```
  与 staff.performanceDetail 共享 SQL，但 admin 用 Drizzle 表达式而非原生 SQL。

### S18-2 sale_allocations 增加冗余 store_id 列（性能 + 隔离）
- **优先级**：P2（避免 JOIN sale_orders 走索引）
- **来源**：[audit-18 §6 P0-18-02 修复链](./audit-18-employee-performance.md)
- **范围**：`db/schema/order.ts` saleAllocations + migration
- **建议**：
  ```ts
  storeId: text('store_id').notNull().references(() => stores.storeId),
  // 应用层 INSERT 时同步从 sale_orders 写入；与 sale_items.store_id 已存在的冗余设计一致
  ```
  - 此后所有"按员工 / 门店汇总销售提成"SQL 可直接 `WHERE sa.store_id = $1 AND sa.employee_id = $2`，避免 JOIN sale_items + sale_orders 两表
  - 同时建议给 service_commissions 加 store_id（已在 audit-08 P1-08-13 提）

### S18-3 物化"员工绩效日聚合"（性能优化，30+ 店或员工年度万级订单时）
- **优先级**：P2
- **来源**：[audit-18 §3.2 P1-18-06](./audit-18-employee-performance.md)
- **范围**：5434/fengyu
- **建议**：
  ```sql
  CREATE MATERIALIZED VIEW mv_employee_daily_commission AS
    SELECT
      sa.employee_id,
      o.store_id,
      o.paid_at::date AS d,
      o.sale_order_type,
      SUM(sa.total_amount::numeric) AS sales_alloc,
      0::numeric AS service_commission
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
   WHERE sa.is_void = false AND o.status = '已支付'
   GROUP BY 1,2,3,4
  UNION ALL
    SELECT
      sc.employee_id,
      so.store_id,
      so.service_date AS d,
      '服务' AS sale_order_type,
      0::numeric AS sales_alloc,
      SUM(sc.commission_amount::numeric) AS service_commission
    FROM service_commissions sc
    JOIN service_items sit ON sit.service_item_id = sc.service_item_id
    JOIN service_orders so ON so.service_order_id = sit.service_order_id
   WHERE sc.is_void = false AND so.status = '已完成'
   GROUP BY 1,2,3;
  CREATE UNIQUE INDEX ON mv_employee_daily_commission(employee_id, store_id, d, sale_order_type);
  -- cron STEP 6 同 S17-4：REFRESH MATERIALIZED VIEW CONCURRENTLY
  ```
  - performanceDetail / monthlyCalendar / todayCommission 全部走 MV，实时性 1 天足够（绩效不要求秒级更新），分页 LIMIT/OFFSET 直接落库

## 来自域 20（家居产品提货）

### S20-1 pickup_records 加 sale_order_id 冗余列（审计完整性 + 性能）
- **表**：`pickup_records`
- **现状**：仅有 `sale_item_id` 外键，列表 / 详情通过 `LEFT JOIN sale_items` 取 `sale_order_id`（admin/actions/pickup-records.ts:114, 174）
- **DDL**：
  ```sql
  ALTER TABLE pickup_records
    ADD COLUMN sale_order_id varchar(30);
  -- 回填
  UPDATE pickup_records pr
     SET sale_order_id = si.sale_order_id
    FROM sale_items si
   WHERE si.sale_item_id = pr.sale_item_id;
  ALTER TABLE pickup_records
    ALTER COLUMN sale_order_id SET NOT NULL,
    ADD CONSTRAINT pickup_records_sale_order_id_fk
      FOREIGN KEY (sale_order_id) REFERENCES sale_orders(sale_order_id);
  CREATE INDEX idx_pickup_records_sale_order ON pickup_records(sale_order_id);
  ```
- **影响**：列表查询不再 JOIN sale_items 取 saleOrderId；审计可通过 sale_order_id 直接关联到原销售单（即使 sale_items 行被软删）
- **关联**：[P1-20-07](./audit-20-pickup.md#p1-20-07)

### S20-2 pickup_records 增加幂等键（防重提交）
- **表**：`pickup_records`
- **现状**：仅 `bigserial` 主键，无任何防重约束。admin / staff 在网络抖动 / 并发 click 场景可写入两条 records 行（picked_up_quantity 仅加一次但 records 多 1 行）。
- **DDL**（方案 A：应用层传 idempotency key）：
  ```sql
  ALTER TABLE pickup_records
    ADD COLUMN idempotency_key text;
  CREATE UNIQUE INDEX uq_pickup_records_idempotent
    ON pickup_records(sale_item_id, idempotency_key)
   WHERE idempotency_key IS NOT NULL;
  ```
- **DDL**（方案 B：基于业务字段去重，不需应用层改造）：
  ```sql
  CREATE UNIQUE INDEX uq_pickup_records_per_action
    ON pickup_records(sale_item_id, confirmed_by, created_at);
  -- 注意：created_at NOW() 精度毫秒，理论可冲突；建议用方案 A
  ```
- **影响**：admin createPickupRecord / staff createPickup 调用方需传 client UUID
- **关联**：[P0-20-03](./audit-20-pickup.md#p0-20-03)

### S20-3 sale_items 增加 picked_up_quantity NOT NULL DEFAULT 0
- **表**：`sale_items`
- **现状**：`picked_up_quantity integer DEFAULT 0`（`db/schema/order.ts:164` 无 NOT NULL）；多处 SQL 用 `COALESCE(picked_up_quantity, 0)` 兜底，逻辑负担可移至 schema
- **DDL**：
  ```sql
  UPDATE sale_items SET picked_up_quantity = 0 WHERE picked_up_quantity IS NULL;
  ALTER TABLE sale_items
    ALTER COLUMN picked_up_quantity SET NOT NULL,
    ADD CONSTRAINT chk_picked_up_in_range
      CHECK (picked_up_quantity >= 0 AND picked_up_quantity <= quantity);
  ```
- **影响**：移除 5 处 COALESCE 副本（仍可保留 defensive）；CHECK 在退款 / 转换 / 提货 三链路任一漏处理时直接 DB 拒绝
- **关联**：[P0-20-01](./audit-20-pickup.md#p0-20-01) / [P0-20-02](./audit-20-pickup.md#p0-20-02) / [P1-20-04](./audit-20-pickup.md#p1-20-04)

### S20-4 pickup_records 头部注释增"流水表无 updated_at"
- **表**：`pickup_records`
- **DDL**：
  ```ts
  /**
   * 提货记录（流水表，仅 created_at；无 updated_at）
   *
   * ⚠ 不要为本表添加 updated_at 触发器或 $onUpdate；
   * 已写入的提货记录不可变，撤销提货应通过另写一条"反向 pickup_quantity 为负"的行实现
   *（待 spec 决策；当前 chk_pickup_quantity > 0 不允许负值）。
   */
  ```
- **关联**：[P2-20-03](./audit-20-pickup.md#p2-20-03)

## 来自域 21（组织架构）

### S21-1 stores.org_node_id 必填 + 与 org_nodes 1:1
- 表：stores、org_nodes
- DDL：
  ```sql
  ALTER TABLE stores ALTER COLUMN org_node_id SET NOT NULL;
  CREATE UNIQUE INDEX uq_stores_org_node_id ON stores(org_node_id);
  ```
- 关联：[P1-21-04 / P1-21-05](./audit-21-org-structure.md)

### S21-2 org_nodes 邻接表防环
- 表：org_nodes
- DDL：trigger 在 INSERT/UPDATE 时递归检查；或改 closure-table / ltree path 列
- 关联：[P0-21-02 / P1-21-02](./audit-21-org-structure.md)

---

## 来自域 22（权限矩阵 + 角色）

### S22-1 新增 roleEnum PG enum
- 表：permission_roles
- DDL：
  ```sql
  CREATE TYPE role_enum AS ENUM('admin','manager','finance','hr','product','customer_mgr','staff');
  ALTER TABLE permission_roles ALTER COLUMN role TYPE role_enum USING role::role_enum;
  ```
- 关联：[P1-22-06](./audit-22-permission-matrix.md)

### S22-2 permission_roles.scope_id 不指向 type='部门'
- 表：permission_roles + org_nodes
- DDL：DB CHECK 或应用层 + trigger
- 关联：[P0-22-01](./audit-22-permission-matrix.md)

### S22-3 PERMISSION_MATRIX DB 化（system_configs）
- 表：system_configs
- DDL：增 key='permission_matrix' jsonb；admin/staff/cron 共读
- 关联：[audit-01 P1-PERM-07](./audit-01-auth.md) + [P1-22-07](./audit-22-permission-matrix.md)

### S22-4 permission_roles.scope_id 类型升级或加 CHECK
- 关联：[P2-22-09](./audit-22-permission-matrix.md)（优先级低）

---

## 来自域 23（操作日志）

### S23-1 operation_logs 加 idempotency_key
- 表：operation_logs
- DDL：
  ```sql
  ALTER TABLE operation_logs ADD COLUMN idempotency_key text;
  CREATE UNIQUE INDEX uq_op_idempotency ON operation_logs(idempotency_key) WHERE idempotency_key IS NOT NULL;
  ```
- 关联：与 messages 表 idempotency 模式一致

### S23-2 复合索引覆盖高频查询
- 表：operation_logs
- DDL：
  ```sql
  CREATE INDEX idx_oplog_operator_time ON operation_logs(operator_employee_id, created_at DESC);
  CREATE INDEX idx_oplog_target_time ON operation_logs(target_type, target_id, created_at DESC);
  ```

### S23-3（待业务确认）加 operator_user_id 列 + CHECK
- 表：operation_logs
- DDL：
  ```sql
  ALTER TABLE operation_logs ADD COLUMN operator_user_id text;
  ALTER TABLE operation_logs ADD CONSTRAINT chk_oplog_operator
    CHECK (operator_employee_id IS NOT NULL OR operator_user_id IS NOT NULL OR source IN ('cronTask','payNotify'));
  ```

### S23-4（长期）加 occurred_at
- 表：operation_logs
- DDL：ADD COLUMN occurred_at timestamp（区分业务时间与日志记录时间）

### S23-5 文档化 detail v2 schema
- 路径：.42cog/dev/sys.spec.md
- 内容：`{ _v:2, _t:'update'|'transition', changes?:{}, from?, to?, context?:{} }`

---

## 来自域 24（品项分类动态字段）

### S-EXP-1 product_skus 加 is_experience capability 列 ✅ 已落地（2026-04-26 migration 0017）
- 表：product_skus
- DDL：
  ```sql
  ALTER TABLE product_skus ADD COLUMN is_experience boolean NOT NULL DEFAULT false;
  CREATE INDEX idx_product_skus_is_experience
    ON product_skus(is_experience) WHERE is_experience = true;
  -- 数据回填（一次性）
  UPDATE product_skus ps SET is_experience = true
  WHERE EXISTS (SELECT 1 FROM product_categories pc
                WHERE pc.category_id = ps.category_id
                  AND pc.product_kind = '体验卡');
  ```
- **粒度选择**：放 `product_skus` 而非 `product_categories`（ticket §1.1）。同一 product 下可有"体验装 SKU + 正装 SKU"双规格，体验属性是 SKU 级而非 product 级
- **配套代码**：admin trial-card-picker / orders / products / cards / lib/product-kind / db/seed（10 文件）；staff routes/product.js shopInit + routes/order.js + utils/refund.js + 测试（5 文件）；client clientApi routes/product.js + 新增 `experienceCardList` action + index.js 路由表（4 文件）
- 关联：ticket [2026-04-26-experience-card-as-sku-flag](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md)；audit-10 P0-10-06、audit-15 P0-15-04/05、audit-24 magic string '体验卡'

### S-EXP-2 sale_items 加 is_experience 行级快照 ✅ 已落地（2026-04-26 migration 0017）
- 表：sale_items
- DDL：
  ```sql
  ALTER TABLE sale_items ADD COLUMN is_experience boolean NOT NULL DEFAULT false;
  -- 历史回填（一次性）
  UPDATE sale_items si SET is_experience = true
  WHERE EXISTS (SELECT 1 FROM product_skus ps
                WHERE ps.sku_id = si.sku_id AND ps.is_experience = true);
  ```
- **理由**：与 unit_price/unit_real_price/service_fee/is_shengmei 同模式（real.md #2 价格快照不可变）。admin 后续修改 product_skus.is_experience 不影响历史订单
- **跃迁 SQL**：`SUM(received) FILTER (WHERE NOT is_experience)` = 非体验金额；`SUM(received) FILTER (WHERE is_experience)` = 体验金额；混合订单按非体验部分判（[ticket §1.4](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md)）
- 关联：D-Q5-2026-04-26 / Q5.1 / Q5.2 已答（[SUMMARY §5.2](./SUMMARY.md)）

### S24-1 product_categories 加 is_recharge_card capability 列
- 表：product_categories
- DDL：
  ```sql
  ALTER TABLE product_categories ADD COLUMN is_recharge_card boolean NOT NULL DEFAULT false;
  UPDATE product_categories SET is_recharge_card = true WHERE category_name = '充值卡' AND product_kind IS NULL;
  ```
- 配套：staff `routes/order.js` 7 处 + admin 7 处把 `category_name <> '充值卡'` 替换为 `is_recharge_card = false`，让"充值卡 vs 其他卡类"语义升格为 DB 驱动 capability
- **平行设计**：与 [S-EXP-1](#s-exp-1-product_skus-加-is_experience-capability-列--已落地2026-04-26-migration-0017) 共用"capability 列替代字面量"模式，建议同 epic（E9）实施。粒度差异：is_experience 在 SKU 级；is_recharge_card 在分类级（充值卡是整个一级 kind 的属性）
- 关联：[P0-24-01](./audit-24-product-category-dynamic.md)

### S24-2 getCategories LEFT JOIN parent 加 is_valid 守卫
- admin `actions/products.ts:93-98`
- 关联：[P0-24-02](./audit-24-product-category-dynamic.md)

### S24-3 updateProductKind 停用级联 + 依赖检查
- 关联：[P0-24-02](./audit-24-product-category-dynamic.md)

### S24-4 display_color 加 CHECK regex
- DDL：`CHECK (display_color IS NULL OR display_color ~ '^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$')`

### S24-5 一级行约束（productKind IS NULL）
- DDL：`CHECK ((product_kind IS NULL AND sales_category IS NULL) OR product_kind IS NOT NULL)`

### S24-6 文档化"product_categories 永不硬删除"
- schema 注释固化设计决策

---

## 来自域 25（流量 / 推广员）

### S25-1 sale_allocations 增 is_from_promoter 或 salesCategory 加"推广引流"
- 表：sale_allocations / enums.ts
- 关联：[P0-25-05](./audit-25-traffic-promoter.md)

### S25-2 client_wechat_users 增 promoter_employee_name 冗余
- 表：client_wechat_users
- DDL：`ADD COLUMN promoter_employee_name varchar(50)`
- 关联：[P1-25-12](./audit-25-traffic-promoter.md)

### S25-3 customer_source 改软枚举（迁移到 system_configs）
- 表：system_configs + client_wechat_users.customer_source 改 varchar(50)
- 关联：[P1-25-08](./audit-25-traffic-promoter.md)

### S25-4 operation_logs partial unique 防 promoter 变更幂等
- DDL：`CREATE UNIQUE INDEX uq_oplog_change_promoter ON operation_logs(target_id, idempotency_key) WHERE action = 'customer.changePromoter'`
- 关联：[P1-25-06](./audit-25-traffic-promoter.md)

### S25-5 commission_rate_matrix 增"推广引流"默认 rate 行
- 关联：[P0-25-05](./audit-25-traffic-promoter.md)

---

## 来自横切 CC1（数值精度与金额）

### S-CC1-1 批量金额 / 比例 CHECK 升级（部分完成 2026-04-27）
- 表：order.ts (sale_orders / sale_items / sale_allocations)
- DDL：
  ```sql
  -- ✅ 已架构性作废（2026-04-27）：sale_order_type 不再包含'退款单'/'回款单'，
  -- 退款符号约束由 sale_order_payments.chk_sop_amount_sign 守护
  -- ALTER TABLE sale_orders ADD CONSTRAINT chk_sale_orders_amount_sign ... → 不再需要
  -- 以下两项仍待：
  ALTER TABLE sale_allocations ADD CONSTRAINT chk_sale_alloc_ratio_iv
    CHECK (allocation_ratio IN (0.10,0.11,0.12,0.13,0.15,0.18,0.20,0.30,0.50,1.00));
  ALTER TABLE sale_items ADD CONSTRAINT chk_sale_item_sale_amount
    CHECK (ABS(sale_amount - unit_price * quantity) <= 0.02);
  ```
- 关联：[P0-CC1-01 / ~~P0-CC1-03~~（架构性作废）](./audit-CC1-numeric-precision.md)

### S-CC1-2 流水符号 CHECK 推广 chk_sop_amount_sign
- 表：prepaid-card.ts (card_transactions) + points.ts (point_transactions)
- DDL：
  ```sql
  ALTER TABLE card_transactions ADD CONSTRAINT chk_card_tx_amount_sign
    CHECK ((type='充值' AND amount > 0) OR (type='扣款' AND amount < 0));
  ALTER TABLE point_transactions ADD CONSTRAINT chk_pt_amount_sign
    CHECK ((type IN ('消费冲销') AND amount < 0) OR amount > 0);
  ```
- 关联：[P0-CC1-02 / P0-CC1-05](./audit-CC1-numeric-precision.md)

### S-CC1-3 比例边界 CHECK
- 表：commission.ts + service-commission.ts
- DDL：
  ```sql
  ALTER TABLE commission_rate_matrix ADD CONSTRAINT chk_commission_rate_range
    CHECK (commission_rate BETWEEN 0 AND 1);
  ```

### S-CC1-4 价格上限 CHECK
- 表：product.ts
- DDL：trigger `special_price <= price`、mall_product_skus.bundle_price <= sku.price

### S-CC1-5 不变量 CHECK 集
- service_commissions: `commission_amount = fixed_fee + consume_amount`（容忍 0.02）
- sale_orders: `payable_amount = total_amount - prepaid_card_amount`（容忍 0.02 + 仅销售/转换单）

### S-CC1-6 三端 money helper 抽取（L1）
- 新建：`db/helpers/money.ts` (roundCNY) + `cloudfunctions-shared/money.js` (MONEY_EPSILON=0.001)
- 配套：commission-recalc.ts / discount-pipeline.ts / coupon-allocation.ts 三端共用

### S-CC1-7 cron 不变量守护（L11）
- 新建：`cron-worker/steps/audit-money-invariants.ts`
- 5 项校验 SQL（详见 [audit-CC1 §7](./audit-CC1-numeric-precision.md#7-验证-sql)）

---

## 来自横切 CC2（并发与幂等）

> **CC2 收官报告新增建议**（[audit-CC2-concurrency-idempotency.md](./audit-CC2-concurrency-idempotency.md)）。本节中 S-CC2-1 ~ S-CC2-10 与既有 S03/S05/S06/S11/S12/S14/S15/S20/S23 重叠（已合并，不重复展开）；以下仅记 2 项 CC2 收官**新增**。

### S-CC2-11 prepaid_cards.balance 加 CHECK ≥ 0 + audit-prepaid-balance.ts cron 守护
- 表：prepaid_cards
- DDL：
  ```sql
  ALTER TABLE prepaid_cards ADD CONSTRAINT chk_prepaid_balance_nonneg CHECK (balance >= 0);
  ```
- 配套：cron-worker/steps/audit-prepaid-balance.ts 校验 balance = SUM(card_transactions.amount)
- 关联：audit-CC2 §6 + audit-14 P1

### S-CC2-12 体系化 idempotency_key 字段化（批量 ALTER）
- 表：sale_orders / service_orders / appointments / sale_allocations / service_commissions
- DDL：
  ```sql
  ALTER TABLE sale_orders ADD COLUMN idempotency_key text;
  CREATE UNIQUE INDEX uq_sale_orders_idem ON sale_orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
  -- service_orders / appointments / sale_allocations / service_commissions 同模式
  ```
- 关联：与 messages / operation_logs idempotency_key 模式统一

---

## 来自横切 CC3（组织域隔离）

### S-CC3-1 db/helpers/scope.ts 新增统一 expandScopeStoreIds Drizzle 实现
- 现状：staff utils/scope.js:82 与 admin lib/permissions.ts:108 是双副本
- 建议：抽取共享 helper（可选 PG function `fn_expand_store_scope`）
- 关联：[audit-CC3-org-isolation.md P0-CC3-05](./audit-CC3-org-isolation.md)

### S-CC3-2 staff utils/scope.js 新增 assert* 系列 helper
- 内容：assertCustomerInScope / assertEmployeeInScope / assertSaleOrderInScope / buildClientScopeCondition
- 关联：staff mgmt-customer.js:217 已实现的 assertCustomerInScope 抽出共享

### S-CC3-3 client 新建 clientApi/utils/scope.js
- 内容：assertOwnSaleOrder / assertOwnAppointment / assertOwnUserCoupon
- 配套：clientApi/index.js 引入 phoneRequiredRoutes 集合自动 wrap requirePhone
- 关联：[audit-CC3-org-isolation.md P0-CC3-04](./audit-CC3-org-isolation.md)

### S-CC3-4 staff_wechat_users.store_id 重命名为 default_store_id（可选 P2）
- 消除与 effectiveStoreId 命名混淆

### S-CC3-5 staffApi/utils/scope.js text[] cast 修复（与 audit-21 同源）
- 文件：staffApi/utils/scope.js:108-122
- 修改：`::uuid[]` → `::text[]`（不需 schema 改，仅代码）
- 关联：[P0-21-01](./audit-21-org-structure.md) + [P1-CC3-08](./audit-CC3-org-isolation.md)

---

## 来自横切 CC4（后端鉴权）

### S-CC4-1 新增 roleEnum PG enum（与 S22-1 合并）
- 表：permission_roles
- DDL：见 [S22-1](#s22-1-新增-roleenum-pg-enum)
- 关联：[audit-CC4-auth.md P0](./audit-CC4-auth.md) + [audit-22 P1-22-06](./audit-22-permission-matrix.md)

### S-CC4-2 跨表 openid 全局唯一（与 S01-2 合并）
- 表：staff_wechat_users + client_wechat_users
- DDL：见 [S01-2](#s01-2-跨表-openid-全局唯一)
- 关联：[audit-01 P0-SPLIT-04](./audit-01-auth.md) + audit-CC4

### S-CC4-3 PERMISSION_MATRIX DB 化（与 S22-3 合并）
- 表：system_configs
- DDL：见 [S22-3](#s22-3-permission_matrix-db-化system_configs)
- 关联：audit-01 P1-PERM-07 + P1-22-07 + P1-CC4-13

### S-CC4-4 db/helpers/scope.ts 增 assert* 跨域 helper（与 S-CC3-2 合并）
- 内容：assertCustomerInScope / assertEmployeeInScope / assertOrderInScope
- 关联：staff mgmt-* 三副本 buildScopeFragment + admin estimateRefundOverdraft / getAvailableCoupons / searchEmployees 跨域散落

---

## 来自横切 CC5（错误码）

### S-CC5-1 cloudfunctions/_shared/error-codes.js 单点声明权威错误前缀白名单
- 内容：8 项白名单（4 项约定 + NOT_FOUND / INSUFFICIENT_BALANCE / CONFLICT / INVALID_STATE）
- staff/client/payNotify 三端 index.js 共享导入
- 关联：[audit-CC5 P1](./audit-CC5-error-code.md)

### S-CC5-2 fengyu-admin/src/lib/api-error.ts ApiError + withApiResponse HOF
- 内容：`class ApiError extends Error { code, errorType, prefix }` + `withApiResponse(action)` HOF
- 用途：统一封装 47 处裸 `throw new Error`
- 关联：[audit-CC5 P1](./audit-CC5-error-code.md)

### S-CC5-3 CLAUDE.md + .42cog/dev/sys.spec.md 同步错误前缀约定 8 项
- 文档：CLAUDE.md 全局规范 + .42cog/dev/sys.spec.md
- 内容：错误前缀约定从 4 项扩展为 8 项；明确 admin 必须 throw 带前缀

### S-CC5-4 三端 utils/cloud.ts sanitize 规则共享
- 内容：长度阈值（60 → 100）+ 共享至 `_shared/sanitize.js`

---

## 来自横切 CC6（PII）

### S-CC6-1 db/helpers/pii.ts 抽取权威 mask 系列
- 内容：`maskPhone / maskOpenid / maskIdCard / safeStringify(obj, sensitiveKeys[]) / pgErrorToBusiness(err)`
- 配套：cloudfunctions/<fn>/helpers/pii.js（云函数 build 时复制）
- 关联：[audit-CC6 P0-CC6-02](./audit-CC6-pii.md)

### S-CC6-2 id_card AES envelope encryption 模式
- 表：staff_wechat_users
- DDL：
  ```sql
  ALTER TABLE staff_wechat_users
    ADD COLUMN id_card_ciphertext bytea,
    ADD COLUMN id_card_iv bytea;
  -- 数据回填 + 删除 id_card 列
  ```
- 配套：encryptIdCard / decryptIdCard helper
- 关联：[audit-CC6 P0-CC6-01](./audit-CC6-pii.md)

### S-CC6-3 历史 operation_logs.detail 一次性回填脱敏
- migration：`00NN_pii_redact_operation_logs.sql`
- 内容：jsonb regex 替换 `\d{11}` / `\d{18}` / `oABC[A-Za-z0-9_-]+`
- 关联：[audit-CC6 §7-D](./audit-CC6-pii.md)

### S-CC6-4 admin lib/operation-log.ts 写入前 sanitizeDetail
- 内容：升级 `_v: 3`（已脱敏标记）
- 配套：[audit-CC6 P0-CC6-03](./audit-CC6-pii.md)

### S-CC6-5 admin formatPhoneSafe(phone, role) 按 PERMISSION_MATRIX 权限收紧
- 内容：admin 全明文、其他角色一律 mask
- 配套：与 audit-12 P2-12-16 `customer:phone:full` 权限项合流

---

## 来自横切 CC7（时间字段）

### S-CC7-1 PG 集群级 SET timezone = 'Asia/Shanghai'
- migration：`00NN_set_db_timezone.sql`
- DDL：
  ```sql
  ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai';
  ```
- 修复根因：P0-CC7-01 / P1-CC7-09
- CI 守卫：跑验证 SQL `SHOW timezone` 应等于 `Asia/Shanghai`

### S-CC7-2 service_commissions 增 voided_at ✅ 已完成（migration 0018）
- 表：service_commissions
- DDL：~~`ADD COLUMN voided_at timestamp`~~ → **已落地**（migration 0018 + 退款 cascade 双端使用）
- 关联：与 sale_allocations.voided_at 软删时间审计对称（P1-CC7-08）

### S-CC7-3 时区路线决策（withTimezone 策略）
- 推荐：继续 naive timestamp（与现有 60+ 列 + JS new Date() 默认行为兼容）
- 修改：db/schema/user.ts:38/40/53 三列改回 naive 以消除同表混用（P1-CC7-10）

### S-CC7-4（可选）DB 端 updated_at 触发器统一替代 Drizzle $onUpdate 钩子
- 风险评估：staff/client/payNotify 走原生 SQL 时显式 `updated_at = $X` 30+ 处仍生效，纯收益

### S-CC7-5 baseline assertion CI 守卫
- 内容：P0 修复迁移合入时打 assertion，跑 `SHOW timezone` 验证

---

## 来自横切 CC9（测试与迁移残留）

### S-CC9-1 productKindEnum PG enum 4 值类型化
- 表：products
- DDL：
  ```sql
  CREATE TYPE product_kind_enum AS ENUM('护理项目','家居产品','充值卡','体验卡');
  ALTER TABLE products ALTER COLUMN product_kind TYPE product_kind_enum USING product_kind::product_kind_enum;
  ```
- 关联：消除自由文本 + 前端硬编码 drift（与 audit-24 同源）

### S-CC9-2 products.display_icon 决策
- 表：products
- DDL：删除或在三端 wxml 加渲染（dead column 治理）
- 关联：[audit-24 P2-24-11](./audit-24-product-category-dynamic.md)

### S-CC9-3 system_configs 新增 special_card_kind_id 配置项
- 表：system_configs
- 内容：消除 SQL 中 `'充值卡'` 字面量；解锁 admin 改名 capability
- 关联：与 [S24-1](#s24-1-product_categories-加-is_recharge_card-capability-列) 二选一（is_recharge_card 列 vs system_configs 配置）

### S-CC9-4 spec 校对
- 文件：backend.pr.spec.md / admin.pr.spec.md / admin.ui.spec.md
- 操作：全量替换 `valid_start / valid_end` → `is_enabled boolean`
- 关联：[audit-09 P1-09-06](./audit-09-product-sku.md)

### S-CC9-5 归档清单
- 文件：`db/scripts/sync-products-from-workfine.js` + staffApi `db/mssql.js` + `query_wf_tables.js`
- 操作：移入 `_archive/` 或加废弃 banner
- 依据：memory `workfine-sync-stopped` 决策（2026-04-16）

---

## 待补充

后续轮次发现的 schema 建议会追加到此文件。

---

## 2026-04-27 域重构收官备注

> **sale-order-domain-refactor 域重构收官（2026-04-27）**产生以下已落地变更，对应上方标记 ✅ 的条目：
>
> 1. **saleOrderTypeEnum 5→3**：'回款单'/'退款单' 已移除，migration 0019+0021 已 apply，当前（'销售单','内部单','转换单'）
> 2. **sale_order_payment_details 1:1 子表**：operator/note/退款专属（refund_reason, ref_sale_item_id, session_count）/审批专属（audit_employee_id, audit_at, audit_remark）字段全部下沉
> 3. **paymentFlowStatusEnum** 新增 `'待审批'` 值
> 4. **uq_sop_status_audit** partial unique index：`(sale_order_id, change_type) WHERE change_type='退款' AND status='待审批'`，覆盖退款审批并发保护
> 5. **退款 5 通道 cascade 已实现**：sale_allocations (is_void), service_commissions (voided_at), user_coupons (restored), point_transactions (reversed), pickup_records (rolled back)
> 6. **audit-payment-invariants cron STEP 7**：验证 5 项退款不变量
> 7. **Dashboard**：received - refunded_amount, WHERE is_void=false
