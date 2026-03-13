'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'

export interface SyncHistoryEntry {
  id: number
  time: string
  type: string
  status: string
  operator: string
  duration: string
  detail: Record<string, unknown> | null
}

/**
 * 从 operation_logs 中获取同步相关的历史记录
 */
export async function getSyncHistory(): Promise<SyncHistoryEntry[]> {
  try {
    const rows = await db.execute(sql`
      SELECT id, operator_name, action, detail, created_at
      FROM operation_logs
      WHERE action LIKE 'sync.%'
      ORDER BY created_at DESC
      LIMIT 20
    `)

    return (rows as any[]).map((r: any) => ({
      id: Number(r.id),
      time: r.created_at instanceof Date
        ? r.created_at.toLocaleString('zh-CN')
        : new Date(r.created_at).toLocaleString('zh-CN'),
      type: r.action === 'sync.full' ? '全量同步' : r.action === 'sync.incremental' ? '增量同步' : r.action,
      status: r.detail?.status || '成功',
      operator: r.operator_name,
      duration: r.detail?.duration || '-',
      detail: r.detail,
    }))
  } catch {
    return []
  }
}
