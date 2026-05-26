#!/usr/bin/env bash
# 部署云函数到当前 active env
# 处理：
#   - tcb 双账号切换（staff/client 各自登录）
#   - prod 强制 confirm prompt
#   - tcb env list 校验目标 env 可见
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

# 渲染产物存在性检查
[[ -f "$ROOT/fengyu-staff/cloudbaserc.json" ]] || { echo "ERROR: fengyu-staff/cloudbaserc.json missing. Run scripts/use-env.sh $ACTIVE first." >&2; exit 1; }
[[ -f "$ROOT/fengyu-client/cloudbaserc.json" ]] || { echo "ERROR: fengyu-client/cloudbaserc.json missing." >&2; exit 1; }

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
