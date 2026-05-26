# 横切问题归集（CROSS-CUTTING）

> 审计时间：2026-04-26 v3
> 来源：10 个域 v3 合并报告（audit-01 ~ audit-10）
> 合并规则：同问题跨域出现 → 归并；按出现频率排序；旧版条目保留并注明后续命中

---

## 1. 全仓穿透问题

### [X-BIG-01] `pg.query` 包装器丢弃 `rowCount` — CAS 保护全失效
- **根因文件**：`staffApi/db/pg.js:33-41`
  ```js
  async function query(sql, params = []) {
    const result = await client.query(sql, params)
    return result.rows   // ← 仅返回 rows 数组，丢弃 rowCount
  }
  ```
- **影响范围**（5 处，全部在 staffApi）：
  | 文件 | 行 | 方法 | 后果 |
  |------|----|------|------|
  | `routes/service.js` | 271 | `start` CAS UPDATE | 并发 start 两次均成功，无人报错 |
  | `routes/service.js` | 755 | `cancel` CAS UPDATE | 并发 cancel+complete，cancel 静默失败 |
  | `routes/customer.js` | 928 | `assign` UPDATE | 分配幂等失效 |
  | `routes/customer.js` | 987 | `updateNotes` UPDATE | 备注更新幂等失效 |
  | `routes/appointment.js` | 209 | `confirm` UPDATE | 预约确认幂等失效 |
- **来源**：audit-05（P0-V2-01），v3 合并确认为全仓穿透
- **对比**：`pg.transaction()` 内使用 `client.query()`（原始 PG client）正确返回 `rowCount`，不受影响
- **复现**：`result.rowCount === 0` → `undefined === 0` 为 `false`，CAS 守卫永远不触发
- **修复**：(L3) `pg.js` 增加 `queryWithCount(sql, params)` 返回 `{ rows, rowCount }`；或(L3) 将上述 5 处 UPDATE 移入 `pg.transaction()` 内使用 `client.query()`
- **风险等级**：P0 — 违反 real.md #3（并发幂等）+ #4（状态单向推进）

### [X-BIG-02] `payNotify` 代码引用 migration 0018/0019 已 DROP 的列 — schema drift
- **根因文件**：`fengyu-client/cloudfunctions/payNotify/index.js:127-287`
- **三处废弃列引用**：
  1. `SELECT ... paid_amount, wechat_transaction_id ... FROM sale_orders`（L127-129）
  2. `UPDATE sale_orders SET paid_amount = $2, wechat_transaction_id = ...`（L265-274）
  3. `UPDATE sale_orders SET wechat_transaction_id = COALESCE(...)`（L280-287）
  4. `order.sale_order_type === '回款单'`（L143, 221）— 该枚举值已从 `sale_order_type` 中移除
- **迁移依据**：
  - `0018_black_madrox.sql L36-37`：`DROP COLUMN paid_amount`、`DROP COLUMN wechat_transaction_id`
  - `db/schema/order.ts:72-73` 注释明确确认
  - `0019` 又加回部分枚举值，但代码引用的是列而非枚举
- **触发条件**：`PAYNOTIFY_DISABLED = false`（守卫解除）时，每次回调触发 PG `column "paid_amount" does not exist`，事务 ROLLBACK，订单永久卡在 `待支付`
- **来源**：audit-04（P0-04v2-03）
- **关联**：audit-03（P0-03v2-02）同源
- **修复**：(L3) 全量替换 `paid_amount → received`；删除 `wechat_transaction_id` 相关行；与 `2026-04-26-sale-order-domain-refactor.md` ticket 对齐
- **风险等级**：P0 — 守卫解除后状态机死锁，微信支付完全失效

---

## 2. 跨端一致性

### [X-CONS-01] `sale_items.unit_price` 三端写入语义分裂
- **出现频率**：3 个域（域 09、域 07、域 02）
- **三端口径**：
  | 端 | 赋值语句 | 语义 |
  |----|---------|------|
  | staff | `unitPrice = special_price \|\| price` | 实价写入标价字段 |
  | client | `unitPrice = price`（原价）| 原价快照 |
  | admin | `unitPrice = 前端传值` | 不重算，可篡改 |
- **来源**：audit-09（P1-09-04）
- **影响**：同一 SKU 写 `sale_items.unit_price` 值不同；BI 报表 `SUM(unit_price * quantity)` 不可信；退款比例拆分漂移
- **关联**：audit-07（域 07 P1-v2-07-03 同覆盖：`sale_items.unit_real_price` 三端同样分裂）
- **修复**：(L0/L3) 统一约定 `unit_price = sku.price`（原价）、`unit_real_price = special_price || price`（实价）；三端重构 `order.create`
- **风险等级**：P1

### [X-CONS-02] `commission_rate_matrix` 查询缺 `org_id` 过滤 — 跨市场费率误命中
- **出现频率**：2 个域（域 08、域 07）
- **现象**：`staff.service.complete` 查询矩阵无 `AND org_id = $X`；多市场下跨市场服务单误按全库 ORDER BY 命中错误费率
- **来源**：audit-08（P0-08-01）
- **关联**：admin UI `findMatchingRate` 正确按 orgName 过滤；staff 端无此过滤，两端口径不一致
- **修复**：(L3) `complete` 取 `so.market_name` 查 `org_nodes.id`，矩阵查询加 `AND org_id = $X`
- **风险等级**：P0 — 跨市场提成计算错误（资损）

### [X-CONS-03] `spending_tier` / `customer_type` 重算三端口径分裂
- **出现频率**：4 个域（域 10、域 08、域 04、域 03）
- **三种口径**：
  | 触发点 | SQL 公式 | 窗口 | sale_order_type |
  |--------|---------|------|----------------|
  | staff order.create | `SUM(total_amount)` | 无 | 无过滤 |
  | admin refunds.ts | `SUM(GREATEST(received - refunded_amount, 0))` | 无 | 仅销售单+转换单 |
  | cron member_level | 同上 | 12月滚动 | 仅销售单+转换单 |
  | payNotify | `SUM(total_amount)` 含回款单 | 无 | 无过滤 |
- **来源**：audit-10（P1-10-v2-06 / P1-10-v2-11）
- **关联**：域 15（P0-15-04/05）第三套口径叠加；域 17（P0-17-02）业绩口径与 member_level 混乱
- **修复**：(L0 决策) 统一为 `received - refunded_amount`、全量（无时间窗口）、仅销售单/转换单；与 `2026-04-26-sale-order-domain-refactor.md` ticket 对齐
- **风险等级**：P1 — 消费档位跨端不一致，运营数据失效

### [X-CONS-04] `customer.search` phone 分支无 scope 过滤
- **出现频率**：4 个域（域 01、域 10、域 07、域 06）
- **现象**：`WHERE c.phone = $1 AND c.bound_store_id IS NOT NULL` — 仅过滤已绑店，不过滤门店；任意员工可跨店搜索顾客 PII
- **来源**：audit-01（P0-03）、audit-10（P1-10-v2-12）
- **关联**：`keyword/默认分支` 有 `AND c.bound_store_id = $effectiveStoreId`；phone 分支遗漏
- **修复**：(L3) phone 分支追加 `AND c.bound_store_id = $2`（门店模式）或 `IN (scopeStoreIds)`（管理层模式）
- **风险等级**：P0 — 跨店 PII 泄露（域 10 detail/calendar/giftHistory/updateNotes/assign 共 5 个函数各有独立 P0）

### [X-CONS-05] staff `commissionRate` 当 `allocationRatio` 提交 — 前端字段语义错传
- **出现频率**：2 个域（域 07、域 08）
- **现象**：前端 `onSave` 直接把 `commissionRate`（来自矩阵，0.05~0.30）作为 `allocationRatio` 提交；后端 VALID_RATIOS 仅接受 `{0.10, 0.20, ..., 1.00}`
- **来源**：audit-07（P0-V2-07-01）
- **关联**：矩阵值 ∈ {0.10, 0.20, ..., 1.00} 时保存成功，但 `total_amount = received × 0.30`（应为 `received × 1.00 × 0.30`）→ 业绩少算约 70%
- **修复**：(L9) 前端 `AllocLine` 增加独立 `allocationRatio` 字段（默认 1.00）；suggest 返回 `allocationRatio: 1.00`
- **风险等级**：P0 — 员工业绩系统性少算（资损）

### [X-CONS-06] `order.create` 三端均不校验 `is_enabled` — 下架 SKU 可下单
- **出现频率**：3 个域（域 09、域 07、域 02）
- **现象**：三端 `order.create` 查询 SKU 不带 `AND is_enabled = true`；已下架 SKU 仍可落单
- **来源**：audit-09（P0-09-01）
- **修复**：(L3) staff/client/admin 三端 `order.create` 的 SKU 查询均追加 `AND is_enabled = true`；不匹配时抛 `INVALID_PARAMS: SKU ... 已下架`
- **风险等级**：P0 — 下架后仍可购买（价格快照失效）

### [X-CONS-07] `order.create` 三端均不校验 `market_scope` — 跨市场 SKU 可下单
- **出现频率**：2 个域（域 09、域 01）
- **现象**：浏览层正确过滤 `market_scope IS NULL OR = $boundMarketName`；下单层三端均不复核，跨市场 SKU 可直接传入 skuId 落单
- **来源**：audit-09（P0-09-02）
- **关联**：audit-01 CC3 组织域隔离命中
- **修复**：(L3) 三端 `order.create` SKU 查询追加 `AND (market_scope IS NULL OR market_scope = $boundMarketName)`
- **风险等级**：P0 — 组织域数据隔离在商品维度失守

### [X-CONS-08] `staff`/`client` 端 **service_commission** 不写提成（admin 路径）
- **出现频率**：2 个域（域 08、域 05）
- **现象**：`admin.completeServiceOrder` 完全不写 `service_commissions`；admin 完成的服务单提成永远为 0
- **来源**：audit-08（P0-08-02）、audit-05（P0-05-06）
- **修复**：(L7) `completeServiceOrder` 补提成计算；或抽共用 helper 供 admin/staff 两端复用
- **风险等级**：P0 — admin 后台完成服务单，员工业绩永久缺失（资损）

---

## 3. 退款 cascade 缺失

### [X-CASCADE-01] 退款不冲销 `sale_allocations`
- **来源**：audit-07（P0-07-02，**CLOSED from v1**）
- **状态**：admin `lib/refund-cascade.ts:60-83` + staff `helpers/refund-cascade.js:42-56` 均已实现软删 ✅

### [X-CASCADE-02] 退款不冲销 `service_commissions`
- **来源**：audit-08（P0-08-04，**CLOSED from v1**）
- **状态**：`admin.refund-cascade.ts:85-105` + `staff.helpers/refund-cascade.js:65-79` 均已实现 ✅

### [X-CASCADE-03] 退款不冲销 `coupons`
- **来源**：audit-11（P0-11-04）
- **现象**：approveRefund 完全不动 `user_coupons`；全额退款后优惠券价值消失
- **关联**：audit-19（P0-19-04）— 分享礼券（`sg-inviter-*` / `sg-invitee-*`）退款/关单/取消均不撤销
- **修复**：(L7) approveRefund 事务内 `UPDATE user_coupons SET status='已使用' WHERE ...`（退款场景应改为 '可用' 或加 `refunded_at` 标记）；需新增 `couponStatus='已撤销'` 枚举值
- **风险等级**：P0

### [X-CASCADE-04] 退款不冲销 `points`
- **来源**：audit-15（P0-15-01）
- **现象**：`admin.confirmOfflinePayment / recordPayment / approveRefund` **三处全无 `settlePointsSafe`**；staff/client/payNotify 同触发点 5 处均有
- **关联**：audit-15（P0-15-02）— `settlePointsSafe` 三端副本漂移（staff/client/payNotify 各一份，无 lint 守护）
- **修复**：(L7) admin 三处补 `settlePointsSafe`；同步三端副本
- **风险等级**：P0

### [X-CASCADE-05] 退款不冲销家居产品 `picked_up_quantity`
- **来源**：audit-20（P0-20-01）
- **现象**：`approveRefund` 仅扣减疗程卡 `remaining_sessions`；对 `product_type IN ('单品','家居产品')` 的"退出"行完全无任何 `picked_up_quantity` 回滚。顾客买5件+提货2件+全额退款 → 退款5件+实物2件均保留（双倍资损）
- **修复**：(L7) approveRefund 对家居产品行补 `picked_up_quantity` 回滚逻辑
- **风险等级**：P0

### [X-CASCADE-06] 退款 `received` 重算公式漏 `储值卡抵扣`
- **来源**：audit-03（P0-03v2-05）
- **现象**：`admin.recordPayment` 的 `new_received` 公式 `SUM(CASE WHEN change_type IN ('首次支付','回款') ...)` 遗漏 `'储值卡抵扣'`
- **正确公式**（staff/client）：`IN ('首次支付','回款','储值卡抵扣')`
- **修复**：(L7) `admin.recordPayment` 的 `new_received` SUM 公式加入 `'储值卡抵扣'`
- **风险等级**：P0 — 有储值卡抵扣的订单被 admin recordPayment 后 received 低估，超额允许付款

---

## 4. 组织隔离缺失

### [X-SCOPE-01] Staff 路由 scope 过滤非全覆盖（5 个域命中）
- **来源**：audit-01（P0-03）
- **命中域**：
  | 域 | 函数 | 问题 |
  |----|------|------|
  | 01 | `customer.search` phone 分支 | 无 scope 过滤 → PII 泄露 |
  | 10 | `customer.detail` | 无 scope → 跨店读档案 |
  | 10 | `customer.calendar` | 无 scope → 跨店读日历 |
  | 10 | `customer.giftHistory` | 无 scope → 跨店读赠送记录 |
  | 10 | `customer.updateNotes` | 无 scope → 跨店改备注 |
  | 10 | `customer.assign` | 无 scope → 跨店分配顾客 |
  | 10 | `customer.paidOrders` | 有 scope ✅ |
  | 07 | `allocation.save/pendingList/suggest` 等 4 处 | effectiveStoreId=null 时全返回空集 |
  | 05 | `service.list/detail/counts` | effectiveStoreId=null 时管理层模式空集 |
  | 06 | `appointment.list/detail/confirm/checkin` | 同上 |
  | 06 | `appointment.confirm` | 缺幂等守卫（NEW-P1-06-C） |
- **根因**：`ctx.auth.scopeStoreIds` 已由 middleware 注入，但 SQL 是否调用 `buildStoreScopeCondition` 全靠路由作者自觉，无 lint 强制
- **修复**：(L3) 逐函数补 scope 过滤；(L3) 引 `buildStoreScopeCondition(ctx.auth, column, $n)` 统一替换硬编码 `store_id = $effectiveStoreId`
- **风险等级**：P0 — 组织域隔离在顾客/服务/预约/分配四域全面失效

### [X-SCOPE-02] `effectiveStoreId=null` 管理层模式功能全黑
- **来源**：audit-07（P1-V2-07-04）、audit-05（P1-05-10）、audit-06（P1-06-09）
- **现象**：四类路由全部硬编码 `WHERE store_id = $effectiveStoreId`；当 `effectiveStoreId=null`（总部/市场层登录）时所有查询返回空集
- **修复**：(L3) 用 `buildStoreScopeCondition(ctx.auth, 'store_id', $n)` 替代硬编码
- **风险等级**：P1

---

## 5. 数值精度问题

### [X-PREC-01] `allocationRatio` 无 DB CHECK 约束，DB 层可写非法值
- **来源**：audit-07（P1-V2-07-06）
- **现象**：`sale_allocations.allocation_ratio` NUMERIC(5,2) 无值域 CHECK；`VALID_RATIOS` 仅应用层校验；`admin.saveAllocation` 单条入口无校验
- **修复**：(L0) migration：`ALTER TABLE sale_allocations ADD CHECK (allocation_ratio >= 0.10 AND allocation_ratio <= 1.00)`
- **风险等级**：P1

### [X-PREC-02] `commissionAmount` / `unitPrice` 后端不重算，前端可篡改
- **来源**：audit-08（P1-v2-05）、audit-09（P1-09-07）、audit-07（P0-V2-07-01）
- **三处前端篡改通道**：
  | 域 | 字段 | 后果 |
  |----|------|------|
  | 08 | admin `batchSave` commissionAmount | 前端传值直接入库，不按矩阵重算 |
  | 09 | admin `createOrder` unitPrice | 不信任 `sku.price`，可写任意值 |
  | 07 | staff 前端提交 commissionRate | 误当 allocationRatio，业绩少算 |
- **修复**：(L7) admin actions 重算逻辑在服务端执行；前端口令仅作 hint；(L3) staff 前端补 `allocationRatio` 独立字段
- **风险等级**：P0（admin 可篡改提成金额）

### [X-PREC-03] `payAmount` 无上限校验
- **来源**：audit-04（P0-04v2-05）
- **现象**：`payNotify` 信任 event.payAmount，`INSERT sale_order_payments.amount = payAmount` 无上限检查；可传 9999999 入账
- **修复**：(L3) 加 `if (thisPayAmount > remaining + 0.001) throw 'INVALID_PARAMS: payAmount 超出应付金额'`
- **风险等级**：P0 — 资金直接资损

### [X-PREC-04] `transactionId` 缺省 fallback 破坏幂等键
- **来源**：audit-04（P0-04v2-06）
- **现象**：`txnId = transactionId || \`mock_txn_${Date.now()}\`` — 每次调用不同 txnId，`uq_sop_txn` 唯一索引失效，可重复入账
- **修复**：(L3) 移除 fallback；缺 transactionId 直接 FAIL
- **风险等级**：P0

### [X-PREC-05] `rate=0` 时仍 INSERT `service_commissions` + 置 `commission_status='已分配'`
- **来源**：audit-08（P0-08-03）、audit-05（P0-05-05）
- **现象**：`commission_rate_matrix` 查不到时 rate=0 + opLog 记录，但 INSERT sc 照常；唯一索引阻止后续重插；无 cron/工具检测历史 rate=0 行
- **修复**：(L3) rate=0 + consumeBase>0 时不写 sc；置 `commission_status='待重算'`；admin allocation tab 走人工补算
- **风险等级**：P0 — 员工提成永久少计（资损）

---

## 6. 时间字段不一致

### [X-TIME-01] 三端时区三选一：UTC vs PG NOW vs Asia/Shanghai
- **出现频率**：6 个域（域 02、域 04、域 05、域 06、域 17、域 18）
- **三种时区基准**：
  | 端 | 基准 | 位置 |
  |----|------|------|
  | staff/client | `new Date().toISOString().slice(2,10)` | JS UTC |
  | admin | `to_char(NOW(), 'YYMMDD')` | PG 服务器时区（未显式设定） |
  | appointment.list | `new Date().toISOString().slice(0,10)` | UTC 8位 |
  | appointment.create | `+08:00` 字面量 | Asia/Shanghai 字符串 |
- **来源**：audit-02（P0-02v2-02）
- **风险**：北京时间 00:00–08:00 区间，JS 取前一天 UTC；两端口径计算出不同 dateStr；跨夜重号窗口
- **关联**：audit-05（P1-05-14）service_order_id 同问题；audit-06（P1-06-07）appointment today 同问题；audit-18（P0-18-03）绩效三时间语义同框漂移
- **修复**：(L0) `ALTER DATABASE fengyu SET timezone = 'Asia/Shanghai'`；(L3) 所有 JS Date 改用 `dayjs().tz('Asia/Shanghai')`；PG NOW 自动对齐
- **风险等级**：P0 — 订单号/服务单号跨夜重号

---

## 7. 测试失效

### [X-TEST-01] 测试用例锁死错误行为
- **来源**：audit-08（P2-v2-01）
- **现象**：`service.test.js:836-842` 断言 `rate=0` 时 sc 仍然写入且 `commission_amount=80`；此断言主动锁死 P0-08-03 错误行为。修复 P0-08-03 后此测试必须同步更新
- **来源2**：audit-06（P1-06-11）
- **现象2**：`appointment.test.js:147-161` 用例名"待确认状态也可签到"明确测试并通过宽松行为，测试反向锁死 P1-06-11 修复窗口
- **修复**：(L9) 修复错误行为后同步更新测试断言；用例名收敛
- **风险等级**：P2 — 修复时若忘记改测试，CI 绿但逻辑仍错

### [X-TEST-02] 守卫期内 payNotify 13 个业务测试全部 FAIL
- **来源**：audit-04（P1-04v2-07）
- **现象**：`PAYNOTIFY_DISABLED = true` 是编译时常量，`loadFreshIndex()` require 时常量不变，所有 `main()` 调立即返回 -403。13 个业务用例全部 FAIL；7 个 config 测试通过
- **关联**：P0-04v2-03 schema drift 使恢复守卫后测试也失效（测试与 schema drift 同时存在）
- **修复**：测试文件顶部 mock `PAYNOTIFY_ENABLED = true`；守卫解除后同步修复 schema drift
- **风险等级**：P1 — 守卫解除后核心支付逻辑零有效测试覆盖

### [X-TEST-03] mock 使用 `count` 而非 `rowCount` — 测试与生产代码共用 `any` 互相掩护
- **来源**：audit-06（NEW-P2-06-D）
- **现象**：`admin/src/actions/appointments.test.ts:68-71` mock `setupUpdate` 返回 `{ count, rowCount: count }`；生产代码 `appointments.ts:196,235,273` 用 `(result as any).count === 0`。Drizzle 实际返回 `{ rowCount }` 不是 `.count`，测试和生产共用 `any` 掩盖了类型漂移
- **修复**：(L9) mock 改为 `{ rowCount: n }`；生产代码引入 `assertOneRow(result)` 断言
- **风险等级**：P2

### [X-TEST-04] `monthly_activity` cron 未注册，schema docstring 与实现不符
- **来源**：audit-10（P1-10-v2-07）
- **现象**：`db/schema/user.ts:57` docstring 声明"每日凌晨3点计算"；`run.ts` 的 8 个 STEP 无此任务；`customers.test.ts:536-541` 仅断言 eq 被调用，形式通过实际功能空
- **关联**：audit-09 CC9（P2-09-10）死路由残留；audit-06（P0-06-04 appointment 过期关闭）同 spec vs 实现断裂模式
- **修复**：(L4) `calc-monthly-activity.js` 封装为 cron STEP 注册到 run.ts；或 DROP 列
- **风险等级**：P1

---

## 8. 跨域待统一改造项

| 改造项 | 涉及域 | 优先级 | 预估 | 关联条目 |
|--------|--------|--------|------|----------|
| `pg.query` → `queryWithCount` 返回 `{rows, rowCount}` | 05（根因）+ 01/10/06 | P0 | L | X-BIG-01 |
| 三端时区统一 Asia/Shanghai | 02+05+06+17+18 | P0 | L | X-TIME-01 |
| `staffApi` scope 过滤强制覆盖（5 域） | 01+10+07+05+06 | P0 | M | X-SCOPE-01 |
| `payNotify` schema drift 修复 | 04+03 | P0 | M | X-BIG-02 |
| `order.create` 加 is_enabled + market_scope 校验 | 09+07+02 | P0 | L3 | X-CONS-06/07 |
| 退款 cascade 补 coupons/points/picked_up_quantity | 11+19+15+20 | P0 | M | X-CASCADE-03/04/05 |
| `received` 重算公式补储值卡抵扣 | 03 | P0 | S | X-CASCADE-06 |
| `commission_rate_matrix` 查加 org_id 过滤 | 08+07 | P0 | L3 | X-CONS-02 |
| 前端 `allocationRatio` 独立字段补 | 07 | P0 | L9 | X-CONS-05 |
| 后端重算 commissionAmount/unitPrice | 08+09 | P0 | L7 | X-PREC-02 |
| rate=0 不写 sc，置 commission_status | 08+05 | P0 | L3 | X-PREC-05 |
| payAmount 上限 + transactionId fallback | 04 | P0 | L3 | X-PREC-03/04 |
| `staffApi` 新建审计 helper + audit 日志补位 | 23（收口） | P0 | M | — |
| `allocationRatio` DB CHECK 约束 | 07 | P1 | L0 | X-PREC-01 |
| 守卫解除前实现 payNotify 拉卡拉签名校验 | 04 | P0 | M | — |
| 测试锁死错误行为用例修正 | 08+06 | P2 | L9 | X-TEST-01/03 |
| payNotify 测试用 env mock 恢复通过 | 04 | P1 | L3 | X-TEST-02 |
| monthly_activity cron 集成 | 10 | P1 | L4 | X-TEST-04 |

---

## 9. v3 vs 旧版 CROSS-CUTTING.md 净变化

| 类别 | 变化说明 |
|------|---------|
| 新增 X-BIG-01 | `pg.query` rowCount 丢失全仓穿透（audit-05 新发现）|
| 新增 X-BIG-02 | payNotify schema drift（audit-04 v2 新发现）|
| 新增 X-CASCADE-03/04/05 | coupons/points/picked_up_quantity 退款 cascade 缺失（域 11/15/20 新发现）|
| 合并 X-CONS-01 | `unit_price` 三端分裂（原分散在 audit-09/07/02，现合并）|
| 合并 X-CONS-06/07 | is_enabled / market_scope 校验（原分散在 audit-09/02，现合并）|
| 合并 X-TIME-01 | 时区问题（原分散在 02/05/06，现合并）|
| 移除过时条目 | `sale_allocations` DELETE → UPDATE（P0-07-01 CLOSED）；退款冲销 sa/sc（P0-07-02/P0-08-04 CLOSED）|
| 更新 X-CASCADE-06 | received 公式补储值卡抵扣（原漏，未明确列出）|

---

*审计员：claude-sonnet-4-6，审计时间 2026-04-26 v3*
