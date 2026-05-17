# Ticket: 单次卡多数量未拆为 N 行 — 列表合并为 1 行 bug

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（影响卡核销 / 转换单按张选卡的核心场景） |
| 端 | fengyu-staff（`staffApi.order.create` 写入侧）+ fengyu-admin（`/cards` 列表读侧） |
| 修复成本 | **M**（需改下单逻辑 + 历史数据拆分迁移） |
| 来源 | meeting-20260423 §三 Bug 2 |
| 关联代码 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:284-311`（写入 sale_items 用 quantity）|

---

## 0 一句话背景

会议示例：顾客同一项目购买 **10 张单次卡**（如"单次身体护理 ×10"），期望在"疗程卡管理"列表展示 **10 行独立卡**（每张独立疗程，可单独转换/核销）。实际只展示 **1 行**，数量也错。

会上张凯怀疑是"按名字 + 规格合并"，夜航星澄清"不是按名字并的，是 Bug"。本 ticket 定位为**写入侧 bug**：staffApi.order.create 把"单次卡 ×10" 写成 1 行 `quantity=10 / session_count=10`，而单次卡的业务语义是 N 张独立卡 = N 行 `quantity=1 / session_count=1`。

---

## 1 现状（grep 实证）

### 1.1 写入侧（staffApi/routes/order.js:284-311）

```js
const quantity = item.quantity || 1
// sale_items.session_count / remaining_sessions 是"次"维度（service.complete 按次扣减），
// 应 = sku.session_count × quantity；之前漏乘 quantity 导致剩余次数显示 1/1 而非 N/N
if (sessionCount != null) sessionCount = sessionCount * quantity   // ← bug 现场
const saleAmount = unitPrice * quantity
// ... 单行 INSERT，quantity 字段直接写 quantity
```

**问题诊断**：
- 该逻辑对**疗程卡**（如"10次卡 ×2"= 1 行 sessionCount=20）是**正确**的——一张多次卡的"次"可以汇总
- 但对**单次卡**（session_count=1）来说，"10 张单次卡"**应该是 10 张独立卡**，每张独立扣减/转换。当前把 10 张写成 1 行 sessionCount=10 → 列表合并、转换时只能整张转、核销时按次扣实质等同于"一张 10 次卡"

### 1.2 读侧（cards.ts:106-110）

```ts
if (filters.type === '疗程卡') {
  conditions.push(gte(saleItems.sessionCount, 2))
} else if (filters.type === '单次卡') {
  conditions.push(eq(saleItems.sessionCount, 1))
}
```

读侧按 `sessionCount` 判定"单次卡 vs 疗程卡"。当前写入侧把"10 张单次卡"算成 `sessionCount=10` → 被读侧判定为"疗程卡"，标签错乱（详见 `cards-page.tsx:141`）。

### 1.3 业务语义对照

| 场景 | sku.sessionCount | quantity | 期望 sale_items 行数 | 期望 session_count/行 |
|------|------------------|----------|----------------------|----------------------|
| 单次卡 ×10 | 1 | 10 | **10 行**（每张独立卡）| 1 |
| 10 次卡 ×2 | 10 | 2 | **2 行**（每张独立卡）| 10 |
| 10 次卡 ×1 | 10 | 1 | 1 行 | 10 |
| 单品（家居）×10 | null | 10 | **1 行** quantity=10 | null（家居走 picked_up_quantity） |

→ **核心规则**：对 `product_type IN ('疗程卡')` 的 SKU（无论 sessionCount 是 1 还是 N），开单时应**按 quantity 拆 N 行**，每行 quantity=1 / session_count=sku.sessionCount。家居产品（productType='家居产品'）继续合行（quantity 累加）。

---

## 2 修复方案

### 2.1 PR-1：staffApi.order.create 拆行（仅疗程卡 SKU）

**文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:243-330`

**改动**：

```js
// 在 items 拼装阶段（约 line 283 之后）
const expandedItems = []
for (const item of items) {
  if (item.productType === '疗程卡' && (item.quantity || 1) > 1) {
    // 拆 N 行：每行 quantity=1 / session_count = sku.sessionCount（不再 × N）
    const n = item.quantity
    for (let i = 0; i < n; i++) {
      expandedItems.push({ ...item, quantity: 1, _splitFromBatch: true, _splitIndex: i, _splitTotal: n })
    }
  } else {
    expandedItems.push(item)
  }
}
// 后续用 expandedItems 替换 items，sale_item_id 仍各自生成
```

**注意事项**：
- `sale_item_id` 序号 `FY-FXSDM-WX-{YYMMDD}{8位}` 已有 advisory lock，N 行各申请一个序号
- `sale_allocations` 是按 sale_item_id 维度的，拆 10 行后会有 10 行 allocation —— 业务允许（每张卡独立分配）
- 折扣/优惠券分摊：原来按 1 行均摊；拆后需在每行均摊 `discount / n`，确保 sum 不变
- 储值卡抵扣金额同理需按行均摊
- E2E 验证：开 1 单 "单次卡 ×10" → sale_items COUNT = 10；sale_allocations COUNT 同步 = 10；total_amount = 单价 × 10

### 2.2 PR-2：admin/createOrder 同步改造（如 admin 也支持开单）

**文件**：`fengyu-admin/src/actions/orders.ts`

同 PR-1 的拆行逻辑；admin 开单与 staff 走同一规则，由 `cross-end-sql-snapshot.test.js` 守护一致性。

### 2.3 PR-3：历史数据拆分迁移（一次性脚本）

**文件**：`db/scripts/split-merged-single-cards.js`

逻辑：

```sql
-- 找出"单次卡被合并"的历史行：sku.session_count=1 AND sale_items.quantity > 1
WITH offenders AS (
  SELECT si.sale_item_id, si.sale_order_id, si.quantity, sk.session_count AS sku_sc
  FROM sale_items si
  JOIN product_skus sk ON sk.sku_id = si.sku_id
  WHERE si.product_type = '疗程卡'
    AND sk.session_count = 1
    AND si.quantity > 1
)
-- 对每行：
-- 1. 拆 N-1 个新 sale_items（复制所有字段，quantity=1, session_count=1, remaining_sessions = MIN(remaining_sessions, 1)）
-- 2. 原行更新 quantity=1, session_count=1, remaining_sessions=1
-- 3. 按比例拆分 sale_allocations + sale_order_payments 引用（如有）
-- 注：service_items 已发生核销的拆分按比例分配 remaining_sessions
```

**风险点**：
- 已部分核销的卡（remaining_sessions < quantity）需要业务确认怎么拆（先核销的算哪张）。
- 默认策略：按"先满后空"拆——前 K 张 remaining_sessions=1，后 N-K 张 remaining_sessions=0（K = 原 remaining_sessions）。
- 已绑定 service_items 的引用：service_items.sale_item_id 改指拆后的某一张。

→ 迁移前必须**生产库 dump 备份** + 在 docker 临时 PG 上 dry-run。

### 2.4 PR-4：读侧防御（cards.ts）

在 §2.1 修完之前，前端列表展示"数量 × N"——临时补丁，避免错乱。修完后移除。

```ts
// cards-page.tsx 渲染层（约 line 141 周边）
const label = (row.sessionCount ?? 0) === 1
  ? `单次卡${row.quantity > 1 ? ` ×${row.quantity}` : ''}`
  : `${row.sessionCount}次卡`
```

→ 这是兜底显示，根治在 §2.1。

---

## 3 验收标准（DoD）

- [ ] PR-1：单次卡 ×10 开单 → sale_items COUNT(*)=10；每行 quantity=1 / session_count=1 / remaining_sessions=1
- [ ] PR-1：10次卡 ×2 开单 → sale_items COUNT(*)=2；每行 quantity=1 / session_count=10 / remaining_sessions=10
- [ ] PR-1：家居 ×10 开单 → sale_items COUNT(*)=1；quantity=10 / session_count=null
- [ ] PR-1：折扣/优惠券抵扣金额 sum 守恒（拆前后 total_amount / received 一致）
- [ ] PR-2：admin/createOrder 同上 3 测试通过
- [ ] PR-3：dry-run 输出"被拆 N 行 → 拆为 M 行"统计；执行后 `cards.ts` 列表的"单次卡"展示数 = 原合并行 quantity 之和
- [ ] `archives/2026-04-26-sale-order-domain-refactor.md` 中"按 sale_item 维度"的 6 通道（payments / allocations / refund-cascade / pickup / service / commission）仍跑通

---

## 4 风险与回滚

| 风险 | 缓解 |
|------|------|
| sale_items 行数 ×N 倍 → 列表分页 / dashboard 聚合 SQL 性能下降 | 监控 cards 列表 query plan；如有需要在 `(product_type, item_direction, store_id)` 加复合索引 |
| 历史数据拆分时 service_items 引用断裂 | 迁移脚本同事务更新 service_items.sale_item_id；dry-run 必出"将影响 X 条 service_items" 报告 |
| 折扣均摊浮点误差 | 用 `Math.round(... * 100) / 100`，并把最后一行的尾差吸收 |

回滚：
- PR-1/PR-2 代码：commit revert
- PR-3 数据：迁移前 dump；问题严重时 `pg_restore` 局部表

---

## 5 关联

| 项 | 说明 |
|----|------|
| 来源 | `notes/meetings/meeting-20260423/article.md` §三 Bug 2 |
| 关联代码 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:243-330` / `fengyu-admin/src/actions/cards.ts:106-110` |
| 关联 ticket | `archives/2026-04-26-sale-order-domain-refactor.md`（按 sale_item 维度模型）|
| 相邻 ticket | `2026-05-18-treatment-card-listing-filter-audit.md`（B1 列表过滤问题，先排查再修本 ticket） |
