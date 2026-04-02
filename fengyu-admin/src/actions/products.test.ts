import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.spyOn(crypto, 'randomUUID').mockReturnValue('mock-uuid-1234' as any)

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@db/product', () => ({
  productCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    productKind: 'product_kind',
    sortOrder: 'sort_order',
    isValid: 'is_valid',
    updatedAt: 'updated_at',
  },
  products: {
    productId: 'product_id',
    categoryId: 'category_id',
    name: 'name',
    salesCategory: 'sales_category',
    updatedAt: 'updated_at',
    productId_: 'product_id',
  },
  productSkus: {
    skuId: 'sku_id',
    categoryId: 'category_id',
    productType: 'product_type',
    updatedAt: 'updated_at',
    sortOrder: 'sort_order',
  },
  mallCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    sortOrder: 'sort_order',
    isValid: 'is_valid',
    updatedAt: 'updated_at',
  },
  mallBundleGroups: {
    id: 'id',
    productId: 'product_id',
    groupName: 'group_name',
    pickCount: 'pick_count',
    sortOrder: 'sort_order',
  },
  mallProductSkus: {
    productId: 'product_id',
    skuId: 'sku_id',
    bundleGroupId: 'bundle_group_id',
    bundlePrice: 'bundle_price',
    sortOrder: 'sort_order',
  },
}))

vi.mock('@db/org', () => ({
  orgNodes: {
    id: 'id',
    name: 'name',
    type: 'type',
    isActive: 'is_active',
    sortOrder: 'sort_order',
    parentId: 'parent_id',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: { saleItemId: 'sale_item_id', skuId: 'sku_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), { raw: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  createProduct,
  updateProduct,
  createCategory,
  updateCategory,
  createSku,
  updateSku,
  deleteSku,
  getCategories,
  getProducts,
  getProductById,
  getSkusByProductId,
  getAllSkus,
} from './products'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const mockSession = {
  employeeId: 'MGR-001',
  roles: [{ role: 'admin', scopeId: 'hq' }],
  permissions: { actions: ['product:list', 'product:create', 'product:update'], scopeStoreIds: [] },
}

function makeSelectChain(result: any[]) {
  const limit = vi.fn().mockResolvedValue(result)
  const whereResult = Object.assign(Promise.resolve(result), { limit })
  const where = vi.fn().mockReturnValue(whereResult)
  const from = vi.fn().mockReturnValue({ where })
  return vi.fn().mockReturnValue({ from })
}

// ── createProduct ─────────────────────────────────────────────────────────────

describe('createProduct — 输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('价格为负数 → 拒绝', async () => {
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '-10' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('价格必须为非负数')
    expect(db.select).not.toHaveBeenCalled()
  })

  it('会员价为负数 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100', specialPrice: '-5' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('会员价必须为非负数')
  })

  it('分类不存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-999', name: '测试商品', price: '100' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品分类不存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('商品编号重复（23505）→ 友好消息', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品编号已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100' })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('商品创建成功')
  })
})

// ── updateProduct ─────────────────────────────────────────────────────────────

describe('updateProduct — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告商品不存在（而非静默成功）', async () => {
    setupUpdate(0)
    const result = await updateProduct('P-999', { name: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateProduct('P-001', { name: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)
    const result = await updateProduct('P-001', { name: '新名称' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })
})

// ── createCategory ────────────────────────────────────────────────────────────

describe('createCategory — 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('分类编号重复（23505）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('分类编号已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('分类创建成功')
  })
})

// ── updateCategory ────────────────────────────────────────────────────────────

describe('updateCategory — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告分类不存在', async () => {
    setupUpdate(0)
    const result = await updateCategory('CAT-999', { categoryName: '新名称' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('分类不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateCategory('CAT-1', { categoryName: '新名称' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)
    const result = await updateCategory('CAT-1', { categoryName: '新名称' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })
})

// ── createSku ─────────────────────────────────────────────────────────────────

describe('createSku — 输入校验 + 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  const baseSkuData = {
    skuId: 'SKU-001',
    productId: 'P-001',
    productType: '疗程卡' as const,
    specName: '10次卡',
    price: '1000',
    sessionCount: 10,
  }

  it('无效 productType → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, productType: '无效类型' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('无效的产品类型')
  })

  it('价格为负数 → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, price: '-1' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('价格必须为非负数')
  })

  it('疗程卡 sessionCount < 1 → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, sessionCount: 0 })
    expect(result.success).toBe(false)
    expect(result.message).toContain('疗程卡的次数必须 >= 1')
  })

  it('SKU 编号重复（23505）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('SKU 编号已存在')
  })

  it('商品不存在（23503）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('FK violation'), { code: '23503' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品不存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(createSku(baseSkuData)).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(true)
    expect(result.message).toContain('SKU 创建成功')
  })
})

// ── updateSku ─────────────────────────────────────────────────────────────────

describe('updateSku — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告 SKU 不存在', async () => {
    setupUpdate(0)
    const result = await updateSku('SKU-999', { specName: '新规格' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('SKU 不存在')
  })

  it('rowCount=0，有乐观锁 → 报告并发冲突', async () => {
    setupUpdate(0)
    const result = await updateSku('SKU-001', { specName: '新规格' }, '2026-01-01T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他人修改')
  })

  it('rowCount=1 → 成功', async () => {
    setupUpdate(1)
    const result = await updateSku('SKU-001', { specName: '新规格' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
  })
})

// ── deleteSku ─────────────────────────────────────────────────────────────────

describe('deleteSku — 引用校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('SKU 被订单引用 → 拒绝删除', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ saleItemId: 'item-1' }]))
    const result = await deleteSku('SKU-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被订单引用')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('SKU 未被引用 → 成功删除', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({}) })
    const result = await deleteSku('SKU-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    expect(db.delete).toHaveBeenCalledOnce()
  })
})

// ── 读函数覆盖 ───────────────────────────────────────────────────────────────

describe('getCategories — 品项分类列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回序列化的分类列表', async () => {
    const orderBy = vi.fn().mockResolvedValue([{
      categoryId: 'cat-1', categoryName: '护理项目', productKind: '护理项目',
      sortOrder: 1, isValid: true,
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-03-15'),
    }])
    const from = vi.fn().mockReturnValue({ orderBy })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getCategories()

    expect(result).toHaveLength(1)
    expect(result[0].categoryId).toBe('cat-1')
    expect(result[0].categoryName).toBe('护理项目')
  })
})

describe('getProducts — 商品列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回商品列表', async () => {
    // getProducts 内部有子查询 + 主查询
    let callIndex = 0
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        // 子查询: select → from → groupBy → as
        const as = vi.fn().mockReturnValue({ count: 'sku_count' })
        const groupBy = vi.fn().mockReturnValue({ as })
        const from = vi.fn().mockReturnValue({ groupBy })
        return { from }
      }
      // 主查询: select → from → leftJoin → leftJoin → orderBy → limit
      const limit = vi.fn().mockResolvedValue([{
        product: {
          productId: 'prod-1', name: '蜜语面膜', categoryId: 'cat-1',
          description: null, isShengmei: false, isBundle: false,
          price: '199.00', specialPrice: null, salesCategory: null,
          manageScope: null, marketScope: null,
          coverImage: null, detailImages: null,
          isEnabled: true, isVisible: true, sortOrder: 1,
          createdAt: new Date(), updatedAt: new Date(),
        },
        categoryName: '护理项目', productKind: '护理项目', skuCount: 2,
      }])
      const orderBy = vi.fn().mockReturnValue({ limit })
      const leftJoin2 = vi.fn().mockReturnValue({ orderBy })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    const result = await getProducts()

    expect(result).toHaveLength(1)
    expect(result[0].productId).toBe('prod-1')
  })
})

describe('getProductById — 单商品查询', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('未找到 → 返回 null', async () => {
    const limit = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ limit })
    const leftJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ leftJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getProductById('prod-999')

    expect(result).toBeNull()
  })

  it('找到 → 返回序列化的 Product', async () => {
    const limit = vi.fn().mockResolvedValue([{
      product: {
        productId: 'prod-1', name: '蜜语面膜', categoryId: 'cat-1',
        description: null, isShengmei: false, isBundle: false,
        price: '199.00', specialPrice: null, salesCategory: null,
        manageScope: null, marketScope: null,
        coverImage: null, detailImages: null,
        isEnabled: true, isVisible: true, sortOrder: 1,
        createdAt: new Date(), updatedAt: new Date(),
      },
      categoryName: '护理项目', productKind: '护理项目',
    }])
    const where = vi.fn().mockReturnValue({ limit })
    const leftJoin = vi.fn().mockReturnValue({ where })
    const from = vi.fn().mockReturnValue({ leftJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getProductById('prod-1')

    expect(result).not.toBeNull()
    expect(result!.productId).toBe('prod-1')
    expect(result!.categoryName).toBe('护理项目')
  })
})

// ── SKU 读函数 ────────────────────────────────────────────────────────────────

const mockSkuRow = {
  skuId: 'SKU-001', productId: 'prod-1', productType: '疗程卡',
  specName: '10次卡', price: '1999.00', specialPrice: null,
  sessionCount: 10, isBundleSku: false, sortOrder: 1, serviceFee: '50.00',
  isEnabled: true,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-03-15'),
}

describe('getSkusByProductId — 按商品查 SKU', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回序列化的 SKU 列表', async () => {
    const orderBy = vi.fn().mockResolvedValue([mockSkuRow])
    const where = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getSkusByProductId('prod-1')

    expect(result).toHaveLength(1)
    expect(result[0].skuId).toBe('SKU-001')
    expect(result[0].specName).toBe('10次卡')
    expect(result[0].sessionCount).toBe(10)
  })

  it('空结果 → []', async () => {
    const orderBy = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getSkusByProductId('prod-999')

    expect(result).toEqual([])
  })
})

describe('getAllSkus — 全量 SKU', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回全量 SKU 列表', async () => {
    const limit = vi.fn().mockResolvedValue([mockSkuRow])
    const orderBy = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ orderBy })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getAllSkus()

    expect(result).toHaveLength(1)
    expect(result[0].skuId).toBe('SKU-001')
    expect(result[0].productType).toBe('疗程卡')
  })
})
