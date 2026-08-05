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
./deploy-admin.sh <dev|prod> [ssh-host] [remote-dir]
```

第一个参数 `dev`/`prod` 决定目标环境：SSH host 自动路由（dev→`ali-demo` 测试 / prod→`fengyu-prod` 生产），admin 容器连对应远程 PG（dev→47.113.202.7 / prod→118.178.196.26，均 5433/fengyu_wxapp）。`[ssh-host]`/`[remote-dir]` 可显式覆盖（默认远程目录 dev=`/root/proj.xt.com/fengyu-wxapp/docker`，prod=`/www/wwwroot/fengyu-admin/docker`）。prod 有二次确认 + 生产库迁移预检，dev 无。

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

本地保留所有构建过的镜像：

```bash
# 查看历史版本
docker images fengyu-admin

# 回滚到指定版本
docker tag fengyu-admin:<old-tag> fengyu-admin:latest
./deploy-admin.sh
```
