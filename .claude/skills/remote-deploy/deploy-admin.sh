#!/bin/bash
# 部署 fengyu-admin 镜像到远程服务器（prod→fengyu-prod；dev 默认→ali-demo）。
# 当 dev 部署且当前是拉卡拉入网分支时，自动路由到 101.34.242.103，避免与同事的测试环境冲突。
#
# Usage:
#   .claude/skills/remote-deploy/deploy-admin.sh <dev|prod> [ssh-host] [remote-dir]
#
# 参数：
#   $1 (required) — dev / prod
#   $2 (optional) — SSH host，可被 SSH_HOST 环境变量覆盖
#   $3 (optional) — 远程 docker/ 目录绝对路径，可被 REMOTE_DIR 环境变量覆盖

set -eo pipefail

if [[ -z "${1:-}" ]] || [[ ! "$1" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod> [ssh-host] [remote-dir]" >&2
  echo "  $1 must be 'dev' or 'prod'" >&2
  exit 1
fi

ENV="$1"
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
IS_LAKALA_TEST_TARGET=false
if [[ "$ENV" == "dev" && "$CURRENT_BRANCH" == "feat/lakala-payment-migration" ]]; then
  IS_LAKALA_TEST_TARGET=true
fi

case "$ENV" in
  dev)
    if [[ "$IS_LAKALA_TEST_TARGET" == true ]]; then
      SSH_HOST_DEFAULT="sqlserver101"
      REMOTE_DIR_DEFAULT="/www/wwwroot/fengyu-admin/docker"
      EXPECT_PG_HOST=""
    else
      SSH_HOST_DEFAULT="ali-demo"
      REMOTE_DIR_DEFAULT="/root/proj.xt.com/fengyu-wxapp/docker"
      EXPECT_PG_HOST="47.113.202.7"
    fi
    ;;
  prod) SSH_HOST_DEFAULT="fengyu-prod"; REMOTE_DIR_DEFAULT="/www/wwwroot/fengyu-admin/docker"; EXPECT_PG_HOST="118.178.196.26" ;;
esac
# SSH host 按环境自动路由；可被第 2 参数或 SSH_HOST 环境变量覆盖
SSH_HOST="${SSH_HOST:-${2:-$SSH_HOST_DEFAULT}}"
# 远程 docker/ 目录；可被第 3 参数或 REMOTE_DIR 环境变量覆盖
REMOTE_DIR="${REMOTE_DIR:-${3:-$REMOTE_DIR_DEFAULT}}"

# [预检] SSH_HOST 与 ENV 绑定默认 host 一致性：env/arg 把部署目标覆盖成异环境 host 时
# （典型：shell 残留 export SSH_HOST=fengyu-prod，随后跑 deploy-admin.sh dev），会绕过下方仅看 ENV
# 的 prod confirm 门把镜像推到错环境，且 DB IP 断言在 compose up 之后才跑。此处把"事后补救"提到
# "事前拦截"。显式跨环境部署（如 fengyu-prod 上 remote-dir 不同）时，操作员看清警告后输入 yes 放行。
if [[ "$SSH_HOST" != "$SSH_HOST_DEFAULT" ]]; then
  echo "⚠️  SSH_HOST ($SSH_HOST) ≠ ENV=$ENV 绑定默认 ($SSH_HOST_DEFAULT)。" >&2
  echo "    疑似 shell 残留污染或显式跨环境部署；DB IP 断言仍会在部署后兜底。" >&2
  read -p "Type 'yes' to confirm this target is intentional: " ssh_confirm
  if [[ "$ssh_confirm" != "yes" ]]; then echo "Aborted."; exit 1; fi
fi

# 切到项目根：后续 envs/、db/、docker/ 等相对路径均基于此
cd "$(dirname "$0")/../../.."

read_env_value() {
  local key="$1"
  local value
  value=$(grep -m1 "^${key}=" "envs/$ENV.env" 2>/dev/null | cut -d= -f2- | tr -d '\r"' )
  if [[ -z "$value" ]]; then
    echo "✗ envs/$ENV.env 缺少 $key，无法部署。" >&2
    exit 1
  fi
  printf '%s' "$value"
}

read_remote_env_value() {
  local key="$1"
  local value
  value=$(ssh "$SSH_HOST" "awk -F= -v k='$key' '\$1==k {sub(/^[^=]*=/, \"\"); gsub(/^\"|\"$/, \"\"); print; exit}' '$REMOTE_DIR/.env'" 2>/dev/null | tr -d '\r')
  if [[ -z "$value" ]]; then
    echo "✗ 测试服务器 $REMOTE_DIR/.env 缺少 $key，无法部署。" >&2
    exit 1
  fi
  printf '%s' "$value"
}

check_test_onboarding_runtime() {
  ssh "$SSH_HOST" "REMOTE_ENV_FILE='$REMOTE_DIR/.env' sh -s" <<'EOF'
set -eu
get_env() {
  awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' "$REMOTE_ENV_FILE"
}
for key in LAKALA_ONBOARDING_ENV LAKALA_ONBOARDING_API_BASE LAKALA_ONBOARDING_APPID LAKALA_ONBOARDING_SM4_KEY; do
  test -n "$(get_env "$key")" || { echo "missing:$key" >&2; exit 1; }
done
case "$(get_env LAKALA_ONBOARDING_ENV)" in release|prod|production) ;; *) echo 'invalid:LAKALA_ONBOARDING_ENV' >&2; exit 1;; esac
test "$(get_env LAKALA_ONBOARDING_API_BASE)" = 'https://s2.lakala.com' || { echo 'invalid:LAKALA_ONBOARDING_API_BASE' >&2; exit 1; }
test "$(get_env LAKALA_ONBOARDING_APPID)" != 'OP00000003' || { echo 'invalid:LAKALA_ONBOARDING_APPID' >&2; exit 1; }
EOF
}

# 远程 .env 保存账号密钥等运行期秘密；只传输目标环境的非敏感存储标识，
# 并用独立变量名覆盖 compose 插值，避免误用远程残留的另一环境值。
# 拉卡拉分支的 dev 部署以 101 服务器自己的 .env 为准，避免把配置复制进本机或 Git。
if [[ "$IS_LAKALA_TEST_TARGET" == true ]]; then
  if ! check_test_onboarding_runtime; then
    echo "✗ 测试服务器入网配置校验失败：必须是完整的生产拉卡拉配置，且不得回退到支付 LAKALA_*。" >&2
    exit 1
  fi
  DEPLOY_CLOUDBASE_ENV_ID=$(read_remote_env_value CLOUDBASE_ENV_ID)
  DEPLOY_CDN_BASE=$(read_remote_env_value CDN_BASE)
else
  DEPLOY_CLOUDBASE_ENV_ID=$(read_env_value CLOUDBASE_ENV_ID)
  DEPLOY_CDN_BASE=$(read_env_value CDN_BASE)
fi
RUNTIME_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/fengyu-admin-runtime.XXXXXX")
trap 'rm -f "$RUNTIME_ENV_FILE"' EXIT
printf 'DEPLOY_CLOUDBASE_ENV_ID=%s\nDEPLOY_CDN_BASE=%s\n' \
  "$DEPLOY_CLOUDBASE_ENV_ID" "$DEPLOY_CDN_BASE" > "$RUNTIME_ENV_FILE"
COMPOSE_OVERRIDE="docker-compose.remote.yml"

# prod 强制确认（dev 发 ali-demo 无生产副作用，不打断）
if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  About to deploy admin to PROD ($SSH_HOST)"
  echo "    admin 容器将连接 118.178.196.26:5433/fengyu_wxapp（生产业务库）"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
else
  if [[ "$IS_LAKALA_TEST_TARGET" == true ]]; then
    echo "==> Deploy admin to LAKALA TEST ($SSH_HOST / 101.34.242.103)，远程 .env 与数据库均以测试服务器现有配置为准"
  else
    echo "==> Deploy admin to DEV ($SSH_HOST)，admin 容器将连 47.113.202.7:5433/fengyu_wxapp（测试业务库）"
  fi
fi

# [预检] prod 部署前：生产库迁移必须先于代码上线。
# 复盘（2026-06-24）：admin 先部署了依赖 migration 0069 的 /allocations 页面，
# 但生产库当时未迁 0069 → 生产 Server Components 报 "column ... does not exist"。
# 本预检比对「本地 journal 总数」vs「目标库已应用数」，落后则列出 pending 并确认后迁移，杜绝该窗口期。
# 仅 prod：dev 库迁移属开发流程，发版不自动迁。
if [[ "$ENV" == "prod" ]]; then
  echo "=== [预检] 生产库（$EXPECT_PG_HOST）迁移状态 ==="
  PROD_DB_URL=$(grep '^ADMIN_DATABASE_URL=' "envs/$ENV.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
  if [[ -z "$PROD_DB_URL" ]]; then
    echo "✗ envs/$ENV.env 缺少 ADMIN_DATABASE_URL，无法预检迁移。" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "✗ 本机未装 psql，无法预检迁移状态（brew install libpq）。" >&2
    exit 1
  fi

  LOCAL_N=$(node -e 'process.stdout.write(String(require("./db/migrations/meta/_journal.json").entries.length))' 2>/dev/null)
  APPLIED_N=$(psql "$PROD_DB_URL" -tAc "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "$LOCAL_N" || -z "$APPLIED_N" ]]; then
    echo "⚠️  无法读取迁移计数（目标库连不上 / node 或 journal 异常）。"
    read -p "跳过迁移预检、继续部署? (yes=跳过 / 其它=中止): " skip_pc
    [[ "$skip_pc" == "yes" ]] || { echo "Aborted."; exit 1; }
  elif (( APPLIED_N < LOCAL_N )); then
    echo "⚠️  目标库落后：本地 journal $LOCAL_N 个，已应用 $APPLIED_N 个，缺 $((LOCAL_N - APPLIED_N)) 个待迁移："
    node -e '
      const j = require("./db/migrations/meta/_journal.json");
      const fs = require("fs"), a = +process.argv[1];
      for (const e of j.entries.slice(a)) {
        let d = 0;
        try { d = (fs.readFileSync("db/migrations/" + e.tag + ".sql", "utf8").match(/DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|DROP INDEX|TRUNCATE/gi) || []).length; } catch {}
        console.log("    - " + e.tag + (d ? "   ⚠️ 含 " + d + " 处破坏性语句(DROP/TRUNCATE)" : ""));
      }
    ' "$APPLIED_N"
    # 锁检查：避开 pg_dump 的 AccessExclusive 冻结整表（参考 memory project_migrate_vs_backup_lock）
    LOCKERS=$(psql "$PROD_DB_URL" -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname='fengyu_wxapp' AND pid<>pg_backend_pid() AND (application_name ILIKE '%pg_dump%' OR query ILIKE '%pg_dump%' OR (state='active' AND xact_start IS NOT NULL AND now()-xact_start > interval '30 seconds'))" 2>/dev/null | tr -d '[:space:]')
    if (( ${LOCKERS:-0} > 0 )); then
      echo "    ⚠️  检测到 ${LOCKERS} 个长事务/疑似 pg_dump，迁移可能撞 AccessExclusive 锁，建议稍后再迁。"
    fi
    echo ""
    read -p "对生产库执行以上迁移、再继续部署? (yes=迁移并继续 / 其它=中止): " mig_confirm
    if [[ "$mig_confirm" == "yes" ]]; then
      ( cd db && DATABASE_URL="$PROD_DB_URL" npm run db:migrate )
      echo "✓ 生产库迁移完成，继续部署。"
    else
      echo "已中止。请手动迁移生产库后重试。" >&2
      exit 1
    fi
  elif (( APPLIED_N > LOCAL_N )); then
    echo "⚠️  已应用 $APPLIED_N 个 > 本地 journal $LOCAL_N 个：本地代码可能落后（未 pull 最新 migration）。"
    read -p "仍用当前代码继续部署? (yes=继续 / 其它=中止): " ahead_confirm
    [[ "$ahead_confirm" == "yes" ]] || { echo "Aborted."; exit 1; }
  else
    echo "✓ 生产库已是最新（$APPLIED_N 个 migration），无 pending。"
  fi
fi

echo "=== 1/5 本地构建 Docker 镜像（linux/amd64）==="
APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
echo "版本号: $APP_VERSION${APP_COMMIT:+ · $APP_COMMIT}"
if [[ -n "$EXPECT_PG_HOST" ]]; then
  echo "目标环境: $ENV（admin DB→$EXPECT_PG_HOST:5433）"
else
  echo "目标环境: $ENV（admin DB→测试服务器远程 .env 的 ADMIN_DATABASE_URL）"
fi

# 登录密码 RSA 公钥：NEXT_PUBLIC_ 变量须在「构建期」inline 进客户端 bundle。
# 优先读 envs/$ENV.env；缺失则 fallback envs/prod.env（RSA 密钥对 env 无关，dev/prod 可共用同一对公钥；
# 远程 ADMIN_RSA_PRIVATE_KEY 须与本公钥配对，首跑后用 admin 登录验证）。
# 任一端都缺 RSA_PUB → fail-fast（否则前端 encryptPassword 抛「缺少公钥」，登录不可用）。
extract_pub() {
  local value
  # grep 未命中时返回 1；在 set -e -o pipefail 下不能让它中断后续 fallback。
  value=$(grep '^NEXT_PUBLIC_RSA_PUBLIC_KEY=' "$1" 2>/dev/null | head -1 | cut -d= -f2- || true)
  printf '%s' "$value"
}
if [[ "$IS_LAKALA_TEST_TARGET" == true ]]; then
  RSA_PUB=$(read_remote_env_value NEXT_PUBLIC_RSA_PUBLIC_KEY)
  RSA_SRC="测试服务器 $REMOTE_DIR/.env"
else
  RSA_PUB=$(extract_pub "envs/$ENV.env")
  RSA_SRC="envs/$ENV.env"
fi
if [[ -z "$RSA_PUB" && "$ENV" != "test" ]]; then
  RSA_PUB=$(extract_pub "envs/prod.env")
  RSA_SRC="envs/prod.env（fallback：envs/$ENV.env 未配 NEXT_PUBLIC_RSA_PUBLIC_KEY）"
fi
if [[ -z "$RSA_PUB" ]]; then
  echo "✗ envs/$ENV.env 与 envs/prod.env 均缺少 NEXT_PUBLIC_RSA_PUBLIC_KEY，登录会挂。请先配置 RSA 密钥对。" >&2
  exit 1
fi
echo "  RSA 公钥来源: $RSA_SRC"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg APP_COMMIT="$APP_COMMIT" \
  --build-arg NEXT_PUBLIC_RSA_PUBLIC_KEY="$RSA_PUB" \
  -f docker/Dockerfile.admin -t fengyu-admin:latest .

echo "=== 2/5 传输镜像到 $SSH_HOST ==="
docker save fengyu-admin:latest | gzip | ssh "$SSH_HOST" "docker load"

echo "=== 3/5 同步 docker-compose 文件和环境覆盖（base + remote override）==="
# remote override 让 admin 连远程 PG 5433、注入 JWT/RSA 私钥、禁用本地 postgres 容器。
# CloudBase 标识从 envs/$ENV.env 生成 .admin-runtime.env，不能复用远程 .env 的残留值。
scp docker/docker-compose.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"
scp "docker/$COMPOSE_OVERRIDE" "$SSH_HOST:$REMOTE_DIR/$COMPOSE_OVERRIDE"
scp "$RUNTIME_ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.admin-runtime.env"
ssh "$SSH_HOST" "chmod 600 '$REMOTE_DIR/.admin-runtime.env'"
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env --env-file .admin-runtime.env -f docker-compose.yml -f $COMPOSE_OVERRIDE config --quiet" || { echo "✗ Compose 配置校验失败，请检查 .admin-runtime.env 必填变量"; exit 1; }
echo "  ✓ 已同步 docker-compose.yml + $COMPOSE_OVERRIDE + .admin-runtime.env"

echo "=== 4/5 远程重启服务（base + override）==="
# cron-worker 日志挂载卷（容器内 uid=1001 nextjs 才能写入；目录不存在 docker 会以 root 自建并越权）
if ! ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR/logs/cron-worker' '$REMOTE_DIR/logs/export-worker' && chown -R 1001:1001 '$REMOTE_DIR/logs/cron-worker' '$REMOTE_DIR/logs/export-worker'"; then
  echo "  当前 SSH 用户无日志目录写权限，尝试 sudo 修复既有目录归属。"
  ssh "$SSH_HOST" "sudo mkdir -p '$REMOTE_DIR/logs/cron-worker' '$REMOTE_DIR/logs/export-worker' && sudo chown -R 1001:1001 '$REMOTE_DIR/logs/cron-worker' '$REMOTE_DIR/logs/export-worker'"
fi
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env --env-file .admin-runtime.env -f docker-compose.yml -f $COMPOSE_OVERRIDE up -d admin cron-worker export-worker"

echo "=== 5/5 健康检查 + DB 连接验证 ==="
sleep 5
ssh "$SSH_HOST" "curl -sf http://localhost:3000/ > /dev/null && echo '✓ HTTP 健康检查通过' || echo '✗ HTTP 健康检查失败'"
DB_URL=$(ssh "$SSH_HOST" "docker exec fengyu-admin sh -c 'echo \"\$DATABASE_URL\"'" 2>/dev/null | head -1 || true)
# 脱敏回显（隐藏 user:pass，保留 host:port/db 可见）+ 提取 host 做 IP 断言
DB_REDACTED=$(node -e "const s=process.argv[1]||'';process.stdout.write(s.replace(/:\/\/[^@]+@/,'://***@'))" "$DB_URL" 2>/dev/null || echo "")
echo "  DATABASE_URL: ${DB_REDACTED:-（无法读取，admin 容器可能未就绪）}"
GOT_HOST=$(node -e "const s=process.argv[1]||'';const m=s.match(/@([^:]+):\d+\//);process.stdout.write(m?m[1]:'')" "$DB_URL" 2>/dev/null || echo "")
if [[ -z "$GOT_HOST" ]]; then
  echo "  ⚠️  无法提取 DB host（容器未就绪？），跳过 IP 断言——请手动核对 DATABASE_URL。" >&2
elif [[ "$IS_LAKALA_TEST_TARGET" == true ]]; then
  echo "  ✓ admin DB host=$GOT_HOST（拉卡拉测试服务器远程 .env 配置）"
elif [[ "$GOT_HOST" == "$EXPECT_PG_HOST" ]]; then
  echo "  ✓ admin DB host=$GOT_HOST 与 $ENV 一致"
elif [[ "$GOT_HOST" =~ ^(172\.(1[6-9]|2[0-9]|3[01])\.|10\.|192\.168\.) ]]; then
  # GOT_HOST 是私网/Docker 网桥地址（prod 同机架构：admin 容器经网桥回连同机宿主裸机 PG）。
  # 验证网桥确实回连到 EXPECT_PG_HOST 对应宿主：宿主公网 IP 匹配 + PG 在宿主 5433 监听。
  HOST_PUBLIC_IP=$(ssh "$SSH_HOST" "curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ip.sb 2>/dev/null" 2>/dev/null | head -1 || true)
  PG_LISTENING=$(ssh "$SSH_HOST" "ss -tlnp 2>/dev/null | grep -q ':5433' && echo yes || echo no" 2>/dev/null || echo "")
  if [[ "$HOST_PUBLIC_IP" == "$EXPECT_PG_HOST" && "$PG_LISTENING" == "yes" ]]; then
    echo "  ✓ admin DB host=$GOT_HOST（Docker 网桥回连同机宿主裸机 PG；宿主公网=$HOST_PUBLIC_IP==$EXPECT_PG_HOST，PG 监听 5433）"
  else
    echo "✗ 远程 admin DB host=$GOT_HOST（私网网桥）但宿主公网=$HOST_PUBLIC_IP、PG 监听 5433=$PG_LISTENING，与 $ENV 期望 $EXPECT_PG_HOST 不符（疑似跨环境污染）。" >&2
    echo "  回滚：docker tag fengyu-admin:<old-tag> fengyu-admin:latest 后重新部署" >&2
    exit 1
  fi
else
  echo "✗ 远程 admin DB host=$GOT_HOST ≠ $ENV 期望 $EXPECT_PG_HOST（疑似跨环境污染）。" >&2
  echo "  回滚：docker tag fengyu-admin:<old-tag> fengyu-admin:latest 后重新部署" >&2
  exit 1
fi

verify_cloudbase_runtime() {
  local container="$1"
  local actual
  actual=$(ssh "$SSH_HOST" "docker exec $container sh -c 'printf \"%s|%s\" \"\$CLOUDBASE_ENV_ID\" \"\$CDN_BASE\"'" 2>/dev/null || true)
  if [[ "$actual" != "$DEPLOY_CLOUDBASE_ENV_ID|$DEPLOY_CDN_BASE" ]]; then
    echo "✗ $container CloudBase 配置与 $ENV 不一致：$actual" >&2
    echo "  期望：$DEPLOY_CLOUDBASE_ENV_ID|$DEPLOY_CDN_BASE" >&2
    exit 1
  fi
  echo "  ✓ $container CloudBase 配置与 $ENV 一致"
}

verify_cloudbase_runtime fengyu-admin
verify_cloudbase_runtime fengyu-export-worker

echo ""
echo "部署完成（env=$ENV）。"
echo ""
echo "下一步验证（必查）："
echo "  1. ssh $SSH_HOST 'docker exec fengyu-admin env | grep DATABASE_URL'   # 应为目标环境业务库"
echo "  2. ssh $SSH_HOST 'docker exec fengyu-admin env | grep CLOUDBASE_ENV_ID' # 应为 $DEPLOY_CLOUDBASE_ENV_ID"
echo "  3. ssh $SSH_HOST 'docker logs fengyu-admin --tail 50'                  # 看启动是否正常"
echo "  4. 浏览器打开 admin 域名 → 用初始账号登录验证（含 RSA 密码解密）"
echo ""
echo "回滚：docker tag fengyu-admin:<old-tag> fengyu-admin:latest 后重新部署"
