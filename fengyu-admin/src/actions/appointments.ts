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
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { resolvePaging } from '@/lib/paging'

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

  return rows.map(serializeAppointment)
  },
)

/** 预约列表筛选参数 */
export interface AppointmentFilters {
  tab?: 'pending' | 'confirmed' | 'today' | 'all'
  marketId?: string
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
  const { page, pageSize, offset } = resolvePaging({
    page: filters.page,
    pageSize: filters.pageSize,
    defaultPageSize: 20,
    allowedPageSizes: [10, 20, 50],
  })

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

  if (filters.marketId) conditions.push(storeInMarketCondition(appointments.storeId, filters.marketId))
  if (filters.storeId) conditions.push(eq(appointments.storeId, filters.storeId))
  if (filters.dateFrom) {
    // 日期串拼北京字面 timestamp（appointment_time 库存北京字面）；不经 new Date（date-only 串 UTC 午夜解析→+8h）。
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

/**
 * 签到 — 仅记录时间，不翻状态（对齐 staff appointment.checkin）
 * - 允许 status ∈ ('待确认','已确认')
 * - 幂等：已有 checkin_at 直接返回不覆盖原始时间
 */
export const checkinAppointment = withPermission(
  'appointment:checkin',
  async (session, appointmentId: string): Promise<{ success: boolean; message: string }> => {
  // 预查状态 + checkinAt + 上下文（用于状态/幂等判定与日志）
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

  // 幂等：已签到不覆盖原始时间
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

  // 签到仅打时间戳不翻状态，用 logOperation（旧实现误记 '已确认'→'已签到' 状态翻转，状态机无此态）
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

/**
 * 物理删除预约（仅系统管理员；数据治理用，清理历史/测试预约）。
 *
 * 守卫：仅 已取消 / 已完成 / 已关闭 可删（待确认 / 已确认 为活跃态，禁删）；
 *       被服务单（service_orders.appointment_id）引用 → 禁删。
 * 无从属子表，直接删 + 23503 兜底。
 */
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
