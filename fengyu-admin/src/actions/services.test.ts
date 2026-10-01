import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/employee-assignment-server', () => ({ getInvalidEmployeeAssignmentId: vi.fn().mockResolvedValue(null) }))

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
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(), join: vi.fn(() => ({})) }),
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

vi.mock('@/lib/visit-points', () => ({
  grantVisitPointsSafe: vi.fn().mockResolvedValue({ granted: true }),
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
  getAvailableSaleItems,
  getServiceOrdersPaginated,
  deleteServiceOrder,
  getServiceOrderById,
  exportAllocationServiceOrders,
  exportServiceOrders,
} from './services'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, isAdminScope, scopeCondition } from '@/lib/permissions'
import { eq, ilike, gte, lte, desc, sql } from 'drizzle-orm'
import { serviceOrders } from '@db/service'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'
import { productSkus } from '@db/product'
import { grantVisitPointsSafe } from '@/lib/visit-points'

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

function mockStartTx(count: number, lockRows: any[] = [], reservedRows: any[] = []) {
  const execute = vi.fn()
    .mockResolvedValueOnce(lockRows)
    .mockResolvedValueOnce(reservedRows)
    .mockResolvedValue([])
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ execute, update }))
  return { execute, update }
}

function mockCancelTx(count: number) {
  const execute = vi.fn().mockResolvedValue([])
  const where = vi.fn().mockResolvedValue({ count })
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  ;(db.transaction as any).mockImplementation(async (fn: any) => fn({ execute, update }))
  return { execute, update }
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

/** export worker 的分页查询会串联 limit(...).offset(...)。 */
function makePagedSelectChain(result: any[]) {
  const chain: any = Object.assign(Promise.resolve(result), {
    limit: vi.fn(() => chain),
    offset: vi.fn(() => chain),
  })
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  return chain
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
    mockStartTx(0)

    const result = await startServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('rowCount=1 → 成功', async () => {
    const tx = mockStartTx(1)

    const result = await startServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已开始')
    expect(tx.execute).toHaveBeenCalledTimes(2)
  })

  it('已有服务预扣占满次数时拒绝，不推进状态也不写入本单预扣', async () => {
    const tx = mockStartTx(1, [{
      sale_item_id: 'item-1',
      session_used: 1,
      remaining_sessions: 1,
      session_count: 1,
      paid_sessions: 1,
      product_type: '疗程卡',
    }], [{ sale_item_id: 'item-1', total_reserved: 1 }])

    const result = await startServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('可用次数不足')
    expect(tx.update).not.toHaveBeenCalled()
    expect(tx.execute).toHaveBeenCalledTimes(2)
  })

  it('只汇总服务中和待客户确认服务单的有效预扣', () => {
    const source = readFileSync('src/actions/services.ts', 'utf8')
    const fnSource = source.slice(source.indexOf('export const startServiceOrder'), source.indexOf(' * C4: 员工标记完成服务'))

    expect(fnSource).toMatch(/INNER JOIN service_orders reserved_order/)
    expect(fnSource).toMatch(/reserved_order\.status IN \('服务中', '待客户确认'\)/)
  })

  it('DB 异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    const result = await startServiceOrder('svc-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('开始服务失败，请稍后重试')
  })
})

// ── cancelServiceOrder ────────────────────────────────────────────────────────

describe('cancelServiceOrder — scope + 状态守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ status: '待服务', customerName: '李女士' }])
  })

  it('待服务 → 取消成功', async () => {
    const tx = mockCancelTx(1)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已取消')
    expect(tx.execute).toHaveBeenCalledOnce()
  })

  it('服务中 → 取消成功（口径对齐 staff 三态）', async () => {
    mockSelectBefore([{ status: '服务中', customerName: '李女士' }])
    mockCancelTx(1)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已取消')
  })

  it('待客户确认 → 取消成功（口径对齐 staff 三态）', async () => {
    mockSelectBefore([{ status: '待客户确认', customerName: '李女士' }])
    mockCancelTx(1)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('服务已取消')
  })

  it('已完成 → 拒绝并提示走退款链路（不触达 update）', async () => {
    mockSelectBefore([{ status: '已完成', customerName: '李女士' }])

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('退款')
  })

  it('服务单不存在/无权（select 返回空）→ 失败', async () => {
    mockSelectBefore([])

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或无权')
  })

  it('rowCount=0（并发状态变更）→ 失败', async () => {
    const tx = mockCancelTx(0)

    const result = await cancelServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
    expect(tx.execute).not.toHaveBeenCalled()
  })

  it('DB 异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

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

describe('confirmServiceOrder — scope + 扣减 + paid_sessions 限额 + 服务提成写入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isAdminScope as any).mockReturnValue(false)
  })

  // mock db.transaction：CTE 扣减+置已完成 返回 cteRow；settleServiceCommissions 的后续 execute
  // （查 service_items/rate、insert operation_logs/service_commissions、update commission_status）
  // 一律返回空数组（无 service_items → 跳过提成 for 循环，仅置 commission_status）。
  // 返回 spy holder，供用例断言 settle 是否在事务内被调用（tx.execute 调用次数 > 1 = CTE 之外有 settle 写入）。
  function mockConfirmTx(cteRow: { status_updated: number; items_deducted: number; items_total: number }) {
    const spy = { execute: null as any }
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      // 先锁 sale_items，再执行 CTE；成功时第三次调用才释放 reserved_at。
      spy.execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([cteRow]).mockResolvedValue([] as any)
      return fn({ execute: spy.execute })
    })
    return spy
  }

  it('非 admin + 服务单 storeId 不在 scope → 拒绝，不执行扣减', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'other-store' }]))

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('status_updated=0（状态已变更）→ 失败', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    mockConfirmTx({ status_updated: 0, items_deducted: 0, items_total: 1 })

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('items_deducted < items_total（paid_sessions 限额拦下某行）→ 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ storeId: 'store-1' }]))
    mockConfirmTx({ status_updated: 1, items_deducted: 1, items_total: 2 })

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(false)
    expect(result.message).toContain('已支付次数不足')
  })

  it('同一卡多条服务明细按 sale_item_id 汇总后只扣减一次', () => {
    const source = readFileSync('src/actions/services.ts', 'utf8')
    const fnSource = source.slice(source.indexOf('export const confirmServiceOrder'), source.indexOf('/** C4: 取消服务'))

    expect(fnSource).toContain('service_totals AS')
    expect(fnSource).toContain('SUM(session_used) AS session_used')
    expect(fnSource).toContain('GROUP BY sale_item_id')
    expect(fnSource).toContain('FROM service_totals totals')
    expect(fnSource).toContain('remaining_sessions = remaining_sessions - totals.session_used')
    expect(fnSource).toContain('SELECT COUNT(*) AS n FROM service_totals')
  })

  it('全部行成功扣减（items_deducted = items_total）→ 确认完成 + 事务内写服务提成（M1）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{
      storeId: 'store-1',
      serviceOrderType: '售后',
      serviceDate: '2026-08-13',
      clientUserId: 'client-1',
      remark: '',
      hasPositiveItem: true,
    }]))
    const spy = mockConfirmTx({ status_updated: 1, items_deducted: 2, items_total: 2 })

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('已确认完成')
    // M1：成功扣减后须在同一事务内写服务提成（settleServiceCommissions 至少多调一次 tx.execute 置 commission_status）
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(spy.execute.mock.calls.length).toBeGreaterThan(1)
    expect(grantVisitPointsSafe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceOrderId: 'svc-1',
        serviceOrderType: '售后',
        serviceDate: '2026-08-13',
        clientUserId: 'client-1',
        hasPositiveItem: true,
      }),
      'admin.service.confirm',
    )
  })

  it('admin 用户：跳过 scope 预检查，仍执行扣减 + 写提成', async () => {
    mockSelectBefore([{ storeId: 'store-1', employeeName: '张三', customerName: '李女士' }])
    ;(isAdminScope as any).mockReturnValue(true)
    mockConfirmTx({ status_updated: 1, items_deducted: 1, items_total: 1 })

    const result = await confirmServiceOrder('svc-1')

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
  })
})

// ── createServiceOrder ────────────────────────────────────────────────────────

describe('getAvailableSaleItems — 疗程卡权益列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('SQL 守卫：有效权益订单包含已支付、部分支付、已完成，并按已付未用过滤', () => {
    const source = readFileSync('src/actions/services.ts', 'utf8')
    const fnSource = source.slice(source.indexOf('export const getAvailableSaleItems'), source.indexOf('/** C4: 开始服务'))

    expect(fnSource).toContain("o.status IN ('已支付', '部分支付', '已完成')")
    expect(fnSource).toContain("si.paid_sessions IS NULL")
    expect(fnSource).toContain("si.paid_sessions > (si.session_count - si.remaining_sessions)")
  })

  it('转换单转入卡作为可用权益返回，已付未用按 paid_sessions 派生', async () => {
    ;(db.execute as any).mockResolvedValue([{
      sale_item_id: 'FY-XSD-WX-2607250060-02',
      sale_order_id: 'FY-XSD-WX-2607250060',
      product_name: '面部三重维养',
      product_type: '疗程卡',
      session_count: 10,
      remaining_sessions: 10,
      paid_sessions: 10,
      unit_real_price: '200.00',
      expire_date: null,
    }])

    const rows = await getAvailableSaleItems('FYGK-20260711-00026')

    expect(rows).toHaveLength(1)
    expect(rows[0].saleItemId).toBe('FY-XSD-WX-2607250060-02')
    expect(rows[0].productName).toBe('面部三重维养')
    expect(rows[0].paidUnusedSessions).toBe(10)
  })
})

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

  it('is_shengmei 快照取 SKU 当前值优先、sale_items 兜底（#378，与 staff service.js 同源）', async () => {
    ;(db.select as any).mockImplementation(
      makeSelectChain([{ remainingSessions: 5, unitRealPrice: '200.00', boundStoreId: 'store-1', isShengmei: true }])
    )
    mockTx('FY-FW-260925001')
    ;(sql as any).mockClear()

    const result = await createServiceOrder(baseData)
    expect(result.success).toBe(true)

    // 找到 SELECT 里构造 isShengmei 的 COALESCE 模板：参数顺序即优先级
    const coalesceCalls = (sql as any).mock.calls.filter(
      ([strings, ...values]: [TemplateStringsArray, ...unknown[]]) =>
        Array.isArray(strings) && strings.join('?').includes('COALESCE(') &&
        values.includes(productSkus.isShengmei),
    )
    expect(coalesceCalls).toHaveLength(1)
    const [strings, ...values] = coalesceCalls[0]
    expect(strings.join('?').replace(/\s+/g, '')).toBe('COALESCE(?,?)')
    expect(values[0]).toBe(productSkus.isShengmei)
    expect(values[1]).toBe('is_shengmei') // saleItems.isShengmei（mock 列名）
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

// ── exportAllocationServiceOrders — 服务提成三态导出（已分配明细 + 待分配占位行） ──
describe('exportAllocationServiceOrders — 三态导出 + 派生列 + 全量返回', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(scopeCondition as any).mockReturnValue(undefined)
  })

  // 已分配段 raw（service_commissions 来源，含分配/提成/评价列）
  const allocatedRaw = {
    market: '九江', storeName: '世纪店', serviceOrderId: 'SO1',
    saleOrderType: '销售单', serviceOrderType: '售后',
    customerName: '王女士', customerPhone: null, fallbackPhone: '13151094335',
    productType: '疗程卡', categoryL1: '护理项目', categoryL2: '圣源养心',
    productName: '【王牌】疼痛管理', sessionUsed: 1, skuUnit: '疗程', unitRealPrice: '300.00',
    status: '已完成',
    employeeName: '王雯馨', positionName: '美容师',
    allocationRatio: '0.30', commissionRate: '0.1500', commissionAmount: '162.00',
    rating: 5, reviewComment: '好评',
    salesCategory: '自销自耗', customerType: '会员客', openedByName: '张凯',
    sourceSaleOrderId: 'FY-XSD-WX-2606080003',
    serviceDate: '2026-06-08', createdAt: new Date('2026-06-08T15:26:32.000Z'), remark: null,
  }

  // 待分配段 raw（无 service_commissions，select 里没分配/提成/评价字段）
  const pendingRaw = {
    market: '九江', storeName: '世纪店', serviceOrderId: 'SO2',
    saleOrderType: '销售单', serviceOrderType: '售后',
    customerName: '李女士', customerPhone: null, fallbackPhone: '13000000000',
    productType: '疗程卡', categoryL1: '护理项目', categoryL2: '圣源养心',
    productName: '【王牌】疼痛管理', sessionUsed: 1, unitRealPrice: '300.00',
    status: '已完成',
    salesCategory: '自销自耗', customerType: '会员客', openedByName: '张凯',
    sourceSaleOrderId: 'FY-XSD-WX-2607010001',
    serviceDate: '2026-07-10', createdAt: new Date('2026-07-10T10:00:00.000Z'), remark: null,
  }

  // 已分配但无有效 service_commissions 的占位段 raw（如寄存单退款专用服务单）
  const missingAllocatedRaw = {
    market: '南昌', storeName: '南昌蓝莱店', serviceOrderId: 'SO3',
    saleOrderType: '销售单', serviceOrderType: '售后',
    customerName: '宗女士', customerPhone: null, fallbackPhone: '13900000000',
    productType: '疗程卡', categoryL1: '护理项目', categoryL2: '美体',
    productName: '美体护理', sessionUsed: 9, unitRealPrice: '298.00',
    status: '已完成',
    employeeName: '吁慧', positionName: '门店经理',
    rating: null, reviewComment: null,
    salesCategory: '自销自耗', customerType: '会员客', openedByName: '张凯',
    sourceSaleOrderId: 'FY-XSD-WX-2607160014',
    serviceDate: '2026-07-17',
    createdAt: new Date('2026-07-17T08:43:43.699Z'),
    remark: DEPOSIT_REFUND_REMARK,
  }

  it('「已分配」→ 查明细段 + 缺明细占位，字段映射 + 派生列 + 顾客手机回退', async () => {
    ;(db.select as any).mockImplementation(makeSelectSequence([allocatedRaw], []))
    const { rows } = await exportAllocationServiceOrders({ allocStatus: '已分配' })

    expect(rows).toHaveLength(1)
    expect(db.select).toHaveBeenCalledTimes(2)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO1')
    expect(r.customerPhone).toBe('13151094335') // 回退来源销售单 client_phone
    expect(r.consumeMoney).toBe(300) // 单次价 × 消耗次数
    expect(r.unitRealPrice).toBe(300)
    expect(r.unit).toBe('疗程')
    expect(r.allocationAmount).toBe(90) // 消耗金额 × 分配占比
    expect(r.commissionAmount).toBe(162)
    expect(r.allocationRatio).toBe('0.30')
    expect(r.commissionRate).toBe('0.1500')
    expect(r.rating).toBe(5)
    expect(r.createdAt).toBe('2026-06-08T15:26:32.000Z')
  })

  it('「已分配」但缺有效提成明细 → 返回服务项目占位行，避免页面有而导出缺失', async () => {
    ;(db.select as any).mockImplementation(makeSelectSequence([], [missingAllocatedRaw]))
    const { rows, truncated } = await exportAllocationServiceOrders({ allocStatus: '已分配' })

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    expect(db.select).toHaveBeenCalledTimes(2)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO3')
    expect(r.employeeName).toBe('吁慧')
    expect(r.positionName).toBe('门店经理')
    expect(r.consumeMoney).toBe(0)
    expect(r.unitRealPrice).toBe(298)
    expect(r.allocationRatio).toBeNull()
    expect(r.commissionRate).toBeNull()
    expect(r.commissionAmount).toBeNull()
    expect(r.remark).toBe(DEPOSIT_REFUND_REMARK)
  })

  it('「待分配」→ 只查待分配段，占位行（分配/提成/评价列 null，派生消耗金额仍算）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([pendingRaw]))
    const { rows, truncated } = await exportAllocationServiceOrders({ allocStatus: '待分配' })

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    expect(db.select).toHaveBeenCalledTimes(1)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO2')
    expect(r.employeeName).toBeNull()
    expect(r.positionName).toBeNull()
    expect(r.allocationRatio).toBeNull()
    expect(r.allocationAmount).toBeNull()
    expect(r.commissionRate).toBeNull()
    expect(r.commissionAmount).toBeNull()
    expect(r.rating).toBeNull()
    expect(r.reviewComment).toBeNull()
    expect(r.consumeMoney).toBe(300) // 派生列仍由 unitRealPrice × sessionUsed 算出
    expect(r.productName).toBe('【王牌】疼痛管理')
  })

  it('「全部」(缺省) → 三段都查，按 createdAt desc 合并（待分配 07-10 在前，已分配 06-08 在后）', async () => {
    ;(db.select as any).mockImplementation(makeSelectSequence([allocatedRaw], [], [pendingRaw]))
    const { rows, truncated } = await exportAllocationServiceOrders({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(2)
    expect(db.select).toHaveBeenCalledTimes(3)
    expect(rows[0].serviceOrderId).toBe('SO2') // 待分配（07-10）在前
    expect(rows[0].employeeName).toBeNull()
    expect(rows[1].serviceOrderId).toBe('SO1') // 已分配（06-08）
    expect(rows[1].employeeName).toBe('王雯馨')
  })

  it('worker 分页跨三段来源推进独立游标，不重复也不遗漏', async () => {
    const allocatedNewest = {
      ...allocatedRaw,
      serviceOrderId: 'ALLOC-NEW',
      createdAt: new Date('2026-07-06T00:00:00.000Z'),
    }
    const allocatedOldest = {
      ...allocatedRaw,
      serviceOrderId: 'ALLOC-OLD',
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
    }
    const missingNewest = {
      ...missingAllocatedRaw,
      serviceOrderId: 'MISSING-NEW',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
    }
    const missingOldest = {
      ...missingAllocatedRaw,
      serviceOrderId: 'MISSING-OLD',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    }
    const pendingNewest = {
      ...pendingRaw,
      serviceOrderId: 'PENDING-NEW',
      createdAt: new Date('2026-07-04T00:00:00.000Z'),
    }
    const pendingOldest = {
      ...pendingRaw,
      serviceOrderId: 'PENDING-OLD',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }
    const results = [
      [allocatedNewest, allocatedOldest], [missingNewest, missingOldest], [pendingNewest, pendingOldest],
      [allocatedOldest], [missingNewest, missingOldest], [pendingNewest, pendingOldest],
      [allocatedOldest], [missingOldest], [pendingNewest, pendingOldest],
      [allocatedOldest], [missingOldest], [pendingOldest],
      [], [missingOldest], [pendingOldest],
      [], [], [pendingOldest],
    ]
    let call = 0
    ;(db.select as any).mockImplementation(() => makePagedSelectChain(results[call++] ?? []))

    const first = await exportAllocationServiceOrders({}, { limit: 1 })
    const second = await exportAllocationServiceOrders({}, { limit: 1, cursor: first.nextCursor })
    const third = await exportAllocationServiceOrders({}, { limit: 1, cursor: second.nextCursor })
    const fourth = await exportAllocationServiceOrders({}, { limit: 1, cursor: third.nextCursor })
    const fifth = await exportAllocationServiceOrders({}, { limit: 1, cursor: fourth.nextCursor })
    const sixth = await exportAllocationServiceOrders({}, { limit: 1, cursor: fifth.nextCursor })

    expect(first.nextCursor).toEqual({ allocatedOffset: 1, missingOffset: 0, pendingOffset: 0 })
    expect(second.nextCursor).toEqual({ allocatedOffset: 1, missingOffset: 1, pendingOffset: 0 })
    expect(third.nextCursor).toEqual({ allocatedOffset: 1, missingOffset: 1, pendingOffset: 1 })
    expect(fourth.nextCursor).toEqual({ allocatedOffset: 2, missingOffset: 1, pendingOffset: 1 })
    expect(fifth.nextCursor).toEqual({ allocatedOffset: 2, missingOffset: 2, pendingOffset: 1 })
    expect(sixth.hasMore).toBe(false)
    expect([
      ...first.rows,
      ...second.rows,
      ...third.rows,
      ...fourth.rows,
      ...fifth.rows,
      ...sixth.rows,
    ].map((row) => row.serviceOrderId)).toEqual([
      'ALLOC-NEW',
      'MISSING-NEW',
      'PENDING-NEW',
      'ALLOC-OLD',
      'MISSING-OLD',
      'PENDING-OLD',
    ])
  })

  it('超过旧上限也返回全量且不标记截断', async () => {
    const many = Array.from({ length: 10001 }, (_, i) => ({
      serviceOrderId: `SO${i}`, sessionUsed: 1, unitRealPrice: '100.00',
      allocationRatio: '1.00', commissionAmount: '10.00',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
    }))
    ;(db.select as any).mockImplementation(makeSelectChain(many))
    const { rows, truncated } = await exportAllocationServiceOrders({ allocStatus: '已分配' })
    expect(truncated).toBe(false)
    expect(rows).toHaveLength(20002)
  })

  it('段内 orderBy 主键=createdAt（与合并层 sort 同键）', async () => {
    // 回归守护：合并层按 createdAt desc 做全量合并排序，段内 orderBy 主键也保持 createdAt。
    // db.select 被 mock 使 orderBy 在测试里是 no-op，故直接查 desc mock 的调用序列：
    // 断言 createdAt 紧邻在 updatedAt 之前（即主键在前）。
    ;(db.select as any).mockImplementation(makeSelectChain([allocatedRaw]))
    await exportAllocationServiceOrders({ allocStatus: '已分配' })

    const descCols = (desc as any).mock.calls.map((c: any[]) => c[0])
    const ci = descCols.indexOf(serviceOrders.createdAt)
    expect(ci).toBeGreaterThanOrEqual(0)
    expect(descCols[ci + 1]).toBe(serviceOrders.updatedAt) // createdAt 主键 → updatedAt 次键
  })
})

// ── exportServiceOrders — 服务单管理页导出（消耗项目主表，service_items 主链） ──────
describe('exportServiceOrders — 服务单管理页消耗项目主表导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('产出 25 列消耗项目主表行 + 派生列 consumeMoney（无员工提成维度）', async () => {
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
          skuUnit: '次',
          unitRealPrice: '300.00',
          status: '已完成',
          rating: 5,
          reviewComment: '好评',
          salesCategory: '自销自耗',
          customerType: '会员客',
          openedByName: '张凯',
          sourceSaleOrderId: 'FY-XSD-WX-2606080003',
          serviceDate: '2026-06-08',
          createdAt: new Date('2026-06-08T15:26:32.000Z'),
          remark: null,
        },
      ]),
    )
    const { rows, truncated } = await exportServiceOrders({})
    expect(rows).toHaveLength(1)
    expect(truncated).toBe(false)
    const r = rows[0]
    expect(r.serviceOrderId).toBe('SO1')
    expect(r.market).toBe('九江')
    // 派生列：项目消耗金额 = 单次价 × 次数
    expect(r.consumeMoney).toBe(300)
    expect(r.unit).toBe('次')
    // 主表已移除员工提成维度（提成分配明细改由 exportAllocationServiceOrders 承担）
    expect((r as any).employeeName).toBeUndefined()
    expect((r as any).allocationAmount).toBeUndefined()
    expect((r as any).commissionAmount).toBeUndefined()
  })

  it('强制锁 status=已完成 + 沿用列表筛选口径（解析 from/to/search）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    await exportServiceOrders({ status: '已完成', store: 'store-1', from: '2026-01-01', to: '2026-12-31', q: '王' })
    // date 筛选由 parseServiceOrderFilters 的 from/to → buildServiceOrderConditions 的 gte/lte
    expect(gte).toHaveBeenCalledWith(expect.anything(), '2026-01-01')
    expect(lte).toHaveBeenCalledWith(expect.anything(), '2026-12-31')
    // search 走 ilike
    expect(ilike).toHaveBeenCalled()
  })

  // 回归守护：exportServiceOrders 为消耗项目主表（service_items 主链），不含员工提成维度列。
  // 若有人手贱加回提成列或回滚到 service_commissions 主链，下列断言失败。
  it('回归守护：25 列消耗项目主表 shape（无员工提成维度，有 consumeMoney）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const { rows } = await exportServiceOrders({})
    expect(rows).toEqual([])
    // 主表级列集合（25 列，与 services-page.tsx 导出列一一对应）
    const expectedColumns = [
      'market', 'storeName', 'serviceOrderId', 'saleOrderType', 'serviceOrderType',
      'customerName', 'customerPhone', 'productType', 'categoryL1', 'categoryL2',
      'productName', 'sessionUsed', 'unit', 'consumeMoney', 'unitRealPrice', 'status',
      'salesCategory', 'customerType', 'reviewComment', 'rating',
      'openedByName', 'sourceSaleOrderId', 'serviceDate', 'createdAt', 'remark',
    ]
    // 通过导出空行 + 静态类型对照，断言列集合稳定（防止有人手贱增删列）
    // vitest 无法直接枚举 interface 字段；用「mock 1 行后取 keys」做集合断言
    ;(db.select as any).mockImplementationOnce(
      makeSelectChain([
        {
          market: null, storeName: null, serviceOrderId: 'SO1', saleOrderType: null, serviceOrderType: null,
          customerName: null, customerPhone: null, fallbackPhone: null,
          productType: null, categoryL1: null, categoryL2: null, productName: null,
          sessionUsed: null, skuUnit: null, unitRealPrice: null, status: null,
          rating: null, reviewComment: null,
          salesCategory: null, customerType: null, openedByName: null,
          sourceSaleOrderId: null, serviceDate: null, createdAt: null, remark: null,
        },
      ]),
    )
    const r2 = (await exportServiceOrders({})).rows[0]
    expect(Object.keys(r2).sort()).toEqual(expectedColumns.sort())
  })
})
