# Migration 2026-04-26 — Sale Order Domain Refactor

> 来源 ticket：[notes/tickets/2026-04-26-sale-order-domain-refactor.md](../../../notes/tickets/2026-04-26-sale-order-domain-refactor.md)
> 主迁移 SQL：[`db/migrations/0018_black_madrox.sql`](../../migrations/0018_black_madrox.sql)（drizzle 自动生成）
> 数据迁移脚本：本目录 01–05
> 严重级别：**P0**（资金链路重构 + 退款资损根治）

## 1 一句话目标

把 `sale_orders` 表里的 `回款单 / 退款单` 类型行下沉为 `sale_order_payments` 流水（+ `sale_order_payment_details` 子表），随后对历史已审批通过的退款做 **5 通道全量回滚**（sale_allocations / service_commissions / user_coupons / point_transactions / pickup_records）。

## 2 执行顺序（强制按序）

```
Phase 0 — 预检
  P0-1 冷备份（pg_dump 全库 + 关键表）
  P0-2 dry-run（脱敏副本库验证整套 SQL）
  P0-3 业务方公告（员工业绩可能负数）
  P0-4 应用层冻结写入（admin / staff / client 拒绝 createRefund / createOrder）

Phase 1 — schema 迁移（drizzle-kit 自动）
  M1-M7 (=> db/migrations/0018_black_madrox.sql)
    M1: payment_flow_status ADD VALUE '待审批'
    M2: CREATE TABLE sale_order_payment_details
    M3: sale_order_payments DROP COLUMN operator_employee_id, note
    M4: service_commissions ADD COLUMN voided_at, voided_reason
    M5: sale_orders DROP COLUMN paid_amount / wechat_transaction_id / alipay_transaction_id
        sale_orders ADD COLUMN received, refunded_amount
    M6: sale_order_type 5→3（先 → text，DROP TYPE，CREATE TYPE 新值，→ enum）
    M7: uq_sop_status_audit partial unique（防 in-flight 退款审批并发）

Phase 2 — 数据迁移（本目录手写 SQL）
  Step A => 01_step_a_repayment_migration.sql
  Step B => 02_step_b_refund_migration.sql
  Step C => 03_step_c_recompute_summary.sql
  Step D => 04_step_d_5channel_rollback.sql

Phase 3 — 校验
  Step E => 05_step_e_validation.sql （所有 SELECT 均应输出 0 / OK）

Phase 4 — 解冻 + 部署应用层（属于阶段 2 应用层任务，本目录不涉及）
```

> **重要**：Phase 1 的 enum ADD VALUE（M1）必须在与 Phase 2 不同的事务/会话执行（PG 不允许 ADD VALUE 同事务引用）。drizzle 默认 `breakpoints: true` 已保证。

## 3 业务方公告模板（P0-3）

> 主题：【系统升级】2026-04-2X 凌晨进行历史退款资损修复
>
> 各位同事好：
>
> 为修复**退款审批后业绩 / 提成 / 顾客权益（券、积分、提货）未冲销**的历史问题，我们将于 **2026-04-2X 周X 凌晨 02:00–06:00** 执行一次性数据迁移。
>
> **业务影响**：
> - 凌晨 02:00 起 admin / staff / client 进入只读 30 分钟（拒绝新建订单/退款）
> - 完成后**所有员工的历史业绩 / 提成将重算**，部分员工本期业绩可能为负（因历史已退款单当时未冲销）
> - 顾客已退款订单的"使用过的券"将自动恢复为"未使用"（仅未过期）
> - 顾客已退款订单的赠送积分将冲销
> - 顾客已退款订单的家居产品已提货数量将恢复
>
> **资金面无变化**：已退款的资金已经退给了顾客；本次仅修复账面数据。
>
> 如有业绩争议请于 2026-04-2X 12:00 前反馈财务（XXX）+ 店长审批。

## 4 灰度窗口建议

- 时段：**周末凌晨 02:00–06:00**（业务最低谷）
- 备份恢复演练：执行前 7 天必须完成一次 dry-run restore 到测试库
- 只读窗口：迁移期间应用层切只读 30 分钟（Step A→B→C→D 全程）
- 校验窗口：Step E 跑通 + 业务方抽样 30 分钟

## 5 冷备份命令

```bash
# 全库备份（custom format）
pg_dump -h 47.113.202.7 -p 5434 -U fengyu -Fc \
  -f ~/backups/fengyu-$(date +%Y%m%d-%H%M%S)-pre-domain-refactor.dump fengyu

# 关键表只读快照（额外保险）
pg_dump -h 47.113.202.7 -p 5434 -U fengyu \
  -t sale_orders -t sale_items -t sale_allocations \
  -t sale_order_payments \
  -t service_commissions -t user_coupons -t point_transactions \
  -t pickup_records -t prepaid_cards -t card_transactions \
  -Fc -f ~/backups/fengyu-tables-$(date +%Y%m%d-%H%M%S).dump fengyu
```

恢复演练（到测试库）：

```bash
createdb fengyu_restore_test
pg_restore -h ... -U fengyu -d fengyu_restore_test --clean --if-exists ~/backups/fengyu-XXX.dump
psql -h ... -U fengyu -d fengyu_restore_test -c "SELECT count(*) FROM sale_orders;"
```

## 6 回滚预案

| 阶段 | 是否可回滚 | 方案 |
|------|-----------|------|
| Phase 0 预检 | ✅ 完全可回滚 | 不动数据，直接终止 |
| Phase 1 schema 迁移完成 + Phase 2 未开始 | ✅ 可回滚 | 恢复 pg_dump 备份；schema 改动可丢弃 |
| Phase 2 进行中（事务未 COMMIT）| ✅ 可回滚 | `ROLLBACK;` |
| Phase 2 已 COMMIT + Phase 4 未解冻 | ⚠️ 有限可回滚 | 恢复 pg_dump 备份（数据回到迁移前） |
| Phase 4 解冻后 | ❌ 不可回滚 | 必须 fix-forward；准备 hotfix 修复 |

> **关键判断**：Phase 4 解冻完成后即不可回滚（新订单已基于新 schema），所以 Phase 1+2+3 的 dry-run + 校验必须 100% 通过。

## 7 校验通过标准（Step E 必读）

`05_step_e_validation.sql` 中每条 SELECT 都有预期输出。**全部预期为 0 才算通过**。具体见 §6.1 §6.2 ticket：

| ID | 校验项 | 预期 |
|----|-------|------|
| E1 | sale_orders 不应再有 '回款单' / '退款单' | count = 0 |
| E2 | 已支付退款流水数 = 迁移前已审批退款单数 | 差值 = 0（外部对账，需迁移前快照）|
| E3 | received = SUM(payments[首次支付/回款/储值卡抵扣].amount) | 偏差行数 = 0 |
| E4 | refunded_amount = -SUM(payments[退款].amount) | 偏差行数 = 0 |
| E5 | sale_allocations.is_void=true 行数 ≥ 历史已退款单关联 sa 行数 | 差值 ≥ 0 |
| E6 | service_commissions.voided_at 非空行数 ≥ 历史已退款单关联 sc 行数 | 差值 ≥ 0 |
| E7 | customer_points.balance = SUM(point_transactions.amount) per user | 偏差用户数 = 0 |
| E8 | pickup_records.picked_up_quantity ≥ 0（不允许负） | 违例行数 = 0 |

## 8 文件清单

- `00_README.md` — 本文件
- `01_step_a_repayment_migration.sql` — 回款单迁移
- `02_step_b_refund_migration.sql` — 退款单迁移（含 details 子表写入）
- `03_step_c_recompute_summary.sql` — sale_orders 汇总字段重算
- `04_step_d_5channel_rollback.sql` — 5 通道历史回滚
- `05_step_e_validation.sql` — 全量校验

## 9 常见问题

**Q：drizzle-kit 生成的 0018 sql 已经做了 schema，但应用层（admin/staff）还在写老 schema 怎么办？**
A：阶段 2 同步发布。本阶段（阶段 1）只交付 schema + 数据迁移；阶段 2 由应用层 agent 负责 admin / staff / client / cloudfunctions 改造。两阶段中间业务必须只读。

**Q：B4 的 sale_order_payment_details INSERT 用 `created_at` 配对会不会撞？**
A：`(sale_order_id, change_type, created_at)` 在迁移上下文中是唯一的（每个原"退款单"的 created_at 是 INSERT 时拷贝过去的，单点写入不会撞）。但若有历史并发数据可能存在重复，建议在 dry-run 时执行：

```sql
SELECT sale_order_id, change_type, created_at, COUNT(*)
FROM sale_order_payments
WHERE change_type = '退款'
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
```

如有重复 → 走 `02_step_b_refund_migration.sql` 末尾的 mapping 表方案。

**Q：D6 pickup 的 session_count 反推不准怎么办？**
A：D6 兜底用 `COALESCE(spd.session_count, 1)`，对单品/家居产品默认 1 件。如业务方反馈不准，则改为按 sale_items.quantity 反推（详见 04 SQL 注释）。
