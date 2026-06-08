#!/bin/bash
# 部署 fengyu-admin 镜像到远程 ali-demo，按 env 选择 compose 文件。
#
# Usage:
#   .claude/skills/remote-deploy/deploy-admin.sh <dev|prod> [ssh-host] [remote-dir]
#
# 参数：
#   $1 (required) — dev / prod
#   $2 (optional) — SSH host，默认 ali-demo
#   $3 (optional) — 远程 docker/ 目录绝对路径，默认 /root/proj.xt.com/fengyu-wxapp/docker

set -e

if [[ -z "${1:-}" ]] || [[ ! "$1" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod> [ssh-host] [remote-dir]" >&2
  echo "  $1 must be 'dev' or 'prod'" >&2
  exit 1
fi

ENV="$1"
SSH_HOST="${2:-ali-demo}"
REMOTE_DIR="${3:-/root/proj.xt.com/fengyu-wxapp/docker}"

# prod 强制确认
if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  About to deploy admin to PROD ($SSH_HOST)"
  echo "    admin 容器将连接 5433/fengyu_wxapp（生产业务库）"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "=== 1/5 本地构建 Docker 镜像（linux/amd64）==="
cd "$(dirname "$0")/../../.."
APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
echo "版本号: $APP_VERSION${APP_COMMIT:+ · $APP_COMMIT}"
echo "目标环境: $ENV"

# 登录密码 RSA 公钥：NEXT_PUBLIC_ 变量须在「构建期」inline 进客户端 bundle。
# 从 envs/$ENV.env 读出（.dockerignore 已排除 .env.local，构建时拿不到），--build-arg 传入。
# prod 缺失则 fail-fast（否则前端 encryptPassword 抛「缺少公钥」，登录不可用）。
RSA_PUB=$(grep '^NEXT_PUBLIC_RSA_PUBLIC_KEY=' "envs/$ENV.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [[ "$ENV" == "prod" && -z "$RSA_PUB" ]]; then
  echo "✗ envs/prod.env 缺少 NEXT_PUBLIC_RSA_PUBLIC_KEY，登录会挂。请先配置 RSA 密钥对。" >&2
  exit 1
fi

docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  --build-arg NEXT_PUBLIC_RSA_PUBLIC_KEY="$RSA_PUB" \
  -f docker/Dockerfile.admin -t fengyu-admin:latest .

echo "=== 2/5 传输镜像到 $SSH_HOST ==="
docker save fengyu-admin:latest | gzip | ssh "$SSH_HOST" "docker load"

echo "=== 3/5 同步 docker-compose 文件 ==="
# base
scp docker/docker-compose.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"
# prod 时同时同步 override
if [[ "$ENV" == "prod" ]]; then
  scp docker/docker-compose.prod.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.prod.yml"
  echo "  ✓ 已同步 docker-compose.prod.yml"
fi

echo "=== 4/5 远程重启服务 ==="
# cron-worker 日志挂载卷（容器内 uid=1001 nextjs 才能写入；目录不存在 docker 会以 root 自建并越权）
ssh "$SSH_HOST" "mkdir -p $REMOTE_DIR/logs/cron-worker && chown 1001:1001 $REMOTE_DIR/logs/cron-worker"
if [[ "$ENV" == "prod" ]]; then
  # prod：base + override，且 disabled profile 排除 postgres 容器
  ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d admin cron-worker"
else
  # dev：仅 base
  ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose -f docker-compose.yml up -d admin cron-worker"
fi

echo "=== 5/5 健康检查 + DB 连接验证 ==="
sleep 5
ssh "$SSH_HOST" "curl -sf http://localhost:3000/ > /dev/null && echo '✓ HTTP 健康检查通过' || echo '✗ HTTP 健康检查失败'"
ssh "$SSH_HOST" "docker exec fengyu-admin sh -c 'echo \"DATABASE_URL=\$DATABASE_URL\"' | head -1"

echo ""
echo "部署完成（env=$ENV）。"
if [[ "$ENV" == "prod" ]]; then
  echo ""
  echo "下一步验证（必查）："
  echo "  1. ssh $SSH_HOST 'docker exec fengyu-admin env | grep DATABASE_URL'   # 应为 5433"
  echo "  2. ssh $SSH_HOST 'docker logs fengyu-admin --tail 50'                  # 看启动是否正常"
  echo "  3. 浏览器打开 admin 域名 → 用初始账号登录验证"
fi
echo ""
echo "回滚：docker tag fengyu-admin:<old-tag> fengyu-admin:latest 后重新部署"
