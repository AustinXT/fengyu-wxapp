import "server-only"

import { unstable_cache } from "next/cache"
import { sql } from "drizzle-orm"
import { db } from "@/db"

export const MEMBER_THRESHOLD_FALLBACK = 1980
export const MEMBER_THRESHOLD_TAG = "new_member_threshold"

export const getMemberThreshold = unstable_cache(
  async (): Promise<number> => {
    try {
      const rows = await db.execute<{ value: string }>(sql`
        SELECT value FROM system_configs WHERE key = 'new_member_threshold' LIMIT 1
      `)
      const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
      const value = Number(raw)
      return Number.isFinite(value) && value > 0 ? value : MEMBER_THRESHOLD_FALLBACK
    } catch {
      return MEMBER_THRESHOLD_FALLBACK
    }
  },
  [MEMBER_THRESHOLD_TAG],
  { tags: [MEMBER_THRESHOLD_TAG], revalidate: 300 },
)
