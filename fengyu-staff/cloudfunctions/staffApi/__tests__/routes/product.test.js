/**
 * 商品模块路由测试
 * 覆盖：shopInit / categories / spuList / skuDetail / spuDetail
 */



const pg = globalThis.__mocks__.pg
const { createCtx } = require('../helpers')
const productRoutes = require('../../routes/product')


// ============================================================
// product.categories
// ============================================================
describe('product.categories', () => {
  test('返回排序后的分类列表', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sort_order: 1 },
      { category_id: 'cat-2', category_name: '家居产品', product_kind: '家居产品', sort_order: 2 },
    ])

    await productRoutes.categories(ctx)

    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0]).toEqual({
      id: 'cat-1',
      name: '护理项目',
      productKind: '护理项目',
      sortOrder: 1,
    })
  })

  test('无有效分类时返回空数组', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([])

    await productRoutes.categories(ctx)
    expect(ctx.result).toEqual([])
  })
})

// ============================================================
// product.spuList
// ============================================================
describe('product.spuList', () => {
  test('返回商品列表（含 SKU 及 priceFrom）', async () => {
    const ctx = createCtx({ payload: { categoryId: 'cat-1' } })

    pg.query.mockResolvedValueOnce([
      {
        product_id: 'prod-1', name: '面部护理', category_id: 'cat-1',
        category_name: '护理项目', product_kind: '护理项目',
        cover_image: null, description: '', sort_order: 1, list_price: '200',
      },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-1', product_id: 'prod-1', product_type: '疗程卡',
        spec_name: '基础款', price: '300', special_price: '200',
        session_count: 10, sort_order: 1,
      },
      {
        sku_id: 'sku-2', product_id: 'prod-1', product_type: '疗程卡',
        spec_name: '高级款', price: '500', special_price: null,
        session_count: 20, sort_order: 2,
      },
    ])

    await productRoutes.spuList(ctx)

    expect(ctx.result).toHaveLength(1)
    expect(ctx.result[0].spuId).toBe('prod-1')
    expect(ctx.result[0].priceFrom).toBe(200)
    expect(ctx.result[0].skus).toHaveLength(2)
  })

  test('无商品时返回空数组', async () => {
    const ctx = createCtx({ payload: {} })

    pg.query.mockResolvedValueOnce([])

    await productRoutes.spuList(ctx)
    expect(ctx.result).toEqual([])
  })
})

// ============================================================
// product.skuDetail
// ============================================================
describe('product.skuDetail', () => {
  test('找到 SKU 返回详情', async () => {
    const ctx = createCtx({ payload: { skuId: 'sku-1' } })

    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_id: 'prod-1', product_type: '疗程卡',
      spec_name: '基础款', price: '300', special_price: '200',
      session_count: 10, sort_order: 1,
      product_name: '面部护理', category_id: 'cat-1',
      category_name: '护理项目', product_kind: '护理项目',
      description: '深层清洁',
    }])

    await productRoutes.skuDetail(ctx)

    expect(ctx.result.sku.sku_id).toBe('sku-1')
    expect(ctx.result.sku.product_name).toBe('面部护理')
  })

  test('缺少 skuId 抛出 INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })

    await expect(productRoutes.skuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*skuId/)
  })

  test('SKU 不存在抛出 INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: { skuId: 'sku-nonexist' } })

    pg.query.mockResolvedValueOnce([])

    await expect(productRoutes.skuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*SKU.*不存在/)
  })
})

// ============================================================
// product.spuDetail
// ============================================================
describe('product.spuDetail', () => {
  test('找到商品返回详情（含 SKU 列表）', async () => {
    const ctx = createCtx({ payload: { spuId: 'prod-1' } })

    pg.query.mockResolvedValueOnce([{
      product_id: 'prod-1', name: '面部护理', category_id: 'cat-1',
      category_name: '护理项目', product_kind: '护理项目',
      cover_image: null, description: '深层清洁', sort_order: 1,
      price: '300', special_price: '200', is_bundle: false,
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', product_type: '疗程卡', spec_name: '基础款', price: '300', special_price: '200', session_count: 10, sort_order: 1 },
      { sku_id: 'sku-2', product_type: '疗程卡', spec_name: '高级款', price: '500', special_price: '400', session_count: 20, sort_order: 2 },
    ])

    await productRoutes.spuDetail(ctx)

    expect(ctx.result.spu.product_id).toBe('prod-1')
    expect(ctx.result.spu.skuList).toHaveLength(2)
    expect(ctx.result.spu.priceFrom).toBe(200)
  })

  test('缺少 spuId 抛出 INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })

    await expect(productRoutes.spuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*spuId/)
  })

  test('商品不存在抛出 INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: { spuId: 'prod-nonexist' } })

    pg.query.mockResolvedValueOnce([])

    await expect(productRoutes.spuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*商品.*不存在/)
  })
})

// ============================================================
// product.shopInit
// ============================================================
describe('product.shopInit', () => {
  test('返回分类列表 + 第一个分类的商品', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sort_order: 1 },
      { category_id: 'cat-2', category_name: '家居产品', product_kind: '家居产品', sort_order: 2 },
    ])
    pg.query.mockResolvedValueOnce([
      {
        product_id: 'prod-1', name: '面部护理', category_id: 'cat-1',
        category_name: '护理项目', product_kind: '护理项目',
        cover_image: null, description: '', sort_order: 1, list_price: '200',
      },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-1', product_id: 'prod-1', product_type: '疗程卡',
        spec_name: '基础款', price: '300', special_price: '200',
        session_count: 10, sort_order: 1,
      },
    ])

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toHaveLength(2)
    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].spuId).toBe('prod-1')
  })

  test('无分类时返回空商品列表', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([])

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.spuList).toEqual([])
  })
})

// ============================================================
// product.promotionList / promotionPlans (stubs)
// ============================================================
describe('product.promotionList', () => {
  test('返回空 schemes 数组', async () => {
    const ctx = createCtx()

    await productRoutes.promotionList(ctx)
    expect(ctx.result).toEqual({ schemes: [] })
  })
})

describe('product.promotionPlans', () => {
  test('返回空数组', async () => {
    const ctx = createCtx()

    await productRoutes.promotionPlans(ctx)
    expect(ctx.result).toEqual([])
  })
})
