# Ticket: 重写 staffApi 25 个 skipped 测试为 sale_order_payments 新模型

> 创建日期：2026-04-26
> 实施日期：2026-05-03（schedule 远程 agent 触发）
> 严重级别：**P1**（技术债，不阻塞上线）
> 来源：sale_order_type 5→3 重构 follow-up（[2026-04-26-sale-order-domain-refactor.md](./2026-04-26-sale-order-domain-refactor.md) §8.3 子任务）

---

## 0 一句话目标

把 staffApi 在 2026-04-26 重构后被整组 `describe.skip` 的 25 个测试按新模型重写：从"sale_orders[type=退款单]"改为"sale_order_payments[change_type='退款']"+"sale_order_payment_details" 子表 + paymentId 入参。

---

## 1 背景上下文（Self-contained，给 1 周后 cloud agent）

### 1.1 关键 commits（参考实现）
通过 `git log --oneline -25` 查看。关键：
- `622fdee` staff routes 重构 + helpers/refund-cascade.js 抽出
- `5ea6057` refund-cascade 列名对齐 schema（point_transactions.type / ref_order_id）
- `a1099fc` admin sale-order domain refactor — dashboard/订单详情/测试对齐
- `04bc346` admin dashboard action 重构（时间维度指标分组）
- `b47b282` 订单列表实付/已退列 + payNotify 全锁守卫
- `05f532e` staff 测试对齐（之前轮 F1 修了 62 fail 但 22+3 整组 skipped 留待本 ticket 处理）

### 1.2 DB schema 关键变化
- `sale_orders` 删 `paid_amount` / `wechat_transaction_id` / `alipay_transaction_id`；加 `received` / `refunded_amount`
- `sale_order_payments` 主表瘦身（删 `operator_employee_id` / `note`）；详情下沉到 `sale_order_payment_details` 子表
- `paymentFlowStatusEnum` 加 `'待审批'`
- `serviceCommissions` 加 `voided_at` / `voided_reason`
- `product_skus` 加 `isExperience` / `isRechargeCard` capability 列
- `saleOrderTypeEnum` 5→3：`['销售单', '内部单', '转换单']`

### 1.3 API 关键变化
- `approveRefund` / `rejectRefund` / `createRefund` 入参从 `{saleOrderId}` 改为 `{paymentId}`
- 错误前缀 8 项：UNAUTHORIZED / PHONE_REQUIRED / INVALID_PARAMS / PERMISSION_DENIED / NOT_FOUND / INSUFFICIENT_BALANCE / CONFLICT / INVALID_STATE

### 1.4 helpers/refund-cascade.js
5 通道 cascade 调用模式，参考：
- staff: `fengyu-staff/cloudfunctions/staffApi/routes/order.js` 中 `cascadeRefund(client, params)` 调用点
- admin: `fengyu-admin/src/actions/refunds.ts` 中 `cascadeRefund(tx, params)` 调用点

返回类型：`{ voidedAllocations, voidedCommissions, refundedCoupons, reversedPoints, rolledBackPickups }`

---

## 2 ~25 个 skipped 测试位置

实测 1 周后数字可能变化，以 `npm test` 为准。当前已知：
- 22 个：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/order.test.js` — `describe.skip` 整组（createRefund / approveRefund / rejectRefund / approveRefund 按比例拆分场景）
- 1 个：`__tests__/routes/customer.test.js` — `refundHistory`
- 2 个：`__tests__/routes/mgmt-customer.test.js` — `refundHistory` + 1 个零散

---

## 3 任务详细步骤

### Step 1: 跑测试看基线
```bash
cd fengyu-staff/cloudfunctions/staffApi && npm test 2>&1 | tail -30
```
确认 fail / passed / skipped 数。理论应是 0 fail / 875+ passed / ≈34 skipped。

### Step 2: 逐个重写 skipped 测试

#### 2.1 createRefund 测试组
```js
// 入参 { refSaleOrderId, items[], refundReason, paymentMethod }
// 写入：
//   - sale_order_payments(change_type='退款', amount<0, status='待审批')
//   - sale_order_payment_details(refund_reason, ref_sale_item_id, session_count)
// 返回：{ paymentId, status: '待审批' }
// 核查 partial unique uq_sop_status_audit 防重复 in-flight
```

新增覆盖：
- ✅ 部分退款（指定 ref_sale_item_id）
- ✅ 全单退款
- ✅ 退疗程卡（session_count 写入 details）
- ✅ partial unique 冲突（同原单第 2 笔 in-flight 应抛 CONFLICT）

#### 2.2 approveRefund 测试组
```js
// 入参 { paymentId, auditRemark? }
// 流程（事务内）：
//   1. CAS UPDATE sale_order_payments SET status='已支付', paid_at=NOW()
//      WHERE id=$1 AND status='待审批'  → rowCount===1 校验
//   2. UPDATE sale_order_payment_details SET audit_employee_id, audit_at, audit_remark
//   3. UPDATE sale_orders SET refunded_amount += ABS(amount)
//   4. cascadeRefund(client, {saleOrderId, saleItemId, sessionCount, refundReason})  // 5 通道
//   5. logOperation('order.approveRefund', target_type='sale_order_payment', detail={cascade})
```

新增覆盖：
- ✅ CAS 幂等哨兵：重复调用应抛 `INVALID_STATE: REFUND_NOT_PENDING`
- ✅ 5 通道 cascade 各自验证（mock cascadeRefund 返回 voidedAllocations 等）
- ✅ refunded_amount 累加（多次部分退款）
- ✅ 储值卡 vs 原通道分支（参考当前 staff routes/order.js 实现）

#### 2.3 rejectRefund 测试组
```js
// 入参 { paymentId, auditRemark }（驳回理由必填）
// CAS UPDATE sop status='待审批' → '已作废'
// UPDATE details audit_employee_id, audit_at, audit_remark
```

新增覆盖：
- ✅ auditRemark 为空抛 INVALID_PARAMS
- ✅ CAS 幂等：重复调用抛 INVALID_STATE
- ✅ 不触发 cascadeRefund（仅状态翻转）

#### 2.4 refundHistory 测试组（customer.js + mgmt-customer.js）
```js
// 数据源从 sale_orders[type=退款单] 改为：
//   sale_order_payments[change_type='退款']
//   LEFT JOIN sale_order_payment_details
//   JOIN sale_orders（取 store_id 用于 scope 过滤）
//   WHERE store_id IN scopeStoreIds  -- CC3 P0-CC3-02 修复
```

新增覆盖：
- ✅ scope 过滤生效（不同 storeId 顾客不可见）
- ✅ 4 状态展示完整（待审批 / 已支付 / 已作废 / 已退款）
- ✅ details 子表字段返回（refund_reason / audit_at 等）

### Step 3: 跑测试确认
```bash
cd fengyu-staff/cloudfunctions/staffApi && npm test 2>&1 | tail -30
```
目标：**0 fail，skipped 数 < 5**（保留 1-2 个真正"未来要做"的占位）

### Step 4: 测试质量自查
- 反向锁死检查：测试不应 lock 旧"sale_orders[type=退款单]"概念，全部按新 sop 模型断言
- mock 数据 schema 对齐：所有 sale_orders mock 用 `received` 不用 `paid_amount`
- helper 抽出（可选）：如多个测试共用 mock 数据，可在文件顶部抽 `makeRefundFixture(...)`

---

## 4 严禁

- 修改 db/schema/* / db/migrations/*
- 修改 staff 业务代码（routes/* / helpers/* / index.js）
- 修改 fengyu-admin / fengyu-client
- `npm run db:migrate` / `tcb fn deploy`
- **直接 git commit / push / merge**（让用户人工评审）

---

## 5 完成回报（结构化）

### A. 取消 skip 的测试数
- order.test.js: ?/22
- customer.test.js: ?/1
- mgmt-customer.test.js: ?/2

### B. 新增覆盖测试数
- CAS 幂等哨兵：?
- 5 通道 cascade 各自验证：?
- 储值卡分支：?
- refunded_amount 累加：?
- scope 过滤：?

### C. 当前测试数字
- fail / passed / skipped

### D. 反向锁死断言修正情况
- 修正了哪些（应该没有，因为测试 skip 时锁死被注释了；现在是激活后重写）

### E. 待评审开放问题
- 是否有业务方需确认的 mock 字段值
- 是否有发现的潜在业务代码 bug（不修，仅记录）

### F. CI 守卫建议
- 防止测试中再次出现 `sale_orders[type=退款单]` 字面量（grep 守卫）
- 防止测试 mock 用 `paid_amount` / `wechat_transaction_id` 等已 DROP 字段

---

## 6 备注

- 本 ticket 由 schedule remote agent 在 2026-05-03 10:03 Asia/Shanghai 自动触发执行
- agent prompt 仅引用本文件路径，不重复内容
- 完成后由用户人工评审 + commit
