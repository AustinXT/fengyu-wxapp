# 审计报告：开单 + 状态机 + 订单号唯一 (02) — v3

**审计时间**：2026-04-26
**域 ID**：02
**审计员**：claude-sonnet-4-6
**审计版本**：v3（合并 v1 + v2，独立交叉验证）
**审计时长**：~45 分钟（合并评审）
**关联 PR/Ticket**：sale-order-domain-refactor（2026-04-26）

**合并来源**
- v1：`docs/audit/audit-02-order-creation.md`（审计时间 2026-04-25，审计员 claude-opus-4-7）
- v2：`docs/audit/audit-02-order-creation-v2.md`（审计时间 2026-04-26，审计员 claude-sonnet-4-6，从零独立读源码）

**合并规则**
- 同问题（相同 file:line 或实质相同）：以 v2 为准，补充 v1 细节
- v2 新发现：新增条目，ID 延续 v2
- v1 P0 在 v2 已修复：标记 `[CLOSED from v1]` 附修复文件
- v1 P0 在 v2 降级：保留说明降级原因
- 最终 P0 = v2 仍标 P0 的 + 已 CLOSED 条目

**规范版本**：`real.md` v3.1.0（命中 #2 价格快照、#4 状态单向、#7 待支付唯一）+ `enums.ts` 28 枚举

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:40-125`（saleOrders）+ `:127-208`（saleItems）| ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:5-14` orderStatus(8 值) + `enums.ts:22` saleOrderType(5 值枚举，实际 create 仅接受 3 值) | ↑ | ↑ |

> **注 (2026-04-27)**：`saleOrderTypeEnum` 已精简为 3 值（销售单/内部单/转换单），不再有 '回款单'/'退款单'。退款改为基于 `sale_order_payments`（change_type='退款', amount<0）+ `sale_order_payment_details` 子表。
| Action/Route | `fengyu-admin/src/actions/orders.ts:692`（createOrder）+ `:535`（confirmOfflinePayment）+ `:599`（closeOrder）+ `:654`（resetOrderFailed）+ `:1709`（recordPayment）| `staffApi/routes/order.js:162`（create）+ `:771`（confirmOffline）+ `:1068`（close）+ `:1143`（resetFailed）+ `:2491`（generateOrderNo）| `clientApi/routes/order.js:160`（create）+ `:657`（pay）+ `:785`（offlinePay）+ `:1073`（cancel）+ `:56`（scanDetail）+ `:1361`（scanAdjust）+ `:1471`（confirmPrepaidFull）+ `:1612`（repay）|
| 唯一约束 | `db/schema/order.ts:116-121`：`uq_sale_orders_client_pending` ON `(client_user_id)` WHERE `status='待支付' AND client_user_id IS NOT NULL` + `uq_sale_orders_phone_pending` ON `(client_phone, store_id)` WHERE `status='待支付' AND client_user_id IS NULL` | ↑ | ↑ |
| Advisory lock | admin `actions/orders.ts:1038-1052`（createOrder），`:1807-1821`（recordPayment FY-HKD 单） — 单事务持锁 ✅ | staff `routes/order.js:404`（`generateOrderNo()` 独立事务） + `:499-501`（主事务再次持锁）— **双事务！** ❌ + `routes/order.js:2056`（createConversion 同问题）| client `routes/order.js:389-390`（单事务持锁）✅ |
| 前端 | `fengyu-admin/src/app/(main)/orders/_components/order-create/` | `pagesOrder/create/` | `pagesShop/` |

---

## 2. v1 vs v2 评审摘要

### 2.1 评审结论对照

| 发现 | v1 结论 | v2 独立结论 | 变化 |
|------|---------|-------------|------|
| staff create 双事务 advisory lock | P0-02-01，未修复 | P0-02v2-01，**确认存在，未修复** | 一致 |
| UTC vs PG 时区不一致 | P0-02-02，未修复 | P0-02v2-02，**确认存在，未修复** | 一致 |
| client cancel 缺 CAS 守卫 | P0-02-03，缺守卫 | **[CLOSED from v1]** — v2 行 1127-1133 已加 `AND status = ANY($4::order_status[])` 守卫 | 已修复 |
| settlePointsSafe 回滚整笔收款 | P0-02-04，判 P0 | **降级 P1**（P1-02v2-05）：v2 独立读 `utils/points.js:105-125`，`settlePointsSafe` 已内置 try/catch 隔离，JS 异常不导致主事务回滚；仅 PG 死锁（error 40P01）概率极低场景仍存在 | v2 更精确 |
| recordPayment 缺 isInScope | P0-02-05，未修复 | P0-02v2-03，**确认存在，未修复** | 一致 |
| sale_items is_experience 遗漏 | 未发现 | **P0-02v2-05（新发现）**：staff create INSERT sale_items 遗漏 `is_experience` 列，schema 默认 false，破坏顾客类型跃迁 | v2 新 P0 |
| allocation_status NULL | P1-02-09，未修复 | P1-02v2-06，**确认存在，未修复** | 一致 |
| 状态机关闭集不一致 | P1-02-07，未修复 | P1-02v2-07，**确认存在，未修复** | 一致 |
| admin confirmOfflinePayment 不写 payments | §4 提及，分类不明确 | **P1-02v2-09（v2 新标）**：admin confirmOfflinePayment 整体不写 payments，`received` 不更新，精确定位 | v2 精化 |
| cancel CAS 已修复 | P0-02-03 | v2 行 1127-1133 已修复 | [CLOSED from v1] |

### 2.2 v1 漏判 / 误判总结

**v1 漏判**
- `[P0-02v2-05]`：staff create INSERT sale_items 遗漏 `is_experience` 列 — v1 未发现
- `[P1-02v2-09]`：admin `confirmOfflinePayment` 整体不写 `payments` 行 — v1 仅在 §4 跨端不一致表格模糊提及，未单独立项

**v1 误判 / 需修正**
- `[P0-02-04 → P1-02v2-05]`：`settlePointsSafe` 的 P0 评级过于悲观。v2 独立读源码（`utils/points.js`）确认：函数已内置 try/catch 吸收 JS 异常，主事务不会因积分模块 JS 异常回滚。仅 PG 级死锁（40P01）低概率场景保留为 P1。

**v1 漏判 / 低估**
- `[P1-02v2-08]`：`saleOrderTypeEnum` 5 值但实际 create 仅接受 3 值 — v1 仅在 [P1-02-08] 提转换单前缀问题，未指出枚举本身与业务约束的脱节

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-02v2-01]** staff `create` 与 `createConversion`：`generateOrderNo()` 独立事务释放锁后、主事务 INSERT 前存在并发重号窗口

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:404`（调用 `generateOrderNo()`）、`:2491-2512`（`generateOrderNo` 内含独立 `pg.transaction`）、`:499`（主事务内 advisory_xact_lock，再次持锁）；同问题出现在 `:2056`（`createConversion`）
- **现象**：`generateOrderNo()` 在自己的事务内执行 `advisory_xact_lock + SELECT MAX + COMMIT`，锁在 COMMIT 时释放。返回 `saleOrderId` 后，外层在行 499 开启主事务时 `sale_orders` 还未插入。若两个并发进程：A 调 `generateOrderNo()` 得 id=N+1 → 释放锁；B 在 A 主事务 INSERT 之前调 `generateOrderNo()`，SELECT MAX 看到的还是 N，也得 id=N+1 → 两个进程都持有相同 id，随后同时 INSERT sale_orders → 主键冲突（PG error 23505）。
- **v1 对比**：v1 [P0-02-01] 已发现，**两轮独立验证：问题仍存在，未修复**。
- **风险**：高并发下（多个店长同时开单）PK 冲突 → 开单失败；应用层未捕获时出现重号"幽灵单"或半插数据。违反**订单号唯一性**硬约束（real.md）。
- **复现**：模拟两个并发 staff.create 请求；在 `generateOrderNo()` commit 后、主事务 INSERT 前人工 sleep 可稳定复现。
- **修复**：(L3) 方案一（推荐）：参照 client/admin 模式，把 advisory lock + 订单号生成逻辑直接内联到主事务内，`generateOrderNo()` 接收 `tx client` 参数而不自己开事务。方案二：废弃 `generateOrderNo()` 独立函数，改为 `generateOrderNoInTx(txClient, prefix)` 纯函数形式。

#### **[P0-02v2-02]** 三端订单号 `YYMMDD` 时区不一致：staff/client 强制 UTC，admin 用 PG `NOW()` 的集群时区（未显式 `AT TIME ZONE`）

- **文件**：
  - staff `routes/order.js:2494`：`new Date().toISOString().slice(2,10).replace(/-/g,'')` — **JavaScript UTC**
  - client `routes/order.js:449`：`now.toISOString().slice(2,10).replace(/-/g,'')` — **JavaScript UTC**
  - admin `actions/orders.ts:1042`：`to_char(NOW(), 'YYMMDD')` — **PG 集群时区**（生产 PG timezone 未在 connection level 显式设定）
  - sale_item_id 用 `slice(0,10)` 得 YYYYMMDD 8 位（UTC），与订单号前 6 位不对齐
- **现象**：北京时间 00:00–08:00 区间，`new Date().toISOString()` 返回前一天 UTC；如果 PG 集群设为 Asia/Shanghai（`SHOW TIMEZONE`），则 `to_char(NOW(),'YYMMDD')` = 当天北京时间，而 staff/client JS = 前一天 UTC。两端生成的 dateStr 不同，序号搜索各用不同前缀池，存在"跨夜重号"窗口。
- **v1 对比**：v1 [P0-02-02] 已发现，**两轮独立验证确认：问题仍存在，未修复**。
- **风险**：凌晨跨夜窗口（北京时间 00:00–08:00）可能导致订单号重复（违反唯一性硬约束）；财务对账日期错位（订单号内嵌日期与业务日期不一致）。
- **修复**：(L0) PG 集群 `SET timezone = 'Asia/Shanghai'`；(L3) staff/client JS 端改用 `dayjs().tz('Asia/Shanghai').format('YYMMDD')`，或在 SQL 端用 `to_char(NOW() AT TIME ZONE 'Asia/Shanghai', 'YYMMDD')` 统一。

#### **[P0-02v2-03]** admin `recordPayment` 缺 `isInScope` 校验，scope 保护依赖权限矩阵隐式合约

- **文件**：`fengyu-admin/src/actions/orders.ts:1780-1782`
- **现象**：注释明确写"非 admin 的 record_payment 由权限矩阵拒绝，此处 admin 默认可跨门店；若未来扩展该权限到 scoped 角色，需要在此处做 `isInScope(session, locked.store_id)` 校验"。`closeOrder`、`confirmOfflinePayment`、`resetOrderFailed` 均有 `scopeCondition()` 内嵌到 WHERE，但 `recordPayment` 无此保护。
- **v1 对比**：v1 [P0-02-05] 已发现，**两轮独立验证确认：隐式合约仍存在，未修复**。
- **风险**：一旦权限矩阵授予 manager/finance 角色 `sale_order:record_payment`，该角色可对所有门店的订单执行回款，违反组织域数据隔离（real.md #6）。
- **复现**：在 PERMISSION_MATRIX 中把 `sale_order:record_payment` 添加到 `manager` → manager 角色可 recordPayment 任意门店订单。
- **修复**：(L7) 在 `recordPayment` 中锁完 `locked` 后立即执行 `if (!isInScope(session, locked.store_id)) throw PERMISSION_DENIED`；与 `closeOrder`/`confirmOfflinePayment` 模式对齐。

#### **[P0-02v2-05]** staff `create` 的 INSERT sale_items 遗漏 `is_experience` 列，体验卡快照写入 schema 默认值 `false`，破坏顾客类型跃迁逻辑

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:610-629`（INSERT sale_items 列集）、`db/schema/order.ts:185`（`isExperience boolean NOT NULL DEFAULT false`）
- **现象**：staff create INSERT sale_items 的列集：`sale_item_id, sale_order_id, store_id, item_direction, sku_id, product_name, sku_spec_name, product_type, session_count, remaining_sessions, unit_price, quantity, unit_real_price, sale_amount, received, sales_category, service_fee, is_shengmei, is_recharge_card`。**`is_experience` 列不在此列集中**。写入时 PG 以 schema 默认值 `false` 填充。staff create 的 `itemDataList` 中已计算 `isExperience`（行 313），但未被用于 INSERT。
- **对比**：client create 行 527 INSERT sale_items 列集包含 `is_experience`（行 526）；admin createOrder 亦通过 Drizzle 传 `isExperience`。**仅 staff create 遗漏**。
- **风险**：店长开单的体验卡订单，`sale_items.is_experience` 全为 `false`。`recalcCustomerType` SQL（行 86-131）用 `si.is_experience = true` 识别体验客、`si.is_experience = false` 识别小美客。店长开体验卡 → `is_experience=false` → 被判定为"小美客"而非"体验客"——顾客类型跃迁结果错误。同时影响 `sale_order_type='销售单' AND si.is_experience=true` 的筛选逻辑（staff.js 行 112）。
- **v1 对比**：v1 未发现，**v2 独立新发现**。
- **复现**：1) 用店长开单购买一张 `is_experience=true` 的 SKU 体验卡；2) 确认收款触发 `recalcCustomerType`；3) 顾客变成"小美客"而非"体验客"。
- **修复**：(L3) 在 staff `create` INSERT sale_items 列集末尾补 `is_experience`，值为 `d.isExperience === true`（变量已在 itemDataList 计算，行 313）。

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-02v2-05]** `settlePointsSafe` 在主事务 client 上执行，若 points 内部引发 PG 死锁（非 JS 异常），事务被 PG 标记为终止，整笔收款回滚（P1 级低概率风险）

> **v1 对比**：v1 [P0-02-04] 判 P0；v2 独立读 `utils/points.js:105-125` 后**降级为 P1**。`settlePointsSafe` 已内置 try/catch 捕获 JS 异常，被吞后返回 `{ error, skipped }`，主事务不因 JS 异常回滚。仅 PG 死锁（error 40P01）场景仍会终止事务，概率极低但不可完全排除。

- **文件**：`staffApi/routes/order.js:1024`；`utils/points.js:109-111`
- **现象**：`settlePointsSafe` 用 try/catch 捕获 JS 层错误。但 PG 死锁错误（error code 40P01）会由 PG 直接 ROLLBACK 并通过 pg.js error event 到达 Node，此时 `client.query` promise reject，try/catch 能捕获 → 写 operation_logs → 实际上 client 已被 PG 标记为"in failed transaction"，后续 operation_logs INSERT 也会失败（被静默吞掉），但主事务无法继续提交（PG 会在最终 COMMIT 时报 ERROR: current transaction is aborted）。实质与直接抛出无异。
- **风险**：若 customer_points 表竞争锁（例如多个 confirmOffline 同一顾客同时发生），死锁触发概率低但可导致店长"已看到成功提示"而 DB 内收款未落账。
- **修复**：(L3) 对 `settlePointsSafe` 也用 SAVEPOINT 包裹，与 `grantShareGift` 保持一致。

#### **[P1-02v2-06]** staff `create` INSERT sale_orders 未写 `allocation_status` 列；admin `createOrder` 写 `allocationStatus: '待分配'`；两端初值不一致

- **文件**：staff `routes/order.js:551-571`（INSERT sale_orders 列集无 `allocation_status`）；admin `actions/orders.ts:1093`（`allocationStatus: '待分配'`）；`db/schema/order.ts` 无默认值
- **现象**：staff create 写入的订单 `allocation_status = NULL`（DB 默认）；admin 写入 `'待分配'`；client create 也无此列写入（同 NULL）。`allocation_status` 仅在 staff `confirmOffline` 行 924 通过 `CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END` 补填。
- **风险**：管理后台「待分配清单」按 `allocation_status = '待分配'` 过滤，漏掉 NULL 行 → staff 开单后未确认收款前的订单不出现在分配清单，导致提成分配遗漏。
- **修复**：(L0/L3) 方案一：`db/schema/order.ts` 中 `allocation_status` 加 `.default('待分配')`；方案二：staff create INSERT 补 `allocation_status = '待分配'`。

#### **[P1-02v2-07]** 状态机关闭允许集三端不一致：admin `closeOrder` 仅允许 `待支付/支付失败`；staff `close` manager 允许 `待支付/待确认收款/支付失败`；client `cancel` 允许 `待支付/(已支付且全额抵扣)`

- **文件**：admin `actions/orders.ts:616-619`；staff `routes/order.js:1090-1096`；client `routes/order.js:1102-1108`
- **现象**：staff manager 可关闭 `待确认收款` 订单，但 admin 不可。顾客可取消"已支付全额抵扣"订单（存在业务合理性），但三端规则从未对齐。
- **风险**：admin 无法关闭 `待确认收款` 单 → 运营人员需走到小程序才能操作；状态机规则未文档化 → 后续维护者各端各自延伸导致状态崩坏。
- **修复**：(L0) 在 `.42cog/cog.md` 补充订单状态机权威迁移图；(L7) admin `closeOrder` 允许集补 `待确认收款`，与 staff manager 对齐。

#### **[P1-02v2-08]** `saleOrderType` 枚举 5 值但 v2 实际 create 仅接受 3 值：staff/client/admin 各自过滤不同子集

> **FIXED 2026-04-27**：`saleOrderTypeEnum` 已从 5 值精简为 3 值（销售单/内部单/转换单），'回款单'/'退款单' 已从枚举移除。退款/回款语义完全由 `sale_order_payments.change_type` 表达（change_type='退款', amount<0, status='待审批'→'已支付'），不再有独立的退款单/回款单订单类型。新表 `sale_order_payment_details` 作为 1:1 子表存储 operator、note、refund reason、audit 信息。

- **文件**：`db/schema/enums.ts:22`（枚举 5 值：销售单/内部单/回款单/转换单/退款单）；staff `routes/order.js:207-211`（仅接受销售单/内部单，拒绝回款单/退款单）；admin `actions/orders.ts:703`（接受销售单/内部单/转换单）；client create 不传 `saleOrderType`（默认 `'销售单'`）
- **现象**：`sale-order-domain-refactor` 后回款/退款单语义已下沉到 `sale_order_payments`，但枚举未精简为 3 值。enum 与实际业务约束脱节，未来误用风险高。
- **风险**：枚举中残留的 `回款单/退款单` 字面量若被外部程序直接传入（绕过 create 校验），仍可写入 DB，引起下游分配/积分/状态机逻辑错误。
- **修复**：(L0) `db/schema/enums.ts` 对 `saleOrderTypeEnum` 精简为 3 值（销售单/内部单/转换单），写 migration；退款/回款语义完全由 `sale_order_payments.change_type` 表达。

#### **[P1-02v2-09]** `admin.confirmOfflinePayment` 不写 `sale_order_payments` 流水行，与 staff/client 口径不对称

- **文件**：`fengyu-admin/src/actions/orders.ts:535-596`（`confirmOfflinePayment`：UPDATE sale_orders status='已支付' + 写 expire_date + 写充值卡入账，但**无 payments 行写入**）
- **现象**：staff `confirmOffline` 在事务内写 `payments[首次支付/回款]` + `payments[储值卡抵扣]`，保持 `received` 不变量。admin `confirmOfflinePayment` 直接置 `status='已支付'`，**不写 payments 行，`received` 字段不更新**。
- **v1 对比**：v1 §4 跨端不一致表格中模糊提及"admin 路径不对账"，未单独立项；v2 精确定位为独立 P1。
- **风险**：admin 确认的收款在 `sale_order_payments` 中无记录 → 款项流水不完整 → 对账缺失 → `received` 快照与 payments 行 SUM 不一致（破坏款项域不变量）。
- **修复**：(L7) `confirmOfflinePayment` 同时写 1 行 payments `change_type='首次支付'/'回款'` + 聚合重算 `received`，与 staff `confirmOffline` 对齐。

#### **[P1-02v2-10]** sale_items `sale_item_id` 格式三端不一致：admin `createOrder` 用 `{orderId}-{NN}` 格式，staff/client 用 `XSLSH-WX-{YYYYMMDD}{4}`

- **文件**：admin `actions/orders.ts:1158`（admin createOrder sale_item_id 生成）；staff `routes/order.js:601` 与 client `routes/order.js:483` 均用 `XSLSH-WX-{YYYYMMDD}{4}` 格式
- **现象**：schema `sale_item_id varchar(30)` 容纳 admin `{orderId}-{NN}` 格式（22 字符）无问题，但前缀与 staff/client 的 `XSLSH-WX-` 完全不兼容。任何按前缀匹配 sale_item_id 的报表/查询会漏掉 admin 单。
- **修复**：(L0/L7) 统一三端为 `XSLSH-WX-{YYMMDD}{4}` 格式；admin createOrder sale_item_id 改用与 createConversion 一致的规则。

#### **[P1-02v2-11]** 待支付订单唯一约束 `(client_phone, store_id)` 维度跨店重号漏覆盖

- **文件**：`db/schema/order.ts:118-121` `uq_sale_orders_phone_pending ON (client_phone, store_id) WHERE status='待支付' AND client_user_id IS NULL`
- **现象**：phone+store 索引允许同一手机号在 A 店待支付订单 `(phone='13900', store_A)` 与 B 店待支付订单 `(phone='13900', store_B)` 同时存在。real.md #7「同一顾客同一时间至多 1 笔待支付」按"顾客=user_id"语义已被 `uq_sale_orders_client_pending` 覆盖；但 `client_user_id IS NULL` 路径（WorkFine 同步的未注册顾客）存在跨店重号风险。
- **风险**：若未来 admin/小程序绕过 client_user_id 注入创建未绑定顾客的待支付单，同一手机号跨店可累积多单。
- **修复**：(L0) 把 `uq_sale_orders_phone_pending` 拓宽为仅按 `(client_phone) WHERE status='待支付' AND client_user_id IS NULL`（删除 store_id 维度）；或（L3）在 client/staff/admin create 分支显式 SELECT 跨店全网检查。

#### **[P1-02v2-12]** 订单号前缀 `FY-XSD-WX-` 销售单与转换单共用，前缀语义重叠

- **文件**：`staffApi/routes/order.js:2018`、`fengyu-admin/src/actions/orders.ts:1282`
- **现象**：转换单 `sale_order_type='转换单'`，但订单号前缀仍为 `FY-XSD-WX-`，外观与销售单完全相同；只能靠 `sale_order_type` 字段区分。退款/回款分别用 `FY-TKD-WX-`/`FY-HKD-WX-` 与单据类型语义对齐。
- **风险**：肉眼审单 / 财务报表按订单号前缀分组会把转换单误归销售；订单号查询索引混。
- **修复**：(L0/L3) 转换单引入独立前缀 `FY-ZHD-WX-`，与 saleOrderType 一一对应。

#### **[P1-02v2-13]** 错误前缀 `INVALID_STATE:`、`CONFLICT:` 不在 4 种约定内

- **文件**：`clientApi/routes/order.js:1673, 1688`（`INVALID_STATE:`）；client `routes/order.js:1514, 1519, 1135`（`CONFLICT:`）
- **现象**：前缀为非约定值，前端按约定前缀做 toast 映射会落入"未识别"分支。
- **风险**：前端无法正确展示业务错误文案（低风险）。
- **修复**：(L3) 改为 `INVALID_PARAMS:` 嵌套语义。

### 3.3 P2（代码质量 / 可维护）

#### **[P2-02v2-14]** staff `create` 与 `createConversion` 双 advisory lock 持取浪费

- **文件**：`routes/order.js:404,499,2056,2059`
- **现象**：`generateOrderNo()` 在事务内获取 advisory lock（行 2499）；主事务开后又获取一次（行 501/2059）。第二次持锁的 `SELECT sale_item_id MAX` 在主事务内，而订单号已由第一段获取——主事务内的锁多余。
- **修复**：(L3) 参见 P0-02v2-01 修复建议，合并后只需一次持锁。

#### **[P2-02v2-15]** `client.order.js` detail/list/scanDetail 中封面图子查询 N+1

- **文件**：`clientApi/routes/order.js:111-114, 926-929, 1001-1003`
- **现象**：每行触发 `(SELECT p.cover_image FROM mall_product_skus mps JOIN products p ON ... WHERE mps.sku_id=si.sku_id LIMIT 1)` 子查询，属于 N+1 变体。
- **修复**：(L3) 改为主查询 JOIN `mall_product_skus` + `products`，单次 JOIN 代替 N 次子查询。

#### **[P2-02v2-16]** 错误前缀 `INSUFFICIENT_BALANCE:`、`CLIENT_NOT_REGISTERED:`、`MIXED_PAYMENT_NOT_SUPPORTED:` 均不在 4 种约定内

- **文件**：staff `routes/order.js:233, 875, 879, 1135`；client `routes/order.js:419`
- **修复**：(L3) 全部映射到 `INVALID_PARAMS:` 前缀，可嵌套扩展语义。

#### **[P2-02v2-17]** qrcodeCache 模块级 Map 无淘汰策略，容器长期运行内存无限增长

- **文件**：`staffApi/routes/order.js:27`（`const qrcodeCache = new Map()`）
- **修复**：(L3) 改用 LRU + cap（参考 `auth.js AUTH_CACHE` 模式）。

#### **[P2-02v2-18]** `client.create` 内两次计算 dateStr：`slice(2,10)` 6 位 YYMMDD vs `slice(0,10)` 8 位 YYYYMMDD，语义混乱

- **文件**：`clientApi/routes/order.js:449, 464`
- **现象**：`dateStrOrder = now.toISOString().slice(2,10)` 得 `260426`（6 位）；`dateStr = today.toISOString().slice(0,10)` 得 `20260426`（8 位）。两个变量名相近但取法不同。
- **修复**：(L3) 统一命名并注释；推荐统一为 Asia/Shanghai 时区后的 `YYMMDD` 6 位（与订单号对齐）。

#### **[P2-02v2-19]** staff/create/confirmOffline/close 大量复制粘贴 dateStr 计算 + advisory lock + max id 查询逻辑

- **文件**：`routes/order.js:507-520, 1394-1402, 2018-2030, 2186-2199, 2240-2247`
- **修复**：(L3) 抽 `helpers/order-id.js`（generate(prefix, tx, dateStr) → id）。

#### **[P2-02v2-20]** client.create / staff.create 内嵌优惠券处理，三端独立实现

- **文件**：staff:325-407, client:244-331, admin:746-775
- **修复**：(L3) 抽 `helpers/coupon-discount.js`（calc + distribute）。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| advisory lock 持有方式 | 单事务持锁直到 COMMIT ✅ | generateOrderNo 独立事务，主事务再持 ❌ | 单事务持锁 ✅ | 并发重号窗口 | P0（P0-02v2-01）|
| 订单号 dateStr 时区 | PG `to_char(NOW(), 'YYMMDD')`（集群时区） | JS UTC `toISOString()` | JS UTC | 跨夜重号 | P0（P0-02v2-02）|
| `is_experience` 写入 | Drizzle 传值 ✅ | INSERT 列集遗漏 ❌ | INSERT 包含 ✅ | 顾客类型跃迁错误 | P0（P0-02v2-05）|
| `allocation_status` 初值 | `'待分配'` ✅ | 不写（NULL）❌ | 不写（NULL）❌ | 待分配清单漏单 | P1（P1-02v2-06）|
| `confirmOffline` payments | staff 写流水 ✅；**admin 不写** ❌ | — | — | received 快照与 payments SUM 不一致 | P1（P1-02v2-09）|
| 关闭允许集 | `待支付/支付失败` | `待支付/待确认收款/支付失败`(mgr) | `待支付/(已支付+全额抵扣)` | 三端规则不闭合 | P1（P1-02v2-07）|
| sale_item_id 格式 | `{orderId}-NN` | `XSLSH-WX-{YYYYMMDD}{4}` | `XSLSH-WX-{YYYYMMDD}{4}` | 报表前缀匹配失效 | P1（P1-02v2-10）|
| 订单号前缀（转换单） | `FY-XSD-WX-`（含转换单） | `FY-XSD-WX-`（含转换单） | 仅 `FY-XSD-WX-` | 转换 vs 销售前缀冲突 | P1（P1-02v2-12）|
| saleOrderType 5 值枚举 | 接受 3 值（含转换单） | 接受 2 值（销售单/内部单） | 仅默认销售单 | 枚举与业务约束脱节 | P1（P1-02v2-08）→ **FIXED 2026-04-27**（枚举已精简为 3 值）|
| 错误前缀 | 中文 throw（无前缀） | `CLIENT_NOT_REGISTERED:` + `INSUFFICIENT_BALANCE:` | `CONFLICT:` + `INVALID_STATE:` | toast 映射落空 | P2（P2-02v2-13, P2-02v2-16）|

---

## 5. 横切检查（CC1-CC9）

- [x] **CC1 数值精度**：金额 NUMERIC(10,2) ✅；JS `Math.round(*100)/100` 风险面有限；`totalAmount` 计算链以 `received` 为基础（already includes discount）逻辑正确；分摊尾差修正 ✅。
- [ ] **CC2 并发与幂等**：advisory lock 三端格式基本到位；**staff create 双事务窗口（P0-02v2-01）**；cancel CAS 守卫**已修复**（`AND status = ANY($4::order_status[])` 行 1127-1133，v2 验证通过）✅；confirmOffline CAS UPDATE `WHERE status = $7` ✅；repay `FOR UPDATE` ✅。幂等键：card_transactions `ref_order_id + type` ✅；payments 无 UNIQUE 约束（由 `change_type` 自然区分，首次支付无重复保证）。
- [x] **CC3 组织域数据隔离**：staff `confirmOffline`/`close`/`resetFailed`/`list` 均用 `effectiveStoreId` 过滤 ✅；admin 用 `scopeCondition()` ✅（除 `recordPayment` 无保护 [P0-02v2-03]）；client 全部 `WHERE client_user_id = userId` ✅。
- [x] **CC4 后端统一鉴权**：staff `requireManager()` / `requireStaffBound()` ✅；admin `requirePermission()` ✅；client `requirePhone()` ✅（含 scanDetail/scanAdjust/confirmPrepaidFull）。`scanDetail` v2 已修复补 `requirePhone()` ✅。
- [ ] **CC5 错误前缀**：大量自定义前缀偏离 4 种约定（P2-02v2-13, P2-02v2-16）；admin 抛中文无前缀。
- [ ] **CC6 PII**：`sale_orders.customer_name` + `client_phone` 快照；`scanDetail` 返回 `storeName`/`openerName`（无脱敏）；`refundList` 返回 `client_phone`/`customer_name`（完整）。属已知跨域问题（audit-01 P0-PII-06 关联）。
- [x] **CC7 时间字段**：`created_at`/`updated_at` defaultNow ✅；`paid_at` 由各 UPDATE 显式写 ✅。但 dateStr UTC vs PG NOW 时区不一致（P0-02v2-02）。
- [x] **CC8 WXML/Vant**：本域无前端 WXML 审计（scope 在域 06/13）。
- [ ] **CC9 测试与残留**：staff create INSERT sale_items 遗漏 `is_experience`（P0-02v2-05）；`saleOrderTypeEnum` 5 值但业务仅用 3 值（P1-02v2-08）；`wechat_transaction_id`/`alipay_transaction_id` 已从 `sale_orders` 列注释标记 DROP，但 `0000_baseline.sql` 中 UNIQUE 约束仍存（如 `sale_orders_wechat_transaction_id_unique`），若列已 DROP 则约束为僵尸（待迁移确认）。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/enums.ts:22` | `saleOrderTypeEnum` 精简为 3 值（销售单/内部单/转换单），写 migration | P1-02v2-08 → **FIXED 2026-04-27** |
| L0 schema | `db/schema/order.ts` | `allocationStatus` 列加 `.default('待分配')` | P1-02v2-06 |
| L0 DB | 新 migration | `SET timezone = 'Asia/Shanghai'`（集群级）；验证生产 PG `SHOW TIMEZONE` 后决策 | P0-02v2-02 |
| L0 schema | `db/schema/order.ts:111-113` | `uq_sale_orders_phone_pending` 移除 `store_id` 维度 | P1-02v2-11 |
| L3 staffApi | `staffApi/routes/order.js:2491-2512` | 重构 `generateOrderNo` 为 `generateOrderNoInTx(txClient, prefix)`，不自己开事务；在 `create` 主事务内调用 | P0-02v2-01 |
| L3 staffApi | `staffApi/routes/order.js:610-629` | INSERT sale_items 列集补 `is_experience`，值为 `d.isExperience === true`（第 19 个参数） | P0-02v2-05 |
| L3 staffApi | `staffApi/routes/order.js:551-571` | INSERT sale_orders 列集补 `allocation_status = '待分配'` | P1-02v2-06 |
| L3 staffApi | `staffApi/routes/order.js:1024` | 为 `settlePointsSafe` 调用添加 SAVEPOINT 保护（与 grantShareGift 同模式） | P1-02v2-05 |
| L3 staffApi/client | `routes/order.js` 多处 | 统一时区：`dateStr` 改用 Asia/Shanghai | P0-02v2-02 |
| L3 staffApi/client | 多处错误 throw | 错误前缀统一为 `INVALID_PARAMS:` 嵌套语义 | P2-02v2-13, P2-02v2-16 |
| L3 staffApi | `routes/order.js:27` | `qrcodeCache` 改 LRU + cap | P2-02v2-17 |
| L3 staffApi | `helpers/order-id.js`（新文件） | 抽公共 advisory lock + dateStr + maxSeq → id | P0-02v2-01, P2-02v2-19 |
| L3 staffApi | `helpers/coupon-discount.js`（新文件） | 抽优惠券处理逻辑 | P2-02v2-20 |
| L3 clientApi | `clientApi/routes/order.js:111-114` | 封面图查询 JOIN 优化，消除 N+1 | P2-02v2-15 |
| L7 admin | `actions/orders.ts:1780` | `recordPayment` 补 `if (!isInScope(session, locked.store_id)) throw PERMISSION_DENIED` | P0-02v2-03 |
| L7 admin | `actions/orders.ts:535-596` | `confirmOfflinePayment` 补写 payments 流水 + 重算 `received` | P1-02v2-09 |
| L7 admin | `actions/orders.ts:616-619` | `closeOrder` 允许集补 `待确认收款`，与 staff manager 对齐 | P1-02v2-07 |
| L7 admin | `actions/orders.ts:977` | sale_item_id 改用 `XSLSH-WX-{YYMMDD}{4}` 与 staff/client 对齐 | P1-02v2-10 |
| L7 admin | `actions/orders.ts`（多处） | 转换单用独立前缀 `FY-ZHD-WX-` | P1-02v2-12 |
| L9 前端 | `_components/order-create-page.tsx` | UI 提示状态机非法跳变 | P1-02v2-07 |

---

## 7. 验证 SQL（5434/fengyu，仅 SELECT / EXPLAIN）

```sql
-- 1. 验证 is_experience 字段在 staff create 路径的写入情况（[P0-02v2-05]）
-- staff开单 = opened_by IS NOT NULL
SELECT
  so.sale_order_id,
  so.opened_by,
  BOOL_OR(si.is_experience) AS any_experience_true,
  COUNT(*) AS item_cnt
FROM sale_orders so
JOIN sale_items si ON si.sale_order_id = so.sale_order_id
WHERE so.opened_by IS NOT NULL
  AND so.created_at > NOW() - INTERVAL '30 days'
GROUP BY so.sale_order_id, so.opened_by
HAVING BOOL_OR(si.is_experience) = false
  -- 若存在 product_skus.is_experience=true 对应的 sku_id 则为漏写
LIMIT 20;

-- 2. 验证 is_experience 跨开单来源分布（[P0-02v2-05] 辅助）
SELECT
  so.opened_by IS NOT NULL AS staff_opened,
  si.is_experience,
  COUNT(*) AS cnt
FROM sale_orders so
JOIN sale_items si ON si.sale_order_id = so.sale_order_id
JOIN product_skus sk ON sk.sku_id = si.sku_id
WHERE sk.is_experience = true
  AND so.created_at > NOW() - INTERVAL '30 days'
GROUP BY 1, 2;
-- 期望：staff_opened=true 的行 is_experience 全为 false（证明漏写），client/admin 为 true

-- 3. 验证 allocation_status NULL 比例（[P1-02v2-06]）
SELECT
  status,
  allocation_status,
  opened_by IS NOT NULL AS is_staff_order,
  COUNT(*) AS cnt
FROM sale_orders
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- 4. 确认 admin confirmOfflinePayment 不写 payments 行（[P1-02v2-09]）
SELECT so.sale_order_id, so.status, so.received,
       COALESCE((
         SELECT SUM(amount) FROM sale_order_payments
         WHERE sale_order_id = so.sale_order_id
           AND status = '已支付'
           AND change_type IN ('首次支付','回款','储值卡抵扣')
       ), 0) AS payments_sum
FROM sale_orders so
WHERE so.status = '已支付'
  AND so.offline_confirmed_by IS NOT NULL
  AND COALESCE((
    SELECT SUM(amount) FROM sale_order_payments
    WHERE sale_order_id = so.sale_order_id
      AND status = '已支付'
  ), 0) < so.received - 0.01
LIMIT 20;

-- 5. 验证订单号重复（[P0-02v2-01]）
SELECT sale_order_id, COUNT(*) FROM sale_orders GROUP BY 1 HAVING COUNT(*) > 1;
-- 期望 0 行；任何行 = 审计现场抓到重号

-- 6. PG 实例时区（[P0-02v2-02] 风险面）
SHOW TIMEZONE;
SELECT current_setting('TIMEZONE'), NOW(), NOW() AT TIME ZONE 'Asia/Shanghai';

-- 7. saleOrderType 现有分布（[P1-02v2-08] 枚举精简影响评估）
-- 注 (2026-04-27)：枚举已精简为 3 值，此查询可确认历史数据中是否有 回款单/退款单 行需要迁移处理
SELECT sale_order_type, COUNT(*) FROM sale_orders GROUP BY 1 ORDER BY 1;

-- 8. 状态机非法历史检测（已支付 → 已关闭 路径，[P0-02v2-03 CLOSED 验证]）
SELECT entity_id, before_status, after_status, COUNT(*)
FROM operation_logs
WHERE entity_type = 'sale_order'
  AND action = 'order.close'
  AND before_status = '已支付'
  AND after_status = '已关闭'
GROUP BY 1, 2, 3;
-- v2 cancel CAS 已修复，此查询应仅返回修复前的历史数据

-- 9. sale_item_id 格式分布（[P1-02v2-10]）
SELECT
  CASE
    WHEN sale_item_id LIKE 'XSLSH-WX-%' THEN 'XSLSH-WX (staff/client)'
    WHEN sale_item_id LIKE 'FY-%-WX-%-%' THEN 'orderId-NN (admin)'
    ELSE 'OTHER' END AS fmt,
  COUNT(*) AS cnt
FROM sale_items GROUP BY 1;

-- 10. 同一日期上重复 sale_order_id（[P0-02v2-01/P0-02v2-02] 辅助）
SELECT SUBSTRING(sale_order_id FROM 11 FOR 6) AS dt,
       COUNT(*) AS cnt,
       COUNT(DISTINCT sale_order_id) AS uniq
FROM sale_orders WHERE sale_order_id LIKE 'FY-XSD-WX-%'
GROUP BY 1 HAVING COUNT(*) <> COUNT(DISTINCT sale_order_id);
```

---

## 8. 回归测试用例（建议）

1. **is_experience 快照一致性**（P0-02v2-05）：用店长开单购买 `is_experience=true` SKU → 确认收款后查 `sale_items.is_experience` = `true`；顾客 `customer_type` = `'体验客'`（不是 `'小美客'`）。
2. **并发开单不重号**（P0-02v2-01）：两个 staff.create 并发，断言两个 `saleOrderId` 不重复。
3. **跨夜 UTC 边界**（P0-02v2-02）：mock UTC `2026-04-25T23:55:00Z`（北京 2026-04-26T07:55:00）；三端各开一单，验订单号 dateStr 均为 `260426`（北京时间当天）。
4. **allocation_status 初值**（P1-02v2-06）：staff create 后立刻查 `sale_orders.allocation_status = '待分配'`（不是 NULL）。
5. **admin confirmOfflinePayment payments 流水**（P1-02v2-09）：admin 确认收款后查 `sale_order_payments` 有对应 `change_type='首次支付'` 行，且 `received` 与 SUM 一致。
6. **admin recordPayment scope 保护**（P0-02v2-03）：将 `sale_order:record_payment` 授予 manager → manager 对跨门店订单调 `recordPayment` 应返回 `PERMISSION_DENIED`。
7. **status CAS 保护**（CLOSED from v1 验证）：并发触发 client.cancel + staff.confirmOffline，断言只有一个成功。
8. **saleOrderType 枚举精简后旧数据读取**（P1-02v2-08）：→ **FIXED 2026-04-27**（枚举已精简为 3 值；历史数据迁移待确认）
9. **settlePointsSafe PG 死锁场景**（P1-02v2-05）：mock PG deadlock error，确认 confirmOffline 事务不静默提交（应抛出或回滚）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（is_experience 快照缺失影响历史 staff 开单订单；saleOrderType 枚举精简需迁移确认；`wechat_transaction_id` UNIQUE 僵尸约束需迁移确认）
- 修复成本：M（P0-02v2-05 is_experience 修复小；P0-02v2-01 generateOrderNo 重构中等；P1-02v2-09 admin payments 中等）

---

## 10. P0 总览（v3 最终）

| ID | 问题 | 状态 | 来源 |
|----|------|------|------|
| P0-02v2-01 | staff create generateOrderNo 双事务并发重号 | **OPEN** | v1 [P0-02-01] 确认 |
| P0-02v2-02 | 三端订单号 UTC vs PG 时区不一致 | **OPEN** | v1 [P0-02-02] 确认 |
| P0-02v2-03 | admin recordPayment 缺 isInScope 隐式合约 | **OPEN** | v1 [P0-02-05] 确认 |
| P0-02v2-05 | staff create INSERT sale_items 遗漏 is_experience | **OPEN** | **v2 新发现** |
| ~~P0-02-03~~ | client cancel 缺 CAS UPDATE 守卫 | **[CLOSED from v1]** | v2 验证已修复（行 1127-1133 `AND status = ANY(...)`） |
| ~~P0-02-04~~ | settlePointsSafe 回滚整笔收款 | **降级 P1**（P1-02v2-05） | v2 独立读 `utils/points.js`，try/catch 已隔离；仅 PG 死锁低概率残留 |

**OPEN P0：4 项 | CLOSED P0：1 项 | 降级 P1 P0：1 项**

---

## 11. 后续待办

- [ ] 与域 03（款项流水）对齐：`admin.confirmOfflinePayment` 不写 payments 是域 03 的核心遗漏
- [ ] 与域 04（payNotify 幂等）对齐：mock 微信支付如何转入真实回调
- [ ] 与域 05（服务单扣次）对齐：`is_experience` 遗漏同时影响 `recalcCustomerType`，需 `service.complete` 处同样复查；cancel 已支付路径与 service.start 的竞争
- [ ] 与域 07（销售提成）对齐：`allocation_status=NULL` 会导致提成分配列表漏单
- [ ] 与域 10（顾客会员等级）对齐：`is_experience` 快照遗漏影响历史订单的顾客类型分析
- [x] saleOrderType 枚举精简（P1-02v2-08）迁移时需与 admin UI filter 联动确认 → **FIXED 2026-04-27**（枚举已精简为 3 值）
- [ ] `wechat_transaction_id`/`alipay_transaction_id` UNIQUE 僵尸约束迁移确认（CC9）

---

## 12. 横切归集

- CC1 → CROSS-CUTTING.md 新增 "数值精度：JS Number vs PG NUMERIC 边界"（P1-02v2-05 关联）
- CC2 → CROSS-CUTTING.md 新增 "advisory lock 跨事务释放窗口"（P0-02v2-01）
- CC2 → CROSS-CUTTING.md 新增 "状态机 CAS UPDATE 守卫"（[CLOSED P0-02-03]）
- CC2 → CROSS-CUTTING.md 新增 "PG 死锁 vs JS 异常事务行为差异"（P1-02v2-05）
- CC3 → CROSS-CUTTING.md 新增 "admin scope 隐式合约"（P0-02v2-03）
- CC5 → CROSS-CUTTING.md 新增 "错误前缀约定：4 种 vs 实际偏离"（P2-02v2-13, P2-02v2-16）
- CC7 → CROSS-CUTTING.md 新增 "时区不一致：UTC vs PG NOW vs Asia/Shanghai"（P0-02v2-02）
- CC9 → CROSS-CUTTING.md 新增 "PG UNIQUE 约束僵尸检测"（wechat_transaction_id）

## 13. Schema 修改建议追加

- S02-1 `uq_sale_orders_phone_pending` 索引去掉 store_id 维度（P1-02v2-11）
- S02-2 `sale_orders.allocation_status` 加默认值 `'待分配'`（P1-02v2-06）
- S02-3 集群级 `SET timezone = 'Asia/Shanghai'`（P0-02v2-02）
- S02-4 `saleOrderTypeEnum` 精简为 3 值（销售单/内部单/转换单）（P1-02v2-08）→ **FIXED 2026-04-27**
- S02-5 确认 `wechat_transaction_id`/`alipay_transaction_id` UNIQUE 僵尸约束已移除（P1-02v2-09）

## 14. 枚举发现追加

- E02-order-status：8 值齐全 ✅；三端允许迁移子集不一致 → 文档化建议（不改枚举）
- E02-sale-order-type：5 值枚举 vs 3 值实际约束，建议精简（P1-02v2-08）→ **FIXED 2026-04-27**（已精简为 3 值）

---

**v1 报告备份已归档为** `docs/audit/audit-02-order-creation-v1-archived-20260426.md`（建议归档，本文件为现行版本）
