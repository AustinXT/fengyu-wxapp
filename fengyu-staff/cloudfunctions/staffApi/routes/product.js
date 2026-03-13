/**
 * 商品模块路由（员工端）
 * product.shopInit — 开单页初始化（合并接口）
 * product.categories — 品项分类列表
 * product.spuList — 商品列表（含 SKU 价格）
 * product.skuDetail — SKU 详情
 * product.spuDetail — 商品详情
 *
 * 数据全部来自 PG（product_categories / products / product_skus），零 WorkFine 依赖。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

// ===== 公共查询辅助 =====

/** 查询分类列表 */
async function _queryCategoryRows() {
  return pg.query(`
    SELECT category_id, category_name, product_kind, sort_order
    FROM product_categories
    WHERE is_valid = true
    ORDER BY sort_order ASC
  `)
}

/** 格式化分类行 → 前端格式 */
function _formatCategory(r) {
  return {
    id: r.category_id,
    name: r.category_name,
    productKind: r.product_kind,
    sortOrder: r.sort_order
  }
}

/** 查询商品列表并格式化为前端格式 */
async function _queryFormattedSpuList(categoryId, productKind) {
  const params = []
  const conditions = [
    `(p.valid_start IS NULL OR p.valid_start <= CURRENT_DATE)`,
    `(p.valid_end IS NULL OR p.valid_end >= CURRENT_DATE)`
  ]

  if (categoryId) {
    params.push(categoryId)
    conditions.push(`p.category_id = $${params.length}`)
  }

  if (productKind) {
    params.push(productKind)
    conditions.push(`pc.product_kind = $${params.length}`)
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ')

  const spuRows = await pg.query(`
    SELECT p.product_id, p.name, p.category_id, pc.category_name, pc.product_kind,
           p.cover_image, p.description, p.sort_order, p.price AS list_price
    FROM products p
    JOIN product_categories pc ON p.category_id = pc.category_id
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 批量查询所有商品的 SKU
  const productIds = spuRows.map(s => s.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT sku_id, product_id, product_type, spec_name, price, special_price,
             session_count, sort_order
      FROM product_skus
      WHERE product_id = ANY($1)
        AND (valid_start IS NULL OR valid_start <= CURRENT_DATE)
        AND (valid_end IS NULL OR valid_end >= CURRENT_DATE)
      ORDER BY sort_order ASC
    `, [productIds])
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  return spuRows.map(spu => {
    const skus = skuByProduct[spu.product_id] || []
    return {
      spuId: spu.product_id,
      spuName: spu.name,
      categoryId: spu.category_id,
      categoryName: spu.category_name,
      productKind: spu.product_kind,
      priceFrom: skus.length > 0 ? Math.min(...skus.map(s => Number(s.special_price || s.price) || 0)) : null,
      cover_image: spu.cover_image,
      skus: skus.map(s => ({
        skuId: s.sku_id,
        specName: s.spec_name || '',
        price: Number(s.price) || 0,
        specialPrice: s.special_price ? Number(s.special_price) : null,
        sessionCount: s.session_count != null ? Number(s.session_count) : null,
        productType: s.product_type,
      }))
    }
  })
}

// ===== 路由处理器 =====

/**
 * 开单页初始化（合并接口）
 * 一次返回 categories + 第一个分类的 spuList
 */
async function shopInit(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const catRows = await _queryCategoryRows()
  const categories = catRows.map(_formatCategory)

  let spuList = []
  if (categories.length > 0) {
    spuList = await _queryFormattedSpuList(categories[0].id, null)
  }

  ctx.result = { categories, spuList }
}

/**
 * 品项分类列表
 */
async function categories(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const rows = await _queryCategoryRows()
  ctx.result = rows.map(_formatCategory)
}

/**
 * 商品列表（按品项分类）
 */
async function spuList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { category, categoryId, productKind } = ctx.event.payload || {}
  const resolvedCategoryId = categoryId || category
  ctx.result = await _queryFormattedSpuList(resolvedCategoryId, productKind)
}

/**
 * SKU 详情
 */
async function skuDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { skuId } = ctx.event.payload || {}
  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  const skuList = await pg.query(`
    SELECT
      s.sku_id, s.product_id, s.product_type, s.spec_name,
      s.price, s.special_price, s.session_count, s.sort_order,
      p.name AS product_name, p.category_id, pc.category_name, pc.product_kind,
      p.description
    FROM product_skus s
    JOIN products p ON s.product_id = p.product_id
    JOIN product_categories pc ON p.category_id = pc.category_id
    WHERE s.sku_id = $1
  `, [skuId])

  if (skuList.length === 0) {
    throw new Error('INVALID_PARAMS: SKU 不存在')
  }

  ctx.result = { sku: skuList[0] }
}

/**
 * 商品详情（单个商品详情页）
 */
async function spuDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { spuId } = ctx.event.payload || {}
  if (!spuId) {
    throw new Error('INVALID_PARAMS: 缺少 spuId 参数')
  }

  const spuRows = await pg.query(`
    SELECT p.product_id, p.name, p.category_id, pc.category_name, pc.product_kind,
           p.cover_image, p.description, p.sort_order, p.price, p.special_price,
           p.is_bundle
    FROM products p
    JOIN product_categories pc ON p.category_id = pc.category_id
    WHERE p.product_id = $1
  `, [spuId])

  if (spuRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const spu = spuRows[0]

  const skuList = await pg.query(`
    SELECT sku_id, product_type, spec_name, price, special_price,
           session_count, sort_order
    FROM product_skus
    WHERE product_id = $1
      AND (valid_start IS NULL OR valid_start <= CURRENT_DATE)
      AND (valid_end IS NULL OR valid_end >= CURRENT_DATE)
    ORDER BY sort_order ASC
  `, [spuId])

  ctx.result = {
    spu: {
      ...spu,
      skuList,
      priceFrom: skuList.length > 0 ? Math.min(...skuList.map(s => Number(s.special_price || s.price) || 0)) : null,
    }
  }
}

/**
 * 促销方案列表（已迁移至 PG 商品体系）
 * 原 WorkFine 促销查询已废弃，bundle 商品为后续实现
 */
async function promotionList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  ctx.result = { schemes: [] }
}

async function promotionPlans(ctx) {
  await requireStaffBound()(ctx, async () => {})
  ctx.result = []
}

module.exports = { shopInit, categories, spuList, skuDetail, spuDetail, promotionList, promotionPlans }
