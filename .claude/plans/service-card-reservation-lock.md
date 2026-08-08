# 服务期间疗程卡预扣锁定机制

## 问题分析

### 当前问题
用户截图显示：服务单 FY-FW-2608050001 处于"待确认"状态，点击"代客户确认"时报错：
```
订单行 XSLSH-WX-20260805O0001 剩余次数不足 1
```

**根本原因**：服务单状态流转与次数扣减时机错配导致的并发竞态条件：

1. **当前流程**：
   - `待服务` → `service.start()` → `服务中`（无副作用）
   - `服务中` → `service.complete()` → `待客户确认`（无副作用）
   - `待客户确认` → `service.confirm()` / 顾客确认 → `已完成`（**此时才扣减次数**）

2. **并发窗口**：
   - 服务单从"待服务"到"已完成"整个生命周期中，疗程卡的 `remaining_sessions` 都未被锁定
   - 在服务期间，该疗程卡可以被：
     - 其他服务单消耗
     - 转换单折抵（`createConversion` 会原子置 `remaining_sessions=0`）
     - 退款审批通过后回滚（虽然有 `assertNoPendingRefund` 防护）

3. **用户场景复现**：
   - T1: 创建服务单 A（疗程卡剩余 1 次），状态=待服务
   - T2: 开始服务，状态=服务中
   - **T3: 创建转换单 B，使用该疗程卡折抵，remaining_sessions 被置 0**
   - T4: 完成服务，状态=待客户确认
   - T5: 确认服务 → 报错"剩余次数不足"

### 当前代码位置

**服务单次数扣减**（3 处独立副本，snapshot 守护）：
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js` - `finalizeServiceOrder()`
- `fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js`
- `fengyu-admin/src/services/services.ts` - `confirmServiceOrder()`

**转换单次数扣减**（即时扣减，无预扣）：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` - `createConversion()`，第 3517 行
- `fengyu-admin/src/actions/orders.ts` - `createConversionOrder()`

**当前原子扣减 SQL**（`finalizeServiceOrder` L46-52）：
```sql
UPDATE sale_items
SET remaining_sessions = remaining_sessions - $1
WHERE sale_item_id = $2
  AND remaining_sessions >= $1
  AND remaining_sessions IS NOT NULL
  AND (session_count - remaining_sessions + $1) <= COALESCE(paid_sessions, session_count)
```

**转换单原子扣减 SQL**（`createConversion` L3517）：
```sql
UPDATE sale_items
  SET remaining_sessions = 0, updated_at = $1
WHERE sale_item_id = $2
  AND store_id = $3
  AND COALESCE(remaining_sessions, 0) >= $4
```

## 解决方案设计

### 方案选择：服务预扣机制（预留 + 确认两阶段）

**核心思路**：将服务单的次数消耗分为两个阶段：
1. **预扣阶段**：服务开始时（`service.start`），在 `service_items` 表记录预扣次数，转换单/退款需要考虑预扣
2. **确认阶段**：服务确认时（`service.confirm` / 顾客确认），将预扣转为正式扣减

### 数据库 Schema 变更

**新增字段**（`service_items` 表）：
```sql
ALTER TABLE service_items 
ADD COLUMN reserved_at timestamptz;  -- 预扣时间戳，NULL=未预扣
```

**语义**：
- `reserved_at IS NULL`：未预扣（旧服务单、或"待服务"状态）
- `reserved_at IS NOT NULL`：已预扣（"服务中"/"待确认"/"已完成"状态）

**为什么不用独立的 `is_reserved` 布尔字段**？
- `reserved_at` 可记录预扣时刻，便于审计和调试
- 避免布尔字段与状态不一致的维护负担
- 时间戳可用于未来的超时释放机制（如服务单超过 24 小时未完成自动释放）

### 业务逻辑变更

#### 1. 服务开始时预扣（`service.start`）

**位置**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js` - `service.start` 方法

**原逻辑**：
```javascript
// 仅更新服务单状态，无副作用
UPDATE service_orders 
SET status = '服务中', started_at = $1, updated_at = $1 
WHERE service_order_id = $2 AND status = '待服务'
```

**新逻辑**：
```javascript
await pg.transaction(async (client) => {
  // 1. 加载服务明细（含 sale_item 关联）
  const items = await loadServiceItems(serviceOrderId)
  
  // 2. 逐行校验剩余次数（考虑已有预扣）
  for (const item of items) {
    const checkRes = await client.query(`
      SELECT si.remaining_sessions,
             si.session_count,
             si.paid_sessions,
             COALESCE(SUM(sit.session_used), 0) AS total_reserved
      FROM sale_items si
      LEFT JOIN service_items sit ON sit.sale_item_id = si.sale_item_id
        AND sit.reserved_at IS NOT NULL
        AND sit.service_order_id != $2  -- 排除当前服务单（幂等重入）
      WHERE si.sale_item_id = $1
      GROUP BY si.sale_item_id, si.remaining_sessions, si.session_count, si.paid_sessions
    `, [item.sale_item_id, serviceOrderId])
    
    const row = checkRes.rows[0]
    const available = row.remaining_sessions - row.total_reserved
    if (available < item.session_used) {
      throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.sale_item_id} 可用次数不足（剩余 ${row.remaining_sessions}，已预留 ${row.total_reserved}，本次需 ${item.session_used}）`)
    }
    
    // paid_sessions 限额校验（与 finalizeServiceOrder 一致）
    if (row.session_count != null) {
      const paid = row.paid_sessions == null ? Number(row.session_count) : Number(row.paid_sessions)
      if (paid <= 0) {
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.sale_item_id} 尚未支付，无可用次数`)
      }
      const usedNow = Number(row.session_count) - Number(row.remaining_sessions)
      const usedAfter = usedNow + Number(item.session_used)
      if (usedAfter > paid) {
        throw new Error(`INSUFFICIENT_BALANCE: 订单行 ${item.sale_item_id} 已支付次数不足`)
      }
    }
  }
  
  // 3. 更新服务单状态
  const updateResult = await client.query(
    "UPDATE service_orders SET status = '服务中', started_at = $1, updated_at = $1 WHERE service_order_id = $2 AND status = '待服务'",
    [now, serviceOrderId]
  )
  if (updateResult.rowCount === 0) {
    throw new Error('INVALID_STATE: 服务单状态已变更')
  }
  
  // 4. 标记预扣（幂等：ON CONFLICT DO UPDATE）
  for (const item of items) {
    await client.query(`
      UPDATE service_items
      SET reserved_at = $1, updated_at = $1
      WHERE service_item_id = $2
    `, [now, item.service_item_id])
  }
  
  await logTransition(client, ctx, 'service.start', 'service_order', serviceOrderId, '待服务', '服务中')
})
```

#### 2. 服务确认时转正（`finalizeServiceOrder`）

**位置**：3 处独立副本
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js`
- `fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js`
- `fengyu-admin/src/services/services.ts`

**变更**：扣减 SQL 无需修改（已有原子性保护），但需在事务开始时清除预扣标记：

```javascript
async function finalizeServiceOrder(client, so, items, ctx, now) {
  const serviceOrderId = so.service_order_id

  // 0. 清除预扣标记（确认前，防止重复计入预扣统计）
  // 注：必须在扣减前清除，否则 available 计算会重复减去本服务单的 session_used
  await client.query(`
    UPDATE service_items
    SET reserved_at = NULL, updated_at = $1
    WHERE service_order_id = $2
  `, [now, serviceOrderId])

  // 1. 原子扣减（保持不变）
  for (const item of items) {
    const updateResult = await client.query(
      `UPDATE sale_items
       SET remaining_sessions = remaining_sessions - $1
       WHERE sale_item_id = $2
         AND remaining_sessions >= $1
         AND remaining_sessions IS NOT NULL
         AND (session_count - remaining_sessions + $1) <= COALESCE(paid_sessions, session_count)`,
      [item.session_used, item.sale_item_id]
    )
    
    if (updateResult.rowCount === 0) {
      // 错误提示需更新：可能是预扣冲突
      const checkRows = await client.query(/*...省略...*/)
      // ... 原有错误处理保持不变 ...
    }
    // ... 剩余逻辑保持不变 ...
  }
  // ... 提成计算、状态更新等保持不变 ...
}
```

#### 3. 服务取消时释放预扣（`service.cancel`）

**位置**：`fengyu-staff/cloudfunctions/staffApi/routes/service.js` - `service.cancel` 方法

**新增逻辑**：
```javascript
await pg.transaction(async (client) => {
  // 1. 更新服务单状态
  const updateResult = await client.query(
    "UPDATE service_orders SET status = '已取消', updated_at = $1 WHERE service_order_id = $2 AND status IN ('待服务', '服务中')",
    [now, serviceOrderId]
  )
  if (updateResult.rowCount === 0) {
    throw new Error('INVALID_STATE: 服务单状态不允许取消')
  }
  
  // 2. 释放预扣（清除 reserved_at）
  await client.query(`
    UPDATE service_items
    SET reserved_at = NULL, updated_at = $1
    WHERE service_order_id = $2
  `, [now, serviceOrderId])
  
  await logTransition(client, ctx, 'service.cancel', 'service_order', serviceOrderId, originalStatus, '已取消')
})
```

#### 4. 转换单需考虑预扣次数（`createConversion`）

**位置**：
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` - `createConversion()`
- `fengyu-admin/src/actions/orders.ts` - `createConversionOrder()`

**变更**：在锁定候选卡时，查询需排除已预扣的次数：

```javascript
// 原查询（L3295）
const heldResult = await tx.query(
  `SELECT si.sale_item_id,
          si.remaining_sessions,
          ...
   FROM sale_items si
   WHERE si.sale_item_id = ANY($1)
   FOR UPDATE OF si`,
  [convertOutSaleItemIds]
)

// 新查询（带预扣统计）
const heldResult = await tx.query(
  `SELECT si.sale_item_id,
          si.remaining_sessions,
          COALESCE(SUM(sit.session_used) FILTER (WHERE sit.reserved_at IS NOT NULL), 0) AS total_reserved,
          ...
   FROM sale_items si
   LEFT JOIN service_items sit ON sit.sale_item_id = si.sale_item_id
   WHERE si.sale_item_id = ANY($1)
   GROUP BY si.sale_item_id, si.remaining_sessions, ...
   FOR UPDATE OF si`,
  [convertOutSaleItemIds]
)

// 校验改为减去预扣
for (const row of held.rows) {
  const available = Number(row.remaining_sessions || 0) - Number(row.total_reserved || 0)
  if (productType === '疗程卡') {
    if (available <= 0) {
      throw new Error('INVALID_PARAMS: 部分卡可用次数不足（存在服务中预留）')
    }
    qty = available  // 折抵数量改为"可用次数"而非"剩余次数"
  }
}
```

**注意**：转换单仍然是"整卡折抵"，但折抵数量从 `remaining_sessions` 改为 `remaining_sessions - total_reserved`（可用次数）。

#### 5. 退款审批需防护服务预扣（`order.createRefund` / `order.approveRefund`）

**当前已有防护**：`assertNoPendingRefundByServiceOrder` - 服务单存在时禁止退款

**增强防护**：在 `order.createRefund` 中增加预扣检测：

```javascript
// 在 createRefund 开始处（L2400 附近）
// 防护：疗程卡有服务中预扣时禁止退款（否则退款和服务确认会冲突）
const reservedCheck = await pg.query(`
  SELECT si.sale_item_id, si.product_name, COUNT(*) AS reserved_count
  FROM sale_items si
  JOIN service_items sit ON sit.sale_item_id = si.sale_item_id
  WHERE si.sale_order_id = $1
    AND sit.reserved_at IS NOT NULL
    AND si.product_type = '疗程卡'
  GROUP BY si.sale_item_id, si.product_name
`, [refSaleOrderId])

if (reservedCheck.rows.length > 0) {
  const item = reservedCheck.rows[0]
  throw new Error(`INVALID_STATE: 该订单有服务中预留（${item.product_name}），请先完成或取消服务后再退款`)
}
```

### 数据库迁移

**Migration 文件**：`db/migrations/0079_add_service_items_reserved_at.sql`

```sql
-- 服务预扣机制：service_items 新增 reserved_at 字段
-- 语义：
--   NULL = 未预扣（旧服务单、"待服务"状态）
--   NOT NULL = 已预扣（"服务中"/"待确认"状态）

ALTER TABLE service_items
ADD COLUMN reserved_at timestamptz;

COMMENT ON COLUMN service_items.reserved_at IS '预扣时间戳（服务开始时记录，用于防止服务期间疗程卡被转换单消耗）';

-- 索引：转换单查询预扣统计时需要
CREATE INDEX idx_service_items_sale_item_reserved 
ON service_items (sale_item_id) 
WHERE reserved_at IS NOT NULL;
```

### 兼容性与回滚

**向后兼容**：
- 旧服务单（已完成/已取消）：`reserved_at = NULL`，无影响
- 进行中服务单（升级前处于"服务中"/"待确认"）：`reserved_at = NULL`，升级后第一次 `service.start` 调用会触发校验失败（因为转换单已经看不到预扣），但这是正确行为（数据已不一致，应该报错而非静默成功）

**数据修复脚本**（可选，用于生产环境升级前修复进行中的服务单）：

```sql
-- 为升级前所有"服务中"/"待确认"的服务单补打预扣标记
UPDATE service_items sit
SET reserved_at = so.started_at
FROM service_orders so
WHERE sit.service_order_id = so.service_order_id
  AND so.status IN ('服务中', '待客户确认')
  AND sit.reserved_at IS NULL;
```

**回滚方案**：
```sql
-- 移除字段和索引
DROP INDEX IF EXISTS idx_service_items_sale_item_reserved;
ALTER TABLE service_items DROP COLUMN reserved_at;
```

## 影响范围

### 代码文件修改清单

#### 1. 数据库层（必改）
- `db/migrations/0079_add_service_items_reserved_at.sql` - 新建迁移文件
- `db/schema/service.ts` - 更新 `serviceItems` 表定义

#### 2. 云函数层（必改）
- `fengyu-staff/cloudfunctions/staffApi/routes/service.js`
  - `service.start` - 新增预扣逻辑
  - `service.cancel` - 新增释放预扣逻辑
  - `finalizeServiceOrder` - 清除预扣标记
  - `loadServiceItems` - 查询增加 `reserved_at` 字段

- `fengyu-staff/cloudfunctions/staffApi/routes/order.js`
  - `createConversion` - 转换单考虑预扣次数
  - `createRefund` - 增强退款防护

- `fengyu-client/cloudfunctions/clientApi/utils/service-finalize.js`
  - 同步 `finalizeServiceOrder` 变更

#### 3. Admin 后台层（必改）
- `fengyu-admin/src/services/services.ts`
  - `confirmServiceOrder` - 同步 `finalizeServiceOrder` 变更
- `fengyu-admin/src/actions/orders.ts`
  - `createConversionOrder` - 同步转换单预扣逻辑

#### 4. 测试层（必改）
- `fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js`
  - 更新 `finalizeServiceOrder` SQL snapshot

- 新增集成测试：
  - `fengyu-staff/tests/e2e-cloudfn/service-reservation-conflict.spec.mjs`
  - 场景1：服务中创建转换单（应报错）
  - 场景2：服务中申请退款（应报错）
  - 场景3：服务取消后转换单（应成功）

### 风险评估

**高风险点**：
1. **三端 SQL 一致性**：`finalizeServiceOrder` 是跨端独立副本，必须同步修改，否则触发 snapshot 测试失败
2. **转换单查询性能**：新增 `LEFT JOIN service_items` 可能影响性能，需添加索引
3. **生产环境升级窗口**：迁移期间进行中的服务单会有短暂的数据不一致

**缓解措施**：
1. Snapshot 测试自动守护跨端一致性
2. 迁移文件包含索引创建
3. 升级前运行数据修复脚本，补打预扣标记

## 实施步骤

### Phase 1: 数据库迁移（本地 + dev）
1. 编写迁移文件 `0079_add_service_items_reserved_at.sql`
2. 更新 `db/schema/service.ts`
3. 本地运行 `bun db:migrate` 验证
4. Dev 环境部署迁移

### Phase 2: 云函数逻辑变更（dev）
1. 修改 `staffApi/routes/service.js` - 预扣逻辑
2. 修改 `staffApi/routes/order.js` - 转换单防护
3. 同步 `clientApi/utils/service-finalize.js`
4. 更新 snapshot 测试
5. 运行 L2 测试套件验证

### Phase 3: Admin 后台同步（dev）
1. 修改 `fengyu-admin/src/services/services.ts`
2. 修改 `fengyu-admin/src/actions/orders.ts`
3. 本地 TypeScript 编译验证

### Phase 4: 集成测试（dev）
1. 编写 `service-reservation-conflict.spec.mjs`
2. 手动端到端测试：
   - 创建服务单 → 开始服务 → 尝试转换同一卡（应拒绝）
   - 创建服务单 → 开始服务 → 取消 → 转换（应成功）
   - 创建服务单 → 开始服务 → 确认完成（应扣减）

### Phase 5: 生产环境部署
1. 数据库迁移：
   - 备份生产数据库
   - 运行数据修复脚本（补打预扣标记）
   - 运行迁移 `0079`
2. 云函数部署：
   - `staffApi` / `clientApi` 部署（按标准流程）
3. Admin 部署：
   - 远程部署（`deploy-admin.sh prod`）
4. 烟雾测试：
   - 创建测试服务单，验证预扣流程
   - 监控错误日志

## 后续优化（可选）

1. **超时释放机制**：服务单超过 24 小时未完成，自动释放预扣
   ```sql
   -- Cron job 定期清理
   UPDATE service_items sit
   SET reserved_at = NULL, updated_at = NOW()
   FROM service_orders so
   WHERE sit.service_order_id = so.service_order_id
     AND sit.reserved_at IS NOT NULL
     AND sit.reserved_at < NOW() - INTERVAL '24 hours'
     AND so.status NOT IN ('已完成', '已取消')
   ```

2. **监控告警**：Grafana 监控长时间预扣的服务单
   ```sql
   SELECT so.service_order_id, so.status, sit.reserved_at
   FROM service_items sit
   JOIN service_orders so ON sit.service_order_id = so.service_order_id
   WHERE sit.reserved_at < NOW() - INTERVAL '2 hours'
     AND so.status IN ('服务中', '待客户确认')
   ```

3. **UI 提示优化**：
   - 转换单选卡界面显示"预留中"标签
   - 服务单列表显示预扣状态

## 总结

本方案通过在服务开始时预扣次数（记录 `reserved_at` 时间戳），将次数消耗提前到"服务中"状态，防止服务期间疗程卡被转换单或退款消耗。核心变更：
- **数据库**：`service_items.reserved_at` 新字段 + 索引
- **服务开始**：校验可用次数（扣除预扣）+ 标记预扣
- **服务确认**：清除预扣标记 + 正式扣减（原逻辑不变）
- **服务取消**：释放预扣标记
- **转换单**：查询时排除预扣次数
- **退款**：检测预扣，有预扣时拒绝退款

预期效果：用户报告的"服务期间疗程卡被转换单消耗"问题将被彻底解决。
