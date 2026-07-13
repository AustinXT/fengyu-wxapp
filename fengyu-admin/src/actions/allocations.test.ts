import { describe, it, expect, vi, beforeEach } from 'vitest'

// 退款前置检查（allocations.ts 调 hasPendingRefund / hasSettledRefund / hasSettledRefundForPayment）：
// 默认 false 走正常分支（预防 flaky）。订单级 hasSettledRefund 给 batchSaveAllocations，回款级 ForPayment 给 savePaymentAllocations。
vi.mock('@/lib/refund-cascade', () => ({
  hasPendingRefund: vi.fn().mockResolvedValue(false),
  hasSettledRefund: vi.fn().mockResolvedValue(false),
  hasSettledRefundForPayment: vi.fn().mockResolvedValue(false),
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
    saleOrderType: 'sale_order_type',
    saleOrderDatetime: 'sale_order_datetime',
  },
  saleItems: {
    saleOrderId: 'sale_order_id',
    saleItemId: 'sale_item_id',
    received: 'received',
  },
  saleOrderPayments: {
    id: 'id',
    saleOrderId: 'sale_order_id',
    allocationStatus: 'allocation_status',
    paidAt: 'paid_at',
    status: 'status',
    changeType: 'change_type',
    amount: 'amount',
    paymentMethod: 'payment_method',
  },
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  desc: vi.fn((a) => ({ type: 'desc', a })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
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

vi.mock('@/lib/db-time', () => ({
  nowTs: vi.fn(),
  beijingBoundaryTs: vi.fn((d: string, t: string) => ({ type: 'boundary', d, t })),
}))

import {
  deleteAllocation,
  batchSaveAllocations,
  savePaymentAllocations,
  getPendingPayments,
} from './allocations'
import { db } from '@/db'
import { saleOrderPayments, saleOrders } from '@db/order'
import { eq, gte, lt } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { isAdminScope, isInScope } from '@/lib/permissions'
import { hasSettledRefund, hasSettledRefundForPayment } from '@/lib/refund-cascade'

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
      if (callCount === 2) return makeSelectChain([{ saleOrderType: '销售单' }])() // 订单类型白名单 OK
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
      if (callCount === 2) return makeSelectChain([{ saleOrderType: '销售单' }])() // 订单类型白名单 OK
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
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1', saleOrderType: '销售单' }]))
    mockTx()

    const result = await batchSaveAllocations('order-1', [])

    expect(result.success).toBe(true)
    // scope 查询 + 订单类型白名单查询（空分配跳过 item 校验）
    expect(db.select).toHaveBeenCalledTimes(2)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('正常分配 → 成功，scope + item 归属均被校验', async () => {
    mockScopeAndItems()
    mockTx()

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(true)
    // scope + 订单类型白名单 + item 归属
    expect(db.select).toHaveBeenCalledTimes(3)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  // 审查发现 #1：整单全作废重插会连退款负数冲销行一并作废 → 营业额膨胀回退款前。订单存在已结算退款时必须拒绝。
  it('订单已有「已支付」退款 → 拒绝整单重保存，不进事务（防抹除退款冲销）', async () => {
    // scope(call1) + 订单类型(call2) 通过；守卫在 item 校验前触发
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1', saleOrderType: '销售单' }]))
    ;(hasSettledRefund as any).mockResolvedValueOnce(true)
    mockTx()

    const result = await batchSaveAllocations('order-1', validAllocations)

    expect(result.success).toBe(false)
    expect(result.message).toContain('已锁定')
    expect(hasSettledRefund).toHaveBeenCalledWith(db, 'order-1')
    expect(db.transaction).not.toHaveBeenCalled()
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
    // scope + 订单类型白名单 + item 归属
    expect(db.select).toHaveBeenCalledTimes(3)
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
      if (callCount === 2) return makeSelectChain([{ saleOrderType: '销售单' }])() // 订单类型白名单 OK
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

  it('寄存单 → 拒绝营业额分配，不进事务', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope OK
      return makeSelectChain([{ saleOrderType: '寄存单' }])() // 订单类型白名单拒绝
    })

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('该订单类型不参与营业额分配')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值单 → 拒绝营业额分配，不进事务', async () => {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ storeId: 'store-1' }])() // scope OK
      return makeSelectChain([{ saleOrderType: '充值单' }])() // 订单类型白名单拒绝
    })

    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('该订单类型不参与营业额分配')
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

// ── savePaymentAllocations — 退款后重分配守卫（回款级，审查发现 #2）──────────────────
describe('savePaymentAllocations — 退款守卫粒度（回款级，非订单级）', () => {
  const validPay = {
    id: 7,
    sale_order_id: 'order-1',
    allocation_status: '待分配',
    store_id: 'store-1',
    market_name: 'M',
    sale_order_type: '销售单',
    legacy_source: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('本回款涉及已结算退款 item → 锁定，且用回款级守卫(salePaymentId)，不调订单级 hasSettledRefund', async () => {
    ;(db.execute as any).mockResolvedValueOnce([validPay]) // pay 查询命中
    ;(hasSettledRefundForPayment as any).mockResolvedValueOnce(true)

    const result = await savePaymentAllocations(7, [])

    expect(result.success).toBe(false)
    expect(result.message).toContain('已锁定')
    // #2 核心：回款级守卫，按 salePaymentId 判定（而非整单）
    expect(hasSettledRefundForPayment).toHaveBeenCalledWith(db, 7)
    // 订单级守卫不得参与回款级路径（否则同单无关回款会被误锁）
    expect(hasSettledRefund).not.toHaveBeenCalled()
  })

  it('本回款不涉及退款 item → 守卫放行：即便订单级退款为 true 也不调用订单级守卫', async () => {
    ;(db.execute as any).mockResolvedValue([]) // pay 之后查询均空
    ;(db.execute as any).mockResolvedValueOnce([validPay]) // 首个 execute 为 pay 查询
    ;(hasSettledRefundForPayment as any).mockResolvedValue(false) // 本回款 item 无退款冲销 → 守卫放行
    ;(hasSettledRefund as any).mockResolvedValue(true) // 同单存在其它退款（订单级为 true）

    // 守卫之后的保存路径非本测关注点，允许其下游抛错；仅断言守卫粒度行为
    await savePaymentAllocations(7, []).catch(() => {})

    // #2 核心回归：回款级守卫被咨询，订单级守卫绝不参与回款级路径 → 无关回款不被同单退款误锁
    expect(hasSettledRefundForPayment).toHaveBeenCalledWith(db, 7)
    expect(hasSettledRefund).not.toHaveBeenCalled()
  })
})

// ── getPendingPayments — 全部状态 + 日期筛选（防「全部状态」假全部回归） ─────────
// fluent select 链：支持 .from().innerJoin().leftJoin().where().orderBy().limit().offset()
// 以及直接 await .where()（count 查询）。builder 自身是 thenable，await 得 result。
function makePendingSelectChain(result: any[]) {
  const resolve = () => Promise.resolve(result)
  const builder: any = {
    then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
  }
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    builder[m] = vi.fn(() => builder)
  }
  builder.offset = vi.fn(() => resolve())
  return vi.fn(() => builder)
}

describe('getPendingPayments — 全部状态/日期筛选', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(makePendingSelectChain([{ id: 1 }]))
  })

  it('「全部状态」(allocationStatus 缺省) → 不强制兜底为待分配，不出现 eq(allocation_status, ...)', async () => {
    await getPendingPayments({})

    // 旧逻辑：undefined → 强制 eq(allocation_status, '待分配')。修复后应消失。
    const anyAllocEq = (eq as any).mock.calls.find(
      ([col]: any[]) => col === saleOrderPayments.allocationStatus,
    )
    expect(anyAllocEq).toBeUndefined()
  })

  it('「待分配」→ eq(allocation_status, 待分配) 命中一次', async () => {
    await getPendingPayments({ allocationStatus: '待分配' })

    const hit = (eq as any).mock.calls.filter(
      ([col, val]: any[]) => col === saleOrderPayments.allocationStatus && val === '待分配',
    )
    expect(hit).toHaveLength(1)
  })

  it('「已分配」→ eq(allocation_status, 已分配) 命中一次', async () => {
    await getPendingPayments({ allocationStatus: '已分配' })

    const hit = (eq as any).mock.calls.filter(
      ([col, val]: any[]) => col === saleOrderPayments.allocationStatus && val === '已分配',
    )
    expect(hit).toHaveLength(1)
  })

  it('dateFrom/dateTo → 触发 gte/lt on sale_order_datetime（修复日期筛选失效）', async () => {
    await getPendingPayments({ dateFrom: '2026-07-01', dateTo: '2026-07-31' })

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(true)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(true)

    // 补强：第二参必须是 beijingBoundaryTs 的返回（防退化成 gte(col, 'YYYY-MM-DD') 裸串致早 8h 时区漂移）
    const gteCall = (gte as any).mock.calls.find(([col]: any[]) => col === saleOrders.saleOrderDatetime)
    expect(gteCall?.[1]).toEqual({ type: 'boundary', d: '2026-07-01', t: '00:00:00' })
    const ltCall = (lt as any).mock.calls.find(([col]: any[]) => col === saleOrders.saleOrderDatetime)
    expect(ltCall?.[1]).toEqual({ type: 'boundary', d: '2026-07-31', t: '23:59:59' })
  })

  it('无日期 → 不触发 gte/lt on sale_order_datetime', async () => {
    await getPendingPayments({})

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
  })
})
