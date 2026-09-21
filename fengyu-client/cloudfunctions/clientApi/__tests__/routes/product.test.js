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

  test('未绑定门店时商品要求全市场，但允许指定市场 SKU 参与目录展示', async () => {
    pg.query.mockResolvedValueOnce([])

    const ctx = createNewUserCtx()
    await routes.categories(ctx)

    expect(pg.query.mock.calls[0][0]).toContain('p.market_scope IS NULL')
    expect(pg.query.mock.calls[0][0]).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(pg.query.mock.calls[0][0]).not.toContain('FROM stores s')
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

  test('未绑定门店时全市场 SPU 可带指定市场 SKU 返回', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', name: '全市场商品', category_id: 'cat-1', category_name: '护理', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', sku_id: 'sku-market', price: 100, special_price: 80, market_scope: 'market-other', sort_order: 1 },
    ])

    const ctx = createNewUserCtx({ categoryId: 'cat-1' })
    await routes.spuList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].skuList).toHaveLength(1)
    expect(ctx.result.spuList[0].skuList[0].sku_id).toBe('sku-market')

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope IS NULL')
    expect(productSql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(productSql).not.toContain('FROM stores s')
    expect(productParams).toEqual(['cat-1'])

    const [skuSql, skuParams] = pg.query.mock.calls[1]
    expect(skuSql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(skuSql).not.toContain('FROM stores s')
    expect(skuParams).toEqual([['p-global']])
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

describe('product.search', () => {
  test('未绑定门店时可搜索到全市场 SPU 的指定市场 SKU', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', name: '全市场商品', category_id: 'cat-1', category_name: '护理', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', sku_id: 'sku-market', price: 100, special_price: 80, market_scope: 'market-other', sort_order: 1 },
    ])

    const ctx = createNewUserCtx({ keyword: '全市场' })
    await routes.search(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].skuList[0].sku_id).toBe('sku-market')

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope IS NULL')
    expect(productSql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(productParams).toEqual(['%全市场%'])
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

  test('未绑定门店时指定市场 SKU 详情可用于直接下单预览', async () => {
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-market', product_type: '疗程卡',
      spec_name: '市场专属卡', price: 1000, special_price: 800,
      session_count: 10, service_fee: 0, sort_order: 1, is_shengmei: false,
      category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sales_category: null,
    }])

    const ctx = createNewUserCtx({ skuId: 'sku-market' })
    await routes.skuDetail(ctx)

    expect(ctx.result.sku.sku_id).toBe('sku-market')
    const [calledSql, params] = pg.query.mock.calls[0]
    expect(calledSql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(calledSql).not.toContain('FROM stores s')
    expect(params).toEqual(['sku-market', null])
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

  test('未绑定门店时全市场商品详情包含指定市场 SKU', async () => {
    pg.query.mockResolvedValueOnce([{
      product_id: 'p-global', name: '全市场商品', category_id: 'cat-1',
      category_name: '护理', cover_image: '', description: '', sort_order: 1,
      price: 100, special_price: 80, is_bundle: false,
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-market', price: 100, special_price: 80, market_scope: 'market-other', sort_order: 1 },
    ])

    const ctx = createNewUserCtx({ productId: 'p-global' })
    await routes.spuDetail(ctx)

    expect(ctx.result.spu.skuList).toHaveLength(1)
    expect(ctx.result.spu.skuList[0].sku_id).toBe('sku-market')

    const [productSql, productParams] = pg.query.mock.calls[0]
    expect(productSql).toContain('p.market_scope IS NULL')
    expect(productParams).toEqual(['p-global'])

    const [skuSql, skuParams] = pg.query.mock.calls[1]
    expect(skuSql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(skuSql).not.toContain('FROM stores s')
    expect(skuParams).toEqual(['p-global'])
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

  test('未绑定门店时全市场商品可带指定市场 SKU 出现在热门列表', async () => {
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', name: '热门全市场商品', category_id: 'c1', category_name: '护理', cover_image: '', sort_order: 1, price: 100, special_price: 80, is_bundle: false },
    ])
    pg.query.mockResolvedValueOnce([
      { product_id: 'p-global', sku_id: 'sku-market', price: 100, special_price: 80, market_scope: 'market-other', sort_order: 1 },
    ])

    const ctx = createNewUserCtx({ limit: 3 })
    await routes.hotList(ctx)

    expect(ctx.result.spuList).toHaveLength(1)
    expect(ctx.result.spuList[0].priceFrom).toBe(80)
    expect(pg.query.mock.calls[0][0]).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(pg.query.mock.calls[0][1]).toEqual([3])
    expect(pg.query.mock.calls[1][0]).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
    expect(pg.query.mock.calls[1][1]).toEqual([['p-global']])
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

  test('未绑定门店时分类与分组查询允许全市场 SPU 的指定市场 SKU', async () => {
    pg.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const ctx = createNewUserCtx()
    await routes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.spuList).toEqual([])
    for (const [sql, params] of pg.query.mock.calls) {
      expect(sql).toContain('p.market_scope IS NULL')
      expect(sql).toContain("sk.market_scope IS NULL OR btrim(sk.market_scope) <> ''")
      expect(sql).not.toContain('FROM stores s')
      expect(params).toEqual([])
    }
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

/**
 * issue #230：商品封面图下发前的尺寸约束。
 *
 * 背景与 #213 同根因——解码内存只跟分辨率有关，与文件体积无关。
 * 生产库里出现过 405KB / 12576×12575 的 PNG（解码 ~603MB），
 * 靠上传侧的 file.size 校验拦不住，必须在下发的 URL 上限制输出分辨率。
 *
 * 契约有两条，两条都要守：
 * 1. 能缩略的 → URL 带 imageMogr2/thumbnail/NxN（双边 box，解码封顶 N×N×4）
 * 2. 不能保证缩略的 → 下发 null，**不退回原图**（退回原图 = 保护静默失效）
 */
describe('issue #230：商品封面图缩略下发', () => {
  /** 生产实际形态（45/45 条均为此格式）：CloudBase COS 域名 + 两段 ASCII 对象键 */
  const COS_COVER_URL = 'https://test-env-1300000000.tcb.qcloud.la/product-covers/a.jpg'
  const COS_DETAIL_URL = 'https://test-env-1300000000.tcb.qcloud.la/product-details/d1.jpg'
  /** 非 COS 域名：数据万象不生效，拼参数等于没保护，按 fail-closed 返回 null */
  const NON_COS_URL = 'https://img.example.com/a.jpg'

  const LARGE = 'imageMogr2/thumbnail/1080x1080'
  const SMALL = 'imageMogr2/thumbnail/400x400'
  /** 详情长图走面积模式（总像素约束），不是 box —— 见下方「长图必须用面积模式」用例 */
  const AREA = 'imageMogr2/thumbnail/2250000@'

  function mockProductRow(overrides = {}) {
    return {
      product_id: 'p1', name: '美白护理', category_id: 'cat-1', category_name: '护理',
      cover_image: COS_COVER_URL, description: '', sort_order: 1,
      price: 100, special_price: 80, is_bundle: false,
      ...overrides,
    }
  }

  test('spuList：列表封面走大档（shop 页整行展示）', async () => {
    pg.query.mockResolvedValueOnce([mockProductRow()])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', price: 100, special_price: 80 }])

    const ctx = createBoundCtx()
    await routes.spuList(ctx)

    expect(ctx.result.spuList[0].cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
  })

  test('search / shopInit 与 spuList 共用同一实现，缩略同样生效', async () => {
    // 三个入口都走 getProductListByCategory，一处改写覆盖三者——
    // 这条用 search 抽样验证，防止将来有人只给 spuList 加保护
    pg.query.mockResolvedValueOnce([mockProductRow()])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', price: 100, special_price: 80 }])

    const ctx = createBoundCtx({ keyword: '美白' })
    await routes.search(ctx)

    expect(ctx.result.spuList[0].cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
  })

  test('hotList：当前无前端消费者，仍按同口径保护', async () => {
    pg.query.mockResolvedValueOnce([mockProductRow()])
    pg.query.mockResolvedValueOnce([{ product_id: 'p1', sku_id: 'sku-1', price: 100, special_price: 80 }])

    const ctx = createBoundCtx()
    await routes.hotList(ctx)

    expect(ctx.result.spuList[0].cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
  })

  test('skuDetail：结算页与体验卡详情共用，按大者取档', async () => {
    pg.query.mockResolvedValueOnce([{
      sku_id: 'sku-1', product_type: '疗程卡', spec_name: '标准',
      price: 100, special_price: 80, cover_image: COS_COVER_URL,
    }])

    const ctx = createBoundCtx({ skuId: 'sku-1' })
    await routes.skuDetail(ctx)

    expect(ctx.result.sku.cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
  })

  test('spuDetail：头图走 box 档，detail_images 走面积档', async () => {
    pg.query.mockResolvedValueOnce([mockProductRow({
      detail_images: [COS_DETAIL_URL, COS_COVER_URL],
    })])
    pg.query.mockResolvedValueOnce([{ sku_id: 'sku-1', price: 100, special_price: 80 }])

    const ctx = createCtx({ payload: { productId: 'p1' } })
    await routes.spuDetail(ctx)

    expect(ctx.result.spu.cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
    expect(ctx.result.spu.detail_images).toEqual([
      `${COS_DETAIL_URL}?${AREA}`,
      `${COS_COVER_URL}?${AREA}`,
    ])
  })

  test('detail_images 必须走面积模式，不能退回 box——box 会把长图压糊', async () => {
    // 生产 14/14 张详情图高宽比 3.56~5.42（如 1389×5547、1737×7065），
    // 前端 mode="widthFix" 满屏渲染。
    // box 的 contain 语义会把 1737×7065 压成 266×1080（实测），
    // widthFix 再拉回 1290px = 放大 4.8 倍，长图里的文字直接糊掉。
    // 面积模式下同一张图是 743×3025（实测），放大 1.7 倍。
    //
    // 这条钉住「规则形状」而不只是数值：任何人把 detail_images 改回 box 立刻转红。
    pg.query.mockResolvedValueOnce([mockProductRow({
      detail_images: [COS_DETAIL_URL],
    })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { productId: 'p1' } })
    await routes.spuDetail(ctx)

    const url = ctx.result.spu.detail_images[0]
    expect(url).toMatch(/imageMogr2\/thumbnail\/\d+@$/)
    expect(url).not.toMatch(/thumbnail\/\d+x\d+/)
    // 必须是不带 `!` 的形式：实测 `thumbnail/!<Area>@` 在本项目 bucket 上原样返回原图
    expect(url).not.toContain('!')
  })

  test('spuDetail：无法缩略的 detail_images 被剔除而不是留 null', async () => {
    // 详情长图没有占位分支（wx:for 直接渲染），留 null 会变成裂图
    pg.query.mockResolvedValueOnce([mockProductRow({
      detail_images: [COS_DETAIL_URL, NON_COS_URL, ''],
    })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { productId: 'p1' } })
    await routes.spuDetail(ctx)

    expect(ctx.result.spu.detail_images).toEqual([`${COS_DETAIL_URL}?${AREA}`])
  })

  test('spuDetail：detail_images 为 NULL 时归一为空数组', async () => {
    pg.query.mockResolvedValueOnce([mockProductRow({ detail_images: null })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createCtx({ payload: { productId: 'p1' } })
    await routes.spuDetail(ctx)

    expect(ctx.result.spu.detail_images).toEqual([])
  })

  test('experienceCardList：200rpx 方卡走小档', async () => {
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-exp-1', spec_name: '体验装', price: 99, special_price: 1, cover_image: COS_COVER_URL },
    ])

    const ctx = createBoundCtx()
    await routes.experienceCardList(ctx)

    expect(ctx.result.skuList[0].cover_image).toBe(`${COS_COVER_URL}?${SMALL}`)
  })

  test('experienceCardList：LEFT JOIN 落空时 cover_image 为 NULL，保持 null', async () => {
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-exp-1', spec_name: '体验装', price: 99, special_price: 1, cover_image: null },
    ])

    const ctx = createBoundCtx()
    await routes.experienceCardList(ctx)

    expect(ctx.result.skuList[0].cover_image).toBeNull()
  })

  test('非 COS 域名一律下发 null，不退回原图', async () => {
    // 这是全族的核心不变量：退回原图意味着调用方看不出区别，
    // 而那张图可能正是会撑爆进程的巨图
    pg.query.mockResolvedValueOnce([mockProductRow({ cover_image: NON_COS_URL })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.spuList(ctx)

    expect(ctx.result.spuList[0].cover_image).toBeNull()
  })

  test('空封面（历史脏数据）下发 null 而不是空串或原值', async () => {
    pg.query.mockResolvedValueOnce([mockProductRow({ cover_image: '' })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.spuList(ctx)

    expect(ctx.result.spuList[0].cover_image).toBeNull()
  })

  test('缩略规则是双边 box 而不是只限宽——只限宽挡不住细长图', async () => {
    // 1080×20000 的长截图在 `thumbnail/1080x` 下宽度已达标、高度完全不受约束，
    // 解码仍是 1080×20000×4 ≈ 86MB。这条钉住规则形状，防止有人改回单边。
    pg.query.mockResolvedValueOnce([mockProductRow()])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.spuList(ctx)

    const url = ctx.result.spuList[0].cover_image
    expect(url).toMatch(/imageMogr2\/thumbnail\/(\d+)x\1$/)
  })

  test('原 URL 上的处理参数被整串丢弃，不与服务端规则并存', async () => {
    // imageView2 的 mode 1 可以把图放大到指定尺寸——黑名单漏掉任何一个平级 API
    // 都等于留了个放大通道，所以必须整串丢弃 query
    pg.query.mockResolvedValueOnce([mockProductRow({
      cover_image: `${COS_COVER_URL}?imageView2/1/w/50000/h/50000`,
    })])
    pg.query.mockResolvedValueOnce([])

    const ctx = createBoundCtx()
    await routes.spuList(ctx)

    expect(ctx.result.spuList[0].cover_image).toBe(`${COS_COVER_URL}?${LARGE}`)
    expect(ctx.result.spuList[0].cover_image).not.toContain('imageView2')
  })
})
