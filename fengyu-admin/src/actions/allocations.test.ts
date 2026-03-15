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
    // Call 1: fetch alloc → found (active)
    // Call 2: verifySaleItemScope → fetch saleItem → found
    // Call 3: verifyOrderScope → fetch order → storeId='other-store'
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
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
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
    const where = vi.fn().mockResolvedValue({ rowCount: 1 })
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
  })

  const validAllocations = [
    { saleItemId: 'item-1', employeeId: 'EMP-001', allocationRatio: '0.5', totalAmount: '100.00' },
  ]

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
    // verifyOrderScope → order not found
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
      { saleItemId: 'alien-item', employeeId: 'EMP-001', allocationRatio: '1', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('不属于该订单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('空分配列表 → 跳过 saleItemId 校验，直接进事务（allocationStatus=pending）', async () => {
    // Only verifyOrderScope select needed; item validation skipped for empty list
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    mockTx()

    const result = await batchSaveAllocations('order-1', [])

    expect(result.success).toBe(true)
    expect(db.select).toHaveBeenCalledTimes(1) // only scope check, no item validation
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('正常分配 → 成功，scope + item 归属均被校验', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope OK
      return makeSelectChain([{ saleItemId: 'item-1' }])() // item validation OK
    })
    mockTx()

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(true)
    expect(db.select).toHaveBeenCalledTimes(2) // scope + item validation
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('事务内 FK 违反（23503，employeeId 不存在）→ 友好消息', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      return makeSelectChain([{ saleItemId: 'item-1' }])()
    })
    ;(db.transaction as any).mockRejectedValue(
      Object.assign(new Error('FK violation'), { code: '23503' })
    )

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(false)
    expect(result.message).toContain('员工信息不存在')
  })

  it('事务内其他异常 → 重新抛出（非业务错误）', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      return makeSelectChain([{ saleItemId: 'item-1' }])()
    })
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(batchSaveAllocations('order-1', validAllocations)).rejects.toThrow('connection lost')
  })

  it('重复 saleItemId 去重后校验（Set 去重）', async () => {
    // Two allocations with same saleItemId → only one DB check needed
    const dupeAllocations = [
      { saleItemId: 'item-1', employeeId: 'EMP-001', allocationRatio: '0.6', totalAmount: '120.00' },
      { saleItemId: 'item-1', employeeId: 'EMP-002', allocationRatio: '0.4', totalAmount: '80.00' },
    ]
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])()
      return makeSelectChain([{ saleItemId: 'item-1' }])() // item-1 found (deduped)
    })
    mockTx()

    const result = await batchSaveAllocations('order-1', dupeAllocations)

    expect(result.success).toBe(true)
    // item validation called once (deduped to single saleItemId)
    expect(db.select).toHaveBeenCalledTimes(2)
  })
})
