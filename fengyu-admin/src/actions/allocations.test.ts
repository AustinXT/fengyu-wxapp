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

vi.mock('@db/order', () => ({
  saleAllocations: {
    id: 'id',
    saleItemId: 'sale_item_id',
    employeeId: 'employee_id',
    allocationRatio: 'allocation_ratio',
    roleType: 'role_type',
    totalAmount: 'total_amount',
    departmentName: 'department_name',
    isVoid: 'is_void',
    voidedAt: 'voided_at',
  },
  saleOrders: {
    saleOrderId: 'sale_order_id',
    storeId: 'store_id',
    allocationStatus: 'allocation_status',
  },
  saleItems: {
    saleOrderId: 'sale_order_id',
    saleItemId: 'sale_item_id',
    received: 'received',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isAdminScope: vi.fn(),
  isInScope: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { deleteAllocation, batchSaveAllocations } from './allocations'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isAdminScope } from '@/lib/permissions'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['allocation:list', 'allocation:save'], scopeStoreIds: ['store-1'] },
}

/**
 * 构建支持 .limit() 和直接 await 两种用法的 select 链。
 * - `await db.select().from().where().limit(1)` ✓
 * - `await db.select().from().where(...)` ✓（无 limit 的批量查询）
 */
function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  // where() 返回一个 thenable（可直接 await）同时携带 .limit 方法
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

// ── deleteAllocation ──────────────────────────────────────────────────────────

describe('deleteAllocation — scope 校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(db.execute as any).mockResolvedValue([]) // 默认空数组：销售提成快照查询无市场 → rate 0
  })

  it('分配记录不存在 → 拒绝，不调用 update', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))

    const result = await deleteAllocation(999)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('分配已被删除（isVoid=true）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ saleItemId: 'item-1', isVoid: true }])
    )

    const result = await deleteAllocation(1)

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被删除')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('分配所属订单不在 scope 内 → 拒绝', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ saleItemId: 'item-1', isVoid: false }])()
      if (callCount === 2) return makeSelectChain([{ saleOrderId: 'order-1' }])()
      return makeSelectChain([{ storeId: 'other-store' }])()
    })

    const result = await deleteAllocation(1)

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('admin 用户：isAdminScope=true，跳过 DB scope 查询，直接成功', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ saleItemId: 'item-1', isVoid: false }])
    )
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await deleteAllocation(1)

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledOnce()
    // admin 不查 saleItems/saleOrders 表做 scope 过滤
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it('scope 内正常删除 → 成功', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ saleItemId: 'item-1', isVoid: false }])()
      if (callCount === 2) return makeSelectChain([{ saleOrderId: 'order-1' }])()
      return makeSelectChain([{ storeId: 'store-1' }])() // store-1 in scope
    })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await deleteAllocation(1)

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledOnce()
  })
})

// ── batchSaveAllocations ──────────────────────────────────────────────────────

describe('batchSaveAllocations — 归属校验 + 事务错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(db.execute as any).mockResolvedValue([]) // 默认空数组：销售提成快照查询无市场 → rate 0
  })

  const validAllocations = [
    { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
  ]

  function mockScopeAndItems(received = '200.00') {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope OK
      return makeSelectChain([{ saleItemId: 'item-1', received }])() // item validation OK
    })
  }

  function mockTx() {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      }
      return fn(tx)
    })
  }

  it('订单不在 scope 内 → 拒绝，不进事务', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('saleItemId 不属于该订单 → 拒绝，不进事务', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope OK
      return makeSelectChain([])() // item validation: not found
    })

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'alien-item', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('不属于该订单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('空分配列表 → 跳过 saleItemId 校验，直接进事务（allocationStatus=pending）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    mockTx()

    const result = await batchSaveAllocations('order-1', [])

    expect(result.success).toBe(true)
    expect(db.select).toHaveBeenCalledTimes(1)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('正常分配 → 成功，scope + item 归属均被校验', async () => {
    mockScopeAndItems()
    mockTx()

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(true)
    expect(db.select).toHaveBeenCalledTimes(2)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('事务内 FK 违反（23503，employeeId 不存在）→ 友好消息', async () => {
    mockScopeAndItems()
    ;(db.transaction as any).mockRejectedValue(
      Object.assign(new Error('FK violation'), { code: '23503' })
    )

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(false)
    expect(result.message).toContain('员工信息不存在')
  })

  it('事务内其他异常 → 重新抛出（非业务错误）', async () => {
    mockScopeAndItems()
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(batchSaveAllocations('order-1', validAllocations)).rejects.toThrow('connection lost')
  })

  it('重复 saleItemId 去重后校验（Set 去重）', async () => {
    const dupeAllocations = [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.60', totalAmount: '120.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.40', totalAmount: '80.00' },
    ]
    mockScopeAndItems()
    mockTx()

    const result = await batchSaveAllocations('order-1', dupeAllocations)

    expect(result.success).toBe(true)
    expect(db.select).toHaveBeenCalledTimes(2)
  })
})

// ── batchSaveAllocations — 新增业务校验 ──────────────────────────────────────

describe('batchSaveAllocations — 业绩分配校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(db.execute as any).mockResolvedValue([]) // 默认空数组：销售提成快照查询无市场 → rate 0
  })

  function mockScopeAndItems(items: Array<{ saleItemId: string; received: string }>) {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      return makeSelectChain(items)()
    })
  }

  function mockTx() {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      }
      return fn(tx)
    })
  }

  it('分配比例非整十 → 拒绝', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '100.00' }])

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.15', totalAmount: '15.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('整十')
  })

  it('同技能标签超过 3 人 → 拒绝（P2-14 Q5）', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '400.00' }])

    // P2-14 之后 4 人同一技能标签才超限；跨标签的 3 人 + 1 人不会触发
    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.20', totalAmount: '80.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.20', totalAmount: '80.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-003', roleType: '美容师', allocationRatio: '0.20', totalAmount: '80.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-004', roleType: '美容师', allocationRatio: '0.20', totalAmount: '80.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('最多分配 3 人')
  })

  it('美容师与养生师三池独立校验（P2-14 Q5）', async () => {
    // P2-14 前这两角色合并同一池（beautician）；现在是独立池，70%+30% 分别属两池各自 ≤100% 合法
    mockScopeAndItems([{ saleItemId: 'item-1', received: '100.00' }])
    mockTx()

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', totalAmount: '70.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '养生师', allocationRatio: '0.30', totalAmount: '30.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('不同技能标签独立池 — 美容师 100% + 推广师 100% 允许', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '100.00' }])
    mockTx()

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1.00', totalAmount: '100.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '推广师', allocationRatio: '1.00', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('同技能标签分配比例超 100% → 拒绝', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '100.00' }])

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', totalAmount: '70.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.40', totalAmount: '40.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('超过 100%')
  })

  it('分配比例合计刚好 100%（容差内）→ 通过', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '100.00' }])
    mockTx()

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.70', totalAmount: '70.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.30', totalAmount: '30.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('同技能标签重复员工 → 拒绝', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '200.00' }])

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('重复分配')
  })

  // ─── P2-14 Q5 独立池回归 ──────────────────────────────────────────

  it('三角色独立池：美容师 110% 被拒 + 养生师 50% 通过（P2-14）', async () => {
    // 若仍合并为 beautician 组，三条合计 160% 应 pass（旧行为）；
    // P2-14 后独立池：美容师池 110% 超 100% → 拒绝，不受养生师池 50% 影响
    mockScopeAndItems([{ saleItemId: 'item-1', received: '1000.00' }])

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.60', totalAmount: '600.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.50', totalAmount: '500.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-003', roleType: '养生师', allocationRatio: '0.50', totalAmount: '500.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('超过 100%')
  })

  it('服务端重算 totalAmount：前端篡改 99999 被忽略（P2-14）', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '1000.00' }])
    let capturedRows: any[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((rows: any[]) => {
            capturedRows = rows
            return Promise.resolve({})
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }),
        }),
      }
      return fn(tx)
    })

    const result = await batchSaveAllocations('order-1', [
      {
        saleItemId: 'item-1',
        employeeId: 'EMP-001',
        roleType: '美容师',
        allocationRatio: '0.30',
        totalAmount: '99999.00', // 前端试图篡改
      },
    ])

    expect(result.success).toBe(true)
    // INSERT 的 totalAmount 应为 1000 × 0.30 = 300.00，不是 99999
    expect(capturedRows).toHaveLength(1)
    expect(capturedRows[0].totalAmount).toBe('300.00')
  })

  it('池金额合计 = received 通过（容差 0.02 内，P2-14）', async () => {
    // 0.30 + 0.30 + 0.40 = 1.00；三人合计金额 = received
    mockScopeAndItems([{ saleItemId: 'item-1', received: '1000.00' }])
    mockTx()

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.30', totalAmount: '300.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', roleType: '美容师', allocationRatio: '0.30', totalAmount: '300.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-003', roleType: '美容师', allocationRatio: '0.40', totalAmount: '400.00' },
    ])

    expect(result.success).toBe(true)
  })

  it('销售提成固化快照：commission_amount = 份额 × 命中费率（§3.15）', async () => {
    mockScopeAndItems([{ saleItemId: 'item-1', received: '1000.00' }])
    // db.execute 三次：①订单 market_name ②订单明细 ③销售单费率矩阵
    let execCall = 0
    ;(db.execute as any).mockImplementation(() => {
      execCall++
      if (execCall === 1) return Promise.resolve([{ market_name: '测试市场' }])
      if (execCall === 2)
        return Promise.resolve([{ sale_item_id: 'item-1', received: '1000.00', sales_category: '自销自耗' }])
      return Promise.resolve([
        { role_type: '美容师', sales_category: '自销自耗', amount_tier_min: '0', amount_tier_max: null, commission_rate: '0.08' },
      ])
    })
    let capturedRows: any[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue({}),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((rows: any[]) => {
            capturedRows = rows
            return Promise.resolve({})
          }),
        }),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({}) }) }),
      }
      return fn(tx)
    })

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.30', totalAmount: '300.00' },
    ])

    expect(result.success).toBe(true)
    expect(capturedRows).toHaveLength(1)
    // 份额 = 1000 × 0.30 = 300；提成 = 300 × 0.08 = 24.00
    expect(capturedRows[0].totalAmount).toBe('300.00')
    expect(capturedRows[0].commissionRate).toBe('0.0800')
    expect(capturedRows[0].commissionAmount).toBe('24.00')
  })
})
