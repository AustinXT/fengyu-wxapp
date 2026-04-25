# 2026-04-25 role_type INSERT 路径全仓审计 + NOT NULL 约束兜底

## 背景

线上发现 `sale_allocations.role_type` 100% 为 NULL（双库各 156,715 行），说明历史上**所有** `INSERT INTO sale_allocations` 路径都没填 `role_type`。已通过一次性 backfill 脚本 `db/scripts/backfill-allocations-roletype.js` 双库全量回填到 0 NULL，但需要：

1. 全仓审计是否还有遗漏的 INSERT 路径
2. 同步审计 `service_commissions.role_type`（同模式表）
3. 评估给 schema 加 NOT NULL 约束作为兜底

## 双库 NULL 现状统计（2026-04-25 实测）

> 提示：2026-04-24 起 5434/fengyu 已是唯一生产业务库；5433/fengyu_wxapp 转为冷备
> （详见 `db/CLAUDE.md`「生产库与冷备库」）。下表保留双库快照便于追踪历史 drift。

### sale_allocations

| 库 | total | NULL (active) | NULL (void) | NULL (all) |
|---|---|---|---|---|
| 5434/fengyu（生产） | 156,715 | 0 | 0 | 0 |
| 5433/fengyu_wxapp（冷备） | 156,715 | 0 | 0 | 0 |

✓ backfill 已完成，可安全添加 NOT NULL 约束。

### service_commissions

| 库 | total | NULL (active) | NULL (void) | NULL (all) |
|---|---|---|---|---|
| 5434/fengyu（生产） | 616,210 | 616,210 | 0 | 616,210 |
| 5433/fengyu_wxapp（冷备） | 616,210 | 616,210 | 0 | 616,210 |

✗ 全表 NULL，需要先 backfill 再加 NOT NULL。

skills 覆盖度（5434）：
- has_skills（员工 skills 非空）：166,308 行（27%）→ 可派生
- no_skills：449,902 行（73%）→ 兜底 `'美容师'`

## 全仓 INSERT 路径清单

### sale_allocations（4 处）

| # | 路径:行号 | 角色 | role_type 状态 | 处理 |
|---|---|---|---|---|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/allocation.js:171` | 店长手动批量分配（save） | ✅ 已正确填（`alloc.roleType` 来自 payload） | 无需修改 |
| 2 | `fengyu-client/cloudfunctions/payNotify/index.js:348` | 顾客支付回调自动分配 | ✅ 已正确填（按员工 skills[0] 派生，兜底 `'美容师'`） | 已在前置任务修复 |
| 3 | `fengyu-admin/src/actions/allocations.ts:109` `saveAllocation` | admin 单条保存 | ⚠️ 漏填：`data.roleType \|\| null`（未被前端调用，但仍是地雷） | **本 ticket 已修**：缺省时按 staff.skills[0] 派生，兜底 `'美容师'` |
| 4 | `fengyu-admin/src/actions/allocations.ts:275` `batchSaveAllocations` | admin 批量保存 | ✅ 已正确填（前端 100% 传 `e.skillTag`） | 无需修改 |
| 5 | `fengyu-admin/src/db/seed.ts:377` SALE_ALLOCATIONS | 本地开发种子数据 | ⚠️ 漏填 | **本 ticket 已修**：3 行手工补 `roleType: '美容师'` |
| 6 | `db/scripts/migrate-allocations.js:276` | 一次性 WorkFine 历史导入脚本 | ⚠️ 漏填（这是历史 NULL 的源头） | **本 ticket 已修**：加载 staff.skills 派生 + ON CONFLICT 也要跟上唯一索引 `(item, emp, role)` 而非旧的 `(item, emp)` |

### service_commissions（3 处）

| # | 路径:行号 | 角色 | role_type 状态 | 处理 |
|---|---|---|---|---|
| 1 | `fengyu-staff/cloudfunctions/staffApi/routes/service.js:434` `service.complete` | 服务单完成自动写提成 | ✅ 已正确填（按员工 skills[0] 派生） | 无需修改 |
| 2 | `db/scripts/migrate-service-records.js:287` | 一次性 WorkFine 历史售后导入 | ⚠️ 漏填（历史 NULL 的源头之一） | **本 ticket 已修**：加载 staff.skills + INSERT 增加 role_type 列 + ON CONFLICT 用唯一约束名 |
| 3 | `db/scripts/migrate-presale-services.js:383` | 一次性 WorkFine 售前导入 | ⚠️ 漏填（历史 NULL 的源头之二） | **本 ticket 已修**：加载 staff.skills + INSERT 增加 role_type 列 + ON CONFLICT 用唯一约束名 |

## 已修复的代码改动（本 ticket）

| 文件 | 改动 |
|---|---|
| `fengyu-admin/src/actions/allocations.ts` | `saveAllocation` 缺省 roleType 时按 staff.skills[0] 派生 + 兜底 `'美容师'` |
| `fengyu-admin/src/db/seed.ts` | `SALE_ALLOCATIONS` 3 行补 `roleType: '美容师'` |
| `db/scripts/migrate-allocations.js` | `loadLookups` 加载 employeeSkills + `generateAllocations` 派生 roleType + INSERT 增列 + ON CONFLICT 改为唯一索引 `(item, emp, role)` |
| `db/scripts/migrate-service-records.js` | 同上模式 + ON CONFLICT 改用约束名 `uq_svc_comm_item_emp_role` |
| `db/scripts/migrate-presale-services.js` | 同上模式 |
| `db/scripts/backfill-service-commissions-roletype.js` | **新增**：仿 backfill-allocations-roletype.js 的一次性回填脚本（双库都要跑） |

## Schema 现状（截至 2026-04-25）

`db/schema/order.ts:208`
```ts
roleType: varchar("role_type", { length: 20 }),  // 当前 nullable
```

`db/schema/service-commission.ts:27`
```ts
roleType: varchar('role_type', { length: 20 }),  // 当前 nullable
```

两表对应的唯一索引都把 role_type 作为键的一部分（`(saleItemId, employeeId, roleType)` / `(serviceItemId, employeeId, roleType)`），但 PG 的 partial unique index 在 NULL 列上的语义是「NULL 互不冲突」，**当前形同虚设**——这是 156k+ 行 NULL 能顺利积累的根因。

## NOT NULL 约束改造方案

### 步骤（不在本 ticket 直接执行，由用户走 db:generate 流程）

1. 先跑 backfill 清零（5434 必跑；5433 可选作为冷备演练）：
   ```bash
   # 5434（生产业务库，必跑）
   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu" \
     node db/scripts/backfill-service-commissions-roletype.js --commit

   # 5433（冷备，可选）
   PG_CONNECTION_STRING="postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp" \
     node db/scripts/backfill-service-commissions-roletype.js --commit
   ```

2. 修改 schema：
   ```ts
   // db/schema/order.ts
   roleType: varchar("role_type", { length: 20 }).notNull(),

   // db/schema/service-commission.ts
   roleType: varchar('role_type', { length: 20 }).notNull(),
   ```

3. `npm run db:generate` 产出 migration（drizzle-kit 会生成形如）：
   ```sql
   ALTER TABLE "sale_allocations"     ALTER COLUMN "role_type" SET NOT NULL;
   ALTER TABLE "service_commissions"  ALTER COLUMN "role_type" SET NOT NULL;
   ```

4. 临时 docker PG 验证 + 双库 `npm run db:migrate`（参考 `db/CLAUDE.md`）。

### 风险评估

| 风险 | 缓解 |
|---|---|
| backfill 后未来再有 NULL 流入（NOT NULL 阻塞） | 这正是 NOT NULL 想要的兜底：让漏填路径在 staging/dev 阶段就 22023 错出来，避免又静默积累 156k 脏数据 |
| 唯一索引在 NULL 上 "互不冲突" 的副作用消除 | 同员工同明细同角色重复分配会被唯一索引拦截（之前 NULL 状态下重复行可能已积累，但 backfill 后若有冲突会自然暴露） |
| 历史 migration 脚本如果再被重跑（理论上不会） | 已修；ON CONFLICT 改对齐唯一索引 `(item, emp, role)`，不会再撞旧索引 |
| 应用代码漏填导致整个事务回滚 | 全部 INSERT 路径已审计/修复；payNotify 修复后已上线一段时间 |

## 验收标准

- [ ] `db/scripts/backfill-service-commissions-roletype.js --commit` 在 5434 执行完，自检 `service_commissions.role_type IS NULL AND is_void=FALSE` = 0（5433 冷备同步可选）
- [ ] `sale_allocations.role_type IS NULL` = 0（已达成）
- [ ] schema 改动 + drizzle-kit 生成的 migration 通过临时 docker PG 验证
- [ ] 5434 `db:migrate` 后，`\d sale_allocations` / `\d service_commissions` 显示 `role_type ... not null`
- [ ] 主要单元测试通过：`fengyu-admin` Vitest、`fengyu-staff/cloudfunctions/staffApi` Jest、`fengyu-client/cloudfunctions/payNotify` Jest
- [ ] 灰度观察 1 周内无新 22023 报错（NOT NULL 约束违反）

## 相关 ticket / memory

- `notes/tickets/`（本 ticket）
- `db/scripts/backfill-allocations-roletype.js`（前置 backfill）
- `db/scripts/backfill-service-commissions-roletype.js`（本 ticket 新增）
- 项目记忆 `project_db_dual_env.md`（双库纪律）
