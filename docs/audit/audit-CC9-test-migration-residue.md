# 审计报告：测试与迁移残留 (CC9-vFinal)

**审计时间**：2026-04-26
**域 ID**：CC9
**审计员**：claude（batch agent）
**版本**：vFinal（v1 + v2 合并版）
**基线 commit**：c8f1c65（当前 HEAD，含 2026-04-26 customer/order 测试扩充）

> v1（2026-04-25）：claude-opus-4-7 横切收官审计，135 测试文件，6P0/6P1/9P2
> v2（2026-04-26）：claude 独立重审，基于实际 grep 证据，2P0 已修，1P2 已修
> **本版**：合并两轮结果，标注所有状态变化，移除冗余，保留完整量化表

---

## 1. 扫描覆盖范围

| 层 | 扫描目标 | 说明 |
|----|----------|------|
| StaffApi 路由 | `fengyu-staff/cloudfunctions/staffApi/routes/*.js`（15 文件） | 所有路由逐一 grep |
| StaffApi 测试 | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/*.js`（16 文件）| 含 SQL 守卫测试 |
| ClientApi 路由 | `fengyu-client/cloudfunctions/clientApi/routes/*.js`（12 文件） | — |
| ClientApi 测试 | `fengyu-client/cloudfunctions/clientApi/__tests__/routes/*.js`（12 文件）| — |
| Admin Actions | `fengyu-admin/src/actions/*.ts`（26 文件）+ `*.test.ts`（22 文件） | — |
| Admin 组件 | `fengyu-admin/src/app/**/*.tsx`（关键组件） | 枚举/字段引用 |
| DB Schema | `db/schema/*.ts`（22 模块）| 权威来源对照 |
| Specs | `.42cog/pm/*.pr.spec.md`（3 文件） | 字段漂移检查 |
| 小程序 mock | `fengyu-staff/miniprogram/mock/` | 废弃枚举残留 |

**全仓测试文件总数：135**
**扫描方法**：每个废弃项独立 grep，不依赖推断，所有命中均附 file:line。

---

## 2. 废弃字段/表/枚举残留检查结果

### 2.1 废弃表名（routes/actions 层）

| 废弃表名 | 扫描命令 | 结果 |
|---------|---------|------|
| `catalog_items` | grep routes/ actions/ | **0 命中** ✓ |
| `material_products` | grep routes/ actions/ | **0 命中** ✓ |
| `promotion_schemes` | grep routes/ actions/ | **0 命中** ✓ |
| `promotion_scheme_items` | grep routes/ actions/ | **0 命中** ✓ |
| `product_spu_sku_map` | grep routes/ actions/ | **0 命中** ✓ |
| `product_spu` | grep `\bproduct_spu\b` routes/ actions/ | **0 命中** ✓ |

结论：废弃表名在业务路由层完全清除。

### 2.2 废弃列名（routes/actions 层）

#### ✓ 已清除项

| 废弃列名 | 结果 |
|---------|------|
| `operator_user_id` | 0 命中 ✓ |
| `sale_order_source` | 0 命中 ✓ |
| `item_flow_no` | 0 命中 ✓ |
| `service_order_no`（旧名） | 0 命中 ✓ |
| `sku_display_name` | 0 命中 ✓ |
| `receivable` | 0 命中 ✓ |
| `order_no`（旧名）| 0 命中 ✓ |
| `staff_wechat_users.user_id`（已废弃 PK） | 0 命中 ✓ |

#### ⚠️ 需要区分的有效列名引用

- **`store_name`**：大量引用，但均属 `stores.store_name`（该列是 stores 表的真实列 `db/schema/org.ts:45`），不是"废弃"。v4.0 重命名是 appointments.store_name → appointments.store_id；stores 表的 store_name 列从未被废弃。
- **`customer_name`**：大量引用，但均属 `sale_orders.customer_name`（该列是真实列 `db/schema/order.ts:59`），不是"废弃"。v4.0 重命名是 appointments.customer_name → appointments.client_name；sale_orders.customer_name 从未被废弃。
- **`user_id`**（client_wechat_users）：大量引用，均属 `client_wechat_users.user_id`（该表 PK 保留 `db/schema/user.ts:16`），完全合法。
- **`preferred_staff_name`**（`staffApi/routes/order.js:1287`、`clientApi/routes/order.js:1061`）：这不是 DB 列引用，是运行时向 order 对象动态追加的 API 响应字段（依据 preferred_employee_id 查 staff_wechat_users.name 返回的展示名），不存在列名废弃问题。

#### ❌ 真实废弃列残留（P0 级）

**`from_store_name`**（`store_unbind_requests` 表已废弃该列，schema 只有 `from_store_id`）：

```
fengyu-client/cloudfunctions/clientApi/routes/store.js:156
  INSERT INTO store_unbind_requests (request_id, user_id, from_store_name, status, note)

fengyu-client/cloudfunctions/clientApi/routes/store.js:175
  SELECT request_id, from_store_name, status, note, created_at

fengyu-client/cloudfunctions/clientApi/routes/store.js:186
  fromStoreName: rows[0].from_store_name,
```

schema 权威源：`db/schema/store-unbind.ts:11` — `fromStoreId: text('from_store_id')`，无 from_store_name 列。

**`service_items.sku_id`**（schema 无此列，但 service.create 仍插入）：

```
fengyu-staff/cloudfunctions/staffApi/routes/service.js:210
  INSERT INTO service_items
    (service_item_id, sale_item_id, unit_real_price, service_order_id,
     sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
```

schema 权威源：`db/schema/service.ts:52-80`——serviceItems 表列：serviceItemId, saleItemId, unitRealPrice, isShengmei, salesCategory, serviceOrderId, sessionUsed, employeeId, serviceDuration, createdAt, updatedAt。无 sku_id 列。

**测试反锁**：`__tests__/routes/service.test.js` 使用 mock 绕过真实 INSERT，无法发现该错误。

### 2.3 废弃枚举值

#### ✓ 已清除项

| 废弃枚举值 | 结果 |
|---------|------|
| `big_category`（改为 `product_kind`）— routes/actions | 0 命中 ✓ |
| `workfine_source`（已废弃）— routes/actions/tests | 0 命中 ✓ |
| `sale_order_source`（已 DROP）| 0 命中 ✓ |
| recalcCustomerType SQL 中 `category_name <> '充值卡'` magic string | **0 命中 ✓（v2 已迁移到 is_experience）** |

#### ⚠️ 非运行时残留（不阻断）

- **`big_category`**：`fengyu-staff/miniprogram/mock/product.ts:4-9` 仍使用 `big_category` 字段，但这是前端 mock 数据，不执行 SQL，不影响运行。
- **`组合套餐`**：
  - `fengyu-staff/miniprogram/pages/order-create/order-create.ts:16-17` — `PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡']`，但代码逻辑中 `组合套餐` 转为 `is_bundle=true` 过滤，不写入 product_kind 列。
  - `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:41-43` — 同上。
  - `fengyu-staff/cloudfunctions/staffApi/routes/product.js:185` — 注释说明，不是 SQL 参数。
  - `fengyu-admin/src/actions/orders.ts:991,1148,1576` — 注释和 comment，不是 SQL 参数。
- **`福利活动`**：
  - `fengyu-admin/src/actions/__tests__/products-getProductsByKind.test.ts:204,207,212,235` — 作为测试的 productKind 文本值，测试"排除法语义"，是合法的新增分类测试场景（不是枚举约束），且 DB 中 product_kind 是 text 列（无枚举约束），此用法正确。
- **`AND FALSE -- TODO: 组合套餐`**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:844` — giftHistory 组合套餐死分支
  - `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:722` — 同上

---

## 3. 测试覆盖现状

### 3.1 staffApi 路由覆盖（16 测试文件 / 15 路由文件）

| 路由文件 | 测试文件 | 已覆盖方法 |
|---------|---------|----------|
| auth.js | auth.test.js | login, bindPhone |
| store.js | store.test.js | list, unbindRequests, approveUnbind, rejectUnbind |
| staff.js | staff.test.js | list, departments, todayCommission, monthlyCalendar, todoList, bindStore, **performanceDetail, dashboard**（v2 已补齐） |
| customer.js | customer.test.js | search, calendar, detail, paidOrders, stats, listByTag, giftHistory, refundHistory, updateNotes, assign |
| mgmt-customer.js | mgmt-customer.test.js | listByTag, detail, paidOrders, stats, search |
| product.js | product.test.js | shopInit, categories, skuList, skuDetail, spuDetail, cardKinds |
| order.js | order.test.js | create, qrcode, confirmOffline, close, resetFailed, list, detail, **approveRefund（v2 重写，含完整事务路径）**, createRefund, rejectRefund, createRepayment, createConversion |
| allocation.js | allocation.test.js | save, deleteAllocation, getCommissionRates, pendingList, suggest |
| appointment.js | appointment.test.js | list, detail, confirm, checkin |
| coupon.js | coupon.test.js | available |
| service.js | service.test.js | create, start, complete, cancel, list, detail |
| mgmt-dashboard.js | mgmt-dashboard.test.js | scopeOptions, summary, storeRanking, staffRanking |
| mgmt-product.js | mgmt-product.test.js | 覆盖 |
| mgmt-traffic.js | mgmt-traffic.test.js | 覆盖 |
| card.js | card.test.js | rechargeSkus, recharge |
| —（SQL 守卫） | recalc-customer-type-sql.test.js | 三端 recalcCustomerType SQL 结构完整性 |

**v2 新增覆盖（相比原始 v1）**：
- `staff.performanceDetail` 和 `staff.dashboard`（v1 P2-CC9-02 标记为空白，**已补齐**）
- `order.approveRefund` 重写（v1 被 describe.skip，**已重写为新模型**）

### 3.2 clientApi 路由覆盖（12 测试文件 / 12 路由文件）

| 路由文件 | 测试文件 |
|---------|---------|
| auth.js | auth.test.js |
| store.js | store.test.js |
| product.js | product.test.js |
| order.js | order.test.js + order.repay.test.js |
| appointment.js | appointment.test.js |
| service.js | service.test.js |
| coupon.js | coupon.test.js |
| points.js | points.test.js |
| message.js | message.test.js |
| card.js | card.test.js |
| staff.js | staff.test.js |
| _constants.js / config.js | — （无业务逻辑） |

客户端路由测试覆盖完整。

### 3.3 admin actions 覆盖（22 测试文件 / 26 action 文件）

**有测试**：allocations, appointments, auth, card-transactions, cards, commission, coupons, customers, dashboard, employees, logs, messages, orders, org, permissions, products, refunds, service-commissions, services, settings, store-unbind, stores

**无测试**（P2 空白）：
- `pickup-records.ts`
- `points.ts`
- `positions.ts`
- `skill-tags.ts`

### 3.4 覆盖空白（新发现）

- `staffApi/routes/customer.js` 的 `customerBalance` 方法无测试（CLAUDE.md 列出但 customer.test.js 无对应用例）
- 小程序 E2E：staff 3 文件 / client 3 文件

---

## 4. 发现的问题（P0/P1/P2 分级）

### P0 级（运行时失败 / 资损）

#### [P0-CC9-01] service.create 写入不存在的 service_items.sku_id 列

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-staff/cloudfunctions/staffApi/routes/service.js:208-211`
  ```sql
  INSERT INTO service_items
    (service_item_id, sale_item_id, unit_real_price, service_order_id,
     sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ```
- schema `db/schema/service.ts:52-80` 中 serviceItems 无 sku_id 列。
- **影响**：service.create 100% 运行时失败（`42703 column "sku_id" does not exist`）。
- **测试反锁**：service.test.js mock 绕过真实 INSERT，测试永不失败。

#### [P0-CC9-03] client store.js 引用不存在的 store_unbind_requests.from_store_name 列

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-client/cloudfunctions/clientApi/routes/store.js:156`（INSERT）
- `fengyu-client/cloudfunctions/clientApi/routes/store.js:175`（SELECT）
- `fengyu-client/cloudfunctions/clientApi/routes/store.js:186`（读取响应）
- schema `db/schema/store-unbind.ts:11` 只有 `from_store_id` 列，无 `from_store_name`。
- **影响**：requestUnbind 和 getUnbindRequest 100% 运行时失败。
- **测试反锁**：`clientApi/__tests__/routes/store.test.js:111` mock 返回 `from_store_name: '凤御A店'` — 假绿。

#### [P0-CC9-06] monthly_activity 列存在但 cron 8 步无写入

**状态**：**OPEN — v1/v2 一致，未修复**

- `db/schema/user.ts` 存在 monthly_activity 列
- `fengyu-admin/src/cron/steps/` 8 个 STEP 文件，grep 无任何一处写入 monthly_activity
- 仅 `db/scripts/calc-monthly-activity.js` 是手动脚本，无调度
- `admin/src/actions/customers.test.ts:541` `expect(eq).toHaveBeenCalledWith('monthly_activity', '二次客活')` 反锁 — 筛选器实际永远空集

### ✅ 已修复 P0（v1→v2，移至修复记录）

#### [P0-CC9-04] admin applyRechargeOnOrderPaid 引用已 DROP 的 prepaid_cards.store_id

**状态**：**RESOLVED（v1→v2 修复）**

- `fengyu-admin/src/actions/orders.ts:96-101` 当前已正确：
  ```sql
  INSERT INTO prepaid_cards (card_id, user_id, balance)
  ON CONFLICT (user_id) DO UPDATE SET balance = ...
  ```
- 无 store_id 列写入，ON CONFLICT 目标正确。
- `orders.test.ts:102` mock 更新为 `{cardId, userId, balance}`，无 storeId。
- 注：createConversionOrder 路径 (`orders.ts:1611-1613`) 同样已修复。

#### [P0-CC9-05] recalcCustomerType SQL 中 '充值卡' magic string

**状态**：**RESOLVED（v1→v2，commit 0707bdc）**

- 三端 SQL 均已迁移至 `si.is_experience = false/true` capability 列。
- `recalc-customer-type-sql.test.js` 完整重写：守卫 is_experience 存在、不含旧 JOIN 链、三端镜像一致。
- 不再有 `category_name <> '充值卡'` 字面量出现。

### P1 级（数据一致 / 死代码 / 维护风险）

#### [P1-CC9-01] spec 仍引用 valid_start/valid_end（schema 已删）

**状态**：**OPEN — v1/v2 一致，未修复**

- `.42cog/pm/backend.pr.spec.md:141-146` — products 字段表仍列 valid_start/valid_end
- `.42cog/pm/admin.pr.spec.md:160,162` — 同上
- `.42cog/design/admin.ui.spec.md:504` — 同上
- `db/schema/product.ts` 实际已替换为 `is_enabled boolean`

#### [P1-CC9-02] 组合套餐 UI 硬编码与 DB is_bundle 双轨

**状态**：**OPEN（部分缓解）**

- `fengyu-staff/miniprogram/pages/order-create/order-create.ts:16` — `PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡']`
- `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:41-43` — 同上
- 代码层面"组合套餐"仍通过硬编码字面量路由，而非 DB 驱动（products.is_bundle=true）

#### [P1-CC9-03] staffApi 部署包仍包含 mssql 依赖

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-staff/cloudfunctions/staffApi/package.json:12` — `"mssql": "^10.0.1"`
- `fengyu-staff/cloudfunctions/staffApi/db/mssql.js` — 存在
- `fengyu-staff/cloudfunctions/staffApi/query_wf_tables.js` — 存在
- `fengyu-staff/cloudfunctions/staffApi/__tests__/setup.js:9,13,20` — mssql mock 存在
- 所有 15 条路由 0 处 `require('./db/mssql')`，deploy 包含冗余 SQL Server 客户端。

#### [P1-CC9-04] share-gift.js 三副本（含 1 dead）

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-staff/cloudfunctions/staffApi/share-gift.js`（live）
- `fengyu-client/cloudfunctions/payNotify/share-gift.js`（live）
- `fengyu-client/cloudfunctions/clientApi/share-gift.js`（**dead**，clientApi 路由从不调用）

#### [P1-CC9-05] giftHistory `AND FALSE -- TODO` 双副本死分支

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:844`
  ```sql
  AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记
  ```
- `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-customer.js:722` — 同上

#### [P1-CC9-06] mgmt-dashboard / staff.js "旧口径（已废弃）" 注释保留

**状态**：**OPEN — v1 一致，未修复**

- `mgmt-dashboard.js:363, 808, 1032`、`staff.js:704` — 注释里详尽描述废弃口径，影响后续 reviewer 误读。无运行时影响。

### P2 级（代码质量 / 可维护性）

#### [P2-CC9-01] admin 4 个 action 文件无测试

**状态**：**OPEN — v1/v2 一致，未修复**

- `fengyu-admin/src/actions/pickup-records.ts` — 0 测试
- `fengyu-admin/src/actions/points.ts` — 0 测试
- `fengyu-admin/src/actions/positions.ts` — 0 测试
- `fengyu-admin/src/actions/skill-tags.ts` — 0 测试

#### [P2-CC9-02] staff.performanceDetail/dashboard 测试

**状态**：**RESOLVED（v1→v2 修复）**

- `staff.test.js:265` `describe('staff.performanceDetail', ...)` ✓
- `staff.test.js:503` `describe('staff.dashboard', ...)` ✓

#### [P2-CC9-03] 三端 dashboard 口径无一致性断言

**状态**：**OPEN — v1/v2 一致，未修复**

#### [P2-CC9-04] product.promotionList/promotionPlans 死路由

**状态**：**OPEN — v1/v2 一致，未修复**

- `staffApi/routes/product.js:482-491` — 永远返回 `{ schemes: [] }` / `[]`
- `staffApi/index.js:54-55` — 路由注册仍存在

#### [P2-CC9-05] admin/staff CARD_PRODUCT_KINDS 双轨常量

**状态**：**部分缓解**

- `fengyu-admin/src/lib/product-kind.ts:24` — `CARD_PRODUCT_KINDS = ['充值卡', '体验卡']`，注释说明"仅供 fallback / 测试 fixture"，capability 列判定已优先使用。
- `fengyu-staff/miniprogram/pages/order-create/order-create.ts:28` — `CARD_PRODUCT_KINDS = ['充值卡', '体验卡']`（fallback 兜底）

#### [P2-CC9-06] display_icon 小程序端无渲染消费

**状态**：**部分修复**

- admin 端：`fengyu-admin/src/app/(main)/products/categories/_components/product-kind-management-dialog.tsx:83,99,292,293` — 已有 read/write UI
- staff / client miniprogram：grep 0 命中，displayIcon 无 wxml 渲染

#### [P2-CC9-07] allocation.js departmentName deprecated 字段

**状态**：**OPEN — v1/v2 一致，未修复**

- `staffApi/routes/allocation.js:462` — `departmentName: null, // deprecated (PR-4)`

#### [P2-CC9-08] sync-products-from-workfine.js 无废弃 banner

**状态**：**OPEN — v1/v2 一致，未修复**

#### [P2-CC9-09] 小程序 E2E 极少

**状态**：**OPEN — v1/v2 一致，未修复**

#### [P2-CC9-10] valid_start/valid_end spec drift（新归类至 P2）

**状态**：**OPEN**，同 P1-CC9-01，spec 层未更新。

#### [P2-CC9-11] staffApi `customer.customerBalance` 方法无测试

**状态**：**OPEN（v2 新发现）**

- `staffApi/routes/customer.js` 有 customerBalance 方法（CLAUDE.md 列出），customer.test.js 无对应用例。

---

## 5. 跨端不一致

| 维度 | admin | staff | client | 风险 | 优先级 |
|------|-------|-------|--------|------|--------|
| share-gift.js 副本 | — | 1 live | 2（1 live + 1 dead） | 维护漂移 | P1-CC9-04 |
| recalcCustomerType SQL | — | routes/order.js | payNotify/index.js | 镜像 / 测试已守卫 ✓ | OK |
| product_kind 字面量 | order-create-page.tsx 4 值硬编码 | order-create.ts 4 值硬编码 | — | DB 4 值 + UI 双轨 | P1-CC9-02 |
| `from_store_name` 引用 | JOIN alias（OK） | JOIN alias（OK） | INSERT/SELECT 直引（FAIL） | client 100% 失效 | P0-CC9-03 |
| valid_start/valid_end | spec 仍提 / 代码已删 | spec 仍提 / 代码已删 | spec 仍提 / 代码已删 | 新人按 spec 写错 | P1-CC9-01 |
| dashboard 业绩口径 | 3 套实现各自跑 | 3 套实现各自跑 | — | 测试无一致性断言 | P2-CC9-03 |
| monthlyActivity 写入 | cron 0 STEP 写 | — | — | 测试反锁 + 列死 | P0-CC9-06 |

---

## 6. 修复建议

### 优先级 P0（本周必修）

| 问题 | 文件 | 修复动作 |
|------|------|---------|
| P0-CC9-01 service_items.sku_id | `staffApi/routes/service.js:208-224` | 从 INSERT 列表和 VALUES 中删除 sku_id；删 siRows 中 `sku_id` 字段；修 test mock |
| P0-CC9-03 from_store_name | `clientApi/routes/store.js:156,175,186` | INSERT 改 from_store_id；SELECT 改 from_store_id；响应字段改 fromStoreId；同步修 store.test.js:111 mock |

### 优先级 P0（尽快修）

| 问题 | 文件 | 修复动作 |
|------|------|---------|
| P0-CC9-06 monthly_activity | `fengyu-admin/src/cron/steps/` | 新增 `recalc-monthly-activity.ts` STEP（移植 db/scripts/calc-monthly-activity.js 逻辑）；修 customers.test.ts:541 |

### 优先级 P1（2 周内）

| 问题 | 文件 | 修复动作 |
|------|------|---------|
| P1-CC9-01 spec drift | `.42cog/pm/{backend,admin}.pr.spec.md`, `admin.ui.spec.md` | 全量替换 valid_start/valid_end → is_enabled 说明 |
| P1-CC9-02 组合套餐硬编码 | `order-create.ts:16`, `order-create-page.tsx:41` | 改读 `product.cardKinds` + is_bundle 接口动态取列表 |
| P1-CC9-03 mssql 残留 | `package.json`, `db/mssql.js`, `query_wf_tables.js`, `setup.js` | 删除 mssql 依赖 + 文件 + mock |
| P1-CC9-04 share-gift dead 副本 | `clientApi/share-gift.js` | 删除 dead 副本 + 对应 test |
| P1-CC9-05 AND FALSE 死分支 | `customer.js:844`, `mgmt-customer.js:722` | 改为按 `sale_orders.is_bundle=true` 或 `sale_items.is_bundle` 过滤 |

### 优先级 P2（1 月内）

| 问题 | 文件 | 修复动作 |
|------|------|---------|
| P2-CC9-01 admin 4 无测试 actions | `pickup-records/points/positions/skill-tags.ts` | 各补 happy path + 边界用例 |
| P2-CC9-03 dashboard 一致性 | 新文件 `dashboard.consistency.test.ts` | 同一 fixture 跑三套接口，断言核心指标相等 |
| P2-CC9-04 dead routes | `product.js:482-491`, `index.js:54-55` | 删除 promotionList/promotionPlans 路由 + 注册 |
| P2-CC9-07 departmentName | `allocation.js:462` | 删除 `departmentName: null` 字段 |
| P2-CC9-08 sync 脚本 | `db/scripts/sync-products-from-workfine.js` | 加废弃 banner `process.exit(1)` 或移入 `_archive/` |
| P2-CC9-09 E2E | staff/client e2e/ | 至少补 staff order.create + client order.pay |
| P2-CC9-11 customer.customerBalance 无测 | `__tests__/routes/customer.test.js` | 补 customerBalance happy path |

---

## 7. 量化总表

| 类别 | P0 | P1 | P2 | 说明 |
|------|----|----|----|----|
| (A) 已删字段/表/枚举残留 | 2 | 2 | 2 | sku_id/from_store_name(P0); spec drift/mssql(P1); dead promotions/departmentName(P2) |
| (B) 测试反向锁死 | 2 | 1 | — | service rate=0/from_store_name mock(P0); monthlyActivity filter(P1) |
| (C) 关键路径无测试 | 0 | 0 | 5 | admin 4 actions/dashboard一致性/E2E/customerBalance |
| (D) 死代码/死分支 | 0 | 2 | 3 | share-gift dead/AND FALSE(P1); promotionRoutes/syncScript/E2E(P2) |
| **总计** | **4** | **5** | **10** | — |

### 版本对比

| 指标 | v1 | v2 | vFinal |
|------|----|----|--------|
| P0 总数 | 6 | 4（-2） | **4** |
| P1 总数 | 6 | 5（-1） | **5** |
| P2 总数 | 9 | 9 | **10**（+1 customerBalance） |
| 已修复 P0 | — | 2 | **2（prepaid_cards.store_id, 充值卡 magic string）** |
| 已修复 P2 | — | 1 | **1（staff 绩效路由测试覆盖）** |

---

## 8. 回归验证建议

1. **P0-CC9-01**：staff service.create 跑 staging 实库 → 确认 INSERT 无 `42703 column "sku_id" does not exist`
2. **P0-CC9-03**：client requestUnbind 跑 staging 实库 → 确认成功 INSERT + getUnbindRequest 成功 SELECT
3. **P0-CC9-06**：cron monthly_activity STEP 执行 → admin 顾客"本月活跃"过滤器命中 ≥1 行
4. **P0-CC9-04 回归**：admin confirmOfflinePayment 充值卡订单 → prepaid_cards 成功 UPSERT（验证修复不回退）
5. **P0-CC9-05 回归**：recalc-customer-type-sql.test.js 全绿（确认 is_experience 守卫持续有效）

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB + 测试 + spec）**：☑
- 涉及历史数据：☑（monthly_activity 列回填 + prepaid_cards 充值订单的兼容性）
- 修复成本：**M**（3 个 OPEN P0 是局部代码修改 + 测试同步；2 个已修 P0 回归；5 个 P1 是 spec 同步 + 死代码清理；10 个 P2 是新增测试）
- 关键依赖：CC9 与 CC1/CC2/CC3/CC4 的修复一一对应（同一 P0 在不同视角被多次确认）

---

## 10. 后续待办

- [ ] **优先级 1**（P0，本周必修）：service.create sku_id / requestUnbind from_store_name 两个 100% 生产失效路径修复 + 同步修对应测试 mock
- [ ] **优先级 2**（P0，本周尽快）：cron 加 monthly_activity STEP
- [ ] **优先级 3**（P1，2 周内）：spec 三件套同步 valid_start → is_enabled；productKind 升级为 PG enum + 前端硬编码改读 API
- [ ] **优先级 4**（P1，2 周内）：share-gift.js 三副本治理；customer.giftHistory `AND FALSE` 死分支重写
- [ ] **优先级 5**（P2，1 月内）：admin 4 个 0 测试 actions 补齐；staff.js 绩效路由补测（已修）；dashboard 三端口径一致性测试
- [ ] **优先级 6**（P2，1 月内）：清理 staffApi 中 mssql 依赖 + db/scripts 废弃同步脚本归档；E2E 补 6 大资损链路；补 customerBalance 测试
- [ ] 与 audit-CC2/CC3/CC4 修复 PR 合并：很多 P0 对应同源（如 P0-CC9-03 = audit-12 P0）

---

## 附：验证 SQL（目标 5434/fengyu）

```sql
-- 验证 service_items 表无 sku_id 列（佐证 P0-CC9-01）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'service_items' ORDER BY ordinal_position;

-- 验证 store_unbind_requests 表无 from_store_name 列（佐证 P0-CC9-03）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'store_unbind_requests' ORDER BY ordinal_position;

-- 验证 prepaid_cards 表无 store_id 列 + UNIQUE 仅 (user_id)（佐证 P0-CC9-04 已修）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'prepaid_cards' ORDER BY ordinal_position;
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'prepaid_cards';

-- 验证 monthly_activity 列存在但全部 NULL（佐证 P0-CC9-06）
SELECT monthly_activity, COUNT(*) FROM client_wechat_users GROUP BY monthly_activity;

-- 验证三端 recalcCustomerType SQL 均使用 is_experience（佐证 P0-CC9-05 已修）
-- staff: fengyu-staff/cloudfunctions/staffApi/routes/order.js
-- client: fengyu-client/cloudfunctions/clientApi/routes/order.js
-- payNotify: fengyu-client/cloudfunctions/payNotify/index.js
-- grep 'is_experience' 各文件中均存在，category_name='充值卡' 均不存在
```
