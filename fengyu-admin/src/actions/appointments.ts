'use server'

import { db } from '@/db'
import { appointments } from '@db/appointment'
import { stores } from '@db/org'
import { eq, desc, and, or, sql, ilike, gte, lt } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Appointment } from '@/lib/types'
import { scopeCondition } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logTransition } from '@/lib/operation-log'

function serializeAppointment(r: {
  appointment: typeof appointments.$inferSelect
  storeName: string | null
}): Appointment {
  const a = r.appointment
  return {
    appointmentId: a.appointmentId,
    status: a.status as Appointment['status'],
    storeId: a.storeId,
    clientUserId: a.clientUserId,
    clientName: a.clientName,
    employeeId: a.employeeId,
    employeeName: a.employeeName,
    saleItemId: a.saleItemId,
    appointmentTime: a.appointmentTime.toISOString(),
    checkinAt: a.checkinAt?.toISOString() ?? null,
    notes: a.notes,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
  }
}

export const getAppointments = withPermission(
  'appointment:list',
  async (session): Promise<Appointment[]> => {
  const rows = await db
    .select({
      appointment: appointments,
      storeName: stores.storeName,
    })
    .from(appointments)
    .leftJoin(stores, eq(appointments.storeId, stores.storeId))
    .where(scopeCondition(session, appointments.storeId))
    // 例外：业务时间优先（预约时间比"最近编辑过"更符合管理员直觉）
    .orderBy(desc(appointments.appointmentTime))
    .limit(500)

  return rows.map(serializeAppointment)
  },
)

/** 预约列表筛选参数 */
export interface AppointmentFilters {
  tab?: 'pending' | 'confirmed' | 'today' | 'all'
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  page?: number
  pageSize?: number
}

/** 分页结果（含各 Tab badge 数量） */
export interface PaginatedAppointments {
  data: Appointment[]
  total: number
  pendingCount: number
  confirmedCount: number
}

/**
 * 服务端分页预约列表 — DB 级过滤 + Tab badge 数量
 *
 * Tab 映射：
 *   pending   → WHERE status = '待确认'
 *   confirmed → WHERE status = '已确认'
 *   today     → WHERE appointment_time >= CURRENT_DATE AND < CURRENT_DATE + 1
 *   all       → 无 Tab 过滤
 *
 * badge 数量通过额外 COUNT 查询获取（scope 范围内全局统计，不受其他筛选影响）。
 */
export const getAppointmentsPaginated = withPermission(
  'appointment:list',
  async (session, filters: AppointmentFilters = {}): Promise<PaginatedAppointments> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE（DB 级过滤）
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, appointments.storeId),
  ]

  // Tab 筛选
  if (filters.tab === 'pending') {
    conditions.push(eq(appointments.status, '待确认'))
  } else if (filters.tab === 'confirmed') {
    conditions.push(eq(appointments.status, '已确认'))
  } else if (filters.tab === 'today') {
    conditions.push(sql`${appointments.appointmentTime} >= CURRENT_DATE`)
    conditions.push(sql`${appointments.appointmentTime} < CURRENT_DATE + INTERVAL '1 day'`)
  }
  // 'all' → 无 tab 过滤

  if (filters.storeId) {
    conditions.push(eq(appointments.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    conditions.push(gte(appointments.appointmentTime, new Date(filters.dateFrom)))
  }
  if (filters.dateTo) {
    conditions.push(lt(appointments.appointmentTime, new Date(filters.dateTo + 'T23:59:59.999')))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(appointments.clientName, pattern),
        ilike(appointments.employeeName, pattern),
      ),
    )
  }

  const whereClause = and(...conditions)

  // 并行执行：数据分页 + 当前 total + badge 数量
  const scopeWhere = scopeCondition(session, appointments.storeId)

  const [countRow, badgeRow, rows] = await Promise.all([
    // COUNT — 当前筛选条件下的总数
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(appointments)
      .where(whereClause)
      .then(r => r[0]),
    // Badge 数量 — scope 范围内全局统计（不受 tab/search 影响）
    db.select({
      pending: sql<number>`cast(count(*) filter (where ${appointments.status} = '待确认') as int)`,
      confirmed: sql<number>`cast(count(*) filter (where ${appointments.status} = '已确认') as int)`,
    })
      .from(appointments)
      .where(scopeWhere)
      .then(r => r[0]),
    // DATA — JOIN + ORDER + LIMIT/OFFSET
    db.select({
        appointment: appointments,
        storeName: stores.storeName,
      })
      .from(appointments)
      .leftJoin(stores, eq(appointments.storeId, stores.storeId))
      .where(whereClause)
      // 例外：业务时间优先（预约时间比"最近编辑过"更符合管理员直觉）
      .orderBy(desc(appointments.appointmentTime))
      .limit(pageSize)
      .offset(offset),
  ])

  return {
    data: rows.map(serializeAppointment),
    total: countRow?.count ?? 0,
    pendingCount: badgeRow?.pending ?? 0,
    confirmedCount: badgeRow?.confirmed ?? 0,
  }
  },
)

/** C4: 确认预约 — WHERE status = '待确认' + scope 校验 */
export const confirmAppointment = withPermission(
  'appointment:confirm',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [apptCtx] = await db
    .select({ clientName: appointments.clientName, employeeName: appointments.employeeName, appointmentTime: appointments.appointmentTime })
    .from(appointments)
    .where(eq(appointments.appointmentId, appointmentId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(appointments)
      .set({ status: '已确认', confirmedAt: new Date() })
      .where(and(
        eq(appointments.appointmentId, appointmentId),
        eq(appointments.status, '待确认'),
        scopeCondition(session, appointments.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logTransition(session, 'appointment.confirm', 'appointment', appointmentId, '待确认', '已确认', {
    clientName: apptCtx?.clientName, employeeName: apptCtx?.employeeName,
    appointmentTime: apptCtx?.appointmentTime?.toISOString(),
  })

  revalidatePath('/appointments')
  return { success: true, message: '预约已确认' }
  },
)

/** 签到 — 仅记录时间，不改状态 + scope 校验 */
export const checkinAppointment = withPermission(
  'appointment:checkin',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [apptCtx] = await db
    .select({ clientName: appointments.clientName, appointmentTime: appointments.appointmentTime })
    .from(appointments)
    .where(eq(appointments.appointmentId, appointmentId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(appointments)
      .set({ checkinAt: new Date() })
      .where(and(
        eq(appointments.appointmentId, appointmentId),
        eq(appointments.status, '已确认'),
        scopeCondition(session, appointments.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logTransition(session, 'appointment.checkin', 'appointment', appointmentId, '已确认', '已签到', {
    clientName: apptCtx?.clientName, appointmentTime: apptCtx?.appointmentTime?.toISOString(),
  })

  revalidatePath('/appointments')
  return { success: true, message: '签到成功' }
  },
)

/** 取消预约 — WHERE status IN ('待确认', '已确认') + scope 校验 */
export const cancelAppointment = withPermission(
  'appointment:confirm',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [apptCtx] = await db
    .select({ status: appointments.status, clientName: appointments.clientName, appointmentTime: appointments.appointmentTime })
    .from(appointments)
    .where(eq(appointments.appointmentId, appointmentId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(appointments)
      .set({ status: '已取消' })
      .where(and(
        eq(appointments.appointmentId, appointmentId),
        sql`${appointments.status} IN ('待确认', '已确认')`,
        scopeCondition(session, appointments.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logTransition(session, 'appointment.cancel', 'appointment', appointmentId, apptCtx?.status ?? '待确认', '已取消', {
    clientName: apptCtx?.clientName, appointmentTime: apptCtx?.appointmentTime?.toISOString(),
  })

  revalidatePath('/appointments')
  return { success: true, message: '预约已取消' }
  },
)
