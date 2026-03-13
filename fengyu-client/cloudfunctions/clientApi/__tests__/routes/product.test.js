/**
 * 商品路由测试
 * 覆盖：categories、spuList（分页/market_scope）、skuDetail、spuDetail、hotList、shopInit
 */

vi.mock('../../db/pg', () => require('../mocks/pg'))
vi.mock('wx-server-sdk', () => require('../mocks/wx-server-sdk'))

const pg = require('../../db/pg')
const { createCtx, createBoundCtx, createNewUserCtx } = require('../helpers')

let routes
beforeEach(() => {
  vi.clearAllMocks()
  routes = require('../../routes/product')
})

describe('product.categories', () => {
  test('返回有效分类列表', async () => {
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', category_order: 1 },
      { category_id: 'cat-2', category_name: '家居产品', product_kind: '家居产品', category_order: 2 },
    ])

    const ctx = createBoundCtx()
    await routes.categories(ctx)

    expect(ctx.result.categories).toHaveLength(2)
    expect(ctx.result.categories[0].category_name).toBe('护理项目')
  })

  test('无市场绑定时过滤 market_scope IS NULL', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createNewUserCtx()
    await routes.categories(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('market_scope IS NULL')
    expect(pg.query.mock.calls[0][1]).toEqual([])
  })

  test('有市场绑定时包含 market_scope 参数', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({}, { boundMarketName: '华东市场' })
    await routes.categories(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('market_scope')
    expect(pg.query.mock.calls[0][1]).toEqual(['华东市场'])
  })
})

describe('product.spuList', () => {
  test('按分类查询商品列表', async () => {
    // 商品
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: '美白护理', category_id: 'cat-1', category_name: '护理', product_kind: '护理项目', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_shengmei: false, is_bundle: false },
    ])
    // SKU
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx({ categoryId: 'cat-1' })
    await routes.spuList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].name).toBe('美白护理')
    expect(ctx.result.spuList[0].priceFrom).toBe(80)
  })

  test('无商品时返回空列表', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({ categoryId: 'cat-empty' })
    await routes.spuList(ctx)

    expect(ctx.result.spuList).toEqual([])
  })
})

describe('product.skuDetail', () => {
  test('正常返回 SKU 详情', async () => {
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1',
      product_id: 'p1',
      product_type: '疗程卡',
      spec_name: '10次卡',
      price: 1000,
      special_price: 800,
      session_count: 10,
      product_name: '美白护理',
      category_id: 'cat-1',
      category_name: '护理项目',
      product_kind: '护理项目',
    }])

    const ctx = createCtx({ payload: { skuId: 'sku-1' } })
    await routes.skuDetail(ctx)

    expect(ctx.result.sku.sku_id).toBe('sku-1')
    expect(ctx.result.sku.product_name).toBe('美白护理')
  })

  test('缺少 skuId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.skuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*skuId/)
  })

  test('SKU 不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { skuId: 'nonexistent' } })
    await expect(routes.skuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*SKU 不存在/)
  })
})

describe('product.spuDetail', () => {
  test('正常返回商品详情含 SKU 列表', async () => {
    pg.query.mockResolvedValueOnce([{
      product_id: 'p1', name: '美白护理', category_id: 'cat-1',
      category_name: '护理', product_kind: '护理项目',
      cover_image: '', description: '', sort_order: 1,
      price: 100, special_price: 80, is_shengmei: false, is_bundle: false,
      sales_category: null,
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
      { sku_id: 'sku-2', price: 200, special_price: 150, sort_order: 2 },
    ])

    const ctx = createCtx({ payload: { productId: 'p1' } })
    await routes.spuDetail(ctx)

    expect(ctx.result.spu.name).toBe('美白护理')
    expect(ctx.result.spu.skuList).toHaveLength(2)
    expect(ctx.result.spu.priceFrom).toBe(80)
  })

  test('缺少 productId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.spuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*productId/)
  })

  test('商品不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { productId: 'nonexistent' } })
    await expect(routes.spuDetail(ctx))
      .rejects.toThrow(/INVALID_PARAMS.*商品不存在/)
  })
})

describe('product.hotList', () => {
  test('返回热门推荐列表', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: '热门A', category_id: 'c1', category_name: '护理', product_kind: '护理项目', cover_image: '', sort_order: 1, price: 100, special_price: 80 },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx({ limit: 3 })
    await routes.hotList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].priceFrom).toBe(80)
  })
})

describe('product.shopInit', () => {
  test('返回分类 + 第一个分类的商品列表', async () => {
    // getCategoriesList
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理', product_kind: '护理项目', category_order: 1 },
    ])
    // getProductListByCategory（商品）
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: 'A', category_id: 'cat-1', category_name: '护理', product_kind: '护理项目', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_shengmei: false, is_bundle: false },
    ])
    // SKU
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx()
    await routes.shopInit(ctx)

    expect(ctx.result.categories).toHaveLength(1)
    expect(ctx.result.spuList).toHaveLength(1)
  })

  test('无分类时返回空列表', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.spuList).toEqual([])
  })
})
