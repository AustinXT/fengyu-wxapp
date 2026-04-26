# 审计报告：CC9 测试覆盖与迁移残留 (CC9)

**审计时间**：2026-04-25
**域 ID**：CC9（横切收官审计 / 9 个横切检查域之最后一个）
**审计员**：claude-opus-4-7
**审计时长**：~15 分钟
**关联 PR/Ticket**：—

> 横切归集型审计：不审业务，只回收 §3 CC9 的三类专项 —— **(A) 已废弃字段/表/枚举的代码残留**，**(B) 测试反向锁死错误代码 / magic string**，**(C) 关键路径无测试的覆盖空白**。已在 audit-01 ~ audit-25 中散落命中，本报告做最终量化与归集。

---

## 1. 三端入口对照（横切域无单一入口，列出聚合扫描面）

| 层 | 范围 | 实际命中 |
|----|------|----------|
| Schema 权威 | `db/schema/*.ts`（22 模块）+ `enums.ts`（28 枚举） | 28 枚举 / 缺 `productKindEnum` 仍是 `text` |
| 已归档 schema | `db/migrations/_archive_pre_baseline_2026_04/` | 仅供 grep 黑名单 |
| Admin actions | `fengyu-admin/src/actions/*.ts`（28 文件） | 22 测试 / 缺 4 测试（pickup/points/positions/skill-tags） |
| Admin cron | `fengyu-admin/src/cron/steps/*` | 7/7 全覆盖 ✓ |
| StaffApi routes | `fengyu-staff/cloudfunctions/staffApi/routes/*.js`（15 文件） | 16 路由测试全覆盖（含 1 SQL 守卫） |
| ClientApi routes | `fengyu-client/cloudfunctions/clientApi/routes/*.js` | 8 路由测试 + 3 顶层（index/share-gift/smoke）|
| payNotify | `fengyu-client/cloudfunctions/payNotify/` | 1 index 测试 + 1 config 测试 |
| Mini-program 前端 | `fengyu-{client,staff}/miniprogram/__tests__/` | 11 文件（utils + compile + 部分 page） |
| E2E | `fengyu-admin/e2e/`（24 spec）+ `fengyu-client/e2e/`（3 文件）+ `fengyu-staff/miniprogram/e2e/`（3 文件） | admin E2E 高覆盖 / 小程序 E2E 极少 |

**全仓测试文件总数：135**

---

## 2. 数据流图（迁移残留传播图）

```
audit-NN.md §5 CC9 命中
  ↓ aggregated by CC9
docs/audit/CROSS-CUTTING.md §357 / §491 / §537 / §550 / §564 / §569 / §574 / §590 / §595
  ↓ classified into 3 buckets
(A) 已删字段/表/枚举的代码残留           → 6 P0 + 4 P1 (字段级)
(B) 测试反向锁死（locks-in wrong code）   → 4 P0 + 2 P1 (test-as-spec 反模式)
(C) 关键路径无测试 / 测试盲区             → 3 P1 + 5 P2 (覆盖率)
+ 死代码 / 死配置 / 死分支                → 4 P1 + 3 P2 (consume-side 缺位)
```

---

## 3. 自身漏洞（横切归集 P0/P1/P2）

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-CC9-01]** staff `service.create` 写入不存在的 `service_items.sku_id` 列（域 05 retain）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js:209-217`（INSERT 列表含 `sku_id`）+ schema `db/schema/service.ts:56`（serviceItems 表只有 `sale_item_id` / `unit_real_price` / 无 sku_id）
- **现象**：从 sale_items 拷贝 sku_id 到 service_items，但 service_items 没有这一列。`INSERT INTO service_items (... sku_id, ...) VALUES ($5, ...)` 必抛 `42703 column "sku_id" of relation "service_items" does not exist`。
- **测试盲区**：`__tests__/routes/service.test.js` 的 `service.create` 用例 mock 了 `client.query` 返回 OK，未在测试 schema 上做真实 INSERT 校验，**完美绕过列不存在错误**。
- **风险**：开单 → 服务创建链路 100% 失败；唯一原因生产没爆是路径很少触发（多走 sale_item → 自动转服务单的路径）。
- **修复**：(L3) staff/routes/service.js 删除 `sku_id` 列写入 + (L9 测试) 增加 schema-aware 集成测试或在 mock 层断言 INSERT 列必须存在于 schema。

#### **[P0-CC9-02]** staff `service.test.js:778-839` 反向锁死 rate=0 静默资损路径（域 08 retain）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js:778, 836-839`
- **现象**：当 `commission_rate_matrix` 查不到费率时，service.complete 静默写入 `service_commissions.commission_rate=0, consume_amount=0, fixed_fee=80`，等同于"提成消失"。**测试用例反向锁死了这一行为**：
  ```js
  test('commission_rate_matrix 查不到规则时 rate=0 + 写 operation_logs，不阻塞 complete', ...)
  // L836-839: expect(commission_amount).toBe(80); expect(rate).toBe(0)
  // → 修复 P0-08-03 时必须同步修测试，否则 test 反阻
  ```
- **风险**：测试本身正确（行为正确性需要 spec 决策），但若决策"rate 缺失应抛 INVALID_PARAMS 阻断 complete 而非静默写 0"，此测试将反向阻挠正确实现。
- **修复**：(L3+L9) 修 service.complete + 同步修 test 断言。

#### **[P0-CC9-03]** client `routes/store.js:156` 写入不存在的 `store_unbind_requests.from_store_name` 列（域 12 retain）

- **文件**：`fengyu-client/cloudfunctions/clientApi/routes/store.js:156, 175, 186` + `staff/routes/store.js:49, 63` + schema `db/schema/store-unbind.ts:11` 仅 `from_store_id`
- **现象**：
  - **client.requestUnbind** `INSERT INTO store_unbind_requests (request_id, user_id, **from_store_name**, status, note) ...` → 必抛 `42703`。
  - **client.getUnbindRequest** `SELECT request_id, **from_store_name**, status, note FROM ...` → 必抛 `42703`。
  - **staff.unbindRequests** `SELECT s.store_name AS from_store_name FROM store_unbind_requests sur JOIN stores s ON s.store_id = sur.from_store_id` ✓（这是 JOIN 的 SELECT alias，不是列引用 — OK）
- **测试反锁**：`fengyu-staff/__tests__/routes/store.test.js:54` 和 `fengyu-client/__tests__/routes/store.test.js:111` mock 都返回 `from_store_name: '凤御A店'` → 测试假绿，CI 永不报错。
- **风险**：顾客解绑流 100% 生产失效；老顾客自助换店通道完全断。
- **修复**：(L3) client store.js 全部 `from_store_name` 改 `from_store_id` + (L9) 修两个 test mock。

#### **[P0-CC9-04]** admin `applyRechargeOnOrderPaid` / `createConversionOrder` 仍引用已 DROP 的 `prepaid_cards.store_id`（域 14 retain）

- **文件**：`fengyu-admin/src/actions/orders.ts:91-98`（applyRechargeOnOrderPaid）+ `:1424-1430`（createConversionOrder） + `db/migrations/0003_abandoned_aqueduct.sql:52`（DROP store_id + 改 UNIQUE 索引）
- **现象**：两个 admin 路径仍执行 `INSERT INTO prepaid_cards(card_id, user_id, **store_id**, balance) ... ON CONFLICT (user_id, store_id)`。运行时必抛 `42703 column "store_id" does not exist` + ON CONFLICT 目标不存在。
- **测试反锁**：`orders.test.ts:99` mock 中保留了 `prepaidCards.storeId` 字段；`:553` 注释明示"非充值订单：order 查询返回无 clientUserId，applyRechargeOnOrderPaid 提前 return" → **测试故意走 early return 路径绕过 P0**，CI 永不报错。
- **风险**：admin 端线下确认收款 + 创建转换单两个路径，遇到充值订单 100% 失败。
- **修复**：(L7) admin orders.ts 删 store_id 列写入 + 改 ON CONFLICT (user_id) + (L9) 修 test mock + 加充值订单 confirmOfflinePayment 用例。

#### **[P0-CC9-05]** staff `recalc-customer-type-sql.test.js:78,104` 反向锁死 `'充值卡'` magic string（域 24 retain）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/recalc-customer-type-sql.test.js:78, 104`
- **现象**：测试断言 `staffSql.toContain("pc_parent.is_card_kind = true AND pc_parent.category_name <> '充值卡'")` 字面包含 `'充值卡'`。同时 admin `(main)/products/categories` 又允许动态新增/修改 product_kind 名字 ⇒ **管理员把"充值卡"改名为任何其他字串**（如"会员卡" / "Stored Value Card"）将导致：
  - DB 中 `category_name` 不再是 `'充值卡'`
  - SQL 字面量 `<> '充值卡'` 失效，体验客判定逻辑漂移
  - 测试断言不变，但实际 SQL 必须改 → CI 通过 / 业务逻辑塌陷
- **风险**：测试反向阻碍 DB 驱动 schema 的 capability；admin "改名" 功能 + 测试 magic string 锁死，二者矛盾。
- **修复**：(L0+L7+L9) 把 "充值卡" 升级为 system_configs.special_card_kind_id 配置项 + 测试断言改读配置 + 三端 SQL 改 `<> $cardKindName` 参数化。

#### **[P0-CC9-06]** `customers.test.ts:541` 反向锁死 `monthlyActivity='二次客活'` 但 cron 0 写入（域 10 retain）

- **文件**：`fengyu-admin/src/actions/customers.test.ts:541` + cron `fengyu-admin/src/cron/steps/*.ts`（grep monthly_activity → 0 命中） + `db/schema/user.ts:57`（列存在但 docstring 称"每日凌晨3点根据当月已完成服务单计算"）
- **现象**：测试 mock `eq('monthly_activity', '二次客活')` 形式断言通过，掩盖**实际 cron 6 个 STEP 中无任何一个写 monthly_activity 列**这一资损/列死问题。filter 永远命中 NULL。`db/scripts/calc-monthly-activity.js` 是手动脚本，无定时调度。
- **风险**：admin 顾客筛选"本月活跃"过滤器永远空集；spec 与代码脱节；测试假绿。
- **修复**：(L0+L7+L9) cron 加 STEP `recalc-monthly-activity` 或迁移 `db/scripts/calc-monthly-activity.js` 进 cron + 测试改写为 cron-step 真值集成测试。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-CC9-01]** spec `backend.pr.spec.md` / `admin.pr.spec.md` / `admin.ui.spec.md` 仍提 `valid_start/valid_end` 但 schema 已删（域 09 retain）

- **文件**：`db/schema/product.ts:61, 113`（已替换为 `is_enabled boolean`） vs 三处 spec 仍列 `valid_start` / `valid_end` 字段（backend.pr.spec.md L141-146/L162-163, admin.pr.spec.md L160-164, admin.ui.spec.md L504）
- **现象**：spec 漂移；新人按 spec 写代码会写不存在的字段。
- **修复**：(L0+L1) spec 同步重写为 `is_enabled` + 在 valid period 章节明确"已弃用，改用 is_enabled boolean"。

#### **[P1-CC9-02]** `'组合套餐'` 不再是 product_kind 枚举值，但 admin/staff 前端硬编码（域 24 retain）

- **文件**：
  - `fengyu-staff/miniprogram/pages/order-create/order-create.ts:16` `PRODUCT_KIND_CHOICES = ['组合套餐', '普通商品', '体验卡', '充值卡']`
  - `fengyu-admin/src/app/(main)/orders/_components/order-create-page.tsx:42-44`（同样字面量）
  - `db/schema/enums.ts` 实际无 `productKindEnum`（productKind 仍是 text 列，自由文本但 sync-workfine.js mapping 只产 4 值：护理项目/家居产品/充值卡/体验卡）
- **现象**：UI 提供"组合套餐"选项作为商品类型，但 DB 中 `products.is_bundle=true` 才是组合套餐的真正表达。前端选"组合套餐" → 写到 product_kind 文本列，与 is_bundle 双轨。
- **修复**：(L0) 升级 productKind 为 PG enum 4 值 + (L9) 前端 PRODUCT_KIND_CHOICES 改读后端 GET /product/kinds 动态列表。

#### **[P1-CC9-03]** staff `db/mssql.js` + `query_wf_tables.js` + `mssql` npm 包仍在云函数包内但 0 路由消费

- **文件**：`fengyu-staff/cloudfunctions/staffApi/db/mssql.js`（`require('mssql')`） + `query_wf_tables.js`（同模块） + 测试 setup.js mock 它 + package.json 依赖 mssql 包
- **现象**：所有路由 grep 0 处 `require('./db/mssql')`；按 memory `workfine-sync-stopped` 决策（2026-04-16）运行时 100% PG，但部署包仍带 mssql 客户端 + WorkFine 凭据环境变量分支。
- **风险**：部署包冗余、潜在凭据泄露面、新人误以为 staffApi 仍连 SQL Server。
- **修复**：(L3) 删 staffApi/db/mssql.js + query_wf_tables.js + package.json 中 mssql 依赖 + 测试 setup.js 中 mssql mock。

#### **[P1-CC9-04]** 三份 `share-gift.js` 字节级一致副本 + 1 份 dead test（域 19 retain P1-19-06）

- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/share-gift.js`（live，被 confirmOffline / order.create 调）
  - `fengyu-client/cloudfunctions/payNotify/share-gift.js`（live，payNotify.handleSuccess 调）
  - `fengyu-client/cloudfunctions/clientApi/share-gift.js`（**dead** - clientApi 路由从不调）
  - `fengyu-client/cloudfunctions/clientApi/__tests__/share-gift.test.js`（覆盖 dead code）
- **现象**：3 份要 byte-identical 维护，clientApi 那份 deploy 后永不执行。
- **修复**：(L3) 选项 A 删 clientApi/share-gift.js + 对应 test；选项 B 抽 monorepo shared 包。

#### **[P1-CC9-05]** `customer.giftHistory` / `mgmt-customer.giftHistory` `AND FALSE -- TODO` 死分支（域 19 retain P1-19-07）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:769`、`mgmt-customer.js:722`
- **现象**：组合套餐订单永不命中 — `WHERE ... AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记`。
- **修复**：(L3) 重写为按 `sale_orders.is_bundle=true` 或 sale_items.is_bundle 真值过滤。

#### **[P1-CC9-06]** mgmt-dashboard / staff.js 三处 "旧口径（已废弃）" 注释保留但代码已切

- **文件**：`mgmt-dashboard.js:363, 808, 1032`、`staff.js:704`
- **现象**：注释里详尽描述废弃口径，影响后续 reviewer 误读"是否还在用"。无运行时影响。
- **修复**：(L3) 删除已废弃 docstring 段，保留切换的 commit 链接即可。

### 3.3 P2（代码质量 / 可维护）

#### **[P2-CC9-01]** admin 4 个 actions 0 单测：pickup-records / points / positions / skill-tags

- **文件**：`fengyu-admin/src/actions/{pickup-records,points,positions,skill-tags}.ts` + 0 对应 .test.ts
- **现象**：admin 28 个 actions 文件中 22 有测试，4 个无（22 / 28 = 78.6% 覆盖）。pickup-records 是真正资损面（audit-20 P0 已记），points 是积分流水管理。
- **修复**：(L9) 至少补 happy path + 1 边界用例。

#### **[P2-CC9-02]** staff `routes/staff.js` 4 路由（performanceDetail / dashboard / todayCommission / monthlyCalendar）0 unit test（域 18 retain）

- **文件**：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/staff.test.js`
- **现象**：staff.test.js 仅覆盖 list / departments / todoList / bindStore，绩效 4 个路由全无。绩效域 P0 全部为推断而非测试断言。
- **修复**：(L9) 补 4 路由测试，最低断言 store-scope 过滤 + sale_order_type 过滤。

#### **[P2-CC9-03]** dashboard 测试无"三端口径一致"断言（域 17 retain，CROSS-CUTTING.md §493）

- **文件**：`fengyu-admin/src/actions/dashboard.test.ts` 256 行
- **现象**：admin / mgmt-dashboard.summary / staff.dashboard 三套实现各自跑，但无一处 fixture 跑出 today_revenue 后断言三套数字必须相等。
- **修复**：(L9 新文件) `dashboard.consistency.test.ts` 用同一 fixture 读三套接口，断言核心字段全相等。

#### **[P2-CC9-04]** staff `product.promotionList` / `promotionPlans` 死路由 + mock 残留（域 09 retain P2-09-12）

- **文件**：`staffApi/routes/product.js:476-481`（永远返回 `{ schemes: [] }` / `[]`）+ `staffApi/index.js:54-55` 路由注册 + `staff/miniprogram/mock/product.ts:222`
- **现象**：注释"原 WorkFine 促销查询已废弃，bundle 商品为后续实现"。路由 + mock 同时残留 → 删除阻力小但需同步删除三处。
- **修复**：(L3) 删除 promotionList / promotionPlans 路由 + index.js 注册 + mock 条目。

#### **[P2-CC9-05]** admin `lib/product-kind.ts` `CARD_PRODUCT_KINDS` deprecated 常量保留（域 24 P2-24-10）+ staff 同名常量（`order-create.ts:28`）

- **文件**：`admin/lib/product-kind.ts` + `staff/order-create.ts:28 CARD_PRODUCT_KINDS = ['充值卡', '体验卡']`
- **现象**：与 DB 驱动 `product_categories.is_card_kind=true` 双轨；shopInit 仍用 JS 常量排除卡类。
- **修复**：(L3) 三端常量删除 → 改读 `productCategories` API。

#### **[P2-CC9-06]** `display_icon` 字段 admin write/read 全链路但三端无渲染消费（域 24 P2-24-11）

- **文件**：admin `actions/products.ts:212` INSERT + `:88, 112, 148` SELECT；client / staff 无任何 wxml 渲染
- **现象**：dead column 类型典型 — 写入但无消费。
- **修复**：(L3) 三端 wxml 加 icon 渲染 或 (L0) schema 删除 display_icon 列。

#### **[P2-CC9-07]** allocation.js `departmentName: null` deprecated 字段保留（PR-4 注释）

- **文件**：`staffApi/routes/allocation.js:454`
- **现象**：`departmentName: null,  // deprecated (PR-4)：保留字段兼容前端展示，值不再由服务端填` — 前端已不用应同步删。
- **修复**：(L3+L9) 删除字段 + 前端清理 mock + grep 无残留确认。

#### **[P2-CC9-08]** spec drift 集合：`db/scripts/sync-products-from-workfine.js` 仍读 `big_category` / `workfine_source` / `sku_display_name` / `product_spu` / `product_spu_sku_map` 等已废弃 schema

- **文件**：`db/scripts/sync-products-from-workfine.js`（多处 INSERT 旧表）
- **现象**：按 memory `workfine-sync-stopped`（2026-04-16），WorkFine 同步已停用；本脚本已不再调度，但保留在 db/scripts/ 内可能被开发者误执行。
- **风险**：误运行将向已 DROP 的表 INSERT，全部失败。
- **修复**：(L3) 在脚本顶部加 `console.error('DEPRECATED — workfine sync stopped 2026-04-16'); process.exit(1)` 或迁入 `db/scripts/_archive/`。

#### **[P2-CC9-09]** 小程序 E2E 极少（fengyu-staff 3 文件 / fengyu-client 3 文件） vs admin E2E 24 文件

- **文件**：`fengyu-{staff,client}/miniprogram/e2e/*.test.js`
- **现象**：staff e2e 仅 workbench / service / login；client e2e 仅 page-render / navigation / interaction。开单 / 支付 / 退款 / 服务单 / 预约 / 提货 6 大资损链路 0 端到端覆盖。
- **修复**：(L9) 至少补 staff order.create + client order.pay 两条端到端流程。

---

## 4. 跨端不一致（CC9 关注的"测试镜像漂移" + "spec/代码 drift"）

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

## 5. 横切检查（套用 §3，本身就是 CC9 收口）

- [x] **CC9 测试与残留** — 本报告
  - **(A) 已删字段/表/枚举的代码残留**：
    - **字段名残留**：
      - `from_store_name` — 4 文件（client routes/store.js + 2 test mock + staff alias 1 处）→ **2 P0 写入路径**
      - `prepaid_cards.store_id` — 2 admin 路径（applyRechargeOnOrderPaid + createConversionOrder）+ 1 test mock 残留 → **1 P0 + 1 测试反锁**
      - `service_items.sku_id` — 1 写入路径（staff service.create）+ schema 0 列 → **1 P0**
      - `valid_start` / `valid_end` — 0 代码引用 ✓ / 4 spec 文件引用 → **1 P1 spec drift**
      - `staff_wechat_users.user_id` — 0 残留 ✓（v3.3 完整迁移）
      - `operator_user_id` — 0 残留 ✓（audit-23 RESOLVED）
      - `monthly_activity` — 列存在 + cron 0 写入 → **1 P0**
    - **表名残留**：
      - `product_spu` / `product_spu_sku_map` / `catalog_items` / `material_products` / `promotion_schemes` — 0 命中（仅 `db/scripts/sync-products-from-workfine.js` 残留 → P2-CC9-08）
    - **枚举值残留**：
      - `'组合套餐'` — admin/staff order-create 硬编码 → **1 P1**
      - `'福利活动'` — staff product.test.js 测试用例**正向使用**作为新增 kind 案例，OK ✓
      - `big_category` — 仅 staff/miniprogram/mock/product.ts + sync-workfine.js → **mock + 同步脚本残留**
      - `workfine_source` — 仅 sync-products-from-workfine.js → P2-CC9-08

  - **(B) 测试反向锁死错误代码 / magic string**：
    - service.test.js rate=0 静默写入（**P0-CC9-02**）
    - store.test.js (staff+client) `from_store_name` mock（**P0-CC9-03**）
    - orders.test.ts `:553` 早 return 绕过 prepaid 充值订单 path（**P0-CC9-04**）
    - recalc-customer-type-sql.test.js `'充值卡'` 4 处 字面量（**P0-CC9-05**）
    - customers.test.ts:541 monthlyActivity mock（**P0-CC9-06**）
    - allocation.test.js:685 `'推广师' rate=0.1` 但代码 0 实现（**P1**，audit-25）

  - **(C) 关键路径无测试 / 测试盲区**：
    - admin pickup-records / points / positions / skill-tags 无单测（P2-CC9-01）
    - staff.js 4 绩效路由无 unit test（P2-CC9-02）
    - dashboard 三端口径无一致性测试（P2-CC9-03）
    - 小程序 E2E 6 大资损链路 0 覆盖（P2-CC9-09）

  - **(D) 死代码 / 死配置 / 死分支**：
    - share-gift.js 3 副本 + 1 dead clientApi（P1-CC9-04）
    - customer.js / mgmt-customer.js `AND FALSE -- TODO` 双副本（P1-CC9-05）
    - product.js promotionList/Plans dead routes + mock（P2-CC9-04）
    - allocation.js `departmentName: null` deprecated 字段（P2-CC9-07）
    - admin lib/product-kind.ts CARD_PRODUCT_KINDS / staff order-create.ts 同名常量（P2-CC9-05）
    - display_icon dead column write/read 但无渲染（P2-CC9-06）
    - mssql.js / query_wf_tables.js / mssql 依赖在 staffApi 部署包内但 0 路由消费（P1-CC9-03）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| **L0 schema/enums** | `db/schema/enums.ts` | 新增 `productKindEnum` 4 值（护理项目/家居产品/充值卡/体验卡）+ products.product_kind 类型升级 | P1-CC9-02 |
| **L0** | `db/schema/product.ts` | 评估 display_icon 列：删除或在 wxml 加渲染 | P2-CC9-06 |
| **L0** | `db/schema/system-config.ts` | 加 `special_card_kind_id` 配置项 | P0-CC9-05 |
| **L1 spec** | `.42cog/pm/{backend,admin}.pr.spec.md` + `admin.ui.spec.md` | 全量替换 `valid_start/valid_end` → `is_enabled boolean` 字段说明 | P1-CC9-01 |
| **L3 staff** | `staffApi/routes/service.js:209-217` | 删除 INSERT 列表中 `sku_id` | P0-CC9-01 |
| **L3 staff** | `staffApi/routes/service.js` (complete) | rate 缺失 → 抛 `INVALID_PARAMS:` 阻断 | P0-CC9-02 |
| **L3 client** | `clientApi/routes/store.js:156, 175, 186` | 全部 `from_store_name` 改 `from_store_id` | P0-CC9-03 |
| **L3 staff** | `staffApi/share-gift.js` 三副本 | 抽 monorepo 共享 / 删 clientApi 副本 | P1-CC9-04 |
| **L3 staff** | `staffApi/routes/customer.js:769` + `mgmt-customer.js:722` | 重写按 sale_orders.is_bundle 过滤组合套餐 | P1-CC9-05 |
| **L3 staff** | `staffApi/db/mssql.js` + `query_wf_tables.js` + package.json | 删除 mssql 依赖 + 文件 + setup.js mock | P1-CC9-03 |
| **L3 staff** | `staffApi/routes/product.js:476-481` + `staffApi/index.js:54-55` + miniprogram/mock/product.ts:222 | 删除 promotionList / promotionPlans 三处残留 | P2-CC9-04 |
| **L3 staff/client/admin** | 三端 `'充值卡' / '体验卡'` 字面常量 | 改读 productCategories DB 驱动 | P2-CC9-05 / P0-CC9-05 |
| **L3 staff** | allocation.js:454 | 删 `departmentName: null` 字段 | P2-CC9-07 |
| **L3 db/scripts** | `sync-products-from-workfine.js` | 加废弃 banner exit 1 或迁入 `_archive/` | P2-CC9-08 |
| **L7 admin** | `actions/orders.ts:91-98, 1424-1430` | 删 `store_id` 列写入 + 改 ON CONFLICT (user_id) | P0-CC9-04 |
| **L7 admin** | `cron/steps/recalc-monthly-activity.ts` 新增 | 把 db/scripts/calc-monthly-activity.js 迁进 cron | P0-CC9-06 |
| **L7 admin** | `app/(main)/orders/_components/order-create-page.tsx:42-44` | 改读后端 GET /product/kinds 动态列表 | P1-CC9-02 |
| **L9 admin tests** | `actions/{pickup-records,points,positions,skill-tags}.test.ts` | 新增 4 个 spec | P2-CC9-01 |
| **L9 staff tests** | `__tests__/routes/staff.test.js` | 补 performanceDetail/dashboard/todayCommission/monthlyCalendar 4 套 | P2-CC9-02 |
| **L9 admin tests** | `actions/dashboard.consistency.test.ts` 新增 | 跨实现一致性 | P2-CC9-03 |
| **L9 staff tests** | `__tests__/routes/{store,service}.test.js` + `__tests__/routes/recalc-customer-type-sql.test.js` | 同步修测试断言（P0 修复后） | P0-CC9-02/03/05 |
| **L9 admin tests** | `actions/orders.test.ts:99, 553` | 删 prepaid_cards.storeId mock + 加充值订单 confirmOfflinePayment 用例 | P0-CC9-04 |
| **L9 admin tests** | `actions/customers.test.ts:541` | 改写为 cron-step 真值集成测试 | P0-CC9-06 |
| **L10 e2e** | `fengyu-{staff,client}/miniprogram/e2e/` | 至少补 staff order.create + client order.pay | P2-CC9-09 |

---

## 7. 验证 SQL（仅 SELECT / EXPLAIN，目标 5434/fengyu）

```sql
-- 验证 service_items 表无 sku_id 列（佐证 P0-CC9-01）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'service_items' ORDER BY ordinal_position;

-- 验证 store_unbind_requests 表无 from_store_name 列（佐证 P0-CC9-03）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'store_unbind_requests' ORDER BY ordinal_position;

-- 验证 prepaid_cards 表无 store_id 列 + UNIQUE 仅 (user_id)（佐证 P0-CC9-04）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'prepaid_cards' ORDER BY ordinal_position;
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'prepaid_cards';

-- 验证 monthly_activity 列存在但全部 NULL（佐证 P0-CC9-06）
SELECT monthly_activity, COUNT(*) FROM client_wechat_users GROUP BY monthly_activity;

-- 验证 product_categories 是否真存在 'name=充值卡' 行（佐证 P0-CC9-05 magic string 来源）
SELECT category_id, category_name, product_kind, is_card_kind
FROM product_categories WHERE product_kind IS NULL AND is_card_kind = true;

-- 验证 promoter_employee_id 写入但 sale_allocations 0 消费（佐证 audit-25 P0）
SELECT
  COUNT(*) FILTER (WHERE promoter_employee_id IS NOT NULL) AS with_promoter,
  COUNT(*) AS total
FROM client_wechat_users;
SELECT cu.promoter_employee_id, COUNT(DISTINCT so.sale_order_id) AS orders,
       COUNT(DISTINCT sa.id) AS promoter_allocations
FROM client_wechat_users cu
LEFT JOIN sale_orders so ON so.client_user_id = cu.user_id
LEFT JOIN sale_allocations sa ON sa.sale_order_id = so.sale_order_id AND sa.employee_id = cu.promoter_employee_id
WHERE cu.promoter_employee_id IS NOT NULL
GROUP BY cu.promoter_employee_id;
```

---

## 8. 回归测试用例（建议）

1. **P0-CC9-01**：staff service.create 走真实 PG schema → 确认 INSERT 无 `42703` 错误（移除 sku_id 后）
2. **P0-CC9-02**：commission_rate_matrix 删除某行 → service.complete 应 throw `INVALID_PARAMS:` 而非静默写 0
3. **P0-CC9-03**：client requestUnbind / getUnbindRequest 跑 staging 实库 → 应成功
4. **P0-CC9-04**：admin confirmOfflinePayment 一笔含充值 SKU 的 sale_order → prepaid_cards 行成功 UPSERT
5. **P0-CC9-05**：把"充值卡" rename 为"会员卡" → 三端体验客判定逻辑 + 测试断言不变
6. **P0-CC9-06**：cron STEP 跑完 → admin 顾客列表"本月活跃"过滤器命中 ≥1 行
7. **P1-CC9-01**：新人按 spec 写代码 → spec 自身明确 is_enabled 而非 valid_start
8. **P1-CC9-02**：admin 新增"福利活动" product_kind → staff/client/admin order-create 自动出现该选项
9. **P1-CC9-03**：删除 staffApi mssql 依赖 → 部署包大小减少；staffApi 路由全测过
10. **P2-CC9-09**：staff order.create + client order.pay E2E 通过

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- **全栈（3 端 + DB + 测试 + spec）**：☑
- 涉及历史数据：☑（monthly_activity 列回填 + prepaid_cards 充值订单的兼容性）
- 修复成本：**M**（4 个 P0 是局部代码修改 + 测试同步；6 个 P1 是 spec 同步 + 死代码清理；9 个 P2 是新增测试）
- 关键依赖：CC9 与 CC1/CC2/CC3/CC4 的修复一一对应（同一 P0 在不同视角被多次确认）

---

## 10. 后续待办

- [ ] **优先级 1**（P0，本周）：service.create / requestUnbind / applyRechargeOnOrderPaid 三个 100% 生产失效路径修复 + 同步修对应测试 mock
- [ ] **优先级 2**（P0，本周）：cron 加 monthly_activity STEP；'充值卡' magic string 升级为 system_config 配置项
- [ ] **优先级 3**（P1，2 周内）：spec 三件套同步 valid_start → is_enabled；productKind 升级为 PG enum + 前端硬编码改读 API
- [ ] **优先级 4**（P1，2 周内）：share-gift.js 三副本治理；customer.giftHistory `AND FALSE` 死分支重写
- [ ] **优先级 5**（P2，1 月内）：admin 4 个 0 测试 actions 补齐；staff.js 4 绩效路由补测；dashboard 三端口径一致性测试
- [ ] **优先级 6**（P2，1 月内）：清理 staffApi 中 mssql 依赖 + db/scripts 废弃同步脚本归档；E2E 补 6 大资损链路
- [ ] 与 audit-CC2/CC3/CC4 修复 PR 合并：很多 P0 对应同源（如 P0-CC9-04 = audit-14 P0；P0-CC9-03 = audit-12 P0）

---

## 附：CC9 量化总表

| 类别 | 计数 | 说明 |
|------|------|------|
| **(A) 已删字段/表/枚举的代码残留** | 6 P0 + 4 P1 | 含 service_items.sku_id / from_store_name / prepaid_cards.store_id / monthly_activity / 充值卡 magic / valid_start spec drift / 组合套餐 UI 硬编码 / mssql 依赖残留 / share-gift dupes / AND FALSE 死分支 |
| **(B) 测试反向锁死错误代码** | 4 P0 + 2 P1 | service rate=0 / store from_store_name mock / orders early-return / 充值卡 magic / monthlyActivity mock + 推广师 rate=0.1 测试 |
| **(C) 关键路径无测试** | 0 P0 + 0 P1 + 5 P2 | admin 4 actions / staff.js 4 绩效路由 / dashboard 一致性 / E2E 6 资损链路 |
| **(D) 死代码 / 死配置** | 0 P0 + 4 P1 + 4 P2 | share-gift / mssql / promotion stub / departmentName / display_icon / CARD_PRODUCT_KINDS 常量 / 已废弃注释 / sync-workfine 脚本 |
| **总计** | **6 P0 / 6 P1 / 9 P2** | — |
