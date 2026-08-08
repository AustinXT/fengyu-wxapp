# Archive: pre-baseline migrations (before 2026-08-06)

本目录保存 2026-08-06 baseline reset 之前的迁移历史，Drizzle 不会读取此目录。

## 背景

两套业务库的 `drizzle.__drizzle_migrations` 都有 94 条记录，而当时源码 journal 只有 93 条；其中 `0082_harsh_firebird` 的 hash 不同，另有一条无法从 Git blob 恢复的额外 hash。实际 `public` schema 经验证已与 `db/schema` 一致，唯一例外是生产库中 6 张未被源码引用的遗留表。

在归档前，已通过官方 custom migration `0093_source_external_table_cleanup.sql` 删除这 6 张遗留表，并已在开发库、生产库和恢复出的生产 schema 副本中验证。

## 内容

- `sql/`：归档前的 94 个 migration SQL 文件（含 `0093`）。
- `snapshots/`：归档前由 Drizzle 生成的 86 个 snapshot。
- `_journal.json`：归档前的 94 条源码 migration journal。

## 之后的规则

当时活动迁移目录以从当前 `db/schema` 生成的 `0000_baseline` 重置。两套业务库的 journal 先重置为该 baseline 的单条 hash；后续变更必须从此 baseline 继续用 `drizzle-kit generate` 产生增量 migration。

不要修改本目录中的文件。如需追溯旧迁移或恢复其中的备份表，请使用本次仓库外备份或按归档内容进行只读查证。

## 已有业务库升级步骤

旧 journal 的 hash 不会匹配新的 `0000_baseline`；因此对于已完整应用本归档链路的业务库，**不能先运行** `db:migrate`。必须分别对开发/测试库和生产库按以下顺序执行：

1. 暂停该库的发布/迁移并完成常规备份。
2. 先运行 dry-run，确认输出显示 94 条旧 journal 记录：

   ```bash
   DATABASE_URL="postgresql://..." npm --prefix db run db:baseline:reset
   ```

3. 对同一目标库执行 journal 重置：

   ```bash
   DATABASE_URL="postgresql://..." npm --prefix db run db:baseline:reset -- --yes
   ```

4. 最后才运行正常迁移，供今后的增量 migration 使用：

   ```bash
   DATABASE_URL="postgresql://..." npm --prefix db run db:migrate
   ```

`db:baseline:reset` 会拒绝空库、部分旧 journal，或已含 baseline 后续增量的库，避免把未验证的 schema 误标为已迁移。空库直接运行 `db:migrate`，它会创建 schema 并写入 `recharge.tiers`、`recharge.minAmount`、`recharge.maxAmount` 三项默认配置。
