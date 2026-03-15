import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    productId: 'product_id',
    productType: 'product_type',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: { saleItemId: 'sale_item_id', skuId: 'sku_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
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

  it('特价为负数 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100', specialPrice: '-5' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('特价必须为非负数')
  })

  it('分类不存在 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([]))
    const result = await createProduct({ productId: 'P-001', categoryId: 'CAT-999', name: '测试商品', price: '100' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('商品分类不存在')
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('有效期开始晚于结束 → 拒绝', async () => {
    ;(db.select as any).mockImplementation(makeSelectChain([{ categoryId: 'CAT-1' }]))
    const result = await createProduct({
      productId: 'P-001', categoryId: 'CAT-1', name: '测试商品', price: '100',
      validStart: '2026-12-01', validEnd: '2026-01-01',
    })
    expect(result.success).toBe(false)
    expect(result.message).toContain('有效期')
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

  function setupUpdate(rowCount: number) {
    const where = vi.fn().mockResolvedValue({ rowCount })
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
    const result = await createCategory({ categoryId: 'CAT-1', categoryName: '测试分类', productKind: '护理项目' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('分类编号已存在')
  })

  it('其他 DB 异常 → 重新抛出', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('connection lost')) })
    await expect(
      createCategory({ categoryId: 'CAT-1', categoryName: '测试分类', productKind: '护理项目' })
    ).rejects.toThrow('connection lost')
  })

  it('正常创建 → 成功', async () => {
    ;(db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue({}) })
    const result = await createCategory({ categoryId: 'CAT-1', categoryName: '测试分类', productKind: '护理项目' })
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

  function setupUpdate(rowCount: number) {
    const where = vi.fn().mockResolvedValue({ rowCount })
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

  it('有效期开始晚于结束 → 拒绝', async () => {
    const result = await createSku({ ...baseSkuData, validStart: '2026-12-01', validEnd: '2026-01-01' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('有效期')
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

  function setupUpdate(rowCount: number) {
    const where = vi.fn().mockResolvedValue({ rowCount })
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
