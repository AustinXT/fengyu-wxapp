#!/usr/bin/env bun
/**
 * P2-14 skills 批量补录
 *
 * 策略：仅按 position_name 关键字精确匹配"一线业绩岗位"，自动填 skills。
 *       管理岗（经理/督导/财务/行政/培训...）不自动填，留 NULL 让业务方手动决定。
 *
 * 映射规则（按优先级顺序，首个匹配生效）：
 *   1. 含 '美容师' / '美容学员' / '美容顾问' → ['美容师']
 *   2. 含 '养生师' / '养生学徒' / '养生老师' / '养生主管' / '养生副主管' → ['养生师']
 *   3. 含 '推广员' / '推广部' → ['推广师']
 *   4. 其他：不动（保留 NULL）
 *
 * 使用：
 *   # dry-run（默认，只预览不写入）
 *   DATABASE_URL=postgres://.../5434/fengyu bun run scripts/p2-14-backfill-skills.ts
 *
 *   # 实际执行
 *   DATABASE_URL=postgres://.../5434/fengyu bun run scripts/p2-14-backfill-skills.ts --apply
 *
 *   # 指定库
 *   DATABASE_URL=postgres://.../5433/fengyu_wxapp bun run scripts/p2-14-backfill-skills.ts --apply
 *
 * 退出码：
 *   0 — dry-run 或 apply 成功
 *   1 — 错误
 */

import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL ?? process.env.PG_CONNECTION_STRING
if (!connectionString) {
  console.error('ERROR: DATABASE_URL or PG_CONNECTION_STRING is required')
  process.exit(1)
}

const APPLY = process.argv.includes('--apply')

function inferSkills(positionName: string | null): string[] | null {
  if (!positionName) return null
  const p = positionName.trim()
  // 注意顺序：先检查养生/推广再美容（"养生师"含"师"不应被匹配到"美容师"那条；实际字符不冲突但保守顺序）
  if (p.includes('美容师') || p.includes('美容学员') || p.includes('美容顾问')) {
    return ['美容师']
  }
  if (
    p.includes('养生师') ||
    p.includes('养生学徒') ||
    p.includes('养生老师') ||
    p.includes('养生主管') ||
    p.includes('养生副主管')
  ) {
    return ['养生师']
  }
  if (p.includes('推广员') || p.includes('推广部')) {
    return ['推广师']
  }
  return null
}

async function main() {
  const sql = postgres(connectionString!, { max: 1 })
  const dbLabel = connectionString!.replace(/:[^:@]+@/, ':***@')
  console.log(`[backfill-skills] DB: ${dbLabel}`)
  console.log(`[backfill-skills] Mode: ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (preview only)'}`)
  console.log('')

  // 拉所有在职无 skills 员工
  type Row = { employee_id: string; name: string; position_name: string | null }
  const rows = await sql<Row[]>`
    SELECT employee_id, name, position_name
    FROM staff_wechat_users
    WHERE is_resigned = false
      AND (skills IS NULL OR cardinality(skills) = 0)
    ORDER BY employee_id
  `

  // 按映射结果分组
  const beautyRows: Row[] = []
  const wellnessRows: Row[] = []
  const promoterRows: Row[] = []
  const skippedRows: Row[] = []

  for (const r of rows) {
    const inferred = inferSkills(r.position_name)
    if (!inferred) skippedRows.push(r)
    else if (inferred[0] === '美容师') beautyRows.push(r)
    else if (inferred[0] === '养生师') wellnessRows.push(r)
    else if (inferred[0] === '推广师') promoterRows.push(r)
  }

  const toFill = beautyRows.length + wellnessRows.length + promoterRows.length
  console.log(`扫描在职无 skills 员工: ${rows.length} 人`)
  console.log(`  → 自动推断可补录: ${toFill} 人`)
  console.log(`    · 美容师: ${beautyRows.length}`)
  console.log(`    · 养生师: ${wellnessRows.length}`)
  console.log(`    · 推广师: ${promoterRows.length}`)
  console.log(`  → 无法推断保留 NULL: ${skippedRows.length} 人（管理岗/职能岗，待业务方手动补）`)
  console.log('')

  // position 分布 top 10 for skipped
  const skippedPosCnt = new Map<string, number>()
  for (const r of skippedRows) {
    const p = r.position_name || '(NULL)'
    skippedPosCnt.set(p, (skippedPosCnt.get(p) || 0) + 1)
  }
  const topSkipped = [...skippedPosCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.log('未填的 position_name top 10（需业务方 review）：')
  for (const [pos, cnt] of topSkipped) {
    console.log(`  ${String(cnt).padStart(5)}  ${pos}`)
  }
  console.log('')

  if (!APPLY) {
    console.log('[backfill-skills] ⚠ DRY-RUN 模式，未写入。加 --apply 实际执行。')
    await sql.end()
    return
  }

  // APPLY: 事务内分三次 UPDATE
  console.log('[backfill-skills] 开始 APPLY...')
  let updatedTotal = 0
  await sql.begin(async (tx) => {
    if (beautyRows.length > 0) {
      const ids = beautyRows.map((r) => r.employee_id)
      const res = await tx`
        UPDATE staff_wechat_users
        SET skills = ARRAY['美容师']::text[], updated_at = now()
        WHERE employee_id = ANY(${ids}) AND is_resigned = false
          AND (skills IS NULL OR cardinality(skills) = 0)
      `
      console.log(`  UPDATE 美容师: ${res.count} 行`)
      updatedTotal += res.count
    }
    if (wellnessRows.length > 0) {
      const ids = wellnessRows.map((r) => r.employee_id)
      const res = await tx`
        UPDATE staff_wechat_users
        SET skills = ARRAY['养生师']::text[], updated_at = now()
        WHERE employee_id = ANY(${ids}) AND is_resigned = false
          AND (skills IS NULL OR cardinality(skills) = 0)
      `
      console.log(`  UPDATE 养生师: ${res.count} 行`)
      updatedTotal += res.count
    }
    if (promoterRows.length > 0) {
      const ids = promoterRows.map((r) => r.employee_id)
      const res = await tx`
        UPDATE staff_wechat_users
        SET skills = ARRAY['推广师']::text[], updated_at = now()
        WHERE employee_id = ANY(${ids}) AND is_resigned = false
          AND (skills IS NULL OR cardinality(skills) = 0)
      `
      console.log(`  UPDATE 推广师: ${res.count} 行`)
      updatedTotal += res.count
    }
  })
  console.log(`[backfill-skills] ✅ APPLY 完成：${updatedTotal} 行已更新`)

  // 再跑一次预检统计
  const [remain] = await sql<{ cnt: string }[]>`
    SELECT COUNT(*)::text AS cnt FROM staff_wechat_users
    WHERE is_resigned = false AND (skills IS NULL OR cardinality(skills) = 0)
  `
  console.log(`[backfill-skills] 剩余无 skills 在职员工: ${remain.cnt} 人（待业务方手动补）`)

  await sql.end()
}

main().catch((err) => {
  console.error('[backfill-skills] ERROR:', err)
  process.exit(1)
})
