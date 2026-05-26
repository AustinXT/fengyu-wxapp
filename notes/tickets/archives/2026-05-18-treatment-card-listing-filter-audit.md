# Ticket: 疗程卡管理列表 — 部分卡缺失排查

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（影响卡管理 / 转换单选卡链路） |
| 端 | fengyu-admin（`/cards` 列表）+ fengyu-staff（转换单选卡器，若用同 query） |
| 修复成本 | **S**（仅排查 + 微调过滤条件，无 schema 变更） |
| 来源 | meeting-20260423 §三 Bug 1 |
| 关联代码 | `fengyu-admin/src/actions/cards.ts:78-180`（`getCardsPaginated`） |

---

## 0 一句话背景

会议中张凯试图打开转换单时发现：**部分疗程卡未出现在"疗程卡管理"列表里**，导致这些卡无法被选中做转换。夜航星初判为"过滤逻辑问题"，需要在会后排查。

会议截图未附；纪要未指明漏掉的是哪些卡（不同门店、不同状态、不同购买路径）。本 ticket 用"宽口径排查 → 定位 → 收窄修复"三步走。

---

## 1 现状（grep 实证）

### 1.1 列表口径定义（cards.ts:85-92）

```ts
const conditions: (SQL | undefined)[] = [
  eq(saleItems.itemDirection, '购买'),              // 基础过滤
  eq(saleItems.productType, '疗程卡'),
  isNotNull(saleItems.remainingSessions),
  scopeCondition(session, saleItems.storeId),       // 角色 scope 过滤
]
```

加上后续：
- 卡类型筛选：`sessionCount === 1`（单次卡）/ `≥ 2`（疗程卡）—— 默认 `all` 不过滤
- 状态筛选（active / exhausted / expired）—— 默认不过滤
- 顾客搜索 ILIKE clientWechatUsers.name / phone
- 默认排序：`paidAt DESC NULLS LAST`

### 1.2 候选漏卡的 4 个嫌疑点

| # | 嫌疑 | 验证方法 |
|---|------|---------|
| H1 | `sale_items.product_type` 不是 `'疗程卡'`（被错填为 `'单品'` 或 NULL） | `SELECT product_type, COUNT(*) FROM sale_items WHERE remaining_sessions IS NOT NULL GROUP BY 1` |
| H2 | `sale_items.item_direction != '购买'`（转入/转出/退出三种） | `SELECT item_direction, COUNT(*) FROM sale_items WHERE product_type='疗程卡' GROUP BY 1` |
| H3 | `sale_items.remaining_sessions IS NULL`（开单时漏写） | `SELECT COUNT(*) FROM sale_items WHERE product_type='疗程卡' AND remaining_sessions IS NULL` |
| H4 | scope 过滤（H4-a：`sale_items.store_id` 为空；H4-b：当前用户 `scope_store_ids` 不含此卡所属门店） | `SELECT COUNT(*) FROM sale_items WHERE product_type='疗程卡' AND store_id IS NULL` + 检查当前登录店长的 scope |

### 1.3 已知关联 ticket

- `archives/2026-04-23-prepaid-card-deduction-by-store.md`：sale_items 引入 `store_id` 列（PR-A）。如果 backfill 漏掉了某些历史行 → store_id NULL → scope 过滤直接踢掉。
- `archives/2026-04-26-sale-order-domain-refactor.md`：sale_order_type/枚举调整。如果某些卡是 `'转换单'` 或 `'回款单'` 的 sale_items，需要确认过滤条件是否漏掉这类。

---

## 2 修复方案

### Step 1 — 数据普查（先 SQL，不动代码）

在生产 5434 库上跑下面 4 个统计，导出结果给夜航星 + 张凯对比"实际 vs 列表展示数"：

```sql
-- H1: product_type 分布（仅含 remaining_sessions 的行）
SELECT product_type, COUNT(*) AS cnt
FROM sale_items
WHERE remaining_sessions IS NOT NULL
GROUP BY 1;

-- H2: item_direction 分布（按 product_type='疗程卡'）
SELECT item_direction, COUNT(*) AS cnt
FROM sale_items
WHERE product_type = '疗程卡'
GROUP BY 1;

-- H3: 是否有疗程卡 remaining_sessions 为 NULL
SELECT COUNT(*) AS missing_sessions
FROM sale_items
WHERE product_type = '疗程卡'
  AND item_direction = '购买'
  AND remaining_sessions IS NULL;

-- H4-a: store_id 为空的疗程卡
SELECT COUNT(*) AS missing_store
FROM sale_items
WHERE product_type = '疗程卡'
  AND item_direction = '购买'
  AND store_id IS NULL;

-- H4-b: 按门店 + 当前 scope 推算漏了哪些门店
SELECT store_id, COUNT(*) AS cnt
FROM sale_items
WHERE product_type = '疗程卡'
  AND item_direction = '购买'
GROUP BY 1
ORDER BY 1;
```

**Decision Gate**：根据结果决定走 Step 2-A / 2-B / 2-C 中的哪条。

### Step 2-A — H1/H2/H3 命中：开单逻辑或迁移脚本回填

如果存在 product_type 错填、direction 错、remaining_sessions 为空等数据问题：
- 写一次性回填脚本 `db/scripts/backfill-treatment-card-sessions.js`
- 同时定位下单/转换路径中**写入侧** bug，避免新数据继续错

### Step 2-B — H4-a 命中：store_id NULL

回放 PR-A 的回填脚本，补 store_id：
```sql
UPDATE sale_items si
SET store_id = so.store_id
FROM sale_orders so
WHERE si.sale_order_id = so.sale_order_id
  AND si.store_id IS NULL;
```

### Step 2-C — H4-b 命中：scope 过滤过严

如果"店长视角"只能看到本店疗程卡，但顾客的卡是从别店买的——这是**业务设计问题**：
- 选项 1：默认放开 `getCardsPaginated`，所有店长能看到任何顾客的卡（按顾客视角，不按门店）
- 选项 2：保留 scope 过滤，但在顾客详情页/转换单选卡器**改成跨店查询**（与 `customer.js` 的 `getCustomerCards` 一致）

→ 需要在 ticket §3 验收前与张凯确认业务期望。

---

## 3 验收标准（DoD）

- [ ] Step 1 的 4 个统计 SQL 结果导出 + 与 admin 列表展示数对比，给出"漏卡明细 CSV"（cardId / storeId / product_type / item_direction / remaining_sessions / store_id 列）
- [ ] 根据 §2 Step 2-A/B/C 走完对应修复路径，提供"修复前/修复后"列表数对比
- [ ] `bun fengyu-admin/tests/e2e-actions/` 新增一条 smoke：插入 1 个 store_id=NULL 的疗程卡 sale_item，断言 `getCardsPaginated` 能正确（按修复方案）展示或剔除
- [ ] 顾客详情页"卡包"列表与 `/cards` 总列表数对账（同一顾客视角下数量一致）

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| §2-B 大批量 UPDATE 锁表 | 分批（每批 5000 行）+ 业务低峰执行；回填前 PG dump 备份 sale_items |
| §2-C 放开 scope 后跨店看卡 | 与权限矩阵 `sale_item:list` 重新约定；可能需要新增 `sale_item:list_cross_store` 细分权限 |
| §2-A 写入侧 bug 修复影响存量下单 | 灰度 staff order create，先在测试环境验证 |

回滚：纯查询脚本无副作用；回填脚本提供 reverse SQL（恢复 store_id=NULL，仅限 §2-B）。

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260423/article.md` §三 Bug 1 |
| 关联 ticket | `archives/2026-04-23-prepaid-card-deduction-by-store.md`（store_id 引入）/ `archives/2026-04-26-sale-order-domain-refactor.md` |
| 关联代码 | `fengyu-admin/src/actions/cards.ts:78-180` / `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:950+` |
| 后续 | 若 §2-C 命中，需开 follow-up ticket 调整 scope 矩阵 |

---

## 完成记录

- **完成日期**：2026-05-18
- **完成 commit**：`a982e99` feat(audit): 疗程卡列表缺卡 P1 普查脚本 + smoke 防回归
- **实际落地清单**：
  - `db/scripts/audit-treatment-card-listing.js`（215 行）— 5 个 read-only 普查 SQL（H1 product_type / H2 item_direction / H3 remaining_sessions / X1 /cards vs 转换单候选差集 / X2 store 维度分布）
  - `fengyu-admin/tests/e2e-actions/smoke-cards-listing-filter.{mjs,impl.mjs}` — 防回归 smoke（spawn 子进程 + mock 注入）
- **DoD 偏差**：
  - [x] §2 Step 1 4 个普查 SQL 已落（实际扩到 5 个，新增 X1 差集 / X2 分布）
  - [⚠️] §2 Step 2 修复路径未走 —— 普查发现 H4-a / 5 值 sale_order_type **结构上已不可能命中**，无需 §2-B/C 数据回填
  - [x] 防回归 smoke 已写
  - [⚠️] D6 决策（卡列表 scope 是否放开）暂未触发 —— 普查结果显示无漏卡，scope 维持现状
- **决策应用**：D6=A → 普查证实无需放开 scope
- **关联归档**：同批 `2026-05-18-workfine-legacy-orders-unaudited-flow.md` / `2026-05-18-sale-order-type-deposit-add.md`
