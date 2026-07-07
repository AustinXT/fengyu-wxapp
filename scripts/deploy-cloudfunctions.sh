#!/usr/bin/env bash






















set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"


TARGET=all
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    client|staff|all) TARGET="$arg" ;;
    --yes|-y)         ASSUME_YES=1 ;;
    *) echo "ERROR: unknown arg '$arg'. Usage: $0 [client|staff|all] [--yes]" >&2; exit 1 ;;
  esac
done
DO_STAFF=0; DO_CLIENT=0
[[ "$TARGET" == "staff"  || "$TARGET" == "all" ]] && DO_STAFF=1
[[ "$TARGET" == "client" || "$TARGET" == "all" ]] && DO_CLIENT=1

if [[ ! -f "$ROOT/envs/.active" ]]; then
  echo "ERROR: envs/.active not found. Run scripts/use-env.sh <env> first." >&2
  exit 1
fi
ACTIVE=$(cat "$ROOT/envs/.active")

if [[ ! -f "$ROOT/envs/$ACTIVE.env" ]]; then
  echo "ERROR: envs/$ACTIVE.env not found." >&2
  exit 1
fi


STAFF_ENV_ID=$(grep -E '^STAFF_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)
CLIENT_ENV_ID=$(grep -E '^CLIENT_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)

if [[ -z "$STAFF_ENV_ID" || -z "$CLIENT_ENV_ID" ]]; then
  echo "ERROR: STAFF_ENV_ID / CLIENT_ENV_ID missing in envs/$ACTIVE.env" >&2
  exit 1
fi


if [[ "$ACTIVE" == "prod" && "$ASSUME_YES" != "1" ]]; then
  echo "⚠️  About to deploy to PROD (target=$TARGET):"
  [[ "$DO_STAFF"  == "1" ]] && echo "    staffApi              → $STAFF_ENV_ID"
  [[ "$DO_CLIENT" == "1" ]] && echo "    clientApi + payNotify → $CLIENT_ENV_ID"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi



echo "==> Re-rendering cloudbaserc from .active=$ACTIVE （保证 envId 指向正确环境）"
node "$ROOT/scripts/render-cloudbaserc.mjs" "$ACTIVE"


EXPECT_PG_PORT=$([[ "$ACTIVE" == "prod" ]] && echo 5433 || echo 5434)
assert_rc() {  # $1=side 目录  $2=期望 envId
  local f="$ROOT/$1/cloudbaserc.json"
  [[ -f "$f" ]] || { echo "ERROR: $f 缺失（渲染失败）。中止。" >&2; exit 1; }
  local got_env got_pg
  got_env=$(node -e "console.log(require('$f').envId||'')")
  if [[ "$got_env" != "$2" ]]; then
    echo "ERROR: $1/cloudbaserc.json envId=$got_env ≠ 期望 $2（.active=$ACTIVE 渲染异常）。中止。" >&2; exit 1
  fi
  got_pg=$(node -e "const c=require('$f');const fn=(c.functions||[]).find(x=>(x.envVariables||{}).PG_CONNECTION_STRING);const m=fn&&(fn.envVariables.PG_CONNECTION_STRING.match(/:(\d+)\//));console.log(m?m[1]:'')")
  if [[ -n "$got_pg" && "$got_pg" != "$EXPECT_PG_PORT" ]]; then
    echo "ERROR: $1 的 PG 端口=$got_pg ≠ ${ACTIVE} 期望 ${EXPECT_PG_PORT}（env 值与环境不符，疑似跨环境污染）。中止。" >&2; exit 1
  fi
}
[[ "$DO_STAFF"  == "1" ]] && assert_rc fengyu-staff  "$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && assert_rc fengyu-client "$CLIENT_ENV_ID"
echo "  ✓ envId + PG 端口校验通过（${ACTIVE}）"


SCAN_FILES=()
[[ "$DO_STAFF"  == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-staff/cloudbaserc.json")
[[ "$DO_CLIENT" == "1" ]] && SCAN_FILES+=("$ROOT/fengyu-client/cloudbaserc.json")
PLACEHOLDERS=$(grep -ohE '<待用户提供[^>]*>|[A-Za-z0-9_.-]*PLACEHOLDER[A-Za-z0-9_.-]*' "${SCAN_FILES[@]}" 2>/dev/null | sort -u || true)
if [[ -n "$PLACEHOLDERS" ]]; then
  echo "⚠️  注意：cloudbaserc 仍含以下占位符，将原样上传到 [$ACTIVE]，请确认是否预期："
  echo "$PLACEHOLDERS" | sed 's/^/      /'
fi


TOTAL=0
[[ "$DO_STAFF"  == "1" ]] && TOTAL=$((TOTAL + 1))
[[ "$DO_CLIENT" == "1" ]] && TOTAL=$((TOTAL + 2))
STEP=0


if [[ "$DO_STAFF" == "1" ]]; then
  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy staffApi → $STAFF_ENV_ID"
  cd "$ROOT/fengyu-staff"
  set -a; source .env 2>/dev/null || true; set +a
  if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
    echo "ERROR: fengyu-staff/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
    exit 1
  fi
  tcb logout >/dev/null 2>&1 || true
  tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
  if ! tcb env list 2>/dev/null | grep -q "$STAFF_ENV_ID"; then
    echo "ERROR: staff 账号看不到 ${STAFF_ENV_ID}（tcb env list 未列出）。" >&2
    echo "  检查：fengyu-staff/.env 的 TENCENTCLOUD_SECRETID 是 staff 账号子号" >&2
    exit 1
  fi

  tcb fn code update staffApi
  echo "  ✓ staffApi deployed"
fi


if [[ "$DO_CLIENT" == "1" ]]; then
  cd "$ROOT/fengyu-client"
  unset TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY  # 清空可能残留的 staff 账号 secrets
  set -a; source .env 2>/dev/null || true; set +a
  if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
    echo "ERROR: fengyu-client/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
    exit 1
  fi
  tcb logout >/dev/null 2>&1 || true
  tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
  if ! tcb env list 2>/dev/null | grep -q "$CLIENT_ENV_ID"; then
    echo "ERROR: client 账号看不到 ${CLIENT_ENV_ID}。" >&2
    echo "  检查：fengyu-client/.env 的 TENCENTCLOUD_SECRETID 是 client 账号子号" >&2
    exit 1
  fi

  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy clientApi → $CLIENT_ENV_ID"
  tcb fn code update clientApi
  echo "  ✓ clientApi deployed"

  STEP=$((STEP + 1))
  echo "==> [$STEP/$TOTAL] Deploy payNotify → $CLIENT_ENV_ID"
  tcb fn code update payNotify
  echo "  ✓ payNotify deployed"
fi

echo ""
echo "==> Done (target=$TARGET)。请在 CloudBase 控制台验证环境变量正确。"
[[ "$DO_STAFF"  == "1" ]] && echo "    staff:  https://console.cloud.tencent.com/tcb/scf?envId=$STAFF_ENV_ID"
[[ "$DO_CLIENT" == "1" ]] && echo "    client: https://console.cloud.tencent.com/tcb/scf?envId=$CLIENT_ENV_ID"


exit 0
