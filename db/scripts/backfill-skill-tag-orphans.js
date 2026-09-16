#!/usr/bin/env node

/**
 * backfill-skill-tag-orphans.js — 一次性清理 staff_wechat_users.skills 数组里
 * 已不在 skill_tags 字典表中的孤儿标签名。
 *
 * 背景：
 *   员工 skills 按 name 反范式存在 text[] 数组里（db/schema/lookup.ts 注释：
 *   staff_wechat_users.skills 保持 text[] 不变，skill_tags 仅提供 UI 选项）。
 *   历史 deleteSkillTag/updateSkillTag 只动字典表不级联员工，导致删除/改名后
 *   员工身上残留旧名（如「推广部」被删后仍挂多个员工）。已修复级联
 *   （fengyu-admin/src/actions/skill-tags.ts：deleteSkillTag/updateSkillTag
 *   事务化 array_remove/array_replace），本脚本清理存量孤儿。
 *
 * 选行口径（保守）：
 *   staff_wechat_users.skills 含任意不在 skill_tags.name 集合中的名字。
 *   清洗后只保留字典里存在的名字（isValid 已废弃，停用=删除：isValid=false 的标签行
 *   及其员工关联由 backfill-delete-disabled-skill-tags.js 清理；本脚本只清字典外孤儿）。
 *   全清空的行 skills 置 NULL。
 *
 * 幂等：EXISTS 守护，二次运行 0 行。
 *
 * 副作用：SET updated_at = NOW()（原生 SQL 不触发 Drizzle $onUpdate，手动刷；
 *   与级联修复行为一致），受影响员工会在列表「编辑即浮顶」排序中上浮。
 *
 * 用法：
 *   # dry-run（默认）
 *   DATABASE_URL="postgresql://fengyu:fengyu123@101.34.242.103:5433/fengyu_wxapp" \
 *     node db/scripts/backfill-skill-tag-orphans.js
 *   # 实际提交
 *   ... node db/scripts/backfill-skill-tag-orphans.js --apply
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
  console.log(`[BACKFILL-SKILL-TAG-ORPHANS] ${new Date().toISOString()} ${msg}`)
}

const AFFECTED_WHERE = `
WHERE s.skills IS NOT NULL
  AND EXISTS (SELECT 1 FROM unnest(s.skills) x WHERE x NOT IN (SELECT name FROM skill_tags))
`

const PREVIEW_COUNT_SQL = `
SELECT COUNT(*)::int AS affected_staff FROM staff_wechat_users s
${AFFECTED_WHERE}
`

// 孤儿名分布：哪些名字已不在字典、各挂在多少员工身上
const PREVIEW_ORPHANS_SQL = `
SELECT x AS orphan_tag, COUNT(*)::int AS staff_count
FROM staff_wechat_users s, unnest(s.skills) AS u(x)
WHERE NOT (x IN (SELECT name FROM skill_tags))
GROUP BY x ORDER BY 2 DESC
`

const SAMPLE_SQL = `
SELECT s.employee_id, s.skills
FROM staff_wechat_users s
${AFFECTED_WHERE}
LIMIT 10
`

const UPDATE_SQL = `
UPDATE staff_wechat_users s
SET skills = NULLIF(ARRAY(SELECT unnest(s.skills) INTERSECT SELECT name FROM skill_tags), ARRAY[]::text[]),
    updated_at = NOW()
${AFFECTED_WHERE}
RETURNING s.employee_id
`

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

    const count = await client.query(PREVIEW_COUNT_SQL)
    log(`命中：${count.rows[0].affected_staff} 个员工的 skills 含孤儿标签名`)

    const orphans = await client.query(PREVIEW_ORPHANS_SQL)
    if (orphans.rows.length > 0) {
      log('孤儿标签分布（孤儿名 | 残留员工数）:')
      for (const r of orphans.rows) {
        log(`  ${r.orphan_tag} | ${r.staff_count}`)
      }
    } else {
      log('无孤儿标签（数据已干净）')
    }

    const sample = await client.query(SAMPLE_SQL)
    if (sample.rows.length > 0) {
      log('样本（前 10 个受影响员工：employee_id | skills）:')
      for (const r of sample.rows) {
        log(`  ${r.employee_id} | {${(r.skills || []).join(',')}}`)
      }
    }

    if (apply) {
      const upd = await client.query(UPDATE_SQL)
      log(`APPLY 完成：已清理 ${upd.rowCount} 个员工的 skills 孤儿标签`)
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
