'use server'

import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { adminExportJobs } from '@db/export-job'
import { ApiError } from '@/lib/api-error'
import { deleteByCloudPaths } from '@/lib/cloudbase'
import { logOperation } from '@/lib/operation-log'
import { requirePermission } from '@/lib/permissions'
import { scopeSessionToAllActions } from '@/lib/action-scope'
import { withAnyPermission } from '@/lib/with-permission'
import type { AuthSession } from '@/lib/types'
import {
  DATA_CENTER_VIEW_REQUIRED_ACTIONS,
  EXPORT_LABEL_BY_TYPE,
  EXPORT_PERMISSION_ACTIONS,
  EXPORT_PERMISSIONS_BY_TYPE,
  exportJobLabel,
  findExportPermissionAction,
  type CreateExportJobInput,
  type DataCenterExportPayload,
  type ExportJobListItem,
  type ExportJobPayload,
  type ExportJobStatus,
  type ExportJobType,
} from '@/lib/export-job-types'
import {
  parseCreateExportJobInput,
  parseExportPayload,
  parseExportStatus,
  parseExportType,
  snapshotExportSession,
} from '@/lib/export-job-schema'

const ACTIVE_STATUSES = ['queued', 'running'] as const
const RETRYABLE_STATUSES = ['failed', 'empty', 'expired'] as const

function normalizePayload(input: CreateExportJobInput): CreateExportJobInput {
  if (input.exportType === 'data-center') {
    const params = Object.fromEntries(
      Object.entries(input.payload.params)
        .filter(([key, value]) => !['page', 'size', 'tab'].includes(key) && value !== '')
        .sort(([left], [right]) => left.localeCompare(right)),
    )
    return {
      exportType: input.exportType,
      payload: {
        view: input.payload.view,
        ...(input.payload.metric ? { metric: input.payload.metric } : {}),
        params,
      },
    }
  }

  return {
    exportType: input.exportType,
    payload: Object.fromEntries(
      Object.entries(input.payload)
        .filter(([key, value]) => !['page', 'size'].includes(key) && value !== '')
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

/**
 * 导出任务的权限闸门：先按 exportType 的「任一即可」取记账用的 permissionAction，
 * data-center 再按视图要求「全部满足」（#367，见 `DATA_CENTER_VIEW_REQUIRED_ACTIONS`）。
 * 发起与重试共用，保证两条入口口径一致。
 */
function requireExportPermission(
  session: AuthSession,
  exportType: ExportJobType,
  payload: ExportJobPayload,
): string {
  const permissionAction = findExportPermissionAction(
    exportType,
    session.permissions.actions,
  ) ?? EXPORT_PERMISSIONS_BY_TYPE[exportType][0]
  requirePermission(session, permissionAction)

  if (exportType === 'data-center') {
    // 两条入口都已过 zod 校验（view ∈ DATA_CENTER_EXPORT_VIEWS）；查不到仍按拒绝处理，不放行。
    const required = DATA_CENTER_VIEW_REQUIRED_ACTIONS[(payload as DataCenterExportPayload).view]
    if (!required) throw new Error('INVALID_PARAMS: 导出视图无效')
    for (const action of required) requirePermission(session, action)
    // 与 withAllPermissions 同口径：多项权限必须落在同一条角色授权上，不能拼接两个角色的范围。
    if (required.length > 1 && scopeSessionToAllActions(session, required).roles.length === 0) {
      throw new Error('PERMISSION_DENIED: 多项权限必须由同一角色授权范围同时提供')
    }
  }
  return permissionAction
}

function requestHash(input: CreateExportJobInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function serializeJob(row: typeof adminExportJobs.$inferSelect): ExportJobListItem {
  const exportType = parseExportType(row.exportType)
  const status = parseExportStatus(row.status)
  if (!exportType || !status) {
    throw new Error('INVALID_STATE: 导出任务状态异常')
  }
  const payload = row.requestPayload as CreateExportJobInput['payload']
  return {
    id: row.id,
    exportType,
    label: exportJobLabel(exportType, payload),
    status: status as ExportJobStatus,
    rowCount: row.rowCount,
    sheetCount: row.sheetCount,
    fileName: row.fileName,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }
}

/** 创建任务后立即返回，实际数据查询和文件生成由 export-worker 完成。 */
export const createExportJob = withAnyPermission(
  EXPORT_PERMISSION_ACTIONS,
  async (session, rawInput: CreateExportJobInput) => {
    const input = normalizePayload(parseCreateExportJobInput(rawInput))
    const permissionAction = requireExportPermission(session, input.exportType, input.payload)

    const hash = requestHash(input)
    const inserted = await db
      .insert(adminExportJobs)
      .values({
        requestedByEmployeeId: session.employeeId,
        requestedByName: session.name,
        exportType: input.exportType,
        permissionAction,
        requestPayload: input.payload,
        scopeSnapshot: snapshotExportSession(session),
        requestHash: hash,
      })
      .onConflictDoNothing({
        target: [adminExportJobs.requestedByEmployeeId, adminExportJobs.requestHash],
        where: sql`${adminExportJobs.status} IN ('queued', 'running')`,
      })
      .returning()

    const created = inserted[0]
    if (created) {
      await logOperation(session, 'export_job.create', 'admin_export_jobs', String(created.id), {
        exportType: input.exportType,
        permissionAction,
      })
      return { id: created.id, reused: false }
    }

    const [active] = await db
      .select()
      .from(adminExportJobs)
      .where(and(
        eq(adminExportJobs.requestedByEmployeeId, session.employeeId),
        eq(adminExportJobs.requestHash, hash),
        inArray(adminExportJobs.status, ACTIVE_STATUSES),
      ))
      .orderBy(desc(adminExportJobs.createdAt))
      .limit(1)

    if (!active) {
      throw new Error('CONFLICT: 相同导出任务正在创建，请稍后重试')
    }
    return { id: active.id, reused: true }
  },
)

/** 任务中心只返回当前提交人的最近任务，文件与错误信息都不跨账号泄露。 */
export const listMyExportJobs = withAnyPermission(
  EXPORT_PERMISSION_ACTIONS,
  async (session): Promise<ExportJobListItem[]> => {
    const rows = await db
      .select()
      .from(adminExportJobs)
      .where(eq(adminExportJobs.requestedByEmployeeId, session.employeeId))
      .orderBy(desc(adminExportJobs.createdAt))
      .limit(30)
    return rows.map(serializeJob)
  },
)

/** 失败、空结果和已过期任务可由原提交人重新排队；重新执行会重新读取当前数据。 */
export const retryMyExportJob = withAnyPermission(
  EXPORT_PERMISSION_ACTIONS,
  async (session, id: number): Promise<{ id: number }> => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('INVALID_PARAMS: 导出任务编号无效')
    }
    const [job] = await db
      .select()
      .from(adminExportJobs)
      .where(and(
        eq(adminExportJobs.id, id),
        eq(adminExportJobs.requestedByEmployeeId, session.employeeId),
      ))
      .limit(1)
    if (!job) throw new Error('NOT_FOUND: 导出任务不存在')

    const exportType = parseExportType(job.exportType)
    if (!exportType) throw new Error('INVALID_STATE: 导出任务类型异常')
    let payload: ExportJobPayload
    try {
      payload = parseExportPayload(exportType, job.requestPayload)
    } catch {
      throw new Error('INVALID_STATE: 导出任务参数异常')
    }
    const permissionAction = requireExportPermission(session, exportType, payload)
    if (!RETRYABLE_STATUSES.includes(job.status as (typeof RETRYABLE_STATUSES)[number])) {
      throw new Error('INVALID_STATE: 当前任务不能重新导出')
    }

    const activeRows = await db
      .select({ id: adminExportJobs.id })
      .from(adminExportJobs)
      .where(and(
        eq(adminExportJobs.requestedByEmployeeId, session.employeeId),
        eq(adminExportJobs.requestHash, job.requestHash),
        inArray(adminExportJobs.status, ACTIVE_STATUSES),
      ))
      .limit(1)
    if (activeRows.length > 0) {
      throw new Error('CONFLICT: 已有相同导出任务正在生成')
    }

    // 已过期但尚未被 maintenance 扫到的文件也必须先删除；失败时保留任务和路径，
    // 让用户稍后重试，避免清空引用后留下不可回收的 CloudBase 文件。
    if (job.fileCloudPath) {
      try {
        await deleteByCloudPaths([job.fileCloudPath])
      } catch (err) {
        console.error(`[export-jobs] retry cleanup failed for job ${job.id}:`, err)
        throw new ApiError('INVALID_STATE', '旧导出文件清理失败，请稍后重试')
      }
    }

    await db
      .update(adminExportJobs)
      .set({
        status: 'queued',
        requestedByName: session.name,
        permissionAction,
        scopeSnapshot: snapshotExportSession(session),
        attemptCount: 0,
        nextAttemptAt: new Date(),
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        expiresAt: null,
        progressRows: 0,
        rowCount: null,
        sheetCount: null,
        fileCloudPath: null,
        fileName: null,
        errorCode: null,
        errorMessage: null,
      })
      .where(and(
        eq(adminExportJobs.id, id),
        eq(adminExportJobs.requestedByEmployeeId, session.employeeId),
      ))

    await logOperation(session, 'export_job.retry', 'admin_export_jobs', String(id), {
      exportType,
      label: EXPORT_LABEL_BY_TYPE[exportType],
    })
    return { id }
  },
)
