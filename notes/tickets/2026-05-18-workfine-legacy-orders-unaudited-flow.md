# Ticket: WorkFine 历史订单"未审核 + 顾客触发核对"全流程

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P0**（阻塞正式上线 — 否则会员等级/标签 / 同环比无历史基线） |
| 端 | db + db/scripts（抓取脚本）+ fengyu-admin（未审核订单页 + 核对流程）+ fengyu-staff（顾客详情触发按钮）+ fengyu-client（登录后挂钩） |
| 修复成本 | **L**（schema 扩展 + 抓取脚本 + 单独管理页 + 标签重算 hook） |
| 来源 | meeting-20260507 §一（最核心议题）|
| 关联 schema | `db/schema/order.ts`（sale_orders）/ `db/schema/enums.ts:5-14`（orderStatusEnum）|
| 关联反馈 | `feedback_mssql_readonly.md`（WorkFine 严格只读，仅 SELECT 抓取）|

---

## 0 一句话背景

会议否决"订单从零开始"方案——会员等级/消费档位/顾客类型等标签依赖历史消费，没历史就算不出，同比/环比也要等运行满 1 年才可用。

最终采纳 "**全量抓取 + 默认未审核 + 顾客到店触发核对**"：

```
WorkFine（8 万条历史订单）
    │ db/scripts/import-workfine-legacy.js（一次性抓 4 字段）
    ▼
sale_orders.status = '未审核'  + sale_order_type = '销售单'  + 标记 source='workfine_legacy'
    │ 不参与统计、不在订单管理列表展示
    │
    │ ▽ 顾客到店流程
    │
顾客微信小程序登录 → 提取手机号 → 员工在 admin "未审核订单" 页按手机号筛
    │ 员工核对 4 字段（金额/日期/门店/手机号正确性）
    │ → 审核通过：status 跳到 '已支付'（或新增 '已核对'）
    │ → 拒绝：status='已作废'
    ▼
顾客 customer_status / member_level / spending_tier 全量重算
```

**抓取字段最小化**："手机号 / 归属门店 / 金额 / 日期" 四字段；**不抓**品项名（变体上千个）、**不抓**次数（错得多）—— 用户原话："你抓的多就错的多"。

---

## 1 现状（grep 实证）

### 1.1 sale_orders.status 枚举（待扩展）

```ts
// db/schema/enums.ts:5-14
export const orderStatusEnum = pgEnum("order_status", [
  "待支付", "待确认收款", "已支付", "已完成",
  "支付失败", "已关闭", "待审批", "部分支付",
]);
// → 缺 "未审核" 值
```

### 1.2 sale_orders 缺乏 "来源" 标记

```bash
$ grep -nE "legacy|workfine|source" db/schema/order.ts
（仅 sale_order_payments.source_end，不适用于订单维度）
```

→ 需要新加列 `legacy_source TEXT`（NULL = 系统原生订单；`'workfine'` = 历史导入）

### 1.3 WorkFine 表名映射（reference_workfine_mssql.md）

历史销售订单源表（dbo.B_销售订单 / dbo.B_销售订单明细）—— 仅取主表 4 字段：
- 手机号（来自 dbo.顾客信息表 JOIN）
- 归属门店（dbo.店铺信息表 JOIN）
- 订单总金额（B_销售订单.金额）
- 订单日期（B_销售订单.业务日期）

不取明细行（避免品项映射错乱）。

### 1.4 admin 当前订单列表已过滤逻辑

```ts
// fengyu-admin/src/actions/orders.ts:listOrders
// 当前 WHERE 默认 status IN ('已支付','部分支付', ...)
// → 未审核订单需要单独入口，不混入主列表
```

---

## 2 修复方案（4 PR）

### PR-1：schema 扩展

**文件**：`db/schema/enums.ts` + `db/schema/order.ts` + `db/migrations/00NN_*.sql`

**改动**：

```ts
// enums.ts
export const orderStatusEnum = pgEnum("order_status", [
  "待支付", "待确认收款", "已支付", "已完成",
  "支付失败", "已关闭", "待审批", "部分支付",
  "未审核",   // ← 新增
  "已作废",   // ← 新增（核对拒绝时用，区别于"已关闭"=超时关闭）
]);

// order.ts saleOrders 增列
legacySource: text("legacy_source"),  // NULL=系统原生；'workfine'=WorkFine 导入
legacyCustomerId: text("legacy_customer_id"),  // WorkFine 顾客编号原值（核对辅助）
legacyRawSnapshot: text("legacy_raw_snapshot"),  // JSON 字符串，存抓取时原始 4 字段
auditedAt: timestamp("audited_at"),  // 审核通过时间
auditedBy: varchar("audited_by", { length: 30 }).references(() => staffWechatUsers.employeeId),  // 审核员
```

走标准 drizzle-kit：`db:generate` → 临时 PG 验证 → 5434 `db:migrate`。

### PR-2：抓取脚本 `db/scripts/import-workfine-legacy.js`

**作用**：从 WorkFine MSSQL **一次性**抓所有历史销售订单（仅 4 字段）→ 写入 PG `sale_orders` 表，status='未审核'。

**关键 SQL**（MSSQL 只读 SELECT）：

```sql
SELECT
  k.手机号 AS phone,
  s.店铺编号 AS workfine_store_code,
  o.金额 AS amount,
  o.业务日期 AS order_date,
  k.顾客编号 AS legacy_customer_id,
  o.销售单号 AS legacy_order_no
FROM dbo.B_销售订单 o
LEFT JOIN dbo.顾客信息表 k ON o.顾客编号 = k.顾客编号
LEFT JOIN dbo.店铺信息表 s ON o.店铺编号 = s.店铺编号
WHERE o.业务日期 >= '2020-01-01'  -- 时间窗待与张凯确认
ORDER BY o.业务日期;
```

**PG 写入逻辑**：

```js
// 每行 -> 1 个 sale_orders 行
INSERT INTO sale_orders (
  sale_order_id,          -- 生成新号：FY-LEG-WX-{YYMMDD}{4位}（LEG = legacy 区分）
  status,                 -- '未审核'
  sale_order_type,        -- '销售单'（不用'寄存单'，寄存单是另一 ticket）
  market_name,
  store_id,               -- 通过 workfine_store_code 映射到 stores.store_id；无映射时挂"未知门店"占位
  sale_order_datetime,    -- order_date
  client_user_id,         -- 通过 phone 匹配 client_wechat_users.phone；无匹配填 NULL（顾客来时再绑）
  client_phone,           -- phone（即使匹配不到也存）
  customer_name,          -- NULL（不抓）
  total_amount,           -- amount
  payable_amount,         -- amount
  received,               -- 0（待审核前不入账）
  payment_method,         -- '无'
  legacy_source,          -- 'workfine'
  legacy_customer_id,     -- WorkFine 顾客编号
  legacy_raw_snapshot,    -- JSON.stringify({phone,workfine_store_code,amount,order_date,legacy_order_no})
  market_name,            -- 通过 store_id 反查
  opened_by               -- 'SYSTEM_MIGRATION'（特殊员工号占位）
)
ON CONFLICT DO NOTHING;  -- 幂等（按 legacy_raw_snapshot.legacy_order_no UNIQUE）
```

**幂等**：在 `legacy_source='workfine' AND legacy_raw_snapshot->>'legacy_order_no'` 上建 partial UNIQUE 索引。

**Dry-run 模式**：脚本支持 `--dry-run` 输出"将导入 N 行 / 门店映射缺失 M 行 / 手机号匹配 K 行"。

**预估数据量**：会议提到约 8 万条；按 8 万行 INSERT 走批量（每批 1000 行），约 1 分钟。

### PR-3：admin "未审核订单" 单独管理页

**文件**：`fengyu-admin/src/app/(main)/legacy-orders/page.tsx`（新页）

**功能**：
- 路由 `/legacy-orders`，菜单挂在 "订单管理" 之下，仅 `admin` / `manager` 角色可见
- 列表展示 `WHERE legacy_source='workfine' AND status='未审核'`
- 列：手机号 / 门店 / 金额 / 日期 / 匹配的小程序顾客（绿色✓ / 红色✗ 未注册）/ 操作
- **筛选**：手机号搜索（最常用——顾客到店店员手机号查）/ 门店 / 日期 / 是否已匹配顾客
- **批量操作**：选中多行 → 批量通过（用于已确认的同顾客多单）/ 批量作废
- 单行操作：
  - "通过" → status='已支付' + audited_at + audited_by；写 operation_log
  - "作废" → status='已作废'；写 operation_log
  - "改手机号" → 仅修 client_phone 字段（用于 WorkFine 上手机号错的情况），改完自动尝试重新匹配 client_user_id

**Server Action 新增**：
- `listLegacyOrders(filters)` — 服务端分页
- `approveLegacyOrder(saleOrderId, expectedUpdatedAt)` — CAS 守卫
- `rejectLegacyOrder(saleOrderId, expectedUpdatedAt)` — CAS 守卫
- `batchApproveLegacyOrders(ids[], expectedUpdatedAts[])` — 事务批量
- `updateLegacyOrderPhone(saleOrderId, newPhone, expectedUpdatedAt)`

权限矩阵新增 4 项：`legacy_order:list` / `:approve` / `:reject` / `:update_phone`。

### PR-4：顾客触发核对入口 + 审核通过后标签重算 hook

#### PR-4a：staff 顾客详情页"触发核对"按钮

**文件**：`fengyu-staff/miniprogram/pages/customer-detail/customer-detail.ts`

- 顾客详情页加 "历史订单核对" 按钮（仅当 `legacyOrderCount > 0`）
- 点击 → 跳 admin 网页（或 staff 端新增轻量审核页，建议直接跳 admin 因审核流复杂）
- 顾客 detail API 返回新字段 `legacyOrderCount`（`SELECT COUNT(*) FROM sale_orders WHERE legacy_source='workfine' AND client_phone=? AND status='未审核'`）

#### PR-4b：client 登录后自动尝试匹配

**文件**：`fengyu-client/cloudfunctions/clientApi/routes/auth.js` `bindPhone`

- 用户首次绑定手机号时，触发一次"按 phone 反查并回填 `client_user_id`"：

```sql
UPDATE sale_orders
SET client_user_id = $newUserId
WHERE legacy_source='workfine'
  AND client_phone = $phone
  AND client_user_id IS NULL;
```

→ 不改 status；只是建立关联，让 admin 审核时能直接看到"已匹配顾客"。

#### PR-4c：审核通过后标签重算

**文件**：`fengyu-admin/src/actions/legacy-orders.ts` `approveLegacyOrder`

- 审核通过的同事务中：
  1. UPDATE sale_orders SET status='已支付', audited_at=NOW(), audited_by=$session.employeeId
  2. 如果该订单有 client_user_id：触发 `recomputeCustomerTags(clientUserId)`（复用 cron STEP 1 + STEP 2 的逻辑，单顾客版）
  3. 写 operation_log

**`recomputeCustomerTags(userId)` 新增**：把 `fengyu-admin/src/cron/steps/refresh-customer-status.ts` + `refresh-member-levels.ts` 的核心 SQL 抽到 helper，支持"全量重算"和"单顾客重算"两种入参。

---

## 3 验收标准（DoD）

### PR-1（schema）
- [ ] orderStatusEnum 包含 '未审核' + '已作废'；5434 + 临时 PG 双跑 OK
- [ ] sale_orders 新增 5 列；类型检查 `cd fengyu-admin && npx tsc --noEmit` 0 错
- [ ] partial UNIQUE 索引 `uq_legacy_order_no` 落地

### PR-2（抓取脚本）
- [ ] `--dry-run` 输出统计：将导入 X 行 / 门店映射成功 Y / 手机号匹配 Z
- [ ] 实跑后 PG `SELECT COUNT(*) FROM sale_orders WHERE legacy_source='workfine'` = WorkFine `SELECT COUNT(*) FROM dbo.B_销售订单 WHERE 业务日期>='...'`
- [ ] 重跑脚本不产生重复行（幂等）
- [ ] 现有统计 SQL（dashboard / mgmt-product / mgmt-customer）**自动**剔除 `status='未审核'` 行（因 status NOT IN 过滤）→ 抽样 5 个核心聚合 SQL 验证不污染统计

### PR-3（admin 单独管理页）
- [ ] `/legacy-orders` 路由可见；非 admin/manager 角色 403
- [ ] 手机号搜索 < 200ms（需 `INDEX (legacy_source, client_phone)`）
- [ ] 批量通过 50 行 < 5s
- [ ] CAS 守卫：两人同时审核同一行 → 后者收到 `CONFLICT: 订单已被审核`
- [ ] operation_log 完整记录每次 approve/reject

### PR-4（触发核对 + 重算）
- [ ] PR-4a：staff 顾客详情新增 `legacyOrderCount` 字段；按钮仅当 > 0 显示
- [ ] PR-4b：client bindPhone 后 legacy 订单 client_user_id 自动回填，admin 列表"已匹配顾客"列变绿
- [ ] PR-4c：审核通过 1 条 → 该顾客 member_level / customer_status / spending_tier 立即重算；与 cron 跑出的结果一致
- [ ] e2e 链路：mock WorkFine 数据 → 抓取 → 顾客登录 → 自动匹配 → 审核 → 标签变化（全链 ≤ 30s）

### 总
- [ ] 文档更新：`.42cog/pm/backend.pr.spec.md` 新增 §legacy_orders 小节；`reference_workfine_mssql.md` 加抓取 SQL 引用
- [ ] memory 新增 `project_legacy_orders_workflow.md` 记录"为什么不批量审，而是顾客触发"决策

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| 抓取后 sale_orders 增 8 万行，dashboard 聚合慢 | 所有现有聚合 SQL `WHERE status NOT IN ('未审核','已作废')`（grep + 补 partial 索引）|
| 顾客手机号在 WorkFine 错填 → 永远匹配不上 | 提供 admin "改手机号" 入口（PR-3）+ 邵冬已强调"管理上的问题，不打代码补丁"|
| 审核通过后标签 SQL 慢（单顾客重算 ~ 670ms 已优化） | 复用 cron STEP 1/2 的批量 SQL；单顾客模式加 `WHERE user_id=$1` 即可 |
| WorkFine 顾客编号与小程序 client_user_id 双重身份混乱 | sale_orders 同时存 legacy_customer_id 和 client_user_id，二者并行；client_user_id 为权威，legacy 仅作核对辅助 |
| 8 万条历史中存在大量重复/作废订单（WorkFine 数据质量差）| 抓取时不去重；审核时由员工逐条作废；脚本支持"导出待人工核对清单"|

**回滚**：
- PR-1 schema：新加列 NOT NULL → 实际 nullable，DROP COLUMN 即可
- PR-2 数据：`DELETE FROM sale_orders WHERE legacy_source='workfine'`
- PR-3/PR-4 代码：commit revert

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260507/article.md` §一 |
| 关联 schema | `db/schema/order.ts` / `db/schema/enums.ts` |
| 关联 reference | `notes/memory/reference_workfine_mssql.md`（MSSQL 连接 + 表名映射）|
| 关联 feedback | `notes/memory/feedback_mssql_readonly.md`（只读约束，仅 SELECT 抓取符合）|
| 关联 cron | `fengyu-admin/src/cron/steps/refresh-customer-status.ts` + `refresh-member-levels.ts`（重算逻辑复用）|
| 关联 ticket | 同批 `2026-05-18-deposit-sale-order-type.md`（寄存单是另一类初始化订单，与本 ticket 互补）|
| 关联 spec | 实施后需更新 `.42cog/pm/backend.pr.spec.md` §legacy_orders + `admin.pr.spec.md` 新 AC |
