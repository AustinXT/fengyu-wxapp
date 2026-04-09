# Archive: pre-baseline migrations (before 2026-04-10)

本目录存放 **2026-04-10 drizzle-kit baseline reset** 之前的全部迁移历史。

## 为什么做 baseline reset

`db/migrations/` 的 `_journal.json` 和磁盘文件长期脱节，导致任何机器上跑
`npm run db:migrate` 都会失败：

1. **Journal 和磁盘错位**：journal 登记到 idx=18（`0018_green_rogue`），磁盘却有
   0000-0034 共 40 个 `.sql` 文件，idx 19-34 全部是手写孤儿，drizzle-kit 完全看不见
2. **序号冲突**：0010/0016/0017/0018/0023 各有 2 个同序号文件（drizzle 生成 + 手写孤儿）
3. **sync_to_current 文件**：`0007_sync_to_current.sql` 和 `0016_sync_to_current.sql`
   是整库 CREATE 全量输出，在已有 schema 上重放必然失败。测试库（5434/fengyu）
   的 `drizzle.__drizzle_migrations` 表缺这两条记录
4. **本质**：项目长期采用「drizzle-kit generate（生成 SQL）+ psql 手动 apply」混杂流程

## 目录结构

```
_archive_pre_baseline_2026_04/
├── README.md            本文件
├── _journal.json        原 db/migrations/meta/_journal.json（登记到 idx=18 为止）
├── sql/                 40 个旧 .sql 文件（含所有序号冲突文件）
├── snapshots/           13 个旧 drizzle-kit snapshot JSON
└── manual-applied/      7 个更早（项目早期）的手写 migration 归档
```

## 序号冲突清单（磁盘上同 idx 两文件）

- **0010**：`0010_closed_spyke.sql`（drizzle 生成）+ `0010_commission_role_rename.sql`（手写孤儿）
- **0016**：`0016_permission_roles_hard_delete.sql`（手写孤儿）+ `0016_sync_to_current.sql`（手写全库快照 154 行）
- **0017**：`0017_even_warpath.sql`（drizzle 生成）+ `0017_product_categories_hierarchy.sql`（手写孤儿）
- **0018**：`0018_green_rogue.sql`（journal 登记）+ `0018_mall_categories_hierarchy.sql`（手写孤儿）
- **0023**：`0023_document_type.sql`（手写孤儿）+ `0023_monthly_activity.sql`（手写孤儿）

## Journal 未登记的孤儿迁移

`0019_mall_categories_drop_is_valid.sql` 起到 `0034_apply_sale_order_type_split.sql`，
以及上面"序号冲突"里的手写文件，全部从未被 drizzle-kit 登记，都是手写后直接
`psql` apply 到数据库。

## baseline reset 做了什么

1. **Phase A（drift 修复）**：对 `47.113.202.7:5434/fengyu`（测试库）做了一次
   `psql` 一次性 fix，把以下 drift 修到和 `db/schema/*.ts` 语义一致：
   - DROP 两张今天备份表 `sale_items_backup_20260410` / `service_commissions_backup_20260410`
   - DROP 老列 `client_wechat_users.category`（varchar(50)，A/B/C/D/E 老分级，22875 行丢失）
   - UPDATE 4 行 `product_categories.product_kind='福利活动'` → `'护理项目'`
   - CREATE TYPE `product_kind` enum（4 值：护理项目/家居产品/充值卡/体验卡）
   - ALTER 列 `product_categories.product_kind` 从 text → enum
   - （脚本见 `db/scripts/phase-a-converge.sql`，本次执行的"最后一次"手动 apply）
2. **Phase B（归档）**：把全部旧 migration 挪到本目录（git mv 保留历史）
3. **Phase C（baseline 生成）**：基于 `db/schema/*.ts` 重新 `drizzle-kit generate --name baseline`
4. **Phase D（journal 重置）**：`db/scripts/reset-drizzle-journal.js` 把 5434 的
   `drizzle.__drizzle_migrations` 表重置为只含 baseline
5. **Phase F（规范）**：`db/CLAUDE.md` 写入「禁止 psql 手动 apply」+ `.github/workflows/db-migrations-check.yml` CI 守卫

## 作业范围外（follow-up）

- **5433/fengyu_wxapp（开发库，staffApi/clientApi 云函数用）** 本次没有处理。它的 schema
  停留在约 2026-02 的状态，比 schema.ts 落后 20+ 个 migration。详细 drift 清单见
  `db/scripts/follow-up-5433-drift.txt`。将在后续 PR 专项修复
- **两个 cosmetic drift 未处理**：
  1. `staff_wechat_users_employee_id_unique` 冗余 unique 约束 — 15 个 FK 依赖，
     DROP 会 CASCADE 连锁删除 FK，风险过高，作为 cosmetic 忽略
  2. `uq_org_nodes_parent_name` 列顺序 `(parent_id,name)` vs `(name,parent_id)`，
     语义相同，drizzle-kit 不会因此触发 ALTER

## 不要原地修改本目录

本目录仅供历史查证。如果需要复现某个时间点的 schema，请从 `git log
db/migrations/_archive_pre_baseline_2026_04/` checkout。**不要**在本目录下新增
或修改文件——它对 drizzle-kit 完全隐形，修改没有任何效果，反而会误导阅读的人。
