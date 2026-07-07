#!/usr/bin/env bash




set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ENV="${1:-}"
if [[ -z "$ENV" || ! "$ENV" =~ ^(dev|prod)$ ]]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 1
fi

ENV_FILE="$ROOT/envs/$ENV.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "  cp envs/$ENV.env.example envs/$ENV.env  # 然后填实值" >&2
  exit 1
fi

echo "==> Switching to: $ENV"


node "$ROOT/scripts/render-cloudbaserc.mjs" "$ENV"


echo "$ENV" > "$ROOT/envs/.active"
echo "  ✓ envs/.active = $ENV"


PG=$(grep -E '^PG_CONNECTION_STRING=' "$ENV_FILE" | head -1 | cut -d= -f2-)
CLIENT_ID=$(grep -E '^CLIENT_ENV_ID=' "$ENV_FILE" | head -1 | cut -d= -f2)
STAFF_ID=$(grep -E '^STAFF_ENV_ID=' "$ENV_FILE" | head -1 | cut -d= -f2)

echo ""
if [[ "$ENV" == "prod" ]]; then
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║  Active env: PROD  ⚠️  生产环境                                 ║"
  echo "║  PG: $PG"
  echo "║  Client env: $CLIENT_ID"
  echo "║  Staff env:  $STAFF_ID"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Next: scripts/deploy-cloudfunctions.sh   # 部署云函数到 prod"
  echo "      .claude/skills/remote-deploy/deploy-admin.sh prod   # admin 远程切到 5433"
else
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║  Active env: DEV   开发环境                                     ║"
  echo "║  PG: $PG"
  echo "║  Client env: $CLIENT_ID"
  echo "║  Staff env:  $STAFF_ID"
  echo "╚════════════════════════════════════════════════════════════════╝"
fi
