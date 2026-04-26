/**
 * 商品模块路由测试
 * 覆盖：shopInit / categories / skuList / skuDetail / spuDetail
 */



const pg = globalThis.__mocks__.pg
const { createCtx } = require('../helpers')
const productRoutes = require('../../routes/product')
const { _queryCategoryRows } = productRoutes.__testables__


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
      { sku_id: 'sku-1', product_type: '疗程卡', spec_name: '基础款', price: '300', special_price: '200', session_count: 10, sort_order: 1, product_kind: '护理项目', kind_display_color: '#C0322A' },
      { sku_id: 'sku-2', product_type: '疗程卡', spec_name: '高级款', price: '500', special_price: '400', session_count: 20, sort_order: 2, product_kind: '护理项目', kind_display_color: '#C0322A' },
    ])

    await productRoutes.spuDetail(ctx)

    expect(ctx.result.spu.product_id).toBe('prod-1')
    expect(ctx.result.spu.skuList).toHaveLength(2)
    expect(ctx.result.spu.priceFrom).toBe(200)
    // PR-D：spu 级 productKind / kindDisplayColor 由 SKU 行聚合
    expect(ctx.result.spu.productKind).toBe('护理项目')
    expect(ctx.result.spu.kindDisplayColor).toBe('#C0322A')
  })

  test('PR-D：所有 SKU 行均无 product_kind 时 productKind/kindDisplayColor=null', async () => {
    const ctx = createCtx({ payload: { spuId: 'prod-1' } })

    pg.query.mockResolvedValueOnce([{
      product_id: 'prod-1', name: '面部护理', category_id: 'cat-1',
      category_name: '护理项目', product_kind: '护理项目',
      cover_image: null, description: null, sort_order: 1,
      price: '300', special_price: null, is_bundle: false,
    }])
    pg.query.mockResolvedValueOnce([
      { sku_id: 'sku-1', product_type: '疗程卡', spec_name: '基础款', price: '300', special_price: null, session_count: 10, sort_order: 1 },
    ])

    await productRoutes.spuDetail(ctx)

    expect(ctx.result.spu.productKind).toBeNull()
    expect(ctx.result.spu.kindDisplayColor).toBeNull()
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

    // PR-B 重构后调用顺序：
    // 1) _queryCategoryRows (withParentJoin=true, kindNotIn=['充值卡','体验卡'])
    // 2) nonEmptyRows EXISTS 过滤
    // 3) _queryFormattedSkuList (第一个分类的 SKU)
    // 4) _queryMallBundleGroups → productRows
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 1, kind_name: '护理项目', kind_sort_order: 1 },
      { category_id: 'cat-2', category_name: '洗护', product_kind: '家居产品', sales_category: null, sort_order: 2, kind_name: '家居产品', kind_sort_order: 2 },
    ])
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1' },
      { category_id: 'cat-2' },
    ])
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-1', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '基础款', price: '300', special_price: '200',
        session_count: 10, sort_order: 1, service_fee: '0', is_shengmei: false,
        category_name: '面部护理', product_kind: '护理项目', sales_category: null,
        is_bundle: false,
      },
    ])
    pg.query.mockResolvedValueOnce([]) // 无 bundle 商品 → mallBundleGroups 早返回

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toHaveLength(2)
    expect(ctx.result.skuList).toHaveLength(1)
    expect(ctx.result.skuList[0].skuId).toBe('sku-1')
    expect(ctx.result.mallBundleGroups).toEqual([])
    // groupedCategories 契约
    expect(ctx.result.groupedCategories).toHaveLength(2)
    expect(ctx.result.groupedCategories[0].productKind).toBe('护理项目')
    expect(ctx.result.groupedCategories[0].items).toHaveLength(1)
    expect(ctx.result.groupedCategories[1].productKind).toBe('家居产品')
  })

  test('无分类时返回空 SKU 列表', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([]) // _queryCategoryRows（空 → 跳过 EXISTS + skuList 查询）
    pg.query.mockResolvedValueOnce([]) // _queryMallBundleGroups productRows

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toEqual([])
    expect(ctx.result.groupedCategories).toEqual([])
    expect(ctx.result.skuList).toEqual([])
    expect(ctx.result.mallBundleGroups).toEqual([])
  })

  // ===== D2.6 isBundle 字段 + mallBundleGroups 聚合 =====
  test('skuList 透传 is_bundle：true/false 行分别映射到 isBundle', async () => {
    const ctx = createCtx()

    // _queryCategoryRows
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-1', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 1, kind_name: '护理项目', kind_sort_order: 1 },
    ])
    // nonEmptyRows EXISTS
    pg.query.mockResolvedValueOnce([{ category_id: 'cat-1' }])
    // _queryFormattedSkuList
    pg.query.mockResolvedValueOnce([
      {
        sku_id: 'sku-bundle-1', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '套餐SKU', price: '800', special_price: null,
        session_count: 5, sort_order: 1, service_fee: '0', is_shengmei: false,
        category_name: '面部护理', product_kind: '护理项目', sales_category: '自销自耗',
        is_bundle: true,
      },
      {
        sku_id: 'sku-normal-2', category_id: 'cat-1', product_type: '疗程卡',
        spec_name: '普通SKU', price: '300', special_price: null,
        session_count: 10, sort_order: 2, service_fee: '0', is_shengmei: false,
        category_name: '面部护理', product_kind: '护理项目', sales_category: '自销自耗',
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

  // ===== PR-B：排除法 + 分组返回 =====

  test('PR-B: shopInit 的 categories/groupedCategories 不含"充值卡"/"体验卡"', async () => {
    const ctx = createCtx()
    // 2026-04-26 重构：shopInit 不再用 kindNotIn 过滤分类，改在 SKU EXISTS 阶段
    // 用 capability 列 NOT (sk.is_recharge_card OR sk.is_experience) 过滤；
    // 仍保留含卡类商品的分类被排除（mock 返回的 nonEmptyRows 不含 cat-card 即可）
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-h', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 1, kind_name: '护理项目', kind_sort_order: 1 },
      { category_id: 'cat-home', category_name: '洗护', product_kind: '家居产品', sales_category: null, sort_order: 1, kind_name: '家居产品', kind_sort_order: 2 },
    ])
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-h' },
      { category_id: 'cat-home' },
    ])
    pg.query.mockResolvedValueOnce([]) // _queryFormattedSkuList（第一个分类的 SKU）
    pg.query.mockResolvedValueOnce([]) // _queryMallBundleGroups → productRows

    await productRoutes.shopInit(ctx)

    // 断言：返回 categories 均不含 卡类 productKind
    const allKinds = ctx.result.categories.map(c => c.productKind)
    expect(allKinds).not.toContain('充值卡')
    expect(allKinds).not.toContain('体验卡')
    // 断言：groupedCategories 每一组的 productKind 均不在卡类中
    const groupKinds = ctx.result.groupedCategories.map(g => g.productKind)
    expect(groupKinds).not.toContain('充值卡')
    expect(groupKinds).not.toContain('体验卡')

    // 断言第一次 SQL：_queryCategoryRows withParentJoin=true（无 kindNotIn）
    const sql1 = pg.query.mock.calls[0][0]
    expect(sql1).toContain('JOIN product_categories parent')
    expect(sql1).toContain('product_kind IS NOT NULL')
    // 不再传 kindNotIn 数组（改用 SKU EXISTS 阶段的 capability 列过滤）
    const params1 = pg.query.mock.calls[0][1]
    expect(params1).toEqual([])

    // 第二次 SQL：EXISTS 过滤必须含 NOT (sk.is_recharge_card OR sk.is_experience)
    const sql2 = pg.query.mock.calls[1][0]
    expect(sql2).toContain('NOT (sk.is_recharge_card OR sk.is_experience)')
  })

  test('PR-B: 新增非卡 kind"福利活动"自动出现在 groupedCategories', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-h', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 1, kind_name: '护理项目', kind_sort_order: 1 },
      { category_id: 'cat-w', category_name: '节日福利', product_kind: '福利活动', sales_category: null, sort_order: 1, kind_name: '福利活动', kind_sort_order: 3 },
    ])
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-h' },
      { category_id: 'cat-w' },
    ])
    pg.query.mockResolvedValueOnce([]) // skuList
    pg.query.mockResolvedValueOnce([]) // bundle productRows

    await productRoutes.shopInit(ctx)

    const kinds = ctx.result.groupedCategories.map(g => g.productKind)
    expect(kinds).toContain('福利活动')
    const welfare = ctx.result.groupedCategories.find(g => g.productKind === '福利活动')
    expect(welfare.items).toHaveLength(1)
    expect(welfare.items[0].id).toBe('cat-w')
    expect(welfare.kindSortOrder).toBe(3)
  })

  test('PR-B: EXISTS 过滤剔除空分类', async () => {
    const ctx = createCtx()
    // 两个分类：cat-h 有 SKU，cat-empty 没 SKU
    pg.query.mockResolvedValueOnce([
      { category_id: 'cat-h', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 1, kind_name: '护理项目', kind_sort_order: 1 },
      { category_id: 'cat-empty', category_name: '空分类', product_kind: '护理项目', sales_category: null, sort_order: 2, kind_name: '护理项目', kind_sort_order: 1 },
    ])
    // nonEmptyRows 只返回 cat-h
    pg.query.mockResolvedValueOnce([{ category_id: 'cat-h' }])
    pg.query.mockResolvedValueOnce([]) // skuList
    pg.query.mockResolvedValueOnce([]) // bundle productRows

    await productRoutes.shopInit(ctx)

    expect(ctx.result.categories).toHaveLength(1)
    expect(ctx.result.categories[0].id).toBe('cat-h')
    const welfareGroup = ctx.result.groupedCategories.find(g => g.productKind === '护理项目')
    expect(welfareGroup.items).toHaveLength(1)
  })
})

// ============================================================
// product._queryCategoryRows（PR-B 新增辅助函数签名测试）
// ============================================================
describe('product._queryCategoryRows', () => {
  test('无参调用返回全量（不加 product_kind 过滤）', async () => {
    pg.query.mockResolvedValueOnce([
      { category_id: 'root-1', category_name: '护理项目', product_kind: null, sales_category: null, sort_order: 1 },
      { category_id: 'cat-h', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 2 },
    ])

    const rows = await _queryCategoryRows()
    expect(rows).toHaveLength(2)
    const sql = pg.query.mock.calls[0][0]
    expect(sql).not.toContain('ANY($1)')
    expect(sql).not.toContain('<> ALL')
    // 不含 JOIN parent（withParentJoin=false）
    expect(sql).not.toContain('JOIN product_categories parent')
  })

  test('kindNotIn 注入 <> ALL + IS NOT NULL', async () => {
    pg.query.mockResolvedValueOnce([])
    await _queryCategoryRows({ kindNotIn: ['充值卡', '体验卡'] })

    const sql = pg.query.mock.calls[0][0]
    const params = pg.query.mock.calls[0][1]
    expect(sql).toContain('<> ALL')
    expect(sql).toContain('product_kind IS NOT NULL')
    expect(params[0]).toEqual(['充值卡', '体验卡'])
  })

  test('kindIn 注入 = ANY + IS NOT NULL', async () => {
    pg.query.mockResolvedValueOnce([])
    await _queryCategoryRows({ kindIn: ['护理项目'] })

    const sql = pg.query.mock.calls[0][0]
    const params = pg.query.mock.calls[0][1]
    expect(sql).toContain('= ANY')
    expect(sql).toContain('product_kind IS NOT NULL')
    expect(params[0]).toEqual(['护理项目'])
  })

  test('withParentJoin=true 返回 kind_name/kind_sort_order 并按 parent.sort_order 排序', async () => {
    pg.query.mockResolvedValueOnce([])
    await _queryCategoryRows({ kindNotIn: ['充值卡'], withParentJoin: true })

    const sql = pg.query.mock.calls[0][0]
    expect(sql).toContain('JOIN product_categories parent')
    expect(sql).toContain('parent.product_kind IS NULL')
    expect(sql).toContain('kind_sort_order')
    expect(sql).toContain('ORDER BY parent.sort_order ASC, child.sort_order ASC')
    expect(sql).toContain('product_kind IS NOT NULL')
  })
})

// ============================================================
// product.categories — 保留全量契约
// ============================================================
describe('product.categories（PR-B 全量契约）', () => {
  test('无参调用返回全量（含历史一级+二级行语义不变）', async () => {
    const ctx = createCtx()
    pg.query.mockResolvedValueOnce([
      { category_id: 'root-1', category_name: '护理项目', product_kind: null, sales_category: null, sort_order: 1 },
      { category_id: 'cat-h', category_name: '面部护理', product_kind: '护理项目', sales_category: null, sort_order: 2 },
    ])

    await productRoutes.categories(ctx)

    expect(ctx.result).toHaveLength(2)
    const sql = pg.query.mock.calls[0][0]
    // 无参契约：没有 product_kind 过滤
    expect(sql).not.toContain('ANY($1)')
    expect(sql).not.toContain('<> ALL')
  })

  test('payload.kindNotIn 可选过滤（不破坏无参契约）', async () => {
    const ctx = createCtx({ payload: { kindNotIn: ['充值卡', '体验卡'] } })
    pg.query.mockResolvedValueOnce([])

    await productRoutes.categories(ctx)

    const sql = pg.query.mock.calls[0][0]
    const params = pg.query.mock.calls[0][1]
    expect(sql).toContain('<> ALL')
    expect(sql).toContain('product_kind IS NOT NULL')
    expect(params[0]).toEqual(['充值卡', '体验卡'])
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

// ============================================================
// product.cardKinds（PR-D 新增）
// ============================================================
describe('product.cardKinds', () => {
  test('从 DB 读 is_card_kind=true 的一级行 category_name', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([
      { category_name: '充值卡' },
      { category_name: '体验卡' },
    ])

    await productRoutes.cardKinds(ctx)

    expect(ctx.result).toEqual({ names: ['充值卡', '体验卡'] })
    // SQL 关键条件断言
    const sql = pg.query.mock.calls[0][0]
    expect(sql).toMatch(/is_card_kind\s*=\s*true/)
    expect(sql).toMatch(/product_kind\s+IS\s+NULL/i)
  })

  test('DB 返回空时回退到兜底常量', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([])

    await productRoutes.cardKinds(ctx)

    // CARD_PRODUCT_KINDS 常量 = ['充值卡', '体验卡']
    expect(ctx.result.names).toEqual(['充值卡', '体验卡'])
  })

  test('DB 异常时回退到兜底常量', async () => {
    const ctx = createCtx()

    pg.query.mockRejectedValueOnce(new Error('connection reset'))

    await productRoutes.cardKinds(ctx)

    expect(ctx.result.names).toEqual(['充值卡', '体验卡'])
  })

  test('支持任意 admin 新建的卡类（如 "测试卡"）', async () => {
    const ctx = createCtx()

    pg.query.mockResolvedValueOnce([
      { category_name: '充值卡' },
      { category_name: '体验卡' },
      { category_name: '测试卡' },
    ])

    await productRoutes.cardKinds(ctx)

    expect(ctx.result.names).toEqual(['充值卡', '体验卡', '测试卡'])
  })
})
