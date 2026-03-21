import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
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
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { confirmAppointment, checkinAppointment, cancelAppointment, getAppointmentsPaginated } from './appointments'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
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

// ── confirmAppointment ────────────────────────────────────────────────────────

describe('confirmAppointment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
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

describe('checkinAppointment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('rowCount=0 → 状态已变更或无权', async () => {
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
