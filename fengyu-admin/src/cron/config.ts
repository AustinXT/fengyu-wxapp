

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
