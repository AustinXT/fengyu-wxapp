# 审计报告：顾客 + 会员等级 (10) — v3 合并版

**审计时间**：2026-04-26
**域 ID**：10
**审计员**：claude-sonnet-4-6
**审计时长**：v1 约 25 分钟（claude-opus-4-7，2026-04-25）+ v2 约 40 分钟（claude-sonnet-4-6，2026-04-26）→ 合并约 20 分钟
**审计版本**：v3（合并 v1 + v2，结论以 v2 为准）
**关联 PR/Ticket**：—

---

> ### ✅ 2026-05-17 复核状态
>
> | 问题 ID | v3 原状态 | 2026-05-17 复核 |
> |---------|---------|-----------------|
> | **P0-10-01** customer.detail 无 store_id scope | 未修复 | ✅ **已修复** — `routes/customer.js:296-300` 加 `bound_store_id ∈ scopeStoreIds` 守卫 |
> | **P0-10-02** customer.calendar 无 store_id scope | 未修复 | ✅ **已修复** — L185 `buildStoreScopeCondition('o.store_id')` |
> | **P0-10-03** customer.updateNotes 无 WHERE 守卫 + 无 audit | 未修复 | ✅ **已修复** — L932 requireManager + L941 `WHERE ... AND bound_store_id = $3` + L950-955 logOperation |
> | **P0-10-04** customer.assign 无 store_id 守卫 + 无 audit | 未修复 | ✅ **已修复** — L992-1024 requireManager + bound_store_id WHERE + logOperation |
> | refresh-member-levels 性能 N+1 | — | ✅ **已优化**（commit 626d0b4：单 JOIN 重写，1500× 提速，~210s → ~673ms） |
> | 其余 P1/P2 | 未修复 | 未复核 |
>
> 详情见 [SUMMARY v3](SUMMARY.md) 与 ticket `2026-04-27-staff-customer-scope-isolation.md`。

---

## 1. 三端入口对照

| 层 | admin | staff（门店级）| staff（管理层）| client |
|----|-------|----------------|----------------|--------|
| Schema | `db/schema/user.ts:12-87` | ↑ | ↑ | ↑ |
| Action/Route | `src/actions/customers.ts` + `src/actions/orders.ts` + `src/actions/refunds.ts` | `staffApi/routes/customer.js` | `staffApi/routes/mgmt-customer.js` | `clientApi/routes/auth.js` |
| 跃迁触发 | `orders.ts:1935 recalcCustomerType` + `refunds.ts:858 refreshSpendingTierTx` | `routes/order.js:40 refreshSpendingTier` + `:73 recalcCustomerType` | — | `payNotify/index.js:439 + :466` |
| Cron | STEP 2 `refresh-customer-status.ts`；STEP 3 `refresh-member-levels.ts` | — | — | — |
| 手工脚本 | `db/scripts/calc-monthly-activity.js`（未集成 cron）| — | — | — |
| 测试 | `src/actions/customers.test.ts` | `__tests__/routes/customer.test.js` | `__tests__/routes/mgmt-customer.test.js` | — |

---

## 2. 数据流图

```
身份行创建：
  client.login (clientApi/auth.js:36-43)
    → INSERT openid-only 行（phone=NULL, bound_store_id=NULL, customer_type='流量客'）
  WorkFine sync (db/scripts/sync-workfine.js)
    → UPSERT phone-matched 行（openid 可 NULL）
  admin.createCustomer (actions/customers.ts:476+)
    → INSERT phone+name 行（scope 校验）
  client.bindPhone (clientApi/auth.js:81-167)
    → UPDATE phone（首绑守卫：已绑则拒绝；检查 phone 唯一；补全 sale_orders.client_user_id）
    → 注意：未检查 phone 是否已有孤儿行（openid=NULL），不合并，仅写 phone
  client.bindStore (clientApi/auth.js:201-290)
    → UPDATE bound_store_id + 可选 customer_source / promoter_employee_id
    → inviterUserId 前缀 'FYGK-' 校验 + EXISTS 兜底（非幂等安全）

"可开单"判定：bound_store_id IS NOT NULL（不要求 openid）✓ 符合规范

customer_type 跃迁（5 个触发点）：
  ① staff order.create / confirmOffline / createRepayment
     → order.js:40 refreshSpendingTier + :73 recalcCustomerType（事务内）
  ② payNotify.handleSuccess (payNotify/index.js:435-532)
     → spending_tier + customer_type 内联重算（含回款单累计，会员客判定更宽松）
  ③ admin.recordPayment (actions/orders.ts:1935)
     → recalcCustomerType(tx, clientUserId)（不含回款单累计）
  ④ admin.approveRefund (actions/refunds.ts:858)
     → 仅 refreshSpendingTierTx（不触发 customer_type 重算）

spending_tier 三端口径（最复杂跨端一致性问题）：
  ① staff order.create/confirmOffline/payNotify：
     SUM(total_amount) 全量无窗口、所有 status IN ('已支付','已完成')
  ② admin approveRefund (refunds.ts:1242-1248)：
     SUM(GREATEST(received - refunded_amount, 0)) 全量无窗口、仅销售单+转换单
  ③ member_level（cron STEP 3）：
     SUM(GREATEST(received - refunded_amount, 0)) 12月滚动窗口、仅销售单+转换单
  同一顾客的 spending_tier 随触发路径不同可得不同结果（total_amount vs received-refunded）

member_level 重算（cron）：
  仅扫 customer_type='会员客'
  口径：SUM(GREATEST(received - refunded_amount, 0)) 滚动 12 个月 WHERE sale_order_type IN ('销售单','转换单')
  → 升降级 + 权益三件套（消息/积分/优惠券）+ 150天保级期

monthly_activity：
  → 仅 db/scripts/calc-monthly-activity.js（手工脚本，cron run.ts 未注册）
  → schema docstring 声明"每日凌晨3点计算"，实际需手动执行

customer_status（cron STEP 2）：
  仅会员客（customer_type='会员客'）
  5值枚举：保有会员-稳定 / 保有会员-有效 / 沉睡 / 冰冻 / 休眠
```

---

## 3. 自身漏洞

### 3.1 P0（5个：v1 5个中 1个已修复关闭，v2 新增 1个）

---

- **[P0-10-01]** staff `customer.detail` 无 scope 校验：任意绑店员工可读全局任意顾客档案
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:242-342`
  - 现象：函数仅调用 `requireStaffBound()`，按 `id`（customer_id）/ `clientUserId` / `phone` 查找，**整个函数体内无任何 bound_store_id 或 scopeStoreIds 过滤**。返回 `name/gender/skinType/improvementFocus/notes/totalConsumption/yearConsumption` 均为 PII 敏感字段。员工通过任意途径获取他店顾客手机号，即可拉到完整档案。
  - 与 `mgmt-customer.js:222-244 assertCustomerInScope` 形成严重的双轨分裂。
  - 风险：组织域数据隔离崩溃（real.md §6）；PII 大规模泄露。
  - 复现：1) 员工绑店 A；2) 任意途径得知店 B 顾客手机号；3) 调 `customer.detail { phone: "..." }`；4) 无 scope 检查返回完整档案。
  - 修复：(L3) 在 detail 函数主查询后，补 scope 过滤；或合并进 SELECT WHERE 子句。

---

- **[P0-10-02]** staff `customer.calendar` 无 store_id scope 过滤
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:146-237`
  - 现象：两个 SQL（dailySummary + orderRows）**仅按 `client_user_id` 或 `client_phone` 过滤**，无任何门店过滤。员工可读取某顾客在全国任意门店的消费日历，包括竞争对手同品牌店。
  - 对比：同模块 `paidOrders` 函数（line 428-432）已正确强制 `store_id = ctx.auth.effectiveStoreId`。
  - 风险：跨店财务数据泄露；单顾客全国消费轨迹可读。
  - 修复：(L3) 两个 SQL 均追加 `AND o.store_id = $N`（门店模式）或 `AND o.store_id = ANY($N)`（管理层）。

---

- **[P0-10-03]** staff `customer.updateNotes` 无 scope 校验：任意员工可改任意顾客备注
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:914-933`
  - 现象：`UPDATE client_wechat_users SET notes = $1 WHERE user_id = $2`，无 `bound_store_id` 过滤，无 `requireManager`，无 `operation_logs` 写入。任意绑店员工均可修改任意顾客备注，跨店可读→可改。
  - 修复：(L3) 加 `AND bound_store_id = $3`（`effectiveStoreId`）+ `requireManager()` + `logOperation('customer.updateNotes', ...)`。

---

- **[P0-10-04]** staff `customer.assign` 无顾客归属校验：多店店长可跨店分配顾客
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:967-995`
  - 现象：`requireManager()` 校验通过，然后 `UPDATE client_wechat_users SET bound_employee_id = $1 WHERE user_id = $2`，**不验证顾客 `bound_store_id` 是否在当前 `effectiveStoreId` 内**。员工验证（line 975-980: `store_id = $2`）正确，但顾客侧无对应校验。同时无操作日志。
  - 修复：(L3) UPDATE 加 `AND bound_store_id = $3`（`effectiveStoreId`），rowCount=0 返回 PERMISSION_DENIED；并写 `customer.assign` 操作日志。

---

- **[P0-10-v2-05 / 新增]** staff `customer.giftHistory` 无 store_id scope 过滤（giftItems 真实数据泄露）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:823-909`
  - 现象：`giftItems` 查询（line 850-862）**无任何 store_id 过滤**，仅按 `client_user_id` 或 `client_phone` 查询。员工可读取他店顾客的赠送记录。`promoOrders` 因 `AND FALSE` 永远空，但 giftItems 是真实泄露路径。
  - 风险：跨店业务数据泄露（与 P0-10-01 同级越权）。
  - 修复：(L3) `giftItems` SQL 追加 `AND o.store_id IN (scopeStoreIds)` 或门店模式 `AND o.store_id = $effectiveStoreId`。

---

### CLOSED from v1

- **[P0-10-05 - CLOSED from v1]** staff `customer.refundHistory` 无 store_id 过滤 → **已修复**
  - v2 验证：`routes/customer.js:699-704` 已有 `AND o.store_id = $effectiveStoreId` 过滤（store 模式）和 `AND o.store_id = ANY($scopeStoreIds)`（management 模式）。
  - 结论：v1 发现的问题已在 baseline reset 后或后续迭代中修复，标记关闭，无需回退。

---

### 3.2 P1（8个）

---

- **[P1-10-v2-06 / spending_tier 三端漂移，最复杂]** `spending_tier` 与 `member_level` 口径三重分裂
  - 文件：
    - `staffApi/routes/order.js:55-59`（staff/payNotify spending_tier：`SUM(total_amount)`，全量，无退款扣减，无 sale_order_type 限定）
    - `admin/src/actions/refunds.ts:1242-1248`（refund spending_tier：`SUM(GREATEST(received - refunded_amount, 0))`，全量，仅销售单+转换单）
    - `cron/steps/refresh-member-levels.ts:72-77`（member_level：`SUM(GREATEST(received - refunded_amount, 0))`，12月滚动，仅销售单+转换单）
  - 现象：**三种口径并存**，同一顾客的 `spending_tier` 随触发路径不同可得不同结果：
    - staff order.create → `total_amount`（含储值卡抵扣，不扣退款）
    - admin approveRefund → `received - refunded_amount`（扣退款，仅销售单/转换单）
    - cron member_level → `received - refunded_amount`，12月滚动窗口
    - payNotify（会员客判定）→ `total_amount` 含回款单累计（与 staffApi order.js 不一致，见 P1-10-v2-11）
  - 极端场景：顾客先创单 total_amount=12000 → spending_tier='1-3W'；后退款 refunded_amount=5000 → approveRefund 路径 spending_tier 按 received-refunded=7000 重新计算，同一顾客两次触发 spending_tier 结果不同。
  - 风险：消费档位口径分裂，运营数据分析失效；admin 列表同时展示 `spending_tier` 和 `member_level` 两字段时数字含义不一致；`spending_tier` 在 order 触发路径包含退款金额，而 refund 触发路径则扣除。
  - 修复：(L0+L4) 决策统一 spending_tier 口径，建议与 member_level 对齐（`received - refunded_amount`，全量，仅销售单/转换单，无时间窗口）；spending_tier 重算迁移至 cron（取代 order/payNotify 内联触发）；同步 payNotify 与 staffApi 的会员客判定 SQL（含/不含回款单累计需决策统一）。

---

- **[P1-10-v2-07 / monthly_activity]** `monthly_activity` 列依赖手工脚本，cron 未注册
  - 文件：`db/schema/user.ts:57`（docstring："每日凌晨3点根据当月已完成服务单计算"）、`fengyu-admin/src/cron/run.ts:40-53`（8 个 STEP 均无 monthlyActivity）、`db/scripts/calc-monthly-activity.js`（手工脚本，逻辑正确但未集成）
  - 现象：schema docstring 承诺每日凌晨3点自动更新，但 cron run.ts **没有任何 STEP 写 `monthly_activity`**。admin 列表筛选 `monthlyActivity` 时永远命中 NULL（除非手动运行脚本）。`customers.test.ts:536-541` 仅断言 `eq` 被调用，不验证实际命中。
  - 风险：运营按"月度客活"做营销分群将获得空集；schema 承诺与实现不符。
  - 修复：(L4) 将 `calc-monthly-activity.js` 封装为 `cron/steps/refresh-monthly-activity.ts` 并注册到 run.ts（STEP 4，memberLevels 之后）；或 (L0) DROP 列 + 清除 admin filter。

---

- **[P1-10-v2-08]** `customer.search` 管理层模式 keyword/默认分支返回空集
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:50-63`
  - 现象：keyword 分支（line 50）和默认分支（line 60）均用 `c.bound_store_id = $N`（`effectiveStoreId`）。管理层模式（`loginLevel='management'`）时 `effectiveStoreId = null`，`WHERE c.bound_store_id = NULL` 永远空集（SQL NULL 比较不匹配任何行）。phone 精确分支（line 41）用 `c.bound_store_id IS NOT NULL`，在管理层模式下可正常返回——但 phone 分支本身无 scope 限制（见 P1-10-v2-12）。
  - 对比：`mgmt-customer.js` 用 `buildClientScope` 正确处理 all/market/store 三态。
  - 修复：(L3) 引入 `buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', $n)`，统一三种分支；phone 分支补加 scope 限制。

---

- **[P1-10-v2-09 / stats 口径矛盾]** `customer.stats` 用 `customer_id IS NOT NULL` 判定"会员客"，与 `customer_type` 枚举不一致
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:553-558`（stats.memberCount）+ line 27（search customerType filter）
  - 现象：
    - `stats.memberCount = COUNT WHERE customer_id IS NOT NULL`（WorkFine 顾客编号非空）
    - `stats.flowCount = total - memberCount`（无 customer_id 即"流量客"）
    - 但 `customer_type` 枚举有 4 值（流量客/体验客/小美客/会员客），需消费达阈值才为"会员客"
    - `customer_id IS NOT NULL` 仅表示来自 WorkFine 同步，不等同于消费达标
  - 同一"会员客数量"卡片上混用两种口径，会引起数字矛盾；运营据此做决策会被误导。
  - 修复：(L3) `stats.memberCount` 改为 `WHERE customer_type = '会员客'`；`stats.flowCount` 改为 `WHERE customer_type = '流量客'`；`search` 的 member 过滤改为 `customer_type = '会员客'`。

---

- **[P1-10-v2-10]** `admin.approveRefund` 仅更新 spending_tier，缺失 customer_type 重算
  - 文件：`fengyu-admin/src/actions/refunds.ts:858`（仅 `refreshSpendingTierTx`，无 `recalcCustomerType`）
  - 现象：退款审批通过后，spending_tier 重算，但 **customer_type 不重算**。极端情况：顾客原单 total_amount >= threshold → 被判为'会员客'；退款后实际消费 < threshold；customer_type 因"只升不降"规则仍保持'会员客'（这是业务设计决策，但 spending_tier 和 customer_type 两者退款响应不对称，属于实现不完整）。
  - 修复：(L7+决策) 明确 customer_type 退款降级策略；若需降级则在 `approveRefund` 补调 `recalcCustomerType`（需去掉只升不降限制）。

---

- **[P1-10-v2-11 / 会员客判定边界不同]** `payNotify` 会员客分支含回款单累计，与 `staffApi` 同一 SQL 不一致
  - 文件：`fengyu-client/cloudfunctions/payNotify/index.js:470-484` vs `fengyu-staff/cloudfunctions/staffApi/routes/order.js:86-117`
  - 现象：payNotify 会员客 SQL 包含 `OR (o.total_amount + COALESCE(SUM(回款单), 0)) >= $2`（累计回款单金额），staffApi 同一 SQL **直接用 `total_amount >= $2`，不含回款单累计**。测试 `recalc-customer-type-sql.test.js:122-125` 明确断言 payNotify 必须包含 `ref_sale_order_id` 和 `回款单` 关键字（说明这是已知设计差异），但测试未验证是否正确。
  - 风险：payNotify 支付比 staff confirmOffline 支付更早将顾客跃迁为"会员客"；同一顾客相同消费金额，经不同路径可得不同 customer_type。
  - 修复：(L3) 决策是否统一口径；若 payNotify 需要回款单累计，staffApi 也需要；反之亦然。

---

- **[P1-10-v2-12]** `customer.search` phone 分支无 scope 限制（全库精确匹配）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:35-43`
  - 现象：`WHERE c.phone = $1 AND c.bound_store_id IS NOT NULL`，仅过滤已绑店（保证"可开单"），**不过滤 scope（不限门店）**。任意员工精确搜索他店顾客手机号，即可在搜索结果中看到他店顾客（含 `memberLevel/storeName`）。
  - 对比：keyword/默认分支强制 `bound_store_id = effectiveStoreId`，phone 分支遗漏了这一过滤。
  - 修复：(L3) phone 分支追加 `AND c.bound_store_id = $2`（门店模式）或 `IN (scopeStoreIds)`（管理层模式）。

---

### 3.3 P2（7个）

- **[P2-10-13]** `customer.detail` 姓名回填（sale_orders.customer_name）无 scope 过滤
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:293-301`
  - 现象：`SELECT customer_name FROM sale_orders WHERE client_phone = $1 ORDER BY created_at DESC LIMIT 1`，无 `store_id` 过滤。回填结果来自全国最近一笔含该手机号的订单（可能是他店订单）。
  - 修复：(L3) 追加 `AND store_id IN (scopeStoreIds)`。

- **[P2-10-14]** `customer.search` LIKE 未转义 `%` `_`
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:52`（`%${keyword.trim()}%`）；`mgmt-customer.js:286`
  - 现象：keyword 含 `%` 或 `_` 时被解释为 SQL 通配符，搜索 "李%" 实际匹配所有以"李"开头的姓名。非 SQL 注入（已参数化），但行为偏差。
  - 修复：(L3) 转义 `%` 和 `_`；或改用 `position($1 IN c.name) > 0`。

- **[P2-10-15]** `customer.giftHistory` 中 `promoOrders` 的 `AND FALSE` TODO 为迁移残留
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:843-847`；`mgmt-customer.js:722`
  - 现象：写死 `AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记`，两处永远返回空数组。前端预期的"组合套餐订单"功能不可用，等同于 dead code。
  - 修复：(L0) 在 `sale_orders` 或 `sale_items` 补 `is_bundle_*` 标记；或删除 promoOrders 字段。

- **[P2-10-16]** 测试 `customer.test.js` 中 `member_level` 使用字面量 `'VIP'` 而非枚举值
  - 文件：`__tests__/routes/customer.test.js:21,22,41,55,73` 等多处
  - 现象：mock 数据 `member_level: 'VIP'` 而非 `'初钻'/'星钻'/'粉钻'/'金钻'/'黑钻'`（枚举实际值）。测试不能验证枚举约束是否正确映射。
  - 修复：(L9) 将 mock 中 `member_level: 'VIP'` 改为实际枚举值（如 `'金钻'`）。

- **[P2-10-17]** `customer.detail` 缺少 `memberLevelLockedUntil`、`becameMemberAt` 字段返回
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:322-342`
  - 现象：`ctx.result` 只返回 `memberLevel`，未返回 `memberLevelLockedUntil`（保级截止时间）、`becameMemberAt`（成为会员时间）。前端无法展示"保级到 X 日"，店长无法判断会员降级风险。
  - 修复：(L9) 补充查询和返回这两个字段。

- **[P2-10-18]** 错误前缀 `INVALID_PARAMS:` 用于"顾客不存在"（应为 NOT_FOUND）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:286, 929`
  - 现象：`throw new Error('INVALID_PARAMS: 顾客不存在')` 语义应为 NOT_FOUND，但项目错误前缀约定仅 4 项，前端 toast 文案与实际不符。
  - 修复：(L3) 增补 `NOT_FOUND:` 前缀约定。

---

## 4. 跨端不一致

| 维度 | admin | staff/customer.js（门店级）| mgmt-customer.js（管理层）| client | 风险 | 优先级 |
|------|-------|--------------------------|--------------------------|--------|------|--------|
| scope 校验 | `scopeCondition` 正确 | detail/calendar/giftHistory/updateNotes/assign 无 scope | `assertCustomerInScope` 正确 | 仅操作自己 | 跨店 PII 泄露 | P0 |
| "会员客"判定口径 | customer_type='会员客'（枚举）| `customer_id IS NOT NULL`（stats/search，WorkFine编号）| customer_type='会员客' | 不判定 | 统计数字矛盾 | P1 |
| spending_tier 口径 | approveRefund 用 `received-refunded` | order.create 用 `total_amount` | 不触发 | payNotify 用 `total_amount` | **三端各不同，最复杂跨端问题** | P1 |
| customer_type 会员客跃迁 | orders.ts 不含回款单 | order.js 不含回款单 | 不触发 | payNotify 含回款单累计 | 两端跃迁边界不同 | P1 |
| monthly_activity 写入 | admin filter 但列永远 NULL | 无写入 | 无写入 | 无写入 | 筛选功能死列 | P1 |
| refundHistory scope | — | v2 验证已有 storeId 过滤 ✓ | — | — | CLOSED from v1 | — |
| phone 脱敏规则 | admin 全量不脱敏 | manager 不脱敏，员工脱敏 | headquarters/market 不脱敏 | 仅返回自己 phone | 有业务理由但略不统一 | P2 |
| listByTag scope | 不适用 | `effectiveStoreId` 单值（管理层模式空集）| N/A | N/A | 管理层搜索失效 | P1 |

---

## 5. 横切检查（仅记录有问题的项）

- [x] **CC1 数值精度**：spending_tier 和 member_level 阈值比较均在 PG 内部完成（`NUMERIC >= $N`），JS 侧仅做结果使用。业务金额量级不超 JS Number 安全范围。`✓`
- [ ] **CC2 并发幂等**：`staff.order.create` 事务内调用 `recalcCustomerType`（SELECT-then-UPDATE 无行锁）。并发两笔订单同时 commit 时 `became_member_at` 两个独立 UPDATE 有竞态，仅影响审计字段。**P2 影响**。
- [x] **CC3 组织隔离**：customer.detail / calendar / giftHistory / updateNotes / assign 共 5 个函数无 scope 过滤（P0-10-01~04 + P0-10-v2-05）。`customer.search` phone 分支全库精确匹配（P1-10-v2-12）。**P0 多处命中**。
- [x] **CC4 后端鉴权**：`requireStaffBound()` 在所有 customer.js 函数入口均已调用；`requireManager()` 在 assign 调用；`requireManagementLevel()` 在所有 mgmt-customer.js 函数调用。鉴权入口无缺失。`✓`（scope 过滤缺失是另一问题，见 CC3）。
- [ ] **CC5 错误码**：`INVALID_PARAMS: 顾客不存在` 语义应为 NOT_FOUND（P2-10-18）。4 项约定未含 NOT_FOUND。
- [x] **CC6 PII**：phone 明文存在于 detail（manager 模式）和 mgmt（management 不脱敏）；`operation_logs` 无顾客 phone 写入（updateNotes 本身无日志）。id_card 仅在 staff_wechat_users 存在，client 表无此字段。`✓`
- [x] **CC7 时间字段**：`member_level_upgraded_at / became_member_at / member_level_locked_until` 均用 PG `NOW()`；spending_tier UPDATE 用 `NOW()`；cron `paid_at >= (NOW() - INTERVAL '12 months')` 在 PG 内部计算。时区一致。`✓`
- [x] **CC8 WXML/Vant**：本轮未审前端页面代码，略。
- [ ] **CC9 测试与残留**：(a) `customer.test.js` 中 `member_level: 'VIP'` 测试数据与枚举不符（P2-10-16）；(b) `customers.test.ts:536-541` monthlyActivity 用例形式通过但功能死列（P1-10-v2-07）；(c) `promoOrders AND FALSE` 迁移残留（P2-10-15）；(d) v1 P0-10-05 refundHistory 已修复关闭。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/user.ts:57 monthlyActivity` | 决策：集成 cron 还是 DROP；保留则更新 docstring 说明"手工脚本，待集成" | P1-10-v2-07 |
| L0 决策 | spending_tier 口径统一决策 | 统一为 `received - refunded_amount` + 全量 + 仅销售单/转换单（无时间窗口），与 admin refunds.ts 对齐 | P1-10-v2-06 |
| L3 staff | `routes/customer.js:242-342 detail` | 补 scope 过滤：`AND c.bound_store_id IN ($scopeStoreIds)` 或门店模式 `= effectiveStoreId` | P0-10-01 |
| L3 staff | `routes/customer.js:146-237 calendar` | 两个 SQL 追加 `AND o.store_id = $effectiveStoreId`（门店）/ `= ANY($scopeStoreIds)`（管理层） | P0-10-02 |
| L3 staff | `routes/customer.js:914-933 updateNotes` | 加 `AND bound_store_id = $3`（`effectiveStoreId`）+ `requireManager()` + `logOperation` | P0-10-03 |
| L3 staff | `routes/customer.js:967-995 assign` | 追加 `AND bound_store_id = $3`（`effectiveStoreId`）+ `logOperation('customer.assign', ...)` | P0-10-04 |
| L3 staff | `routes/customer.js:850-862 giftHistory.giftItems` | 追加 `AND o.store_id = $effectiveStoreId` | P0-10-v2-05 |
| L3 staff | `routes/customer.js:35-43 search phone branch` | 追加 `AND c.bound_store_id = $2`（门店）/ `IN (scopeStoreIds)`（管理层） | P1-10-v2-12 |
| L3 staff | `routes/customer.js:50-63 search keyword/default` | 引入 `buildStoreScopeCondition` 兼容 `effectiveStoreId=null` 的管理层模式 | P1-10-v2-08 |
| L3 staff | `routes/customer.js:553-558 stats.memberCount` | 改为 `WHERE customer_type = '会员客'`；同步 flowCount | P1-10-v2-09 |
| L3 staff | `routes/customer.js:25-30 search customerType filter` | `member` → `WHERE customer_type = '会员客'`；`flow` → `customer_type = '流量客'` | P1-10-v2-09 |
| L3 staff | `routes/order.js:40-63 refreshSpendingTier` | 口径决策后统一 SQL（`received - refunded_amount`）+ 限定 sale_order_type | P1-10-v2-06 |
| L3 client | `payNotify/index.js:437-455 spending_tier` | 与 order.js 口径对齐（决策后同步修改） | P1-10-v2-06 |
| L3 client | `payNotify/index.js:470-484 会员客分支` | 决策是否与 staffApi 统一"回款单累计"逻辑 | P1-10-v2-11 |
| L4 cron | `src/cron/steps/refresh-monthly-activity.ts` 新建 | 将 `db/scripts/calc-monthly-activity.js` 逻辑迁入；注册到 `run.ts` STEP 4 | P1-10-v2-07 |
| L7 admin | `src/actions/refunds.ts:858` approveRefund | 在 `refreshSpendingTierTx` 之后视决策补调 `recalcCustomerType`（需同步解除 customer_type 只升不降限制） | P1-10-v2-10 |
| L9 测试 | `__tests__/routes/customer.test.js` | 将 `member_level: 'VIP'` 替换为实际枚举值 | P2-10-16 |
| L9 前端 | `routes/customer.js:322-342 detail` | 补充返回 `memberLevelLockedUntil`、`becameMemberAt` | P2-10-17 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 monthly_activity 列实际值分布（预期全 NULL，cron 未注册）
SELECT monthly_activity, COUNT(*)::int AS cnt
FROM client_wechat_users
GROUP BY monthly_activity
ORDER BY monthly_activity NULLS FIRST;

-- (2) 验证 spending_tier 与 member_level 口径漂移（预期会员客中不完全对齐）
SELECT spending_tier, member_level, COUNT(*)::int AS cnt
FROM client_wechat_users
WHERE customer_type = '会员客'
GROUP BY spending_tier, member_level
ORDER BY spending_tier, member_level;

-- (3) 验证 customer_type='会员客' 与 customer_id IS NOT NULL 的口径差（预期数量不同）
SELECT
  SUM(CASE WHEN customer_type = '会员客' THEN 1 ELSE 0 END)::int AS by_type,
  SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END)::int AS by_customer_id,
  SUM(CASE WHEN customer_type = '会员客' AND customer_id IS NULL THEN 1 ELSE 0 END)::int AS type_member_no_id,
  SUM(CASE WHEN customer_type != '会员客' AND customer_id IS NOT NULL THEN 1 ELSE 0 END)::int AS id_not_null_non_member
FROM client_wechat_users
WHERE bound_store_id IS NOT NULL;

-- (4) 验证 spending_tier 口径差异：同一顾客 total_amount vs (received-refunded) 的差值
SELECT u.user_id, u.spending_tier AS current_tier,
       COALESCE(SUM(o.total_amount), 0)::numeric AS total_amt_sum,
       COALESCE(SUM(GREATEST((o.received::numeric) - (o.refunded_amount::numeric), 0)), 0) AS net_received_sum
FROM client_wechat_users u
JOIN sale_orders o ON o.client_user_id = u.user_id
  AND o.status IN ('已支付', '已完成')
  AND o.sale_order_type IN ('销售单', '转换单')
GROUP BY u.user_id, u.spending_tier
HAVING COALESCE(SUM(o.total_amount), 0) <>
       COALESCE(SUM(GREATEST((o.received::numeric) - (o.refunded_amount::numeric), 0)), 0)
LIMIT 20;
-- 预期：有行即 spending_tier 两口径在历史数据上产生了差异

-- (5) 验证 assign 跨店分配漏洞：顾客归属门店与绑定美容师门店不同
SELECT c.user_id, c.bound_store_id AS customer_store, s.store_id AS employee_store
FROM client_wechat_users c
JOIN staff_wechat_users s ON s.employee_id = c.bound_employee_id
WHERE c.bound_store_id IS NOT NULL
  AND s.store_id IS NOT NULL
  AND c.bound_store_id <> s.store_id
LIMIT 20;
-- 预期：返回 0 行；非 0 即历史越权分配证据

-- (6) 验证 member_level 仅扫"会员客"的覆盖完整性：非会员客中 member_level 非 NULL 即脏数据
SELECT customer_type, member_level, COUNT(*)::int AS cnt
FROM client_wechat_users
WHERE customer_type != '会员客' AND member_level IS NOT NULL;

-- (7) 验证 phone UPSERT 幂等：同一 phone 是否有多行
SELECT phone, COUNT(*)::int AS cnt
FROM client_wechat_users
WHERE phone IS NOT NULL
GROUP BY phone HAVING COUNT(*) > 1;
-- 预期 0 行
```

---

## 8. 回归测试用例（建议）

1. **detail 跨店拒绝**：员工 A 绑店 X，调 `customer.detail { phone: 他店顾客 }` → 预期 403 / PERMISSION_DENIED（修复 P0-10-01 后）
2. **calendar 跨店拒绝**：同上，调 `customer.calendar { clientPhone: ... }` → 预期仅返回本店数据（修复 P0-10-02 后）
3. **updateNotes 跨店拒绝**：普通员工调 `customer.updateNotes { clientUserId: 他店顾客 }` → 预期 403（修复 P0-10-03 后）
4. **assign 跨店顾客拒绝**：店长以 Store A 模式分配 Store B 顾客 → rowCount=0 返回 PERMISSION_DENIED（修复 P0-10-04 后）
5. **giftHistory 跨店拒绝**：员工调 `customer.giftHistory { clientUserId: 他店顾客 }` → 预期仅返回本店赠送记录（修复 P0-10-v2-05 后）
6. **search 管理层模式**：多店店长 loginLevel='management' 调 `customer.search { keyword: '张' }` → 预期返回 scope 内所有门店顾客（修复 P1-10-v2-08 后）
7. **stats memberCount 口径**：`customer.stats` 中 memberCount 等于 DB 内 `customer_type='会员客'` 数量（修复 P1-10-v2-09 后）
8. **monthly_activity cron**：运行 `runDailyJobs once` → 预期 `monthly_activity` 列被写入非 NULL 值（修复 P1-10-v2-07 后）
9. **spending_tier 口径一致性**：同一顾客经 order.create 和 approveRefund 后，spending_tier 使用一致口径（修复 P1-10-v2-06 后）
10. **payNotify 会员客分支一致性**：通过 payNotify 支付与通过 staff confirmOffline 支付，同等消费情况下 customer_type 跃迁结果一致（修复 P1-10-v2-11 后）
11. **search phone branch scope**：员工以门店 A 模式精确搜索门店 B 顾客手机号 → 预期无结果（修复 P1-10-v2-12 后）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + cron-worker）：☑
- 涉及历史数据：☑（spending_tier 口径修正后需回填；monthly_activity 历史为 NULL 需重算；assign 越权分配历史记录需清理）
- 修复成本：L（共 5 个 P0 scope 守卫 + 3 个 P1 口径对齐/边界 + 2 个 P1 cron 集成 + 多处小修）

---

## 10. v1 vs v2 差异摘要

| 维度 | v1（claude-opus-4-7，2026-04-25）| v2（claude-sonnet-4-6，2026-04-26）| v3 结论 |
|------|------|------|------|
| P0 总数 | 5 个（detail/calendar+giftHistory+refundHistory/updateNotes/assign）| 5 个（detail/calendar/updateNotes/assign 各自独立；giftHistory 升级为 P0；refundHistory 已修复）| **合并 P0 = 5 个**（giftHistory 来自 v2 新发现）|
| refundHistory scope | P0-10-02（无 scope）| **已修复**（customer.js:699-704 已有 storeId 过滤）| CLOSED from v1 |
| monthly_activity | P0-10-05（列完全无写入）| P1-10-v2-07（脚本存在但未集成 cron，降级）| v2 发现 `calc-monthly-activity.js` 存在，非完全无实现 |
| spending_tier 口径 | P0-10-06（双端漂移：staff vs payNotify）| P1-10-v2-06（升级为**三端漂移**：staff + payNotify + admin refunds.ts）| v2 发现 refunds.ts 用第三种口径，最复杂跨端问题 |
| stats memberCount 口径 | 未发现 | P1-10-v2-09（新发现：`customer_id IS NOT NULL` ≠ `customer_type='会员客'`）| v2 新发现 |
| payNotify 会员客分支差异 | P1-10-08（重复代码问题）| P1-10-v2-11（口径不一致问题，更精准：payNotify 含回款单累计，staffApi 不含）| v2 精准化为独立 P1 |
| search phone 分支 | P1-10-07（管理层空集，一部分）| P1-10-v2-12（phone 无 scope，新发现独立问题）| v2 拆分为两个独立问题 |
| member_level / spending_tier 关系 | P0-10-06（口径不一致，member_level 用 paid_amount，spending_tier 用 total_amount）| P1-10-v2-06（升级为三端漂移：admin refunds.ts 用 received-refunded，staff/payNotify 用 total_amount，cron 用 received-refunded 12月窗口）| v2 补充第三端 |

---

## 11. 后续待办

- [ ] **P0 高优（最高优先级）**：`customer.detail` 补 scope 校验（PII 泄露路径）
- [ ] **P0 高优**：`customer.calendar / updateNotes / assign / giftHistory` 补 scope 校验
- [ ] **P1 决策**：spending_tier 口径统一（与 member_level 对齐为 `received - refunded_amount`，全量，仅销售单/转换单），同步修改 staffApi/payNotify/refunds 三处触发点
- [ ] **P1 决策**：payNotify 会员客分支是否需要回款单累计，与 staffApi 对齐
- [ ] **P1**：将 `calc-monthly-activity.js` 集成为 cron STEP，并更新 schema docstring
- [ ] **P1**：`stats.memberCount` 和 `search.customerType` 改用 `customer_type` 枚举判定，废弃 `customer_id IS NOT NULL` 口径
- [ ] **P1**：`approveRefund` 视决策补 `recalcCustomerType`（需明确 customer_type 退款降级策略）
- [ ] **P2**：`promoOrders AND FALSE` 迁移残留，决定保留（补 is_bundle 标记）还是删除
- [ ] **P2**：customer.test.js 中 member_level mock 值改为枚举真实值
- [ ] **P2**：customer.detail 返回 `memberLevelLockedUntil`、`becameMemberAt`
- [ ] **跨域**：与 audit-01（认证）+ audit-CC3（组织隔离）联动做 scope 守卫总扫
- [ ] **跨域**：与 audit-15（积分/等级跳档）对齐 cron 步骤顺序依赖关系