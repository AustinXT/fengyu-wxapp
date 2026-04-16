#!/bin/bash
set -e

SSH_HOST="${1:-ali-demo}"
REMOTE_DIR="${2:-/root/fengyu-wxapp}"

echo "=== 1/4 本地构建 Docker 镜像 ==="
cd "$(dirname "$0")/../../.."
APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
echo "版本号: $APP_VERSION${APP_COMMIT:+ · $APP_COMMIT}"
docker build \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  -f docker/Dockerfile.admin -t fengyu-admin:latest .

echo "=== 2/4 传输镜像到 $SSH_HOST ==="
docker save fengyu-admin:latest | gzip | ssh "$SSH_HOST" "docker load"

echo "=== 3/4 远程重启服务 ==="
ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose up -d admin"

echo "=== 4/4 健康检查 ==="
sleep 5
ssh "$SSH_HOST" "curl -sf http://localhost:3000/ > /dev/null && echo '✓ 部署成功' || echo '✗ 健康检查失败'"

echo ""
echo "部署完成。如需回滚，使用历史镜像重新部署："
echo "  docker tag fengyu-admin:<old-tag> fengyu-admin:latest"
echo "  $0 $SSH_HOST"
