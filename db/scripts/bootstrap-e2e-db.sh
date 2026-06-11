#!/usr/bin/env bash
# ============================================================================
# bootstrap-e2e-db.sh — 建/重置 e2e 独立测试库（默认 fengyu_e2e）
#
# 背景（2026-06-08）：admin e2e 测试原先与开发/staff 测试共用 5434/fengyu，
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

E2E_DB_NAME="${E2E_DB_NAME:-fengyu_e2e}"
PG_BASE="postgresql://fengyu:fengyu123@47.113.202.7:5434"
E2E_URL="$PG_BASE/$E2E_DB_NAME"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADMIN_DIR="$(cd "$DB_DIR/../fengyu-admin" && pwd)"
PSQL() { env -u http_proxy -u https_proxy -u all_proxy psql "$@"; }

echo "[1/4] 建库 ${E2E_DB_NAME}（若不存在；fengyu 用户有 createdb 权限）"
PSQL "$PG_BASE/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname='$E2E_DB_NAME'" | grep -q 1 \
  || PSQL "$PG_BASE/postgres" -c "CREATE DATABASE $E2E_DB_NAME OWNER fengyu;"

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
