# 审计报告：退款 / 退换货 (11) — v2（独立重审，2026-04-26）

**审计时间**：2026-04-26
**域 ID**：11
**审计员**：claude-sonnet-4-6
**说明**：本报告为独立重审，以代码为权威来源，上轮结论仅供参考。所有结论基于当前代码直接审查。
**审计时长**：~25 分钟
**关联 PR/Ticket**：ticket 2026-04-24-refund-admin-parity-and-rules（已落地三端 createRefund/approveRefund/rejectRefund）

---

## 1. 三端入口对照

| 层 | admin | staff | client |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:40-117`（saleOrders 含 refund 列）+ `db/schema/order.ts:241-287`（saleOrderPayments）+ `db/schema/enums.ts:5-16`（含 `'退款单'` / `'待审批'` / `'已关闭'`） | ↑ | — |
| Action / Route | `fengyu-admin/src/actions/refunds.ts:151`（getRefundable）`:268`（estimateRefundOverdraft）`:456`（createRefundOrder）`:778`（approveRefund）`:971`（rejectRefund）`:1061`（listRefunds）`:1110`（getRefundById） | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1332`（createRefund）`:1488`（approveRefund）`:1641`（rejectRefund）`:2482`（refundList）`:2526`（refundDetail）+ `routes/customer.js:675`（refundHistory，顾客视角列表） | — |
| 共享工具 | `fengyu-admin/src/lib/refund.ts:57/72/135/...`（buildRefundDetails / split / resolveRefundPaymentMethod） | `fengyu-staff/cloudfunctions/staffApi/utils/refund.js:19/37/103/126`（同源算法纯函数） | — |
| 前端 | `fengyu-admin/src/app/(main)/refunds/page.tsx` + `_components/`（列表+详情）+ `[id]/page.tsx` | `miniprogram/pages/order/refund/*`（开单退款入口）+ 顾客详情"退换记录" Tab | — |
| 测试 | `fengyu-admin/src/actions/refunds.test.ts` | `staffApi/__tests__/routes/order.test.js:2130~2498`（createRefund / approveRefund 主测） | — |
| 权限 | `fengyu-admin/src/lib/permissions.ts:35,44,58`（admin/manager/finance 3 角色含 `sale_order:refund`） | `routes/order.js:1333,1489,1642`（`requireManager()`）；非店长仅可 `refundList/refundDetail` 看自己开的 | — |

> client 不参与退款发起；顾客的退款只能通过 `staff.customer.refundHistory` 在员工端查看，无主动入口。

---

## 2. 数据流图

```
[发起]  staff/admin createRefund
   │ scope+state 校验 → 校验 in-flight 唯一性 → buildRefundDetails(unitRealPrice × unused)
   │ → split refundByCard / refundByOrigin → resolveRefundPaymentMethod
   ▼
   sale_orders (FY-TKD-WX-, status=待审批, type=退款单, total_amount=负数)
   sale_items (item_direction=退出, ref_sale_item_id, sale_amount/received 为负)
   sale_order_payments × 1~2 (挂在原销售单, change_type=退款, amount<0, status=待支付)

[审批]  staff/admin approveRefund
   │ CAS UPDATE FY-TKD '待审批'→'已支付' (rowCount 哨兵)
   │ → 扣减原行 remaining_sessions（疗程卡）
   │ → 储值卡部分回冲 prepaid_cards.balance + INSERT card_transactions(type=充值)
   │ → 翻 payments '待支付'→'已支付'
   │ → 重算原单 paid_amount/prepaid_card_amount = SUM payments
   │ → refreshSpendingTier + recalcCustomerType (staff) / refreshSpendingTierTx (admin)
   │ → settlePointsSafe (staff only)
   ▼
   原 sale_orders.paid_amount 减少；FY-TKD.paid_amount=负；spending_tier 可能下移
   ❌ sale_allocations 不联动作废（P0-07-02）
   ❌ service_commissions 不联动冲销（P0-08-04）
   ❌ user_coupons 不回退（已用券保留 '已使用'）
   ❌ service_orders 已挂的不取消 / 不解绑

[驳回]  staff/admin rejectRefund
   │ CAS UPDATE FY-TKD '待审批'→'已关闭' (沿用 orderStatusEnum，无 '已驳回')
   │ → UPDATE payments 退款行 '待支付'→'已作废'
   ▼
   FY-TKD.status='已关闭' + rejected_reason；原单零变化
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-11-01]** 退款审批不冲销已写入的 sale_allocations / service_commissions（双重业绩资损 — 已知问题再确认 + 量化）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1488-1636`（staff approveRefund）+ `fengyu-admin/src/actions/refunds.ts:778-965`（admin approveRefund）
- **现象**：approveRefund 事务内仅
  1) 翻 FY-TKD 状态、扣 remaining_sessions、回冲储值卡、翻 payments、重算原单 paid_amount、刷 spending_tier+customer_type、settlePoints。
  2) **完全不动**原销售单的 sale_allocations（应按退款比例反向写负行或 `is_void=true`）。
  3) **完全不动**已完成服务单写入的 service_commissions。
- **风险**：
  - **销售提成资损**：员工早已按订单总额拿到分配奖金，顾客退款后业绩仍按未退款金额结算 → 反向工资差额永久不追回；按部分退（如 30%）/ 全退口径都失血。
  - **服务提成资损**：疗程卡退款的剩余次数即使被回扣（`remaining_sessions -= quantity`），已经服务过的次数所产生的 service_commissions 行不冲销。极端：顾客做 1 次退 9 次的疗程，1 次的提成留存合理；但若员工服务 0 次后退款，仍可能有 0 次提成残存（取决于是否进入 service_orders.complete）。
- **复现**：
  1. 销售单总额 ¥1000，已分配给员工 A 70% / B 30%（sale_allocations 各 1 行）。
  2. 全额退款 → approveRefund：`sale_allocations.is_void` 仍为 false；员工绩效报表的 `SUM(total_amount WHERE is_void=false)` 仍包含 ¥1000。
- **修复（L3 + L7）**：
  - 在 approveRefund 事务内追加：`UPDATE sale_allocations SET is_void=true, voided_at=NOW() WHERE sale_item_id IN (SELECT ref_sale_item_id FROM sale_items WHERE sale_order_id=$tkdId)` 部分退则按比例插负行（需新增 `parent_alloc_id` 列追溯）。
  - service_commissions 同理：增加 voided_at 列（详见 audit-08 P0-08-05），按 sale_item_id 关联软作废。
- **互引**：CROSS-CUTTING.md「退款审批不冲销已写入提成 / 分配（资损）」+ audit-07 P0-07-02 + audit-08 P0-08-04（本次为退款域明确再确认且确认 admin 路径同样未补丁）。

#### **[P0-11-02]** createRefund 的 in-flight 唯一性事务外读（TOCTOU 重复退款单）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1352-1358` + `fengyu-admin/src/actions/refunds.ts:503-516`
- **现象**：staff/admin 都用 `pg.query` / `db.select`（事务外）查 `WHERE ref_sale_order_id=$1 AND status='待审批'`，然后才进 `pg.transaction` INSERT。两个店长同时点"退款"，两次查询均返回 0 行 → 都进事务 → 都 INSERT FY-TKD-* 行 → 同一原单存在 2 笔 `'待审批'` 退款单。
- **风险**：
  - 第二张退款单 approveRefund 时也能扣储值卡 + 翻 payments → **顾客被回款两次**（如果 split 拆分把两笔退款都给到原通道，顾客实际只承担 0 元 → 对商家直接资损 = 退款金额）。
  - 即使触发金额上限校验（remaining_sessions 不足），仍占用 advisory lock 资源浪费 + 异常态。
- **修复（L0 + L3）**：
  - L0：加 partial unique index — `CREATE UNIQUE INDEX uq_refund_inflight ON sale_orders(ref_sale_order_id) WHERE sale_order_type='退款单' AND status='待审批'`。
  - L3：把 in-flight 检查移到事务内（`SELECT ... FOR UPDATE`），并加 partial unique 兜底。
- **关联**：CROSS-CUTTING.md「TOCTOU 校验：事务外读 → 事务内 INSERT，无 partial unique 兜底」+ audit-03 P0-03-04（首次发现于 03 域）。

#### **[P0-11-03]** staff createRefund advisory lock 双事务窗口可重号
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1391`（generateOrderNo）+ `:1393`（pg.transaction INSERT）+ `:2452-2474`（generateOrderNo 自带事务）
- **现象**：`generateOrderNo('FY-TKD-WX-')` 内部 `pg.transaction` 取 advisory lock + 读最大序号 + commit；再开新事务 `pg.transaction` 做 INSERT。两段中间 advisory lock 已释放，并发可读到相同 maxSeq → 同一日期生成相同 `FY-TKD-WX-YYMMDD0001`，第二段 INSERT 触发 PK 冲突（22505）→ ctx.result 写不到，但 sale_order_id_gen 状态被打乱。
- **风险**：高并发下首单成功、并发单 INSERT 抛错；用户体验差且错误回滚后顾客可能多收 toast。同 audit-02 P0-02-01。
- **修复（L3）**：把 advisory lock + maxSeq 计算 + INSERT 全部合并到同一 `pg.transaction`（`createRefund` 内部已经在事务里又跑一次 `pg_advisory_xact_lock + max(...)`，但前面外层 generateOrderNo 又跑了一次独立事务 → 显式废除外层调用，仅用事务内的那段）。注意现状中事务内**确实**有第二次 maxSeq 计算（`:1397-1402`），但生成的 `refundOrderId` 来自外层 generateOrderNo（事务外），并未使用事务内重算结果 → 实质上两次序号源不一致：外层用于 sale_orders.sale_order_id，事务内的 dateStr+seq 仅用于 sale_items 行 ID。该不一致需要在重构时合并。
- **关联**：CROSS-CUTTING.md「Advisory lock 跨事务释放窗口可生成重号」（首次发现 audit-02）。

#### **[P0-11-04]** 退款不回退已使用优惠券（资损 + 业务规则缺失）
- **文件**：staff/admin approveRefund 全流程；`fengyu-staff/cloudfunctions/staffApi/routes/order.js:525-528`（开单 set 已使用）；`:1093-1097`（仅 close 操作释放，approveRefund 无对应逻辑）
- **现象**：开单时 `UPDATE user_coupons SET status='已使用', used_sale_order_id=$saleOrderId, used_at=NOW()`；订单 close 时会 `UPDATE...SET status='未使用'` 释放；**退款 approve 时不释放**。顾客全额退款后券已被吞，无法再用。
- **风险**：
  - 资损（顾客侧）：用了 ¥100 现金券支付 → 退款只退 `unit_real_price × unused × split` → 券价值彻底消失，顾客等于亏了 ¥100。
  - 业务规则不一致：close 释放、refund 不释放，状态机断裂。
- **修复（L3）**：approveRefund 事务内追加：
  ```sql
  UPDATE user_coupons
     SET status='未使用', used_sale_order_id=NULL, used_at=NULL
   WHERE used_sale_order_id = $refSaleOrderId
     AND status = '已使用'
  ```
  仅当**全额退款**才释放（部分退款应保留已使用，按 partial 规则不退券或扣减券价值，需 PM 决策）。

#### **[P0-11-05]** customer.refundHistory 路由完全无 scope 隔离（PII / 越权读）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:675-741`
- **现象**：仅校验 `requireStaffBound()` + `clientUserId/clientPhone` 必填，无 `store_id` 过滤、无 `bound_store_id` 校验。任何已绑定员工（包括美容师、HQ 临时账号）输入任意 phone → 拿到该顾客**全集团**的退款单/转换单（金额、原因、原单号、明细 SKU）。
- **风险**：
  - PII 泄露：跨店窥视任何顾客的财务行为。
  - 与 audit-10 P0-10 系列「customer.{detail/calendar/giftHistory/refundHistory/updateNotes} 全无 scope」是同一类问题，但 refundHistory 暴露的是更敏感的财务细节。
- **修复（L3）**：注入 `effectiveStoreId` 过滤：`AND o.store_id = ANY($scopeStoreIds)`，或回退到该顾客 `bound_store_id IN ($scopeStoreIds)`。
- **关联**：audit-10 + CROSS-CUTTING.md「customer.* 跨店全局可读改」。

#### **[P0-11-06]** approveRefund 在原单已存在多笔退款时算法假设错误（部分退款累计资损）
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1519-1524` + `splitRefundByOriginalPayment(refundAmount, origPrepaidCardAmount, origTotalAmount)`
- **现象**：`approveRefund` 用 **原单 prepaid_card_amount / total_amount 比例**拆分本次退款。但原单 prepaid_card_amount 在第 1 次退款 approve 后已被 `重算 = SUM payments(储值卡抵扣) + 已退款负行` 修改（变小 / 含负数）；第 2 次 createRefund / approveRefund 拿到的是变化后的快照，而**算法注释明确说"原单储值卡抵扣比例"应该是开单时的初始比例**。
- **风险**：连续 2 次退款 → 第 2 次的 split 用了"已扣过一次的 prepaid"作分母，比例失真 → refundByCard / refundByOrigin 偏离；金额对账漂移。
- **复现**：
  - 原单：total=1000, prepaid=400 → ratio=0.4
  - 退 600：refundByCard=floor(0.4×600)=240, refundByOrigin=360 → approve 后 prepaid 变为 400-240=160, paid_amount 减 360
  - 第 2 次退 400：此时 origPrepaidCardAmount=160（变小后的）→ ratio=160/(实际总=??) → split 错位
- **修复（L0 + L3）**：把"原始储值卡抵扣比例"作为快照存到 sale_orders（如新增列 `original_prepaid_ratio` 或在退款时从 `sale_order_payments WHERE change_type='储值卡抵扣' AND status='已支付'` 累计取数，而非依赖 sale_orders.prepaid_card_amount）。审批时也应从这个快照读，避免链式漂移。

#### **[P0-11-07]** rejectRefund 用 '已关闭' 复用 orderStatus，丢失审批语义
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1660` + `fengyu-admin/src/actions/refunds.ts:1010`
- **现象**：driverRefund 写入 `status='已关闭'` + `rejected_reason`。`orderStatusEnum` 含 `'已关闭'` 但**没有** `'已驳回'`。同时同一枚举的 `'已关闭'` 还被 staff order.close（关闭超时未支付订单）使用。混用导致：
  - 列表筛选无法区分"驳回"与"超时关闭"，只能 join `rejected_reason IS NOT NULL` 推断，破坏语义。
  - `audit-02` 已发现 close/cancel/refund 共用 '已关闭'。本次为退款 reject 路径再次确认。
- **风险**：报表口径错乱、用户/审计追溯困难；**严格说不构成资损**，但会让"驳回数 / 关闭数 / 取消数"的看板指标全部错位（admin dashboard 已知有"退款单状态筛选 ['待审批','已支付','已关闭']"，对外暴露 '已关闭' 即驳回，UI 文案与状态枚举耦合脆弱）。
- **修复（L0 + 全栈）**：在 `orderStatusEnum` 追加 `'已驳回'`，rejectRefund 写入新值；admin 列表筛选 + UI 同步。属于 schema 级变更，影响范围大但收益高。
- **关联**：audit-02 P1-02 系列已知"状态枚举混用"问题。

> **P0 计数**：7 项。其中 P0-11-01 / P0-11-04 是直接资损；P0-11-02 / P0-11-03 是并发资损；P0-11-05 是越权 / PII；P0-11-06 是金额对账漂移；P0-11-07 是审计语义破坏。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-11-08]** staff approveRefund / createRefund / rejectRefund **全无 operation_logs 写入**
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1332-1679`（搜遍三函数 0 处 operation_logs / logOperation 调用）；admin `refunds.ts:747,759,955,1046` 4 处 logOperation 写入完整。
- **现象**：员工端店长执行的退款全程不留审计日志；同一动作 admin 端**完整记录**（含 finalRefundAmount / overdraft / refundByCard / refundByOrigin）。审计断裂。
- **风险**：店长发起的退款无法事后追溯，与 admin AC-11 全覆盖背道而驰。
- **修复（L3）**：staff 内部仿 admin `logOperation`（staffApi 没有现成 helper，需补一个 `utils/operation-log.js`）。
- **关联**：CC9 测试与残留；与 audit-07/08 staff 端 operation_logs 缺失同源。

#### **[P1-11-09]** estimateRefundOverdraft 越权可读任意 userId 的会员等级 + 12 月消费 + 已用券明细
- **文件**：`fengyu-admin/src/actions/refunds.ts:268-450`
- **现象**：仅 `requirePermission(session, 'sale_order:refund')`；不校验 `userId` 是否属于 session 的 scope，不校验 `originalSaleOrderId` 是否属于该 userId。任何 manager（绑了店长权限的 finance 也行）都能传任意 userId 拿到该顾客 12 月累计消费 / member_level 升级时间 / 已使用 upgrade-coupon 列表 / 积分余额。
- **风险**：PII 跨店窥视；尤其 `usedCoupons` 暴露券号 + discount_value，可用于伪造券。
- **修复（L7）**：加 `scopeCondition` 校验 `clientWechatUsers.boundStoreId` ∈ session.scopeStoreIds，且校验 `originalSaleOrderId` 属于该 userId。

#### **[P1-11-10]** 退款单 paid_amount/prepaid_card_amount 写负值，违反 chk_sop_amount_sign 之外的"sale_orders 金额非负惯例"
- **文件**：staff `:1535`（`paid_amount = -refundByOrigin`）；admin `:838-840`（`paid_amount = (-refundByOrigin).toFixed(2)::numeric`）
- **现象**：FY-TKD 凭证单 `total_amount`/`paid_amount`/`prepaid_card_amount` 全为负数。schema 仅 sale_items 有 `chk_item_unit_price >= 0`，sale_orders 无。但下游 admin 的"订单总额"统计如果不区分 saleOrderType 而做 SUM，会出现 净额自动减去退款 — 这是**双刃**：业绩报表想要的就是净额，但**未支付订单合计 / 应收**等口径必须排除退款单，否则金额漂移。
- **现状校验**：staff `routes/staff.js` performanceDetail / dashboard 多处 SUM(total_amount) WHERE sale_order_type='销售单'，明确排除。但 admin orders 列表 / customer.paidOrders 等若不显式过滤 type 会被退款单减低。
- **风险**：跨域聚合查询不一致。
- **修复（L7）**：所有 SUM(saleOrders.totalAmount/paidAmount) 显式带 `AND sale_order_type='销售单'`（已多数遵守，需查漏）。

#### **[P1-11-11]** createRefund 写 `payable_amount=0` 但原单 payable_amount 计算口径不在退款单上反映
- **文件**：admin `refunds.ts:653`（`payableAmount: '0'`）；staff 未显式给 payable_amount → 用列默认值 `'0'`。
- **现象**：FY-TKD payable_amount=0 / paid_amount=负 / total_amount=负，三者关系破坏 `payable_amount = total - prepaid_card`。schema 注释 `:64` 明确 payable_amount = total - prepaid 冗余列；退款单破坏此不变量。
- **风险**：任何依赖该不变量做对账 / 校验 / 测试断言的代码会在退款单上失败。
- **修复（L3）**：要么把 payable_amount 也设负值保持一致；要么在 schema/约定文档中明确"退款单 payable_amount 总是 0"并在 migration 加 CHECK 排除约束。

#### **[P1-11-12]** rejectRefund 不刷新 spending_tier / customer_type
- **文件**：staff `:1657-1676`；admin `:1006-1033`
- **现象**：rejectRefund 仅翻 FY-TKD 状态 + 作废 payments 待支付行；不调 refreshSpendingTier。
- **现状评估**：被作废的 payments 是 `status='待支付'`，spending_tier 计算口径都用 `status IN ('已支付','已完成')` of sale_orders（非 payments），逻辑上无影响 — 但若未来口径切到 payments 流水，rejectRefund 必须同步刷新。
- **风险**：依赖隐式正确，不防御性编程。
- **修复（L3）**：建议在 rejectRefund 末尾追加 refresh，与 approve 对称。

#### **[P1-11-13]** approveRefund 内储值卡 UPSERT 用 `card_id = FY-CARD-${Date.now()}${rand(3)}` 防冲突弱
- **文件**：staff `:1570`；admin `:882`
- **现象**：当顾客 prepaid_cards 行不存在时 UPSERT 兜底插入，card_id 用 `Date.now()` + 3 位随机数。Date.now() 毫秒级 + 3 位随机 = 1000 个空间，不能保证唯一（虽然有 ON CONFLICT，但冲突的 card_id 不是冲突键，user_id 才是 → ON CONFLICT (user_id) DO UPDATE，所以 EXCLUDED.balance 是新的，但 card_id 仍是冲突的随机值，被 EXCLUDED.balance UPDATE 后 card_id 不变）。注意：当 user_id 已存在时，EXCLUDED 的 card_id 不写入 → 不冲突，仅 balance 累加。
- **现状评估**：因 user_id 是 unique 约束，逻辑正确；card_id 在 ON CONFLICT 路径下不被使用。但代码 readability 差，且在测试场景下若同一秒并发跑两次"无卡顾客退款"理论可能 INSERT 两次（虽然 ON CONFLICT 兜底会归约为一行）。
- **风险**：低，但 card_id 命名熵不足。建议改 `crypto.randomUUID()` 或 `nanoid()`。

### 3.3 P2

#### **[P2-11-14]** refundHistory / refundList / refundDetail SQL `ORDER BY created_at DESC` 与 admin sys.spec §5"列表默认排序：业务时间 desc"建议不一致
- **文件**：staff `routes/order.js:2513`（`ORDER BY r.created_at DESC`）；admin `refunds.ts:1097`（`desc(updatedAt), desc(createdAt)`）
- **现象**：admin 用 updatedAt（编辑即浮顶）；staff 用 createdAt。同一资源两端排序口径分裂。
- **修复**：staff 改齐 admin 口径或在 spec 加例外注释。

#### **[P2-11-15]** estimateRefundOverdraft 错误吞没（catch {} 静默）
- **文件**：admin `:240-252`（`loadUpgradeBenefitsMap` `catch { return {} }`）+ `:1318-1320`（`refreshSpendingTierTx` 的 system_configs 读失败 fallback 到默认值）
- **现象**：JSON 解析失败 / 配置读失败 → 静默降级。无 console.error 输出。
- **风险**：升级权益误算 → suggestedOverdraftDeduction 长期为 0 难发现。
- **修复**：catch 处 `console.error`。

#### **[P2-11-16]** payment_method='线下' 兜底 + 注释里说"下一 ticket 集成三方 refund API"已成 TODO 漂移
- **文件**：`utils/refund.js:117-134` + `lib/refund.ts` 同源
- **现象**：微信/支付宝原单 → 退款 payments 行 payment_method 强制改为 '线下'（需店员现场退现金）。当前流程 payNotify 也不处理 refund 回调（grep 0 命中）。
- **风险**：业务上"原路退回"完全靠人工，与微信小程序行业规范不符。
- **修复**：单独 ticket 集成微信 V3 退款 API。

#### **[P2-11-17]** rejectRefund 必须传 rejectedReason，但 staff 端不校验非空（admin 校验）
- **文件**：staff `:1644-1645`（仅校验 saleOrderId）；admin `:980-981`（校验 reason 非空）
- **现象**：staff 允许空字符串作为 rejected_reason → 写入 `''`。
- **修复**：staff 端补 `if (!rejectedReason) throw new Error('INVALID_PARAMS: 驳回原因不能为空')`。

#### **[P2-11-18]** admin createRefundOrder 支持 `applyOverdraftDeduction=false` 旁路；staff 不支持，参数不对等
- **文件**：admin `refunds.ts:462,564-565`；staff 无此参数
- **现象**：admin 可显式跳过 overdraft 扣减；staff 永远扣（调用 estimate）。同一动作行为分裂。
- **修复**：staff 接入 estimate（目前 staff createRefund 完全不调 estimateRefundOverdraft → 跌档退款不扣已享权益 = 资损）→ 或确认两端策略差异是产品决策。

#### **[P2-11-19]** approveRefund 在 split 后写 sale_orders.paid_amount = -refundByOrigin（**单次写**）；下面又 SUM payments 重算覆盖（**双写**）
- **文件**：admin `:836-841` 先写 `-refundByOrigin`；`:911-929` 又 `UPDATE...paid_amount=newPaid` 覆盖（针对 refSaleOrderId）。但前者写的是 FY-TKD 自己，后者是原单 → 实际两个不同 row。读时不冲突，但变量名 `paidAmount` 混淆。
- **风险**：低，仅 readability。
- **修复**：注释明确"FY-TKD.paid_amount 为本次退款的原通道部分（负值快照）；refSaleOrder.paid_amount 由 SUM payments 重算"。

---

## 4. 跨端不一致

| 维度 | admin | staff | 风险 | 优先级 |
|------|-------|-------|------|--------|
| 鉴权 | `requirePermission('sale_order:refund')` 含 admin/manager/finance 3 角色 | `requireManager()` 仅店长 | finance 在 admin 能审批退款，staff 不能。**业务规则差异**还是 BUG？需 PM 确认 | P1 |
| in-flight 唯一性检查 | 事务外 db.select | 事务外 pg.query | 同 P0-11-02，两端均存在 | P0 |
| operation_logs | 4 处写入完整 | 0 处 | 审计断裂 | P1 (P1-11-08) |
| 已驳回状态 | status='已关闭' | status='已关闭' | 同步问题，但都未独立定义 '已驳回' | P0 (P0-11-07) |
| overdraft 扣减 | 实现完整（estimateRefundOverdraft + overdraft_deduction 列） | **未实现**，跌档顾客退款不扣已享权益 | 资损（顾客白嫖升级权益） | P1 |
| 排序口径 | desc(updatedAt), desc(createdAt) | desc(created_at) | 列表浮顶语义不一致 | P2 |
| service_fee 退款行 | `(d.serviceFee \|\| 0).toFixed(2)`（admin 写正值） | `d.serviceFee \|\| 0`（staff 写**负值**：`utils/refund.js:67` `refundServiceFee = -...`） | **service_fee 符号不一致**（admin 退款行 service_fee=正，staff 退款行=负） — 影响服务提成计算？ | P1 |
| approveRefund 扣减 remaining_sessions | 同（CAS WHERE remaining_sessions >= ri.quantity） | 同 | OK | — |
| 回退 user_coupons | 不实现 | 不实现 | 同 P0-11-04 | P0 |
| 回滚 sale_allocations | 不实现 | 不实现 | 同 P0-11-01 | P0 |
| 冲销 service_commissions | 不实现 | 不实现 | 同 P0-11-01 | P0 |

> **新发现的跨端不一致**：admin 写退款行 service_fee 为正（绝对值），staff 写为负（带符号）。`buildRefundDetails` 在两端都返回 `serviceFee: refundServiceFee`（已是负值），但 staff `INSERT (service_fee) VALUES ($16)` 直接 `d.serviceFee || 0`（保留负），admin `(d.serviceFee || 0).toFixed(2)` 也保留负 — 实际两端**一致**，刚才误读。✅ 撤回此条，留 P2 提示后续核对。

---

## 5. 横切检查（套用 §3 模板）

- [ ] **CC1 数值精度**：split / handlingFee / overdraftDeduction 均使用 Math.round * 100 / 100；`Number()` 直接用 → 浮点 ε 风险存在但被 round 兜底。**P0-11-06**（多次退款分母漂移）属算法层缺陷而非精度。
- [ ] **CC2 并发幂等**：3 项 P0（P0-11-02 in-flight 事务外读、P0-11-03 advisory lock 双事务、approveRefund CAS 哨兵 ✓ OK）
- [ ] **CC3 组织域隔离**：P0-11-05（refundHistory 无 scope）+ P1-11-09（estimateRefundOverdraft 可读任意 userId）
- [x] **CC4 后端鉴权**：admin requirePermission 完整；staff requireManager 完整。✓ OK
- [ ] **CC5 错误码**：staff 用 `INVALID_PARAMS:` / `CONFLICT:` / `INVALID_STATE:` / `PERMISSION_DENIED:`；admin 用 `code: 'INVALID_PARAMS' | 'INVALID_STATE' | 'CONCURRENT_CHANGED' | 'CONFLICT' | 'CARD_UPSERT_FAILED' | 'ORDER_ID_GEN_FAILED' | 'ORDER_ID_CONFLICT' | 'INSUFFICIENT_SESSIONS' | 'UNKNOWN'`。两端语义差异。staff `CONFLICT:` 与 PLAN 4 项约定不在列。
- [ ] **CC6 PII**：P1-11-09（estimateRefundOverdraft 暴露券号 + 12 月消费）
- [ ] **CC7 时间字段**：approveRefund 写 paid_at + approved_at + updated_at = now（一致）；rejectRefund 同 ✓
- [x] **CC8 WXML/Vant**：客户端无入口
- [ ] **CC9 测试与残留**：staff 测试覆盖完整（`order.test.js:2130-2498` 含 createRefund 13 个 case）；admin 有 `refunds.test.ts`；操作日志 staff 0 写入（CC9 表面通过但隐含审计断裂）

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/enums | `db/schema/enums.ts:5` | `orderStatusEnum` 追加 `'已驳回'` | P0-11-07 |
| L0 schema | `db/schema/order.ts` | 新增 partial unique `uq_refund_inflight ON sale_orders(ref_sale_order_id) WHERE sale_order_type='退款单' AND status='待审批'` | P0-11-02 |
| L0 schema | `db/schema/order.ts` saleAllocations / service_commissions | 加 `voided_at`（sa 已有，sc 需补） | P0-11-01 + audit-08 P0-08-05 |
| L3 staffApi | `routes/order.js:1332-1476 createRefund` | 1) 在事务内做 in-flight 检查 + maxSeq；2) 移除 `generateOrderNo` 外层调用，改在事务内拼号；3) 加 user_coupons 释放（仅全额退） | P0-11-02, P0-11-03, P0-11-04 |
| L3 staffApi | `routes/order.js:1488-1636 approveRefund` | 1) 加 `UPDATE sale_allocations SET is_void=true...`；2) 加 `UPDATE service_commissions SET voided_at=...` 待 schema 就绪；3) 释放 user_coupons；4) 加 logOperation；5) split 用持久化的 original_prepaid_ratio 而非动态 prepaid_card_amount | P0-11-01, P0-11-04, P0-11-06, P1-11-08 |
| L3 staffApi | `routes/order.js:1641-1679 rejectRefund` | 1) 校验 rejectedReason 非空；2) status 改 '已驳回'；3) 加 logOperation | P0-11-07, P1-11-08, P2-11-17 |
| L3 staffApi | `routes/customer.js:675-741 refundHistory` | 加 `AND o.store_id = ANY($scopeStoreIds)` | P0-11-05 |
| L7 admin | `actions/refunds.ts:268 estimateRefundOverdraft` | 加 scopeCondition + 校验 originalSaleOrderId 属于 userId | P1-11-09 |
| L7 admin | `actions/refunds.ts:778 approveRefund` | 1) 同 staff 加 sa/sc/coupon 反向；2) 用 original_prepaid_ratio 快照 | P0-11-01, P0-11-04, P0-11-06 |
| L7 admin | `actions/refunds.ts:971 rejectRefund` | status 改 '已驳回'；同步 UI 文案 | P0-11-07 |
| L9 前端 | `fengyu-admin/src/app/(main)/refunds/_components/*` | 状态筛选 ['待审批','已支付','已驳回']（替换 '已关闭'）；显示业绩冲销结果 | P0-11-07 |

---

## 7. 验证 SQL（仅 SELECT / EXPLAIN，目标 5434/fengyu）

```sql
-- 1) 检查同一原单是否存在多笔 '待审批' 退款单（P0-11-02 实证）
SELECT ref_sale_order_id, COUNT(*) AS pending_refunds
FROM sale_orders
WHERE sale_order_type = '退款单' AND status = '待审批'
GROUP BY ref_sale_order_id
HAVING COUNT(*) > 1;

-- 2) 检查退款单号重复（P0-11-03 实证）
SELECT sale_order_id, COUNT(*) AS dup
FROM sale_orders
WHERE sale_order_type = '退款单'
GROUP BY sale_order_id
HAVING COUNT(*) > 1;

-- 3) 已批准退款但 sale_allocations 仍有效（P0-11-01 业绩资损量化）
SELECT
  refund.sale_order_id        AS refund_id,
  refund.total_amount         AS refund_amount,
  COUNT(sa.id)                AS active_allocations,
  SUM(sa.total_amount)        AS active_amount
FROM sale_orders refund
JOIN sale_items si_refund ON si_refund.sale_order_id = refund.sale_order_id
                          AND si_refund.item_direction = '退出'
JOIN sale_allocations sa ON sa.sale_item_id = si_refund.ref_sale_item_id
                         AND sa.is_void = false
WHERE refund.sale_order_type = '退款单'
  AND refund.status = '已支付'
GROUP BY refund.sale_order_id, refund.total_amount
ORDER BY active_amount DESC
LIMIT 20;

-- 4) 已批准退款但原单 user_coupons 仍 '已使用' （P0-11-04 量化）
SELECT
  refund.sale_order_id      AS refund_id,
  uc.coupon_id,
  uc.used_sale_order_id     AS orig_sale_order_id,
  ct.discount_value
FROM sale_orders refund
JOIN user_coupons uc ON uc.used_sale_order_id = refund.ref_sale_order_id
                     AND uc.status = '已使用'
JOIN coupon_templates ct ON ct.template_id = uc.template_id
WHERE refund.sale_order_type = '退款单'
  AND refund.status = '已支付'
LIMIT 20;

-- 5) 退款单 prepaid_card_amount / paid_amount 符号校验（P1-11-10）
SELECT sale_order_id, total_amount, paid_amount, prepaid_card_amount, payable_amount
FROM sale_orders
WHERE sale_order_type = '退款单'
  AND (total_amount > 0 OR paid_amount > 0 OR prepaid_card_amount > 0)
LIMIT 10;

-- 6) refundHistory 跨店泄露 actor 验证（CROSS-CUTTING 后续证据）：
--   员工 A 在门店 X，但顾客 Y bound_store_id = Z；A 应不可见 Y 的退款。
EXPLAIN SELECT o.sale_order_id, o.total_amount
FROM sale_orders o
WHERE o.client_user_id = 'cwu-y'
  AND o.sale_order_type IN ('退款单', '转换单');
-- 实际无 store_id 过滤 → 任何 staff 凭 OPENID 都可见。
```

---

## 8. 回归测试用例（建议）

1. **并发 createRefund**：同一原单 2 个 store_manager 同时点退款 → 仅一笔成功，第二笔抛 `CONFLICT`（依赖 P0-11-02 修复后的 partial unique）。
2. **退款链式漂移**：原单 1000+400 prepaid，分 3 次部分退（300+300+400），每次 approve 后核查 split 比例使用初始 0.4 而非动态值（依赖 P0-11-06 修复）。
3. **退款回退优惠券**：开单用 coupon C1（discount=100），全额退款后查 `user_coupons.coupon_id=C1` → status='未使用'（依赖 P0-11-04 修复）。
4. **退款冲销分配**：原单已分配 emp A 70% / B 30%，全额退款后 `sale_allocations WHERE sale_item_id=$origItem AND is_void=false` → 0 行（依赖 P0-11-01 修复）。
5. **rejectRefund 必填驳回原因**：staff 端传空 rejectedReason → 抛 `INVALID_PARAMS`（依赖 P2-11-17 修复）。
6. **跨店读 refundHistory**：员工绑定门店 X，传 phone 属于门店 Z 的顾客 → 返回空列表（依赖 P0-11-05 修复）。
7. **跌档退款扣 overdraft**：staff 端发起的退款若顾客会员将跌档，应扣减已享权益（依赖 P2-11-18 修复）。
8. **rejectRefund 状态枚举**：拒批后 `sale_orders.status='已驳回'`（依赖 P0-11-07 修复）。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（admin + staff + DB schema）：☑
- 涉及历史数据：☑（已批准退款的 sale_allocations / service_commissions / user_coupons 历史回溯需要数据修复脚本）
- 修复成本：**L**（schema 改动 + 三端 actions/routes 改动 + 操作日志补 + 历史数据清理）

---

## 10. 后续待办

- [ ] 与 PM 确认：finance 角色在 admin 可审批退款 vs staff 仅 manager → 业务策略统一
- [ ] 与 PM 确认：部分退款时优惠券不退 vs 按比例扣回券价值 → 当前完全不实现
- [ ] 与 PM 确认：退款是否取消 service_orders / 仅扣 remaining_sessions（当前仅扣次）
- [ ] 写补丁 migration：
  - `orderStatusEnum` 加 `'已驳回'`
  - `sale_orders` partial unique `uq_refund_inflight`
  - `service_commissions` 加 `voided_at` / `is_void`
- [ ] 写数据修复脚本：把已批准退款的 sale_allocations / user_coupons / service_commissions 反向冲销（需快照"何时已退款"）
- [ ] 集成微信 V3 退款 API（替换"线下兜底"）
- [ ] staff 补 `utils/operation-log.js` helper，approveRefund/createRefund/rejectRefund 全 logOperation

---

## 11. 独立重审结论（2026-04-26，claude-sonnet-4-6）

**验证方法**：直接读源码，不依赖上轮报告。审查范围：
- `fengyu-admin/src/actions/refunds.ts`（1251 行，全读）
- `fengyu-admin/src/lib/refund-cascade.ts`（209 行，全读）
- `fengyu-admin/src/lib/refund.ts`（169 行，全读）
- `fengyu-admin/src/app/(main)/refunds/` 全部页面
- `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1354–1740`（退款相关）
- `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`（162 行，全读）
- `fengyu-staff/cloudfunctions/staffApi/routes/customer.js:675–816`（refundHistory）
- `db/schema/order.ts`（全读）；`db/schema/enums.ts`（全读）

### 11.1 与前轮报告的主要分歧

**架构层面关键差异（前轮报告存在误判）**：

前轮报告（v1）的数据流图中描述"退款不冲销 sale_allocations / service_commissions / user_coupons"为 P0-11-01 / P0-11-04，但本次实审发现：

**2026-04-26 sale-order-domain-refactor 已实现 5 通道级联冲销**：

- `fengyu-admin/src/lib/refund-cascade.ts` 实现了完整的 `cascadeRefund()` 函数，在 `approveRefund` 事务内调用：
  - 通道 1：`sale_allocations` SET `is_void=true, voided_at=NOW()`
  - 通道 2：`service_commissions` SET `is_void=true, voided_at=NOW(), voided_reason=$reason`
  - 通道 3：`user_coupons` 恢复 `status='未使用'`（仅未过期）
  - 通道 4：`point_transactions` INSERT 反向流水 `type='消费冲销'` + 重算 `client_wechat_users.points_balance`
  - 通道 5：`sale_items.picked_up_quantity` 反向恢复

- `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js` 同样实现了完整的 5 通道，被 `approveRefund` 调用。

因此，前轮报告将"5 通道全未实现"列为 P0 的描述**不再成立**。但审计发现了 staff/admin 两端实现存在差异，这是新的 P0 问题。

### 11.2 新增（或修正前轮）的确认发现

**[CONFIRM-P0-NEW-A]** staff `approveRefund` 中 `refunded_amount` 用累加法（admin 用重算法），多次退款后漂移

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1585–1591`
- staff：`SET refunded_amount = COALESCE(refunded_amount, 0) + $1`（累加）
- admin：`SET refunded_amount = COALESCE(-SUM(sop.amount::numeric)..., 0)`（重算，`fengyu-admin/src/actions/refunds.ts:793–803`）
- 风险：连续多次退款（驳回 + 重新发起）时累加错位，`received - refunded_amount` 净收入计算偏差
- 优先级：**P0**

**[CONFIRM-P0-NEW-B]** staff `cascadeRefund` channel-5（pickup 恢复）在整单退款（`saleItemId=null`）时完全跳过

- 文件：`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js:135–148`
- staff：`if (saleItemId && sessionCount && Number(sessionCount) > 0)` — saleItemId 为 null 时不执行 channel-5
- admin：`fengyu-admin/src/lib/refund-cascade.ts:181–198` — saleItemId 为 null 时按 saleOrderId 清零所有 `picked_up_quantity > 0` 的行
- 风险：家居产品整单退款后 `picked_up_quantity` 不归零
- 优先级：**P0**

**[CONFIRM-P0-NEW-C]** staff `cascadeRefund` channel-5 有额外 `AND product_type = '家居产品'` 限制，admin 无

- 文件：`fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js:144`
- admin：`fengyu-admin/src/lib/refund-cascade.ts` 无此限制
- 优先级：**P0**（防御性，未来可能漏）

**[CONFIRM-P0-NEW-D]** staff `refreshSpendingTier` 不使用 `received - refunded_amount`，退款后消费档位不下降

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:40–63`
- staff：`SUM(total_amount)`，无 `refunded_amount` 扣减，无 `sale_order_type` 过滤（含内部单）
- admin：`SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0))` + `sale_order_type IN ('销售单','转换单')`（`fengyu-admin/src/actions/refunds.ts:1230–1250`）
- 优先级：**P0**

**[CONFIRM-P0-NEW-E]** `uq_sop_status_audit` DB partial unique 约束已存在（migration 0018），但前轮报告的 `uq_refund_inflight` 建议针对旧架构（sale_orders），已不适用新架构（退款下沉至 sale_order_payments）

- 验证：`db/migrations/0018_black_madrox.sql:32` 已建 `uq_sop_status_audit`：
  `CREATE UNIQUE INDEX ON sale_order_payments(sale_order_id, change_type) WHERE change_type='退款' AND status='待审批'`
- 结论：in-flight 唯一性已由 DB 兜底，前轮 P0-11-02 中关于"需补 partial unique"的部分**已落地**。
- 但：`createRefund` 仍在事务外做 SELECT 预检（race window 仍存在），DB 兜底可防止双写，仅导致第二个并发请求收到 `23505` DB 错误，`createRefund` 已捕获并映射为 `CONFLICT` 响应（`fengyu-admin/src/actions/refunds.ts:670–672`；staff 类似）。**现状可接受，非阻断性 P0**。降为 P1。

**[CONFIRM-P1-NEW-F]** `sale_orders` schema 中仍保留 7 个旧退款字段（新架构已下沉至 `sale_order_payment_details`）

- 文件：`db/schema/order.ts:94–108`（`refundReason`/`handlingFee`/`approvedBy`/`approvedAt`/`rejectedReason`/`overdraftDeduction`/`overdraftDeductionDetail`）
- 这些字段属于旧"退款单"概念，2026-04-26 重构后退款数据完全在 `sale_order_payment_details` 中
- 建议：migration DROP 这 7 列（确认无代码引用后）
- 优先级：**P1**

**[CONFIRM-P1-NEW-G]** admin 退款详情页手机号未脱敏

- 文件：`fengyu-admin/src/app/(main)/refunds/[id]/page.tsx:83`
- `{refund.clientPhone || '-'}` 展示完整手机号
- 优先级：**P1** (CC6)

**[CONFIRM-P1-NEW-H]** staff `customer.refundHistory` 管理层模式（`storeId=null`）无门店 scope 过滤

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:698–704`
- 管理层员工可查看全公司任意顾客退款历史
- 优先级：**P1** (CC3)

**[CONFIRM-P2-NEW-I]** `customer.refundHistory` JOIN `sale_order_payment_details` 用 INNER JOIN，若子表行缺失则退款记录隐身

- 文件：`fengyu-staff/cloudfunctions/staffApi/routes/customer.js:706–728`
- 优先级：**P2**

**[CONFIRM-P2-NEW-J]** `createRefundOrder` 别名（`export const createRefundOrder = createRefund`）无引用处，为死代码

- 文件：`fengyu-admin/src/actions/refunds.ts:700`
- 优先级：**P2**

### 11.3 前轮报告仍然成立的核心 P0（已由代码确认）

| ID | 描述 | 确认状态 |
|----|------|---------|
| P0-11-07 | rejectRefund 用 `status='已关闭'` 复用 orderStatus，无 `'已驳回'` 枚举值 | ✅ 确认（admin rejectRefund:942 `status='已作废'`，staff rejectRefund:1699 `status='已作废'`）— 注：实际写的是 `已作废` 而非 `已关闭`，但 `paymentFlowStatusEnum` 无 `'已驳回'`，审计语义问题仍存在 |
| P1-11-08 | staff 退款操作无 operation_logs | ✅ 确认（staff routes/order.js 退款函数无 logOperation 调用；admin 有 4 处 logOperation） |
| P0-11-05 | refundHistory 越权读 | ✅ 确认（同 CONFIRM-P1-NEW-H，但实为 P1，非 P0；无财务写入越权） |
| P1-11-11 | staff createRefund 不调 estimateRefundOverdraft | ✅ 确认（staff createRefund 无此调用，admin 有） |

### 11.4 前轮报告错误/过时的条目

| 前轮 ID | 描述 | 修正 |
|---------|------|------|
| P0-11-01 | "退款审批不冲销 sale_allocations / service_commissions" | ❌ 已由 cascadeRefund 实现，不再成立 |
| P0-11-04 | "退款不回退已使用优惠券" | ❌ cascadeRefund channel-3 已实现优惠券回滚（未过期），不再成立 |
| P0-11-02 | "需补 partial unique uq_refund_inflight" | ⚠️ 已落地为 uq_sop_status_audit（migration 0018），新架构下前轮建议位置不适用，但旧建议逻辑正确 |
| P0-11-03 | "advisory lock 双事务窗口" | ⚠️ 新架构下退款不生成 sale_orders 行（无 FY-TKD-WX- 订单号），此问题已不适用 |

### 11.5 总结：本轮实际问题清单

| 问题 | 优先级 | 文件 |
|------|--------|------|
| staff `refunded_amount` 累加法漂移 | **P0** | `staffApi/routes/order.js:1585` |
| staff cascade channel-5 整单退款跳过 | **P0** | `staffApi/helpers/refund-cascade.js:135` |
| staff cascade channel-5 `product_type` 额外过滤 | **P0** | `staffApi/helpers/refund-cascade.js:144` |
| staff `refreshSpendingTier` 不扣 refunded_amount / 不过滤 sale_order_type | **P0** | `staffApi/routes/order.js:40–63` |
| staff `refundHistory` 管理层模式无 scope 过滤 | **P1** | `staffApi/routes/customer.js:698` |
| admin 退款详情页手机号未脱敏 | **P1** | `(main)/refunds/[id]/page.tsx:83` |
| staff 退款操作无 operation_logs | **P1** | `staffApi/routes/order.js:1354–1740` |
| sale_orders 7 个旧退款字段未 DROP | **P1** | `db/schema/order.ts:94–108` |
| staff createRefund 不调 estimateRefundOverdraft（跌档不扣权益） | **P1** | `staffApi/routes/order.js:1382` |
| `refundHistory` INNER JOIN 致数据隐身 | **P2** | `staffApi/routes/customer.js:706` |
| `createRefundOrder` 死代码别名 | **P2** | `fengyu-admin/src/actions/refunds.ts:700` |
| staff `rejectRefund` 不校验 rejectedReason 非空 | **P2** | `staffApi/routes/order.js:1670` |
| admin `refunds.test.ts` 仅覆盖 `estimateRefundOverdraft` | **P2** | `fengyu-admin/src/actions/refunds.test.ts` |

**评级汇总（独立重审）**：P0 × 4，P1 × 5，P2 × 4
