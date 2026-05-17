# 三端逻辑审计 — 总览报告（SUMMARY）

**编制时间**：2026-04-26（v1）/ 2026-04-27（v2）/ **2026-05-17（v3 — 当前）**
**审计范围**：admin (Next.js 15) / staff (staffApi) / client (clientApi) + payNotify + db schema + cron-worker
**输入来源**：34 份 audit-NN 子报告 + CROSS-CUTTING.md + SCHEMA-CHANGES.md + ENUM-AUDIT.md
**评级标准**：见 `notes/references/audit_plan.md` §1（P0 = 资损/越权/状态机崩坏；P1 = 数据一致；P2 = 代码质量）

---

### v3 更新摘要（2026-05-17，基于当前代码核验）

距上次更新（2026-04-27）已过去约 3 周，期间共 ~50 个 commit 落地。本轮逐项核验了 Top 10 P0 与横切热点，对照 schema / 路由代码 / 归档 ticket 重置状态：

| 维度 | v2（2026-04-27） | v3（2026-05-17） | 变化 |
|------|------------------|-------------------|------|
| 业务域 P0（25 域） | 124 | **111** | **-13**（11 项关闭 + 2 项降级）|
| 横切域 P0（9 域） | 38 | **32** | **-6**（CC4/CC9/CC1/CC2 各关 1-2 条）|
| **全栈 P0 合计** | **162** | **143** | **-19** |

**v3 期间新关闭的 P0**（验证依据见 §2 Top 10 与归档 ticket）：

| # | 项目 | 关闭依据 |
|---|------|---------|
| 1 | #2 `_testOpenid` ALLOW_TEST_OPENID 门控 | `staffApi/middleware/auth.js:104` 已加 env 守卫；ticket 已归档 |
| 2 | #4 admin createOrder 优惠券 4 维度校验 | `fengyu-admin/src/actions/orders.ts:952-988` 已实施 store/market/category/product 全维度过滤 |
| 3 | #5 admin createConversion / applyRecharge `store_id` 引用 | `prepaid_cards.store_id` 已 DROP；orders.ts 重写完成 |
| 4 | #7 client requestUnbind `from_store_name` 列引用 | `clientApi/routes/store.js:156` 已改为 `from_store_id` |
| 5 | #8 sale_allocations.allocation_ratio CHECK | migration 0022 已 apply：`IN (0.10, 0.20, ..., 1.00)` |
| 6 | #8b service_commissions commission_rate/amount/alloc_ratio CHECK | migration 0022 同步落地 |
| 7 | #9 staff customer 6 路由 + performanceDetail scope 隔离 | `routes/customer.js` 全部加 `effectiveStoreId` WHERE + requireManager + audit log；`routes/staff.js:444-461` 加 scope 守卫 |
| 8 | #13 admin settlePoints | `fengyu-admin/src/lib/points-settle.ts` + `actions/orders.ts:592, 2055` 两触发点；测试用例 P0-15-01 守护 |
| 9 | #15 settlePoints 跨端漂移 | 四端独立副本 + `cross-end-sql-snapshot.test.js` 字面量守护（用户拒绝 cloudfunctions-shared 抽取，feedback `no-shared-cloudfunctions`）|
| 10 | payNotify settlePoints 接入 | commit `6b32787`：`payNotify/index.js:549` 接入 `settlePointsSafe` + 跨端 SQL 一致性快照守护 |
| 11 | S04-1 已删字段（paid_amount / wechat_transaction_id / alipay_transaction_id）| migration 0018 已 DROP（staff/admin 业务代码已切干净；payNotify 仍有残留，见下表）|
| 12 | S04-2 `uq_sop_status_audit` partial unique 索引 | migration 0018 已部署，覆盖退款 in-flight 并发 |
| 13 | sale_orders 7 列退款专属下沉至 sop | migration 0025（2026-05-17）DROP `refund_reason/handling_fee/approved_by/approved_at/rejected_reason/overdraft_deduction/overdraft_deduction_detail`|
| 14 | E9 Round 2 capability 列收敛 | commit `ed3bf1f`：`is_recharge_card` SKU capability + 与 is_experience 互斥校验（E9 第 2 项完成）|
| 15 | refund_create / refund_approve 权限拆分 | commit `f873bd1` + `8a30454`：PERMISSION_MATRIX 拆分 + admin 拿回 approve 权限 |
| 16 | cron `audit-payment-invariants` + `close-expired-appointments` 落地 | `fengyu-admin/src/cron/steps/` 已存在（Q4 决策） |

**v3 期间仍未关闭、需要专项排期的 P0**：见 §2 新 Top 10。

---

## 1. 总览（25 业务 + 9 横切）

### 1.1 业务域（25），按 P0 降序

| NN | 域 | P0 | P1 | P2 | 总计 | 报告 |
|----|----|----|----|----|------|------|
| 13 | 优惠券 | 8 | 7 | 6 | 21 | audit-13-coupons.md |
| 05 | 服务单 + 扣次原子性 | 8 | 8 | 5 | 21 | audit-05-service-order.md |
| 11 | 退款 / 退换货 | 7 | 6 | 6 | 19 | audit-11-refunds.md |
| 08 | 服务提成 | 6 | 8 | 5 | 19 | audit-08-service-commission.md |
| 10 | 顾客 + 会员等级 | 5 | 9 | 6 | 20 | audit-10-customer-member-level.md |
| 12 | 门店绑定 / 解绑 | 6 | 7 | 5 | 18 | audit-12-store-binding.md |
| 15 | 积分 + 等级跳档 | 4 | 9 | 7 | 20 | audit-15-points-member-level.md |
| 17 | 数据看板 | 6 | 7 | 6 | 19 | audit-17-dashboard.md |
| 01 | 认证 / 鉴权 / 双端用户表隔离 | 5 | 4 | 3 | 12 | audit-01-auth.md |
| 06 | 预约 + 签到 → 服务单流转 | 5 | 9 | 6 | 20 | audit-06-appointment-checkin.md |
| 19 | 赠送 / 分享 / 客户分配 | 5 | 7 | 6 | 18 | audit-19-gift-share-assign.md |
| 21 | 组织架构 | 5 | 8 | 6 | 19 | audit-21-org-structure.md |
| 14 | 充值卡 + 卡流水 | 5 | 7 | 5 | 17 | audit-14-prepaid-card.md |
| 25 | 流量 / 推广员 | 5 | 7 | 8 | 20 | audit-25-traffic-promoter.md |
| 02 | 开单 + 状态机 + 订单号唯一 | 5 | 8 | 6 | 19 | audit-02-order-creation.md |
| 03 | 款项流水（sale_order_payments）| 5 | 7 | 8 | 20 | audit-03-payment-flow.md |
| 07 | 销售提成分配 | 5 | 7 | 6 | 18 | audit-07-sales-allocation.md |
| 04 | 支付回调 / payNotify 幂等 | 4 | 7 | 6 | 17 | audit-04-pay-notify.md |
| 16 | 消息中心 | 4 | 7 | 4 | 15 | audit-16-message-center.md |
| 09 | 商品 + SKU + 价格 + 有效期 | 3 | 8 | 5 | 16 | audit-09-product-sku.md |
| 18 | 员工绩效 | 3 | 7 | 5 | 15 | audit-18-employee-performance.md |
| 22 | 权限矩阵 + 角色 | 3 | 5 | 3 | 11 | audit-22-permission-matrix.md |
| 23 | 操作日志 | 3 | 6 | 6 | 15 | audit-23-operation-logs.md |
| 20 | 家居产品提货 | 3 | 8 | 6 | 17 | audit-20-pickup.md |
| 24 | 品项分类动态字段 | 2 | 7 | 5 | 14 | audit-24-product-category-dynamic.md |
| **业务小计** |  | **124** | **188** | **144** | **456** |  |

### 1.2 横切域（9），按 P0 降序（2026-04-26 v2 合并后）

| ID | 横切域 | P0 | P1 | P2 | 总计 | 报告 |
|----|--------|----|----|----|------|------|
| CC4 | 后端鉴权 | 11 | 5 | 3 | 19 | audit-CC4-auth.md |
| CC2 | 并发与幂等 | 6 | 6 | 5 | 17 | audit-CC2-concurrency-idempotency.md |
| CC3 | 组织域隔离 | 7 | 9 | 5 | 21 | audit-CC3-org-isolation.md |
| CC1 | 数值精度与金额 | 4 | 7 | 5 | 16 | audit-CC1-numeric-precision.md |
| CC9 | 测试与迁移残留 | 3 | 6 | 10 | 19 | audit-CC9-test-migration-residue.md |
| CC6 | PII | 4 | 4 | 4 | 12 | audit-CC6-pii.md |
| CC7 | 时间字段 | 3 | 10 | 4 | 17 | audit-CC7-time-field.md |
| CC5 | 错误码 | 0 | 4 | 6 | 10 | audit-CC5-error-code.md |
| CC8 | WXML / Vant | 0 | 5 | 11 | 16 | audit-CC8-wxml-vant.md |
| **横切小计** |  | **38** | **56** | **53** | **147** | 

### 1.3 全栈合计

| 维度 | P0 (v2) | P0 (v3) | P1 | P2 | 总计 (v3) |
|------|---------|---------|----|----|-----------|
| 业务域（25）| 124 | **111** | 188 | 144 | 443 |
| 横切域（9）| 38 | **32** | 56 | 53 | 141 |
| **合计** | 162 | **143** | **244** | **197** | **584** |

> v3 P0 关闭明细见开篇"v3 更新摘要"表；§1.1 与 §1.2 的单域计数本轮未逐条重算（域内 P0 互相覆盖，单域计数仅作参考），优先关注总合计与 §2 Top 10。


---

## 2. Top 10 P0（v3 — 按资损/越权严重度排序，2026-05-17 重置）

> 优先级：**资金资损 > 跨用户/跨店越权 > 数据混乱 > 状态机崩坏**
> 修复成本：S = 半天 / M = 1-3 天 / L = 1 周以上
> v2 表中已关闭的 11 项移至 §2.1 关闭归档；v3 新榜单按"剩余风险 + 剩余资损"重排。

| # | 标题 | 来源 | 影响范围 | 修复成本 | 状态 |
|---|------|------|---------|---------|------|
| **1** | **payNotify 仍 PAYNOTIFY_DISABLED=true，且业务代码残留已 DROP 字段引用**（`payNotify/index.js:54` 全锁；解锁前 L127/148/271/283 仍 SELECT/UPDATE `sale_orders.wechat_transaction_id` 已 DROP 列 → 42703 崩溃）— 整个微信支付通道仍未对接；线上结算依赖店长 confirmOffline + 储值卡，对外仍是单一信任点 | P0-04-01 + P0-CC4-01 + P0-CC2-v2-01 | 全栈支付链；命中 real.md #3 + #5 | **L** |
| **2** | **staff service.create 写入不存在的 sku_id 列** — `routes/service.js:208-211` 仍 INSERT INTO service_items (..., sku_id, ...); 但 service_items 表实际无 sku_id 列（仅 sale_items 有）。**e2e 测试 `smoke-service-lifecycle.mjs` 注释明确标注"当前生产 bug，绕过 service.create"** | P0-05-01 / P0-CC9-01 | staff 核心服务流；CI mock 反向锁死 | **S** |
| **3** | **Advisory lock 跨事务释放窗口可生成重号** — `staffApi/routes/order.js:2473-2495` generateOrderNo 自带独立 `pg.transaction()`，advisory_xact_lock 随子事务 commit 释放；外层 order.create 在 L540 又开新事务才 INSERT；两事务之间存在 TOCTOU 窗口 | P0-02-01 + P0-05-02 + P0-11-03 → P0-CC2-01/04 | 订单号 / 退款单号 / 服务单号 三类业务 ID 唯一性破坏 | **M** |
| **4** | **admin server action 缺统一鉴权 wrapper** — `requirePermission` 已在 208 处调用（覆盖 171 个 action）但仍是显式调用，无 wrapper HOF，新增 action 容易漏；hasPermission 模块归属 2026-05-17 刚做完重整（commit 8a30454）但 wrapper 仍未抽 | P0-CC4-02 | admin 全 action 越权防御深度不足 | **M** |
| **5** | **client order.create 无券路径 totalAmount 未 Math.round** — `clientApi/routes/order.js:240-247` `totalAmount += saleAmount` 累加后无券路径不再 round（L391-392 的 round 只在 `if (couponInfo)` 块内），直写库；最终 paidAmount 虽 round，但 sale_orders.total_amount 保留浮点 | P0-CC1-v2-01 | client 所有无优惠券订单 total_amount 浮点漂移 ±0.005 | **S** |
| **6** | **L0 一次性 migration epic 剩余 8 项**（时区 / 充值卡余额 / point/card_transactions 符号 / point bigint / 11→10 项 partial unique / sale_orders.allocation_status default 等）— 退款 in-flight 已由 `uq_sop_status_audit` 覆盖；ratio/commission CHECK 已落 migration 0022；剩余项零碎积压 | L0 P0（13→5 剩 8）| 数值/并发/时区不变量在 DB 层无兜底 | **M** |
| **7** | **PII 三端日志全无脱敏 + admin 物理硬删 PII 字段** — `db/helpers/pii.ts` 仍未抽出；操作日志 detail 字段未 sanitize；admin deleteSku / deleteMessage / point_transactions 仍走物理 DELETE | P0-CC6 + 多域 | 个保法合规风险，不可量化资损 | **M** |
| **8** | **状态机 UPDATE 缺 CAS 守卫（约 12 处路径）** — order/payment/appointment/service 多处 `UPDATE ... WHERE id = $1` 未带 `AND status = $prev`；事务并发下可越级状态 | 02/03/04/06/12/CC2 | 跨表状态机不变量破坏 | **M** |
| **9** | **TOCTOU partial UNIQUE 索引剩 10 项**（退款 in-flight 那 1 项已落地）— 优惠券模板发放、appointment 时段、unbind 申请等仍依赖事务外读 | L0 P0（11→10 剩） | 兜底防御缺失（应用层并发抢占可绕过）| **M** |
| **10** | **错误前缀 4→8 项白名单未抽 + admin 裸 throw 未统一** — `cloudfunctions-shared/error-codes.js`（用户已 veto 共享目录，feedback `no-shared-cloudfunctions`）；改为各端各自 error-codes.js + 跨端字面量 snapshot 守护方案待落 | P0-CC5 + 多域 | 前端错误识别不一致 | **S** |

### Top 10 之外的 5 个高敏 P0（v3）

| # | 标题 | 来源 | v3 状态 |
|---|------|------|---------|
| 11 | admin createOrder/staff/client 三端 face_value_override 跨端读取漂移 | P0-13-02 残留 | admin 三处已读 COALESCE(face_value_override, discount_value)；staff/client 仍需核 |
| 12 | 跨表 OPENID 唯一 — 已作废（D-Q2 决策） | — | ✅ v2 已降级 |
| 13 | scope helper assertOrderInScope/assertCustomerInScope 仍未抽 | P0-CC3 衍生 | scope 过滤在路由层已加，但 helper 集中化未做（用户 veto 共享目录后改测试守护，仍待跨端审计） |
| 14 | refund-cascade 跨端字面量漂移守护 | 跨端 SQL 守护 | admin TS / staff JS 双副本已落地；snapshot 测试覆盖 settlePoints 与 applyRecharge，refund-cascade 暂无 |
| 15 | dashboard 三端业绩口径对齐测试 | P1-CC1 | admin 已切 `received - refunded_amount`；staff mgmtDashboard 需要 dashboard.consistency.test.ts 守护 |

### 2.1 v2 → v3 关闭归档（11 项 P0 已落地）

> 出于审计追溯性目的保留，详细关闭依据见开篇"v3 更新摘要"。

| 关闭项 | 关闭依据 | Migration / Commit |
|--------|---------|---------------------|
| ✅ 退款审批 5 通道 cascade | refund-cascade.js + .ts 双端 + sale_order_type 5→3 + uq_sop_status_audit 并发守卫 | 0018 / 0019 / 0021 / sale-order-domain-refactor ticket |
| ✅ staffApi `_testOpenid` ALLOW_TEST_OPENID 门控 | `middleware/auth.js:104` 加 env 守卫 | 2026-04-27 ticket 归档 |
| ✅ admin createOrder 优惠券 4 维度校验 | orders.ts L935-988 全实施 | 2026-04-27 coupon-scope-validation ticket |
| ✅ admin applyRecharge/createConversion store_id 引用 | prepaid_cards.store_id DROP；orders.ts 重写 | 2026-04-24 双库 drift 修复 + orders.ts 重构 |
| ✅ client requestUnbind from_store_name | routes/store.js:156 改为 from_store_id | 2026-04-27 ticket 归档 |
| ✅ sale_allocations / service_commissions CHECK | migration 0022 chk_sale_alloc_ratio + chk_svc_comm_* | 0022 |
| ✅ staff customer 6 路由 + performanceDetail scope 隔离 | customer.js 全部 effectiveStoreId + requireManager；staff.js performanceDetail L444-461 scope 守卫 | 2026-04-27 staff-customer-scope-isolation ticket |
| ✅ admin settlePoints 三大触发点 | orders.ts L592/L2055 + 测试 P0-15-01 守护 | settlePoints-on-sale-order ticket |
| ✅ admin getDashboardStats 公式 | actions/dashboard.ts L92-136 `received - refunded_amount` + sale_order_type IN ('销售单','转换单') | 2026-04-27 dashboard 重写 |
| ✅ S04-1 sale_orders 冗余三方流水列 DROP | migration 0018 | 0018 |
| ✅ S04-2 uq_sop_status_audit partial unique | migration 0018 | 0018 |
| ✅ E9 Round 2 is_recharge_card capability + 互斥校验 | commit ed3bf1f | recharge-card-as-sku-flag ticket |
| ✅ refund_create / refund_approve 权限拆分 | commit f873bd1 + 8a30454 PERMISSION_MATRIX 改写 | refund-admin-parity ticket |
| ✅ payNotify settlePoints 接入 | commit 6b32787 payNotify/index.js:549 + cross-end-sql-snapshot.test.js | payNotify 积分结算 + 守护 commit |
| ✅ cron audit-payment-invariants + close-expired-appointments | fengyu-admin/src/cron/steps/ 已存在 | Q4 决策 |
| ✅ sale_orders 7 项退款专属列 DROP | migration 0025 | 2026-05-17 sale-order-domain-refactor §11 收尾 |

---

## 3. 横切热点（≥ 3 次同类问题，v3 状态更新）

| 模式名称 | 命中域数 | 命中域列表 | 修复路径 / v3 状态 |
|---------|---------|----------|------------------|
| **退款不冲销次数等价物（5 通道）** | 5 | 07/08/11/15/20 | **✅ 已修复（2026-04-26/27）**：refund-cascade.js/ts 双端落地 + 5 通道全量回滚 + sale_order_type 5→3 + uq_sop_status_audit 并发守卫 |
| **代码引用已删 schema 字段** | 4→**1** | ~~12(from_store_name)~~ ✅ / ~~14(store_id)~~ ✅ / ~~09(valid_start/end)~~ ✅ / **05(service_items.sku_id) 仍 ❌** | migration 0003 后所有 DROP/RENAME 全仓 grep；CI 加 typecheck + drizzle-kit check；**仅剩 service.create 待修** |
| **测试反向锁死错误代码** | 5+→**2** | ~~08/12/14/24~~ ✅ / CC9（service.create + payNotify 守卫态残留） | 修 P0 同步删/改测试；CI lint "测试不应锁死 schema 字面量" |
| **时区漂移** | 5 | 02/05/06/17/18/CC7 | `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'` 仍待跑 + 三端禁 `new Date().toISOString().slice()` |
| **scope 过滤非全覆盖** | 8+→**3** | ~~10/11/19~~ ✅（staff customer/performanceDetail 全部已加） / 01/02/CC3/CC4 仍待 scope helper 抽出 | 强制 staffApi/clientApi/admin 三端 scope helper + middleware assert |
| **同业务工具三/四端副本漂移** | 6+→**3** | ~~15(settlePoints)~~ ✅ snapshot 守护 / ~~07(DELETE→is_void)~~ ✅ migration 0022 / ~~14 充值卡逻辑~~ ✅ E9 R2 / 08(roleType×3) / 10(customer_type×2) / 20(remaining×5) 仍待 | 用户 veto 共享目录后改 `cross-end-sql-snapshot.test.js` 字面量守护方案；剩余项各端各落 |
| **schema 字段写入完整但消费 0** | 4 | 06(过期关闭)✅ cron 已落 / 10(monthly_activity)待 / 13(applicable_xxx_ids)✅ 校验已落 / 25(promoter_employee_id)待 | spec/schema docstring 关键字 grep + cron STEP 补齐 |
| **状态机 UPDATE 缺 CAS 守卫** | 5+ 路径 | 02/03/04/06/12/CC2 — 共 12 处 | 全仓 `UPDATE.*WHERE.*_id` 扫描 + CI lint 强制 `AND status =`（v3 未推进） |
| **TOCTOU：事务外读 → 事务内 INSERT 无 partial unique** | 7→**6** | 03/05/06/12/13×2/CC2 — ~~退款 in-flight~~ ✅ `uq_sop_status_audit` | 剩 10 项 partial UNIQUE 索引一次性 migration |
| **错误前缀偏离 4 项约定 + admin 裸 throw** | 多域 | 01/02/03/04/24/CC5 | 共享方案被 veto；改各端 error-codes.js + snapshot 守护（待落） |
| **PII 三端日志全无脱敏** | 多域 | 01/04/16/CC6 | `db/helpers/pii.ts` mask 系列 + logOperation sanitizeDetail（v3 未推进） |
| **admin 物理硬删 vs 软删双轨** | 多 | 09(deleteSku) / 15(point_transactions) / 16(deleteMessage) | 关键流水/PII 表统一软删 + 删除前置 logOperation（v3 未推进） |
| **金额/比例字段无 CHECK 约束** | 5+→**2** | ~~07(ratio)~~ ✅ / ~~svc_comm~~ ✅ migration 0022 / 14(card_tx) / 15(pt) 待 | 一次性补齐剩余 2 项 CHECK |

---

## 4. 修复 Roadmap（按 L0→L11 传播层）

### L0 — Schema / Enums 层（一次性 migration epic — v3 更新）

**P0（剩 5 项）**：手机号 CHECK（S01-1）/ card_transactions 符号 CHECK（S-CC1-2）/ point_transactions 符号 CHECK + bigint（S-CC1-2）/ prepaid_cards.balance >= 0（S-CC2-11）/ PG timezone = Asia/Shanghai（S-CC7-1）/ 剩余 10 项 partial UNIQUE 索引

**已关闭**：~~跨表 OPENID 唯一（S01-2）~~ 作废 / ~~sale_orders 金额符号联动 CHECK（S03-4）~~ 架构性作废 / ~~service_commissions voided_at（S-CC7-2）~~ migration 0018 / ~~sale_allocations.allocation_ratio CHECK（S-CC1-1）~~ migration 0022 / ~~commission_rate CHECK（S-CC1-3）~~ migration 0022 / ~~退款 in-flight partial unique~~ migration 0018 uq_sop_status_audit / ~~删除冗余列 sale_orders.wechat_transaction_id + alipay_transaction_id（S04-1）~~ migration 0018 / ~~uq_sop_txn 去除 method 维度（S04-2）~~ migration 0018 / ~~7 项退款专属列 DROP~~ migration 0025

**P1（5 项）**：roleEnum PG enum / productKindEnum PG enum / system_configs 加 special_card_kind_id / sale_orders.allocation_status 加 default '待分配' / PII 历史 operation_logs.detail 一次性脱敏

**P2（2 项）**：products.display_icon 删除决策 / staff_wechat_users.store_id 重命名

### L1 — Helpers 层（v3 更新）

**P0（剩 6 项）**：`db/helpers/phone.ts` / `db/helpers/pii.ts` / `db/helpers/scope.ts`（含 assertCustomerInScope/assertEmployeeInScope/assertOrderInScope）/ `db/helpers/money.ts` / 各端 `error-codes.js`（用户 veto 共享目录） + 字面量 snapshot 守护 / `db/helpers/role-resolve.ts`

**已关闭**：~~refund-cascade.ts~~ ✅ 已落地（admin TS + staff JS 双副本）/ ~~settlePoints 四端 + applyRecharge 三端~~ ✅ `cross-end-sql-snapshot.test.js` 字面量守护

**P1（3 项）**：`db/helpers/dashboard-metrics.ts` / `db/helpers/sale-item-availability.ts` / 跨端 sanitize 字面量守护

### L3 — 三端 routes / actions 层（v3 更新）

**P0（剩 7 项关键 patch）**：
- **payNotify/index.js** — 接入 V3 签名 + AEAD + IP 白名单 + 清理 wechat_transaction_id 残留（解锁前 L127/148/271/283 仍 SELECT/UPDATE 已 DROP 列）
- **staffApi/routes/order.js generateOrderNo** — 改单事务（移除内部 pg.transaction，把 advisory_xact_lock 放到 order.create 主事务里）
- **staffApi/routes/service.js** — 移除 INSERT INTO service_items 的 sku_id 列引用（L208-211）
- **client order.js** — 无券路径补齐 totalAmount Math.round（L247 累加后 / L542 写库前）
- **staff/client order.create** — face_value_override 跨端读取漂移核查
- **close/cancel/closeExpired 三端** — 状态推进同事务 cascade payments/sa
- **12 处 UPDATE 加 CAS 守卫**（02/03/04/06/12）

**已关闭**：~~admin/actions/orders.ts applyRecharge/createConversion store_id~~ ✅ / ~~admin createOrder 优惠券 server-side 校验范围~~ ✅ / ~~clientApi/routes/store.js requestUnbind from_store_name~~ ✅ / ~~staffApi/routes/customer.js 6 路由 scope WHERE + audit log~~ ✅ / ~~approveRefund 三端 5 通道 cascade~~ ✅ / ~~payNotify + admin sa 写入后置 settlePoints~~ ✅

**P1（约 60 项）**：详见各 audit §6 表（v3 未逐条核验）

### L4 — Cron-worker 层

**P0（5 项）**：refresh-monthly-activity.ts 新建 / refresh-member-levels.ts 范围扩到全 customer_type / close-expired-appointments.ts 新建 / audit-prepaid-balance.ts 新建 / audit-money-invariants.ts 新建

**P1（3 项）**：member_level vs spending_tier 口径统一 / cron 自动发放接 totalCount / 偏差告警工单化

### L7 — admin lib 层

**P0（6 项）**：`lib/auth.ts` 加 `withPermission` HOF / `lib/api-error.ts` 新建 / PERMISSION_MATRIX 增独立权限项（appointment:cancel / sale_order:reject_refund 等）/ assignRole 校验 scope.type + admin 撤销保护 / `lib/operation-log.ts` 写入前 sanitizeDetail / `lib/format.ts` formatPhoneSafe

**P1（2 项）**：PERMISSION_MATRIX DB 化（system_configs）/ 非 admin scope 改子树包含

### L9 — Spec 层（文档校对）

**P1（6 项）**：backend.pr.spec.md valid_start/valid_end → is_enabled 全量替换 / '储值卡抵扣' 启用范围说明刷新 / admin.pr.spec.md 增 prepaid_cards 余额管理 UI / sys.spec.md 错误前缀 4→8 项扩展 / sys.spec 添加 cron STEP 配套 schema docstring 守卫 / CLAUDE.md 增跨端复制函数禁令

**P2（2 项）**：dashboard 时间维度 memory 增业绩公式 / 归档 db/scripts/sync-products-from-workfine.js + staffApi/db/mssql.js

### L11 — Cron 守护层

**P0（5 项）**：audit-money-invariants.ts（5 项不变量）/ audit-prepaid-balance.ts / audit-store-unbind-orphans.ts / audit-refund-cascade-coverage.ts / audit-payment-invariants.ts（STEP 7，验证退款 5 通道不变量，2026-04-27 新增）

**P1（2 项）**：dashboard.consistency.test.ts 三端业绩对齐 / CC1 不变量与 ops 工单联动

### Roadmap 总条数（v3 — 2026-05-17）

| 层 | P0 (v2) | P0 (v3) | P1 | P2 | 小计 (v3) |
|----|---------|---------|----|----|-----------|
| L0 | 13 | **5** | 5 | 2 | 12 |
| L1 | 8 | **6** | 3 | 0 | 9 |
| L3 | 16 | **7** | ~60 | — | ~67 |
| L4 | 5 | **2**（剩 STEP 6 dashboard 守护 + STEP 8 partial-unique 巡检）| 3 | 0 | 5 |
| L7 | 6 | **4**（剩 withPermission HOF / PERMISSION_MATRIX DB 化 / api-error / formatPhoneSafe）| 2 | 0 | 6 |
| L9 | 0 | 0 | 6 | 2 | 8 |
| L11 | 5 | **2**（剩 audit-store-unbind-orphans / audit-refund-cascade-coverage）| 2 | 0 | 4 |
| **合计** | **53** | **26** | **81** | **4** | **111** |

> v3 关闭 **27** 项 P0。剩余 26 项 P0 的 60% 集中在 L0/L1/L3 三层 — 仍是 schema migration → helpers → routes 三层串行优先。L4/L11 cron 已有 audit-payment-invariants + close-expired 落地，剩余守护脚本与 L1 helpers 并行。

---

## 5. 决策与重大风险

### 5.1 用户已决策（2026-04-26）

| 决策 | 内容 |
|------|------|
| D-Q6.1-2026-04-27 | **big bang 实施**：sale_order_type_enum 5→3，migration 0019+0021 已 apply，enum 收窄为（'销售单','内部单','转换单'），代码全端已切换 |
| D-Q6.2-2026-04-27 | **sale_order_payment_details 1:1 子表**：operator_employee_id/note 移至子表，退款专属字段（refund_reason, ref_sale_item_id, session_count, audit_*）和审批专属字段全部下沉至 details 子表 |
| D-Q6.3-2026-04-27 | **5 通道全量回滚**：历史数据 0 行无需迁移；cascade 逻辑已实现（admin refunds.ts + staffApi order.js），覆盖 sale_allocations/service_commissions/user_coupons/point_transactions/pickup_records |
| D-CC1-2026-04-26 | 保留 `sale_allocations.allocationRatio = NUMERIC(5,2)` 不升级，仍需补 IN-集合 CHECK |
| D-Q1-2026-04-26 | payNotify 立即停用直到补完签名校验（注入 NODE_ENV 守卫直接抛 503）|
| D-Q2-2026-04-26 | 跨表 OPENID 唯一约束**作废**（appid scoped 物理保证），audit-01 P0-SPLIT-04 降 P2 文档化 |
| D-Q3-2026-04-26 | PERMISSION_MATRIX DB 化（system_configs.permission_matrix），admin 增管理页 |
| D-Q4-2026-04-26 | 过期 appointment 自动关闭（新建 cron close-expired-appointments + 一次性回填）|
| D-Q5-2026-04-26 | 跃迁规则：流量/体验/小美/会员客按单笔订单 received vs new_member_threshold + 是否含体验卡 SKU 触发；spending_tier 仅 BI；member_level 仅会员客有；audit-10 P0-10-06 / audit-15 P0-15-04/05 共 3 条降级。**ticket** [2026-04-26-experience-card-as-sku-flag](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md) **Round 1 已落地**（2026-04-26）：`product_skus.is_experience` + `sale_items.is_experience` 两列 + migration 0017 + admin/staff/client 三端代码全部切换至 capability 列；跃迁 SQL/cron-worker/共享 helper 待 Round 2 |
| D-Q7-2026-04-26 | rate=0 抛错 `INVALID_STATE: COMMISSION_RATE_MISSING:`；admin 增"待补矩阵告警"页 |
| D-Q8-2026-04-26 | sale_allocations 仅软删（is_void=true, voided_at=NOW()）；staff 三处硬 DELETE 改造，admin/staff/cron 读取加 `WHERE is_void=false` |
| D-Q9-2026-04-26 | 提成按 `skills[0] \|\| '美容师'`；抽 `db/helpers/role-resolve.ts`；3 端副本（staff/admin/payNotify）收敛 |
| D-Q10-2026-04-26 | 服务单号统一 FY-FW；HLD-WX 开发期遗留一次性 UPDATE 转换；staff 代码统一前缀生成 |
| D-Q11-2026-04-26 | 线上支付走拉卡拉（未对接），微信签名校验方案作废；接入前 payNotify 全锁线下/储值卡通道 |
| D-Q12-2026-04-26 | assignRole admin 自删保护：阻断撤销最后一个 admin（≥1 admin 守卫，revokeRole + employees.updateEmployee(isResigned=true) 同时 guard）|
| D-WF-2026-04-16 | 停用 WorkFine 同步，全部 db/scripts 同步模块归档 |
| D-DB-2026-04-24 | 5434/fengyu 唯一生产业务库；5433 退冷备 |
| D-DRIZZLE-2026-04-10 | 5434 + 5433 双库 baseline reset 全闭环 |

### 5.2 待用户决策清单（2026-04-26 更新）

12 项原清单已全部答复，见 §5.1 决策表（Q1/Q2/Q3/Q4/Q5/Q6/Q7/Q8/Q9/Q10/Q11/Q12）；Q5.1/Q5.2 已通过 ticket 2026-04-26-experience-card-as-sku-flag Round 1 答复并落地（见下表 ✅ 行）；Q6.1/Q6.2/Q6.3 已于 2026-04-27 答复并落地（见下表 ✅ 行）：

| # | 决策项 | 答复 / 推荐方向 | 状态 |
|---|--------|---------------|------|
| Q5.1 | "非体验卡"判定字段（product_kind / is_trial / 名字 LIKE）| **`product_skus.is_experience boolean`** + `sale_items.is_experience` 行级快照（capability 列模式，物理隔离体验卡 SKU 与商城商品） | ✅ Round 1 已落地（migration 0017 + 三端） |
| Q5.2 | 单笔混合订单（体验卡 + 普通商品）跃迁怎么算？ | **按"非体验部分总额"判跃迁**：`order_non_trial_amount = SUM(received WHERE NOT is_experience)`；混合订单 non_trial≥threshold→会员客，>0→小美客，仅体验部分→体验客 | ✅ schema 字段就位；跃迁 SQL Round 2 落地 |
| Q6.1 | sale_order_type 5→3 重构排期：双轨过渡 vs big bang | **big bang（Q6.1=B）**：migration 0019+0021 已 apply，enum 5→3，代码全端已切换 | ✅ 已落地（2026-04-27） |
| Q6.2 | sale_order_payments 是否需补 audit_status / audit_employee_id / refund_reason 等列承载退款单字段？ | **sale_order_payment_details 1:1 子表（Q6.2=B）**：operator/note/退款专属/审批专属字段全部下沉 | ✅ 已落地（2026-04-27） |
| Q6.3 | 历史回款单/退款单迁移时是否一并冲销 sa/sc/coupons/points/pickup？ | **5 通道全量回滚（Q6.3=A）**：历史数据 0 行无需迁移；cascade 逻辑已实现 | ✅ 已落地（2026-04-27） |

### 5.3 资损金额估算（v3）

| 风险 | 资损规模 / 月 | v3 状态 |
|------|--------------|---------|
| payNotify 伪造支付 | **≥ 整月营业额** | 🔶 仍 PAYNOTIFY_DISABLED 拦截，灾难级风险但不发生 |
| payNotify 解锁后 42703 崩溃 | 全部线上支付链不可用 | 🔶 解锁前必须先清掉 wechat_transaction_id 残留 |
| 退款不冲销 5 通道 | — | ✅ 全部已修复（2026-04-26/27/05-17 收官）|
| admin createOrder 跨 store 优惠券 | — | ✅ 已修复（orders.ts 4 维度校验） |
| sale_allocations.ratio 写 9.99 | — | ✅ 已修复（migration 0022 IN-集合 CHECK） |
| staff service.create 100% 失败 | 服务单创建链路阻塞 | ❌ 仍未修，业务实际靠"绕过 create"测试态运行 |
| advisory lock 跨事务重号 | 订单号/退款号/服务单号 重复 | ❌ 仍未修；并发场景概率性触发 |
| client 无券订单 total_amount 浮点漂移 | ±0.005 / 订单 | ❌ 仍未修；日均累积影响对账 |
| cron 跳档仅扫会员客 | 流量/体验客生日+感恩+升级三件套漏发 | 🔶 部分待 — refresh-member-levels 已大幅提速（commit 626d0b4 N+1→单 JOIN 1500× 提速）|
| staff customer.* 6 路由 PII | — | ✅ 已修复（scope WHERE + audit log） |
| admin 物理硬删 PII | 个保法合规风险 | ❌ 未修（多域散落）|

> **v3 修复 ROI**：剩余 P0 中 **payNotify 签名 + service.create 列引用 + advisory lock 改单事务** 三项可拦下 ≥ 90% 剩余生产风险，预估 1-2 周可完成。
> 已落地 19 项 P0 关闭对应历史资损面（主要是退款 5 通道 + 优惠券范围）的修复成本回收周期 < 1 个月。

### 5.4 跨域 epic 优先级（v3 — 重排）

| Epic | 包含修复 | v3 状态 / 推荐排期 |
|------|---------|--------------------|
| E1 payNotify 安全收官 + 残留字段清理 | P0-04-01/02/03/04 + S04-3 + P0-CC2-v2-01（wechat_transaction_id 残留）| **🔥 仍待** — 解锁前必须清残留；签名方案因拉卡拉切换 + 待对接 |
| E2 退款级联 cascade（5 通道）| P0-CC2-07 + L1 helpers + L3 三端 + 域重构 | ✅ **完成**（2026-04-26/27/05-17） |
| E3 已删字段引用清理 | P0-05-01 service.create / payNotify 残留 + CC9 测试整改 | 🔥 **部分** — admin/staff/client 业务侧已干净；剩 service.create + payNotify 守卫态 |
| E4 scope 全覆盖 | P0-CC4-06 / P0-CC3-x + L1 scope helpers + admin withPermission | 🔶 **部分** — staff 路由层已加；helper 集中化 + withPermission HOF 待 |
| E5 schema 不变量 CHECK 一次性 migration | L0 P0 剩 5 项 + L11 audit cron 剩 2 项 | 🔶 **5/13 关闭**：ratio/commission/uq_sop ✅；剩 时区/金额符号/partial unique 10 项 |
| E6 时区统一 + 跨端口径收敛 | CC7 + CC1 + dashboard 三端口径 | 🔶 admin dashboard 已切；staff mgmtDashboard 守护测试待 |
| E7 跨端副本 helper 抽取 | settlePoints / grantShareGift / role-resolve / sale-item-availability | ✅ **方案改动**：用户 veto 共享目录，改用 `cross-end-sql-snapshot.test.js` 字面量守护（settlePoints + applyRecharge 已落地）；剩 grantShareGift / role-resolve / sale-item-availability 待 |
| E8 spec 与代码同步守卫 | L9 spec 校对 + CI lint + schema docstring grep | 🔶 **部分** — backend.pr.spec.md v2.1.0 已更；sale_order_type 5→3 后 staff/client.pr.spec 已校对（ticket §11 收尾）|
| E9 capability 列收敛 magic string | is_experience（R1）/ is_recharge_card（R2）+ 跃迁 SQL + cron-worker + 三端接入 | ✅ **R1 + R2 完成**（commit ed3bf1f：is_recharge_card SKU 表单 + 互斥校验 + payNotify 行级快照）|
| E10（新增 v3）admin permission 收尾 | refund_create / refund_approve 拆分（已落）/ withPermission HOF（未落）/ PERMISSION_MATRIX DB 化（D-Q3 决策待落） | 🔶 拆分完成；HOF + DB 化第 4-5 周 |
| E11（新增 v3）测试基础设施 | L2 云函数 + L3 小程序 E2E 框架（commit d13c7e2 已落） + SQL patch shim 移除（commit 09488bd） + manual-e2e 共享 helper（commit 12d47bf） | ✅ **完成**（2026-05 月） |
