# E2E 验收清单 — 储值卡抵扣消费

> 对应 ticket: `2026-04-23-prepaid-card-deduction-by-store.md`
> 本清单从 ticket §4.1–4.10 的 47 条验收条件重组为可在真机 + 微信开发者工具按步骤执行的操作手册
> 执行前提：5434/5433 双库已 migrate；clientApi / staffApi / payNotify 已部署；admin 已部署

---

## 约定

- **顾客端**：微信开发者工具打开 `fengyu-client/`，账号 A（bound_store_id = A 店）
- **员工端**：微信开发者工具打开 `fengyu-staff/miniprogram/`，账号 M（店长角色）
- **admin**：浏览器打开本地或部署的 admin 站
- **psql**：双库都可，以 5434 为主（admin 连接库）；命令行验证时统一写 SQL 不手改数据
- ⚠ 提醒：当前 `clientApi` 连 5434、`staffApi`/`payNotify` 连 5433 存在 env drift，跨端联动场景（场景 B）需暂时接受"看不到对方订单"的已知局限，单独 ticket 修

---

## 场景 A — 顾客端闭环（客户端单端，clientApi + 5434）

### A.1 跨店共享（§4.1）
1. 账号 A 绑定 A 店 → 充值 ¥500 → 5434 `SELECT card_id, balance FROM prepaid_cards WHERE user_id='A'`：应为单行 balance=500
2. `\d prepaid_cards` 看不到 `store_id` 列 ✓
3. 申请解绑 A 店并绑定 B 店 → 再查同一行 balance=500（跨店继续可用）✓
4. 尝试 `INSERT INTO prepaid_cards(..., user_id='A', ...)` 第二行 → 被 `uq_prepaid_cards_user` 拒绝 ✓
5. 下单页余额显示 500；前端篡改 `prepaidCardAmount=600`（devtools → network 改 payload）→ 后端返回 `INSUFFICIENT_BALANCE`

### A.2 全额抵扣（§4.2，实付=0，payment_method='无'）
1. 账号 A 在 B 店下单 ¥300（无优惠券）→ checkout 页显示：
   - 储值卡区块开关默认 on、抵扣 ¥300
   - 实付金额 ¥0.00
   - **支付方式按钮组完全隐藏**
   - 副文案显示"全额抵扣，无需选择支付方式"
   - 提交按钮文案"确认支付（已抵扣）"
2. 点提交 → 无 `wx.requestPayment` 调用 → 直接跳订单详情
3. psql：
   ```sql
   SELECT sale_order_id, status, total_amount, prepaid_card_amount, paid_amount, payment_method
   FROM sale_orders WHERE client_user_id='A' ORDER BY created_at DESC LIMIT 1;
   -- 期望: status='已支付', total=300, prepaid=300, paid=0, method='无'
   SELECT balance FROM prepaid_cards WHERE user_id='A';  -- 期望: 200
   SELECT type, amount, ref_order_id FROM card_transactions WHERE ref_order_id=<新订单号>;
   -- 期望: 单行 type='扣款', amount=-300
   ```
4. admin 订单详情页看到三行："订单总额 ¥300.00 / 储值卡抵扣 ¥300.00 / 实付 ¥0.00（无（全额抵扣））" ✓
5. admin 列表筛选"有储值卡抵扣=是" → 能搜到；筛选 `payment_method='无'` → 能搜到
6. 恶意测试：devtools 改 payload `paymentMethod='微信'` + `prepaidCardAmount=300` → 后端仍强制落 '无'

### A.3 部分抵扣 + 剩余微信（§4.3，因 mock 模式 payNotify 暂不自动触发）
1. 先让 A 余额 = 100（从上一场景结束后的 200 扣或另造）
2. 账号 A 下单 ¥300 → checkout 页显示储值卡抵扣 ¥100、实付 ¥200、微信按钮组显示 ✓
3. 选"微信"点提交 → 订单 status='待支付'、prepaid=100、paid=200、method='微信'
4. `card_transactions` 无新行（扣卡延后）✓
5. **mock 模式**：手动触发 payNotify：
   ```bash
   tcb fn invoke payNotify --env-id cloud1-3gpht4b01ff88838 \
     --params '{"orderNo":"<订单号>","transactionId":"mock_txn_001"}'
   ```
   （⚠ 需要临时绕过 env drift：把 clientApi 下单的订单手工同步到 5433，或换 env 前测）
6. 期望：balance 从 100 → 0、card_transactions 新增 type='扣款' amount=-100、订单 status='已支付'
7. 重复触发 payNotify：幂等，balance 不再变，card_transactions 不新增

### A.4 CHECK 约束（§4.4）
```sql
-- 应被 chk_prepaid_paid_sum 拒绝
INSERT INTO sale_orders (sale_order_id, market_name, store_id, sale_order_datetime,
  total_amount, prepaid_card_amount, paid_amount, payment_method, ...)
VALUES (..., 300, 100, 100, '微信', ...);  -- 100+100≠300，拒
```

### A.5 取消回冲（§4.5）
1. 全额抵扣订单（§A.2）→ 顾客端点"取消订单" → `card_transactions` 新增一行 type='充值' amount=+300、balance 回涨 300
2. 再次取消同订单 → 幂等，余额不变

---

## 场景 B — 店长开单 + 顾客扫码（§4.6，跨端链路）

> ⚠ 已知 env drift：staffApi 写 5433，顾客端 clientApi 查 5434 看不到。要完整跑通需先对齐 env。

### B.1 预选全额抵扣 → 顾客直确认（§4.6 #23–26）
1. 账号 M（店长）打开员工端 order-create → 选顾客 A（余额 500）→ 添加商品总价 ¥300
2. 结算弹层看到"抵扣（预选）" 区 + 开关默认 on + 抵扣 ¥270、实付 ¥30（若有券 -30）或抵扣 ¥300
3. 底部警示条"顾客扫码确认后才真正扣卡" ✓
4. 点"生成付款码" → 二维码页 → `SELECT * FROM sale_orders WHERE sale_order_id=<新>`:
   - status='待支付', prepaid=300, paid=0, method='无'
   - `SELECT balance FROM prepaid_cards WHERE user_id='A'`: **仍 = 500**
   - `SELECT count(*) FROM card_transactions WHERE ref_order_id=<新>`: **0**
5. 顾客 A 扫码进入 scan-pay 页 → 预填"储值卡抵扣 ¥300、实付 ¥0" + "确认支付" 按钮
6. 顾客点"确认支付" → `confirmPrepaidFull` → balance 500→200、card_transactions 新 type='扣款' -300、订单 '已支付'

### B.2 顾客扫码调整（§4.6 #27–28）
- 情形 1：顾客扫码后关掉储值卡开关 → scanAdjust(useCard=false) → 订单更新为 prepaid=0, paid=300, method=<顾客选的>
- 情形 2：顾客扫码改为部分抵扣 → scanAdjust 落 prepaid=100, paid=200 → 选微信 → 走 `pay` + wx.requestPayment
- 情形 3：`INSUFFICIENT_BALANCE` → wx.showModal 弹"关闭抵扣重付"/"取消订单" 两按钮

### B.3 超时 / 跨店 / confirmOffline 扣卡（§4.6 #29–30）
1. 店长开单后顾客不扫 → 10min 后订单被 `closeExpiredPending` 关闭，balance 仍 500（预选未扣）
2. 跨店：店长在 B 店给曾在 A 店充值的 A 开单 → B 店扫码确认成功（跨店可用）
3. 线下支付：顾客扫码选"线下" → offlinePay 置 '待确认收款' → 店长 confirmOffline → 同事务扣卡 + 置 '已支付'

---

## 场景 C — 退款（§4.7）

### C.1 全额抵扣订单退款（§4.7 #31）
1. 找 §A.2 的全额抵扣订单（prepaid=300, paid=0, total=300）
2. admin 或员工端发起退款 ¥100 → approveRefund → 返回 `{ refundByCard: 100, refundByOrigin: 0 }`
3. balance +100；card_transactions 新 type='充值' amount=+100 ref_order_id=退款单ID
4. 退款单 sale_orders 行：total=-100, prepaid=-100, paid=0

### C.2 部分抵扣订单退款（§4.7 #32–33）
- 比例 prepaid=100 / total=300，退款 ¥150 → refundByCard=50.00, refundByOrigin=100.00；两者合计=150 ✓
- **精度边界**：prepaid=100 / total=301, refund=150 → `refundByCard = floor(49.8339, 2) = 49.83`, `refundByOrigin = 150 - 49.83 = 100.17`；断言 `refundByCard + refundByOrigin ≡ 150.00`

### C.3 非抵扣订单退款（§4.7 边界）
- total=300, prepaid=0, paid=300, 退款 ¥100 → refundByCard=0, refundByOrigin=100；card_transactions 无新行

---

## 场景 D — 边界与回归（§4.8–4.9）

### D.1 边界（§4.8）
- 余额 0 + 下单页 → 开关灰显无法打开 + useCard 锁为 false
- `prepaid_card_amount > total_amount - couponDiscount` → INVALID_PARAMS
- `prepaid_card_amount` 小数 3 位 → 拒绝
- payNotify / confirmOffline / confirmPrepaidFull 扣前 FOR UPDATE + 二次校验，不足抛 INSUFFICIENT_BALANCE、订单保持 '待支付'、**前端弹框**不自动降级（§5 决策 #7）

### D.2 回归（§4.9）
1. 无储值卡订单（所有历史订单 & 新下订单 useCard=false）：checkout 页完全保持原样，提交 → 订单 prepaid=0, paid=total
2. 充值流程（A 店充值 ¥500）：
   ```sql
   SELECT card_id, balance FROM prepaid_cards WHERE user_id='A';
   -- 期望: 单行（不按 user+store 拆分），balance 历史 + 500
   ```
   `\d prepaid_cards` 列集：card_id / user_id / balance / created_at / updated_at（无 store_id）
3. 历史订单：`SELECT COUNT(*) FROM sale_orders WHERE paid_amount <> total_amount`：应为 0（migration 回填齐）；GMV 老口径 `SUM(total_amount)` 不变
4. 转换单负差额：多退入卡 → UPSERT 按 user_id、INSERT 列集不含 store_id
5. 完整流：充值 500 → 换店 → 下单 300 全额抵扣 → 余额 200 → 退款 100 → 余额 300；流水三行（充值+500、扣款-300、充值+100）

---

## 场景 E — admin 展示（§2.6 + §3.4）

1. 订单详情页三行金额正确（见 §A.2 第 4 步）
2. 列表筛选"有储值卡抵扣"、`payment_method='无'` 能工作
3. 仪表盘 action 返回 `totalPaidAmount` 字段（本期 UI 不展示，DevTools Network 能看到即可）
4. 资金流水页（card-transactions）type='扣款' 能筛

---

## 快速 psql 检查脚本

```sql
-- 状态概览（对任一库）
SELECT
  (SELECT count(*) FROM prepaid_cards) AS cards,
  (SELECT count(*) FROM prepaid_cards p GROUP BY user_id HAVING count(*)>1) AS dup,
  (SELECT unnest(enum_range(NULL::payment_method))) AS methods,
  (SELECT count(*) FROM sale_orders WHERE prepaid_card_amount + paid_amount <> total_amount) AS check_violations;

-- 储值卡完整流水（指定用户）
SELECT ct.type, ct.amount, ct.ref_order_id, ct.created_at, pc.balance
FROM card_transactions ct
JOIN prepaid_cards pc ON pc.card_id = ct.card_id
WHERE pc.user_id = 'FYGK-xxx' ORDER BY ct.created_at;
```

---

## 已知局限 & Follow-up

- 🟠 **env drift**：clientApi(5434) vs staffApi/payNotify(5433) — 跨端联动（场景 B）需先修；建议单独 ticket 对齐。
- 🟠 **card-recharge WXSS 硬编码 #C0322A**（pre-existing，11 处）：不在本 ticket 范围。
- 🟡 微信支付接入 mock 模式：真实支付回调自动触发 payNotify 的链路需 env 对齐后重新 smoke。
