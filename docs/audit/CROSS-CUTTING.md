# 横切问题归集（CROSS-CUTTING）

汇总每轮审计中发现的、跨多个业务域共性的问题。每个条目记录首次发现时的报告 + 后续命中的报告，便于最终评估"有多少域受影响"。

---

## CC1 数值精度与金额计算

### 后端不重算前端传入的金额 / 比例
- **首次发现**：[audit-08-service-commission.md §3.2 P1-08-14](./audit-08-service-commission.md)
- **域**：08 (service-commission)
- **现象**：admin batchSaveServiceCommissions 把前端计算后的 `commissionRate` / `commissionAmount` 直接持久化到 service_commissions 表，不在后端按 commission_rate_matrix 二次重算。恶意 admin 用户 / 前端 BUG 可写入任意金额（real.md #5 后端统一鉴权违背的"信任前端值"形态）。
- **后续命中**：
  - [audit-09-product-sku.md §3.2 P1-09-07](./audit-09-product-sku.md) — admin createOrder 信任前端传入 `unitPrice` / `unitRealPrice`，无 server-side `SELECT productSkus.price` 二次校验；与 commission 同模式

### 软删除字段不一致：is_void 与 voided_at 的双轨
- **首次发现**：[audit-07-sales-allocation.md §3.1 P0-07-01](./audit-07-sales-allocation.md)
- **后续命中**：[audit-08-service-commission.md §3.1 P0-08-05](./audit-08-service-commission.md) — sa 有 `voided_at`，sc schema 完全没有；同样的"软删除"语义两表实现差异，跨表审计回溯断裂

### 员工/门店绩效汇总不过滤 sale_order_type，退款单负行 / 内部单 / 回款单全计入
- **首次发现**：[audit-18-employee-performance.md §3.1 P0-18-01](./audit-18-employee-performance.md)
- **域**：18 (employee-performance)
- **现象**：performanceDetail / todayCommission / monthlyCalendar / dashboard 的 sa 汇总 SQL 全部仅 `WHERE o.status='已支付' AND o.paid_at IN ...`，未限制 `o.sale_order_type ∈ ('销售单','回款单')`。结果：
  - 退款单 FY-TKD `total_amount<0` + sa 行 `total_amount<0`（schema 注释明确"退款业绩为负数"）→ 员工绩效"今日分成"被退款负值拉低（甚至变负）；
  - 回款单 FY-HKD payNotify 写 sa 时和原销售单首次写 sa 重复；
  - 内部单（spec §3.13 要求"不计入员工业绩 / 顾客客流"）当前仍全额计入。
- **波及**：与 retain audit-07 P0-07-02（销售提成不冲销）+ audit-08 P0-08-04（服务提成不冲销）+ audit-11 P0-11-01（退款审批不冲销）联合发力时，员工绩效汇总在退款生命周期里 4 次计算口径全错。
- **修复**：所有员工 / 门店级 sa 汇总 SQL 强制加 `AND o.sale_order_type IN ('销售单','回款单')`（或显式排除 '退款单','内部','转换单'）；建议提一个 `assertSettlableOrderType()` SQL helper 统一 WHERE 子句，跨域引用。

### 员工绩效汇总 sa+sc 双轨在不同入口选择性接入（数字割裂）
- **首次发现**：[audit-08-service-commission.md §3.2 P1-08-07](./audit-08-service-commission.md)
- **域**：08 (service-commission) → 18 (employee-performance) 再确认未修
- **现象**：performanceDetail ✅ 已读 sa+sc；todayCommission / monthlyCalendar / staff.dashboard ❌ 仅读 sa。员工"工作台今日分成 / 月度日历 / 数据看板"显示的金额都不含服务提成 → 与"绩效详情"总额永远割裂。
- **后续命中**：
  - [audit-18-employee-performance.md §3.2 P1-18-04 / §3.3 P2-18-13](./audit-18-employee-performance.md) — todayCommission / monthlyCalendar 视角再次确认未修；建议与服务侧统一一次性接入 sc.commission_amount

---

## CC2 并发与幂等

### bindPhone 重试不幂等
- **首次发现**：[audit-01-auth.md §3.2 P1-PHONE-09](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：client bindPhone 缺 idempotency_key，首次成功后超时重试报"已绑定"
- **后续命中**：—

### Advisory lock 跨事务释放窗口可生成重号
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-01](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：`staffApi/routes/order.js:2452 generateOrderNo` 自带 `pg.transaction`，advisory_xact_lock 在 commit 时释放；外层主事务再开新事务持锁。两段中间存在窗口，并发可重号。client/admin 已是单事务正确模式。
- **后续命中**：
  - [audit-11-refunds.md §3.1 P0-11-03](./audit-11-refunds.md) — 11 域 staff `createRefund` 同样用 `generateOrderNo('FY-TKD-WX-')` 外层独立事务 + 内层 `pg.transaction` 双事务模式；并且 INSERT 用的 sale_order_id 来自外层调用，事务内的 maxSeq 仅用于 sale_items 行 ID — 序号源不一致 → 应合并到单事务

### 状态机 UPDATE 缺 CAS 守卫
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-03](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：`clientApi/routes/order.js:1045 cancel`、`:781 offlinePay`、`:1251 alipayPay` 等 UPDATE sale_orders 仅 WHERE sale_order_id，未带 `AND status = $expectedStatus`。状态机靠应用层 SELECT 校验，存在竞态。
- **后续命中**：
  - [audit-03-payment-flow.md §3.3 P2-03-15](./audit-03-payment-flow.md) — 03 域 client.{pay,alipayPay,offlinePay} 改写 payment_method 时也无 CAS。
  - [audit-06-appointment-checkin.md §3.1 P0-06-02](./audit-06-appointment-checkin.md) — client `appointment.js:208-214 cancel` UPDATE appointments 仅 WHERE appointment_id，未带 status / client_user_id；TOCTOU 把 '已确认' 甚至 '已完成' 强行覆盖为 '已取消'。
  - [audit-12-store-binding.md §3.1 P0-12-04](./audit-12-store-binding.md) — 12 域 staff approveUnbind / rejectUnbind + admin approveUnbind / rejectUnbind + client cancelUnbindRequest **三端 5 个路径** UPDATE store_unbind_requests 全部仅 WHERE request_id，无 status CAS；并发 cancel/approve 终态可被互相覆盖，违反 real.md #4 状态单向

### 多步硬删除非事务包装（孤儿态风险）
- **首次发现**：[audit-09-product-sku.md §3.1 P0-09-03](./audit-09-product-sku.md)
- **域**：09 (product-sku)
- **现象**：admin `deleteSku` 在 `actions/products.ts:633-654` 先 `db.delete(mallProductSkus)` 后 `db.delete(productSkus)`，两步**不在 `db.transaction` 内**。第一步成功后第二步失败 → mall_product_skus 关联清空、productSkus 残留 → 商城 SPU 显示为"无 SKU 可选"。同理 `mall_category_group` 删除已用事务包（参考），`deleteSku` 是回退模式。
- **波及**：所有"先删关联 + 再删主体"的 admin actions 模式（待审计 deleteCategory / deleteCoupon / deleteAppointment / cancelOrder 等）
- **后续命中**：—

### 余额扣减 UPDATE 缺 CAS 守卫（依赖 FOR UPDATE 行锁）
- **首次发现**：[audit-14-prepaid-card.md §4 表](./audit-14-prepaid-card.md)
- **域**：14 (prepaid-card)
- **现象**：所有 `UPDATE prepaid_cards SET balance = balance - $1 WHERE card_id = $2` 都**没有** `AND balance >= $1` 守卫。当前 PG 默认 read committed + FOR UPDATE 行锁理论上安全，但单条 UPDATE 自身不防超卖。违反 `real.md` #1 "原子操作（单条 UPDATE + 条件判断）"精神。
- **修复**：所有扣减 UPDATE 加 `AND balance >= $1`（与 sale_items.remaining_sessions 扣次模式对齐）。
- **波及**：14 域全部 4 处扣款 UPDATE（client × 3, staff × 2, payNotify × 1, admin × 1）

### card_transactions 缺 (ref_order_id, type) UNIQUE
- **首次发现**：[audit-14-prepaid-card.md §3.1 P0-14-02](./audit-14-prepaid-card.md)
- **域**：14 (prepaid-card)
- **现象**：所有 11+ 处 INSERT card_transactions 路径采用"先 SELECT 1 + 再 INSERT"幂等去重。无 DB UNIQUE 兜底；TOCTOU 类同 audit-06/audit-11 的"事务外读 → 事务内 INSERT 无 partial unique 兜底"模式。
- **修复**：加 `CREATE UNIQUE INDEX uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`
- **波及**：14 域

### TOCTOU 校验：事务外读 → 事务内 INSERT，无 partial unique 兜底
- **首次发现**：[audit-03-payment-flow.md §3.1 P0-03-03](./audit-03-payment-flow.md)
- **后续命中**：
  - [audit-05-service-order.md §3.1 P0-05-03](./audit-05-service-order.md) — staff service.create 把 appointment_id 重复关联校验 / 顾客活动服务单校验 / 剩余次数校验全部放在 `pg.transaction()` 外部用 `pg.query` 读，事务内才 INSERT；并发 create 可绕过校验，无 partial unique 兜底（appointment_id / client_user_id+status）。
  - [audit-06-appointment-checkin.md §3.1 P0-06-03 / §3.3 P2-06-15](./audit-06-appointment-checkin.md) — client `appointment.js:108` create 同 saleItemId 已有活跃预约校验事务外读；staff `service.js:55-69` 校验 appointment 占用同样事务外读；两者都缺 partial unique 索引兜底（建议同时加 `service_orders(appointment_id) WHERE NOT NULL` + `appointments(sale_item_id) WHERE status IN ('待确认','已确认')`）。
  - [audit-12-store-binding.md §3.1 P0-12-05](./audit-12-store-binding.md) — client `store.js:146-159` requestUnbind 用 SELECT-then-INSERT 防同顾客重复 pending，无锁、无事务、无 partial unique；并发提交 / 弱网重试可写多行 pending（建议加 `uq_store_unbind_pending ON store_unbind_requests(user_id) WHERE status='待处理'`）
  - [audit-13-coupons.md §3.1 P0-13-06 / P0-13-07](./audit-13-coupons.md) — admin `actions/coupons.ts:527-535 issueCoupon` + `:652-665 batchIssueCoupons` 用 `SELECT count(*)` 后立即 INSERT user_coupons，无事务、无 advisory lock、无库存兜底；cron-worker 三类自动发放 (refresh-member-levels / grant-birthday / grant-thanksgiving) **完全不验 totalCount**，仅 `is_active` 校验。两路同时穿仓可让 limit 模板随意超发，资损按整个会员池 × 单券面值。建议 advisory_xact_lock(`'coupon-issue-' || templateId`) + 事务内 SELECT FOR UPDATE

### Advisory lock 跨端 key 不一致
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-01](./audit-02-order-creation.md)
- **后续命中**：
  - [audit-05-service-order.md §3.1 P0-05-02](./audit-05-service-order.md) — staff `Buffer.reduce` 私有 hash vs admin `hashtext('service_order_id_gen')`，对同一资源（service_orders.serviceOrderId）的两端 advisory lock 不互斥；号段碎片在两端前缀分裂下被掩盖，前缀任一统一就会立刻撞号。

### 决策语句在事务外读，可在并发下产生重复主语义行
- **首次发现**：[audit-03-payment-flow.md §3.1 P0-03-03](./audit-03-payment-flow.md)
- **域**：03 (payment-flow)
- **现象**：`staffApi/routes/order.js:826-838` confirmOffline 用 pg.query（事务外）判断 changeType 是 '首次支付' 还是 '回款'；并发下两进程都读到 0 行 → 都 INSERT '首次支付'。无 partial unique 兜底。同源问题：`staffApi/routes/order.js:1352-1358` createRefund 的 in-flight 唯一性也是事务外读（P0-03-04）。
- **后续命中**：
  - [audit-04-pay-notify.md §3.1 P0-04-02 反例 + §4](./audit-04-pay-notify.md) — 04 域 payNotify changeType 决策已在事务内（`index.js:150-156`），属于"修复模式"参考实现，与 staffApi 同模式发散
  - [audit-11-refunds.md §3.1 P0-11-02](./audit-11-refunds.md) — 11 域再确认：staff createRefund + admin createRefundOrder **两端**都把 in-flight 唯一性放在事务外读；缺 partial unique `uq_refund_inflight ON sale_orders(ref_sale_order_id) WHERE sale_order_type='退款单' AND status='待审批'` 兜底

### 状态机 UPDATE 缺 CAS 守卫（payNotify 凭证单）
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-03](./audit-02-order-creation.md)
- **后续命中**：
  - [audit-04-pay-notify.md §3.2 P1-04-09](./audit-04-pay-notify.md) — payNotify/index.js:204-214 凭证单 UPDATE 仅 WHERE sale_order_id，无 status CAS

### 关单 / 取消未作废已写入流水（payments / allocations）
- **首次发现**：[audit-03-payment-flow.md §3.1 P0-03-05](./audit-03-payment-flow.md)
- **域**：03 (payment-flow)
- **现象**：staff.close / client.cancel / closeExpiredOrder 仅 UPDATE sale_orders.status='已关闭'，不联动 sale_order_payments / card_transactions / sale_allocations 的状态翻转/作废。'已关闭' 订单仍在 SUM payments 中计入营收。
- **后续命中**：
  - [audit-07-sales-allocation.md §3.1 P0-07-02](./audit-07-sales-allocation.md) — 07 域 staff/admin approveRefund 完全不动原销售单 sa 行（既不写负 total_amount，也不缩减原行），员工业绩按未退款金额持续累计；与"已关闭"清理缺失同源问题但更严重（直接资损）

### 同资源双写模式漂移：staff 硬 DELETE / admin 软 is_void=true
- **首次发现**：[audit-07-sales-allocation.md §3.1 P0-07-01](./audit-07-sales-allocation.md)
- **域**：07 (sales-allocation)
- **现象**：sale_allocations 模式 schema 显式声明 `is_void` + `voided_at` 软删除字段，admin batchSaveAllocations 用 `UPDATE is_void=true, voided_at=NOW()`；staff allocation.save / deleteAllocation 三处用 `DELETE FROM sale_allocations`。同一资源两端实现风格冲突，硬 DELETE 让审计 / 退款回滚链彻底断裂。
- **后续命中**：
  - [audit-08-service-commission.md §3.1 P0-08-05](./audit-08-service-commission.md) — service_commissions 反向问题：schema 仅 `is_void` 无 `voided_at`，admin batchSave 软删时无时间戳；与 sale_allocations 双轨另一极端，审计同样断裂

### 退款审批不冲销已写入提成 / 分配（资损）
- **首次发现**：[audit-07-sales-allocation.md §3.1 P0-07-02](./audit-07-sales-allocation.md)
- **域**：07 (sales-allocation)
- **现象**：staff/admin approveRefund 都不动原销售单的 sale_allocations 行，员工业绩永久按未退款金额累计
- **后续命中**：
  - [audit-08-service-commission.md §3.1 P0-08-04](./audit-08-service-commission.md) — 退款审批同样不动 service_commissions，已完成服务的提成在退款后永久留存（销售提成 + 服务提成双重资损）
  - [audit-11-refunds.md §3.1 P0-11-01](./audit-11-refunds.md) — 11 域再确认：admin/staff approveRefund 仍未补 sa/sc 冲销逻辑，且新发现 user_coupons 也不释放（P0-11-04）；建议三者一并补：sa is_void+voided_at、sc 加 voided_at 列、user_coupons 全额退款释放
  - [audit-15-points-member-level.md §3.1 P0-15-01](./audit-15-points-member-level.md) — admin `confirmOfflinePayment / recordPayment / approveRefund` **三处全无 settlePointsSafe**（staff/client/payNotify 同语义触发点 5 处全有）；admin 路径退款不写"消费冲销"流水 + 回款不发"消费赠送"，与 sa / sc / coupons 漏冲销同源（"admin 资金链 vs 业务链"系统性脱节）
  - [audit-20-pickup.md §3.1 P0-20-01](./audit-20-pickup.md) — 家居产品退款审批**不冲销 picked_up_quantity**：admin `actions/refunds.ts:847-872` 与 staff `routes/order.js:1547-1558` approveRefund 仅扣减疗程卡 `remaining_sessions`，对 product_type IN ('单品','家居产品') 的"退出"行完全无任何 picked_up_quantity 累加 / 耗尽锁。顾客买 5 件 + 申请全退（待审批）+ staff 提货 2 件 + approveRefund 通过 → 双消费资损（退款 5 件 + 实物 2 件）。与 P0-07-02 / P0-08-04 / P0-11-04 / P0-15-01 联合构成"退款不冲销次数等价物" 5 命中域系统性问题（疗程卡次数 / 服务提成 / 销售提成 / 优惠券 / 积分 / **家居提货次数**）

### 同业务工具三/四端副本漂移（修一处忘多处）
- **首次发现**：[audit-15-points-member-level.md §3.1 P0-15-02](./audit-15-points-member-level.md)
- **域**：15 (points-member-level)
- **现象**：`settlePointsForOrder` 在 `staffApi/utils/points.js`、`clientApi/utils/points.js`、`payNotify/points.js` 三份逐字复制；cron-worker `refresh-member-levels.ts:228 grantUpgradeBenefits` + `grant-birthday-benefits.ts:108 grantOneBirthday` + `grant-thanksgiving-benefits.ts` 又各自手写 INSERT point_transactions + UPDATE points_balance，"积分写入"散落 5 套口径 × 5 种 type 字符串。任一端漏改 → 数据漂移。
- **波及**：与 audit-08 P0-08-06（roleType 推断三端分裂）+ audit-10 P1-10-08（customer_type 跃迁 SQL 三端 100% 重复）同模式；建议把"积分发放" / "type 字符串" / "提成系数" 等核心规则统一为 db function 或共享 npm package
- **后续命中**：
  - [audit-19-gift-share-assign.md §1 + §3.2 P1-19-06](./audit-19-gift-share-assign.md) — `grantShareGift` 在 `staffApi/share-gift.js`、`payNotify/share-gift.js`、`clientApi/share-gift.js` 三份**字节级 diff = 0**，且 clientApi 副本是 dead code（无 require）。函数顶端注释直白写"必须保持字节级一致"但无 lint/CI 守护，未来某一份漂移半行就会到生产才发现。建议抽 `cloudfunctions-shared/share-gift.js` 或在 cloudbase-deploy 加 prebuild `diff` 守卫
  - [audit-20-pickup.md §3.2 P1-20-04](./audit-20-pickup.md) — `quantity - picked_up_quantity`（剩余可提）**5 处副本**：admin `pickup-records.ts:256` + admin `refunds.ts:200`（→ `utils/refund.js`） + staff `order.js:2085`（转换单可折抵卡） + staff `order.js:2335-2356`（转换单备选查询） + staff `order.js:2397`（createPickup CAS）+ staff `utils/refund.js:25-26`。NULL/COALESCE/类型 cast 处理细微差异即口径漂移；建议提取 `db/helpers/sale-item-availability.ts` 与 `staffApi/utils/sale-item.js` 共用 helper

### 退款审批不释放已使用优惠券（顾客侧资损）
- **首次发现**：[audit-11-refunds.md §3.1 P0-11-04](./audit-11-refunds.md)
- **域**：11 (refunds)
- **现象**：staff `routes/order.js:525-528` 开单时 `UPDATE user_coupons SET status='已使用'`，`:1093-1097 close` 时释放，但 approveRefund **完全不释放**。顾客全额退款后券价值消失。与 P0-11-01 同源（"退款不联动反向已变状态"）。
- **后续命中**：
  - [audit-13-coupons.md §3.1 P0-13-04](./audit-13-coupons.md) — 13 域再确认（retain）：admin `actions/refunds.ts:778` 与 staff `routes/order.js:1488-1636` approveRefund 均未补释放；优惠券域回归测试用例 4 已列出
  - [audit-19-gift-share-assign.md §3.1 P0-19-04](./audit-19-gift-share-assign.md) — 19 域加强：分享礼券（coupon_id 前缀 `sg-inviter-` / `sg-invitee-`）在退款 / 关单 / 取消订单 路径下均不撤销，运营方资损（已发出的"奖励券"无对价继续可用）。修复需新增 `couponStatus='已撤销'` 枚举值 + 事务内 UPDATE WHERE coupon_id IN (sg-inviter-{X}, sg-invitee-{X})；与 P0-11-04 同事务一并补

### 多次部分退款 split 算法分母漂移
- **首次发现**：[audit-11-refunds.md §3.1 P0-11-06](./audit-11-refunds.md)
- **域**：11 (refunds)
- **现象**：approveRefund 用 `origPrepaidCardAmount / origTotalAmount` 作为储值卡 vs 原通道拆分比例，但原单 prepaid_card_amount 在第 1 次退款 approve 后已被重算（变小/含负），第 2 次再用变化后的快照作分母，比例失真。算法注释明确说应用"原始抵扣比例"，与实现不符。
- **波及**：所有"链式状态依赖原表当前值"模式（待 14 充值卡 / 03 款项流水 二次复核）
- **后续命中**：—

### Server-side 计算结果的命中维度缺失（matrix lookup 缺 scope）
- **首次发现**：[audit-08-service-commission.md §3.1 P0-08-01](./audit-08-service-commission.md)
- **域**：08 (service-commission)
- **现象**：staff service.complete 查 commission_rate_matrix 缺 `org_id` 维度过滤；矩阵以市场维度持久化（`commissionRateMatrix.orgId`），跨市场误命中导致按错费率结算。admin 前端 `findMatchingRate` 显式过滤 marketName，两端口径不一致。
- **后续命中**：—（待域 09 商品价格 / 13 优惠券 / 17 看板 验证类似 matrix lookup 是否缺 scope）

### 同概念三端推断算法分裂（roleType 推断）
- **首次发现**：[audit-07-sales-allocation.md §3.2 P1-07-06](./audit-07-sales-allocation.md)
- **后续命中**：
  - [audit-08-service-commission.md §3.1 P0-08-06](./audit-08-service-commission.md) — admin（`推广师>养生师>美容师`） vs staff（`skills[0]||'美容师'`） vs payNotify（`skills[0]||'美容师'`）三套算法；同一员工同一服务单，自动入账与店长查看后保存的金额不同。建议抽 `db/helpers/role-resolve.ts` 共用 helper
  - [audit-10-customer-member-level.md §3.2 P1-10-08](./audit-10-customer-member-level.md) — customer_type 跃迁 SQL 在 `staffApi/routes/order.js:73-156 recalcCustomerType` 与 `payNotify/index.js:358-463` 100% 重复（90 行 EXISTS 子查询 + UPDATE 单调递增校验），任一处口径变更必须双改

### 同 metric 多算法漂移（消费档位与会员等级）
- **首次发现**：[audit-10-customer-member-level.md §3.1 P0-10-06](./audit-10-customer-member-level.md)
- **域**：10 (customer-member-level)
- **现象**：`member_level`（cron）用 `SUM(paid_amount)` + 12 月滚动窗口；`spending_tier`（staff order / payNotify 内联）用 `SUM(total_amount)` 累计无窗口。同顾客可同时 spending_tier='1-3W' + member_level=null，admin 详情页两栏数字矛盾。
- **波及**：所有"消费档位 + 等级"双指标共存的页面（staff customer detail / admin 顾客列表 / mgmt-traffic / 数据看板）
- **后续命中**：
  - [audit-15-points-member-level.md §3.1 P0-15-04 / P0-15-05](./audit-15-points-member-level.md) — 15 域再确认：cron 跳档 SQL `WHERE customer_type='会员客'` 把流量/体验/小美客排除在 member_level 评估外（从而排除生日/感恩三件套 `WHERE member_level IS NOT NULL`）；同时在双口径基础上**叠加第三口径** customer_type（其跃迁规则完全独立）。建议 audit-10 修复时三口径一并统一

### 金额字段 amount 缺符号 CHECK 约束（流水类表）
- **首次发现**：[audit-14-prepaid-card.md §3.1 P0-14-05](./audit-14-prepaid-card.md)
- **域**：14 (prepaid-card)
- **现象**：`card_transactions.amount` NUMERIC(10,2) 但**无** `CHECK ((type='充值' AND amount>0) OR (type='扣款' AND amount<0))`。对比 `sale_order_payments.chk_sop_amount_sign` 已有此 CHECK。一旦应用层 bug 写反，admin summary 按符号汇总会失真。
- **波及**：14 域；积分流水 `point_transactions`（待 15 复核）应同样补 CHECK
- **后续命中**：
  - [audit-15-points-member-level.md §3.3 P2-15-18](./audit-15-points-member-level.md) — `point_transactions.amount integer NOT NULL` 完全无 CHECK 也无类型语义守卫（消费赠送=正/消费冲销=负 仅由应用层维护）；同时 amount 用 int4（±21 亿），长尾累积 / 错误回放可触底负值。建议同步补 `CHECK ((type='消费赠送' AND amount>0) OR (type='消费冲销' AND amount<0) OR amount > 0)` + 切 bigint

### Balance 与流水的对账不变量无 cron 守护
- **首次发现**：[audit-14-prepaid-card.md §3.1 P0-14-04](./audit-14-prepaid-card.md)
- **域**：14 (prepaid-card)
- **现象**：约束 `prepaid_cards.balance ≡ SUM(card_transactions.amount)`，但既无 trigger 也无 cron 校验（cron STEP 5 只校验 customer_points 余额）。任何代码 bug 导致漂移会沉默不被发现。
- **修复**：仿 `audit-points-balance.ts` 加 `audit-prepaid-balance.ts` step。
- **波及**：14 域；后续 15 (积分) 已实现，但其他余额类表（如未来 cards）需注意

### 流水表 (xxx_id, ref_xxx_id, type) 缺 partial UNIQUE 兜底
- **首次发现**：[audit-14-prepaid-card.md §3.1 P0-14-02](./audit-14-prepaid-card.md)
- **后续命中**：
  - [audit-15-points-member-level.md §3.2 P1-15-07](./audit-15-points-member-level.md) — `point_transactions` 仅 `external_ref` 有 partial unique（`points.ts:29`），消费赠送/冲销 `(user_id, ref_order_id, type)` 三元组无 UNIQUE。当前靠 settle "差值法 delta=expected-granted" 应用层幂等，但任何外部手动 INSERT / 触发点同事务再调一次 settlePoints 都没有 DB 兜底
  - 建议一并补：`uq_pt_consumption ON point_transactions(user_id, ref_order_id, type) WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销')`、`uq_card_tx_ref_type ON card_transactions(ref_order_id, type) WHERE ref_order_id IS NOT NULL`

### 一致性 cron 仅告警不修复（偏差累积无回收路径）
- **首次发现**：[audit-15-points-member-level.md §3.2 P1-15-13](./audit-15-points-member-level.md)
- **域**：15 (points-member-level)
- **现象**：`audit-points-balance.ts` 决策 D7 故意只告警不 UPDATE balance（避免掩盖上游 bug），但 notifyOps 企微 webhook + 5 行 preview + operation_logs 单条 INSERT 之后**无任何工单 / SLA / 自动修复路径**。一次发现 100 条偏差只展示 5 条，余下 95 条详情埋在 operation_logs.detail jsonb 内。
- **波及**：未来 audit-prepaid-balance 一旦上线如果照搬只会复制此问题；任何"仅告警 cron"模式（包括 audit-08 / audit-10 建议中的 sc/customer_type 重算守护 cron）需考虑配合：偏差阈值升级、json path 索引、人工 ack 机制。

---

## CC3 组织域数据隔离

### Staff 路由 scope 过滤非全覆盖
- **首次发现**：[audit-01-auth.md §3.1 P0-AUTH-02](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：middleware 注入 `ctx.auth.scopeStoreIds` 但 SQL 是否调用 `buildStoreScopeCondition` 完全靠路由作者自觉
- **后续命中**：
  - [audit-05-service-order.md §3.2 P1-05-10](./audit-05-service-order.md) — staff service.list/detail/counts 直接拼 `so.store_id = $1`（取 effectiveStoreId），管理层模式下 effectiveStoreId 为 null，service Tab 一片空白
  - [audit-06-appointment-checkin.md §3.2 P1-06-09](./audit-06-appointment-checkin.md) — staff appointment.list/detail/confirm/checkin 全部直接拼 `a.store_id = $effectiveStoreId`，管理层 (loginLevel='management') 模式下空集
  - [audit-07-sales-allocation.md §3.2 P1-07-07](./audit-07-sales-allocation.md) — staff allocation.save/pendingList/suggest/deleteAllocation/getCommissionRates 全部直接 `store_id = $effectiveStoreId`，多店店长以管理层模式登录后整个分配模块返回空
  - [audit-12-store-binding.md §3.2 P1-12-08 / P1-12-09](./audit-12-store-binding.md) — staff `store.js:42-58 unbindRequests` + `:78-88 approveUnbind` + `:115-125 rejectUnbind` 三个路由用 `ctx.auth.storeId`（员工档案默认门店）而非 `scopeStoreIds`；多店店长漏看其他店申请，管理层模式（effectiveStoreId=null）完全不可审批

### Client 端无 scope helper，业务隔离 100% 业务层手写
- **首次发现**：[audit-01-auth.md §3.1 P0-AUTH-03](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：middleware 仅暴露身份字段，SQL 必须手动加 `AND client_user_id = $n`
- **后续命中**：—（待域 02/05/13/14/15/16 验证 client 各路由）

### order.create 不复核商品 market_scope（跨市场绕过）
- **首次发现**：[audit-09-product-sku.md §3.1 P0-09-02](./audit-09-product-sku.md)
- **域**：09 (product-sku)
- **现象**：product 列表查询都按 `market_scope IS NULL OR = $boundMarketName` 过滤；但 staff/client/admin 三端 order.create 直接按 skuId 查 product_skus，**完全不复核 market_scope**。攻击者把跨市场 skuId 直接传给 create 即下单成功。
- **波及**：market_scope 是 product 维度的"组织域隔离"，与传统按 store_id 过滤的销售/服务流域不同。需在所有可能"按 skuId 直接查"的入口（order.create / appointment.create / refund 等）补 market_scope 复核。
- **后续命中**：—（待 06 预约 / 11 退款 等域复核）

### 优惠券 applicable_market_ids / applicable_product_ids 三端运行时不消费（设计→实现断裂）
- **首次发现**：[audit-13-coupons.md §3.1 P0-13-02 / P0-13-03](./audit-13-coupons.md)
- **域**：13 (coupons)
- **现象**：`db/schema/coupon.ts:24/30` 声明 `applicable_product_ids` + `applicable_market_ids` 字段；admin createTemplate 写入；admin getAvailableCoupons 仅消费 market（line 130-148）；**staff/client coupon.available + 三端 order.create 全部不读**。运营配置的市场/商品维度限制对客户/员工/admin 下单完全失效。同时 admin createOrder（`actions/orders.ts:748-775`）连 store/market/category/product **四个范围全部跳过**。
- **波及**：market_scope 类似的"前端展示过滤但下单不复核"模式（同 product 域 P0-09-02 命中）；建议建立"凡 schema 含 applicable_xxx_ids 字段，三端 create-time 必须 grep 检查"的硬规则。
- **后续命中**：—

### 范围/快照字段三端读取口径漂移（face_value_override 仅 client order.create + 部分 available 路径读）
- **首次发现**：[audit-13-coupons.md §3.1 P0-13-05](./audit-13-coupons.md)
- **域**：13 (coupons)
- **现象**：`user_coupons.face_value_override` 设计为"分享礼/动态面值"运行时覆盖；client coupon.list/available + order.create 用 `COALESCE(face_value_override, ct.discount_value)` ✅；staff coupon.available 用了 COALESCE 但同模块的 order.create（`routes/order.js:331`）漏掉；admin 全链路均读 `couponTemplates.discountValue`。三端不齐 → 面值动态调整对 staff 现场录单 + admin 后台录单完全失效。
- **波及**：与 `face_value_override` 同性质的运行时覆盖列存在于其他模块时（待 14 充值卡 / 15 积分 验证）需相同 grep 检查。
- **后续命中**：—

---

## CC4 后端统一鉴权

### Admin Server Action 缺统一鉴权 wrapper
- **首次发现**：[audit-01-auth.md §3.1 P0-AUTH-01](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：依赖每个 action 自调 `requirePermission()`，无 HOF 包装
- **后续命中**：—（每个 admin 域审计时都应抽样验证）

### Admin scope 隐式合约：依赖权限矩阵不维护就漏 isInScope
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-05](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：`fengyu-admin/src/actions/orders.ts:1531 recordPayment` 注释明确说"非 admin 由权限矩阵拒绝；扩权限到 scoped 角色需在此处补 isInScope"。这是隐式合约，权限矩阵任何修改都会破坏。
- **后续命中**：[audit-03-payment-flow.md §5 CC3](./audit-03-payment-flow.md) — 03 域确认 admin.recordPayment 仍未补 isInScope，依赖权限矩阵兜底；admin.confirmOfflinePayment 也无 isInScope 但用 scopeCondition 做 WHERE 过滤，更安全。

### Client 端 scanDetail 类无鉴权"枚举式"接口
- **首次发现**：[audit-02-order-creation.md §5 CC4](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：`clientApi/routes/order.js:51 scanDetail` 未调 `requirePhone()` 守卫，只校验订单 `opened_by IS NOT NULL`，任何已登录用户可枚举 saleOrderId 看他人订单。
- **后续命中**：—（待 06 预约扫码 验证）

### Staff 业务路由 store/scope 完全无过滤（cross-store 全局读/改）
- **首次发现**：[audit-10-customer-member-level.md §3.1 P0-10-01/02/03/04](./audit-10-customer-member-level.md)
- **域**：10 (customer-member-level)
- **现象**：`staffApi/routes/customer.js` 中
  - `detail (242-342)` / `calendar (146-237)` / `giftHistory (748-834)` / `refundHistory (675-741)` / `updateNotes (839-858)` 完全无 store_id 或 bound_store_id 过滤
  - `assign (892-920)` 仅 `requireManager` 但 UPDATE WHERE 不校验顾客 `bound_store_id ∈ scope`
  - 与同模块 `paidOrders (425-433)` 强制 `o.store_id = $effectiveStoreId` 形成 module 内双轨实现
- **波及**：与"middleware scope 注入但 SQL 不调用 helper"是同源问题（CC3 第一条）但更严重——这里完全没有任何 store 维度的 WHERE。修复需引入 `assertCustomerInScope()` helper 并强制 lint。
- **后续命中**：
  - [audit-11-refunds.md §3.1 P0-11-05](./audit-11-refunds.md) — 11 域再确认：`customer.refundHistory` 完全无 store 维度过滤，暴露的退款金额/原因/SKU 比 detail/calendar 更敏感（财务级 PII）
  - [audit-11-refunds.md §3.2 P1-11-09](./audit-11-refunds.md) — admin `estimateRefundOverdraft(userId, refundAmount, originalSaleOrderId)` 仅 requirePermission，不校验 userId/originalSaleOrderId 属于 session scope，可枚举任意顾客 12 月消费 + member_level + 已用 upgrade-coupon 列表（券号 + discount_value）
  - [audit-13-coupons.md §3.1 P0-13-08](./audit-13-coupons.md) — admin `actions/coupons.ts:106 getAvailableCoupons(clientUserId, totalAmount, storeId)` 仅 `requirePermission(session, 'sale_order:create')`，传入 clientUserId 不校验属于 session scope；任何 admin 用户可枚举任意顾客的全部 user_coupons + 模板（含 face_value_override 真实面值），与 estimateRefundOverdraft 同模式。建议加 `assertCustomerInScope(session, clientUserId)` helper 并应用所有 `clientUserId` 传参的查询路径
  - [audit-19-gift-share-assign.md §3.1 P0-19-01/P0-19-02](./audit-19-gift-share-assign.md) — 19 域再次复现 `customer.assign` UPDATE 不校验顾客 `bound_store_id ∈ scope`（员工同店校验只能阻止"分配给非本店员工"，但不能阻止"把别店顾客拉进来"），多店店长可跨店分配；`customer.giftHistory` 完全裸 SQL 零 store 过滤（与 mgmtCustomer.giftHistory 走 validateScope 形成模块内双轨）。建议把所有 `customer.*`（门店模式）路由收口到 `mgmtCustomer.*`（管理层 + scope 校验）实现
  - [audit-20-pickup.md §3.1 P0-20-02 + P1-20-02](./audit-20-pickup.md) — staff `order.createPickup` 仅 `requireStaffBound()`（非 `requireManager()`），任何已绑手机员工（含美容师 / 推广师）都能代客提货；UPDATE WHERE 缺 `item_direction='购买'` 守卫，"退出/转出"行可被反向"提货"造成方向语义崩坏。与"业务路由 store/scope 完全无过滤"同源（"业务路由 middleware 守卫缺位"）但角度更具体：缺业务方向守卫

### Client 路由忘记 requirePhone() 而仍读 ctx.auth.userId
- **首次发现**：[audit-06-appointment-checkin.md §3.1 P0-06-01](./audit-06-appointment-checkin.md)
- **域**：06 (appointment-checkin)
- **现象**：`clientApi/routes/appointment.js:131-179 list / 185-221 cancel` 仅依赖默认 auth 中间件即直接 `const { userId } = ctx.auth`，但 auth 中间件在未注册用户时 `userId: null`（`middleware/auth.js:53-61`）。同模块的 `create` 显式调 `await requirePhone()(ctx, async()=>{})`，list/cancel 漏调形成防线缺口。
- **波及**：未绑定手机号 / 解绑后用户对预约接口仍可调；`appointment.cancel` 配合 P0-06-02 无 CAS 可越权重写。其他 client 路由（service.list / coupon.list / points.balance / message.list 等）需相同 grep 自检。
- **后续命中**：
  - [audit-13-coupons.md §1](./audit-13-coupons.md) — 13 域 sweep 结果：client `coupon.list` / `coupon.available` 已加 `requirePhone()` ✅，未命中此模式

### admin Server Action 用相邻动作权限项替代独立 cancel/reject 等
- **首次发现**：[audit-06-appointment-checkin.md §3.1 P0-06-05](./audit-06-appointment-checkin.md)
- **域**：06 (appointment-checkin)
- **现象**：`admin/actions/appointments.ts:248-250 cancelAppointment` 用 `requirePermission(session, 'appointment:confirm')`，PERMISSION_MATRIX 没有 `appointment:cancel` 项。"确认权"角色自动拥有"取消权"，权限语义错位。
- **波及**：所有 admin actions 凡是不在 PERMISSION_MATRIX 单独声明动作的"复用相邻 action"模式都有此风险（待 11 退款 reject、12 解绑 reject、13 优惠券 expire、19 客户分配 等域核查）。
- **后续命中**：
  - [audit-11-refunds.md §1 + §3.2](./audit-11-refunds.md) — 11 域 `rejectRefund` 与 `approveRefund` 共用 `'sale_order:refund'`，不分离审批/驳回权限项；finance 角色拥有审批退款 + 同时拥有驳回退款的权力，与"双人审核"理念背道（如未来需要分权要补独立 action）

### payNotify 完全无任何鉴权 / 签名校验（最严重 CC4 命中）
- **首次发现**：[audit-04-pay-notify.md §3.1 P0-04-01](./audit-04-pay-notify.md)
- **域**：04 (pay-notify)
- **现象**：`fengyu-client/cloudfunctions/payNotify/index.js:38-46` 入口直接信任 event.{orderNo, transactionId, payAmount, paymentMethod}，无微信 V2/V3 签名校验、无 AEAD_AES_256_GCM 解密、无 NotifyURL 来源校验、无 NODE_ENV 守卫。任何小程序 page（同 envId）通过 `wx.cloud.callFunction({name:'payNotify',data:{orderNo,...}})` 即可伪造支付落账。
- **波及**：资金 P0 全栈（命中 real.md #3 支付幂等 + #5 后端鉴权）；下游业绩、积分、储值卡、顾客等级、share-gift 全部触发
- **后续命中**：—（仅本域；其他域无类似第三方回调入口）

---

## CC5 错误码与错误前缀

### Admin throw Error 不带 4 种规范前缀
- **首次发现**：[audit-01-auth.md §3.3 P2-ERROR-12](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：staff/client 用 `UNAUTHORIZED:` / `PHONE_REQUIRED:` / `INVALID_PARAMS:` / `PERMISSION_DENIED:`；admin 多裸 `throw Error(msg)`
- **后续命中**：[audit-02-order-creation.md §3.3 P2-02-17](./audit-02-order-creation.md) — admin orders 全部错误为中文字符串无前缀

### staff/client 自定义错误前缀偏离 4 种约定
- **首次发现**：[audit-02-order-creation.md §3.3 P2-02-17](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：staff/client 大量自定义前缀（`CLIENT_NOT_REGISTERED:`、`INSUFFICIENT_BALANCE:`、`MIXED_PAYMENT_NOT_SUPPORTED:`），不在 4 种约定 `UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED` 内。前端按前缀 toast 文案映射会落入"未识别错误"分支。
- **后续命中**：
  - [audit-03-payment-flow.md §3.3 P2-03-14](./audit-03-payment-flow.md) — 03 域 admin.recordPayment 错误码（`OVERPAY:`、`INSUFFICIENT_BALANCE:`、`CONCURRENT_CHANGED`、`REF_ORDER_NOT_FOUND`）也不在 4 约定内
  - [audit-04-pay-notify.md §3.3 P2-04-14](./audit-04-pay-notify.md) — payNotify 抛 `INVALID_PAY_AMOUNT:` / `INSUFFICIENT_BALANCE:`

---

## CC6 PII / 敏感数据

### 三端日志 / 错误均含完整 OPENID / 手机号 / 身份证
- **首次发现**：[audit-01-auth.md §3.1 P0-PII-06](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：`operation_logs.detail` 含完整 phone/openid；错误堆栈带原始参数
- **波及**：合规风险；audit log 被读取即泄露
- **后续命中**：
  - [audit-04-pay-notify.md §3.1 P0-04-04](./audit-04-pay-notify.md) — payNotify/index.js:39 `console.log('[payNotify] received event:', JSON.stringify(event))` 接入真实回调后会输出 V3 解密载荷中的 payer.openid + 商户订单 + 金额明细

### 三端均缺中国手机号格式校验
- **首次发现**：[audit-01-auth.md §3.1 P0-PHONE-05](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：直接信任 cloudId 解密结果或 admin 入参；无 `/^1[3-9]\d{9}$/` 二次验证
- **后续命中**：—（待 admin 顾客创建/编辑、staff customer 模块验证）

---

## CC7 时间字段责任

### 三端时区不一致：UTC vs PG NOW vs Asia/Shanghai
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-02](./audit-02-order-creation.md)
- **域**：02 (order-creation)
- **现象**：admin 订单号 dateStr 用 `to_char(NOW(), 'YYMMDD')`（PG 服务器时区）；staff/client 用 `new Date().toISOString().slice(2,10)`（UTC 强制）。北京时间 00:00–08:00 三端可能算出不同 dateStr，跨午夜窗口可重号。
- **波及**：所有"按日计数"的字段 / 报表（订单号、流水号、操作日志、看板时间维度）。
- **后续命中**：
  - [audit-05-service-order.md §3.2 P1-05-14](./audit-05-service-order.md) — staff `generateServiceOrderId` 用 `Date#toISOString().slice(2,10)`（UTC），admin 用 `to_char(NOW(),'YYMMDD')`（PG 时区），北京时间 00:00–08:00 跨午夜窗口两端服务单号段不同步。
  - [audit-06-appointment-checkin.md §3.2 P1-06-07](./audit-06-appointment-checkin.md) — staff appointment.list todayOnly 用 `new Date().toISOString().slice(0,10)` (UTC)，admin 用 `appointment_time >= CURRENT_DATE` (PG 时区)，client.create 用 `+08:00` 字面量。三端"今日"集合在跨午夜窗口期不一致。

---

## CC9 测试与迁移残留

### Schema 字段声明每日重算但无 cron STEP 实现
- **首次发现**：[audit-10-customer-member-level.md §3.1 P0-10-05](./audit-10-customer-member-level.md)
- **域**：10 (customer-member-level)
- **现象**：`db/schema/user.ts:57 monthlyActivity` docstring 声明"每日凌晨3点根据当月已完成服务单计算"，但 `fengyu-admin/src/cron/run.ts:28-34` 注册的 6 个 STEP 中**没有任何一个写 monthly_activity 列**。admin filter 永远命中 NULL，配套测试 `customers.test.ts:541` 仅断言"调用 eq" → 形式上通过实际功能空。
- **波及**：与 audit-06 P0-06-04（appointment 过期关闭实现缺失）同源——schema/spec 与代码同步问题，需在每个域审计时穷举 schema docstring "由 cron 维护" / "每日重算" / "由后端定时任务" 等关键字。
- **后续命中**：—

### Schema migration 删除列后应用层未跟进（admin runtime 失败）
- **首次发现**：[audit-14-prepaid-card.md §3.1 P0-14-01](./audit-14-prepaid-card.md)
- **域**：14 (prepaid-card)
- **现象**：`db/migrations/0003_abandoned_aqueduct.sql:52` 删除了 `prepaid_cards.store_id` 列，并把 UNIQUE 索引由 `(user_id,store_id)` 改为 `(user_id)`。staff `routes/order.js`、payNotify、client `routes/order.js` 都已对齐（无 store_id 引用），但 admin `actions/orders.ts:91-98` `applyRechargeOnOrderPaid` 与 `:1424-1430` `createConversionOrder` 仍写 `INSERT INTO prepaid_cards(card_id, user_id, store_id, balance) ... ON CONFLICT (user_id, store_id)`，运行时必抛 `42703 column "store_id" does not exist`。admin 测试 `orders.test.ts:553` 注释 "非充值订单：order 查询返回无 clientUserId，applyRechargeOnOrderPaid 提前 return"——**测试绕过该 branch**，所以 CI 不报错。
- **波及**：admin 替顾客确认含虚拟充值 SKU 订单 100% 失败 + admin createConversionOrder 差额退余 100% 失败
- **修复**：检查迁移 0003 的字段删除影响，所有 `applyRecharge` / `createConversion` 路径同步改为 `(user_id)`
- **后续命中**：—（建议穷举 0003 之后的所有 ALTER DROP / RENAME，对照 admin/staff/client 三端代码核对）

### Spec 状态机存在但实现缺失（appointment 过期关闭）
- **首次发现**：[audit-06-appointment-checkin.md §3.1 P0-06-04](./audit-06-appointment-checkin.md)
- **域**：06 (appointment-checkin)
- **现象**：`db/schema/appointment.ts:14` 与 `.42cog/pm/backend.pr.spec.md:709-710` 都规定 `待确认/已确认 → 已关闭（超过预约时间一天未到店）`。全仓 grep 唯一一处写入是 `staffApi/routes/service.js:380` 在次数归零时关闭同 sale_item 预约，**无任何 cron / 触发器 / 应用层定时任务实现"超期关闭"**。`fengyu-admin/src/cron/steps/` 目录 5 STEP 均无该任务。
- **波及**：spec 与代码同步有更广覆盖问题；后续每个域应在审计时把"spec 5.x 状态机"与代码实际写入路径做穷举对比。
- **后续命中**：—（待 02/05/11 等所有有状态机的域复核）

### v3.3 `operator_user_id` → `operator_employee_id` 迁移完整性
- **首次发现**：[audit-01-auth.md §3.2 P1-MODEL-10](./audit-01-auth.md)
- **域**：01 (auth)
- **现象**：需验证 `operation_logs` 表是否还残留 `operator_user_id` 列以及是否有写入路径未迁移
- **验证 SQL**：见 audit-01-auth §8 #1
- **后续命中**：—（域 23 操作日志专题审计时收尾）

### 已废弃路由 / 死代码持续残留
- **首次发现**：[audit-09-product-sku.md §3.3 P2-09-12](./audit-09-product-sku.md)
- **域**：09 (product-sku)
- **现象**：staff `product.promotionList` / `product.promotionPlans` 永远返回空数组 `{ schemes: [] }` / `[]`，但仍在 `staffApi/index.js:54-55` 注册路由 + `miniprogram/mock/product.ts:222` 留有 mock。注释明确"已迁移至 PG，原 WorkFine 促销查询已废弃"。
- **波及**：迁移残留治理；建议每轮审计在 §5 CC9 grep 类似 "stub" / "已废弃" / "已迁移" / "WorkFine 同步" 等关键字。
- **后续命中**：—

### 测试用例锁死错误行为（rate=0 静默写入）
- **首次发现**：[audit-08-service-commission.md §5 CC9](./audit-08-service-commission.md)
- **域**：08 (service-commission)
- **现象**：staff `service.test.js:814-843` 含 rate=0 写入用例，断言 `commission_amount=80`（仅 fixed_fee）+ "service_commissions 依然被写入"，相当于**测试反向锁死了 P0-08-03 的静默资损路径**。修复 P0-08-03 时必须同步修测试。
- **波及**：测试覆盖率不能只看通过数；锁死错误行为的用例需在审计中识别并标记。
- **后续命中**：—（待其他域审计中识别类似"测试锁死错误行为"的反模式）

---

### admin getMessagesPaginated 完全无 scope 过滤
- **首次发现**：[audit-16-message-center.md §3.1 P0-16-03](./audit-16-message-center.md)
- **域**：16 (message-center)
- **现象**：`fengyu-admin/src/actions/messages.ts:46-50, 62-92` 注释明确写 "messages 表无 store_id，不走 scope 过滤"，仅靠 `requirePermission(session, 'message:list')` 单点防御。recipient_type='客户' 已 leftJoin clientWechatUsers + 'staff' 已 leftJoin staffWechatUsers，所有顾客/员工 PII 暴露面在表层，仅由 PERMISSION_MATRIX 仅授 admin 一线兜底。
- **后续命中**：—（与 audit-10 P0-10-01 staff 顾客 scope 不同：admin 是单点权限风险，staff 是路由直接缺 scope）
- **修复**：(L7) recipient_type='客户' 时 JOIN clientWechatUsers + scopeCondition；recipient_type='员工' 时 JOIN staffWechatUsers + scopeCondition

### 错误前缀缺 NOT_FOUND/PERMISSION_DENIED 区分（client 读私域）
- **首次发现**：[audit-16-message-center.md §3.3 P2-16-12](./audit-16-message-center.md)
- **域**：16 (message-center)
- **现象**：client `routes/message.js:46` UPDATE rowCount=0 静默 success，调用方无法区分"已读" / "不存在" / "他人的"。错误码体系缺失 NOT_FOUND/PERMISSION_DENIED 路径。
- **后续命中**：—（与 client 全量读私域路由（points/card/coupon/order）应一并审计；属 audit-15/14/13 后续小整改）

## CC4 后端鉴权（追加）

### Client 私域读接口 requirePhone 守卫覆盖率不全
- **首次发现**：[audit-15-points-member-level.md](./audit-15-points-member-level.md) — points balance/history 缺
- **后续命中**：
  - [audit-16-message-center.md §3.1 P0-16-01](./audit-16-message-center.md) — client message.list/read/unreadCount **三接口同时缺** requirePhone 守卫；与 card.balance / card.history 已挂的标准不一致；属横切"私域读接口守卫一刀切"模式
- **修复**：在 `clientApi/index.js` 路由层维护一个 `phoneRequiredRoutes` 集合（与 `publicActions` 对偶），自动 wrap requirePhone()

## CC2 并发幂等（追加）

### admin 批量写不带 idempotency_key
- **首次发现**：[audit-16-message-center.md §3.1 P0-16-02](./audit-16-message-center.md)
- **域**：16 (message-center)
- **现象**：`fengyu-admin/src/actions/messages.ts:460-475` `batchSendMessages` 循环构造 values 不写 idempotency_key；`uq_messages_idempotency_key` partial unique 因 NULL 完全无效。重试 / 双 tab / Server Action retry 直接重复写。
- **后续命中**：—（admin batch* 类操作（couponBatchIssue / batchAssign / employeeBulkImport）应一并核查）
- **修复**：每批生成 batchId UUID，每行 idempotency_key=`batch-${batchId}-${userId}`

### admin 物理硬删 vs 软删双轨（金融级流水）
- **首次发现**：[audit-15-points-member-level.md](./audit-15-points-member-level.md) — point_transactions 软删与硬删不一致
- **后续命中**：
  - [audit-16-message-center.md §3.2 P1-16-08](./audit-16-message-center.md) — admin `deleteMessage` 物理硬删 messages，无 deleted_at；logOperation detail 不写 title/recipient_id；删除后无法回查
- **修复**：消息表加 `deleted_at`；deleteMessage 软删；logOperation detail 写实体快照

## CC1 数值精度与金额（追加）

### 同 metric 三端实现各写一套，权威口径文档与代码失同步
- **首次发现**：[audit-08-service-commission.md §3.2 P1-08-14](./audit-08-service-commission.md)
- **后续命中**：
  - [audit-17-dashboard.md §3.1 P0-17-01 / P0-17-02 / P0-17-03](./audit-17-dashboard.md) — 17 域：admin getDashboardStats `today_revenue` 用 `SUM(total_amount)`、`today_visitors` 用 `sale_orders.sale_order_datetime`，与 metrics.md 权威口径（业绩 = SUM(paid_amount)、客流 = service_orders 维度）+ mgmt-dashboard summary 实现完全脱钩；同时缺 `sale_order_type IN ('销售单','转换单')` 过滤导致**退款单 paid_amount 流入业绩**（与 audit-07 P0-07-02 / audit-11 P0-11-01 退款不冲销叠加形成系统性资损）
  - [audit-17-dashboard.md §3.2 P1-17-07](./audit-17-dashboard.md) — staff.dashboard 店长分支 revenue 用 `SUM(si.received)` 与 mgmt-dashboard `SUM(paid_amount)` 不同 → 同店长在 admin / 员工端工作台 / mgmt-dashboard 看到 3 个不同业绩数字
- **修复**：抽 `db/helpers/dashboard-metrics.ts`（或 db function）作为唯一聚合实现；admin/staff mgmt/staff 工作台禁止各自写 SUM 类 SQL（参见 audit-08 P0-08-06 / audit-15 P0-15-02 同样 helper 收敛诉求）

### 「业绩」是否含退款单 / 内部单的 SUM 入口口径不一
- **首次发现**：[audit-17-dashboard.md §3.1 P0-17-02](./audit-17-dashboard.md)
- **域**：17 (dashboard)
- **现象**：mgmt-dashboard summary 全部用 `sale_order_type IN ('销售单','转换单')`；admin getDashboardStats 全部漏过滤；staff.dashboard 美容师分支走 sa（含 audit-07 P0-07-02 不冲销资损）。三端三套口径，业务对账时无法解释差异。
- **波及**：所有 SUM(paid_amount) / SUM(received) / SUM(total_amount) 类 dashboard 接口
- **修复**：与 S17-1 一致，DB 视角只承认"业绩 = SUM(paid_amount) WHERE status='已支付' AND sale_order_type IN ('销售单','转换单')" 单一公式

## CC3 组织域数据隔离（追加）

### 模块级（云函数实例级）缓存跨账号数据共享
- **首次发现**：[audit-17-dashboard.md §3.1 P0-17-04](./audit-17-dashboard.md)
- **域**：17 (dashboard)
- **现象**：mgmt-dashboard `loadAllMarkets` 5 分钟模块级 CACHE 是 HQ 视角全量；scopeOptions 事后过滤是干净的，但缓存窗口期内组织变更对市场账号可见性延迟；与 staff auth 中间件 5 分钟缓存（`middleware/auth.js:21-22`）配合时漂移窗口扩大到 10 分钟。
- **波及**：所有云函数模块级缓存（如 productCache / categoryCache 等模式），需穷举验证是否存在"以 HQ 视角缓存 + 在路由层事后过滤"反模式
- **修复**：模块级 CACHE 必须按 ctx.auth 维度分桶（OPENID / staffWfId），或在 admin 写入路径加 invalidate hook

### staff.dashboard 一线员工 newMember 跨店越权
- **首次发现**：[audit-17-dashboard.md §3.1 P0-17-06](./audit-17-dashboard.md)
- **域**：17 (dashboard)
- **现象**：staff.js dashboard 美容师分支 5 指标里 4 个限定 `assigned_employee_id` + `service_orders.store_id`（隐式经 service_orders.store_id），唯独 newMember 仅 `c.bound_employee_id` 无 store_id 过滤；员工调店后 A 店历史顾客的 became_member_at 仍计入新店统计。
- **修复**：newMember SQL 加 `c.bound_store_id = effectiveStoreId`，与其他 4 指标对齐
- **后续命中**：
  - [audit-18-employee-performance.md §3.2 P1-18-08](./audit-18-employee-performance.md) — 18 域绩效视角再次确认；同时确认 performanceDetail / dashboard 使用 `assigned_employee_id` vs `bound_employee_id` 双归属字段在 staff 端持续漂移

### staff.performanceDetail / todayCommission / monthlyCalendar 全无 store/scope，manager 跨店读他人绩效
- **首次发现**：[audit-18-employee-performance.md §3.1 P0-18-02](./audit-18-employee-performance.md)
- **域**：18 (employee-performance)
- **现象**：performanceDetail 仅 `requireStaffBound`（无 `requireManager`），收到 employeeId 后零校验；同时 sa 与 sc 关联的 sale_orders.store_id / service_orders.store_id 均不在 WHERE。任意 manager 拿到他店员工 employeeId 即可读他店历史 sa/sc 全集 + 顾客姓名 + 顾客手机号。
- **波及**：与"Staff 业务路由 store/scope 完全无过滤"（顶部条目）同根；本节为绩效（非顾客）维度的对应表现。修复需新增 `assertEmployeeInScope(session, employeeId)` helper，跟 `assertCustomerInScope` 同构。
- **修复**：performanceDetail 入口判定 `queryEmployeeId !== ctx.auth.staffWfId` 时强制 manager + 校验 target 员工的 store_id ∈ scopeStoreIds；同时 sa/sc 双 SQL 加 `o.store_id = ANY($scopeStoreIds)` / `so.store_id = ANY($scopeStoreIds)`

## CC7 时间字段责任（追加）

### 三端"今日 / 本月"边界仍然漂移（17 域再次命中）
- **首次发现**：[audit-02-order-creation.md §3.1 P0-02-02](./audit-02-order-creation.md)
- **后续命中**：
  - [audit-05-service-order.md §3.2 P1-05-14](./audit-05-service-order.md) — 服务单号
  - [audit-06-appointment-checkin.md §3.2 P1-06-07](./audit-06-appointment-checkin.md) — 预约 today
  - [audit-17-dashboard.md §3.2 P1-17-08](./audit-17-dashboard.md) — staff.dashboard 用 `new Date(...)` 容器时区 + `.toISOString()` UTC；mgmt-dashboard 用 `$date::date`（业务传值）；admin 用 `CURRENT_DATE`（PG NOW）。三端跨午夜窗口（0:00~8:00 北京）"今日"互不一致
  - [audit-18-employee-performance.md §3.1 P0-18-03 / §3.2 P1-18-07](./audit-18-employee-performance.md) — performanceDetail **同函数内**销售分支 `paid_at >= [JS Date,+1d)` (容器时区) 与服务分支 `service_date BETWEEN [str, str]` (PG date) 双时间区间语义；monthlyCalendar 同时混用 JS 容器时区 + UTC ISO + PG `DATE()` 三层漂移。绩效"今日"和服务"今日"可能算到不同业务日，导致同一员工同一日两口径不可对账。
- **统一修复**：S02-3 设置 `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'` 后所有 `new Date()` / `NOW()` / `CURRENT_DATE` 自动对齐；但 staff.js 仍需一并切到 PG 端而非 JS Date

## CC9 测试与迁移残留（追加）

### dashboard 测试不断言"三端口径一致"
- **首次发现**：[audit-17-dashboard.md §5 CC9](./audit-17-dashboard.md)
- **域**：17 (dashboard)
- **现象**：`fengyu-admin/src/actions/dashboard.test.ts` 256 行，覆盖 admin 业务/系统分支多种角色，但**不断言** today_revenue 与 mgmt-dashboard.summary 口径一致；mgmt-dashboard.js 1507 行**完全无独立测试**
- **波及**：所有"分布式权威口径"模块（dashboard / commission / 退款金额拆分）应有"跨实现一致性"测试
- **修复**：新建 `dashboard.consistency.test.ts`，固定一组 fixture 在 5434/fengyu 跑出 admin/mgmt/staff.dashboard 三套数字，断言核心字段全相等（业绩、实耗、客流、新会员）

## CC6 PII 敏感数据（追加）

### admin 端列表 / 详情直显 recipientId / recipientName 无脱敏
- **首次发现**：[audit-16-message-center.md §3.1 P0-16-03 / §5 CC6](./audit-16-message-center.md)
- **域**：16 (message-center)
- **现象**：messages 详情 Dialog 在 `messages-page.tsx:478-484` 完整展示 recipientType + recipientName + recipientId（顾客 user_id text）；批量发送 `getCustomersForBatchMessage` 列表也直显 phone（`messages-page.tsx:703`）；admin 端无脱敏 helper（既无 maskPhone 也无 maskUserId）
- **后续命中**：—
- **修复**：与 audit-01 计划项"`db/helpers/phone.ts` mask 系列"合并；admin 列表展示按角色脱敏（仅 admin 看完整，其他角色看 138****8888）

## 来自域 21 / 22 / 23 的归集（2026-04-26 并行批次）

### CC-CAST-001 PG text 列被错误 cast 为 uuid[]
- **首次发现**：[audit-21-org-structure.md](./audit-21-org-structure.md)
- **域**：21 (org-structure)
- **现象**：`org_nodes.id` / `stores.org_node_id` 在 schema 中均为 text，但 staff `utils/scope.js:108-122` 用 `ANY($1::uuid[])` 强制 cast，触发 PG 22P02。所有走 expandScopeStoreIds 的市场/门店级 manager 路由全部失效。

### CC-PARENT-VALIDATION-001 邻接表 update 路径不校验 newParent
- **首次发现**：[audit-21-org-structure.md](./audit-21-org-structure.md) (admin/actions/org.ts:122-171 updateOrgNode)
- **域**：21 (org-structure)
- **现象**：createOrgNode 有 type/scope/父类型校验，updateOrgNode 完全没有。可制造环路、跨类型、越权挪节点。

### CC-DUAL-WRITE-001 org_nodes.name vs stores.store_name 双写脱钩
- **首次发现**：[audit-21-org-structure.md](./audit-21-org-structure.md) (admin/actions/stores.ts:154-217 updateStore)
- **域**：21 (org-structure)
- **现象**：createStore tx 内双写一致初值；updateStore 仅改 stores 表；admin org tree / 权限分配 UI 走 org_nodes.name，列表/选择器走 stores.store_name，名称改动后两 UI 漂移。

### CC4 后续命中：assignRole scope.type 校验缺失 + 集合相等而非子树
- **后续命中**：[audit-22-permission-matrix.md §3.1 P0-22-01/02](./audit-22-permission-matrix.md)
- **域**：22 (permission-matrix)
- **现象**：admin/actions/permissions.ts:184-201, 263-269 仅 admin 校验 type；非 admin 用 includes(scopeId) 集合相等，hr 无法在自身子树内分配
- **与首次发现关联**：audit-01 P1-PERM-07 + audit-02/03 admin scope 隐式合约

### CC4 后续命中：staff requireManager 旧数据 fallback 越权
- **后续命中**：[audit-22-permission-matrix.md §3.2 P1-22-07](./audit-22-permission-matrix.md)
- **域**：22 (permission-matrix)
- **现象**：fengyu-staff/cloudfunctions/staffApi/middleware/auth.js:259-272 scopeType 缺失时退化到 roles.includes('manager')，绕过"门店"约束

### CC9+CC4 staffApi 全域审计日志缺位（域 23 收口）
- **首次反复命中**：audit-11 / 12 / 19 / 20
- **收口**：[audit-23-operation-logs.md §3.1 P0-23-01](./audit-23-operation-logs.md)
- **域**：23 (operation-logs)
- **根因**：staffApi 无审计 helper、无规范；12 routes 仅 service.js 一处显式写 operator 字段
- **量化**：admin ≈75 写入点 vs staff 3 + client 2 + payNotify 2 = 三端非 admin 总计 7 处
- **修复路径**：新建 staffApi/utils/audit.js + clientApi/utils/audit.js helper

### detail JSON schema 三端漂移
- **首次发现**：[audit-23-operation-logs.md](./audit-23-operation-logs.md)
- **域**：23 (operation-logs)
- **现象**：admin `_v:2,_t:'update'/'transition'` vs staff/client/payNotify `_v:1` flat vs cron `_v:3,_t:'transition'` 自定义；admin /logs LogDetail 仅按 v2 渲染，其他 schema 降级原始 JSON pre

### CC9 RESOLVED：v3.3 operator_user_id → operator_employee_id 迁移完成
- **收口**：[audit-23-operation-logs.md](./audit-23-operation-logs.md)
- **域**：23
- **结论**：运行时代码 0 残留；仅 db/migrations/_archive_pre_baseline_2026_04/ 命中。audit-01 P1-MODEL-10 关闭。

---

## 来自域 24 / 25 / CC1 的归集（2026-04-26 第二并行批次）

### CC5 后续命中：admin 新增非约定错误前缀 INVALID_PRODUCT_KIND:
- **后续命中**：[audit-24-product-category-dynamic.md §5 CC5](./audit-24-product-category-dynamic.md)
- **域**：24 (product-category-dynamic)
- **现象**：admin actions/products.ts:328 / 377 createCategory/updateCategory 用 `INVALID_PRODUCT_KIND:` 自定义前缀，不在 4 项约定内

### CC9 后续命中：dead column / dead config — 写入但全链路不消费
- **后续命中**：[audit-24-product-category-dynamic.md §3.3 P2-24-11](./audit-24-product-category-dynamic.md)
- **域**：24
- **现象**：`product_categories.display_icon` 列：admin 表单写入 ✓ + admin types 透出 ✓，但 staff/client/前端三端均无 SELECT 也无渲染消费，等效暗坑

### CC9 新发现：测试锁死 magic string 阻断 spec 演进
- **首次发现**：[audit-24-product-category-dynamic.md §3.3 P2-24-12](./audit-24-product-category-dynamic.md)
- **域**：24
- **现象**：staff `__tests__/routes/recalc-customer-type-sql.test.js:78,104` expect SQL 含字面量 `<> '充值卡'` — 改名"充值卡"则测试自动挂掉，迫使开发者反向放弃 DB 驱动诉求

### CC9 新发现：前端硬编码字面量数组与 DB 驱动 schema 矛盾
- **首次发现**：[audit-24-product-category-dynamic.md §3.2 P1-24-08](./audit-24-product-category-dynamic.md)
- **域**：24
- **现象**：admin `order-create-page.tsx:42-44` PRODUCT_KIND_CHOICES 字面量；staff `product.js:29` CARD_PRODUCT_KINDS 同源；DB product_kind 设为 text 自由扩展但前端没跟进

### CC2 后续命中：状态字段级联缺失 — parent isValid 关闭后子级未级联
- **后续命中**：[audit-24-product-category-dynamic.md §3.1 P0-24-02](./audit-24-product-category-dynamic.md)
- **域**：24
- **现象**：updateProductKind 停用一级行不级联子级 isValid

### 新主题：前端 UI 文本字符串错传后端 ID 字段（CC4 + CC8 主线）
- **首次发现**：[audit-25-traffic-promoter.md §3.1 P0-25-02](./audit-25-traffic-promoter.md)
- **域**：25 (traffic-promoter)
- **现象**：client store-detail "推荐人姓名" UI van-field 收集人类可读文本，TS 直接 `promoterEmployeeId: promoterName` 当员工编号传后端；后端 schema FK→staff_wechat_users.employee_id 必失败；同模式 audit-13 face_value_override 类型语义错位、audit-09 unitPrice 信任前端
- **建议**：建立"凡 schema 字段命名为 *Id / *EmployeeId / *SkuId 的 API 入参，前端 UI 必须用选择器/picker，禁止纯文本输入"硬规则

### 新主题：schema 字段写入路径完整但消费路径完全空白（CC9 spec 设计先行）
- **首次发现**：[audit-25-traffic-promoter.md §3.1 P0-25-05](./audit-25-traffic-promoter.md)
- **域**：25
- **现象**：promoter_employee_id 在 client/admin 写入路径齐全，业绩消费/统计路径 0 处实现
- **同源问题**：audit-10 P0-10-05（monthly_activity 声明每日重算但无 cron STEP）、audit-06 P0-06-04（appointment 过期关闭 spec 但代码缺失）
- **建议**：每域审计 §5 CC9 grep schema docstring "由 cron 维护"/"业绩"/"推荐人" 等关键字 + 代码消费路径对照

### CC4 后续命中：admin search* 选择器零 scope（与 list/getX 双轨）
- **后续命中**：[audit-25-traffic-promoter.md §3.1 P0-25-03](./audit-25-traffic-promoter.md)
- **域**：25
- **现象**：admin `searchEmployees` (employees.ts:73-102) 完全无 scope 过滤；同文件 `getEmployees` (line 52) 有 scopeCondition ✅。"主管理列表"和"选择器搜索"双轨实现风险
- **建议**：grep admin/src/actions/*.ts 所有 `search*` 函数补 scopeCondition 或独立 `searchInScope*` 命名

### CC1 横切收官（[audit-CC1-numeric-precision.md](./audit-CC1-numeric-precision.md)）
- **角色**：本身就是 CC1 收官报告，不再向 CC1 段追加新条目
- **5 个 P0 摘要**：(1) sale_allocations.allocationRatio 实为 NUMERIC(5,2) 而 PLAN 写 (5,4) 且无 CHECK，admin 信任前端可写 9.99 → 业绩 ×10 倍资损；(2) sale_orders 退款单四金额列、card_transactions、point_transactions 三处全无符号 CHECK；(3) admin batchSaveServiceCommissions / createOrder 持久化前端金额不二次重算违反 real.md #2/#5；(4) admin toFixed (banker) vs staff/client Math.round (远离零) 0.005 边界差 1 分；(5) 33 NUMERIC 列仅 9 非负 CHECK，5 大不变量（saleAmount/payableAmount/commissionAmount/balance/paid）全无 DB 守护
- **PLAN 校正项（2026-04-26 已决策）**：保留 `sale_allocations.allocationRatio = NUMERIC(5,2)` 不升级（业务上够用，admin/staff/client 现有计算无需小数 4 位精度），PLAN §3 CC1 第 3 项措辞已校正。S-CC1 系列建议中涉及"批量 ratio 类型升级"的子项作废，仅保留 IN-集合 CHECK（业绩可写 9.99 的资损通道仍需 CHECK 兜底）

---

## 跨域待统一改造项（汇总）

下列改动在多个域共用，最终汇总到 SUMMARY.md / SCHEMA-CHANGES.md 时合并 epic：

| 改造项 | 涉及域 | 优先级 | 预估工作量 |
|--------|--------|--------|-----------|
| 引入 `db/helpers/phone.ts` (validate + mask 系列) | 01, 后续大部分 | P0 | S |
| Staff 路由 scope 强制守卫（middleware assertion） | 01 + 全部 staff 业务域 | P0 | M |
| Client 路由 ownership 守卫（middleware）| 01 + 全部 client 业务域 | P0 | M |
| Admin `withPermission(action, fn)` HOF | 01 + 全部 admin 业务域 | P0 | M |
| 三端 logOperation 自动脱敏 PII | 01 + 全部域 | P0 | S |
| Admin 错误前缀统一 | 01 + 全部 admin 业务域 | P2 | S |
| 跨表 openid 唯一性约束 | 01 | P0 | M |
