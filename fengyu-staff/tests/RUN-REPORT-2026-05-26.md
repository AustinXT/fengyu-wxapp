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

## 决策项执行（用户 2026-05-26 已批准全部三项 + 多 Agent 并行）

> ⚠️ 执行期间本仓库有并行 git 操作（claude-review/MiniMax CI 分支的 checkout/merge/reset）一度把
> 未提交的 D-1/D-2 编辑冲掉；按用户决定「在 dev 工作区重做不提交」已重新应用。这些改动**未提交**。

### D-1. 统一 `createTestSaleOrder` 的 unit_real_price 为单次价语义 — ✅ 已改

- 原 `createTestSaleOrder`：`unit_real_price = totalAmount/quantity`（整卡价），与 `createTestSaleItem`
  的 per-session 语义矛盾，且违反 [sale-items-money-fields]。
- **改法**：`unit_real_price = sessionCount>0 ? totalAmount/(quantity×sessionCount) : totalAmount/quantity`
  （疗程卡按单次价，家居产品不变），`sale_amount` 仍为行应付总额。
- **连带修复**：① `smoke-order-conversion.mjs` 源卡 `totalAmount` 由 `500`（误填单次价）改为 `2500`
  （真实卡总额 = 5 次 × 500）；② `smoke-service-refund-freeze.mjs` 移除原 phase-1 的局部 `UPDATE`
  （helper 已直接产出正确单次价 100，无需局部修正）。
- **验证**：全部 order/service/alloc/product 类 + 全套通过（见末尾「最终结果」）。

### D-2. L2 测试隔离根治（独立命名空间前缀）— ✅ 已改

- **改法**：staff 端 L2 命名空间前缀 `TE2L2` → **`TE2LS`**（= TEST_E2E_L2_Staff），手机号段
  `19999099xxx` → `19999098xxx`，与 client 端（仍 `TE2L2` / `099` 段）彻底隔离。
- **关键陷阱**：不能用 `TE2L2S`（6 字符）——会被 client 的 `LIKE 'TE2L2%'` 命中而被 client cleanup 误删；
  `TE2LS`（5 字符，第 5 位 S≠2）与 `TE2L2` **互不为 LIKE 前缀**，双向无碰撞，且长度不变（零 varchar(30) 溢出风险）。
- **改动文件**：`setup.mjs`（NS + 号段常量 + 说明注释）、9 个 smoke 的硬编码手机号、`cleanup.mjs`
  （paynotify event_keys 过滤改用 NS 参数化）、`fixtures.mjs` 文档注释。
- **效果**：client L2 / staff L2 现可并发跑同一 5434 库而不互删夹具（admin e2e 用 FY-CHAIN/FY-TEST，本就不同前缀）。

### D-3. L2 覆盖盲区补 smoke — ✅ 4 个 Agent 并行新建，已实跑全 PASS

4 个 Agent 并行各写 1 个新 smoke（run-all 自动发现）：

| 新文件 | 覆盖 action | 断言要点 | 实跑 |
|--------|------------|---------|------|
| `smoke-card-refund.mjs` | card.createRefund/approveRefund/rejectRefund | 退款 face vs pay 双口径、approve 扣 balance + card_transactions 落账、reject 不动账 | ✅ PASS |
| `smoke-order-pickup.mjs` | order.availablePickupItems/createPickup/pickupRecordsList | 家居产品分次自提：picked_up_quantity 原子累加、幂等、超提拒、记录列表（自写 pickup_records cleanup） | ✅ PASS |
| `smoke-order-deposit-received.mjs` | order.updateDepositReceived | 寄存单历史实收 delete-rebuild、received 重算、4 条边界（负值/非寄存单/非店长/越界 item） | ✅ PASS |
| `smoke-inventory.mjs` | inventory.list/detail | procurement 单据 scope 过滤可见 + 明细 + 非法 docCategory 拒（自写 inventory_* cleanup） | ✅ PASS |

> `service.confirm`（migration 0053「待客户确认」）已被 smoke-service-lifecycle 覆盖，无需补。
> L2 smoke 总数 53 → **57**。

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
