#!/usr/bin/env node

/**
 * backfill-delete-disabled-skill-tags.js — 一次性删除 skill_tags 里 isValid=false 的标签
 * （含从员工 skills 移除关联）。
 *
 * 背景：
 *   停用功能已移除（2026-07-20，「停用既是删除」决策）：skill_tags.isValid 字段废弃恒 true，
 *   代码不再读写；存量 isValid=false 的标签按「删除」语义清理——与 deleteSkillTag 同口径：
 *   事务内 ① array_remove 从 staff_wechat_users.skills 移除这些标签名；② 删 skill_tags 行。
 *
 * 事务：PREVIEW + 两步 UPDATE/DELETE 同事务，任一失败回滚（保证「字典行不存在 ⇒ 员工身上也不留」）。
 * 幂等：二次运行 isValid=false 行已为 0，UPDATE/DELETE 命中 0 行。
 *
 * 副作用：SET updated_at = NOW()（受影响员工在列表「编辑即浮顶」排序中上浮）。
 *
 * 用法：
 *   # dry-run（默认）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-delete-disabled-skill-tags.js
 *   # 实际提交
 *   ... node db/scripts/backfill-delete-disabled-skill-tags.js --apply
 *
 * 双库（dev 101.34.242.103 / prod 118.178.196.26）各跑；永远显式传 DATABASE_URL。
 */

const { Pool } = require('pg')

const PG_CONFIG = {
  connectionString: process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING,
  max: 3,
}

const apply = process.argv.includes('--apply')

function log(msg) {
  console.log(`[BACKFILL-DELETE-DISABLED-SKILL-TAGS] ${new Date().toISOString()} ${msg}`)
}

// isValid=false 的标签 + 各挂多少员工
const DISABLED_TAGS_SQL = `
SELECT t.name AS tag, t.sort_order,
  (SELECT count(*)::int FROM staff_wechat_users s WHERE t.name = ANY(s.skills)) AS staff_count
FROM skill_tags t
WHERE t.is_valid = false
ORDER BY t.sort_order, t.name
`

// 受影响员工数（skills 含任一 isValid=false 标签名）
const AFFECTED_STAFF_SQL = `
SELECT COUNT(*)::int AS n FROM staff_wechat_users s
WHERE s.skills IS NOT NULL
  AND EXISTS (SELECT 1 FROM unnest(s.skills) x WHERE x IN (SELECT name FROM skill_tags WHERE is_valid = false))
`

// ① 从员工 skills 移除所有 isValid=false 标签名（保留其余；全清空置 NULL）
const UPDATE_STAFF_SQL = `
UPDATE staff_wechat_users s
SET skills = NULLIF(
      ARRAY(SELECT x FROM unnest(s.skills) AS u(x)
            WHERE x NOT IN (SELECT name FROM skill_tags WHERE is_valid = false)),
      ARRAY[]::text[]),
    updated_at = NOW()
WHERE s.skills IS NOT NULL
  AND EXISTS (SELECT 1 FROM unnest(s.skills) x WHERE x IN (SELECT name FROM skill_tags WHERE is_valid = false))
RETURNING s.employee_id
`

// ② 删 skill_tags 里 isValid=false 的行
const DELETE_TAGS_SQL = `DELETE FROM skill_tags WHERE is_valid = false RETURNING name`

async function main() {
  if (!PG_CONFIG.connectionString) {
    console.error('FATAL: DATABASE_URL 或 PG_CONNECTION_STRING 必须设置')
    process.exit(1)
  }

  log(`目标库: ${PG_CONFIG.connectionString.replace(/:[^:@]+@/, ':***@')}`)
  log(`模式: ${apply ? 'APPLY（实际写入）' : 'DRY-RUN（默认；加 --apply 提交）'}`)

  const pool = new Pool(PG_CONFIG)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const tags = await client.query(DISABLED_TAGS_SQL)
    log(`isValid=false 标签：${tags.rows.length} 个`)
    if (tags.rows.length > 0) {
      log('分布（标签 | 排序 | 关联员工数）:')
      for (const r of tags.rows) {
        log(`  ${r.tag} | ${r.sort_order} | ${r.staff_count}`)
      }
    } else {
      log('无 isValid=false 标签（数据已干净）')
    }

    const aff = await client.query(AFFECTED_STAFF_SQL)
    log(`受影响员工：${aff.rows[0].n} 个（skills 将移除这些标签名）`)

    if (apply) {
      const upd = await client.query(UPDATE_STAFF_SQL)
      log(`APPLY 员工 skills：更新 ${upd.rowCount} 行（array_remove isValid=false 标签名）`)

      const del = await client.query(DELETE_TAGS_SQL)
      const names = del.rows.map((r) => r.name)
      log(`APPLY 字典：删除 ${del.rowCount} 个 isValid=false 标签：${names.join(', ') || '（无）'}`)

      await client.query('COMMIT')
      log('事务已提交')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN：已回滚，未写入。加 --apply 提交。')
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch (_) {}
    console.error('FATAL:', err.message)
    console.error(err.stack)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
