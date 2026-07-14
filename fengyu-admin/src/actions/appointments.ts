'use server'

import { db } from '@/db'
import { appointments } from '@db/appointment'
import { stores } from '@db/org'
import { eq, desc, and, or, sql, ilike, gte, lt, isNull, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Appointment } from '@/lib/types'
import { scopeCondition, isInScope, requireAdmin } from '@/lib/permissions'
import { withPermission } from '@/lib/with-permission'
import { logTransition, logOperation } from '@/lib/operation-log'
import { pgErrorCode } from '@/lib/pg-error'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'

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
    
    .orderBy(desc(appointments.appointmentTime))
    .limit(500)

  return rows.map(serializeAppointment)
  },
)


export interface AppointmentFilters {
  tab?: 'pending' | 'confirmed' | 'today' | 'all'
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  page?: number
  pageSize?: number
}


export interface PaginatedAppointments {
  data: Appointment[]
  total: number
  pendingCount: number
  confirmedCount: number
}


export const getAppointmentsPaginated = withPermission(
  'appointment:list',
  async (session, filters: AppointmentFilters = {}): Promise<PaginatedAppointments> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, appointments.storeId),
  ]

  
  if (filters.tab === 'pending') {
    conditions.push(eq(appointments.status, '待确认'))
  } else if (filters.tab === 'confirmed') {
    conditions.push(eq(appointments.status, '已确认'))
  } else if (filters.tab === 'today') {
    conditions.push(sql`${appointments.appointmentTime} >= CURRENT_DATE`)
    conditions.push(sql`${appointments.appointmentTime} < CURRENT_DATE + INTERVAL '1 day'`)
  }
  

  if (filters.storeId) {
    conditions.push(eq(appointments.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    
    conditions.push(gte(appointments.appointmentTime, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    conditions.push(lt(appointments.appointmentTime, beijingBoundaryTs(filters.dateTo, '23:59:59')))
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

  
  const scopeWhere = scopeCondition(session, appointments.storeId)

  const [countRow, badgeRow, rows] = await Promise.all([
    
    db.select({ count: sql<number>`cast(count(*) as int)` })
      .from(appointments)
      .where(whereClause)
      .then(r => r[0]),
    
    db.select({
      pending: sql<number>`cast(count(*) filter (where ${appointments.status} = '待确认') as int)`,
      confirmed: sql<number>`cast(count(*) filter (where ${appointments.status} = '已确认') as int)`,
    })
      .from(appointments)
      .where(scopeWhere)
      .then(r => r[0]),
    
    db.select({
        appointment: appointments,
        storeName: stores.storeName,
      })
      .from(appointments)
      .leftJoin(stores, eq(appointments.storeId, stores.storeId))
      .where(whereClause)
      
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


export const confirmAppointment = withPermission(
  'appointment:confirm',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  
  const [apptCtx] = await db
    .select({ clientName: appointments.clientName, employeeName: appointments.employeeName, appointmentTime: appointments.appointmentTime })
    .from(appointments)
    .where(eq(appointments.appointmentId, appointmentId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(appointments)
      .set({ status: '已确认', confirmedAt: nowTs() })
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


export const checkinAppointment = withPermission(
  'appointment:checkin',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  
  const [apptCtx] = await db
    .select({
      status: appointments.status,
      checkinAt: appointments.checkinAt,
      storeId: appointments.storeId,
      clientName: appointments.clientName,
      appointmentTime: appointments.appointmentTime,
    })
    .from(appointments)
    .where(and(
      eq(appointments.appointmentId, appointmentId),
      scopeCondition(session, appointments.storeId),
    ))
    .limit(1)

  if (!apptCtx || !isInScope(session, apptCtx.storeId)) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  if (!['待确认', '已确认'].includes(apptCtx.status)) {
    return { success: false, message: '预约状态不支持签到' }
  }

  
  if (apptCtx.checkinAt) {
    return { success: true, message: '已签到' }
  }

  const now = new Date()
  let result: any
  try {
    result = await db
      .update(appointments)
      .set({ checkinAt: nowTs() })
      .where(and(
        eq(appointments.appointmentId, appointmentId),
        inArray(appointments.status, ['待确认', '已确认']),
        scopeCondition(session, appointments.storeId),
        isNull(appointments.checkinAt),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  
  await logOperation(session, 'appointment.checkin', 'appointment', appointmentId, {
    _v: 3,
    status: apptCtx.status,
    checkinAt: now.toISOString(),
    clientName: apptCtx.clientName,
    appointmentTime: apptCtx.appointmentTime?.toISOString(),
  })

  revalidatePath('/appointments')
  return { success: true, message: '签到成功' }
  },
)


export const cancelAppointment = withPermission(
  'appointment:confirm',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  
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


export const deleteAppointment = withPermission(
  'appointment:delete',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    const [appt] = await db
      .select({ status: appointments.status, clientName: appointments.clientName, appointmentTime: appointments.appointmentTime })
      .from(appointments)
      .where(and(eq(appointments.appointmentId, appointmentId), scopeCondition(session, appointments.storeId)))
      .limit(1)

    if (!appt) {
      return { success: false, message: '预约不存在或无权操作' }
    }
    if (!(['已取消', '已完成', '已关闭'] as string[]).includes(appt.status)) {
      return { success: false, message: '仅「已取消 / 已完成 / 已关闭」预约可删除' }
    }

    const [svcRef] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one FROM service_orders WHERE appointment_id = ${appointmentId} LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    if (svcRef) {
      return { success: false, message: '该预约已关联服务单，不可删除' }
    }

    let result: any
    try {
      result = await db
        .delete(appointments)
        .where(and(
          eq(appointments.appointmentId, appointmentId),
          inArray(appointments.status, ['已取消', '已完成', '已关闭']),
          scopeCondition(session, appointments.storeId),
        ))
    } catch (e) {
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '该预约存在关联数据，无法删除' }
      }
      throw e
    }
    if ((result as any).count === 0) {
      return { success: false, message: '预约状态已变更，请刷新重试' }
    }

    await logOperation(session, 'appointment.delete', 'appointment', appointmentId, {
      snapshot: {
        status: appt.status,
        clientName: appt.clientName,
        appointmentTime: appt.appointmentTime?.toISOString(),
      },
    })

    revalidatePath('/appointments')
    return { success: true, message: '预约已删除' }
  },
)
