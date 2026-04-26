# 审计报告：优惠券 (13)

**审计时间**：2026-04-25 23:00
**域 ID**：13
**slug**：coupons
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：—

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/coupon.ts:11-77` （`couponTemplates` + `userCoupons`） | ↑ | ↑ |
| Enums | `db/schema/enums.ts:81` couponType `[现金券, 品项券, 折扣券]`；`:83` couponStatus `[未使用, 已使用, 已过期]` | ↑ | ↑ |
| 模板 CRUD | `fengyu-admin/src/actions/coupons.ts:259 createTemplate` / `:346 updateTemplate` / `:467 toggleTemplateActive` | — | — |
| 发放 | `fengyu-admin/src/actions/coupons.ts:509 issueCoupon` / `:621 batchIssueCoupons` ；cron 自动发：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:298`（升级权益）/ `grant-birthday-benefits.ts:170`（生日）/ `grant-thanksgiving-benefits.ts:173`（感恩节） | — | — |
| 查询自有券 | `fengyu-admin/src/actions/coupons.ts:587 getIssuedCoupons` | — | `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:14 list` |
| 可用券计算 | `fengyu-admin/src/actions/coupons.ts:106 getAvailableCoupons` | `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:13 available` | `fengyu-client/cloudfunctions/clientApi/routes/coupon.js:114 available` |
| 下单时核销 | `fengyu-admin/src/actions/orders.ts:748` 校验 / `:962-973` claim CAS UPDATE | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:328-407` 校验 + 分摊 / `:522-534` claim | `fengyu-client/cloudfunctions/clientApi/routes/order.js:247-331` 校验 + 分摊 / `:449-460` claim |
| 退款冲销 | `fengyu-admin/src/actions/refunds.ts:778 approveRefund` — **无任何 `user_coupons` 释放**（P0-11-04 retain） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1488-1636 approveRefund` — **同上未释放** | — |
| 取消订单释放券 | `fengyu-admin/src/actions/orders.ts` cancel 路径中**未发现**释放 `user_coupons` 的逻辑 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1091-1097 close` 释放 ✅ | `fengyu-client/cloudfunctions/clientApi/routes/order.js:22-27 closeExpiredOrder` / `:1049-1055 cancel` 释放 ✅ |
| 过期处理 | 无 cron 任务清扫 | `routes/coupon.js:51-55 available` lazy 清扫 | `routes/coupon.js:21-25 list` / `:135-140 available` lazy 清扫 |
| 测试 | `fengyu-admin/src/actions/coupons.test.ts` | — | — |

---

## 2. 数据流图

```
admin.createTemplate                  → coupon_templates
admin.issueCoupon / batchIssue        → user_coupons (status='未使用', expire_at)
cron-worker.refresh-member-levels     → user_coupons (升级权益，cpn-up-{userId}-{level}-{tplId})
cron-worker.grant-birthday-benefits   → user_coupons (bday-{YYYY}-{userId}-{tplId})
cron-worker.grant-thanksgiving        → user_coupons (thx-{YYYY}-{MM}-{userId}-{tplId})

client/staff coupon.available  ──→ lazy expire 清扫 → SELECT 未使用未过期 → 满减门槛/品类/门店过滤 → 折扣计算
admin     getAvailableCoupons  ──→ 同上 + 市场过滤（仅 admin 实现）

下单时（三端 order.create）：
  校验 status='未使用' AND expire_at>NOW() AND ct.is_active
  → CAS UPDATE user_coupons SET status='已使用', used_sale_order_id=$1, used_at=NOW()
    WHERE coupon_id=$2 AND user_id=$3 AND status='未使用' AND expire_at>NOW()
  → rowCount===1 校验

订单关闭/取消（client cancel / staff close / closeExpiredOrder）：
  → UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL
    WHERE used_sale_order_id=$1

退款审批（admin / staff approveRefund）：
  → ✗ 完全不释放 user_coupons（P0-11-04 已记录）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-13-01]** admin `createOrder` 校验优惠券时**完全跳过 store / market / category / product 范围校验**（资损 + 越权）

- 文件：`fengyu-admin/src/actions/orders.ts:748-775`
- 现象：`coupon` 子查询只 SELECT `status, expireAt, userId, couponType, discountValue, maxDiscount, minSpend, isActive`，**根本不读 `applicableStoreIds / applicableMarketIds / applicableCategoryIds / applicableProductIds`**。校验逻辑只判断 `status==='未使用' / expireAt / isActive / minSpend`，门店/市场/品类全部不校验。
- 现象 2：admin `getAvailableCoupons:106-193` 倒是过滤了 `applicableStoreIds + applicableMarketIds`，但 `createOrder` **没有 binding 同样的过滤**。前后端口径不一致 + admin 信任前端的 couponId（CC4）。
- 风险：admin 用户给"南昌门店专属券"挂到任意其它门店订单 / 给"面部护理品类券"挂到家居产品订单。资损量级 = 单券面值 × 任意订单。
- 复现：1) admin 创建 `applicableStoreIds=['store-A']` 的 ¥100 现金券；2) admin 给某顾客发一张；3) admin 用顾客身份在 store-B 开单，传 `couponId`；4) 订单成功扣减 ¥100，原本 store-B 不在范围。
- 修复：(L7) `actions/orders.ts:748` 增补 SELECT `applicableStoreIds / applicableMarketIds / applicableCategoryIds / applicableProductIds`，参考 `getAvailableCoupons` + staff/client `order.create` 的过滤逻辑。

#### **[P0-13-02]** staff / client `order.create` 完全忽略 `applicable_market_ids`（数据资损）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:329-339` + `fengyu-client/cloudfunctions/clientApi/routes/order.js:249-260`
- 现象：两端 SELECT 都不读 `applicable_market_ids`；admin schema 已建该列（`db/schema/coupon.ts:30`）+ admin createTemplate 写入 + admin getAvailableCoupons 过滤。但 staff/client 端**完全无视该字段**。市场维度的券（如某市场专属推广券）能被任意市场顾客在任意市场使用。
- 风险：跨市场使用券 → 市场 A 的促销预算被市场 B 顾客侵蚀 → 市场维度 ROI 数据失真，资损按市场预算上限计。
- 修复：(L3 ×2) 三端对齐 + 抽公共 `helpers/coupon-validate.js` 统一 storeId/marketId/categoryIds 过滤函数。

#### **[P0-13-03]** 三端 order.create + admin getAvailableCoupons + admin createOrder **全部忽略 `applicable_product_ids`**（设计缺失）

- 文件：上述 5 处。
- 现象：`db/schema/coupon.ts:24 applicableProductIds`（→ products.product_id）字段存在，admin createTemplate 写入，admin/client 列表展示。但**没有任何运行时路径在 order.create 时按 productId 过滤**，全部仅以 `applicable_category_ids` + `sku_id → category_id` JOIN 检查。
- 风险：精细的"单 SPU 体验券"需求无法实现，运营把希望放在 `applicableProductIds` 上 → 实际用券方完全不限品 → 直接资损。当前看可能只是隐患（运营未启用），但字段长期存在却不消费 = 滴答炸弹。
- 修复：要么 (L0) DROP 该字段（如运营从未用），要么 (L3) 三端补 product_id 过滤逻辑。建议先量化 `SELECT count(*) FROM coupon_templates WHERE applicable_product_ids IS NOT NULL` 决定方向。

#### **[P0-13-04]** 退款审批不释放 `user_coupons`（资损，retain P0-11-04）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1488-1636` + `fengyu-admin/src/actions/refunds.ts:778`
- 现象：approveRefund 完全没有反向操作 `user_coupons`。客户全额退款后，原券保持 `status='已使用', used_sale_order_id=<已退款单>` 永久无法重用。
- 风险：与 audit-11 P0-11-04 同源；保留在本报告作为优惠券域的资损主线。
- 修复：(L3) 退款全额时 `UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE used_sale_order_id=$refSaleOrderId`；部分退款保持 '已使用' 不变。

#### **[P0-13-05]** staff / admin `order.create` 读券时**不消费 `face_value_override`**（资损双向）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:330-339` 直接读 `ct.discount_value`；`fengyu-admin/src/actions/orders.ts:755` 直接读 `couponTemplates.discountValue`。
- 现象：仅 client 端 `order.create:252` 与 client `coupon.list:39 / available:147` 用 `COALESCE(uc.face_value_override, ct.discount_value)`。staff 端 `coupon.available:62` 也用了 COALESCE，但下单 `order.create` 漏掉。admin 全链路不感知 `face_value_override`。
- 风险：分享礼/动态面值场景，staff 帮顾客线下开单 → 用模板默认面值（如模板 ¥0 的占位券，运行时被 share 写入 ¥30）→ staff create 抵扣 ¥0 直接吃券；反向 admin 录单 → 模板 ¥50 但 override ¥10 → 抵扣 ¥50 资损 ¥40。
- 修复：(L3 ×2) staff order.js:331 + admin orders.ts:755 改为 `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value`。

#### **[P0-13-06]** admin `issueCoupon` / `batchIssueCoupons` `totalCount` 检查 **read-then-write TOCTOU**（库存超发）

- 文件：`fengyu-admin/src/actions/coupons.ts:527-535` + `:652-665`
- 现象：`if (tpl.totalCount !== null) { const [{count}] = COUNT(*) ...; if (count >= tpl.totalCount) return ... }` 后立即 `db.insert(userCoupons)`，**不在事务内、无 advisory lock、无唯一约束兜底**。两个 admin 同时 issue 最后 1 张券 → 都通过校验 → 都插入 → totalCount=N+1。
- 风险：限量券（如 "新客 100 张" 营销券）超发，资损量级 = 超发数 × 单券面值。
- 复现：1) 模板 totalCount=1；2) 并发开两个 issueCoupon 调用；3) `SELECT count(*) FROM user_coupons WHERE template_id=...` 得到 2 行。
- 修复：(L3) 改为 advisory_xact_lock(`hashtext('coupon-issue-' || templateId)`) + 事务内 `SELECT count(*) FROM user_coupons WHERE template_id=$1 FOR UPDATE` 然后插入；或更简单：在 user_coupons 表加一个针对 templateId 的 SERIAL `issue_seq` 列 + UNIQUE(templateId, issue_seq) + 应用层 INSERT-on-conflict 失败回退。

#### **[P0-13-07]** cron-worker 自动发放（升级 / 生日 / 感恩节）**完全不校验 `totalCount`**（库存失控）

- 文件：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:280-303` / `grant-birthday-benefits.ts:160-176` / `grant-thanksgiving-benefits.ts:165-185`（行号近似）
- 现象：cron 任务 INSERT user_coupons 时只检查 `tpl.is_active`，根本不查 `totalCount` 是否还有库存。生日 / 感恩节自动批量发放 → 限量券立即被 cron 直接写穿。
- 风险：与 P0-13-06 叠加，运营手动 + 自动双线穿仓，资损量级 = 整个会员池 × 单券面值。
- 修复：(L3) cron tx 内 SELECT count + 比较；或 (L0) 强制约束：cron 发放路径用的模板必须 `totalCount IS NULL`，schema 加 CHECK 约束 / 业务文档明确分区。

#### **[P0-13-08]** admin `getAvailableCoupons` 缺 scope 守卫（CC4 越权）

- 文件：`fengyu-admin/src/actions/coupons.ts:106-118`
- 现象：仅 `requirePermission(session, 'sale_order:create')`，传入参数 `clientUserId` **不校验是否属于当前 session 的 scope**（store_manager / 一线员工应只能查自己门店绑定的顾客的券）。任何 admin 用户传任意 `clientUserId` 即可枚举该顾客的全部 user_coupons + 模板信息。
- 风险：跨店枚举顾客券资产；与 P1-11-09 (`estimateRefundOverdraft`) 同模式。中等敏感，PII + 营销情报泄露。
- 修复：(L7) 加 `scopeCondition` 过滤 `clientWechatUsers.boundStoreId`；如果 store_manager 调用且 clientUserId 不在 scope 内 → 返回空 + 警告。

---

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-13-09]** staff `coupon.available` 缺 market 过滤（与 admin 不一致）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:88-105`
- 现象：staff 端 available 只过滤 `applicable_store_ids`，不过滤 `applicable_market_ids`。admin getAvailableCoupons 已实现市场过滤。staff 与 admin 行为不一致 → 店长前端展示的"可用券"含跨市场券；下单时 staff `order.create` 也不校验市场（P0-13-02 同源）→ 下单成功。
- 修复：(L3) 同 P0-13-02 抽公共校验函数。

#### **[P1-13-10]** client `coupon.list` 不暴露 `applicable_market_ids`（前端无法显示市场限制）

- 文件：`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:35-105`
- 现象：返回 `applicableStoreNames + applicableCategoryNames`，但**不返回市场名**。顾客看不出"该券仅限上海市场"。
- 修复：(L3) 加 market 名称解析 + 返回 `applicableMarketNames`。

#### **[P1-13-11]** staff `coupon.available` 用 `storeName` 反查 storeId 而非 `effectiveStoreId`（CC3 隔离不彻底）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:38-48`
- 现象：`payload.storeId || payload.storeName || ctx.auth.storeName`，**不优先用 `ctx.auth.effectiveStoreId`**（参考 staffApi/CLAUDE.md `effectiveStoreId` 是业务 SQL 必须使用的字段）。多店店长在管理层模式 + 门店模式之间切换可能查不到正确门店。
- 修复：(L3) 优先用 `ctx.auth.effectiveStoreId`；payload 仅作覆盖。

#### **[P1-13-12]** staff `available` 无 `clientPhone` 即静默返回空数组（不区分"顾客不存在 vs 顾客无券"）

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:31-34`
- 现象：`if (clientRows.length === 0) ctx.result = { coupons: [] }; return`。前端无法区分"phone 写错"与"该顾客无券"。
- 修复：(L3) 抛 `INVALID_PARAMS: 顾客不存在` 或返回明确的状态码。

#### **[P1-13-13]** admin `validateValidityFields` 拒"validTo<=now"，但 `issueCoupon` 不复检 → 编辑后即将过期的模板可发出立即过期券

- 文件：`fengyu-admin/src/actions/coupons.ts:548-560` + `:686-699`
- 现象：模板 validTo 在过去（admin 漏改），issueCoupon `expireAt = new Date(tpl.validTo)` 计算出"已过期"日期 → 顾客查 `expire_at>NOW()` 永远查不到 → 该券静默不可用。但用户已收到"发放成功"消息。
- 修复：(L7) issueCoupon 计算 expireAt 后比较 NOW() ，过期则拒绝。

#### **[P1-13-14]** admin `updateTemplate` 用 `result.count === 0`（drizzle 返回类型不稳）判断乐观锁，但乐观锁 SQL 用 `date_trunc('milliseconds')` 比较

- 文件：`fengyu-admin/src/actions/coupons.ts:441-460`
- 现象：`date_trunc('milliseconds', updated_at) = $expectedUpdatedAt` 假设 updated_at 精度只到 ms，但 drizzle ORM `$onUpdate(() => new Date())` 返回 JS 毫秒精度，PG 存储微秒精度。比较时 PG 端做 trunc 但 JS 端的 `expectedUpdatedAt` 字符串若直接来自前端 `updated_at.toISOString()` 会精确匹配；但若并发链路有不同序列化路径（admin actions ↔ cron-worker ↔ 直接 SQL），微秒尾数会导致乐观锁误报"被其他人修改"。
- 修复：(L7) 统一序列化口径，或改用 `version` 单调列。

#### **[P1-13-15]** admin `toggleTemplateActive` 停用券模板**不影响已发放但未使用的券**（业务规则缺失）

- 文件：`fengyu-admin/src/actions/coupons.ts:467-503`
- 现象：toggle 仅改 `couponTemplates.is_active = false`。下单时 client/staff/admin 都做 `AND ct.is_active = true` 校验 → 已发但未使用的 user_coupons 立即不可用。看似一致，但顾客小程序 `coupon.list` SQL **不含 `is_active` 过滤**（`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:35-53`）→ 顾客看到券，点击使用时被拒。UX 断裂。
- 修复：(L3) client coupon.list 加 `AND ct.is_active = true`；或 admin toggle 时同步 `UPDATE user_coupons SET status='已过期'` 让顾客端自动消失。

---

### 3.3 P2（代码质量 / 可维护）

#### **[P2-13-16]** 三端 coupon discount 计算逻辑近 100% 重复 + admin `calcCouponDiscount` 与 staff/client SQL 互不知

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:107-124 + order.js:373-407`；`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:191-211 + order.js:294-330`；`fengyu-admin/src/lib/utils.ts:37-49`
- 现象：折扣计算 + 满减门槛 + 行级分摊三段逻辑，三端独立实现。staff coupon.available 已经精确到分 + 浮点兜底，order.create 复制一遍；client 同样。admin 的 `calcCouponDiscount` 在 utils 但不做行级分摊（admin 不分摊到 sale_items.received，仅写 `sale_orders.coupon_discount` 单字段）。
- 修复：(L3) 抽 `helpers/coupon-discount.js`（在 audit-02 §6.4 P0-02-01 修复表中已提）；admin 用 npm-shared 或重写。

#### **[P2-13-17]** staff `coupon.available` / order.create 不写 `operation_logs`（CC4 审计断裂）

- 文件：staff coupon.js / order.js coupon claim 段
- 现象：staff 全程无 `logOperation`。开单时核销 user_coupons 是营业账目级动作（金额抵扣），却无审计写入。
- 修复：(L3) 接入 `helpers/operation-log.js`（与 audit-11 P1 staff 0 logOperation 同源）。

#### **[P2-13-18]** client `coupon.list` 用 `IF tpl is_active=false 不过滤` 导致已停用模板的旧券仍展示

- 同 P1-13-15。归类于 list 接口设计简化。

#### **[P2-13-19]** staff/client 取消订单释放券**释放范围过广**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1093-1097` + `fengyu-client/cloudfunctions/clientApi/routes/order.js:23-27 + 1050-1055`
- 现象：`UPDATE user_coupons SET status='未使用' WHERE used_sale_order_id=$1` — 没有 `AND status='已使用'` CAS 守卫。如果 admin 已手动把券置为 `'已过期'`（如运营降级处理），订单关闭会"复活"过期券。
- 修复：(L3) UPDATE 加 `AND status='已使用'` 守卫。

#### **[P2-13-20]** `coupon-tpl-` ID 由前端传入（admin createTemplate）+ 无格式校验

- 文件：`fengyu-admin/src/actions/coupons.ts:316`
- 现象：`templateId: data.templateId` 直接信任前端，仅靠 `23505` UNIQUE 错误反馈冲突。无前缀校验、无 length 校验、无字符集白名单（中英文/特殊字符都能进）。
- 修复：(L7) 加正则白名单 `^coupon-[a-z0-9-]{2,40}$`，或服务端 nanoid 自动生成。

#### **[P2-13-21]** `userCoupons.couponId` 由 admin / cron 各自字符串拼接，无中央生成器

- 文件：admin issueCoupon `cpn-${Date.now()}-${random36(4)}`；batchIssueCoupons `cpn-${now}-${random36(4)}-${i}`；cron `cpn-up-{userId}-{level}-{tplId}` / `bday-{YYYY}-{userId}-{tplId}` / `thx-{YYYY}-{MM}-{userId}-{tplId}`
- 现象：5 种生成模式、不同前缀、长度差异大。运营查"该顾客本次升级权益"用 LIKE 'cpn-up-...-%'（参考 `fengyu-admin/src/actions/refunds.ts:378`）依赖前缀；任一模式被改都会破坏统计。
- 修复：(L7) 抽 `lib/coupon-id.ts`，约定 `{kind}-{...args}` 命名模式 + 单元测试覆盖。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 可用券范围过滤 | store + market 过滤 ✅ | store ✅ market ✗ | store ✅ market ✗ | 跨市场资损 | P0-13-02/13-09 |
| 下单时校验范围 | store ✗ market ✗ category ✗ product ✗ | store ✅ category ✅ market ✗ product ✗ | store ✅ category ✅ market ✗ product ✗ | admin 完全失守 | P0-13-01 |
| 读 face_value_override | ✗ | available ✅ / order.create ✗ | available ✅ / list ✅ / order.create ✅ | 动态面值漂移 | P0-13-05 |
| 已使用券核销 | tx + CAS rowCount=0 抛错 ✅ | tx + CAS rowCount!==1 抛错 ✅ | tx + CAS rowCount!==1 抛错 ✅ | OK | — |
| 释放券（订单关闭）| ✗（admin orders.ts cancel 路径未发现释放）| ✅（无 CAS 守卫，P2-13-19）| ✅（无 CAS 守卫，P2-13-19） | admin cancel 漏 | P1 |
| 释放券（退款）| ✗ | ✗ | — | 资损（P0-13-04）| P0 |
| 过期清扫 | ✗（无 cron） | lazy（available 时） | lazy（list/available 时） | 数据库膨胀 | P2 |
| coupon.list 过滤 is_active | — | — | ✗ | UX 断裂 | P1-13-15 |
| operation_logs | ✅（issue/batchIssue/create/update/toggle）| ✗（claim 0 行）| ✗ | 审计断裂 | P2-13-17 |
| 错误码前缀 | `success: false, message:` 非 4 项前缀（admin server actions 自有体系） | `INVALID_PARAMS: / INSUFFICIENT_BALANCE:` ✅ | `INVALID_PARAMS:` ✅ | admin 与 CC5 不对齐（admin 全局问题）| P2 |

---

## 5. 横切检查（套用 §3 模板，仅记录有问题的项）

- [x] **CC1 数值精度**：couponTemplates.discountValue / minSpend / maxDiscount 都是 NUMERIC(10,2) ✅；分摊到 received 用 `Math.round(× 100) / 100` + 最后一项尾差吸收 ✅。calcCouponDiscount 用 `parseFloat` 但前置已归一化 ✅。
- [ ] **CC2 并发 / 幂等**：claim CAS ✅；但 issueCoupon/batchIssueCoupons totalCount TOCTOU [P0-13-06]、cron 不验 totalCount [P0-13-07]、cancel 释放无 CAS [P2-13-19]。
- [ ] **CC3 组织域隔离**：admin getAvailableCoupons 无 scope 守卫 [P0-13-08]；staff coupon.available 用 storeName 而非 effectiveStoreId [P1-13-11]。
- [ ] **CC4 后端鉴权**：admin createOrder 信任前端 couponId 不重算范围 [P0-13-01]；staff/client 范围不齐 [P0-13-02/13-03]。
- [ ] **CC5 错误码**：admin 用 `{success:false, message:...}` 非 4 项前缀（与 CC5 全局违规同步）；staff/client ✅。
- [ ] **CC6 PII**：admin operation_logs 写入 `customerPhone, customerName`（可能含完整手机号）— `actions/coupons.ts:577 + :720` 直接放 phone 列表入 details JSON。建议脱敏或仅存 userId。
- [x] **CC7 时间字段**：created_at / updated_at defaultNow ✅；expire_at 写入显式 ✅；used_at 显式 NOW() ✅；时区一致（PG NOW + JS new Date 全部 UTC 落盘）✅。
- [x] **CC8 WXML / Vant**：未审（前端 UI 不在本域）。
- [ ] **CC9 测试 / 残留**：`fengyu-admin/src/actions/coupons.test.ts` 覆盖 admin 流程；staff/client 无 unit test；schema `applicable_product_ids` 字段死代码 [P0-13-03]。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/coupon.ts:24` | 决策 `applicableProductIds` 是否启用：DROP 或在三端 order.create 实现过滤 | P0-13-03 |
| L3 公共 helper | 新建 `helpers/coupon-validate.js`（staff/client/admin npm 共享） | 抽 store/market/category/product 过滤 + face_value_override 读取 | P0-13-01/02/03/05 |
| L3 staffApi | `routes/order.js:330-339` | SELECT 加 `applicable_market_ids / applicable_product_ids / face_value_override`；调用 helper 过滤 | P0-13-02/03/05 |
| L3 staffApi | `routes/order.js:1488-1636 approveRefund` | 全额退款时释放 user_coupons | P0-13-04 |
| L3 staffApi | `routes/coupon.js:88-105` | 加市场过滤 + market 名称解析 | P0-13-02, P1-13-09/10 |
| L3 staffApi | `routes/coupon.js:38` | 优先 `ctx.auth.effectiveStoreId` | P1-13-11 |
| L3 staffApi | `routes/coupon.js:31-34` | 顾客不存在抛 INVALID_PARAMS | P1-13-12 |
| L3 staffApi | `routes/order.js:1091-1097 close` | UPDATE 加 `AND status='已使用'` CAS | P2-13-19 |
| L3 clientApi | `routes/order.js:249-260` | SELECT 加 market/product；调用 helper | P0-13-02/03 |
| L3 clientApi | `routes/coupon.js:35-53 list` | 加 `AND ct.is_active = true` 或显示停用标识；返回 applicableMarketNames | P1-13-10/15 |
| L3 clientApi | `routes/order.js:23-27 / 1049-1055` | UPDATE 加 `AND status='已使用'` CAS | P2-13-19 |
| L3 cron-worker | `src/cron/steps/refresh-member-levels.ts:280` + `grant-birthday-benefits.ts:160` + `grant-thanksgiving-benefits.ts:165` | INSERT user_coupons 前事务内查 totalCount，超额日志告警跳过 | P0-13-07 |
| L7 admin | `src/actions/orders.ts:748-775` | SELECT 加 4 个范围字段 + face_value_override；过滤逻辑对齐 staff/client | P0-13-01/05 |
| L7 admin | `src/actions/coupons.ts:509 issueCoupon` + `:621 batchIssueCoupons` | tx 内 advisory lock + 复查 totalCount；issueCoupon 校验 expireAt > NOW() | P0-13-06, P1-13-13 |
| L7 admin | `src/actions/coupons.ts:106 getAvailableCoupons` | 加 scope 校验 clientUserId.boundStoreId | P0-13-08 |
| L7 admin | `src/actions/refunds.ts:778 approveRefund` | 全额退款时释放 user_coupons | P0-13-04 |
| L7 admin | `src/actions/coupons.ts:316 createTemplate` | templateId 正则白名单或服务端 nanoid | P2-13-20 |
| L7 admin | `lib/coupon-id.ts`（新文件） | 中央 couponId 生成器 + 单测 | P2-13-21 |
| L9 admin UI | `_components/coupon-create-page.tsx + coupon-detail-page.tsx` | 增加 `applicableProductIds` UI（如选 keep）/ 移除（如选 drop） | P0-13-03 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1) 量化 applicable_product_ids 是否被运营使用
SELECT count(*) AS templates_with_product_filter
FROM coupon_templates
WHERE applicable_product_ids IS NOT NULL AND array_length(applicable_product_ids, 1) > 0;

-- 2) 量化 applicable_market_ids 启用程度（决定 P0-13-02 修复优先级）
SELECT count(*) FROM coupon_templates
WHERE applicable_market_ids IS NOT NULL AND array_length(applicable_market_ids, 1) > 0;

-- 3) 量化 P0-13-04：已批准退款但 user_coupons 仍 '已使用' 的资损
SELECT count(*) AS leaked_used_coupons,
       SUM(COALESCE(uc.face_value_override::numeric, ct.discount_value::numeric)) AS lost_value
FROM sale_orders refund
JOIN user_coupons uc ON uc.used_sale_order_id = refund.ref_sale_order_id
JOIN coupon_templates ct ON ct.template_id = uc.template_id
WHERE refund.sale_order_type = '退款单' AND refund.status = '已支付'
  AND uc.status = '已使用';

-- 4) 量化 P0-13-06：limit 模板是否超发
SELECT t.template_id, t.name, t.total_count, COUNT(uc.coupon_id) AS issued,
       COUNT(uc.coupon_id) - t.total_count AS overflow
FROM coupon_templates t
JOIN user_coupons uc ON uc.template_id = t.template_id
WHERE t.total_count IS NOT NULL
GROUP BY t.template_id, t.name, t.total_count
HAVING COUNT(uc.coupon_id) > t.total_count;

-- 5) 量化 P0-13-05：face_value_override 与 template.discount_value 不同的活券
SELECT count(*) AS divergent_active_coupons
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
WHERE uc.face_value_override IS NOT NULL
  AND uc.face_value_override::numeric != ct.discount_value::numeric
  AND uc.status = '未使用'
  AND uc.expire_at > NOW();

-- 6) 量化 P1-13-15：已停用模板下仍有"未使用"券
SELECT count(*) AS undead_coupons,
       count(DISTINCT uc.template_id) AS affected_templates
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
WHERE ct.is_active = false AND uc.status = '未使用' AND uc.expire_at > NOW();

-- 7) 验证 lazy expire 机制：已经"应该过期但未清扫"的券
SELECT count(*) AS stale_unexpired
FROM user_coupons
WHERE status = '未使用' AND expire_at <= NOW();

-- 8) 跨店使用证据（P0-13-02 量化）
SELECT count(*) AS cross_store_used
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
JOIN sale_orders so ON so.sale_order_id = uc.used_sale_order_id
WHERE uc.status = '已使用'
  AND ct.applicable_store_ids IS NOT NULL
  AND NOT (so.store_id = ANY(ct.applicable_store_ids));
```

---

## 8. 回归测试用例（建议）

1. admin 创建仅限 store-A 的现金券 → 用顾客在 store-B 开单 → **应当拒绝**（当前 admin 通过）
2. admin 创建仅限"面部护理"品类券 → 在含家居产品订单使用 → **应当只对面部护理行抵扣**
3. share gift 写 face_value_override=¥30 → admin 录单使用 → 抵扣应为 ¥30 而非模板 ¥50
4. admin 全额退款一张 ¥100 现金券订单 → 查 user_coupons.coupon_id → status='未使用'（依赖 P0-13-04 修复）
5. 并发 2 admin 同时 issueCoupon limit=1 模板 → 仅 1 张写入（依赖 P0-13-06）
6. cron 同日生日 + 升级 + 感恩节同跑 limit=10 模板 → 不超发（依赖 P0-13-07）
7. admin 停用模板 → 顾客 client.coupon.list → 已发未用券应**消失或显示停用**
8. admin getAvailableCoupons 用其他 store 的 clientUserId → 拒绝或返回空
9. staff coupon.available 在管理层模式（loginLevel='management'）传 storeId → 应使用传入值；门店模式不传 → 应用 effectiveStoreId
10. 折扣券 dv=0.85 max_discount=¥200 + eligibleTotal=¥2000 → 折扣应为 ¥200（封顶生效）；eligibleTotal=¥500 → 折扣 ¥75

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑（admin schema / actions、staff routes、client routes、cron 全链）
- 涉及历史数据：☑（已批准退款的 user_coupons 历史回溯，超发模板回退，face_value_override 历史订单核对）
- 修复成本：**M / L** —
  - L0 决策 + L3 helper 抽取 ~1 周
  - 三端 order.create + cron-worker 修改 + 数据修复脚本 ~2 周
  - 历史数据修复（释放退款关联券、超发回收）需 PRD 决策

---

## 10. 后续待办

- [ ] 与产品 / 运营对齐：`applicable_product_ids` 是 keep 还是 drop（P0-13-03）
- [ ] 与产品对齐：share-gift / 分享礼链路 `face_value_override` 当前由谁写、生命周期（P0-13-05 关联）
- [ ] 写数据修复脚本：把已批准退款的 user_coupons 反向 `status='未使用'`（与 audit-11 P0-11-04 数据修复合并）
- [ ] 写数据修复脚本：超发的 limit 模板回收（按 created_at 倒序保留前 totalCount 张，其余 status='已过期'）
- [ ] cron-worker 增加 `totalCount` 哨兵 + 告警通道（接前轮 cron-worker notifyOps）
- [ ] 在 audit-CC2/CC3/CC4 段添加本域命中条目
