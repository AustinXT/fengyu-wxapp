# Ticket: admin /dashboard 门店今日业绩与 SQL 不一致（store manager 视角 0 vs 实际 ¥854）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | ✅ 已完成（2026-05-19）|
| 优先级 | **P1**（看板是高频运营页，数字不准 = 经营决策错）|
| 端 | fengyu-admin |
| 修复成本 | **S–M**（视根因，1 个查询缺过滤 / scope 注入路径 bug / 时区或日期窗口 bug）|
| 来源 | 2026-05-18 e2e-chains 跑批 link-17 失败 |
| 关联文件 | `src/actions/dashboard.ts`、`src/app/(main)/dashboard/**` |

---

## 0 一句话

FY-TEST-MGR 在自己门店开了一单已支付，DB SQL 累加店内当日营业额 = ¥854，但 `/dashboard` 该 manager 视角"今日业绩"卡显示 **¥0**。

---

## 1 实证

### 1.1 link-17 跑批输出

```
[链路17] Step 1: MGR 开一单贡献当日营业额
[链路17] saleOrderId: FY-XSD-WX-2605180004
[链路17/04-mgr] 今日业绩 = ¥0 → 0                          ← 看板显示
[链路17] SQL: store-nc01 当日 SUM(received-refunded)=854   ← DB 实际
[链路17] revenue: admin=-1 market=0 store=0
```

### 1.2 失败 verdict

```json
{
  "check": "store_role_matches_sql",
  "verdict": "FAIL",
  "actual": "mgrRev=0, dbStoreRevenue=854, diff=-854.00"
}
```

### 1.3 同时观察到的次要现象（可能同根因可能独立）

- admin 角色 dashboard **完全不渲染**"今日业绩"卡 → spec 把 admin 这条 verdict 标为 SKIP（说"roleContext='admin' 走另一套"）
- market manager（FY-TEST-MKT）当日业绩也 = ¥0（按理应聚合下属门店 store-nc01 的 ¥854 → 应 ≥ ¥854）

---

## 2 嫌疑

### 嫌疑 A：当日窗口的时区 / 边界 bug

dashboard 后端 SQL 可能用 `WHERE created_at::date = CURRENT_DATE` 但应用容器时区 ≠ Asia/Shanghai，导致 6:54 创建的订单被算作"昨天"。

**排查方法**：
```sql
SELECT now(), current_setting('TIMEZONE');
SELECT created_at, created_at AT TIME ZONE 'Asia/Shanghai' FROM sale_orders WHERE sale_order_id='<最近一单>';
```

### 嫌疑 B：dashboard scope 注入路径未把当前 manager 的 store_id 传到 SQL

`/dashboard/page.tsx` 可能 fetch 的是 `getDashboardSummary({ storeId: undefined })`，导致 SQL `WHERE store_id = NULL` 或 `WHERE TRUE`。

**排查方法**：
- grep `getDashboardSummary\|dashboardSummary` src/actions/dashboard.ts
- 检查 session 注入参数是否被 scope 拆解

### 嫌疑 C：dashboard 查询用了 status 白名单，未包含订单当前状态

订单 `FY-XSD-WX-2605180004` 状态可能是 `已支付`，但 SQL 只看 `IN ('已完成')` 之类。

**排查方法**：
- 看 src/actions/dashboard.ts WHERE clauses
- 对比 link-17 spec 期望（接受"已支付"为业绩入账状态）

### 嫌疑 D：admin 角色不渲染"今日业绩"卡是设计

如果 README §1.B link-17 注释里写的"admin 走另一套"是确认设计，那 admin 看不到该卡是 by-design，不算 bug；但 **store/market 看不到自己门店当日业绩仍然是 bug**。

---

## 3 决策点

### 问 1：先排查时区还是先排查 scope 注入？

**我的建议**：先看 `src/actions/dashboard.ts`（10 分钟内能定位），9 成会发现 scope 路径或 status 白名单问题。时区 bug 通常是 admin 全局问题，不会只影响 dashboard。

### 问 2：admin 角色 dashboard 是否应该有"今日业绩"卡？

A. 是的，admin = "上帝视角"，应该看到全平台业绩聚合
B. 不需要，admin 看的是平台元信息（角色管理、权限）；业绩交给 manager 自查
C. 现状（看不到）是 bug 但不优先修

---

## 4 我需要你判断的

**Q1**：选问 1 的排查路径（先看 dashboard.ts 代码）？
**Q2**：选问 2 的产品立场（A / B / C）？

---

## 5 关联引用

- `src/actions/dashboard.ts`
- `src/app/(main)/dashboard/page.tsx`
- `tests/e2e-chains/link-17-dashboard-three-role-aggregation.spec.ts`
- `notes/memory/project_dashboard_time_dimensions.md`（dashboard 时间维度规则）

---

## 完成记录

- 完成日期：2026-05-19
- 真正根因：**时区 cast 方向反了**。`paid_at` / `sale_order_datetime` 列是 `timestamp WITHOUT time zone`（Drizzle 写入 `new Date()` 以 UTC 字面值落库），但 dashboard SQL 写的是 `(paid_at AT TIME ZONE 'Asia/Shanghai')::date` — PG 把这个 naive 时间**当作 Shanghai 本地时间**重新解释，再回 UTC 偏 8 小时。结果落在 16:00 UTC 之后的订单（次日凌晨 Shanghai）会被错算成前一天。
- 5434 实测：FY-XSD-WX-2605180001 paid_at=2026-05-17 19:34（naive，实为 UTC）；buggy ::date='2026-05-17'，正确应是 '2026-05-18'。
- 落地：
  - `fengyu-admin/src/actions/dashboard.ts` L92/98/104/110/125/131 — 6 处 `(<col> AT TIME ZONE 'Asia/Shanghai')` 改为 `(<col> AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')`
  - L85/151 `NOW() AT TIME ZONE 'Asia/Shanghai'` 不动（NOW() 返回 timestamptz，cast 方向正确）
- Q2 决策：admin 角色 dashboard 不需要"今日业绩"卡 — 当前 backend 已走 `roleContext='admin' + ZERO_BUSINESS` 分支，无需 UI 改动。
- 后续：staff `routes/mgmt-customer.js` + `routes/customer.js` 有同 bug 模式（5 处），按"不抽共享目录"约束需要独立修 + 跨端 snapshot，另起 ticket。
- DoD：
  - [x] dashboard.ts 6 处改完
  - [x] `npx tsc --noEmit` 0 错
  - [ ] e2e link-17 PASS（依赖 B1 fixture 迁移到 5434，待 Agent D 完成）
