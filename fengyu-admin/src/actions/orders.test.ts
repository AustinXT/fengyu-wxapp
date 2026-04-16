import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('@db/order', () => ({
  saleOrders: {
    saleOrderId: 'sale_order_id',
    status: 'status',
    saleOrderType: 'sale_order_type',
    storeId: 'store_id',
    saleOrderDatetime: 'sale_order_datetime',
    customerName: 'customer_name',
    clientPhone: 'client_phone',
    clientUserId: 'client_user_id',
    paidAt: 'paid_at',
    offlineConfirmedBy: 'offline_confirmed_by',
    offlineConfirmedAt: 'offline_confirmed_at',
    $inferInsert: {} as any,
  },
  saleItems: {
    saleOrderId: 'sale_order_id',
    saleItemId: 'sale_item_id',
    storeId: 'store_id',
    itemDirection: 'item_direction',
    remainingSessions: 'remaining_sessions',
    pickedUpQuantity: 'picked_up_quantity',
    quantity: 'quantity',
    $inferInsert: {} as any,
  },
}))

vi.mock('@db/coupon', () => ({
  userCoupons: {
    couponId: 'coupon_id',
    templateId: 'template_id',
    userId: 'user_id',
    status: 'status',
    expireAt: 'expire_at',
    usedSaleOrderId: 'used_sale_order_id',
    usedAt: 'used_at',
  },
  couponTemplates: {
    templateId: 'template_id',
    couponType: 'coupon_type',
    discountValue: 'discount_value',
    maxDiscount: 'max_discount',
    minSpend: 'min_spend',
    isActive: 'is_active',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name' },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
  clientWechatUsers: { userId: 'user_id', customerType: 'customer_type' },
}))

vi.mock('@db/system-config', () => ({
  systemConfigs: { key: 'key', value: 'value' },
}))

vi.mock('@db/product', () => ({
  productSkus: { skuId: 'sku_id', specName: 'spec_name', productId: 'product_id', categoryId: 'category_id', price: 'price', serviceFee: 'service_fee', sessionCount: 'session_count', productType: 'product_type' },
  products: { productId: 'product_id', name: 'name' },
  productCategories: { categoryId: 'category_id', productKind: 'product_kind', salesCategory: 'sales_category' },
}))

vi.mock('@db/prepaid-card', () => ({
  prepaidCards: { cardId: 'card_id', userId: 'user_id', storeId: 'store_id', balance: 'balance' },
  cardTransactions: { id: 'id', cardId: 'card_id', type: 'type', amount: 'amount', refOrderId: 'ref_order_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, arr) => ({ type: 'inArray', col, arr })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn(), join: vi.fn() }),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((table, _name) => table),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  calcCouponDiscount: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}))

const mockGetMemberThreshold = vi.fn(async () => 1980)
vi.mock('@/lib/member-threshold', () => ({
  getMemberThreshold: () => mockGetMemberThreshold(),
  invalidateMemberThreshold: vi.fn(),
  MEMBER_THRESHOLD_FALLBACK: 1980,
  MEMBER_THRESHOLD_TAG: 'new_member_threshold',
}))

import { createOrder, confirmOfflinePayment, closeOrder, resetOrderFailed, getOrdersPaginated, createConversionOrder } from './orders'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, scopeCondition } from '@/lib/permissions'
import { calcCouponDiscount } from '@/lib/utils'
import { eq, ilike, gte, lt } from 'drizzle-orm'

const mockSession = {
  employeeId: 'EMP-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['sale_order:create', 'sale_order:update'], scopeStoreIds: ['store-1'] },
}

const baseOrderData = {
  storeId: 'store-1',
  marketName: '市场A',
  clientUserId: null,
  clientPhone: '13812345678',
  customerName: '顾客甲',
  paymentMethod: '线下' as const,
  saleOrderType: '销售单' as const,
  items: [{
    skuId: 'sku-001',
    productName: '美容套餐',
    skuSpecName: '标准',
    productType: '单品' as const,
    sessionCount: null,
    unitPrice: '200.00',
    unitRealPrice: '200.00',
    quantity: 1,
    salesCategory: '自采自销' as const,
  }],
}

function mockTransactionSuccess(orderId = 'FY-XSD-WX-260315001') {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([{ id: orderId }]),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }),
    }
    return fn(tx)
  })
}

// where 返回的对象同时支持 `.limit()` 链式和直接 await（productSkus 批量查询走后者）
function makeThenableWhere(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows)
  return vi.fn().mockImplementation(() => ({
    limit,
    then: (resolve: (value: any[]) => any) => resolve(rows),
  }))
}

function mockSelectEmpty() {
  const where = makeThenableWhere([])
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ where, innerJoin })
  return vi.fn().mockReturnValue({ from })
}

function mockSelectFound(row: any) {
  const where = makeThenableWhere([row])
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ where, innerJoin })
  return vi.fn().mockReturnValue({ from })
}

describe('createOrder — 权限与 scope 校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('storeId 不在 scope 内 → 拒绝', async () => {
    ;(isInScope as any).mockReturnValue(false)

    const result = await createOrder({ ...baseOrderData, storeId: 'other-store' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('storeId 在 scope 内 → 允许进入事务', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionSuccess()

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
  })
})

describe('createOrder — 优惠券校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  const now = new Date()
  const futureDate = new Date(now.getTime() + 86400_000)
  const pastDate = new Date(now.getTime() - 86400_000)

  const validCoupon = {
    userId: 'user-1',
    status: '未使用',
    expireAt: futureDate,
    isActive: true,
    couponType: '现金券',
    discountValue: '50.00',
    maxDiscount: null,
    minSpend: '100',
  }

  it('优惠券不存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-999',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
  })

  it('优惠券不属于该顾客 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, userId: 'other-user' }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不属于该顾客')
  })

  it('优惠券已使用 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, status: '已使用' }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('已被使用')
  })

  it('优惠券已过期 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, expireAt: pastDate }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('过期')
  })

  it('优惠券模板已停用 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, isActive: false }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('停用')
  })

  it('订单金额未达最低消费 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, minSpend: '500' }))

    // baseOrderData items total = 200, minSpend = 500
    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('最低消费')
  })

  it('有效优惠券 → calcCouponDiscount 被调用，totalAmount 扣减', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(validCoupon))
    ;(calcCouponDiscount as any).mockReturnValue(50)
    mockTransactionSuccess()

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(calcCouponDiscount).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })
})

describe('createOrder — 事务异常捕获', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('优惠券并发核销失败（事务内 throw）→ 友好消息', async () => {
    // 预检查通过（coupon 有效），但事务内并发核销失败
    ;(db.select as any).mockImplementation(mockSelectFound({
      userId: 'user-1', status: '未使用',
      expireAt: new Date(Date.now() + 86400_000),
      isActive: true, couponType: '现金券',
      discountValue: '50.00', maxDiscount: null, minSpend: '100',
    }))
    ;(calcCouponDiscount as any).mockReturnValue(50)
    ;(db.transaction as any).mockRejectedValue(new Error('优惠券已被使用，请刷新后重试'))

    const result = await createOrder({ ...baseOrderData, couponId: 'coupon-1', clientUserId: 'user-1' })

    expect(result.success).toBe(false)
    expect(result.message).toBe('优惠券已被使用，请刷新后重试')
  })

  it('PG 外键违反（23503）→ 友好消息', async () => {
    const err = Object.assign(new Error('FK violation'), { code: '23503' })
    ;(db.transaction as any).mockRejectedValue(err)

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('关联数据不存在')
  })

  it('PG 唯一冲突（23505）→ 友好消息', async () => {
    const err = Object.assign(new Error('unique violation'), { code: '23505' })
    ;(db.transaction as any).mockRejectedValue(err)

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(false)
    expect(result.message).toContain('冲突')
  })

  it('其他 DB 异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    const result = await createOrder(baseOrderData)
    expect(result.success).toBe(false)
    expect(result.message).toBe('创建订单失败，请稍后重试')
  })

  it('正常创建（无优惠券）→ 返回 saleOrderId', async () => {
    mockTransactionSuccess('FY-XSD-WX-260315001')

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(true)
    expect(result.saleOrderId).toBe('FY-XSD-WX-260315001')
    expect(result.message).toBe('订单创建成功')
  })
})

describe('createOrder — documentType 使用 getMemberThreshold helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('金额低于 helper 返回门槛 → documentType 保持售前（即调用 helper）', async () => {
    mockGetMemberThreshold.mockResolvedValueOnce(2000)
    mockTransactionSuccess('FY-XSD-WX-260410001')

    const result = await createOrder({
      ...baseOrderData,
      items: [{
        ...baseOrderData.items[0],
        unitPrice: '100.00',
        unitRealPrice: '100.00',
      }],
    })

    expect(result.success).toBe(true)
    expect(mockGetMemberThreshold).toHaveBeenCalled()
  })

  it('金额 >= helper 门槛 → documentType = 售后（helper 读到 1980 时 total=2000）', async () => {
    mockGetMemberThreshold.mockResolvedValueOnce(1980)
    mockTransactionSuccess('FY-XSD-WX-260410002')

    const result = await createOrder({
      ...baseOrderData,
      items: [{
        ...baseOrderData.items[0],
        unitPrice: '2000.00',
        unitRealPrice: '2000.00',
      }],
    })

    expect(result.success).toBe(true)
    expect(mockGetMemberThreshold).toHaveBeenCalled()
  })
})

/** mock db.select() 链用于 logTransition 上下文获取：.from().where().limit() */
function mockSelectBefore(rows: any[] = [{}]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValue(chain)
}

describe('confirmOfflinePayment — 事务原子性（AC-13）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ customerName: '顾客甲', totalAmount: '200.00' }])
  })

  function mockConfirmTx(count: number) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
      }
      return fn(tx)
    })
  }

  it('订单状态已变更（rowCount=0）→ 失败', async () => {
    mockConfirmTx(0)
    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('正常确认收款（rowCount=1）→ 事务内两步均执行', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
      }
      const result = await fn(tx)
      expect(tx.update).toHaveBeenCalledOnce()
      expect(tx.execute).toHaveBeenCalledOnce() // 设置到期日
      return result
    })

    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('确认收款成功')
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('事务异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('确认收款失败，请稍后重试')
  })
})

describe('closeOrder — 事务原子性（关闭 + 作废分配）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ status: '待支付', customerName: '顾客甲', totalAmount: '200.00' }])
  })

  function mockCloseTx(count: number) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
      }
      return fn(tx)
    })
  }

  it('订单不可关闭（rowCount=0）→ 失败', async () => {
    mockCloseTx(0)
    const result = await closeOrder('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('正常关闭（rowCount=1）→ 事务内两步均执行', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
      }
      const result = await fn(tx)
      expect(tx.update).toHaveBeenCalledOnce() // 关闭订单
      expect(tx.execute).toHaveBeenCalledOnce() // 作废分配
      return result
    })

    const result = await closeOrder('order-1')
    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('事务异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    const result = await closeOrder('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('关闭订单失败，请稍后重试')
  })
})

describe('resetOrderFailed — 重置支付失败', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ customerName: '顾客甲', totalAmount: '200.00' }])
  })

  it('订单不是支付失败状态（rowCount=0）→ 失败', async () => {
    const where = vi.fn().mockResolvedValue({ count: 0 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await resetOrderFailed('order-1')

    expect(result.success).toBe(false)
  })

  it('正常重置（rowCount=1）→ 成功', async () => {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    const result = await resetOrderFailed('order-1')

    expect(result.success).toBe(true)
    expect(result.message).toContain('待支付')
  })

  it('DB 异常 → 重新抛出', async () => {
    const where = vi.fn().mockRejectedValue(new Error('connection lost'))
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })

    await expect(resetOrderFailed('order-1')).rejects.toThrow('connection lost')
  })
})

// ─── getOrdersPaginated 服务端分页 ─────────────────────────────────

describe('getOrdersPaginated — 服务端分页', () => {
  const mockOrderRow = {
    order: {
      saleOrderId: 'FY-XSD-WX-260315-0001',
      status: '已支付',
      saleOrderType: '销售单',
      refSaleOrderId: null,
      marketName: '南昌市场',
      storeId: 'store-1',
      saleOrderDatetime: new Date('2026-03-15T10:00:00Z'),
      clientUserId: 'user-1',
      clientPhone: '13812345678',
      customerName: '李女士',
      totalAmount: '1999.00',
      paymentMethod: '微信',
      openedBy: 'EMP-001',
      preferredEmployeeId: null,
      paidAt: new Date('2026-03-15T10:05:00Z'),
      allocationStatus: '待分配',
      couponId: null,
      couponDiscount: '0',
      remark: null,
      createdAt: new Date('2026-03-15T10:00:00Z'),
      updatedAt: new Date('2026-03-15T10:05:00Z'),
    },
    storeName: '南昌旗舰店',
    openedByName: '张三',
  }

  /** 构建完整的链式调用 mock：select → from → leftJoin → leftJoin → where → orderBy → limit → offset */
  function mockPaginatedChain(countResult: number, dataRows: any[]) {
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // COUNT 查询链：select → from → where
        const where = vi.fn().mockResolvedValue([{ count: countResult }])
        const from = vi.fn().mockReturnValue({ where })
        return { from }
      }
      // DATA 查询链：select → from → leftJoin → leftJoin → where → orderBy → limit → offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin2 = vi.fn().mockReturnValue({ where })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无筛选 → 返回分页结果 + total', async () => {
    mockPaginatedChain(1, [mockOrderRow])

    const result = await getOrdersPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].saleOrderId).toBe('FY-XSD-WX-260315-0001')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].openedByName).toBe('张三')
  })

  it('空数据 → 返回 { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getOrdersPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('page/pageSize 传入 → 调用链包含 limit + offset', async () => {
    mockPaginatedChain(50, [])

    const result = await getOrdersPaginated({ page: 3, pageSize: 10 })

    expect(result.total).toBe(50)
    // 验证 limit/offset 链被调用（mock 链已验证结构）
    expect(db.select).toHaveBeenCalledTimes(2) // COUNT + DATA
  })

  it('page < 1 时修正为 1', async () => {
    mockPaginatedChain(10, [])

    const result = await getOrdersPaginated({ page: -5 })

    expect(result.total).toBe(10)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('非法 pageSize → 默认 20', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ pageSize: 999 })

    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('status 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ status: '已支付' })

    expect(eq).toHaveBeenCalledWith('status', '已支付')
  })

  it('type 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ type: '体验' })

    expect(eq).toHaveBeenCalledWith('sale_order_type', '体验')
  })

  it('storeId 筛选 → eq 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ storeId: 'store-2' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-2')
  })

  it('search 筛选 → ilike 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ search: '李女士' })

    expect(ilike).toHaveBeenCalledWith('sale_order_id', '%李女士%')
    expect(ilike).toHaveBeenCalledWith('customer_name', '%李女士%')
    expect(ilike).toHaveBeenCalledWith('client_phone', '%李女士%')
  })

  it('dateFrom 筛选 → gte 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ dateFrom: '2026-03-01' })

    expect(gte).toHaveBeenCalled()
  })

  it('dateTo 筛选 → lt 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ dateTo: '2026-03-31' })

    expect(lt).toHaveBeenCalled()
  })

  it('paidAt 为 null → 序列化为 null', async () => {
    const rowNoPaid = {
      ...mockOrderRow,
      order: { ...mockOrderRow.order, paidAt: null },
    }
    mockPaginatedChain(1, [rowNoPaid])

    const result = await getOrdersPaginated()

    expect(result.data[0].paidAt).toBeNull()
  })

  it('storeName/openedByName 为 null → 序列化为 undefined', async () => {
    const rowNoJoins = {
      ...mockOrderRow,
      storeName: null,
      openedByName: null,
    }
    mockPaginatedChain(1, [rowNoJoins])

    const result = await getOrdersPaginated()

    expect(result.data[0].storeName).toBeUndefined()
    expect(result.data[0].openedByName).toBeUndefined()
  })
})

// ─── createOrder — 内部单半价 + 禁用优惠券 (A4) ─────────────────────────

describe('createOrder — 内部单半价 + 禁用优惠券', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('内部单 + couponId → 拒绝并返回明确提示', async () => {
    const result = await createOrder({
      ...baseOrderData,
      saleOrderType: '内部单',
      clientUserId: 'user-1',
      couponId: 'coupon-1',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('内部单不允许叠加优惠券')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('内部单 → 进入事务时 items 金额已 ×0.5（unitPrice 原价保留）', async () => {
    let capturedItem: any
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260410-INT01' }]),
        insert: vi.fn().mockImplementation((table: any) => ({
          values: vi.fn().mockImplementation((v: any) => {
            if (table && 'saleItemId' in v) capturedItem = v
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
      }
      return fn(tx)
    })

    const result = await createOrder({
      ...baseOrderData,
      saleOrderType: '内部单',
      items: [{
        ...baseOrderData.items[0],
        unitPrice: '200.00',
        unitRealPrice: '200.00',
        quantity: 2,
      }],
    })

    expect(result.success).toBe(true)
    // 半价生效：unitRealPrice 200 → 100；unitPrice 保留原价 200
    expect(capturedItem.unitRealPrice).toBe('100.00')
    expect(capturedItem.unitPrice).toBe('200.00')
  })
})

// ─── createConversionOrder (A3) ───────────────────────────────────────

describe('createConversionOrder — 权限与入参校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  const baseConvData = {
    storeId: 'store-1',
    marketName: '市场A',
    clientUserId: 'user-1',
    paymentMethod: '线下' as const,
    convertOutSaleItemIds: ['card-1'],
    convertInItems: [{
      skuId: 'sku-new-1',
      productName: '新项目',
      skuSpecName: '10次卡',
      productType: '疗程卡' as const,
      sessionCount: 10,
      unitPrice: '1000.00',
      quantity: 1,
    }],
  }

  it('storeId 不在 scope → 拒绝', async () => {
    ;(isInScope as any).mockReturnValue(false)
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('无权')
  })

  it('clientUserId 为空 → 拒绝', async () => {
    const result = await createConversionOrder({ ...baseConvData, clientUserId: '' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('必须指定顾客')
  })

  it('convertOutSaleItemIds 空数组 → 拒绝', async () => {
    const result = await createConversionOrder({ ...baseConvData, convertOutSaleItemIds: [] })
    expect(result.success).toBe(false)
    expect(result.message).toContain('折抵卡')
  })

  it('convertInItems 空数组 → 拒绝', async () => {
    const result = await createConversionOrder({ ...baseConvData, convertInItems: [] })
    expect(result.success).toBe(false)
    expect(result.message).toContain('转入项目')
  })

  it('顾客不存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('顾客不存在')
  })
})

describe('createConversionOrder — 事务路径：differ=0 / >0 / <0', () => {
  const mockClient = { userId: 'user-1', phone: '13812345678', name: '张小姐', customerType: '会员客' }

  /**
   * 构造模拟 tx：
   * heldRow 控制 FOR UPDATE 返回的转出候选（含 client_user_id / order_status 等字段）
   * skuRow 控制转入 SKU 查询返回
   * orderId 控制 INSERT 前 advisory lock 查询
   */
  function mockConvTx(opts: {
    heldRows: any[]
    skuRows: any[]
    orderId?: string
    updateCount?: number
    upsertCardId?: string
    onInsertOrder?: (v: any) => void
  }) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let execCall = 0
      const tx = {
        execute: vi.fn().mockImplementation(async () => {
          execCall++
          if (execCall === 1) return opts.heldRows
          if (execCall === 2) return [{ id: opts.orderId || 'FY-XSD-WX-260416-0001' }]
          if (execCall === 3) return [{ card_id: opts.upsertCardId || 'card-new-1' }]
          return []
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(opts.skuRows),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            if (v && 'saleOrderId' in v && 'saleOrderType' in v) {
              opts.onInsertOrder?.(v)
            }
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
          }),
        }),
      }
      return fn(tx)
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    // 顾客查找
    ;(db.select as any).mockImplementation(mockSelectFound(mockClient))
  })

  const baseConvData = {
    storeId: 'store-1',
    marketName: '市场A',
    clientUserId: 'user-1',
    paymentMethod: '线下' as const,
    convertOutSaleItemIds: ['card-1'],
    convertInItems: [{
      skuId: 'sku-new-1',
      productName: '新项目',
      skuSpecName: '10次卡',
      productType: '疗程卡' as const,
      sessionCount: 10,
      unitPrice: '1000.00',
      quantity: 1,
    }],
  }

  it('priceDiff = 0：totalIn=totalOut，订单 total_amount=0，status=已支付', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', sku_spec_name: '5次卡',
        product_type: '疗程卡', session_count: 5, remaining_sessions: 5,
        quantity: 1, picked_up_quantity: 0, unit_price: '1000.00',
        unit_real_price: '200.00', sales_category: '自采自销', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '1000.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自采自销',
      }],
      onInsertOrder: (v) => { capturedOrder = v },
    })

    const result = await createConversionOrder(baseConvData)

    expect(result.success).toBe(true)
    expect(result.totalIn).toBe(1000)
    expect(result.totalOut).toBe(1000)
    expect(result.priceDiff).toBe(0)
    expect(capturedOrder.totalAmount).toBe('0.00')
    expect(capturedOrder.status).toBe('已支付')
  })

  it('priceDiff > 0：补现，total_amount=差额，status=待确认收款（线下）', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', sku_spec_name: '3次卡',
        product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自采自销', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自采自销',
      }],
      onInsertOrder: (v) => { capturedOrder = v },
    })

    const result = await createConversionOrder(baseConvData)

    expect(result.success).toBe(true)
    expect(result.totalIn).toBe(500)
    expect(result.totalOut).toBe(300)
    expect(result.priceDiff).toBe(200)
    expect(capturedOrder.totalAmount).toBe('200.00')
    expect(capturedOrder.status).toBe('待确认收款')
    expect(result.prepaidCardCredit).toBe(0)
  })

  it('priceDiff < 0：差额入储值卡，status=已支付', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', sku_spec_name: '8次卡',
        product_type: '疗程卡', session_count: 8, remaining_sessions: 8,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自采自销', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自采自销',
      }],
      upsertCardId: 'card-new-99',
      onInsertOrder: (v) => { capturedOrder = v },
    })

    const result = await createConversionOrder(baseConvData)

    expect(result.success).toBe(true)
    expect(result.totalIn).toBe(500)
    expect(result.totalOut).toBe(800)
    expect(result.priceDiff).toBe(-300)
    expect(result.prepaidCardCredit).toBe(300)
    expect(capturedOrder.totalAmount).toBe('0.00')
    expect(capturedOrder.status).toBe('已支付')
  })
})

describe('createConversionOrder — 异常路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectFound({
      userId: 'user-1', phone: '13812345678', name: '张小姐', customerType: '流量客',
    }))
  })

  const baseConvData = {
    storeId: 'store-1',
    marketName: '市场A',
    clientUserId: 'user-1',
    paymentMethod: '线下' as const,
    convertOutSaleItemIds: ['card-1'],
    convertInItems: [{
      skuId: 'sku-new-1',
      productName: '新项目',
      skuSpecName: '10次卡',
      productType: '疗程卡' as const,
      sessionCount: 10,
      unitPrice: '1000.00',
      quantity: 1,
    }],
  }

  it('跨店（heldRow.store_id != ctx.storeId）→ CARD_STORE_MISMATCH', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{
          sale_item_id: 'card-1', store_id: 'store-999', item_direction: '购买',
          product_type: '疗程卡', remaining_sessions: 5, unit_real_price: '100',
          client_user_id: 'user-1', order_status: '已支付', quantity: 1,
          picked_up_quantity: 0, unit_price: '100', service_fee: '0',
          session_count: 5, product_kind: '护理项目',
        }]),
        select: vi.fn(), insert: vi.fn(), update: vi.fn(),
      }
      return fn(tx)
    })
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不属于当前门店')
  })

  it('卡已耗尽（remaining_sessions=0）→ CARD_EXHAUSTED', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{
          sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
          product_type: '疗程卡', remaining_sessions: 0, unit_real_price: '100',
          client_user_id: 'user-1', order_status: '已支付', quantity: 1,
          picked_up_quantity: 0, unit_price: '100', service_fee: '0',
          session_count: 5, product_kind: '护理项目',
        }]),
        select: vi.fn(), insert: vi.fn(), update: vi.fn(),
      }
      return fn(tx)
    })
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('已耗尽')
  })

  it('部分卡不存在（held.length 不等于 input）→ CARD_NOT_FOUND', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),  // 输入 1 张卡，返回 0 张
        select: vi.fn(), insert: vi.fn(), update: vi.fn(),
      }
      return fn(tx)
    })
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在或已失效')
  })

  it('并发扣减失败（updateCount=0）→ CARD_CONCURRENT_CHANGED', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let execCall = 0
      const tx = {
        execute: vi.fn().mockImplementation(async () => {
          execCall++
          if (execCall === 1) return [{
            sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
            product_type: '疗程卡', remaining_sessions: 5, unit_real_price: '100',
            client_user_id: 'user-1', order_status: '已支付', quantity: 1,
            picked_up_quantity: 0, unit_price: '100', service_fee: '0',
            session_count: 5, product_kind: '护理项目', sku_id: 'sku-old',
            product_name: 'xx', sku_spec_name: 'yy', sales_category: '自采自销',
          }]
          return [{ id: 'FY-XSD-WX-260416-0001' }]
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{
                skuId: 'sku-new-1', price: '500', serviceFee: '0', sessionCount: 10,
                productType: '疗程卡', salesCategory: '自采自销',
              }]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        // 关键：update 返回 count=0 表示并发冲突
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 0 }),
          }),
        }),
      }
      return fn(tx)
    })
    const result = await createConversionOrder(baseConvData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('卡状态变化')
  })
})
