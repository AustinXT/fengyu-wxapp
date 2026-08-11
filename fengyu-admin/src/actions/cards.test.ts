import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
  },
}))

vi.mock('@db/order', () => ({
  saleItems: {
    saleItemId: 'sale_item_id',
    saleOrderId: 'sale_order_id',
    storeId: 'store_id',
    itemDirection: 'item_direction',
    productType: 'product_type',
    productName: 'product_name',
    sessionCount: 'session_count',
    remainingSessions: 'remaining_sessions',
    expireDate: 'expire_date',
    createdAt: 'created_at',
    quantity: 'quantity',
    pickedUpQuantity: 'picked_up_quantity',
    unitRealPrice: 'unit_real_price',
    skuId: 'sku_id',
  },
  saleOrders: {
    saleOrderId: 'sale_order_id',
    saleOrderType: 'sale_order_type',
    clientUserId: 'client_user_id',
    paidAt: 'paid_at',
    status: 'status',
  },
}))

vi.mock('@db/product', () => ({
  productSkus: { skuId: 'sku_id', categoryId: 'category_id', unit: 'unit' },
  productCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    productKind: 'product_kind',
    sortOrder: 'sort_order',
  },
}))

vi.mock('@db/org', () => ({
  stores: { storeId: 'store_id', storeName: 'store_name', orgNodeId: 'org_node_id' },
  orgNodes: { id: 'id', parentId: 'parent_id' },
}))

vi.mock('@db/user', () => ({
  clientWechatUsers: {
    userId: 'user_id',
    name: 'name',
    phone: 'phone',
  },
  staffWechatUsers: {
    employeeId: 'employee_id',
    name: 'name',
  },
}))

vi.mock('@db/service', () => ({
  serviceItems: {
    serviceItemId: 'service_item_id',
    serviceOrderId: 'service_order_id',
    saleItemId: 'sale_item_id',
    sessionUsed: 'session_used',
    unitRealPrice: 'unit_real_price',
    employeeId: 'employee_id',
    createdAt: 'created_at',
  },
  serviceOrders: {
    serviceOrderId: 'service_order_id',
    status: 'status',
    serviceDate: 'service_date',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  isNull: vi.fn((col) => ({ type: 'isNull', col })),
  sql: Object.assign(
    vi.fn(() => ({ as: vi.fn().mockReturnValue({ type: 'sql-as' }) })),
    { raw: vi.fn() },
  ),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
  scopeCondition: vi.fn(() => undefined),
  isAdminScope: vi.fn(() => false),
  isInScope: vi.fn(),
}))

import { getCardsPaginated, getCardFilterOptions, getCustomerHeldCards, getCardById, getCardTransactions, exportCards } from './cards'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope, scopeCondition } from '@/lib/permissions'
import { parseCardFilters } from '@/lib/list-filters'
import { eq, gte, ilike, isNotNull, isNull, inArray, sql } from 'drizzle-orm'

// ============================================================================
// getCardsPaginated tests
// ============================================================================

const mockCardsPaginatedSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
  permissions: {
    actions: ['sale_item:list'],
    scopeStoreIds: ['store-1'],
  },
}

/** mock 2 个并行 select：COUNT + DATA */
function mockPaginatedChain(total: number, dataRows: any[]) {
  let callIndex = 0
  ;(db.select as any).mockImplementation(() => {
    callIndex++
    if (callIndex === 1) {
      // COUNT: select → from → leftJoin → leftJoin → where(→ Promise)
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.leftJoin = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockResolvedValue([{ count: total }])
      return chain
    }
    // DATA: select → from → leftJoin ×3 → where → orderBy → limit → offset
    const chain: any = {}
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockReturnValue(chain)
    chain.offset = vi.fn().mockResolvedValue(dataRows)
    return chain
  })
}

const mockCardRow = {
  saleItemId: 'SI-001',
  saleOrderId: 'FY-XSD-WX-2604100001',
  productName: '蜜语水润嫩肤护理',
  sessionCount: 10,
  remainingSessions: 7,
  paidSessions: 10,
  paidUnusedSessions: 7,
  expireDate: '2026-12-31',
  paidAt: new Date('2026-04-01T10:00:00Z'),
  storeId: 'store-1',
  storeName: '南昌旗舰店',
  marketName: '南昌市场',
  clientUserId: 'FYGK-001',
  clientName: '李女士',
  clientPhone: '13812345678',
}

describe('getCardsPaginated — 服务端分页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockCardsPaginatedSession)
  })

  it('无筛选 → 应用基础条件：权益方向 + 有效订单状态 + 疗程卡 + 余次不为空', async () => {
    mockPaginatedChain(1, [mockCardRow])

    const result = await getCardsPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].saleItemId).toBe('SI-001')
    expect(result.data[0].productName).toBe('蜜语水润嫩肤护理')
    expect(result.data[0].sessionCount).toBe(10)
    expect(result.data[0].remainingSessions).toBe(7)
    expect(result.data[0].paidSessions).toBe(10)
    expect(result.data[0].paidUnusedSessions).toBe(7)
    // 基础条件
    expect(eq).toHaveBeenCalledWith('item_direction', '购买')
    expect(eq).toHaveBeenCalledWith('sale_order_type', '转换单')
    expect(eq).toHaveBeenCalledWith('item_direction', '转入')
    expect(inArray).toHaveBeenCalledWith('status', ['已支付', '部分支付', '已完成'])
    expect(eq).toHaveBeenCalledWith('product_type', '疗程卡')
    expect(isNotNull).toHaveBeenCalledWith('remaining_sessions')
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getCardsPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
  })

  it('部分支付疗程卡 → paidUnusedSessions 透传（已付未用口径，欠款时 < 物理剩余）', async () => {
    // 15 次卡，已用 2（remaining=13），欠款只付 80%（paid=12）→ 已付未用 = 12 - 2 = 10
    const partialRow = {
      ...mockCardRow,
      saleItemId: 'SI-PARTIAL',
      sessionCount: 15,
      remainingSessions: 13,
      paidSessions: 12,
      paidUnusedSessions: 10,
    }
    mockPaginatedChain(1, [partialRow])

    const result = await getCardsPaginated()

    expect(result.data[0].paidUnusedSessions).toBe(10)
    expect(result.data[0].remainingSessions).toBe(13)
    // 欠款部分支付：可用(已付未用 10) < 物理剩余(13)，差 3 次为未付款次数
    expect(result.data[0].paidUnusedSessions!).toBeLessThan(result.data[0].remainingSessions!)
  })

  it('type=单次卡 → eq(session_count, 1)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ type: '单次卡' })

    expect(eq).toHaveBeenCalledWith('session_count', 1)
    expect(gte).not.toHaveBeenCalledWith('session_count', 2)
  })

  it('type=疗程卡 → gte(session_count, 2)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ type: '疗程卡' })

    expect(gte).toHaveBeenCalledWith('session_count', 2)
  })

  it('marketId 筛选 → 递归组织节点子查询', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ marketId: 'market-1' })

    expect((sql as any).mock.calls.some(([strings]: [TemplateStringsArray]) =>
      strings.join('').includes('WITH RECURSIVE descendants'),
    )).toBe(true)
  })

  it('storeId 筛选 → eq(store_id, storeId)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ storeId: 'store-9' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-9')
  })

  it('一级/二级品项筛选 → 分别命中分类表和 SKU 分类 ID', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ productKind: '护理项目', categoryId: 'face-care' })

    expect(eq).toHaveBeenCalledWith('product_kind', '护理项目')
    expect(eq).toHaveBeenCalledWith('category_id', 'face-care')
  })

  it('search 筛选 → ilike(name) + ilike(phone) + ilike(product_name)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ search: '李' })

    expect(ilike).toHaveBeenCalledWith('name', '%李%')
    expect(ilike).toHaveBeenCalledWith('phone', '%李%')
    expect(ilike).toHaveBeenCalledWith('product_name', '%李%')
  })

  it('search 转义 %/_ 字符（避免通配泄漏）', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ search: '100%_off' })

    expect(ilike).toHaveBeenCalledWith('name', '%100\\%\\_off%')
    expect(ilike).toHaveBeenCalledWith('phone', '%100\\%\\_off%')
    expect(ilike).toHaveBeenCalledWith('product_name', '%100\\%\\_off%')
  })

  it('search 筛选 → 订单号精准匹配 eq(sale_order_id, search)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ search: 'FY-XSD-WX-2604100001' })

    // sale_order_id 主键唯一：精确匹配（不走 % 模糊），输入完整单号即定位唯一卡
    expect(eq).toHaveBeenCalledWith('sale_order_id', 'FY-XSD-WX-2604100001')
  })

  it('status=exhausted → eq(remaining_sessions, 0)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ status: 'exhausted' })

    expect(eq).toHaveBeenCalledWith('remaining_sessions', 0)
  })

  it('status=expired → isNotNull(expire_date)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ status: 'expired' })

    // 基础条件里 isNotNull(remaining_sessions) + expired 分支的 isNotNull(expire_date)
    expect(isNotNull).toHaveBeenCalledWith('expire_date')
  })

  it('status=active → isNull(expire_date) OR expire_date >= today', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ status: 'active' })

    expect(isNull).toHaveBeenCalledWith('expire_date')
  })

  it('page/pageSize → 2 次 select（COUNT + DATA）', async () => {
    mockPaginatedChain(50, [])

    const result = await getCardsPaginated({ page: 3, pageSize: 10 })

    expect(result.total).toBe(50)
    expect(db.select).toHaveBeenCalledTimes(2)
  })

  it('序列化：paidAt 转 ISO，storeName/marketName 保留', async () => {
    mockPaginatedChain(1, [mockCardRow])

    const result = await getCardsPaginated()

    expect(result.data[0].paidAt).toBe('2026-04-01T10:00:00.000Z')
    expect(result.data[0].storeName).toBe('南昌旗舰店')
    expect(result.data[0].marketName).toBe('南昌市场')
    expect(result.data[0].clientPhone).toBe('13812345678')
  })

  it('paidAt 为 null 时不爆，返回 null', async () => {
    const rowNoPaid = { ...mockCardRow, paidAt: null }
    mockPaginatedChain(1, [rowNoPaid])

    const result = await getCardsPaginated()

    expect(result.data[0].paidAt).toBeNull()
  })
})

describe('getCardFilterOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockCardsPaginatedSession)
  })

  it('返回一级品项和对应二级品项，供疗程卡筛选栏使用', async () => {
    const makeChain = (rows: any[]) => {
      const chain: any = {}
      chain.from = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.orderBy = vi.fn().mockResolvedValue(rows)
      return chain
    }
    ;(db.select as any)
      .mockReturnValueOnce(makeChain([{ categoryName: '护理项目' }]))
      .mockReturnValueOnce(makeChain([
        { categoryId: 'face-care', categoryName: '面部护理', productKind: '护理项目' },
      ]))

    await expect(getCardFilterOptions()).resolves.toEqual({
      productKinds: ['护理项目'],
      categories: [{ categoryId: 'face-care', categoryName: '面部护理', productKind: '护理项目' }],
    })
  })
})

describe('parseCardFilters', () => {
  it('未选一级品项时忽略孤立二级品项，避免 URL 幽灵筛选', () => {
    expect(parseCardFilters({ category: 'face-care' }).categoryId).toBeUndefined()
    expect(parseCardFilters({ productKind: '护理项目', category: 'face-care' })).toMatchObject({
      productKind: '护理项目',
      categoryId: 'face-care',
    })
  })
})

// ============================================================================
// getCustomerHeldCards tests（PR-A 新增）
// ============================================================================

const mockHeldCardsSession = {
  employeeId: 'EMP-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['sale_order:list'], scopeStoreIds: ['store-1'] },
}

function mockSelectRows(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

describe('getCustomerHeldCards — 权限与 scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockHeldCardsSession)
  })

  it('clientUserId 为空 → 返回空数组', async () => {
    const result = await getCustomerHeldCards('', 'store-1')
    expect(result).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it('storeId 为空 → 返回空数组', async () => {
    const result = await getCustomerHeldCards('user-1', '')
    expect(result).toEqual([])
  })

  it('跨店（storeId 不在 scope）→ 返回空数组，不查询 DB', async () => {
    ;(isInScope as any).mockReturnValue(false)
    const result = await getCustomerHeldCards('user-1', 'store-999')
    expect(result).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })
})

describe('getCustomerHeldCards — 数据映射', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockHeldCardsSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('疗程卡：deductibleAmount = unitRealPrice × remainingSessions，remainingQty=null', async () => {
    mockSelectRows([{
      saleItemId: 'si-1',
      productName: '经络护理',
      productType: '疗程卡',
      remainingSessions: 5,
      quantity: 1,
      pickedUpQuantity: 0,
      unitRealPrice: '200.00',
      productKind: '护理项目',
    }])
    const [row] = await getCustomerHeldCards('user-1', 'store-1')
    expect(row.productType).toBe('疗程卡')
    expect(row.remainingSessions).toBe(5)
    expect(row.remainingQty).toBeNull()
    expect(row.deductibleAmount).toBe('1000.00')
  })

  it('原体验卡单品（合并后=疗程卡 1 次）：按 remaining_sessions 折抵，remainingQty=null', async () => {
    // 2026-05-21 单品合并：原"体验卡单品"已并入疗程卡，统一走 remaining_sessions 口径
    mockSelectRows([{
      saleItemId: 'si-2',
      productName: '体验项目',
      productType: '疗程卡',
      remainingSessions: 2,
      quantity: 1,
      pickedUpQuantity: 0,
      unitRealPrice: '99.00',
      productKind: '体验卡',
    }])
    const [row] = await getCustomerHeldCards('user-1', 'store-1')
    expect(row.productType).toBe('疗程卡')
    expect(row.remainingSessions).toBe(2)
    expect(row.remainingQty).toBeNull()
    expect(row.deductibleAmount).toBe('198.00')
  })

  it('多张疗程卡合并列表：均按 remaining_sessions 返回', async () => {
    mockSelectRows([
      {
        saleItemId: 'si-1', productName: '疗程A',
        productType: '疗程卡', remainingSessions: 5, quantity: 1,
        pickedUpQuantity: 0, unitRealPrice: '200.00', productKind: '护理项目',
      },
      {
        saleItemId: 'si-2', productName: '体验B',
        productType: '疗程卡', remainingSessions: 2, quantity: 1,
        pickedUpQuantity: 0, unitRealPrice: '99.00', productKind: '体验卡',
      },
    ])
    const rows = await getCustomerHeldCards('user-1', 'store-1')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.productType)).toEqual(['疗程卡', '疗程卡'])
    expect(rows.map((r) => r.deductibleAmount).sort()).toEqual(['1000.00', '198.00'])
  })

  it('空结果：顾客无可折抵卡 → 返回空数组', async () => {
    mockSelectRows([])
    const rows = await getCustomerHeldCards('user-1', 'store-1')
    expect(rows).toEqual([])
  })

  it('remainingSessions = null 时按 0 处理（deductibleAmount=0.00）', async () => {
    mockSelectRows([{
      saleItemId: 'si-3', productName: '疗程C',
      productType: '疗程卡', remainingSessions: null, quantity: 1,
      pickedUpQuantity: null, unitRealPrice: '100.00', productKind: '护理项目',
    }])
    const [row] = await getCustomerHeldCards('user-1', 'store-1')
    expect(row.remainingSessions).toBe(0)
    expect(row.remainingQty).toBeNull()
    expect(row.deductibleAmount).toBe('0.00')
  })
})

// ============================================================================
// getCardById / getCardTransactions tests（卡详情页 PR）
// ============================================================================

const mockCardDetailSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1', scopeType: '门店' }],
  permissions: {
    actions: ['sale_item:list'],
    scopeStoreIds: ['store-1'],
  },
}

const mockCardDetailRow = {
  saleItemId: 'SI-001',
  saleOrderId: 'FY-XSD-WX-2604100001',
  productName: '蜜语水润嫩肤护理',
  sessionCount: 10,
  remainingSessions: 7,
  paidSessions: 10,
  unitPrice: '500.00',
  unitRealPrice: '400.00',
  saleAmount: '4000.00',
  received: '4000.00',
  quantity: 1,
  expireDate: '2026-12-31',
  itemDirection: '购买',
  productType: '疗程卡',
  storeId: 'store-1',
  storeName: '南昌旗舰店',
  marketName: '南昌市场',
  clientUserId: 'FYGK-001',
  clientName: '李女士',
  clientPhone: '13812345678',
  paidAt: new Date('2026-04-01T10:00:00Z'),
  orderCreatedAt: new Date('2026-04-01T09:55:00Z'),
  orderStatus: '已支付',
}

/** mock select 单查链：.from.leftJoin*.innerJoin?.where.limit/orderBy → Promise */
function mockSelectChain(rows: any[]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.innerJoin = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.orderBy = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

describe('getCardById — 卡详情', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockCardDetailSession)
  })

  it('命中：返回完整 CardDetail，timestamp 字段转 ISO 字符串', async () => {
    mockSelectChain([mockCardDetailRow])

    const result = await getCardById('SI-001')

    expect(result).not.toBeNull()
    expect(result!.saleItemId).toBe('SI-001')
    expect(result!.saleOrderId).toBe('FY-XSD-WX-2604100001')
    expect(result!.productName).toBe('蜜语水润嫩肤护理')
    expect(result!.sessionCount).toBe(10)
    expect(result!.remainingSessions).toBe(7)
    expect(result!.paidSessions).toBe(10)
    expect(result!.productType).toBe('疗程卡')
    expect(result!.itemDirection).toBe('购买')
    expect(result!.storeName).toBe('南昌旗舰店')
    expect(result!.marketName).toBe('南昌市场')
    expect(result!.clientName).toBe('李女士')
    expect(result!.clientPhone).toBe('13812345678')
    expect(result!.paidAt).toBe('2026-04-01T10:00:00.000Z')
    expect(result!.orderCreatedAt).toBe('2026-04-01T09:55:00.000Z')
    expect(result!.orderStatus).toBe('已支付')
    expect(result!.expireDate).toBe('2026-12-31')
    // 强制权益方向：购买行 + 转换单转入行
    expect(eq).toHaveBeenCalledWith('item_direction', '购买')
    expect(eq).toHaveBeenCalledWith('sale_order_type', '转换单')
    expect(eq).toHaveBeenCalledWith('item_direction', '转入')
    expect(inArray).toHaveBeenCalledWith('status', ['已支付', '部分支付', '已完成'])
    // saleItemId 锁定
    expect(eq).toHaveBeenCalledWith('sale_item_id', 'SI-001')
  })

  it('未命中：返回 null（覆盖 saleItemId 不存在 / item_direction 非购买 / 跨门店 scope 失败三种）', async () => {
    mockSelectChain([])

    const result = await getCardById('SI-NOT-EXIST')

    expect(result).toBeNull()
  })

  it('saleItemId 为空字符串 → 直接返回 null，不查 DB', async () => {
    const result = await getCardById('')

    expect(result).toBeNull()
    expect(db.select).not.toHaveBeenCalled()
  })

  it('非 admin 角色：scopeCondition 被嵌入 WHERE 做门店隔离', async () => {
    mockSelectChain([mockCardDetailRow])

    await getCardById('SI-001')

    expect(scopeCondition).toHaveBeenCalledWith(mockCardDetailSession, 'store_id')
  })

  it('paidAt / orderCreatedAt 为 null 时不爆，返回 null', async () => {
    mockSelectChain([{
      ...mockCardDetailRow,
      paidAt: null,
      orderCreatedAt: null,
    }])

    const result = await getCardById('SI-001')

    expect(result!.paidAt).toBeNull()
    expect(result!.orderCreatedAt).toBeNull()
  })
})

describe('getCardTransactions — 划卡明细', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockCardDetailSession)
  })

  it('返回划卡记录数组，按 service_date DESC 排序', async () => {
    mockSelectChain([
      {
        serviceItemId: 'SVI-001-01',
        serviceOrderId: 'FY-FW-2604200001',
        serviceDate: '2026-04-20',
        serviceOrderStatus: '已完成',
        sessionUsed: 1,
        unitRealPriceSnapshot: '400.00',
        employeeId: 'EMP-001',
        employeeName: '王美容师',
      },
      {
        serviceItemId: 'SVI-002-01',
        serviceOrderId: 'FY-FW-2604150002',
        serviceDate: '2026-04-15',
        serviceOrderStatus: '已完成',
        sessionUsed: 1,
        unitRealPriceSnapshot: '400.00',
        employeeId: 'EMP-002',
        employeeName: '张美容师',
      },
    ])

    const rows = await getCardTransactions('SI-001')

    expect(rows).toHaveLength(2)
    expect(rows[0].serviceOrderId).toBe('FY-FW-2604200001')
    expect(rows[0].sessionUsed).toBe(1)
    expect(rows[0].employeeName).toBe('王美容师')
    expect(rows[1].serviceOrderId).toBe('FY-FW-2604150002')
  })

  it('空结果：尚未划卡 → 返回空数组', async () => {
    mockSelectChain([])

    const rows = await getCardTransactions('SI-001')

    expect(rows).toEqual([])
  })

  it('saleItemId 为空 → 直接返回空数组，不查 DB', async () => {
    const rows = await getCardTransactions('')

    expect(rows).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })
})

// ============================================================================
// exportCards tests（疗程卡导出）
// ============================================================================

/** mock exportCards 单查链：支持直接 await orderBy(...) 与旧的 .limit() 收口 */
function mockExportChain(rows: any[]) {
  const chain: any = Object.assign(Promise.resolve(rows), {})
  chain.from = vi.fn().mockReturnValue(chain)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  ;(db.select as any).mockReturnValue(chain)
}

const mockExportRow = {
  productName: '蜜语水润嫩肤护理',
  specName: '蜜语水润嫩肤护理 10次卡',
  sessionCount: 10,
  paidUnusedSessions: 7,
  unitPrice: '500.00',
  unitRealPrice: '400.00',
  saleAmount: '4000.00',
  received: '4000.00',
  productKind: '护理项目',
  categoryName: '蜜语系列',
  storeName: '南昌旗舰店',
  marketName: '南昌市场',
  clientName: '李女士',
  clientPhone: '13812345678',
  fallbackName: null,
  fallbackPhone: null,
  saleOrderId: 'FY-XSD-WX-2604100001',
  saleOrderDatetime: new Date('2026-04-01T09:55:00Z'),
  orderStatus: '已支付',
  paidAt: new Date('2026-04-01T10:00:00Z'),
}

describe('exportCards — 疗程卡导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockCardsPaginatedSession)
  })

  it('字段映射：金额 number 化、剩余用 paidUnusedSessions、类型派生、L1/L2 正向、时间转 ISO', async () => {
    mockExportChain([mockExportRow])

    const { rows, truncated } = await exportCards({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.clientName).toBe('李女士')
    expect(r.clientPhone).toBe('13812345678')
    expect(r.categoryL1).toBe('护理项目') // productKind（一级父级名，正向）
    expect(r.categoryL2).toBe('蜜语系列') // categoryName（二级行名）
    expect(r.productSpec).toBe('蜜语水润嫩肤护理') // productName 快照优先于 specName
    expect(r.cardType).toBe('10次卡') // sessionCount=10 派生
    expect(r.remaining).toBe(7) // 已付未用口径
    expect(r.totalSessions).toBe(10)
    expect(r.unitPrice).toBe(500) // numeric string → number
    expect(r.unitRealPrice).toBe(400)
    expect(r.saleAmount).toBe(4000)
    expect(r.received).toBe(4000)
    expect(r.storeDisplay).toBe('南昌旗舰店 / 南昌市场')
    expect(r.saleOrderDatetime).toBe('2026-04-01T09:55:00.000Z')
    expect(r.saleOrderId).toBe('FY-XSD-WX-2604100001')
    expect(r.orderStatus).toBe('已支付')
    expect(r.paidAt).toBe('2026-04-01T10:00:00.000Z')
  })

  it('查询条件支持转换单转入权益卡，并限定有效订单状态', async () => {
    mockExportChain([{
      ...mockExportRow,
      saleOrderId: 'FY-XSD-WX-2607250060',
      productName: '面部三重维养',
      paidUnusedSessions: 10,
    }])

    const { rows } = await exportCards({})

    expect(rows[0].saleOrderId).toBe('FY-XSD-WX-2607250060')
    expect(rows[0].productSpec).toBe('面部三重维养')
    expect(rows[0].remaining).toBe(10)
    expect(eq).toHaveBeenCalledWith('sale_order_type', '转换单')
    expect(eq).toHaveBeenCalledWith('item_direction', '转入')
    expect(inArray).toHaveBeenCalledWith('status', ['已支付', '部分支付', '已完成'])
  })

  it('单次卡 → cardType=单次卡；顾客主档 / productName 缺失时回退订单快照与 specName', async () => {
    mockExportChain([{
      ...mockExportRow,
      sessionCount: 1,
      clientName: null,
      clientPhone: null,
      fallbackName: '快照顾客',
      fallbackPhone: '13900000000',
      productName: null,
      specName: '体验项目 1次卡',
    }])

    const { rows } = await exportCards({})

    expect(rows[0].cardType).toBe('单次卡')
    expect(rows[0].clientName).toBe('快照顾客')
    expect(rows[0].clientPhone).toBe('13900000000')
    expect(rows[0].productSpec).toBe('体验项目 1次卡')
  })

  it('空结果：当前筛选无命中 → { rows: [], truncated: false }', async () => {
    mockExportChain([])

    const { rows, truncated } = await exportCards({})

    expect(rows).toEqual([])
    expect(truncated).toBe(false)
  })

  it('超过旧上限也返回全量且不标记截断', async () => {
    const many = Array.from({ length: 10001 }, (_, i) => ({ ...mockExportRow, saleOrderId: `FY-${i}` }))
    mockExportChain(many)

    const { rows, truncated } = await exportCards({})

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(10001)
  })
})
