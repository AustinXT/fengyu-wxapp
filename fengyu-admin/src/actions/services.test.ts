import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/service', () => ({
  serviceOrders: {
    serviceOrderId: 'service_order_id',
    status: 'status',
    storeId: 'store_id',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    updatedAt: 'updated_at',
  },
  serviceItems: {
    serviceItemId: 'service_item_id',
    serviceOrderId: 'service_order_id',
    saleItemId: 'sale_item_id',
    sessionUsed: 'session_used',
    unitRealPrice: 'unit_real_price',
    employeeId: 'employee_id',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: {
    saleItemId: 'sale_item_id',
    remainingSessions: 'remaining_sessions',
    unitRealPrice: 'unit_real_price',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
  clientWechatUsers: { userId: 'user_id', name: 'name' },
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
  isInScope: vi.fn(),
  isAdminScope: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  startServiceOrder,
  completeServiceOrder,
  cancelServiceOrder,
  createServiceOrder,
} from './services'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['service:update', 'service:create'], scopeStoreIds: ['store-1'] },
}

function setupUpdate(rowCount: number) {
  const where = vi.fn().mockResolvedValue({ rowCount })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
}

/** select chain: .from().where().limit() 或 .from().where()（直接 await） */
function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

// ── startServiceOrder ─────────────────────────────────────────────────────────

describe('startServiceOrder — scope + 状态推进', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('rowCount=0（状态已变更或 scope 不符）→ 失败', async () => {
    setupUpdate(0)

    const result = await startServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)

    const result = await startServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已开始')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(startServiceOrder('svc-1')).rejects.toThrow('connection lost')
  })
})

// ── cancelServiceOrder ────────────────────────────────────────────────────────

describe('cancelServiceOrder — scope + 状态推进', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('rowCount=0 → 失败', async () => {
    setupUpdate(0)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已取消')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(cancelServiceOrder('svc-1')).rejects.toThrow('connection lost')
  })
})

// ── completeServiceOrder ──────────────────────────────────────────────────────

describe('completeServiceOrder — 非 admin scope 预检查', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  it('scopeStoreIds 为空 → 直接拒绝（不查 DB）', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['service:update'], scopeStoreIds: [] },
    })

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('服务单不存在（select 返回空）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('服务单 storeId 不在 scope 内 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'other-store' }]))

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('scope 校验通过，但 status_updated=0（状态已变更）→ 失败', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    ;(db.execute as any).mockResolvedValue([{ status_updated: '0', items_deducted: '0' }])

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('scope 校验通过，status_updated=1 → 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    ;(db.execute as any).mockResolvedValue([{ status_updated: '1', items_deducted: '1' }])

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已完成')
  })

  it('admin 用户：跳过 scope 预检查，直接执行原子 SQL', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.execute as any).mockResolvedValue([{ status_updated: '1', items_deducted: '1' }])

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(db.select).not.toHaveBeenCalled() // admin 不做预检查
  })

  it('原子 SQL 异常 → 重新抛出', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.execute as any).mockRejectedValue(new Error('connection lost'))

    await expect(completeServiceOrder('svc-1')).rejects.toThrow('connection lost')
  })
})

// ── createServiceOrder ────────────────────────────────────────────────────────

describe('createServiceOrder — scope + 次数校验 + 事务错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  const baseData = {
    storeId: 'store-1',
    marketName: '市场A',
    clientUserId: 'client-1',
    assignedEmployeeId: 'EMP-001',
    serviceDate: '2026-03-15',
    items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
  }

  function mockTx(id = 'FY-FW-260315001') {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id }]),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(tx)
    })
  }

  it('storeId 不在 scope → 拒绝，不查 DB', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.select).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('saleItem 不存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('剩余次数不足 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 0, unitRealPrice: '200.00' }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('剩余次数不足')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('事务内 FK 违反（23503）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00' }])
    )
    ;(db.transaction as any).mockRejectedValue(
      Object.assign(new Error('FK violation'), { code: '23503' })
    )

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('关联数据不存在')
  })

  it('事务内其他异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00' }])
    )
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(createServiceOrder(baseData)).rejects.toThrow('connection lost')
  })

  it('remainingSessions=null（无次数限制）→ 跳过次数校验，成功', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: null, unitRealPrice: '0' }])
    )
    mockTx('FY-FW-260315001')

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(true)
    expect(result.serviceOrderId).toBe('FY-FW-260315001')
  })

  it('正常创建 → 成功，返回 serviceOrderId', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00' }])
    )
    mockTx('FY-FW-260315001')

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务单创建成功')
    expect(result.serviceOrderId).toBe('FY-FW-260315001')
    expect(db.transaction).toHaveBeenCalledOnce()
  })
})
