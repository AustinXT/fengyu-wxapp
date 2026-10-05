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
printf '#!/bin/sh\nif [ "$1" = inspect ]; then echo "${MOCK_WORKER_STATE:-running}"; else echo compose >> "$test_root/compose-calls"; fi\n' > "$test_root/mock-bin"/docker
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

# 停止的旧worker允许安装恢复代码，残留仍保留给新worker恢复。
component=admin
export MOCK_WORKER_STATE=exited
backup_safe_compose up -d
test "$(wc -l < "$test_root/compose-calls")" = 4
# 两个远端脚本的独立副本必须一致。
awk '/^backup_safe_compose\(\)/ { n++; printing=(n==2) } printing { print } printing && /^}/ { exit }' \
  "$script_dir/deploy-common.sh" > "$test_root/helper-two.sh"
cmp "$test_root/helper.sh" "$test_root/helper-two.sh"
