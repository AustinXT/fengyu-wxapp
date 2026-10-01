import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/employee-assignment-server', () => ({ getInvalidEmployeeAssignmentId: vi.fn().mockResolvedValue(null) }))

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
  salePaymentItemAllocations: {
    id: 'id',
    salePaymentItemReceiptId: 'sale_payment_item_receipt_id',
    employeeId: 'employee_id',
    allocationRatio: 'allocation_ratio',
    roleType: 'role_type',
    allocatedAmount: 'allocated_amount',
    commissionRate: 'commission_rate',
    commissionAmount: 'commission_amount',
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
    received: 'received',
    refundedAmount: 'refunded_amount',
      performanceAttributionDate: 'so.performance_attribution_date',
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
    // 与 saleOrders 刻意用**不同**的 mock 串：两者同名的话，
    // "读款项级列"与"读订单级列"在断言里就分不开，而这正是 issue #137 的全部行为变更。
    performanceAttributionDate: 'sop.performance_attribution_date',
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
  sql: Object.assign(vi.fn((_strings: any, ...values: any[]) => ({ __sqlValues: values })), { raw: vi.fn() }),
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

vi.mock('@/lib/payment-allocatable', () => ({
  refreshOrderAllocationRollup: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/db-time', () => ({
  nowTs: vi.fn(),
  beijingBoundaryTs: vi.fn((d: string, t: string) => ({ type: 'boundary', d, t })),
  beijingNextDayBoundaryTs: vi.fn((d: string) => ({ type: 'next-day-boundary', d })),
}))

import {
  deleteAllocation,
  batchSaveAllocations,
  savePaymentAllocations,
  getPendingPayments,
} from './allocations'
import { db } from '@/db'
import { saleOrderPayments, saleOrders } from '@db/order'

/**
 * 归属日期口径断言助手（迁移 0041 收敛后）：查询侧直读
 * sale_order_payments.performance_attribution_date，不再拼 CASE/COALESCE。
 */
const usedAttributionColumn = () =>
  (sql as any).mock.calls.some(([, ...values]: any[]) =>
    values.includes('sop.performance_attribution_date'),
  )

/** 反向守卫：口径被改回订单级时，只有这条会红。 */
const usedOrderLevelColumn = () =>
  (sql as any).mock.calls.some(([, ...values]: any[]) =>
    values.includes('so.performance_attribution_date'),
  )
import { eq, gte, lt, sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { isAdminScope, isInScope } from '@/lib/permissions'
import { hasPendingRefund, hasSettledRefund, hasSettledRefundForPayment } from '@/lib/refund-cascade'
import { logOperation } from '@/lib/operation-log'

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

// ── deleteAllocation：旧单条入口关闭，删除由回款详情整笔保存完成 ────────────────

describe('deleteAllocation — 旧入口下线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it.each(['manager', 'finance', 'admin'] as const)('%s 直调均拒绝且不读写数据', async (role) => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role, scopeId: 'store-1', scopeType: '门店', actions: ['allocation:save'], scopeStoreIds: ['store-1'], scopeOrgNodeIds: ['store-1'] }],
    })
    const result = await deleteAllocation(9)
    expect(result).toMatchObject({ success: false, message: expect.stringContaining('回款详情保存分配') })
    expect(db.execute).not.toHaveBeenCalled()
    expect(db.select).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
    expect(logOperation).not.toHaveBeenCalled()
  })
})

// ── batchSaveAllocations ──────────────────────────────────────────────────────

describe('batchSaveAllocations — 订单级入口已下线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
  })

  it('订单级批量保存直接 fail-closed，不进事务', async () => {
    const result = await batchSaveAllocations('order-1', [
      { saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.50', totalAmount: '100.00' },
    ])

    expect(result.success).toBe(false)
    expect(result.message).toContain('订单级营业额分配已下线')
    expect(result.message).toContain('按每笔回款保存分配')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('空分配列表也不复活订单级入口', async () => {
    const result = await batchSaveAllocations('order-1', [])

    expect(result.success).toBe(false)
    expect(result.message).toContain('订单级营业额分配已下线')
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

describe('销售回款冻结权限 #480', () => {
  const oldPay = {
    id: 7, sale_order_id: 'order-1', allocation_status: '已分配', change_type: '回款',
    paid_at: new Date(Date.now() - 4 * 86400000).toISOString(),
    store_id: 'store-1', market_name: null, sale_order_type: '销售单', legacy_source: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  it('店长直调冻结回款，保存与空数组清空均在事务前拒绝', async () => {
    for (const allocations of [[], [{ saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '1' }]]) {
      ;(db.execute as any).mockResolvedValueOnce([oldPay])
      const result = await savePaymentAllocations(7, allocations)
      expect(result).toMatchObject({ success: false, message: expect.stringContaining('已冻结') })
    }
    expect(db.transaction).not.toHaveBeenCalled()
    expect(logOperation).not.toHaveBeenCalled()
  })

  it('店长在未冻结窗口内仍可清空并记录操作', async () => {
    ;(db.execute as any)
      .mockResolvedValueOnce([{ ...oldPay, paid_at: new Date(Date.now() - 2 * 86400000).toISOString() }])
      .mockResolvedValueOnce([])
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([]).mockResolvedValueOnce({ count: 1 }),
    }))
    const result = await savePaymentAllocations(7, [])
    expect(result.success).toBe(true)
    expect(logOperation).toHaveBeenCalledOnce()
  })

  it.each(['finance', 'admin'] as const)('%s 在冻结后仍可保存空分配并记录操作', async (role) => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role, scopeId: 'store-1', scopeType: '门店', actions: ['allocation:save'], scopeStoreIds: ['store-1'], scopeOrgNodeIds: ['store-1'] }],
    })
    ;(db.execute as any).mockResolvedValueOnce([oldPay]).mockResolvedValueOnce([])
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const execute = vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([]).mockResolvedValueOnce({ count: 1 })
      return fn({ execute })
    })
    const result = await savePaymentAllocations(7, [])
    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledOnce()
  })

  it('财务冻结后可调整非空销售分配，金额由服务端重算并留日志', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      roles: [{ role: 'finance', scopeId: 'store-1', scopeType: '门店', actions: ['allocation:save'], scopeStoreIds: ['store-1'], scopeOrgNodeIds: ['store-1'] }],
    })
    ;(db.execute as any)
      .mockResolvedValueOnce([oldPay])
      .mockResolvedValueOnce([{ receipt_id: 21, sale_item_id: 'item-1', amount: '200.00', sales_category: '自销自耗' }])
    const inserted: any[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn({
      execute: vi.fn().mockResolvedValueOnce([1]).mockResolvedValueOnce([]).mockResolvedValueOnce({ count: 1 }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockImplementation((rows: any[]) => { inserted.push(...rows) }) }),
    }))
    const result = await savePaymentAllocations(7, [{
      saleItemId: 'item-1', employeeId: 'EMP-001', roleType: '美容师', allocationRatio: '0.5', totalAmount: '9999.00',
    }])
    expect(result.success).toBe(true)
    expect(inserted).toMatchObject([{ allocatedAmount: '100.00', allocationRatio: '0.500' }])
    expect(logOperation).toHaveBeenCalledOnce()
  })

  it('退款态对财务仍是只读', async () => {
    ;(getSession as any).mockResolvedValue({ ...mockSession, roles: [{ ...mockSession.roles[0], role: 'finance', actions: ['allocation:save'], scopeStoreIds: ['store-1'] }] })
    ;(db.execute as any).mockResolvedValueOnce([{ ...oldPay, change_type: '退款' }])
    expect((await savePaymentAllocations(7, [])).message).toContain('退款赤字')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('财务仍受待审批退款守卫限制', async () => {
    ;(getSession as any).mockResolvedValue({ ...mockSession, roles: [{ ...mockSession.roles[0], role: 'finance', actions: ['allocation:save'], scopeStoreIds: ['store-1'] }] })
    ;(db.execute as any).mockResolvedValueOnce([oldPay])
    ;(hasPendingRefund as any).mockResolvedValueOnce(true)
    const result = await savePaymentAllocations(7, [])
    expect(result.message).toContain('退款审批中')
    expect(db.transaction).not.toHaveBeenCalled()
  })


})

describe('savePaymentAllocations — 同池不限人数', () => {
  const pay = {
    id: 7, sale_order_id: 'order-1', allocation_status: '待分配',
    store_id: 'store-1', market_name: 'M', sale_order_type: '销售单', legacy_source: null,
  }
  const receipts = [
    { receipt_id: '101', sale_item_id: 'item-1', amount: '100.00', sales_category: '自销自耗' },
    { receipt_id: '102', sale_item_id: 'item-2', amount: '80.00', sales_category: '自销自耗' },
  ]
  const employees = ['EMP-1', 'EMP-2', 'EMP-3', 'EMP-4']
  const lines = (ratio = '0.250', roleType = '养生师') =>
    receipts.flatMap((item) => employees.map((employeeId) => ({
      saleItemId: item.sale_item_id, employeeId, roleType, allocationRatio: ratio,
    })))
  let insertedValues: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.execute as any).mockReset()
      .mockResolvedValueOnce([pay])
      .mockResolvedValueOnce(receipts)
      .mockResolvedValueOnce([])
    insertedValues = vi.fn().mockResolvedValue(undefined)
    ;(db.transaction as any).mockReset().mockImplementation(async (callback: any) => {
      const execute = vi.fn()
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce([])
      await callback({ execute, insert: vi.fn(() => ({ values: insertedValues })) })
    })
  })

  it('两个商品实例每池 4 人各 25%，逐 receipt 保存并由服务端重算金额', async () => {
    const result = await savePaymentAllocations(7, lines())

    expect(result.success).toBe(true)
    expect(insertedValues).toHaveBeenCalledOnce()
    const inserted = insertedValues.mock.calls[0][0]
    expect(inserted).toHaveLength(8)
    expect(inserted.filter((row: any) => row.salePaymentItemReceiptId === 101).map((row: any) => [row.employeeId, row.allocationRatio, row.allocatedAmount])).toEqual([
      ['EMP-1', '0.250', '25.00'], ['EMP-2', '0.250', '25.00'], ['EMP-3', '0.250', '25.00'], ['EMP-4', '0.250', '25.00'],
    ])
    expect(inserted.filter((row: any) => row.salePaymentItemReceiptId === 102).map((row: any) => row.allocatedAmount)).toEqual(['20.00', '20.00', '20.00', '20.00'])
  })

  it.each([
    ['比例超 100%', lines('0.300'), '比例合计不能超过 100%'],
    ['同池重复员工', [...lines('0.200'), { saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '养生师', allocationRatio: '0.100' }], '不能重复分配同一员工'],
    ['单行无效比例', [{ saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '养生师', allocationRatio: '0' }], '分配比例必须'],
  ])('%s 仍被拒绝，事务未开始', async (_name, allocations, message) => {
    const result = await savePaymentAllocations(7, allocations)
    expect(result.success).toBe(false)
    expect(result.message).toContain(message)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('不同技能标签独立计算比例', async () => {
    const allocations = [
      ...employees.map((employeeId) => ({ saleItemId: 'item-1', employeeId, roleType: '养生师', allocationRatio: '0.250' })),
      { saleItemId: 'item-1', employeeId: 'EMP-1', roleType: '美容师', allocationRatio: '1.000' },
    ]
    const result = await savePaymentAllocations(7, allocations)
    expect(result.success).toBe(true)
    expect(insertedValues.mock.calls[0][0]).toHaveLength(5)
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

  it('下单日期口径 → 触发 sale_order_datetime 的上海自然日半开区间', async () => {
    await getPendingPayments({ dateBasis: 'order', dateFrom: '2026-07-01', dateTo: '2026-07-31' })

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(true)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(true)

    // 补强：第二参必须是 beijingBoundaryTs 的返回（防退化成 gte(col, 'YYYY-MM-DD') 裸串致早 8h 时区漂移）
    const gteCall = (gte as any).mock.calls.find(([col]: any[]) => col === saleOrders.saleOrderDatetime)
    expect(gteCall?.[1]).toEqual({ type: 'boundary', d: '2026-07-01', t: '00:00:00' })
    const ltCall = (lt as any).mock.calls.find(([col]: any[]) => col === saleOrders.saleOrderDatetime)
    expect(ltCall?.[1]).toEqual({ type: 'next-day-boundary', d: '2026-07-31' })
  })

  it('款项发生日期口径 → 仅筛当前回款行 paid_at', async () => {
    await getPendingPayments({
      dateBasis: 'payment',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
    })

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrderPayments.paidAt)).toBe(true)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrderPayments.paidAt)).toBe(true)
    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
  })

  it('缺省口径 → 按款项业绩归属日期闭区间筛，不落到 sale_order_datetime/paid_at', async () => {
    await getPendingPayments({ dateFrom: '2026-07-01', dateTo: '2026-07-31' })

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrderPayments.paidAt)).toBe(false)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrderPayments.paidAt)).toBe(false)
    // 直读款项级归属日期列（迁移 0041 收敛：不再有首次支付→订单级的 CASE 分支，
    // 该行的列值由 trigger 写成订单级的镜像）
    expect(usedAttributionColumn()).toBe(true)
    expect(usedOrderLevelColumn()).toBe(false)
    const rendered = (sql as any).mock.calls
      .map(([strings]: any[]) => (Array.isArray(strings?.raw) ? strings.raw.join(' ') : ''))
      .join('\n')
    expect(rendered).not.toContain("= '首次支付' THEN")
    expect(rendered).toContain('::date')
  })

  it('无日期 → 不触发 gte/lt on sale_order_datetime', async () => {
    await getPendingPayments({})

    expect((gte as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
    expect((lt as any).mock.calls.some(([col]: any[]) => col === saleOrders.saleOrderDatetime)).toBe(false)
  })
})
