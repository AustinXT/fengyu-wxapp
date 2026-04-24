# Ticket: admin 退款补齐 + 退款金额按商品剩余未使用价值规则对齐

> 生成日期：2026-04-24
> 严重级别：P1（产品增量 / 补齐 admin 端退款能力 + 规则规范化）
> 端：fengyu-admin（管理后台，**全新能力**） + fengyu-staff（员工端，**规则对齐 + 流水迁移**）
> 影响面：admin.actions.orders（+2 action）+ staffApi.order（createRefund/rejectRefund/approveRefund 改写写入 payments）+ 三端订单详情展示退款流水
> 前置：**`2026-04-24-order-partial-payment-foundation.md` 的 PR-1（schema）必须先合并**
> 并行：与 Ticket 2（多次回款）可并行
>
> **一句话目标**：staff 端已有的 `createRefund` 沿用 "`退款金额 = Σ(未使用数量 × unit_real_price) − handling_fee`" 规则，但资金动作改为写 `sale_order_payments` 表 `change_type='退款' amount<0` 行；admin 端**补齐对等能力**（Server Action + UI）；client 端**不提供**退款入口（店长/管理员审批型流程）。

---

## 0 一句话背景

退款场景规范化：
- 顾客消费了 2 次疗程中的 1 次，剩 1 次未用 → 可退 `1 × unit_real_price − 手续费`
- 顾客买的单品已提货一半 → 可退 `未提货数量 × unit_real_price`
- 顾客订单只付了部分款（Ticket 1 引入的部分支付） → 退款金额仍按"未使用价值"算，不按"已付金额"算；财务上会出现"退款 > 已付"的情况，此时系统生成一条 payments 负数行，净额 `paid_amount` 可变为负数（= 商家欠顾客），由对账月结走线下结清

现状差异：
- staff 端 `createRefund` 已实现完整规则（云函数 1012-1127），但**仍在 sale_orders 插入 FY-TKD 子订单承载资金流水**
- admin 端 0 实现
- 历史退款订单（FY-TKD）需回填对应 payments 流水（Ticket 1 迁移覆盖）

**本 ticket 核心变更**：
1. 保留 `sale_order_type='退款单'` + FY-TKD 订单号作**审批凭证类型**；资金动作走 payments
2. 退款金额规则**明文化**到 spec 文档，admin/staff 两端共用
3. admin 新增 `createRefundOrder` + `approveRefund` + `rejectRefund` Server Action 三联
4. staff 端改写为"凭证单 + payments 行"双写（与 Ticket 2 的 repayment 形态一致）

---

## 1 问题定位

### 1.1 现状盘点

| 端 | 现状 | 差异 |
|---|---|---|
| staff 云函数 | `createRefund`（routes/order.js:1012-1127）完整；生成 FY-TKD 凭证单 + sale_items 行 `item_direction='退出'`；待审批 → 店长 approve/reject；approve 时扣减原 `sale_items.remaining_sessions` | ⚠️ 资金流水改走 payments；规则不变 |
| staff 前端 | 已有退款发起页（`pages/refund-create/` 或类似） | ✓ 保留；仅增加流水显示 |
| admin | 零实现 | ❌ 全新能力 |
| client | 零实现 | — **不做**（业务决定） |

### 1.2 退款金额规则（明文化）

**核心公式**：
```
refundable_per_item = remaining_unused_quantity × unit_real_price
total_refundable = Σ(refundable_per_item for each sale_item selected)
final_refund_amount = max(0, total_refundable − handling_fee)
```

**"未使用数量"的定义**（按商品类型）：

| 商品类型 | 已使用计量 | 未使用计算 |
|---|---|---|
| 护理项目（疗程卡） | `sale_items.session_count − remaining_sessions` | `remaining_sessions` |
| 家居产品（单品） | `picked_up_quantity` | `sale_items.quantity − picked_up_quantity` |
| 充值卡 | 看 `cardTransactions` 已扣款累计 | `初始金额 − Σ(type='扣款')` 的金额维度 |
| 体验卡 | 同护理项目 | `remaining_sessions` |
| 组合套餐（bundle） | 按组成 sub-items 递归计算 | 逐个子项加总 |

**禁止退款的情况**：
- `remaining_sessions = 0 && picked_up_quantity = quantity`（全部使用完）
- 原订单 `status='已关闭'`
- 已有未完结的退款单（同一原单只允许 1 笔退款单 in-flight）

### 1.3 数据模型补充

无新增表；复用 Ticket 1 的 `sale_order_payments`。

**退款流水行模板**：
```sql
INSERT INTO sale_order_payments (
  sale_order_id,      -- ref 到原销售单
  change_type,        -- '退款'
  amount,             -- 负数
  payment_method,     -- 退款原路径：微信/支付宝/线下/储值卡
  external_txn_id,    -- 若退款通过三方 refund API，返回的退款号
  status,             -- 待审批（审批中）→ 已支付（审批通过 + 退款到账）
  source_end,         -- staff / admin
  operator_employee_id,
  note,               -- 含退款原因 + handling_fee 记录
  created_at, paid_at
);
```

**FY-TKD 凭证单（sale_orders）**：
```sql
INSERT INTO sale_orders (
  sale_order_id,          -- FY-TKD-WX-YYMMDD0001
  sale_order_type,         -- '退款单'
  ref_sale_order_id,       -- 原销售单
  total_amount,            -- = -(total_refundable) = 负数
  paid_amount,             -- = -(final_refund_amount)
  handling_fee,
  refund_reason,
  status,                  -- '待审批' → '已支付' (approve) / '已关闭' (reject)
  approved_by, approved_at, rejected_reason,
  payment_method,
  ...
);
```

### 1.4 储值卡回冲

若原单有 `prepaid_card_amount > 0`（储值卡抵扣部分），退款时按比例回冲：
```
refund_to_prepaid_card = round(final_refund_amount × prepaid_card_amount / payable_amount, 2)
refund_to_payment_channel = final_refund_amount − refund_to_prepaid_card
```

对应写 2 行 payments：
- `change_type='退款', payment_method='储值卡', amount=-refund_to_prepaid_card`（负数）
- `change_type='退款', payment_method=<原通道>, amount=-refund_to_payment_channel`（负数）

同时 `cardTransactions` 插入 `type='充值', amount=refund_to_prepaid_card, ref_order_id=FY-TKD-...`（回补储值卡余额）。

---

## 2 设计决策

### 2.1 退款审批流

```
staff/admin 发起 createRefund
        ↓
     FY-TKD 凭证单 (sale_orders.status='待审批')
     payments 行 (status='待审批')
        ↓
     审批人决定：
      ├─→ approveRefund（店长/admin）
      │      ├─ 扣减 sale_items.remaining_sessions / picked_up_quantity（反向）
      │      ├─ payments 行 status='已支付', amount=负数
      │      ├─ 若有储值卡回冲：cardTransactions(type='充值')
      │      ├─ 若三方退款（微信/支付宝）：调用三方 refund API, 成功后 paid_at
      │      └─ 重算原单 paid_amount（可能变负）
      │
      └─→ rejectRefund
             ├─ FY-TKD 凭证单 status='已关闭' + rejected_reason
             ├─ payments 行 status='已作废'
             └─ 原单 sale_items 不动
```

### 2.2 admin 退款权限

- 默认：`admin` 角色可发起 + 审批
- 大额退款（>500 元）：预留开关走二级审批（本 ticket **不实现**，留 TODO）
- staff 端仍沿用店长权限

### 2.3 三方退款路径

| 原支付方式 | 退款路径 |
|---|---|
| 微信 | 调用微信退款 API（`/refund`）；result 回调后更新 payments.status |
| 支付宝 | 调用支付宝退款 API；同上 |
| 线下 | 直接标记 `已支付`（线下退现金，店员操作） |
| 储值卡 | 同事务回冲 `prepaid_cards.balance` + `cardTransactions(type='充值')` |
| 无（全额储值卡抵扣订单） | 全额回补储值卡 |

本 ticket **只实现线下 + 储值卡路径**；微信/支付宝退款 API 集成留下一 ticket（需联调沙盒环境 + 证书配置）。

### 2.4 退款对业绩分配的影响

退款审批通过后：
- 原单 `sale_items` 的业绩分配 `sale_allocations` 行按比例**生成反向分配行**（amount 负数）
- 业绩报表聚合时自然扣除

**本 ticket 不深入此部分**，保持 staff 现有行为（若已有反向分配逻辑）。

### 2.5 staff 前端 vs admin 前端差异

| 功能 | staff 前端 | admin 前端 |
|---|---|---|
| 发起退款入口 | 订单详情"申请退款"按钮（店员） | 订单详情"创建退款单"按钮 |
| 审批 | 店长"我的"→ 退款待审批列表 | 后台"订单 → 退款审批"页面 |
| 批量审批 | ✗ | ✓（勾选 + 批量通过） |
| 退款流水展示 | 订单详情款项流水区 | 订单详情 + 独立流水页 |

---

## 3 实施计划（按 PR 拆分）

### PR-X：staff 退款云函数改写（写 payments）

| # | 任务 | 文件 |
|---|------|------|
| X1 | `createRefund` 改写：生成 FY-TKD 凭证 + 插入 payments 行 `change_type='退款', status='待审批'` | `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1012-1127` |
| X2 | `approveRefund` 改写：payments 行 `status='已支付'` + 扣减 `sale_items.remaining_sessions` + 储值卡回冲 | 同上 |
| X3 | `rejectRefund` 改写：payments 行 `status='已作废'` | 同上 |
| X4 | 重算原单 paid_amount（允许负数） | 同上 + `db/utils/payments.ts` |
| X5 | 集成测试：退 1 次疗程 → 原单 remaining_sessions 减 1，payments 负数行已支付 | `__tests__/order.refund.test.js` |

### PR-Y：admin Server Action + UI

| # | 任务 | 文件 |
|---|------|------|
| Y1 | `createRefundOrder` Server Action（入参对齐 staff） | `fengyu-admin/src/actions/orders.ts` |
| Y2 | `approveRefund` / `rejectRefund` Server Action | 同上 |
| Y3 | `calculateRefundable(saleOrderId)` 工具：返回按 sale_item 粒度的可退明细（复用 staff 端算法） | `fengyu-admin/src/lib/refund.ts`（新增） |
| Y4 | 订单详情页"退款"区块（已有退款单展示 + "创建退款"按钮） | `fengyu-admin/src/app/(dashboard)/orders/[id]/page.tsx` |
| Y5 | 退款创建弹层组件（item 粒度勾选 + 数量输入 + 手续费 + 原因） | `fengyu-admin/src/components/orders/RefundForm.tsx` |
| Y6 | 退款审批页（/dashboard/refunds） | `fengyu-admin/src/app/(dashboard)/refunds/page.tsx` |
| Y7 | 类型检查 + vitest + Playwright E2E | `fengyu-admin/tests/e2e/refund.spec.ts` |

**Y3 算法（`calculateRefundable`）**：
```ts
async function calculateRefundable(saleOrderId: string) {
  const items = await db.query.saleItems.findMany({
    where: eq(saleItems.saleOrderId, saleOrderId),
  });
  return items.map(item => {
    let unused = 0;
    if (item.productKind === '护理项目' || item.productKind === '体验卡') {
      unused = item.remainingSessions ?? 0;
    } else if (item.productKind === '家居产品') {
      unused = (item.quantity ?? 0) - (item.pickedUpQuantity ?? 0);
    } else if (item.productKind === '充值卡') {
      unused = /* 查 cardTransactions 累计扣款 */;
    }
    return {
      saleItemId: item.saleItemId,
      productName: item.spuName,
      specName: item.specName,
      unitRealPrice: item.unitRealPrice,
      unusedQuantity: unused,
      refundableAmount: Number(item.unitRealPrice) * unused,
    };
  });
}
```

**Y1 签名**：
```ts
createRefundOrder({
  refSaleOrderId: string,
  items: Array<{ saleItemId: string, refundQuantity: number }>,
  refundReason: string,
  handlingFee?: number,  // 默认 0
}): Promise<{ refundOrderId: string }>  // FY-TKD-WX-...
```

### PR-Z：三端订单详情展示退款流水

| # | 任务 | 文件 |
|---|------|------|
| Z1 | staff 订单详情 payments 流水含退款行（负数用红色/[-] 显示） | `fengyu-staff/miniprogram/pages/order-detail/` |
| Z2 | admin 订单详情 payments 流水 | `fengyu-admin/src/components/orders/PaymentsTable.tsx` |
| Z3 | client 订单详情（只读，含退款记录） | `fengyu-client/miniprogram/pages/order-detail/` |
| Z4 | 三端 detail API 返回 payments 数组（Ticket 1 已实现，本 PR 仅确保包含退款行） | — |

### 不在本 ticket 范围

- [ ] 微信/支付宝退款 API 集成（本 ticket 只线下 + 储值卡）
- [ ] client 端退款发起入口（业务决策：不提供）
- [ ] 二级审批（大额退款）
- [ ] 业绩分配反向冲销细节（延续现有行为）
- [ ] 批量退款操作（admin 批量审批本 ticket 覆盖；批量创建不做）

---

## 4 验收标准

1. **staff 退款疗程**：订单含疗程卡 2 次已用 1 次 → staff 发起退款 → FY-TKD 凭证 `待审批` + payments 负数行 `待审批` → 店长通过 → sale_items.remaining_sessions=0，payments `已支付`，原单 paid_amount 减对应金额
2. **admin 退款疗程**：同 1，通过 admin 入口
3. **admin 退款单品**：订单 5 件商品已提 2 件 → 退款 3 件 → 退款金额 `3 × unit_real_price`
4. **手续费**：退款金额 100 + handling_fee 20 → 实退 80；payments amount=-80
5. **储值卡回冲**：原单 payable=200，prepaid_card_amount=50（储值卡抵 50 + 现金 150）→ 全额退款 200 → 储值卡回补 50（cardTransactions 充值行），现金退 150（payments 负数）；顾客账户余额恢复
6. **部分支付订单退款**：订单 payable=200 paid=100，未使用价值 150 → 退款 150 → paid_amount 变为 -50（商家欠顾客，走线下月结）；系统不阻止
7. **禁止退全部用完的订单**：所有 item `unused=0` → 创建退款返回 `INVALID_STATE: 无可退项`
8. **in-flight 唯一性**：同一原单已有 `待审批` 的 FY-TKD → 再发起 → 返回 `CONFLICT: 存在未完结退款单`
9. **审批驳回**：FY-TKD `已关闭` + payments `已作废`；原单 remaining_sessions 不变
10. **幂等**：approveRefund 重复调用 → 同一 FY-TKD 仅扣减一次 remaining_sessions（DB 条件判断）
11. **类型检查**：admin / staff 通过
12. **测试覆盖**：新增 ≥ 15 个测试用例

---

## 5 风险与决策点

| 风险/决策 | 处理方案 |
|---|---|
| 退款金额 > 已付金额（部分支付后退款） | 允许，paid_amount 变负；UI 明确提示"商家应退顾客差额 X 元（线下结清）" |
| 并发审批（两个管理员同时通过同一退款） | `SELECT ... FOR UPDATE` + FY-TKD 凭证 status 单向 `待审批→已支付/已关闭` 校验 |
| 扣减 remaining_sessions 前商品已被核销 | 事务内 `FOR UPDATE` + 校验 remaining_sessions ≥ 本次退款数量 |
| 储值卡回冲时余额账户已被删 | 同 2026-04-23 ticket：一户一账户，唯一索引 user_id；不存在删除场景 |
| 历史 FY-TKD 订单（Ticket 1 合并前已存在）与新 payments 行对齐 | Ticket 1 迁移脚本已回填对应 payments 行 |
| 审批后反悔（已退款想撤回） | **不支持**；业务上已退款无法撤销，只能重新开单 |
| 退款金额规则若业务方后续修改 | 规则在 `calculateRefundable` 工具里集中实现，便于后续调整 |
| handling_fee 是否参与业绩分配 | **不参与**；作为商家收入行，单独记账 |

---

## 6 前置依赖与环境

- **前置 ticket**：`2026-04-24-order-partial-payment-foundation.md`（Ticket 1）的 PR-1（schema） 必须先合并
- **并行 ticket**：`2026-04-24-multi-repayment-three-ends.md`（Ticket 2）可同步进行（两者不共享改动文件）
- **数据库**：无 DDL（仅 DML）
- **部署顺序**：staff 云函数改写 → admin 云函数/Action → 前端（可交错）
- **回滚**：按 PR 粒度独立回滚；staff 端改写若有问题，可临时回到"不写 payments、只写 FY-TKD"模式（通过环境变量开关）

---

## 7 相关引用

- **Ticket 1**：`notes/tickets/2026-04-24-order-partial-payment-foundation.md`（schema）
- **Ticket 2**：`notes/tickets/2026-04-24-multi-repayment-three-ends.md`（回款，并行）
- **现有 staff 实现**：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:1012-1127`（`createRefund`）
  - 同文件其他 `approveRefund` / `rejectRefund`（若已存在）
- **现有算法依据**：
  - `sale_items.remaining_sessions` 扣减（核销时）`fengyu-staff/cloudfunctions/staffApi/routes/service.js` `complete`
  - `picked_up_quantity` 累加逻辑（若有）
- **储值卡相关**：
  - `notes/tickets/2026-04-23-prepaid-card-deduction-by-store.md` §2.5（退款回冲规则）
  - `db/schema/prepaid-card.ts`
- **规范文档**：
  - `.42cog/real.md:§2.2`（支付幂等）§2.3（状态单向推进）
  - `.42cog/pm/backend.pr.spec.md` §3.1（退款单）
  - `.42cog/pm/admin.pr.spec.md`（admin 退款 UI 规范，若无则本 ticket 建立基线）
