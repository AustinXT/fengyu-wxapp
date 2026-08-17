/**
 * 商品路由测试
 * 覆盖：categories、spuList（分页/market_scope）、skuDetail、spuDetail、hotList、shopInit
 */

const pg = globalThis.__mocks__.pg
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

    expect(pg.query.mock.calls[0][0]).toContain('p.market_scope IS NULL')
    expect(pg.query.mock.calls[0][0]).toContain('sk.market_scope IS NULL')
    expect(pg.query.mock.calls[0][1]).toEqual([])
  })

  test('有绑定门店时商品和 SKU 均按门店所属市场 ID 列表过滤', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx({}, { boundMarketName: '华东市场' })
    await routes.categories(ctx)

    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain('p.market_scope')
    expect(calledSql).toContain('sk.market_scope')
    expect(calledSql).toContain('FROM stores s')
    expect(calledSql).toContain('pm.id = ANY')
    expect(params).toEqual([['store-001'], ['store-001']])
  })

  test('无绑定门店但有市场名时兼容历史名称范围', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx(
      {},
      { boundStoreId: null, boundStoreName: null, boundMarketName: '华东 市场' }
    )
    await routes.categories(ctx)

    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain("replace($1, ' ', '') = ANY")
    expect(calledSql).toContain("replace($2, ' ', '') = ANY")
    expect(calledSql).not.toContain('FROM stores s')
    expect(params).toEqual(['华东 市场', '华东 市场'])
  })
})

describe('product.spuList', () => {
  test('按分类查询商品列表', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: '美白护理', category_id: 'cat-1', category_name: '护理', product_kind: '护理项目', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_shengmei: false, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx({ categoryId: 'cat-1' })
    await routes.spuList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].name).toBe('美白护理')
    expect(ctx.result.spuList[0].priceFrom).toBe(80)
  })

  test('组合套餐展示套餐总价（SPU price），而非单次套餐价（SKU bundle_price）', async () => {
    // 599 体验福利：SPU 总价 599，含多个 SKU（招牌任选 3 次），单次套餐价 199.67
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-bundle', name: '599体验福利', category_id: 'cat-1', category_name: '体验', cover_image: '', sort_order: 1, price: 599, special_price: 599, is_bundle: true },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-bundle', sku_id: 's1', price: 199.67, special_price: 199.67, bundle_price: 199.67, sort_order: 1 },
      { product_id: 'p-bundle', sku_id: 's2', price: 199.67, special_price: 199.67, bundle_price: 199.67, sort_order: 2 },
    ])

    const ctx = createBoundCtx({ categoryId: 'cat-1' })
    await routes.spuList(ctx)

    // 列表应展示套餐总价 599，而非单次套餐价 199.67
    expect(ctx.result.spuList[0].priceFrom).toBe(599)
    expect(ctx.result.spuList[0].listPriceFrom).toBe(599)
  })

  test('商品存在性与下发 SKU 列表同步按绑定门店所属市场过滤', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: '美白护理', category_id: 'cat-1', category_name: '护理', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx(
      { categoryId: 'cat-1' },
      { boundStoreId: 'store-nanchang', boundMarketName: '南昌凤御' }
    )
    await routes.spuList(ctx)

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope')
    expect(productSql).toContain('sk.market_scope')
    expect(productSql).toContain('FROM stores s')
    expect(productSql).toContain('pm.id = ANY')
    expect(productParams).toEqual([['store-nanchang'], 'cat-1', ['store-nanchang']])

    const [skuSql, skuParams] = pg.query.mock.calls[1]
    expect(skuSql).toContain('sk.market_scope')
    expect(skuSql).toContain('FROM stores s')
    expect(skuParams).toEqual([['p1'], ['store-nanchang']])
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
    // skuDetail 仅查 product_skus + product_categories（cover_image 在 products 层，不属 SKU 详情）
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_type: '疗程卡',
      spec_name: '10次卡', price: 1000, special_price: 800,
      session_count: 10, service_fee: 0, sort_order: 1, is_shengmei: false,
      category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sales_category: null,
    }])

    const ctx = createCtx({ payload: { skuId: 'sku-1' } })
    await routes.skuDetail(ctx)

    expect(ctx.result.sku.sku_id).toBe('sku-1')
    expect(ctx.result.sku.spec_name).toBe('10次卡')
    expect(ctx.result.sku.category_name).toBe('护理项目')
  })

  test('按绑定门店所属市场过滤 SKU 可见范围', async () => {
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_type: '疗程卡',
      spec_name: '10次卡', price: 1000, special_price: 800,
      session_count: 10, service_fee: 0, sort_order: 1, is_shengmei: false,
      category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sales_category: null,
    }])

    const ctx = createBoundCtx(
      { skuId: 'sku-1' },
      { boundStoreId: 'store-nanchang', boundMarketName: '南昌凤御' }
    )
    await routes.skuDetail(ctx)

    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain('sk.market_scope')
    expect(calledSql).toContain('FROM stores s')
    expect(calledSql).toContain('pm.id = ANY')
    expect(params).toEqual(['sku-1', null, ['store-nanchang']])
  })

  test('缺少 skuId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.skuDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*skuId/)
  })

  test('商品不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createCtx({ payload: { skuId: 'nonexistent' } })
    await expect(routes.skuDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*商品不存在/)
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

  test('商品详情下发 SKU 列表同步按绑定门店所属市场过滤', async () => {
    pg.query.mockResolvedValueOnce([{
      product_id: 'p1', name: '美白护理', category_id: 'cat-1',
      category_name: '护理', cover_image: '', description: '', sort_order: 1,
      price: 100, special_price: 80, is_bundle: false,
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx(
      { productId: 'p1' },
      { boundStoreId: 'store-nanchang', boundMarketName: '南昌凤御' }
    )
    await routes.spuDetail(ctx)

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope')
    expect(productSql).toContain('FROM stores s')
    expect(productSql).toContain('pm.id = ANY')
    expect(productParams).toEqual(['p1', ['store-nanchang']])

    const [skuSql, skuParams] = pg.query.mock.calls[1]
    expect(skuSql).toContain('sk.market_scope')
    expect(skuSql).toContain('FROM stores s')
    expect(skuParams).toEqual(['p1', ['store-nanchang']])
  })

  test('缺少 productId → INVALID_PARAMS', async () => {
    const ctx = createCtx({ payload: {} })
    await expect(routes.spuDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*productId/)
  })

  test('商品不存在 → INVALID_PARAMS', async () => {
    pg.query.mockResolvedValueOnce([])
    const ctx = createCtx({ payload: { productId: 'nonexistent' } })
    await expect(routes.spuDetail(ctx)).rejects.toThrow(/INVALID_PARAMS.*商品不存在/)
  })
})

describe('product.hotList', () => {
  test('返回热门推荐列表', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', name: '热门A', category_id: 'c1', category_name: '护理', product_kind: '护理项目', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80, sort_order: 1 },
    ])

    const ctx = createBoundCtx({ limit: 3 })
    await routes.hotList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].priceFrom).toBe(80)

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope')
    expect(productSql).toContain('sk.market_scope')
    expect(productSql).toContain('FROM stores s')
    expect(productParams).toEqual([3, ['store-001'], ['store-001']])

    const [skuSql, skuParams] = pg.query.mock.calls[1]
    expect(skuSql).toContain('sk.market_scope')
    expect(skuSql).toContain('FROM stores s')
    expect(skuParams).toEqual([['p1'], ['store-001']])
  })
})

describe('product.shopInit', () => {
  test('返回 groups + 二级分类 + 第一个二级分类的商品列表', async () => {
    // 重构后：shopInit 并发查 getCategoryGroups + getCategoriesList，
    // 然后查第一个 group 下首个二级分类的商品（getProductListByCategory 内部 2 次 query）
    pg.query
      // 1) getCategoryGroups → 一级分组
      .mockResolvedValueOnce([
        { category_id: 'g-1', category_name: '护理', sort_order: 1 },
      ])
      // 2) getCategoriesList → 二级分类（category_group 必须等于 group 的 category_name）
      .mockResolvedValueOnce([
        { category_id: 'cat-1', category_name: '面部', category_group: '护理', category_order: 1 },
      ])
      // 3) getProductListByCategory products
      .mockResolvedValueOnce([
        { product_id: 'p1', name: 'A', category_id: 'cat-1', category_name: '面部', cover_image: '', description: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
      ])
      // 4) getProductListByCategory skus
      .mockResolvedValueOnce([
        { product_id: 'p1', sku_id: 'sku-1', product_type: '疗程卡', spec_name: '10次', price: 100, special_price: 80, session_count: 10, service_fee: 0, display_order: 1, bundle_price: null, bundle_group_id: null, group_name: null, group_pick_count: null },
      ])

    const ctx = createBoundCtx()
    await routes.shopInit(ctx)

    expect(ctx.result.groups).toHaveLength(1)
    expect(ctx.result.categories).toHaveLength(1)
    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].product_id).toBe('p1')

    expect(pg.query.mock.calls[0][0]).toContain('p.market_scope')
    expect(pg.query.mock.calls[1][0]).toContain('p.market_scope')
    expect(pg.query.mock.calls[2][0]).toContain('p.market_scope')

    const [skuSql, skuParams] = pg.query.mock.calls[3]
    expect(skuSql).toContain('sk.market_scope')
    expect(skuSql).toContain('FROM stores s')
    expect(skuParams).toEqual([['p1'], ['store-001']])
  })

  test('无分类时返回空列表', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.spuList).toEqual([])
  })
})

describe('product.experienceCardList', () => {
  test('按 sortOrder ASC 返回 is_experience = true 的 SKU 列表', async () => {
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-exp-1', product_type: '疗程卡', spec_name: '体验装', price: 99, special_price: 1, session_count: 1, service_fee: 0, sort_order: 1, product_id: 'p-trial-A', product_name: '焕活面部体验', cover_image: 'https://img/a.jpg', description: '新人专享' },
      { sku_id: 'sku-exp-2', product_type: '疗程卡', spec_name: '体验装', price: 199, special_price: 9, session_count: 1, service_fee: 0, sort_order: 2, product_id: 'p-trial-B', product_name: '小气泡体验', cover_image: 'https://img/b.jpg', description: null },
    ])

    const ctx = createBoundCtx()
    await routes.experienceCardList(ctx)

    expect(ctx.result.skuList).toHaveLength(2)
    expect(ctx.result.skuList[0].sku_id).toBe('sku-exp-1')
    expect(ctx.result.skuList[1].sku_id).toBe('sku-exp-2')

    // 验证 SQL：必须含 is_experience = true 过滤、is_enabled = true、按 sort_order ASC 排序
    const calledSql = pg.query.mock.calls[0][0]
    expect(calledSql).toMatch(/is_experience\s*=\s*true/)
    expect(calledSql).toMatch(/is_enabled\s*=\s*true/)
    expect(calledSql).toContain('sk.market_scope')
    expect(calledSql).toContain('FROM stores s')
    expect(calledSql).toMatch(/ORDER BY sk\.sort_order ASC/)
  })

  test('有绑定门店时按门店所属市场过滤 SKU 可见范围', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx(
      {},
      { boundStoreId: 'store-jiujiang', boundMarketName: '九江凤御' }
    )
    await routes.experienceCardList(ctx)

    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain('sk.market_scope')
    expect(calledSql).toContain('JOIN org_nodes pm')
    expect(calledSql).toContain('pm.id = ANY')
    expect(params).toEqual([['store-jiujiang']])
  })

  test('未绑定门店时只返回全局可见体验卡', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createNewUserCtx()
    await routes.experienceCardList(ctx)

    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain('sk.market_scope IS NULL')
    expect(calledSql).not.toContain('btrim(sk.market_scope) =')
    expect(calledSql).not.toContain('FROM stores s')
    expect(params).toEqual([])
  })

  test('SQL 不能用 SKU_VALID_FILTER（会反向过滤掉所有体验卡）', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.experienceCardList(ctx)

    const calledSql = pg.query.mock.calls[0][0]
    // SKU_VALID_FILTER 含 NOT (is_experience OR is_recharge_card)，本入口反向使用，必须不含
    expect(calledSql).not.toMatch(/NOT\s*\(\s*sk\.is_experience\s+OR/)
  })

  test('无体验卡时返回空 skuList', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.experienceCardList(ctx)

    expect(ctx.result.skuList).toEqual([])
  })
})
