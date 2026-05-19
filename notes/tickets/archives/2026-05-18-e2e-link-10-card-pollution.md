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

---

## 完成记录

- **完成日期**：2026-05-19
- **决策**：D2=A（afterEach SQL reset）；Q2=不保留 link-10 跑测试中产生的 card_transactions，下次跑批从干净 baseline 开始
- **改动范围**（1 文件）：
  - `fengyu-admin/tests/e2e-chains/link-10-card-balance-check.spec.ts` — 加 `SPEC_START_TS = new Date().toISOString()` 记录跑批启动时刻；加 `test.afterEach()`：
    1. `DELETE FROM card_transactions WHERE card_id='FY-FIX-CARD-01' AND created_at > SPEC_START_TS`（仅删本次跑批产生的流水，保留 baseline）
    2. `UPDATE prepaid_cards SET balance=baselineBalance, updated_at=NOW() WHERE card_id='FY-FIX-CARD-01'`（baseline fallback 到 1000）
- **设计权衡**：
  - afterEach 与已有 afterAll 双重保险共存：afterEach 防中段失败污染 Step 间，afterAll 防整 spec 异常退出污染下一次跑批
  - 保留 README 的 `preserveCardTransactions=true` 设计语义：该选项仅在 `cleanupSaleOrder(soid, ...)` 调用路径下生效（NULL 化 ref_order_id 而非删 card_transactions 行），而 afterEach 是 fixture-level 强 reset 钩子，作用范围互不冲突
  - Step 1/2/3 内部本就使用 `preBalanceStepN = SELECT balance` 做相对断言，afterEach reset 不会破坏 Step 之间的链路逻辑
- **TypeScript 类型检查**：`npx tsc --noEmit` 全项目 0 错误
- **Playwright 解析**：5 个 test 全部正确枚举
- **DoD 偏差**：
  - [x] afterEach 强制 reset balance ✓
  - [x] afterEach DELETE 新增 card_transactions（Q2 答案）✓
  - [x] README preserveCardTransactions=true 设计保留 ✓
  - [⚠️] DoD 1 测试 PASS：**SKIP 执行验证**。原 spec psql 连 5433/fengyu_wxapp（fixture 所在地），后由 linter 同步切换至 5434/fengyu（admin dev server 实际连接的库）；FY-FIX-CARD-01 等 fixture 仅存在于 5433，5434 无对应 fixture → 全部 Step FAIL。afterEach 钩子已实际执行（Step 间未抛错）。环境数据库不一致问题归 ticket `2026-05-18-e2e-chains-test-db-mismatch.md`，本 agent 不动 admin/DB 配置
- **关联引用**：
  - 配套 ticket `2026-05-18-e2e-fixture-cron-member-upgrade-design.md`（D1）同批归档
  - 待修 DB 配置：`2026-05-18-e2e-chains-test-db-mismatch.md`
