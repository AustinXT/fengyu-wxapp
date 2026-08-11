import { z } from 'zod'
import {
  DATA_CENTER_EXPORT_VIEWS,
  EXPORT_JOB_TYPES,
  EXPORT_JOB_STATUSES,
  type CreateExportJobInput,
  type ExportJobPayload,
  type ExportJobType,
} from '@/lib/export-job-types'
import type { AuthSession } from '@/lib/types'

const queryPayloadSchema = z
  .record(z.string().max(240, '筛选条件过长'))
  .refine((value) => Object.keys(value).length <= 40, '筛选条件过多')

const dataCenterPayloadSchema = z.object({
  view: z.enum(DATA_CENTER_EXPORT_VIEWS),
  params: queryPayloadSchema,
  metric: z.string().min(1).max(80).optional(),
}).strict()

export const createExportJobSchema = z.union([
  z.object({
    exportType: z.enum(EXPORT_JOB_TYPES.filter((type) => type !== 'data-center') as [Exclude<ExportJobType, 'data-center'>, ...Exclude<ExportJobType, 'data-center'>[]]),
    payload: queryPayloadSchema,
  }).strict(),
  z.object({
    exportType: z.literal('data-center'),
    payload: dataCenterPayloadSchema,
  }).strict(),
])

export function parseCreateExportJobInput(input: unknown): CreateExportJobInput {
  return createExportJobSchema.parse(input) as CreateExportJobInput
}

export function parseExportType(value: unknown): ExportJobType | null {
  const parsed = z.enum(EXPORT_JOB_TYPES).safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseExportStatus(value: unknown) {
  const parsed = z.enum(EXPORT_JOB_STATUSES).safeParse(value)
  return parsed.success ? parsed.data : null
}

const exportSessionSchema = z.object({
  employeeId: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  phone: z.string().max(40),
  roles: z.array(z.object({
    role: z.string().min(1).max(64),
    roleName: z.string().max(30).optional(),
    canAccessAdmin: z.boolean().optional(),
    isSuperAdmin: z.boolean().optional(),
    isStoreManager: z.boolean().optional(),
    scopeId: z.string().min(1).max(80),
    scopeType: z.enum(['总部', '市场', '门店']),
  })).max(20),
  permissions: z.object({
    actions: z.array(z.string().min(1).max(100)).max(300),
    scopeStoreIds: z.array(z.string().min(1).max(80)).max(2000),
    scopeOrgNodeIds: z.array(z.string().min(1).max(80)).max(3000).optional(),
    scopeDeptNodeIds: z.array(z.string().min(1).max(80)).max(3000).optional(),
  }),
}).strict()

/** 任务创建时冻结权限范围，worker 不读取浏览器 cookie。 */
export function snapshotExportSession(session: AuthSession): AuthSession {
  return {
    employeeId: session.employeeId,
    name: session.name,
    phone: session.phone,
    roles: session.roles.map((role) => ({ ...role })),
    permissions: {
      actions: [...session.permissions.actions],
      scopeStoreIds: [...session.permissions.scopeStoreIds],
      ...(session.permissions.scopeOrgNodeIds
        ? { scopeOrgNodeIds: [...session.permissions.scopeOrgNodeIds] }
        : {}),
      ...(session.permissions.scopeDeptNodeIds
        ? { scopeDeptNodeIds: [...session.permissions.scopeDeptNodeIds] }
        : {}),
    },
  }
}

export function parseExportSession(value: unknown): AuthSession {
  return exportSessionSchema.parse(value) as AuthSession
}

export function parseExportPayload(
  exportType: ExportJobType,
  value: unknown,
): ExportJobPayload {
  if (exportType === 'data-center') {
    return dataCenterPayloadSchema.parse(value)
  }
  return queryPayloadSchema.parse(value)
}
