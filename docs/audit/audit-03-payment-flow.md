# 审计报告：款项流水（sale_order_payments） (03)

**审计时间**：2026-04-25
**域 ID**：03
**审计员**：claude-opus-4-7
**审计时长**：~25 分钟
**关联 PR/Ticket**：partial-payment foundation (PR-2/PR-3) + 多次回款 (Ticket 2026-04-24 PR-A/B/C)
**规范版本**：`real.md` v3.1.0（命中 #2 价格快照、#3 支付幂等、#4 状态单向）+ `enums.ts` 28 枚举

---

## 1. 三端入口对照

| 层 | admin | staff | client / payNotify |
|----|-------|-------|--------|
| Schema | `db/schema/order.ts:241-287` saleOrderPayments | ↑ | ↑ |
| 枚举 | `db/schema/enums.ts:34-39` paymentChangeType(4 值) + `:49-54` paymentFlowStatus(4 值) + `:59-64` paymentSourceEnd(4 值) + `:22` paymentMethod(5 值) | ↑ | ↑ |
| CHECK | `order.ts:273-277` `chk_sop_amount_sign`（首次支付/回款/储值卡抵扣 > 0；退款 < 0）+ `:282-285` `chk_sop_method_txn`（微信/支付宝必带 external_txn_id） | ↑ | ↑ |
| UNIQUE | `order.ts:269-271` `uq_sop_txn (sale_order_id, payment_method, external_txn_id)` WHERE external_txn_id IS NOT NULL | ↑ | ↑ |
| 写入 (创建) | `actions/orders.ts:947-960`（首次支付/admin/线下） | `staffApi/routes/order.js:589-597`（首次支付/staff/线下/储值卡/无）+ `:877-883`（储值卡抵扣 confirmOffline） | `clientApi/routes/order.js:503-523`（**仅写 card_transactions, 未写 payments 行**）+ `payNotify/index.js:160-184`（首次支付/回款/notify/线上） |
| 写入 (回款) | `actions/orders.ts:1695-1706`（回款/admin/线下）+ `:1709-1720`（储值卡抵扣/admin/储值卡） | `staffApi/routes/order.js:1873-1893`（回款/staff/线下/储值卡）+ `:907-915`（confirmOffline 回款/staff/线下） | `clientApi/routes/order.js:1667-1675`（回款/client/储值卡） + `payNotify/index.js:160-184`（回款/notify/线上） |
| 写入 (退款) | — | `staffApi/routes/order.js:1447-1464`（退款/staff/线下\|储值卡 status='待支付'）+ `:1591-1596`（UPDATE→已支付）+ `:1670-1674`（UPDATE→已作废） | — |
| confirmOffline 状态机 | `actions/orders.ts:425-487`（**不写 payments 不更新 paid_amount**；仅 status→已支付） | `staffApi/routes/order.js:755-1030`（CAS 更新 paid_amount + 写 payments + 储值卡扣减） | — |
| 储值卡抵扣行 | `actions/orders.ts:1709-1720` recordPayment 写 | `staffApi/routes/order.js:877-883` confirmOffline 写 + `:1885-1892` createRepayment 写 | `clientApi/routes/order.js:1667-1675` repay 写 (回款单)；`:503-523` create 全额抵扣**未写**；`:1430-1456` confirmPrepaidFull**未写** |
| 详情读取 | `actions/orders.ts:397-422` getOrderPayments | `staffApi/routes/order.js:1295-1310` order.detail | `clientApi/routes/order.js:965-980` order.detail |
| 前端 | `(main)/orders/[id]/page.tsx` + `_components/record-payment-dialog.tsx` | `pagesOrder/order-detail/*` | `pagesOrder/order-detail/*` |

---

## 2. 数据流图

```
client.create (普通)
  事务: advisory lock → INSERT sale_orders(待支付)
                      → INSERT sale_items
                      ⛔ 不写 payments
  payNotify (线上回调)
    事务: SUM payments → 算 thisPayAmount
        → INSERT payments(首次支付/notify/微信|支付宝/已支付/external_txn_id) ON CONFLICT DO NOTHING
        → UPDATE sale_orders.paid_amount = SUM, status = 已支付|部分支付

client.create (储值卡全额抵扣) ⚠️ "已支付" 但无 payments 行 ⚠️
  事务: lock prepaid_cards FOR UPDATE
      → INSERT sale_orders(已支付, prepaid_card_amount=X, paid_amount=0)
      → INSERT sale_items
      → UPDATE prepaid_cards balance -= X + INSERT card_transactions(扣款)
      ⛔ 不写 '储值卡抵扣' payments → invariant 破裂

client.confirmPrepaidFull
  事务: 锁卡 → UPDATE prepaid_cards balance -= X + INSERT card_transactions(扣款)
      → UPDATE sale_orders status = 已支付
      ⛔ 不写 '储值卡抵扣' payments → invariant 破裂

client.repay (储值卡回款)
  事务: 锁原单 FOR UPDATE
      → 锁卡 → UPDATE prepaid_cards balance -= X + INSERT card_transactions(扣款 to FY-HKD)
      → INSERT sale_orders(FY-HKD-WX, 回款单, 已支付)
      → INSERT payments(回款/client/储值卡/已支付) sale_order_id=原单
      → SUM payments → UPDATE sale_orders.paid_amount + status

staff.create (店长)
  事务: advisory lock → INSERT sale_orders → INSERT sale_items
      → 若 !isOnline && paid > 0：INSERT payments(首次支付/staff/线下|储值卡|无/已支付)
      ⛔ 储值卡部分（prepaidCardAmount > 0）此处不写 '储值卡抵扣'，等 confirmOffline

staff.confirmOffline (店长)
  外层 SELECT '已支付 payments 是否存在' 决定 changeType (首次支付 vs 回款) ⚠️ 事务外
  事务: prepaidCardAmount > 0 ⇒ 锁卡 + 扣减 + INSERT card_transactions(扣款) + INSERT '储值卡抵扣' payments
      → UPDATE sale_orders SET status, paid_amount, paid_at WHERE status = $expectedStatus (CAS)
      → INSERT '首次支付'|'回款' payments
      → product_kind='充值卡' 充值入账

staff.createRepayment (FY-HKD)
  事务: SELECT 原单 FOR UPDATE
      → 锁卡 → 扣 + card_transactions(ref=FY-HKD)
      → INSERT 回款单(已支付)
      → INSERT '回款' payments + (可选) INSERT '储值卡抵扣' payments
      → SUM payments → UPDATE 原单 paid_amount/prepaid_card_amount + CAS status

staff.createRefund (FY-TKD)
  事务: INSERT 退款单(待审批)
      → INSERT '退款' payments(状态='待支付' note='FY-TKD=...')
staff.approveRefund
  事务: UPDATE 退款单 status '待审批'→'已支付' (CAS, 幂等哨兵)
      → 扣减 remaining_sessions / 储值卡回冲 + card_transactions(充值)
      → UPDATE '退款' payments status '待支付'→'已支付' (用 note LIKE 匹配)
      → SUM payments → UPDATE 原单 paid_amount/prepaid_card_amount
staff.rejectRefund
  事务: UPDATE 退款单 status '待审批'→'已关闭'
      → UPDATE '退款' payments status '待支付'→'已作废' (用 note LIKE 匹配)

admin.confirmOfflinePayment ⚠️ 与 staff.confirmOffline 高度发散
  事务: UPDATE sale_orders status='已支付' WHERE status='待确认收款' AND scope (CAS)
      → UPDATE sale_items expire_date += 1 year
      → applyRechargeOnOrderPaid (充值卡入账)
      ⛔ 不写 '首次支付' payments
      ⛔ 不更新 paid_amount
      ⛔ 不做储值卡扣减（与 staff confirmOffline 行为不一致）

admin.recordPayment (FY-HKD)
  事务: SELECT 原单 FOR UPDATE
      → 锁卡 → 扣 + card_transactions(ref=FY-HKD)
      → INSERT 回款单(已支付)
      → INSERT '回款' payments(线下, external_txn_id=银行回执号 必填) / '储值卡抵扣' payments
      → SUM payments → UPDATE 原单 paid_amount/prepaid_card_amount + CAS status
```

---

## 3. 自身漏洞

### 3.1 P0（阻断 / 资损 / 越权）

#### **[P0-03-01]** admin `confirmOfflinePayment` 不写 payments 行、不更新 paid_amount，破坏"流水加总=已支付金额"不变量
- **文件**：`fengyu-admin/src/actions/orders.ts:425-487`
- **现象**：admin 把 sale_orders.status 从 `'待确认收款'` 翻 `'已支付'` 时，**完全不操作 sale_order_payments**，且不修改 `paid_amount` 列。schema 注释（`order.ts:65-70` + `:236-240`）明确写 `paid_amount` 是 payments 表已支付行的冗余快照。staff.confirmOffline (`staffApi/routes/order.js:840-915`) 是正确的：CAS UPDATE + INSERT '首次支付'/'回款' payments + 扣减储值卡 + INSERT '储值卡抵扣' payments。两端语义对同一业务动作（确认线下收款）发散。
- **风险**：
  1. **资金账实不符**：所有从 admin 端确认的订单，`paid_amount`、`prepaid_card_amount` 均保持 create 时的初始值（client.create 写 paid_amount=payable=非零，staff.create 写 paid_amount=receivedAmount，admin.createOrder 写 paid_amount=receivedAmount——见 `actions/orders.ts:928`）但 **payments 表加总 ≠ paid_amount**。
  2. **退款拆分计算错误**：staff.approveRefund 在重算原单时调用 `SUM(payments WHERE change_type IN ('首次支付','回款','退款'))` 得到 `new_paid`，然后 UPDATE sale_orders.paid_amount = new_paid。如果原单是被 admin.confirmOfflinePayment 翻已支付的（payments 表为空），退款审批后 paid_amount 会被改写成 `-refundByOrigin`，原本"已收到的钱"凭空消失。
  3. **储值卡未扣减**：admin.confirmOfflinePayment 不读 `prepaid_card_amount > 0` 的订单做扣卡操作；同一订单若被 admin 确认收款，**储值卡余额没扣 + 不写 card_transactions**。顾客白嫖。
- **复现**：
  1. staff.create 一笔订单：total=600, prepaidCardAmount=200, paymentMethod=线下, receivedAmount=400 → status='待确认收款', paid_amount=400, prepaid_card_amount=200, payments 表 1 行 (首次支付 400)。
  2. **admin** 触发 confirmOfflinePayment → status='已支付'，paid_amount 仍=400 (OK)，**储值卡未扣 200**，payments 表仍只有 1 行。
  3. 顾客储值卡余额未扣，下次下单可重复使用——**直接资损**。
- **修复**：(L7) admin.confirmOfflinePayment 应当对齐 staff.confirmOffline 的事务体——锁卡扣减、写 '储值卡抵扣' payments、写 '首次支付'/'回款' payments、CAS UPDATE paid_amount + status。或者干脆从 admin 移除该 action，统一让店长在小程序操作。

#### **[P0-03-02]** client.create 全额储值卡抵扣 + client.confirmPrepaidFull 路径"已支付"但无 `'储值卡抵扣'` payments 行
- **文件**：
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js:462-479` 创建主表
  - `:503-523` 全额抵扣分支扣卡 + card_transactions（**未写 payments**）
  - `:1380-1469` confirmPrepaidFull（**未写 payments**）
- **现象**：schema `order.ts:236-240` 不变量：`prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')`。client.create 全额抵扣分支 **写了 prepaid_card_amount 列但没插 '储值卡抵扣' 行**；confirmPrepaidFull 同病。staff.confirmOffline (`:877-883`)、staff.createRepayment (`:1885-1892`)、admin.recordPayment (`:1709-1720`)、client.repay (`:1667-1675`) 都正确写了。
- **风险**：
  1. staff.approveRefund / admin.recordPayment 在 SUM payments 时把 `prepaid_card_amount` 算成 0，**退款比例拆分（splitRefundByOriginalPayment 用 origPrepaidCardAmount 除 origTotal）正确**因为还读的是 sale_orders 列；但是 `staff.approveRefund:1614-1619` UPDATE sale_orders SET prepaid_card_amount = newPrepaid（**= SUM payments**），**会把原本 200 的列重写成 0**！下次再退款会按 0 比例拆分，全额从原通道（线下）退，储值卡不回冲，资损。
  2. 数据看板/对账查询若直接用 SUM payments 而不取 sale_orders 列，会算少营业额。
- **复现**：
  1. client.create 全额储值卡 600 抵扣 → paid_amount=0, prepaid_card_amount=600, payments 表 0 行。
  2. staff.createRefund 部分退 300 → '退款' 行 status=待支付（按比例 refundByCard=300, refundByOrigin=0）→ approveRefund → UPDATE 原单 prepaid_card_amount = SUM (=−300)、paid_amount = 0。
  3. 顾客再退 100 → splitRefund 按 (-300/600) 比例算，refundByCard 计算异常 / 原列变成负数。
- **修复**：(L3) 三处补写 INSERT '储值卡抵扣' payments；或 (L0) 改 schema：把 `prepaid_card_amount` 列上挂触发器从 SUM payments 派生，或干脆让 SUM 派生不再写 sale_orders 列。

#### **[P0-03-03]** staff.confirmOffline `existingPaymentsRow` 在事务外读，paymentChangeType（首次支付 vs 回款）取错可触发 `chk_sop_amount_sign` 之外的语义错乱
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:826-838`（事务外 SELECT）+ `:907-915`（事务内 INSERT）
- **现象**：判定本次是"首次支付"还是"回款"的 SQL `SELECT 1 FROM sale_order_payments WHERE sale_order_id = $1 AND status = '已支付' AND change_type IN ('首次支付','回款','退款')` **在 `pg.transaction` 之前用顶层 pg 连接执行**。两段并发 confirmOffline / 与 payNotify 并发：
  - A 读到 0 行（无），决定 type='首次支付'；
  - B 读到 0 行（无），决定 type='首次支付'；
  - A 进入事务 INSERT '首次支付'，commit；
  - B 进入事务 INSERT '首次支付'——**同一订单出现 2 行 '首次支付'**，违反"首次支付至多 1 行/订单"业务规则。
- **风险**：DB 层无 partial unique index `WHERE change_type='首次支付'` 兜底（schema `order.ts:265-271` 只有 `uq_sop_txn` 关于 external_txn_id 的索引），应用层并发判定不可靠。报表"按首次支付时间统计新单"会把同一订单计 2 次。
- **复现**：两个店长同时点确认收款；或 staff.confirmOffline 与 client.pay→payNotify 同时进行。
- **修复**：
  - (L0) 加 `uq_sop_first_payment` partial unique index `ON sale_order_payments (sale_order_id) WHERE change_type = '首次支付'`，DB 兜底。
  - (L3) 把 existingPaymentsRow 移到事务内、加 SELECT FOR UPDATE 行级锁；或直接用"事务内 INSERT 失败回退到 '回款'"的乐观策略。
  - 备注：payNotify (`payNotify/index.js:150-156`) 的"firstPayCheck" 是事务内执行，相对安全；问题主要在 staff.confirmOffline。

#### **[P0-03-04]** `'退款'` payments 行幂等键缺失，重复创建退款单产生多行未支付退款
- **文件**：`fengyu-staff/cloudfunctions/staffApi/routes/order.js:1444-1464`（createRefund INSERT 退款）+ `:1591-1596`（approveRefund UPDATE 用 note LIKE）
- **现象**：refund 行靠 `note LIKE 'FY-TKD=<saleOrderId>%'` 字符串匹配做后续状态翻转，**没有显式 payments 表的幂等键**。createRefund 应用层有 in-flight 唯一性 (`:1352-1358` SELECT 已存在 '待审批' 退款单)，但是这个判定也是事务外读：
  - A、B 两个店长同时为同一原单发起 createRefund；
  - A、B 都读到 inflightRefunds=0 行；
  - A、B 各 INSERT 一条 FY-TKD 退款单 + 一对（refundByCard, refundByOrigin）payments 行；
  - 现在原单上挂着两条 '退款' payments status='待支付'，note 含两个不同 FY-TKD id。
- **风险**：approveRefund 只翻 note LIKE 匹配的退款单的 payments 行，另一条 FY-TKD 仍卡在 '待支付'。SUM payments 算 paid_amount 把 '待支付' 的退款行排除（CASE WHEN status='已支付'），暂时无影响；但若被 rejectRefund 处理则置 '已作废'，状态混乱仍存在。
- **复现**：双店长 / 双标签页同时点退款。
- **修复**：(L0) DB 增加 partial unique `ON sale_orders (ref_sale_order_id) WHERE sale_order_type='退款单' AND status='待审批'`；(L3) 事务内 SELECT FOR UPDATE 原单后再 SELECT 已存在退款单。

#### **[P0-03-05]** `staff.close` / `client.cancel` 关闭订单时未作废已写入的 payments 行
- **文件**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1071-1098`（close 仅 UPDATE sale_orders + 优惠券）
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js:15-28` closeExpiredOrder（仅 UPDATE sale_orders + 优惠券）+ `:1020-1085` cancel
- **现象**：close 允许 `'待支付'/'待确认收款'/'支付失败'`；其中 `'待确认收款'` 已可能有 staff.create 写入的 '首次支付' payments 行（`:589-597`）和 confirmOffline 之前的预选状态。一旦关闭，order.status='已关闭' 但 payments 表中仍存在 status='已支付' 的 '首次支付' 行——SUM payments 报"该订单已收钱"，但 sale_orders 显示 '已关闭'。
- **风险**：
  1. 数据看板/对账：'已关闭' 订单计入 SUM payments，营收报表偏高。
  2. 若顾客已实际付现金而店长误关闭，没有 '已作废' 的 payments 行追溯，后续审计无法对账。
- **复现**：staff.create paymentMethod='线下', receivedAmount=600 → '待确认收款' + 1 行 '首次支付'/已支付/600。店长 close → '已关闭'，payments 行仍存在。
- **修复**：(L3) close / cancel 事务内 UPDATE payments SET status='已作废' WHERE sale_order_id=$1 AND status IN ('已支付','待支付')；同时回退储值卡（如有 '储值卡抵扣' 行）和现金对账。

### 3.2 P1（数据一致 / 状态错乱）

#### **[P1-03-06]** `paid_at` 字段三端写入责任不清，部分支付场景遗留过期值
- **文件**：
  - staff.confirmOffline `routes/order.js:894`：targetStatus='部分支付' → paid_at 保留原值（若已有则保留）
  - client.repay `routes/order.js:1705`：targetStatus='部分支付' → CASE WHEN '已支付' THEN $3 ELSE paid_at 保留
  - payNotify `payNotify/index.js:196`：fullyPaid=false → paid_at 保留
  - admin.recordPayment `actions/orders.ts:1740`：targetStatus='部分支付' → 保留 locked.paid_at
- **现象**：行为本身一致（部分支付时保留 paid_at），但 schema (`order.ts:262-263`) 注释写 paid_at 是"status 翻 '已支付' 的时间"。订单可能经历：'待支付' → '部分支付' (paid_at=NULL) → 部分回款 (paid_at 仍 NULL) → 全额回款 (paid_at=now)，OK。但**若 staff.create 时 paymentMethod=线下 paid > 0 → status='待确认收款' 且写 paid_at=now**（`:556`），而 confirmOffline 把 status 翻 '部分支付' 时，原 paid_at 保留 → "**部分支付订单的 paid_at 是 create 时的某个时刻**"，与 schema 语义不符。
- **风险**：报表/对账"按首次到账时间"统计的口径不准；前端展示"支付时间"易误导顾客。
- **修复**：(L0) schema 注释明确"paid_at = 最近一次到账时间快照"；或 (L3) 三端统一在每次写 payments 已支付行时更新 paid_at = now（不区分目标 status）。

#### **[P1-03-07]** 三端 `source_end` 硬编码与端别一致性 OK，但 admin 内部存在两类来源（confirmOfflinePayment vs recordPayment）未区分
- **文件**：
  - admin: `actions/orders.ts:955`（首次支付 source_end='admin'）+ `:1702,1716`（回款/储值卡抵扣 source_end='admin'）
  - staff: `routes/order.js:594,881,912,1452,1462,1877,1890`（全部 'staff'）
  - client: `routes/order.js:1672`（'client'）
  - payNotify: `payNotify/index.js:165`（'notify'）
- **现象**：admin 端 confirmOfflinePayment 完全不写 payments（见 P0-03-01），只有 createOrder（首次支付）和 recordPayment（回款）写。值都用 'admin'，无法在 payments 表中区分"管理后台开单"vs"管理后台录入回款"——note 字段做软分类（'管理后台开单首次收款' vs '管理后台录入回款'）。
- **风险**：审计/资金追溯靠 note 字符串匹配，运营改提示文案即破。
- **修复**：(L0) 把 paymentSourceEnd 拆细，或保留 4 值但 (L3) 用 change_type + source_end 组合做语义键。

#### **[P1-03-08]** payNotify 的回款"剩余应付"算法将 sale_orders.paid_amount 的初始值（create 时=payable）当成"已到账"会双重计数
- **文件**：`payNotify/index.js:120-138` + 兜底注释 `client.pay :659-666`
- **现象**：注释明确说"第一次回调时 payments 表为空，remaining = total_amount - prepaid_card_amount = paid_amount 列初值"。这就把 sale_orders.paid_amount 的两种语义混用。client.create 写 paid_amount=total-prepaid 作为应付（旧逻辑），但 payNotify 的 remaining 算法是 `payableAmount - paidSum`（不读 paid_amount 列）。两侧虽然都不依赖 paid_amount 列做"已到账"判定，但 client.pay (`:660-666`) 的 fallback 是 `effectiveRemaining = paid_amount 列值`——若 payNotify 已写过一次 payments，但 sale_orders.paid_amount 列没更新（数据回流延迟）→ remaining 取错。
- **风险**：极端竞态下顾客可能被 fallback 路径要求支付错误金额，UX 而非资损。
- **修复**：(L0) 改 schema 让 paid_amount 在 create 时初值=0，create 不再写 payable（破坏现存约定），改由 payments 累加。或 (L3) fallback 直接以 0 处理，不读 paid_amount 列。

#### **[P1-03-09]** confirmOffline 的"事务外取 changeType + 事务内 CAS UPDATE"竞态：CAS 守住 sale_orders 但 payments 行 type 已固化
- **文件**：`staffApi/routes/order.js:826-838`（外）+ `:907-915`（内）
- **现象**：外层判 changeType='首次支付' 写入；同时另一进程并发执行 payNotify 把同订单写了一行 '首次支付'/notify/已支付。本进程 CAS 守 `WHERE status = order.status` 失败（status 已被 notify 改），抛错回滚——changeType 决策被废弃。**不会写错 payments**，但 race 频繁时用户体验差。
- **风险**：UX；但若改 CAS 守卫为 IN（'待支付','待确认收款','部分支付'）→ payNotify 已写 '首次支付'，confirmOffline 仍能继续写第二条 '首次支付' → 资损与 P0-03-03 相同。
- **修复**：和 P0-03-03 一起修，靠 partial unique 兜底。

#### **[P1-03-10]** clientApi 路由未先过 ownership 中间件，pay/alipayPay/offlinePay 都在业务层手动 `client_user_id !== userId` 校验
- **文件**：
  - `clientApi/routes/order.js:622-628`（pay）
  - `:749-755`（offlinePay）
  - `:1201-1207`（alipayPay）
  - `:1404`（confirmPrepaidFull）
  - `:1555-1557`（repay）
- **现象**：每个路由复制粘贴 `if (order.client_user_id) { if (order.client_user_id !== userId) throw 'PERMISSION_DENIED' } else if (!order.opened_by) throw 'INVALID_PARAMS' }`。无 helper，无中间件保证。漏一处即越权。
- **风险**：未来新加路由（如 `cancelRefund` / `confirmRefund`）忘记复制 = 越权读写他人订单。
- **修复**：(L3) 抽 `loadOrderForOwner(orderId, userId)` helper，返回 row + 自动校验。已在 `CROSS-CUTTING.md` CC4 "Client 端无 scope helper" 命中本域。

#### **[P1-03-11]** `'退款'` payments 行 amount 符号 vs sale_orders 列符号不对齐
- **文件**：`staffApi/routes/order.js:1530-1535` approveRefund UPDATE 退款单
- **现象**：approveRefund 把 FY-TKD 退款单的 `prepaid_card_amount = -refundByCard, paid_amount = -refundByOrigin`（**负数**）。schema chk_sop_amount_sign 只约束 sale_order_payments.amount 退款<0，但 sale_orders 表 chk 未在 schema 里检查 prepaid_card_amount 符号。后续若 SUM 退款单的 paid_amount 做"全店收款合计"就会算错（负数被加）。
- **风险**：报表/数据看板的累计收款值偏低；不是直接资损但口径不一致。
- **修复**：(L0) sale_orders.prepaid_card_amount / paid_amount 加 CHECK ≥ 0 但允许退款单（sale_order_type='退款单'）为负；或 (L3) 报表 SQL 始终 SUM CASE WHEN sale_order_type IN ('销售单','回款单') THEN amount ELSE 0 END。

#### **[P1-03-12]** payNotify 的 `'部分支付'` 路径不写 paid_at，但 sale_orders.paid_at NOT NULL 约束未配
- **文件**：`payNotify/index.js:191-201` UPDATE 主订单
- **现象**：CASE WHEN `'已支付'` THEN $3 ELSE paid_at — 部分支付保留旧值。如果原单 create 时 paid_at=NULL，部分支付路径走完后 paid_at 仍 NULL；payments 表却已经有 1 行 '已支付'。前端列表"按支付时间排序"看不到该订单。
- **风险**：UX；订单列表排序不稳。
- **修复**：(L3) 部分支付路径也写 `paid_at = COALESCE(paid_at, $3)` 取最早入账时间。

### 3.3 P2（代码质量 / 可维护）

- **[P2-03-13]** staff.confirmOffline `targetStatus + 0.001 >= orderTotal` 浮点比较，金额接近整千时仍可能因 JS Number 精度滑过期望边界（`routes/order.js:824`）。建议统一用整数分（cents）比较。
- **[P2-03-14]** admin.recordPayment 错误前缀（`'OVERPAY:'`、`'INSUFFICIENT_BALANCE:'`、`'CONCURRENT_CHANGED'`、`'REF_ORDER_NOT_FOUND'`）不在 4 项约定（UNAUTHORIZED/PHONE_REQUIRED/INVALID_PARAMS/PERMISSION_DENIED）内，前端 toast 文案映射会进入"未识别错误"分支。**与 audit-02 §3.3 P2-02-17 同源**。
- **[P2-03-15]** `staff.confirmOffline` 注释说"C4 合规：WHERE 锁定当前状态防止并发竞态"（`:889`），但 `pay/alipayPay/offlinePay` 的 UPDATE sale_orders（`clientApi/routes/order.js:688-697`、`:1251-1254`、`:781-784`）均无 CAS 守卫——见 audit-02 §3.1 P0-02-03。本域不再重复，但 payment_method 改写缺保护。
- **[P2-03-16]** payments.note 字段被当成软结构化键（如 `'FY-TKD=<id>; reason=...; fee=...'`，`'店长开单现场收款'`，`'管理后台录入回款-储值卡抵扣'`），缺乏正式的 metadata jsonb 字段。建议 (L0) 加 metadata jsonb，（L3）逐步迁移。
- **[P2-03-17]** `staff.createRefund` UPDATE 用 `note LIKE 'FY-TKD=...%'` 匹配 payments 行（`:1591-1596` `:1670-1674`），如果 note 被人编辑或换格式即崩。建议加 `ref_repayment_order_id` 列直接关联，避免字符串依赖。
- **[P2-03-18]** payNotify 的 FOR UPDATE 仅锁 prepaid_cards 行，不锁 sale_orders 主行；幂等靠 ON CONFLICT DO NOTHING (`:166-168`) 实现。设计 OK，但事务边界长（含充值卡入账、消费扣款、业绩分配、积分结算、分享礼），rollback 概率随事务长度增加。建议拆分。
- **[P2-03-19]** 三端 `source_end` 字符串裸写（`'staff' / 'client' / 'admin' / 'notify'`），缺常量。建议 (L0) 在 helpers 暴露常量。
- **[P2-03-20]** schema 文档对 `'储值卡抵扣'` 行的"何时写"语义模糊：order.ts:235 注释说"留待后续 ticket 启用"，实际已被 5 处路由启用（client.repay/staff.confirmOffline/staff.createRepayment/admin.recordPayment）+ 2 处遗漏（client.create 全额抵扣/client.confirmPrepaidFull）——见 P0-03-02。schema 注释建议刷新为最新现实。

---

## 4. 跨端不一致

| 维度 | admin | staff | client | payNotify | 风险 | 优先级 |
|------|-------|-------|--------|-----------|------|--------|
| 确认线下收款是否写 payments | ❌ 不写 | ✅ 写 '首次支付'/'回款' | — | — | 资损 + 不变量破坏 | P0 |
| 确认线下收款是否扣储值卡 | ❌ 不扣 | ✅ 扣（FOR UPDATE + card_transactions） | — | — | 资损 | P0 |
| 储值卡全额抵扣是否写 '储值卡抵扣' payments | ✅ recordPayment 写 | ✅ confirmOffline 写 | ❌ create 全额/confirmPrepaidFull 不写 | — | 退款拆分错误 | P0 |
| change_type 决策位置 | 事务内 | **事务外**（confirmOffline） | 事务内 | 事务内 | 并发可生 2 行首次支付 | P0 |
| 退款 payments amount 符号 | — | < 0 ✅ | — | — | 列符号未约束 | P1 |
| paid_at 写入语义 | 全状态写 now | 部分支付保留 | 部分支付保留 | 部分支付保留 | 三端不一致 | P1 |
| `source_end` 值 | 'admin' | 'staff' | 'client' | 'notify' | OK | — |
| 错误前缀 | 自定义（OVERPAY/INSUFFICIENT_BALANCE/...） | INVALID_PARAMS/INSUFFICIENT_BALANCE: | INVALID_PARAMS:/PERMISSION_DENIED: | 内部 'INVALID_PAY_AMOUNT:' | 不属于 4 约定 | P2 |
| 列表展示 payments 排序 | asc(createdAt) | asc(created_at, id) | asc(created_at, id) | — | OK | — |

---

## 5. 横切检查（仅记录有问题的项）

- [ ] **CC1 数值精度**：金额字段用 NUMERIC(10,2) ✅；JS 端用 `Math.round(x * 100) / 100` 兜底 ✅；但 `+ 0.001` 浮点比较散落多处（`routes/order.js:463,549,815,824,1043,1334,1425,1594,1604,1700,1818`），建议统一改用整数分。**P2**
- [ ] **CC2 并发幂等**：
  - 首次支付 vs 回款 changeType 事务外读 → P0-03-03 ⚠️
  - 退款单 in-flight 唯一性事务外读 → P0-03-04 ⚠️
  - admin.recordPayment 注释"幂等：本 ticket 简化，依赖前端防重复提交"——**应用层无防重，依赖前端**，与"支付幂等"硬约束不符（real.md #3）。⚠️
  - payNotify 的 ON CONFLICT 兜底正确 ✅
- [ ] **CC3 组织域隔离**：admin.recordPayment 不做 isInScope（隐式合约，见 audit-02 §3.1 P0-02-05 后续命中）⚠️；staff.confirmOffline 用 effectiveStoreId 过滤 OK；client 端按 client_user_id 过滤 OK。
- [ ] **CC4 后端鉴权**：client.{pay,alipayPay,offlinePay,confirmPrepaidFull,repay} 重复 ownership 校验代码无中间件 → P1-03-10 ⚠️
- [ ] **CC5 错误码**：admin.recordPayment 自定义前缀（OVERPAY:、INSUFFICIENT_BALANCE: 等）不在 4 约定 → P2-03-14 ⚠️
- [ ] **CC6 PII**：payments.note 含订单/凭证号，未含 PII，OK。但 console.error 输出原始 err（`payNotify:507`、`actions/orders.ts:1803`），可能带 SQL 错误堆栈含字段名。**P2**
- [ ] **CC7 时间字段**：paid_at 三端语义有偏差 → P1-03-06 ⚠️；created_at 全部 DB DEFAULT NOW() 或 application now()，混用但本域无明显跨日窗口问题（订单号生成在 02 域处理）。
- [ ] **CC8 WXML/Vant**：本域无 UI 直接耦合。
- [ ] **CC9 测试与残留**：staff/client/admin payments 测试覆盖在 `__tests__/routes/order.test.js`、`order.repay.test.js`、`payNotify/__tests__/index.test.js` 中存在，但 admin.confirmOfflinePayment 不写 payments 这一**核心 P0 缺陷未被任何测试覆盖**——验证 SQL 见 §7。

---

## 6. 修复建议（按 L0→L10 传播层）

| 层 | 文件 | 修改 | 关联问题 |
|----|------|------|----------|
| L0 schema/migrations | `db/migrations/00NN_payment_uniques.sql` | 新增 `uq_sop_first_payment` partial unique on (sale_order_id) WHERE change_type='首次支付'；`uq_refund_inflight` partial unique on sale_orders(ref_sale_order_id) WHERE sale_order_type='退款单' AND status='待审批'；payments 加 `metadata jsonb` 列 | P0-03-03, P0-03-04, P2-03-16 |
| L0 schema | `db/schema/order.ts:262-263` | paid_at 注释改为"最近一次状态进 '已支付' 的时间快照（部分支付不更新）"，与代码现状对齐 | P1-03-06 |
| L3 admin | `fengyu-admin/src/actions/orders.ts:425-487` | confirmOfflinePayment 对齐 staff.confirmOffline：事务内 CAS UPDATE + INSERT '首次支付' payments + 储值卡扣减 + INSERT '储值卡抵扣' payments + 重算 paid_amount/prepaid_card_amount | P0-03-01 |
| L3 client | `clientApi/routes/order.js:503-523` create 全额抵扣分支 | 同事务内 INSERT INTO sale_order_payments(储值卡抵扣, client, 储值卡, 已支付, prepaidCardAmount, sale_order_id=orderNo) | P0-03-02 |
| L3 client | `clientApi/routes/order.js:1380-1469` confirmPrepaidFull | 同事务内 INSERT INTO sale_order_payments(储值卡抵扣, client, 储值卡, 已支付, prepaid_card_amount) | P0-03-02 |
| L3 staff | `staffApi/routes/order.js:826-838` | existingPaymentsRow 移到 `pg.transaction` 内（client.query），并加 SELECT FOR UPDATE 锁 sale_orders 主行 | P0-03-03 |
| L3 staff | `staffApi/routes/order.js:1352-1358` createRefund 的 in-flight 校验 | 移到事务内，并依赖新加的 partial unique 兜底 | P0-03-04 |
| L3 staff/client | `staffApi/routes/order.js:1071-1098` close + `clientApi/routes/order.js:15-28` closeExpiredOrder + `:1020-1085` cancel | 事务内追加 `UPDATE sale_order_payments SET status='已作废' WHERE sale_order_id=$1 AND status IN ('已支付','待支付')`；储值卡回退 | P0-03-05 |
| L3 三端 helpers | `cloudfunctions/*/helpers/payment.js`（新建） | 抽出 `insertFirstOrRepayPayment(client, ctx)` / `applyPrepaidCardDeduction(client, ctx)` 复用，统一 source_end / change_type 决策 | P0-03-01, P0-03-02, P0-03-03, P1-03-10 |
| L3 admin | `fengyu-admin/src/actions/orders.ts` recordPayment | 错误前缀改为 `INVALID_PARAMS:OVERPAY` 等约定形态 | P2-03-14 |
| L7 admin actions | `fengyu-admin/src/actions/orders.ts:1593-1594` recordPayment | 加 `assertInScope(session, locked.store_id)`，去除"权限矩阵兜底"隐式合约 | CC3 |
| L9 前端 | `(main)/orders/_components/record-payment-dialog.tsx` | 错误码映射表更新 | P2-03-14 |

---

## 7. 验证 SQL（在 5434 EXPLAIN，禁止写入）

```sql
-- 1. 验证 P0-03-01：admin confirmOfflinePayment 之后 paid_amount 与 payments 加总不一致
-- 期望：返回订单是 '已支付' 但 SUM(payments) ≠ paid_amount
SELECT o.sale_order_id, o.status, o.paid_amount, o.prepaid_card_amount,
       COALESCE(p.paid_sum, 0) AS payments_paid_sum,
       COALESCE(p.prepaid_sum, 0) AS payments_prepaid_sum,
       o.offline_confirmed_by IS NOT NULL AS confirmed_offline
FROM sale_orders o
LEFT JOIN (
  SELECT sale_order_id,
         SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款','退款') THEN amount ELSE 0 END) AS paid_sum,
         SUM(CASE WHEN status='已支付' AND change_type='储值卡抵扣' THEN amount ELSE 0 END) AS prepaid_sum
  FROM sale_order_payments
  GROUP BY sale_order_id
) p ON p.sale_order_id = o.sale_order_id
WHERE o.status IN ('已支付','已完成','部分支付')
  AND o.sale_order_type = '销售单'
  AND (
    ABS(o.paid_amount - COALESCE(p.paid_sum, 0)) > 0.01
    OR ABS(o.prepaid_card_amount - COALESCE(p.prepaid_sum, 0)) > 0.01
  )
LIMIT 50;

-- 2. 验证 P0-03-02：全额储值卡抵扣订单 prepaid_card_amount > 0 但无 '储值卡抵扣' payments 行
SELECT o.sale_order_id, o.status, o.prepaid_card_amount,
       (SELECT COUNT(*) FROM sale_order_payments p
        WHERE p.sale_order_id = o.sale_order_id
          AND p.change_type = '储值卡抵扣'
          AND p.status = '已支付') AS prepaid_payment_rows
FROM sale_orders o
WHERE o.prepaid_card_amount > 0
  AND o.sale_order_type = '销售单'
  AND o.status IN ('已支付','已完成','部分支付')
HAVING (SELECT COUNT(*) FROM sale_order_payments p
        WHERE p.sale_order_id = o.sale_order_id
          AND p.change_type = '储值卡抵扣') = 0
LIMIT 50;

-- 3. 验证 P0-03-03：是否已存在多 '首次支付' 行的订单（事故已发生才有数据）
SELECT sale_order_id, COUNT(*) AS first_pay_count
FROM sale_order_payments
WHERE change_type = '首次支付'
GROUP BY sale_order_id
HAVING COUNT(*) > 1;

-- 4. 验证 P0-03-04：同一原单存在多笔 '待审批' 退款单
SELECT ref_sale_order_id, COUNT(*) AS pending_refund_count,
       array_agg(sale_order_id) AS refund_ids
FROM sale_orders
WHERE sale_order_type = '退款单' AND status = '待审批'
GROUP BY ref_sale_order_id
HAVING COUNT(*) > 1;

-- 5. 验证 P0-03-05：'已关闭' 订单仍存在 '已支付' payments 行
SELECT o.sale_order_id, o.status,
       COUNT(p.id) AS active_payment_rows
FROM sale_orders o
JOIN sale_order_payments p ON p.sale_order_id = o.sale_order_id
WHERE o.status = '已关闭'
  AND p.status = '已支付'
  AND p.change_type IN ('首次支付','回款','储值卡抵扣')
GROUP BY o.sale_order_id, o.status
LIMIT 50;

-- 6. 索引覆盖 EXPLAIN（`uq_sop_txn` partial unique）
EXPLAIN
SELECT 1 FROM sale_order_payments
WHERE sale_order_id = 'FY-XSD-WX-260425XXXX'
  AND payment_method = '微信'
  AND external_txn_id = 'wx-txn-xxx';

-- 7. 退款单链路一致性：退款单 paid_amount 是否始终 ≤ 0
SELECT sale_order_id, sale_order_type, status, paid_amount, prepaid_card_amount, total_amount
FROM sale_orders
WHERE sale_order_type = '退款单'
  AND (paid_amount > 0 OR prepaid_card_amount > 0)
LIMIT 20;
```

---

## 8. 回归测试用例（建议）

1. **admin.confirmOfflinePayment 应当写 payments + 扣储值卡**：构造 staff.create 待确认收款订单含 prepaid_card_amount=200 + paid_amount=400 → admin 触发 → 期望储值卡余额 -200，payments 表 +1 行 '储值卡抵扣'，paid_amount/prepaid_card_amount 不变（已对账）。
2. **client.create 全额抵扣应写 '储值卡抵扣' payments**：构造 useCard=true totalAmount=600 cardBalance=1000 → 期望 payments 表 1 行 (储值卡抵扣, client, 储值卡, 已支付, 600)。
3. **client.confirmPrepaidFull 应写 '储值卡抵扣' payments**：staff.create useCard=true paymentMethod='无' → 顾客扫码 confirmPrepaidFull → 期望 payments +1 行。
4. **首次支付并发去重**：mock 两个并发 confirmOffline 同订单 → 期望仅 1 行 '首次支付'（partial unique 命中）。
5. **退款 in-flight 唯一性**：mock 两个并发 createRefund 同原单 → 期望 1 个成功 + 1 个抛 CONFLICT。
6. **关闭订单作废 payments**：staff.create paymentMethod='线下' receivedAmount=600 → close → 期望 payments 行 status='已作废'。
7. **payments 加总不变量**：插入若干订单，跑 §7 #1 SQL 期望返回 0 行。
8. **退款 payments amount 必为负**：mock 退款 → assert chk_sop_amount_sign 触发拦截若误写正数。
9. **chk_sop_method_txn**：尝试 INSERT payments 微信通道 + external_txn_id=NULL → 期望 DB 拦截。

---

## 9. 影响半径

- 单端：☐
- 跨端（任意 2 端）：☐
- 全栈（3 端 + DB）：☑
- 涉及历史数据：☑（已支付订单中 admin.confirmOfflinePayment 处理过的全部需要回填 payments）
- 修复成本：**M**（schema 加 2 个 partial unique + admin/client 各加 ~30 行事务体；测试增量较大）

---

## 10. 后续待办

- [ ] 与 域 04 (payNotify 幂等) 对齐：partial unique on '首次支付' 是否影响 payNotify 重放幂等（应该不影响，只在事务内 INSERT 时由 ON CONFLICT 兜住）
- [ ] 与 域 11 (退款) 对齐：退款单符号、退款 payments status 流转、approveRefund 重算 prepaid_card_amount = SUM payments 在 client.create 全额抵扣场景下的 P0 联动
- [ ] 与 域 14 (充值卡 + 卡流水) 对齐：card_transactions 与 sale_order_payments '储值卡抵扣' 双写一致性
- [ ] 写补丁 migration `00NN_payment_inv_uniques.sql` 加 partial unique
- [ ] 回填脚本：扫描历史已支付订单中无对应 payments 行的 case，按 sale_orders 列回写 payments
