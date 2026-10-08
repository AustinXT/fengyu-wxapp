#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
REMOTE=/www/wwwroot/lxcoding-demo
node scripts/demo/prepare.mjs
set -a
source envs/demo.env
set +a
REVISION=$(git rev-parse --short=12 HEAD)
IMAGE="lxcoding-demo:$REVISION"
LOCAL=.tmp/lxcoding-demo-release
cp docker/docker-compose.demo.yml "$LOCAL/compose.yml"
echo "构建 LX CODING 演示镜像 $REVISION"
docker buildx build --platform linux/amd64 --load -f docker/Dockerfile.admin -t "$IMAGE" \
  --build-arg APP_VERSION=demo --build-arg APP_COMMIT="$REVISION" \
  --build-arg NEXT_PUBLIC_RSA_PUBLIC_KEY="$NEXT_PUBLIC_RSA_PUBLIC_KEY" \
  --build-arg NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED=true \
  --build-arg NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=false .
docker save "$IMAGE" | gzip | ssh lx-test 'gunzip | docker load'
LOCAL_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}')
REMOTE_ID=$(ssh lx-test "docker image inspect '$IMAGE' --format '{{.Id}}'")
[[ "$LOCAL_ID" == "$REMOTE_ID" ]] || { echo '镜像 ID 不一致'; exit 1; }
ssh lx-test "sudo -n mkdir -p '$REMOTE'; sudo -n chown \"\$(id -u):\$(id -g)\" '$REMOTE'; mkdir -p '$REMOTE/data/uploads' '$REMOTE/data/private-uploads' '$REMOTE/data/runtime'; sudo -n chown -R 1001:1001 '$REMOTE/data/uploads' '$REMOTE/data/private-uploads' '$REMOTE/data/runtime'"
# Refuse to replace a service belonging to another project.
ssh lx-test 'python3 -' <<'PY'
import json, subprocess
containers=json.loads(subprocess.check_output(['docker','ps','--format','json']).decode().replace('\n',',').rstrip(',').join(['[',']']))
for c in containers:
    if any(f':{port}->' in c.get('Ports','') for port in (8094,8096)) and not c['Names'].startswith('lxcoding-demo-'):
        raise SystemExit(f"端口已被其他服务占用：{c['Names']}")
PY
scp "$LOCAL/compose.yml" "$LOCAL/compose.env" "$LOCAL/postgres.env" "$LOCAL/admin.env" "lx-test:$REMOTE/"
ssh lx-test "cd '$REMOTE'; chmod 600 *.env; docker compose --env-file compose.env config --quiet; docker compose --env-file compose.env up -d --wait demo-postgres"
ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:58096:127.0.0.1:8096 lx-test &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true' EXIT
sleep 1
kill -0 "$TUNNEL_PID" || { echo '演示数据库 SSH 隧道未建立，停止初始化'; exit 1; }
export DATABASE_URL="postgresql://lxcoding_demo:$DEMO_DB_PASSWORD@127.0.0.1:58096/lxcoding_demo"
node scripts/demo/bootstrap.mjs
node scripts/demo/seed.mjs
ssh lx-test "cd '$REMOTE'; docker compose --env-file compose.env up -d --wait admin export-worker; curl --fail --silent http://127.0.0.1:8094/login >/dev/null; docker inspect lxcoding-demo-admin --format '{{.Config.Image}} {{.State.Status}}'"
echo '演示后台：http://101.34.242.103:8094/login；数据库：127.0.0.1:8096（SSH 隧道）'
