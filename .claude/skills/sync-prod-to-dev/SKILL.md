---
name: sync-prod-to-dev
description: |
  用生产库（prod 118.178.196.26）数据覆盖开发库（dev 101.34.242.103）。
  dump prod → pg_restore --clean 覆盖 dev，restore 前强制二次确认 + 关键表行数校验。
  当用户说「同步 prod 到 dev」「把生产数据刷到开发库」「刷新 dev 库」、
  「prod 数据同步 dev」「sync prod dev」时激活。
disable-model-invocation: true
user-invocable: true
metadata:
  title: prod → dev 数据库同步
  description_zh: dump prod 覆盖 dev，手动触发 + 二次确认
  author: nvoyager
  version: 1.0.0
---

# prod → dev 数据库同步

⚠ **破坏性操作**：用生产库数据**覆盖**开发库（sqlserver101），dev 现有数据全部丢失、不可恢复。

运行同步脚本：

```bash
bash .claude/skills/sync-prod-to-dev/sync-prod-to-dev.sh
```

## 流程

1. 读 `envs/prod.env` / `envs/dev.env` 的 `PG_CONNECTION_STRING`（不硬编码密码）
2. 双向 IP 防误连校验（prod 必含 `118.178.196.26`、dev 必含 `101.34.242.103`，防反向灌库）
3. dump prod → `~/backups/fengyu/`（custom format；自动排除 codex_* 等无 SELECT 权限的外部表，保留作每日备份）
4. **restore 前强制 `yes` 二次确认**
5. 断开 dev 活跃连接 → `pg_restore --clean --if-exists --no-owner --no-acl` 覆盖 dev
6. prod / dev 关键表（`sale_orders` 等）行数对比校验

## 注意

- 来源：生产库 `118.178.196.26:5433/fengyu_wxapp`；目标：开发库 `101.34.242.103:5433/fengyu_wxapp`（sqlserver101）
- restore 期间不要用 dev admin / dev 云函数（会冲突，脚本会先断开连接兜底）
- dev 开发中手造的数据会丢失；未上线 migration 的库内痕迹会清掉，但 `db/migrations/` 代码层 `.sql` 不受影响（下次 `db:migrate` 会重 apply）
- dump 产物含顾客手机号 / 身份证 / 支付等敏感数据，落项目外 `~/backups/fengyu/`，勿外发
- 需本地 `postgresql@16`（pg_dump major ≥ 服务端 16）
