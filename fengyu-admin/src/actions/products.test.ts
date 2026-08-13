import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.spyOn(crypto, 'randomUUID').mockReturnValue('mock-uuid-1234' as any)

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
}))

vi.mock('@db/product', () => ({
  productCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    productKind: 'product_kind',
    sortOrder: 'sort_order',
    isValid: 'is_valid',
    displayColor: 'display_color',
    updatedAt: 'updated_at',
  },
  products: {
    productId: 'product_id',
    categoryId: 'category_id',
    name: 'name',
    sortOrder: 'sort_order',
    deletedAt: 'deleted_at',
    salesCategory: 'sales_category',
    updatedAt: 'updated_at',
    productId_: 'product_id',
  },
  productSkus: {
    skuId: 'sku_id',
    categoryId: 'category_id',
    productType: 'product_type',
    purchaseLimit: 'purchase_limit',
    updatedAt: 'updated_at',
    sortOrder: 'sort_order',
  },
  mallCategories: {
    categoryId: 'category_id',
    categoryName: 'category_name',
    categoryGroup: 'category_group',
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
  asc: vi.fn((col) => ({ type: 'asc', col })),
  sql: Object.assign(vi.fn(() => ({ as: vi.fn() })), { raw: vi.fn() }),
  isNull: vi.fn((col) => ({ type: 'isNull', col })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  inArray: vi.fn((col, vals) => ({ type: 'inArray', col, vals })),
  ilike: vi.fn((col, value) => ({ type: 'ilike', col, value })),
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  expandVisibleMarketIds: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/operation-log', () => ({
  logOperation: vi.fn(),
  logUpdate: vi.fn(),
  logTransition: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import {
  createProduct,
  updateProduct,
  createCategory,
  updateCategory,
  deleteCategory,
  updateProductKind,
  createSku,
  updateSku,
  deleteSku,
  getCategories,
  getProductKinds,
  getProducts,
  exportMallProducts,
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

function mockSelectBefore(rows: any[] = [{}]) {
  const chain: any = {}
  chain.from = vi.fn().mockReturnValue(chain)
  chain.where = vi.fn().mockReturnValue(chain)
  chain.limit = vi.fn().mockResolvedValue(rows)
  chain.leftJoin = vi.fn().mockReturnValue(chain)
  chain.orderBy = vi.fn().mockReturnValue(chain)
  ;(db.select as any).mockReturnValue(chain)
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

  it('会员价为负数 → 允许（交由前端/DB 约束校验）', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100', specialPrice: '-5' })
    expect(result.success).toBe(true)
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
    mockSelectBefore()
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
    // 一级 kind 存在
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'kind-care' }]))
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('分类编号已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'kind-care' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'kind-care' }]))
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createCategory({ categoryName: '测试分类', productKind: '护理项目' })
    expect(result.success).toBe(true)
    expect(result.message).toContain('分类创建成功')
  })

  it('品项一级分类不存在 → INVALID_PARAMS', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await createCategory({ categoryName: '测试分类', productKind: '不存在的 kind' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('品项一级分类不存在或已停用')
    expect(db.insert).not.toHaveBeenCalled()
  })
})

// ── updateCategory ────────────────────────────────────────────────────────────

describe('updateCategory — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
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

  it('传了不存在的 productKind → INVALID_PARAMS', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await updateCategory('CAT-1', { productKind: '不存在的 kind' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('品项一级分类不存在或已停用')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('updateCategory({isValid: false}) → 成功（停用路径走 update 而非 delete）', async () => {
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
    const result = await updateCategory('CAT-1', { isValid: false }, '2026-05-18T00:00:00.000Z')
    expect(result.success).toBe(true)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ isValid: false }))
  })
})

// ── deleteCategory ────────────────────────────────────────────────────────────

describe('deleteCategory — 引用校验 + 硬删', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('有 SKU 引用 → 拒绝删除，提示 REFERENCE_EXISTS', async () => {
    // 第 1 次 select: SKU 引用计数（>0）
    ;(db.select as any).mockImplementation(makeSelectChain([{ c: 3 }]))
    const result = await deleteCategory('CAT-1', '2026-05-18T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('INVALID_STATE: REFERENCE_EXISTS')
    expect(result.message).toContain('3 个 SKU')
    expect(db.execute).not.toHaveBeenCalled()
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('有优惠券引用 → 拒绝删除，提示 REFERENCE_EXISTS', async () => {
    // 第 1 次 select: SKU 引用计数（0）
    ;(db.select as any).mockImplementation(makeSelectChain([{ c: 0 }]))
    // 第 2 次：db.execute 返回优惠券引用计数（drizzle 返回 array-like {rows: [...]} 或 array）
    ;(db.execute as any).mockResolvedValue({ rows: [{ c: 2 }] })
    const result = await deleteCategory('CAT-1', '2026-05-18T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('INVALID_STATE: REFERENCE_EXISTS')
    expect(result.message).toContain('2 张优惠券')
    expect(db.delete).not.toHaveBeenCalled()
  })

  it('无引用 + CAS 命中 → 删除成功', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ c: 0 }]))
    ;(db.execute as any).mockResolvedValue({ rows: [{ c: 0 }] })
    const where = vi.fn().mockResolvedValue({ count: 1 })
    ;(db.delete as any).mockReturnValue({ where })
    const result = await deleteCategory('CAT-1', '2026-05-18T00:00:00.000Z')
    expect(result.success).toBe(true)
    expect(result.message).toContain('分类已删除')
    expect(db.delete).toHaveBeenCalledTimes(1)
  })

  it('CAS 未命中（被改） → CONFLICT 提示', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ c: 0 }]))
    ;(db.execute as any).mockResolvedValue({ rows: [{ c: 0 }] })
    const where = vi.fn().mockResolvedValue({ count: 0 })
    ;(db.delete as any).mockReturnValue({ where })
    const result = await deleteCategory('CAT-1', '2026-05-18T00:00:00.000Z')
    expect(result.success).toBe(false)
    expect(result.message).toContain('CONFLICT')
  })
})

// ── updateProductKind 级联 ────────────────────────────────────────────────────

describe('updateProductKind — 改名级联', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('改名时级联 UPDATE 子级的 product_kind', async () => {
    // 第 1 次 select: 当前一级行；第 2 次 select: 重名检查（无重复）
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      if (call === 1) {
        return makeSelectChain([{
          categoryId: 'kind-care',
          categoryName: '护理项目',
          productKind: null,
          sortOrder: 2,
          isValid: true,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }])()
      }
      return makeSelectChain([])()
    })

    const setCalls: Array<Record<string, unknown>> = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            setCalls.push(data)
            return { where: vi.fn().mockResolvedValue({}) }
          }),
        }),
      }
      return fn(tx)
    })

    const result = await updateProductKind('kind-care', { categoryName: '新护理项目' })
    expect(result.success).toBe(true)
    // 第 1 次 set: 更新自身 categoryName；第 2 次 set: 级联更新 productKind
    expect(setCalls).toHaveLength(2)
    expect(setCalls[0]).toMatchObject({ categoryName: '新护理项目' })
    expect(setCalls[1]).toEqual({ productKind: '新护理项目' })
  })

  it('未改名时不触发级联 UPDATE', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      if (call === 1) {
        return makeSelectChain([{
          categoryId: 'kind-care',
          categoryName: '护理项目',
          productKind: null,
          sortOrder: 2,
          isValid: true,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }])()
      }
      return makeSelectChain([])()
    })

    const setCalls: Array<Record<string, unknown>> = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            setCalls.push(data)
            return { where: vi.fn().mockResolvedValue({}) }
          }),
        }),
      }
      return fn(tx)
    })

    const result = await updateProductKind('kind-care', { sortOrder: 5 })
    expect(result.success).toBe(true)
    // 只有 1 次 set（自身 sortOrder），没有级联
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toMatchObject({ sortOrder: 5 })
  })

  it('updateProductKind 接收 capability 字段（displayColor）', async () => {
    let call = 0
    ;(db.select as any).mockImplementation(() => {
      call++
      if (call === 1) {
        return makeSelectChain([{
          categoryId: 'kind-test', categoryName: '测试卡', productKind: null,
          sortOrder: 9, isValid: true,
          displayColor: null,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }])()
      }
      return makeSelectChain([])()
    })

    const setCalls: Array<Record<string, unknown>> = []
    ;(db.transaction as any).mockImplementation(async (fn: any) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            setCalls.push(data)
            return { where: vi.fn().mockResolvedValue({}) }
          }),
        }),
      }
      return fn(tx)
    })

    const result = await updateProductKind('kind-test', {
      displayColor: '#FF00FF',
    })
    expect(result.success).toBe(true)
    expect(setCalls[0]).toMatchObject({
      displayColor: '#FF00FF',
    })
  })
})

describe('getProductKinds — 一级 kind 含 capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回结构含 displayColor', async () => {
    const orderBy = vi.fn().mockResolvedValue([{
      categoryId: 'kind-care', categoryName: '护理项目', productKind: null,
      sortOrder: 2, isValid: true,
      displayColor: '#1989FA',
      createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    }])
    const where = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ where })
    ;(db.select as any).mockReturnValue({ from })

    const kinds = await getProductKinds()
    expect(kinds[0]).toMatchObject({
      categoryName: '护理项目',
      displayColor: '#1989FA',
    })
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
    categoryId: 'cat-hr-01',
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

  it('purchaseLimit < 1 → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, purchaseLimit: 0 })
    expect(result.success).toBe(false)
    expect(result.message).toContain('限购次数必须为正整数')
  })

  it('商品编号重复（23505）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品编号已存在')
  })

  it('品项分类不存在（23503）→ 友好消息', async () => {
    const pgError = Object.assign(new Error('FK violation'), { code: '23503' })
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(pgError) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(false)
    expect(result.message).toContain('品项分类不存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(createSku(baseSkuData)).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createSku(baseSkuData)
    expect(result.success).toBe(true)
    expect(result.message).toContain('商品创建成功')
  })

  it('未填写单位时，疗程卡默认使用「次」', async () => {
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    await createSku(baseSkuData)

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ unit: '次' }))
  })

  it('未填写单位时，家居产品默认使用「盒」', async () => {
    const values = vi.fn().mockResolvedValue({})
    ;(db.insert as any).mockReturnValue({ values })

    await createSku({
      ...baseSkuData,
      skuId: 'SKU-HOME-001',
      productType: '家居产品',
      sessionCount: null,
    })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ unit: '盒' }))
  })

  it('空白单位 → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, unit: '  ' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('单位不能为空')
  })
})

// ── updateSku ─────────────────────────────────────────────────────────────────

describe('updateSku — rowCount=0 静默成功修复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
    mockSelectBefore()
  })

  function setupUpdate(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('rowCount=0，无乐观锁 → 报告商品不存在', async () => {
    setupUpdate(0)
    const result = await updateSku('SKU-999', { specName: '新规格' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品不存在')
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

  it('purchaseLimit < 1 → 拒绝', async () => {
    const result = await updateSku('SKU-001', { purchaseLimit: 0 })
    expect(result.success).toBe(false)
    expect(result.message).toContain('限购次数必须为正整数')
  })
})

// ── updateSku — 疗程卡 session_count 守卫（与 createSku 对齐） ─────────────────

describe('updateSku — 疗程卡 session_count 守卫（与 createSku 对齐）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  // 守卫位于 products.ts updateSku ~710-716，含非平凡偏序：
  //   (data.productType ?? before.productType) === '疗程卡'
  //   finalSessionCount = data.sessionCount !== undefined ? data.sessionCount : before.sessionCount
  // 简化为 `data.sessionCount ?? before.sessionCount` 会漏掉 null 显式传入（case c）。

  it('疗程卡 sessionCount < 1 → 拒绝', async () => {
    mockSelectBefore([{ skuId: 'SKU-001', productType: '疗程卡', sessionCount: 10 }])
    const result = await updateSku('SKU-001', { sessionCount: 0 })
    expect(result.success).toBe(false)
    expect(result.message).toContain('疗程卡的次数必须 >= 1')
  })

  it('家居→疗程卡切换 + before.sessionCount=null 脏数据 → 拒绝', async () => {
    mockSelectBefore([{ skuId: 'SKU-001', productType: '家居产品', sessionCount: null }])
    const result = await updateSku('SKU-001', { productType: '疗程卡' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('疗程卡的次数必须 >= 1')
  })

  it('疗程卡 data.sessionCount=null → 拒绝', async () => {
    mockSelectBefore([{ skuId: 'SKU-001', productType: '疗程卡', sessionCount: 10 }])
    const result = await updateSku('SKU-001', { sessionCount: null })
    expect(result.success).toBe(false)
    expect(result.message).toContain('疗程卡的次数必须 >= 1')
  })

  it('疗程卡 data.sessionCount=5 → 通过（守护不误拦正常更新）', async () => {
    mockSelectBefore([{ skuId: 'SKU-001', productType: '疗程卡', sessionCount: 10 }])
    const where = vi.fn().mockResolvedValue({ count: 1 })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
    const result = await updateSku('SKU-001', { sessionCount: 5 })
    expect(result.success).toBe(true)
    expect(result.message).toContain('已更新')
    expect(result.message).not.toContain('疗程卡的次数必须 >= 1')
  })
})

// ── deleteSku ─────────────────────────────────────────────────────────────────

describe('deleteSku — 引用校验 + 软删', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  // 软删流程需要两次 db.select：1) saleItems 引用 guard；2) productSkus 快照。
  function setupSelectsForDelete(refRows: any[], snapshotRows: any[]) {
    let callCount = 0
    ;(db.select as any).mockImplementation(() => {
      callCount += 1
      const rows = callCount === 1 ? refRows : snapshotRows
      return makeSelectChain(rows)()
    })
  }

  function setupUpdateForDelete(count: number) {
    const where = vi.fn().mockResolvedValue({ count })
    const set = vi.fn().mockReturnValue({ where })
    ;(db.update as any).mockReturnValue({ set })
  }

  it('SKU 被订单引用 → 拒绝删除（不进入快照/软删流程）', async () => {
    setupSelectsForDelete([{ saleItemId: 'item-1' }], [])
    const result = await deleteSku('SKU-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被订单引用')
    expect(db.delete).not.toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it('SKU 不存在 / 已删 → 报告不存在', async () => {
    setupSelectsForDelete([], [])
    const result = await deleteSku('SKU-999')
    expect(result.success).toBe(false)
    expect(result.message).toContain('不存在')
    expect(db.update).not.toHaveBeenCalled()
  })

  it('SKU 未被引用 → 软删成功（mallProductSkus 物理删 + productSkus update deleted_at）', async () => {
    setupSelectsForDelete([], [{
      skuId: 'SKU-001', categoryId: 'CAT-1', specName: '测试规格',
      price: '100.00', productType: '护理项目', isExperience: false,
    }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({}) })
    setupUpdateForDelete(1)
    const result = await deleteSku('SKU-001')
    expect(result.success).toBe(true)
    expect(result.message).toContain('已删除')
    // mallProductSkus 物理删一次
    expect(db.delete).toHaveBeenCalledTimes(1)
    // productSkus 软删一次
    expect(db.update).toHaveBeenCalledTimes(1)
  })

  it('软删 update rowCount=0 → 并发冲突提示', async () => {
    setupSelectsForDelete([], [{
      skuId: 'SKU-001', categoryId: 'CAT-1', specName: '测试规格',
      price: '100.00', productType: '护理项目', isExperience: false,
    }])
    ;(db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue({}) })
    setupUpdateForDelete(0)
    const result = await deleteSku('SKU-001')
    expect(result.success).toBe(false)
    expect(result.message).toContain('请刷新重试')
  })
})

// ── 读函数覆盖 ───────────────────────────────────────────────────────────────

describe('getCategories — 品项分类列表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('返回序列化的分类列表（含父级 capability 回填）', async () => {
    // getCategories 现在 LEFT JOIN parent 行，回填 parent displayColor。
    const orderBy = vi.fn().mockResolvedValue([{
      child: {
        categoryId: 'cat-1', categoryName: '面部护理', productKind: '护理项目',
        salesCategory: '自销自耗',
        sortOrder: 1, isValid: true,
        displayColor: null,
        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-03-15'),
      },
      parentDisplayColor: '#1989FA',
    }])
    const leftJoin = vi.fn().mockReturnValue({ orderBy })
    const from = vi.fn().mockReturnValue({ leftJoin })
    ;(db.select as any).mockReturnValue({ from })

    const result = await getCategories()

    expect(result).toHaveLength(1)
    expect(result[0].categoryId).toBe('cat-1')
    expect(result[0].categoryName).toBe('面部护理')
    expect(result[0].parentDisplayColor).toBe('#1989FA')
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
      // 主查询: select → from → leftJoin → leftJoin → where → orderBy
      const orderBy = vi.fn().mockResolvedValue([{
        product: {
          productId: 'prod-1', name: '蜜语面膜', categoryId: 'cat-1',
          description: null, isShengmei: false, isBundle: false,
          price: '199.00', specialPrice: null, salesCategory: null,
          manageScope: null, marketScope: null,
          coverImage: null, detailImages: null,
          isVisible: true, sortOrder: 1,
          createdAt: new Date(), updatedAt: new Date(),
        },
        categoryName: '护理项目', productKind: '护理项目', skuCount: 2,
      }])
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin2 = vi.fn().mockReturnValue({ where })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    const result = await getProducts()

    expect(result).toHaveLength(1)
    expect(result[0].productId).toBe('prod-1')
  })
})

describe('exportMallProducts — 商城商品导出', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getSession as any).mockResolvedValue(mockSession)
  })

  it('按筛选条件分批查询并返回稳定游标', async () => {
    const sourceRows = [1, 2, 3].map((index) => ({
      product: {
        productId: `prod-${index}`,
        categoryId: 'cat-1',
        name: `商城商品 ${index}`,
        coverImage: null,
        detailImages: null,
        description: null,
        isBundle: index === 1,
        price: '199.00',
        specialPrice: null,
        manageScope: null,
        marketScope: null,
        sortOrder: index,
        isVisible: true,
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T01:00:00.000Z'),
      },
      categoryName: '面膜',
      categoryGroup: '居家护理',
      skuCount: index,
    }))

    let callIndex = 0
    const offset = vi.fn().mockResolvedValue(sourceRows)
    const limit = vi.fn().mockReturnValue({ offset })
    ;(db.select as any).mockImplementation(() => {
      callIndex++
      if (callIndex === 1) {
        const as = vi.fn().mockReturnValue({ count: 'sku_count' })
        const groupBy = vi.fn().mockReturnValue({ as })
        const from = vi.fn().mockReturnValue({ groupBy })
        return { from }
      }
      const query = { limit }
      const orderBy = vi.fn().mockReturnValue(query)
      const where = vi.fn().mockReturnValue({ orderBy })
      const leftJoin2 = vi.fn().mockReturnValue({ where })
      const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2 })
      const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1 })
      return { from }
    })

    const result = await exportMallProducts(
      { q: '商品', category: 'cat-1' },
      { limit: 2, cursor: 4 },
    )

    expect(limit).toHaveBeenCalledWith(3)
    expect(offset).toHaveBeenCalledWith(4)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({
      productId: 'prod-1',
      categoryName: '面膜',
      categoryGroup: '居家护理',
      skuCount: 1,
    })
    expect(result).toMatchObject({ hasMore: true, nextCursor: 6 })
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
        isVisible: true, sortOrder: 1,
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
    const mockRow = { sku: mockSkuRow, bundlePrice: null, bundleGroupId: null, displayOrder: 1, groupName: null }
    const orderBy = vi.fn().mockResolvedValue([mockRow])
    const where = vi.fn().mockReturnValue({ orderBy })
    const leftJoin = vi.fn().mockReturnValue({ where })
    const innerJoin = vi.fn().mockReturnValue({ leftJoin })
    const from = vi.fn().mockReturnValue({ innerJoin })
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
    const leftJoin = vi.fn().mockReturnValue({ where })
    const innerJoin = vi.fn().mockReturnValue({ leftJoin })
    const from = vi.fn().mockReturnValue({ innerJoin })
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
    const mockRow = { sku: mockSkuRow, categoryName: '护理项目', productKind: '护理项目', salesCategory: null }
    // chain 自引用：leftJoin/where/orderBy 都返回 chain 本身，支持连续 leftJoin
    // （products.ts getAllSkus 有 2 个 leftJoin：productCategories + projectSeriesLookup）。
    const chain: any = {}
    chain.limit = vi.fn().mockResolvedValue([mockRow])
    chain.orderBy = vi.fn().mockResolvedValue([mockRow])
    chain.where = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    const from = vi.fn().mockReturnValue(chain)
    ;(db.select as any).mockReturnValue({ from })

    const result = await getAllSkus()

    expect(result).toHaveLength(1)
    expect(result[0].skuId).toBe('SKU-001')
    expect(result[0].productType).toBe('疗程卡')
  })
})
