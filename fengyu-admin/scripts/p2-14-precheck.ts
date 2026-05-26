#!/usr/bin/env bun
/**
 * P2-14 脏数据预检（PR-1 上线阻塞检查）
 *
 * 三段查询（对应 ticket §4.1）：
 *   1. 在职员工无 skills 数量（非 0 → 阻塞 PR-1，业务方需在 admin 补 skills）
 *   2. sale_allocations 历史 role_type NULL 数（观测性，不回填）
 *   3. sale_allocations.total_amount 与 received × ratio 偏差 > 0.02 的记录数
 *
 * 使用：
 *   DATABASE_URL=postgres://.../5434/fengyu bun run scripts/p2-14-precheck.ts
 *   DATABASE_URL=postgres://.../5433/fengyu_wxapp bun run scripts/p2-14-precheck.ts
 *
 * 退出码：
 *   0 — 所有检查通过（第 1 段 = 0）
 *   1 — 第 1 段非 0（在职员工缺 skills），阻塞 PR-1 合并
 */

import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL ?? process.env.PG_CONNECTION_STRING
if (!connectionString) {
  console.error('ERROR: DATABASE_URL or PG_CONNECTION_STRING is required')
  process.exit(2)
}

const sql = postgres(connectionString, { max: 1 })

async function main() {
  console.log(`[p2-14-precheck] DB: ${connectionString.replace(/:[^:@]+@/, ':***@')}`)
  console.log('')

  // 1. 在职员工无 skills（PR-1 阻塞）
  const noSkillsRows = await sql<{ employee_id: string; name: string; position_name: string; store_id: string }[]>`
    SELECT employee_id, name, position_name, store_id
    FROM staff_wechat_users
    WHERE is_resigned = false
      AND (skills IS NULL OR cardinality(skills) = 0)
    ORDER BY employee_id
  `
  console.log(`[1/3] 在职员工无 skills: ${noSkillsRows.length} 人`)
  if (noSkillsRows.length > 0) {
    console.log('      → PR-1 阻塞：需在 admin /employees/:id 补 skills')
    for (const r of noSkillsRows.slice(0, 20)) {
      console.log(`        ${r.employee_id}  ${r.name}  ${r.position_name || '-'}  ${r.store_id || '-'}`)
    }
    if (noSkillsRows.length > 20) {
      console.log(`        ... 和 ${noSkillsRows.length - 20} 人（仅显示前 20 条）`)
    }
  }
  console.log('')

  // 2. 历史 sale_allocations.role_type NULL（仅观测）
  const nullRoleType = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM sale_allocations
    WHERE role_type IS NULL AND is_void = false
  `
  const nullRoleTypeCount = Number(nullRoleType[0]?.cnt ?? 0)
  console.log(`[2/3] sale_allocations.role_type NULL (is_void=false): ${nullRoleTypeCount} 条（观测，不回填）`)
  console.log('')

  // 3. 历史 total_amount 与 received × ratio 偏差 > 0.02 的记录
  const badAmounts = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    WHERE sa.is_void = false
      AND ABS(sa.total_amount::numeric - si.received::numeric * sa.allocation_ratio::numeric) > 0.02
  `
  const badAmountsCount = Number(badAmounts[0]?.cnt ?? 0)
  console.log(`[3/3] sale_allocations.total_amount 与 received × ratio 偏差 > 0.02: ${badAmountsCount} 条（观测，不回填）`)
  console.log('')

  await sql.end()

  if (noSkillsRows.length > 0) {
    console.log('[p2-14-precheck] ❌ FAIL — 第 1 段非 0，PR-1 阻塞')
    process.exit(1)
  }
  console.log('[p2-14-precheck] ✅ PASS')
}

main().catch((err) => {
  console.error('[p2-14-precheck] ERROR:', err)
  process.exit(2)
})
