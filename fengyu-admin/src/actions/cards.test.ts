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
    skuSpecName: 'sku_spec_name',
    sessionCount: 'session_count',
    remainingSessions: 'remaining_sessions',
    expireDate: 'expire_date',
    createdAt: 'created_at',
  },
  saleOrders: {
    saleOrderId: 'sale_order_id',
    clientUserId: 'client_user_id',
    paidAt: 'paid_at',
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
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args: args.filter(Boolean) })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
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
  scopeCondition: vi.fn(() => undefined),
  isAdminScope: vi.fn(() => false),
}))

import { getCardsPaginated } from './cards'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { eq, gte, ilike, isNotNull, isNull, inArray } from 'drizzle-orm'

const mockSession = {
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
  skuSpecName: '蜜语水润嫩肤护理 10次卡',
  sessionCount: 10,
  remainingSessions: 7,
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
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('无筛选 → 应用基础条件：购买方向 + 疗程卡 + 余次不为空', async () => {
    mockPaginatedChain(1, [mockCardRow])

    const result = await getCardsPaginated()

    expect(result.total).toBe(1)
    expect(result.data).toHaveLength(1)
    expect(result.data[0].saleItemId).toBe('SI-001')
    expect(result.data[0].productName).toBe('蜜语水润嫩肤护理')
    expect(result.data[0].sessionCount).toBe(10)
    expect(result.data[0].remainingSessions).toBe(7)
    // 基础条件
    expect(eq).toHaveBeenCalledWith('item_direction', '购买')
    expect(eq).toHaveBeenCalledWith('product_type', '疗程卡')
    expect(isNotNull).toHaveBeenCalledWith('remaining_sessions')
  })

  it('空数据 → { data: [], total: 0 }', async () => {
    mockPaginatedChain(0, [])

    const result = await getCardsPaginated()

    expect(result.total).toBe(0)
    expect(result.data).toEqual([])
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

  it('marketId 筛选 → inArray(store_id, subquery)', async () => {
    // Market subquery 内部会调用 db.select → from → innerJoin → where
    // 为避免第一次 select 被 subquery 消耗，这里先给 subquery 一个独立链
    const subChain: any = {}
    subChain.from = vi.fn().mockReturnValue(subChain)
    subChain.innerJoin = vi.fn().mockReturnValue(subChain)
    subChain.where = vi.fn().mockReturnValue(subChain)

    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      if (call === 1) return subChain  // market subquery
      if (call === 2) {
        const c: any = {}
        c.from = vi.fn().mockReturnValue(c)
        c.leftJoin = vi.fn().mockReturnValue(c)
        c.where = vi.fn().mockResolvedValue([{ count: 0 }])
        return c
      }
      const c: any = {}
      c.from = vi.fn().mockReturnValue(c)
      c.leftJoin = vi.fn().mockReturnValue(c)
      c.where = vi.fn().mockReturnValue(c)
      c.orderBy = vi.fn().mockReturnValue(c)
      c.limit = vi.fn().mockReturnValue(c)
      c.offset = vi.fn().mockResolvedValue([])
      return c
    })

    await getCardsPaginated({ marketId: 'market-1' })

    expect(eq).toHaveBeenCalledWith('parent_id', 'market-1')
    expect(inArray).toHaveBeenCalled()
  })

  it('storeId 筛选 → eq(store_id, storeId)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ storeId: 'store-9' })

    expect(eq).toHaveBeenCalledWith('store_id', 'store-9')
  })

  it('search 筛选 → ilike(name) + ilike(phone)', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ search: '李' })

    expect(ilike).toHaveBeenCalledWith('name', '%李%')
    expect(ilike).toHaveBeenCalledWith('phone', '%李%')
  })

  it('search 转义 %/_ 字符（避免通配泄漏）', async () => {
    mockPaginatedChain(0, [])

    await getCardsPaginated({ search: '100%_off' })

    expect(ilike).toHaveBeenCalledWith('name', '%100\\%\\_off%')
    expect(ilike).toHaveBeenCalledWith('phone', '%100\\%\\_off%')
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
