

import { sql } from 'drizzle-orm'
import type { Db } from '../run'

export type ConfigKey = 'member_level_benefits' | 'birthday_benefits' | 'thanksgiving_benefits'

export async function loadJsonConfig<T = Record<string, unknown>>(
  db: Db,
  key: ConfigKey,
): Promise<T | null> {
  const rows = (await db.execute(sql`
    SELECT value FROM system_configs WHERE key = ${key}
  `)) as Array<{ value: string | null }>

  if (!rows[0]?.value) {
    console.warn(`[cron-worker] ${key} 配置不存在，跳过对应 STEP`)
    return null
  }

  try {
    const raw = rows[0].value
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T
  } catch (err) {
    console.error(`[cron-worker] ${key} 解析失败:`, (err as Error).message)
    return null
  }
}
