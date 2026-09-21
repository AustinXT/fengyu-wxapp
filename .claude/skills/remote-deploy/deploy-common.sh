#!/usr/bin/env bash

# remote-deploy 的公共实现。调用方必须先启用 set -euo pipefail。

REMOTE_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$REMOTE_DEPLOY_DIR/../../.." && pwd)"
RUNTIME_CONFIG="$REMOTE_DEPLOY_DIR/runtime-config.mjs"

load_target() {
  local env="$1"
  case "$env" in
    dev)
      # 2026-09-10 对齐 origin/dev：dev 的 PG 迁入 lx-test（101.34.242.103），ali-demo 弃用。
      # 2026-09-01 起 dev 的 PG 迁入本机；独立 test 环境已退役。
      SSH_HOST="lx-test"   # ~/.ssh/config 别名（原 sqlserver101，2026-09-04 改名）
      TARGET_PUBLIC_HOST="101.34.242.103"
      REMOTE_DIR="/www/wwwroot/fengyu-admin/docker"
      MIGRATION_HOST="101.34.242.103"
      CONTAINER_DB_HOST="172.18.0.1"
      ;;
    prod)
      SSH_HOST="lx-prod"   # ~/.ssh/config 别名（原 fengyu-prod，2026-09-04 改名）
      TARGET_PUBLIC_HOST="118.178.196.26"
      REMOTE_DIR="/www/wwwroot/fengyu-admin/docker"
      MIGRATION_HOST="118.178.196.26"
      CONTAINER_DB_HOST="118.178.196.26"
      ;;
    *)
      echo "ERROR: environment must be dev or prod" >&2
      return 1
      ;;
  esac
}

capture_worktree_provenance() {
  local status untracked_path
  status=$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)
  WORKTREE_STATE="clean"
  WORKTREE_FINGERPRINT="clean"
  [[ -n "$status" ]] || return 0

  WORKTREE_STATE="dirty"
  WORKTREE_FINGERPRINT=$(
    {
      printf '%s\n' '--- tracked diff ---'
      git -C "$REPO_ROOT" diff --binary HEAD --
      printf '%s\n' '--- untracked files ---'
      git -C "$REPO_ROOT" ls-files --others --exclude-standard | LC_ALL=C sort | while IFS= read -r untracked_path; do
        [[ -n "$untracked_path" ]] || continue
        printf 'path:%s\nsha256:' "$untracked_path"
        shasum -a 256 < "$REPO_ROOT/$untracked_path" | awk '{print $1}'
      done
    } | shasum -a 256 | awk '{print substr($1,1,12)}'
  )

  echo "WARNING: deploying a dirty worktree as dirty.$WORKTREE_FINGERPRINT" >&2
  echo "$status" >&2
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

reconcile_local_configs() {
  node "$RUNTIME_CONFIG" reconcile >/dev/null
}

check_migration_gate() {
  local env="$1"
  node "$RUNTIME_CONFIG" migrations "$env"
}

remote_readonly_preflight() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" sh -s -- \
    "$TARGET_PUBLIC_HOST" "$REMOTE_DIR" <<'REMOTE'
set -eu

detect_public_ip() {
  for ip_url in https://ifconfig.me https://ip.sb https://myip.ipip.net https://cip.cc http://ip.3322.net; do
    ip_body=$(curl -fsS --max-time 8 "$ip_url" 2>/dev/null || true)
    ip_value=$(printf '%s\n' "$ip_body" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1)
    if [ -n "$ip_value" ]; then
      printf '%s' "$ip_value"
      return 0
    fi
  done
  return 1
}

expected_public_ip="$1"
remote_dir="$2"

test "$(uname -m)" = "x86_64" || { echo "ERROR: remote architecture must be x86_64" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: remote docker is missing" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "ERROR: remote flock is missing" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: remote docker compose is missing" >&2; exit 1; }
test -d "$remote_dir" || { echo "ERROR: remote directory is missing: $remote_dir" >&2; exit 1; }
public_ip=$(detect_public_ip || true)
test "$public_ip" = "$expected_public_ip" || {
  echo "ERROR: SSH target public IP is ${public_ip:-unreadable}, expected $expected_public_ip" >&2
  exit 1
}
REMOTE
}

print_release_manifest() {
  local component="$1" env="$2" bundle="$3" revision="$4" image_ref="$5" release_id="$6"
  local manifest="$bundle/build-manifest.json"
  echo "=== 脱敏发布清单 ==="
  echo "组件: $component"
  echo "环境: $env"
  echo "SSH: $SSH_HOST ($TARGET_PUBLIC_HOST)"
  echo "远端目录: $REMOTE_DIR"
  echo "迁移连接目标: $MIGRATION_HOST:5433/fengyu_wxapp"
  echo "容器 DB 目标: $CONTAINER_DB_HOST:5433/fengyu_wxapp"
  echo "Analyst: $(manifest_value "$manifest" analystPublicOrigin)"
  echo "工作树: $WORKTREE_STATE"
  echo "Git revision: $revision"
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
        --build-arg NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED="$(manifest_value "$manifest" nextPublicInventoryLinkageEnabled)" \
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
  local local_config remote_config remote_id
  # 校验标识用 config digest（docker save 导出 tar 里 manifest.json 的 Config blob）：
  # 它在经典与 containerd 两种镜像存储下都按内容寻址、两端一致；而 .Id 在经典存储
  # =config digest、containerd 存储=manifest digest，跨引擎比对必然假阳性
  # （2026-09-01 test 部署：本地经典 overlay2 vs 远端 containerd snapshotter）。
  local_config=$(docker save "$image_ref" | tar -xO manifest.json | sed -nE 's/.*"Config":"([^"]+)".*/\1/p' | sed -E 's#.*/##')
  test -n "$local_config" || { echo "ERROR: cannot extract local image config digest" >&2; return 1; }
  docker save "$image_ref" | gzip | ssh "$SSH_HOST" docker load >&2
  remote_config=$(ssh "$SSH_HOST" "docker save '$image_ref' | tar -xO manifest.json" | sed -nE 's/.*"Config":"([^"]+)".*/\1/p' | sed -E 's#.*/##')
  test -n "$remote_config" || { echo "ERROR: cannot extract remote image config digest" >&2; return 1; }
  [[ "$remote_config" == "$local_config" ]] || {
    echo "ERROR: transferred image config digest mismatch (local=$local_config remote=$remote_config)" >&2
    return 1
  }
  # 返回远端 .Id（远端 native 标识）：后续远端 docker tag 回滚 / inspect 漂移复核均按此解析
  remote_id=$(ssh "$SSH_HOST" docker image inspect -f '{{.Id}}' "$image_ref")
  test -n "$remote_id" || { echo "ERROR: cannot resolve remote image ID" >&2; return 1; }
  printf '%s' "$remote_id"
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

  local -a encoded_params=()
  local raw_param
  for raw_param in \
    "$component" "$env" "$release_id" "$remote_release_dir" "$image_ref" "$image_id" \
    "$REMOTE_DIR" "$CONTAINER_DB_HOST" "$TARGET_PUBLIC_HOST" "$cloudbase" "$cdn" \
    "$analyst_origin" "$analyst_host"; do
    # base64 字符集不含 shell 元字符，杜绝远端二次分词/展开/glob；tr 去 wrapping（GNU base64 默认换行）。
    encoded_params+=("$(printf %s "$raw_param" | base64 | tr -d '\n')")
  done

  ssh "$SSH_HOST" sh -s -- "${encoded_params[@]}" <<'REMOTE'
set -eu
component=$(printf %s "$1" | base64 -d)
env_name=$(printf %s "$2" | base64 -d)
release_id=$(printf %s "$3" | base64 -d)
release_dir=$(printf %s "$4" | base64 -d)
image_ref=$(printf %s "$5" | base64 -d)
image_id=$(printf %s "$6" | base64 -d)
remote_dir=$(printf %s "$7" | base64 -d)
expected_db_host=$(printf %s "$8" | base64 -d)
expected_public_host=$(printf %s "$9" | base64 -d)
expected_cloudbase=$(printf %s "${10}" | base64 -d)
expected_cdn=$(printf %s "${11}" | base64 -d)
expected_analyst_origin=$(printf %s "${12}" | base64 -d)
expected_analyst_host=$(printf %s "${13}" | base64 -d)

deploy_root="$remote_dir/.deploy"
state_dir="$deploy_root/state"
release_root="$deploy_root/releases/$component"
mkdir -p "$state_dir" "$release_root"
chmod 700 "$deploy_root" "$state_dir" "$release_root"
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo "ERROR: another remote deployment is active" >&2; exit 1; }

# 历史秘密文件不再参与新版发布，只收紧权限并保留兼容回滚能力。
# test 服务器 .env 属主 www-data 而 SSH 用户是 ubuntu，chmod 可能 EPERM，需 sudo -n 兜底。
secure_legacy_env_file() {
  secure_path="$1"
  if [ ! -f "$secure_path" ]; then
    return 0
  fi
  if chmod 600 "$secure_path" 2>/dev/null; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n chmod 600 "$secure_path" 2>/dev/null; then
    return 0
  fi
  echo "ERROR: cannot chmod 600 $secure_path (owner differs from SSH user and passwordless sudo is unavailable)" >&2
  echo "HINT: run 'sudo chmod 600 $secure_path' (or 'sudo chown <ssh-user> $secure_path') on the server, then retry" >&2
  return 1
}
secure_legacy_env_file "$remote_dir/.env"
secure_legacy_env_file "$remote_dir/.admin-runtime.env"
secure_legacy_env_file "$remote_dir/.analyst-runtime.env"

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

detect_public_ip() {
  for ip_url in https://ifconfig.me https://ip.sb https://myip.ipip.net https://cip.cc http://ip.3322.net; do
    ip_body=$(curl -fsS --max-time 8 "$ip_url" 2>/dev/null || true)
    ip_value=$(printf '%s\n' "$ip_body" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1)
    if [ -n "$ip_value" ]; then
      printf '%s' "$ip_value"
      return 0
    fi
  done
  return 1
}

worker_running() {
  worker_container="$1"
  worker_attempt=1
  while [ "$worker_attempt" -le 6 ]; do
    if [ "$(docker inspect -f '{{.State.Status}}' "$worker_container" 2>/dev/null || true)" = "running" ]; then
      sleep 5
      if [ "$(docker inspect -f '{{.State.Status}}' "$worker_container" 2>/dev/null || true)" = "running" ]; then
        return 0
      fi
    fi
    worker_attempt=$((worker_attempt + 1))
    sleep 5
  done
  return 1
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
  if [ "$env_name" = "dev" ]; then
    public_ip=$(detect_public_ip || true)
    test "$public_ip" = "$expected_public_host" || return 1
    ss -tln 2>/dev/null | grep -q ':5433' || return 1
  fi

  if [ "$component" = "admin" ]; then
    worker_running fengyu-cron-worker || return 1
    worker_running fengyu-export-worker || return 1
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
    worker_running fengyu-cron-worker || return 1
    worker_running fengyu-export-worker || return 1
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
    # v1 遗留 compose 对 admin 服务声明 DEPLOY_STAFF_* :? 强制插值；analyst 独立 runtime env
    # 只有 3 个 DEPLOY_* 键，缺键会让 compose 直接拒绝回滚。占位值仅用于插值校验（admin 服务
    # 未被启动）；compose 插值中 shell env 优先于 env-file，故仅当 env-file 未提供该键时注入，
    # 避免覆盖 admin legacy 回滚（.admin-runtime.env）中的真实 staff 凭据。
    for legacy_key in DEPLOY_STAFF_ENV_ID DEPLOY_STAFF_TENCENTCLOUD_SECRETID DEPLOY_STAFF_TENCENTCLOUD_SECRETKEY; do
      if ! grep -Eq "^${legacy_key}=." "$remote_dir/.env" "$legacy_runtime" 2>/dev/null; then
        export "$legacy_key=legacy-not-used"
      fi
    done
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

# 保守清理本组件历史镜像：docker images 按精确镜像名过滤（fengyu-admin/fengyu-analyst，不会
# 碰其它项目），保留最近 5 个 tag；当前/上一 release 引用与 latest（legacy 回滚目标）永不删；
# rmi 失败仅告警不阻断发布。
image_name="${image_ref%%:*}"
protected_current_image="$image_ref"
protected_previous_image=$(state_get "$previous_state" image_ref)
image_rank=0
for image_tag in $(docker images "$image_name" --format '{{.Tag}}'); do
  [ "$image_tag" != "<none>" ] || continue
  [ "$image_tag" != "latest" ] || continue
  image_rank=$((image_rank + 1))
  [ "$image_rank" -le 5 ] && continue
  image_candidate="$image_name:$image_tag"
  [ "$image_candidate" != "$protected_current_image" ] || continue
  [ "$image_candidate" != "$protected_previous_image" ] || continue
  docker rmi "$image_candidate" >/dev/null 2>&1 || \
    echo "WARN: failed to prune old image $image_candidate (still referenced?); skipping" >&2
done

echo "RELEASE_OK: $component $release_id"
REMOTE
}

manual_remote_rollback() {
  local component="$1" env="$2"
  # F10 防呆覆盖开关：ROLLBACK_FORCE=1 允许回滚到上次回滚已放弃（已知坏）的版本。
  local rollback_force="${ROLLBACK_FORCE:-0}"
  ssh "$SSH_HOST" sh -s -- \
    "$component" "$env" "$REMOTE_DIR" "$CONTAINER_DB_HOST" "$TARGET_PUBLIC_HOST" "$rollback_force" <<'REMOTE'
set -eu
component="$1"
env_name="$2"
remote_dir="$3"
expected_db_host="$4"
expected_public_host="$5"
rollback_force="$6"
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

detect_public_ip() {
  for ip_url in https://ifconfig.me https://ip.sb https://myip.ipip.net https://cip.cc http://ip.3322.net; do
    ip_body=$(curl -fsS --max-time 8 "$ip_url" 2>/dev/null || true)
    ip_value=$(printf '%s\n' "$ip_body" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1)
    if [ -n "$ip_value" ]; then
      printf '%s' "$ip_value"
      return 0
    fi
  done
  return 1
}

rollback_late_failure() {
  rollback_reason="$1"
  echo "ERROR: $rollback_reason" >&2
  echo "NOTICE: containers were already switched to the previous release; current/previous state files were NOT swapped" >&2
  echo "HINT: check 'docker logs --tail 100 <container>' on the server; rerunning --rollback retries the same previous release" >&2
  exit 1
}

mode=$(state_get "$previous_state" mode)
release_dir=$(state_get "$previous_state" release_dir)
image_id=$(state_get "$previous_state" image_id)
# 防呆：previous 若是上次回滚刚放弃的版本，再次回滚会重新拉起已知坏版本。
rolled_back_marker="$state_dir/$component.rolled-back"
abandoned_release_id=$(state_get "$rolled_back_marker" rolled_back_from 2>/dev/null || true)
target_release_id=$(state_get "$previous_state" release_id)
if [ -n "$abandoned_release_id" ] && [ "$abandoned_release_id" = "$target_release_id" ] && [ "$rollback_force" != "1" ]; then
  echo "ERROR: rollback target '$target_release_id' was already abandoned by an earlier rollback; rolling back again would re-deploy that known-bad release" >&2
  echo "HINT: set ROLLBACK_FORCE=1 to override, or deploy a fixed release instead" >&2
  exit 1
fi
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
  # v1 遗留 compose 对 admin 服务声明 DEPLOY_STAFF_* :? 强制插值；analyst 独立 runtime env
  # 只有 3 个 DEPLOY_* 键，缺键会让 compose 直接拒绝回滚。占位值仅用于插值校验（admin 服务
  # 未被启动）；compose 插值中 shell env 优先于 env-file，故仅当 env-file 未提供该键时注入，
  # 避免覆盖 admin legacy 回滚（.admin-runtime.env）中的真实 staff 凭据。
  for legacy_key in DEPLOY_STAFF_ENV_ID DEPLOY_STAFF_TENCENTCLOUD_SECRETID DEPLOY_STAFF_TENCENTCLOUD_SECRETKEY; do
    if ! grep -Eq "^${legacy_key}=." "$remote_dir/.env" "$runtime" 2>/dev/null; then
      export "$legacy_key=legacy-not-used"
    fi
  done
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
test "$attempt" -le 12 || rollback_late_failure "rollback target is unhealthy"

db_url=$(docker exec "$container" sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null || true)
case "$db_url" in
  *@*:*/*) db_tail=${db_url##*@}; db_host=${db_tail%%:*} ;;
  *) db_host="" ;;
esac
test "$db_host" = "$expected_db_host" || rollback_late_failure "rollback DB host is ${db_host:-unreadable}, expected $expected_db_host"
if [ "$component" = "admin" ]; then
  test "$(docker inspect -f '{{.State.Status}}' fengyu-cron-worker 2>/dev/null || true)" = "running" || rollback_late_failure "cron-worker is not running after rollback"
  test "$(docker inspect -f '{{.State.Status}}' fengyu-export-worker 2>/dev/null || true)" = "running" || rollback_late_failure "export-worker is not running after rollback"
fi
if [ "$env_name" = "dev" ]; then
  public_ip=$(detect_public_ip || true)
  test "$public_ip" = "$expected_public_host" || rollback_late_failure "dev-env public IP check failed after rollback (got ${public_ip:-unreadable})"
  ss -tln 2>/dev/null | grep -q ':5433' || rollback_late_failure "dev-env PG 5433 listener check failed after rollback"
fi

swap="$state_dir/$component.swap.$$"
cp "$current_state" "$swap"
mv "$previous_state" "$current_state"
mv "$swap" "$previous_state"
printf 'rolled_back_from=%s\n' "$(state_get "$previous_state" release_id)" > "$rolled_back_marker"
chmod 600 "$rolled_back_marker"
echo "ROLLBACK_OK: $component -> $(state_get "$current_state" release_id)"
REMOTE
}
