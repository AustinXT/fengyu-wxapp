/**
 * 通用 system_configs JSON 配置加载器
 *
 * 替代原 cronTask 内三个重复的 loadXxxBenefitsConfig 函数。
 *
 * **不缓存**：admin 改了 system_configs.value 后下次 03:00 应即时生效，
 * 不依赖 cron-worker 长驻进程缓存（详见 ticket §1.7 D）。
 *
 * **value 列类型为 text**（参考 db/schema/system-config.ts），需 JSON.parse；
 * 解析失败或 row 不存在 → 返回 null，让调用方决定跳过该 STEP 或继续。
 */

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
