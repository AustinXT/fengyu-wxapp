#!/usr/bin/env bash
# 部署云函数到当前 active env
# 处理：
#   - 部署前【强制按 .active 重新渲染 cloudbaserc】→ 保证上传的 env 一定是目标环境的
#   - 渲染后【校验 envId + PG 端口与 .active 一致】→ 不一致直接中止（防 dev 配置误推 prod）
#   - 渲染后【扫描占位符】→ 仍含 <待用户提供…>/PLACEHOLDER 的 env 给出告警
#   - tcb 双账号切换（staff/client 各自登录）
#   - prod 强制 confirm prompt
#   - tcb env list 校验目标 env 可见
#
# ⚠️ 重要：`tcb fn code update` 会把 cloudbaserc.json 的 envVariables 一并推送覆盖（不只代码）。
#    因此【禁止手动 `tcb fn code update <fn> --env-id <X>` 跨环境部署】——务必只走本脚本，
#    它会先按 .active 重渲染，确保 env 与目标环境匹配。手动跨环境调用会把 dev/SIT 配置刷进 prod。
#
# Usage: scripts/deploy-cloudfunctions.sh [--yes]

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$ROOT/envs/.active" ]]; then
  echo "ERROR: envs/.active not found. Run scripts/use-env.sh <env> first." >&2
  exit 1
fi
ACTIVE=$(cat "$ROOT/envs/.active")

if [[ ! -f "$ROOT/envs/$ACTIVE.env" ]]; then
  echo "ERROR: envs/$ACTIVE.env not found." >&2
  exit 1
fi

# 解析 envId（不 source 整个 .env，避免污染当前 shell）
STAFF_ENV_ID=$(grep -E '^STAFF_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)
CLIENT_ENV_ID=$(grep -E '^CLIENT_ENV_ID=' "$ROOT/envs/$ACTIVE.env" | head -1 | cut -d= -f2)

if [[ -z "$STAFF_ENV_ID" || -z "$CLIENT_ENV_ID" ]]; then
  echo "ERROR: STAFF_ENV_ID / CLIENT_ENV_ID missing in envs/$ACTIVE.env" >&2
  exit 1
fi

# 防呆：prod 强制 confirm
if [[ "$ACTIVE" == "prod" && "${1:-}" != "--yes" ]]; then
  echo "⚠️  About to deploy to PROD:"
  echo "    staff env: $STAFF_ENV_ID"
  echo "    client env: $CLIENT_ENV_ID"
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── 强制按 .active 重新渲染，保证 cloudbaserc 与目标环境一致（防 dev 配置误推 prod）──
echo "==> Re-rendering cloudbaserc from .active=$ACTIVE （保证上传正确环境变量）"
node "$ROOT/scripts/render-cloudbaserc.mjs" "$ACTIVE"

# ── 一致性校验：envId 必须匹配 .active 的 env-id；PG 端口必须匹配环境（prod=5433 / dev=5434）──
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
    echo "ERROR: $1 的 PG 端口=$got_pg ≠ $ACTIVE 期望 $EXPECT_PG_PORT（env 值与环境不符，疑似跨环境污染）。中止。" >&2; exit 1
  fi
}
assert_rc fengyu-staff  "$STAFF_ENV_ID"
assert_rc fengyu-client "$CLIENT_ENV_ID"
echo "  ✓ envId + PG 端口校验通过（$ACTIVE）"

# ── 占位符扫描：渲染后仍含占位符的 env 给出告警（不中止，部分占位是预期的，如 prod 未填的 SM4）──
PLACEHOLDERS=$(grep -ohE '<待用户提供[^>]*>|[A-Za-z0-9_.-]*PLACEHOLDER[A-Za-z0-9_.-]*' "$ROOT/fengyu-client/cloudbaserc.json" "$ROOT/fengyu-staff/cloudbaserc.json" 2>/dev/null | sort -u || true)
if [[ -n "$PLACEHOLDERS" ]]; then
  echo "⚠️  注意：cloudbaserc 仍含以下占位符，将原样上传到 [$ACTIVE]，请确认是否预期："
  echo "$PLACEHOLDERS" | sed 's/^/      /'
fi

# --- staff side ---
echo "==> [1/3] Deploy staffApi → $STAFF_ENV_ID"
cd "$ROOT/fengyu-staff"
set -a; source .env 2>/dev/null || true; set +a
if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
  echo "ERROR: fengyu-staff/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
  exit 1
fi
tcb logout >/dev/null 2>&1 || true
tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
if ! tcb env list 2>/dev/null | grep -q "$STAFF_ENV_ID"; then
  echo "ERROR: staff 账号看不到 $STAFF_ENV_ID（tcb env list 未列出）。" >&2
  echo "  检查：fengyu-staff/.env 的 TENCENTCLOUD_SECRETID 是 staff 账号子号" >&2
  exit 1
fi
tcb fn code update staffApi --envId "$STAFF_ENV_ID"
echo "  ✓ staffApi deployed"

# --- client side ---
echo "==> [2/3] Deploy clientApi → $CLIENT_ENV_ID"
cd "$ROOT/fengyu-client"
unset TENCENTCLOUD_SECRETID TENCENTCLOUD_SECRETKEY  # 清空 staff 账号 secrets
set -a; source .env 2>/dev/null || true; set +a
if [[ -z "${TENCENTCLOUD_SECRETID:-}" || -z "${TENCENTCLOUD_SECRETKEY:-}" ]]; then
  echo "ERROR: fengyu-client/.env missing TENCENTCLOUD_SECRETID/SECRETKEY" >&2
  exit 1
fi
tcb logout >/dev/null 2>&1 || true
tcb login -k --apiKeyId "$TENCENTCLOUD_SECRETID" --apiKey "$TENCENTCLOUD_SECRETKEY" >/dev/null
if ! tcb env list 2>/dev/null | grep -q "$CLIENT_ENV_ID"; then
  echo "ERROR: client 账号看不到 $CLIENT_ENV_ID。" >&2
  echo "  检查：fengyu-client/.env 的 TENCENTCLOUD_SECRETID 是 client 账号子号" >&2
  exit 1
fi
tcb fn code update clientApi --envId "$CLIENT_ENV_ID"
echo "  ✓ clientApi deployed"

# --- payNotify (same env as client) ---
echo "==> [3/3] Deploy payNotify → $CLIENT_ENV_ID"
tcb fn code update payNotify --envId "$CLIENT_ENV_ID"
echo "  ✓ payNotify deployed"

echo ""
echo "==> Done. 请在 CloudBase 控制台验证环境变量正确。"
echo "    staff: https://console.cloud.tencent.com/tcb/scf?envId=$STAFF_ENV_ID"
echo "    client: https://console.cloud.tencent.com/tcb/scf?envId=$CLIENT_ENV_ID"
