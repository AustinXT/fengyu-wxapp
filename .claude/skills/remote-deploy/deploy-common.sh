#!/usr/bin/env bash

# remote-deploy 的公共实现。调用方必须先启用 set -euo pipefail。

REMOTE_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$REMOTE_DEPLOY_DIR/../../.." && pwd)"
RUNTIME_CONFIG="$REMOTE_DEPLOY_DIR/runtime-config.mjs"

load_target() {
  local env="$1"
  case "$env" in
    dev)
      SSH_HOST="ali-demo"
      TARGET_PUBLIC_HOST="47.113.202.7"
      REMOTE_DIR="/root/proj.xt.com/fengyu-wxapp/docker"
      MIGRATION_HOST="47.113.202.7"
      CONTAINER_DB_HOST="47.113.202.7"
      ;;
    test)
      SSH_HOST="sqlserver101"
      TARGET_PUBLIC_HOST="101.34.242.103"
      REMOTE_DIR="/www/wwwroot/fengyu-admin/docker"
      MIGRATION_HOST="101.34.242.103"
      CONTAINER_DB_HOST="172.18.0.1"
      ;;
    prod)
      SSH_HOST="fengyu-prod"
      TARGET_PUBLIC_HOST="118.178.196.26"
      REMOTE_DIR="/www/wwwroot/fengyu-admin/docker"
      MIGRATION_HOST="118.178.196.26"
      CONTAINER_DB_HOST="118.178.196.26"
      ;;
    *)
      echo "ERROR: environment must be dev, test, or prod" >&2
      return 1
      ;;
  esac
}

assert_clean_worktree() {
  local status
  status=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)
  if [[ -n "$status" ]]; then
    echo "ERROR: deployment requires a clean worktree; commit or remove all non-ignored changes first." >&2
    echo "$status" >&2
    return 1
  fi
}

assert_local_tools() {
  local tool
  for tool in git node docker ssh scp gzip shasum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing local tool: $tool" >&2; return 1; }
  done
  docker buildx version >/dev/null 2>&1 || { echo "ERROR: docker buildx is unavailable" >&2; return 1; }
}

manifest_value() {
  local manifest="$1" key="$2"
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$manifest" "$key"
}

render_local_bundle() {
  local env="$1" bundle="$2"
  node "$RUNTIME_CONFIG" render "$env" "$bundle" >/dev/null
  chmod 600 "$bundle"/*.env "$bundle/build-manifest.json"
}

check_migration_gate() {
  local env="$1"
  node "$RUNTIME_CONFIG" migrations "$env"
}

remote_readonly_preflight() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" sh -s -- \
    "$TARGET_PUBLIC_HOST" "$REMOTE_DIR" <<'REMOTE'
set -eu
expected_public_ip="$1"
remote_dir="$2"

test "$(uname -m)" = "x86_64" || { echo "ERROR: remote architecture must be x86_64" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: remote docker is missing" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "ERROR: remote flock is missing" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: remote docker compose is missing" >&2; exit 1; }
test -d "$remote_dir" || { echo "ERROR: remote directory is missing: $remote_dir" >&2; exit 1; }
public_ip=$(curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 8 https://ip.sb 2>/dev/null || true)
test "$public_ip" = "$expected_public_ip" || {
  echo "ERROR: SSH target public IP is ${public_ip:-unreadable}, expected $expected_public_ip" >&2
  exit 1
}
REMOTE
}

print_release_manifest() {
  local component="$1" env="$2" bundle="$3" commit="$4" image_ref="$5" release_id="$6"
  local manifest="$bundle/build-manifest.json"
  echo "=== 脱敏发布清单 ==="
  echo "组件: $component"
  echo "环境: $env"
  echo "SSH: $SSH_HOST ($TARGET_PUBLIC_HOST)"
  echo "远端目录: $REMOTE_DIR"
  echo "迁移连接目标: $MIGRATION_HOST:5433/fengyu_wxapp"
  echo "容器 DB 目标: $CONTAINER_DB_HOST:5433/fengyu_wxapp"
  echo "Analyst: $(manifest_value "$manifest" analystPublicOrigin)"
  echo "Git commit: $commit"
  echo "镜像: $image_ref"
  echo "Release: $release_id"
}

confirm_prod_release() {
  local env="$1" commit="$2"
  [[ "$env" == "prod" ]] || return 0
  local expected="prod:$commit" confirm
  read -r -p "输入 '$expected' 确认生产发布: " confirm
  [[ "$confirm" == "$expected" ]] || { echo "Aborted."; return 1; }
}

build_image() {
  local component="$1" bundle="$2" image_ref="$3" app_version="$4" app_commit="$5"
  local manifest="$bundle/build-manifest.json"
  case "$component" in
    admin)
      docker buildx build \
        --platform linux/amd64 \
        --load \
        --build-arg APP_VERSION="$app_version" \
        --build-arg APP_COMMIT="$app_commit" \
        --build-arg NEXT_PUBLIC_RSA_PUBLIC_KEY="$(manifest_value "$manifest" nextPublicRsaPublicKey)" \
        --build-arg NEXT_PUBLIC_ANALYST_ORIGIN="$(manifest_value "$manifest" analystPublicOrigin)" \
        -f "$REPO_ROOT/docker/Dockerfile.admin" \
        -t "$image_ref" \
        "$REPO_ROOT"
      ;;
    analyst)
      docker buildx build \
        --platform linux/amd64 \
        --load \
        --build-arg APP_VERSION="$app_version" \
        --build-arg APP_COMMIT="$app_commit" \
        --build-arg NEXT_PUBLIC_ADMIN_ORIGIN="$(manifest_value "$manifest" analystAdminOrigin)" \
        --build-arg NEXT_PUBLIC_ANALYST_ORIGIN="$(manifest_value "$manifest" analystPublicOrigin)" \
        -f "$REPO_ROOT/docker/Dockerfile.analyst" \
        -t "$image_ref" \
        "$REPO_ROOT"
      ;;
    *)
      echo "ERROR: unsupported component $component" >&2
      return 1
      ;;
  esac
  local arch
  arch=$(docker image inspect -f '{{.Architecture}}' "$image_ref")
  [[ "$arch" == "amd64" ]] || { echo "ERROR: local image architecture is $arch, expected amd64" >&2; return 1; }
}

transfer_image() {
  local image_ref="$1"
  local local_id remote_id
  local_id=$(docker image inspect -f '{{.Id}}' "$image_ref")
  docker save "$image_ref" | gzip | ssh "$SSH_HOST" docker load >&2
  remote_id=$(ssh "$SSH_HOST" docker image inspect -f '{{.Id}}' "$image_ref")
  [[ "$remote_id" == "$local_id" ]] || {
    echo "ERROR: transferred image ID mismatch (local=$local_id remote=$remote_id)" >&2
    return 1
  }
  printf '%s' "$local_id"
}

prepare_release_files() {
  local component="$1" bundle="$2" remote_release_dir="$3" admin_image="$4" analyst_image="$5"
  cp "$REPO_ROOT/docker/docker-compose.yml" "$bundle/docker-compose.yml"
  cp "$REPO_ROOT/docker/docker-compose.remote.yml" "$bundle/docker-compose.remote.yml"
  {
    printf 'ADMIN_IMAGE=%s\n' "$admin_image"
    printf 'ANALYST_IMAGE=%s\n' "$analyst_image"
    printf 'ADMIN_ENV_FILE=%s/admin.env\n' "$remote_release_dir"
    printf 'CRON_ENV_FILE=%s/cron-worker.env\n' "$remote_release_dir"
    printf 'EXPORT_ENV_FILE=%s/export-worker.env\n' "$remote_release_dir"
    printf 'ANALYST_ENV_FILE=%s/analyst.env\n' "$remote_release_dir"
    printf 'DEPLOY_COMPONENT=%s\n' "$component"
  } > "$bundle/compose.env"
  chmod 600 "$bundle/compose.env"
}

upload_release_files() {
  local bundle="$1" remote_release_dir="$2"
  ssh "$SSH_HOST" sh -s -- "$remote_release_dir" <<'REMOTE'
set -eu
release_dir="$1"
mkdir -p "$release_dir"
chmod 700 "$release_dir"
REMOTE
  scp -p "$bundle/admin.env" "$bundle/cron-worker.env" "$bundle/export-worker.env" \
    "$bundle/analyst.env" "$bundle/compose.env" "$bundle/build-manifest.json" \
    "$bundle/docker-compose.yml" "$bundle/docker-compose.remote.yml" \
    "$SSH_HOST:$remote_release_dir/"
  ssh "$SSH_HOST" sh -s -- "$remote_release_dir" <<'REMOTE'
set -eu
release_dir="$1"
chmod 600 "$release_dir"/*.env "$release_dir/build-manifest.json"
chmod 644 "$release_dir/docker-compose.yml" "$release_dir/docker-compose.remote.yml"
REMOTE
}

switch_remote_release() {
  local component="$1" env="$2" release_id="$3" remote_release_dir="$4" image_ref="$5" image_id="$6" bundle="$7"
  local manifest="$bundle/build-manifest.json"
  local cloudbase cdn analyst_origin analyst_host
  cloudbase=$(manifest_value "$manifest" cloudbaseEnvId)
  cdn=$(manifest_value "$manifest" cdnBase)
  analyst_origin=$(manifest_value "$manifest" analystPublicOrigin)
  analyst_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).host)' "$analyst_origin")

  ssh "$SSH_HOST" sh -s -- \
    "$component" "$env" "$release_id" "$remote_release_dir" "$image_ref" "$image_id" \
    "$REMOTE_DIR" "$CONTAINER_DB_HOST" "$TARGET_PUBLIC_HOST" "$cloudbase" "$cdn" \
    "$analyst_origin" "$analyst_host" <<'REMOTE'
set -eu
component="$1"
env_name="$2"
release_id="$3"
release_dir="$4"
image_ref="$5"
image_id="$6"
remote_dir="$7"
expected_db_host="$8"
expected_public_host="$9"
expected_cloudbase="${10}"
expected_cdn="${11}"
expected_analyst_origin="${12}"
expected_analyst_host="${13}"

deploy_root="$remote_dir/.deploy"
state_dir="$deploy_root/state"
release_root="$deploy_root/releases/$component"
mkdir -p "$state_dir" "$release_root"
chmod 700 "$deploy_root" "$state_dir" "$release_root"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo "ERROR: another remote deployment is active" >&2; exit 1; }

# 历史秘密文件不再参与新版发布，只收紧权限并保留兼容回滚能力。
test ! -f "$remote_dir/.env" || chmod 600 "$remote_dir/.env"
test ! -f "$remote_dir/.admin-runtime.env" || chmod 600 "$remote_dir/.admin-runtime.env"
test ! -f "$remote_dir/.analyst-runtime.env" || chmod 600 "$remote_dir/.analyst-runtime.env"

compose_release() {
  target_release="$1"
  shift
  docker compose \
    --project-directory "$remote_dir" \
    --env-file "$target_release/compose.env" \
    -f "$target_release/docker-compose.yml" \
    -f "$target_release/docker-compose.remote.yml" \
    "$@"
}

ensure_admin_runtime_dirs() {
  [ "$component" = "admin" ] || return 0
  runtime_dirs="logs/cron-worker logs/export-worker data/private-uploads data/runtime-status data/backup-control data/database-backups"
  if (
    cd "$remote_dir"
    mkdir -p $runtime_dirs
    chown 1001:1001 $runtime_dirs
  ); then
    return 0
  fi
  command -v sudo >/dev/null 2>&1 || {
    echo "ERROR: cannot prepare admin bind-mount directories and sudo is unavailable" >&2
    return 1
  }
  (
    cd "$remote_dir"
    sudo mkdir -p $runtime_dirs
    sudo chown 1001:1001 $runtime_dirs
  )
}

services_for_component() {
  if [ "$component" = "admin" ]; then
    printf '%s\n' admin cron-worker export-worker
  else
    printf '%s\n' analyst
  fi
}

container_for_component() {
  if [ "$component" = "admin" ]; then printf '%s' fengyu-admin; else printf '%s' fengyu-analyst; fi
}

state_get() {
  state_file="$1"
  state_key="$2"
  awk -F= -v key="$state_key" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$state_file"
}

write_state() {
  output="$1"
  mode="$2"
  state_release="$3"
  state_image_ref="$4"
  state_image_id="$5"
  state_release_id="$6"
  temp="$output.tmp.$$"
  {
    printf 'mode=%s\n' "$mode"
    printf 'release_dir=%s\n' "$state_release"
    printf 'image_ref=%s\n' "$state_image_ref"
    printf 'image_id=%s\n' "$state_image_id"
    printf 'release_id=%s\n' "$state_release_id"
  } > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$output"
}

extract_db_host() {
  db_url="$1"
  case "$db_url" in
    *@*:*/*)
      db_tail=${db_url##*@}
      printf '%s' "${db_tail%%:*}"
      ;;
    *) return 1 ;;
  esac
}

basic_health() {
  health_component="$1"
  if [ "$health_component" = "admin" ]; then
    health_container="fengyu-admin"
    health_url="http://localhost:3000/"
  else
    health_container="fengyu-analyst"
    health_url="http://localhost:3001/"
  fi
  test "$(docker inspect -f '{{.State.Status}}' "$health_container" 2>/dev/null || true)" = "running" || return 1
  curl -fsS --max-time 8 "$health_url" >/dev/null
}

full_health() {
  attempt=1
  while [ "$attempt" -le 12 ]; do
    if basic_health "$component"; then break; fi
    attempt=$((attempt + 1))
    sleep 5
  done
  test "$attempt" -le 12 || return 1

  health_container=$(container_for_component)
  db_url=$(docker exec "$health_container" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)
  got_db_host=$(extract_db_host "$db_url" || true)
  test "$got_db_host" = "$expected_db_host" || {
    echo "ERROR: $component DB host is ${got_db_host:-unreadable}, expected $expected_db_host" >&2
    return 1
  }
  if [ "$env_name" = "test" ]; then
    public_ip=$(curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 8 https://ip.sb 2>/dev/null || true)
    test "$public_ip" = "$expected_public_host" || return 1
    ss -tln 2>/dev/null | grep -q ':5433' || return 1
  fi

  if [ "$component" = "admin" ]; then
    test "$(docker inspect -f '{{.State.Status}}' fengyu-cron-worker 2>/dev/null || true)" = "running" || return 1
    test "$(docker inspect -f '{{.State.Status}}' fengyu-export-worker 2>/dev/null || true)" = "running" || return 1
    actual=$(docker exec fengyu-admin sh -c 'printf "%s|%s|%s" "$CLOUDBASE_ENV_ID" "$CDN_BASE" "$NEXT_PUBLIC_ANALYST_ORIGIN"' 2>/dev/null || true)
    test "$actual" = "$expected_cloudbase|$expected_cdn|$expected_analyst_origin" || return 1
    docker exec fengyu-admin sh -c "grep -RqsF -- '$expected_analyst_host' /app/.next/static /app/.next/server" || return 1
  else
    actual_origin=$(docker exec fengyu-analyst sh -c 'printf %s "$NEXT_PUBLIC_ANALYST_ORIGIN"' 2>/dev/null || true)
    test "$actual_origin" = "$expected_analyst_origin" || return 1
  fi
}

rollback_health() {
  rollback_attempt=1
  while [ "$rollback_attempt" -le 12 ]; do
    if basic_health "$component"; then break; fi
    rollback_attempt=$((rollback_attempt + 1))
    sleep 5
  done
  test "$rollback_attempt" -le 12 || return 1

  rollback_container=$(container_for_component)
  rollback_db_url=$(docker exec "$rollback_container" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)
  rollback_db_host=$(extract_db_host "$rollback_db_url" || true)
  test "$rollback_db_host" = "$expected_db_host" || return 1
  if [ "$component" = "admin" ]; then
    test "$(docker inspect -f '{{.State.Status}}' fengyu-cron-worker 2>/dev/null || true)" = "running" || return 1
    test "$(docker inspect -f '{{.State.Status}}' fengyu-export-worker 2>/dev/null || true)" = "running" || return 1
  fi
}

run_release_state() {
  state_file="$1"
  mode=$(state_get "$state_file" mode)
  rollback_image_id=$(state_get "$state_file" image_id)
  if [ "$mode" = "release" ]; then
    rollback_release=$(state_get "$state_file" release_dir)
    test -d "$rollback_release" || return 1
    compose_release "$rollback_release" up -d --no-build $(services_for_component)
  elif [ "$mode" = "legacy" ]; then
    test -n "$rollback_image_id" || return 1
    if [ "$component" = "admin" ]; then
      docker tag "$rollback_image_id" fengyu-admin:latest
      legacy_runtime="$remote_dir/.admin-runtime.env"
    else
      docker tag "$rollback_image_id" fengyu-analyst:latest
      legacy_runtime="$remote_dir/.analyst-runtime.env"
      test -f "$legacy_runtime" || legacy_runtime="$remote_dir/.admin-runtime.env"
    fi
    test -f "$remote_dir/.env" && test -f "$legacy_runtime" || return 1
    docker compose \
      --project-directory "$remote_dir" \
      --env-file "$remote_dir/.env" \
      --env-file "$legacy_runtime" \
      -f "$remote_dir/docker-compose.yml" \
      -f "$remote_dir/docker-compose.remote.yml" \
      up -d --no-build $(services_for_component)
  else
    return 1
  fi
}

compose_release "$release_dir" config --quiet
remote_image_id=$(docker image inspect -f '{{.Id}}' "$image_ref" 2>/dev/null || true)
remote_arch=$(docker image inspect -f '{{.Architecture}}' "$image_ref" 2>/dev/null || true)
test "$remote_image_id" = "$image_id" || { echo "ERROR: remote image ID drift" >&2; exit 1; }
test "$remote_arch" = "amd64" || { echo "ERROR: remote image is not amd64" >&2; exit 1; }

current_state="$state_dir/$component.current"
previous_state="$state_dir/$component.previous"
rollback_state="$state_dir/$component.rollback.$$"
current_container=$(container_for_component)
old_image_id=$(docker inspect -f '{{.Image}}' "$current_container" 2>/dev/null || true)
if [ -f "$current_state" ]; then
  cp "$current_state" "$rollback_state"
else
  write_state "$rollback_state" legacy "" "" "$old_image_id" "legacy-before-$release_id"
fi

ensure_admin_runtime_dirs
if ! compose_release "$release_dir" up -d --no-build $(services_for_component) || ! full_health; then
  echo "ERROR: $component release $release_id failed; starting automatic rollback" >&2
  docker logs --tail 80 "$current_container" 2>&1 || true
  if run_release_state "$rollback_state" && rollback_health; then
    echo "ROLLBACK_OK: restored $(state_get "$rollback_state" release_id)" >&2
    exit 1
  fi
  echo "ROLLBACK_FAILED: both release and rollback are unhealthy; preserved $release_dir and $rollback_state" >&2
  exit 70
fi

if [ -f "$current_state" ]; then cp "$current_state" "$previous_state"; else cp "$rollback_state" "$previous_state"; fi
write_state "$current_state" release "$release_dir" "$image_ref" "$image_id" "$release_id"
rm -f "$rollback_state"

# 仅清理该组件目录中不再被 current/previous 引用的旧 release，保留最近三个。
current_release=$(state_get "$current_state" release_dir)
previous_release=$(state_get "$previous_state" release_dir)
count=0
for candidate in $(ls -1dt "$release_root"/* 2>/dev/null || true); do
  [ -d "$candidate" ] || continue
  if [ "$candidate" = "$current_release" ] || [ "$candidate" = "$previous_release" ]; then continue; fi
  count=$((count + 1))
  if [ "$count" -gt 1 ]; then rm -rf -- "$candidate"; fi
done

echo "RELEASE_OK: $component $release_id"
REMOTE
}

manual_remote_rollback() {
  local component="$1" env="$2"
  ssh "$SSH_HOST" sh -s -- \
    "$component" "$env" "$REMOTE_DIR" "$CONTAINER_DB_HOST" "$TARGET_PUBLIC_HOST" <<'REMOTE'
set -eu
component="$1"
env_name="$2"
remote_dir="$3"
expected_db_host="$4"
expected_public_host="$5"
deploy_root="$remote_dir/.deploy"
state_dir="$deploy_root/state"
current_state="$state_dir/$component.current"
previous_state="$state_dir/$component.previous"
test -f "$current_state" && test -f "$previous_state" || {
  echo "ERROR: no complete current/previous release state for $component" >&2
  exit 1
}
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo "ERROR: another remote deployment is active" >&2; exit 1; }

state_get() {
  awk -F= -v key="$2" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$1"
}
mode=$(state_get "$previous_state" mode)
release_dir=$(state_get "$previous_state" release_dir)
image_id=$(state_get "$previous_state" image_id)
if [ "$component" = "admin" ]; then
  services="admin cron-worker export-worker"
  container="fengyu-admin"
  url="http://localhost:3000/"
else
  services="analyst"
  container="fengyu-analyst"
  url="http://localhost:3001/"
fi

if [ "$mode" = "release" ]; then
  docker compose --project-directory "$remote_dir" --env-file "$release_dir/compose.env" \
    -f "$release_dir/docker-compose.yml" -f "$release_dir/docker-compose.remote.yml" \
    up -d --no-build $services
elif [ "$mode" = "legacy" ]; then
  if [ "$component" = "admin" ]; then
    docker tag "$image_id" fengyu-admin:latest
    runtime="$remote_dir/.admin-runtime.env"
  else
    docker tag "$image_id" fengyu-analyst:latest
    runtime="$remote_dir/.analyst-runtime.env"
    test -f "$runtime" || runtime="$remote_dir/.admin-runtime.env"
  fi
  docker compose --project-directory "$remote_dir" --env-file "$remote_dir/.env" --env-file "$runtime" \
    -f "$remote_dir/docker-compose.yml" -f "$remote_dir/docker-compose.remote.yml" \
    up -d --no-build $services
else
  echo "ERROR: invalid previous release mode" >&2
  exit 1
fi

attempt=1
while [ "$attempt" -le 12 ]; do
  status=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)
  if [ "$status" = "running" ] && curl -fsS --max-time 8 "$url" >/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 5
done
test "$attempt" -le 12 || { echo "ERROR: rollback target is unhealthy; state files were not changed" >&2; exit 1; }

db_url=$(docker exec "$container" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)
case "$db_url" in
  *@*:*/*) db_tail=${db_url##*@}; db_host=${db_tail%%:*} ;;
  *) db_host="" ;;
esac
test "$db_host" = "$expected_db_host" || {
  echo "ERROR: rollback DB host is ${db_host:-unreadable}, expected $expected_db_host; state files were not changed" >&2
  exit 1
}
if [ "$component" = "admin" ]; then
  test "$(docker inspect -f '{{.State.Status}}' fengyu-cron-worker 2>/dev/null || true)" = "running" || exit 1
  test "$(docker inspect -f '{{.State.Status}}' fengyu-export-worker 2>/dev/null || true)" = "running" || exit 1
fi
if [ "$env_name" = "test" ]; then
  public_ip=$(curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || curl -fsS --max-time 8 https://ip.sb 2>/dev/null || true)
  test "$public_ip" = "$expected_public_host" || exit 1
  ss -tln 2>/dev/null | grep -q ':5433' || exit 1
fi

swap="$state_dir/$component.swap.$$"
cp "$current_state" "$swap"
mv "$previous_state" "$current_state"
mv "$swap" "$previous_state"
echo "ROLLBACK_OK: $component -> $(state_get "$current_state" release_id)"
REMOTE
}
