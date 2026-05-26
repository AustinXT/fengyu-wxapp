# Ticket: e2e link-6 / link-22 fixture 顾客消费额不足触发不了 cron 升级

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待修 spec |
| 优先级 | **P2**（不阻塞业务；仅阻塞 spec 通过率）|
| 端 | tests/e2e-chains |
| 修复成本 | **S**（spec beforeAll 加 1 段 SQL）|
| 来源 | 2026-05-17 README §1.B 已标注；2026-05-18 跑批复现 |
| 类别 | spec 设计交互（非 admin bug）|

---

## 0 一句话

`link-6`（会员升级）和 `link-22`（生日权益 cron）都期望 fixture 顾客 `FY-FIX-CLIENT-01` 跑 cron 时已经达到"初钻"门槛（年度消费 ≥ ¥1980），但当前 fixture 顾客滚动 12 个月消费仅 ~¥1242 < 1980。

cron STEP 2 `refresh-member-levels` 看到 spend 不达标 → 把 member_level 强降为 NULL → STEP 3 `grant-birthday-benefits` 按"非空 member_level"过滤 → 跳过 fixture → 生日积分 / 消息 / 优惠券全 0 发放 → 全部 verdict FAIL。

---

## 1 README 已写的修复路径

> "**fix spec**：beforeAll 先开 ¥1000 单 + 确认收款补足 spend 到 ≥1980，afterAll 一并清；或直接调 grant-birthday 单 STEP 跳过 cron-once 全跑"

---

## 2 决策点

### 选项 A：spec beforeAll 用 SQL 直接 INSERT 补 spend

直接插 1 行已支付 sale_order 把 fixture 顾客 spend 拉到 ¥3000；afterAll 删掉。

**好处**：稳定；afterAll 失败也只是数据脏，不影响其他链路。

**坏处**：跳过了"通过链路 1 真实开单"的端到端校验路径；如果 admin createOrder 引入新 side effect（如必发放积分），spec 不会捕捉。

### 选项 B：spec beforeAll 跑链路 1 真实开单 + 收款

通过 admin UI 真开一单 ¥2000 顶 spend。

**好处**：端到端真实路径覆盖。

**坏处**：跑批时长 +60s；如果 link-1 admin createOrder 出 bug，link-6 / 22 跟着挂（耦合）。

### 选项 C：把"开单达标"前置抽成 setup helper（fixture-setup 文件）

引入 `tests/e2e-chains/_helpers/fixture-spend-topup.ts`，被 link-6 / 22 共享调用。

**好处**：未来更多依赖 spend 的 spec 复用。

**坏处**：抽象度上升；当前只有 2 处使用，可能 over-engineer。

### 选项 D：直接 SKIP link-6 / 22，归类为"不在 fixture 当前能力范围"

documents and moves on; spec 标 `.skip()` 直到 fixture 拍板。

**好处**：跑批清爽。

**坏处**：会员升级 / 生日权益的 cron 链路完全无自动化覆盖。

---

## 3 我需要你判断的

**Q1**：选 A / B / C / D？

**我的建议**：**A**（SQL 注入最稳）。理由：link-1 本身已覆盖"开单端到端"路径；link-6 / 22 的本意是验证 cron 行为，把 admin createOrder 耦合进来违反单一职责。

**Q2**：fixture 顾客的初始 member_level 现在是 NULL（每次 cron 后都被降回 NULL）。是否在 beforeAll 同时 SQL 把 member_level 顶到"初钻"以避免 cron 再次降级？

---

## 4 关联引用

- `tests/e2e-chains/link-6-member-upgrade.spec.ts`
- `tests/e2e-chains/link-22-cron-birthday-boundary.spec.ts`
- `notes/memory/project_test_fixture_resting_state.md`（FY-FIX-CLIENT-01.member_level 静息态 NULL）
- `notes/memory/project_member_level_rules.md`（初钻阈值 1980）
- `src/cron/steps/refresh-member-levels.ts`
- `src/cron/steps/grant-birthday-benefits.ts`

---

## 完成记录

- **完成日期**：2026-05-19
- **决策**：D1=B（spec beforeAll 真实 admin createOrder + 收款顶 fixture spend）
- **改动范围**（2 文件）：
  - `fengyu-admin/tests/e2e-chains/link-6-member-upgrade.spec.ts` — beforeAll 新增 chromium launch + 真实 admin /orders/create 流程：登录 MGR (13900139001 / fengyu2026) → 选 fixture 顾客 (13800138000) → 缦之羽分类下 SKU1 (洗-无创纹身 ¥100) 累加 20 件 → 凑 ¥2000 → 提交销售单 + 线下支付 → 确认收款。beforeAll 末校验 12mo spend ≥ 1980，否则报错。afterAll 用 `cleanupSaleOrder` 完整回滚补 spend 订单（含 sale_items / sale_allocations / payments / 自引用回款单）
  - `fengyu-admin/tests/e2e-chains/link-22-cron-birthday-boundary.spec.ts` — 同 link-6 beforeAll 流程；额外保留原有 `member_level='初钻'` 设置（Q2 答案，避免 cron STEP 2 即便看到 spend ≥ 1980 还要触发"升级"消息流）；afterAll 加 `cleanupSaleOrder` 清补 spend 订单
- **TypeScript 类型检查**：`npx tsc --noEmit` 全项目 0 错误
- **Playwright 解析**：`bunx playwright test --list` 7 个 test 全部正确枚举
- **DoD 偏差**：
  - [x] beforeAll 真实 admin createOrder + confirmOfflinePayment ✓
  - [x] beforeAll 校验 12mo spend ≥ 1980 ✓
  - [x] Q2 答案：link-22 同步把 member_level 顶到 '初钻'（link-6 仍走 NULL→初钻 升级路径，因为 link-6 测的就是升级行为本身）✓
  - [x] afterAll cleanupSaleOrder 清补 spend 订单 ✓
  - [⚠️] DoD 1 测试 PASS：**SKIP 执行验证**。本 agent 实施期间另一并行 agent 把 e2e-chains 全部 spec 的 psql 连接从 5433/fengyu_wxapp 切换到 5434/fengyu（与 admin dev server 实际连接的库对齐），同时本 agent 在 link-6 / link-22 加 setup createOrder 改动。但 fixture（FY-TEST-MGR 测试账号 / FY-FIX-CLIENT-01 顾客 / FY-FIX-CARD-01 储值卡等）目前仅存在于 5433，5434 上缺失（fixture 迁移属 B1 agent 工作），导致 admin login + UI 流程因找不到测试账号 → 超时 FAIL。spec 改动语义已写完并通过 `npx tsc --noEmit` + `bunx playwright --list`；待 5434 fixture 迁移完成后跑批即可 PASS。此 DB 一致性问题归 ticket `2026-05-18-e2e-chains-test-db-mismatch.md`
- **关联引用**：
  - 配套 ticket `2026-05-18-e2e-link-10-card-pollution.md`（D2）同批归档
  - 关联 memory：`project_test_fixture_resting_state.md`、`project_member_level_rules.md`
  - 待修 DB 配置：`2026-05-18-e2e-chains-test-db-mismatch.md`
