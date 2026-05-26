# fengyu-staff e2e 全量跑批报告 — 2026-05-26

跑批范围：`fengyu-staff/tests/` 三层 e2e。

## 结果总览

| 层 | 套件 | 首跑 | 修复 + 干净窗口复跑 | 备注 |
|----|------|------|---------------------|------|
| L2 | e2e-cloudfn（53 smoke） | ❌ 46/53 | ✅ **53/53**（7 个失败逐个干净窗口串行复跑全 PASS） | 2 真 bug 已修 + 5 个并发污染假失败 |
| L2 | scope-isolation（4 spec / 21 check） | ✅ **4/4** | — | S-1/S-3/S-4/S-8 全绿 |
| L3 | e2e-miniprogram（10 smoke + 12 scenarios） | ⏸ 未跑 | — | 需微信开发者工具 9420 自动化 + 已登录态，本轮环境未就绪（见末尾） |

> 首跑 7 个失败 = **2 个真问题（已直接修复）** + **5 个并发污染假失败**。首跑时
> `fengyu-admin` 的 Playwright e2e（`tests/e2e-pages/*`）正并发跑同一 5434 库，污染了 staff L2
> 共用的夹具（详见「并发污染」一节）。干净独占窗口串行重跑，7 个全部 PASS。

## 已直接修复（无需决策的明显 bug）

### 1. smoke-service-refund-freeze — 疗程卡单次价语义错（确定性回归）

- **现象**：`createRefund 应成功，实际 INVALID_STATE: 退款金额超过订单可退余额`，并连锁拖垮后续
  4 条断言（service.create 冻结 / rejectRefund / 恢复）。
- **根因**：夹具 helper `createTestSaleOrder` 把疗程卡 `unit_real_price` 填成**整卡价**
  （`totalAmount/quantity` = 500/1 = 500），而 commit `0da8122f` 新增的退款封顶按
  `unit_real_price × 退款次数` 计算 → 退满 5 次得 500×5=2500，远超封顶 `max(流水净额, 已收)=500` 被拒。
  生产封顶逻辑（order.js:1678-1680 + refund.js:60-61）**正确**，是夹具数据违反了
  [sale-items-money-fields] 约定（`unit_real_price` = per-session 单次价 = `sale_amount/session_count`）。
- **修复**：`smoke-service-refund-freeze.mjs` 建单后追加 `UPDATE sale_items SET unit_real_price =
  sale_amount/session_count`（500/5=100）。改后退 5 次 = 100×5 = 500 = 已收，封顶通过。
  **局部修正、零波及**（未动共享 helper，见决策项 D-1）。

### 2. cleanupTestData FK 顺序缺口 — 残留孤儿阻断级联删除

- **现象**：smoke-order-refund 报 `stores_org_node_id_org_nodes_id_fk`、
  smoke-order-repay-per-item 报 `sale_order_payments_ref_sale_item_id_fk`（夹具 setup 阶段父行不存在）。
- **根因**：cleanup 第 4 段删 `point_transactions` 只按 `ref_order_id LIKE NS` / `user_id`，
  漏了 `order.create` 真实生成的 `FY-XSD-WX-*` 单（不带 NS 前缀、挂在共享夹具客 FY-FIX-CLIENT-01 上）
  的积分流水 → 残留 point_transactions 阻断 `sale_orders` 删除 → 连锁阻断 `stores`/`org_nodes` →
  下一 run 的 `ensureTestStore` INSERT FK 失败。
- **修复**：`helpers/fixtures.mjs` cleanup 第 4 段补一条按 order 的
  `store_id/opened_by/client_user_id LIKE NS` 兜底删除 point_transactions。纯测试基建健壮性，零语义改动。

## 并发污染（非代码 bug，干净窗口已验证 PASS）

首跑时 admin Playwright e2e 正并发跑同一 5434 库。staff L2 与之共享夹具客 FY-FIX-CLIENT-01 +
真实开单流水，并发增删导致以下 5 个 smoke 假失败，**干净独占窗口串行重跑全 PASS**：

| smoke | 假失败表现 | 机制 |
|-------|-----------|------|
| smoke-order-create-internal | `-403 仅店长可执行此操作` | manager 的 org 节点/角色被并发 cleanup 清掉 → requireManager 见 scopeType=NULL |
| smoke-order-deposit | `-403 仅店长可执行此操作` | 同上 |
| smoke-product-skulist | `permission_roles_employee_id_fk` | createTestStaff 插 permission_roles 时父 staff 行被并发清掉 |
| smoke-mgmt-customer | `越权访问其他市场数据` / `顾客不存在` | 4 个测试顾客被并发 cleanup 删掉 |
| smoke-order-refund / repay | （另含 #2 的真缺口）| 兼有残留孤儿阻断 |

已更新记忆 [e2e-shared-namespace-contention]：补记 admin e2e 也是污染源。

## 待决策（请统一处理，未改动）

### D-1. 夹具 `createTestSaleOrder` vs `createTestSaleItem` 的 unit_real_price 语义不一致

- `createTestSaleOrder`（fixtures.mjs:596）：`unit_real_price = totalAmount/quantity`（**整卡价**）。
- `createTestSaleItem`（另一 helper）：按 **per-session 单次价** 语义（smoke-service-commission 注释
  "单 item 总额 = unitRealPrice × sessionCount" 印证）。
- 两者矛盾，且 `createTestSaleOrder` 的整卡价违反 [sale-items-money-fields]（unit_real_price 应为单次价）。
- 本轮只对 refund-freeze 做了局部修正；**未统一共享 helper**，因为有 10 个 smoke 用 `sessionCount>1`
  建单，改默认值可能波及它们的提成/退款断言。
- **决策点**：是否把 `createTestSaleOrder` 的 `unit_real_price` 统一改为
  `sale_amount/(quantity×session_count)`（疗程卡 per-session）？需逐个核对受影响 smoke 的断言。

### D-2. L2 测试隔离根治（共享 TE2L2 命名空间 + 5434 单库）

- 现状：client L2、staff L2 共用 `TE2L2_` 命名空间；admin e2e 共用 5434 库 + 夹具客 FY-FIX-CLIENT-01。
  三者并发即互相污染，假失败非确定性。本轮靠"抓干净窗口串行跑"规避。
- **决策点**：是否根治？候选方案——(a) 各端 L2 用独立命名空间前缀；(b) CI 串行化所有打 5434 的 e2e +
  跑前独占锁。属测试架构改造。

### D-3. L2 覆盖盲区（建议补 smoke，补哪些属判断）

逐一比对路由表 action 与现有 smoke，以下**近期新增功能无专属 L2 smoke**（按业务重要度排序）：

| 缺口 | action | 重要度 | 备注 |
|------|--------|--------|------|
| 储值卡退款 | `card.createRefund` / `card.approveRefund` / `card.rejectRefund` | 高（财务） | 已有 order 退款三联 smoke，可镜像；现仅 card.recharge/balance 有 smoke |
| 提货流程 | `order.createPickup` / `availablePickupItems` / `pickupRecordsList` | 中 | 库存域 v1（[inventory-domain-v1]），全链路无覆盖 |
| 寄存单历史实收 | `order.updateDepositReceived` | 中 | 5972dcb1 新增，无覆盖 |
| 门店库存只读 | `inventory.list` / `inventory.detail` | 低 | 只读，员工端展示用 |

> `service.confirm`（migration 0053「待客户确认」）已被 smoke-service-lifecycle 覆盖（含幂等），无需补。
>
> **决策点**：是否补这些 smoke？建议优先补储值卡退款（财务一致性 + 已有可镜像的 order 退款模板）。
> 提供 SKILL/夹具后可委派 subagent 实现。

## L3（e2e-miniprogram）未跑说明

L3 需要微信开发者工具以自动化模式监听 9420（IPv6）+ **已登录态**（cloud 调用要 access_token）。
本轮 9420 未监听，且无法自主完成扫码登录。需你在 IDE GUI 扫码登录 + 启动 automation 后我再跑：

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project /Users/nv/proj.xt.com/fengyu-wxapp/fengyu-staff/miniprogram --port 9420
until lsof -nP -iTCP:9420 -sTCP:LISTEN | grep -q IPv6; do sleep 3; done
bun fengyu-staff/tests/e2e-miniprogram/run-all.mjs
```

L3 历史遗留待决策项见 `RUN-REPORT-2026-05-22.md`（bs02 refund-detail 契约等），本轮未触及。

## 环境

- DB：`47.113.202.7:5434/fengyu`（开发库），L2=`TE2L2_*`、scope=`FY-TEST-*` 命名空间隔离
- 跑批工具：bun；首跑 L2 全套 ~1236s（53 smoke）
</content>
</invoke>
