# staff service.create 写入不存在的 sku_id 列（service_items schema 残留）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-17 |
| 实施状态 | 📝 待实施 |
| 优先级 | **P0** |
| 端 | fengyu-staff（staffApi 云函数） |
| 修复成本 | **S**（半天） |
| 来源 | SUMMARY v3 Top10 #2 + audit-05 P0-05-01 / P0-CC9-01 |
| 关联 e2e | `fengyu-staff/tests/e2e-cloudfn/smoke-service-lifecycle.mjs`（已绕过）、`smoke-service-create.mjs`（守护中） |

> ### v2 修订摘要（2026-05-17，复核反馈后）
> - 修订状态：R1 → **R2（复核反馈合入）**
> - 关键修订：参数 $1~$9 自检 / mock 文件清单补 3 处 / smoke 注释清理任务 / 验收 Checklist 加硬断言
> - 详见末尾"复核反馈（R2）"节

---

## 0 一句话背景

`staffApi/routes/service.js:208-211` 仍按老 schema INSERT `service_items (sku_id, ...)`，但 `service_items` 表自 baseline 起从未存在 `sku_id` 列，导致 `service.create` 在任何真实数据库上都会抛 `column "sku_id" of relation "service_items" does not exist`，员工端"创建服务单"功能 100% 不可用，目前 e2e 用 fixture 绕过 service.create 来掩盖此 bug。

## 1 现状（grep 实证）

### 1.1 staffApi 错误 INSERT

`fengyu-staff/cloudfunctions/staffApi/routes/service.js:195-224`：

```js
// 195-205: 读 sale_items 快照（含 sku_id 字段）
const siRows = await client.query(
  `SELECT si.sku_id, si.unit_real_price, si.is_shengmei, si.sales_category
   FROM sale_items si
   WHERE si.sale_item_id = $1`,
  [item.saleItemId]
)
const skuId = siRows.rows[0]?.sku_id || null
const unitRealPrice = siRows.rows[0]?.unit_real_price || null
const isShengmei = siRows.rows[0]?.is_shengmei ?? null
const salesCategory = siRows.rows[0]?.sales_category ?? null

// 207-224: INSERT 列清单包含 sku_id —— 但表里没这一列
await client.query(
  `INSERT INTO service_items
     (service_item_id, sale_item_id, unit_real_price, service_order_id,
      sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [
    serviceItemId,
    item.saleItemId,
    unitRealPrice,
    serviceOrderId,
    skuId,             // ← $5：被 INSERT 进不存在的列
    item.sessionUsed,
    item.employeeId || resolvedStaffWfId,
    item.serviceDuration || null,
    isShengmei,
    salesCategory
  ]
)
```

`skuId` 仅在此 INSERT 中使用一次，后续无任何路径消费它（只读快照，业务对 `service_items.sku_id` 没有任何反向引用）。

### 1.2 service_items schema 确无 sku_id 列

`db/schema/service.ts:52-80`：

```ts
export const serviceItems = pgTable('service_items', {
  serviceItemId: text('service_item_id').primaryKey(),
  saleItemId:    varchar('sale_item_id', { length: 30 }).notNull()...,
  unitRealPrice: numeric('unit_real_price', { precision: 10, scale: 2 }),
  isShengmei:    boolean('is_shengmei'),
  salesCategory: salesCategoryEnum('sales_category'),
  serviceOrderId: varchar('service_order_id', { length: 30 }).notNull()...,
  sessionUsed:   integer('session_used').notNull(),
  employeeId:    varchar('employee_id', { length: 30 }).notNull()...,
  serviceDuration: integer('service_duration'),
  createdAt, updatedAt,
})  // ← 无 sku_id
```

迁移历史验证（`grep -rn "service_items" db/migrations/*.sql | grep -i sku_id` → 0 命中）：

- `db/migrations/0000_baseline.sql:292-302` — baseline CREATE TABLE 不含 sku_id
- `db/migrations/0008_aspiring_pride.sql` — ADD COLUMN `is_shengmei`（无 sku_id）
- `db/migrations/0011_misty_nebula.sql` — ADD COLUMN `sales_category`（无 sku_id）

→ **service_items 表从未存在过 sku_id 列**。`sku_id` 字段是 `sale_items` 独有。

### 1.3 全仓 sku_id × service_items 误用扫描

```
$ grep -rn "service_items" --include="*.{js,ts,mjs}" | grep sku_id
fengyu-staff/cloudfunctions/staffApi/routes/service.js:195   // 注释
fengyu-staff/cloudfunctions/staffApi/routes/service.js:197   // SELECT sale_items.sku_id（正确）
fengyu-staff/cloudfunctions/staffApi/routes/service.js:202   // const skuId = ...
fengyu-staff/cloudfunctions/staffApi/routes/service.js:210   // INSERT service_items(..., sku_id, ...) ← BUG
fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js:268,273  // mock 旧契约
fengyu-staff/tests/e2e-cloudfn/smoke-service-lifecycle.mjs:5  // bug 说明注释
fengyu-staff/tests/e2e-cloudfn/smoke-service-create.mjs:6,62  // 守护脚本
```

只有 service.js:208-211 一处真实误用。admin `fengyu-admin/src/actions/services.ts` 只做 SELECT JOIN，不做 INSERT，无相同 bug（admin 端无创建服务单功能）。

### 1.4 e2e 绕过现状

`fengyu-staff/tests/e2e-cloudfn/smoke-service-lifecycle.mjs:1-15`：

```js
/**
 * service.start + complete 生命周期冒烟（绕过 service.create）
 *
 * NOTE：service.create 当前生产 bug — routes/service.js:207 INSERT service_items 列 'sku_id'
 *       但 service_items 表无此列。create 走 fixture (createTestServiceOrder) 绕过；
 *       此 smoke 仅验证 start + complete + 幂等 路径。
 *       create 路径 bug 一旦修复（删除 sku_id 列引用），追加 smoke-service-create.mjs。
 */
```

`smoke-service-create.mjs` 已存在（line 5-8、line 62-63），它会 **真调** service.create 并对 message 关键字 `sku_id` 做断言报告，作为修复回归守护。修复后该 smoke 应直接 PASS，且 lifecycle.mjs 的 NOTE 注释可清理。

`helpers/fixtures.mjs:402-450` 的 `createTestServiceOrder` 直接 INSERT 至 PG（不经业务路径），其 INSERT 列清单本身就没有 sku_id，所以 fixture 端无需修改。"绕过"指的是测试不调云函数路由 `service.create`，并非 fixture 写了错误列。

## 2 修复方案

### 2.1 删除 SQL 列引用（唯一根因修复点）

`routes/service.js` 的 SELECT/局部变量/INSERT 三处协调修改：

| # | 行号 | 当前 | 修复后 |
|---|------|------|--------|
| 1 | 195 | 注释 `获取 sale_item 的 sku_id、unit_real_price...` | `获取 sale_item 的 unit_real_price...` |
| 2 | 197 | `SELECT si.sku_id, si.unit_real_price, ...` | `SELECT si.unit_real_price, ...` |
| 3 | 202 | `const skuId = siRows.rows[0]?.sku_id \|\| null` | **删除整行** |
| 4 | 210 | `..., sku_id, session_used, ...`（INSERT 列名） | `..., session_used, ...`（去掉 sku_id） |
| 5 | 211 | `VALUES ($1...$10)` | `VALUES ($1...$9)` |
| 6 | 217 | `skuId,`（参数 $5） | **删除整行**；其后参数自动前移到 $5~$9 |

### 2.2 同步修单元测试 mock

`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js` 修改点（grep 实证 sku_id 出现在 L57 / L237 / L268 / L273 / L325 / L394 / L1434 / L1479）：

| 行号 | 类型 | 现状 | 修复后 |
|------|------|------|--------|
| L57 | catch-all mock | `mockResolvedValue({ rows: [{ sku_id: 'sku-001', unit_real_price: '100' }], rowCount: 1 })` | 移除 `sku_id` 字段，仅保留 `unit_real_price`（统一风格，避免 review 困惑） |
| L237 | 测试用例 | `test('sale_item 无 sku_id 时快照为 null...')` | **删除整个 test 块**（理由：快照 null 兜底由 line 356 `sales_category=NULL` case 覆盖，无需重复） |
| L268 | 注释 | `INSERT service_orders + SELECT sku_id(null) + INSERT service_items` | `INSERT service_orders + SELECT 快照 + INSERT service_items` |
| L273 | mock 返回 | `{ sku_id: null, unit_real_price: null }` | `{ unit_real_price: null, is_shengmei: null, sales_category: null }` |
| L325 | mock 返回 | `{ sku_id: 'sku-001', ... }` | 移除 `sku_id` 字段（保留其他字段） |
| L394 | mock 返回 | `{ sku_id: 'sku-legacy', ... }` | 移除 `sku_id` 字段（保留其他字段） |
| L1434 | catch-all mock | `mockResolvedValue({ rows: [{ sku_id: 'sku-001', unit_real_price: '100' }], rowCount: 1 })` | 移除 `sku_id` 字段 |
| L1479 | catch-all mock | `mockResolvedValue({ rows: [{ sku_id: 'sku-001', unit_real_price: '100' }], rowCount: 1 })` | 移除 `sku_id` 字段 |

> 备注：L57 / L1434 / L1479 是 catch-all mock，对 INSERT 容忍 sku_id 残留不会失败，但与精确 mock 风格不一致，一并清理。

### 2.3 e2e 守护脚本切换

- `smoke-service-create.mjs` 修复后应直接 PASS。**额外清理任务**（避免 dead code 留作噪声）：
  - 删除 L5-8 的"⚠️ 当前已知生产 bug 守护"注释（bug 已修，注释过期）
  - 简化 L60-64 的 KNOWN BUG 报告分支（修复后 `createRes.code === 0` 永远走正常分支，错误分支保留过期文档）
- `smoke-service-lifecycle.mjs:1-15` 的 NOTE 注释删除（或改为"延续 service.create 后的 start/complete 验证"）。同时保留 fixture `createTestServiceOrder` 作为独立 fixture，不强求改用 service.create（fixture 路径更快、可造任意状态，仍有价值）
- `tests/e2e-cloudfn/run-all.mjs` 自动发现 `smoke-*.mjs`，`smoke-service-create.mjs` 已自动纳入 run-all（无需手动追加）

## 3 详细 patch（按文件）

### 3.1 `fengyu-staff/cloudfunctions/staffApi/routes/service.js`

```diff
     // 创建服务明细
     for (const item of normalizedItems) {
       const serviceItemId = generateServiceItemId()

-      // 获取 sale_item 的 sku_id、unit_real_price、is_shengmei、sales_category（全部快照拷贝到 service_items）
+      // 获取 sale_item 的 unit_real_price、is_shengmei、sales_category（全部快照拷贝到 service_items）
       const siRows = await client.query(
-        `SELECT si.sku_id, si.unit_real_price, si.is_shengmei, si.sales_category
+        `SELECT si.unit_real_price, si.is_shengmei, si.sales_category
          FROM sale_items si
          WHERE si.sale_item_id = $1`,
         [item.saleItemId]
       )
-      const skuId = siRows.rows[0]?.sku_id || null
       const unitRealPrice = siRows.rows[0]?.unit_real_price || null
       const isShengmei = siRows.rows[0]?.is_shengmei ?? null
       const salesCategory = siRows.rows[0]?.sales_category ?? null

       await client.query(
         `INSERT INTO service_items
            (service_item_id, sale_item_id, unit_real_price, service_order_id,
-            sku_id, session_used, employee_id, service_duration, is_shengmei, sales_category)
-         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
+            session_used, employee_id, service_duration, is_shengmei, sales_category)
+         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
         [
           serviceItemId,
           item.saleItemId,
           unitRealPrice,
           serviceOrderId,
-          skuId,
           item.sessionUsed,
           item.employeeId || resolvedStaffWfId,
           item.serviceDuration || null,
           isShengmei,
           salesCategory
         ]
       )
     }
```

> **Self-check（apply patch 前必做）**：删除 `skuId,` 一行后，参数数组共 **9 项**，对应 `$1~$9`，与 INSERT 列序逐一核对，确保占位符总数与参数总数严格一致。

修复后 INSERT 列序与参数序：

| $n | 列 | 来源 |
|----|----|------|
| $1 | service_item_id | `generateServiceItemId()` |
| $2 | sale_item_id | `item.saleItemId` |
| $3 | unit_real_price | 来自 sale_items 快照 |
| $4 | service_order_id | 当前生成的服务单号 |
| $5 | session_used | `item.sessionUsed` |
| $6 | employee_id | `item.employeeId || resolvedStaffWfId` |
| $7 | service_duration | `item.serviceDuration || null` |
| $8 | is_shengmei | 来自 sale_items 快照 |
| $9 | sales_category | 来自 sale_items 快照 |

### 3.2 `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js`

```diff
-    // pg.transaction #2: INSERT service_orders + SELECT sku_id(null) + INSERT service_items
+    // pg.transaction #2: INSERT service_orders + SELECT 快照 + INSERT service_items
     pg.transaction.mockImplementationOnce(async (cb) => {
       const client = {
         query: vi.fn()
           .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT service_orders
-          .mockResolvedValueOnce({ rows: [{ sku_id: null, unit_real_price: null }], rowCount: 1 })
+          .mockResolvedValueOnce({ rows: [{ unit_real_price: null, is_shengmei: null, sales_category: null }], rowCount: 1 })
           .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT service_items
       }
       return await cb(client)
     })
```

- 删除 line 237 `test('sale_item 无 sku_id 时快照为 null（line 183 || null 分支）', ...)`（整个测试用例移除，注明删除原因）

### 3.3 `fengyu-staff/tests/e2e-cloudfn/smoke-service-lifecycle.mjs`

```diff
 /**
- * service.start + complete 生命周期冒烟（绕过 service.create）
- *
- * NOTE：service.create 当前生产 bug — routes/service.js:207 INSERT service_items 列 'sku_id'
- *       但 service_items 表无此列。create 走 fixture (createTestServiceOrder) 绕过；
- *       此 smoke 仅验证 start + complete + 幂等 路径。
- *       create 路径 bug 一旦修复（删除 sku_id 列引用），追加 smoke-service-create.mjs。
+ * service.start + complete 生命周期冒烟（fixture 直造服务单，独立于 service.create）
+ *
+ * service.create 路径由 smoke-service-create.mjs 独立守护。
+ * 此处用 createTestServiceOrder fixture 直造 PG 记录，跳过业务校验以便测 start/complete 状态机。
  */
```

### 3.4 `fengyu-staff/tests/e2e-cloudfn/smoke-service-create.mjs`

修复后 smoke 自然 PASS，但**需清理 dead code**（避免后续维护误读）：

```diff
- /**
-  * smoke: service.create
-  * ⚠️ 当前已知生产 bug 守护
-  * 期望：修复 sku_id 列残留后 createRes.code === 0
-  */
+ /**
+  * smoke: service.create — 验证服务单创建路径
+  */

  ...

- if (createRes.code !== 0) {
-   // ⚠️ KNOWN PROD BUG: service_items 表无 sku_id 列
-   errors.push(`service.create FAIL: ${createRes.message}（可能仍是 sku_id 残留 bug）`)
-   return { name: 'smoke-service-create', errors }
- }
+ if (createRes.code !== 0) {
+   errors.push(`service.create FAIL: ${createRes.message}`)
+   return { name: 'smoke-service-create', errors }
+ }
```

实际行号以 grep `KNOWN` / `sku_id` / `⚠️` 命中为准（L5-8 注释 + L60-64 错误分支）。

## 4 验证 Checklist

- [ ] grep `service_items.*sku_id` 在 `fengyu-staff/cloudfunctions/` 命中 0 次（除已删除的注释/旧 mock）
- [ ] **硬断言**：`grep -rn 'sku_id' fengyu-staff/cloudfunctions/staffApi/routes/service.js | wc -l` 必须 = `0`
- [ ] grep `sku_id` 在 `routes/service.js` 命中 0 次（确认无残留）
- [ ] `cd fengyu-staff/cloudfunctions/staffApi && npm test -- service.test.js` PASS（含修过 mock 的 case）
- [ ] `cd fengyu-staff/tests/e2e-cloudfn && bun smoke-service-create.mjs` PASS（线上数据库或本地 PG）
- [ ] `cd fengyu-staff/tests/e2e-cloudfn && bun smoke-service-lifecycle.mjs` 保持 PASS（不应回归）
- [ ] `cd fengyu-staff/tests/e2e-cloudfn && bun run-all.mjs` 全绿
- [ ] 部署后小程序端实测：店长账号"护理 → FAB → 创建服务单"完整走通，PG `service_items` 有新行落库
- [ ] PG 实测：`\d service_items` 不含 sku_id 列；新插入行各列符合 §3.1 序号映射
- [ ] admin `fengyu-admin/src/actions/services.ts` SELECT 仍正常（确认未误删依赖字段）

## 5 风险与回滚

| 风险点 | 评估 | 缓解 |
|--------|------|------|
| 历史数据是否有 sku_id 残留行 | **无** — 表无此列，从未写入成功 | N/A |
| 是否有下游消费 service_items.sku_id | **无** — grep 全仓 0 命中 | N/A |
| admin 端查询 service_items 是否要联 sku | 否，admin 已通过 `service_items.sale_item_id → sale_items.sku_id` 链路读取 | 无需改 |
| admin seed.ts service_items 写入是否也误写 sku_id | **否** — `fengyu-admin/src/db/seed.ts:387-388` 实地查证仅 console.log，无 sku_id 字段写入 | OK |
| 修复后 service.create 还有其它隐藏 bug | smoke-service-create.mjs 同时验证家居拒、appointment 关联、快照写入正确性 | 修复一并跑 |

**回滚**：纯应用层 4 行 SQL 字符串改动，无 schema/数据迁移，回退 PR 即恢复。

## 6 关联

| 项 | 说明 |
|----|------|
| 来源 | [SUMMARY v3 §2 Top10 #2](../../docs/audit/SUMMARY.md) |
| 关联 audit | audit-05 P0-05-01（服务单 schema vs 实现 drift）、audit-CC9 P0-CC9-01（云函数 SQL 字段一致性） |
| 关联 schema | `db/schema/service.ts` `serviceItems`、`db/migrations/0000_baseline.sql:292`、`0008_aspiring_pride.sql`、`0011_misty_nebula.sql` |
| 关联 e2e | `fengyu-staff/tests/e2e-cloudfn/smoke-service-create.mjs`（守护）、`smoke-service-lifecycle.mjs`（绕过注释清理） |
| 关联 unit | `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/service.test.js`（mock 同步）|
| 部署 | 改完 `cloudfunctions/staffApi`，按 `/cloudbase-deploy` 流程 `tcb fn code update`（**禁止 --force**，避免冲掉 `ALLOW_TEST_OPENID` / `PG_CONNECTION_STRING` 等环境变量） |

---

## 复核反馈（R2，2026-05-17）

**Block 级问题**（实施会失败 / 高优）：
- **§3.1 patch 在事务回调内有未对齐的右括号**：原 SQL 是 `WHERE si.sale_item_id = $1`，前导留 9 个空格（因外层 `client.query(` 套 `\`...\``）；ticket diff 内 `+ FROM sale_items si` 行只给 8 个空格，apply 后会引发 SQL 字符串风格不一致（视觉），但更要紧的是 patch 演示未把 INSERT 后续参数行（`item.sessionUsed,` 等）下移；实际应用必须确认删除 `skuId,` 那一行后剩余 9 个参数与 `$1~$9` 一一对应（参数总数与占位符必须严格一致）。

**Warn 级问题**（实施可能不完整 / 中优）：
- **遗漏的 mock 修改点**：ticket 只点名 `service.test.js:268-277, 237`，但实际还有 `line 57`、`line 1434`、`line 1479` 三处也 mock 返回了 `{ sku_id, unit_real_price }`，未列入修改清单。这三处当前 mock 对 INSERT 是 catch-all，不会因 sku_id 残留而失败，但保留会与 §2.2 风格不一致，回归 review 时易混淆是否修复彻底。
- **§2.2 误判删除 line 237 测试理由**：注释写"该分支不再存在"——实际 `siRows.rows[0]?.unit_real_price || null` 分支仍在（用 `|| null` 兜底），仅 `skuId` 局部变量整体消失。删除该 case 应改述"快照 null 兜底由 line 356 'sales_category=NULL' case 覆盖，无需重复"，更准确。
- **smoke-service-create.mjs 注释清理未列入 Checklist**：line 5-8 的"⚠️ 当前已知生产 bug 守护"注释 + line 60-64 的 KNOWN BUG 报告分支在修复后变成 dead code，ticket §2.3 / §3.4 说"无需改动"——可运行但保留过期文档对后续维护是噪声，建议补"删除 bug 守护注释 + 简化错误分支"任务。
- **§5 风险表"无下游消费"未覆盖 admin/seed**：grep 显示 `fengyu-admin/src/db/seed.ts:387-388` 也有 service_items 写入（seed 路径），ticket 未确认 seed 是否同样误写 sku_id。已实地查 seed 该处仅打 console.log，无 sku_id 字段写入，OK，但 ticket 该判断应留一行实证而非空白。

**OK**（确认无问题的关键事项）：
- service_items schema 确无 sku_id（grep 0 命中 baseline/0008/0011/0028+）。
- 全仓 INSERT INTO service_items 共 4 处：staff service.js（bug 本体）、staff fixtures.mjs（无 sku_id 列，OK）、client list-detail.spec.mjs（test fixture，无 sku_id 列，OK）。admin 无 INSERT。
- list/detail/staff 提成/mgmt-dashboard 多处 `service_items sit JOIN sale_items si` 读 sku_id，全从 sale_items 取，对 `service_items.sku_id` 零反向依赖。
- run-all.mjs 自动发现 `smoke-*.mjs`，smoke-service-create.mjs 自动纳入，§2.3 "若没有需追加" 不必要但无害。
- frontmatter 完整（生成日期/状态/优先级/端/成本/来源/关联 e2e 齐全），无 schema 变更任务（符合 db/CLAUDE.md "禁直接 ALTER"）。

**改进建议**：
- §3.1 diff 块加一行"删后参数数组共 9 项，对应 `$1~$9`，与 INSERT 列序逐一核对"作为 self-check 提示。
- Checklist 增加 `grep -rn 'sku_id' fengyu-staff/cloudfunctions/staffApi/routes/service.js | wc -l` 应 = 0 的硬断言。
- §6 关联补充 `smoke-service-create.mjs` 注释清理为后续清扫项（避免日后误读 bug 还在）。
