# 枚举一致性审计报告（ENUM-AUDIT）

**审计时间**：2026-04-26 v3
**审计范围**：域 01–10 共 10 个域（合并 v1 + v2 独立审计）
**权威来源**：`db/schema/enums.ts`（28 个枚举）
**规范版本**：`real.md` v3.1.0 / `backend.pr.spec.md` v2.1.0

---

## 1. 枚举值缺失（某枚举实际只有 N 值但代码用了 M>N，或用了不存在枚举值的字面量）

### [缺失-01] `payNotify` 引用已从 `saleOrderTypeEnum` 删除的 `'回款单'` 值 — 死代码激活即崩

- **枚举**：`saleOrderTypeEnum`（`db/schema/enums.ts:22`）
- **权威现状**：migration 0018 DROP → 0019 ADD BACK，目前 DB 5 值（销售单/内部单/回款单/转换单/退款单）
- **问题**：`payNotify/index.js:143,221` 检查 `order.sale_order_type === '回款单'`，同时 v4 schema 重构目标是将回款下沉至 `sale_order_payments`，重构完成后 `sale_orders` 中永无 `sale_order_type = '回款单'` 行
- **风险**：大重构 ticket 执行后，`isRepaymentCredential` 路径永远 false（死代码）；但若守卫（`PAYNOTIFY_DISABLED=true`）解除时 schema drift（P0-04v2-03）会先触发 PG 报错，两层问题叠加
- **来源**：域 04 P0-04v2-04（TOP-3 新增）

---

### [缺失-02] `saleOrderTypeEnum` 5 值但三端 create 仅接受 3 值，废弃值无 CHECK 拦截

- **枚举**：`saleOrderTypeEnum`
- **权威值**：`销售单 / 内部单 / 回款单 / 转换单 / 退款单`（5 值）
- **三端实际约束**：
  - staff `order.js:207-211`：仅接受 `销售单 / 内部单`（拒绝 回款单/退款单）
  - admin `orders.ts:703`：接受 `销售单 / 内部单 / 转换单`
  - client create：不传 saleOrderType（默认 `'销售单'`）
- **风险**：外部程序绕过 create 校验直接写 `回款单`/`退款单` 到 DB，触发下游分配/积分/状态机逻辑错误
- **来源**：域 02 P1-02v2-08
- **建议**：L0 migration 精简为 3 值（销售单/内部单/转换单），退款/回款语义完全由 `sale_order_payments.change_type` 表达

---

### [缺失-03] `staffApi order.detail` 读取已 DROP 列 `note`，production apply migration 0018 后崩溃

- **枚举**：无（列不存在问题）
- **现象**：`staffApi/routes/order.js:1329-1344` SELECT `note FROM sale_order_payments`，但 `note` 列已在 migration 0018 DROP，下沉至 `sale_order_payment_details`
- **风险**：5434 生产库 apply migration 0018 后订单详情页崩溃
- **来源**：域 03 P1-03v2-11
- **建议**：改写为 JOIN `sale_order_payment_details`

---

## 2. 枚举值漂移（三端使用的枚举值集合不一致）

### [漂移-04] `customer_type` vs `customer_id IS NOT NULL` — "会员客"判定双口径

- **枚举**：`customerTypeEnum`（流量客/体验客/小美客/会员客）
- **漂移表现**：
  - `staff customer.stats`（line 553-558）：`memberCount = COUNT WHERE customer_id IS NOT NULL`（WorkFine 顾客编号非空）
  - `staff customer.search`（line 27）：`customerType='member'` → `customer_id IS NOT NULL`
  - `staff customer.listByTag`：同 `customer_id IS NOT NULL` 判定
  - 规范：`customer_type='会员客'` 应由 `spending_tier` 阈值跃迁决定
- **风险**：同一"会员客数量"卡片使用两种口径，运营数字矛盾
- **来源**：域 10 P1-10-v2-09
- **建议**：统一改为 `WHERE customer_type = '会员客'`

---

### [漂移-05] `spending_tier` 三端口径漂移

- **枚举**：`spendingTierEnum`（10W+ / 6-10W / 3-6W / 1-3W / 1990-1W / <1990）
- **三端差异**：
  - staff `order.js:55-59`：`SUM(total_amount)` 全量无退款扣减
  - admin `refunds.ts:1242-1248`：`SUM(GREATEST(received - refunded_amount, 0))` 全量无时间窗口
  - cron `refresh-member-levels.ts:72-77`：`SUM(GREATEST(received - refunded_amount, 0))` 12月滚动窗口
  - payNotify：同 staff，含回款单累计；staffApi 同 SQL 不含回款单累计
- **风险**：同一顾客的 spending_tier 随触发路径不同可得不同结果
- **来源**：域 10 P1-10-v2-06 / P1-10-v2-11
- **建议**：统一为 `received - refunded_amount`，全量，仅销售单/转换单，无时间窗口

---

### [漂移-06] `customer_type` 会员客跃迁边界不同：payNotify 含回款单累计，staffApi 不含

- **枚举**：`customerTypeEnum`
- **漂移表现**：
  - payNotify `index.js:470-484`：含 `OR (o.total_amount + COALESCE(SUM(回款单), 0)) >= $2`
  - staff `order.js:86-117`：直接 `total_amount >= $2`，不含回款单累计
- **风险**：相同消费金额经不同路径得不同 customer_type
- **来源**：域 10 P1-10-v2-11
- **建议**：决策统一口径；payNotify 的回款单累计是否保留需与 staffApi 对齐

---

### [漂移-07] `allocation_status` 初值三端不一致

- **枚举**：`allocationStatusEnum`（待分配/已分配）
- **漂移表现**：
  - admin `createOrder`：显式写 `allocationStatus: '待分配'`
  - staff `create`：INSERT 不写列 → DB default NULL
  - client `create`：同 staff，NULL
- **风险**：待分配清单按 `allocation_status='待分配'` 过滤，漏掉 NULL 行
- **来源**：域 02 P1-02v2-06
- **建议**：schema 加 `.default('待分配')` 或三端 INSERT 均显式写

---

### [漂移-08] `paymentChangeType` client 端两处漏写 `'储值卡抵扣'`

- **枚举**：`paymentChangeTypeEnum`（首次支付/回款/退款/储值卡抵扣）
- **漂移表现**：
  - client `create` 全额储值卡抵扣路径：**不写** `sale_order_payments` 行（域 03 P0-03-02 已修复）
  - client `confirmPrepaidFull`：**不写** `sale_order_payments` 行
  - staff 三端：完整写入
  - payNotify：同样不写 `储值卡抵扣`（依赖 `prepaid_card_amount` 直推）
- **风险**：`received = SUM(payments)` 不变量在 client 全额抵扣路径下破裂
- **来源**：域 03 P0-03-02（已 CLOSED from v1）+ 域 04 E04
- **建议**：补全 client 端两处缺失写入

---

### [漂移-09] `orderStatus` 关闭允许集三端分裂

- **枚举**：`orderStatusEnum`（8 值）
- **漂移表现**：
  - admin `closeOrder`：仅 `待支付 / 支付失败` → `已关闭`
  - staff `close`（manager）：`待支付 / 待确认收款 / 支付失败` → `已关闭`
  - client `cancel`：`待支付` 或 `已支付+全额抵扣` → `已关闭`
- **风险**：admin 无法关闭"待确认收款"单，店长在小程序可关；状态机规则未文档化
- **来源**：域 02 P1-02v2-07
- **建议**：统一关闭允许集，补 `待确认收款`

---

### [漂移-10] `appointmentStatus` checkin 前置状态 admin/staff 分裂

- **枚举**：`appointmentStatusEnum`（待确认/已确认/已完成/已取消/已关闭）
- **漂移表现**：
  - staff `checkin`（`appointment.js:246`）：接受 `待确认 / 已确认`
  - admin `checkin`（`appointments.ts:228`）：仅接受 `已确认`（CAS WHERE status='已确认'）
- **风险**：staff 可跳过 confirm 直接签到；操作日志 `logTransition` from='已确认' 与实际 from='待确认' 审计失真；测试锁死宽松行为
- **来源**：域 06 P1-06-11
- **建议**：staff checkin 收敛到仅 `'已确认'`，对齐 admin

---

## 3. 枚举使用错误（引用了已废弃的枚举值）

### [错误-11] `payNotify` SELECT/UPDATE 引用已 DROP 列 `paid_amount` / `wechat_transaction_id`

- **文件**：`payNotify/index.js:127-130,265-275,280-287`
- **错误内容**：
  ```sql
  SELECT ... paid_amount, wechat_transaction_id ...
  UPDATE sale_orders SET paid_amount = $2, wechat_transaction_id = ...
  ```
  两列均在 migration 0018 DROP
- **风险**：`PAYNOTIFY_DISABLED = false` 时，激活即触发 `column "paid_amount" does not exist`，事务回滚，微信支付全部失败（P0-04v2-03，TOP-2 新增）
- **来源**：域 04 P0-04v2-03
- **建议**：全量替换 `paid_amount → received`；删除 `wechat_transaction_id` 相关行

---

### [错误-12] `payNotify` 守卫之后检查 `sale_order_type = '回款单'`，该枚举值语义已重构

- **文件**：`payNotify/index.js:143,221`
- **错误内容**：`isRepaymentCredential = order.sale_order_type === '回款单'`
- **风险**：大重构完成后 `sale_orders` 永无 `回款单` 行，逻辑永远 false；即使未重构也会被 P0-04v2-03 schema drift 先拦截
- **来源**：域 04 P0-04v2-04（TOP-3 新增）
- **建议**：与重构 ticket 对齐，移除此段逻辑或加注释标记待删

---

### [错误-13] `customerType` 搜索用 `customer_id IS NOT NULL` vs `customer_type='会员客'`，功能漂移

- **枚举**：`customerTypeEnum`
- **错误内容**：
  - `stats.memberCount`：用 `customer_id IS NOT NULL`
  - `search customerType='member'`：用 `customer_id IS NOT NULL`
  - 规范语义：`customer_type='会员客'` 应由 spending_tier 阈值跃迁决定
- **风险**：`customer_id IS NOT NULL` 仅表示来自 WorkFine 同步，不等同于消费达标会员
- **来源**：域 10 P1-10-v2-09
- **建议**：统一用 `customer_type = '会员客'`

---

## 4. 枚举未在 DB 约束（缺少 CHECK 约束校验枚举值合法性）

### [约束-14] `allocation_ratio` 无 CHECK 约束，任意小数可写入

- **枚举**：`allocationStatusEnum` 关联字段 `allocation_ratio`（NUMERIC(5,2)）
- **现状**：schema 仅精度约束，无值域 CHECK；应用层 VALID_RATIOS 整十白名单；但 admin `saveAllocation` 单条入口无校验
- **风险**：直连 PG 脚本可写入 0.01/2.00 等非法值，导致 todayCommission 计算错误
- **来源**：域 07 P1-V2-07-06
- **建议**：L0 migration：`CHECK (allocation_ratio >= 0.10 AND allocation_ratio <= 1.00)`

---

### [约束-15] `commission_rate_matrix` 的 `role_type / order_type / sales_category` 用 varchar(20)，无 DB 枚举约束

- **枚举**：`roleTypeEnum` / `orderTypeEnum` / `salesCategoryEnum`（隐性，未声明为 PG enum）
- **现状**：`db/schema/commission.ts:17-19` 三列均为 `varchar(20)`；admin UI 硬编码 `ORDER_TYPE_OPTIONS = ['销售单','服务单']`（缺转换单）
- **风险**：admin 可写 `'service'` 等无效字面量，schema 不拦截
- **来源**：域 08 P2-v2-03
- **建议**：L0 迁移为独立 PG enum：`ALTER TABLE commission_rate_matrix ALTER COLUMN order_type TYPE commission_matrix_order_type USING order_type::commission_matrix_order_type`

---

### [约束-16] `sales_category` 在 `commission_rate_matrix` 和 `sale_items` 用不同类型

- **枚举**：`salesCategoryEnum`
- **现状**：
  - `sale_items.sales_category`：`salesCategoryEnum` PG enum ✅
  - `commission_rate_matrix.sales_category`：`varchar(20)`，非 enum ❌
- **风险**：两边加值/改名节奏不同步；admin UI 硬编码 4 值常量与 schema 可能漂移
- **来源**：域 07 P1-V2-07-06
- **建议**：commission_rate_matrix.sales_category 也迁移为 enum，与 sale_items 统一

---

### [约束-17] `coupon.validity_mode` 用 text + 应用层校验，无 PG enum

- **枚举**：`coupon_validity_mode`（隐性 2 值：`fixed / days`）
- **现状**：`coupon_templates.validity_mode text DEFAULT 'fixed'`，应用层校验合法值，DB 无约束
- **风险**：直接 SQL 可写入 `'forever'` 等脏值；cron expireAt 走隐式 default `NOW() + 365d`
- **来源**：域 13（ENUM-AUDIT.md 原记录）
- **建议**：L0 迁移为 `coupon_validity_mode_enum ('fixed', 'days')`

---

### [约束-18] `point_transactions.type` 用 text 无 PG enum

- **枚举**：`point_transaction_type`（5 值：`消费赠送/消费冲销/等级升级奖励/生日积分/感恩回馈`）
- **现状**：`point_transactions.type text DEFAULT '获取'`，应用层散写；default '获取' 与所有写入路径不符（无路径写'获取'）
- **风险**：枚举语义完全依赖应用层，脏数据可写入任意文本
- **来源**：域 15（ENUM-AUDIT.md 原记录）
- **建议**：L0 迁移为 PG enum

---

## 5. 枚举语义矛盾（同一枚举值在三端含义不同）

### [矛盾-19] `unit_price` 在 `sale_items` 三端写入语义分裂

- **枚举**：无（数值字段语义问题）
- **矛盾表现**：
  - staff：写入 `special_price || price`（实价）
  - client：写入 `price`（原价）
  - admin：信任前端传值
  - `unit_real_price`：staff 语义等同于 unit_price（相同值），client 语义为实际单价
- **风险**：BI 报表 `SUM(unit_price * quantity)` 折扣总额不可信；退款按比例拆分储值卡部分时口径漂移
- **来源**：域 09 P1-09-04
- **建议**：统一约定 `unit_price = sku.price`（原价快照）；`unit_real_price = special_price || price`（实际单价）；`sale_amount = unit_real_price × qty`

---

### [矛盾-20] `commission_status` 在 service_orders 上下文三端含义分裂

- **枚举**：`allocationStatusEnum`（待分配/已分配）共用
- **矛盾表现**：
  - staff `complete`：永远写 `'已分配'`（含 rate=0 的零提成行）
  - admin `completeServiceOrder`：**完全不写**，永远 NULL
  - admin `batchSave`：空数组也写 `'已分配'`
- **语义冲突**：NULL（admin 完成）/ '待分配'（空数组）/ '已分配'（含 rate=0）在 SQL 层无法区分真实语义
- **风险**：admin 完成的服务单绩效报表永久为 0；rate=0 的行显示"已分配"但实际零提成
- **来源**：域 08 P1-v2-04
- **建议**：拆出独立 `serviceCommissionStatusEnum`（4 值：待分配/已分配/待触发/待重算）

---

### [矛盾-21] `roleType` 推断算法在 staff vs admin UI 优先级反转

- **枚举**：`roleTypeEnum`（美容师/养生师/推广师，非 PG enum）
- **矛盾表现**：
  - staff `service.complete`（`service.js:395-396`）：`skills[0] || '美容师'`（取第一个）
  - admin `service-commission-detail-page.tsx:88-95`：推广师>养生师>美容师（优先级反转）
- **风险**：同一员工 `skills=['美容师','推广师']` 时三端计算佣金使用不同角色，金额可能相差 3–6 倍
- **来源**：域 08 P1-v2-06
- **建议**：统一封装 `resolveRoleType(skills)` 函数（建议优先级：推广师>养生师>美容师）

---

### [矛盾-22] `is_recharge_card` / `is_experience` 快照缺失导致顾客类型判断错误

- **枚举**：`customerTypeEnum`（体验客/小美客）
- **矛盾表现**：
  - staff `order.create` INSERT sale_items **遗漏** `is_experience` 列（PG 以 schema default `false` 填充）
  - client / admin 均正确写入
  - 店长开体验卡 → `is_experience=false` → 被判为"小美客"而非"体验客"
- **风险**：顾客类型跃迁结果错误，会员客判定链路污染
- **来源**：域 02 P0-02v2-05
- **建议**：staff INSERT 补 `is_experience` 列（已有变量 `d.isExperience`，仅未写入）

---

### [矛盾-23] `paymentMethod` 枚举白名单三端分裂：staff 不支持支付宝

- **枚举**：`paymentMethodEnum`（微信/支付宝/线下/无/储值卡）
- **矛盾表现**：
  - staff `order.js:209`：`['微信','线下']`（不接受支付宝）
  - admin / client：均支持支付宝
- **风险**：员工端业务能力缺口，店长无法开支付宝收款订单
- **来源**：域 02 E02-payment-method
- **建议**：staff 补支付宝支持或在 PRD 中明确"店长开单不允许支付宝"

---

### [矛盾-24] `productType` 与 `productKind` 值域重叠，无 schema 层 CHECK 约束

- **枚举**：`productTypeEnum`（疗程卡/单品/家居产品）vs `productKind`（text 动态）
- **矛盾表现**：
  - "家居产品" 同时是 `productTypeEnum` 枚举值和 `productKind` 文本值
  - admin `VALID_PRODUCT_TYPES` 硬编码 3 值，与 PG enum 双源不同步
  - schema 无 CHECK 强制对应关系
- **风险**：运营误配 kind=护理项目的分类下可创建 type=家居产品的 SKU，统计报表失真
- **来源**：域 09 P1-09-05
- **建议**：在 schema 加 CHECK 约束，限定合法组合（见 ENUM-AUDIT.md E09-product-kind-vs-product-type）

---

## 6. 废弃枚举残留（已废弃枚举仍有引用）

### [残留-25] `big_category` / `workfine_source` 在文档中引用

- **废弃来源**：
  - `big_category`：已废弃（现为 `product_kind` text 动态）
  - `workfine_source`：已废弃（迁移 0014+0015 清理）
- **残留位置**：
  - `clientApi/README.md:156-157`：引用 `product_spu` / `product_spu_sku_map` 表名（已废弃）
  - `clientApi/测试报告.md:57,95`：引用 `big_category` 字段
  - `db/scripts/sync-products-from-workfine.js`：使用 `big_category / workfine_source`（同步脚本，预期使用）
- **风险**：文档误导新开发者；测试报告断言逻辑已失效（字段不存在）
- **来源**：域 09 P2-09-13
- **建议**：更新 README.md / 测试报告.md 中的废弃字段引用

---

### [残留-26] `组合套餐` / `福利活动` 在 productKind 枚举值中残留

- **废弃来源**：2026-04-10 baseline reset 时已从运行时值中移除
- **残留位置**：
  - admin UI label 映射到 `products.is_bundle=true`（前端字符串，非 DB 枚举值，可接受）
  - staff `CARD_PRODUCT_KINDS` 硬编码兜底常量 `['充值卡','体验卡']`（与 is_card_kind DB 查询双源，可接受）
  - 文档中可能仍有引用
- **现状评估**：运行时已清理，前端 UI label 仅是展示字符串，可接受；监控无生产代码引用
- **来源**：域 09 CC9

---

### [残留-27] `paid_amount` / `wechat_transaction_id` 列在 payNotify 引用（双重废弃）

- **废弃原因**：migration 0018 DROP 列，v4 schema 重命名
- **残留位置**：`payNotify/index.js`（见错误-11）
- **双重废弃**：列已 DROP，守卫未解除时尚不触发；且守卫解除后被 schema drift 先拦截，无法到达此段逻辑
- **来源**：域 04 P0-04v2-03 + P0-04v2-04

---

### [残留-28] `customer_source` 枚举 10 值硬编码，新渠道扩展需三处同步

- **枚举**：`customerSourceEnum`（10 值：美团/抖音/小程序/推带新/地推卡/拓客卡/老带新/转让店/自进店/内部员工或家属）
- **残留表现**：
  - admin select 硬编码 10 值
  - client `sourceGroups` 硬编码副本
  - DB enum 硬编码副本
  - WorkFine 同步顾客上 100% NULL（无来源数据）
- **风险**：新渠道（小红书/视频号）扩展需同时修改三处
- **来源**：域 10 E10-customer-source + 域 25 E25-customer-source
- **建议**：改软枚举（system_configs 维护下拉值）

---

## 汇总表

| ID | 类型 | 枚举/字段 | 三端/问题 | 优先级 | 来源 |
|----|------|----------|----------|--------|------|
| 01 | 缺失 | saleOrderTypeEnum | payNotify 引用已删除的 '回款单' | P0 | 域 04 |
| 02 | 缺失 | saleOrderTypeEnum | 5值仅用3值，无CHECK | P1 | 域 02 |
| 03 | 缺失 | 列 | order.detail SELECT 已DROP列note | P1 | 域 03 |
| 04 | 漂移 | customerTypeEnum | customer_id IS NOT NULL ≠ 枚举值 | P1 | 域 10 |
| 05 | 漂移 | spendingTierEnum | 三端口径：total_amount vs received-refunded vs 12月窗口 | P1 | 域 10 |
| 06 | 漂移 | customerTypeEnum | payNotify含回款单累计，staffApi不含 | P1 | 域 10 |
| 07 | 漂移 | allocationStatusEnum | staff NULL / admin '待分配' / client NULL | P1 | 域 02 |
| 08 | 漂移 | paymentChangeTypeEnum | client两处漏写'储值卡抵扣'（已修+未修）| P1 | 域 03/04 |
| 09 | 漂移 | orderStatusEnum | 关闭允许集三端分裂 | P1 | 域 02 |
| 10 | 漂移 | appointmentStatusEnum | checkin前置状态：admin仅已确认/staff含待确认 | P1 | 域 06 |
| 11 | 错误 | 列引用 | payNotify引用已DROP列paid_amount/wechat_txn_id | P0 | 域 04 |
| 12 | 错误 | saleOrderTypeEnum | payNotify检查'回款单'语义已重构 | P0 | 域 04 |
| 13 | 错误 | customerTypeEnum | search/stats用customer_id非枚举值 | P1 | 域 10 |
| 14 | 约束 | allocation_ratio | 无CHECK约束，非法值可入 | P1 | 域 07 |
| 15 | 约束 | commission_rate_matrix cols | varchar无enum约束 | P2 | 域 08 |
| 16 | 约束 | salesCategory | commission_matrix用varchar/sale_items用enum不一致 | P1 | 域 07 |
| 17 | 约束 | validity_mode | text无PG enum | P2 | 域 13 |
| 18 | 约束 | point_transactions.type | text无PG enum | P2 | 域 15 |
| 19 | 矛盾 | unit_price/unit_real_price | 三端写入语义分裂 | P1 | 域 09 |
| 20 | 矛盾 | allocationStatusEnum | commission_status三端含义NULL/'待分配'/'已分配' | P1 | 域 08 |
| 21 | 矛盾 | roleTypeEnum | staff取skills[0]/admin优先级反转 | P1 | 域 08 |
| 22 | 矛盾 | customerTypeEnum | staff开单遗漏is_experience→判为小美客 | P0 | 域 02 |
| 23 | 矛盾 | paymentMethodEnum | staff不支持支付宝 | P1 | 域 02 |
| 24 | 矛盾 | productTypeEnum/productKind | 值域重叠无CHECK约束 | P1 | 域 09 |
| 25 | 残留 | big_category/workfine_source | 文档中引用废弃字段名 | P2 | 域 09 |
| 26 | 残留 | 组合套餐/福利活动 | 前端UI label残留（已无害） | P2 | 域 09 |
| 27 | 残留 | paid_amount/wechat_txn_id | payNotify引用已DROP列（双重废弃） | P0 | 域 04 |
| 28 | 残留 | customerSourceEnum | 10值硬编码三处副本，新渠道扩展需同步 | P2 | 域 10/25 |

**P0: 5 项**（01, 11, 12, 22, 27）
**P1: 17 项**（02–10, 13, 14, 16, 19–24）
**P2: 6 项**（15, 17, 18, 25, 26, 28）

---

## 修复优先级

### 立即修复（P0，热修）

| ID | 修复 | 关联 |
|----|------|------|
| 01 | payNotify：删除 `sale_order_type='回款单'` 检查，标记 TODO 待大重构删除 | P0-04v2-04 |
| 11 | payNotify：全量替换 `paid_amount → received`，删除 `wechat_transaction_id` 行 | P0-04v2-03 |
| 22 | staff INSERT sale_items 补 `is_experience` 列 | P0-02v2-05 |
| 27 | 与 11 同修（双重废弃，同一文件） | P0-04v2-03 |

### 高优先级（P1）

| ID | 修复 | 关联 |
|----|------|------|
| 02 | `saleOrderTypeEnum` 精简为 3 值 migration | P1-02v2-08 |
| 04/13 | `stats.memberCount` + `search customerType` 统一改为 `customer_type='会员客'` | P1-10-v2-09 |
| 05 | spending_tier 三口径统一决策 + 代码同步 | P1-10-v2-06 |
| 06 | payNotify 会员客分支与 staffApi 对齐 | P1-10-v2-11 |
| 07 | schema 加 `allocation_status DEFAULT '待分配'` | P1-02v2-06 |
| 09 | 关闭允许集三端对齐 | P1-02v2-07 |
| 10 | staff checkin 收敛到仅 `'已确认'` | P1-06-11 |
| 14 | `allocation_ratio` 加 CHECK (>=0.10 AND <=1.00) | P1-V2-07-06 |
| 16 | commission_rate_matrix.sales_category 迁移为 enum | P1-V2-07-06 |
| 19 | 三端 `unit_price`/`unit_real_price` 语义统一 | P1-09-04 |
| 20 | 拆出独立 `serviceCommissionStatusEnum` | P1-v2-04 |
| 21 | 统一 `resolveRoleType(skills)` 算法 | P1-v2-06 |
| 23 | staff 补支付宝支持 | E02-payment-method |

### 规划中（P2）

| ID | 修复 | 关联 |
|----|------|------|
| 03 | order.detail 改 JOIN sale_order_payment_details | P1-03v2-11 |
| 15 | commission_rate_matrix order_type/role_type 迁移为 enum | P2-v2-03 |
| 17 | coupon.validity_mode 迁移为 PG enum | 域 13 |
| 18 | point_transactions.type 迁移为 PG enum | 域 15 |
| 24 | productKind vs productType 加 schema CHECK | P1-09-05 |
| 25 | 更新 clientApi README.md / 测试报告.md 废弃字段 | P2-09-13 |
| 26 | 确认前端 UI label 无生产引用 | CC9 |
| 28 | customerSource 改为 system_configs 软枚举 | E10-customer-source |

---

*审计时间：2026-04-26 v3*
*合并来源：audit-01~10 共 10 域 v3 合并报告*
