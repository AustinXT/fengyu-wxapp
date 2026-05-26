# fengyu-staff e2e 全量跑批 — findings（2026-05-21）

跑了 `fengyu-staff/tests/` 三套（L2 e2e-cloudfn / scope-isolation / L3 miniprogram）+ 顺带 L1 unit。

## 结果总览

| 套件 | 结果 | 备注 |
|------|------|------|
| L2 e2e-cloudfn | 45/52 → 修复后 46/52，余 5 待决策 + 1 flake | 全部失败均为「测试预期落后于已落地的产品行为」 |
| scope-isolation | 3/4 → **4/4 PASS（已修）** | scope-s8 fixture 列名 bug |
| L3 miniprogram | **阻塞** | IDE 未装 staff 项目（staffApi FUNCTION_NOT_FOUND）；需切项目（会退出当前 IDE 会话） |
| L1 unit（非 tests/，附带） | 1205/1237，32 fail | 跨端 snapshot 漂移 + mock 漂移，pre-existing，本次未动 |

---

## ✅ 已直接修复（明显 bug，无需决策）

### 1. scope-isolation/scope-s8 — INSERT 引用不存在的列
`scope-s8-mgr-cross-store-deny.mjs:67` 向 `sale_items` 插入 `is_recharge_card`，该列不存在于 sale_items（在 `product_skus` 上）。删列 + 删对应 `false` 值后 6/6 PASS。

### 2. smoke-order-create-sales — 断言落后于 B2 拆行 + per-session 价
- 疗程卡 quantity=2 经 B2 拆行（ticket 2026-05-18）落成 **2 行**（每行 quantity=1, session_count=5），测试旧断言为 1 行 quantity=2。
- 卡类 `unit_price`/`unit_real_price` 现为 **per-session 单次价**（500/5=100），测试旧断言为 per-card 500（见 memory sale-items-money-fields）。
- 已改断言：2 行、每行 quantity=1 / unit_price=100 / unit_real_price=100 / session_count=5。重跑 PASS。

---

## ✅ 决策后已落实（2026-05-21 第二轮）

按用户拍板逐项处理：

1. **删 `smoke-staff-dashboard.mjs`** — staff.dashboard 已并入 mgmtDashboard，run-all 自动发现无需改列表；MEMORY.md staffApi 列表已更正。
2. **一顾客一待支付单 = 显式拒绝（保留现有守卫）** — 生产代码已是该行为；改 `smoke-order-create-internal`：删废弃的 customPrice 拒绝步骤，新增「同顾客二次开单被拒」断言。PASS。
3. **每顾客仅一张 待服务/服务中** — 确认 `uq_so_client_active` 不变量；改 `smoke-service-cancel` fixture，so1(待服务)/so2(服务中) 分属不同顾客。PASS。
4. **加固 requireManager（生产代码）** — `middleware/auth.js`：manager 绑定须落在合法 scope（总部/市场/门店），部门级 manager 绑定一并拒绝。`smoke-deny-non-manager` 4/4 PASS；rbac 4 套 63 case 全过；L1 回到基线 32（index.test.js mock 同步补 scope_type + expandScope）；scope-isolation 4/4。
5. **xend 改混合单（方案 b）** — `smoke-xend-scan-confirm-scope` fixture 改为 total=500/储值卡 300+现金 200/payment_method='线下'，confirmOffline 扣卡 300+确认现金 200，保留 client card.history 跨端断言。4/4 PASS。

> 改动文件：生产 1（`middleware/auth.js` requireManager）+ 测试若干（见 git）。生产改动经 L1 全量 + rbac/scope-isolation/confirm-offline/card-recharge 验证零回归。

## ⏳ 仍待你决定（本轮未处理）

### smoke-card-balance — flake（非 bug）
- 全套跑时失败，单独跑 PASS。属已知 TE2L2 命名空间并发污染（见 memory e2e-shared-namespace-contention）。无需改代码；如要消除，给它独立命名空间或串行隔离。

### L3 run-scenarios 余下失败（见下方 L3 段）
- bs01/02/03/05/06：文档化 spec vs 页面文案/接口契约 mismatch（KNOWN-ISSUES-2026-05-17 有逐条修正指引）。
- bs04/07/09：L3 topology/scope seed + system_configs 不稳定（cleanup 清掉 staff scope 绑定，per-spec setup 没全重建）。

### L1 unit 32 fail（非 tests/ 范围）
- 跨端 snapshot 漂移（admin recharge.ts 文案、mgmt-dashboard SQL 形态、admin orders SQL）+ mock 漂移（order.test.js 幂等守卫先于校验）+ `product.test.js` 对已删 `is_recharge_card` 列的滞后断言。建议另开工单。

---

## L3（已切到 staff 项目跑完，IDE 现停在 staff 项目）

切项目时关键：`cli auto` 必须带 `--auto-port 9420` 才会起 automation ws（IPv6），否则只有 HTTP（IPv4）连不上。`run-staff-l3.sh` 已带，手敲 `cli auto` 漏了会卡住。

### L3 run-all（10 smoke）— **10/10 PASS（已修）**
唯一失败 `smoke-staff-confirm-offline` 撞同一个 `is_recharge_card` bug（`helpers/fixtures.mjs:368` 往 sale_items 插已删列）。已修，重跑 PASS。

### L3 run-scenarios（12 BS 场景）— 4 稳定 PASS / 余下分两类

**`is_recharge_card` 列已于 2026-05-20 从 sale_items + product_skus 删除**（充值识别改走 `sale_order_type='充值单'` / `product_kind='充值卡'`；cross-end-sql-snapshot 测试明令禁止再引用该列）。但 fixtures/specs 没跟上。已修以下对该列的引用（全部移除列+对应值）：
- sale_items：scope-s8、L3 fixtures.mjs、bs03/bs05/bs08/bs12
- product_skus：bs01、bs08

修后 **bs08 由 fixture 崩溃 → PASS**。

| 场景 | 状态 | 性质 |
|------|------|------|
| bs08, bs10, bs11, bs12 | PASS | 稳定 |
| bs04, bs07, bs09 | flaky | 跑批 run1 PASS、run2/隔离 FAIL「无权访问该门店」/「recharge.tiers 为空」——topology/scope fixture + system_configs 不稳定（与本次改动无关，见 memory e2e-shared-namespace-contention）。**决策**：需稳定 L3 拓扑/scope seed（cleanup 会清掉 staff scope 绑定，per-spec setup 没重建全）。 |
| bs01, bs02, bs03, bs05, bs06 | FAIL | 文档化的 spec vs 页面 mismatch（见 KNOWN-ISSUES-2026-05-17）。bs03=`.van-button text=确认完成` 选择器/文案不命中；bs05=loadPaidOrders 过滤不含 fixture item；bs01=categories=[]；等。**决策**：逐条按 KNOWN-ISSUES 修正指引对齐文案/接口契约。 |

> 注：L1 product.test.js 也有 `is_recharge_card` 残留断言（`expect(sql).toMatch(/sk.is_recharge_card/)`），属同一列删除的滞后，列在下方 L1 待处理。

## L1 unit（附带，非本次范围）
32 fail / 1237：跨端 snapshot 漂移（admin `recharge.ts` 错误文案、mgmt-dashboard SQL 形态、admin orders SQL 快照）+ mock 漂移（order.test.js 幂等守卫先于校验触发）。pre-existing，建议另开工单。
