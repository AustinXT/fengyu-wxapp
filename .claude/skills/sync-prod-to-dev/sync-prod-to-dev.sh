#!/usr/bin/env bash
# ============================================================================
# sync-prod-to-dev.sh — 用生产库数据覆盖开发/测试库
#
# 来源 prod : envs/prod.env  PG_CONNECTION_STRING  → 118.178.196.26:5433
# 目标 dev  : envs/dev.env   PG_CONNECTION_STRING  → 101.34.242.103:5433（2026-09-10 从 47.113.202.7 迁入）
#
# 流程：在 prod 服务器原地 dump（排除无 SELECT 权限的外部表如 codex_*）→
#       yes 二次确认 → 通过 SSH 流式传输给 pg_restore（本地不落盘）覆盖 dev →
#       关键表行数校验。dump 产物仅保留在 prod 服务器 /www/backup/fengyu-postgres/。
#
# ⚠ 破坏性：dev 现有数据全部丢失，不可恢复。仅手动触发，restore 前强制二次确认。
#
# 用法：
#   bash .claude/skills/sync-prod-to-dev/sync-prod-to-dev.sh
#
# 环境变量：
#   PG_RESTORE_BIN pg_restore 路径（默认自动探测 postgresql@16）
#   SKIP_CONFIRM=1 跳过二次确认（CI 等，不建议日常用）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # .claude/skills/sync-prod-to-dev → repo root
PROD_ENV="$REPO_ROOT/envs/prod.env"
DEV_ENV="$REPO_ROOT/envs/dev.env"
PROD_SSH_HOST="lx-prod"
PROD_PUBLIC_HOST="118.178.196.26"
REMOTE_ENV_FILE="/www/wwwroot/fengyu-admin/docker/.env"
REMOTE_OUT_DIR="/www/backup/fengyu-postgres"

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
# 本脚本是破坏性的（prod 数据覆盖 dev），断言必须精确：
#   - 不能只用「字符串包含 IP」——IP 可能出现在密码或 query 里，形成假通过；
#   - 必须同时校验 host/port/dbname，并拒绝 libpq 的目标覆盖参数
#     （`?host=` 等会覆盖 authority，实测能让所有表面校验全绿却连到另一台机）。
assert_pg_target() {  # $1=连接串  $2=期望 host  $3=角色描述
  node -e '
    const [s, expectHost, role] = process.argv.slice(1)
    let u
    try { u = new URL(s) } catch { console.error(`✗ ${role} 连接串无法解析为 URL`); process.exit(1) }
    const errs = []
    if (!["postgres:", "postgresql:"].includes(u.protocol)) errs.push(`protocol=${u.protocol}`)
    if (u.hostname !== expectHost) errs.push(`host=${u.hostname} ≠ ${expectHost}`)
    if (u.port !== "5433") errs.push(`port=${u.port || "(空)"} ≠ 5433`)
    if (u.pathname !== "/fengyu_wxapp") errs.push(`dbname=${u.pathname || "(空)"} ≠ /fengyu_wxapp`)
    const ov = ["host","hostaddr","port","dbname","database","options","service","passfile"].filter((k) => u.searchParams.has(k))
    if (ov.length) errs.push(`query 试图覆盖连接目标：${ov.join(",")}`)
    if (errs.length) { console.error(`✗ ${role} 目标校验失败：${errs.join("；")}`); process.exit(1) }
  ' "$1" "$2" "$3"
}
assert_pg_target "$PROD_CS" "118.178.196.26" "prod（来源）" || {
  echo "  目标：$(mask "$PROD_CS")" >&2; exit 1; }
assert_pg_target "$DEV_CS" "101.34.242.103" "dev（覆盖目标）" || {
  echo "${RED}  拒绝执行，防反向覆盖${RST}" >&2; echo "  目标：$(mask "$DEV_CS")" >&2; exit 1; }
[ "$PROD_CS" != "$DEV_CS" ] || { echo "${RED}✗ prod 与 dev 连接串相同，拒绝执行${RST}" >&2; exit 1; }

echo "${GRN}• 来源 prod : $(mask "$PROD_CS")${RST}"
echo "${GRN}• 目标 dev  : $(mask "$DEV_CS")${RST}"

# --- 本地只需 pg_restore；dump 在 prod 服务器执行 ---
if [ -z "${PG_RESTORE_BIN:-}" ]; then
  for c in /opt/homebrew/opt/postgresql@16/bin/pg_restore /usr/local/opt/postgresql@16/bin/pg_restore; do
    [ -x "$c" ] && PG_RESTORE_BIN="$c" && break
  done
fi
[ -x "${PG_RESTORE_BIN:-}" ] || PG_RESTORE_BIN="$(command -v pg_restore || true)"
[ -x "${PG_RESTORE_BIN:-}" ] || { echo "${RED}✗ 未找到 pg_restore16；brew install postgresql@16 或设 PG_RESTORE_BIN${RST}" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "${RED}✗ 未找到 ssh${RST}" >&2; exit 1; }

# SSH 别名必须直指 prod 公网 IP，禁止把敏感 dump 写到其它主机。
SSH_RESOLVED_HOST="$(ssh -G "$PROD_SSH_HOST" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')"
[ "$SSH_RESOLVED_HOST" = "$PROD_PUBLIC_HOST" ] || {
  echo "${RED}✗ SSH 目标校验失败：$PROD_SSH_HOST 解析为 ${SSH_RESOLVED_HOST:-空}，期望 $PROD_PUBLIC_HOST${RST}" >&2
  exit 1
}

# --- 连通性 + 版本校验（prod） ---
CLIENT_MAJOR="$("$PG_RESTORE_BIN" --version | grep -oE '[0-9]+' | head -1)"
SERVER_VER="$(run_untainted psql "$PROD_CS" -tAc 'SHOW server_version;' 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$SERVER_VER" ] || { echo "${RED}✗ 无法连接生产库；检查网络/代理/连接串${RST}" >&2; exit 1; }
SERVER_MAJOR="${SERVER_VER%%.*}"
[ "$CLIENT_MAJOR" -ge "$SERVER_MAJOR" ] || { echo "${RED}✗ 版本不匹配：pg_restore=${CLIENT_MAJOR} < 服务端=${SERVER_MAJOR}${RST}" >&2; exit 1; }
echo "• 本地 pg_restore $CLIENT_MAJOR / 服务端 $SERVER_MAJOR ✓"

# --- [1/4] 在 prod 服务器原地 dump，本地不落盘 ---
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$REMOTE_OUT_DIR/fengyu_wxapp_prod_${TS}.dump"
echo "${GRN}[1/4] 在 prod 服务器导出 → $PROD_SSH_HOST:$OUT${RST}"
run_untainted ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH_HOST" bash -s -- \
  "$REMOTE_ENV_FILE" "$OUT" "$PROD_PUBLIC_HOST" <<'REMOTE_DUMP'
set -euo pipefail
env_file="$1"
out="$2"
expect_host="$3"
out_dir="$(dirname "$out")"
tmp="${out}.tmp.$$"
checksum_tmp="${out}.sha256.tmp.$$"
trap 'rm -f "$tmp" "$checksum_tmp"' EXIT
umask 077

[ -f "$env_file" ] || { echo "✗ 找不到生产环境文件：$env_file" >&2; exit 1; }
[ "$(stat -c '%a' "$env_file")" = "600" ] || { echo "✗ 生产环境文件权限必须为 600" >&2; exit 1; }
prod_cs="$(grep -E '^ADMIN_DATABASE_URL=' "$env_file" | head -1 | cut -d= -f2-)"
prod_cs="${prod_cs//\"/}"; prod_cs="${prod_cs//\'/}"
[ -n "$prod_cs" ] || { echo "✗ $env_file 中未找到 ADMIN_DATABASE_URL" >&2; exit 1; }

python3 - "$prod_cs" "$expect_host" <<'PY'
import sys
from urllib.parse import urlparse, parse_qs

raw, expected_host = sys.argv[1:]
url = urlparse(raw)
errors = []
if url.scheme not in {"postgres", "postgresql"}:
    errors.append(f"protocol={url.scheme}")
if url.hostname != expected_host:
    errors.append(f"host={url.hostname} != {expected_host}")
if url.port != 5433:
    errors.append(f"port={url.port} != 5433")
if url.path != "/fengyu_wxapp":
    errors.append(f"dbname={url.path} != /fengyu_wxapp")
overrides = sorted(set(parse_qs(url.query)) & {"host", "hostaddr", "port", "dbname", "database", "options", "service", "passfile"})
if overrides:
    errors.append("query 试图覆盖连接目标：" + ",".join(overrides))
if errors:
    raise SystemExit("✗ prod 服务器连接目标校验失败：" + "；".join(errors))
PY

for tool in pg_dump pg_restore psql sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ prod 服务器缺少 $tool" >&2; exit 1; }
done
client_major="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
server_ver="$(psql "$prod_cs" -tAc 'SHOW server_version;' | tr -d '[:space:]')"
server_major="${server_ver%%.*}"
[ "$client_major" -ge "$server_major" ] || { echo "✗ prod 服务器 pg_dump=$client_major < 数据库=$server_major" >&2; exit 1; }
echo "    • prod 服务器 pg_dump $client_major / 数据库 $server_major ✓"

# 动态排除当前用户无 SELECT 权限的外部表，避免全库 dump 失败。
no_perm="$(psql "$prod_cs" -tAc "
  SELECT schemaname||'.'||tablename FROM pg_tables
  WHERE schemaname='public'
    AND NOT has_table_privilege(current_user, schemaname||'.'||tablename, 'SELECT');")"
exclude_flags=()
if [ -n "$no_perm" ]; then
  while IFS= read -r table_name; do
    [ -n "$table_name" ] && exclude_flags+=(--exclude-table="$table_name")
  done <<< "$no_perm"
  echo "    • 排除 ${#exclude_flags[@]} 个无 SELECT 权限表"
fi

mkdir -p "$out_dir"
chmod 700 "$out_dir"
[ ! -e "$out" ] && [ ! -e "${out}.sha256" ] || { echo "✗ 远端备份文件已存在，拒绝覆盖：$out" >&2; exit 1; }
pg_dump -Fc "${exclude_flags[@]+"${exclude_flags[@]}"}" -f "$tmp" "$prod_cs"
[ -s "$tmp" ] || { echo "✗ dump 产物为空（0B）" >&2; exit 1; }
entries="$(pg_restore --list "$tmp" | grep -cE '^[0-9]+;' || true)"
data_tables="$(pg_restore --list "$tmp" | grep -cE ' TABLE DATA ' || true)"
hash="$(sha256sum "$tmp" | awk '{print $1}')"
mv "$tmp" "$out"
printf '%s  %s\n' "$hash" "$(basename "$out")" > "$checksum_tmp"
mv "$checksum_tmp" "${out}.sha256"
chmod 600 "$out" "${out}.sha256"
echo "    ✓ 体积 $(du -h "$out" | awk '{print $1}')"
echo "    ✓ TOC ${entries} 条目，含数据表 ${data_tables} 张"
echo "    ✓ SHA-256 校验文件 ${out}.sha256"
REMOTE_DUMP

# --- [2/4] 二次确认 ---
echo ""
echo "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
echo "${RED}⚠  即将用 prod 数据覆盖 dev 库（101.34.242.103:5433/fengyu_wxapp）${RST}"
echo "${RED}⚠  dev 现有数据（含开发中手造数据）将全部丢失，不可恢复！${RST}"
echo "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
if [ "${SKIP_CONFIRM:-0}" != "1" ]; then
  printf '%s输入 yes 继续，其它任意键取消: ' "${YEL}"
  read -r ANSWER
  [ "$ANSWER" = "yes" ] || { echo "已取消，dev 未改动。"; exit 0; }
fi

# --- [3/4] restore（先断开 dev 活跃连接，避免 schema 重建时卡锁） ---
echo "${GRN}[3/4] 覆盖 dev（pg_restore --clean --no-owner --no-acl）${RST}"
echo "${DIM}    校验 prod 服务器远端 dump...${RST}"
REMOTE_OUT_BASE="$(basename "$OUT")"
run_untainted ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH_HOST" \
  "cd '$REMOTE_OUT_DIR' && sha256sum -c '${REMOTE_OUT_BASE}.sha256'" >/dev/null
echo "${DIM}    断开 dev 其它活跃连接...${RST}"
run_untainted psql "$DEV_CS" -tAc "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname=current_database() AND pid<>pg_backend_pid();" >/dev/null 2>&1 \
  || echo "${DIM}    (terminate 跳过：权限不足或无其它连接)${RST}"

echo "${DIM}    重建 dev 业务 schema（public、drizzle）...${RST}"
run_untainted psql "$DEV_CS" -v ON_ERROR_STOP=1 -c '
  DROP SCHEMA IF EXISTS drizzle CASCADE;
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
' >/dev/null

RESTORE_LOG="$(mktemp)"
set +e
{ run_untainted ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH_HOST" "cat -- '$OUT'"; } 2>>"$RESTORE_LOG" \
  | run_untainted "$PG_RESTORE_BIN" --clean --if-exists --no-owner --no-acl -d "$DEV_CS" >>"$RESTORE_LOG" 2>&1
PIPE_RC=("${PIPESTATUS[@]}")
set -e
SSH_RC="${PIPE_RC[0]}"
RC="${PIPE_RC[1]}"
if [ "$SSH_RC" -ne 0 ]; then
  echo "${RED}✗ 从 prod 服务器流式读取 dump 失败（ssh 退出码 $SSH_RC）${RST}" >&2
  tail -15 "$RESTORE_LOG" | sed 's/^/      /' >&2 || true
  rm -f "$RESTORE_LOG"
  exit 1
fi
if [ "$RC" -ne 0 ]; then
  echo "${YEL}    pg_restore 退出码 ${RC}（--clean 常伴非致命 warning，以行数校验为准）${RST}"
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
echo "  dump 备份仅保留在 prod 服务器：$PROD_SSH_HOST:$OUT"
echo "  本地未落盘 dump"
if [ "$ALL_OK" -eq 1 ]; then
  echo "  dev 已是 prod 快照（行数校验全绿）"
else
  echo "${YEL}  ⚠ 行数校验有不一致，请人工核查上方对比表${RST}"
fi
