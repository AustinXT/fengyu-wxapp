# DBA 评审 Brief — Sale Order Domain Refactor

> 1 页速览版。详细 runbook 见 [00_README.md](./00_README.md)。
> 来源 ticket：[../../../notes/tickets/2026-04-26-sale-order-domain-refactor.md](../../../notes/tickets/2026-04-26-sale-order-domain-refactor.md)
> 严重级别：**P0**（资金链路重构 + 退款资损根治 + 5 通道历史回滚）

---

## 评审目标（5 分钟看完）

确认以下 4 点是 GO 之前的最低门槛：
1. ✅ 冷备份可恢复（dry-run restore 验证）
2. ✅ 6 个 SQL 在脱敏副本上**全部一次跑通**（含 enum 重建）
3. ✅ 5 通道回滚的"员工业绩可能负数"已业务方公告 + 审批
4. ✅ 灰度窗口选定（建议周末凌晨 02:00-06:00）

任一未达 → NO-GO，回到 P0 预检。

---

## 审什么（按文件）

| 文件 | 行数 | 审什么 |
|------|------|--------|
| `00_README.md` | 150 | 整体 runbook：执行顺序、公告、回滚、校验 |
| `01_step_a_repayment_migration.sql` | 131 | **回款单 → sop[change_type='回款']** + details 子表写入 + mapping 临时表 |
| `02_step_b_refund_migration.sql` | 197 | **退款单 4 状态分支迁移** + B4 details 子表 + mapping 临时表 |
| `03_step_c_recompute_summary.sql` | 76 | sale_orders.received / refunded_amount 重算 |
| `04_step_d_5channel_rollback.sql` | 206 | **5 通道回滚**（sa/sc/coupons/points/pickup）+ 重算 customer_points.balance |
| `05_step_e_validation.sql` | 302 | E1-E15 校验 SQL（每条 PASS/FAIL verdict 列）|
| 主迁移 SQL（drizzle 自动）| `db/migrations/0019_*.sql` | M1-M7 schema 改动（enum 减值 + 列删/加 + 子表新建 + partial unique）|

---

## 关键风险点（5 条）

### R1 enum 减值的 cast 失败 🔴
- M6 的 `ALTER COLUMN sale_order_type TYPE sale_order_type_new USING sale_order_type::text::sale_order_type_new`
- **若 saleOrders 仍有 `回款单` / `退款单` 行，此 cast 会失败**
- 缓解：必须**先跑 01-04 数据迁移再 apply M6**
- 实操：把 0019.sql **拆为 part1（M1-M5+M7）+ part2（M6 enum 减值）**，中间插入 01-04

### R2 5 通道回滚的副作用 🔴
- D1-D6 会让员工**历史业绩 / 提成可能负数**
- 缓解：业务方公告（README §3 模板）+ 审批
- 不可回滚边界：D 步骤 COMMIT 后即定稿；建议 D 步骤**单独 COMMIT**，必要时单独 ROLLBACK

### R3 mapping 临时表的并发安全 🟡
- 01 / 02 用 `tmp_repayment_mapping` / `tmp_refund_mapping` 关联 RETURNING id ↔ legacy sale_order_id
- 必须在**应用层冻结写入期**执行，否则迁移期间新写入的 sop 行可能被错误关联
- 缓解：README §2 P0-4 强制冻结 30 分钟

### R4 D6 pickup_records session_count 反推不准 🟡
- session_count 来源三层降级（spd.session_count / sale_items.quantity / fallback=1）
- 抽样审计：随机 10 个家居产品退款单，人工核对反推合理性，容忍 ±1 误差

### R5 不可逆边界 🔴
- Phase 1（M1-M5+M7）+ Phase 2（A/B/C/D）解冻后即不可回滚（新写入已基于新 schema）
- 缓解：dry-run 100% 通过 + 冷备份 + 灰度窗口

---

## Dry-run 步骤（脱敏副本）

```bash
# 1. 拉取生产快照 → 脱敏 → 临时库
pg_restore -d fengyu_dryrun ~/backups/fengyu-XXX.dump

# 2. 拆 0019.sql 为 part1 / part2（按 README §2 R1 缓解）
csplit db/migrations/0019_*.sql '/-- M6 enum 减值/' --prefix=0019_

# 3. 串行执行
psql -d fengyu_dryrun -f 0019_part1.sql                                      # M1-M5+M7
psql -d fengyu_dryrun -f db/scripts/migration-2026-04-26-domain-refactor/01_step_a_repayment_migration.sql
psql -d fengyu_dryrun -f db/scripts/migration-2026-04-26-domain-refactor/02_step_b_refund_migration.sql
psql -d fengyu_dryrun -f db/scripts/migration-2026-04-26-domain-refactor/03_step_c_recompute_summary.sql
psql -d fengyu_dryrun -f db/scripts/migration-2026-04-26-domain-refactor/04_step_d_5channel_rollback.sql
psql -d fengyu_dryrun -f 0019_part2.sql                                      # M6 enum 减值
psql -d fengyu_dryrun -f db/scripts/migration-2026-04-26-domain-refactor/05_step_e_validation.sql 2>&1 | tee dry-run.log

# 4. grep PASS/FAIL
grep -E '^\s+(PASS|FAIL)' dry-run.log
# 全 PASS = GO；任一 FAIL = NO-GO
```

---

## GO / NO-GO 决策矩阵

| 条件 | 通过 | 不通过 |
|------|------|--------|
| 冷备份恢复演练 | ✅ | NO-GO，重做备份 |
| Dry-run 6 SQL 一次跑通（无 PG 错误）| ✅ | NO-GO，定位失败 SQL |
| Step E 全部 PASS（15 条 verdict）| ✅ | NO-GO，按 FAIL 项 fix-forward |
| 抽样审计（20 退款单 + 10 pickup + 5 顾客积分）| ✅ | NO-GO，调整 D 步骤 SQL |
| 业务方对"业绩负数"已审批 | ✅ | NO-GO，先沟通 |
| 灰度窗口已选 | ✅ | NO-GO，等下一个低谷 |

**全部 ✅ → GO 上线**

---

## 上线序列（生产）

```
T-30min   应用层切只读（admin / staff / client 拒绝 createOrder / createRefund）
T-25min   pg_dump 备份验证（DBA 确认）
T-20min   psql -f 0019_part1.sql                                  # M1-M5+M7
T-15min   psql -f 01_step_a_repayment_migration.sql                 # 回款单迁移
T-10min   psql -f 02_step_b_refund_migration.sql                    # 退款单迁移
T-5min    psql -f 03_step_c_recompute_summary.sql                   # 重算汇总
T+0       psql -f 04_step_d_5channel_rollback.sql                   # 5 通道回滚（单独 COMMIT 边界）
T+10min   psql -f 0019_part2.sql                                    # M6 enum 减值
T+15min   psql -f 05_step_e_validation.sql                          # 校验
T+25min   抽样审计（DBA + 业务方）
T+30min   应用层部署 commits 622fdee + a1099fc + 04bc346 + 5ea6057 + b47b282
T+35min   应用层解冻
T+40min   烟测 5 个核心路径（createOrder / approveRefund / refundHistory / dashboard / pickup）
```

预计总时长 **40 分钟**（含审计），灰度窗口建议 **02:00-06:00** 留 4 小时缓冲。

---

## 应急回滚

| 阶段 | 回滚方式 |
|------|---------|
| Phase 1 之前 | 直接 ROLLBACK / 不需操作 |
| Phase 1（part1）失败 | `pg_restore --clean` 恢复冷备份 |
| Phase 2 A/B/C 失败 | 恢复冷备份 |
| **Phase 2 D 失败**（5 通道回滚出错）| 单独 ROLLBACK D 事务，应用层保持冻结，调整 D SQL 重跑 |
| Phase 2 part2（M6）失败 | 罕见（数据已迁移完成）；恢复冷备份是最稳妥 |
| **解冻后** | **不可回滚**，必须 fix-forward |

---

## 联系人

- 开发：参考 ticket §9 联系人列表
- 业务方：财务 + 运营负责人（业绩负数决策）
- DBA：本评审主审

---

> 评审通过后请在本文件末尾签名 + 日期：
>
> ✅ DBA Review By: ___________ Date: ___________
> ✅ Business Approve: ___________ Date: ___________
