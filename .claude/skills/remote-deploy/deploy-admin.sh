#!/bin/bash
# 部署 fengyu-admin 镜像到远程服务器（按 env 自动路由：prod→fengyu-prod / dev→ali-demo），按 env 选择 compose 文件。
#
# Usage:
#   .claude/skills/remote-deploy/deploy-admin.sh <dev|prod> [ssh-host] [remote-dir]
#
# 参数：
#   $1 (required) — dev / prod
#   $2 (optional) — SSH host，默认按 env 自动选择（prod=fengyu-prod / dev=ali-demo），可被 SSH_HOST 环境变量覆盖
#   $3 (optional) — 远程 docker/ 目录绝对路径，默认 /root/proj.xt.com/fengyu-wxapp/docker（ali-demo；fengyu-prod 上路径若不同须显式传入）

set -e

if [[ -z "${1:-}" ]] || [[ ! "$1" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod> [ssh-host] [remote-dir]" >&2
  echo "  $1 must be 'dev' or 'prod'" >&2
  exit 1
fi

ENV="$1"
# SSH host 按环境自动路由（prod→fengyu-prod / dev→ali-demo）；可被第 2 参数或 SSH_HOST 环境变量覆盖
SSH_HOST_DEFAULT=$([[ "$ENV" == "prod" ]] && echo "fengyu-prod" || echo "ali-demo")
SSH_HOST="${SSH_HOST:-${2:-$SSH_HOST_DEFAULT}}"
# 远程 docker/ 目录；可被第 3 参数或 REMOTE_DIR 环境变量覆盖（fengyu-prod 上路径可能不同，首跑确认）
REMOTE_DIR="${REMOTE_DIR:-${3:-/root/proj.xt.com/fengyu-wxapp/docker}}"

# 切到项目根：后续 envs/、db/、docker/ 等相对路径均基于此
cd "$(dirname "$0")/../../.."

# prod 强制确认
if [[ "$ENV" == "prod" ]]; then
  echo "⚠️  About to deploy admin to PROD ($SSH_HOST)"
  echo "    admin 容器将连接 118.178.196.26:5433/fengyu_wxapp（生产业务库）"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# [预检] prod 部署前：5433 生产库迁移必须先于代码上线。
# 复盘（2026-06-24）：admin 先部署了依赖 migration 0069 的 /allocations 页面，
# 但 5433 当时未迁 0069 → 生产 Server Components 报 "column ... does not exist"。
# 本预检比对「本地 journal 总数」vs「5433 已应用数」，落后则列出 pending 并确认后迁移，杜绝该窗口期。
if [[ "$ENV" == "prod" ]]; then
  echo "=== [预检] 5433 生产库迁移状态 ==="
  PROD_DB_URL=$(grep '^ADMIN_DATABASE_URL=' "envs/$ENV.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
  if [[ -z "$PROD_DB_URL" ]]; then
    echo "✗ envs/$ENV.env 缺少 ADMIN_DATABASE_URL，无法预检迁移。" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "✗ 本机未装 psql，无法预检 5433 迁移状态（brew install libpq）。" >&2
    exit 1
  fi

  LOCAL_N=$(node -e 'process.stdout.write(String(require("./db/migrations/meta/_journal.json").entries.length))' 2>/dev/null)
  APPLIED_N=$(psql "$PROD_DB_URL" -tAc "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null | tr -d '[:space:]')

  if [[ -z "$LOCAL_N" || -z "$APPLIED_N" ]]; then
    echo "⚠️  无法读取迁移计数（5433 连不上 / node 或 journal 异常）。"
    read -p "跳过迁移预检、继续部署? (yes=跳过 / 其它=中止): " skip_pc
    [[ "$skip_pc" == "yes" ]] || { echo "Aborted."; exit 1; }
  elif (( APPLIED_N < LOCAL_N )); then
    echo "⚠️  5433 落后：本地 journal $LOCAL_N 个，5433 已应用 $APPLIED_N 个，缺 $((LOCAL_N - APPLIED_N)) 个待迁移："
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
    read -p "对 5433 执行以上迁移、再继续部署? (yes=迁移并继续 / 其它=中止): " mig_confirm
    if [[ "$mig_confirm" == "yes" ]]; then
      ( cd db && DATABASE_URL="$PROD_DB_URL" npm run db:migrate )
      echo "✓ 5433 迁移完成，继续部署。"
    else
      echo "已中止。请手动迁移 5433 后重试。" >&2
      exit 1
    fi
  elif (( APPLIED_N > LOCAL_N )); then
    echo "⚠️  5433 已应用 $APPLIED_N 个 > 本地 journal $LOCAL_N 个：本地代码可能落后（未 pull 最新 migration）。"
    read -p "仍用当前代码继续部署? (yes=继续 / 其它=中止): " ahead_confirm
    [[ "$ahead_confirm" == "yes" ]] || { echo "Aborted."; exit 1; }
  else
    echo "✓ 5433 已是最新（$APPLIED_N 个 migration），无 pending。"
  fi
fi

echo "=== 1/5 本地构建 Docker 镜像（linux/amd64）==="
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
