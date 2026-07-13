import { describe, it, expect, vi, beforeEach } from 'vitest'

// 退款前置检查（services.ts confirmServiceOrder 等调 hasPendingRefundByServiceOrder）：
// 默认返回 false（无退款审批中），让现有用例走正常分支；不 mock 会跑真实实现拿 mock 的 db 误判。
vi.mock('@/lib/refund-cascade', () => ({
  hasPendingRefund: vi.fn().mockResolvedValue(false),
  hasPendingRefundByServiceOrder: vi.fn().mockResolvedValue(false),
}))

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
    salesCategory: 'sales_category',
  },
  serviceReviews: {
    serviceOrderId: 'service_order_id',
    rating: 'rating',
    comment: 'comment',
    createdAt: 'created_at',
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
    skuId: 'sku_id',
    isShengmei: 'is_shengmei',
    salesCategory: 'sales_category',
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
  inArray: vi.fn((a, b) => ({ type: 'inArray', a, b })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
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
  deleteServiceOrder,
  getServiceOrderById,
  exportAllocationServiceOrders,
  exportServiceOrders,
} from './services'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope, scopeCondition } from '@/lib/permissions'
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

/** 多次 db.select() 按顺序返回不同结果（最后一个结果用于后续所有调用）。
 *  createServiceOrder 顺序：1) customerRow(becameMemberAt+boundStoreId) 2) pendingAppt 3) saleItem 循环 */
function makeSelectSequence(...results: any[][]) {
  let i = 0
  return vi.fn().mockImplementation(() => {
    const result = results[Math.min(i, results.length - 1)]
    i++
    const chain: any = Object.assign(Promise.resolve(result), {
      limit: vi.fn().mockResolvedValue(result),
    })
    chain.from = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.innerJoin = vi.fn().mockReturnValue(chain)
    return chain
  })
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

  it('顾客绑定门店 ≠ data.storeId → 拒绝（疗程卡只能在绑定门店核销）', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectSequence([{ boundStoreId: 'store-OTHER' }])
    )

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('绑定门店')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('saleItem 不存在 → 拒绝', async () => {
    // customerRow 命中绑定门店（过绑定门店校验），但 saleItem 查不到
    ;(db.select as any).mockImplementation(
      makeSelectSequence([{ boundStoreId: 'store-1' }], [], [])
    )

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // #5 收紧口径：可用次数 = 已付未用（paidSessions 未设视作 null → 退回物理剩余 remaining=0），不足则拒绝
  it('可用次数不足（已付未用 < sessionUsed）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 0, unitRealPrice: '200.00', boundStoreId: 'store-1' }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('可用次数不足')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('原订单退款审批中 → 拒绝（在途退款冻结）', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', hasPendingRefund: true, boundStoreId: 'store-1' }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('退款审批中')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  // #5 收紧口径后：paid_sessions=0 的欠款卡可用次数=0，统一被 paidUnused 校验拒绝（不再依赖 hasApprovedRefund 分支）
  it('欠款卡（paid_sessions=0，已付未用=0）→ 可用次数不足拒绝', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{
        sessionCount: 10, remainingSessions: 10, paidSessions: 0,
        unitRealPrice: '200.00', hasApprovedRefund: true, boundStoreId: 'store-1',
      }])
    )

    const result = await createServiceOrder({
      ...baseData,
      items: [{ saleItemId: 'item-1', sessionUsed: 1 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('可用次数不足')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('事务内 FK 违反（23503）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', boundStoreId: 'store-1' }])
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
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', boundStoreId: 'store-1' }])
    )
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(createServiceOrder(baseData)).rejects.toThrow('connection lost')
  })

  it('remainingSessions=null（无次数限制）→ 跳过次数校验，成功', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: null, unitRealPrice: '0', boundStoreId: 'store-1' }])
    )
    mockTx('FY-FW-260315001')

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(true)
    expect(result.serviceOrderId).toBe('FY-FW-260315001')
  })

  it('正常创建 → 成功，返回 serviceOrderId', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', boundStoreId: 'store-1' }])
    )
    mockTx('FY-FW-260315001')

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务单创建成功')
    expect(result.serviceOrderId).toBe('FY-FW-260315001')
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('service_items 写入 sale_items 快照的 is_shengmei + sales_category', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{
        remainingSessions: 5, unitRealPrice: '200.00', boundStoreId: 'store-1',
        isShengmei: true, salesCategory: '自销自耗',
      }])
    )
    const inserts: Array<{ table: any; values: any }> = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-FW-260617001' }]),
        insert: vi.fn().mockImplementation((table: any) => ({
          values: vi.fn().mockImplementation((values: any) => {
            inserts.push({ table, values })
            return Promise.resolve({})
          }),
        })),
      }
      return fn(tx)
    })

    const result = await createServiceOrder(baseData)

    expect(result.success).toBe(true)
    const serviceItemInsert = inserts.find((c) =>
      c.values && typeof c.values === 'object' && 'serviceItemId' in c.values
    )
    expect(serviceItemInsert).toBeDefined()
    expect(serviceItemInsert!.values.isShengmei).toBe(true)
    expect(serviceItemInsert!.values.salesCategory).toBe('自销自耗')
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

// ── deleteServiceOrder — 物理删除守卫 + 级联 ──────────────────────────────

describe('deleteServiceOrder — 守卫 + 级联删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupTx(deleteCount: number) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: deleteCount }) }),
      }
      return fn(tx)
    })
  }

  it('服务单不存在 → 拒绝，不进事务', async () => {
    mockSelectBefore([])
    const result = await deleteServiceOrder('SVC-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('已完成服务单 → 拒绝（仅待服务/已取消可删）', async () => {
    mockSelectBefore([{ status: '已完成', serviceDate: '2026-05-01', assignedEmployeeId: 'E1', commissionStatus: '已分配' }])
    const result = await deleteServiceOrder('SVC-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('待服务')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('已取消服务单 → 级联删除成功 + 审计', async () => {
    mockSelectBefore([{ status: '已取消', serviceDate: '2026-05-01', assignedEmployeeId: 'E1', commissionStatus: null }])
    setupTx(1)
    const { logOperation } = await import('@/lib/operation-log')
    const result = await deleteServiceOrder('SVC-2')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'service.delete', 'service_order', 'SVC-2',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('主表删除 rowCount=0（并发）→ 回滚提示', async () => {
    mockSelectBefore([{ status: '待服务', serviceDate: '2026-05-01', assignedEmployeeId: 'E1', commissionStatus: null }])
    setupTx(0)
    const result = await deleteServiceOrder('SVC-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })
})

// ── getServiceOrderById — 跨门店只读放行 ──────────────────────────────────────
describe('getServiceOrderById — 读取不限 scope + readOnly 标记', () => {
  const soRow = {
    service_order: {
      serviceOrderId: 'SVC-1',
      status: '已完成',
      serviceOrderType: '售前',
      marketName: 'M',
      storeId: 'store-9',
      serviceDate: '2026-06-01',
      assignedEmployeeId: 'EMP-1',
      remark: null,
      appointmentId: null,
      clientUserId: 'user-1',
      commissionStatus: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    },
    storeName: '门店9',
    employeeName: '张三',
    customerName: '李四',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('不存在 → null', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    expect(await getServiceOrderById('SVC-404')).toBeNull()
  })

  it('读取不施加 scopeCondition（跨门店可点进只读）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([soRow]))
    ;(isInScope as any).mockReturnValue(true)
    await getServiceOrderById('SVC-1')
    expect(scopeCondition).not.toHaveBeenCalled()
  })

  it('门店在 scope → readOnly=false', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([soRow]))
    ;(isInScope as any).mockReturnValue(true)
    const result = await getServiceOrderById('SVC-1')
    expect(result?.readOnly).toBe(false)
  })

  it('门店不在 scope → readOnly=true（跨门店只读）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([soRow]))
    ;(isInScope as any).mockReturnValue(false)
    const result = await getServiceOrderById('SVC-1')
    expect(result?.readOnly).toBe(true)
    expect(isInScope).toHaveBeenCalledWith(mockSession, 'store-9')
  })
})

// ── exportAllocationServiceOrders — 服务提成明细导出（30 列） ──────────────────
describe('exportAllocationServiceOrders — 明细导出 + 派生列 + 截断', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('maps a service_commissions detail row to export fields + derived columns', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([
        {
          market: '九江',
          storeName: '世纪店',
          serviceOrderId: 'SO1',
          saleOrderType: '销售单',
          serviceOrderType: '售后',
          customerName: '王女士',
          customerPhone: null,
          fallbackPhone: '13151094335',
          productType: '疗程卡',
          categoryL1: '护理项目',
          categoryL2: '圣源养心',
          productName: '【王牌】疼痛管理',
          sessionUsed: 1,
          unitRealPrice: '300.00',
          status: '已完成',
          employeeName: '王雯馨',
          positionName: '美容师',
          allocationRatio: '0.30',
          commissionRate: '0.1500',
          commissionAmount: '162.00',
          rating: 5,
          reviewComment: '好评',
          salesCategory: '自销自耗',
          customerType: '会员客',
          openedByName: '张凯',
          sourceSaleOrderId: 'FY-XSD-WX-2606080003',
          serviceDate: '2026-06-08',
          createdAt: new Date('2026-06-08T15:26:32.000Z'),
          remark: null,
          scId: 1,
        },
      ])
    )
    const { rows } = await exportAllocationServiceOrders({})
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO1')
    expect(r.market).toBe('九江')
    expect(r.saleOrderType).toBe('销售单')
    expect(r.serviceOrderType).toBe('售后')
    // 顾客手机回退到来源销售单 client_phone
    expect(r.customerPhone).toBe('13151094335')
    // 派生：消耗金额 = 单次价 × 消耗次数；分配额 = 消耗金额 × 分配占比
    expect(r.consumeMoney).toBe(300)
    expect(r.unitRealPrice).toBe(300)
    expect(r.allocationAmount).toBe(90)
    // 金额转 number；占比/比例保留原始小数串交前端格式化
    expect(r.commissionAmount).toBe(162)
    expect(r.allocationRatio).toBe('0.30')
    expect(r.commissionRate).toBe('0.1500')
    expect(r.rating).toBe(5)
    // createdAt 序列化为 ISO 串
    expect(r.createdAt).toBe('2026-06-08T15:26:32.000Z')
  })

  it('truncates at 10000 rows', async () => {
    const many = Array.from({ length: 10001 }, (_, i) => ({
      serviceOrderId: `SO${i}`,
      sessionUsed: 1,
      unitRealPrice: '100.00',
      allocationRatio: '1.00',
      commissionAmount: '10.00',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
    }))
    ;(db.select as any).mockImplementation(makeSelectChain(many))
    const { rows, truncated } = await exportAllocationServiceOrders({})
    expect(truncated).toBe(true)
    expect(rows).toHaveLength(10000)
  })
})

// ── exportServiceOrders — 服务单管理页导出（复用 helper，明细展开） ──────────────
describe('exportServiceOrders — 服务单管理页明细导出（复用提成分配查询）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('产出 30 列明细行 + 派生列（与 exportAllocationServiceOrders 同口径）', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([
        {
          market: '九江',
          storeName: '世纪店',
          serviceOrderId: 'SO1',
          saleOrderType: '销售单',
          serviceOrderType: '售后',
          customerName: '王女士',
          customerPhone: '13151094335',
          fallbackPhone: null,
          productType: '疗程卡',
          categoryL1: '护理项目',
          categoryL2: '圣源养心',
          productName: '【王牌】疼痛管理',
          sessionUsed: 1,
          unitRealPrice: '300.00',
          status: '已完成',
          employeeName: '王雯馨',
          positionName: '美容师',
          allocationRatio: '0.30',
          commissionRate: '0.1500',
          commissionAmount: '162.00',
          rating: 5,
          reviewComment: '好评',
          salesCategory: '自销自耗',
          customerType: '会员客',
          openedByName: '张凯',
          sourceSaleOrderId: 'FY-XSD-WX-2606080003',
          serviceDate: '2026-06-08',
          createdAt: new Date('2026-06-08T15:26:32.000Z'),
          remark: null,
          scId: 1,
        },
      ]),
    )
    const { rows, truncated } = await exportServiceOrders({})
    expect(rows).toHaveLength(1)
    expect(truncated).toBe(false)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO1')
    expect(r.market).toBe('九江')
    // 派生列：消耗金额 = 单次价 × 次数；分配额 = 消耗金额 × 占比
    expect(r.consumeMoney).toBe(300)
    expect(r.allocationAmount).toBe(90)
    expect(r.commissionAmount).toBe(162)
  })

  it('沿用服务单管理列表筛选口径（parseServiceOrderFilters：不锁已完成，解析 from/to）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    await exportServiceOrders({ status: '已完成', store: 'store-1', from: '2026-01-01', to: '2026-12-31', q: '王' })
    // date 筛选由 parseServiceOrderFilters 的 from/to → buildServiceOrderConditions 的 gte/lte
    expect(gte).toHaveBeenCalledWith(expect.anything(), '2026-01-01')
    expect(lte).toHaveBeenCalledWith(expect.anything(), '2026-12-31')
    // search 走 ilike
    expect(ilike).toHaveBeenCalled()
  })

  // 回归守护：v1.3.13 起 exportServiceOrders 改为明细级（service_commissions 主链），
  // 旧列 itemsSummary 不应再出现。若有人手贱回滚到 serviceOrders 主链，下列断言失败。
  it('回归守护：v1.3.13 BREAKING — 30 列明细级 shape（无 itemsSummary，有 consumeMoney/allocationAmount）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const { rows } = await exportServiceOrders({})
    expect(rows).toEqual([])
    // 明细级列集合（30 列，与 services-page.tsx 导出列一一对应）
    const expectedColumns = [
      'market', 'storeName', 'serviceOrderId', 'saleOrderType', 'serviceOrderType',
      'customerName', 'customerPhone', 'productType', 'categoryL1', 'categoryL2',
      'productName', 'sessionUsed', 'consumeMoney', 'unitRealPrice', 'status',
      'employeeName', 'positionName', 'allocationRatio', 'allocationAmount',
      'commissionRate', 'commissionAmount', 'reviewComment', 'rating',
      'salesCategory', 'customerType', 'openedByName', 'sourceSaleOrderId',
      'serviceDate', 'createdAt', 'remark',
    ]
    // 通过导出空行 + 静态类型对照，断言列集合稳定（防止有人手贱增删列）
    // vitest 无法直接枚举 interface 字段；用「mock 1 行后取 keys」做集合断言
    ;(db.select as any).mockImplementationOnce(
      makeSelectChain([
        {
          market: null, storeName: null, serviceOrderId: 'SO1', saleOrderType: null, serviceOrderType: null,
          customerName: null, customerPhone: null, fallbackPhone: null,
          productType: null, categoryL1: null, categoryL2: null, productName: null,
          sessionUsed: null, unitRealPrice: null, status: null,
          employeeName: null, positionName: null,
          allocationRatio: null, commissionRate: null, commissionAmount: null,
          rating: null, reviewComment: null,
          salesCategory: null, customerType: null, openedByName: null,
          sourceSaleOrderId: null, serviceDate: null, createdAt: null, remark: null,
          scId: 1,
        },
      ]),
    )
    const r2 = (await exportServiceOrders({})).rows[0]
    expect(Object.keys(r2).sort()).toEqual(expectedColumns.sort())
  })
})
