# Ticket: admin confirmOfflinePayment 缺储值卡扣款逻辑（部分抵扣订单余额永不扣减）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | ✅ 已完成（2026-05-19，commit d5ad692）|
| 优先级 | **P0**（数据一致性 Bug：admin 录入的部分抵扣订单顾客余额从未被扣减）|
| 端 | fengyu-admin |
| 修复成本 | **M**（移植 staff confirmOffline 扣卡块到 admin，约 50 行）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（G1 缺口）|
| 决策 | **方案 A**：在 admin `confirmOfflinePayment` 内补扣卡逻辑（与 staff 对齐）|
| 关联文件 | `src/actions/orders.ts`（L544-620 confirmOfflinePayment, L1078-1082 createOrder）|

---

## 0 一句话

`createOrder` 接受 `prepaidCardAmount > 0` 后只把数字写入 `sale_orders.prepaid_card_amount`，但 `confirmOfflinePayment` 只调 `applyRechargeOnOrderPaid`（充值入账）+ `settlePointsSafe`（积分），**没有扣卡块** → 顾客 `prepaid_cards.balance` 永远不会因 admin 端订单被扣减。

---

## 1 复现证据

### 1.1 admin createOrder 部分抵扣路径

```ts
// fengyu-admin/src/actions/orders.ts L1077-1082
// payable_amount = total_amount - prepaid_card_amount（冗余列，用于状态机决策和前端展示）
const prepaidCardAmount = Math.max(0, data.prepaidCardAmount ?? 0)
if (prepaidCardAmount > totalAmount + 0.005) {
  return { success: false, message: '储值卡抵扣金额不能超过订单总额' }
}
const payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
```

— 仅校验金额范围，无 `SELECT FOR UPDATE prepaid_cards`，无 `UPDATE balance`，无 `INSERT card_transactions(type='扣款')`。

### 1.2 admin confirmOfflinePayment

```ts
// fengyu-admin/src/actions/orders.ts L584-590
// 充值卡入账（若订单含虚拟 SKU）：UPSERT prepaid_cards + 记流水
// 与 fengyu-client payNotify 的充值入账逻辑完全同义，幂等由 ref_order_id 去重保障
await applyRechargeOnOrderPaid(tx, saleOrderId)
// 积分发放（修复 audit-15 P0-15-01：admin confirmOfflinePayment 触发点缺失）
await settlePointsSafe(tx, saleOrderId, 'admin.confirmOffline')
```

— 只入账（顾客买卡时），完全没有扣卡（顾客用卡抵扣时）。

### 1.3 对照 staff confirmOffline 完整扣卡块

```js
// fengyu-staff/cloudfunctions/staffApi/routes/order.js L908-945
const prepaidAmount = Number(order.prepaid_card_amount || 0)
if (prepaidAmount > 0) {
  // 幂等：已扣过则跳过
  const dedup = await client.query(
    `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
    [saleOrderId],
  )
  if (dedup.rows.length === 0) {
    // 锁余额
    const balRes = await client.query(
      'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
      [order.client_user_id],
    )
    if (balRes.rows.length === 0 || Number(balRes.rows[0].balance) + 0.001 < prepaidAmount) {
      throw new Error('INSUFFICIENT_BALANCE: ...')
    }
    // 扣减
    await client.query(
      `UPDATE prepaid_cards SET balance = balance - $1 WHERE card_id = $2`,
      [prepaidAmount, balRes.rows[0].card_id],
    )
    // 写流水（带幂等 external_ref）
    await client.query(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
       VALUES ($1, '扣款', $2, $3, $4, NOW())
       ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
      [..., -prepaidAmount, saleOrderId, `card-deduct-${saleOrderId}`],
    )
    // 写 payments 行
    await client.query(`INSERT INTO sale_order_payments (...) VALUES (..., '储值卡抵扣', ...)`)
  }
}
```

— admin 端缺失这整块。

---

## 2 影响范围

| 场景 | 当前行为 | 期望行为 |
|------|---------|---------|
| admin 创建"全抵扣"订单（prepaid = total） | balance 不扣，订单标"已支付"，余额错乱 | balance 扣减 |
| admin 创建"部分抵扣"订单（prepaid < total） | balance 不扣，订单按 payable 收现金 | balance 扣减 + 收现金 |
| admin 创建"零抵扣"订单 | ✓ 正确 | ✓ 正确 |
| admin 录入历史线下储值卡支付补登 | ✗ 余额错乱 | ✓ 扣卡 |

`sale_orders.prepaid_card_amount` 与 `prepaid_cards.balance` 实际值之间**长期漂移**，需要数据修复脚本核对。

---

## 3 已决方案（A）

在 `confirmOfflinePayment` 事务内（L555-604 之间）补一段扣卡逻辑，紧贴 `applyRechargeOnOrderPaid` 之前或之后：

```ts
// 锁原单读 prepaid_card_amount 和 client_user_id
const [order] = await tx.execute(sql`
  SELECT prepaid_card_amount, client_user_id FROM sale_orders
  WHERE sale_order_id = ${saleOrderId} FOR UPDATE
`)
const prepaidAmount = Number(order.prepaid_card_amount || 0)
if (prepaidAmount > 0 && order.client_user_id) {
  // 幂等查 + 锁余额 + 扣 + 写流水（与 staff L908-945 字面一致）
}
```

**关键约束**：
- 必须复用 `external_ref = card-deduct-${saleOrderId}` 编码（与 staff/client 三端一致）
- 必须同事务写一行 `sale_order_payments[change_type='储值卡抵扣', status='已支付']`
- 余额不足时抛 `INSUFFICIENT_BALANCE: 顾客储值卡余额不足`，整个事务回滚（**不要**降级为部分扣 + 部分收现金）

---

## 4 验证

### 4.1 单元测试

`fengyu-admin/src/actions/orders.test.ts` 新增 case：
- admin createOrder + 全抵扣 → confirmOfflinePayment 后 `prepaid_cards.balance` 减少正确值
- 余额不足时 confirmOfflinePayment 抛 INSUFFICIENT_BALANCE 且订单状态不变
- 幂等：重复调 confirmOfflinePayment 不会重复扣卡

### 4.2 跨端 snapshot

修改后必跑：
```bash
bun test fengyu-admin/tests/e2e-chains/link-10-card-balance-check.spec.ts
bun test fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js
```

### 4.3 数据修复脚本（实施前必备）

实施扣卡逻辑后，存量数据可能已经错乱。需要一次性脚本核对：
- 查 `sale_orders WHERE prepaid_card_amount > 0` 且对应客户 `card_transactions` 没有 type='扣款' ref_order_id 命中的订单
- 输出报表 → 人工决定是补扣还是清零 `prepaid_card_amount`

---

## 5 关联引用

- `fengyu-admin/src/actions/orders.ts` L544-620, L1078-1082
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js` L908-945
- `fengyu-client/cloudfunctions/clientApi/routes/order.js` L588-628（client 全抵扣同事务扣卡参考）
- `notes/tickets/archives/2026-04-15-audit-15-admin-points-missing.md`（audit-15 P0-15-01 同类问题：admin confirmOfflinePayment 缺积分发放，已修复，本 ticket 是其姊妹问题）
