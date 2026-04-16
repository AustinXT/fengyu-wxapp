import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
  },
}))

vi.mock('@db/order', () => ({
  saleItems: {
    saleItemId: 'sale_item_id',
    storeId: 'store_id',
    saleOrderId: 'sale_order_id',
    itemDirection: 'item_direction',
    productType: 'product_type',
    remainingSessions: 'remaining_sessions',
    quantity: 'quantity',
    pickedUpQuantity: 'picked_up_quantity',
    unitRealPrice: 'unit_real_price',
    productName: 'product_name',
    skuSpecName: 'sku_spec_name',
    skuId: 'sku_id',
  },
  saleOrders: {
    saleOrderId: 'sale_order_id',
    clientUserId: 'client_user_id',
    status: 'status',
  },
}))

vi.mock('@db/product', () => ({
  productSkus: { skuId: 'sku_id', categoryId: 'category_id' },
  productCategories: { categoryId: 'category_id', productKind: 'product_kind' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  isInScope: vi.fn(),
}))

import { getCustomerHeldCards } from './cards'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { isInScope } from '@/lib/permissions'

const mockSession = {
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
    ;(getSession as any).mockResolvedValue(mockSession)
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
    ;(getSession as any).mockResolvedValue(mockSession)
    ;(isInScope as any).mockReturnValue(true)
  })

  it('疗程卡：deductibleAmount = unitRealPrice × remainingSessions，remainingQty=null', async () => {
    mockSelectRows([{
      saleItemId: 'si-1',
      productName: '经络护理',
      skuSpecName: '10次卡',
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

  it('体验卡单品：deductibleAmount = unitRealPrice × (quantity - pickedUp)，remainingSessions=null', async () => {
    mockSelectRows([{
      saleItemId: 'si-2',
      productName: '体验项目',
      skuSpecName: '单次',
      productType: '单品',
      remainingSessions: null,
      quantity: 3,
      pickedUpQuantity: 1,
      unitRealPrice: '99.00',
      productKind: '体验卡',
    }])
    const [row] = await getCustomerHeldCards('user-1', 'store-1')
    expect(row.productType).toBe('单品')
    expect(row.remainingSessions).toBeNull()
    expect(row.remainingQty).toBe(2)
    expect(row.deductibleAmount).toBe('198.00')
  })

  it('疗程卡 + 体验卡单品合并列表：两种卡同时返回', async () => {
    mockSelectRows([
      {
        saleItemId: 'si-1', productName: '疗程A', skuSpecName: '10次',
        productType: '疗程卡', remainingSessions: 5, quantity: 1,
        pickedUpQuantity: 0, unitRealPrice: '200.00', productKind: '护理项目',
      },
      {
        saleItemId: 'si-2', productName: '体验B', skuSpecName: '单次',
        productType: '单品', remainingSessions: null, quantity: 2,
        pickedUpQuantity: 0, unitRealPrice: '99.00', productKind: '体验卡',
      },
    ])
    const rows = await getCustomerHeldCards('user-1', 'store-1')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.productType).sort()).toEqual(['单品', '疗程卡'])
  })

  it('空结果：顾客无可折抵卡 → 返回空数组', async () => {
    mockSelectRows([])
    const rows = await getCustomerHeldCards('user-1', 'store-1')
    expect(rows).toEqual([])
  })

  it('pickedUpQuantity = null 时按 0 处理（remainingQty = quantity）', async () => {
    mockSelectRows([{
      saleItemId: 'si-3', productName: '体验C', skuSpecName: '单次',
      productType: '单品', remainingSessions: null, quantity: 5,
      pickedUpQuantity: null, unitRealPrice: '100.00', productKind: '体验卡',
    }])
    const [row] = await getCustomerHeldCards('user-1', 'store-1')
    expect(row.remainingQty).toBe(5)
    expect(row.deductibleAmount).toBe('500.00')
  })
})
