/**
 * 会员门槛读取 + 缓存（admin 侧）
 *
 * 多实例部署 + Server Actions 无进程保证，采用 unstable_cache + revalidateTag。
 * 权威源：system_configs.new_member_threshold
 * FALLBACK 与 DEFAULT_SETTINGS 对齐（1980）。
 *
 * ⚠️ export-worker（`dist/export-worker.mjs`）是独立 node 进程，没有 Next 的 incrementalCache：
 * `unstable_cache` 在那里一调用就抛 `Invariant: incrementalCache missing`，而且抛在回调**外面**，
 * 回调里的 try/catch 兜不住。品项板导出（product-*）因此在 prod 一直失败（2026-09-24 实测 6/6），
 * #292 让客量板也读门槛后会同样失败。所以导出进程（构建期 define 的 FENGYU_EXPORT_WORKER）直接读库，
 * 其它没有 incrementalCache 的场景也按同一错误回退直读，不静默落到 FALLBACK。
 */

import { unstable_cache, revalidateTag } from 'next/cache'
import { db } from '@/db'
import { sql } from 'drizzle-orm'

export const MEMBER_THRESHOLD_FALLBACK = 1980
export const MEMBER_THRESHOLD_TAG = 'new_member_threshold'

/** 直读配置；无记录 / 非正数 / 非数字 → FALLBACK，DB 异常向上抛（由调用方决定是否兜底） */
async function readMemberThreshold(): Promise<number> {
  const rows = await db.execute<{ value: string }>(sql`
    SELECT value FROM system_configs WHERE key = 'new_member_threshold'
  `)
  const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : MEMBER_THRESHOLD_FALLBACK
}

const cachedMemberThreshold = unstable_cache(readMemberThreshold, ['new_member_threshold'], {
  tags: [MEMBER_THRESHOLD_TAG],
  revalidate: 300,
})

function isMissingIncrementalCache(err: unknown): boolean {
  return err instanceof Error && err.message.includes('incrementalCache missing')
}

/**
 * 获取会员门槛（单位：元）。
 * 失败兜底：DB 异常/无记录/无效值 → 返回 FALLBACK（1980）。
 */
export async function getMemberThreshold(): Promise<number> {
  try {
    if (process.env.FENGYU_EXPORT_WORKER === '1') return await readMemberThreshold()
    try {
      return await cachedMemberThreshold()
    } catch (err) {
      if (isMissingIncrementalCache(err)) return await readMemberThreshold()
      throw err
    }
  } catch (err) {
    console.warn('[member-threshold] 读取失败，回退', MEMBER_THRESHOLD_FALLBACK, (err as Error)?.message)
    return MEMBER_THRESHOLD_FALLBACK
  }
}

/**
 * 主动失效缓存（saveSettings 变更门槛后调用）。
 */
export function invalidateMemberThreshold(): void {
  revalidateTag(MEMBER_THRESHOLD_TAG)
}
