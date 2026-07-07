

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

export interface PointsAuditResult {
  mismatchCount: number
  checkedCount: number
}

export async function auditPointsBalance(db: Db): Promise<PointsAuditResult> {
  const rows = (await db.execute(sql`
    WITH sums AS (
      SELECT user_id, COALESCE(SUM(amount), 0)::int AS total_from_txns
      FROM point_transactions
      GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0) AS cached_balance,
           COALESCE(s.total_from_txns, 0) AS expected_balance
      FROM client_wechat_users u
      LEFT JOIN sums s ON s.user_id = u.user_id
     WHERE COALESCE(u.points_balance, 0) <> COALESCE(s.total_from_txns, 0)
  `)) as Array<{
    user_id: string
    cached_balance: number | string
    expected_balance: number | string
  }>

  for (const row of rows) {
    const cached = Number(row.cached_balance)
    const expected = Number(row.expected_balance)
    const detail = JSON.stringify({
      cachedBalance: cached,
      expectedBalance: expected,
      delta: expected - cached,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('points.balanceMismatch', 'customer', ${row.user_id}, ${detail}::jsonb, 'cronTask', NOW())
    `)
  }

  const checkedRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM client_wechat_users
  `)) as Array<{ cnt: number }>
  const checkedCount = Number(checkedRows[0]?.cnt ?? 0)

  if (rows.length > 0) {
    const previewLines = rows.slice(0, 5).map((r) => {
      const cached = Number(r.cached_balance)
      const expected = Number(r.expected_balance)
      return `- ${r.user_id}: cached=${cached} expected=${expected} delta=${expected - cached}`
    })
    const more = rows.length > 5 ? `\n- ...（共 ${rows.length} 条偏差，仅展示前 5）` : ''
    await notifyOps(
      [
        '⚠️ [cron-worker] points.balanceMismatch',
        `偏差用户数：${rows.length} / 检查总数：${checkedCount}`,
        '',
        previewLines.join('\n') + more,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { mismatchCount: rows.length, checkedCount }
}
