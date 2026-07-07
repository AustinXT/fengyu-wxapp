import { db } from '@/db'
import { sql } from 'drizzle-orm'


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
