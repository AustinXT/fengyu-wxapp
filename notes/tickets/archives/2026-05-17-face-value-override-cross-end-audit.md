# Ticket: 优惠券 face_value_override 三端读取一致性核查

> 生成日期：2026-05-17
> 实施状态：✅ **已实施**（snapshot 守护 9 用例落地 + 顺手清掉 staff/order.js 冗余 SELECT）
> 实施日期：2026-05-17
> PR：E7 + E6 收尾 PR（与 #13/#14/#15 合并）
> 严重级别：P0（残留项，源自 P0-13-02）
> 端：fengyu-admin / fengyu-staff / fengyu-client
> 来源：[SUMMARY v3 §2 #11](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-13-coupons.md](../../docs/audit/audit-13-coupons.md)

---

## 0 一句话背景

`user_coupons.face_value_override` 是"分享礼 / 动态面值"场景下覆盖 `coupon_templates.discount_value` 的快照列。
audit-13-coupons.md 在 v2 阶段标记 P0-13-02 "三端读取漂移" — 即 admin / staff / client 三端
在使用优惠券计算抵扣时，是否一致按 `COALESCE(uc.face_value_override, ct.discount_value)` 读取。
如有一端漏读，则同一张券在不同端结算出不同面值，**直接资损**。

本 ticket 把"三端是否一致使用 COALESCE 模式"的核查结果固化为审计记录，并提议补 snapshot 守护防回归。

---

## 1 三端读取核查结果（2026-05-17 grep 实证）

| 端 | 文件 | 行号 | SQL 片段 | 是否 COALESCE |
|----|------|------|---------|----------------|
| admin | `fengyu-admin/src/actions/orders.ts` | 931 | `discountValue: sql<number>` `COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})` | ✅ |
| staff | `fengyu-staff/cloudfunctions/staffApi/routes/coupon.js` | 62 | `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value` | ✅ |
| staff | `fengyu-staff/cloudfunctions/staffApi/routes/order.js` | 330 | `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value` | ✅ |
| client | `fengyu-client/cloudfunctions/clientApi/routes/order.js` | 283 | `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value` | ✅ |
| client | `fengyu-client/cloudfunctions/clientApi/routes/coupon.js` | 39, 147 | `COALESCE(uc.face_value_override, ct.discount_value) AS discount_value` | ✅ |

**结论**：5 处读取全部使用同一 COALESCE 模式，**三端一致，无漂移**。

> 注释一致性：staff/coupon.js:57、client/order.js:279、client/coupon.js:142 三处均带 "face_value_override 优先于 template.discount_value，分享礼等动态面值场景" 注释。可作为后续 grep 守护的字面量。

---

## 2 残留风险

虽然当前代码一致，但 **没有自动化守护**，未来任意端单独新增/重构优惠券读取路径时，可能引入漂移：

- staff 新加一个 `routes/order.js` 内联子查询，写成 `ct.discount_value` 漏 COALESCE
- admin 重构 `actions/orders.ts` 改 Drizzle 查询时漏 alias
- client 加新的折扣场景（如 satisfy-and-discount）时漏 COALESCE

这与 settlePoints / applyRecharge 跨端字面量守护是同一类风险（用户已 veto `cloudfunctions-shared/` 抽取方案，
统一改用 `cross-end-sql-snapshot.test.js` 字面量比对）。

---

## 3 修复方案

### 3.1 扩展 cross-end-sql-snapshot.test.js（推荐，与 #14 同 epic）

把 face_value_override 的 SQL 片段加入跨端守护：

```js
// fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js
const FILES = {
  // ... 已有
  adminOrdersTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/orders.ts'),
  staffCouponJs: path.resolve(__dirname, '../../routes/coupon.js'),
  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),
  clientCouponJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/coupon.js'),
  clientOrderJs: path.resolve(__dirname, '../../../../../fengyu-client/cloudfunctions/clientApi/routes/order.js'),
}

// 新增测试组
describe('优惠券 face_value_override 跨端读取一致性', () => {
  const COALESCE_PATTERN = /COALESCE\([^)]*face_value_override[^)]*,[^)]*discount_value[^)]*\)/g

  it('admin orders.ts 必须使用 COALESCE(faceValueOverride, discountValue)', () => {
    const content = fs.readFileSync(FILES.adminOrdersTs, 'utf-8')
    expect(content).toMatch(/COALESCE\(\$\{userCoupons\.faceValueOverride\},\s*\$\{couponTemplates\.discountValue\}\)/)
  })

  it.each([
    ['staffCouponJs', FILES.staffCouponJs],
    ['staffOrderJs', FILES.staffOrderJs],
    ['clientCouponJs', FILES.clientCouponJs],
    ['clientOrderJs', FILES.clientOrderJs],
  ])('%s 必须含 COALESCE(uc.face_value_override, ct.discount_value)', (_, file) => {
    const content = fs.readFileSync(file, 'utf-8')
    const matches = content.match(COALESCE_PATTERN) || []
    expect(matches.length).toBeGreaterThan(0)
  })

  it('云函数三端 COALESCE 字面量完全一致（snapshot）', () => {
    const literals = [
      FILES.staffCouponJs, FILES.staffOrderJs,
      FILES.clientCouponJs, FILES.clientOrderJs,
    ].map(file => {
      const content = fs.readFileSync(file, 'utf-8')
      return content.match(/COALESCE\(uc\.face_value_override,\s*ct\.discount_value\)\s*AS\s*discount_value/g) || []
    })
    // 4 端必须都至少出现一次且字面量同义
    literals.forEach(arr => expect(arr.length).toBeGreaterThan(0))
    expect(new Set(literals.flat()).size).toBeLessThanOrEqual(1)
  })
})
```

### 3.2 不需要改动业务代码

三端业务代码本身已一致，**仅补测试守护**。

---

## 4 实施记录（2026-05-17）

- 落地位置：`fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-sql-snapshot.test.js` 第 `'SUMMARY v3 §2 #11：优惠券 face_value_override 跨端 COALESCE 一致性'` describe 块
- 用例数：**9**（原计划 3）
  - admin Drizzle 模式 COALESCE 校验：1
  - 4 端 pg COALESCE 校验（test.each 展开 staffCoupon/staffOrder/clientCoupon/clientOrder）：4
  - 4 端字面量同义 snapshot：1
  - 反向守护"不允许裸读 ct.discount_value 不走 COALESCE"：1（含 staff/order.js:327 真实命中 → 修复后变 0 命中）
- 副作用 — 顺手修真实代码气味：
  - `fengyu-staff/cloudfunctions/staffApi/routes/order.js:327` 在 SELECT 中同时列 `ct.discount_value` 与 `COALESCE(...) AS discount_value`（pg 取最后同名列 → 功能正确但冗余，且让"反向守护"误报）
  - 已删除 L327 重复的 `ct.discount_value`，与 `client/order.js:281-283` 的简洁模式对齐

## 5 验证 Checklist

- [x] `bun run test cross-end-sql-snapshot` 通过新增 9 个用例
- [x] 故意修改 `staffApi/routes/order.js:330` 把 `COALESCE(...)` 改成 `ct.discount_value` 后测试失败（反向守护即捕获）
- [x] 故意删掉 `client/coupon.js:147` 一次 COALESCE 后测试失败（每端至少 1 处守护）

---

## 6 关联

- [SUMMARY v3 §2 #11](../../docs/audit/SUMMARY.md)
- audit-13-coupons.md（P0-13-02 残留）
- E7 跨端副本 helper 抽取（用户 veto 共享目录后改 snapshot 守护方案）
- 同 epic 还有 #14 refund-cascade snapshot 守护（见 `2026-05-17-refund-cascade-snapshot-guard.md`）

## 7 排期建议

S（半天）— ✅ 已落地，与 #13/#14/#15 合并为 E7 + E6 收尾 PR。
