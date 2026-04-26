# 三端逻辑审计 — 总览报告（SUMMARY）

**编制时间**：2026-04-26
**审计范围**：admin (Next.js 15) / staff (staffApi) / client (clientApi) + payNotify + db schema + cron-worker
**输入来源**：34 份 audit-NN 子报告 + CROSS-CUTTING.md + SCHEMA-CHANGES.md + ENUM-AUDIT.md
**评级标准**：见 `notes/references/audit_plan.md` §1（P0 = 资损/越权/状态机崩坏；P1 = 数据一致；P2 = 代码质量）

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

### 1.2 横切域（9），按 P0 降序

| ID | 横切域 | P0 | P1 | P2 | 总计 | 报告 |
|----|--------|----|----|----|------|------|
| CC2 | 并发与幂等 | 11 | 6 | 5 | 22 | audit-CC2-concurrency-idempotency.md |
| CC4 | 后端鉴权 | 10 | 5 | 3 | 18 | audit-CC4-auth.md |
| CC9 | 测试与迁移残留 | 6 | 6 | 9 | 21 | audit-CC9-test-migration-residue.md |
| CC3 | 组织域隔离 | 5 | 9 | 5 | 19 | audit-CC3-org-isolation.md |
| CC1 | 数值精度与金额 | 5 | 6 | 5 | 16 | audit-CC1-numeric-precision.md |
| CC6 | PII | 4 | 3 | 3 | 10 | audit-CC6-pii.md |
| CC7 | 时间字段 | 3 | 8 | 4 | 15 | audit-CC7-time-field.md |
| CC5 | 错误码 | 0 | 4 | 6 | 10 | audit-CC5-error-code.md |
| CC8 | WXML / Vant | 0 | 5 | 5 | 10 | audit-CC8-wxml-vant.md |
| **横切小计** |  | **44** | **52** | **45** | **141** |  |

### 1.3 全栈合计

| 维度 | P0 | P1 | P2 | 总计 |
|------|----|----|----|------|
| 业务域（25）| 124 | 188 | 144 | 456 |
| 横切域（9）| 44 | 52 | 45 | 141 |
| **合计** | **168** | **240** | **189** | **597** |

> **去重说明**：横切域中相当部分 P0 是对业务域 P0 的归集（如 CC2-07 = audit-07/08/11/15/20 五处不冲销集合）；保持原报告口径，**实际独立修复点约 106 P0**（2026-04-26 修正：扣除 P0-SPLIT-04 / P0-10-06 / P0-15-04 / P0-15-05 共 4 项降级）。

---

## 2. Top 10 P0（按资损/越权严重度排序）

> 优先级：**资金资损 > 跨用户/跨店越权 > 数据混乱 > 状态机崩坏**
> 修复成本：S = 半天 / M = 1-3 天 / L = 1 周以上

| # | 标题 | 来源 | 影响范围 | 修复成本 |
|---|------|------|---------|---------|
| **1** | **payNotify 完全无微信签名校验/无 AEAD 解密/无来源校验** — 任何小程序 page 可伪造支付落账，下游 sa/sc/积分/储值卡/share-gift 全栈连环触发 | P0-04-01 / P0-CC4-01 | 全栈（3 端 + DB + 营销发放）；命中 real.md #3 + #5 | **L** |
| **2** | **退款审批不冲销已写入的次数等价物（5 通道）** — sale_allocations / service_commissions / user_coupons / point_transactions / picked_up_quantity 全部不回滚 | P0-07-02 + P0-08-04 + P0-11-01/04 + P0-15-01 + P0-20-01 → P0-CC2-07 | 全栈业绩 + 财务 + 顾客权益；分享礼券退款后仍可用 | **L** |
| **3** | **admin createOrder 校验优惠券完全跳过 store/market/category/product 范围** — 资损 + 越权 | P0-13-01/02/03 | admin/staff/client 三端 order.create 全部忽略 applicable_market_ids / applicable_product_ids；面值 face_value_override 跨端读取漂移 | **M** |
| **4** | **admin applyRechargeOnOrderPaid / createConversionOrder 引用已 DROP 的 store_id 列** — admin 替顾客确认含虚拟充值 SKU 订单 100% PG 42703 失败；测试 mock 反向锁死 | P0-14-01 + P0-CC9-x | admin 核心结算路径完全失效 | **S** |
| **5** | **staff service.create 写入不存在的 sku_id 列** — 所有 staffApi 服务单创建 100% 失败 | P0-05-01 | staff 核心服务流；CI mock 反向锁死 | **S** |
| **6** | **client requestUnbind 写入不存在的 from_store_name 列** — 顾客解绑流 100% 失效 | P0-12-01 | client 端唯一解绑入口完全不可用 | **S** |
| **7** | **sale_allocations.allocationRatio 无 IN-集合 CHECK** — admin 信任前端可写 9.99 → 业绩 ×10 倍资损；admin batchSaveServiceCommissions 同模式信任前端 commissionAmount | P0-CC1-01/04 + P0-07-03 | admin 全部业绩/提成持久化路径 | **S** |
| **8** | **staff 业务路由 store/scope 完全无过滤（cross-store 全局读改）** — customer.detail / calendar / giftHistory / refundHistory / updateNotes / assign 6 路由完全无 store_id 过滤 | P0-10-01/02/03/04 + P0-11-05 + P0-19-01/02 + P0-CC4-06 | 全集团顾客 PII 暴露；越权改备注、跨店分配 | **M** |
| **9** | **staff buildStoreScopeCondition helper 0 路由调用** — middleware 已注入 scope，但 SQL 是否过滤完全靠开发者自觉；admin 10/28 actions 同样 0 scope | P0-CC3-01/02/05 + P0-CC4-06 | 与 #8 同根但更广覆盖 | **M** |
| **10** | **Advisory lock 跨事务释放窗口可生成重号** — staff generateOrderNo 自带子事务，外层主事务再开新事务持锁 | P0-02-01 + P0-05-02 + P0-11-03 → P0-CC2-01/04 | 订单号 / 退款单号 / 服务单号 三类业务 ID 唯一性破坏 | **M** |

### Top 10 之外的 4 个高敏 P0（2026-04-26 修正：删除 #12 跨表 OPENID 唯一）

| # | 标题 | 来源 |
|---|------|------|
| 11 | admin server action 缺统一鉴权 wrapper（171 个 action，4 处确认漏调）| P0-CC4-02 |
| 12 | admin 三大资金触发点全无 settlePoints | P0-15-01 |
| 13 | admin getDashboardStats 业绩用 total_amount + 不过滤退款单 | P0-17-01/02/03 |
| 14 | settlePointsForOrder 三端字节级副本 + cron 5 套写入散落 | P0-15-02 |

---

## 3. 横切热点（≥ 3 次同类问题）

| 模式名称 | 命中域数 | 命中域列表 | 修复路径 |
|---------|---------|----------|---------|
| **退款不冲销次数等价物（5 通道）** | 5 | 07/08/11/15/20 | 抽 `db/helpers/refund-cascade.ts`；新增 `service_commissions.voided_at` 列 |
| **代码引用已删 schema 字段** | 4 | 05(sku_id) / 12(from_store_name) / 14(store_id) / 09(valid_start/end) | migration 0003 后所有 DROP/RENAME 全仓 grep；CI 加 typecheck + drizzle-kit check |
| **测试反向锁死错误代码** | 5+ | 08/12/14/24/CC9 | 修 P0 同步删/改测试；CI lint "测试不应锁死 schema 字面量" |
| **时区漂移** | 5 | 02/05/06/17/18/CC7 | `ALTER DATABASE fengyu SET timezone='Asia/Shanghai'` + 三端禁 `new Date().toISOString().slice()` |
| **scope 过滤非全覆盖** | 8+ | 01/02/05/06/07/10/11/12/19/25/CC3/CC4 | 强制 staffApi/clientApi/admin 三端 scope helper + middleware assert |
| **同业务工具三/四端副本漂移** | 6+ | 07(DELETE vs is_void) / 08(roleType×3) / 10(customer_type×2) / 15(settlePoints×3) / 19(grantShareGift×3) / 20(remaining×5) | 抽 `cloudfunctions-shared/` + admin lib helper；diff 守卫 |
| **schema 字段写入完整但消费 0** | 4 | 06(过期关闭) / 10(monthly_activity) / 13(applicable_xxx_ids) / 25(promoter_employee_id) | spec/schema docstring 关键字 grep + cron STEP 补齐 |
| **状态机 UPDATE 缺 CAS 守卫** | 5+ 路径 | 02/03/04/06/12/CC2 — 共 12 处 | 全仓 `UPDATE.*WHERE.*_id` 扫描 + CI lint 强制 `AND status =` |
| **TOCTOU：事务外读 → 事务内 INSERT 无 partial unique** | 7 | 03/05/06/12/13×2/CC2 | 11 项 partial UNIQUE 索引一次性 migration |
| **错误前缀偏离 4 项约定 + admin 裸 throw** | 多域 | 01/02/03/04/24/CC5 | 共享 `_shared/error-codes.js` 8 项白名单 + admin `withApiResponse` HOF |
| **PII 三端日志全无脱敏** | 多域 | 01/04/16/CC6 | `db/helpers/pii.ts` mask 系列 + logOperation sanitizeDetail |
| **admin 物理硬删 vs 软删双轨** | 多 | 09(deleteSku) / 15(point_transactions) / 16(deleteMessage) | 关键流水/PII 表统一软删 + 删除前置 logOperation |
| **金额/比例字段无 CHECK 约束** | 5+ | 07(ratio) / 14(card_tx) / 15(pt) / CC1 | 一次性补齐 5 项 CHECK |

---

## 4. 修复 Roadmap（按 L0→L11 传播层）

### L0 — Schema / Enums 层（一次性 migration epic）

**P0（12 项）**：~~跨表 OPENID 唯一（S01-2，已作废）~~ / 手机号 CHECK（S01-1）/ sale_orders 金额符号联动 CHECK（S03-4）/ card_transactions 符号 CHECK（S-CC1-2）/ point_transactions 符号 CHECK + bigint（S-CC1-2）/ sale_allocations.allocation_ratio IN-集合 CHECK（S-CC1-1，保留 NUMERIC(5,2)）/ commission_rate BETWEEN 0 AND 1（S-CC1-3）/ prepaid_cards.balance >= 0（S-CC2-11）/ service_commissions 增 voided_at（S-CC7-2）/ 11 项 partial UNIQUE 索引（M 量级）/ PG timezone = Asia/Shanghai（S-CC7-1）/ 删除冗余列 sale_orders.wechat_transaction_id + alipay_transaction_id（S04-1）/ uq_sop_txn 去除 method 维度（S04-2）

**P1（5 项）**：roleEnum PG enum / productKindEnum PG enum / system_configs 加 special_card_kind_id / sale_orders.allocation_status 加 default '待分配' / PII 历史 operation_logs.detail 一次性脱敏

**P2（2 项）**：products.display_icon 删除决策 / staff_wechat_users.store_id 重命名

### L1 — Helpers 层

**P0（8 项）**：`db/helpers/phone.ts` / `db/helpers/pii.ts` / `db/helpers/scope.ts`（含 assertCustomerInScope/assertEmployeeInScope/assertOrderInScope）/ `db/helpers/money.ts` / `cloudfunctions-shared/error-codes.js` / `cloudfunctions-shared/share-gift.js + points.js` / `db/helpers/refund-cascade.ts` / `db/helpers/role-resolve.ts`

**P1（3 项）**：`db/helpers/dashboard-metrics.ts` / `db/helpers/sale-item-availability.ts` / `cloudfunctions-shared/sanitize.js`

### L3 — 三端 routes / actions 层

**P0（16 项关键 patch）**：
- payNotify/index.js — 接入 V3 签名 + AEAD + IP 白名单 + NODE_ENV 守卫
- staffApi/routes/order.js generateOrderNo — 改单事务
- staffApi/routes/service.js — 移除 sku_id 列引用
- clientApi/routes/store.js requestUnbind — 移除 from_store_name 列引用
- admin/actions/orders.ts applyRecharge/createConversion — 去除 store_id
- admin/actions/orders.ts createOrder — 优惠券 server-side 校验范围
- staff/client order.create — 校验 applicable_market_ids + face_value_override
- staffApi/routes/customer.js（6 路由）— assertCustomerInScope + scope WHERE
- approveRefund 三端 — 5 通道 cascade（sa/sc/coupons/points/picked_up）
- close/cancel/closeExpired 三端 — 状态推进同事务 cascade payments/sa
- 12 处 UPDATE 加 CAS 守卫
- client appointment/message/points 加 requirePhone()
- admin coupon issue + cron 自动发放 — advisory_xact_lock + totalCount 校验
- staff createPickup — `AND item_direction='购买'` 守卫 + requireManager
- payNotify + staff allocation.save + admin batchSave — sa 写入后置 allocation_status

**P1（约 60 项）**：详见各 audit §6 表

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

**P0（4 项）**：audit-money-invariants.ts（5 项不变量）/ audit-prepaid-balance.ts / audit-store-unbind-orphans.ts / audit-refund-cascade-coverage.ts

**P1（2 项）**：dashboard.consistency.test.ts 三端业绩对齐 / CC1 不变量与 ops 工单联动

### Roadmap 总条数

| 层 | P0 | P1 | P2 | 小计 |
|----|----|----|----|------|
| L0 | 13 | 5 | 2 | 20 |
| L1 | 8 | 3 | 0 | 11 |
| L3 | 16 | ~60 | — | 76 |
| L4 | 5 | 3 | 0 | 8 |
| L7 | 6 | 2 | 0 | 8 |
| L9 | 0 | 6 | 2 | 8 |
| L11 | 4 | 2 | 0 | 6 |
| **合计** | **52** | **81** | **4** | **137** |

> P0 修复优先 L0→L1→L3 三层串行（schema migration 是其他层的前置）；L4 cron 与 L11 cron 守护可并行。

---

## 5. 决策与重大风险

### 5.1 用户已决策（2026-04-26）

| 决策 | 内容 |
|------|------|
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

12 项原清单已答 11 项见 §5.1 决策表（Q1/Q2/Q3/Q4/Q5/Q7/Q8/Q9/Q10/Q11/Q12 + Q6 主体方向）；Q5.1/Q5.2 已通过 ticket 2026-04-26-experience-card-as-sku-flag Round 1 答复并落地（见下表 ✅ 行）；剩余 3 项 Q6 细节待补：

| # | 决策项 | 答复 / 推荐方向 | 状态 |
|---|--------|---------------|------|
| Q5.1 | "非体验卡"判定字段（product_kind / is_trial / 名字 LIKE）| **`product_skus.is_experience boolean`** + `sale_items.is_experience` 行级快照（capability 列模式，物理隔离体验卡 SKU 与商城商品） | ✅ Round 1 已落地（migration 0017 + 三端） |
| Q5.2 | 单笔混合订单（体验卡 + 普通商品）跃迁怎么算？ | **按"非体验部分总额"判跃迁**：`order_non_trial_amount = SUM(received WHERE NOT is_experience)`；混合订单 non_trial≥threshold→会员客，>0→小美客，仅体验部分→体验客 | ✅ schema 字段就位；跃迁 SQL Round 2 落地 |
| Q6.1 | sale_order_type 5→3 重构排期：双轨过渡 vs big bang | 双轨过渡（3 周）| P0 待执行 |
| Q6.2 | sale_order_payments 是否需补 audit_status / audit_employee_id / refund_reason 等列承载退款单字段？ | 待 schema check 后定 | P0 待评审 |
| Q6.3 | 历史回款单/退款单迁移时是否一并冲销 sa/sc/coupons/points/pickup？ | 一并冲销（与未来 cascade 一致）| P0 待执行 |

### 5.3 资损金额估算

| 风险 | 资损规模 / 月 | 备注 |
|------|--------------|------|
| payNotify 伪造支付 | **≥ 整月营业额** | 灾难级，攻击门槛 0 |
| 退款不冲销 sa 提成 | 员工业绩 5-15% 长尾累积 | 12 月可达 100% 退款金额对应提成 |
| 退款不冲销 user_coupons | 券面值 × 月退款单数 × 平均折扣 | 顾客主动套利风险 |
| 退款不冲销 picked_up_quantity | 被退商品零售价 | 实物 + 退款双消费 |
| admin createOrder 跨 store 优惠券 | 券面值 × admin 主动套利频次 | admin 内部信任问题 |
| sale_allocations.ratio 写 9.99 | 业绩 ×10 倍 | IN-集合 CHECK 后归零 |
| cron 跳档仅扫会员客 | 流量/体验客生日+感恩+升级三件套漏发 | 单顾客年损 ≈ 礼券 + 积分 |
| 跨表 OPENID 重叠 | 身份混乱无法对账 | 数据完整性，资损延迟暴露 |
| staff customer.* 6 路由 PII | 合规风险 | 不可量化（个人信息保护法）|

> **修复 ROI**：payNotify 签名 + 退款 cascade + ratio CHECK 三项一次修复即可拦下 ≥ 80% 资损通道，预估 1 周内可完成。

### 5.4 跨域 epic 优先级

| Epic | 包含修复 | 推荐排期 |
|------|---------|---------|
| E1 payNotify 安全收官 | P0-04-01/02/03/04 + S04-1/2/3 | 第 1 周 |
| E2 退款级联 cascade（5 通道）| P0-CC2-07 + L1 helpers + L3 三端 + L11 cron | 第 1-2 周 |
| E3 已删字段引用清理 | P0-05-01 / P0-12-01 / P0-14-01 + CC9 测试整改 | 第 1 周（与 E1 并行）|
| E4 scope 全覆盖 | P0-CC4-06 / P0-CC3-x + L1 scope helpers + admin withPermission | 第 2-3 周 |
| E5 schema 不变量 CHECK 一次性 migration | L0 P0 13 项 + L11 audit cron | 第 2 周 |
| E6 时区统一 + 跨端口径收敛 | CC7 + CC1 + dashboard 三端口径 | 第 3-4 周 |
| E7 跨端副本 helper 抽取 | settlePoints / grantShareGift / role-resolve / sale-item-availability | 第 3-4 周 |
| E8 spec 与代码同步守卫 | L9 spec 校对 + CI lint + schema docstring grep | 第 4 周 |
| E9 capability 列收敛 magic string | **Round 1 ✅ 已完成**：is_experience（[ticket](../../notes/tickets/2026-04-26-experience-card-as-sku-flag.md)）；**Round 2 待**：is_recharge_card (S24-1)、跃迁 SQL 切 sale_items.is_experience、cron-worker / cloudfunctions-shared 共享 helper、payNotify/staff confirmOffline/admin recordPayment 三处接入 | 第 1-2 周 |
