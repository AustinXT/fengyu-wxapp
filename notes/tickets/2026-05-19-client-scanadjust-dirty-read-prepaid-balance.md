# Ticket: client scanAdjust 脏读余额，confirmPrepaidFull 可能超额触发 INSUFFICIENT_BALANCE

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-19 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（顾客体验异常：扫码确认时报"余额不足"但用户看到的预选额是合法的）|
| 端 | fengyu-client |
| 修复成本 | **S**（scanAdjust 返回 balance 快照 + updated_at；confirmPrepaidFull 入参带版本号校验）|
| 来源 | 2026-05-18 充值卡跨三端调试审计（B4.1）|
| 决策 | **方案 A**：scanAdjust 返回余额快照，confirmPrepaidFull 比对版本 |
| 关联文件 | `cloudfunctions/clientApi/routes/order.js`（L1397-1485 scanAdjust, L1513-1628 confirmPrepaidFull）|

---

## 0 一句话

`scanAdjust` 读余额**非锁**（SELECT without FOR UPDATE），返回给前端的"建议抵扣金额"基于此快照；用户在调整窗口期内若有他订单消耗余额，`confirmPrepaidFull` 锁余额后扣减时会报 INSUFFICIENT_BALANCE，体验割裂。

---

## 1 复现证据

### 1.1 scanAdjust 非锁读

```js
// fengyu-client/cloudfunctions/clientApi/routes/order.js L1440-1450
const cardRows = await pg.query(
  'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1',
  [userId]
)
// ← 非 FOR UPDATE，仅作"建议"用
```

### 1.2 confirmPrepaidFull 才锁

```js
// fengyu-client/cloudfunctions/clientApi/routes/order.js L1552
const cardRows = await client.query(
  `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
  [userId]
)
// L1565+ 余额不足直接抛 INSUFFICIENT_BALANCE
```

### 1.3 复现步骤

1. 顾客 A 余额 = 200 元
2. A 在店内扫店长开的码 → scanAdjust 读到 balance=200 → 建议全抵 200
3. 同时 A 在另一台手机/或同账户的家人触发了一笔自助充值/支付（或 staff 端有另一笔订单 confirmOffline 扣了卡）→ balance 变成 80
4. A 点"确认支付" → confirmPrepaidFull FOR UPDATE 锁到 balance=80 < 200 → 抛 INSUFFICIENT_BALANCE
5. 前端报"余额不足"，但顾客困惑：明明刚刚显示 200 元

---

## 2 影响范围

- 多设备 / 同账户场景下并发率高时易触发
- 当前业务流量低，但**储值卡共享账户**（家人合用）场景下复现门槛低
- 短期不致命，长期顾客流失风险

---

## 3 已决方案（A）：返回余额快照 + 版本号校验

### 3.1 scanAdjust 改动

```js
// L1440-1450 改造
const cardRows = await pg.query(
  'SELECT card_id, balance, updated_at FROM prepaid_cards WHERE user_id = $1',
  [userId]
)
// 返回 result 增加 balanceSnapshot 字段
ctx.result = {
  ...existingFields,
  balanceSnapshot: cardRows.length > 0 ? {
    cardId: cardRows[0].card_id,
    balance: Number(cardRows[0].balance),
    updatedAt: cardRows[0].updated_at,  // 用于版本号
  } : null,
}
```

### 3.2 confirmPrepaidFull 入参增加 expectedBalanceUpdatedAt

```js
// L1513+ 入参增加可选 expectedBalanceUpdatedAt
const { saleOrderId, expectedBalanceUpdatedAt } = ctx.event.payload || {}

// L1552 FOR UPDATE 后校验
const lockedRow = cardRows[0]
if (expectedBalanceUpdatedAt && 
    new Date(lockedRow.updated_at).getTime() !== new Date(expectedBalanceUpdatedAt).getTime()) {
  throw new Error('CONFLICT: 储值卡余额已变动，请刷新页面后重新选择抵扣金额')
}
```

### 3.3 前端处理

- 前端接到 `CONFLICT` 错误码 → 自动调 `card.balance` 重新拉取 → 提示用户"余额已变动，请重新选择"
- 不要静默吞错；展示一次"余额变动"toast 后让用户主动重选

---

## 4 验证

### 4.1 单元测试

`fengyu-client/cloudfunctions/clientApi/__tests__/routes/order.test.js` 新增：
- scanAdjust 返回 balanceSnapshot 包含 updatedAt
- confirmPrepaidFull 传入过期 updatedAt → 抛 CONFLICT
- confirmPrepaidFull 不传 expectedBalanceUpdatedAt → 兼容旧行为（向后兼容期）

### 4.2 L2 e2e

`fengyu-client/tests/e2e-cloudfn/run-all.mjs --module order` 全量过；新增 spec 模拟并发消耗场景。

### 4.3 跨端兼容

- staff 端 `scanQrcode` 走不同链路，本 ticket 不涉及
- admin 不调 scanAdjust，本 ticket 不影响

---

## 5 关联引用

- `fengyu-client/cloudfunctions/clientApi/routes/order.js` L1397-1485 (scanAdjust), L1513-1628 (confirmPrepaidFull)
- `fengyu-client/miniprogram/pagesOrder/` 扫码确认页 — 前端需配合处理 CONFLICT 错误码
- `notes/tickets/archives/2026-04-26-sale-order-domain-refactor.md`（scanAdjust 设计背景）
