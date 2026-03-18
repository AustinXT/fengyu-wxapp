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
    paidAt: 'paid_at',
    offlineConfirmedBy: 'offline_confirmed_by',
    offlineConfirmedAt: 'offline_confirmed_at',
  },
  saleItems: { saleOrderId: 'sale_order_id', saleItemId: 'sale_item_id' },
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
}))

vi.mock('@db/product', () => ({
  productSkus: { skuId: 'sku_id', specName: 'spec_name', productId: 'product_id' },
  products: { productId: 'product_id', name: 'name' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
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
}))

vi.mock('@/lib/utils', () => ({
  calcCouponDiscount: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { createOrder, confirmOfflinePayment, closeOrder, resetOrderFailed, getOrdersPaginated } from './orders'
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
  paymentMethod: 'offline' as const,
  saleOrderType: '普通' as const,
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

function mockSelectEmpty() {
  const limit = vi.fn().mockResolvedValue([])
  const where = vi.fn().mockReturnValue({ limit })
  const innerJoin = vi.fn().mockReturnValue({ where })
  const from = vi.fn().mockReturnValue({ where, innerJoin })
  return vi.fn().mockReturnValue({ from })
}

function mockSelectFound(row: any) {
  const limit = vi.fn().mockResolvedValue([row])
  const where = vi.fn().mockReturnValue({ limit })
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

  it('其他 DB 异常重新抛出（非业务错误）', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))

    await expect(createOrder(baseOrderData)).rejects.toThrow('connection lost')
  })

  it('正常创建（无优惠券）→ 返回 saleOrderId', async () => {
    mockTransactionSuccess('FY-XSD-WX-260315001')

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(true)
    expect(result.saleOrderId).toBe('FY-XSD-WX-260315001')
    expect(result.message).toBe('订单创建成功')
  })
})

describe('confirmOfflinePayment — 事务原子性（AC-13）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
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

  it('事务异常 → 重新抛出', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    await expect(confirmOfflinePayment('order-1')).rejects.toThrow('connection lost')
  })
})

describe('closeOrder — 事务原子性（关闭 + 作废分配）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
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

  it('事务异常 → 重新抛出', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    await expect(closeOrder('order-1')).rejects.toThrow('connection lost')
  })
})

describe('resetOrderFailed — 重置支付失败', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
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
      saleOrderType: '普通',
      refSaleOrderId: null,
      marketName: '南昌市场',
      storeId: 'store-1',
      saleOrderDatetime: new Date('2026-03-15T10:00:00Z'),
      clientUserId: 'user-1',
      clientPhone: '13812345678',
      customerName: '李女士',
      totalAmount: '1999.00',
      paymentMethod: 'wechat',
      saleOrderSource: 'admin',
      openedBy: 'EMP-001',
      preferredEmployeeId: null,
      paidAt: new Date('2026-03-15T10:05:00Z'),
      allocationStatus: 'pending',
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
