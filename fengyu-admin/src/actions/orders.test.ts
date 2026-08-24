import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/employee-assignment-server', () => ({ getInvalidEmployeeAssignmentId: vi.fn().mockResolvedValue(null) }))

// 退款前置检查（orders.ts recordPayment 等调 hasPendingRefund）：
// 默认 false（无退款审批中），让现有用例走正常分支；不 mock 会跑真实实现拿 mock 的 db 误判。
vi.mock('@/lib/refund-cascade', () => ({
  hasPendingRefund: vi.fn().mockResolvedValue(false),
  hasPendingRefundByServiceOrder: vi.fn().mockResolvedValue(false),
}))

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
    marketName: 'market_name',
    storeName: 'store_name',
    saleOrderDatetime: 'sale_order_datetime',
    customerName: 'customer_name',
    clientPhone: 'client_phone',
    clientUserId: 'client_user_id',
    paidAt: 'paid_at',
    auditedAt: 'audited_at',
    auditedBy: 'audited_by',
    paymentMethod: 'payment_method',
    prepaidCardAmount: 'prepaid_card_amount',
    payableAmount: 'payable_amount',
    // 2026-04-26 sale-order-domain-refactor：DB 列名已由 paid_amount 重命名为 received
    received: 'received',
    refundedAmount: 'refunded_amount',
    totalAmount: 'total_amount',
    documentType: 'document_type',
    remark: 'remark',
    isActivity: 'is_activity',
    isExperienceConversion: 'is_experience_conversion',
    // 迁移 0077 双库已迁；admin 导出/列表 select 字段
    isMembershipUpgrade: 'is_membership_upgrade',
    openedBy: 'opened_by',
    offlineConfirmedBy: 'offline_confirmed_by',
    offlineConfirmedAt: 'offline_confirmed_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    allocationStatus: 'allocation_status',
    couponId: 'coupon_id',
    couponDiscount: 'coupon_discount',
    refSaleOrderId: 'ref_sale_order_id',
    preferredEmployeeId: 'preferred_employee_id',
    legacySource: 'legacy_source',
    lakalaOutOrderNo: 'lakala_out_order_no',
    firstPaymentAmount: 'first_payment_amount',
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
    productName: 'product_name',
    productType: 'product_type',
    salesCategory: 'sales_category',
    sessionCount: 'session_count',
    unitPrice: 'unit_price',
    unitRealPrice: 'unit_real_price',
    saleAmount: 'sale_amount',
    received: 'received',
    pendingReceived: 'pending_received',
    skuId: 'sku_id',
    refSaleItemId: 'ref_sale_item_id',
    paidSessions: 'paid_sessions',
    expireDate: 'expire_date',
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
    allocationStatus: 'allocation_status',
    $inferInsert: {} as any,
  },
  salePaymentItemReceipts: {
    id: 'id',
    salePaymentId: 'sale_payment_id',
    saleOrderId: 'sale_order_id',
    saleItemId: 'sale_item_id',
    amount: 'amount',
    salesCategory: 'sales_category',
  },
  salePaymentItemAllocations: {
    id: 'id',
    salePaymentItemReceiptId: 'sale_payment_item_receipt_id',
    employeeId: 'employee_id',
    allocationRatio: 'allocation_ratio',
    roleType: 'role_type',
    departmentName: 'department_name',
    allocatedAmount: 'allocated_amount',
    commissionRate: 'commission_rate',
    commissionAmount: 'commission_amount',
    isVoid: 'is_void',
    voidedAt: 'voided_at',
  },
}))

vi.mock('@db/coupon', () => ({
  userCoupons: {
    couponId: 'coupon_id',
    templateId: 'template_id',
    userId: 'user_id',
    status: 'status',
    expireAt: 'expire_at',
    faceValueOverride: 'face_value_override',
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
    applicableStoreIds: 'applicable_store_ids',
    applicableCategoryIds: 'applicable_category_ids',
    applicableProductIds: 'applicable_product_ids',
    applicableMarketIds: 'applicable_market_ids',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', name: 'name', type: 'type', parentId: 'parent_id' },
}))

vi.mock('@db/user', () => ({
  staffWechatUsers: { employeeId: 'employee_id', name: 'name' },
  // 2026-07-08 修复 T1：orders.ts getOrders/getOrdersPaginated/getOrderById 读取 list 端点
  // 全部 left join clientWechatUsers.name / phone 做兜底，createOrder 也在事务内反查 name/phone 作为权威。
  clientWechatUsers: {
    userId: 'user_id', customerType: 'customer_type', name: 'name', phone: 'phone',
    boundStoreId: 'bound_store_id', isCrossStoreTemp: 'is_cross_store_temp',
  },
}))

vi.mock('@db/system-config', () => ({
  systemConfigs: { key: 'key', value: 'value' },
}))

vi.mock('@db/product', () => ({
  productSkus: { skuId: 'sku_id', specName: 'spec_name', productId: 'product_id', categoryId: 'category_id', price: 'price', specialPrice: 'special_price', serviceFee: 'service_fee', sessionCount: 'session_count', unit: 'unit', purchaseLimit: 'purchase_limit', productType: 'product_type', isExperience: 'is_experience', isManagerSpecial: 'is_manager_special', isShengmei: 'is_shengmei', marketScope: 'market_scope', isEnabled: 'is_enabled', deletedAt: 'deleted_at' },
  products: {
    productId: 'product_id', name: 'name', isBundle: 'is_bundle',
    deletedAt: 'deleted_at', marketScope: 'market_scope',
  },
  productCategories: { categoryId: 'category_id', productKind: 'product_kind', categoryName: 'category_name', salesCategory: 'sales_category' },
  // 2026-04-27 dfa4847: orders.ts createOrder 优惠券范围校验需查 mall_product_skus → product 的映射
  mallBundleGroups: { id: 'id', productId: 'product_id', groupName: 'group_name', pickCount: 'pick_count' },
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
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  gt: vi.fn((a, b) => ({ type: 'gt', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, arr) => ({ type: 'inArray', col, arr })),
  isNull: vi.fn((a) => ({ type: 'isNull', a })),
  // ticket 2026-05-19：sql 模板调用保留 strings.raw 副本，
  // 便于 mockTxByKeyword 按 SQL 文本关键字（FOR UPDATE / SELECT 1 FROM card_transactions 等）路由
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({
      __sqlText: Array.isArray(strings?.raw)
        ? strings.raw.join(' ? ')
        : Array.isArray(strings)
          ? strings.join(' ? ')
          : String(strings ?? ''),
      __sqlValues: values,
      // paid-sessions.ts 的 paidUnusedSessionsExpr 模块级 sql(...).as(...) 需要链式 .as
      as: vi.fn().mockReturnValue({ type: 'sql-as' }),
    })),
    { raw: vi.fn(), join: vi.fn() },
  ),
}))

vi.mock('drizzle-orm/pg-core', () => ({
  alias: vi.fn((table, _name) => table),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isInScope: vi.fn(),
  isDepositOrderApprover: vi.fn(() => true),
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

import { createOrder, confirmOfflinePayment, closeOrder, resetOrderFailed, getOrdersPaginated, createConversionOrder, recordPayment, freezeConversionRepaymentAmount, deleteOrder, exportOrders, exportAllocationOrders, createDepositOrder, updatePerformanceAttributionDate } from './orders'
import { settlePointsSafe } from '@/lib/points-settle'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, scopeCondition } from '@/lib/permissions'
import { calcCouponDiscount } from '@/lib/utils'
import { eq, ilike, gte, lt, gt, inArray, isNull } from 'drizzle-orm'
import { requirePermission } from '@/lib/permissions'
import { ApiError } from '@/lib/api-error'
import { logUpdate } from '@/lib/operation-log'
import { hasPendingRefund } from '@/lib/refund-cascade'

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
    productType: '疗程卡' as const,
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
      // 待支付订单 partial unique index 检查（line 1194-1207）使用 tx.select；空结果绕过 conflict
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

// 事务变体：待支付订单 partial unique index 检查命中已有待支付订单 → 触发 CONFLICT 抛错
function mockTransactionWithPendingOrder(pendingId = 'FY-XSD-WX-2605250007') {
  ;(db.transaction as any).mockImplementation(async (fn: any) => {
    const tx = {
      execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260315099' }]),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }),
      // 非空结果 → createOrder 事务内 throw ApiError('CONFLICT', '该顾客已有待支付订单 ...')
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ saleOrderId: pendingId }]),
          }),
        }),
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

// 自引用 chain：from/innerJoin/leftJoin 均返回同一含 where 的对象，抗 JOIN 增减
// （记忆 admin-test-mock-source-drift：加 JOIN 漏更新 mock 致批量假失败）
function mockSelectEmpty() {
  const where = makeThenableWhere([])
  const chain: any = { where }
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
  return vi.fn().mockReturnValue({ from })
}

function mockSelectFound(row: any) {
  return mockSelectRows([row])
}

function mockSelectRows(rows: any[]) {
  const where = makeThenableWhere(rows)
  const chain: any = { where }
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  const from = vi.fn().mockReturnValue(chain)
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

  it('SKU 超过限购次数 → 拒绝且不进入事务', async () => {
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001',
      specName: '10次卡',
      price: '200.00',
      specialPrice: null,
      isExperience: false,
      isManagerSpecial: false,
      purchaseLimit: 1,
    }))

    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], quantity: 2 }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('每单最多可购买 1 件')
    expect(db.transaction).not.toHaveBeenCalled()
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

describe('createOrder — 组合套餐市场范围与归属校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('顾客绑定门店市场不匹配的套餐 → 拒绝且不进入事务', async () => {
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-a',
        marketName: '市场A',
      }))
      .mockImplementationOnce(mockSelectEmpty())

    const result = await createOrder({
      ...baseOrderData,
      bundleProductId: 'bundle-market-b',
      items: [{ ...baseOrderData.items[0], isBundle: true }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不适用于该顾客绑定门店')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('套餐 SKU 不属于声明套餐 → 拒绝且不进入事务', async () => {
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-a',
        marketName: '市场A',
      }))
      .mockImplementationOnce(mockSelectFound({ productId: 'bundle-a' }))
      .mockImplementationOnce(mockSelectFound([]))
      .mockImplementationOnce(mockSelectRows([{ skuId: 'other-sku', bundleGroupId: null }]))

    const result = await createOrder({
      ...baseOrderData,
      bundleProductId: 'bundle-a',
      items: [{ ...baseOrderData.items[0], isBundle: true }],
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不属于该组合套餐')
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('createOrder — 普通 SKU 市场范围校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('受限普通 SKU 不匹配顾客绑定门店市场时拒绝提交', async () => {
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound({
        skuId: 'sku-001',
        specName: '仅限其他市场商品',
        price: '200.00',
        specialPrice: null,
        isExperience: false,
        isManagerSpecial: false,
        purchaseLimit: null,
        marketScope: 'market-other',
      }))
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-east',
        marketName: '华东市场',
      }))
      .mockImplementationOnce(mockSelectEmpty())

    const result = await createOrder(baseOrderData)

    expect(result).toEqual({
      success: false,
      message: '商品「仅限其他市场商品」不适用于该顾客绑定门店',
    })
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('createOrder — 已有待支付订单守卫（CONFLICT 消息透出）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  // 回归守护：f4248169 把事务内 throw 迁移到 ApiError（带 "CONFLICT: " 前缀）后，
  // 旧 catch 的 err.message.startsWith('该顾客已有待支付订单') 失配，被吞成通用「创建订单失败」。
  // 修复后 catch 改走 instanceof ApiError + parseErrorPrefix，剥前缀透出真实单号消息。
  it('顾客已有待支付订单 → 透出含单号的真实消息（剥离前缀，不退化成通用失败）', async () => {
    ;(db.select as any).mockImplementation(mockSelectEmpty())
    mockTransactionWithPendingOrder('FY-XSD-WX-2605250007')

    const result = await createOrder(baseOrderData)

    expect(result.success).toBe(false)
    expect(result.message).toBe('该顾客已有待支付订单 FY-XSD-WX-2605250007，请先关闭后再创建新订单')
    expect(result.message).not.toContain('CONFLICT')
    expect(result.message).not.toBe('创建订单失败，请稍后重试')
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

  // ticket 2026-05-30 client-coupon-not-allocated-to-sale-items：admin 同类 bug 守护
  // 修复前：couponDiscount 仅在订单层 totalAmount = rawTotal - couponDiscount 扣；
  // INSERT sale_items 用前端传入的 pre-coupon saleAmount → unit_real_price/sale_amount 残留原价。
  // 修复后：couponDiscount > 0 时按 saleAmount 比例摊到 eligibleItems 各行，覆盖 it.saleAmount/it.received。
  it('B14: 5次卡 1000 + 298 现金券 → sale_items 落 saleAmount=702 / unitRealPrice=140.4 / received=702', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, minSpend: '0' }))
    ;(calcCouponDiscount as any).mockReturnValue(298)
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260530001')

    const result = await createOrder({
      ...baseOrderData,
      clientUserId: 'user-1',
      couponId: 'cpn-298',
      items: [{
        skuId: 'sku-5card',
        productName: '面部三重维养',
        productType: '疗程卡' as const,
        sessionCount: 5,        // 行总次数（B2 拆行后 quantity=1 不触发；这里 mock skuSessionMap 空 → fallback item.sessionCount）
        unitPrice: '1000.00',   // per-card 标价
        unitRealPrice: '1000.00',
        quantity: 1,
        saleAmount: '1000.00',  // pre-coupon 应付（前端 getItemAmounts 不扣券）
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(1)
    const v = saleItemInserts[0].values
    expect(v.sessionCount).toBe(5)
    expect(Number(v.saleAmount)).toBe(702)            // 1000 - 298
    // 两步式（2026-06-07 修 P0）：开单行级 received=0（资金铁律：只认已支付流水），
    // 实付草稿落 pending_received = 券摊后应付（确认收款入账后才驱动 received/paid_sessions）。
    expect(Number(v.received)).toBe(0)
    expect(Number(v.pendingReceived)).toBe(702)
    expect(Number(v.unitRealPrice)).toBeCloseTo(140.4, 2)  // 702 / 5
    expect(Number(v.unitPrice)).toBe(200)             // per-session 标价 1000/5（不变）
  })

  it('B14 多行：1000(5次卡 eligible) + 200(单品 eligible) + 300 券 → 按 saleAmount 比例摊；尾差归最后行', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({ ...validCoupon, minSpend: '0' }))
    ;(calcCouponDiscount as any).mockReturnValue(300)
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260530002')

    const result = await createOrder({
      ...baseOrderData,
      clientUserId: 'user-1',
      couponId: 'cpn-300',
      items: [
        {
          skuId: 'sku-card',
          productName: '5次卡',
          productType: '疗程卡' as const,
          sessionCount: 5,
          unitPrice: '1000.00',
          unitRealPrice: '1000.00',
          quantity: 1,
          saleAmount: '1000.00',
          salesCategory: '自销自耗' as const,
        },
        {
          skuId: 'sku-home',
          productName: '家居产品',
          productType: '家居产品' as const,
          sessionCount: null,
          unitPrice: '200.00',
          unitRealPrice: '200.00',
          quantity: 1,
          saleAmount: '200.00',
          salesCategory: '自销自耗' as const,
        },
      ],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(2)
    // 摊比 1000:200 = 5:1，券 300 → 250/50
    // 第一行 saleAmount = 1000 - 250 = 750；第二行 200 - 50 = 150
    // 但末行吸收尾差：250 = round(300*1000/1200, 2) = 250；50 = 300 - 250 = 50
    const totalSaleAmount = saleItemInserts.reduce((s, c) => s + Number(c.values.saleAmount), 0)
    expect(Math.round(totalSaleAmount * 100)).toBe(90_000)  // 1200 - 300 = 900
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
    // 真实代码（orders.ts L1368）抛 ApiError('CONFLICT', ...)，带 "CONFLICT: " 前缀；
    // catch 走 instanceof ApiError + parseErrorPrefix 剥前缀后透出原始业务消息。
    ;(db.transaction as any).mockRejectedValue(new ApiError('CONFLICT', '优惠券已被使用，请刷新后重试'))

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

describe('createOrder — 全额储值卡抵扣即时扣卡（2026-05-21）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('prepaidCardAmount==totalAmount（payable=0）→ 即时扣卡 + status=已支付 + payment_method=无 + received=prepaid', async () => {
    let capturedOrder: any
    let execTexts: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          execTexts.push(text)
          if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve([{ id: 'FY-XSD-WX-260521-0009' }])
          if (/SELECT\s+1\s+FROM\s+card_transactions/i.test(text) && /'扣款'/.test(text)) return Promise.resolve([])
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve([{ card_id: 'FY-CARD-DEDUCT', balance: 1000 }])
          }
          if (/SELECT\s+customer_type/i.test(text)) return Promise.resolve([])
          return Promise.resolve({})
        }),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            if (v && 'saleOrderId' in v && 'saleOrderType' in v) capturedOrder = v
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }
      return fn(tx)
    })

    // totalAmount=200（unitRealPrice 200 × 1），prepaidCardAmount=200 → payable=0 全额抵扣
    const result = await createOrder({ ...baseOrderData, paymentMethod: '微信', prepaidCardAmount: 200 })

    expect(result.success).toBe(true)
    expect(result.status).toBe('已支付')
    expect(capturedOrder.status).toBe('已支付')
    expect(capturedOrder.paymentMethod).toBe('无')
    expect(capturedOrder.prepaidCardAmount).toBe('200.00')
    expect(capturedOrder.payableAmount).toBe('0.00')
    expect(capturedOrder.received).toBe('200.00')
    expect(execTexts.some((t) => /UPDATE\s+prepaid_cards/i.test(t))).toBe(true)
    expect(execTexts.some((t) => /INSERT\s+INTO\s+sale_order_payments/i.test(t) && /储值卡抵扣/.test(t))).toBe(true)
    expect(settlePointsSafe).toHaveBeenCalledTimes(1)
  })

  it('余额不足 → 抛 INSUFFICIENT_BALANCE，订单创建失败', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve([{ id: 'FY-XSD-WX-260521-0010' }])
          if (/SELECT\s+1\s+FROM\s+card_transactions/i.test(text) && /'扣款'/.test(text)) return Promise.resolve([])
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve([{ card_id: 'FY-CARD-DEDUCT', balance: 50 }])
          }
          return Promise.resolve({})
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }
      return fn(tx)
    })

    const result = await createOrder({ ...baseOrderData, paymentMethod: '微信', prepaidCardAmount: 200 })

    expect(result.success).toBe(false)
    expect(result.message).toContain('储值卡余额不足')
  })
})

describe('createOrder — 手填充值卡抵扣校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('抵扣金额超过本次逐行实付合计 → 拒绝，不进入事务', async () => {
    const result = await createOrder({
      ...baseOrderData,
      prepaidCardAmount: 80.01,
      items: [{ ...baseOrderData.items[0], received: '80.00' }],
    })

    expect(result).toEqual({ success: false, message: '充值卡抵扣金额超过应抵上限' })
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('部分抵扣金额超过事务内读取的充值卡余额 → 拒绝', async () => {
    const execTexts: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          execTexts.push(text)
          if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve([{ id: 'FY-XSD-WX-260806-0001' }])
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve([{ card_id: 'FY-CARD-1', balance: 50 }])
          }
          return Promise.resolve([])
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }
      return fn(tx)
    })

    const result = await createOrder({
      ...baseOrderData,
      prepaidCardAmount: 100,
      items: [{ ...baseOrderData.items[0], received: '100.00' }],
    })

    expect(result).toEqual({ success: false, message: '充值卡余额不足' })
    const balanceSql = execTexts.find((text) => /SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text))
    expect(balanceSql).toBeDefined()
    expect(balanceSql).not.toMatch(/FOR UPDATE/i)
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
      // 待支付订单 partial unique index 检查（line 1194-1207）；空结果绕过 conflict
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([{
                productSkuId: 'sku-home',
                inventorySkuId: 'inventory-sku-001',
                productCode: 'I001',
                productName: '库存商品',
                specName: null,
                inventorySkuActive: true,
                quantityPerSaleUnit: 1,
              }]),
            }),
          }),
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
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

  it('5次卡 ×3，应付 500/张，实付 1350 → pendingReceived=500/500/350', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518104')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-5x',
        productName: '5次面部护理',
        productType: '疗程卡' as const,
        sessionCount: 5,
        unitPrice: '500.00',
        unitRealPrice: '500.00',
        quantity: 3,
        saleAmount: '1500.00',
        received: '1350.00',
        salesCategory: '自销自耗' as const,
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(3)
    expect(saleItemInserts.map((c) => Number(c.values.saleAmount))).toEqual([500, 500, 500])
    expect(saleItemInserts.map((c) => Number(c.values.received))).toEqual([0, 0, 0])
    expect(saleItemInserts.map((c) => Number(c.values.pendingReceived))).toEqual([500, 500, 350])
  })

  it('家居产品 ×10（productType=家居产品）→ 写入 1 行 sale_items（quantity=10，合行不拆）', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518103')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-home',
        productName: '精华液',
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
    expect(saleItemInserts[0].values.inventoryCompositionSnapshot).toBeNull()
  })
})

function mockDepositOrderReads(skuRows: any[]) {
  ;(db.select as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            userId: 'user-1',
            phone: '13812345678',
            name: '顾客甲',
            boundStoreId: 'store-1',
          }]),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(skuRows),
        }),
      }),
    })
}

describe('createDepositOrder — 疗程卡逐张落库', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('相同 5 次卡逐张落库，并按张分摊历史实收', async () => {
    mockDepositOrderReads([{
      skuId: 'sku-deposit',
      productType: '疗程卡',
      specName: '水光卡',
      price: '500.00',
      specialPrice: null,
      sessionCount: 5,
      isShengmei: false,
      isExperience: false,
      salesCategory: '自销自耗',
      productKind: '护理项目',
    }])
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518201')

    const result = await createDepositOrder({
      storeId: 'store-1',
      marketName: '市场A',
      clientUserId: 'user-1',
      remark: '老系统剩余次数录入',
      items: [
        { skuId: 'sku-deposit', quantity: 1, received: 500 },
        { skuId: 'sku-deposit', quantity: 2, received: 850 },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.itemCount).toBe(3)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(3)
    expect(saleItemInserts.map((c) => c.values.quantity)).toEqual([1, 1, 1])
    expect(saleItemInserts.map((c) => c.values.sessionCount)).toEqual([5, 5, 5])
    expect(saleItemInserts.map((c) => c.values.remainingSessions)).toEqual([5, 5, 5])
    expect(saleItemInserts.map((c) => c.values.saleAmount)).toEqual(['500.00', '500.00', '500.00'])

    const paymentInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'refSaleItemId' in c.values
    )
    expect(paymentInserts).toHaveLength(3)
    expect(paymentInserts.map((c) => Number(c.values.amount))).toEqual([500, 425, 425])
  })

  it('家居产品 ×3 逐件落库，并共用同一显示行组', async () => {
    mockDepositOrderReads([{
      skuId: 'sku-home',
      productType: '家居产品',
      specName: '精华液',
      price: '300.00',
      specialPrice: null,
      sessionCount: null,
      isShengmei: false,
      isExperience: false,
      salesCategory: '自销自耗',
      productKind: '家居产品',
    }])
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260518202')

    const result = await createDepositOrder({
      storeId: 'store-1',
      marketName: '市场A',
      clientUserId: 'user-1',
      items: [{ skuId: 'sku-home', quantity: 3, received: 0 }],
    })

    expect(result.success).toBe(true)
    expect(result.itemCount).toBe(3)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(3)
    expect(saleItemInserts.map((c) => c.values.quantity)).toEqual([1, 1, 1])
    expect(saleItemInserts.map((c) => c.values.sessionCount)).toEqual([null, null, null])
    expect(saleItemInserts.map((c) => c.values.remainingSessions)).toEqual([null, null, null])
    expect(new Set(saleItemInserts.map((c) => c.values.saleItemGroupId)).size).toBe(1)
    expect(saleItemInserts.every((c) => c.values.inventoryCompositionSnapshot == null)).toBe(true)
  })

  it('受限普通 SKU 不匹配顾客绑定门店市场时拒绝提交', async () => {
    mockDepositOrderReads([{
      skuId: 'sku-deposit',
      productType: '疗程卡',
      specName: '仅限其他市场商品',
      price: '500.00',
      specialPrice: null,
      sessionCount: 5,
      isShengmei: false,
      isExperience: false,
      marketScope: 'market-other',
      salesCategory: '自销自耗',
      productKind: '护理项目',
    }])
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-east',
        marketName: '华东市场',
      }))
      .mockImplementationOnce(mockSelectEmpty())

    const result = await createDepositOrder({
      storeId: 'store-1',
      marketName: '市场A',
      clientUserId: 'user-1',
      items: [{ skuId: 'sku-deposit', quantity: 1 }],
    })

    expect(result).toEqual({
      success: false,
      message: '商品「仅限其他市场商品」不适用于该顾客绑定门店',
    })
    expect(db.transaction).not.toHaveBeenCalled()
  })
})

describe('createOrder — sales_category / is_shengmei 后端反查（不信前端 payload）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    // skuRows 返回带 is_shengmei + sales_category 的商品定义；前端硬编码 null 也应被反查值覆盖
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001',
      customerType: '散客',
      serviceFee: '0',
      sessionCount: null,
      isExperience: false,
      isManagerSpecial: false,
      isShengmei: true,
      salesCategory: '自销自耗',
    }))
  })

  it('前端 item.salesCategory=null 时，sale_items 仍写入反查的 sales_category + is_shengmei', async () => {
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260617001')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-001',
        productName: '招牌一卡通',
        productType: '疗程卡' as const,
        sessionCount: null,
        unitPrice: '200.00',
        unitRealPrice: '200.00',
        quantity: 1,
        salesCategory: null, // 前端开单向导硬编码 null（order-create-page.tsx:1447）
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts).toHaveLength(1)
    // 关键：后端从 product_categories / product_skus 反查写入，不取前端 null
    expect(saleItemInserts[0].values.salesCategory).toBe('自销自耗')
    expect(saleItemInserts[0].values.isShengmei).toBe(true)
  })

  it('product_skus.is_shengmei=false 时如实写入 false（不被 ?? null 吞成 null）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001', customerType: '散客', serviceFee: '0', sessionCount: null,
      isExperience: false, isManagerSpecial: false, isShengmei: false, salesCategory: '他销自耗',
    }))
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260617002')
    const result = await createOrder({
      ...baseOrderData,
      items: [{
        skuId: 'sku-001', productName: 'X', productType: '疗程卡' as const,
        sessionCount: null, unitPrice: '100.00', unitRealPrice: '100.00', quantity: 1,
        salesCategory: null,
      }],
    })

    expect(result.success).toBe(true)
    const saleItemInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleItemId' in c.values
    )
    expect(saleItemInserts[0].values.isShengmei).toBe(false)
    expect(saleItemInserts[0].values.salesCategory).toBe('他销自耗')
  })
})

describe('createOrder — 顾客档案权威覆写 clientPhone/customerName（2026-07-08 T1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('入参被 phone-as-name 污染 → sale_orders 落库用客户档案权威 phone/name', async () => {
    // 所有事务外 db.select（顾客类型 + SKU 反查 + 权威覆写）共享此 row：
    // phone/name = 客户档案权威值，应覆盖入参的 phone-as-name 污染值。
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001',
      customerType: '散客',
      memberLevel: null,
      serviceFee: '0',
      sessionCount: null,
      isExperience: false,
      isManagerSpecial: false,
      isShengmei: false,
      salesCategory: '自销自耗',
      phone: '13800009999', // 客户档案权威 phone
      name: '徐丽珍',        // 客户档案权威 name
    }))
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260708001')

    // 入参：customerName 被前端 `name || phone` fallback 污染成手机号
    const result = await createOrder({
      ...baseOrderData,
      clientPhone: '13800001111',  // 入参污染 phone
      customerName: '13800001111', // 入参污染 name（phone-as-name）
    })

    expect(result.success).toBe(true)
    const orderInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleOrderId' in c.values && 'customerName' in c.values,
    )
    expect(orderInserts).toHaveLength(1)
    // 权威覆写：sale_orders 落库用客户档案 phone/name，非入参污染值
    expect(orderInserts[0].values.clientPhone).toBe('13800009999')
    expect(orderInserts[0].values.customerName).toBe('徐丽珍')
  })

  it('客户档案 phone/name 为空 → 回落入参值（后端不强行清空，由前端阻断 + 回填脚本兜底）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001',
      customerType: '散客',
      memberLevel: null,
      serviceFee: '0',
      sessionCount: null,
      isExperience: false,
      isManagerSpecial: false,
      isShengmei: false,
      salesCategory: '自销自耗',
      phone: null,
      name: null,
    }))
    const inserts = mockTransactionCaptureInserts('FY-XSD-WX-260708002')

    const result = await createOrder({
      ...baseOrderData,
      clientPhone: '13800001111',
      customerName: '老顾客快照',
    })

    expect(result.success).toBe(true)
    const orderInserts = inserts.filter((c) =>
      c.values && typeof c.values === 'object' && 'saleOrderId' in c.values && 'customerName' in c.values,
    )
    expect(orderInserts).toHaveLength(1)
    // 档案为空 → 权威覆写短路（if (authCust?.phone)），保留入参快照
    expect(orderInserts[0].values.clientPhone).toBe('13800001111')
    expect(orderInserts[0].values.customerName).toBe('老顾客快照')
  })
})

describe('createOrder — documentType 仅按下单时会员身份判（不再用金额阈值）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
    ;(db.select as any).mockImplementation(mockSelectEmpty())
  })

  it('非会员客 + 小额 → documentType=售前，不调 getMemberThreshold', async () => {
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
    // 分支 B（金额达标算售后）已移除：document_type 只按下单时会员身份判，不再读门槛
    expect(mockGetMemberThreshold).not.toHaveBeenCalled()
  })

  it('非会员客 + 大额达门槛 → documentType 仍售前（不再因金额升级为售后），不调 getMemberThreshold', async () => {
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
    // 「成为会员那一单」下单时仍非会员客 → 售前；跃迁发生在支付后 recalcCustomerType
    expect(mockGetMemberThreshold).not.toHaveBeenCalled()
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
    ;(isInScope as any).mockReturnValue(true)
  })

  // 入口锁单返回行（默认线下待支付、全额应付 200、未收）
  function lockRow(over: Record<string, any> = {}) {
    return {
      status: '待支付', payment_method: '线下', store_id: 'store-1',
      total_amount: '200.00', payable_amount: '200.00', received: '0',
      prepaid_card_amount: '0', client_user_id: null, customer_name: '顾客甲',
      lakala_out_order_no: null,
      ...over,
    }
  }

  /**
   * confirmOfflinePayment 重构后：入口 SELECT ... FOR UPDATE 锁单 → 写现金流水 → SUM 重算 →
   * UPDATE sale_orders SET status（带 WHERE status='待支付' 守卫，rowCount=0 视为并发变更）。
   */
  function mockConfirmTx(opts: { updateRowCount?: number; lock?: Record<string, any>; sumReceived?: string } = {}) {
    const updateRowCount = opts.updateRowCount ?? 1
    const statements: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          statements.push(text)
          if (/SELECT\s+status,\s*payment_method/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return Promise.resolve([lockRow(opts.lock)])
          }
          if (/AS\s+new_received/i.test(text)) {
            return Promise.resolve([{ new_received: opts.sumReceived ?? '0', new_prepaid: '0' }])
          }
          if (/UPDATE\s+sale_orders\s+SET\s+status/i.test(text)) {
            return Promise.resolve({ rowCount: updateRowCount })
          }
          return Promise.resolve({})
        }),
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
    return statements
  }

  it('终态 UPDATE rowCount=0（并发已变更）→ 失败', async () => {
    mockConfirmTx({ updateRowCount: 0 })
    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('锁单非"线下待支付"（如已支付）→ 失败', async () => {
    mockConfirmTx({ lock: { status: '已支付' } })
    const result = await confirmOfflinePayment('order-x')
    expect(result.success).toBe(false)
    expect(result.message).toContain('状态已变更')
  })

  it('preorder 已 claim 但支付方式尚未切微信时拒绝线下确认', async () => {
    const statements = mockConfirmTx({
      lock: {
        payment_method: '线下',
        lakala_out_order_no: 'FY-XSD-WX-2608170001_1786960800',
      },
    })

    const result = await confirmOfflinePayment('order-active-intent')

    expect(result.success).toBe(false)
    expect(result.message).toContain('PAYMENT_INTENT_ACTIVE')
    expect(statements).toHaveLength(1)
  })

  it('正常确认收款（全额）→ 已支付 + 事务内写现金流水 + 翻态', async () => {
    const capturedExecutes: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          capturedExecutes.push(text)
          if (/SELECT\s+status,\s*payment_method/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return Promise.resolve([lockRow()])
          }
          if (/AS\s+new_received/i.test(text)) {
            return Promise.resolve([{ new_received: '200', new_prepaid: '0' }])
          }
          if (/UPDATE\s+sale_orders\s+SET\s+status/i.test(text)) {
            return Promise.resolve({ rowCount: 1 })
          }
          return Promise.resolve({})
        }),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockResolvedValue([])
          return chain
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue({}) }),
      }
      const result = await fn(tx)
      // 写了现金首次支付流水 + 翻态 UPDATE
      expect(capturedExecutes.some((t) => /INSERT INTO sale_order_payments/i.test(t))).toBe(true)
      expect(capturedExecutes.some((t) => /UPDATE\s+sale_orders\s+SET\s+status/i.test(t))).toBe(true)
      const orderUpdate = capturedExecutes.find((t) => /UPDATE\s+sale_orders\s+SET\s+status/i.test(t))
      expect(orderUpdate).toContain('lakala_out_order_no IS NULL')
      return result
    })

    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('确认收款成功')
    expect(result.status).toBe('已支付')
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('已有正向储值卡抵扣时，后续现金归类为回款且查询排除退款', async () => {
    let firstPaymentCheck = ''
    let cashInsertValues: unknown[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          if (/SELECT\s+status,\s*payment_method/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return Promise.resolve([lockRow()])
          }
          if (/SELECT\s+1\s+FROM\s+sale_order_payments/i.test(text)
            && /change_type\s+IN\s*\('首次支付','回款','储值卡抵扣'\)/i.test(text)) {
            firstPaymentCheck = text
            return Promise.resolve([{ exists: 1 }])
          }
          if (/INSERT\s+INTO\s+sale_order_payments/i.test(text)) {
            cashInsertValues = sqlArg?.__sqlValues ?? []
            return Promise.resolve([{ id: 11 }])
          }
          if (/AS\s+new_received/i.test(text)) {
            return Promise.resolve([{ new_received: '100', new_prepaid: '50' }])
          }
          if (/UPDATE\s+sale_orders\s+SET\s+status/i.test(text)) {
            return Promise.resolve({ rowCount: 1 })
          }
          return Promise.resolve({})
        }),
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

    const result = await confirmOfflinePayment('order-card-first', 100)

    expect(result.success).toBe(true)
    expect(firstPaymentCheck).toContain('amount::numeric > 0')
    expect(firstPaymentCheck).toContain("change_type IN ('首次支付','回款','储值卡抵扣')")
    expect(firstPaymentCheck).not.toContain("change_type IN ('首次支付','回款','退款')")
    expect(cashInsertValues).toContain('回款')
  })

  it('部分确认（confirmAmount < 应付）→ 部分支付', async () => {
    mockConfirmTx({ sumReceived: '80' }) // SUM 重算后 received=80 < total 200
    const result = await confirmOfflinePayment('order-1', 80)
    expect(result.success).toBe(true)
    expect(result.status).toBe('部分支付')
    expect(result.message).toContain('部分')
  })

  it('confirmAmount 超过剩余应付 → INVALID_PARAMS 校验错', async () => {
    mockConfirmTx({})
    const result = await confirmOfflinePayment('order-1', 300) // > payable 200
    expect(result.success).toBe(false)
    expect(result.message).toContain('不能超过剩余应付')
  })

  it('转换单确认金额不能超过录单时填写的首笔实付', async () => {
    mockConfirmTx({ lock: { sale_order_type: '转换单', first_payment_amount: '50.00' } })
    const result = await confirmOfflinePayment('order-1', 80)
    expect(result.success).toBe(false)
    expect(result.message).toContain('不能超过转换单录入的实付金额')
  })

  it('事务异常 → 返回友好错误', async () => {
    ;(db.transaction as any).mockRejectedValue(new Error('connection lost'))
    const result = await confirmOfflinePayment('order-1')
    expect(result.success).toBe(false)
    expect(result.message).toBe('确认收款失败，请稍后重试')
  })
})

// 充值卡剥离 SKU 化（2026-05-20）: confirmOfflinePayment 充值入账旧测试组删除

describe('confirmOfflinePayment — 储值卡抵扣扣款（ticket 2026-05-19）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  /** 按 SQL 关键字路由 tx.execute 的扣卡测试 mock（不含充值入账逻辑） */
  function mockDeductTx(opts: {
    prepaidAmount: number
    clientUserId?: string | null
    cardBalance?: number
    cardExists?: boolean
    deductDupExists?: boolean
  }) {
    const captured: { executes: Array<{ text: string; raw: any }>; insertValues: any[] } = {
      executes: [],
      insertValues: [],
    }
    const clientUserId = 'clientUserId' in opts ? opts.clientUserId : 'user-1'
    const cardBalance = opts.cardBalance ?? 1000
    const cardExists = opts.cardExists !== false
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let selectCall = 0
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({ count: 1 }),
          }),
        }),
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          captured.executes.push({ text, raw: sqlArg })
          // 入口锁单（含 prepaid_card_amount + client_user_id）
          if (/SELECT\s+status,\s*payment_method/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return Promise.resolve([{
              status: '待支付', payment_method: '线下', store_id: 'store-1',
              total_amount: '200.00', payable_amount: '200.00', received: '0',
              prepaid_card_amount: 0,
              pending_prepaid_card_amount: opts.prepaidAmount,
              client_user_id: clientUserId,
              customer_name: '顾客甲',
            }])
          }
          if (/UPDATE\s+sale_orders\s+SET\s+status/i.test(text)) {
            return Promise.resolve({ rowCount: 1 })
          }
          if (/SELECT\s+1\s+FROM\s+card_transactions/i.test(text) && /'扣款'/.test(text)) {
            return Promise.resolve(opts.deductDupExists ? [{ '?column?': 1 }] : [])
          }
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve(cardExists ? [{ card_id: 'FY-CARD-DEDUCT', balance: cardBalance }] : [])
          }
          // 充值卡剥离 SKU 化（2026-05-20）后，applyRechargeOnOrderPaid 不再扫 sale_items 行，
          // 直接读 sale_orders.saleOrderType 走 drizzle ORM（不经过 tx.execute mock 分发）
          // recalcCustomerType 内的 SELECT customer_type → 空（保护性路径）
          if (/SELECT\s+customer_type/i.test(text)) {
            return Promise.resolve([])
          }
          // ticket 2026-05-19-cuddly-pancake：confirmOfflinePayment 新增 SUM 重算 received
          if (/AS\s+new_received/i.test(text)) {
            return Promise.resolve([{ new_received: '0', new_prepaid: '0' }])
          }
          return Promise.resolve({})
        }),
        select: vi.fn().mockImplementation(() => {
          const chain: any = {}
          chain.from = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockReturnValue(chain)
          chain.limit = vi.fn().mockImplementation(() => {
            selectCall++
            // applyRechargeOnOrderPaid 第 1 个 tx.select：查 clientUserId
            // 之后再有 tx.select（confirmOfflinePayment 内 customer_type 跃迁前的查询）→ clientUserId
            return Promise.resolve([{ clientUserId }])
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

  it('prepaidAmount=100, balance=200 → 进入扣卡分支：UPDATE prepaid_cards + INSERT card_transactions + INSERT sale_order_payments', async () => {
    const captured = mockDeductTx({ prepaidAmount: 100, cardBalance: 200 })
    const result = await confirmOfflinePayment('order-deduct-1')
    expect(result.success).toBe(true)
    // 扣卡 SQL 都触发
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(true)
    expect(captured.executes.some((e) => /INSERT\s+INTO\s+card_transactions/i.test(e.text))).toBe(true)
    expect(captured.executes.some((e) => /INSERT\s+INTO\s+sale_order_payments/i.test(e.text))).toBe(true)
  })

  it('prepaidAmount=100, balance=50 → 抛 INSUFFICIENT_BALANCE，订单状态不变', async () => {
    const captured = mockDeductTx({ prepaidAmount: 100, cardBalance: 50 })
    const result = await confirmOfflinePayment('order-deduct-fail-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('储值卡余额不足')
    // 不应触发 UPDATE prepaid_cards / INSERT card_transactions
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /INSERT\s+INTO\s+card_transactions/i.test(e.text))).toBe(false)
  })

  it('prepaidAmount=100, 无卡 → 抛 INSUFFICIENT_BALANCE:NO_CARD', async () => {
    const captured = mockDeductTx({ prepaidAmount: 100, cardExists: false })
    const result = await confirmOfflinePayment('order-deduct-no-card')
    expect(result.success).toBe(false)
    expect(result.message).toContain('无储值卡账户')
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(false)
  })

  it('幂等：已存在 type=扣款 的 card_transactions → 跳过整段扣卡块', async () => {
    const captured = mockDeductTx({ prepaidAmount: 100, deductDupExists: true })
    const result = await confirmOfflinePayment('order-deduct-dup')
    expect(result.success).toBe(true)
    // 跳过：不应触发后续的 SELECT card_id, balance / UPDATE / INSERT
    expect(captured.executes.some((e) => /SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /INSERT\s+INTO\s+card_transactions/i.test(e.text))).toBe(false)
  })

  it('prepaidAmount=0 → 不进入扣卡分支', async () => {
    const captured = mockDeductTx({ prepaidAmount: 0 })
    const result = await confirmOfflinePayment('order-no-deduct')
    expect(result.success).toBe(true)
    // 完全跳过：dup 查 / 余额查 / UPDATE 都不触发
    expect(captured.executes.some((e) => /SELECT\s+1\s+FROM\s+card_transactions.*'扣款'/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(false)
  })

  it('client_user_id=null → 不进入扣卡分支（即使 prepaidAmount > 0）', async () => {
    const captured = mockDeductTx({ prepaidAmount: 100, clientUserId: null })
    const result = await confirmOfflinePayment('order-no-user')
    expect(result.success).toBe(true)
    expect(captured.executes.some((e) => /SELECT\s+1\s+FROM\s+card_transactions.*'扣款'/i.test(e.text))).toBe(false)
    expect(captured.executes.some((e) => /UPDATE\s+prepaid_cards/i.test(e.text))).toBe(false)
  })
})

describe('P0-15-01 修复：admin 两触发点必须调用 settlePointsSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('confirmOfflinePayment 成功路径 → settlePointsSafe 以 admin.confirmOffline 调用', async () => {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          if (/SELECT\s+status,\s*payment_method/i.test(text) && /FOR\s+UPDATE/i.test(text)) {
            return Promise.resolve([{
              status: '待支付', payment_method: '线下', store_id: 'store-1',
              total_amount: '300.00', payable_amount: '300.00', received: '0',
              prepaid_card_amount: '0', client_user_id: null, customer_name: '顾客甲',
            }])
          }
          if (/AS\s+new_received/i.test(text)) {
            return Promise.resolve([{ new_received: '300', new_prepaid: '0' }])
          }
          if (/UPDATE\s+sale_orders\s+SET\s+status/i.test(text)) {
            return Promise.resolve({ rowCount: 1 })
          }
          return Promise.resolve({})
        }),
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
    ;(db.execute as any).mockResolvedValue([])
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
        // 合并回款现金/储值卡行用 .returning({id}) 取回 id；直接 await 仍解析为 {}
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve({}), { returning: vi.fn().mockResolvedValue([{ id: 1 }]) }),
          ),
        }),
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

  it('活动在线支付意图存在时原子拒绝关闭', async () => {
    mockSelectBefore([{
      status: '待支付',
      customerName: '顾客甲',
      totalAmount: '200.00',
      lakalaOutOrderNo: 'order-1_123',
    }])
    mockCloseTx(0)

    const result = await closeOrder('order-1')

    expect(result).toEqual({ success: false, message: '在线支付处理中，暂不能关闭订单' })
    expect(isNull).toHaveBeenCalledWith('lakala_out_order_no')
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
      // closeOrder: tx.update 调用两次（saleOrders 关单 + userCoupons 归还核销券），
      // tx.execute 调用三次（作废营业额子分配 + 清空分配状态 + 作废待支付款项）
      expect(tx.update).toHaveBeenCalledTimes(2)
      expect(tx.execute).toHaveBeenCalledTimes(3)
      return result
    })

    const result = await closeOrder('order-1')
    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(isNull).toHaveBeenCalledWith('lakala_out_order_no')
  })

  it('关闭待支付转换单 → 恢复源卡次数并作废转换权益', async () => {
    mockSelectBefore([{
      status: '待支付',
      customerName: '顾客甲',
      totalAmount: '200.00',
      saleOrderType: '转换单',
      storeId: 'store-1',
    }])

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
      const sqlTexts = tx.execute.mock.calls.map((call: any[]) => call[0]?.__sqlText || '')
      expect(sqlTexts.some((text: string) =>
        text.includes('locked_source') &&
        text.includes('ref_sale_item_id') &&
        text.includes('restore_sessions'),
      )).toBe(true)
      expect(sqlTexts.some((text: string) =>
        text.includes("item_direction IN ('转出', '转入')") &&
        text.includes('paid_sessions'),
      )).toBe(true)
      return result
    })

    const result = await closeOrder('order-1')
    expect(result.success).toBe(true)
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
    // 2026-07-08 修复 T1：list 端点 left join clientWechatUsers 后加这俩字段做权威兜底
    custName: '李女士',
    custPhone: '13812345678',
  }

  /** 构建完整的链式调用 mock：select → from → leftJoin ×N → where → orderBy → limit → offset
   * 2026-07-08 修复 T1：data 查询链加 3rd leftJoin（clientWechatUsers）后改用自引用 chain
   * 抗 JOIN 增减漂移（参考 [[project_admin_test_mock_drift]]）。
   */
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
      // DATA 查询链：自引用 chain，含 where/orderBy/limit/offset
      const offset = vi.fn().mockResolvedValue(dataRows)
      const limit = vi.fn().mockReturnValue({ offset })
      const orderBy = vi.fn().mockReturnValue({ limit })
      const where = vi.fn().mockReturnValue({ orderBy })
      const chain: any = { where, orderBy, limit, offset }
      chain.leftJoin = vi.fn().mockReturnValue(chain)
      chain.innerJoin = vi.fn().mockReturnValue(chain)
      const from = vi.fn().mockReturnValue(chain)
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

  // 2026-07-08 修复 T1：list 端点 left join clientWechatUsers 做 name/phone 兜底。
  // 顾客档案权威（custName）应覆盖 sale_orders.customer_name 污染值。
  describe('customerName 兜底（list）', () => {
    it('custName 有值 → 覆盖 sale_orders 旧值（防 phone-as-name 污染）', async () => {
      // sale_orders 旧值是手机号 18270881485（污染），client_wechat_users.name 是 '徐丽珍'（权威）
      mockPaginatedChain(1, [{
        ...mockOrderRow,
        order: { ...mockOrderRow.order, customerName: '18270881485', clientPhone: '18270881485' },
        custName: '徐丽珍',
        custPhone: '18270881485',
      }])

      const result = await getOrdersPaginated()

      expect(result.data[0].customerName).toBe('徐丽珍')
      expect(result.data[0].clientPhone).toBe('18270881485')
    })

    it('custName 为 null → fallback 到 sale_orders.customerName', async () => {
      mockPaginatedChain(1, [{
        ...mockOrderRow,
        order: { ...mockOrderRow.order, customerName: '老顾客快照', clientPhone: '13800000000' },
        custName: null,
        custPhone: null,
      }])

      const result = await getOrdersPaginated()

      expect(result.data[0].customerName).toBe('老顾客快照')
      expect(result.data[0].clientPhone).toBe('13800000000')
    })

    it('custName 和 sale_orders.customerName 都为 null → 返回 null', async () => {
      mockPaginatedChain(1, [{
        ...mockOrderRow,
        order: { ...mockOrderRow.order, customerName: null, clientPhone: null },
        custName: null,
        custPhone: null,
      }])

      const result = await getOrdersPaginated()

      expect(result.data[0].customerName).toBe(null)
      expect(result.data[0].clientPhone).toBe(null)
    })
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

  it('type 多选筛选 → inArray 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ types: ['销售单', '转换单'] })

    expect(inArray).toHaveBeenCalledWith('sale_order_type', ['销售单', '转换单'])
  })

  it('体验转换审计筛选同时限定转换单类型与体验标记', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ conversionMode: 'experience' })

    expect(eq).toHaveBeenCalledWith('sale_order_type', '转换单')
    expect(eq).toHaveBeenCalledWith('is_experience_conversion', true)
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

  it('allocationEligibleOnly=true → inArray(sale_order_type, [销售单, 转换单]) 被调用', async () => {
    mockPaginatedChain(0, [])

    await getOrdersPaginated({ allocationEligibleOnly: true })

    expect(inArray).toHaveBeenCalledWith('sale_order_type', ['销售单', '转换单'])
  })

  it('allocationEligibleOnly 缺省 → 不按订单类型白名单过滤', async () => {
    mockPaginatedChain(0, [])
    ;(inArray as any).mockClear()

    await getOrdersPaginated({})

    const typeWhitelistCalls = (inArray as any).mock.calls.filter(
      (c: any[]) => c[0] === 'sale_order_type',
    )
    expect(typeWhitelistCalls).toHaveLength(0)
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
  // 自引用 thenable 链：.from().leftJoin()*N.where()[.limit()] —— leftJoin 返回自身适配任意层数，
  // where 既可直接 await（items 查询）又可 .limit()（订单查询）。源码 getOrderById 后续再加 JOIN 也不脆断。
  function makeChain(result: any[]) {
    const chain: any = Object.assign(Promise.resolve(result), {
      limit: vi.fn().mockResolvedValue(result),
    })
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    return chain
  }
  function mockDetailChain(orderRow: any, itemRows: any[]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => {
      i++
      return i === 1 ? makeChain(orderRow ? [orderRow] : []) : makeChain(itemRows)
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

  it('内部单 → 进入事务时 items 金额已 ×0.5（基于标价 price，unitPrice 原价保留）', async () => {
    // 会员价分流后后端权威定价：内部单按 DB 标价 price × 50% 重算（不信前端单价），
    // 故需 mock 出 sku-001 的 price=200（同一行兼供会员判定查询读 customerType/memberLevel）。
    ;(db.select as any).mockImplementation(mockSelectFound({
      skuId: 'sku-001', price: '200.00', specialPrice: null, isExperience: false, isManagerSpecial: false,
      customerType: '流量客', memberLevel: null,
    }))
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
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
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

// 充值卡剥离 SKU 化（2026-05-20）: createOrder 充值卡分支 + applyRechargeOnOrderPaid 旧 SKU 路径 测试组删除

// ─── createOrder — 会员价分流（后端权威定价） ───────────────────────────────

describe('createOrder — 会员价分流（后端权威定价）', () => {
  // 捕获事务内 INSERT 的 sale_item（含 per-session 派生后的 unit_price / unit_real_price）
  function mockCaptureTx() {
    const cap: { item?: any; items: any[] } = { items: [] }
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([{ id: 'FY-XSD-WX-260410-MP01' }]),
        insert: vi.fn().mockImplementation((table: any) => ({
          values: vi.fn().mockImplementation((v: any) => {
            if (table && 'saleItemId' in v) {
              cap.item = v
              cap.items.push(v)
            }
            return Promise.resolve({})
          }),
        })),
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }),
        select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
      }
      return fn(tx)
    })
    return cap
  }

  // 单一行（同时供：会员判定查询读 customerType/memberLevel + SKU 定价/反查读其余列）。
  // sessionCount=null → per-session 派生退化为按 quantity（quantity=1 时恒等，便于断言）。
  function skuRow(over: Record<string, unknown>) {
    return {
      skuId: 'sku-001', price: '200.00', specialPrice: '150.00',
      isExperience: false, isManagerSpecial: false, isShengmei: null,
      sessionCount: null, serviceFee: '0', salesCategory: '自销自耗',
      customerType: '流量客', memberLevel: null,
      ...over,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('普通商品 + 会员 → 取会员价 special_price，忽略前端单价', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ customerType: '会员客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '999', unitRealPrice: '999', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('150.00') // 会员价（非前端透传的 999）
    expect(cap.item.unitPrice).toBe('200.00')     // 标价快照
  })

  it('普通商品 + 非会员 → 取标价（堵非会员套用会员价）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ customerType: '流量客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '200', unitRealPrice: '150', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('200.00') // 标价（前端传 150 被忽略）
  })

  it('体验卡 → 非会员按标价（#6=B：不再豁免，与普通商品同口径）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ isExperience: true, price: '500.00', specialPrice: '100.00', customerType: '流量客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '500', unitRealPrice: '500', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('500.00') // 非会员体验卡 → 标价（#6=B，不再豁免）
  })

  it('体验卡 → 会员享 special_price（与普通商品同口径）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ isExperience: true, price: '500.00', specialPrice: '100.00', customerType: '会员客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '500', unitRealPrice: '500', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('100.00') // 会员体验卡 → 会员价
  })

  it('店长特价 + 会员 → 允许向下改价（钳制 ≤ 会员价）', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ isManagerSpecial: true, customerType: '会员客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '200', unitRealPrice: '120', saleAmount: '120', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('120.00') // 店长改到 120（< 会员价 150）
  })

  it('店长特价 → 前端报高于适用价时钳制到适用价', async () => {
    ;(db.select as any).mockImplementation(mockSelectFound(skuRow({ isManagerSpecial: true, customerType: '会员客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [{ ...baseOrderData.items[0], unitPrice: '200', unitRealPrice: '180', saleAmount: '180', quantity: 1 }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('150.00') // 钳制到会员价 150
  })

  it('套餐子项 isBundle → 维持现状，沿用前端套餐价不分流', async () => {
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-a',
        marketName: '市场A',
      }))
      .mockImplementationOnce(mockSelectFound({ productId: 'bundle-a' }))
      .mockImplementationOnce(mockSelectRows([{ id: 1, groupName: '默认组', pickCount: null }]))
      .mockImplementationOnce(mockSelectRows([{ skuId: 'sku-001', bundleGroupId: 1 }]))
      .mockImplementation(mockSelectFound(skuRow({ customerType: '会员客' })))
    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      bundleProductId: 'bundle-a',
      items: [{ ...baseOrderData.items[0], unitPrice: '200', unitRealPrice: '99', saleAmount: '99', quantity: 1, isBundle: true }],
    })
    expect(result.success).toBe(true)
    expect(cap.item.unitRealPrice).toBe('99.00') // 套餐价 99，未被改写为会员价 150
  })

  it('同品类同规格疗程卡累计次数命中最高梯度，忽略前端伪造金额', async () => {
    const oneSession = {
      skuId: 'sku-tier-1', categoryId: 'cat-face', specName: '面部护理', productType: '疗程卡',
      sessionCount: 1, price: '300.00', specialPrice: null, serviceFee: '0',
      isExperience: false, isManagerSpecial: false, isShengmei: false,
      marketScope: null, purchaseLimit: null, salesCategory: '自销自耗',
    }
    const twoSessions = { ...oneSession, skuId: 'sku-tier-2', sessionCount: 2, price: '550.00' }
    const threeSessionTier = { ...oneSession, skuId: 'sku-tier-3', sessionCount: 3, price: '600.00' }
    ;(db.select as any)
      .mockImplementationOnce(mockSelectRows([oneSession, twoSessions]))
      .mockImplementationOnce(mockSelectFound({ customerType: '流量客', memberLevel: null }))
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-a',
        marketName: '市场A',
      }))
      .mockImplementationOnce(mockSelectRows([oneSession, twoSessions, threeSessionTier]))
      .mockImplementationOnce(mockSelectRows([oneSession, twoSessions]))
      .mockImplementationOnce(mockSelectFound({ phone: '13812345678', name: '顾客甲' }))

    const cap = mockCaptureTx()
    const result = await createOrder({
      ...baseOrderData,
      items: [
        {
          ...baseOrderData.items[0], skuId: oneSession.skuId, productName: '面部护理1次',
          sessionCount: 1, unitPrice: '9999', unitRealPrice: '9999', saleAmount: '9999',
        },
        {
          ...baseOrderData.items[0], skuId: twoSessions.skuId, productName: '面部护理2次',
          sessionCount: 2, unitPrice: '9999', unitRealPrice: '9999', saleAmount: '9999',
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(cap.items.map((item) => item.saleAmount)).toEqual(['200.00', '400.00'])
    expect(cap.items.map((item) => item.unitRealPrice)).toEqual(['200.00', '200.00'])
    expect(isNull).toHaveBeenCalledWith('market_scope')
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
    reservedRows?: any[]
    orderId?: string
    updateCount?: number
    upsertCardId?: string
    onInsertOrder?: (v: any) => void
    onInsertItem?: (v: any) => void
  }) {
    const executeSql: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let execCall = 0
      const tx = {
        execute: vi.fn().mockImplementation(async (sqlArg: any) => {
          execCall++
          executeSql.push(sqlArg?.__sqlText ?? '')
          if (execCall === 1) return opts.heldRows
          if (execCall === 2) return opts.reservedRows ?? []
          if (execCall === 3) return [{ id: opts.orderId || 'FY-XSD-WX-260416-0001' }]
          if (execCall === 4) return [{ card_id: opts.upsertCardId || 'card-new-1' }]
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
            if (v && 'saleItemId' in v && 'itemDirection' in v) {
              opts.onInsertItem?.(v)
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
    return { executeSql }
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
      productType: '疗程卡' as const,
      sessionCount: 10,
      unitPrice: '1000.00',
      quantity: 1,
    }],
  }

  it('受限普通转入 SKU 不匹配顾客绑定门店市场时拒绝提交', async () => {
    ;(db.select as any)
      .mockImplementationOnce(mockSelectFound(mockClient))
      .mockImplementationOnce(mockSelectFound({
        isCrossStoreTemp: false,
        marketId: 'market-east',
        marketName: '华东市场',
      }))
      .mockImplementationOnce(mockSelectEmpty())
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', sale_order_id: 'old-order', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old', product_name: '旧疗程', product_type: '疗程卡', session_count: 1,
        remaining_sessions: 1, quantity: 1, picked_up_quantity: 0, unit_price: '100', unit_real_price: '100',
        sales_category: '自销自耗', service_fee: '0', is_experience: false, is_shengmei: false,
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', specName: '仅限其他市场商品', price: '500.00', specialPrice: null,
        serviceFee: '0', sessionCount: 5, productType: '疗程卡', salesCategory: '自销自耗',
        isExperience: false, isManagerSpecial: false, isShengmei: false, categoryId: 'cat-new',
        purchaseLimit: null, marketScope: 'market-other',
      }],
    })

    const result = await createConversionOrder(baseConvData)

    expect(result).toEqual({
      success: false,
      message: '商品「仅限其他市场商品」不适用于该顾客绑定门店',
    })
  })

  it('优惠券按正补差额封顶，订单落券字段、转入行金额和核销均一致', async () => {
    const captured: { execute: string[]; inserts: any[]; updates: any[] } = {
      execute: [],
      inserts: [],
      updates: [],
    }
    ;(calcCouponDiscount as any).mockReturnValue(300)
    ;(db.select as any).mockImplementation(mockSelectFound({
      userId: 'user-1',
      phone: '13812345678',
      name: '张小姐',
      customerType: '会员客',
      memberLevel: null,
    }))

    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let selectCall = 0
      const tx = {
        execute: vi.fn().mockImplementation(async (sqlArg: any) => {
          const text = sqlArg?.__sqlText ?? ''
          captured.execute.push(text)
          if (/FOR\s+UPDATE\s+OF\s+si/i.test(text)) {
            return [{
              sale_item_id: 'card-1', sale_order_id: 'old-order', store_id: 'store-1', item_direction: '购买',
              sku_id: 'sku-old', product_name: '老疗程', product_type: '疗程卡', session_count: 4,
              remaining_sessions: 4, quantity: 1, picked_up_quantity: 0, unit_price: '100', unit_real_price: '100',
              sales_category: '自销自耗', service_fee: '0', is_experience: false, is_shengmei: false,
              client_user_id: 'user-1', order_status: '已支付',
            }]
          }
          if (/pg_advisory_xact_lock/i.test(text)) return [{ id: 'FY-XSD-WX-2608080001' }]
          return []
        }),
        select: vi.fn().mockImplementation(() => {
          selectCall += 1
          const rowsByCall: any[][] = [
            [{
              skuId: 'sku-new-1', specName: '新项目', price: '500', specialPrice: null,
              serviceFee: '0', sessionCount: 1, productType: '疗程卡', isExperience: false,
              isManagerSpecial: false, isShengmei: false, categoryId: 'cat-new',
              salesCategory: '自销自耗', purchaseLimit: null,
            }],
            [{
              skuId: 'sku-new-1', specName: '新项目', price: '500', specialPrice: null,
              serviceFee: '0', sessionCount: 1, productType: '疗程卡', isExperience: false,
              isManagerSpecial: false, isShengmei: false, categoryId: 'cat-new',
              salesCategory: '自销自耗', purchaseLimit: null,
            }],
            [{
              status: '未使用', expireAt: new Date(Date.now() + 86_400_000), userId: 'user-1',
              couponType: '现金券', discountValue: '300', maxDiscount: null, minSpend: '0', isActive: true,
              applicableStoreIds: null, applicableCategoryIds: null, applicableProductIds: null, applicableMarketIds: null,
            }],
            [{ skuId: 'sku-new-1', categoryId: 'cat-new' }],
            [{ skuId: 'sku-new-1', productId: 'product-new' }],
          ]
          const rows = rowsByCall[selectCall - 1] ?? []
          const chain: any = {}
          chain.innerJoin = vi.fn().mockReturnValue(chain)
          chain.leftJoin = vi.fn().mockReturnValue(chain)
          chain.where = vi.fn().mockImplementation(() => selectCall === 3 ? chain : Promise.resolve(rows))
          if (selectCall === 3) chain.limit = vi.fn().mockResolvedValue(rows)
          return { from: vi.fn().mockReturnValue(chain) }
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((values: any) => {
            captured.inserts.push(values)
            return Promise.resolve({})
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((values: any) => {
            captured.updates.push(values)
            return { where: vi.fn().mockResolvedValue({ count: 1 }) }
          }),
        }),
      }
      return fn(tx)
    })

    const result = await createConversionOrder({
      ...baseConvData,
      convertInItems: [{ ...baseConvData.convertInItems[0], quantity: 1 }],
      couponId: 'coupon-001',
    })

    expect(result).toMatchObject({ success: true, totalIn: 400, totalOut: 400, priceDiff: 0, couponDiscount: 100 })
    const orderInsert = captured.inserts.find((row) => row.saleOrderType === '转换单')
    const inItem = captured.inserts.find((row) => row.itemDirection === '转入')
    expect(orderInsert).toMatchObject({ couponId: 'coupon-001', couponDiscount: '100.00', totalAmount: '0.00' })
    expect(inItem).toMatchObject({ saleAmount: '400.00', received: '400.00', unitRealPrice: '400.00' })
    expect(captured.updates).toContainEqual(expect.objectContaining({ status: '已使用', usedSaleOrderId: expect.any(String) }))
    expect(captured.execute.some((text) => text.includes('INSERT INTO prepaid_cards'))).toBe(false)
  })

  it('券前补差额为零时拒绝携券请求', async () => {
    const captured = mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', sale_order_id: 'old-order', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', product_type: '疗程卡', session_count: 5, remaining_sessions: 5,
        quantity: 1, picked_up_quantity: 0, unit_price: '1000.00', unit_real_price: '200.00',
        sales_category: '自销自耗', service_fee: '0', is_experience: false, is_shengmei: false,
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '1000.00', specialPrice: null, serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗', isExperience: false, isManagerSpecial: false,
      }],
    })

    const result = await createConversionOrder({ ...baseConvData, couponId: 'coupon-001' })

    expect(result.success).toBe(false)
    expect(result.message).toContain('无正补差额')
    expect(captured.executeSql.some((text) => text.includes('pg_advisory_xact_lock'))).toBe(false)
  })

  it('priceDiff = 0：totalIn=totalOut，订单 total_amount=0，status=已支付', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
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

  it('转入多行累计次数命中最高疗程梯度，服务端覆盖前端伪造金额', async () => {
    const insertedItems: any[] = []
    const oneSession = {
      skuId: 'sku-tier-1', categoryId: 'cat-face', specName: '面部护理',
      price: '300.00', specialPrice: null, serviceFee: '0', sessionCount: 1,
      productType: '疗程卡', salesCategory: '自销自耗', isExperience: false,
      isManagerSpecial: false, isShengmei: false, marketScope: null, purchaseLimit: null,
    }
    const twoSessions = { ...oneSession, skuId: 'sku-tier-2', sessionCount: 2, price: '550.00' }
    const threeSessionTier = { ...oneSession, skuId: 'sku-tier-3', sessionCount: 3, price: '600.00' }
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', sale_order_id: 'old-order', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old', product_name: '旧疗程', product_type: '疗程卡', session_count: 1,
        remaining_sessions: 1, quantity: 1, picked_up_quantity: 0, unit_price: '100', unit_real_price: '100',
        sales_category: '自销自耗', service_fee: '0', is_experience: false, is_shengmei: false,
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [oneSession, twoSessions, threeSessionTier],
      onInsertItem: (value) => { insertedItems.push(value) },
    })

    const result = await createConversionOrder({
      ...baseConvData,
      convertInItems: [
        {
          ...baseConvData.convertInItems[0], skuId: oneSession.skuId, productName: '面部护理1次',
          sessionCount: 1, unitPrice: '9999', unitRealPrice: '9999', saleAmount: '9999',
        },
        {
          ...baseConvData.convertInItems[0], skuId: twoSessions.skuId, productName: '面部护理2次',
          sessionCount: 2, unitPrice: '9999', unitRealPrice: '9999', saleAmount: '9999',
        },
      ],
    })

    expect(result).toMatchObject({ success: true, totalIn: 600, totalOut: 100, priceDiff: 500 })
    const inItems = insertedItems.filter((item) => item.itemDirection === '转入')
    expect(inItems.map((item) => item.saleAmount)).toEqual(['200.00', '400.00'])
    expect(inItems.map((item) => item.unitRealPrice)).toEqual(['200.00', '200.00'])
    expect(isNull).toHaveBeenCalledWith('market_scope')
  })

  it('转换单转入权益可继续折抵，且 quantity=2 的新疗程拆成两张实体卡', async () => {
    const insertedItems: any[] = []
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-from-conversion', sale_order_id: 'old-conversion',
        store_id: 'store-1', sale_order_type: '转换单', item_direction: '转入',
        sku_id: 'sku-old-1', product_name: '旧疗程', product_type: '疗程卡',
        session_count: 5, remaining_sessions: 5, quantity: 1, picked_up_quantity: 0,
        unit_price: '200.00', unit_real_price: '200.00', sales_category: '自销自耗',
        service_fee: '0', client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '20.00', sessionCount: 5,
        productType: '疗程卡', salesCategory: '自销自耗', isExperience: false,
      }],
      onInsertItem: (value) => { insertedItems.push(value) },
    })

    const result = await createConversionOrder({
      ...baseConvData,
      convertOutSaleItemIds: ['card-from-conversion'],
      convertInItems: [{ ...baseConvData.convertInItems[0], quantity: 2 }],
    })

    expect(result.success).toBe(true)
    const inItems = insertedItems.filter((item) => item.itemDirection === '转入')
    expect(inItems).toHaveLength(2)
    expect(inItems.map((item) => item.quantity)).toEqual([1, 1])
    expect(inItems.map((item) => item.sessionCount)).toEqual([5, 5])
    expect(new Set(inItems.map((item) => item.saleItemGroupId))).toEqual(new Set([inItems[0].saleItemId]))
    expect(inItems.reduce((sum, item) => sum + Number(item.saleAmount), 0)).toBe(1000)
    expect(inItems.reduce((sum, item) => sum + Number(item.serviceFee), 0)).toBe(40)
  })

  it('普通销售单的转入方向不是权益，拒绝用于转换折抵', async () => {
    mockConvTx({
      heldRows: [{
        sale_item_id: 'invalid-in-row', sale_order_id: 'old-sale', store_id: 'store-1',
        sale_order_type: '销售单', item_direction: '转入', sku_id: 'sku-old-1',
        product_name: '异常行', product_type: '疗程卡', session_count: 5,
        remaining_sessions: 5, quantity: 1, picked_up_quantity: 0,
        unit_price: '200.00', unit_real_price: '200.00', sales_category: '自销自耗',
        service_fee: '0', client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [],
    })

    const result = await createConversionOrder({
      ...baseConvData,
      convertOutSaleItemIds: ['invalid-in-row'],
    })

    expect(result).toEqual({ success: false, message: '所选行不是有效疗程权益，不可折抵' })
  })

  it('先锁转出卡再汇总预扣，并按预扣次数折抵', async () => {
    const insertedItems: any[] = []
    const captured = mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 5, remaining_sessions: 5,
        quantity: 1, picked_up_quantity: 0, unit_price: '1000.00',
        unit_real_price: '200.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      reservedRows: [{ sale_item_id: 'card-1', total_reserved: '2' }],
      skuRows: [{
        skuId: 'sku-new-1', price: '1000.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
      }],
      onInsertItem: (v) => { insertedItems.push(v) },
    })

    const result = await createConversionOrder(baseConvData)

    expect(result.success).toBe(true)
    expect(result.totalOut).toBe(600)
    expect(insertedItems.find((item) => item.itemDirection === '转出')?.quantity).toBe(3)
    const lockIndex = captured.executeSql.findIndex((text) => /FOR\s+UPDATE\s+OF\s+si/i.test(text))
    const reservedIndex = captured.executeSql.findIndex((text) => /FROM\s+service_items\s+sit/i.test(text))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(reservedIndex).toBe(lockIndex + 1)
    expect(captured.executeSql[lockIndex]).not.toMatch(/service_items|SUM\s*\(/i)
    expect(captured.executeSql[lockIndex]).toMatch(/ORDER\s+BY\s+si\.sale_item_id\s+FOR\s+UPDATE/i)
    expect(captured.executeSql[reservedIndex]).toMatch(/reserved_at\s+IS\s+NOT\s+NULL/i)
    expect(captured.executeSql[reservedIndex]).toMatch(/INNER\s+JOIN\s+service_orders\s+reserved_order/i)
    expect(captured.executeSql[reservedIndex]).toMatch(/reserved_order\.status\s+IN\s*\('服务中',\s*'待客户确认'\)/i)
  })

  it('全部次数被服务预留 → CARD_RESERVED 透出中文业务提示', async () => {
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 2, remaining_sessions: 2,
        quantity: 1, picked_up_quantity: 0, unit_price: '200.00',
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      reservedRows: [{ sale_item_id: 'card-1', total_reserved: '2' }],
      skuRows: [],
    })

    const result = await createConversionOrder(baseConvData)

    expect(result).toEqual({
      success: false,
      message: '所选卡可用次数不足（存在服务中预留）',
    })
  })

  it('转换单转入支持店长特价：按手填应付计价并保留标价/成交价快照', async () => {
    const insertedItems: any[] = []
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 1, remaining_sessions: 1,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', specialPrice: null, serviceFee: '0', sessionCount: 5,
        productType: '疗程卡', salesCategory: '自销自耗', isManagerSpecial: true,
      }],
      onInsertItem: (v) => { insertedItems.push(v) },
    })

    const result = await createConversionOrder({
      ...baseConvData,
      convertInItems: [{
        ...baseConvData.convertInItems[0],
        unitRealPrice: '300.00',
        saleAmount: '300.00',
      }],
    })

    expect(result.success).toBe(true)
    expect(result.totalIn).toBe(300)
    expect(result.priceDiff).toBe(200)

    const inItem = insertedItems.find((item) => item.itemDirection === '转入')
    expect(inItem).toBeDefined()
    expect(inItem.unitPrice).toBe('100.00')
    expect(inItem.unitRealPrice).toBe('60.00')
    expect(inItem.saleAmount).toBe('300.00')
    expect(inItem.isManagerSpecial).toBe(true)
  })

  it('priceDiff > 0：补现，total_amount=差额，status=待支付（线下走 confirmOffline 入账）', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
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
    expect(capturedOrder.status).toBe('待支付')
    expect(result.prepaidCardCredit).toBe(0)
  })

  it('普通转换可录入部分实付，冻结首次收款金额并保留剩余欠款', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', product_type: '疗程卡',
        session_count: 3, remaining_sessions: 3, quantity: 1, unit_price: '100.00', unit_real_price: '100.00',
        sales_category: '自销自耗', service_fee: '0', client_user_id: 'user-1', order_status: '已支付',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
      }],
      onInsertOrder: (v) => { capturedOrder = v },
    })

    const result = await createConversionOrder({ ...baseConvData, receivedAmount: 100 })

    expect(result).toMatchObject({
      success: true,
      priceDiff: 200,
      receivedAmount: 100,
      remainingAmount: 200,
      status: '待支付',
    })
    expect(result.message).toContain('本次应收 ¥100.00，剩余挂账 ¥100.00')
    expect(capturedOrder).toMatchObject({
      totalAmount: '200.00',
      payableAmount: '200.00',
      received: '0',
      firstPaymentAmount: '100.00',
      isExperienceConversion: false,
    })
  })

  it('体验转换按旧卡划卡价值强制分摊转入价，不补不退且订单直接结清', async () => {
    let capturedOrder: any
    const insertedItems: any[] = []
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程', product_type: '疗程卡',
        session_count: 8, remaining_sessions: 8, quantity: 1, unit_price: '100.00', unit_real_price: '100.00',
        sales_category: '自销自耗', service_fee: '0', client_user_id: 'user-1', order_status: '已支付',
      }],
      skuRows: [
        { skuId: 'sku-new-1', price: '300.00', serviceFee: '0', sessionCount: 3, productType: '疗程卡', salesCategory: '自销自耗' },
        { skuId: 'sku-new-2', price: '700.00', serviceFee: '0', sessionCount: 7, productType: '疗程卡', salesCategory: '他销自耗' },
      ],
      onInsertOrder: (v) => { capturedOrder = v },
      onInsertItem: (v) => { insertedItems.push(v) },
    })

    const result = await createConversionOrder({
      ...baseConvData,
      isExperienceConversion: true,
      convertInItems: [
        { ...baseConvData.convertInItems[0], skuId: 'sku-new-1', productName: '新项目A', sessionCount: 3 },
        { ...baseConvData.convertInItems[0], skuId: 'sku-new-2', productName: '新项目B', sessionCount: 7 },
      ],
    })

    expect(result).toMatchObject({
      success: true,
      totalOut: 800,
      totalIn: 800,
      priceDiff: 0,
      prepaidCardCredit: 0,
      receivedAmount: 0,
      remainingAmount: 0,
      isExperienceConversion: true,
      status: '已支付',
    })
    expect(capturedOrder).toMatchObject({
      totalAmount: '0.00', payableAmount: '0.00', received: '0', paymentMethod: '无',
      firstPaymentAmount: null, isExperienceConversion: true, status: '已支付',
    })
    expect(insertedItems.filter((item) => item.itemDirection === '转入').map((item) => item.saleAmount))
      .toEqual(['240.00', '560.00'])
  })

  it('体验转换拒绝优惠券、储值卡抵扣和实付金额', async () => {
    for (const forbidden of [
      { couponId: 'coupon-1' },
      { prepaidCardAmount: 1 },
      { prepaidCardAmount: -1 },
      { receivedAmount: 1 },
      { receivedAmount: -1 },
    ]) {
      const result = await createConversionOrder({
        ...baseConvData,
        isExperienceConversion: true,
        ...forbidden,
      })
      expect(result).toEqual({ success: false, message: '体验转换不允许优惠券、储值卡抵扣或收款' })
    }
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('priceDiff < 0：差额入储值卡，status=已支付', async () => {
    let capturedOrder: any
    mockConvTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
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

  /**
   * 补差额全额储值卡抵扣（2026-05-21）：priceDiff>0 且 prepaidCardAmount==priceDiff →
   * 创建事务内即时扣卡 + 写 '储值卡抵扣' 流水 → status='已支付'、payment_method='无'、received=card。
   * 关键字路由 tx.execute（扣卡块需返回余额行）。
   */
  function mockConvDeductTx(opts: {
    heldRows: any[]
    skuRows: any[]
    cardBalance?: number
    onInsertOrder?: (v: any) => void
  }) {
    const captured: { execTexts: string[]; insertValues: any[] } = { execTexts: [], insertValues: [] }
    const cardBalance = opts.cardBalance ?? 1000
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          captured.execTexts.push(text)
          if (/FOR\s+UPDATE\s+OF\s+si/i.test(text)) return Promise.resolve(opts.heldRows)
          if (/FROM\s+service_items\s+sit/i.test(text)) return Promise.resolve([])
          if (/pg_advisory_xact_lock/i.test(text)) return Promise.resolve([{ id: 'FY-XSD-WX-260521-0001' }])
          if (/SELECT\s+1\s+FROM\s+card_transactions/i.test(text) && /'扣款'/.test(text)) return Promise.resolve([])
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve([{ card_id: 'FY-CARD-DEDUCT', balance: cardBalance }])
          }
          if (/SELECT\s+customer_type/i.test(text)) return Promise.resolve([])
          return Promise.resolve({})
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(opts.skuRows) }),
          }),
        }),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((v: any) => {
            captured.insertValues.push(v)
            if (v && 'saleOrderId' in v && 'saleOrderType' in v) opts.onInsertOrder?.(v)
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

  it('priceDiff > 0 且储值卡全额抵扣 → 即时扣卡 + status=已支付 + payment_method=无 + received=card', async () => {
    let capturedOrder: any
    const captured = mockConvDeductTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
      }],
      cardBalance: 1000,
      onInsertOrder: (v) => { capturedOrder = v },
    })

    // totalIn=500, totalOut=300 → priceDiff=200；prepaidCardAmount=200 → 全额抵扣
    const result = await createConversionOrder({ ...baseConvData, prepaidCardAmount: 200 })

    expect(result.success).toBe(true)
    expect(result.priceDiff).toBe(200)
    expect(result.prepaidCardAmount).toBe(200)
    expect(capturedOrder.totalAmount).toBe('200.00')
    expect(capturedOrder.payableAmount).toBe('0.00')
    expect(capturedOrder.prepaidCardAmount).toBe('200.00')
    expect(capturedOrder.received).toBe('200.00')
    expect(capturedOrder.status).toBe('已支付')
    expect(capturedOrder.paymentMethod).toBe('无')
    // 即时扣卡 SQL 都触发
    expect(captured.execTexts.some((t) => /UPDATE\s+prepaid_cards/i.test(t))).toBe(true)
    expect(captured.execTexts.some((t) => /INSERT\s+INTO\s+card_transactions/i.test(t))).toBe(true)
    expect(captured.execTexts.some((t) => /INSERT\s+INTO\s+sale_order_payments/i.test(t) && /储值卡抵扣/.test(t))).toBe(true)
    // 已支付 → 触发积分结算
    expect(settlePointsSafe).toHaveBeenCalledTimes(1)
  })

  it('priceDiff > 0 部分储值卡抵扣（payable>0）→ 待支付，不即时扣卡（延后到 confirmOffline/payNotify）', async () => {
    let capturedOrder: any
    const captured = mockConvDeductTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
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

    // priceDiff=200，抵扣 50 → payable=150 > 0
    const result = await createConversionOrder({ ...baseConvData, prepaidCardAmount: 50 })

    expect(result.success).toBe(true)
    expect(result.prepaidCardAmount).toBe(50)
    expect(capturedOrder.prepaidCardAmount).toBe('0.00')
    expect(capturedOrder.pendingPrepaidCardAmount).toBe('50.00')
    expect(capturedOrder.payableAmount).toBe('150.00')
    expect(capturedOrder.received).toBe('0')
    expect(capturedOrder.status).toBe('待支付')
    // 不即时扣卡（延后入账）
    expect(captured.execTexts.some((t) => /UPDATE\s+prepaid_cards/i.test(t))).toBe(false)
    expect(settlePointsSafe).not.toHaveBeenCalled()
  })

  it('充值卡抵扣超过补差额 → 拒绝且不写订单', async () => {
    const captured = mockConvDeductTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
      }],
    })

    const result = await createConversionOrder({ ...baseConvData, prepaidCardAmount: 200.01 })

    expect(result).toEqual({ success: false, message: '充值卡抵扣金额超过补差额' })
    expect(captured.insertValues).toHaveLength(0)
    expect(captured.execTexts.some((t) => /FROM\s+prepaid_cards/i.test(t))).toBe(false)
  })

  it('部分充值卡抵扣超过余额 → 拒绝且不写订单', async () => {
    const captured = mockConvDeductTx({
      heldRows: [{
        sale_item_id: 'card-1', store_id: 'store-1', item_direction: '购买',
        sku_id: 'sku-old-1', product_name: '老疗程',
        product_type: '疗程卡', session_count: 3, remaining_sessions: 3,
        quantity: 1, picked_up_quantity: 0, unit_price: '100.00',
        unit_real_price: '100.00', sales_category: '自销自耗', service_fee: '0',
        client_user_id: 'user-1', order_status: '已支付', product_kind: '护理项目',
      }],
      skuRows: [{
        skuId: 'sku-new-1', price: '500.00', serviceFee: '0', sessionCount: 10,
        productType: '疗程卡', salesCategory: '自销自耗',
      }],
      cardBalance: 99,
    })

    const result = await createConversionOrder({ ...baseConvData, prepaidCardAmount: 100 })

    expect(result).toEqual({ success: false, message: '充值卡余额不足' })
    expect(captured.insertValues).toHaveLength(0)
    expect(captured.execTexts.some((t) => /FROM\s+prepaid_cards/i.test(t))).toBe(true)
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
            product_name: 'xx', sales_category: '自销自耗',
          }]
          if (execCall === 2) return []
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
//   1. 全额现场 → 订单 '已支付'（线下保持 '待支付'，复合判定 payment_method='线下'） + 1 行首次支付 payments
//   2. 部分收款 → 订单 '部分支付' + 1 行首次支付 payments
//   3. 纯挂账（receivedAmount=0） → 订单 '待支付' + 无 payments 行
//   4. receivedAmount > payable_amount → 业务校验错
//   5. paymentMethod=微信 + 0 < receivedAmount < payable → first_payment_amount 落库 + status='待支付' + 不写 payments 行
//   6. 储值卡抵扣 + 部分现场 → 订单 '部分支付' + 2 行 payments（首次支付 + 储值卡抵扣）
//   7. 双写不变量：paid_amount = Σ(已支付 + 首次支付/回款/退款) amount

describe('createOrder — 线下开单不记款 + 线上首付（receivedAmount + 款项流水）', () => {
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
        execute: vi.fn().mockImplementation((sqlArg: any) => {
          const text: string = sqlArg?.__sqlText ?? ''
          if (/SELECT\s+card_id,\s*balance\s+FROM\s+prepaid_cards/i.test(text)) {
            return Promise.resolve([{ card_id: 'FY-CARD-TEST', balance: 1000 }])
          }
          return Promise.resolve([{ id: orderId }])
        }),
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

  it('1) 线下开单（未传 receivedAmount）→ 订单 "待支付" + received=0 + 无 payments 行（确认收款时才记账）', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P001', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
    })

    expect(result.success).toBe(true)
    // 线下：开单不收款，待支付 + received=0 + 无流水（实收在 confirmOfflinePayment 登记）
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.payableAmount).toBe('200.00')
    expect(bag.order.received).toBe('0.00')
    expect(bag.payments).toHaveLength(0)
  })

  it('2) 线下开单 + 传 receivedAmount（被后端忽略）→ 仍 "待支付" + received=0 + 无 payments', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P002', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      receivedAmount: 80, // 线下忽略，不在创建时记款
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.payableAmount).toBe('200.00')
    expect(bag.order.received).toBe('0.00')
    expect(bag.payments).toHaveLength(0)
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

  it('4) 线上 receivedAmount > payable_amount → 业务校验错（线下忽略入参，仅线上校验）', async () => {
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '微信',
      receivedAmount: 300, // payable = 200
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('不能超过应付实金')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('5) paymentMethod=微信 + 0<receivedAmount<payable → first_payment_amount 落库，status=待支付，不写 payments 行', async () => {
    // 2026-05-20 partial-payment-online ticket：放开线上调低，使用 first_payment_amount 让 QR 仅收首付
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260520-P005', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '微信',
      receivedAmount: 100, // < payable=200
    })

    expect(result.success).toBe(true)
    expect(result.status).toBe('待支付')
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.received).toBe('0.00') // 线上 create 时不进 received
    expect(bag.order.firstPaymentAmount).toBe('100.00')
    expect(bag.payments).toHaveLength(0) // 线上首付不写 payments 行，等 payNotify
  })

  it('5b) paymentMethod=微信 + receivedAmount=payable (全额) → 不落 first_payment_amount，走全额 QR', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260520-P005B', bag)

    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '微信',
      receivedAmount: 200, // = payable
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.firstPaymentAmount).toBeNull()
    expect(bag.payments).toHaveLength(0)
  })

  it('6) 线下 + 储值卡抵扣预选 → 订单 "待支付"，received=0，无 payments（扣卡 + 记账归 confirmOffline）', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P006', bag)

    // total=200；prepaidCard=60 → payable=140（写入 pending，扣卡在确认收款时执行）
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      prepaidCardAmount: 60,
      receivedAmount: 50, // 线下忽略
    })

    expect(result.success).toBe(true)
    expect(bag.order.status).toBe('待支付')
    expect(bag.order.prepaidCardAmount).toBe('0.00')
    expect(bag.order.pendingPrepaidCardAmount).toBe('60.00')
    expect(bag.order.payableAmount).toBe('140.00')
    expect(bag.order.received).toBe('0.00')
    expect(bag.payments).toHaveLength(0)
  })

  it('7) 双写不变量（create 阶段）：线下 received/prepaid 实付均为0，预选仅写 pending', async () => {
    const bag = freshBag()
    mockCreateTx('FY-XSD-WX-260424-P007', bag)

    // 场景：total=200 + prepaidCard=60 → payable=140
    const result = await createOrder({
      ...baseOrderData,
      paymentMethod: '线下',
      prepaidCardAmount: 60,
      receivedAmount: 120, // 线下忽略
    })

    expect(result.success).toBe(true)
    // 不变量：received == Σ(已支付 首次支付/回款/退款) == 0（创建时不记款）
    const received = Number(bag.order.received)
    const paymentsSum = bag.payments
      .filter(
        (p) =>
          p.status === '已支付' &&
          ['首次支付', '回款', '退款'].includes(p.changeType),
      )
      .reduce((s, p) => s + Number(p.amount), 0)
    expect(received).toBe(paymentsSum)
    expect(received).toBe(0)

    // prepaid_card_amount 只表示已结算实付；预选金额独立放 pending_prepaid_card_amount。
    const prepaidSnapshot = Number(bag.order.prepaidCardAmount)
    expect(prepaidSnapshot).toBe(0)
    expect(Number(bag.order.pendingPrepaidCardAmount)).toBe(60)
    expect(bag.payments).toHaveLength(0) // 创建时尚无任何 payments 行
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

describe('updatePerformanceAttributionDate — 一次性业绩归属日期调整', () => {
  const input = {
    saleOrderId: 'FY-XSD-WX-2608170001',
    performanceAttributionDate: '2026-08-24',
    expectedUpdatedAt: '2026-08-17T02:03:04.567Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue({
      ...mockSession,
      name: '店长甲',
      permissions: {
        ...mockSession.permissions,
        actions: ['sale_order:performance_attribution_update'],
      },
    })
    ;(isInScope as any).mockReturnValue(true)
  })

  function mockAttributionTransaction({
    adjustedAt = null,
    currentDate = '2026-08-17',
    updatedRows = [{
      performance_attribution_date: '2026-08-24',
      performance_attribution_adjusted_at: new Date('2026-08-17T03:00:00.000Z'),
      performance_attribution_adjusted_by: 'EMP-001',
      updated_at: new Date('2026-08-17T03:00:00.000Z'),
    }],
  }: {
    adjustedAt?: Date | null
    currentDate?: string
    updatedRows?: any[]
  } = {}) {
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        sale_order_id: input.saleOrderId,
        store_id: 'store-1',
        performance_attribution_date: currentDate,
        performance_attribution_adjusted_at: adjustedAt,
        original_order_date: '2026-08-17',
        min_performance_date: '2026-08-10',
        max_performance_date: '2026-08-24',
      }])
      .mockResolvedValueOnce(updatedRows)
    const tx = { execute, select: vi.fn(), insert: vi.fn() }
    ;(db.transaction as any).mockImplementation(async (fn: any) => fn(tx))
    return { tx, execute }
  }

  it('允许原始订单日期 +7 天边界，写入调整人、CAS 和审计日志', async () => {
    const { tx, execute } = mockAttributionTransaction()

    const result = await updatePerformanceAttributionDate(input)

    expect(result.success).toBe(true)
    expect(result.data.performanceAttributionDate).toBe('2026-08-24')
    expect(requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      'sale_order:performance_attribution_update',
    )
    expect(execute.mock.calls[0][0].__sqlText).toMatch(/FOR UPDATE/)
    expect(execute.mock.calls[1][0].__sqlText).toMatch(/performance_attribution_adjusted_at IS NULL/)
    expect(execute.mock.calls[1][0].__sqlText).toMatch(/date_trunc\('milliseconds', updated_at\)/)
    expect(logUpdate).toHaveBeenCalledWith(
      expect.anything(),
      'order.performanceAttribution.update',
      'sale_order',
      input.saleOrderId,
      { performanceAttributionDate: '2026-08-17' },
      expect.objectContaining({
        performanceAttributionDate: '2026-08-24',
        performanceAttributionAdjustedBy: 'EMP-001',
      }),
      tx,
    )
  })

  it('同日提交不消耗修改机会', async () => {
    const { execute } = mockAttributionTransaction({ currentDate: '2026-08-24' })

    await expect(updatePerformanceAttributionDate(input)).rejects.toThrow(/INVALID_PARAMS.*当前日期相同/)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(logUpdate).not.toHaveBeenCalled()
  })

  it('超出原始订单日期前后 7 天时拒绝', async () => {
    const { execute } = mockAttributionTransaction()

    await expect(updatePerformanceAttributionDate({
      ...input,
      performanceAttributionDate: '2026-08-25',
    })).rejects.toThrow(/INVALID_PARAMS.*前后 7 天/)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('已调整订单不允许再改', async () => {
    const { execute } = mockAttributionTransaction({
      adjustedAt: new Date('2026-08-17T02:30:00.000Z'),
    })

    await expect(updatePerformanceAttributionDate(input)).rejects.toThrow(/CONFLICT.*已经调整过/)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('订单版本已变化时 CAS 失败，不写审计日志', async () => {
    mockAttributionTransaction({ updatedRows: [] })

    await expect(updatePerformanceAttributionDate(input)).rejects.toThrow(/CONFLICT.*刷新后重试/)
    expect(logUpdate).not.toHaveBeenCalled()
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
    idempotencyHit?: boolean
    legacyCardIdempotencyHit?: boolean
  } = {}) {
    const captured = { insertValues: [] as Array<{ table: string; v: any }>, executed: [] as string[] }
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        execute: vi.fn().mockImplementation((arg: any) => {
          // 记录顺序（便于调试失败用例）
          const statement = String(arg?.__sqlText ?? '')
          captured.executed.push(statement)
          if (/SELECT \* FROM sale_orders[\s\S]*FOR UPDATE/.test(statement)) {
            return Promise.resolve(opts.lockedOrder ? [opts.lockedOrder] : [])
          }
          if (statement.includes("external_trade_info ->> 'adminRecordPaymentIdempotencyKey'")) {
            return Promise.resolve(opts.idempotencyHit ? [{ exists: 1 }] : [])
          }
          if (statement.includes('SELECT 1 FROM card_transactions') && statement.includes('external_ref')) {
            return Promise.resolve(opts.legacyCardIdempotencyHit ? [{ exists: 1 }] : [])
          }
          if (statement.includes('pg_advisory_xact_lock')) {
            return Promise.resolve([{ id: opts.orderIdGen ?? 'FY-HKD-WX-2604250001' }])
          }
          if (/SELECT card_id, balance FROM prepaid_cards[\s\S]*FOR UPDATE/.test(statement)) {
            return Promise.resolve(
              opts.cardBalance
                ? [{ card_id: opts.cardBalance.cardId, balance: opts.cardBalance.balance.toFixed(2) }]
                : [],
            )
          }
          if (/UPDATE prepaid_cards/.test(statement)) return Promise.resolve({})
          if (/AS new_received/.test(statement)) {
            return Promise.resolve([
              {
                new_received: opts.sumRow?.new_received ?? '0',
                new_prepaid: opts.sumRow?.new_prepaid ?? '0',
                new_refunded: '0',
              },
            ])
          }
          if (/UPDATE sale_orders[\s\S]*SET status/.test(statement)) {
            return Promise.resolve({ rowCount: opts.updateRowCount ?? 1 })
          }
          return Promise.resolve({})
        }),
        insert: vi.fn().mockImplementation((table: any) => ({
          values: vi.fn().mockImplementation((v: any) => {
            captured.insertValues.push({ table: String(table?.constructor?.name || 'unknown'), v })
            // 合并回款现金/储值卡行用 .returning({id}) 取回 id；直接 await 仍解析为 {}
            return Object.assign(Promise.resolve({}), { returning: vi.fn().mockResolvedValue([{ id: 1 }]) })
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
    // recordPayment 用 scopeCondition/isInScope 做门店校验；显式置 true 避免依赖前序 describe
    // 的 mockReturnValue 残留（clearAllMocks 不清返回值）导致 flaky OUT_OF_SCOPE。
    ;(isInScope as any).mockReturnValue(true)
    ;(db.execute as any).mockResolvedValue([])
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
    expect(captured.executed.some((statement) => statement.includes('first_payment_amount = NULL'))).toBe(true)
  })

  it('活动拉卡拉意图存续时拒绝线下入账且不产生资金副作用', async () => {
    const captured = mockRecordTx({
      lockedOrder: {
        ...lockedPartialOrder,
        lakala_out_order_no: 'FY-XSD-WX-260420-0001-P1',
        pending_prepaid_card_amount: '0.00',
      },
    })

    const result = await recordPayment(basePayload)

    expect(result).toEqual({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'PAYMENT_INTENT_ACTIVE: 订单存在进行中的在线支付，请等待支付结果或先取消在线支付',
      },
    })
    expect(captured.insertValues).toHaveLength(0)
    expect(captured.executed).toHaveLength(1)
  })

  it('混合在线支付仍有待结算储值卡时拒绝新线下入账', async () => {
    const captured = mockRecordTx({
      lockedOrder: {
        ...lockedPartialOrder,
        lakala_out_order_no: null,
        pending_prepaid_card_amount: '20.00',
      },
    })

    const result = await recordPayment(basePayload)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.code).toBe('CONFLICT')
    expect(captured.insertValues).toHaveLength(0)
    expect(captured.executed).toHaveLength(1)
  })

  it('储值卡同幂等键已成功时先返回原结果，不被活动在线意图阻断', async () => {
    const captured = mockRecordTx({
      lockedOrder: {
        ...lockedPartialOrder,
        lakala_out_order_no: 'FY-XSD-WX-260420-0001-P1',
        pending_prepaid_card_amount: '20.00',
      },
      idempotencyHit: true,
    })

    const result = await recordPayment({
      saleOrderId: basePayload.saleOrderId,
      repayAmount: 0,
      paymentMethod: '储值卡',
      prepaidCardAmount: 20,
      idempotencyKey: 'same-intent',
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.idempotent).toBe(true)
    expect(captured.insertValues).toHaveLength(0)
    expect(captured.executed).toHaveLength(2)
  })

  it('纯现金新幂等键写入稳定 payment 事实，不依赖 externalTxnId', async () => {
    const captured = mockRecordTx({
      lockedOrder: lockedPartialOrder,
      idempotencyHit: false,
      sumRow: { new_received: '200', new_prepaid: '0' },
    })

    const result = await recordPayment({
      saleOrderId: basePayload.saleOrderId,
      repayAmount: 100,
      paymentMethod: '线下',
      idempotencyKey: 'cash-attempt-2',
    })

    expect(result.success).toBe(true)
    expect(captured.insertValues).toHaveLength(1)
    expect(captured.insertValues[0].v).toMatchObject({
      changeType: '回款',
      externalTxnId: null,
      externalTradeInfo: { adminRecordPaymentIdempotencyKey: 'cash-attempt-2' },
    })
  })

  it('纯现金同键重试在首次已结清后仍幂等成功，早于退款/终态/活动意图检查', async () => {
    const captured = mockRecordTx({
      lockedOrder: {
        ...lockedPartialOrder,
        status: '已支付',
        received: '200.00',
        lakala_out_order_no: 'FY-XSD-WX-260420-0001_1786960800',
        pending_prepaid_card_amount: '20.00',
      },
      idempotencyHit: true,
    })

    const result = await recordPayment({
      saleOrderId: basePayload.saleOrderId,
      repayAmount: 100,
      paymentMethod: '线下',
      idempotencyKey: 'cash-attempt-1',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.idempotent).toBe(true)
      expect(result.data.refStatus).toBe('已支付')
    }
    expect(captured.executed).toHaveLength(2)
    expect(captured.insertValues).toHaveLength(0)
    expect(hasPendingRefund).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('纯储值卡同键重试在首次结清后直接返回，不再次锁卡或扣款', async () => {
    const captured = mockRecordTx({
      lockedOrder: {
        ...lockedPartialOrder,
        status: '已支付',
        received: '200.00',
        prepaid_card_amount: '100.00',
      },
      idempotencyHit: true,
    })

    const result = await recordPayment({
      saleOrderId: basePayload.saleOrderId,
      repayAmount: 0,
      paymentMethod: '储值卡',
      prepaidCardAmount: 100,
      idempotencyKey: 'card-attempt-1',
    })

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.idempotent).toBe(true)
    expect(captured.executed).toHaveLength(2)
    expect(captured.executed.some((statement) => /SELECT card_id, balance FROM prepaid_cards/.test(statement))).toBe(false)
    expect(captured.insertValues).toHaveLength(0)
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
      sumRow: { new_received: '200', new_prepaid: '100' }, // received(含抵扣) 100现金+100储值卡=200 = total → 已支付
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
      // 2026-04-26 sale-order-domain-refactor：FY-HKD 凭证单不再 INSERT 到 sale_orders，
      // card_transactions.ref_order_id 改指原销售单（满足 FK）；凭证单号改由 external_ref 承载。
      refOrderId: 'FY-XSD-WX-260420-0001',
      externalRef: 'card-repay-FY-HKD-WX-2604250001',
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

  it('线下回款不再强制 externalTxnId：未填流水号 → 成功，现金行 external_txn_id=null（2026-06-24 去校验）', async () => {
    const captured = mockRecordTx({
      lockedOrder: lockedPartialOrder,
      orderIdGen: 'FY-HKD-WX-2604250001',
      sumRow: { new_received: '200', new_prepaid: '0' },
    })

    const result = await recordPayment({
      saleOrderId: 'FY-XSD-WX-260420-0001',
      repayAmount: 100,
      paymentMethod: '线下',
      // externalTxnId 缺失：不再被拦截
    })

    expect(result.success).toBe(true)
    const paymentInsert = captured.insertValues[0].v
    expect(paymentInsert).toMatchObject({
      changeType: '回款',
      amount: '100.00',
      paymentMethod: '线下',
      externalTxnId: null,
    })
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

describe('freezeConversionRepaymentAmount — admin 在线转换回款金额冻结', () => {
  const lockedConversion = {
    sale_order_id: 'FY-XSD-WX-260420-0001',
    sale_order_type: '转换单',
    status: '部分支付',
    store_id: 'store-1',
    total_amount: '100.00',
    received: '0.00',
    refunded_amount: '0.00',
    first_payment_amount: null,
    pending_prepaid_card_amount: '0.00',
    lakala_out_order_no: null,
    legacy_source: null,
    is_experience_conversion: false,
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
    ;(isInScope as any).mockReturnValue(true)
  })

  function mockFreezeTx(locked: Record<string, any>, updateRowCount = 1) {
    const statements: string[] = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      let call = 0
      const tx = {
        execute: vi.fn().mockImplementation((arg: any) => {
          call += 1
          statements.push(String(arg?.__sqlText ?? ''))
          if (call === 1) return Promise.resolve([locked])
          return Promise.resolve({ rowCount: updateRowCount })
        }),
      }
      return fn(tx)
    })
    return statements
  }

  it('锁单后以 CAS 写入管理员选择的本次金额', async () => {
    const statements = mockFreezeTx(lockedConversion)

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result).toEqual({ success: true, data: { amount: 40, reused: false } })
    expect(statements[0]).toContain('FOR UPDATE')
    expect(statements[1]).toContain('first_payment_amount =')
    expect(statements[1]).not.toMatch(/SET[\s\S]*lakala_out_order_no\s*=/)
    expect(statements[1]).toContain('first_payment_amount IS NULL')
    expect(statements[1]).toContain('lakala_out_order_no IS NULL')
    expect(statements[1]).toContain('received =')
    expect(statements[1]).toContain('refunded_amount =')
  })

  it('退款后的欠款按 total - received + refunded_amount 冻结', async () => {
    mockFreezeTx({
      ...lockedConversion,
      received: '80.00',
      refunded_amount: '20.00',
    })

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result).toEqual({ success: true, data: { amount: 40, reused: false } })
  })

  it('同额活动意图可幂等复用，不重复更新', async () => {
    const statements = mockFreezeTx({ ...lockedConversion, first_payment_amount: '40.00' })

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result).toEqual({ success: true, data: { amount: 40, reused: true } })
    expect(statements).toHaveLength(1)
  })

  it('拒绝用不同金额覆盖已有活动意图', async () => {
    mockFreezeTx({ ...lockedConversion, first_payment_amount: '50.00' })

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toContain('已有 ¥50.00 在线回款意图')
    }
  })

  it('历史 unrestricted O1 即使 first_payment_amount 为空也不得解绑渠道单', async () => {
    const statements = mockFreezeTx({
      ...lockedConversion,
      first_payment_amount: null,
      lakala_out_order_no: 'FY-XSD-WX-260420-0001_1786960800',
    })

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toContain('PAYMENT_INTENT_ACTIVE')
    }
    expect(statements).toHaveLength(1)
  })

  it('CAS 未命中时返回并发冲突', async () => {
    mockFreezeTx(lockedConversion, 0)

    const result = await freezeConversionRepaymentAmount({
      saleOrderId: lockedConversion.sale_order_id,
      amount: 40,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toContain('订单金额或状态已变化')
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
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
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
        productType: '疗程卡' as const,
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
        productType: '疗程卡' as const,
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
        productType: '疗程卡' as const,
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
          productType: '疗程卡' as const,
          sessionCount: null,
          unitPrice: '0.10',
          unitRealPrice: '0.10',
          quantity: 3,
          salesCategory: '自销自耗' as const,
        },
        {
          skuId: 'sku-float-b',
          productName: '浮点 B',
          productType: '疗程卡' as const,
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
        productType: '疗程卡' as const,
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

// ── deleteOrder — 物理删除守卫 + 级联 ────────────────────────────────────

describe('deleteOrder — 守卫 + 级联删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  /** FIFO 顺序返回 db.select().from().where().limit() 结果 */
  function enqueueSelect(resultsList: any[][]) {
    let i = 0
    ;(db.select as any).mockImplementation(() => {
      const rows = resultsList[i++] ?? []
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.limit = vi.fn().mockResolvedValue(rows)
      return chain
    })
  }
  /** FIFO 顺序返回 db.execute() 结果（point/card/downstream 三次） */
  function enqueueExecute(resultsList: any[][]) {
    let i = 0
    ;(db.execute as any).mockImplementation(async () => resultsList[i++] ?? [])
  }
  function setupTx(deleteCount: number) {
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }),
        execute: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: deleteCount }) }),
      }
      return fn(tx)
    })
  }
  const okOrder = { status: '待支付', received: '0', customerName: '甲', totalAmount: '200.00', saleOrderType: '销售单' }

  it('订单不存在 → 拒绝，不进事务', async () => {
    enqueueSelect([[]])
    const result = await deleteOrder('FY-404')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('有实收 → 拒绝（财务保护）', async () => {
    enqueueSelect([[{ ...okOrder, received: '100' }]])
    const result = await deleteOrder('FY-1')
    expect(result.success).toBe(false)
    expect(result.message).toContain('实收')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('已支付状态 → 拒绝', async () => {
    enqueueSelect([[{ ...okOrder, status: '已支付' }]])
    const result = await deleteOrder('FY-2')
    expect(result.success).toBe(false)
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('存在已支付款项流水 → 拒绝', async () => {
    enqueueSelect([[okOrder], [{ id: 1 }]]) // order, paidPayment
    const result = await deleteOrder('FY-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('款项流水')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('关联积分流水 → 拒绝', async () => {
    enqueueSelect([[okOrder], []]) // order, paidPayment(none)
    enqueueExecute([[{ one: 1 }]]) // ptRef hit
    const result = await deleteOrder('FY-4')
    expect(result.success).toBe(false)
    expect(result.message).toContain('积分')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('明细被服务/提货/预约引用 → 拒绝', async () => {
    enqueueSelect([[okOrder], []])
    enqueueExecute([[], [], [{ one: 1 }]]) // pt none, ct none, downstream hit
    const result = await deleteOrder('FY-5')
    expect(result.success).toBe(false)
    expect(result.message).toContain('服务单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('被子单引用 → 拒绝', async () => {
    enqueueSelect([[okOrder], [], [{ id: 'FY-CHILD' }]]) // order, paidPayment, childOrder hit
    enqueueExecute([[], [], []])
    const result = await deleteOrder('FY-6')
    expect(result.success).toBe(false)
    expect(result.message).toContain('单据')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('干净测试单 → 级联删除成功 + 审计', async () => {
    enqueueSelect([[okOrder], [], []]) // order, paidPayment, childOrder
    enqueueExecute([[], [], []])
    setupTx(1)
    const { logOperation } = await import('@/lib/operation-log')
    const result = await deleteOrder('FY-OK')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession, 'order.delete', 'sale_order', 'FY-OK',
      expect.objectContaining({ snapshot: expect.any(Object) }),
    )
  })

  it('事务内主单删除 rowCount=0 → 回滚提示', async () => {
    enqueueSelect([[okOrder], [], []])
    enqueueExecute([[], [], []])
    setupTx(0)
    const result = await deleteOrder('FY-RACE')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
  })

  // ── 寄存单特例：未消耗（无 service_items/pickup/appointments 引用）则无视 status（含已支付）可删 ──
  const depOrder = {
    status: '已支付',
    received: '0',
    customerName: '老客',
    totalAmount: '0.00',
    saleOrderType: '寄存单',
  }

  it('干净寄存单（status=已支付、未消耗）→ 跳过资金守卫，级联删除成功 + 审计含 saleOrderType', async () => {
    // 寄存单路径 select 仅 order→childOrder 两次（paidPayment 被 if(!isDeposit) 跳过）
    enqueueSelect([[depOrder], []])
    enqueueExecute([[], [], []]) // pt / ct / downstream 全空
    setupTx(1)
    const { logOperation } = await import('@/lib/operation-log')
    const result = await deleteOrder('FY-DEP-1')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'order.delete',
      'sale_order',
      'FY-DEP-1',
      expect.objectContaining({ snapshot: expect.objectContaining({ saleOrderType: '寄存单' }) }),
    )
  })

  it('寄存单 + received>0 历史实收 → 仍可删（跳过 received/status/paidPayment 三道守卫）', async () => {
    enqueueSelect([[{ ...depOrder, received: '500.00' }], []])
    enqueueExecute([[], [], []])
    setupTx(1)
    const result = await deleteOrder('FY-DEP-2')
    expect(result.success).toBe(true)
    expect(db.transaction).toHaveBeenCalledOnce()
  })

  it('寄存单被服务/提货/预约引用 → 拒绝（downstream「未消耗」守卫对寄存单生效）', async () => {
    enqueueSelect([[depOrder], []])
    enqueueExecute([[], [], [{ one: 1 }]]) // downstream hit
    const result = await deleteOrder('FY-DEP-3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('服务单')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('寄存单被退款/转换子单引用 → 拒绝', async () => {
    enqueueSelect([[depOrder], [{ id: 'FY-CHILD' }]]) // childOrder hit
    enqueueExecute([[], [], []])
    const result = await deleteOrder('FY-DEP-4')
    expect(result.success).toBe(false)
    expect(result.message).toContain('单据')
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('寄存单事务内 sale_items 被并发 service_items FK 引用 → 23503 友好提示', async () => {
    enqueueSelect([[depOrder], []])
    enqueueExecute([[], [], []])
    // 并发：守卫读取后，事务内 DELETE sale_items 被 service_items FK（NO ACTION）拦下
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }) }),
        execute: vi.fn().mockRejectedValue({ code: '23503', constraint: 'service_items_sale_item_id_fkey' }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ count: 1 }) }),
      }
      return fn(tx)
    })
    const result = await deleteOrder('FY-DEP-RACE')
    expect(result.success).toBe(false)
    expect(result.message).toContain('关联业务数据')
  })

  // ── 历史已作废单特例：legacySource='workfine' AND status='已作废' ─────
  // 场景：店长把 WorkFine 导入的历史订单点错「作废」后，要清理掉以重新拉取 WorkFine 数据。
  // 守卫放宽：事务内 DELETE 守卫加 and(legacy='workfine', status='已作废') 分支放行；
  //          其他守卫（资金/已支付流水/积分储值卡/下游引用/子单引用）天然放行（received=0、无 items/流水/下游）。
  const legacyVoidedOrder = {
    status: '已作废',
    received: '0',
    customerName: '历史客',
    totalAmount: '1000.00',
    saleOrderType: '销售单',
    legacySource: 'workfine',
  }

  it('干净历史已作废单（legacySource=workfine, status=已作废, received=0, 无下游）→ 物理删除成功 + 审计含 legacySource + auditReason=historical_void_cleanup', async () => {
    // 历史已作废单路径 select：order→paidPayment→childOrder 共 3 次（!isDeposit）
    enqueueSelect([[legacyVoidedOrder], [], []])
    enqueueExecute([[], [], []]) // pt / ct / downstream 全空
    setupTx(1)
    const { logOperation } = await import('@/lib/operation-log')
    const result = await deleteOrder('FY-XSD2503210091')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.transaction).toHaveBeenCalledOnce()
    expect(logOperation).toHaveBeenCalledWith(
      mockSession,
      'order.delete',   // 保持原 action 名，向后兼容所有审计查询
      'sale_order',
      'FY-XSD2503210091',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          legacySource: 'workfine',
          auditReason: 'historical_void_cleanup',
        }),
      }),
    )
  })

  it('历史已作废单但 received>0（异常边界：理论上历史单不该有实收但保险）→ 资金守卫前置拦截，不进事务', async () => {
    // 资金守卫在事务前拦截（received>0 → 资金守卫返回「订单已有实收...不可删除」），不进事务
    enqueueSelect([[{ ...legacyVoidedOrder, received: '500.00' }]])
    const result = await deleteOrder('FY-LEGACY-RECEIVED')
    expect(result.success).toBe(false)
    expect(result.message).toContain('实收')
    expect(db.transaction).not.toHaveBeenCalled()
    expect(db.execute).not.toHaveBeenCalled() // 没走到积分/储值卡/下游守卫
  })

  it('已作废但 legacySource IS NULL（future-proof：原生单理论上不会 status=已作废）→ 事务守卫新分支不放行', async () => {
    // 走完业务守卫全放行（received=0, status 不在白名单但前置守卫未拦），进事务后 DELETE 命中 0 行 → 回滚 + 「订单状态已变更」
    enqueueSelect([[{ ...legacyVoidedOrder, legacySource: null }], [], []])
    enqueueExecute([[], [], []])
    setupTx(0)   // 事务内 DELETE rowCount=0 模拟守卫拒绝
    const result = await deleteOrder('FY-NATIVE-VOIDED')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已变更')
    // 关键：原生单即使 status='已作废' 也不能删除 —— 这是新分支最易回归的边界
  })
})

describe('exportAllocationOrders — 销售提成三态导出（已分配明细 + 待分配占位行）', () => {
  // 自引用 chain：支持直接 await orderBy(...) 与旧的 .limit() 收口，抗 JOIN 增减
  function makeChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn().mockResolvedValue(rows),
    })
    return chain
  }

  /** worker 分页链：limit(...).offset(...) 后仍可直接 await。 */
  function makePagedChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
    })
    return chain
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(scopeCondition as any).mockReturnValue(undefined)
  })

  // 已分配段 raw：含分配明细列（sale_payment_item_allocations 来源）
  const allocatedRaw = {
    market: '九江', storeName: '南昌英伦店', saleOrderId: 'FY-XSD-WX-2606080027',
    saleOrderType: '销售单', documentType: '售后',
    customerName: '张凯顾客', customerPhone: '13617216903', customerSource: '老带新', promoterEmployeeName: '王推荐', fallbackName: null, fallbackPhone: null,
    productType: '疗程卡', categoryL1: '护理项目', categoryL2: '圣源养心',
    productName: '【王牌】疼痛管理', sessionCount: 10, paidUnusedSessions: 10,
    saleAmount: '5200.00', prepaidCardAmount: '0.00', received: '3600.00', refundedAmount: '300.00',
    unitRealPrice: '300.00', status: '部分支付',
    payAllocStatus: '已分配', orderAllocStatus: '待分配',
    employeeName: '熊岚欢', positionName: '美容师',
    allocationRatio: '0.30', allocationAmount: '1080.00', commissionRate: '0.1500', commissionAmount: '162.00',
    isActivity: false, isMembershipUpgrade: false,
    salesCategory: '自销自耗', customerType: '会员客', openedByName: '张凯',
    payPaidAt: new Date('2026-06-08T16:59:49.000Z'), orderPaidAt: null, remark: null,
    sortDatetime: new Date('2026-06-08T16:59:49.000Z'),
  }

  // 待分配段 raw：无分配明细列（select 里就没这些字段），状态=待分配
  const pendingRaw = {
    market: '九江', storeName: '南昌蓝莱店', saleOrderId: 'FY-XSD-WX-2607100038',
    saleOrderType: '销售单', documentType: null,
    customerName: '樊颖', customerPhone: null, customerSource: '抖音', promoterEmployeeName: '李推荐', fallbackName: null, fallbackPhone: null,
    productType: '家居产品', categoryL1: null, categoryL2: null, productName: '家居B',
    sessionCount: null, paidUnusedSessions: null,
    saleAmount: '211.00', prepaidCardAmount: '0.00', received: '211.00', refundedAmount: '0.00',
    unitRealPrice: '211.00', status: '已支付',
    payAllocStatus: '待分配', orderAllocStatus: '待分配',
    isActivity: false, isMembershipUpgrade: false,
    salesCategory: '自销自耗', customerType: '流量客', openedByName: '某某',
    payPaidAt: new Date('2026-07-10T21:30:57.000Z'), orderPaidAt: null, remark: null,
    sortDatetime: new Date('2026-07-10T21:30:57.000Z'),
  }

  it('「待分配」→ 只查待分配段，返回占位行（分配/提成列 null，状态=待分配，商品字段仍填）', async () => {
    ;(db.select as any).mockImplementation(() => makeChain([pendingRaw]))
    const { rows, truncated } = await exportAllocationOrders({ allocStatus: '待分配' })

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    expect(db.select).toHaveBeenCalledTimes(1) // 不查已分配段
    const r = rows[0]
    expect(r.allocationStatus).toBe('待分配')
    expect(r.employeeName).toBeNull()
    expect(r.positionName).toBeNull()
    expect(r.allocationRatio).toBeNull()
    expect(r.allocationAmount).toBeNull()
    expect(r.commissionRate).toBeNull()
    expect(r.commissionAmount).toBeNull()
    expect(r.saleAmount).toBe(211) // 商品行字段仍填
    expect(r.productName).toBe('家居B')
    expect(r.customerSource).toBe('抖音')
    expect(r.promoterEmployeeName).toBe('李推荐')
  })

  it('「已分配」→ 只查已分配段，字段映射 + 回款级状态优先', async () => {
    ;(db.select as any).mockImplementation(() => makeChain([allocatedRaw]))
    const { rows, truncated } = await exportAllocationOrders({ allocStatus: '已分配' })

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    expect(db.select).toHaveBeenCalledTimes(1) // 不查待分配段
    const r = rows[0]
    expect(r.allocationAmount).toBe(1080)
    expect(r.commissionAmount).toBe(162)
    expect(r.allocationStatus).toBe('已分配') // 回款级优先
    expect(r.employeeName).toBe('熊岚欢')
    expect(r.allocationRatio).toBe('0.30')
    expect(r.customerSource).toBe('老带新')
    expect(r.promoterEmployeeName).toBe('王推荐')
  })

  it('「全部」(缺省) → 两段都查，按下单时间 desc 合并（待分配 07-10 在前，已分配 06-08 在后）', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      return makeChain(call === 1 ? [allocatedRaw] : [pendingRaw])
    })

    const { rows, truncated } = await exportAllocationOrders({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(2)
    expect(db.select).toHaveBeenCalledTimes(2)
    expect(rows[0].productName).toBe('家居B') // 待分配（时间较新）在前
    expect(rows[0].employeeName).toBeNull()
    expect(rows[1].productName).toBe('【王牌】疼痛管理') // 已分配
    expect(rows[1].employeeName).toBe('熊岚欢')
  })

  it('worker 分页跨两段来源推进独立游标，不重复也不遗漏', async () => {
    const allocatedNewest = {
      ...allocatedRaw,
      saleOrderId: 'ALLOC-NEW',
      sortDatetime: new Date('2026-07-04T00:00:00.000Z'),
    }
    const allocatedOldest = {
      ...allocatedRaw,
      saleOrderId: 'ALLOC-OLD',
      sortDatetime: new Date('2026-07-02T00:00:00.000Z'),
    }
    const pendingNewest = {
      ...pendingRaw,
      saleOrderId: 'PENDING-NEW',
      sortDatetime: new Date('2026-07-03T00:00:00.000Z'),
    }
    const pendingOldest = {
      ...pendingRaw,
      saleOrderId: 'PENDING-OLD',
      sortDatetime: new Date('2026-07-01T00:00:00.000Z'),
    }
    const results = [
      [allocatedNewest, allocatedOldest], [pendingNewest, pendingOldest],
      [allocatedOldest], [pendingNewest, pendingOldest],
      [allocatedOldest], [pendingOldest],
      [], [pendingOldest],
    ]
    let call = 0
    ;(db.select as any).mockImplementation(() => makePagedChain(results[call++] ?? []))

    const first = await exportAllocationOrders({}, { limit: 1 })
    const second = await exportAllocationOrders({}, { limit: 1, cursor: first.nextCursor })
    const third = await exportAllocationOrders({}, { limit: 1, cursor: second.nextCursor })
    const fourth = await exportAllocationOrders({}, { limit: 1, cursor: third.nextCursor })

    expect(first.nextCursor).toEqual({ allocatedOffset: 1, pendingOffset: 0 })
    expect(second.nextCursor).toEqual({ allocatedOffset: 1, pendingOffset: 1 })
    expect(third.nextCursor).toEqual({ allocatedOffset: 2, pendingOffset: 1 })
    expect(fourth.hasMore).toBe(false)
    expect([
      ...first.rows,
      ...second.rows,
      ...third.rows,
      ...fourth.rows,
    ].map((row) => row.saleOrderId)).toEqual([
      'ALLOC-NEW',
      'PENDING-NEW',
      'ALLOC-OLD',
      'PENDING-OLD',
    ])
  })

  it('「已分配」回款级缺失→状态/支付时间回退订单级；顾客回退订单快照；null 提成透传', async () => {
    const rawRow = {
      ...allocatedRaw,
      customerName: null, customerPhone: null, fallbackName: '快照顾客', fallbackPhone: '13800000000',
      payAllocStatus: null, orderAllocStatus: '已分配',
      payPaidAt: null, orderPaidAt: new Date('2026-06-08T16:14:58.000Z'),
      commissionRate: null, commissionAmount: null,
      productType: '家居产品', productName: '产品', saleAmount: '68.00', received: '58.00', unitRealPrice: '68.00',
    }
    ;(db.select as any).mockImplementation(() => makeChain([rawRow]))

    const { rows } = await exportAllocationOrders({ allocStatus: '已分配' })

    const r = rows[0]
    expect(r.customerName).toBe('快照顾客') // 回退订单快照
    expect(r.customerPhone).toBe('13800000000')
    expect(r.allocationStatus).toBe('已分配') // payAllocStatus null → orderAllocStatus
    expect(r.commissionRate).toBeNull()
    expect(r.commissionAmount).toBeNull()
    expect(r.paidAt).toBe(new Date('2026-06-08T16:14:58.000Z').toISOString()) // 回退订单级 paidAt
  })

  it('会员升级单：isMembershipUpgrade 透传到导出行', async () => {
    const rawRow = { ...allocatedRaw, isMembershipUpgrade: true, saleOrderId: 'FY-UP-1' }
    ;(db.select as any).mockImplementation(() => makeChain([rawRow]))

    const { rows } = await exportAllocationOrders({ allocStatus: '已分配' })

    expect(rows).toHaveLength(1)
    expect(rows[0].isMembershipUpgrade).toBe(true)
  })

  it('超过旧上限也返回全量且不标记截断', async () => {
    const many = Array.from({ length: 10001 }, (_, i) => ({
      saleOrderId: `FY-${i}`, isActivity: false, sortDatetime: new Date(),
    }))
    ;(db.select as any).mockImplementation(() => makeChain(many))

    const { rows, truncated } = await exportAllocationOrders({ allocStatus: '已分配' })

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(10001)
  })
})

/**
 * exportOrders（订单管理列表导出，明细级一行一 sale_items，迁移 0077 后）
 *
 * 与 exportAllocationOrders 区别：以 sale_items 为起点（不是 sale_payment_item_allocations），
 * 不分摊 sale_allations；订单基础字段在每条 item 行重复，行级字段（商品类型/品质/次数/单价）按 item 各填。
 */
describe('exportOrders — 订单明细导出（migration 0077 后）', () => {
  // sale_items 为起点的链式 mock：支持直接 await orderBy(...) 与旧的 .limit() 收口
  function makeChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      rightJoin: vi.fn(() => chain),
      fullJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn().mockResolvedValue(rows),
      offset: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      having: vi.fn(() => chain),
    })
    return chain
  }

  /** worker 分页链：limit(...).offset(...) 后仍可直接 await。 */
  function makePagedChain(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      rightJoin: vi.fn(() => chain),
      fullJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      having: vi.fn(() => chain),
    })
    return chain
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(scopeCondition as any).mockReturnValue(undefined)
    // exportOrders 额外查询已入账款项汇总；未为该测试显式设置时默认没有流水。
    ;(db.select as any).mockReset()
    ;(db.select as any).mockImplementation(() => makeChain([]))
  })

  it('明细级一行一 item：订单基础字段重复，行级字段按 item 各填；isMembershipUpgrade 已 select', async () => {
    const rawA = {
      marketName: '九江',
      storeName: '南昌英伦店',
      saleOrderId: 'FY-XSD-WX-2606080027',
      saleOrderType: '销售单',
      documentType: '售后',
      status: '部分支付',
      custName: '张凯顾客',
      custPhone: '13617216903',
      customerSource: '老带新',
      promoterEmployeeName: '王推荐',
      fallbackName: null,
      fallbackPhone: null,
      totalAmount: '3000.00',   // 行应付（商品行口径；行A，与行B 2200 之和=订单总额 5200）
      prepaidCardAmount: '555.56',
      cashAmount: '1444.44',
      orderReceived: '3600.00',
      received: '2000.00',      // 行实付（商品行口径；行A，与行B 1600 之和=订单总实付 3600）
      refundedAmount: '300.00',
      paymentMethod: '微信',
      isMembershipUpgrade: true,
      isActivity: false,
      customerType: '会员客',
      openedByName: '张凯',
      saleOrderDatetime: new Date('2026-06-08T16:00:00.000Z'),
      createdAt: new Date('2026-06-08T16:05:00.000Z'),
      remark: '备注A',
      productType: '疗程卡',
      salesCategory: '自销自耗',
      productName: '【王牌】疼痛管理',
      sessionCount: 10,
      paidUnusedSessions: 8,
      unitRealPrice: '300.00',
      categoryL1: '护理项目',
      categoryL2: '圣源养心',
    }
    const rawB = {
      ...rawA,
      productName: '【王牌】肩颈舒缓',
      sessionCount: 6,
      paidUnusedSessions: 4,
      unitRealPrice: '500.00',
      totalAmount: '2200.00',   // 行应付（行B）
      received: '1600.00',      // 行实付（行B）
      prepaidCardAmount: '444.44',
      cashAmount: '1155.56',
      saleItemId: 'item-2',
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain([rawA, rawB]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))

    const { rows, truncated } = await exportOrders({})

    expect(truncated).toBe(false)
    // 一行一 item，同订单号重复，但 productName 区分
    expect(rows).toHaveLength(2)
    expect(rows[0].saleOrderId).toBe('FY-XSD-WX-2606080027')
    expect(rows[1].saleOrderId).toBe('FY-XSD-WX-2606080027')
    expect(rows[0].productName).toBe('【王牌】疼痛管理')
    expect(rows[1].productName).toBe('【王牌】肩颈舒缓')
    // 关键：是否纳客已 select 并透传（迁移 0077 双库已迁）
    expect(rows[0].isMembershipUpgrade).toBe(true)
    expect(rows[0].isActivity).toBe(false)
    // 订单级
    expect(rows[0].marketName).toBe('九江')
    expect(rows[0].storeName).toBe('南昌英伦店')
    expect(rows[0].customerName).toBe('张凯顾客')
    expect(rows[0].clientPhone).toBe('13617216903')
    expect(rows[0].customerSource).toBe('老带新')
    expect(rows[0].promoterEmployeeName).toBe('王推荐')
    expect(rows[0].paymentMethod).toBe('微信')
    // 金额列走商品行口径：订单金额=sale_items.sale_amount、实付=sale_items.received（同单多行各不同，可正确求和）
    expect(rows[0].totalAmount).toBe('3000.00')   // 行A应付
    expect(rows[0].received).toBe('2000.00')      // 行A实付
    expect(rows[1].totalAmount).toBe('2200.00')   // 行B应付（+行A 3000 = 订单总额 5200）
    expect(rows[1].received).toBe('1600.00')      // 行B实付（+行A 2000 = 订单总实付 3600）
    // 两个新列均为行级持久化分摊；各行 card + cash = received，跨行 card 合计精确为 1000。
    expect(rows[0].prepaidCardAmount).toBe('555.56')
    expect(rows[1].prepaidCardAmount).toBe('444.44')
    expect(rows[0].cashAmount).toBe('1444.44')
    expect(rows[1].cashAmount).toBe('1155.56')
    for (const row of rows) {
      expect(Number(row.received)).toBe(Number(row.prepaidCardAmount) + Number(row.cashAmount))
    }
    expect(rows.reduce((sum, row) => sum + Number(row.prepaidCardAmount), 0)).toBe(1000)
    // 行级
    expect(rows[0].productType).toBe('疗程卡')
    expect(rows[0].categoryL1).toBe('护理项目')
    expect(rows[0].categoryL2).toBe('圣源养心')
    expect(rows[0].sessionCount).toBe(10)
    expect(rows[0].paidUnusedSessions).toBe(8)
    expect(rows[0].unitRealPrice).toBe(300) // number 化
    expect(rows[0].salesCategory).toBe('自销自耗')
    expect(rows[0].customerType).toBe('会员客')
    // 时间 ISO 化
    expect(rows[0].saleOrderDatetime).toBe('2026-06-08T16:00:00.000Z')
    expect(rows[0].createdAt).toBe('2026-06-08T16:05:00.000Z')
  })

  it('clientUserId 为 NULL → customerType=null 由前端 fallback「未注册」（SQL 不预设）', async () => {
    const rawRow = {
      marketName: '九江', storeName: '店', saleOrderId: 'FY-1',
      saleOrderType: '销售单', documentType: null, status: '已支付',
      custName: null, custPhone: null, customerSource: null, promoterEmployeeName: null, fallbackName: '快照顾客', fallbackPhone: '13800000000',
      totalAmount: '0.01', prepaidCardAmount: '0.00', received: '0.01', refundedAmount: '0.00',
      paymentMethod: '无', isMembershipUpgrade: false, isActivity: false,
      customerType: null, openedByName: '测试', remark: null,
      saleOrderDatetime: new Date('2026-06-01T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      productType: null, salesCategory: null, productName: null,
      sessionCount: null, paidUnusedSessions: null, unitRealPrice: null,
      categoryL1: null, categoryL2: null,
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    // SQL 端 customerType 为 null，由前端「顾客类型」列 accessor 执行 r.customerType ?? '未注册'
    expect(rows[0].customerType).toBeNull()
    // 顾客名走 fallback：client.name=null → sale_orders.customer_name='快照顾客'
    expect(rows[0].customerName).toBe('快照顾客')
    expect(rows[0].clientPhone).toBe('13800000000')
    expect(rows[0].customerSource).toBeNull()
    expect(rows[0].promoterEmployeeName).toBeNull()
  })

  it('非次数卡（家居产品）：sessionCount/paidUnusedSessions NULL 透传给前端 → 「—」', async () => {
    const rawRow = {
      marketName: '九江', storeName: '店', saleOrderId: 'FY-2',
      saleOrderType: '销售单', documentType: null, status: '已支付',
      custName: null, custPhone: null, fallbackName: '甲', fallbackPhone: null,
      totalAmount: '580.00', prepaidCardAmount: '0.00', received: '580.00', refundedAmount: '0.00',
      paymentMethod: '线下', isMembershipUpgrade: false, isActivity: false,
      customerType: '流量客', openedByName: '员工',
      remark: null, saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: '家居产品',
      salesCategory: '他销他耗',
      productName: '精华液',
      sessionCount: null, // 非次数卡 → NULL
      paidUnusedSessions: null,
      unitRealPrice: '580.00',
      categoryL1: '家居产品',
      categoryL2: '精华液',
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows[0].productType).toBe('家居产品')
    expect(rows[0].sessionCount).toBeNull()
    expect(rows[0].paidUnusedSessions).toBeNull()
  })

  it('unitRealPrice 用优惠后价 string → number 化便于 Excel 求和', async () => {
    const rawRow = {
      marketName: 'X', storeName: 'Y', saleOrderId: 'FY-3',
      saleOrderType: '销售单', documentType: null, status: '已支付',
      custName: '甲', custPhone: null, fallbackName: null, fallbackPhone: null,
      totalAmount: '158.50', prepaidCardAmount: '0.00', received: '158.50', refundedAmount: '0.00',
      paymentMethod: '微信', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null,
      remark: null, saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: '疗程卡', salesCategory: '自销自耗',
      productName: '套餐', sessionCount: 1, paidUnusedSessions: 1,
      unitRealPrice: '158.50', categoryL1: null, categoryL2: null,
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(typeof rows[0].unitRealPrice).toBe('number')
    expect(rows[0].unitRealPrice).toBe(158.5)
  })

  it('超过旧 item 上限也返回全量且不标记截断', async () => {
    const row = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-X', saleOrderType: '销售单',
      documentType: null, status: '已支付', custName: null, custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '0', prepaidCardAmount: '0', received: '0', refundedAmount: '0',
      paymentMethod: null, isMembershipUpgrade: false, isActivity: false,
      customerType: null, openedByName: null, remark: null,
      saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: null, salesCategory: null, productName: null,
      sessionCount: null, paidUnusedSessions: null, unitRealPrice: null,
      categoryL1: null, categoryL2: null,
    }
    const many = new Array(100001).fill(row)
    ;(db.select as any).mockReturnValueOnce(makeChain(many)).mockReturnValueOnce(makeChain([]))

    const { rows, truncated } = await exportOrders({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(100001)
  })

  it('混合来源合并后超过旧上限也返回全量且不标记截断', async () => {
    const item = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-ITEM', saleOrderType: '销售单',
      documentType: null, status: '已支付', custName: null, custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '0', prepaidCardAmount: '0', received: '0', refundedAmount: '0',
      paymentMethod: null, isMembershipUpgrade: false, isActivity: false,
      customerType: null, openedByName: null, remark: null,
      saleOrderDatetime: new Date('2026-07-02T00:00:00.000Z'),
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
      productType: null, salesCategory: null, productName: null,
      sessionCount: null, paidUnusedSessions: null, unitRealPrice: null,
      categoryL1: null, categoryL2: null,
    }
    const recharge = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-RECHARGE', saleOrderType: '充值单',
      documentType: null, status: '已支付', custName: null, custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '0', prepaidCardAmount: '0', received: '0', refundedAmount: '0',
      paymentMethod: null, isMembershipUpgrade: false, isActivity: false,
      customerType: null, openedByName: null, remark: null,
      saleOrderDatetime: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain(new Array(50000).fill(item)))
      .mockReturnValueOnce(makeChain(new Array(50001).fill(recharge)))

    const { rows, truncated } = await exportOrders({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(100001)
  })

  it('worker 分页跨商品行和充值单推进独立游标，不重复也不遗漏', async () => {
    const makeItem = (saleOrderId: string, sourceId: string, date: string) => ({
      sourceId,
      saleOrderId,
      saleOrderType: '销售单',
      totalAmount: '100.00',
      prepaidCardAmount: '0.00',
      orderReceived: '100.00',
      received: '100.00',
      refundedAmount: '0.00',
      saleOrderDatetime: new Date(date),
      createdAt: new Date(date),
      isMembershipUpgrade: false,
      isActivity: false,
      productType: '疗程卡',
      sessionCount: 1,
      unitRealPrice: '100.00',
    })
    const makeRecharge = (saleOrderId: string, date: string) => ({
      sourceId: saleOrderId,
      saleOrderId,
      saleOrderType: '充值单',
      totalAmount: '100.00',
      prepaidCardAmount: '0.00',
      orderReceived: '100.00',
      received: '100.00',
      refundedAmount: '0.00',
      saleOrderDatetime: new Date(date),
      createdAt: new Date(date),
      isMembershipUpgrade: false,
      isActivity: false,
    })
    const itemNewest = makeItem('ITEM-NEW', 'item-new', '2026-07-04T00:00:00.000Z')
    const itemOldest = makeItem('ITEM-OLD', 'item-old', '2026-07-02T00:00:00.000Z')
    const rechargeNewest = makeRecharge('RECHARGE-NEW', '2026-07-03T00:00:00.000Z')
    const rechargeOldest = makeRecharge('RECHARGE-OLD', '2026-07-01T00:00:00.000Z')
    // 每页依次为：商品行查询、充值单查询、转换差额储值金查询。
    const results = [
      [itemNewest, itemOldest], [rechargeNewest, rechargeOldest], [],
      [itemOldest], [rechargeNewest, rechargeOldest], [],
      [itemOldest], [rechargeOldest], [],
      [], [rechargeOldest], [],
    ]
    let call = 0
    ;(db.select as any).mockImplementation(() => makePagedChain(results[call++] ?? []))

    const first = await exportOrders({}, { limit: 1 })
    const second = await exportOrders({}, { limit: 1, cursor: first.nextCursor })
    const third = await exportOrders({}, { limit: 1, cursor: second.nextCursor })
    const fourth = await exportOrders({}, { limit: 1, cursor: third.nextCursor })

    expect(first.nextCursor).toEqual({ itemOffset: 1, rechargeOffset: 0, cardCreditOffset: 0 })
    expect(second.nextCursor).toEqual({ itemOffset: 1, rechargeOffset: 1, cardCreditOffset: 0 })
    expect(third.nextCursor).toEqual({ itemOffset: 2, rechargeOffset: 1, cardCreditOffset: 0 })
    expect(fourth.hasMore).toBe(false)
    expect([
      ...first.rows,
      ...second.rows,
      ...third.rows,
      ...fourth.rows,
    ].map((row) => row.saleOrderId)).toEqual([
      'ITEM-NEW',
      'RECHARGE-NEW',
      'ITEM-OLD',
      'RECHARGE-OLD',
    ])
  })

  it('费用列（totalAmount/received/refundedAmount）：prepaidCardAmount 等缺失 fallback 0', async () => {
    const rawRow = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-4',
      saleOrderType: '销售单', documentType: null, status: '已支付',
      custName: '甲', custPhone: null, fallbackName: null, fallbackPhone: null,
      totalAmount: '100.00',
      prepaidCardAmount: null, // 防御性 fallback（新列 DB 实际为 NOT NULL）
      cashAmount: null,
      received: null,
      refundedAmount: null,
      paymentMethod: null, isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: null, salesCategory: null, productName: null,
      sessionCount: null, paidUnusedSessions: null, unitRealPrice: null,
      categoryL1: null, categoryL2: null,
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows[0].prepaidCardAmount).toBe('0.00')
    expect(rows[0].cashAmount).toBe('0.00')
    expect(rows[0].received).toBe('0')
    expect(rows[0].refundedAmount).toBe('0')
  })

  it('寄存单：total=0 设计 + received 真金实付 → 5 金额列留空避免误导（item 级列照常透传）', async () => {
    const rawRow = {
      marketName: '九江', storeName: '南昌英伦店', saleOrderId: 'FY-XSD-WX-2607100001',
      saleOrderType: '寄存单', documentType: '售后', status: '已支付',
      custName: '杜佳月', custPhone: '15070000581', fallbackName: null, fallbackPhone: null,
      totalAmount: '0.00', // 寄存单 total 设计为 0
      prepaidCardAmount: '0.00',
      received: '3900.00', // 真金实付（「寄存单初始化实收」回款行写入）
      refundedAmount: '0.00',
      paymentMethod: '无', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: '员工',
      remark: null,
      saleOrderDatetime: new Date('2026-07-10T01:28:27.000Z'),
      createdAt: new Date('2026-07-10T01:28:27.000Z'),
      productType: '疗程卡', salesCategory: '自销自耗',
      productName: '水活焕能水光', sessionCount: 10, paidUnusedSessions: 10,
      unitRealPrice: '390.00', // received / session_count 按实付重算
      categoryL1: '护理项目', categoryL2: '水光',
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    // 5 个销售口径金额列对寄存单留空（避免 total=0 与 received=3900 并存误导）
    expect(rows[0].totalAmount).toBe('')
    expect(rows[0].prepaidCardAmount).toBe('')
    expect(rows[0].cashAmount).toBe('')
    expect(rows[0].received).toBe('')
    expect(rows[0].refundedAmount).toBe('')
    // item 级列 + 订单级非金额列照常透传
    expect(rows[0].saleOrderType).toBe('寄存单')
    expect(rows[0].productName).toBe('水活焕能水光')
    expect(rows[0].sessionCount).toBe(10)
    expect(rows[0].unitRealPrice).toBe(390)
  })

  it('转换单：转出+转入两行都纳入导出，金额照实（转出负/转入正），非寄存单不留空', async () => {
    const rawOut = {
      marketName: '九江', storeName: '南昌店', saleOrderId: 'FY-XSD-WX-2607010001',
      saleOrderType: '转换单', documentType: '售后', status: '已支付',
      custName: '李女士', custPhone: '13800000000', fallbackName: null, fallbackPhone: null,
      totalAmount: '-3000.00', // 转出行 saleAmount（负，旧卡消耗）
      prepaidCardAmount: '0.00',
      cashAmount: '-3000.00',
      orderReceived: '0.00',
      received: '-3000.00', // 转出行 received（负）
      refundedAmount: '0.00',
      paymentMethod: '无', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: '员工', remark: '卡转换',
      saleOrderDatetime: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      productType: '疗程卡', salesCategory: '自销自耗',
      productName: '【旧】水活焕能水光', // 转出旧卡
      sessionCount: 10, paidUnusedSessions: 0, // 转出后余 0
      unitRealPrice: '300.00',
      categoryL1: '护理项目', categoryL2: '水光',
    }
    const rawIn = {
      ...rawOut,
      totalAmount: '3000.00', // 转入行 saleAmount（正，获得新权益）
      received: '3000.00', // 转入行 received（正）
      cashAmount: '3000.00',
      productName: '【新】疼痛管理', // 转入新卡
      paidUnusedSessions: 10, // 新卡未用
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([rawOut, rawIn])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows).toHaveLength(2)
    expect(rows[0].saleOrderId).toBe('FY-XSD-WX-2607010001')
    expect(rows[1].saleOrderId).toBe('FY-XSD-WX-2607010001')
    expect(rows[0].saleOrderType).toBe('转换单')
    // 转出旧卡 / 转入新卡 各自透传
    expect(rows[0].productName).toBe('【旧】水活焕能水光')
    expect(rows[1].productName).toBe('【新】疼痛管理')
    // 金额照实：转出负、转入正（区别于寄存单 4 列留空）
    expect(rows[0].totalAmount).toBe('-3000.00')
    expect(rows[0].received).toBe('-3000.00')
    expect(rows[1].totalAmount).toBe('3000.00')
    expect(rows[1].received).toBe('3000.00')
    // 转换单没有储值卡实付时卡分摊为 0；现金分摊恒等于行 received。
    expect(rows[0].prepaidCardAmount).toBe('0.00')
    expect(rows[1].prepaidCardAmount).toBe('0.00')
    expect(rows[0].cashAmount).toBe('-3000.00')
    expect(rows[1].cashAmount).toBe('3000.00')
  })

  it('充值单：无 sale_items，按订单级造一行（储值卡充值），金额=面额/实付，item 级列 null', async () => {
    const rechargeRow = {
      marketName: '九江', storeName: '南昌店', saleOrderId: 'FY-XSD-WX-2607010002',
      saleOrderType: '充值单', documentType: null, status: '已支付',
      custName: '王女士', custPhone: '13900000000', fallbackName: null, fallbackPhone: null,
      totalAmount: '3500.00', // 面额（充 3000 送 500）
      prepaidCardAmount: '0.00',
      orderReceived: '3000.00',
      received: '3000.00', // 实付
      refundedAmount: '0.00',
      paymentMethod: '微信', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: '员工', remark: null,
      saleOrderDatetime: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([rechargeRow]))
      .mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows).toHaveLength(1)
    expect(rows[0].saleOrderType).toBe('充值单')
    expect(rows[0].productName).toBe('储值卡充值')
    // 金额取订单级：面额 / 实付
    expect(rows[0].totalAmount).toBe('3500.00')
    expect(rows[0].received).toBe('3000.00')
    expect(rows[0].prepaidCardAmount).toBe('0.00')
    expect(rows[0].cashAmount).toBe('3000.00')
    // item 级列全 null（充值单无商品明细）
    expect(rows[0].productType).toBeNull()
    expect(rows[0].sessionCount).toBeNull()
    expect(rows[0].paidUnusedSessions).toBeNull()
    expect(rows[0].unitRealPrice).toBeNull()
    expect(rows[0].categoryL1).toBeNull()
    expect(rows[0].categoryL2).toBeNull()
    expect(rows[0].salesCategory).toBeNull()
  })

  it('混合：item 行（销售/转换）+ 充值单造行，合并后按订单时间 desc 排序', async () => {
    const sale = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-SALE', saleOrderType: '销售单',
      documentType: null, status: '已支付', custName: '甲', custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '100.00', prepaidCardAmount: '0.00', received: '100.00', refundedAmount: '0.00',
      paymentMethod: '微信', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date('2026-07-03T00:00:00.000Z'),
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
      productType: '家居产品', salesCategory: '他销他耗', productName: '精华液',
      sessionCount: null, paidUnusedSessions: null, unitRealPrice: '100.00',
      categoryL1: '家居产品', categoryL2: '精华液',
    }
    const conv = {
      ...sale, saleOrderId: 'FY-CONV', saleOrderType: '转换单',
      totalAmount: '500.00', received: '500.00', productName: '【新】疼痛管理',
      productType: '疗程卡', sessionCount: 10, paidUnusedSessions: 10, unitRealPrice: '50.00',
      saleOrderDatetime: new Date('2026-07-02T00:00:00.000Z'),
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    }
    const recharge = {
      marketName: 'M', storeName: 'S', saleOrderId: 'FY-RECHARGE', saleOrderType: '充值单',
      documentType: null, status: '已支付', custName: '乙', custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '3000.00', prepaidCardAmount: '0.00', received: '3000.00', refundedAmount: '0.00',
      paymentMethod: '微信', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([sale, conv])).mockReturnValueOnce(makeChain([recharge]))

    const { rows, truncated } = await exportOrders({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(3)
    // 按订单时间 desc：销售(07-03) → 转换(07-02) → 充值(07-01)
    expect(rows[0].saleOrderId).toBe('FY-SALE')
    expect(rows[1].saleOrderId).toBe('FY-CONV')
    expect(rows[2].saleOrderId).toBe('FY-RECHARGE')
    expect(rows[2].productName).toBe('储值卡充值')
  })

  it('普通转换负差额：储值金入账行归入储值卡通道，金额列逐行勾稽', async () => {
    const orderBase = {
      marketName: '九江', storeName: '南昌店', saleOrderId: 'FY-CONV-CREDIT', saleOrderType: '转换单',
      documentType: '售后', status: '已支付', custName: '李女士', custPhone: '13800000000',
      fallbackName: null, fallbackPhone: null, customerSource: null, promoterEmployeeName: null,
      prepaidCardAmount: '0.00', orderReceived: '0.00', refundedAmount: '0.00', paymentMethod: '无',
      isMembershipUpgrade: false, isActivity: false, isExperienceConversion: false,
      customerType: '会员客', openedByName: '员工', remark: null,
      saleOrderDatetime: new Date('2026-08-17T01:00:00.000Z'),
      performanceAttributionDate: '2026-08-17',
      createdAt: new Date('2026-08-17T01:00:00.000Z'),
    }
    const outRow = {
      ...orderBase, sourceId: '01-out', totalAmount: '-300.00', cashAmount: '-300.00', received: '-300.00',
      productType: '疗程卡', productName: '旧卡', salesCategory: '自销自耗', sessionCount: 10,
      paidUnusedSessions: 0, unitRealPrice: '100.00', categoryL1: null, categoryL2: null,
    }
    const inRow = {
      ...orderBase, sourceId: '02-in', totalAmount: '298.00', cashAmount: '298.00', received: '298.00',
      productType: '疗程卡', productName: '新项目', salesCategory: '自销自耗', sessionCount: 8,
      paidUnusedSessions: 8, unitRealPrice: '100.00', categoryL1: null, categoryL2: null,
    }
    const creditRow = {
      ...orderBase, sourceId: 99, amount: '2.00', createdAt: new Date('2026-08-17T01:00:01.000Z'),
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain([outRow, inRow]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([creditRow]))
      .mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows.map((row) => row.productName)).toEqual(['旧卡', '新项目', '转换差额转入储值卡'])
    expect(rows[2]).toMatchObject({
      totalAmount: '2.00',
      received: '2.00',
      prepaidCardAmount: '2.00',
      cashAmount: '0.00',
      productType: null,
    })
    expect(rows.reduce((sum, row) => sum + Number(row.totalAmount), 0)).toBe(0)
    expect(rows.reduce((sum, row) => sum + Number(row.received), 0)).toBe(0)
    for (const row of rows) {
      const channelAmount = Number(row.prepaidCardAmount) + Number(row.cashAmount)
      expect(Number(row.totalAmount)).toBe(channelAmount)
      expect(Number(row.received)).toBe(channelAmount)
    }
  })

  it('待支付订单只有预选储值卡抵扣且无已入账流水时，储值卡抵扣和现付均为 0', async () => {
    const pendingRow = {
      marketName: '九江', storeName: '店', saleOrderId: 'FY-PENDING', saleOrderType: '销售单',
      documentType: null, status: '待支付', custName: '甲', custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '300.00', prepaidCardAmount: '0.00', cashAmount: '0.00', orderReceived: '0.00', received: '0.00', refundedAmount: '0.00',
      paymentMethod: '线下', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: '疗程卡', salesCategory: '自销自耗', productName: '待支付项目',
      sessionCount: 1, paidUnusedSessions: 0, unitRealPrice: '300.00', categoryL1: null, categoryL2: null,
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([pendingRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows[0].prepaidCardAmount).toBe('0.00')
    expect(rows[0].cashAmount).toBe('0.00')
  })

  it('历史订单迁移后直接读取持久化的行级储值卡/现金实付分摊', async () => {
    const legacyRow = {
      marketName: '九江', storeName: '店', saleOrderId: 'FY-LEGACY', saleOrderType: '销售单',
      documentType: null, status: '已支付', custName: '甲', custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '300.00', prepaidCardAmount: '100.00', cashAmount: '150.00', orderReceived: '300.00', received: '250.00', refundedAmount: '50.00',
      paymentMethod: '线下', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: '疗程卡', salesCategory: '自销自耗', productName: '历史项目',
      sessionCount: 1, paidUnusedSessions: 1, unitRealPrice: '300.00', categoryL1: null, categoryL2: null,
    }
    ;(db.select as any).mockReturnValueOnce(makeChain([legacyRow])).mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows[0].prepaidCardAmount).toBe('100.00')
    expect(rows[0].cashAmount).toBe('150.00')
    expect(Number(rows[0].received)).toBe(
      Number(rows[0].prepaidCardAmount) + Number(rows[0].cashAmount),
    )
  })

  it('退款重算后的行级分摊可表达负现金实付', async () => {
    const refundedRow = {
      marketName: '九江', storeName: '店', saleOrderId: 'FY-REFUND', saleOrderType: '销售单',
      documentType: null, status: '已支付', custName: '甲', custPhone: null,
      fallbackName: null, fallbackPhone: null,
      totalAmount: '300.00', prepaidCardAmount: '80.00', cashAmount: '-30.00', orderReceived: '300.00', received: '50.00', refundedAmount: '0.00',
      paymentMethod: '微信', isMembershipUpgrade: false, isActivity: false,
      customerType: '会员客', openedByName: null, remark: null,
      saleOrderDatetime: new Date(), createdAt: new Date(),
      productType: '疗程卡', salesCategory: '自销自耗', productName: '退款项目',
      sessionCount: 1, paidUnusedSessions: 1, unitRealPrice: '300.00', categoryL1: null, categoryL2: null,
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain([refundedRow]))
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]))

    const { rows } = await exportOrders({})

    expect(rows[0].prepaidCardAmount).toBe('80.00')
    expect(rows[0].cashAmount).toBe('-30.00')
  })
})
