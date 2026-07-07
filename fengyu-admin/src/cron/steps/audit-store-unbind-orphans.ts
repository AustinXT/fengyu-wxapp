

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const SAMPLE_LIMIT = 10

type OrphanKind =
  | 'unbound_but_pending'
  | 'bound_to_other_store'
  | 'target_store_closed'
  | 'pending_over_30d'

interface OrphanCategory {
  kind: OrphanKind
  count: number
  samples: Array<{
    request_id: string
    user_id: string
    from_store_id: string
    created_at: string
  }>
}

export interface StoreUnbindOrphansResult {
  totalOrphans: number
  byKind: Partial<Record<OrphanKind, number>>
}

type SampleRow = OrphanCategory['samples'][number]

export async function auditStoreUnbindOrphans(db: Db): Promise<StoreUnbindOrphansResult> {
  const categories: OrphanCategory[] = []

  
  const o1Samples = (await db.execute(sql`
    SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
      FROM store_unbind_requests sur
      JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
     WHERE sur.status = '待处理'
       AND cwu.bound_store_id IS NULL
     ORDER BY sur.created_at
     LIMIT ${SAMPLE_LIMIT}
  `)) as SampleRow[]
  const o1Cnt = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
      FROM store_unbind_requests sur
      JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
     WHERE sur.status = '待处理'
       AND cwu.bound_store_id IS NULL
  `)) as Array<{ cnt: number }>
  if ((o1Cnt[0]?.cnt ?? 0) > 0) {
    categories.push({ kind: 'unbound_but_pending', count: Number(o1Cnt[0].cnt), samples: o1Samples })
  }

  
  const o2Samples = (await db.execute(sql`
    SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
      FROM store_unbind_requests sur
      JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
     WHERE sur.status = '待处理'
       AND cwu.bound_store_id IS NOT NULL
       AND cwu.bound_store_id <> sur.from_store_id
     ORDER BY sur.created_at
     LIMIT ${SAMPLE_LIMIT}
  `)) as SampleRow[]
  const o2Cnt = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
      FROM store_unbind_requests sur
      JOIN client_wechat_users cwu ON cwu.user_id = sur.user_id
     WHERE sur.status = '待处理'
       AND cwu.bound_store_id IS NOT NULL
       AND cwu.bound_store_id <> sur.from_store_id
  `)) as Array<{ cnt: number }>
  if ((o2Cnt[0]?.cnt ?? 0) > 0) {
    categories.push({ kind: 'bound_to_other_store', count: Number(o2Cnt[0].cnt), samples: o2Samples })
  }

  
  
  const o3Samples = (await db.execute(sql`
    SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
      FROM store_unbind_requests sur
      LEFT JOIN stores s ON s.store_id = sur.from_store_id
     WHERE sur.status = '待处理'
       AND (s.store_id IS NULL OR COALESCE(s.is_closed, false) = true)
     ORDER BY sur.created_at
     LIMIT ${SAMPLE_LIMIT}
  `)) as SampleRow[]
  const o3Cnt = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
      FROM store_unbind_requests sur
      LEFT JOIN stores s ON s.store_id = sur.from_store_id
     WHERE sur.status = '待处理'
       AND (s.store_id IS NULL OR COALESCE(s.is_closed, false) = true)
  `)) as Array<{ cnt: number }>
  if ((o3Cnt[0]?.cnt ?? 0) > 0) {
    categories.push({ kind: 'target_store_closed', count: Number(o3Cnt[0].cnt), samples: o3Samples })
  }

  
  const o4Samples = (await db.execute(sql`
    SELECT sur.request_id, sur.user_id, sur.from_store_id, sur.created_at::text
      FROM store_unbind_requests sur
     WHERE sur.status = '待处理'
       AND sur.created_at < NOW() - INTERVAL '30 days'
     ORDER BY sur.created_at
     LIMIT ${SAMPLE_LIMIT}
  `)) as SampleRow[]
  const o4Cnt = (await db.execute(sql`
    SELECT COUNT(*)::int AS cnt
      FROM store_unbind_requests sur
     WHERE sur.status = '待处理'
       AND sur.created_at < NOW() - INTERVAL '30 days'
  `)) as Array<{ cnt: number }>
  if ((o4Cnt[0]?.cnt ?? 0) > 0) {
    categories.push({ kind: 'pending_over_30d', count: Number(o4Cnt[0].cnt), samples: o4Samples })
  }

  const totalOrphans = categories.reduce((acc, c) => acc + c.count, 0)
  const byKind = categories.reduce<Partial<Record<OrphanKind, number>>>((acc, c) => {
    acc[c.kind] = c.count
    return acc
  }, {})

  if (totalOrphans > 0) {
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'unbind_orphans',
      date: dateStamp,
      total: totalOrphans,
      by_kind: categories,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_store_unbind_orphans', 'unbind_orphan', ${dateStamp}, ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = categories.map(
      (c) => `- ${c.kind}: ${c.count} 条（样例 ${c.samples.length} 条）`,
    )
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_store_unbind_orphans',
        `门店解绑申请 orphan 巡检发现 ${totalOrphans} 条异常：`,
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { totalOrphans, byKind }
}
