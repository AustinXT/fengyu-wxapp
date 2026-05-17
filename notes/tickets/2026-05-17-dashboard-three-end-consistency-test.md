# Ticket: dashboard 三端业绩口径一致性测试

> 生成日期：2026-05-17
> 实施状态：✅ **已实施**（12 用例落地于 fengyu-admin/src/actions/dashboard.consistency.test.ts + 双端 head 注释强化）
> 实施日期：2026-05-17
> PR：E7 + E6 收尾 PR（与 #11/#13/#14 合并）
> 严重级别：P0（衍生自 P1-CC1；防回归）
> 端：fengyu-admin / fengyu-staff (mgmtDashboard) / cron-worker（间接）
> 来源：[SUMMARY v3 §2 #15](../../docs/audit/SUMMARY.md)
> 关联 audit：[audit-17-dashboard.md](../../docs/audit/audit-17-dashboard.md) / [audit-18-employee-performance.md](../../docs/audit/audit-18-employee-performance.md) / [audit-CC1-numeric-precision.md](../../docs/audit/audit-CC1-numeric-precision.md)

---

## 0 一句话背景

audit-17-dashboard.md P0-17-01/02/03 已经在 2026-04-27 通过把营业额公式从
`SUM(total_amount) WHERE sale_order_type != '退款单'` 切到
`SUM(received - refunded_amount) WHERE sale_order_type IN ('销售单','转换单') AND status='已支付'`
+ migration 0019 sale_order_type 5→3 收官 落地（admin + staff mgmtDashboard 双端均已切，详见 §1 grep 实证）。

但 **两端公式相同纯属"人工同步"的产物**，没有自动化守护：

- admin/src/actions/dashboard.ts ↔ staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js
- 任一端单独重构（如改 enum 集合 / 改聚合维度 / 加新过滤条件），数据中心首页与管理后台 dashboard 数字
  **当天就会对不上**，老板第二天发现差异，对账压力极大。

本 ticket 补一个 `dashboard.consistency.test.ts` 守护两端公式字面量同义。

---

## 1 两端公式核查（2026-05-17 grep 实证）

### 1.1 admin dashboard（actions/dashboard.ts）

```sql
-- L92-98
SUM(CASE WHEN paid_at >= ... AND paid_at < ...
         AND sale_order_type IN ('销售单', '转换单')
         AND status = '已支付'
    THEN (received::numeric - refunded_amount::numeric)
    ELSE 0 END) AS today_revenue
```

### 1.2 staff mgmtDashboard（routes/mgmt-dashboard.js queryStoreRevenue L226）

```sql
SELECT COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS v
  FROM sale_orders so
 WHERE ${sc.sql}
   AND so.sale_order_type IN ('销售单', '转换单')
   AND so.status = '已支付'
   AND ${timeWindow('so.paid_at', mode, 1, false)}
```

✅ **两端公式同义**（仅写法差异：CASE WHEN vs WHERE；refunded_amount NULL 处理 COALESCE 在 staff 端更稳健）。

### 1.3 关键不变量

```
revenue = SUM(received) - SUM(refunded_amount)
       WHERE sale_order_type IN ('销售单', '转换单')
         AND status = '已支付'
         AND paid_at ∈ [start, end)
         AND store_id ∈ scope
```

---

## 2 风险场景（如不补守护）

| 场景 | 后果 |
|------|------|
| admin 重构改成 `sale_order_type = '销售单'`（漏 转换单） | 转换单业绩在 admin 看不到，staff mgmtDashboard 仍统计 |
| staff 改成 `received - refunded_amount + adjustment`（新加调整列） | staff 数据中心数字虚高，admin 看不到 |
| 任一端把 `status='已支付'` 改成 `IN ('已支付','部分支付')` | 数据偏差不可察觉，月度对账失败 |
| 任一端加新 enum 值（如未来 '会员单'） | 公式漏统计或重复统计 |

---

## 3 修复方案

### 3.1 新建 `fengyu-admin/src/actions/dashboard.consistency.test.ts`

> **实际落地路径修正**：原计划 `src/lib/__tests__/dashboard.consistency.test.ts`，
> 实际落地为 `src/actions/dashboard.consistency.test.ts`（与被测的 `dashboard.ts` colocated，
> 符合 admin 项目惯例 `**/*.test.{ts,tsx}` + 已有 `src/actions/dashboard.test.ts` 兄弟文件）。

放在 admin 端是因为 admin 用 vitest（更易跑），同时 admin 端可以直接 import dashboard.ts；staff
mgmt-dashboard.js 通过文件读源码 + 字面量比对（与 `cross-end-sql-snapshot.test.js` 同模式）。

```ts
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ADMIN_DASHBOARD = path.resolve(__dirname, '../../actions/dashboard.ts')
const STAFF_MGMT_DASHBOARD = path.resolve(
  __dirname,
  '../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js'
)

function normalize(sql: string) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/['"`]/g, '')
    .trim()
}

describe('audit-17 dashboard 两端公式一致性守护', () => {
  let adminSrc: string
  let staffSrc: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_DASHBOARD, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_DASHBOARD, 'utf-8')
  })

  describe('营业额公式 = SUM(received - refunded_amount)', () => {
    it('admin 必须用 received - refunded_amount', () => {
      expect(normalize(adminSrc)).toMatch(/received::numeric\s*-\s*refunded_amount::numeric/)
      expect(normalize(adminSrc)).not.toMatch(/SUM\(paid_amount\)/)
      expect(normalize(adminSrc)).not.toMatch(/SUM\(total_amount\)/)
    })

    it('staff mgmtDashboard 必须用 received - refunded_amount', () => {
      expect(normalize(staffSrc)).toMatch(/received::numeric\s*-\s*COALESCE\(so\.refunded_amount,\s*0\)::numeric/)
      expect(normalize(staffSrc)).not.toMatch(/SUM\(paid_amount\)/)
      expect(normalize(staffSrc)).not.toMatch(/SUM\(total_amount\)/)
    })
  })

  describe('sale_order_type 过滤 — 必须 IN (销售单, 转换单)', () => {
    it('admin 必须含 IN (销售单, 转换单)', () => {
      expect(adminSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('staff mgmtDashboard 必须含 IN (销售单, 转换单)', () => {
      expect(staffSrc).toMatch(/sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)/)
    })

    it('两端枚举集合完全相同（防一端漏改）', () => {
      const adminEnums = (adminSrc.match(/sale_order_type\s+IN\s*\([^)]+\)/g) || []).map(s => s.replace(/\s/g, ''))
      const staffEnums = (staffSrc.match(/sale_order_type\s+IN\s*\([^)]+\)/g) || []).map(s => s.replace(/\s/g, ''))
      expect(adminEnums.length).toBeGreaterThan(0)
      expect(staffEnums.length).toBeGreaterThan(0)
      // 两端出现的所有 IN 集合归一化后必须同义
      expect(new Set(adminEnums.concat(staffEnums)).size).toBe(1)
    })
  })

  describe('status 过滤 — 必须 = 已支付', () => {
    it('admin 营业额查询必须 AND status = 已支付', () => {
      expect(adminSrc).toMatch(/status\s*=\s*'已支付'/)
    })

    it('staff queryStoreRevenue 必须 AND so.status = 已支付', () => {
      expect(staffSrc).toMatch(/so\.status\s*=\s*'已支付'/)
    })
  })
})
```

### 3.2 关键决策

- **不抽公共 helper**（用户 veto 共享目录），与 settlePoints/applyRecharge 同模式
- **字面量 grep 守护**为主，因为两端用不同 ORM（admin Drizzle / staff pg），完整 SQL snapshot 难以归一化
- 测试放 admin/vitest 跑（CI 已有），不需要新建 staff 测试基础设施

---

## 4 改造计划

### Phase 1 — 落测试（半天）— ✅ 全部落地

- [x] 新建 `fengyu-admin/src/actions/dashboard.consistency.test.ts`（不是 `src/lib/__tests__/`）
- [x] 验证 **12** 个用例全过（多于原计划 8；含 `stripComments` helper 处理 docstring 反例引用 + 维护者提醒守护 + 关键注释字面量"2026-04-26 sale-order-domain-refactor"溯源）
- [x] 故意改 admin/dashboard.ts 把 IN ('销售单') 漏 转换单 → 测试失败
- [x] 故意改 staff/mgmt-dashboard.js 把 status='已支付' 删掉 → 测试失败

### Phase 2 — 文档（30 min）— ✅ 全部落地

- [x] admin/actions/dashboard.ts 头部注释强化"**公式 / sale_order_type / status 过滤变更必须同步 staff mgmtDashboard 与 dashboard.consistency.test.ts**"
- [x] staff/routes/mgmt-dashboard.js 头部加反向提示
- [x] SUMMARY.md §2 #15 v3 已标 ✅

### Phase 3（可选）— 数据级一致性测试 — ⏳ 未做（可选）

- [ ] 写一个 e2e 测试：插固定 fixture 订单 → admin getDashboardStats vs staff mgmtDashboard.summary
      → 两端数字必须相等（容差 0.01 元）

---

## 5 实施记录（2026-05-17）

- 落地位置：`fengyu-admin/src/actions/dashboard.consistency.test.ts`（12 用例）
- 守护粒度：
  - 营业额公式（admin Drizzle + staff pg 各自验证 `received - refunded_amount` + 反向禁 `SUM(paid_amount)/SUM(total_amount)`）：5 用例
  - sale_order_type 过滤集合（双端 IN 与归一化同义）：3 用例
  - status 过滤含 '已支付'：2 用例
  - 关键注释字面量"2026-04-26 sale-order-domain-refactor"溯源：2 用例
- 工具函数：`stripComments` 剥离 JS/TS 注释，避免 docstring 反例引用（如 SUM(total_amount)）触发反向守护误报

## 6 验证 Checklist

- [x] `bun run test dashboard.consistency` 通过 12 用例
- [x] 故意改 admin/dashboard.ts SQL → 对应用例失败
- [x] 故意改 staff/mgmt-dashboard.js SQL → 对应用例失败
- [x] CI 中 admin 测试自然带跑（admin 951 全过）

---

## 7 关联

- [SUMMARY v3 §2 #15](../../docs/audit/SUMMARY.md)
- [SUMMARY v3 §5.4 E6 时区统一 + 跨端口径收敛](../../docs/audit/SUMMARY.md#54-跨域-epic-优先级v3--重排)
- audit-17-dashboard.md P0-17-01/02/03（已修复，本 ticket 补防回归）
- audit-18-employee-performance.md P0-18-01（同源问题）
- ticket `2026-04-26-sale-order-domain-refactor.md` §11（已完成的域重构）
- 同 epic 还有 #11 face_value_override / #13 scope helper / #14 refund-cascade snapshot（合并 PR）

## 8 排期建议

S（半天）— ✅ 已落地，与 #11/#13/#14 合并为 E7 + E6 收尾 PR。
