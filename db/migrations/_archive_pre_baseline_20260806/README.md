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

新的活动迁移目录只保留从当前 `db/schema` 生成的 `0000_baseline`。两套业务库的 journal 会重置为该 baseline 的单条 hash；后续 schema 变更必须从此 baseline 继续用 `drizzle-kit generate` 产生增量 migration。

不要修改本目录中的文件。如需追溯旧迁移或恢复其中的备份表，请使用本次仓库外备份或按归档内容进行只读查证。
