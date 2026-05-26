# 审计报告：优惠券 (13)

**审计时间**：2026-04-26
**域 ID**：13
**审计员**：claude-sonnet-4-6
**审计时长**：约 30 分钟（独立重新审计，以代码为准）
**关联 PR/Ticket**：—

---

> ### ✅ 2026-05-17 复核状态
>
> | 问题 ID | 原状态 | 2026-05-17 复核 |
> |---------|--------|-----------------|
> | **P0-13-01** admin createOrder 不校验 applicable_store_ids | 未修复 | ✅ **已修复** — `fengyu-admin/src/actions/orders.ts:952-957` |
> | **P0-13-02** admin createOrder 不校验 applicable_market_ids | 未修复 | ✅ **已修复** — orders.ts:959-971（含 market 反查）|
> | **P0-13-03** admin createOrder 不校验 applicable_category/product_ids | 未修复 | ✅ **已修复** — orders.ts:973-988 |
> | **client/staff 三端 face_value_override 跨端读取** | 未修复 | 🔶 admin 三处已加 COALESCE；staff/client 仍需核（SUMMARY v3 §2 #11）|
> | ticket | — | ✅ ticket `2026-04-27-coupon-scope-validation.md` 已归档 |
> | 其余 P0/P1 | — | 未复核 |

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/coupon.ts:11-77` | ↑ | ↑ |
| Enum | `db/schema/enums.ts:89-91` | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/coupons.ts` | `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js` | `fengyu-client/cloudfunctions/clientApi/routes/coupon.js` |
| 使用方（创建订单） | `fengyu-admin/src/actions/orders.ts:882-910` | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:319-401` | `fengyu-client/cloudfunctions/clientApi/routes/order.js:274-357` |
| 退款归还 | `fengyu-admin/src/lib/refund-cascade.ts:119-133` | `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js 通道3` | client 无退款路径 |
| 关闭订单释放券 | `fengyu-admin/src/actions/orders.ts:599-651`（**缺失**） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1124-1130` ✅ | `fengyu-client/cloudfunctions/clientApi/routes/order.js:1137-1143` ✅ |
| 前端 | admin Next.js RSC 页面 | `fengyu-staff/miniprogram/pages/order-create/order-create.wxml` | `fengyu-client/miniprogram/pagesCoupon/my-coupons/my-coupons.wxml` |
| 测试 | `fengyu-admin/src/actions/coupons.test.ts` | — | — |

---

## 2. 数据流图

```
枚举权威（db/schema/enums.ts:89-91）：
  couponTypeEnum   = ['现金券', '品项券', '折扣券']
  couponStatusEnum = ['未使用', '已使用', '已过期']

[admin issueCoupon / batchIssueCoupons]
  → user_coupons INSERT (status='未使用', expireAt 按 validityMode 计算)

[coupon.available — 三端列出推荐券，不 claim]
  懒清扫：UPDATE status='已过期' WHERE expire_at <= NOW()（staff/client ✅，admin cron ❌）
  过滤：applicable_store_ids + applicable_category_ids + min_spend + coupon_type 计算

[order.create — 三端皆有]
  读：user_coupons + coupon_templates JOIN
  校验：status='未使用' + expire_at > NOW() + is_active=true
       + applicable_store_ids（staff ✅ client ✅ admin ❌）
       + applicable_category_ids（staff ✅ client ✅ admin ❌）
       + min_spend 满减门槛（基数：staff=received staff ✅；admin=saleAmount ≠ staff P1）
  事务内原子 claim：UPDATE user_coupons SET status='已使用' WHERE status='未使用'（CAS ✅）

[订单关闭/取消 — 释放券]
  staff order.close:1124  ✅
  client order.cancel:1138 ✅
  admin closeOrder:599     ❌ 缺失

[退款审批通过 — cascadeRefund 通道3]
  UPDATE user_coupons SET status='未使用'
  WHERE used_sale_order_id=$1 AND status='已使用'
  AND expire_at > NOW()（admin lib ✅ staff helpers ✅，过期券不归还 P2）
```

---

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

---

**[P0-13-01] admin `closeOrder` 关闭订单时未释放已核销优惠券**

- 文件：`fengyu-admin/src/actions/orders.ts:611-635`
- 现象：`closeOrder` 事务内仅作废 `sale_allocations`（`sql UPDATE sale_allocations SET is_void=true`），未 UPDATE `user_coupons` 归还券。staff 端 `order.js:1124-1130` 和 client 端 `order.js:1137-1143` 均有对应 UPDATE，admin 独漏。
- 风险：admin 关闭一笔"待支付"或"支付失败"订单后，已核销的优惠券永久停留在 `status='已使用'`，顾客损失该券，无法在其他订单使用。
- 复现：1) admin 开单时选用优惠券 2) 订单落 `status='待支付'` 3) admin 执行 `closeOrder` 4) 查 `user_coupons`：status 仍为 `'已使用'`，`used_sale_order_id` 仍指向已关闭订单
- 修复：L7 admin actions — `closeOrder` 事务内追加：
  ```sql
  UPDATE user_coupons
     SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
   WHERE used_sale_order_id = $saleOrderId
  ```

---

**[P0-13-02] admin `createOrder` 缺少优惠券门店（`applicable_store_ids`）和品项分类（`applicable_category_ids`）范围校验**

- 文件：`fengyu-admin/src/actions/orders.ts:882-910`
- 现象：admin 优惠券校验仅检查：`status + expireAt + userId + isActive + minSpend`，**未读取也未校验 `applicableStoreIds` / `applicableCategoryIds`**。SELECT 语句中两字段均未被 select。staff 端 `order.js:340-364` 和 client 端 `order.js:298-321` 均做了门店+分类双校验。
- 风险：admin 可将一张"限定某门店/某品类"的优惠券跨门店/跨品类滥用，造成不应有的折扣资损（如仅限 A 门店护理项目满 500 减 100 券，被用于 B 门店家居商品订单）。
- 复现：1) 创建 `applicable_store_ids=['store-A']` 的现金券 2) admin 开 store-B 门店订单，传入该 couponId 3) 校验通过，discount 正常扣除 4) 实际超出适用范围
- 修复：L7 admin actions — `orders.ts:884` 的 select 中补取两字段，校验逻辑对齐 staff/client：
  ```typescript
  // SELECT 补取
  applicableStoreIds: couponTemplates.applicableStoreIds,
  applicableCategoryIds: couponTemplates.applicableCategoryIds,
  // 校验
  if (coupon.applicableStoreIds?.length) {
    if (!data.storeId || !coupon.applicableStoreIds.includes(data.storeId))
      return { success: false, message: '该优惠券不适用于此门店' }
  }
  // 品类校验需按 SKU → category_id 过滤 eligibleItems，逻辑对齐 staff order.js:347-365
  ```

---

**[P0-13-03] `issueCoupon` / `batchIssueCoupons` 发放量上限 TOCTOU 竞态**

- 文件：`fengyu-admin/src/actions/coupons.ts:527-535`（issueCoupon），`652-664`（batchIssueCoupons）
- 现象：发放量上限校验（COUNT → 比较 totalCount）与后续 INSERT 不在同一事务内。并发多请求可能均通过校验后超量插入。
- 风险：实际发放量超过模板设定的 `totalCount`。
- 复现：并发两个 `issueCoupon` 请求（totalCount=1，已发放=0）→ 两者均在 INSERT 前读到 count=0，均判断未超限，各自 INSERT，最终发放 2 张。
- 修复：L7 admin actions — 将 COUNT 校验与 INSERT 置入同一事务，使用 `SELECT FOR UPDATE` 锁模板行。

---

### 3.2 P1

---

**[P1-13-01] 优惠券过期自动置换机制：懒清扫仅在 available/list 调用时触发，无定时任务**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:51-55`，`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:21-25, 136-140`
- 现象：过期券 status 置换采用"懒清扫"模式：仅在 `available` 和 `list` 接口调用时顺带 UPDATE。`fengyu-admin/src/cron/run.ts` 的 5 个 STEP 中没有 `user_coupons` 过期清扫步骤。
- 风险：顾客长期不打开小程序时，券 status 长期虚报 `'未使用'`，统计数据虚高。
- 修复：L3 cron — 在 `fengyu-admin/src/cron/` 新增 STEP 或在既有 STEP 追加批量清扫。

---

**[P1-13-02] admin `getAvailableCoupons` 的 `minSpend` 校验口径与 staff/client 不一致**

- 文件：`fengyu-admin/src/actions/coupons.ts:170`，对比 `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:107-113`
- 现象：
  - staff/client `coupon.available`：`minSpend` 门槛基于"符合 `applicable_category_ids` 筛选后的 eligibleItems 小计"
  - admin `getAvailableCoupons`：用 `total`（全单小计）直接与 `COALESCE(minSpend, 0)` 比较，未区分品类过滤
- 风险：admin 开单界面展示的"可用券"列表包含实际不满足门槛的券，UI 提示不准确。

---

**[P1-13-03] admin `createOrder` 的 `minSpend` 基数是折扣前 saleAmount，staff 用折扣后 received**

- 文件：`fengyu-admin/src/actions/orders.ts:877-909` vs `fengyu-staff/cloudfunctions/staffApi/routes/order.js:368-373`
- 现象：
  - admin：`saleAmountTotal = Σ(item.saleAmount)` = 行级折扣前金额
  - staff：`eligibleTotalRaw = Σ(item.received)` = 行级折扣后实付金额
- 风险：SKU 有行级折扣时两端满减判定可能不同，导致 admin 开单允许/拒绝与 staff 不一致。

---

**[P1-13-04] `issueCoupon` / `batchIssueCoupons` 日志含完整手机号（PII）**

- 文件：`fengyu-admin/src/actions/coupons.ts:573-578`，`717-720`
- 现象：`logOperation` 中 `detail.customerPhone: phone`（完整手机号）和 `detail.phones: uniquePhones`（完整手机号数组）写入 `operation_logs.detail` JSONB。
- 风险：operation_logs 导出/备份时完整手机号随日志外泄。
- 修复：脱敏处理：`phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')`

---

**[P1-13-05] staff `order.create` 未使用 `COALESCE(face_value_override, discount_value)`**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:323-326`
- 现象：staff `order.create` 的优惠券查询只取 `ct.discount_value`，未用 COALESCE 优先 `face_value_override`；而 staff `coupon.available`（`routes/coupon.js:63`）和 client `order.create`（`clientApi/routes/order.js:282`）均正确使用了 COALESCE。
- 风险：分享礼等动态面值场景（`face_value_override != NULL`），staff 开单折扣计算错误（资损）。
- 复现：1) 发券时设 `face_value_override=80`（模板 discount_value=50） 2) staff 开单选该券 3) couponDiscount 计算基于 50 而非 80
- 修复：L3 staffApi routes — `order.js:325` 改为 `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value`

---

**[P1-13-06] `batchIssueCoupons` 批量 INSERT 不在事务内（部分失败无回滚）**

- 文件：`fengyu-admin/src/actions/coupons.ts:714`
- 现象：`await db.insert(userCoupons).values(values)` 直接 INSERT 200 行，未包裹事务。若某行违反 PK 约束（couponId 碰撞），驱动层可能只 INSERT 前 N 行即抛错，造成部分成功部分失败。
- 风险：审计日志记录"发放成功 N 张"，但实际数据库只有部分插入。
- 修复：包裹在 `db.transaction()` 中，保障全有全无语义。

---

### 3.3 P2

---

**[P2-13-01] staff/client `coupon.available` 不过滤 `applicable_market_ids`**

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/coupon.js:88-93`，`fengyu-client/cloudfunctions/clientApi/routes/coupon.js:176-178`
- 现象：staff 和 client 的 `coupon.available` 只检查 `applicable_store_ids`，不检查 `applicable_market_ids`。admin `getAvailableCoupons`（`coupons.ts:129-148`）有市场级过滤。
- 风险：市场级别限制的券在员工/顾客端"可用列表"中出现，但 `order.create` 不校验市场，实际可被跨市场使用（轻微资损）。

---

**[P2-13-02] 退款归还券时有 `expire_at > NOW()` 条件，已过期券退款后不归还**

- 文件：`fengyu-admin/src/lib/refund-cascade.ts:128-131`，`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`
- 现象：两端 cascadeRefund 通道3 均有 `AND expire_at > NOW()` 条件。若退款时券已过期，券停留在 `status='已使用'`。
- 建议：产品层面确认：是否应去掉 expire_at 条件，让退款时始终归还（即使过期），供顾客知情（券显示为过期无法再用）。

---

**[P2-13-03] `getIssuedCoupons` 无分页，`.limit(500)` 硬上限**

- 文件：`fengyu-admin/src/actions/coupons.ts:604`
- 现象：大批量发放的模板超出 500 条时，admin 界面截断。
- 修复：增加分页支持。

---

**[P2-13-04] `applicable_product_ids` 字段在 schema 中存在但三端均未使用（死字段）**

- 文件：`db/schema/coupon.ts:24`
- 现象：`coupon_templates.applicable_product_ids` 定义为 `text('applicable_product_ids').array()`，但 staff/client 的 available 和 order.create 均只查 `applicable_category_ids`，`applicable_product_ids` 从未出现在查询逻辑中。
- 风险：误导开发者认为 product_id 级别的过滤有业务效果；admin create 页面也未提供 productId 选择。
- 修复：确认无业务使用后，通过 migration DROP 该列，或补充 product_id 级别过滤逻辑。

---

**[P2-13-05] admin `createTemplate` 的 `templateId` 由前端生成，无服务端唯一性保障**

- 文件：`fengyu-admin/src/app/(main)/coupons/_components/coupon-create-page.tsx:90`
- 现象：`templateId = tpl-${Date.now()}`，由前端生成，后端仅靠 PK 碰撞（23505）来拦截重复提交。
- 修复：服务端生成 templateId（`crypto.randomUUID()` 或 ULID）。

---

**[P2-13-06] 测试覆盖空白：admin `createOrder` 优惠券范围校验无 unit test**

- 文件：`fengyu-admin/src/actions/orders.test.ts`
- 现象：P0-13-02 的跨店/跨品类滥用场景在测试中未覆盖，漏洞因此存在且未被发现。
- 修复：补充跨店/跨品类使用券被拒绝的 unit test。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| 门店范围校验（createOrder） | ❌ 缺失 | ✅ applicable_store_ids | ✅ applicable_store_ids | 跨店滥用资损 | **P0** |
| 品类范围校验（createOrder） | ❌ 缺失 | ✅ applicable_category_ids | ✅ applicable_category_ids | 跨品类滥用资损 | **P0** |
| 关闭订单释放券 | ❌ closeOrder 缺失 | ✅ order.close | ✅ order.cancel | 顾客丢券 | **P0** |
| `face_value_override` 优先（createOrder） | ✅（前端通过 getAvailableCoupons 已拿到 override 值） | ❌ 仅 ct.discount_value | ✅ COALESCE | 动态面值不生效 | **P1** |
| minSpend 基数 | 折扣前 saleAmount | 折扣后 received | 折扣后 saleAmount | 满减判定不一致 | P1 |
| applicable_market_ids 过滤（available） | ✅ getAvailableCoupons 有 | ❌ staff 缺失 | ❌ client 缺失 | 推荐列表不准 | P2 |
| 过期懒清扫触发 | 无（cron 不含此步骤） | ✅ available 触发 | ✅ available/list 触发 | 统计虚高 | P1 |
| 批量发放事务 | ❌ batchIssueCoupons 无事务 | N/A | N/A | 部分失败不回滚 | P1 |

---

## 5. 横切检查

- [x] **CC1 数值精度**：`discount_value / min_spend / max_discount` 均为 `NUMERIC(10,2)`。三端折扣计算均用 `Math.round(...*100)/100` 归一化，尾差修正逻辑（最后一项补差）在 staff 和 client 中一致。admin `calcCouponDiscount` 返回 `number` 后 `toFixed(2)` 写 DB，精度可控。OK。
- [ ] **CC2 并发幂等**：CAS UPDATE（WHERE status='未使用'）三端均有，防重用有效。发放量上限 TOCTOU 见 P0-13-03。
- [ ] **CC3 组织隔离**：admin `createOrder` 缺 storeId 范围校验（P0-13-02）；staff/client 通过 userId 绑定券，隔离正确。
- [x] **CC4 后端鉴权**：`issueCoupon`→`coupon:create`；`createTemplate`→`coupon:create`；`updateTemplate`→`coupon:update`；staff `coupon.available`→`requireStaffBound()`；client `coupon.list/available`→`requirePhone()`。链路完整。
- [ ] **CC5 错误前缀**：staff `order.js:334` `'INVALID_PARAMS: 优惠券已失效'` 格式正确。`coupon.js` 抛错格式规范。admin Server Action 返回 `{ success: false, message }` 不需前缀，合规。
- [ ] **CC6 PII**：`issueCoupon` 日志含完整手机号；`batchIssueCoupons` 日志含手机号数组（P1-13-04）。
- [x] **CC7 时间字段**：`usedAt` 三端 claim 时写 `NOW()` / `new Date()`。`expireAt` 由发放时 `validityMode` 计算。`createdAt / updatedAt` Drizzle defaultNow / $onUpdate 管理。时区风险继承 CC7 横切报告。
- [x] **CC8 WXML/Vant**：client `my-coupons.wxml` 三 tab（未使用/已使用/已过期）与 DB 枚举对齐；有空态（van-empty）、加载态（van-skeleton）、错误态。staff `order-create.wxml` 优惠券 popup 有 loading/empty 两态。Vant 属性名（`bind:change`）正确。
- [ ] **CC9 测试与残留**：`applicable_product_ids` 死字段（P2-13-04）；admin createOrder 优惠券范围校验无测试覆盖（P2-13-06）。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L7 admin actions | `fengyu-admin/src/actions/orders.ts:611-635` | `closeOrder` 事务内追加 UPDATE user_coupons 归还券 | P0-13-01 |
| L7 admin actions | `fengyu-admin/src/actions/orders.ts:884-909` | SELECT 补取 applicableStoreIds/applicableCategoryIds，校验对齐 staff/client | P0-13-02 |
| L7 admin actions | `fengyu-admin/src/actions/coupons.ts:527-536, 652-665` | issueCoupon/batchIssueCoupons 发放量校验与 INSERT 置同一事务 | P0-13-03 |
| L3 staffApi routes | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:325` | `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value` | P1-13-05 |
| L7 admin actions | `fengyu-admin/src/actions/coupons.ts:573-578, 717-720` | 手机号脱敏后写日志 | P1-13-04 |
| L7 admin actions | `fengyu-admin/src/actions/coupons.ts:714` | batchIssueCoupons INSERT 包裹事务 | P1-13-06 |
| L3 cron | `fengyu-admin/src/cron/run.ts` | 新增批量清扫 user_coupons 过期 step | P1-13-01 |
| L7 admin actions | `fengyu-admin/src/actions/orders.ts:877-909` | minSpend 基数统一为行级折扣后 received | P1-13-03 |
| L3 staffApi/clientApi | `staffApi/routes/coupon.js`，`clientApi/routes/coupon.js` | 补 applicable_market_ids 市场过滤 | P2-13-01 |
| L9/L7 admin | `coupon-create-page.tsx:90`，`coupons.ts` | templateId 改为服务端 crypto.randomUUID() | P2-13-05 |
| L10 测试 | `fengyu-admin/src/actions/orders.test.ts` | 补充跨店/跨品类被拒 unit test | P2-13-06 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 验证 admin closeOrder 后是否有泄露的"已使用"券（关单但券未归还）
SELECT uc.coupon_id, uc.status, so.status AS order_status, so.sale_order_id
FROM user_coupons uc
JOIN sale_orders so ON so.sale_order_id = uc.used_sale_order_id
WHERE uc.status = '已使用'
  AND so.status = '已关闭';

-- 验证跨门店滥用优惠券
SELECT uc.coupon_id, ct.applicable_store_ids, so.store_id, so.sale_order_id
FROM user_coupons uc
JOIN coupon_templates ct ON uc.template_id = ct.template_id
JOIN sale_orders so ON so.coupon_id = uc.coupon_id
WHERE ct.applicable_store_ids IS NOT NULL
  AND array_length(ct.applicable_store_ids, 1) > 0
  AND NOT (so.store_id = ANY(ct.applicable_store_ids));

-- 验证超量发放
SELECT ct.template_id, ct.name, ct.total_count,
       COUNT(uc.coupon_id) AS issued_count
FROM coupon_templates ct
JOIN user_coupons uc ON uc.template_id = ct.template_id
WHERE ct.total_count IS NOT NULL
GROUP BY ct.template_id, ct.name, ct.total_count
HAVING COUNT(uc.coupon_id) > ct.total_count;

-- 验证过期券 status 仍是 '未使用' 的规模
SELECT COUNT(*) AS stale_count
FROM user_coupons
WHERE status = '未使用' AND expire_at < NOW();

-- 验证 applicable_product_ids 死字段是否有历史数据
SELECT COUNT(*) AS with_product_ids
FROM coupon_templates
WHERE applicable_product_ids IS NOT NULL
  AND array_length(applicable_product_ids, 1) > 0;
```

---

## 8. 回归测试用例（建议）

1. **admin closeOrder 释放券**：开单选券 → admin 关闭 → 查 user_coupons.status = '未使用'
2. **admin 跨门店券被拒**：创建 applicable_store_ids=['store-A'] 券 → admin 开 store-B 订单 → 应返回失败
3. **admin 跨品类券被拒**：创建 applicable_category_ids=['cat-护理'] 券 → admin 开含家居商品订单 → 应返回失败
4. **并发 claim 幂等**：两请求并发提交同 couponId → 仅一个成功（CAS 保障）
5. **face_value_override（staff）**：face_value_override=80 的券（模板 discount_value=50）→ staff order.create → couponDiscount 应为 80
6. **发放量上限并发**：并发两请求 issueCoupon（totalCount=1，已发=0）→ 仅一个成功
7. **过期券退款不归还**：用券 → 退款审批时券已过期 → 确认业务决策（当前不归还）
8. **懒清扫**：`coupon.available` 调用 → 过期未使用券 status 自动变 '已过期'

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（P0-13-01：已关单订单下的"已使用"券需运行补数据 SQL 修复）
- 修复成本：M（P0-13-01/02 约 3-4 小时；P0-13-03 约 1 小时；P1-13-05 约 30 分钟）

---

## 10. 后续待办

- [ ] **[紧急]** P0-13-01：修复 admin `closeOrder` 漏还券；执行补数据 SQL 修复历史已关单下的泄露券（参考验证 SQL 第一条）
- [ ] **[紧急]** P0-13-02：admin `createOrder` 补 storeId + categoryIds 校验，对齐 staff/client
- [ ] **[紧急]** P0-13-03：`issueCoupon / batchIssueCoupons` 发放量校验改为事务内操作
- [ ] P1-13-05：staff `order.create` 优惠券查询加 COALESCE(face_value_override, discount_value)
- [ ] P1-13-04：`issueCoupon / batchIssueCoupons` 日志手机号脱敏
- [ ] P1-13-06：`batchIssueCoupons` INSERT 包裹事务，保障全有全无
- [ ] P1-13-01：评估 cron-worker 是否新增定时过期清扫 STEP
- [ ] P1-13-03：确认 minSpend 基数口径，三端统一（折扣前/折扣后）
- [ ] P2-13-01：staff/client `coupon.available` 补 applicable_market_ids 市场过滤
- [ ] P2-13-04：确认 `applicable_product_ids` 是否死字段，若无用通过 migration DROP
- [ ] P2-13-05：templateId 改为服务端生成
- [ ] P2-13-06：补充 orders.test.ts 中优惠券范围校验 unit test
- [ ] 与退款域（域 11）对齐：退款归还已过期券的业务决策是否要修改
