#!/bin/bash
# Deploy fengyu-analyst to remote docker host.
#
# Usage:
#   .claude/skills/remote-deploy/deploy-analyst.sh <dev|prod> [ssh-host] [remote-dir] [public-host]
#   .claude/skills/remote-deploy/deploy-analyst.sh --rollback <ssh-host>
#
# Rollback:
#   回滚到上一个镜像版本（需要先部署过至少两次）

set -euo pipefail

if [[ "${1:-}" == "--rollback" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "Usage: $0 --rollback <ssh-host>" >&2
    exit 1
  fi
  SSH_HOST="$2"
  REMOTE_DIR="${REMOTE_DIR:-/root/proj.xt.com/fengyu-wxapp/docker}"

  echo "=== 回滚 fengyu-analyst ==="
  echo "SSH Host: $SSH_HOST"
  read -p "确认回滚到上一个镜像版本？(yes/no): " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "已取消"
    exit 0
  fi

  # 获取当前运行的镜像 ID
  CURRENT_IMAGE=$(ssh "$SSH_HOST" "docker inspect -f '{{.Image}}' fengyu-analyst 2>/dev/null" || echo "")
  if [[ -z "$CURRENT_IMAGE" ]]; then
    echo "❌ 无法获取当前镜像 ID" >&2
    exit 1
  fi

  # 查找上一个 fengyu-analyst 镜像（旧镜像失去 latest 标签后变为 dangling）
  PREVIOUS_IMAGE=$(ssh "$SSH_HOST" "docker images --filter 'dangling=true' --format '{{.ID}}' | head -1" || echo "")
  if [[ -z "$PREVIOUS_IMAGE" ]]; then
    echo "❌ 未找到上一个镜像版本" >&2
    exit 1
  fi

  echo "当前镜像: ${CURRENT_IMAGE:0:12}"
  echo "回滚目标: ${PREVIOUS_IMAGE:0:12}"

  # 临时标记旧镜像
  ssh "$SSH_HOST" "docker tag $PREVIOUS_IMAGE fengyu-analyst:rollback-temp"
  ssh "$SSH_HOST" "docker tag fengyu-analyst:rollback-temp fengyu-analyst:latest"
  ssh "$SSH_HOST" "cd $REMOTE_DIR && docker compose --env-file .env --env-file .admin-runtime.env -f docker-compose.yml -f docker-compose.remote.yml up -d analyst"
  ssh "$SSH_HOST" "docker rmi fengyu-analyst:rollback-temp 2>/dev/null || true"

  echo "✓ 回滚完成"
  exit 0
fi

if [[ -z "${1:-}" ]] || [[ ! "$1" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod> [ssh-host] [remote-dir] [public-host]" >&2
  echo "       $0 --rollback <ssh-host>" >&2
  exit 1
fi

ENV="$1"
SSH_HOST_DEFAULT=$([[ "$ENV" == "prod" ]] && echo "fengyu-prod" || echo "ali-demo")
SSH_HOST="${SSH_HOST:-${2:-$SSH_HOST_DEFAULT}}"
REMOTE_DIR_DEFAULT=$([[ "$ENV" == "prod" ]] && echo "/www/wwwroot/fengyu-admin/docker" || echo "/root/proj.xt.com/fengyu-wxapp/docker")
REMOTE_DIR="${REMOTE_DIR:-${3:-$REMOTE_DIR_DEFAULT}}"
EXPECT_PG_HOST=$([[ "$ENV" == "prod" ]] && echo "118.178.196.26" || echo "47.113.202.7")
PUBLIC_HOST="${PUBLIC_HOST:-${4:-$EXPECT_PG_HOST}}"
ANALYST_PORT="${ANALYST_PORT:-3001}"
ADMIN_PORT="${ADMIN_PORT:-3000}"

if [[ "$SSH_HOST" != "$SSH_HOST_DEFAULT" ]]; then
  echo "⚠️  SSH_HOST ($SSH_HOST) ≠ ENV=$ENV 绑定默认 ($SSH_HOST_DEFAULT)。" >&2
  echo "    疑似 shell 残留污染或显式跨环境部署；DB/Origin 断言仍会在部署后兜底。" >&2
  read -r -p "Type 'yes' to confirm this target is intentional: " ssh_confirm
  if [[ "$ssh_confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

cd "$(dirname "$0")/../../.."

read_env_value() {
  local key="$1"
  local value
  value=$(grep -m1 "^${key}=" "envs/$ENV.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"')
  if [[ -z "$value" ]]; then
    echo "✗ envs/$ENV.env 缺少 $key，无法部署。" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# 远程 .env 保存账号密钥等运行期秘密；运行期 CloudBase 标识从目标环境生成，
# 避免 dev/prod 共用 docker 目录或残留 .env 时串桶。
DEPLOY_CLOUDBASE_ENV_ID=$(read_env_value CLOUDBASE_ENV_ID)
DEPLOY_CDN_BASE=$(read_env_value CDN_BASE)
CONFIGURED_ANALYST_PUBLIC_ORIGIN=$(read_env_value ANALYST_PUBLIC_ORIGIN)
# The public analyst address is shared with the admin build. Reading it from the
# selected environment prevents a production release from silently falling back
# to the database IP address.
ANALYST_PUBLIC_ORIGIN="${ANALYST_PUBLIC_ORIGIN:-$CONFIGURED_ANALYST_PUBLIC_ORIGIN}"
if ! node -e 'const u = new URL(process.argv[1]); if (!/^https?:$/.test(u.protocol) || u.username || u.password) process.exit(1)' "$ANALYST_PUBLIC_ORIGIN"; then
  echo "✗ ANALYST_PUBLIC_ORIGIN 必须是无账号密码的 http(s) URL。" >&2
  exit 1
fi
ANALYST_ADMIN_ORIGIN="${ANALYST_ADMIN_ORIGIN:-http://$PUBLIC_HOST:$ADMIN_PORT}"
ANALYST_ADMIN_LOGIN_URL="${ANALYST_ADMIN_LOGIN_URL:-$ANALYST_ADMIN_ORIGIN/login}"
RUNTIME_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/fengyu-analyst-runtime.XXXXXX")
printf 'DEPLOY_CLOUDBASE_ENV_ID=%s\nDEPLOY_CDN_BASE=%s\n' \
  "$DEPLOY_CLOUDBASE_ENV_ID" "$DEPLOY_CDN_BASE" > "$RUNTIME_ENV_FILE"
COMPOSE_OVERRIDE="docker-compose.remote.yml"

if [[ "$ENV" == "prod" ]]; then
  echo "About to deploy analyst to PROD ($SSH_HOST) at $ANALYST_PUBLIC_ORIGIN"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
else
  echo "==> Deploy analyst to DEV ($SSH_HOST)"
  echo "    public: $ANALYST_PUBLIC_ORIGIN"
  echo "    admin:  $ANALYST_ADMIN_ORIGIN"
  echo "    db:     $EXPECT_PG_HOST:5433/fengyu_wxapp"
fi

APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")

echo "=== 1/5 本地构建 fengyu-analyst 镜像（linux/amd64）==="
echo "版本号: $APP_VERSION${APP_COMMIT:+ · $APP_COMMIT}"
docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  --build-arg NEXT_PUBLIC_ADMIN_ORIGIN="$ANALYST_ADMIN_ORIGIN" \
  --build-arg NEXT_PUBLIC_ANALYST_ORIGIN="$ANALYST_PUBLIC_ORIGIN" \
  -f docker/Dockerfile.analyst \
  -t fengyu-analyst:latest \
  .

echo "=== 2/5 传输镜像到 $SSH_HOST ==="
docker save fengyu-analyst:latest | gzip | ssh "$SSH_HOST" "docker load"

echo "=== 3/5 同步 compose 文件和 analyst 环境覆盖（base + remote override） ==="
scp docker/docker-compose.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"
scp "docker/$COMPOSE_OVERRIDE" "$SSH_HOST:$REMOTE_DIR/$COMPOSE_OVERRIDE"
scp "$RUNTIME_ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.admin-runtime.env"
ssh "$SSH_HOST" "chmod 600 '$REMOTE_DIR/.admin-runtime.env'"

TMP_ENV=$(mktemp "${TMPDIR:-/tmp}/fengyu-analyst-env.XXXXXX")
cleanup() {
  rm -f "$TMP_ENV" "$RUNTIME_ENV_FILE"
}
trap cleanup EXIT

{
  printf 'ANALYST_ADMIN_LOGIN_URL=%s\n' "$ANALYST_ADMIN_LOGIN_URL"
  printf 'ANALYST_ADMIN_ORIGIN=%s\n' "$ANALYST_ADMIN_ORIGIN"
  printf 'ANALYST_PUBLIC_ORIGIN=%s\n' "$ANALYST_PUBLIC_ORIGIN"
  printf 'ANALYST_VIEW_ACTION=%s\n' "${ANALYST_VIEW_ACTION:-data_center:dashboard}"
  printf 'ANALYST_CHAT_ACTION=%s\n' "${ANALYST_CHAT_ACTION:-data_center:dashboard}"
  printf 'ANALYST_EXPORT_ACTION=%s\n' "${ANALYST_EXPORT_ACTION:-data_center:dashboard}"
  if [[ -f fengyu-analyst/.env.local ]]; then
    grep -E '^(MINIMAX_API_KEY|MINIMAX_BASE_URL|MINIMAX_MODEL|OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL)=' fengyu-analyst/.env.local || true
  fi
} > "$TMP_ENV"

KEY_REGEX=$(awk -F= 'NF { print $1 }' "$TMP_ENV" | paste -sd'|' -)
REMOTE_SNIPPET="/tmp/fengyu-analyst-env-$$"
scp "$TMP_ENV" "$SSH_HOST:$REMOTE_SNIPPET"
ssh "$SSH_HOST" "cd $REMOTE_DIR && touch .env && cp .env .env.bak.analyst-\$(date +%Y%m%d%H%M%S) && { grep -v -E '^($KEY_REGEX)=' .env || true; cat $REMOTE_SNIPPET; } > .env.tmp && mv .env.tmp .env && rm -f $REMOTE_SNIPPET"
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env --env-file .admin-runtime.env -f docker-compose.yml -f $COMPOSE_OVERRIDE config --quiet" || { echo "✗ Compose 配置校验失败，请检查远程 .env 与 .admin-runtime.env"; exit 1; }
echo "  ✓ compose 与 analyst 环境已同步"

echo "=== 4/5 远程启动 analyst ==="
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env --env-file .admin-runtime.env -f docker-compose.yml -f $COMPOSE_OVERRIDE up -d analyst"

echo "=== 5/5 健康检查 ==="
sleep 5

# 检查容器状态
CONTAINER_STATUS=$(ssh "$SSH_HOST" "docker inspect -f '{{.State.Status}}' fengyu-analyst 2>/dev/null" || echo "not_found")
if [[ "$CONTAINER_STATUS" != "running" ]]; then
  echo "❌ 容器未运行 (状态: $CONTAINER_STATUS)" >&2
  echo "查看容器日志:" >&2
  ssh "$SSH_HOST" "docker logs --tail 50 fengyu-analyst 2>&1" || true
  exit 1
fi

echo "  ✓ 容器状态: running"
ssh "$SSH_HOST" "docker ps --filter name=fengyu-analyst --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

# HTTP 健康检查（根路由）
HTTP_STATUS=$(ssh "$SSH_HOST" "curl -sSL -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:$ANALYST_PORT/ 2>/dev/null" || echo "000")
if [[ "$HTTP_STATUS" != "200" && "$HTTP_STATUS" != "307" ]]; then
  echo "❌ HTTP 健康检查失败 (状态码: $HTTP_STATUS)" >&2
  ssh "$SSH_HOST" "docker logs --tail 30 fengyu-analyst 2>&1" || true
  exit 1
fi
echo "  ✓ HTTP 健康检查通过 (状态码: $HTTP_STATUS)"

# API 端点检查
API_STATUS=$(ssh "$SSH_HOST" "curl -sSL -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:$ANALYST_PORT/api/health 2>/dev/null" || echo "000")
if [[ "$API_STATUS" == "200" ]]; then
  echo "  ✓ API 健康检查通过"
elif [[ "$API_STATUS" == "404" ]]; then
  echo "  ⚠ /api/health 端点不存在（可忽略）"
else
  echo "  ⚠ API 健康检查异常 (状态码: $API_STATUS)"
fi

# 环境变量校验
DB_URL=$(ssh "$SSH_HOST" "docker exec fengyu-analyst sh -c 'echo \"\$DATABASE_URL\"'" 2>/dev/null | head -1 || true)
DB_REDACTED=$(node -e "const s=process.argv[1]||'';process.stdout.write(s.replace(/:\/\/[^@]+@/,'://***@'))" "$DB_URL" 2>/dev/null || echo "")
GOT_HOST=$(node -e "const s=process.argv[1]||'';const m=s.match(/@([^:]+):\d+\//);process.stdout.write(m?m[1]:'')" "$DB_URL" 2>/dev/null || echo "")
JWT_LEN=$(ssh "$SSH_HOST" "docker exec fengyu-analyst sh -c 'printf %s \"\${#JWT_SECRET}\"'" 2>/dev/null || true)
ORIGIN=$(ssh "$SSH_HOST" "docker exec fengyu-analyst sh -c 'echo \"\$NEXT_PUBLIC_ANALYST_ORIGIN\"'" 2>/dev/null | head -1 || true)

echo "  DATABASE_URL: ${DB_REDACTED:-not readable}"
echo "  NEXT_PUBLIC_ANALYST_ORIGIN: ${ORIGIN:-not readable}"
echo "  JWT_SECRET length: ${JWT_LEN:-0}"

if [[ "$GOT_HOST" != "$EXPECT_PG_HOST" ]]; then
  echo "Expected DB host $EXPECT_PG_HOST, got ${GOT_HOST:-empty}" >&2
  exit 1
fi
if [[ "$ORIGIN" != "$ANALYST_PUBLIC_ORIGIN" ]]; then
  echo "Expected analyst origin $ANALYST_PUBLIC_ORIGIN, got ${ORIGIN:-empty}" >&2
  exit 1
fi
if [[ -z "$JWT_LEN" || "$JWT_LEN" == "0" ]]; then
  echo "JWT_SECRET is empty in analyst container" >&2
  exit 1
fi

echo ""
echo "部署完成: $ANALYST_PUBLIC_ORIGIN"
