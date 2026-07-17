#!/usr/bin/env bash
# ============================================================================
# dump-prod.sh — 导出生产业务库 (5433/fengyu_wxapp) 为 custom-format dump
#
# 背景：项目此前无现成导出脚本；生产库 118.178.196.26:5433/fengyu_wxapp (PG 16，fengyu-prod 服务器)。
# 本脚本封装 pg_dump，连接串从 envs/prod.env 读取（权威来源，不硬编码密码），
# 产物带时间戳落到 ~/backups/fengyu/（项目外 —— .gitignore 不覆盖 .dump，
# 放项目外彻底避免顾客/支付等敏感数据误入 git）。
#
# 用法：
#   bash db/scripts/dump-prod.sh                                # 全库导出 (custom format)
#   bash db/scripts/dump-prod.sh -t sale_orders -t sale_items   # 仅指定表（可重复 -t）
#   bash db/scripts/dump-prod.sh -F plain                       # 纯 SQL 文本（默认 c=二进制 .dump）
#   OUT_DIR=/tmp bash db/scripts/dump-prod.sh                   # 自定义输出目录
#
# 选项：
#   -t TABLE   仅导出指定表（可重复，语义同 pg_dump -t，支持通配符如 -t 'sale_%'）
#   -F FORMAT  c=custom 二进制 .dump（默认）| plain=纯 SQL 文本 .sql
#   -o DIR     输出目录（同 OUT_DIR 环境变量）
#   -h         帮助
#
# 环境变量：
#   OUT_DIR              输出目录（默认 ~/backups/fengyu）
#   PG_DUMP_BIN          pg_dump 路径（默认自动探测本地 postgresql@16）
#   DUMP_LABEL           文件名前缀（默认 fengyu_wxapp_prod）
#   PG_CONNECTION_STRING 覆盖 envs/prod.env（默认从中读取；慎用）
#
# 安全：连接串全程不回显；pg_dump 持 AccessShareLock，不阻塞业务读写，但执行期间
#       避免跑 db:migrate（DDL 会与 dump 锁冲突）。产物含敏感数据，勿入 git、勿外发。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_ENV="$SCRIPT_DIR/../../envs/prod.env"

OUT_DIR="${OUT_DIR:-$HOME/backups/fengyu}"
DUMP_LABEL="${DUMP_LABEL:-fengyu_wxapp_prod}"
FORMAT="c"
TABLE_FLAGS=()

usage() {
  cat <<'EOF'
dump-prod.sh — 导出生产业务库 (5433/fengyu_wxapp)

用法：
  bash db/scripts/dump-prod.sh                                # 全库 (custom format)
  bash db/scripts/dump-prod.sh -t sale_orders -t sale_items   # 仅指定表（可重复）
  bash db/scripts/dump-prod.sh -F plain                       # 纯 SQL 文本
  OUT_DIR=/tmp bash db/scripts/dump-prod.sh                   # 自定义输出目录

选项：-t TABLE（可重复，支持通配符如 'sale_%'）| -F c|plain | -o DIR | -h
环境变量：OUT_DIR / PG_DUMP_BIN / DUMP_LABEL / PG_CONNECTION_STRING
产物默认落 ~/backups/fengyu/（项目外）；含敏感数据，勿入 git。
EOF
}

while getopts "t:F:o:h" opt; do
  case "$opt" in
    t) TABLE_FLAGS+=(-t "$OPTARG") ;;
    F) FORMAT="$OPTARG" ;;
    o) OUT_DIR="$OPTARG" ;;
    h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

case "$FORMAT" in
  c|plain) : ;;
  *) echo "✗ -F 仅支持 c 或 plain（当前：${FORMAT}）"; exit 1 ;;
esac

# 代理绕过（本机代理会致远程 PG TLS 失败，见 memory project_tcb_deploy_proxy_tls）
run_untainted() { env -u http_proxy -u https_proxy -u all_proxy "$@"; }

# --- 读取连接串 ---
if [ -z "${PG_CONNECTION_STRING:-}" ]; then
  [ -f "$PROD_ENV" ] || { echo "✗ 找不到 $PROD_ENV"; exit 1; }
  _RAW="$(grep -E '^PG_CONNECTION_STRING=' "$PROD_ENV" | head -1 | cut -d= -f2-)"
  PG_CONNECTION_STRING="${_RAW//\"/}"            # 去双引号
  PG_CONNECTION_STRING="${PG_CONNECTION_STRING//\'/}"  # 去单引号
  unset _RAW
fi
[ -n "$PG_CONNECTION_STRING" ] || { echo "✗ 连接串为空"; exit 1; }

# --- 防误连非生产库：必须指向生产 IP 118.178.196.26
#     （2026-07-17 起 dev/测试与 prod 均为 5433/fengyu_wxapp，端口+库名已无法区分环境，仅靠 IP 兜底） ---
case "$PG_CONNECTION_STRING" in
  *"118.178.196.26"*) : ;;
  *)
    echo "✗ 连接串未指向生产库 118.178.196.26:5433/fengyu_wxapp，拒绝执行（防误把测试库当生产导出）"
    echo "  目标：$(printf '%s' "$PG_CONNECTION_STRING" | sed -E 's#://[^:]+:[^@]+@#://***@#')"
    exit 1 ;;
esac

# --- 探测 pg_dump16（本地 postgresql@16；pg_dump major 须 ≥ 服务端） ---
if [ -z "${PG_DUMP_BIN:-}" ]; then
  for c in /opt/homebrew/opt/postgresql@16/bin/pg_dump /usr/local/opt/postgresql@16/bin/pg_dump; do
    [ -x "$c" ] && PG_DUMP_BIN="$c" && break
  done
fi
[ -x "${PG_DUMP_BIN:-}" ] || { echo "✗ 未找到 pg_dump16；请 brew install postgresql@16 或设 PG_DUMP_BIN"; exit 1; }
PG_RESTORE_BIN="${PG_DUMP_BIN%/pg_dump}/pg_restore"
[ -x "$PG_RESTORE_BIN" ] || PG_RESTORE_BIN="$(command -v pg_restore || true)"

# --- 连通性 + 版本校验 ---
CLIENT_MAJOR="$("$PG_DUMP_BIN" --version | grep -oE '[0-9]+' | head -1)"
SERVER_VER="$(run_untainted psql "$PG_CONNECTION_STRING" -tAc 'SHOW server_version;' 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$SERVER_VER" ]; then
  echo "✗ 无法连接生产库（psql 取 server_version 失败）；检查网络/代理/连接串"; exit 1
fi
SERVER_MAJOR="${SERVER_VER%%.*}"
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  echo "✗ 版本不匹配：pg_dump=${CLIENT_MAJOR} < 服务端=${SERVER_MAJOR}（pg_dump major 须 ≥ 服务端）"; exit 1
fi
echo "• pg_dump $CLIENT_MAJOR / 服务端 $SERVER_MAJOR ✓"

# --- 导出 ---
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
EXT="dump"; [ "$FORMAT" = plain ] && EXT="sql"
OUT="$OUT_DIR/${DUMP_LABEL}_${TS}.$EXT"
echo "[1/2] 导出 → $OUT"
run_untainted "$PG_DUMP_BIN" -F"$FORMAT" ${TABLE_FLAGS[@]+"${TABLE_FLAGS[@]}"} -f "$OUT" "$PG_CONNECTION_STRING"
echo "    ✓ 体积 $(ls -lh "$OUT" | awk '{print $5}')"

# --- 验证 ---
echo "[2/2] 验证产物"
if [ "$FORMAT" = c ]; then
  ENTRIES="$(run_untainted "$PG_RESTORE_BIN" --list "$OUT" 2>/dev/null | grep -cE '^[0-9]+;' || true)"
  DATATBL="$(run_untainted "$PG_RESTORE_BIN" --list "$OUT" 2>/dev/null | grep -cE ' TABLE DATA ' || true)"
  echo "    ✓ TOC ${ENTRIES} 条目，含数据表 ${DATATBL} 张"
else
  echo "    ✓ $(wc -l < "$OUT" | tr -d ' ') 行 SQL"
fi

echo ""
echo "✓ 导出完成：$OUT"
if [ "$FORMAT" = c ]; then
  echo "  恢复示例（到本地 5434 dev，先清后建、忽略 owner 差异）："
  echo "    $PG_RESTORE_BIN -h 127.0.0.1 -p 5434 -U fengyu -d fengyu --clean --if-exists --no-owner $OUT"
else
  echo "  恢复示例：psql -h 127.0.0.1 -p 5434 -U fengyu -d fengyu -v ON_ERROR_STOP=1 -f $OUT"
fi
echo ""
echo "  ⚠ 产物含敏感数据（顾客手机号/身份证/支付），勿入 git、勿外发。"
