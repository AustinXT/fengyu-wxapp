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
    serviceDate: 'service_date',
    storeId: 'store_id',
    assignedEmployeeId: 'assigned_employee_id',
    clientUserId: 'client_user_id',
    createdAt: 'created_at',
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
  saleOrders: {
    saleOrderId: 'sale_order_id',
    saleOrderType: 'sale_order_type',
  },
  saleItems: {
    saleItemId: 'sale_item_id',
    saleOrderId: 'sale_order_id',
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
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  notExists: vi.fn((subq) => ({ type: 'notExists', subq })),
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
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  startServiceOrder,
  completeServiceOrder,
  confirmServiceOrder,
  cancelServiceOrder,
  createServiceOrder,
  getServiceOrdersPaginated,
} from './services'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope } from '@/lib/permissions'
import { eq, ilike, gte, lte } from 'drizzle-orm'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['service:update', 'service:create'], scopeStoreIds: ['store-1'] },
}

function setupUpdate(count: number) {
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  ;(db.update as any).mockReturnValue({ set })
}

/** select chain: .from().leftJoin().innerJoin().where().limit() 或 .from().where()（直接 await） */
function makeSelectChain(result: any[]) {
  const chain: any = Object.assign(Promise.resolve(result), {
    limit: vi.fn().mockResolvedValue(result),
  })
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  return vi.fn().mockReturnValue(chain)
}

/** mock db.select() 链用于 logTransition 上下文获取：.from().leftJoin().where().limit() */
function mockSelectBefore(rows: any[] = [{}]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValue(chain)
}

// ── startServiceOrder ─────────────────────────────────────────────────────────

describe('startServiceOrder — scope + 状态推进', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ assignedEmployeeId: 'EMP-001', employeeName: '张三', clientUserId: 'client-1', customerName: '李女士' }])
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

  it('DB 异常 → 返回友好错误', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await startServiceOrder('svc-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('开始服务失败，请稍后重试')
  })
})

// ── cancelServiceOrder ────────────────────────────────────────────────────────

describe('cancelServiceOrder — scope + 状态推进', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ customerName: '李女士' }])
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

  it('DB 异常 → 返回友好错误', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await cancelServiceOrder('svc-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('取消服务失败，请稍后重试')
  })
})

// ── completeServiceOrder ──────────────────────────────────────────────────────

describe('completeServiceOrder — 非 admin scope 预检查', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  it('scopeStoreIds 为空 → 直接拒绝（不执行原子 SQL）', async () => {
    mockSelectBefore([{ storeId: 'store-1', employeeName: '张三', customerName: '李女士' }])
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['service:update'], scopeStoreIds: [] },
    })

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
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

  it('scope 校验通过，但 update count=0（状态已变更）→ 失败', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    setupUpdate(0)

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('scope 校验通过，update count=1 → 标记完成（待客户确认）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    setupUpdate(1)

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(true)
    // C4：员工点「完成」只是标记完成（服务中→待客户确认），扣次数推迟到 confirmServiceOrder
    expect(result.message).toContain('已标记完成')
    expect(result.message).toContain('待客户确认')
  })

  it('admin 用户：跳过 scope 预检查，直接翻转状态', async () => {
    mockSelectBefore([{ storeId: 'store-1', employeeName: '张三', customerName: '李女士' }])
    ;(isAdminScope as any).mockReturnValue(true)
    setupUpdate(1)

    const result = await completeServiceOrder('svc-1')

    expect(result.success).toBe(true)
    // admin 跳过 scope 检查但仍获取上下文用于日志
    expect(db.select).toHaveBeenCalledOnce()
  })

  it('状态翻转 SQL 异常 → 返回友好错误', async () => {
    mockSelectBefore([{ storeId: 'store-1', employeeName: '张三', customerName: '李女士' }])
    ;(isAdminScope as any).mockReturnValue(true)
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await completeServiceOrder('svc-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('标记完成失败，请稍后重试')
  })
})

// ── confirmServiceOrder — 待客户确认 → 已完成（原子扣减 + paid_sessions 限额）──────

describe('confirmServiceOrder — scope + 扣减 + paid_sessions 限额', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  it('非 admin + 服务单 storeId 不在 scope → 拒绝，不执行扣减', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'other-store' }]))

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('status_updated=0（状态已变更）→ 失败', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    ;(db.execute as any).mockResolvedValue([
      { status_updated: 0, items_deducted: 0, items_total: 1 },
    ])

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('items_deducted < items_total（paid_sessions 限额拦下某行）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    ;(db.execute as any).mockResolvedValue([
      { status_updated: 1, items_deducted: 1, items_total: 2 },
    ])

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已支付次数不足')
  })

  it('全部行成功扣减（items_deducted = items_total）→ 确认完成', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    ;(db.execute as any).mockResolvedValue([
      { status_updated: 1, items_deducted: 2, items_total: 2 },
    ])

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('已确认完成')
  })

  it('admin 用户：跳过 scope 预检查，仍执行扣减', async () => {
    mockSelectBefore([{ storeId: 'store-1', employeeName: '张三', customerName: '李女士' }])
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.execute as any).mockResolvedValue([
      { status_updated: 1, items_deducted: 1, items_total: 1 },
    ])

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(db.execute).toHaveBeenCalledOnce()
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

  it('原订单退款审批中 → 拒绝（在途退款冻结）', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', hasPendingRefund: true }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('退款审批中')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('审批后已退完的卡（paid_sessions 余量不足）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{
        sessionCount: 10, remainingSessions: 10, paidSessions: 0,
        unitRealPrice: '200.00', hasApprovedRefund: true,
      }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已退款')
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

// ── getServiceOrdersPaginated 服务端分页 ──────────────────────────────────────

describe('getServiceOrdersPaginated — 服务端分页', () => {
  const mockServiceOrderRow = {
    service_order: {
      serviceOrderId: 'FY-FW-260315-0001',
      status: '待服务',
      serviceOrderType: '售前',
      marketName: '南昌市场',
      storeId: 'store-1',
      serviceDate: '2026-03-15',
      assignedEmployeeId: 'EMP-001',
      remark: null,
      appointmentId: null,
      clientUserId: 'user-1',
      createdAt: new Date('2026-03-15T08:00:00Z'),
      updatedAt: new Date('2026-03-15T08:00:00Z'),
    },
    storeName: '南昌旗舰店',
    employeeName: '张三',
    customerName: '李女士',
  }

  /** mock select chain: call 1 = COUNT, call 2 = DATA (with JOINs) */
  function mockPaginatedChain(countResult: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // COUNT: select → from → where
        const where = vi.fn().mockResolvedValue([{ count: countResult }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA: select → from → leftJoin × 3 → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin3 = vi.fn().mockReturnValue({ where })
      const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3 })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: ['service:list', 'service:update', 'service:create'], scopeStoreIds: ['store-1'] },
    })
  })

  it('无筛选 → 返回分页结果 + total', async () => {
    mockPaginatedChain(1, [mockServiceOrderRow])

    const result = await getServiceOrdersPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].serviceOrderId).toBe('FY-FW-260315-0001')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].employeeName).toBe('张三')
    expect(result.data[0].customerName).toBe('李女士')
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getServiceOrdersPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('page/pageSize 传入 → 两次 select 调用', async () => {
    mockPaginatedChain(100, [])

    const result = await getServiceOrdersPaginated({ page: 5, pageSize: 10 })

    expect(result.total).toBe(100)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('page < 1 修正为 1', async () => {
    mockPaginatedChain(5, [])

    const result = await getServiceOrdersPaginated({ page: -3 })

    expect(result.total).toBe(5)
  })

  it('非法 pageSize → 默认 20', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ pageSize: 999 })

    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('status 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ status: '服务中' })

    expect(eq).toHaveBeenCalledWith('status', '服务中')
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-2')
  })

  it('dateFrom 筛选 → gte 被调用', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ dateFrom: '2026-03-01' })

    expect(gte).toHaveBeenCalledWith('service_date', '2026-03-01')
  })

  it('dateTo 筛选 → lte 被调用', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ dateTo: '2026-03-31' })

    expect(lte).toHaveBeenCalledWith('service_date', '2026-03-31')
  })

  it('search 筛选 → ilike + sql 被调用', async () => {
    mockPaginatedChain(0, [])

    await getServiceOrdersPaginated({ search: '张三' })

    expect(ilike).toHaveBeenCalledWith('service_order_id', '%张三%')
  })

  it('storeName/employeeName/customerName 为 null → undefined', async () => {
    const rowNoJoins = {
      ...mockServiceOrderRow,
      storeName: null,
      employeeName: null,
      customerName: null,
    }
    mockPaginatedChain(1, [rowNoJoins])

    const result = await getServiceOrdersPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].employeeName).toBeUndefined()
    expect(result.data[0].customerName).toBeUndefined()
  })
})
