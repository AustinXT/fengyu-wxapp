#!/bin/bash
set -e

SSH_HOST="${1:-ali-demo}"
REMOTE_DIR="${2:-/root/proj.xt.com/fengyu-wxapp/docker}"

echo "=== 1/4 本地构建 Docker 镜像（linux/amd64）==="
cd "$(dirname "$0")/../../.."
APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
echo "版本号: $APP_VERSION${APP_COMMIT:+ · $APP_COMMIT}"
docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  -f docker/Dockerfile.admin -t fengyu-admin:latest .

echo "=== 2/4 传输镜像到 $SSH_HOST ==="
docker save fengyu-admin:latest | gzip | ssh "$SSH_HOST" "docker load"

echo "=== 3/4 远程重启服务 ==="
# compose.yml 已显式声明 image: fengyu-admin:latest，up 时直接复用传入的镜像
# cron-worker 复用同一镜像、覆盖 entrypoint，跟随同一节奏滚动更新
ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d admin cron-worker"

echo "=== 4/4 健康检查 ==="
sleep 5
ssh "$SSH_HOST" "curl -sf http://localhost:3000/ > /dev/null && echo '✓ 部署成功' || echo '✗ 健康检查失败'"

echo ""
echo "部署完成。如需回滚，使用历史镜像重新部署："
echo "  docker tag fengyu-admin:<old-tag> fengyu-admin:latest"
echo "  $0 $SSH_HOST"
