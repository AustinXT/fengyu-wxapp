# Ticket: refund-cascade 跨端字面量漂移守护

> 生成日期：2026-05-17
> 实施状态：✅ **已实施**（5 通道覆盖 + 触发点防回归共 16 用例 + 双端 head 注释强化）
> 实施日期：2026-05-17
> PR：E7 + E6 收尾 PR（与 #11/#13/#15 合并）
> 严重级别：P0（衍生自 audit-CC2-07；纵深防御缺失）
> 端：fengyu-admin / fengyu-staff（payNotify 不涉及退款）
> 来源：[SUMMARY v3 §2 #14](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-11-refunds.md](../../docs/audit/audit-11-refunds.md) / [audit-CC2-concurrency-idempotency.md](../../docs/audit/audit-CC2-concurrency-idempotency.md) / [audit-CC9-test-migration-residue.md](../../docs/audit/audit-CC9-test-migration-residue.md)

---

## 0 一句话背景

2026-04-26/27 退款审批 5 通道 cascade（sa / sc / coupons / points / pickup）已在 admin TS + staff JS
双端落地（详见 ticket `2026-04-26-sale-order-domain-refactor.md`），SUMMARY v3 Top 10 #3 标记为 ✅ 关闭。
但 **两端 cascade 是独立副本**（用户 veto `cloudfunctions-shared/` 抽取后的方案），缺乏自动化守护：

- `fengyu-admin/src/lib/refund-cascade.ts`（TS，被 actions/refunds.ts 调用）
- `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js`（JS，被 routes/order.js 调用）

任一端修改了 cascade 逻辑（例如新加一个通道 / 改一个 UPDATE 字段）而忘了同步另一端，**就是退款资损回归**。
本 ticket 要求扩展 `cross-end-sql-snapshot.test.js` 把 cascade 5 通道 SQL 全部纳入守护。

---

## 1 现状

### 1.1 已守护对象（cross-end-sql-snapshot.test.js 现有）

| 守护对象 | 端数 | 覆盖范围 |
|---------|------|---------|
| `settlePointsForOrder` SQL | 4 端 | staff/utils/points.js + client/utils/points.js + payNotify/points.js + admin/lib/points-settle.ts |
| `applyRechargeOnOrderPaid` SQL | 3 端 | staff/order.js (confirmOffline 内) + payNotify/index.js + admin/actions/orders.ts |
| admin P0-15-01 settlePointsSafe 触发点防回归 | 1 端 | admin/actions/orders.ts confirmOffline + recordPayment 两处调用 |

### 1.2 未守护 — 本 ticket 需补的

| 守护对象 | 端数 | 文件 |
|---------|------|------|
| `cascadeRefund` 5 通道 SQL | 2 端 | `fengyu-admin/src/lib/refund-cascade.ts` + `fengyu-staff/cloudfunctions/staffApi/helpers/refund-cascade.js` |
| `cascadeRefund` 触发点防回归 | 2 端 | admin/actions/refunds.ts approveRefund → cascadeRefund 必被调；staff/routes/order.js approveRefund 同 |

---

## 2 风险场景（如不补守护）

| 场景 | 后果 |
|------|------|
| admin 加一个新通道（如 service_commissions 部分撤销）但 staff 忘加 | staff 端审批通过的退款部分撤销不生效，业绩长尾累积 |
| staff 改了 sa cascade WHERE 子句（如加 `AND voided_at IS NULL`）但 admin 漏改 | 同一笔退款 admin 端能撤销已撤销的 sa 行，破坏幂等 |
| 任一端误删一个 UPDATE | 退款资损通道立即重新打开 |
| 任一端的事务边界改变（如把通道从主事务移出） | 部分通道未原子回滚，状态机不一致 |

---

## 3 修复方案

### 3.1 扩展 cross-end-sql-snapshot.test.js

```js
// fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js

const FILES = {
  // ... 已有 ...
  staffRefundCascadeJs: path.resolve(__dirname, '../../helpers/refund-cascade.js'),
  adminRefundCascadeTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/lib/refund-cascade.ts'),

  // 触发点防回归
  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),  // 已存在
  adminRefundsTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/refunds.ts'),
}

const MARKER_VOID_SA = "sale_allocations SET is_void"
const MARKER_VOID_SC = "service_commissions SET"
const MARKER_REVERT_COUPON = "user_coupons SET status"
const MARKER_REVERT_POINTS = "INSERT INTO point_transactions"
const MARKER_REVERT_PICKUP = "pickup_records"

describe('audit-CC2-07 协同：双端 cascadeRefund 5 通道 SQL 一致性守护', () => {
  let staffSrc, adminSrc

  beforeAll(() => {
    staffSrc = readFile(FILES.staffRefundCascadeJs)
    adminSrc = readFile(FILES.adminRefundCascadeTs)
  })

  test.each([
    ['通道 1 sale_allocations 软删', MARKER_VOID_SA],
    ['通道 2 service_commissions 软删 / 反向', MARKER_VOID_SC],
    ['通道 3 user_coupons 状态翻转', MARKER_REVERT_COUPON],
    ['通道 4 point_transactions 反向流水', MARKER_REVERT_POINTS],
    ['通道 5 pickup_records 反向（或 picked_up_quantity）', MARKER_REVERT_PICKUP],
  ])('%s — 两端字面量同义', (_, marker) => {
    const staffSql = normalizeSql(extractBacktickStringContaining(staffSrc, marker))
    const adminSql = normalizeSql(extractBacktickStringContaining(adminSrc, marker))
    expect(staffSql).toBe(adminSql)
  })
})

describe('audit-CC2-07 协同：触发点防回归', () => {
  test('admin actions/refunds.ts approveRefund 必须调用 cascadeRefund', () => {
    const src = readFile(FILES.adminRefundsTs)
    expect(src).toMatch(/await\s+cascadeRefund\s*\(/)
  })

  test('staff routes/order.js approveRefund 必须调用 cascadeRefund', () => {
    const src = readFile(FILES.staffOrderJs)
    expect(src).toMatch(/await\s+cascadeRefund\s*\(/)
  })
})
```

### 3.2 关键决策

- **不抽共享代码**（用户 veto `cloudfunctions-shared/`）
- **靠 snapshot test 守护**（settlePoints / applyRecharge 已是这个模式）
- **测试失败时错误信息**应提示"refund-cascade 两端漂移，请同步修改 staff/admin 副本"

---

## 4 改造计划

### Phase 1 — 标记字面量（30 min）— ✅ 落地（方案改）

- [x] 原方案"5 通道 SQL marker 注释" → 实际改为**通道 keyword 守护**（更鲁棒）
  - 原因：staff 端 point_transactions 用 JS 循环 INSERT；admin 端用 `INSERT...SELECT`；ORM + 写法差异导致字面量无法 1:1 同义
  - 现行守护：每通道验证关键 SQL keyword（UPDATE sale_allocations / SET is_void / voided_at 等）+ 双端必须均出现 + 反向流水幂等 (`NOT EXISTS '消费冲销'`) + 函数导出 / 返回字段同义

### Phase 2 — 测试落地（半天）— ✅ 全部落地

- [x] cross-end-sql-snapshot.test.js 加 `'SUMMARY v3 §2 #14：refund-cascade 双端 5 通道覆盖守护'` describe（5 通道）
- [x] 额外加 `'SUMMARY v3 §2 #14：cascadeRefund 触发点防回归'` describe（admin import + staff require + 双端 await）
- [x] 共 **16 用例**（原计划 7）

### Phase 3 — 文档（30 min）— ✅ 已落地

- [x] `admin/lib/refund-cascade.ts` 头部注释强化为"**修改本文件必须同步 fengyu-staff/.../refund-cascade.js**"
- [x] `staff/helpers/refund-cascade.js` 头部注释强化为反向提示
- [x] SUMMARY.md §2 #14 v3 已标 ✅

---

## 5 实施记录（2026-05-17）

- 落地位置：cross-end-sql-snapshot.test.js:334（5 通道 describe）+ :444（触发点 describe）
- 守护粒度：5 channels × 2 ends + 函数导出 + 返回字段同义 + 触发点（admin import + staff require + 双端 await cascadeRefund）

## 6 验证 Checklist

- [x] `bun run test cross-end-sql-snapshot` 通过新增 16 个用例
- [x] 故意删 admin/refund-cascade.ts 一个 UPDATE → 对应通道用例失败（keyword 守护即捕获）
- [x] 故意把 staff/refund-cascade.js 通道 1 的字段名 typo → 测试失败

---

## 7 关联

- [SUMMARY v3 §2 #14](../../docs/audit/SUMMARY.md)
- [SUMMARY v3 §5.4 E7](../../docs/audit/SUMMARY.md#54-跨域-epic-优先级v3--重排) — 跨端副本 helper 抽取（snapshot 守护方案）
- audit-11-refunds.md P0-11-01/04（已修复，本 ticket 补防回归）
- audit-CC2-concurrency-idempotency.md P0-CC2-07（已修复，本 ticket 补防回归）
- 同 epic 还有 #11 face_value_override / #13 scope helper / #15 dashboard 一致性（合并 PR 落地）

## 8 排期建议

S（1 天）— ✅ 已落地，与 #11/#13/#15 合并为 E7 + E6 收尾 PR。
