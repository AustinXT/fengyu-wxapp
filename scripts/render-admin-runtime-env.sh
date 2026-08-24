#!/usr/bin/env bash
# 生成 Admin/Analyst 远程 compose 使用的目标环境覆盖文件。
# 仅写到调用方提供的临时文件；不得输出任何 secret 原文。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-}"
OUTPUT="${2:-}"

if [[ ! "$ENV_NAME" =~ ^(dev|test|prod)$ ]] || [[ -z "$OUTPUT" ]]; then
  echo "Usage: $0 <dev|test|prod> <output-file>" >&2
  exit 1
fi

ENV_FILE="$ROOT/envs/$ENV_NAME.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }

read_value() {
  local file="$1" key="$2"
  grep -m1 "^${key}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '\r"' || true
}

required_value() {
  local file="$1" key="$2" value
  value="$(read_value "$file" "$key")"
  if [[ -z "$value" ]]; then
    echo "ERROR: $file missing $key" >&2
    exit 1
  fi
  printf '%s' "$value"
}

CLOUDBASE_ENV_ID="$(required_value "$ENV_FILE" CLOUDBASE_ENV_ID)"
CDN_BASE="$(required_value "$ENV_FILE" CDN_BASE)"
CLIENT_SECRET="$(required_value "$ENV_FILE" CLIENT_SECRET)"
STAFF_ENV_ID="$(read_value "$ENV_FILE" STAFF_ENV_ID)"
[[ -n "$STAFF_ENV_ID" ]] || STAFF_ENV_ID="$(required_value "$ENV_FILE" STAFF_CLOUDBASE_ENV_ID)"

STAFF_SECRET_SOURCE="$ENV_FILE"
STAFF_SECRET_ID="$(read_value "$ENV_FILE" STAFF_TENCENTCLOUD_SECRETID)"
STAFF_SECRET_KEY="$(read_value "$ENV_FILE" STAFF_TENCENTCLOUD_SECRETKEY)"
if [[ -z "$STAFF_SECRET_ID" || -z "$STAFF_SECRET_KEY" ]]; then
  # 历史配置把 staff 子账号凭据放在 fengyu-staff/.env；兼容读取但不复制进仓库。
  # 所有环境都只能回退到 staff 账号，绝不能把 client 的通用 TENCENTCLOUD_* 注入 staffApi。
  STAFF_SECRET_SOURCE="$ROOT/fengyu-staff/.env"
  STAFF_SECRET_ID="$(required_value "$STAFF_SECRET_SOURCE" TENCENTCLOUD_SECRETID)"
  STAFF_SECRET_KEY="$(required_value "$STAFF_SECRET_SOURCE" TENCENTCLOUD_SECRETKEY)"
fi

umask 077
{
  printf 'DEPLOY_CLOUDBASE_ENV_ID=%s\n' "$CLOUDBASE_ENV_ID"
  printf 'DEPLOY_CDN_BASE=%s\n' "$CDN_BASE"
  printf 'DEPLOY_CLIENT_SECRET=%s\n' "$CLIENT_SECRET"
  printf 'DEPLOY_STAFF_ENV_ID=%s\n' "$STAFF_ENV_ID"
  printf 'DEPLOY_STAFF_TENCENTCLOUD_SECRETID=%s\n' "$STAFF_SECRET_ID"
  printf 'DEPLOY_STAFF_TENCENTCLOUD_SECRETKEY=%s\n' "$STAFF_SECRET_KEY"
} > "$OUTPUT"
chmod 600 "$OUTPUT"

echo "  ✓ Admin runtime env 已按 $ENV_NAME 生成（staff 凭据来源：${STAFF_SECRET_SOURCE#$ROOT/}）"
