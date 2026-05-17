import { db } from '@/db'
import { sql } from 'drizzle-orm'

/**
 * 积分折算元比例（system_configs.points_to_yuan_rate，默认 0.01 即 100 积分 = 1 元）。
 *
 * 内部 PG 工具——给已在 Server Action 中通过 HOF 鉴权的调用方使用
 * （如 refunds 的退款计算）；不再是独立 Server Action，避免内嵌权限冲突
 * （refund 角色不持 system:config）。
 */
export async function getPointsToYuanRate(): Promise<number> {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = 'points_to_yuan_rate' LIMIT 1
    `)
    const raw = (rows as any[])[0]?.value
    const parsed = raw !== undefined ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01
  } catch {
    return 0.01
  }
}
