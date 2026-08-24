---
name: remote-deploy
description: |
  本地 docker build → 传输镜像 → docker compose up -d。
  不在远程服务器上 build（性能差），本地构建完整镜像后传输。
  当用户说"部署到服务器"、"更新服务器"、"remote deploy"、
  "上线 admin"、"服务器更新一下"、"发布到远程"时激活。
disable-model-invocation: true
user-invocable: true
argument-hint: '[admin]'
metadata:
  title: 远程部署（本地构建）
  description_zh: 本地 docker build → save/load → compose up
  author: nvoyager
  version: 1.0.0
---

# 远程部署

运行部署脚本：

```bash
./deploy-admin.sh <dev|test|prod> [ssh-host] [remote-dir]
./deploy-analyst.sh <dev|test|prod> [ssh-host] [remote-dir] [public-host]
```

第一个参数决定环境：`dev` 部署到 `ali-demo`，`test` 部署到 `sqlserver101`（`101.34.242.103`），`prod` 部署到 `fengyu-prod`。test 的 admin 与 analyst 均连接 101 宿主测试库（容器内 `172.18.0.1:5433`），analyst 默认发布到 `http://101.34.242.103:3001`。`[ssh-host]`/`[remote-dir]` 可显式覆盖。prod 有二次确认 + 生产库迁移预检。

## 部署流程

1. **本地 docker build** — 使用 `docker/Dockerfile.admin` 多阶段构建（bun install → bun build → node:18-alpine runner）
2. **镜像传输** — `docker save | gzip | ssh docker load`（管道传输不落盘）
3. **远程启动** — `docker compose up -d admin`
4. **健康检查** — curl localhost:3000

## 前置条件

- 本地 Docker 已安装并运行
- 远程服务器 SSH 可达（`ali-demo`=测试 / `fengyu-prod`=生产，均在 ~/.ssh/config 中配置）
- 远程已有 docker-compose.yml 且 admin service 配置正确
- 远程 .env 中 DATABASE_URL 等环境变量已配置

## 回滚

远程会保留上一版 analyst 镜像，回滚脚本会按已知 SSH host 推断正确目录；未知 host
必须显式传目录：

```bash
# test（自动使用 /www/wwwroot/fengyu-admin/docker）
./deploy-analyst.sh --rollback sqlserver101

# 自定义 host
./deploy-analyst.sh --rollback <ssh-host> <remote-dir>
```

admin 回滚需在目标远程主机把已验证的旧镜像重新标记为 `fengyu-admin:latest`，再用同环境
`./deploy-admin.sh <dev|test|prod>` 重新部署。
