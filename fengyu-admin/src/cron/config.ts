/**
 * 会员门槛（system_configs.new_member_threshold）双层缓存
 *
 * 迁自 fengyu-client/cloudfunctions/cronTask/config.js。
 *   - 30s 内重复调用直接返回缓存（避免 STEP 2 内每个用户都查 DB）
 *   - 5min TTL：超过则强制重读（兜底配置变更后未及时刷新）
 *   - DB 失败 → 返回 FALLBACK_THRESHOLD=1980（与原值一致）
 *
 * cron-worker 是长驻进程，缓存命中率远高于云函数冷启动场景。
 * benefits 类配置（member_level_benefits / birthday_benefits / thanksgiving_benefits）
 * **不缓存**：admin 改了 system_configs.value 后下次 03:00 应即时生效（详见 ticket §1.7 D）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from './run'

const FALLBACK_THRESHOLD = 1980
const CACHE_TTL_MS = 5 * 60 * 1000
const STALE_CHECK_INTERVAL_MS = 30 * 1000

let _cachedValue: number | null = null
let _cachedUpdatedAt: number | null = null
let _lastCheckAt = 0

export async function getMemberThreshold(db: Db): Promise<number> {
  const now = Date.now()

  if (_cachedValue !== null && now - _lastCheckAt < STALE_CHECK_INTERVAL_MS) {
    return _cachedValue
  }

  try {
    const rows = (await db.execute(sql`
      SELECT value, updated_at FROM system_configs WHERE key = 'new_member_threshold'
    `)) as Array<{ value: string; updated_at: Date | string }>
    const row = rows[0]
    if (row) {
      const ts = new Date(row.updated_at).getTime()
      if (ts !== _cachedUpdatedAt || _cachedValue === null) {
        const v = Number(row.value)
        if (Number.isFinite(v) && v > 0) {
          _cachedValue = v
          _cachedUpdatedAt = ts
        }
      }
      _lastCheckAt = now
      if (_cachedValue !== null) return _cachedValue
    }
  } catch (err) {
    console.warn('[cron/config] getMemberThreshold fallback:', (err as Error).message)
  }

  return FALLBACK_THRESHOLD
}

export function invalidateCache(): void {
  _cachedValue = null
  _cachedUpdatedAt = null
  _lastCheckAt = 0
}

const _ttlTimer = setInterval(() => {
  if (_cachedValue !== null && Date.now() - _lastCheckAt > CACHE_TTL_MS) {
    invalidateCache()
  }
}, CACHE_TTL_MS)
if (_ttlTimer && typeof _ttlTimer.unref === 'function') {
  _ttlTimer.unref()
}

export { FALLBACK_THRESHOLD }
