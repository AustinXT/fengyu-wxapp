'use server'

import { db } from '@/db'
import { sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'
import { execFile } from 'child_process'
import { resolve } from 'path'

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
  const session = await getSession()
  requirePermission(session, 'sync:status')

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

// ── 同步互斥锁（内存） ──
let syncRunning = false

/**
 * 触发数据同步（通过 child_process 执行 db/scripts/sync-workfine.js）
 */
export async function triggerSync(
  type: 'full' | 'incremental'
): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'sync:trigger')

  if (syncRunning) {
    return { success: false, message: '同步任务正在执行中，请稍后再试' }
  }

  syncRunning = true
  const startTime = Date.now()
  const action = type === 'full' ? 'sync.full' : 'sync.incremental'

  try {
    // 记录同步开始
    await logOperation(session, action, 'sync', type, { status: '同步中' })

    const scriptPath = resolve(process.cwd(), '..', 'db', 'scripts', 'sync-workfine.js')

    await new Promise<void>((resolve, reject) => {
      const args = type === 'incremental' ? ['--incremental'] : []
      execFile('node', [scriptPath, ...args], {
        env: { ...process.env },
        timeout: 5 * 60 * 1000, // 5 分钟超时
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message))
        } else {
          resolve()
        }
      })
    })

    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`

    await logOperation(session, action, 'sync', type, { status: '成功', duration })

    return { success: true, message: `${type === 'full' ? '全量' : '增量'}同步完成（${duration}）` }
  } catch (err) {
    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`
    const errorMsg = err instanceof Error ? err.message : '未知错误'

    await logOperation(session, action, 'sync', type, {
      status: '失败', duration, error: errorMsg,
    })

    return { success: false, message: `同步失败：${errorMsg}` }
  } finally {
    syncRunning = false
  }
}
