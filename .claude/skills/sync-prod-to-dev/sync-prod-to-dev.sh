#!/usr/bin/env bash
# ============================================================================
# sync-prod-to-dev.sh — 用生产库数据覆盖开发/测试库
#
# 来源 prod : envs/prod.env  PG_CONNECTION_STRING  → 118.178.196.26:5433
# 目标 dev  : envs/dev.env   PG_CONNECTION_STRING  → 47.113.202.7:5433
#
# 流程：dump prod（排除无 SELECT 权限的外部表如 codex_*）→ yes 二次确认 →
#       pg_restore --clean --if-exists --no-owner --no-acl 覆盖 dev → 关键表行数校验。
# dump 产物落 ~/backups/fengyu/（项目外，保留作每日备份）。
#
# ⚠ 破坏性：dev 现有数据全部丢失，不可恢复。仅手动触发，restore 前强制二次确认。
#
# 用法：
#   bash .claude/skills/sync-prod-to-dev/sync-prod-to-dev.sh
#
# 环境变量：
#   OUT_DIR        dump 输出目录（默认 ~/backups/fengyu）
#   PG_DUMP_BIN    pg_dump 路径（默认自动探测 postgresql@16）
#   SKIP_CONFIRM=1 跳过二次确认（CI 等，不建议日常用）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # .claude/skills/sync-prod-to-dev → repo root
PROD_ENV="$REPO_ROOT/envs/prod.env"
DEV_ENV="$REPO_ROOT/envs/dev.env"
OUT_DIR="${OUT_DIR:-$HOME/backups/fengyu}"

if [ -t 1 ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
  RED=''; YEL=''; GRN=''; DIM=''; RST=''
fi

# 代理绕过（本机代理会致远程 PG TLS 失败，见 memory project_tcb_deploy_proxy_tls）
run_untainted() { env -u http_proxy -u https_proxy -u all_proxy "$@"; }
mask() { printf '%s' "$1" | sed -E 's#://[^:]+:[^@]+@#://***@#'; }

# --- 读连接串（不硬编码密码，从 envs/*.env 取权威值） ---
read_cs() {
  local envf="$1"
  [ -f "$envf" ] || { echo "${RED}✗ 找不到 $envf${RST}" >&2; exit 1; }
  local raw; raw="$(grep -E '^PG_CONNECTION_STRING=' "$envf" | head -1 | cut -d= -f2-)"
  raw="${raw//\"/}"; raw="${raw//\'/}"
  [ -n "$raw" ] || { echo "${RED}✗ $envf 中未找到 PG_CONNECTION_STRING${RST}" >&2; exit 1; }
  printf '%s' "$raw"
}
PROD_CS="$(read_cs "$PROD_ENV")"
DEV_CS="$(read_cs "$DEV_ENV")"

# --- 双向防误连校验（防反向把 dev 灌进 prod / 防连错库） ---
case "$PROD_CS" in *"118.178.196.26"*) : ;; *)
  echo "${RED}✗ prod 连接串未指向生产库 118.178.196.26，拒绝执行${RST}" >&2
  echo "  目标：$(mask "$PROD_CS")" >&2; exit 1 ;; esac
case "$DEV_CS" in *"47.113.202.7"*) : ;; *)
  echo "${RED}✗ dev 连接串未指向开发库 47.113.202.7，拒绝执行（防反向覆盖）${RST}" >&2
  echo "  目标：$(mask "$DEV_CS")" >&2; exit 1 ;; esac
[ "$PROD_CS" != "$DEV_CS" ] || { echo "${RED}✗ prod 与 dev 连接串相同，拒绝执行${RST}" >&2; exit 1; }

echo "${GRN}• 来源 prod : $(mask "$PROD_CS")${RST}"
echo "${GRN}• 目标 dev  : $(mask "$DEV_CS")${RST}"

# --- 探测 pg_dump16 / pg_restore16（pg_dump major 须 ≥ 服务端） ---
if [ -z "${PG_DUMP_BIN:-}" ]; then
  for c in /opt/homebrew/opt/postgresql@16/bin/pg_dump /usr/local/opt/postgresql@16/bin/pg_dump; do
    [ -x "$c" ] && PG_DUMP_BIN="$c" && break
  done
fi
[ -x "${PG_DUMP_BIN:-}" ] || { echo "${RED}✗ 未找到 pg_dump16；brew install postgresql@16 或设 PG_DUMP_BIN${RST}" >&2; exit 1; }
PG_RESTORE_BIN="${PG_DUMP_BIN%/pg_dump}/pg_restore"
[ -x "$PG_RESTORE_BIN" ] || PG_RESTORE_BIN="$(command -v pg_restore || true)"
[ -x "${PG_RESTORE_BIN:-}" ] || { echo "${RED}✗ 未找到 pg_restore${RST}" >&2; exit 1; }

# --- 连通性 + 版本校验（prod） ---
CLIENT_MAJOR="$("$PG_DUMP_BIN" --version | grep -oE '[0-9]+' | head -1)"
SERVER_VER="$(run_untainted psql "$PROD_CS" -tAc 'SHOW server_version;' 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$SERVER_VER" ] || { echo "${RED}✗ 无法连接生产库；检查网络/代理/连接串${RST}" >&2; exit 1; }
SERVER_MAJOR="${SERVER_VER%%.*}"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] || { echo "${RED}✗ 版本不匹配：pg_dump=${CLIENT_MAJOR} < 服务端=${SERVER_MAJOR}${RST}" >&2; exit 1; }
echo "• pg_dump $CLIENT_MAJOR / 服务端 $SERVER_MAJOR ✓"

# --- 动态探测 prod 无 SELECT 权限的表（如 codex_* 外部备份表），dump 时排除 ---
#     解决 memory project-dump-prod-codex-backup-permission：无权限表致 pg_dump 全库失败、产物 0B
NO_PERM="$(run_untainted psql "$PROD_CS" -tAc "
  SELECT schemaname||'.'||tablename FROM pg_tables
  WHERE schemaname='public'
    AND NOT has_table_privilege(current_user, schemaname||'.'||tablename, 'SELECT');" 2>/dev/null || true)"
EXCLUDE_FLAGS=()
if [ -n "$NO_PERM" ]; then
  while IFS= read -r t; do
    [ -n "$t" ] && EXCLUDE_FLAGS+=(--exclude-table="$t")
  done <<< "$NO_PERM"
  echo "${YEL}• 检测到 ${#EXCLUDE_FLAGS[@]} 个无 SELECT 权限表，dump 时排除：${RST}"
  printf '    - %s\n' "${EXCLUDE_FLAGS[@]#--exclude-table=}"
fi

# --- [1/4] dump prod ---
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/fengyu_wxapp_prod_${TS}.dump"
echo "${GRN}[1/4] 导出 prod → $OUT${RST}"
run_untainted "$PG_DUMP_BIN" -Fc "${EXCLUDE_FLAGS[@]+"${EXCLUDE_FLAGS[@]}"}" -f "$OUT" "$PROD_CS"
echo "    ✓ 体积 $(ls -lh "$OUT" | awk '{print $5}')"
ENTRIES="$(run_untainted "$PG_RESTORE_BIN" --list "$OUT" 2>/dev/null | grep -cE '^[0-9]+;' || true)"
DATATBL="$(run_untainted "$PG_RESTORE_BIN" --list "$OUT" 2>/dev/null | grep -cE ' TABLE DATA ' || true)"
echo "    ✓ TOC ${ENTRIES} 条目，含数据表 ${DATATBL} 张"
[ -s "$OUT" ] || { echo "${RED}✗ dump 产物为空（0B），疑似导出失败${RST}" >&2; exit 1; }

# --- [2/4] 二次确认 ---
echo ""
echo "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
echo "${RED}⚠  即将用 prod 数据覆盖 dev 库（47.113.202.7:5433/fengyu_wxapp）${RST}"
echo "${RED}⚠  dev 现有数据（含开发中手造数据）将全部丢失，不可恢复！${RST}"
echo "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
if [ "${SKIP_CONFIRM:-0}" != "1" ]; then
  printf '%s输入 yes 继续，其它任意键取消: ' "${YEL}"
  read -r ANSWER
  [ "$ANSWER" = "yes" ] || { echo "已取消，dev 未改动。"; exit 0; }
fi

# --- [3/4] restore（先断开 dev 活跃连接，避免 --clean drop 时卡锁） ---
echo "${GRN}[3/4] 覆盖 dev（pg_restore --clean --no-owner --no-acl）${RST}"
echo "${DIM}    断开 dev 其它活跃连接...${RST}"
run_untainted psql "$DEV_CS" -tAc "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname=current_database() AND pid<>pg_backend_pid();" >/dev/null 2>&1 \
  || echo "${DIM}    (terminate 跳过：权限不足或无其它连接)${RST}"

RESTORE_LOG="$(mktemp)"
set +e
run_untainted "$PG_RESTORE_BIN" --clean --if-exists --no-owner --no-acl -d "$DEV_CS" "$OUT" >"$RESTORE_LOG" 2>&1
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "${YEL}    pg_restore 退出码 $RC（--clean 常伴非致命 warning，以行数校验为准）${RST}"
  grep -iE 'error|fatal' "$RESTORE_LOG" | grep -ivE 'errors ignored|does not exist|already exists' \
    | head -15 | sed 's/^/      /' || true
fi
rm -f "$RESTORE_LOG"

# --- [4/4] 关键表行数校验 ---
echo "${GRN}[4/4] prod / dev 关键表行数对比${RST}"
printf '    %-26s %10s %10s\n' "表" "prod" "dev"
ALL_OK=1
for t in sale_orders sale_items client_wechat_users service_orders prepaid_cards; do
  PC="$(run_untainted psql "$PROD_CS" -tAc "SELECT count(*) FROM $t;" 2>/dev/null | tr -d '[:space:]' || echo '?')"
  DC="$(run_untainted psql "$DEV_CS"  -tAc "SELECT count(*) FROM $t;" 2>/dev/null | tr -d '[:space:]' || echo '?')"
  if [ "$PC" = "$DC" ] && [ "$PC" != "?" ]; then
    printf '    %-26s %10s %10s  %s\n' "$t" "$PC" "$DC" "${GRN}✓${RST}"
  else
    printf '    %-26s %10s %10s  %s\n' "$t" "$PC" "$DC" "${RED}✗${RST}"; ALL_OK=0
  fi
done

echo ""
echo "${GRN}✓ 同步完成${RST}"
echo "  dump 备份保留：$OUT"
if [ $ALL_OK -eq 1 ]; then
  echo "  dev 已是 prod 快照（行数校验全绿）"
else
  echo "${YEL}  ⚠ 行数校验有不一致，请人工核查上方对比表${RST}"
fi
