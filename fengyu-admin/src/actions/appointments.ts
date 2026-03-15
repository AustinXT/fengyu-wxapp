'use server'

import { db } from '@/db'
import { appointments } from '@db/appointment'
import { stores } from '@db/org'
import { eq, desc, and, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Appointment } from '@/lib/types'
import { getSession } from '@/lib/auth'
import { requirePermission, scopeCondition } from '@/lib/permissions'
import { logOperation } from '@/lib/operation-log'

export async function getAppointments(): Promise<Appointment[]> {
  const session = await getSession()
  requirePermission(session, 'appointment:list')

  const rows = await db
    .select({
      appointment: appointments,
      storeName: stores.storeName,
    })
    .from(appointments)
    .leftJoin(stores, eq(appointments.storeId, stores.storeId))
    .where(scopeCondition(session, appointments.storeId))
    .orderBy(desc(appointments.appointmentTime))

  return rows.map((r) => {
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
  })
}

/** C4: 确认预约 — WHERE status = '待确认' + scope 校验 */
export async function confirmAppointment(appointmentId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'appointment:confirm')

  const result = await db
    .update(appointments)
    .set({ status: '已确认' })
    .where(and(
      eq(appointments.appointmentId, appointmentId),
      eq(appointments.status, '待确认'),
      scopeCondition(session, appointments.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logOperation(session, 'appointment.confirm', 'appointment', appointmentId)

  revalidatePath('/appointments')
  return { success: true, message: '预约已确认' }
}

/** 签到 — 仅记录时间，不改状态 + scope 校验 */
export async function checkinAppointment(appointmentId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'appointment:checkin')

  const result = await db
    .update(appointments)
    .set({ checkinAt: new Date() })
    .where(and(
      eq(appointments.appointmentId, appointmentId),
      eq(appointments.status, '已确认'),
      scopeCondition(session, appointments.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logOperation(session, 'appointment.checkin', 'appointment', appointmentId)

  revalidatePath('/appointments')
  return { success: true, message: '签到成功' }
}

/** 取消预约 — WHERE status IN ('待确认', '已确认') + scope 校验 */
export async function cancelAppointment(appointmentId: string): Promise<{ success: boolean; message: string }> {
  const session = await getSession()
  requirePermission(session, 'appointment:confirm')

  const result = await db
    .update(appointments)
    .set({ status: '已取消' })
    .where(and(
      eq(appointments.appointmentId, appointmentId),
      sql`${appointments.status} IN ('待确认', '已确认')`,
      scopeCondition(session, appointments.storeId),
    ))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '预约状态已变更或无权操作' }
  }

  await logOperation(session, 'appointment.cancel', 'appointment', appointmentId)

  revalidatePath('/appointments')
  return { success: true, message: '预约已取消' }
}
