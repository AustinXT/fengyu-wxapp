#!/bin/sh
# 仅在可销毁Linux容器中以root运行（需sudo/useradd）；不连接服务器。
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root" /etc/sudoers.d/backup-guard-test' EXIT
chmod 755 "$test_root"
useradd -u 1050 -M -s /bin/sh backup-guard-tester
mkdir -p "$test_root/remote/data/backup-control/states" "$test_root/bin"
control="$test_root/remote/data/backup-control"
chown -R 1001:1001 "$control"
chmod 700 "$control"
awk '/^backup_safe_compose\(\)/ { printing=1 } printing { print } printing && /^}/ { exit }' "$script_dir/deploy-common.sh" > "$test_root/helper.sh"
printf '#!/bin/sh\nif [ "$1" = inspect ]; then echo running; else echo compose >> "%s/calls"; fi\n' "$test_root" > "$test_root/bin/docker"
chmod 755 "$test_root/bin/docker"
printf 'Defaults secure_path="%s/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nbackup-guard-tester ALL=(ALL) NOPASSWD: ALL\n' "$test_root" > /etc/sudoers.d/backup-guard-test
chmod 440 /etc/sudoers.d/backup-guard-test
cat > "$test_root/as-user.sh" <<EOF_USER
set -eu
. "$test_root/helper.sh"
remote_dir="$test_root/remote"
component=admin
export PATH="$test_root/bin:\$PATH"
umask 077
backup_safe_compose up -d
EOF_USER
su -s /bin/sh backup-guard-tester -c "sh '$test_root/as-user.sh'"
test "$(stat -c %u "$control/runtime.lock")" = 1001
test "$(stat -c %a "$control/runtime.lock")" = 600
# uid1001能打开由root umask077创建后修正的同一inode锁。
su -s /bin/sh -c "flock -n '$control/runtime.lock' true" nobody 2>/dev/null && exit 10 || true
setpriv --reuid=1001 --regid=1001 --clear-groups flock -n "$control/runtime.lock" true
# 等待策略：超时拒绝不杀锁持有者；随后等待释放再执行。
. "$test_root/helper.sh"
remote_dir="$test_root/remote"
component=admin
export PATH="$test_root/bin:$PATH"
printf '{"id":"live-test","kind":"scheduled","state":"running"}' > "$control/states/live.json"
flock "$control/runtime.lock" sh -c 'touch "$1/ready"; sleep 1; rm "$1/remote/data/backup-control/states/live.json"' sh "$test_root" &
lock_pid=$!
while [ ! -e "$test_root/ready" ]; do sleep 0.05; done
if su -s /bin/sh backup-guard-tester -c "sh '$test_root/as-user.sh'" > "$test_root/sudo-busy.log" 2>&1; then exit 12; else test "$?" = 75; fi
grep -q live-test "$test_root/sudo-busy.log"
backup_guard_wait=0.1
if backup_safe_compose up -d; then exit 11; else test "$?" = 75; fi
kill -0 "$lock_pid"
backup_guard_wait=3
backup_safe_compose up -d
wait "$lock_pid"
test "$(wc -l < "$test_root/calls")" = 2
grep -q 'backup_guard_wait=180' "$script_dir/deploy-common.sh"
grep -q 'ROLLBACK_DEFERRED' "$script_dir/deploy-common.sh"
echo SUDO_OWNER_WAIT_PASS
