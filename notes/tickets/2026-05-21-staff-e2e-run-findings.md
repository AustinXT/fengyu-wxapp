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

## ⏳ 待决策（未改，等统一处理）

### A. smoke-staff-dashboard — action `staff.dashboard` 已被移除
- 现状：路由表无 `staff.dashboard`，已重构为 `mgmtDashboard.{summary,storeRanking,staffRanking,salesData}`（`smoke-mgmt-dashboard.mjs` 已覆盖且 PASS）。
- 冲突：MEMORY.md 仍写「staff: …dashboard（数据看板5指标）」，已过时。
- **决策**：删除 `smoke-staff-dashboard.mjs`（已被 mgmt-dashboard 覆盖，建议）/ 还是员工端仍需一个非管理层 dashboard 端点？同步更新 MEMORY.md。

### B. smoke-order-create-internal — 两处
1. 第 3 步期望「内部单 customPrice 被拒」，但 `order.js:320` 已废弃 customPrice/discount 入参（**静默忽略**，不报错），故下单成功（5 折）。
2. 因第 3 步现在成功（建了待支付单），第 4 步撞上新守卫 `order.js:339`「该顾客已有待支付订单」→ -400。
- **决策**：(1) customPrice 该静默忽略（现状）还是显式拒绝？ (2) 该 smoke 给同一顾客连开多单，与「一顾客一待支付单」守卫冲突——需重构（步骤间关单 / 用不同顾客）。建议：删 customPrice 拒绝步骤 + 第 4 步换新顾客。

### C. smoke-service-cancel — 撞 `uq_so_client_active`
- fixture 给**同一顾客**建 待服务 + 服务中 两张服务单，违反唯一索引 `uq_so_client_active`（service_orders：每顾客仅一张 待服务/服务中 活跃单）。
- **决策**：确认该 invariant 是否预期（已是 committed DB index，应为预期）。若是，fixture 改为给 so1/so2 用**不同顾客**（so3 已完成不算活跃，无所谓）。建议：拆顾客。

### D. smoke-deny-non-manager — requireManager 对「部门 scope 上的 manager 绑定」放行（**唯一涉及生产代码**）
- case 4：员工绑定 `{role:'manager', scopeId=部门节点}`，`requireManager()`（auth.js:271）只按**角色名**判定 `r.role==='manager'` 即放行，未校验绑定 scope 类型合法性 → 落入 order.create → 因缺 clientPhone 报 INVALID_PARAMS，而非期望的 PERMISSION_DENIED。
- 背景：[role-scope-pairing] manager 不允许配在 type=部门；admin UI 已阻止该配对，生产不会出现（仅纵深防御缺口）。
- **决策**：(a) 加固 requireManager——要求 manager 绑定落在合法 scope（或 staffLevel≠null）；还是 (b) 放宽测试（非法配对不会发生）。

### E. smoke-xend-scan-confirm-scope — fixture 造了 order.create 不会产生的状态
- fixture 建「待支付 + payment_method='储值卡' + total 全由储值卡覆盖」的单，对它调 confirmOffline。
- 但 `order.js:160-167` 明确：全额储值卡抵扣单（payable==0 && prepaid>0）在**创建时即扣卡结清**，因为 payment_method='无' 走不了 confirmOffline；且新守卫 `order.js:1033` 拒绝 payment_method≠'线下' 的待支付单。故该场景在真实链路不存在。
- **决策**：重设该 smoke——(a) 测创建时全额扣卡结清路径；或 (b) 用「储值卡 300 + 现金应付」混合单（payment_method='线下'）再 confirmOffline 确认现金+扣卡，保留 staff→client card.history 跨端断言。建议 (b)。

### F. smoke-card-balance — flake（非 bug）
- 全套跑时失败，单独跑 PASS。属已知 TE2L2 命名空间并发污染（见 memory e2e-shared-namespace-contention）。无需改代码；如要消除，给它独立命名空间或串行隔离。

---

## L3 阻塞详情
- 探针 `smoke-staff-login-tab` 已连上 IDE（automator OK），但 `staffApi` 返回 `-501000 FUNCTION_NOT_FOUND` → 当前 IDE 装的不是 staff 项目（appid wxe3f5d9ee6a94d22d），或 staffApi 未部署到所连环境。
- 切项目须 `cli quit` + pkill + `cli auto --project fengyu-staff/miniprogram`（会**退出当前 IDE 会话**）。
- 已知基线（2026-05-17）：BS 场景 4/9 PASS，5/9 FAIL（均 spec 文案/接口契约 vs 实际页面 mismatch，非基建）。

## L1 unit（附带，非本次范围）
32 fail / 1237：跨端 snapshot 漂移（admin `recharge.ts` 错误文案、mgmt-dashboard SQL 形态、admin orders SQL 快照）+ mock 漂移（order.test.js 幂等守卫先于校验触发）。pre-existing，建议另开工单。
