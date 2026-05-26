/**
 * STEP 9 — store_unbind_requests 孤儿巡检
 *
 * 决议：与 STEP 5/6/8 一致，**只告警不修复**。
 *   - 自动 UPDATE status='已关闭' 会掩盖上游业务流的 bug
 *     （admin updateCustomer 手改 / client.bindStore 重绑 / 历史 data fix）
 *   - 仅写 operation_logs + notifyOps，由运维 / PM 人工处理
 *
 * 4 类异常（每类 1 SELECT 取样 + 1 SELECT 计数）：
 *   O1: status='待处理' AND clientWechatUsers.boundStoreId IS NULL
 *       → 顾客已通过其他路径解绑，pending 应同步关闭
 *   O2: status='待处理' AND clientWechatUsers.boundStoreId <> fromStoreId
 *       → 顾客已绑别的门店，原 pending 失去意义
 *   O3: status='待处理' AND stores.is_closed = true OR stores 行不存在
 *       → 目标门店已关停，无人能审批（FK 已保证存在性，LEFT JOIN IS NULL 仅作 future-proof）
 *   O4: status='待处理' AND createdAt < NOW() - INTERVAL '30 days'
 *       → 超过 30 天无人审批的僵尸申请
 *
 * 告警机制（与 audit-payment-invariants 一致）：
 *   - operation_logs(action='cron.audit_store_unbind_orphans',
 *                     target_type='unbind_orphan',
 *                     target_id=YYYY-MM-DD,
 *                     detail=jsonb { _v, _t, date, total, by_kind: [{ kind, count, samples }, ...] })
 *   - notifyOps 单条 markdown：每类计数 + 前 10 条 requestId 样例提示
 */

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

  // ── O1: 顾客已解绑但 pending 仍挂着 ──
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

  // ── O2: 顾客已绑别的店 ──
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

  // ── O3: 目标门店已关停 / 不存在 ──
  // stores 表有 is_closed（不是 is_active），FK 已保证 store_id 存在，LEFT JOIN IS NULL 仅 future-proof
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

  // ── O4: 超过 30 天 pending ──
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
