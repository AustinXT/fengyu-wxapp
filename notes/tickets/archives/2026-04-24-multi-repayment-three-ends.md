# Ticket: 三端多次回款 — client / staff / admin 对未付清订单追加付款

> 生成日期：2026-04-24
> 严重级别：P1（产品增量 / 打通三端回款闭环）
> 端：fengyu-client（顾客端，**新增能力**） + fengyu-staff（员工端，**UI 补齐**） + fengyu-admin（管理后台，**全新能力**）
> 影响面：clientApi.order（+1 action）+ staffApi.order（改写 createRepayment） + admin.actions.orders（+2 action）+ 三端 UI
> 前置：**`2026-04-24-order-partial-payment-foundation.md` 的 PR-1（schema）必须先合并**
> 并行：与 Ticket 3（admin 退款补齐）可并行
>
> **一句话目标**：任何一个 `paid_amount < payable_amount` 的订单，顾客（client）、店长（staff）、管理员（admin）都可以发起回款；一个订单允许多次回款；回款通过支付通道（微信/支付宝/储值卡/线下）走通后，向 `sale_order_payments` 追加一条 `change_type='回款'` 的流水行，`paid_amount` 累加；付清时订单状态自动翻 `'已支付'`。

---

## 0 一句话背景

Ticket 1 打好了 payments 流水表底座后，本 ticket 把"对未付清订单追加付款"的能力铺开到三端：

- **client**：顾客在订单详情页看到欠款 → 点"继续支付" → 选支付方式（微信/支付宝/储值卡）→ 付完；支持无限次追加
- **staff**：店长在收银台/订单详情看到欠款 → 选支付方式（现金/扫码/储值卡）→ 收款；沿用现有 `createRepayment` 云函数但改为只写 payments 行（不再创建子订单）
- **admin**：管理员在订单详情页看到欠款 → 录入回款（现金/转账/扫码回执）→ 写入 payments 行

**本 ticket 核心变更**：
1. 现有的 `sale_order_type='回款单'` 模型**保留作审批/凭证类型**（订单号 FY-HKD 仍生成，作为回款凭证载体），**但资金动作只写 payments 行**——一个回款动作 = 1 条 FY-HKD 凭证 sale_orders 行 + 1 条 payments 流水行，后者为资金权威源
2. client 端新增 `clientApi.order.repay` action + 前端入口
3. admin 端新增 `createRepayment` Server Action + UI

---

## 1 问题定位

### 1.1 现状盘点（基于 Ticket 1 合并后的状态）

| 端 | 现状 | 差异 |
|---|---|---|
| **staff** | 云函数 `createRepayment`（staffApi/routes/order.js:1217-1314）已存在；生成 FY-HKD 子订单 + 累加原 sale_items.received；前端**无入口** | ⚠️ 改写：资金动作走 payments 表；前端补入口 |
| **admin** | `actions/orders.ts` 无任何 refund/repayment 函数；订单详情页无回款 UI | ❌ 全新能力 |
| **client** | `clientApi.order` 无 `repay` action；订单详情页无"继续支付"按钮 | ❌ 全新能力 |

### 1.2 三端能力对比表

| 能力 | staff | admin | client |
|---|---|---|---|
| 看到订单欠款额 | ✓（Ticket 1 加） | ✓（Ticket 1 加） | ✓（Ticket 1 加） |
| 发起回款 | 本 ticket（改写） | 本 ticket（新增） | 本 ticket（新增） |
| 支持的支付方式 | 微信扫码（店长扫顾客）/ 现金（线下）/ 储值卡 | 线下录入（手工回执）/ 储值卡 | 微信 / 支付宝 / 储值卡 |
| 支持审批 | 店长免审 | 管理员免审 | 自助免审 |
| 回款号（FY-HKD） | 生成 | 生成 | 生成 |
| 幂等 | 三方交易号（微信） | 手工录入 txn_id 必填 | 三方交易号 |

### 1.3 数据模型补充

无新增表；Ticket 1 的 `sale_order_payments` 即承载本 ticket 全部回款流水。

**回款流水行模板**：
```sql
INSERT INTO sale_order_payments (
  sale_order_id, change_type, amount, payment_method,
  external_txn_id, status, source_end, operator_employee_id,
  note, created_at
) VALUES (
  $original_sale_order_id,   -- 回款流水 ref 到原销售单
  '回款',
  $repay_amount,             -- 正数
  $payment_method,
  $txn_id,                   -- 微信/支付宝必填；线下/储值卡 NULL
  $status,                   -- 线上='待支付'；线下/储值卡='已支付'
  $source,                   -- client/staff/admin
  $employee_id_or_null,
  $note,
  NOW()
);
```

**FY-HKD 凭证行（sale_orders）**：
```sql
INSERT INTO sale_orders (
  sale_order_id,           -- FY-HKD-WX-YYMMDD0001
  sale_order_type,          -- '回款单'
  ref_sale_order_id,        -- 原销售单号
  client_user_id, store_id, ...
  total_amount,             -- = repay_amount
  paid_amount,              -- = repay_amount（凭证单自成闭环）
  prepaid_card_amount,      -- 若储值卡抵扣则 > 0
  payable_amount,           -- = total_amount - prepaid_card_amount
  status,                   -- '已支付'（线上到账后回填）/ '待支付'
  payment_method,
  created_at, paid_at
);
```

**关键约束**：
- 同一订单的回款行 `amount` 之和 + 首次支付 + 储值卡抵扣 ≤ `payable_amount`
- 不允许在 `status='已关闭'` 或 `'已完成'` 订单上发起回款
- 储值卡抵扣回款时：储值卡扣款 + `cardTransactions(type='扣款', ref_order_id=原订单)` 同事务

---

## 2 设计决策

### 2.1 回款 = 凭证单（FY-HKD） + payments 流水行（双写）

| 维度 | 凭证单（sale_orders 中 `sale_order_type='回款单'`） | payments 流水行 |
|---|---|---|
| 承载 | 回款凭证、审批历史、订单号 | 资金实际流动 |
| 订单号 | FY-HKD-WX-YYMMDDNNNN（保留） | 无独立号，通过 `sale_order_id + id` 唯一 |
| 统计 | **不计入**业绩 / 商品销售；只作对账凭证 | paid_amount 权威源 |
| 审批 | 沿用现有店长审批流（staff端 rejectRefund 对称） | 无审批；status 由回调驱动 |

**为什么双写**：
- 凭证单保留对历史/审批流的兼容（staff 现有 UI 和业务习惯不破坏）
- 流水表提供 paid_amount 的单一权威源（Ticket 1 建立的不变量）

### 2.2 三端支付方式矩阵

| 端 | 微信支付 | 支付宝 | 储值卡 | 线下（现金/刷卡/转账） |
|---|---|---|---|---|
| client | ✓ 主路径，复用 `pay` 链路 | ✓ 复用 `alipayPay` | ✓ 复用 2026-04-23 抵扣逻辑 | ✗（顾客端不应有线下入口） |
| staff | ✓（扫码/出示收款码） | ✗（业务暂不做） | ✓ | ✓（店长线下收款，录入回执） |
| admin | ✗（管理员不收钱） | ✗ | ✓（代顾客操作） | ✓（录入回执 txn_id 必填） |

### 2.3 回款金额校验

```
0 < repay_amount ≤ (payable_amount - paid_amount)
```

**边界**：最小回款 0.01 元（DB NUMERIC(10,2)）；**不允许**多付导致负欠款。

### 2.4 储值卡回款的特殊处理

储值卡抵扣回款时，`payments` 表 `change_type='回款'` + `payment_method='储值卡'`（**不再**单独写 `change_type='储值卡抵扣'` 行——那个类型仅用于"下单时同时抵扣 + 现金"的场景）。

**储值卡余额不足**：
- 方案 A：禁止（前端拦截）
- 方案 B：余额全部扣完 + 剩余部分走另一支付方式（二段支付）
- **选择方案 A**（本 ticket 简化），方案 B 留给后续增量

### 2.5 状态机

```
订单状态：
  部分支付 ──repay_full─→ 已支付
  部分支付 ──repay_partial─→ 部分支付（仍然）
  待支付   ──repay─→ 部分支付 或 已支付

payments 行状态：
  new → 待支付 ──wxpay_notify─→ 已支付
  new → 待支付 ──timeout 30min─→ 已作废
  new → 已支付（线下/储值卡直落）
```

**幂等边界**：
- 客户端同一订单 1 秒内点 2 次"继续支付" → 后者命中"存在 status='待支付' 的凭证单" → 复用，不新建
- 微信回调重试 → UNIQUE(sale_order_id, payment_method, external_txn_id) 防重

### 2.6 回款凭证单的业绩分配

**决策**：回款凭证单（FY-HKD）**不产生新的业绩分配行**。业绩分配仍按原销售单挂钩到 sale_items 的 `allocated_to_employee_id`。回款只是资金到账动作，不触发再分配。

---

## 3 实施计划（按 PR 拆分）

### PR-A：staffApi `createRepayment` 改写 + UI 补齐

| # | 任务 | 文件 |
|---|------|------|
| A1 | 改写 `createRepayment`：生成 FY-HKD 凭证单的同时，向 `sale_order_payments` 插入 `change_type='回款'` 行 | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1217-1314` |
| A2 | 更新原销售单 `paid_amount` + `status`（若付清翻 `已支付`） | 同上 |
| A3 | 新增 `payRepayment` action：处理回款凭证单的线上支付发起 | 同上 |
| A4 | 前端：订单详情页"欠款"区域 + "发起回款"按钮（店长可见） | `fengyu-staff/miniprogram/pages/order-detail/` |
| A5 | 前端：回款弹层（金额 + 支付方式选择）；微信扫码走 `qrcode` action 类似路径 | 新组件 `<RepaymentModal>` |
| A6 | 集成测试：部分支付单多次回款付清 → 状态翻 `已支付` | `fengyu-staff/cloudfunctions/staffApi/__tests__/order.repayment.test.js` |

**关键伪代码（A1）**：
```js
async function createRepayment({ refSaleOrderId, repayAmount, paymentMethod, prepaidCardAmount }) {
  await pg.transaction(async tx => {
    // 1. 校验原单
    const origin = await tx.query('SELECT * FROM sale_orders WHERE sale_order_id=$1 FOR UPDATE', [refSaleOrderId]);
    assert(origin.status IN ('部分支付','待支付'));
    assert(repayAmount + prepaidCardAmount ≤ origin.payable_amount - origin.paid_amount);
    
    // 2. 生成 FY-HKD 凭证单
    const saleOrderId = await generateOrderNo('FY-HKD-WX-');
    await tx.query('INSERT INTO sale_orders(...) VALUES (...)', ['回款单', refSaleOrderId, ...]);
    
    // 3. 插入 payments 行
    await tx.query(`
      INSERT INTO sale_order_payments(sale_order_id, change_type, amount, payment_method, status, source_end, ...)
      VALUES ($1, '回款', $2, $3, $4, 'staff', ...)
    `, [refSaleOrderId, repayAmount, paymentMethod, isOnlineMethod(paymentMethod) ? '待支付' : '已支付']);
    
    // 4. 储值卡抵扣（若有）
    if (prepaidCardAmount > 0) {
      await deductPrepaidCard(tx, clientUserId, prepaidCardAmount, refSaleOrderId);
      await tx.query(`INSERT INTO sale_order_payments(..., change_type='储值卡抵扣') VALUES (...)`);
    }
    
    // 5. 重算原单 paid_amount + status
    await recalcSaleOrderPayment(tx, refSaleOrderId);
    
    return { repaymentOrderId: saleOrderId };
  });
}
```

### PR-B：admin 回款 Server Action + UI

| # | 任务 | 文件 |
|---|------|------|
| B1 | 新增 `createRepaymentOrder` Server Action（签名对齐 PR-A） | `fengyu-admin/src/actions/orders.ts` |
| B2 | 订单详情页"款项流水"区块 + "录入回款"按钮 | `fengyu-admin/src/app/(dashboard)/orders/[id]/page.tsx` |
| B3 | 回款表单组件（金额 + 支付方式 + txn_id + 备注） | `fengyu-admin/src/components/orders/RepaymentForm.tsx` |
| B4 | 权限：仅 admin 角色可见 | 复用 `permission_roles` 校验 |
| B5 | vitest 单测 + Playwright E2E | `fengyu-admin/tests/` |

### PR-C：clientApi `order.repay` + 前端继续支付

| # | 任务 | 文件 |
|---|------|------|
| C1 | 新增 action `order.repay`：入参 `saleOrderId`, `paymentMethod`, `repayAmount`, `prepaidCardAmount` | `fengyu-client/cloudfunctions/clientApi/routes/order.js` |
| C2 | 三条路径：微信（复用 `pay` 链路生成 prepay_id）/ 支付宝（复用 `alipayPay`）/ 储值卡（同事务扣款）| 同上 |
| C3 | 回调（`payNotify`）：更新 payments 行 + 重算 sale_orders.paid_amount | `fengyu-client/cloudfunctions/payNotify/index.js` |
| C4 | 订单详情页 "继续支付" 按钮（`payable - paid > 0` 时显示） | `fengyu-client/miniprogram/pages/order-detail/` |
| C5 | 支付方式选择弹层（微信/支付宝/储值卡） | 新组件 |
| C6 | 款项流水展示（历次支付记录列表） | 同上 |
| C7 | 集成测试 | `fengyu-client/cloudfunctions/clientApi/__tests__/` |

**C1 关键签名**：
```js
// clientApi.order.repay
{
  action: 'order.repay',
  payload: {
    saleOrderId: 'FY-XSD-WX-...',
    paymentMethod: '微信' | '支付宝' | '储值卡',
    repayAmount: number,          // 单位：元
    prepaidCardAmount: number     // 可选，0 默认
  }
}
// 返回
{
  code: 0,
  data: {
    repaymentOrderId: 'FY-HKD-WX-...',
    // 微信/支付宝：返回 prepay_id / 支付参数
    paymentParams: {...}
  }
}
```

### PR-D：共用工具函数

| # | 任务 | 文件 |
|---|------|------|
| D1 | `recalcSaleOrderPayment(tx, saleOrderId)` — 重算 paid_amount + status | `db/utils/payments.ts`（新增） |
| D2 | `generateRepaymentOrderNo()` — 订单号生成 | 复用 Ticket 1 的 utility |
| D3 | `deductPrepaidCard(tx, userId, amount, refOrderId)` — 储值卡扣款 + 流水 | 复用 2026-04-23 ticket 的实现 |

### 不在本 ticket 范围

- [ ] 储值卡余额不足的二段支付（方案 B）
- [ ] 回款审批流（本 ticket 三端均免审）
- [ ] 超额回款后自动生成退款（Ticket 3 不覆盖此场景）
- [ ] 批量回款（多订单一次性收款）

---

## 4 验收标准

1. **staff 回款付清**：某订单 payable=200 / paid=100 → 店长发起 repay(100 线下) → 新增 FY-HKD 凭证单 + payments 行 change_type='回款' amount=100 status='已支付' → 原单 paid_amount=200 status='已支付'
2. **staff 多次回款**：某订单 payable=300 / paid=100 → 回款 50 → 状态仍 `部分支付` paid=150 → 再回款 150 → `已支付`
3. **staff 微信回款**：repay(100, '微信') → payments 行 status='待支付' → 店长扫码顾客收款码 → 回调到账 → payments 行转'已支付'
4. **admin 回款**：后台录入现金回款 100，txn_id='bank_receipt_20260425_001' → 成功写入
5. **client 继续支付（微信）**：顾客进订单详情 → 点"继续支付" → 微信拉起 → 付 100 → 回调后看到 paid_amount=200
6. **client 储值卡回款**：余额 150，订单欠款 100 → 点"储值卡付清" → 余额扣至 50，订单 `已支付`
7. **幂等**：微信同一回调重试 3 次 → payments 仅 1 行已支付
8. **超额防御**：尝试回款超过 `payable - paid` → 返回 `INVALID_PARAMS:` 错误
9. **已关闭订单防回款**：对 `status='已关闭'` 订单发起回款 → 返回 `INVALID_STATE:` 错误
10. **三端流水一致**：staff/admin/client 回款后，三端 detail API 返回的 payments 流水完全一致（同一订单）

---

## 5 风险与决策点

| 风险/决策 | 处理方案 |
|---|---|
| 并发两端同时回款（staff 线下 + client 微信） | `SELECT ... FOR UPDATE` + 校验 `paid_amount + 本次 ≤ payable_amount`；后者失败返回错误提示 |
| 微信回调丢失 / 延迟 | payments 行 30 分钟超时任务转 `已作废`；失败订单用户可重发 |
| 储值卡余额扣完后又退款回冲 | 按 Ticket 3 的退款规则，按比例回冲储值卡 |
| FY-HKD 凭证单号并发 | 沿用现有 advisory lock（generateOrderNo 实现） |
| client 端发起回款时原订单被关闭 | 事务内 `SELECT FOR UPDATE` + 校验 status，避免脏写 |
| 回款凭证单业绩是否计入 | **不计入**；业绩以原销售单为准 |
| 旧 `createRepayment` 前端调用方（若有） | 无（当前前端零调用，改写不破坏任何存量调用） |

---

## 6 前置依赖与环境

- **前置 ticket**：`2026-04-24-order-partial-payment-foundation.md`（Ticket 1）的 PR-1（schema） 必须先合并；PR-2/3/4（三端支付改造）建议也先合并以避免双写冲突
- **数据库**：双 PG（5433/5434）不涉及 DDL（只 DML）
- **部署顺序**：staffApi → admin → clientApi + payNotify（client 最后，避免顾客遇到未就绪的 staff 端）
- **灰度**：client 端通过 appConfig 灰度开关控制"继续支付"按钮可见性

---

## 7 相关引用

- **Ticket 1**：`notes/tickets/2026-04-24-order-partial-payment-foundation.md`（schema 基础）
- **Ticket 3**：`notes/tickets/2026-04-24-refund-admin-parity-and-rules.md`（退款，并行）
- **现有 staff 实现**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1217-1314`（createRepayment 原实现）
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1798-1820`（generateOrderNo）
- **现有 client 实现**：
  - `fengyu-client/cloudfunctions/clientApi/routes/order.js` `pay / alipayPay / offlinePay`
  - `fengyu-client/cloudfunctions/payNotify/index.js` 支付回调
- **储值卡参考**：
  - `notes/tickets/2026-04-23-prepaid-card-deduction-by-store.md`（抵扣规则）
  - `db/schema/prepaid-card.ts`（余额表 + 流水表）
- **规范文档**：
  - `.42cog/real.md:§2.1-2.3`（状态流转 / 幂等 / 单向推进）
  - `.42cog/pm/staff.pr.spec.md`（店长回款 UI 规范，若无则本 ticket 建立基线）
  - `.42cog/pm/client.pr.spec.md`（顾客"继续支付"流程）
