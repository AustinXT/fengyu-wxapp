/**
 * 商品模块路由（员工端）
 * product.shopInit — 开单页初始化（合并接口）
 * product.categories — 品项分类列表
 * product.skuList — SKU 列表（按品项分类）
 * product.skuDetail — SKU 详情
 * product.spuDetail — 商城商品详情
 *
 * SKU 直接绑定品项分类（product_skus → product_categories），无 products 中间层。
 * 商城商品查询通过 products → mall_product_skus → product_skus。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

// ===== 公共查询辅助 =====

/** 查询品项分类列表 */
async function _queryCategoryRows() {
  return pg.query(`
    SELECT category_id, category_name, product_kind, sales_category, sort_order
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
    salesCategory: r.sales_category,
    sortOrder: r.sort_order
  }
}

/** 查询 SKU 列表并格式化为前端格式（直接查 product_skus JOIN product_categories） */
async function _queryFormattedSkuList(categoryId, productKind) {
  const params = []
  const conditions = [
    `(sk.valid_start IS NULL OR sk.valid_start <= CURRENT_DATE)`,
    `(sk.valid_end IS NULL OR sk.valid_end >= CURRENT_DATE)`
  ]

  if (categoryId) {
    params.push(categoryId)
    conditions.push(`sk.category_id = $${params.length}`)
  }

  if (productKind) {
    params.push(productKind)
    conditions.push(`pc.product_kind = $${params.length}`)
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ')

  const skuRows = await pg.query(`
    SELECT sk.sku_id, sk.category_id, sk.product_type, sk.spec_name,
           sk.price, sk.special_price, sk.session_count, sk.sort_order,
           sk.service_fee, sk.is_shengmei,
           pc.category_name, pc.product_kind, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    ${whereClause}
    ORDER BY sk.sort_order ASC
  `, params)

  return skuRows.map(sk => ({
    skuId: sk.sku_id,
    specName: sk.spec_name,
    categoryId: sk.category_id,
    categoryName: sk.category_name,
    productKind: sk.product_kind,
    salesCategory: sk.sales_category,
    price: Number(sk.price) || 0,
    specialPrice: sk.special_price ? Number(sk.special_price) : null,
    sessionCount: sk.session_count != null ? Number(sk.session_count) : null,
    productType: sk.product_type,
    serviceFee: Number(sk.service_fee) || 0,
    isShengmei: sk.is_shengmei,
  }))
}

// ===== 路由处理器 =====

/**
 * 开单页初始化（合并接口）
 * 一次返回 categories + 第一个分类的 skuList
 */
async function shopInit(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const catRows = await _queryCategoryRows()
  const categories = catRows.map(_formatCategory)

  let skuList = []
  if (categories.length > 0) {
    skuList = await _queryFormattedSkuList(categories[0].id, null)
  }

  ctx.result = { categories, skuList }
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
 * SKU 列表（按品项分类）
 */
async function skuList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { categoryId, productKind } = ctx.event.payload || {}
  ctx.result = await _queryFormattedSkuList(categoryId, productKind)
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

  const rows = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count, sk.sort_order,
      sk.service_fee, sk.is_shengmei, sk.market_scope,
      pc.category_id, pc.category_name, pc.product_kind, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.sku_id = $1
  `, [skuId])

  if (rows.length === 0) {
    throw new Error('INVALID_PARAMS: SKU 不存在')
  }

  ctx.result = { sku: rows[0] }
}

/**
 * 商城商品详情（展示用，查 products + mall_product_skus）
 */
async function spuDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { spuId } = ctx.event.payload || {}
  if (!spuId) {
    throw new Error('INVALID_PARAMS: 缺少 spuId 参数')
  }

  const spuRows = await pg.query(`
    SELECT p.product_id, p.name, p.category_id, mc.category_name,
           p.cover_image, p.description, p.sort_order, p.price, p.special_price,
           p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    WHERE p.product_id = $1
  `, [spuId])

  if (spuRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const spu = spuRows[0]

  const skuList = await pg.query(`
    SELECT sk.sku_id, sk.product_type, sk.spec_name, sk.price, sk.special_price,
           sk.session_count, sk.sort_order, sk.service_fee,
           mps.bundle_price, mps.sort_order AS display_order,
           mps.bundle_group_id,
           bg.group_name, bg.pick_count AS group_pick_count
    FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    LEFT JOIN mall_bundle_groups bg ON mps.bundle_group_id = bg.id
    WHERE mps.product_id = $1
      AND (sk.valid_start IS NULL OR sk.valid_start <= CURRENT_DATE)
      AND (sk.valid_end IS NULL OR sk.valid_end >= CURRENT_DATE)
    ORDER BY COALESCE(bg.sort_order, 0) ASC, mps.sort_order ASC
  `, [spuId])

  // 构建分组信息（套餐商品）
  let bundleGroups = null
  if (spu.is_bundle) {
    const groupRows = await pg.query(`
      SELECT id, group_name, pick_count, sort_order
      FROM mall_bundle_groups
      WHERE product_id = $1
      ORDER BY sort_order ASC
    `, [spuId])

    bundleGroups = groupRows.map(g => ({
      id: g.id,
      groupName: g.group_name,
      pickCount: g.pick_count,
      skuIds: skuList.filter(s => s.bundle_group_id === g.id).map(s => s.sku_id),
    }))
  }

  ctx.result = {
    spu: {
      ...spu,
      skuList,
      bundleGroups,
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

module.exports = { shopInit, categories, skuList, skuDetail, spuDetail, promotionList, promotionPlans }
