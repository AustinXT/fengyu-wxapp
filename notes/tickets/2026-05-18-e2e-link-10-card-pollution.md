# Ticket: link-10 储值卡余额跑挂后污染递归（cleanup 未恢复 fixture）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待修 spec |
| 优先级 | **P2**（仅阻塞 spec 跑批可重复性）|
| 端 | tests/e2e-chains |
| 修复成本 | **S**（spec afterAll 加 1 行 UPDATE）|
| 来源 | 2026-05-18 跑批 link-10 五步 PARTIAL → 退化到 0/5 FAIL |
| 类别 | spec cleanup 设计 |

---

## 0 一句话

`link-10`（储值卡余额对账）依赖 fixture `FY-FIX-CARD-01.balance=1000`。但 spec 中段失败时不会回滚卡余额；下一次跑 spec 直接看到 `balance=0`，第 1 步对账（book=0 vs calc=1000）直接 FAIL，后续 4 步连锁 FAIL。

---

## 1 实证

### 1.1 跑批历史（5433 上）

| 时间 | balance 实测 | 跑批结果 |
|------|------------|---------|
| 2026-05-17 13:28（初次） | 1000 | PARTIAL（第一步 PASS，后面 FAIL）|
| 2026-05-18 06:08（修了balance=1000 后） | 1000 | PARTIAL 1/5 |
| 2026-05-18 06:18（link-10 跑挂后） | 0 | FAIL 0/5 |
| 2026-05-18 06:45（手 reset 1000 又跑） | 0（再次污染） | FAIL 0/5 |

→ 每次 link-10 跑都会把 balance 改坏，且**无 spec afterAll 自动恢复**。

### 1.2 link-10 cleanup 实际行为

spec 在 step 4 调 `cleanupSaleOrder(..., {preserveCardTransactions: true})` 只清 sale_order 不清 card_transactions（这是设计），但**没有手 UPDATE balance 回 1000**。

---

## 2 决策点

### 选项 A：spec afterAll 加恢复

```ts
test.afterEach(async () => {
  await runPsql(`UPDATE prepaid_cards SET balance=1000 WHERE card_id='FY-FIX-CARD-01'`)
  await runPsql(`DELETE FROM card_transactions WHERE card_id='FY-FIX-CARD-01' AND created_at > '2026-05-17 13:30'`)
})
```

**好处**：最快；最小爆炸半径。
**坏处**：把 fixture 复位逻辑写死在 spec 里，与 `test-fixtures.json._cleanup.sql` 重复。

### 选项 B：在 `test-fixtures.json._cleanup.sql` 加 card balance reset，并在 link-10 afterEach 调统一 reset 钩子

**好处**：fixture cleanup 单一权威源。
**坏处**：需要在多处约定调用 `_cleanup.sql`，工程复杂度上升。

### 选项 C：把 fixture 卡换成"每次跑测试自动 INSERT + DELETE 的临时卡"

不依赖固定 fixture，spec beforeAll 自建 + afterAll 自销毁。

**好处**：彻底解耦；可并行跑。
**坏处**：需要 fixture 顾客有多卡能力；改 fixture-id 引用面较广。

---

## 3 我需要你判断的

**Q1**：选 A / B / C？

**我的建议**：**A**（最直接最稳）。link-10 是少数依赖固定卡余额的 spec，专项处理就够；不必引入更宽的抽象。

**Q2**：cleanup 是否需要把 `card_transactions` 也回滚（删 link-10 跑测试中产生的充值/扣款行）？还是按 README 的"preserveCardTransactions=true"保持流水完整？

---

## 4 关联引用

- `tests/e2e-chains/link-10-card-balance-check.spec.ts`
- `tests/e2e-chains/_helpers/cleanup.ts`（preserveCardTransactions 选项）
- `tests/e2e-chains/test-fixtures.json`（fixture 定义 + _cleanup.sql 段）
