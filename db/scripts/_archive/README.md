# db/scripts/_archive

已归档的一次性脚本，仅留历史参考，**不应再执行**。

归档原因：2026-04 baseline reset 收尾脚本与早期建库脚本，任务已闭环且无任何代码/文档引用。

| 文件 | 用途 | 取代者 |
|------|------|--------|
| `check-enum-dep.mjs` | 一次性查询 enum 列依赖（硬编码连 5434） | — |
| `finish-0018-and-apply-0019.mjs` | baseline reset 期间收尾 0018 + 应用 0019 | drizzle migrate |
| `finish-0019-and-enum-reduce.sql` | 上者的 SQL 配套（enum 缩减） | — |
| `setup-postgres.sh` | 旧本地 PostgreSQL 安装 | `docker/docker-compose.yml` + `bootstrap-from-zero.sh` |
| `setup-pg-ali-demo.sh` | 旧 ali-demo 环境安装 | — |
| `init-remote.sh` | 旧远程服务器初始化 | — |

> 注：仍有审计/血缘价值且被文档引用的一次性脚本（如 `migrate-*`、`backfill-*`、`5433-*`、`sync-products-from-workfine.js`）保留在 `db/scripts/` 原位，未归档。
