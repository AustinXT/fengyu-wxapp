#!/usr/bin/env bash

# 兼容入口：从 envs/<env>.env 单一权威源渲染 Admin 服务白名单环境。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-}"
OUTPUT="${2:-}"

if [[ ! "$ENV_NAME" =~ ^(dev|test|prod)$ ]] || [[ -z "$OUTPUT" ]]; then
  echo "Usage: $0 <dev|test|prod> <output-file>" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fengyu-admin-env.XXXXXX")
cleanup() {
  [[ -d "$TEMP_DIR" ]] && rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

node "$ROOT/.claude/skills/remote-deploy/runtime-config.mjs" render "$ENV_NAME" "$TEMP_DIR" >/dev/null
install -m 600 "$TEMP_DIR/admin.env" "$OUTPUT"
echo "  ✓ Admin runtime env 已按 $ENV_NAME 的中央配置生成"
