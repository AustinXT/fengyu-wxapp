# 审计报告：顾客 + 会员等级 (10)

**审计时间**：2026-04-25
**域 ID**：10
**审计员**：claude-opus-4-7
**审计时长**：约 25 分钟
**关联 PR/Ticket**：—

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/user.ts:12-87` | ↑ | ↑ |
| Action/Route | `fengyu-admin/src/actions/customers.ts` | `fengyu-staff/cloudfunctions/staffApi/routes/customer.js` + `routes/mgmt-customer.js` | `fengyu-client/cloudfunctions/clientApi/routes/auth.js` |
| 前端 | `(main)/customers/page.tsx`, `[id]/_components/customer-detail-page.tsx` | `pages/customer/*` | `pages/profile/*` |
| Cron | `src/cron/steps/refresh-member-levels.ts` + `refresh-customer-status.ts` + `grant-birthday-benefits.ts` | — | — |
| 写跃迁 | `src/actions/customers.ts:395-473 updateCustomer` | `routes/order.js:73-156 recalcCustomerType` + `:40-63 refreshSpendingTier` | `cloudfunctions/payNotify/index.js:358-463` |
| 测试 | `src/actions/customers.test.ts`（537 用例之一）| `customer.test.js`（部分覆盖）| — |

## 2. 数据流图

```
身份创建：
  client.login (clientApi/auth.js:15-72)        → INSERT openid-only 行（phone NULL，bound_store_id NULL）
  WorkFine sync (db/scripts/sync-workfine.js)   → UPSERT phone-matched 行（openid 可为 NULL）
  admin.createCustomer (actions/customers.ts:475)→ INSERT phone+name 行（前端校验 + scope）
  client.bindPhone (clientApi/auth.js:81-167)   → UPDATE phone（首绑守卫，已绑则拒绝换绑）
  client.bindStore (clientApi/auth.js:201-290)  → UPDATE bound_store_id + 可选 customer_source/promoter/inviter

身份判定：
  "可开单"客户 = bound_store_id IS NOT NULL（不要求 openid，老顾客可无）
  staff.search 同店内：phone 精确 / 关键字（仅本店）/ 默认本店
  staff.detail：完全无 bound_store_id 或 scope 校验（任意 customer_id/phone/userId 全局可读）
  mgmt-customer.detail：assertCustomerInScope 校验（D-cross-scope-customer，正例参考）

跃迁链路（5 个写入点，运行时分散）:
  staff.order.create COMMIT (routes/order.js:483-503)
    └─→ refreshSpendingTier + recalcCustomerType（事务内同步执行）
  staff.order.confirmOffline (类似)
  client.order COMMIT
  payNotify.handleSuccess (payNotify/index.js:358-463)
    └─→ 与 order.js 完全重复的 SQL（spending_tier + customer_type）
  cron-worker STEP 2 (refresh-member-levels.ts) — 仅 member_level，不动 customer_type / spending_tier

cron-worker STEP 1 (refresh-customer-status) → customer_status（仅会员客有值）
cron-worker STEP 2 (refresh-member-levels)   → member_level（按 12 月 paid_amount 阈值，150 天保级期）
cron-worker STEP 3 (grant-birthday-benefits) → 生日权益
监控 STEP：积分余额审计 / role_type 空值审计

monthly_activity：schema docstring 声明"每日凌晨3点根据当月已完成服务单计算"
                  → 实际无任何 STEP 写入（admin filter 永远命中 NULL，列已死）
```

## 3. 自身漏洞

### 3.1 P0（阻断/资损/越权）

- **[P0-10-01]** staff `customer.detail` 任何已绑店员工可读取全局任意顾客档案
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:242-342`
  - 现象：仅 `requireStaffBound()`，按 `id`（customer_id）/ `clientUserId` / `phone` 三种入口查找，**无 `bound_store_id` ∈ scope 校验、无 `requireManager`**。返回字段含 `name` / `gender` / `skinType` / `notes` / `boundStoreName` / `lastServiceDate` / `totalConsumption` / `yearConsumption`，店长/普通员工通过其他门店顾客手机号即可拉到完整档案 + 消费总额。
  - 风险：组织域数据隔离崩溃（real.md #6）；与 `mgmt-customer.detail` 的 `assertCustomerInScope`（routes/mgmt-customer.js:222-244）形成两端写法分裂 — 一端管理层走严防、一端门店级走"任意可读"。
  - 复现：1) 员工 A 绑店 X；2) 拿到顾客 B（绑店 Y）的手机号；3) 调 `staffApi.customer.detail` 传 `phone`；4) 后端无 scope 检查，直接返回 B 完整档案。
  - 修复：(L3) `customer.detail` 在返回前补 `await assertCustomerInScope(pgUser.bound_store_id, ctx.auth.scopeStoreIds)`；管理层模式（loginLevel='management'）按 scope_store_ids 校验；门店模式校验 `bound_store_id === effectiveStoreId`。

- **[P0-10-02]** staff `customer.calendar / giftHistory / refundHistory` 完全无 store/scope 过滤
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:146-237`、`:675-741`、`:748-834`
  - 现象：三个函数仅按 `client_user_id` 或 `client_phone` 过滤 `sale_orders`，**不带 `o.store_id` 任何过滤**。任一员工只要拿到顾客身份，即可读到顾客全国所有门店的消费日历 / 赠送记录 / 退款记录。
  - 与同模块 `paidOrders`（行 425-433）"强制 `o.store_id = $effectiveStoreId`" 形成同模块内的双轨实现。
  - 风险：跨店财务数据泄露；店长可看到对手门店与同一顾客的交易历史。
  - 修复：(L3) 三个函数统一引入与 `paidOrders` 同款 store_id 过滤，并补管理层模式 `store_id = ANY($scopeStoreIds)`。

- **[P0-10-03]** staff `customer.updateNotes` 无 scope 校验、无角色校验
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:839-858`
  - 现象：仅 `requireStaffBound()`，UPDATE `WHERE user_id = $1`，任意员工可改任意顾客（含其他门店）备注。combined with P0-10-01 可读 → 可改。
  - 风险：组织域数据隔离崩溃 + 管理审计混乱（无 operation_logs 写入）。
  - 修复：(L3) 加 `requireManager()` 或至少加 `bound_store_id = $effectiveStoreId` 过滤；同时补 `logOperation('customer.updateNotes', ...)`。

- **[P0-10-04]** staff `customer.assign` 跨店分配漏洞 + 不写审计日志
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:892-920`
  - 现象：`requireManager()` 但 UPDATE `WHERE user_id = $2` **不校验顾客 `bound_store_id` 是否在当前店长管辖范围内**。多店店长在 store A 模式下可以把 store B 的顾客分配给 store A 美容师；员工校验 `store_id = $effectiveStoreId` 不阻止"把其他店顾客拉过来"。
  - 同时无 `logOperation` 写入，分配变更不可追溯（v3.3 后审计要求）。
  - 修复：(L3) UPDATE 多加 `AND bound_store_id = $3`（$3 = effectiveStoreId）；rowCount=0 时返回 PERMISSION_DENIED；并写 `customer.assign` 操作日志。

- **[P0-10-05]** monthly_activity 列声明"每日凌晨3点更新"但无任何写入实现
  - 文件：`db/schema/user.ts:57`（声明）、`fengyu-admin/src/cron/run.ts:28-34`（STEPS 数组）
  - 现象：schema docstring `monthly_activity: ... 每日凌晨3点根据当月已完成服务单计算`，但 cron 6 个 STEP（customerStatus / memberLevels / birthday / thanksgiving / pointsAudit / roleTypeNullsAudit）**没有任何一个写 monthly_activity 列**。`fengyu-admin/src/actions/customers.ts:195-197` 的 `monthlyActivity` 筛选 + 页面 filter 永远命中 NULL（`customers.test.ts:541` 测试也只断言"调用 eq"，不验证业务正确性）。
  - 风险：列实际是 NULL-only，admin 列表筛选完全失效；运营按 monthlyActivity 做营销分群将获得空集，业务决策被误导。
  - 修复：(L4-cron) 新增 `src/cron/steps/refresh-monthly-activity.ts`：基于 `service_orders.status='已完成'` + 当月范围统计每用户的服务次数 → 写枚举 `二次客活/一次客活/0次客活`；或 (L0-schema) DROP 列并删 admin filter / E10 枚举。

- **[P0-10-06]** member_level 重算口径与 spending_tier 不一致
  - 文件：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:66-73` vs `fengyu-staff/cloudfunctions/staffApi/routes/order.js:40-63`
  - 现象：
    - member_level 用 `SUM(paid_amount::numeric)`（仅实付，剔除储值卡抵扣 + 退款）+ `paid_at >= NOW() - INTERVAL '12 months'` 滚动窗口
    - spending_tier 用 `SUM(total_amount)`（含储值卡抵扣，**不剔除退款 ref_sale_order_id**）+ 累计无窗口
  - 同一顾客同一时间，可出现 spending_tier='1-3W'（按 total_amount 累计 12000）但 member_level=null（按 paid_amount 12 月滚动 0），admin 顾客详情页两栏数字不一致。
  - 风险：消费档位口径分裂，前端展示矛盾；运营对"会员客 vs 1-3W 档"的混合筛选逻辑无效；real.md 隐含的"价格快照不可变"语义被破坏（退款不该影响累计消费档）。
  - 修复：(L4-cron) 统一两处口径决策；建议 spending_tier 也改为 paid_amount-based 12 月滚动，并由 cron 重算（不再放在 order.create 事务内）。

### 3.2 P1

- **[P1-10-07]** staff customer.search/listByTag 直接拼 effectiveStoreId 不兼容管理层模式
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:50-63`、`:572-668`
  - 现象：search 关键字 / 默认分支用 `c.bound_store_id = $effectiveStoreId`；listByTag 用 `WHERE c.bound_store_id = $1`（`storeId = ctx.auth.effectiveStoreId`）。多店店长以 `loginLevel='management'` 登录时 `effectiveStoreId=null`，整个 search/listByTag 在管理层模式下空集（与 audit-05/06/07 同源 CC3 命中模式）。
  - 修复：(L3) 引入 `buildStoreScopeCondition(ctx.auth, 'c.bound_store_id', $n)`，门店模式单值、管理层模式 ANY(scopeStoreIds)。

- **[P1-10-08]** customer_type 跃迁 SQL 在 staff/order.js 与 payNotify 100% 重复
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:73-156` vs `fengyu-client/cloudfunctions/payNotify/index.js:358-463`
  - 现象：约 90 行 SQL 完全 copy/paste（含小美客 / 体验客判定的 EXISTS 子查询）。任一处口径变更（如新增"VIP 客"），必须双改且严格保持一致；现已经至少触发 2 次 P0 修复链。
  - 风险：维护成本高 + 跨端漂移可能性。
  - 修复：(L0/L4) 抽 `db/scripts/recalc-customer-classification.sql` 作为单一权威源；或在 cron 加 STEP `refresh-customer-type` 每日批量重算（取代 inline trigger），inline 逻辑转 best-effort 提前命中。

- **[P1-10-09]** client `bindStore.inviterUserId` 校验仅限前缀，可越权写邀请关系
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:260-278`
  - 现象：仅 `inviterUserId.startsWith('FYGK-')` + 不等于自己，再 `EXISTS` 兜底。攻击者可枚举其他真实 userId 写到自己的 `inviter_user_id` 字段，获取被邀请人福利（参考 audit 域 19 share-gift 链路）。同模块 `try/catch` 又把异常吞掉（行 275-277）。
  - 风险：分享礼资损（领取到非真实邀请关系产生的福利）。
  - 修复：(L3) 引入"邀请码"机制（短期签名 token），不直接信任前端传入的 userId；或加 `inviter_user_id != $1` + 校验 `inviter` 自身 `bound_store_id IS NOT NULL`（已是有效顾客）。

- **[P1-10-10]** admin `updateCustomer` 修改 phone 不调用换绑合并逻辑
  - 文件：`fengyu-admin/src/actions/customers.ts:395-473`
  - 现象：admin 改 phone 只做 23505 唯一冲突兜底 + 写 phone 变更日志（`getCustomerPhoneChangeLogs` 行 564-653），但不像 P0/P1 客户端换绑（已下线）那样合并历史订单 / 历史档案。如果改成的目标手机号在 client_wechat_users 已存在孤儿行（openid IS NULL），不会触发合并；admin 须手动调用 `mergeClientProfile`（行 723-859）。
  - 风险：admin 改 phone 后历史 sale_orders / coupons / card_transactions 仍属于旧 user_id；下次该顾客微信端登录时按 openid 找到老行，phone 不再匹配老 sale_orders → 顾客看不到历史订单。
  - 修复：(L7) 在 `updateCustomer` 检测 phone 变化 → 自动联动 `mergeClientProfile` 检测目标孤儿；或显式 UI 提示 admin "该手机号已有孤儿档案，是否合并"。

- **[P1-10-11]** customer.search 关键字 LIKE 未转义 `%` `_`
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:50`
  - 现象：`WHERE (c.phone LIKE $1 OR c.name LIKE $1)` 直接 `%${keyword.trim()}%` 拼参数；keyword 含 `%` 时被解释为 SQL 通配符，搜索 "李%" 实际匹配所有以 "李" 开头的姓名，可能在前端展示意外结果（非 SQL 注入，但行为偏差）。
  - 修复：(L3) 转义 `%` 和 `_` 为 `\%` / `\_`，或改用 `position($1 IN c.name) > 0`。同样问题也存在于 admin `searchCustomers`（actions/customers.ts:97）。

- **[P1-10-12]** member_level 升级权益事务内 LATEST staff/payNotify recalcCustomerType 没有耦合
  - 文件：`fengyu-admin/src/cron/steps/refresh-member-levels.ts:124-165` vs `fengyu-staff/cloudfunctions/staffApi/routes/order.js:73-156`
  - 现象：staff/payNotify 在 order create / confirmOffline / payNotify 时同步算 customer_type，但**不算 member_level**（注释说"由 cronTask 每日重算"）。这意味顾客刚下单升级到"会员客"后 24 小时内，member_level 仍是 null（或老等级），即时看到"已是会员"但等级没变；下单后立即想看"金钻"权益的客户体验断裂。
  - 修复：(L4) cron STEP 2 之外，在 order.create / payNotify 同步触发 `determineMemberLevel` lite 版（仅当 customer_type 跃迁为'会员客'或已是'会员客' 时）。

- **[P1-10-13]** mgmt-customer.giftHistory `WHERE ... AND FALSE -- TODO` 永远返回空 promoOrders
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:716-727`、`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:761-772`
  - 现象：promoOrders SQL 写死 `AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记`，永远返回空数组；前端预期"组合套餐订单"展示功能未实现。
  - 修复：(L0) 在 `sale_orders` 加 `is_bundle_order` 列 / 改读 `sale_items.is_bundle_sku` 聚合；或删除 promoOrders 字段。

- **[P1-10-14]** spendingTier 阈值"1990-1W"枚举值含写死配置
  - 文件：`db/schema/enums.ts:112` + `fengyu-staff/cloudfunctions/staffApi/routes/order.js:50` + `fengyu-client/cloudfunctions/payNotify/index.js:369`
  - 现象：枚举字符串含具体阈值"1990-1W"作为 bucket id，但实际下界是 `getMemberThreshold()` 读 `system_configs.new_member_threshold`（默认 1980 而非 1990）。当配置改为 2000 时，标签 `1990-1W` 文本与实际边界产生漂移。
  - 修复：(L0) 枚举改为语义化 bucket（`tier-1` / `tier-2`...）+ admin 展示时 join 配置；或 lock 阈值不动配置。

### 3.3 P2

- **[P2-10-15]** customer.detail 用 sale_orders.customer_name 回填 name 跨店泄露 + 有 race
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:292-301`
  - 现象：`name` 缺失时用 `SELECT customer_name FROM sale_orders WHERE client_phone = $1 ORDER BY created_at DESC` 兜底，**不限店、不限 client_user_id**。一是上面 P0-10-01 的二次泄露面（即使补 scope 主查询，回填也再次跨店读）；二是回填值随最近订单变化，detail 接口幂等性弱。
  - 修复：(L3) 回填 SQL 加 `AND store_id IN (scopeStoreIds)` + ORDER BY paid_at DESC NULLS LAST。

- **[P2-10-16]** customerSource 枚举 10 值含具象渠道，新渠道扩展需 migration
  - 文件：`db/schema/enums.ts:95-106`（10 值）
  - 现象：当前 10 值含"美团/抖音/小程序/推带新/地推卡/拓客卡/老带新/转让店/自进店/内部员工或家属"。"小红书/视频号"等新渠道接入需要 schema migration。
  - 修复：(L0) 改为软枚举（`varchar` + 后台 system_config 维护下拉值）；或保留 hard enum + 显式扩展约定。

- **[P2-10-17]** 错误前缀 `INVALID_PARAMS:` 包含业务错误（"顾客不存在"）
  - 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:286, 853` 等
  - 现象：`throw new Error('INVALID_PARAMS: 顾客不存在')` 用 `INVALID_PARAMS` 表示"未找到资源"；语义应为 `NOT_FOUND` 或 `RESOURCE_NOT_FOUND`，但项目错误前缀约定仅 4 项。前端按前缀映射 toast 文案会落入"参数错误"分支，UI 文案与实际不符。
  - 修复：(L3) 在 §3 §4 错误前缀约定中增补 `NOT_FOUND:`（或保持 4 项但区分业务消息后缀）。

- **[P2-10-18]** test customers.test.ts:541 仅断言"调用 eq"不验证 monthlyActivity 真有数据
  - 文件：`fengyu-admin/src/actions/customers.test.ts:536-541`
  - 现象：`it('monthlyActivity 筛选 → eq 被调用')` 测试用例只断言 `eq` 被调用，没有断言"过滤后能返回正确数据"，配合 P0-10-05 monthly_activity 列从未被写入 → 测试形式上通过实际功能空。
  - 修复：(L9) 增加 E2E 用例：起 cron worker → 验证 monthly_activity 列被填 → admin filter 命中。

- **[P2-10-19]** memberLevelLockedUntil 保级期注释与 schema 一致但缺前端展示
  - 文件：`db/schema/user.ts:38` schema 字段、`fengyu-admin/src/actions/customers.ts:48`（serializeCustomer 已暴露） + admin 详情页 `customer-detail-page.tsx`（未读取该字段）
  - 现象：admin 详情页未展示"保级到 X 日"信息，店长无法判断会员是否在保级窗内、何时降级。
  - 修复：(L9) 详情页加"保级到期"展示；或扩 staff customer.detail 返回该字段。

- **[P2-10-20]** customer-source 写入路径分裂：bindStore vs admin updateCustomer
  - 文件：`fengyu-client/cloudfunctions/clientApi/routes/auth.js:241-244`（首次 bindStore）+ `fengyu-admin/src/actions/customers.ts:404`（admin 修改）
  - 现象：customer_source 仅在首次 bindStore 写入，后续不可由顾客自己改；admin 可改但无 UI 默认提示"此字段是历史快照"。运营有"渠道补打"需求时不易判断。
  - 修复：(L9) 文档/UI 补充字段语义说明。

## 4. 跨端不一致

| 维度 | admin | staff (customer.js) | mgmt-customer.js | client | 风险 | 优先级 |
|------|-------|--------------------|------------------|--------|------|--------|
| scope 校验 | scopeCondition + isAdminScope（行 442-449） | 部分函数无 scope（calendar/giftHistory/refundHistory/detail/updateNotes） | assertCustomerInScope 严格 | bindPhone 用 phone 唯一 | 跨店泄露 P0 | P0 |
| phone 脱敏规则 | 不脱敏（admin 全量） | manager 不脱敏，员工脱敏 | management 不脱敏，其他兜底脱敏 | 仅返回自己 phone | 三端策略不统一 | P1 |
| customer_type 跃迁 | updateCustomer 不触发 recalc | order.create / confirmOffline 内联触发 | — | payNotify 内联触发 | 客户端线下确认 / admin 改单不补算 | P1 |
| member_level 重算口径 | cron paid_amount 12 月 | spending_tier 用 total_amount 累计 | — | 同 staff | 双 metric 漂移 | P0-10-06 |
| monthly_activity 写入 | filter 但永读 NULL | 无写入 | 无写入 | 无写入 | 列实际死 | P0-10-05 |
| name 回填来源 | 不回填（数据库即真值） | sale_orders.customer_name 跨店回填 | sale_orders.customer_name 但限 scope（行 466-471） | 无 | 一致性差 | P2 |
| 备注更新审计 | logUpdate（diff 详情） | 无 logOperation | — | — | 审计断裂 | P0-10-03 |
| 邀请关系建立 | — | — | — | bindStore 仅前缀校验 | 越权设邀请人 | P1-10-09 |
| 错误码 | throw Error 中文（无前缀） | `INVALID_PARAMS:` / `PHONE_REQUIRED:` / `UNAUTHORIZED:` | 同 staff | 同 staff | 与 audit-01/02/03 CC5 同模式 | P2 |

## 5. 横切检查（仅记录有问题的项）

- [ ] **CC1 数值精度**：member_level 阈值 100000/60000/30000/10000/1980 用 JS Number 比较，由于 PG numeric 转字符串再 `Number()`，单笔金额超 `2^53` 安全范围才有问题，业务量级安全；但 spending_tier `total >= $2` 阈值参数 PG 内比较 OK。✓
- [ ] **CC2 并发幂等**：member_level cron STEP 升级走 `db.transaction` + `idempotency_key='member-upgrade-${userId}-${toLevel}'` 保护；但 staff order.create 内联 `recalcCustomerType`（routes/order.js:73-156）在 PG 事务内 SELECT-then-UPDATE，**没有 advisory lock**：并发两笔订单同时 commit 可同时把同一 customer 类型推进，rowCount=1 互斥但 became_member_at 写入分两个 UPDATE（行 134-147 的主 UPDATE + 行 152-153 的额外 UPDATE）。理论可重复写 became_member_at（弱影响，仅审计字段）。**P2**
- [x] **CC3 组织隔离**：P0-10-01/02/03/04，外加 P1-10-07，本域是 audit-05/06/07 之后又一次 staff scope 全覆盖问题大集合。
- [ ] **CC4 后端鉴权**：staff updateNotes / customer.detail 仅 requireStaffBound 不限 scope；client bindStore 信任前端 inviterUserId — 已在 P0/P1 列出
- [ ] **CC5 错误码**：`INVALID_PARAMS: 顾客不存在` 不属于 4 约定语义之一（P2-10-17）
- [x] **CC6 PII**：staff 端 manager 看明文（line 71、327、659），mgmt 管理层看明文（行 313、500），admin 全明文。**身份证字段（id_card）schema 标注 AES-256-GCM 加密，但 client_wechat_users 表无此字段**——只有 staff_wechat_users 有 idCard；本域不命中。phone 明文记入 operation_logs.detail 的风险与 audit-01 P0-PII-06 同源。
- [ ] **CC7 时间字段**：member_level_upgraded_at / became_member_at / member_level_locked_until 全部 `NOW()` PG 时区写入；spending_tier UPDATE 用 NOW(); cron `paid_at >= (NOW() - INTERVAL '12 months')` 用 PG 时区。一致 ✓
- [ ] **CC8 WXML/Vant**：本域不直接涉及；admin 详情页 customer-detail-page.tsx 845 行未审到具体组件 — 略。
- [ ] **CC9 测试与残留**：customers.test.ts:541 monthlyActivity 用例形式通过，掩盖 P0-10-05 列死问题（CC9 命中"测试锁死错误行为"反模式，与 audit-08 同源）。`organic catalog mock`（routes/customer.js 中 share/gift `AND FALSE -- TODO`）属迁移残留。

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema | `db/schema/enums.ts:114 monthlyActivityEnum` | 决策保留还是 DROP；保留则建迁移补 cron STEP；DROP 则清 admin filter | P0-10-05 |
| L0 schema | `db/schema/enums.ts:112 spendingTierEnum` | 改语义化 bucket id（tier-1..tier-6）解耦阈值漂移 | P1-10-14 |
| L0 schema | `db/schema/user.ts:55 spendingTier` 计算口径决策 | 与 member_level 统一为 paid_amount-based 12 月滚动 | P0-10-06 |
| L4 cron | `src/cron/steps/refresh-monthly-activity.ts` 新建 | 写 monthly_activity 列 | P0-10-05 |
| L4 cron | `src/cron/steps/refresh-customer-type.ts` 新建 + run.ts 注册 | 替代 staff/payNotify 内联重算 | P1-10-08 |
| L4 cron | `refresh-member-levels.ts` 与 spending_tier 口径对齐 | 改 paid_amount 或在 spending_tier 用 paid_amount | P0-10-06 |
| L3 staff | `routes/customer.js:18-141 search` | 引入 buildStoreScopeCondition 兼容管理层 | P1-10-07 |
| L3 staff | `routes/customer.js:242-342 detail` | 加 `assertCustomerInScope` | P0-10-01 |
| L3 staff | `routes/customer.js:146-237 calendar`、`:675-741 refundHistory`、`:748-834 giftHistory` | 加 `o.store_id ∈ scope` 过滤 | P0-10-02 |
| L3 staff | `routes/customer.js:839-858 updateNotes` | 加 scope + `requireManager` + logOperation | P0-10-03 |
| L3 staff | `routes/customer.js:892-920 assign` | 加 `bound_store_id = $effectiveStoreId` 守卫 + logOperation | P0-10-04 |
| L3 staff | `routes/customer.js:50-50 listByTag` LIKE | %/_ 转义 | P1-10-11 |
| L3 client | `routes/auth.js:260-278 bindStore inviter` | 引入邀请码 token 机制 | P1-10-09 |
| L3 client/staff/admin | 抽 `db/helpers/customer-classification.sql` 单源 | customer_type 三处 SQL 收敛 | P1-10-08 |
| L7 admin | `actions/customers.ts:395 updateCustomer` | phone 变化时联动 mergeClientProfile | P1-10-10 |
| L9 admin UI | `(main)/customers/[id]/_components/customer-detail-page.tsx` | 展示 memberLevelLockedUntil | P2-10-19 |
| L9 doc | spec | customer_source 字段语义说明 | P2-10-20 |

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- (1) 验证 P0-10-05 monthly_activity 列实际命中率
SELECT monthly_activity, COUNT(*)::int AS cnt
FROM client_wechat_users
GROUP BY monthly_activity
ORDER BY monthly_activity NULLS FIRST;
-- 预期：所有非 NULL 行计数为 0（cron 从未写入）

-- (2) 验证 P0-10-06 member_level 与 spending_tier 口径漂移
SELECT
  spending_tier,
  member_level,
  COUNT(*)::int AS cnt
FROM client_wechat_users
WHERE customer_type = '会员客'
GROUP BY spending_tier, member_level
ORDER BY spending_tier, member_level;
-- 预期：会员客理论上 spending_tier 与 member_level 对齐，漂移行展示口径分裂

-- (3) 验证 P0-10-04 assign 跨店分配漏洞 — 找出 bound_employee 与 bound_store 不在同一店的行
SELECT c.user_id, c.bound_store_id AS customer_store, s.store_id AS employee_store
FROM client_wechat_users c
JOIN staff_wechat_users s ON s.employee_id = c.bound_employee_id
WHERE c.bound_store_id IS NOT NULL
  AND s.store_id IS NOT NULL
  AND c.bound_store_id <> s.store_id;
-- 预期：返回 0 行；非 0 即历史 assign 越权写入证据

-- (4) 验证 P1-10-09 inviter 越权写入 — 邀请人自身未绑店
SELECT a.user_id, a.inviter_user_id, b.bound_store_id AS inviter_bound_store
FROM client_wechat_users a
JOIN client_wechat_users b ON b.user_id = a.inviter_user_id
WHERE a.inviter_user_id IS NOT NULL
  AND b.bound_store_id IS NULL;
-- 预期：返回 0 行；非 0 即邀请人是孤儿/未绑店行（可疑）

-- (5) 验证 P1-10-12 即时升级：刚被推进到"会员客"但 member_level 仍 NULL 的窗口
SELECT user_id, customer_type, member_level, became_member_at, member_level_upgraded_at
FROM client_wechat_users
WHERE customer_type = '会员客'
  AND member_level IS NULL
  AND became_member_at IS NOT NULL
  AND became_member_at > NOW() - INTERVAL '24 hours';
-- 预期：返回行表示当日有顾客已是会员但等级未刷新

-- (6) 验证 P0-10-01 跨店读取 — 详情入口模拟（仅 SELECT 不动数据）
EXPLAIN
SELECT c.user_id, c.phone, c.name, c.bound_store_id
FROM client_wechat_users c
WHERE c.phone = '13800000000';
-- 预期：seq scan + index scan on uq_client_users_phone，单行命中无 store 过滤

-- (7) 验证 phone 唯一索引存在性（v3.1 合并键）
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'client_wechat_users';
-- 预期：包含 uq_client_users_phone / uq_client_users_openid / uq_client_users_customer_id 三个 partial unique
```

## 8. 回归测试用例（建议）

1. **跨店读拒绝**：员工 A 绑店 X，调 `customer.detail` 传任意店 Y 顾客 phone → 预期 403（修复 P0-10-01 后）
2. **管理层 search 命中**：多店店长 `_loginLevel='management'` 调 `customer.search` 默认 → 预期返回 scope 内所有顾客（修复 P1-10-07 后）
3. **assign 跨店阻断**：店长以 store A 模式分配 store B 顾客 → 预期 403（修复 P0-10-04 后）
4. **monthly_activity cron 重算**：起 cron once → 预期 client_wechat_users.monthly_activity 列被写入；filter `?activity=二次客活` → 预期非空（修复 P0-10-05 后）
5. **member_level / spending_tier 一致性**：模拟单笔 50000 paid_amount 订单 → 12 月内 → 预期 spending_tier='1-3W' 同时 member_level='星钻'（修复 P0-10-06 后口径对齐）
6. **inviter 越权**：客户端 bindStore 传一个孤儿 userId 作为 inviter → 预期 inviter_user_id 不写入或返回错误（修复 P1-10-09 后）
7. **admin updateCustomer phone 变化触发合并**：admin 改 phone 到一个已存在孤儿手机号 → 预期返回"是否合并"或自动合并（修复 P1-10-10 后）
8. **memberLevelLockedUntil 保级**：cron 重算时 lockedUntil > NOW() 跳过降级 → 预期写 `customer.memberLevelHeld` 操作日志且 member_level 不变

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB + cron-worker）：☑
- 涉及历史数据：☑（spending_tier / customer_type 累计错误需回填修正）
- 修复成本：L（共 6 个 P0、8 个 P1，含 schema 决策 + cron STEP 新增 + 三端 scope 守卫统一 + 邀请码机制重构）

## 10. 后续待办

- [ ] 与 backend.pr.spec 对齐 monthly_activity 决策（保留/废弃）
- [ ] 发起 spec 变更：将 customer_type 重算移交 cron，inline 触发改 best-effort
- [ ] 写补丁迁移：uq_customer_phone（已有 partial unique，无须修复）
- [ ] 联动 audit-01（认证）+ audit-02（开单）+ audit-19（客户分配）做 scope 守卫总扫
- [ ] 给 cron-worker 补 STEP `refresh-monthly-activity` + `refresh-customer-type`，纳入 7 STEP 串行
- [ ] 把"会员等级显示与即时升级落差"作为 UX P1 ticket 单独跟进（P1-10-12）
- [ ] 评估 mgmt-customer.giftHistory 的 `AND FALSE` TODO 删除路径
