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
    paymentMethod: 'payment_method',
    prepaidCardAmount: 'prepaid_card_amount',
    payableAmount: 'payable_amount',
    // 2026-04-26 sale-order-domain-refactor：DB 列名已由 paid_amount 重命名为 received
    received: 'received',
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
  /** ticket 2026-04-24 PR-3 — 款项流水表 */
  saleOrderPayments: {
    id: 'id',
    saleOrderId: 'sale_order_id',
    changeType: 'change_type',
    amount: 'amount',
    paymentMethod: 'payment_method',
    externalTxnId: 'external_txn_id',
    status: 'status',
    sourceEnd: 'source_end',
    operatorEmployeeId: 'operator_employee_id',
    note: 'note',
    createdAt: 'created_at',
    paidAt: 'paid_at',
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
  // 2026-04-27 dfa4847: orders.ts createOrder 优惠券范围校验需查 mall_product_skus → product 的映射
  mallProductSkus: { productId: 'product_id', skuId: 'sku_id', bundleGroupId: 'bundle_group_id', bundlePrice: 'bundle_price', sortOrder: 'sort_order' },
}))

vi.mock('@db/prepaid-card', () => ({
  // 2026-04-24 prepaid_cards.store_id 已 DROP；2026-04-26 sale-order-domain-refactor 修复
  // P0-14-01：移除 mock 的 storeId 字段，避免反向锁死老代码引用
  prepaidCards: { cardId: 'card_id', userId: 'user_id', balance: 'balance' },
  cardTransactions: { id: 'id', cardId: 'card_id', type: 'type', amount: 'amount', refOrderId: 'ref_order_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  gt: vi.fn((a, b) => ({ type: 'gt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, arr) => ({ type: 'inArray', col, arr })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
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
  requireAnyPermission: vi.fn(),
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

// 把 settlePointsSafe mock 成 noop，避免它在每个 confirmOfflinePayment/recordPayment
// 测试里增加 3-5 次 tx.execute 调用而打破现有精确次数断言；
// 单独的 "settle/recalc 触发点" describe 会复位 mock 来验证调用契约
vi.mock('@/lib/points-settle', () => ({
  settlePointsSafe: vi.fn(async () => ({
    delta: 0,
    expected: 0,
    granted: 0,
    skipped: 'mocked-in-test',
  })),
}))

import { createOrder, confirmOfflinePayment, closeOrder, resetOrderFailed, getOrdersPaginated, createConversionOrder, recordPayment } from './orders'
import { settlePointsSafe } from '@/lib/points-settle'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, scopeCondition } from '@/lib/permissions'
import { calcCouponDiscount } from '@/lib/utils'
import { eq, ilike, gte, lt, gt } from 'drizzle-orm'
import { requirePermission } from '@/lib/permissions'

const mockSession = {
  employeeId: 'EMP-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['sale_order:create', 'sale_order:update'], scopeStoreIds: ['store-1'] },
}

const baseOrderData = {
  storeId: 'store-1',
  marketName: '市场A',
  clientUserId: 'user-1',
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
    salesCategory: '自销自耗' as const,
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

describe('createOrder — 顾客校验（顾客未注册守卫）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('clientUserId 为空字符串 → 拒绝，不进入事务', async () => {
    const result = await createOrder({ ...baseOrderData, clientUserId: '' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('顾客未注册')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('顾客未注册拒单在 scope 校验之前触发（即使 scope 不符也优先报缺顾客）', async () => {
    ;(isInScope as any).mockReturnValue(false)
    const result = await createOrder({ ...baseOrderData, clientUserId: '', storeId: 'other-store' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('顾客未注册')
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

  it('J3 数组形式 couponId → 拒绝 MULTIPLE_COUPON_NOT_SUPPORTED', async () => {
    // B9 ticket follow-up：runtime 兜底防外部调用绕过 schema 校验直接传 array
    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1',
      couponId: ['c1', 'c2'] as unknown as string,  // 故意类型穿透模拟绕过
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('MULTIPLE_COUPON_NOT_SUPPORTED')
    expect(result.message).toContain('1 张优惠券')
  })

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

  // ticket B9：C2 范围（applicableCategoryIds）限制 → eligibleItems 为空必须拒绝
  // 修复前 admin 仅做 hasOverlap 校验，scope-only 限制时未拒；
  // 修复后改为 eligibleItems 过滤，无匹配则报"不满足品类限制"。
  it('applicableCategoryIds 设置但 SKU 不匹配 → 拒绝（C2 范围校验）', async () => {
    // 此 mock 让所有 select 返回该 coupon 行；SKU 行没有 categoryId 字段 → undefined 不在 ['cat-X'] 中
    ;(db.select as any).mockImplementation(mockSelectFound({
      ...validCoupon,
      applicableCategoryIds: ['cat-X'],
    }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('品类限制')
  })

  // ticket B9：C1 范围（applicableProductIds）限制 → eligibleItems 为空必须拒绝
  it('applicableProductIds 设置但 SKU 不匹配 → 拒绝（C1 范围校验）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({
      ...validCoupon,
      applicableProductIds: ['prod-X'],
    }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('商品限制')
  })

  // ticket B9：C6 minSpend 基数必须是 eligibleTotal（scope 内合计），不是全单金额
  // 修复前 admin 用 saleAmountTotal 全单，与 client/staff 行为不一致；
  // 修复后基数切换到 eligibleItems 累加。
  // 当 applicableCategoryIds 设置但无匹配 SKU → 先报"品类不满足"（在 minSpend 之前），证明 eligibleTotal 路径生效
  it('折扣基数：scope 限制 + minSpend 校验顺序符合 eligibleTotal 路径（C6）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({
      ...validCoupon,
      applicableCategoryIds: ['cat-X'],
      minSpend: '0',
    }))

    const result = await createOrder({
      ...baseOrderData, clientUserId: 'user-1', couponId: 'coupon-1',
    })

    // 即使 minSpend=0，由于 eligibleItems 为空，会先在范围校验阶段拒绝
    expect(result.success).toBe(false)
    expect(result.message).toContain('品类限制')
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

/**
 * B2 拆行专用 mock：捕获 tx.insert().values(...) 的所有调用，按表名分组。
 * ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
 */
function mockTransactionCaptureInserts(orderId = 'FY-XSD-WX-260518001') {
  const insertCalls: Array<{ table: any; values: any }> = []
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([{ id: orderId }]),
      insert: vi.fn().mockImplementation((table: any) => ({
        values: vi.fn().mockImplementation((values: any) => {
          insertCalls.push({ table, values })
          return Promise.resolve({})
        }),
      })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }),
    }
    return fn(tx)
  })
  return insertCalls
}

describe('createOrder — B2 拆行（疗程卡 quantity>1 → N 行）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('单次卡 ×10（疗程卡 sessionCount=1）→ 写入 10 行 sale_items（每行 quantity=1）', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518101')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-single',
        productName: '单次身体护理',
        skuSpecName: '单次',
        productType: '疗程卡' as const,
        sessionCount: 1,
        unitPrice: '200.00',
        unitRealPrice: '200.00',
        quantity: 10,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(result.success).toBe(true)
    const itemInserts = inserts.filter((c) => Array.isArray(c.values) ? false : true)
    // sale_items 是 tx.insert(saleItems).values({...}) 单条调用形式
    // 通过累计 values 中含 saleItemId/saleOrderId/productType 的调用计数
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(10)
    for (const c of saleItemInserts) {
      expect(c.values.quantity).toBe(1)
      expect(c.values.sessionCount).toBe(1)
      expect(c.values.remainingSessions).toBe(1)
      expect(c.values.productType).toBe('疗程卡')
    }
    void itemInserts
  })

  it('10次卡 ×2（疗程卡 sessionCount=10）→ 写入 2 行 sale_items（每行 quantity=1, sessionCount=10）', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518102')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-multi',
        productName: '10次面部护理',
        skuSpecName: '10次',
        productType: '疗程卡' as const,
        sessionCount: 10,
        unitPrice: '1000.00',
        unitRealPrice: '1000.00',
        quantity: 2,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(2)
    for (const c of saleItemInserts) {
      expect(c.values.quantity).toBe(1)
      // sessionCount 在服务端 createOrder 用 skuSessionMap × quantity 计算；
      // 因 mockSelectEmpty 让 skuRows=[]，skuSessionMap.get 返回 undefined，
      // 回退使用 item.sessionCount（拆后 quantity=1）= 10
      expect(c.values.sessionCount).toBe(10)
      expect(c.values.remainingSessions).toBe(10)
    }
  })

  it('家居产品 ×10（productType=家居产品）→ 写入 1 行 sale_items（quantity=10，合行不拆）', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518103')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-home',
        productName: '精华液',
        skuSpecName: '50ml',
        productType: '家居产品' as const,
        sessionCount: null,
        unitPrice: '300.00',
        unitRealPrice: '300.00',
        quantity: 10,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(1)
    expect(saleItemInserts[0].values.quantity).toBe(10)
    expect(saleItemInserts[0].values.productType).toBe('家居产品')
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

  /** tx mock：支持 update + execute + select + insert 链（applyRechargeOnOrderPaid 依赖 select/insert） */
  function mockConfirmTx(count: number, selectRows: any[][] = [[], []]) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let selectCall = 0
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockImplementation(() => {
            const rows = selectRows[selectCall] ?? []
            selectCall++
            return Promise.resolve(rows)
          })
          return chain
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
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

  it('正常确认收款（rowCount=1）→ 事务内各步均执行', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          // 非充值订单：order 查询返回无 clientUserId，applyRechargeOnOrderPaid 提前 return
          chain.limit = vi.fn().mockResolvedValue([])
          return chain
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      const result = await fn(tx)
      expect(tx.update).toHaveBeenCalledOnce()
      expect(tx.execute).toHaveBeenCalledOnce() // 设置到期日（非充值订单只调 1 次 execute）
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

describe('confirmOfflinePayment — 充值卡入账（与 payNotify 对齐）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ customerName: '顾客甲', totalAmount: '495.00' }])
  })

  /** 构造含充值虚拟 SKU 的订单 tx mock，默认未重复入账 */
  function mockRechargeTx(opts: {
    updateCount?: number
    clientUserId?: string | null
    storeId?: string | null
    productName?: string | null
    dupExists?: boolean
    upsertCardId?: string
  } = {}) {
    const captured: { executes: any[]; insertValues: any[] } = { executes: [], insertValues: [] }
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let selectCall = 0
      let executeCall = 0
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
          }),
        }),
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          captured.executes.push(sqlArg)
          executeCall++
          // 1: 设置到期日；2: dup 检查；3: UPSERT prepaid_cards
          if (executeCall === 1) return Promise.resolve({})
          if (executeCall === 2) return Promise.resolve(opts.dupExists ? [{ '?column?': 1 }] : [])
          if (executeCall === 3) return Promise.resolve([{ card_id: opts.upsertCardId ?? 'FY-CARD-TEST' }])
          return Promise.resolve({})
        }),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockImplementation(() => {
            selectCall++
            if (selectCall === 1) {
              // 注意：不要用 ?? 覆盖显式传入的 null，otherwise clientUserId:null 分支失效
              return Promise.resolve([{
                clientUserId: 'clientUserId' in opts ? opts.clientUserId : 'user-1',
                storeId: 'storeId' in opts ? opts.storeId : 'store-1',
              }])
            }
            if (selectCall === 2) {
              return Promise.resolve(opts.productName === null
                ? []
                : [{ productName: opts.productName ?? '预付充值卡 ¥500' }])
            }
            return Promise.resolve([])
          })
          return chain
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((v: any) => {
            captured.insertValues.push(v)
            return Promise.resolve({})
          }),
        }),
      }
      const result = await fn(tx)
      return result
    })
    return captured
  }

  it('订单含充值虚拟 SKU → UPSERT prepaid_cards + INSERT card_transactions', async () => {
    const captured = mockRechargeTx({ productName: '预付充值卡 ¥500' })
    const result = await confirmOfflinePayment('order-recharge-1')
    expect(result.success).toBe(true)
    // 期望事务内 execute 被调用 3 次（到期日 + dup 检查 + UPSERT）
    expect(captured.executes.length).toBe(3)
    // card_transactions INSERT 捕获 amount=500.00, type=充值
    expect(captured.insertValues.length).toBe(1)
    expect(captured.insertValues[0]).toMatchObject({
      type: '充值',
      amount: '500.00',
      refOrderId: 'order-recharge-1',
      cardId: 'FY-CARD-TEST',
    })
  })

  it('订单无充值虚拟 SKU → 不触发 prepaid_cards 写入', async () => {
    const captured = mockRechargeTx({ productName: null })
    const result = await confirmOfflinePayment('order-normal-1')
    expect(result.success).toBe(true)
    // 仅 1 次 execute（到期日），无 UPSERT / dup 检查
    expect(captured.executes.length).toBe(1)
    expect(captured.insertValues.length).toBe(0)
  })

  it('历史订单 client_user_id=null（新规前 manualPhone 遗留） → 充值入账跳过', async () => {
    const captured = mockRechargeTx({ clientUserId: null, productName: '预付充值卡 ¥500' })
    const result = await confirmOfflinePayment('order-legacy-null-client')
    expect(result.success).toBe(true)
    expect(captured.executes.length).toBe(1)
    expect(captured.insertValues.length).toBe(0)
  })

  it('充值入账幂等：card_transactions.ref_order_id 已存在 → 跳过 UPSERT/INSERT', async () => {
    const captured = mockRechargeTx({ productName: '预付充值卡 ¥500', dupExists: true })
    const result = await confirmOfflinePayment('order-recharge-dup')
    expect(result.success).toBe(true)
    // 期望 execute 被调用 2 次（到期日 + dup 检查），无 UPSERT
    expect(captured.executes.length).toBe(2)
    expect(captured.insertValues.length).toBe(0)
  })

  it('product_name 无法解析面值 → 抛错回滚', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let selectCall = 0
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockImplementation(() => {
            selectCall++
            if (selectCall === 1) return Promise.resolve([{ clientUserId: 'user-1', storeId: 'store-1' }])
            return Promise.resolve([{ productName: '坏数据：没有面值标识' }])
          })
          return chain
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(tx)
    })
    const result = await confirmOfflinePayment('order-bad')
    expect(result.success).toBe(false)
    expect(result.message).toBe('确认收款失败，请稍后重试')
  })
})

describe('P0-15-01 修复：admin 两触发点必须调用 settlePointsSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore([{ customerName: '顾客甲', totalAmount: '300.00' }])
  })

  it('confirmOfflinePayment 成功路径 → settlePointsSafe 以 admin.confirmOffline 调用', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockResolvedValue({}),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockResolvedValue([])
          return chain
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(tx)
    })

    const result = await confirmOfflinePayment('FY-XSD-WX-2604240001')
    expect(result.success).toBe(true)
    expect(settlePointsSafe).toHaveBeenCalledTimes(1)
    const [, saleOrderId, source] = (settlePointsSafe as any).mock.calls[0]
    expect(saleOrderId).toBe('FY-XSD-WX-2604240001')
    expect(source).toBe('admin.confirmOffline')
  })

  it('recordPayment 成功路径 → settlePointsSafe 以 admin.recordPayment 调用', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let executeCall = 0
      const tx = {
        execute: vi.fn().mockImplementation(() => {
          executeCall++
          // 1: SELECT FOR UPDATE，2: 生成回款单号
          if (executeCall === 1) {
            return Promise.resolve([
              {
                client_user_id: 'user-001',
                status: '待支付',
                total_amount: '300.00',
                received: '0',
                prepaid_card_amount: '0',
                payable_amount: '300.00',
              },
            ])
          }
          if (executeCall === 2) return Promise.resolve([{ id: 'FY-HKD-WX-2604240001' }])
          // 后续 SUM + UPDATE
          if (executeCall === 3) {
            return Promise.resolve([
              { new_received: '300', new_prepaid: '0', new_refunded: '0' },
            ])
          }
          return Promise.resolve({ rowCount: 1 })
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      return fn(tx)
    })

    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-2604240001',
      repayAmount: 300,
      paymentMethod: '线下',
      externalTxnId: 'BANK-TEST-001',
    })
    expect(result.success).toBe(true)
    expect(settlePointsSafe).toHaveBeenCalledTimes(1)
    const [, saleOrderId, source] = (settlePointsSafe as any).mock.calls[0]
    expect(saleOrderId).toBe('FY-XSD-WX-2604240001')
    expect(source).toBe('admin.recordPayment')
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
      // 2026-04 closeOrder: tx.update 调用两次（saleOrders 关单 + userCoupons 归还核销券），
      // tx.execute 调用一次（作废 sale_allocations）
      expect(tx.update).toHaveBeenCalledTimes(2)
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
      prepaidCardAmount: '0',
      received: '1999.00',
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

  // ── 储值卡抵扣字段（ticket §3.4 A1/A3）──────────────────────────────
  it('返回字段包含 prepaidCardAmount + received（默认 0 的订单）', async () => {
    mockPaginatedChain(1, [mockOrderRow])

    const result = await getOrdersPaginated()

    expect(result.data[0].prepaidCardAmount).toBe('0')
    expect(result.data[0].received).toBe('1999.00')
  })

  it('部分抵扣订单字段透传：prepaid=100 + paid=200', async () => {
    const rowWithDeduction = {
      ...mockOrderRow,
      order: {
        ...mockOrderRow.order,
        totalAmount: '300.00',
        prepaidCardAmount: '100.00',
        received: '200.00',
        paymentMethod: '微信',
      },
    }
    mockPaginatedChain(1, [rowWithDeduction])

    const result = await getOrdersPaginated()

    expect(result.data[0].prepaidCardAmount).toBe('100.00')
    expect(result.data[0].received).toBe('200.00')
  })

  it('全额抵扣订单：paymentMethod=无 透传', async () => {
    const rowFullDeduction = {
      ...mockOrderRow,
      order: {
        ...mockOrderRow.order,
        totalAmount: '300.00',
        prepaidCardAmount: '300.00',
        received: '0',
        paymentMethod: '无',
      },
    }
    mockPaginatedChain(1, [rowFullDeduction])

    const result = await getOrdersPaginated()

    expect(result.data[0].paymentMethod).toBe('无')
    expect(result.data[0].received).toBe('0')
    expect(result.data[0].prepaidCardAmount).toBe('300.00')
  })

  it('hasPrepaidDeduction=true → gt(prepaid_card_amount, 0) 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ hasPrepaidDeduction: true })

    expect(gt).toHaveBeenCalledWith('prepaid_card_amount', '0')
  })

  it('hasPrepaidDeduction=false → gt 不为 prepaid_card_amount 调用', async () => {
    mockPaginatedChain(0, [])
    ;(gt as any).mockClear()

    await getOrdersPaginated({ hasPrepaidDeduction: false })

    const prepaidGtCalls = (gt as any).mock.calls.filter(
      (c: any[]) => c[0] === 'prepaid_card_amount',
    )
    expect(prepaidGtCalls).toHaveLength(0)
  })

  it('paymentMethod=无 筛选 → eq(payment_method, 无) 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ paymentMethod: '无' })

    expect(eq).toHaveBeenCalledWith('payment_method', '无')
  })

  it('paymentMethod=微信 筛选 → eq(payment_method, 微信)', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ paymentMethod: '微信' })

    expect(eq).toHaveBeenCalledWith('payment_method', '微信')
  })

  it('paymentMethod 为非法值（`储值卡`）→ 不触发 payment_method 上的 eq', async () => {
    mockPaginatedChain(0, [])
    ;(eq as any).mockClear()

    await getOrdersPaginated({ paymentMethod: '储值卡' })

    const pmCalls = (eq as any).mock.calls.filter(
      (c: any[]) => c[0] === 'payment_method',
    )
    expect(pmCalls).toHaveLength(0)
  })
})

// ── getOrderById（详情页）新字段 A1 ─────────────────────────────────
describe('getOrderById — prepaidCardAmount + received', () => {
  /**
   * 详情查询链：
   *   call#1 = select(order)：.from.leftJoin.leftJoin.where.limit
   *   call#2 = select(items)：.from.leftJoin.where
   */
  function mockDetailChain(orderRow: any, itemRows: any[]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => {
      i++
      if (i === 1) {
        const limit = vi.fn().mockResolvedValue(orderRow ? [orderRow] : [])
        const where = vi.fn().mockReturnValue({ limit })
        const leftJoin2 = vi.fn().mockReturnValue({ where })
        const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
        const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
        return { from }
      }
      // items
      const where = vi.fn().mockResolvedValue(itemRows)
      const leftJoin = vi.fn().mockReturnValue({ where })
      const from = vi.fn().mockReturnValue({ leftJoin })
      return { from }
    })
  }

  const detailOrderBase = {
    order: {
      saleOrderId: 'FY-XSD-WX-260423-0001',
      status: '已支付',
      saleOrderType: '销售单',
      documentType: '售前',
      refSaleOrderId: null,
      marketName: '南昌市场',
      storeId: 'store-1',
      saleOrderDatetime: new Date('2026-04-23T10:00:00Z'),
      clientUserId: 'user-1',
      clientPhone: '13812345678',
      customerName: '李女士',
      totalAmount: '300.00',
      prepaidCardAmount: '100.00',
      received: '200.00',
      paymentMethod: '微信',
      openedBy: 'EMP-001',
      preferredEmployeeId: null,
      paidAt: new Date('2026-04-23T10:05:00Z'),
      allocationStatus: '待分配',
      couponId: null,
      couponDiscount: '0',
      remark: null,
      createdAt: new Date('2026-04-23T10:00:00Z'),
      updatedAt: new Date('2026-04-23T10:05:00Z'),
    },
    storeName: '南昌旗舰店',
    openedByName: '张三',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('订单存在 → 返回含 prepaidCardAmount + received', async () => {
    const { getOrderById } = await import('./orders')
    mockDetailChain(detailOrderBase, [])

    const result = await getOrderById('FY-XSD-WX-260423-0001')

    expect(result).not.toBeNull()
    expect(result!.prepaidCardAmount).toBe('100.00')
    expect(result!.received).toBe('200.00')
    expect(result!.totalAmount).toBe('300.00')
    // 不变量：prepaid + paid = total
    expect(Number(result!.prepaidCardAmount) + Number(result!.received)).toBe(300)
  })

  it('全额抵扣订单 → paymentMethod=无 + received=0', async () => {
    const full = {
      ...detailOrderBase,
      order: {
        ...detailOrderBase.order,
        prepaidCardAmount: '300.00',
        received: '0',
        paymentMethod: '无',
      },
    }
    const { getOrderById } = await import('./orders')
    mockDetailChain(full, [])

    const result = await getOrderById('FY-XSD-WX-260423-0002')

    expect(result!.paymentMethod).toBe('无')
    expect(result!.received).toBe('0')
    expect(result!.prepaidCardAmount).toBe('300.00')
  })

  it('无抵扣订单 → prepaidCardAmount 默认 0', async () => {
    const noDeduction = {
      ...detailOrderBase,
      order: {
        ...detailOrderBase.order,
        prepaidCardAmount: '0',
        received: '300.00',
        paymentMethod: '线下',
      },
    }
    const { getOrderById } = await import('./orders')
    mockDetailChain(noDeduction, [])

    const result = await getOrderById('FY-XSD-WX-260423-0003')

    expect(result!.prepaidCardAmount).toBe('0')
    expect(result!.received).toBe('300.00')
    expect(result!.paymentMethod).toBe('线下')
  })

  it('订单不存在 → 返回 null', async () => {
    const { getOrderById } = await import('./orders')
    mockDetailChain(null, [])

    const result = await getOrderById('FY-NONEXISTENT')

    expect(result).toBeNull()
  })

  it('历史订单缺失字段（旧数据）→ 默认为 "0"', async () => {
    const legacy = {
      ...detailOrderBase,
      order: {
        ...detailOrderBase.order,
        prepaidCardAmount: null,
        received: null,
      },
    }
    const { getOrderById } = await import('./orders')
    mockDetailChain(legacy, [])

    const result = await getOrderById('FY-LEGACY-1')

    expect(result!.prepaidCardAmount).toBe('0')
    expect(result!.received).toBe('0')
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

describe('createOrder — 充值卡订单（与 client 虚拟 SKU 对齐）', () => {
  const RECHARGE_SKU = 'sku-recharge-virtual'

  /** 500 元档档位实付 = 500 × 0.99 = 495.00 */
  // 2026-04-26 ticket: isRechargeCard:true 标识充值卡 SKU（capability 列权威源）
  const validRechargeItem = {
    skuId: RECHARGE_SKU,
    productName: '预付充值卡 ¥500',
    skuSpecName: '预付充值卡（虚拟）',
    productType: '家居产品' as const,
    sessionCount: null,
    unitPrice: '495.00',
    unitRealPrice: '495.00',
    quantity: 1,
    salesCategory: null,
    isRechargeCard: true,
  }

  const baseRechargeData = {
    ...baseOrderData,
    clientUserId: 'user-1',
    clientPhone: '13800000000',
    items: [validRechargeItem],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('合法 500 档充值卡订单 → 成功，sale_items 字段强制覆盖', async () => {
    let capturedItem: any
    let capturedOrder: any
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260416-RC01' }]),
        insert: vi.fn().mockImplementation((_table: any) => ({
          values: vi.fn().mockImplementation((v: any) => {
            if ('saleItemId' in v) capturedItem = v
            else if ('saleOrderId' in v && 'saleOrderType' in v) capturedOrder = v
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
      }
      return fn(tx)
    })

    const result = await createOrder(baseRechargeData)

    expect(result.success).toBe(true)
    expect(capturedOrder.saleOrderType).toBe('销售单')
    expect(capturedOrder.totalAmount).toBe('495.00')
    // 字段强制覆盖：与 client card.js 保持一致
    expect(capturedItem.skuId).toBe(RECHARGE_SKU)
    expect(capturedItem.productName).toBe('预付充值卡 ¥500')
    expect(capturedItem.skuSpecName).toBe('预付充值卡（虚拟）')
    expect(capturedItem.productType).toBe('家居产品')
    expect(capturedItem.sessionCount).toBe(null)
    expect(capturedItem.remainingSessions).toBe(null)
    expect(capturedItem.quantity).toBe(1)
    expect(capturedItem.unitRealPrice).toBe('495.00')
    expect(capturedItem.saleAmount).toBe('495.00')
    expect(capturedItem.received).toBe('495.00')
    expect(capturedItem.serviceFee).toBe('0.00')
  })

  it('充值卡 + 其他商品混单 → 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      items: [
        validRechargeItem,
        {
          skuId: 'sku-normal-001',
          productName: '面部护理',
          skuSpecName: '单次',
          productType: '单品' as const,
          sessionCount: null,
          unitPrice: '200.00',
          unitRealPrice: '200.00',
          quantity: 1,
          salesCategory: null,
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('不允许与其他商品混单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡 + 内部单 → 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      saleOrderType: '内部单',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('仅支持销售单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡 + 优惠券 → 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      couponId: 'coupon-1',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('不支持叠加优惠券')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡无 clientUserId → 拒绝（走入口顾客未注册守卫）', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      clientUserId: '',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('顾客未注册')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡面值与 unitRealPrice 不匹配（篡改防护）→ 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      items: [{
        ...validRechargeItem,
        unitRealPrice: '100.00', // 500 档应为 495，篡改为 100
      }],
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('实付金额与档位不匹配')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡面值低于最低档位（499） → 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      items: [{
        ...validRechargeItem,
        productName: '预付充值卡 ¥499',
        unitRealPrice: '499.00',
      }],
    })
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/最低充值金额|不符合档位/)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('充值卡 quantity !== 1 → 拒绝', async () => {
    const result = await createOrder({
      ...baseRechargeData,
      items: [{
        ...validRechargeItem,
        quantity: 2,
      }],
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('每单仅限 1 笔')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('合法 1000 档充值卡（9.8 折） → 成功，总额 980', async () => {
    let capturedOrder: any
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260416-RC02' }]),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            if ('saleOrderId' in v && 'saleOrderType' in v) capturedOrder = v
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
      ...baseRechargeData,
      items: [{
        ...validRechargeItem,
        productName: '预付充值卡 ¥1000',
        unitPrice: '980.00',
        unitRealPrice: '980.00',
      }],
    })
    expect(result.success).toBe(true)
    expect(capturedOrder.totalAmount).toBe('980.00')
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
        unit_real_price: '200.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '1000.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
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
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
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
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
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
            product_name: 'xx', sku_spec_name: 'yy', sales_category: '自销自耗',
          }]
          return [{ id: 'FY-XSD-WX-260416-0001' }]
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{
                skuId: 'sku-new-1', price: '500', serviceFee: '0', sessionCount: 10,
                productType: '疗程卡', salesCategory: '自销自耗',
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

// ─── PR-3 §3.5 — receivedAmount + 款项流水不变量测试 ─────────────────
// ticket: 2026-04-24-order-partial-payment-foundation.md
//
// 覆盖：
//   1. 全额现场 → 订单 '已支付'（线下走 '待确认收款'） + 1 行首次支付 payments
//   2. 部分收款 → 订单 '部分支付' + 1 行首次支付 payments
//   3. 纯挂账（receivedAmount=0） → 订单 '待支付' + 无 payments 行
//   4. receivedAmount > payable_amount → 业务校验错
//   5. paymentMethod=微信 + receivedAmount>0 → MIXED_PAYMENT_NOT_SUPPORTED
//   6. 储值卡抵扣 + 部分现场 → 订单 '部分支付' + 2 行 payments（首次支付 + 储值卡抵扣）
//   7. 双写不变量：paid_amount = Σ(已支付 + 首次支付/回款/退款) amount

describe('createOrder — PR-3 部分支付基础（receivedAmount + 款项流水）', () => {
  /** 捕获本轮事务内的 saleOrders insert + saleOrderPayments insert 清单 */
  interface CaptureBag {
    order: any
    items: any[]
    payments: any[]
  }

  /** 构造捕获所有 insert 的 tx mock；txResult 为 orderId */
  function mockCreateTx(orderId: string, bag: CaptureBag) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: orderId }]),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            // 区分 3 类插入：saleOrders / saleItems / saleOrderPayments
            if ('saleOrderId' in v && 'saleOrderType' in v) {
              bag.order = v
            } else if ('saleItemId' in v) {
              bag.items.push(v)
            } else if ('saleOrderId' in v && 'changeType' in v) {
              bag.payments.push(v)
            }
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }
      return fn(tx)
    })
  }

  function freshBag(): CaptureBag {
    return { order: null, items: [], payments: [] }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('1) 全额现场（线下）→ 订单 "待确认收款" + 1 行首次支付 payments', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P001', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      // 未传 receivedAmount → 视为全额 = payable_amount = totalAmount
    })

    expect(result.success).toBe(true)
    // 线下全额：status='待确认收款'，paid_amount=受款金额（200），写 1 行首次支付
    expect(bag.order.status).toBe('待确认收款')
    expect(bag.order.payableAmount).toBe('200.00')
    expect(bag.order.received).toBe('200.00')
    expect(bag.payments).toHaveLength(1)
    expect(bag.payments[0]).toMatchObject({
      changeType: '首次支付',
      amount: '200.00',
      paymentMethod: '线下',
      status: '已支付',
      sourceEnd: 'admin',
    })
  })

  it('2) 部分收款 → 订单 "部分支付" + 1 行首次支付 payments', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P002', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      receivedAmount: 80, // < 200 应付
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('部分支付')
    expect(bag.order.payableAmount).toBe('200.00')
    expect(bag.order.received).toBe('80.00')
    expect(bag.payments).toHaveLength(1)
    expect(bag.payments[0]).toMatchObject({
      changeType: '首次支付',
      amount: '80.00',
      paymentMethod: '线下',
      status: '已支付',
      sourceEnd: 'admin',
    })
  })

  it('3) 纯挂账（receivedAmount=0） → 订单 "待支付"，无 payments 行', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P003', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      receivedAmount: 0,
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.received).toBe('0.00')
    expect(bag.payments).toHaveLength(0)
  })

  it('4) receivedAmount > payable_amount → 业务校验错', async () => {
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      receivedAmount: 300, // payable = 200
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不能超过应付实金')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('5) paymentMethod=微信 + receivedAmount>0 → 不支持混合支付', async () => {
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '微信',
      receivedAmount: 100,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('系统管理员开单不支持线上支付')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('6) 储值卡抵扣 + 部分现场 → 订单 "部分支付"，create 仅 1 行首次支付（储值卡抵扣 payments 行 + 扣卡归 confirmOffline）', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P006', bag)

    // total=200；prepaidCard=60 → payable=140；received=50 → 部分
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      prepaidCardAmount: 60,
      receivedAmount: 50,
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('部分支付')
    expect(bag.order.prepaidCardAmount).toBe('60.00')
    expect(bag.order.payableAmount).toBe('140.00')
    expect(bag.order.received).toBe('50.00')
    expect(bag.payments).toHaveLength(1)
    // 仅 1 行：首次支付（线下/50）—— 储值卡抵扣 payments 行由 confirmOffline 同事务扣卡时写入
    const firstPay = bag.payments.find((p) => p.changeType === '首次支付')
    expect(firstPay).toMatchObject({
      changeType: '首次支付',
      amount: '50.00',
      paymentMethod: '线下',
      status: '已支付',
      sourceEnd: 'admin',
    })
    const cardPay = bag.payments.find((p) => p.changeType === '储值卡抵扣')
    expect(cardPay).toBeUndefined()
  })

  it('7) 双写不变量（create 阶段）：paid_amount = Σ(已支付 + 首次支付/回款/退款).amount', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P007', bag)

    // 场景：total=200 + prepaidCard=60 → payable=140；received=120 → 部分支付
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      prepaidCardAmount: 60,
      receivedAmount: 120,
    })

    expect(result.success).toBe(true)
    // 计算不变量左侧：sale_orders.paid_amount
    const received = Number(bag.order.received)
    // 计算不变量右侧：Σ(payments WHERE status='已支付' AND change_type IN ('首次支付','回款','退款'))
    const paymentsSum = bag.payments
      .filter(
        (p) =>
          p.status === '已支付' &&
          ['首次支付', '回款', '退款'].includes(p.changeType),
      )
      .reduce((s, p) => s + Number(p.amount), 0)
    expect(received).toBe(paymentsSum)
    expect(received).toBe(120)

    // create 阶段 sale_orders.prepaid_card_amount 是"预选"冗余；payments 储值卡抵扣行 + 扣卡由 confirmOffline 完成
    const prepaidSnapshot = Number(bag.order.prepaidCardAmount)
    const cardSum = bag.payments
      .filter((p) => p.status === '已支付' && p.changeType === '储值卡抵扣')
      .reduce((s, p) => s + Number(p.amount), 0)
    expect(prepaidSnapshot).toBe(60) // 预选金额已写入 sale_orders 列
    expect(cardSum).toBe(0) // 但 payments 尚未产生储值卡抵扣行
  })

  it('8) 线上支付（微信）+ receivedAmount 未传 → 订单 "待支付"，无 payments 行（admin 不走线上，保留既有语义）', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P008', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '微信',
      // 不传 receivedAmount
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.received).toBe('0.00')
    expect(bag.payments).toHaveLength(0)
  })
})

// ─── recordPayment（ticket 2026-04-24 多次回款 PR-B） ───
//
// 测试事务内各步骤的副作用，基于 sql 模板字符串的参数位置判定当前调用的语义：
//   1) SELECT ... FOR UPDATE 锁原单
//   2) advisory lock + 订单号生成
//   3) （可选）SELECT prepaid_cards FOR UPDATE
//   4) （可选）UPDATE prepaid_cards
//   5) （可选）INSERT card_transactions（tx.insert）
//   6) INSERT sale_orders（凭证单，tx.insert）
//   7) INSERT sale_order_payments（可能 1~2 条，tx.insert）
//   8) SELECT SUM(payments)
//   9) UPDATE sale_orders（重算 paid_amount/status）
describe('recordPayment — 管理后台录入回款', () => {
  /**
   * 构造事务 mock：
   * - executes 数组按调用顺序返回；lookupOrder 提供锁定的原单行
   * - insertValues 收集所有 tx.insert().values(...) 的入参
   * - 支持 updOk 控制最后 UPDATE sale_orders 的 rowCount
   */
  function mockRecordTx(opts: {
    lockedOrder?: Record<string, any>
    orderIdGen?: string
    cardBalance?: { cardId: string; balance: number } | null
    sumRow?: { new_received: string; new_prepaid: string }
    updateRowCount?: number
    throwOnStep?: string
  } = {}) {
    const captured = { insertValues: [] as Array<{ table: string; v: any }>, executed: [] as string[] }
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let execCall = 0
      const tx = {
        execute: vi.fn().mockImplementation((arg: any) => {
          execCall++
          // 记录顺序（便于调试失败用例）
          captured.executed.push(`exec-${execCall}`)
          // step 1: SELECT FOR UPDATE 原单
          if (execCall === 1) {
            return Promise.resolve(opts.lockedOrder ? [opts.lockedOrder] : [])
          }
          // step 2: advisory lock + 生成订单号
          if (execCall === 2) {
            return Promise.resolve([{ id: opts.orderIdGen ?? 'FY-HKD-WX-2604250001' }])
          }
          // 需要储值卡？step 3: SELECT balance FOR UPDATE；step 4: UPDATE balance
          if (opts.cardBalance !== undefined) {
            if (execCall === 3) {
              return Promise.resolve(
                opts.cardBalance
                  ? [{ card_id: opts.cardBalance.cardId, balance: opts.cardBalance.balance.toFixed(2) }]
                  : [],
              )
            }
            if (execCall === 4) {
              return Promise.resolve({})
            }
          }
          // 后面的 SELECT SUM(payments) + UPDATE sale_orders
          // 需要根据 cardBalance 存在与否确定 step 编号
          const stepOffset = opts.cardBalance !== undefined ? 2 : 0
          if (execCall === 3 + stepOffset) {
            return Promise.resolve([
              {
                new_received: opts.sumRow?.new_received ?? '0',
                new_prepaid: opts.sumRow?.new_prepaid ?? '0',
              },
            ])
          }
          if (execCall === 4 + stepOffset) {
            return Promise.resolve({ rowCount: opts.updateRowCount ?? 1 })
          }
          return Promise.resolve({})
        }),
        insert: vi.fn().mockImplementation((table: any) => ({
          values: vi.fn().mockImplementation((v: any) => {
            captured.insertValues.push({ table: String(table?.constructor?.name || 'unknown'), v })
            return Promise.resolve({})
          }),
        })),
      }
      return fn(tx)
    })
    return captured
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: {
        ...mockSession.permissions,
        actions: ['sale_order:record_payment'],
      },
    })
    mockSelectBefore([]) // logOperation orgNode 查询
  })

  const basePayload = {
    saleOrderId: 'FY-XSD-WX-260420-0001',
    repayAmount: 100,
    paymentMethod: '线下' as const,
    externalTxnId: 'BANK-RECEIPT-001',
    prepaidCardAmount: 0,
    note: '银行转账补款',
  }

  const lockedPartialOrder = {
    sale_order_id: 'FY-XSD-WX-260420-0001',
    status: '部分支付',
    total_amount: '200.00',
    prepaid_card_amount: '0.00',
    payable_amount: '200.00',
    received: '100.00',
    client_user_id: 'user-1',
    client_phone: '13800000000',
    customer_name: '顾客甲',
    store_id: 'store-1',
    market_name: '南昌市场',
    document_type: '售前',
    paid_at: null,
  }

  it('成功路径：部分支付 100 → 回款 100 线下 → 付清 → 原单 "已支付"', async () => {
    const captured = mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      sumRow: { new_received: '200', new_prepaid: '0' },
    })

    const result = await recordPayment(basePayload)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repaymentOrderId).toBe('FY-HKD-WX-2604250001')
      expect(result.data.refStatus).toBe('已支付')
      expect(result.data.refPaidAmount).toBe('200.00')
    }
    // 1 条 payments 行（无凭证单 sale_orders 插入）
    expect(captured.insertValues.length).toBe(1)
    // payments 行：change_type='回款' amount='100.00' source_end='admin'
    const paymentInsert = captured.insertValues[0].v
    expect(paymentInsert).toMatchObject({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      changeType: '回款',
      amount: '100.00',
      paymentMethod: '线下',
      externalTxnId: 'BANK-RECEIPT-001',
      status: '已支付',
      sourceEnd: 'admin',
      operatorEmployeeId: 'EMP-001',
    })
  })

  it('多次回款累加：100 已付 + 50 回款 → "部分支付"；后续再回 50 → "已支付"', async () => {
    // 第一次：50 回款 → payments SUM = 150，仍部分支付
    const captured1 = mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      sumRow: { new_received: '150', new_prepaid: '0' },
    })
    const r1 = await recordPayment({ ...basePayload, repayAmount: 50 })
    expect(r1.success).toBe(true)
    if (r1.success) {
      expect(r1.data.refStatus).toBe('部分支付')
      expect(r1.data.refPaidAmount).toBe('150.00')
    }
    expect(captured1.insertValues.length).toBe(1)

    // 第二次：再回 50 → payments SUM = 200 → '已支付'
    const captured2 = mockRecordTx({
      lockedOrder: { ...lockedPartialOrder, received: '150.00' },
      orderIdGen: 'FY-HKD-WX-2604250002',
      sumRow: { new_received: '200', new_prepaid: '0' },
    })
    const r2 = await recordPayment({ ...basePayload, repayAmount: 50 })
    expect(r2.success).toBe(true)
    if (r2.success) {
      expect(r2.data.refStatus).toBe('已支付')
      expect(r2.data.refPaidAmount).toBe('200.00')
    }
    expect(captured2.insertValues.length).toBe(1)
  })

  it('超额拦截：剩余欠款 100，尝试回款 150 → OVERPAY 错误，事务内抛错', async () => {
    mockRecordTx({
      lockedOrder: lockedPartialOrder, // payable=200 - paid=100 → 剩余 100
      orderIdGen: 'FY-HKD-WX-2604250001',
    })

    const result = await recordPayment({ ...basePayload, repayAmount: 150 })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('OVERPAY')
      expect(result.error.message).toContain('超过订单欠款')
    }
  })

  it('已关闭订单拒绝：status="已关闭" → INVALID_STATE', async () => {
    mockRecordTx({
      lockedOrder: { ...lockedPartialOrder, status: '已关闭' },
      orderIdGen: 'FY-HKD-WX-2604250001',
    })

    const result = await recordPayment(basePayload)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE')
      expect(result.error.message).toContain('已关闭')
    }
  })

  it('原订单不存在 → REF_ORDER_NOT_FOUND', async () => {
    mockRecordTx({ lockedOrder: undefined }) // SELECT FOR UPDATE 返回空

    const result = await recordPayment(basePayload)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('REF_ORDER_NOT_FOUND')
    }
  })

  it('储值卡回款：prepaidCardAmount=100 + repayAmount=0 → 扣卡 + 1 条 "储值卡抵扣" payments 行', async () => {
    const captured = mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      cardBalance: { cardId: 'FY-CARD-USER-1', balance: 500 },
      sumRow: { new_received: '100', new_prepaid: '100' }, // paid=100 + prepaid=100 = total 200 → 已支付
    })

    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 0,
      paymentMethod: '储值卡',
      prepaidCardAmount: 100,
      note: '顾客自愿储值卡付清',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.refStatus).toBe('已支付')
    }
    // 2 次 insert：card_transactions + sale_order_payments（无凭证单 sale_orders 插入）
    expect(captured.insertValues.length).toBe(2)
    const cardTxn = captured.insertValues[0].v
    expect(cardTxn).toMatchObject({
      cardId: 'FY-CARD-USER-1',
      type: '扣款',
      amount: '-100.00',
      refOrderId: 'FY-HKD-WX-2604250001', // 指向回款凭证单
    })
    const paymentInsert = captured.insertValues[1].v
    expect(paymentInsert).toMatchObject({
      changeType: '储值卡抵扣',
      amount: '100.00',
      paymentMethod: '储值卡',
      externalTxnId: null,
      sourceEnd: 'admin',
    })
  })

  it('储值卡余额不足 → INSUFFICIENT_BALANCE', async () => {
    mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      cardBalance: { cardId: 'FY-CARD-USER-1', balance: 50 }, // 余额 50 但要扣 100
    })

    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 0,
      paymentMethod: '储值卡',
      prepaidCardAmount: 100,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INSUFFICIENT_BALANCE')
    }
  })

  it('权限校验失败：requirePermission 抛 PERMISSION_DENIED → action 抛出', async () => {
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      permissions: { actions: [], scopeStoreIds: ['store-1'] },
    })
    // requirePermission 模块被全局 mock 了（L124-128），此用例下让它实际抛错以模拟真实行为
    ;(requirePermission as any).mockImplementationOnce(() => {
      throw new Error('PERMISSION_DENIED: 无权执行 sale_order:record_payment')
    })

    await expect(recordPayment(basePayload)).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('入参校验：repayAmount + prepaidCardAmount = 0 → INVALID_PARAMS', async () => {
    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 0,
      paymentMethod: '线下',
      prepaidCardAmount: 0,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_PARAMS')
      expect(result.error.message).toContain('不能都为 0')
    }
  })

  it('入参校验：线下回款 + repayAmount>0 但未填 externalTxnId → INVALID_PARAMS', async () => {
    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 100,
      paymentMethod: '线下',
      // externalTxnId 缺失
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_PARAMS')
      expect(result.error.message).toContain('外部交易号')
    }
  })

  it('入参校验：储值卡 + repayAmount>0 → INVALID_PARAMS（语义冲突）', async () => {
    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 50,
      paymentMethod: '储值卡',
      prepaidCardAmount: 50,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_PARAMS')
      expect(result.error.message).toContain('储值卡付款方式')
    }
  })

  it('并发竞态：UPDATE sale_orders rowCount=0 → CONCURRENT_CHANGED', async () => {
    mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      sumRow: { new_received: '200', new_prepaid: '0' },
      updateRowCount: 0,
    })

    const result = await recordPayment(basePayload)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('CONCURRENT_CHANGED')
    }
  })
})

/**
 * 浮点 round 兜底测试（admin createOrder）
 *
 * 见 notes/tickets/2026-05-17-client-order-no-coupon-rounding.md §5.2
 *
 * 与 client/staff 三端对齐：rawTotal 行级 + 累加后 round；totalAmount 减券后 round。
 *
 * 注：admin L1173 `totalAmount.toFixed(2)` 已掩盖内存浮点漂移至 DB 字符串层，
 * L1042 `settledAmount + 0.005 < totalAmount` 的 0.005 容差也兜住状态判定边界。
 * 本测试为**回归守护**（DB 字符串永远 ≤ 2 位）+ **三端一致性守护**，
 * 不是 TDD（修复前后均 pass）。若未来移除 .toFixed(2) 或收紧 0.005 容差，
 * 这些测试将成为 load-bearing 防漂移网。
 *
 * Node 实测漂移：
 *   0.1 * 3 = 0.30000000000000004
 *   1.1 * 3 = 3.3000000000000003
 *   0.29 * 100 = 28.999999999999996
 */
describe('createOrder — 浮点 round 兜底（R2 真漂移 case）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  function captureOrderTx() {
    const captured: { order?: any } = {}
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260517-FL01' }]),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            if ('saleOrderId' in v && 'saleOrderType' in v) captured.order = v
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
      }
      return fn(tx)
    })
    return captured
  }

  // 断言：value 必须是 number 且小数位 ≤ 2（浮点漂移会让 (v*100) % 1 !== 0）
  function expectAt2Decimals(value: number) {
    expect(typeof value).toBe('number')
    expect(Number.isFinite(value)).toBe(true)
    expect((value * 100) % 1).toBe(0)
  }

  // 断言：DB 字符串值（toFixed(2) 串）必须精确 2 位，不含 3+ 位漂移
  function expectStringAt2Decimals(value: string) {
    expect(typeof value).toBe('string')
    // 必须正好 2 位小数；浮点 toFixed(2) 表面上掩盖漂移，但若内存层泄漏 3+ 位会 fail
    expect(value).toMatch(/^-?\d+\.\d{2}$/)
    // 字符串 → 数值 → 二次验证：还原成 number 后小数位仍 ≤ 2（防 toFixed 截断假象）
    expect((Number(value) * 100) % 1).toBe(0)
  }

  it('无券 0.1×3 ─ saleAmount=0.30000000000000004 应聚合为 0.30', async () => {
    const captured = captureOrderTx()

    await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-float-01',
        productName: '浮点驱动商品',
        skuSpecName: '标准',
        productType: '单品' as const,
        sessionCount: null,
        unitPrice: '0.10',
        unitRealPrice: '0.10',
        quantity: 3,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(captured.order).toBeDefined()
    expectStringAt2Decimals(captured.order.totalAmount)
    expect(Number(captured.order.totalAmount)).toBe(0.30)
  })

  it('无券 1.1×3 ─ 漂移 +3e-16 应聚合为 3.30', async () => {
    const captured = captureOrderTx()

    await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-float-02',
        productName: '浮点驱动商品',
        skuSpecName: '标准',
        productType: '单品' as const,
        sessionCount: null,
        unitPrice: '1.10',
        unitRealPrice: '1.10',
        quantity: 3,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(captured.order).toBeDefined()
    expectStringAt2Decimals(captured.order.totalAmount)
    expect(Number(captured.order.totalAmount)).toBe(3.30)
  })

  it('无券 0.29×100 ─ 大 quantity 漂移应聚合为 29.00', async () => {
    const captured = captureOrderTx()

    await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-float-03',
        productName: '浮点驱动商品',
        skuSpecName: '标准',
        productType: '单品' as const,
        sessionCount: null,
        unitPrice: '0.29',
        unitRealPrice: '0.29',
        quantity: 100,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(captured.order).toBeDefined()
    expectStringAt2Decimals(captured.order.totalAmount)
    expect(Number(captured.order.totalAmount)).toBe(29.00)
  })

  it('无券多商品 0.1×3 + 0.2×3 ─ 累加点漂移应聚合为 0.90', async () => {
    const captured = captureOrderTx()

    await createOrder({
      ...baseOrderData,
      items: [
        {
          skuId: 'sku-float-a',
          productName: '浮点 A',
          skuSpecName: '标准',
          productType: '单品' as const,
          sessionCount: null,
          unitPrice: '0.10',
          unitRealPrice: '0.10',
          quantity: 3,
          salesCategory: '自销自耗' as const,
        },
        {
          skuId: 'sku-float-b',
          productName: '浮点 B',
          skuSpecName: '标准',
          productType: '单品' as const,
          sessionCount: null,
          unitPrice: '0.20',
          unitRealPrice: '0.20',
          quantity: 3,
          salesCategory: '自销自耗' as const,
        },
      ],
    })

    expect(captured.order).toBeDefined()
    expectStringAt2Decimals(captured.order.totalAmount)
    expect(Number(captured.order.totalAmount)).toBe(0.90)
  })

  it('有券路径回归：现金券抵扣后 totalAmount 仍 ≤ 2 位', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({
      userId: 'user-1',
      status: '未使用',
      expireAt: new Date(Date.now() + 86400_000),
      isActive: true,
      couponType: '现金券',
      discountValue: '0.50',
      maxDiscount: null,
      minSpend: '0',
    }))
    ;(calcCouponDiscount as any).mockReturnValue(0.50)
    const captured = captureOrderTx()

    await createOrder({
      ...baseOrderData,
      clientUserId: 'user-1',
      couponId: 'coupon-float',
      items: [{
        skuId: 'sku-float-c',
        productName: '浮点驱动商品',
        skuSpecName: '标准',
        productType: '单品' as const,
        sessionCount: null,
        unitPrice: '0.29',
        unitRealPrice: '0.29',
        quantity: 7,
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(captured.order).toBeDefined()
    expectStringAt2Decimals(captured.order.totalAmount)
    // 0.29 * 7 = 2.0299999999999994 → round 2.03，减 0.50 = 1.53
    expectAt2Decimals(Number(captured.order.totalAmount))
  })
})
