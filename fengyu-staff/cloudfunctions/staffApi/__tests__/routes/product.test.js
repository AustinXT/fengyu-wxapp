/**
 * 商品模块路由测试
 * 覆盖：shopInit / categories / skuList / skuDetail / spuDetail
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
// product.skuList
// ============================================================
describe('product.skuList', () => {
  test('返回扁平 SKU 列表（含分类信息、isBundle 标记）', async () => {
    const ctx = createCtx({ payload: { categoryId: 'cat-1' } })

    // PR-C 重构后：单次 JOIN 查询直接返回 SKU 行
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-1', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '基础款', price: '300', special_price: '200',
        session_count: 10, sort_order: 1, service_fee: '0', is_shengmei: false,
        category_name: '护理项目', product_kind: '护理项目', sales_category: null,
        is_bundle: false,
      },
      {
        sku_id: 'sku-2', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '高级款', price: '500', special_price: null,
        session_count: 20, sort_order: 2, service_fee: '0', is_shengmei: false,
        category_name: '护理项目', product_kind: '护理项目', sales_category: null,
        is_bundle: false,
      },
    ])

    await productRoutes.skuList(ctx)

    expect(ctx.result).toHaveLength(2)
    expect(ctx.result[0].skuId).toBe('sku-1')
    expect(ctx.result[0].specName).toBe('基础款')
    expect(ctx.result[0].price).toBe(300)
    expect(ctx.result[0].specialPrice).toBe(200)
    expect(ctx.result[0].sessionCount).toBe(10)
    expect(ctx.result[0].isBundle).toBe(false)
    expect(ctx.result[1].skuId).toBe('sku-2')
    expect(ctx.result[1].specialPrice).toBeNull()
  })

  test('无商品时返回空数组', async () => {
    const ctx = createCtx({ payload: {} })

    pg.query.mockResolvedValueOnce([])

    await productRoutes.skuList(ctx)
    expect(ctx.result).toEqual([])
  })

  test('按 productKind 过滤 SKU（lines 56-58 TRUE 分支）', async () => {
    const ctx = createCtx({ payload: { productKind: '护理项目' } })

    pg.query.mockResolvedValueOnce([])

    await productRoutes.skuList(ctx)

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('product_kind')
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
  test('返回分类 + 第一个分类的扁平 SKU 列表 + bundleGroups', async () => {
    const ctx = createCtx()

    // PR-C 重构后调用顺序：
    // 1) _queryCategoryRows
    // 2) _queryFormattedSkuList (第一个分类的 SKU)
    // 3) _queryMallBundleGroups → productRows
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sales_category: null, sort_order: 1 },
      { category_id: 'cat-2', category_name: '家居产品', product_kind: '家居产品', sales_category: null, sort_order: 2 },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-1', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '基础款', price: '300', special_price: '200',
        session_count: 10, sort_order: 1, service_fee: '0', is_shengmei: false,
        category_name: '护理项目', product_kind: '护理项目', sales_category: null,
        is_bundle: false,
      },
    ])
    pg.query.mockResolvedValueOnce([]) // 无 bundle 商品 → mallBundleGroups 早返回

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toHaveLength(2)
    expect(ctx.result.skuList).toHaveLength(1)
    expect(ctx.result.skuList[0].skuId).toBe('sku-1')
    expect(ctx.result.mallBundleGroups).toEqual([])
  })

  test('无分类时返回空 SKU 列表', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([]) // _queryCategoryRows
    pg.query.mockResolvedValueOnce([]) // _queryMallBundleGroups productRows

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.skuList).toEqual([])
    expect(ctx.result.mallBundleGroups).toEqual([])
  })

  // ===== D2.6 isBundle 字段 + mallBundleGroups 聚合 =====
  test('skuList 透传 is_bundle：true/false 行分别映射到 isBundle', async () => {
    const ctx = createCtx()

    // _queryCategoryRows
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '护理项目', product_kind: '护理项目', sales_category: null, sort_order: 1 },
    ])
    // _queryFormattedSkuList
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-bundle-1', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '套餐SKU', price: '800', special_price: null,
        session_count: 5, sort_order: 1, service_fee: '0', is_shengmei: false,
        category_name: '护理项目', product_kind: '护理项目', sales_category: '自采自销',
        is_bundle: true,
      },
      {
        sku_id: 'sku-normal-2', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '普通SKU', price: '300', special_price: null,
        session_count: 10, sort_order: 2, service_fee: '0', is_shengmei: false,
        category_name: '护理项目', product_kind: '护理项目', sales_category: '自采自销',
        is_bundle: false,
      },
    ])
    // _queryMallBundleGroups → productRows（无 bundle 产品，早返回）
    pg.query.mockResolvedValueOnce([])

    await productRoutes.shopInit(ctx)

    expect(ctx.result.skuList).toHaveLength(2)
    expect(ctx.result.skuList[0].skuId).toBe('sku-bundle-1')
    expect(ctx.result.skuList[0].isBundle).toBe(true)
    expect(ctx.result.skuList[1].skuId).toBe('sku-normal-2')
    expect(ctx.result.skuList[1].isBundle).toBe(false)
  })

  test('mallBundleGroups 聚合：bundle 商品关联分组 + pickCount + skuIds', async () => {
    const ctx = createCtx()

    // 1) _queryCategoryRows — 不影响本测试，返回空便于跳过 skuList
    pg.query.mockResolvedValueOnce([])
    // 2) _queryMallBundleGroups productRows
    pg.query.mockResolvedValueOnce([
      {
        product_id: 'prod-b1', name: '经典套餐A', cover_image: 'img-a.png',
        description: '护理+家居', price: '1999', special_price: '1888', sort_order: 1,
      },
      {
        product_id: 'prod-b2', name: '单组套餐B', cover_image: null,
        description: null, price: '999', special_price: null, sort_order: 2,
      },
    ])
    // 3) groupRows
    pg.query.mockResolvedValueOnce([
      { id: 10, product_id: 'prod-b1', group_name: '护理服务组', pick_count: 2, sort_order: 1 },
      { id: 11, product_id: 'prod-b1', group_name: '家居产品组', pick_count: 1, sort_order: 2 },
      { id: 20, product_id: 'prod-b2', group_name: '单组', pick_count: null, sort_order: 1 },
    ])
    // 4) skuLinkRows
    pg.query.mockResolvedValueOnce([
      { product_id: 'prod-b1', sku_id: 'sku-h1', bundle_group_id: 10, bundle_price: '200', sort_order: 1 },
      { product_id: 'prod-b1', sku_id: 'sku-h2', bundle_group_id: 10, bundle_price: '200', sort_order: 2 },
      { product_id: 'prod-b1', sku_id: 'sku-h3', bundle_group_id: 10, bundle_price: '200', sort_order: 3 },
      { product_id: 'prod-b1', sku_id: 'sku-home1', bundle_group_id: 11, bundle_price: '300', sort_order: 1 },
      { product_id: 'prod-b2', sku_id: 'sku-only', bundle_group_id: 20, bundle_price: '999', sort_order: 1 },
      // 噪声：跨 product_id 的 link 不能混入
      { product_id: 'prod-b2', sku_id: 'sku-h1', bundle_group_id: 10, bundle_price: '200', sort_order: 2 },
    ])

    await productRoutes.shopInit(ctx)

    const groups = ctx.result.mallBundleGroups
    expect(groups).toHaveLength(2)

    const b1 = groups.find(g => g.productId === 'prod-b1')
    expect(b1).toBeDefined()
    expect(b1.name).toBe('经典套餐A')
    expect(b1.price).toBe(1999)
    expect(b1.specialPrice).toBe(1888)
    expect(b1.groups).toHaveLength(2)

    const careGroup = b1.groups.find(g => g.groupName === '护理服务组')
    expect(careGroup.pickCount).toBe(2)
    expect(careGroup.skuIds).toEqual(['sku-h1', 'sku-h2', 'sku-h3'])

    const homeGroup = b1.groups.find(g => g.groupName === '家居产品组')
    expect(homeGroup.pickCount).toBe(1)
    expect(homeGroup.skuIds).toEqual(['sku-home1'])

    const b2 = groups.find(g => g.productId === 'prod-b2')
    expect(b2.groups).toHaveLength(1)
    expect(b2.groups[0].pickCount).toBeNull() // null=全选
    expect(b2.groups[0].skuIds).toEqual(['sku-only']) // 跨 product_id 的噪声被过滤
    expect(b2.specialPrice).toBeNull()
    expect(b2.coverImage).toBeNull()
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
