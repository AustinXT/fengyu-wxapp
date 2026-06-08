import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}))

vi.mock('@db/appointment', () => ({
  appointments: {
    appointmentId: 'appointment_id',
    status: 'status',
    storeId: 'store_id',
    appointmentTime: 'appointment_time',
    clientName: 'client_name',
    employeeName: 'employee_name',
    checkinAt: 'checkin_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  isNull: vi.fn((col) => ({ type: 'isNull', col })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { confirmAppointment, checkinAppointment, cancelAppointment, getAppointmentsPaginated, deleteAppointment } from './appointments'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'
import { eq, ilike } from 'drizzle-orm'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['appointment:confirm', 'appointment:checkin'], scopeStoreIds: [] },
}

function setupUpdate(count: number) {
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
}

/** mock db.select() 链，用于状态变更前获取上下文 */
function mockSelectBefore(rows: any[] = [{}]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValue(chain)
}

// ── confirmAppointment ────────────────────────────────────────────────────────

describe('confirmAppointment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
  })

  it('rowCount=0 → 状态已变更或无权', async () => {
    setupUpdate(0)
    const result = await confirmAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('预约状态已变更或无权操作')
  })

  it('rowCount=1 → 确认成功', async () => {
    setupUpdate(1)
    const result = await confirmAppointment('apt-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('预约已确认')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(confirmAppointment('apt-001')).rejects.toThrow('connection lost')
  })
})

// ── checkinAppointment ────────────────────────────────────────────────────────

describe('checkinAppointment — 对齐 staff（待确认∪已确认 + 幂等 + 不翻状态）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    // 默认：已确认、未签到
    mockSelectBefore([{ status: '已确认', checkinAt: null, storeId: 'store-1', clientName: '李', appointmentTime: new Date('2026-03-15T14:00:00Z') }])
  })

  it('预约不存在 → 状态已变更或无权', async () => {
    mockSelectBefore([])
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('预约状态已变更或无权操作')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('不在 scope → 状态已变更或无权', async () => {
    ;(isInScope as any).mockReturnValue(false)
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('预约状态已变更或无权操作')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('status=已完成（不在待确认∪已确认）→ 不支持签到', async () => {
    mockSelectBefore([{ status: '已完成', checkinAt: null, storeId: 'store-1', clientName: '李', appointmentTime: new Date() }])
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不支持签到')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('已有 checkinAt（幂等）→ 成功且不覆盖、不 UPDATE', async () => {
    mockSelectBefore([{ status: '已确认', checkinAt: new Date('2026-03-15T14:05:00Z'), storeId: 'store-1', clientName: '李', appointmentTime: new Date() }])
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已签到')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('status=待确认 + 未签到 → 签到成功', async () => {
    mockSelectBefore([{ status: '待确认', checkinAt: null, storeId: 'store-1', clientName: '李', appointmentTime: new Date() }])
    setupUpdate(1)
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('签到成功')
  })

  it('rowCount=0（并发被改）→ 状态已变更或无权', async () => {
    setupUpdate(0)
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('预约状态已变更或无权操作')
  })

  it('rowCount=1 → 签到成功', async () => {
    setupUpdate(1)
    const result = await checkinAppointment('apt-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('签到成功')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('timeout'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(checkinAppointment('apt-001')).rejects.toThrow('timeout')
  })
})

// ── cancelAppointment ─────────────────────────────────────────────────────────

describe('cancelAppointment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
  })

  it('rowCount=0 → 状态已变更或无权', async () => {
    setupUpdate(0)
    const result = await cancelAppointment('apt-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('预约状态已变更或无权操作')
  })

  it('rowCount=1 → 取消成功', async () => {
    setupUpdate(1)
    const result = await cancelAppointment('apt-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('预约已取消')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(cancelAppointment('apt-001')).rejects.toThrow('connection lost')
  })

  it('已取消状态 → rowCount=0 → 失败（IN 条件过滤）', async () => {
    setupUpdate(0)
    const result = await cancelAppointment('apt-already-cancelled')
    expect(result.success).toBe(false)
  })
})

// ── getAppointmentsPaginated 服务端分页 ───────────────────────────────────────

describe('getAppointmentsPaginated — 服务端分页 + Tab badge', () => {
  const mockApptRow = {
    appointment: {
      appointmentId: 'apt-001',
      status: '待确认',
      storeId: 'store-1',
      clientUserId: 'user-1',
      clientName: '李女士',
      employeeId: 'EMP-001',
      employeeName: '张三',
      saleItemId: null,
      appointmentTime: new Date('2026-03-15T14:00:00Z'),
      checkinAt: null,
      notes: null,
      createdAt: new Date('2026-03-15T10:00:00Z'),
      updatedAt: new Date('2026-03-15T10:00:00Z'),
    },
    storeName: '南昌旗舰店',
  }

  /**
   * mock 3 个并行 select 调用：
   *   call 1 = COUNT (总数)
   *   call 2 = Badge COUNT (pending/confirmed)
   *   call 3 = DATA (含 JOIN)
   */
  function mockPaginatedChain(total: number, pending: number, confirmed: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // COUNT query
        const where = vi.fn().mockResolvedValue([{ count: total }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      if (callIndex === 2) {
        // Badge COUNT query
        const where = vi.fn().mockResolvedValue([{ pending, confirmed }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA query: select → from → leftJoin → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })
  }

  const listSession = {
    ...mockSession,
    permissions: { actions: ['appointment:list', 'appointment:confirm', 'appointment:checkin'], scopeStoreIds: [] },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(listSession)
  })

  it('无筛选 → 返回 data + total + badge 数量', async () => {
    mockPaginatedChain(1, 3, 2, [mockApptRow])

    const result = await getAppointmentsPaginated()

    expect(result.total).toBe(1)
    expect(result.pendingCount).toBe(3)
    expect(result.confirmedCount).toBe(2)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].appointmentId).toBe('apt-001')
    expect(result.data[0].clientName).toBe('李女士')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
  })

  it('空数据 → { data: [], total: 0, pendingCount: 0, confirmedCount: 0 }', async () => {
    mockPaginatedChain(0, 0, 0, [])

    const result = await getAppointmentsPaginated()

    expect(result.total).toBe(0)
    expect(result.pendingCount).toBe(0)
    expect(result.confirmedCount).toBe(0)
    expect(result.data).toEqual([])
  })

  it('tab=pending → eq(status, "待确认") 被调用', async () => {
    mockPaginatedChain(0, 0, 0, [])

    await getAppointmentsPaginated({ tab: 'pending' })

    expect(eq).toHaveBeenCalledWith('status', '待确认')
  })

  it('tab=confirmed → eq(status, "已确认") 被调用', async () => {
    mockPaginatedChain(0, 0, 0, [])

    await getAppointmentsPaginated({ tab: 'confirmed' })

    expect(eq).toHaveBeenCalledWith('status', '已确认')
  })

  it('tab=today → sql CURRENT_DATE 条件被构建', async () => {
    mockPaginatedChain(0, 0, 0, [])

    await getAppointmentsPaginated({ tab: 'today' })

    // sql template tag 被调用（用于 CURRENT_DATE 比较）
    expect(db.select).toHaveBeenCalledTimes(3)
  })

  it('tab=all → 无额外 tab 过滤', async () => {
    mockPaginatedChain(5, 2, 1, [])

    const result = await getAppointmentsPaginated({ tab: 'all' })

    expect(result.total).toBe(5)
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, 0, 0, [])

    await getAppointmentsPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-2')
  })

  it('search 筛选 → ilike 被调用', async () => {
    mockPaginatedChain(0, 0, 0, [])

    await getAppointmentsPaginated({ search: '李' })

    expect(ilike).toHaveBeenCalledWith('client_name', '%李%')
    expect(ilike).toHaveBeenCalledWith('employee_name', '%李%')
  })

  it('page/pageSize 参数 → 3 次 select 调用', async () => {
    mockPaginatedChain(100, 50, 30, [])

    const result = await getAppointmentsPaginated({ page: 3, pageSize: 10 })

    expect(result.total).toBe(100)
    expect(db.select).toHaveBeenCalledTimes(3)
  })

  it('checkinAt 为 null → 序列化为 null', async () => {
    mockPaginatedChain(1, 0, 0, [mockApptRow])

    const result = await getAppointmentsPaginated()

    expect(result.data[0].checkinAt).toBeNull()
  })

  it('checkinAt 有值 → 序列化为 ISO string', async () => {
    const withCheckin = {
      ...mockApptRow,
      appointment: { ...mockApptRow.appointment, checkinAt: new Date('2026-03-15T14:05:00Z') },
    }
    mockPaginatedChain(1, 0, 0, [withCheckin])

    const result = await getAppointmentsPaginated()

    expect(result.data[0].checkinAt).toBe('2026-03-15T14:05:00.000Z')
  })

  it('storeName 为 null → undefined', async () => {
    const noStore = { ...mockApptRow, storeName: null }
    mockPaginatedChain(1, 0, 0, [noStore])

    const result = await getAppointmentsPaginated()

    expect(result.data[0].storeName).toBeUndefined()
  })
})

// ── deleteAppointment — 物理删除守卫 ──────────────────────────────────────

describe('deleteAppointment — 守卫 + 删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupDelete(count: number) {
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({ count }) })
  }

  it('预约不存在 → 拒绝', async () => {
    mockSelectBefore([])
    const result = await deleteAppointment('APT-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('待确认（活跃）预约 → 拒绝', async () => {
    mockSelectBefore([{ status: '待确认', clientName: '王', appointmentTime: new Date('2026-05-01T10:00:00Z') }])
    const result = await deleteAppointment('APT-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已取消')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('已取消但关联服务单 → 拒绝', async () => {
    mockSelectBefore([{ status: '已取消', clientName: '王', appointmentTime: new Date('2026-05-01T10:00:00Z') }])
    ;(db.execute as any).mockResolvedValue([{ one: 1 }])
    const result = await deleteAppointment('APT-2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('服务单')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('已完成且无服务单引用 → 删除成功 + 审计', async () => {
    mockSelectBefore([{ status: '已完成', clientName: '王', appointmentTime: new Date('2026-05-01T10:00:00Z') }])
    ;(db.execute as any).mockResolvedValue([])
    setupDelete(1)
    const { logOperation } = await import('@/lib/operation-log')
    const result = await deleteAppointment('APT-3')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'appointment.delete', 'appointment', 'APT-3',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('删除 rowCount=0（并发）→ 提示刷新', async () => {
    mockSelectBefore([{ status: '已关闭', clientName: '王', appointmentTime: new Date('2026-05-01T10:00:00Z') }])
    ;(db.execute as any).mockResolvedValue([])
    setupDelete(0)
    const result = await deleteAppointment('APT-4')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})
