'use server'

import { db } from '@/db'
import { appointments } from '@db/appointment'
import { stores } from '@db/org'
import { eq, desc, and } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { Appointment } from '@/lib/types'

export async function getAppointments(): Promise<Appointment[]> {
  const rows = await db
    .select({
      appointment: appointments,
      storeName: stores.storeName,
    })
    .from(appointments)
    .leftJoin(stores, eq(appointments.storeId, stores.storeId))
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

/** C4: 确认预约 — WHERE status = '待确认' */
export async function confirmAppointment(appointmentId: string): Promise<{ success: boolean; message: string }> {
  const result = await db
    .update(appointments)
    .set({ status: '已确认' })
    .where(and(eq(appointments.appointmentId, appointmentId), eq(appointments.status, '待确认')))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '预约状态已变更，无法确认' }
  }
  revalidatePath('/appointments')
  return { success: true, message: '预约已确认' }
}

/** 签到 — 仅记录时间，不改状态 */
export async function checkinAppointment(appointmentId: string): Promise<{ success: boolean; message: string }> {
  const result = await db
    .update(appointments)
    .set({ checkinAt: new Date() })
    .where(and(eq(appointments.appointmentId, appointmentId), eq(appointments.status, '已确认')))

  if ((result as any).rowCount === 0) {
    return { success: false, message: '预约状态已变更，无法签到' }
  }
  revalidatePath('/appointments')
  return { success: true, message: '签到成功' }
}
