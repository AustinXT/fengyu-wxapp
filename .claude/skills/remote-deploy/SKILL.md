---
name: remote-deploy
description: |
  在本地交叉编译 fengyu-admin 或 fengyu-analyst 的 linux/amd64 Docker 镜像，
  传输到固定的 dev、test、prod 服务器并以版本化配置启动。用于“部署到服务器”、
  “更新服务器”、“上线 admin/analyst”、“remote deploy”等请求；不负责执行数据库迁移。
disable-model-invocation: true
user-invocable: true
argument-hint: '[admin|analyst] [dev|test|prod]'
metadata:
  title: 远程部署（本地交叉编译）
  description_zh: 本地 buildx → 镜像传输 → 版本化 compose → 自动回滚
  author: nvoyager
  version: 2.1.0
---

# 远程部署

部署入口：

```bash
.claude/skills/remote-deploy/deploy-admin.sh <dev|test|prod> [--check]
.claude/skills/remote-deploy/deploy-analyst.sh <dev|test|prod> [--check]

.claude/skills/remote-deploy/deploy-admin.sh --rollback <dev|test|prod>
.claude/skills/remote-deploy/deploy-analyst.sh --rollback <dev|test|prod>
```

`--check` 只运行脱敏预检，不构建、不上传、不修改远端。实际 prod 发布或回滚必须按提示输入包含环境的确认文本。

## 固定拓扑

| 环境 | SSH / 公网服务器 | 远端目录 | 容器数据库 | 本地迁移连接 |
|---|---|---|---|---|
| dev | `ali-demo` / `47.113.202.7` | `/root/proj.xt.com/fengyu-wxapp/docker` | `47.113.202.7:5433` | `47.113.202.7:5433` |
| test | `sqlserver101` / `101.34.242.103` | `/www/wwwroot/fengyu-admin/docker` | `172.18.0.1:5433` | `101.34.242.103:5433` |
| prod | `fengyu-prod` / `118.178.196.26` | `/www/wwwroot/fengyu-admin/docker` | `118.178.196.26:5433` | `118.178.196.26:5433` |

`172.18.0.1` 是 test 容器回连 `101.34.242.103` 宿主 PostgreSQL 的 Docker 网桥，不是另一台服务器。禁止用参数、环境变量或分支名覆盖上述目标。

## 配置权威与门禁

- `envs/<env>.env` 是构建和运行配置的唯一权威源；必须为 `0600`，不得含占位符。
- 不读取或改写远端 `.env` 内容。历史 `.env` 仅收紧文件模式为 `0600`，并保留首版兼容回滚能力。
- Admin、cron、export、Analyst 分别使用白名单 env；秘密不会进入日志或 Docker build args。
- 允许干净或脏工作树发布。脏工作树会对 tracked diff 与非忽略 untracked 文件内容计算指纹，并将 `<commit>-dirty.<fingerprint>` 写入镜像 tag、release ID、应用构建信息和 prod 确认文本；不得把脏发布误报为纯 commit。`ENV_PROFILE`、DB host/port/dbname、URL、CloudBase、拉卡拉 test 通道和 RSA 配对仍必须全部通过。
- 迁移门禁只读比对 Drizzle 最新 `created_at + hash`；有 pending、漂移或库领先本地代码时停止。迁移必须先走 `release-all` 或数据库专项流程。

## 发布与回滚

1. 本地用 `docker buildx --platform linux/amd64 --load` 构建环境专属不可变 tag。
2. `docker save | gzip | ssh docker load` 后核对本地/远端 image ID 与架构。
3. 上传服务白名单 env、compose 和脱敏 manifest 到版本化 release 目录。
4. 远端取得部署锁并执行 `docker compose config --quiet`，通过后只重建目标服务。
5. 验证容器、HTTP、DB、CloudBase 和 Analyst origin；任何不可读或不一致均失败。
6. 失败自动恢复上一成功 release；若自动回滚也失败，保留新旧 release 和状态文件供人工处理。

每个组件保留 current、previous 和一个额外历史 release。手工回滚严格读取版本状态，不扫描 dangling 镜像，也不依赖 `latest` 选择目标。
