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
 * 归属日期口径断言助手（迁移 0040 收敛后）：查询侧直读
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
    ;(db.execute as any).mockResolvedValueOnce([])

    const result = await deleteAllocation(999)

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('分配已被删除（isVoid=true）→ 拒绝', async () => {
    ;(db.execute as any).mockResolvedValueOnce([{ sale_item_id: 'item-1', is_void: true }])

    const result = await deleteAllocation(1)

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被删除')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('分配所属订单不在 scope 内 → 拒绝', async () => {
    ;(db.execute as any).mockResolvedValueOnce([{ sale_item_id: 'item-1', is_void: false }])
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ saleOrderId: 'order-1' }])()
      return makeSelectChain([{ storeId: 'other-store' }])()
    })

    const result = await deleteAllocation(1)

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('admin 用户：isAdminScope=true，跳过 DB scope 查询，直接成功', async () => {
    ;(isAdminScope as any).mockReturnValue(true)
    ;(db.execute as any)
      .mockResolvedValueOnce([{ sale_item_id: 'item-1', is_void: false }])
      .mockResolvedValueOnce([{ sale_order_id: 'order-1' }])
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await deleteAllocation(1)

    expect(result.success).toBe(true)
    expect(db.update).toHaveBeenCalledOnce()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('scope 内正常删除 → 成功', async () => {
    ;(db.execute as any)
      .mockResolvedValueOnce([{ sale_item_id: 'item-1', is_void: false }])
      .mockResolvedValueOnce([{ sale_order_id: 'order-1' }])
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount++
      if (callCount === 1) return makeSelectChain([{ saleOrderId: 'order-1' }])()
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
    // 直读款项级归属日期列（迁移 0040 收敛：不再有首次支付→订单级的 CASE 分支，
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
