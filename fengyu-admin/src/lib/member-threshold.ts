

import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/db'
import { sql } from 'drizzle-orm'

export const MEMBER_THRESHOLD_FALLBACK = 1980
export const MEMBER_THRESHOLD_TAG = 'new_member_threshold'


export const getMemberThreshold = unstable_cache(
  async (): Promise<number> => {
    try {
      const rows = await db.execute<{ value: string }>(sql`
        SELECT value FROM system_configs WHERE key = 'new_member_threshold'
      `)
      const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
      const v = Number(raw)
      return Number.isFinite(v) && v > 0 ? v : MEMBER_THRESHOLD_FALLBACK
    } catch {
      return MEMBER_THRESHOLD_FALLBACK
    }
  },
  ['new_member_threshold'],
  { tags: [MEMBER_THRESHOLD_TAG], revalidate: 300 },
)


export function invalidateMemberThreshold(): void {
  revalidateTag(MEMBER_THRESHOLD_TAG)
}
