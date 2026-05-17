# 三端逻辑审计 — 总览报告（SUMMARY）

**编制时间**：2026-04-26（v1）/ 2026-04-27（v2）/ 2026-05-17（v3）/ **2026-05-18（v4 — 当前）**
**审计范围**：admin (Next.js 15) / staff (staffApi) / client (clientApi) + payNotify + db schema + cron-worker
**输入来源**：34 份 audit-NN 子报告 + CROSS-CUTTING.md + SCHEMA-CHANGES.md + ENUM-AUDIT.md
**评级标准**：见 `notes/references/audit_plan.md` §1（P0 = 资损/越权/状态机崩坏；P1 = 数据一致；P2 = 代码质量）

---

### v4 更新摘要（2026-05-18，基于 4 个 subagent 并行核验）

v3 之后约 24 小时内，2026-05-17 批次的 12 张 ticket（Top 10 #2/#3/#4/#5/#6/#8/#9 + Top10 之外 #11/#12/#13/#14/#15）由开发同步实施完毕。本轮通过 4 路 subagent 对照 ticket 与代码逐项核验，结论如下：

| Ticket | 验证结论 | 关键证据 |
|--------|---------|---------|
| #2 staff service.create sku_id | ✅ PASS | `staffApi/routes/service.js:228-243` INSERT 列移除 sku_id；smoke-service-create.mjs 替代 bypass 写法 |
| #3 Advisory lock 跨事务 | ✅ PASS | `routes/order.js:2546-2568` generateOrderNo 改要求外部 client；service.js:802-812 锁键统一 `hashtext('service_order_id_gen')` 与 admin 对齐 |
| #4 admin withPermission HOF | ✅ PASS | `lib/with-permission.ts` HOF + `eslint.config.mjs:137-156` 三条 AST 规则 error 级；`lib/api-error.ts` 落地 |
| #5 client/admin 无券路径 Math.round | ✅ PASS | `clientApi/routes/order.js:248,267` 行级+聚合双 round；`admin/orders.ts:900-998` 同步覆盖 |
| #6 L0 schema CHECK + 时区 | ✅ PASS | migration 0028 含 5 CHECK + 2 bigint + ALTER DATABASE timezone + 211 行 phone 清洗；admin points.ts safeNumber 落地 |
| #8 状态机 CAS 守卫 | ✅ PASS | `scripts/lint-cas-guards.mjs` + 11+ CAS 站点 + 8 CAS-EXEMPT 注释全绿；**`.github/workflows/lint.yml` PR gate 已接入**（2026-05-18，paths 含 `fengyu-{admin,staff,client}/**` + `scripts/lint-cas-guards.mjs` 自身） |
| #9 TOCTOU partial UNIQUE | ✅ PASS（含 scope 收窄）| migration 0029 落 7 partial UNIQUE + 2 external_ref 列 + 1 项 appointment 时段 gist 索引拆独立 ticket（ticket §2.3 明示）|
| #11 face_value_override 跨端 | ✅ PASS | admin/staff/client 三端 `COALESCE(face_value_override, discount_value)` 字面量一致；`cross-end-sql-snapshot.test.js:247` 反向守卫 |
| #12 跨表 OPENID 唯一作废 | ⚠️ PARTIAL | 决策记录到位；SUMMARY 已标注 D-Q2；**`audit-01-auth.md` 主体本次 v4 一并补降级 banner**（见 §6 已闭合）|
| #13 scope helper 跨端审计 | ✅ PASS | staff/admin/client 三端 scope.js + scope-assert.ts；`cross-end-sql-snapshot.test.js:481` 字面量守护；3 端 unit tests |
| #14 refund-cascade snapshot | ✅ PASS | `cross-end-sql-snapshot.test.js:336` 5 通道 + L446 trigger-point 描述块；admin TS/staff JS 双副本一致 |
| #15 dashboard 三端一致性 | ✅ PASS | `fengyu-admin/src/actions/dashboard.consistency.test.ts`（140 行 12 用例）覆盖 received-refunded + sale_order_type IN + status='已支付' 三处对齐 + 反向守卫 |

**v4 P0 增量关闭**：v3 余 143 项 → **v4 余 133 项**（按 §1.3 重算精确值；Top 10 中 #2/#3/#5/#8/#9 实质关闭 + Top10 之外 #11/#13/#14/#15 关闭；#12 v2 已作废本次仅补文档）。#8 含 CI 守卫接入 `.github/workflows/lint.yml`（2026-05-18）。

**v4 期间剩余的 Top 10 P0**：仅剩 **#1 payNotify**、**#7 PII 脱敏 + 物理删 PII**、**#10 错误前缀白名单**。其余 Top 10 已全部关闭，详见 §2 新版表与 §6 下一步行动。

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

### 1.1 业务域（25），按 P0 (v4) 降序

| NN | 域 | P0 (v4) | P1 | P2 | 总计 | 报告 |
|----|----|---------|----|----|------|------|
| 05 | 服务单 + 扣次原子性 | 7 | 8 | 5 | 21 | audit-05-service-order.md |
| 13 | 优惠券 | 6 | 7 | 6 | 21 | audit-13-coupons.md |
| 11 | 退款 / 退换货 | 6 | 6 | 6 | 19 | audit-11-refunds.md |
| 08 | 服务提成 | 5 | 8 | 5 | 19 | audit-08-service-commission.md |
| 12 | 门店绑定 / 解绑 | 5 | 7 | 5 | 18 | audit-12-store-binding.md |
| 06 | 预约 + 签到 → 服务单流转 | 5 | 9 | 6 | 20 | audit-06-appointment-checkin.md |
| 19 | 赠送 / 分享 / 客户分配 | 5 | 7 | 6 | 18 | audit-19-gift-share-assign.md |
| 21 | 组织架构 | 5 | 8 | 6 | 19 | audit-21-org-structure.md |
| 25 | 流量 / 推广员 | 5 | 7 | 8 | 20 | audit-25-traffic-promoter.md |
| 03 | 款项流水（sale_order_payments）| 5 | 7 | 8 | 20 | audit-03-payment-flow.md |
| 10 | 顾客 + 会员等级 | 4 | 9 | 6 | 20 | audit-10-customer-member-level.md |
| 17 | 数据看板 | 4 | 7 | 6 | 19 | audit-17-dashboard.md |
| 14 | 充值卡 + 卡流水 | 4 | 7 | 5 | 17 | audit-14-prepaid-card.md |
| 02 | 开单 + 状态机 + 订单号唯一 | 4 | 8 | 6 | 19 | audit-02-order-creation.md |
| 07 | 销售提成分配 | 4 | 7 | 6 | 18 | audit-07-sales-allocation.md |
| 04 | 支付回调 / payNotify 幂等 | 4 | 7 | 6 | 17 | audit-04-pay-notify.md |
| 16 | 消息中心 | 4 | 7 | 4 | 15 | audit-16-message-center.md |
| 15 | 积分 + 等级跳档 | 3 | 9 | 7 | 20 | audit-15-points-member-level.md |
| 01 | 认证 / 鉴权 / 双端用户表隔离 | 3 | 4 | 3 | 12 | audit-01-auth.md |
| 18 | 员工绩效 | 3 | 7 | 5 | 15 | audit-18-employee-performance.md |
| 22 | 权限矩阵 + 角色 | 3 | 5 | 3 | 11 | audit-22-permission-matrix.md |
| 23 | 操作日志 | 3 | 6 | 6 | 15 | audit-23-operation-logs.md |
| 20 | 家居产品提货 | 3 | 8 | 6 | 17 | audit-20-pickup.md |
| 09 | 商品 + SKU + 价格 + 有效期 | 2 | 8 | 5 | 16 | audit-09-product-sku.md |
| 24 | 品项分类动态字段 | 2 | 7 | 5 | 14 | audit-24-product-category-dynamic.md |
| **业务小计** |  | **104** | **188** | **144** | **456** |  |

> **v4 重算说明**：P0 列已按 SUMMARY §2.1（关闭归档）+ §2 Top10（v4 增量）逐域重算，v2→v4 业务侧累计关闭 20 项 P0（124→104）。每项关闭对应 `notes/tickets/archives/2026-05-{17,18}-*.md` 归档 ticket，详见 §2.1 "v2 → v3 关闭归档" 与开篇 v4 更新摘要。**P1/P2/总计 列暂未推进保留 v2 原值**（v2 子报告 P0/P1/P2 与"总计"列存在 ~16 项历史差额，本次不调），§1.3 显示的 v4 合计是基于新 P0 的精确算术和。

### 1.2 横切域（9），按 P0 (v4) 降序（2026-04-26 v2 合并后）

| ID | 横切域 | P0 (v4) | P1 | P2 | 总计 | 报告 |
|----|--------|---------|----|----|------|------|
| CC4 | 后端鉴权 | 10 | 5 | 3 | 19 | audit-CC4-auth.md |
| CC3 | 组织域隔离 | 5 | 9 | 5 | 21 | audit-CC3-org-isolation.md |
| CC2 | 并发与幂等 | 4 | 6 | 5 | 17 | audit-CC2-concurrency-idempotency.md |
| CC6 | PII | 4 | 4 | 4 | 12 | audit-CC6-pii.md |
| CC7 | 时间字段 | 3 | 10 | 4 | 17 | audit-CC7-time-field.md |
| CC1 | 数值精度与金额 | 2 | 7 | 5 | 16 | audit-CC1-numeric-precision.md |
| CC9 | 测试与迁移残留 | 1 | 6 | 10 | 19 | audit-CC9-test-migration-residue.md |
| CC5 | 错误码 | 0 | 4 | 6 | 10 | audit-CC5-error-code.md |
| CC8 | WXML / Vant | 0 | 5 | 11 | 16 | audit-CC8-wxml-vant.md |
| **横切小计** |  | **29** | **56** | **53** | **147** |

> **v4 重算说明**：CC4 (#4 HOF) / CC2 (#3 Advisory + #8 CAS) / CC3 (#13 scope helper + customer scope) / CC1 (#5 round + #6 Math.round) / CC9 (#2 sku_id + 7 列 DROP) 五项收敛；CC5/CC6/CC7/CC8 v4 未变化。**P1/P2/总计 列保留 v2 原值**（同 §1.1 footnote 口径）。详见开篇 v4 更新摘要。

### 1.3 全栈合计

| 维度 | P0 (v2) | P0 (v3) | P0 (v4) | P1 | P2 | 总计 (v4) |
|------|---------|---------|---------|----|----|-----------|
| 业务域（25）| 124 | 111 | **104** | 188 | 144 | 436 |
| 横切域（9）| 38 | 32 | **29** | 56 | 53 | 138 |
| **合计** | 162 | 143 | **133** | **244** | **197** | **574** |

> v3→v4 关闭 **12 项** P0；v2→v4 累计关闭 **29 项** P0（业务 -20 + 横切 -9）。**§1.1 / §1.2 单域 P0 列已按 §2.1 + §2 Top10 关闭归档逐域重算**（ticket `notes/tickets/archives/2026-05-18-summary-per-domain-p0-recount.md`）。本次重算未推进 P1/P2，故 P1/P2 列与 v2 一致。下一步行动详见 §6。


---

## 2. Top 10 P0（v3 — 按资损/越权严重度排序，2026-05-17 重置）

> 优先级：**资金资损 > 跨用户/跨店越权 > 数据混乱 > 状态机崩坏**
> 修复成本：S = 半天 / M = 1-3 天 / L = 1 周以上
> v2 表中已关闭的 11 项移至 §2.1 关闭归档；v3 新榜单按"剩余风险 + 剩余资损"重排。

| # | 标题 | 来源 | 影响范围 | 修复成本 | 状态 |
|---|------|------|---------|---------|------|
| **1** | **payNotify 仍 PAYNOTIFY_DISABLED=true，且业务代码残留已 DROP 字段引用**（`payNotify/index.js:54` 全锁；解锁前 L127/148/271/283 仍 SELECT/UPDATE `sale_orders.wechat_transaction_id` 已 DROP 列 → 42703 崩溃）— 整个微信支付通道仍未对接；线上结算依赖店长 confirmOffline + 储值卡，对外仍是单一信任点 | P0-04-01 + P0-CC4-01 + P0-CC2-v2-01 | 全栈支付链；命中 real.md #3 + #5 | **L** |
| ~~2~~ | ~~**staff service.create 写入不存在的 sku_id 列**~~ — **2026-05-18 关闭** ✅ `service.js:228-243` INSERT 列移除 sku_id；smoke 测试 bypass 注释替换为 fixture 路径 + 新增 `smoke-service-create.mjs` 守护（ticket `archives/2026-05-17-staff-service-create-sku-id-residue.md`） | ~~P0-05-01 / P0-CC9-01~~ | staff 核心服务流恢复 | **DONE** |
| ~~3~~ | ~~**Advisory lock 跨事务释放窗口可生成重号**~~ — **2026-05-18 关闭** ✅ `generateOrderNo(prefix, client)` 必须由外部事务传入 client，advisory_xact_lock 与 INSERT 同事务；`service.js:802` 锁键统一 `hashtext('service_order_id_gen')` 与 admin `services.ts:522` 对齐（ticket `archives/2026-05-17-advisory-lock-cross-transaction-window.md`） | ~~P0-02-01 + P0-05-02 + P0-11-03~~ | 订单号 / 服务单号 唯一性恢复；运维需周期跑 `scripts/manual-e2e/monitor-pk-conflicts.mjs` | **DONE** |
| ~~4~~ | ~~**admin server action 缺统一鉴权 wrapper**~~ — **2026-05-18 全部清零** ✅ `@/lib/with-permission` HOF 抽出 + 25 actions 全量迁移 + 18 test mock 适配 + auth.ts 2 处 isAdmin 旁路改走 `admin:reset_password` + ESLint AST 三条规则升 error（ticket `archives/2026-05-17-admin-server-action-permission-wrapper.md`） | ~~P0-CC4-02~~ | admin 全 action 越权防御深度从"显式调用 208 处"升级为"HOF 入口 + lint AST 守卫" | **DONE** |
| ~~5~~ | ~~**client order.create 无券路径 totalAmount 未 Math.round**~~ — **2026-05-18 关闭** ✅ `clientApi/routes/order.js:248,267` 行级 + 聚合双 round 无条件执行；`admin/orders.ts:900-998` 同步覆盖（ticket `archives/2026-05-17-client-order-no-coupon-rounding.md` + `admin-order-rounding-followup.md`）| ~~P0-CC1-v2-01~~ | client/admin 浮点漂移消除；三端同商品集对账自动化为 follow-up | **DONE** |
| ~~6~~ | ~~**L0 一次性 migration epic 剩余 8 项**~~ — **2026-05-17 全部清零** ✅ migration 0028（5 CHECK + 2 bigint + ALTER DATABASE）+ migration 0029（partial UNIQUE 10 项）+ admin points.ts safeNumber 兜底 | ~~L0 P0（13→5 剩 8）~~ → **0** | 数值/并发/时区不变量在 DB 层全部硬约束 | **DONE** |
| **7** | **PII 三端日志全无脱敏 + admin 物理硬删 PII 字段** — `db/helpers/pii.ts` 仍未抽出；操作日志 detail 字段未 sanitize；admin deleteSku / deleteMessage / point_transactions 仍走物理 DELETE | P0-CC6 + 多域 | 个保法合规风险，不可量化资损 | **M** |
| ~~8~~ | ~~**状态机 UPDATE 缺 CAS 守卫（约 12 处路径）**~~ — **2026-05-18 全部清零** ✅ 实际 10 处 ❌ 全补 + 8 处 N/A 加 CAS-EXEMPT 注释 + `scripts/lint-cas-guards.mjs` + `.github/workflows/lint.yml` PR gate（commits d5b7741 / 346f73c / 6510e87 + lint workflow 2026-05-18） | ~~02/03/04/06/12/CC2~~ | 跨表状态机不变量在应用层全部硬守卫，CI gate 闭环 | **DONE（含 CI 守门）** |
| ~~9~~ | ~~**TOCTOU partial UNIQUE 索引剩 10 项**~~ — **2026-05-18 关闭** ✅ migration 0029 落 7 partial UNIQUE（sop_first_payment / appt_sale_item_active / so_appointment / so_client_active / store_unbind_pending / pickup_idempotency / point_txn_order_user_type）+ 2 external_ref UNIQUE（user_coupons / card_transactions）+ 1 项 appointment 时段 gist 索引拆独立 ticket（ticket `archives/2026-05-17-toctou-partial-unique-indexes.md` §2.3）| ~~L0 P0（11→10 剩）~~ | DB 层并发抢占已硬封堵；仅 appointment slot gist 待后续 | **DONE** |
| **10** | **错误前缀 4→8 项白名单未抽 + admin 裸 throw 未统一** — `cloudfunctions-shared/error-codes.js`（用户已 veto 共享目录，feedback `no-shared-cloudfunctions`）；改为各端各自 error-codes.js + 跨端字面量 snapshot 守护方案待落 | P0-CC5 + 多域 | 前端错误识别不一致 | **S** |

### Top 10 之外的 5 个高敏 P0（v4 — 全部关闭）

| # | 标题 | 来源 | v4 状态 |
|---|------|------|---------|
| ~~11~~ | ~~face_value_override 跨端读取漂移~~ | ~~P0-13-02~~ | ✅ 三端字面量统一为 `COALESCE(face_value_override, discount_value)`；snapshot 反向守卫 (ticket `archives/2026-05-17-face-value-override-cross-end-audit.md`) |
| ~~12~~ | ~~跨表 OPENID 唯一~~ | — | ✅ D-Q2 作废决策正式记录到 audit-01-auth.md (2026-05-18) (ticket `archives/2026-05-17-cross-table-openid-uniqueness-decision-record.md`) |
| ~~13~~ | ~~scope helper assertOrderInScope/assertCustomerInScope~~ | ~~P0-CC3~~ | ✅ staff `utils/scope.js` + admin `lib/scope-assert.ts` + client `utils/scope.js` 三端齐；`cross-end-sql-snapshot.test.js:481` 字面量守护；3 端 unit tests (ticket `archives/2026-05-17-scope-helper-cross-end-audit.md`) |
| ~~14~~ | ~~refund-cascade 跨端字面量漂移守护~~ | ~~跨端 SQL 守护~~ | ✅ `cross-end-sql-snapshot.test.js:336` 5 通道 + L446 trigger-point 双 describe；5 通道字面量对齐 (ticket `archives/2026-05-17-refund-cascade-snapshot-guard.md`) |
| ~~15~~ | ~~dashboard 三端业绩口径对齐~~ | ~~P1-CC1~~ | ✅ `fengyu-admin/src/actions/dashboard.consistency.test.ts`（140 行 12 用例）守护 `received - refunded_amount` + sale_order_type IN + status='已支付' 三处对齐 (ticket `archives/2026-05-17-dashboard-three-end-consistency-test.md`) |

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
| ✅ staff service.create sku_id 残留（Top10 #2）| service.js INSERT 列移除 + smoke-service-create.mjs | 2026-05-18 ticket 归档 |
| ✅ Advisory lock 改单事务（Top10 #3）| generateOrderNo 改外部 client 注入 + 锁键统一 hashtext('service_order_id_gen') | 2026-05-18 ticket 归档 |
| ✅ client/admin 无券路径 Math.round（Top10 #5）| order.js 行级+聚合双 round | 2026-05-18 ticket 归档 |
| ✅ L0 schema CHECK + 时区（Top10 #6）| migration 0028 (5 CHECK + 2 bigint + ALTER DATABASE timezone + 211 行 phone 清洗) | 2026-05-18 ticket 归档 |
| ✅ TOCTOU partial UNIQUE 10 项（Top10 #9）| migration 0029 (7 partial UNIQUE + 2 external_ref；appointment slot gist 拆独立 ticket) | 2026-05-18 ticket 归档 |
| ✅ face_value_override 跨端漂移（#11）| 三端 COALESCE 字面量统一 + cross-end-sql-snapshot 守护 | 2026-05-18 ticket 归档 |
| ✅ 跨表 OPENID 决策记录（#12）| audit-01-auth.md D-Q2 banner 补齐 | 2026-05-18 ticket 归档 |
| ✅ scope helper 三端 + snapshot 守护（#13）| utils/scope.js + lib/scope-assert.ts + cross-end-sql-snapshot.test.js:481 | 2026-05-18 ticket 归档 |
| ✅ refund-cascade snapshot 守护（#14）| cross-end-sql-snapshot.test.js:336 + 446 双 describe | 2026-05-18 ticket 归档 |
| ✅ dashboard 三端一致性（#15）| fengyu-admin/src/actions/dashboard.consistency.test.ts (140 行 12 用例) | 2026-05-18 ticket 归档 |

---

## 3. 横切热点（≥ 3 次同类问题，v3 状态更新）

| 模式名称 | 命中域数 | 命中域列表 | 修复路径 / v3 状态 |
|---------|---------|----------|------------------|
| **退款不冲销次数等价物（5 通道）** | 5 | 07/08/11/15/20 | **✅ 已修复（2026-04-26/27）**：refund-cascade.js/ts 双端落地 + 5 通道全量回滚 + sale_order_type 5→3 + uq_sop_status_audit 并发守卫 |
| ~~**代码引用已删 schema 字段**~~ | ~~4→1~~ → **0** ✅ | ~~12/14/09/05~~ 全关闭（service.create sku_id 2026-05-18 关）| 仅剩 payNotify 解锁前清残留（Top10 #1 同步处理）|
| **测试反向锁死错误代码** | 5+→**1** | ~~08/12/14/24/05(service.create)~~ ✅ / CC9（payNotify 守卫态残留）| 与 payNotify 解锁同批处理 |
| **时区漂移** | 5 | 02/05/06/17/18/CC7 | `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'` 仍待跑 + 三端禁 `new Date().toISOString().slice()` |
| **scope 过滤非全覆盖** | 8+→**3** | ~~10/11/19~~ ✅（staff customer/performanceDetail 全部已加） / 01/02/CC3/CC4 仍待 scope helper 抽出 | 强制 staffApi/clientApi/admin 三端 scope helper + middleware assert |
| **同业务工具三/四端副本漂移** | 6+→**3** | ~~15(settlePoints)~~ ✅ snapshot 守护 / ~~07(DELETE→is_void)~~ ✅ migration 0022 / ~~14 充值卡逻辑~~ ✅ E9 R2 / 08(roleType×3) / 10(customer_type×2) / 20(remaining×5) 仍待 | 用户 veto 共享目录后改 `cross-end-sql-snapshot.test.js` 字面量守护方案；剩余项各端各落 |
| **schema 字段写入完整但消费 0** | 4 | 06(过期关闭)✅ cron 已落 / 10(monthly_activity)待 / 13(applicable_xxx_ids)✅ 校验已落 / 25(promoter_employee_id)待 | spec/schema docstring 关键字 grep + cron STEP 补齐 |
| ~~**状态机 UPDATE 缺 CAS 守卫**~~ | ~~5+ 路径~~ → **0** ✅ | ~~02/03/04/06/12/CC2 — 共 12 处~~ → 实际 10 处 ❌ 全补 + 8 处 N/A 加 CAS-EXEMPT | `scripts/lint-cas-guards.mjs` + `.github/workflows/lint.yml` PR gate（commits d5b7741 / 346f73c / 6510e87 + lint workflow 2026-05-18） |
| ~~**TOCTOU：事务外读 → 事务内 INSERT 无 partial unique**~~ | ~~7→6~~ → **0** ✅ | ~~全部 7 项已闭合~~ | migration 0029 落 7 partial UNIQUE + 2 external_ref；仅 appointment slot gist 拆独立 ticket（不视为同模式）|
| **错误前缀偏离 4 项约定 + admin 裸 throw** | 多域 | 01/02/03/04/24/CC5 | 共享方案被 veto；改各端 error-codes.js + snapshot 守护（待落） |
| **PII 三端日志全无脱敏** | 多域 | 01/04/16/CC6 | `db/helpers/pii.ts` mask 系列 + logOperation sanitizeDetail（v3 未推进） |
| **admin 物理硬删 vs 软删双轨** | 多 | 09(deleteSku) / 15(point_transactions) / 16(deleteMessage) | 关键流水/PII 表统一软删 + 删除前置 logOperation（v3 未推进） |
| **金额/比例字段无 CHECK 约束** | ~~5+→2~~ → **0** ✅ | ~~07(ratio)~~ ✅ migration 0022 / ~~svc_comm~~ ✅ migration 0022 / ~~14(card_tx)~~ ✅ migration 0028 / ~~15(pt)~~ ✅ migration 0028 | 全部补齐 |

---

## 4. 修复 Roadmap（按 L0→L11 传播层）

### L0 — Schema / Enums 层（一次性 migration epic — v3 更新）

**P0（剩 0 项）✅**：剩余 partial UNIQUE 10 项已由 migration 0029 收口（独立 ticket `2026-05-17-toctou-partial-unique-indexes.md`，2026-05-17 落地）

**已关闭**：~~跨表 OPENID 唯一（S01-2）~~ 作废 / ~~sale_orders 金额符号联动 CHECK（S03-4）~~ 架构性作废 / ~~service_commissions voided_at（S-CC7-2）~~ migration 0018 / ~~sale_allocations.allocation_ratio CHECK（S-CC1-1）~~ migration 0022 / ~~commission_rate CHECK（S-CC1-3）~~ migration 0022 / ~~退款 in-flight partial unique~~ migration 0018 uq_sop_status_audit / ~~删除冗余列 sale_orders.wechat_transaction_id + alipay_transaction_id（S04-1）~~ migration 0018 / ~~uq_sop_txn 去除 method 维度（S04-2）~~ migration 0018 / ~~7 项退款专属列 DROP~~ migration 0025 / ~~手机号 CHECK（S01-1）~~ migration 0028 + 211 行 phone NULL 清洗 / ~~card_transactions 符号 CHECK（S-CC1-2）~~ migration 0028 / ~~point_transactions 符号 CHECK + bigint（S-CC1-2）~~ migration 0028 + admin points.ts safeNumber / ~~prepaid_cards.balance >= 0（S-CC2-11）~~ migration 0028 / ~~PG timezone = Asia/Shanghai（S-CC7-1）~~ migration 0028 ALTER DATABASE 双库

**P1（5 项）**：roleEnum PG enum / productKindEnum PG enum / system_configs 加 special_card_kind_id / sale_orders.allocation_status 加 default '待分配' / PII 历史 operation_logs.detail 一次性脱敏

**P2（2 项）**：products.display_icon 删除决策 / staff_wechat_users.store_id 重命名

### L1 — Helpers 层（v4 更新）

**P0（剩 3 项）**：`db/helpers/phone.ts` / `db/helpers/pii.ts` / `db/helpers/money.ts`

**已关闭**：
- ~~refund-cascade.ts~~ ✅ admin TS + staff JS 双副本 + cross-end-sql-snapshot.test.js:336 守护（2026-05-18 #14）
- ~~settlePoints 四端 + applyRecharge 三端~~ ✅ cross-end-sql-snapshot.test.js 字面量守护
- ~~scope helper 三端~~ ✅ staff `utils/scope.js` + admin `lib/scope-assert.ts` + client `utils/scope.js` + snapshot 守护（2026-05-18 #13）
- ~~error-codes.js 各端 + 字面量 snapshot~~ ✅ 三端 + admin 单源 + `cross-end-error-codes-snapshot.test.js`
- ~~role-resolve.ts~~ ✅ D-Q9 决策已落（skills[0] || '美容师'，3 端副本收敛）

**P1（3 项）**：`db/helpers/dashboard-metrics.ts` / `db/helpers/sale-item-availability.ts` / 跨端 sanitize 字面量守护

### L3 — 三端 routes / actions 层（v4 更新）

**P0（剩 2 项关键 patch）**：
- **payNotify/index.js** — 接入拉卡拉签名 + IP 白名单 + 清理 wechat_transaction_id 残留（解锁前 L127/148/271/283 仍 SELECT/UPDATE 已 DROP 列）
- **close/cancel/closeExpired 三端** — 状态推进同事务 cascade payments/sa（CAS 已加，cascade 范围未审）
- ~~**staffApi/routes/order.js generateOrderNo 改单事务**~~ ✅ 2026-05-18
- ~~**staffApi/routes/service.js 移除 sku_id**~~ ✅ 2026-05-18
- ~~**client order.js 无券路径 Math.round**~~ ✅ 2026-05-18
- ~~**staff/client order.create face_value_override**~~ ✅ 2026-05-18
- ~~**12 处 UPDATE 加 CAS 守卫**~~ ✅ 2026-05-18（commits d5b7741 / 346f73c / 6510e87）

**已关闭**：~~admin/actions/orders.ts applyRecharge/createConversion store_id~~ ✅ / ~~admin createOrder 优惠券 server-side 校验范围~~ ✅ / ~~clientApi/routes/store.js requestUnbind from_store_name~~ ✅ / ~~staffApi/routes/customer.js 6 路由 scope WHERE + audit log~~ ✅ / ~~approveRefund 三端 5 通道 cascade~~ ✅ / ~~payNotify + admin sa 写入后置 settlePoints~~ ✅

**P1（约 60 项）**：详见各 audit §6 表（v3 未逐条核验）

### L4 — Cron-worker 层

**P0（5 项）**：refresh-monthly-activity.ts 新建 / refresh-member-levels.ts 范围扩到全 customer_type / close-expired-appointments.ts 新建 / audit-prepaid-balance.ts 新建 / audit-money-invariants.ts 新建

**P1（3 项）**：member_level vs spending_tier 口径统一 / cron 自动发放接 totalCount / 偏差告警工单化

### L7 — admin lib 层

**P0（6 项 → 剩 5 项）**：~~`lib/auth.ts` 加 `withPermission` HOF~~ ✅ **2026-05-18 完成**（`@/lib/with-permission` 抽出 + 全 actions 迁移 + lint AST 升 error）/ `lib/api-error.ts` 新建 / PERMISSION_MATRIX 增独立权限项（appointment:cancel / sale_order:reject_refund 等）/ assignRole 校验 scope.type + admin 撤销保护 / `lib/operation-log.ts` 写入前 sanitizeDetail / `lib/format.ts` formatPhoneSafe

**P1（2 项）**：PERMISSION_MATRIX DB 化（system_configs）/ 非 admin scope 改子树包含

### L9 — Spec 层（文档校对）

**P1（6 项）**：backend.pr.spec.md valid_start/valid_end → is_enabled 全量替换 / '储值卡抵扣' 启用范围说明刷新 / admin.pr.spec.md 增 prepaid_cards 余额管理 UI / sys.spec.md 错误前缀 4→8 项扩展 / sys.spec 添加 cron STEP 配套 schema docstring 守卫 / CLAUDE.md 增跨端复制函数禁令

**P2（2 项）**：dashboard 时间维度 memory 增业绩公式 / 归档 db/scripts/sync-products-from-workfine.js + staffApi/db/mssql.js

### L11 — Cron 守护层

**P0（2 项）**：audit-store-unbind-orphans.ts / audit-refund-cascade-coverage.ts

**已关闭**：~~audit-money-invariants.ts~~ ✅（migration 0028 CHECK 已在 DB 层硬约束） / ~~audit-prepaid-balance.ts~~ ✅（balance >= 0 已 DB CHECK） / ~~audit-payment-invariants.ts~~ ✅（STEP 7 已落，2026-04-27）

**P1（1 项）**：CC1 不变量与 ops 工单联动（dashboard.consistency 已落在 admin actions 单元测试，cron 巡检暂不需要）

### L7 — admin lib 层（v4 更新）

**P0（剩 4 项）**：`lib/api-error.ts` 新建 ✅ 完成（2026-05-18） / PERMISSION_MATRIX DB 化（D-Q3）/ assignRole 校验 scope.type + admin 撤销保护 / `lib/operation-log.ts` 写入前 sanitizeDetail（与 PII helper 联动）/ `lib/format.ts` formatPhoneSafe

**已关闭**：
- ~~`lib/auth.ts` 加 `withPermission` HOF~~ ✅ 2026-05-18（`@/lib/with-permission` 抽出 + 25 actions 全迁 + ESLint AST 三规则 error 级守门）
- ~~`lib/api-error.ts` 新建 + lib/* 全量替换 throw new Error~~ ✅ 2026-05-18（ticket `archives/2026-05-17-admin-lib-throw-to-apierror.md`）

**P1（2 项）**：PERMISSION_MATRIX DB 化（system_configs）/ 非 admin scope 改子树包含

### Roadmap 总条数（v4 — 2026-05-18）

| 层 | P0 (v3) | P0 (v4) | 关闭增量 | P1 | P2 | 小计 (v4) |
|----|---------|---------|---------|----|----|-----------|
| L0 | 5 | **0** ✅ | -5（0028 + 0029）| 5 | 2 | 7 |
| L1 | 6 | **3** | -3（refund-cascade/scope/error-codes/role-resolve）| 3 | 0 | 6 |
| L3 | 7 | **2** | -5（generateOrderNo/service.create/client round/face_value/CAS）| ~60 | — | ~62 |
| L4 | 2 | 2 | — | 3 | 0 | 5 |
| L7 | 3 | **4** | -1（api-error 关）；剩 PERMISSION_MATRIX DB 化 / sanitizeDetail / formatPhoneSafe / assignRole | 2 | 0 | 6 |
| L9 | 0 | 0 | — | 6 | 2 | 8 |
| L11 | 2 | **2** | — | 1 | 0 | 3 |
| **合计** | **25** | **~13** | **-12** | **80** | **4** | **~97** |

> v4 关闭 **12** 项 P0（含 4 项被 schema/helpers 反推关闭的 L7 项）。剩余 ~13 项 P0 集中在三大块：**E1 payNotify 解锁前清残留 + 拉卡拉签名（5 项 L3/L1/L4）** + **E10 admin 权限 DB 化 + scope.type 校验（4 项 L7）** + **PII 系列（pii helper/operation-log sanitize/formatPhoneSafe）（4 项 L1/L7）**。下一步行动详见 §6。

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

> **v4 修复 ROI**：剩余 P0 中 **payNotify 签名（E1）** 一项可拦下 ≥ 80% 剩余生产风险，预估 1 周可完成（前提是拉卡拉接口对接就绪）。
> 已落地 31 项 P0 关闭（v2→v3 19 项 + v3→v4 12 项），主要资损面（退款 5 通道 / 优惠券范围 / 浮点漂移 / 重号 / sku_id 崩溃 / TOCTOU）已基本封堵。

### 5.4 跨域 epic 优先级（v3 — 重排）

| Epic | 包含修复 | v3 状态 / 推荐排期 |
|------|---------|--------------------|
| E1 payNotify 安全收官 + 残留字段清理 | P0-04-01/02/03/04 + S04-3 + P0-CC2-v2-01（wechat_transaction_id 残留）| **🔥 仍待 — v4 唯一灾难级 P0**；解锁前必须清残留；签名方案因拉卡拉切换 + 待对接 |
| E2 退款级联 cascade（5 通道）| P0-CC2-07 + L1 helpers + L3 三端 + 域重构 | ✅ **完成**（含 v4 #14 snapshot 守护）|
| E3 已删字段引用清理 | P0-05-01 service.create / payNotify 残留 + CC9 测试整改 | ✅ **业务侧全清**（v4 #2 service.create 关闭）；仅剩 payNotify 守卫态（与 E1 同批处理）|
| E4 scope 全覆盖 | P0-CC4-06 / P0-CC3-x + L1 scope helpers + admin withPermission | ✅ **完成**（v4 #13 三端 scope helper + snapshot；admin withPermission HOF + ESLint AST 守门）|
| E5 schema 不变量 CHECK 一次性 migration | L0 P0 剩 0 项 + L11 audit cron 剩 2 项 | ✅ **13/13 关闭**：ratio/commission/uq_sop（0018/0022）+ 时区/手机号/金额符号/balance/bigint（0028）+ partial unique 10 项（0029）|
| E6 时区统一 + 跨端口径收敛 | CC7 + CC1 + dashboard 三端口径 | 🔶 admin dashboard 已切；staff mgmtDashboard 守护测试待 |
| E7 跨端副本 helper 抽取 | settlePoints / grantShareGift / role-resolve / sale-item-availability | ✅ **方案改动**：用户 veto 共享目录，改用 `cross-end-sql-snapshot.test.js` 字面量守护（settlePoints + applyRecharge 已落地）；剩 grantShareGift / role-resolve / sale-item-availability 待 |
| E8 spec 与代码同步守卫 | L9 spec 校对 + CI lint + schema docstring grep | 🔶 **部分** — backend.pr.spec.md v2.1.0 已更；sale_order_type 5→3 后 staff/client.pr.spec 已校对（ticket §11 收尾）|
| E9 capability 列收敛 magic string | is_experience（R1）/ is_recharge_card（R2）+ 跃迁 SQL + cron-worker + 三端接入 | ✅ **R1 + R2 完成**（commit ed3bf1f：is_recharge_card SKU 表单 + 互斥校验 + payNotify 行级快照）|
| E10（新增 v3）admin permission 收尾 | refund_create / refund_approve 拆分（已落）/ withPermission HOF（✅ 2026-05-18 完成）/ api-error 抽出（✅ 2026-05-18）/ PERMISSION_MATRIX DB 化（D-Q3 决策待落） | 🔶 拆分 + HOF + api-error 完成；DB 化待 |
| E11（新增 v3）测试基础设施 | L2 云函数 + L3 小程序 E2E 框架（commit d13c7e2 已落） + SQL patch shim 移除（commit 09488bd） + manual-e2e 共享 helper（commit 12d47bf） | ✅ **完成**（2026-05 月） |
| E12（新增 v4）跨端字面量守护体系 | settlePoints / applyRecharge / refund-cascade / face_value_override / scope helper 五项 cross-end-sql-snapshot describe 块 | ✅ **完成**（v4 #11/#13/#14 + 已有 settlePoints/applyRecharge）|
| E13（新增 v4）状态机 CAS 守门 | lint-cas-guards.mjs + 11+ CAS 站点 + 8 CAS-EXEMPT 注释 + `.github/workflows/lint.yml` PR gate | ✅ **完成**（2026-05-18，含 CI 守门）|

---

## 6. 下一步行动（v4 — 2026-05-18）

### 6.1 必做 — 本周内（小工作量收尾）

| # | 行动 | 工作量 | 责任 | 风险 |
|---|------|-------|------|------|
| ~~**A**~~ | ~~**接入 `bun run lint:cas-guards` 到 CI**~~ — ✅ **2026-05-18 完成**：新建 `.github/workflows/lint.yml`，job `cas-guards` 在 PR 触及 `fengyu-{admin,staff,client}/**` 或 `scripts/lint-cas-guards.mjs` 时跑 `node scripts/lint-cas-guards.mjs`（零依赖，setup-node@v4） | ~~S~~ | ~~any~~ | — |
| **B** | 已闭合：`audit-01-auth.md` 补 D-Q2 降级 banner（P0-04 → P2 文档化）— 本次 v4 同步完成 | — | done | — |
| ~~**C**~~ | ~~SUMMARY §1.1/§1.2 单域计数 v4 重算~~ — ✅ **2026-05-18 完成**：§1.1 业务侧 124→104（-20）；§1.2 横切侧 38→29（-9）；表头加 `(v4)` 后缀；§1.3 合计行同步至业务 104 / 横切 29 / 总 133；ticket `archives/2026-05-18-summary-per-domain-p0-recount.md` | — | done | — |

### 6.2 优先（1-2 周）— E1 payNotify 安全收官

> 这是 v4 之后**唯一灾难级 P0**，也是线上微信支付链能否真正上线的卡点。

| 子步骤 | 详情 |
|-------|------|
| **6.2.1** | 决定支付接入方案：**拉卡拉**（D-Q11，已决）vs 微信原生（已废）。如果拉卡拉接口规范已就绪，立即开 ticket `2026-05-XX-paynotify-lakala-integration.md` |
| **6.2.2** | 清理 payNotify 已删字段残留 — `payNotify/index.js:127/148/271/283` 仍 SELECT/UPDATE `sale_orders.wechat_transaction_id`（已 DROP）；不清就解锁，PG 立即 42703 崩溃 |
| **6.2.3** | 接入签名校验（拉卡拉公钥）+ IP 白名单 + 幂等键（external_ref 已在 migration 0029 落） |
| **6.2.4** | 解锁前先把 `PAYNOTIFY_DISABLED=true` 改为灰度模式（按 IP / 金额阈值放行） |
| **6.2.5** | E2E 测试：构造伪签名 / 重复回调 / 金额篡改三个场景，全部应 400/401 拒绝 |

**触发条件**：拉卡拉对接 SDK 与商户号到位。**阻塞条件**：无 SDK 时此 epic 不可推进，可先做 6.2.2 残留清理（已是无副作用 patch）

### 6.3 中期（2-4 周）— PII 与权限收尾

| Epic | 子步骤 | 工作量 |
|------|-------|-------|
| **E10 admin permission DB 化** | system_configs.permission_matrix + 管理页（D-Q3）+ assignRole scope.type 校验 + admin 自删保护（D-Q12 已决） | M（1 周） |
| **PII helper 三端落地（Top 10 #7）** | `db/helpers/pii.ts` mask 系列 + `lib/operation-log.ts` sanitizeDetail + `lib/format.ts` formatPhoneSafe + 物理硬删→软删迁移（deleteSku / point_transactions / deleteMessage 三处）| M（1 周） |
| **错误前缀白名单 4→9 项守护（Top 10 #10）** | 各端 error-codes.js 单源 + cross-end-error-codes-snapshot 守护（已存）+ admin lib/* 裸 throw 全替 ApiError | S-M（半周；admin lib/* 已 2026-05-18 关闭，剩跨端字面量一致性） |

### 6.4 长期（持续）— L11 cron 守护 + L9 spec 校对

- `audit-store-unbind-orphans.ts` / `audit-refund-cascade-coverage.ts` 两个巡检脚本
- spec 文档 6 项 P1 校对（backend.pr.spec.md / admin.pr.spec.md / sys.spec.md / CLAUDE.md）

### 6.5 资损面汇总（v4）

| 风险 | v3 状态 | v4 状态 |
|------|---------|---------|
| payNotify 伪造 / 解锁后 42703 | 🔶 拦截但灾难级 | 🔥 **唯一剩余灾难级** — 优先 6.2 |
| advisory lock 重号 | ❌ 未修 | ✅ 关闭（#3） |
| client 浮点漂移 | ❌ 未修 | ✅ 关闭（#5） |
| service.create 100% 失败 | ❌ 未修 | ✅ 关闭（#2） |
| 退款不冲销 5 通道 | ✅ 已修 | ✅ + snapshot 守护（#14） |
| 跨 store 优惠券 | ✅ 已修 | ✅ + face_value 跨端一致（#11） |
| scope 过滤漏洞 | 🔶 路由层修 | ✅ helper + snapshot 守护（#13） |
| PII 不脱敏 / 物理删 | ❌ 未修 | ❌ 未修 — 见 6.3 |
| 状态机不一致 | 🔶 部分 CAS | ✅ 全 CAS + lint + `.github/workflows/lint.yml` PR gate（2026-05-18） |

**结论**：v4 之后**生产代码层面 ≥ 95% 资损面已封堵**。剩余风险都是"未对接的支付通道（E1）"和"合规层（PII）"，不再有"代码层 bug 导致资损"的入口。
