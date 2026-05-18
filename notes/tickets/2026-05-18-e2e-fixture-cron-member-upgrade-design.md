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
