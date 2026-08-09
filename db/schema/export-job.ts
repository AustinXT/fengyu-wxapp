import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * 管理后台异步导出任务。
 *
 * 不使用 PG enum：任务状态仅供 admin worker 内部使用，避免把基础设施状态扩散到三端。
 */
export const adminExportJobs = pgTable(
  'admin_export_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestedByEmployeeId: varchar('requested_by_employee_id', { length: 30 }).notNull(),
    requestedByName: text('requested_by_name').notNull(),
    exportType: varchar('export_type', { length: 80 }).notNull(),
    permissionAction: varchar('permission_action', { length: 80 }).notNull(),
    /** 已规范化的筛选参数；不得保存浏览器传入的行数据或列定义。 */
    requestPayload: jsonb('request_payload').notNull(),
    /** 提交时的权限范围快照，worker 不能依赖 HTTP cookie。 */
    scopeSnapshot: jsonb('scope_snapshot').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    progressRows: integer('progress_rows').notNull().default(0),
    rowCount: integer('row_count'),
    sheetCount: integer('sheet_count'),
    fileCloudPath: text('file_cloud_path'),
    fileName: text('file_name'),
    errorCode: varchar('error_code', { length: 80 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    check(
      'chk_admin_export_job_status',
      sql`${table.status} IN ('queued', 'running', 'ready', 'empty', 'failed', 'expired')`,
    ),
    check('chk_admin_export_job_attempt_count', sql`${table.attemptCount} >= 0`),
    index('idx_admin_export_jobs_claim').on(table.status, table.nextAttemptAt, table.createdAt),
    index('idx_admin_export_jobs_owner').on(table.requestedByEmployeeId, table.createdAt.desc()),
    index('idx_admin_export_jobs_expiry').on(table.expiresAt),
    uniqueIndex('uq_admin_export_jobs_active_request')
      .on(table.requestedByEmployeeId, table.requestHash)
      .where(sql`${table.status} IN ('queued', 'running')`),
  ],
)

export type AdminExportJob = typeof adminExportJobs.$inferSelect
export type NewAdminExportJob = typeof adminExportJobs.$inferInsert
