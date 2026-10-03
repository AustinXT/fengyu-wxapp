#!/bin/sh
# Linux 行为测试；仅临时文件和 docker 替身，不连接服务器/数据库。
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
awk '/^backup_safe_compose\(\)/ { printing=1 } printing { print } printing && /^}/ { exit }'   "$script_dir/deploy-common.sh" > "$test_root/helper.sh"
. "$test_root/helper.sh"

remote_dir="$test_root/remote"
component=admin
mkdir -p "$remote_dir/data/backup-control/states" "$test_root/mock-bin"
printf '#!/bin/sh\necho compose >> $test_root/compose-calls\n' > "$test_root/mock-bin"/docker
chmod +x "$test_root/mock-bin"/docker
export PATH="$test_root/mock-bin":$PATH
export test_root
control="$remote_dir/data/backup-control"
# 无在途备份允许切换。
backup_safe_compose up -d
test "$(wc -l < "$test_root/compose-calls")" = 1
# 旧版在途状态拒绝。
printf '{"state":"running"}' > "$control/states/one.json"
if backup_safe_compose up -d; then exit 10; else test "$?" = 75; fi
rm "$control/states/one.json"
# 实际内核锁竞争：活动备份时拒绝 compose。
flock "$control/runtime.lock" sh -c 'touch "$1/lock-ready"; sleep 1' sh "$test_root" &
lock_pid=$!
while [ ! -e "$test_root/lock-ready" ]; do sleep 0.05; done
if backup_safe_compose up -d; then exit 11; else test "$?" = 75; fi
test "$(wc -l < "$test_root/compose-calls")" = 1
wait "$lock_pid"
backup_safe_compose up -d
test "$(wc -l < "$test_root/compose-calls")" = 2
# legacy 文件锁保守阻断。
touch "$control/backup.lock"
if backup_safe_compose up -d; then exit 12; else test "$?" = 75; fi
# analyst 不影响 cron，无需抢备份锁。
component=analyst
backup_safe_compose up -d
test "$(wc -l < "$test_root/compose-calls")" = 3
printf 'GUARD_BEHAVIOR_PASS\n'
