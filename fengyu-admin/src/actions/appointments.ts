'use server'

import { db } from '@/db'
import { appointments } from '@db/appointment'
import { stores } from '@db/org'
import { eq, desc } from 'drizzle-orm'
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

export async function confirmAppointment(appointmentId: string) {
  await db
    .update(appointments)
    .set({ status: '已确认' })
    .where(eq(appointments.appointmentId, appointmentId))
}

export async function checkinAppointment(appointmentId: string) {
  await db
    .update(appointments)
    .set({ checkinAt: new Date() })
    .where(eq(appointments.appointmentId, appointmentId))
}
