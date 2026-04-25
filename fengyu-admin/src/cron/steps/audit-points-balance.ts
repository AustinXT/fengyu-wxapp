/**
 * STEP 5 — 积分余额一致性校验（迁自 cronTask/index.js:748-783）
 *
 * 校验 client_wechat_users.points_balance 与 point_transactions 流水合计是否一致。
 *
 * 决策 D7：自动修补会掩盖上游 bug，**只告警不修复**。
 *   - 发现偏差仅 INSERT operation_logs(action='points.balanceMismatch')
 *   - 永远不 UPDATE client_wechat_users.points_balance
 *
 * 此 STEP 无事务（与原 cronTask 一致）：
 *   仅一次 SELECT 计算偏差 + 逐条 INSERT operation_logs；
 *   单条 INSERT 失败 → 抛到入口 STEP 级 try/catch 后跳过下一 STEP，但其他 STEP 已完成不受影响。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'

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

  return { mismatchCount: rows.length, checkedCount }
}
