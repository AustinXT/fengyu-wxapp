#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy-common.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/deploy-common.sh"

usage() {
  echo "Usage: $0 <dev|test|prod> [--check]" >&2
  echo "       $0 --rollback <dev|test|prod>" >&2
}

if [[ "${1:-}" == "--rollback" ]]; then
  [[ $# -eq 2 ]] || { usage; exit 1; }
  ENV="$2"
  load_target "$ENV"
  remote_readonly_preflight
  if [[ "$ENV" == "prod" ]]; then
    read -r -p "输入 'rollback:prod' 确认生产回滚: " confirm
    [[ "$confirm" == "rollback:prod" ]] || { echo "Aborted."; exit 1; }
  fi
  manual_remote_rollback admin "$ENV"
  exit 0
fi

[[ $# -ge 1 && $# -le 2 ]] || { usage; exit 1; }
ENV="$1"
CHECK_ONLY=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--check" ]] || { usage; exit 1; }
  CHECK_ONLY=true
fi

load_target "$ENV"
cd "$REPO_ROOT"
assert_local_tools
assert_clean_worktree
reconcile_local_configs

LOCAL_BUNDLE=$(mktemp -d "${TMPDIR:-/tmp}/fengyu-admin-release.XXXXXX")
cleanup() {
  [[ -n "${LOCAL_BUNDLE:-}" && -d "$LOCAL_BUNDLE" ]] && rm -rf -- "$LOCAL_BUNDLE"
}
trap cleanup EXIT

render_local_bundle "$ENV" "$LOCAL_BUNDLE"
check_migration_gate "$ENV"
remote_readonly_preflight

APP_VERSION=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo dev)
APP_COMMIT=$(git rev-parse --short=12 HEAD)
BUILD_FINGERPRINT=$(shasum -a 256 "$LOCAL_BUNDLE/build-manifest.json" | awk '{print substr($1,1,12)}')
CONFIG_FINGERPRINT=$(
  for file in admin.env cron-worker.env export-worker.env analyst.env; do
    shasum -a 256 "$LOCAL_BUNDLE/$file" | awk '{print $1}'
  done | shasum -a 256 | awk '{print substr($1,1,12)}'
)
RELEASE_ID="${ENV}-${APP_COMMIT}-${CONFIG_FINGERPRINT}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
IMAGE_REF="fengyu-admin:${ENV}-${APP_COMMIT}-${BUILD_FINGERPRINT}"
REMOTE_RELEASE_DIR="$REMOTE_DIR/.deploy/releases/admin/$RELEASE_ID"

print_release_manifest admin "$ENV" "$LOCAL_BUNDLE" "$APP_COMMIT" "$IMAGE_REF" "$RELEASE_ID"
if [[ "$CHECK_ONLY" == true ]]; then
  echo "CHECK_OK: 未构建、未上传、未修改远端状态。"
  exit 0
fi

confirm_prod_release "$ENV" "$APP_COMMIT"
build_image admin "$LOCAL_BUNDLE" "$IMAGE_REF" "$APP_VERSION" "$APP_COMMIT"
prepare_release_files admin "$LOCAL_BUNDLE" "$REMOTE_RELEASE_DIR" "$IMAGE_REF" "fengyu-analyst:latest"
IMAGE_ID=$(transfer_image "$IMAGE_REF")
upload_release_files "$LOCAL_BUNDLE" "$REMOTE_RELEASE_DIR"
switch_remote_release admin "$ENV" "$RELEASE_ID" "$REMOTE_RELEASE_DIR" "$IMAGE_REF" "$IMAGE_ID" "$LOCAL_BUNDLE"

echo "部署完成: admin env=$ENV release=$RELEASE_ID"
