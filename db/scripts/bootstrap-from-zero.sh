#!/usr/bin/env bash
# bootstrap-from-zero.sh
#
# 作用：从零空库 apply 全部 migration，绕过两类历史 bug：
#   1) 0018_black_madrox.sql 的 enum-add-then-use 限制（PG 错误码 55P04）
#      → 拆 2 事务：ADD VALUE 独立 commit + 剩余 SQL；
#      → DROP DEFAULT + 剩余 SQL + SET DEFAULT（绕过 column default 依赖 DROP TYPE）
#   2) 0023_keen_freak.sql L44-L47 与 0022 重复 ADD CONSTRAINT
#      → 0023 前预 DROP CONSTRAINT IF EXISTS 4 个约束，让 0023 顺利重 ADD
#      （生产 5434 baseline reset 时 0022/0023 用手工 INSERT drizzle_migrations，
#        从未真正 drizzle migrate 过这两条；hash 字段是文件名不是真 sha256）
#
# 适用场景：
#   - 新机器从零 clone 后初始化本地 PG
#   - CI 验证 migration 全量可 apply
#   - 临时 docker PG 跑回归
#
# **不适用**：
#   - 生产 5434 / 冷备 5433（已 apply 过，用普通 `npm run db:migrate` 即可）
#   - 已有业务数据的库
#
# 策略：纯 psql 全程，每个 migration 独立事务 + INSERT drizzle_migrations。
# 不依赖 drizzle migrate（避免它把全部 pending 包成单一大事务，0018 失败时 0001-0017
# 也回滚）。脚本完成后 drizzle migrate 看 hash 已记录 → 跳过；后续增量 migration
# 仍可用 `npm run db:migrate`。
#
# 幂等：每个 migration apply 前查 drizzle_migrations.hash，已存在则 SKIP。
#
# Usage:
#   DATABASE_URL="postgresql://user:pass@host:5432/db" bash db/scripts/bootstrap-from-zero.sh

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL must be set" >&2
  echo "Usage: DATABASE_URL=postgresql://... bash $0" >&2
  exit 1
fi

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DB_DIR"

echo "==> Bootstrap target: $DATABASE_URL"

# 帮助函数：计算 sha256 hash（与 drizzle 算法一致）
compute_hash() {
  local f=$1
  node -e "
    const fs = require('fs');
    const crypto = require('crypto');
    console.log(crypto.createHash('sha256').update(fs.readFileSync('$f', 'utf-8')).digest('hex'));
  "
}

# 帮助函数：从 journal 读 entry.when（毫秒时间戳）
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

# 记录 hash 到 drizzle_migrations
record_migration() {
  local hash=$1
  local when=$2
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "INSERT INTO drizzle.\"__drizzle_migrations\" (hash, created_at) VALUES ('$hash', $when);" \
    >/dev/null
}

ensure_drizzle_table

# ============================================================
# 主循环：按 journal 顺序遍历每个 migration
# ============================================================
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
      # 特殊：ADD VALUE 拆独立事务 + DROP DEFAULT 绕 DROP TYPE 依赖 + 剩余 SQL + 恢复 DEFAULT
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
      # 特殊：L44-L47 与 0022 重复 ADD CONSTRAINT（生产 5434 baseline reset 时
      # 这两个 migration 是手工 INSERT 的，从未真正 apply 过；从零跑会撞 dup）
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
      # 特殊：末尾手写 `ALTER DATABASE fengyu SET timezone=...` 硬编码生产库名。
      # 0028 注释原文："防漂移声明，零业务影响"。临时 PG 不需要锁定 timezone，跳过该行。
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

# ============================================================
# 验证
# ============================================================
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
