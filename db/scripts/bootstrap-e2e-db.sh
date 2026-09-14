#!/usr/bin/env bash
# ============================================================================
# bootstrap-e2e-db.sh — 建/重置 e2e 独立测试库（默认 fengyu_e2e）
#
# 背景（2026-06-08）：admin e2e 测试原先与开发/staff 测试共用同一业务库，
# 多个 Claude 会话/worktree 并行跑测试会互相清库（订单/顾客被删），造成雪崩式
# flaky。改为独立库 fengyu_e2e 后彻底隔离：其它会话清 fengyu，不碰 fengyu_e2e。
#
# 用法：
#   bash db/scripts/bootstrap-e2e-db.sh              # 用默认库名 fengyu_e2e
#   E2E_DB_NAME=fengyu_e2e_wt1 bash db/scripts/bootstrap-e2e-db.sh   # 自定义库名（多 worktree 各自隔离）
#
# 用 drizzle-kit push（非 migrate）灌 schema —— 直接 push 最终态，规避 64 个
# migration 从零 replay 时的枚举加值冲突（55P04）。
# ============================================================================
set -euo pipefail

# ⚠️ 自定义库名时，跑测试也必须让 fengyu-admin 的 test:e2e* 用同一个库名：
#    要么同样导出 E2E_DB_NAME（package.json 的默认值已读它），要么显式导出完整 E2E_DATABASE_URL。
#    只建库而不同步库名，测试会连回默认的 fengyu_e2e，隔离形同虚设。
E2E_DB_NAME="${E2E_DB_NAME:-fengyu_e2e}"
# e2e 库与 dev 业务库同机（101.34.242.103:5433，SSH 别名 lx-test）但**不同库**，
# 靠库名 fengyu_e2e 与业务库 fengyu_wxapp 隔离。旧的 ali-demo 47.113.202.7 已于 2026-09-01 全面弃用。
PG_BASE="postgresql://fengyu:fengyu123@101.34.242.103:5433"
E2E_URL="$PG_BASE/$E2E_DB_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADMIN_DIR="$(cd "$DB_DIR/../fengyu-admin" && pwd)"
PSQL() { env -u http_proxy -u https_proxy -u all_proxy psql "$@"; }

# 库名只允许 [a-z0-9_]，避免拼进 psql -c 的 CREATE DATABASE 语句里被截断或构造出畸形库名。
# 注意 `${VAR:-default}` 只对 unset/空串兜底，纯空格视为已设置，故这里显式校验。
if [[ ! "$E2E_DB_NAME" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "✗ E2E_DB_NAME='${E2E_DB_NAME}' 非法：只允许小写字母开头的 [a-z0-9_]。" >&2
  exit 1
fi

echo "[1/4] 建库 ${E2E_DB_NAME}（若不存在）"
# 先看库在不在——DBA 可能已手工建好（`CREATE DATABASE <db> OWNER fengyu;`）。
# 只有确实需要新建时才要求 CREATEDB，避免为了跑一次 e2e 而给业务账号永久建库权限。
if PSQL "$PG_BASE/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname='$E2E_DB_NAME'" | grep -q 1; then
  echo "  ✓ 库已存在，跳过创建"
else
  # ⚠️ 2026-09-14 实测：101.34.242.103:5433 上 fengyu 的 rolcreatedb=false。
  # 旧 e2e 库随 ali-demo 47.113.202.7 一并弃用，新机上尚未建库（见 issue #151 / db/CLAUDE.md）。
  if ! PSQL "$PG_BASE/postgres" -tAc "SELECT rolcreatedb FROM pg_roles WHERE rolname='fengyu'" | grep -q 't'; then
    echo "✗ 库 ${E2E_DB_NAME} 不存在，且 fengyu 角色无 CREATEDB 权限。二选一（由 DBA/superuser 执行）：" >&2
    echo "    a) 直接建库（推荐，不放大权限）：CREATE DATABASE ${E2E_DB_NAME} OWNER fengyu;   -- 在 101.34.242.103:5433" >&2
    echo "    b) 授权后由本脚本自建：ALTER ROLE fengyu CREATEDB;                              -- 在 101.34.242.103:5433" >&2
    exit 1
  fi
  PSQL "$PG_BASE/postgres" -c "CREATE DATABASE $E2E_DB_NAME OWNER fengyu;"
fi

echo "[2/4] push schema 到 ${E2E_DB_NAME}（drizzle-kit push --force）"
( cd "$DB_DIR" && env -u http_proxy -u https_proxy -u all_proxy DATABASE_URL="$E2E_URL" bunx drizzle-kit push --force >/dev/null )

echo "[3/4] seed 测试账号 + FY-FIX/scope/cron 夹具 + 商品域 fixture"
for f in seed-e2e-fixtures seed-fyfix-fixtures seed-fyfix-products seed-fyfix-staff seed-fyfix-config seed-fyfix-service seed-scope-fixtures; do
  PSQL "$E2E_URL" -v ON_ERROR_STOP=1 -f "$ADMIN_DIR/tests/e2e-chains/_helpers/$f.sql" >/dev/null
  echo "    ✓ $f"
done

echo "[4/4] 验证"
echo "    $(PSQL "$E2E_URL" -tAc "SELECT '表='||count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "    $(PSQL "$E2E_URL" -tAc "SELECT '测试账号='||count(*) FROM admin_passwords WHERE employee_id LIKE 'FY-TEST-%'")"
echo "    $(PSQL "$E2E_URL" -tAc "SELECT 'FY-FIX-CLIENT-01='||count(*) FROM client_wechat_users WHERE user_id='FY-FIX-CLIENT-01'")"
echo ""
echo "✓ $E2E_DB_NAME 就绪。跑 e2e 时设 E2E_DATABASE_URL=$E2E_URL"
echo "  例：E2E_DATABASE_URL=$E2E_URL bun run dev   # dev server 连独立库"
echo "      E2E_DATABASE_URL=$E2E_URL bunx playwright test --config=tests/e2e-chains/playwright.manual.config.ts <spec>"
