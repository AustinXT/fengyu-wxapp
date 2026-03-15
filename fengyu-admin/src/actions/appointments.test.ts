import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@db/appointment', () => ({
  appointments: {
    appointmentId: 'appointment_id',
    status: 'status',
    storeId: 'store_id',
    checkinAt: 'checkin_at',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
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

import { confirmAppointment, checkinAppointment, cancelAppointment } from './appointments'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'ADMIN-001',
  roles: [{ role: 'admin', scopeId: 'hq-1' }],
  permissions: { actions: ['appointment:confirm', 'appointment:checkin'], scopeStoreIds: [] },
}

function setupUpdate(rowCount: number) {
  const where = vi.fn().mockResolvedValue({ rowCount })
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
