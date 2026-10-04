#!/usr/bin/env bash
set -euo pipefail
ssh -o BatchMode=yes lx-test sudo -n sh -s <<'REMOTE'
set -eu
umask 077
base=/www/wwwroot/fengyu-daily-db/backups
mkdir -p "$base"
target="$base/daily-$(date -u +%Y%m%dT%H%M%SZ).dump"
test ! -e "$target"
test "$(docker exec fengyu-daily-postgres psql -U daily_owner -d fengyu_daily_dev -Atc 'SELECT current_database()')" = fengyu_daily_dev
docker exec fengyu-daily-postgres pg_dump -U daily_owner -d fengyu_daily_dev -Fc --no-owner --no-acl > "$target.partial"
mv "$target.partial" "$target"
echo "日报数据库备份完成：$target"
REMOTE
