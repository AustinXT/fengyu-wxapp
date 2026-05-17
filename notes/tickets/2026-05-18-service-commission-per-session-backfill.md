# 服务提成 consume_amount per-session 口径回填 + 仪表盘 SQL 重算

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待实施 |
| 优先级 | **P1**（涉及金钱口径，影响员工提成对账与门店业绩看板） |
| 端 | db（数据回填） + staff/cloudfunctions/staffApi/routes/{mgmt-dashboard,staff}.js（dashboard SQL） |
| 修复成本 | **M**（1-2 天：回填 SQL + 联调验证 + dashboard SQL 重写 + 看板视觉回归） |
| 关联代码 PR | 本批次 frontend/admin/staff per-session 修复（本 ticket 是配套数据 + 看板修复） |
| 关联 schema | `db/schema/service-commission.ts`、`db/schema/service.ts`、`db/schema/order.ts` |

---

## 0 一句话背景

本次提交修复了「服务提成分配」页面 + admin Server Action + staff `service.complete` 的 per-session 计算 bug
（`service_items.unit_real_price` 是 per-card 价格快照，需还原 per-session = `unit_real_price × quantity / session_count`）。

但 **数据层 + 看板层** 还遗留同口径错误：

1. 历史 `service_commissions` 行用旧公式 `unit_real_price × session_used × rate` 写入 → `consume_amount` 偏大（卡多次商品的倍数 = session_count / quantity）
2. `mgmt-dashboard.js` 和 `staff.js` 中至少 7 处 dashboard 聚合 SQL 仍按 `SUM(sit.unit_real_price * sit.session_used)` 计算"消耗业绩"

本 ticket 把这两件事打成一张单子单独实施，避免本次代码 PR 的 blast radius 过大。

---

## 1 现状（grep 实证）

### 1.1 历史 service_commissions 数据偏差

```bash
# 5434/fengyu 抽样：含 session_count > quantity 的服务明细（即真正"多次卡"）
PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu -c "
  SELECT sc.id, sc.service_item_id, sc.consume_amount AS old_consume,
         si.unit_real_price, si.session_count, si.quantity, svi.session_used,
         ROUND((si.unit_real_price::numeric * si.quantity / si.session_count) * svi.session_used * sc.commission_rate, 2) AS correct_consume
  FROM service_commissions sc
  JOIN service_items svi ON svi.service_item_id = sc.service_item_id
  JOIN sale_items si ON si.sale_item_id = svi.sale_item_id
  WHERE sc.is_void = false
    AND si.session_count > si.quantity
  LIMIT 20;
"
```

差值 = `(session_count / quantity) - 1` 倍。例如 5次卡 × 2张（session_count=10, quantity=2）→ 旧值是正确值的 5 倍。

### 1.2 仪表盘 SQL 同口径错误

7+ 处用同一公式（grep 结果）：

```
fengyu-staff/cloudfunctions/staffApi/routes/staff.js:757
fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:261,275,768,1023,1320,1331,1334,1338
```

对应的两个测试文件 hardcode 了 SQL 文本断言：

```
fengyu-staff/cloudfunctions/staffApi/__tests__/routes/staff.test.js:604-618,772
fengyu-staff/cloudfunctions/staffApi/__tests__/routes/mgmt-dashboard.test.js:1234,1678
```

测试也要更新（断言新 SQL 文本 + 用真实卡 fixture 校验数值）。

---

## 2 修复方案

### 2.1 historic service_commissions 回填

按 `service_order_id` 分批 UPDATE：

```sql
BEGIN;

-- 备份当前快照（一次性）
CREATE TABLE IF NOT EXISTS service_commissions_pre_persession_backfill AS
SELECT * FROM service_commissions WHERE is_void = false;

-- 重算（仅 session_count > 0 AND quantity > 0 的卡多次行；非卡场景 session_count=quantity 自然不变，但走同公式无副作用）
UPDATE service_commissions sc
SET
  consume_amount = ROUND(
    (si.unit_real_price::numeric * si.quantity / NULLIF(si.session_count, 0)) * svi.session_used * sc.commission_rate,
    2
  ),
  commission_amount = ROUND(
    sc.fixed_fee + ROUND(
      (si.unit_real_price::numeric * si.quantity / NULLIF(si.session_count, 0)) * svi.session_used * sc.commission_rate,
      2
    ),
    2
  ),
  updated_at = NOW()
FROM service_items svi
JOIN sale_items si ON si.sale_item_id = svi.sale_item_id
WHERE sc.service_item_id = svi.service_item_id
  AND sc.is_void = false
  AND si.session_count IS NOT NULL
  AND si.session_count > 0;

-- 落审计日志
INSERT INTO operation_logs (operator_employee_id, operator_name, operator_role, action, target_type, target_id, detail, source, created_at)
SELECT 'SYSTEM', 'backfill', 'system', 'serviceCommission.backfill.perSessionFormula', 'service_commission', sc.id::text,
       jsonb_build_object(
         'pre_consume_amount', pre.consume_amount,
         'post_consume_amount', sc.consume_amount,
         'pre_commission_amount', pre.commission_amount,
         'post_commission_amount', sc.commission_amount
       ),
       'backfill', NOW()
FROM service_commissions sc
JOIN service_commissions_pre_persession_backfill pre ON pre.id = sc.id
WHERE pre.consume_amount IS DISTINCT FROM sc.consume_amount;

-- 校验：抽样 5 行人工核对
SELECT sc.id, pre.consume_amount AS old, sc.consume_amount AS new, sc.commission_amount,
       si.unit_real_price, si.quantity, si.session_count, svi.session_used
FROM service_commissions sc
JOIN service_commissions_pre_persession_backfill pre ON pre.id = sc.id
JOIN service_items svi ON svi.service_item_id = sc.service_item_id
JOIN sale_items si ON si.sale_item_id = svi.sale_item_id
WHERE pre.consume_amount IS DISTINCT FROM sc.consume_amount
ORDER BY sc.id DESC LIMIT 5;

-- 确认无误后
COMMIT;
-- 否则
-- ROLLBACK;
```

**实施前必须**：用户在 5434/fengyu 跑一次抽样 SELECT，核对回填值符合预期，再放 UPDATE。

### 2.2 dashboard SQL per-session 化

把所有 `SUM(sit.unit_real_price::numeric * sit.session_used)` 改为：

```sql
SUM(sit.unit_real_price::numeric * si.quantity / NULLIF(si.session_count, 0) * sit.session_used)
```

需要在 FROM 子句 JOIN sale_items（部分查询已 JOIN，部分尚未；逐处确认）。

涉及文件：
- `fengyu-staff/cloudfunctions/staffApi/routes/staff.js:757`（个人业绩聚合）
- `fengyu-staff/cloudfunctions/staffApi/routes/mgmt-dashboard.js:261, 275, 768, 1023, 1320, 1331-1338`
- 对应单测 SQL 文本断言

部署后用 5434 真实数据回归看板（"今日消耗"、"个人业绩"、店铺/员工排名 5 项）数值需复核。

### 2.3 文档同步

- `docs/audit/audit-17-dashboard.md` L123, 228, 230, 328, 330 公式
- `docs/audit/audit-08-service-commission.md` L59, 228 公式
- `docs/audit/audit-CC1-numeric-precision.md` L103 公式

---

## 3 验收

- [ ] 2.1 抽样 SELECT 出来核对，无误后 BEGIN/COMMIT 执行
- [ ] 2.1 `service_commissions_pre_persession_backfill` 备份表保留 30 天后再删
- [ ] 2.2 dashboard SQL 改完 → staffApi 全套单测绿（含 staff.test.js / mgmt-dashboard.test.js 断言更新）
- [ ] 2.2 部署后看板抽样：选一个真实店铺当天数据，人工对账 1 个员工 + 1 个店铺
- [ ] 2.3 audit md 文档公式同步

---

## 4 关联

- 本次代码 PR（提成分配 page + admin save + staff complete）
- `db/schema/service-commission.ts` 文件级注释已更新
- 用户 bug report 截图：服务单 FY-FW-2604230001 显示 ¥3,500 应为 ¥700/次
