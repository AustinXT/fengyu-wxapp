#!/usr/bin/env bash






























set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL must be set" >&2
  echo "Usage: DATABASE_URL=postgresql://... bash $0" >&2
  exit 1
fi

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DB_DIR"

echo "==> Bootstrap target: $DATABASE_URL"


compute_hash() {
  local f=$1
  node -e "
    const fs = require('fs');
    const crypto = require('crypto');
    console.log(crypto.createHash('sha256').update(fs.readFileSync('$f', 'utf-8')).digest('hex'));
  "
}


get_when() {
  local tag=$1
  node -e "
    const j = JSON.parse(require('fs').readFileSync('migrations/meta/_journal.json'));
    const e = j.entries.find(e => e.tag === '$tag');
    if (!e) { console.error('Not in journal: $tag'); process.exit(1); }
    console.log(e.when);
  "
}

ensure_drizzle_table() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.\"__drizzle_migrations\" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    );
  " >/dev/null
}

is_applied() {
  local hash=$1
  psql "$DATABASE_URL" -tAc "
    SELECT EXISTS (SELECT 1 FROM drizzle.\"__drizzle_migrations\" WHERE hash = '$hash');
  " 2>/dev/null | tr -d '[:space:]'
}


record_migration() {
  local hash=$1
  local when=$2
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "INSERT INTO drizzle.\"__drizzle_migrations\" (hash, created_at) VALUES ('$hash', $when);" \
    >/dev/null
}

ensure_drizzle_table




ALL_TAGS=$(node -e "
  const j = JSON.parse(require('fs').readFileSync('migrations/meta/_journal.json'));
  console.log(j.entries.map(e => e.tag).join('\n'));
")

SKIPPED=0
APPLIED=0
for tag in $ALL_TAGS; do
  f="migrations/${tag}.sql"
  if [[ ! -f "$f" ]]; then
    echo "  -> $tag SKIP（SQL 文件不存在）"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  hash=$(compute_hash "$f")
  if [[ "$(is_applied "$hash")" == "t" ]]; then
    echo "  -> $tag SKIP（hash 已记录）"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  when=$(get_when "$tag")

  case "$tag" in
    0018_black_madrox)

      echo "  -> $tag APPLY（特殊：0018 拆 2 事务）"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
        "ALTER TYPE \"public\".\"payment_flow_status\" ADD VALUE '待审批' BEFORE '已支付';" \
        >/dev/null
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
        "ALTER TABLE \"public\".\"sale_orders\" ALTER COLUMN \"sale_order_type\" DROP DEFAULT;" \
        >/dev/null
      tail -n +2 "$f" > /tmp/0018-rest.sql
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f /tmp/0018-rest.sql >/dev/null
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
        "ALTER TABLE \"public\".\"sale_orders\" ALTER COLUMN \"sale_order_type\" SET DEFAULT '销售单'::\"public\".\"sale_order_type\";" \
        >/dev/null
      ;;
    0023_keen_freak)


      echo "  -> $tag APPLY（特殊：预 DROP 4 个重复约束）"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
        ALTER TABLE \"sale_allocations\" DROP CONSTRAINT IF EXISTS \"chk_sale_alloc_ratio\";
        ALTER TABLE \"service_commissions\" DROP CONSTRAINT IF EXISTS \"chk_svc_comm_commission_amount\";
        ALTER TABLE \"service_commissions\" DROP CONSTRAINT IF EXISTS \"chk_svc_comm_commission_rate\";
        ALTER TABLE \"service_commissions\" DROP CONSTRAINT IF EXISTS \"chk_svc_comm_alloc_ratio\";
      " >/dev/null
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null
      ;;
    0028_fine_maelstrom)


      echo "  -> $tag APPLY（特殊：跳过末尾硬编码 ALTER DATABASE 行）"
      grep -v "^ALTER DATABASE fengyu" "$f" > /tmp/0028-no-alter-db.sql
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f /tmp/0028-no-alter-db.sql >/dev/null
      ;;
    *)
      echo "  -> $tag APPLY"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null
      ;;
  esac

  record_migration "$hash" "$when"
  APPLIED=$((APPLIED + 1))
done




TOTAL=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM drizzle.\"__drizzle_migrations\";" | tr -d '[:space:]')
JOURNAL_COUNT=$(node -e "
  const j = JSON.parse(require('fs').readFileSync('migrations/meta/_journal.json'));
  console.log(j.entries.length);
")

echo ""
echo "==> Bootstrap complete!"
echo "    Applied this run:        $APPLIED"
echo "    Skipped (already done):  $SKIPPED"
echo "    drizzle_migrations rows: $TOTAL"
echo "    journal entries:         $JOURNAL_COUNT"

if [[ "$TOTAL" != "$JOURNAL_COUNT" ]]; then
  echo "    WARNING: count mismatch（可能 journal 含未 apply 的 entry，或表含外部 INSERT 行）" >&2
fi
