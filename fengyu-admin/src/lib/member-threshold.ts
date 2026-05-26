/**
 * 会员门槛读取 + 缓存（admin 侧）
 *
 * 多实例部署 + Server Actions 无进程保证，采用 unstable_cache + revalidateTag。
 * 权威源：system_configs.new_member_threshold
 * FALLBACK 与 DEFAULT_SETTINGS 对齐（1980）。
 */

import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/db'
import { sql } from 'drizzle-orm'

export const MEMBER_THRESHOLD_FALLBACK = 1980
export const MEMBER_THRESHOLD_TAG = 'new_member_threshold'

/**
 * 获取会员门槛（单位：元）。
 * 失败兜底：DB 异常/无记录/无效值 → 返回 FALLBACK（1980）。
 */
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

/**
 * 主动失效缓存（saveSettings 变更门槛后调用）。
 */
export function invalidateMemberThreshold(): void {
  revalidateTag(MEMBER_THRESHOLD_TAG)
}
