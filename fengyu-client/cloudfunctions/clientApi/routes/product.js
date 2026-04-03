/**
 * 商品模块路由（客户端/商城管理）
 * 数据从 PG mall_categories / products / mall_product_skus / product_skus 查询
 */

const pg = require('../db/pg')

/**
 * 有效性过滤条件（商城商品层 + SKU 层叠加）
 */
const PRODUCT_VALID_FILTER = `p.is_enabled = true AND p.is_visible = true`
const SKU_VALID_FILTER = `sk.is_enabled = true`

/**
 * 内部函数：获取商品分类列表（mall_categories）
 * 仅返回含有效商品的分类
 */
async function getCategoriesList(marketName) {
  const params = []
  let marketFilter

  if (marketName) {
    params.push(marketName)
    marketFilter = `AND (p.market_scope IS NULL OR p.market_scope = $${params.length})`
  } else {
    marketFilter = 'AND p.market_scope IS NULL'
  }

  const sql = `
    SELECT
      mc.category_id,
      mc.category_name,
      mc.sort_order AS category_order
    FROM mall_categories mc
    WHERE EXISTS (
        SELECT 1 FROM products p
        JOIN mall_product_skus mps ON mps.product_id = p.product_id
        JOIN product_skus sk ON mps.sku_id = sk.sku_id
        WHERE p.category_id = mc.category_id
          AND ${PRODUCT_VALID_FILTER}
          AND ${SKU_VALID_FILTER}
          ${marketFilter}
      )
    ORDER BY mc.sort_order ASC
  `

  return pg.query(sql, params)
}

/**
 * 商品分类列表
 */
async function categories(ctx) {
  const marketName = ctx.auth?.boundMarketName || null
  const categoriesList = await getCategoriesList(marketName)
  ctx.result = { categories: categoriesList }
}

/**
 * 内部函数：按分类获取商城商品列表（含 SKU）
 */
async function getProductListByCategory({ categoryId, marketName }) {
  const params = []

  let marketFilter
  if (marketName) {
    params.push(marketName)
    marketFilter = `AND (p.market_scope IS NULL OR p.market_scope = $${params.length})`
  } else {
    marketFilter = 'AND p.market_scope IS NULL'
  }

  let whereClause = `WHERE ${PRODUCT_VALID_FILTER} ${marketFilter}`

  if (categoryId) {
    params.push(categoryId)
    whereClause += ` AND p.category_id = $${params.length}`
  }

  // 仅返回有有效 SKU 的商品
  whereClause += ` AND EXISTS (
    SELECT 1 FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    WHERE mps.product_id = p.product_id
      AND ${SKU_VALID_FILTER}
  )`

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.description, p.sort_order,
      p.price, p.special_price, p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 批量查询所有商品的 SKU（通过 mall_product_skus 关联）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT
        mps.product_id, sk.sku_id, sk.product_type, sk.spec_name,
        sk.price, sk.special_price, sk.session_count,
        sk.service_fee, mps.sort_order AS display_order,
        mps.bundle_price, mps.bundle_group_id,
        bg.group_name, bg.pick_count AS group_pick_count
      FROM mall_product_skus mps
      JOIN product_skus sk ON mps.sku_id = sk.sku_id
      LEFT JOIN mall_bundle_groups bg ON mps.bundle_group_id = bg.id
      WHERE mps.product_id = ANY($1)
        AND ${SKU_VALID_FILTER}
      ORDER BY mps.sort_order ASC
    `, [productIds])
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  return productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const prices = skus.map(s => Number(s.bundle_price || s.special_price || s.price || 0))
    return {
      ...product,
      skuList: skus,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null
    }
  })
}

/**
 * 商品列表
 */
async function spuList(ctx) {
  const { categoryId } = ctx.event.payload || {}
  const marketName = ctx.auth?.boundMarketName || null
  const result = await getProductListByCategory({ categoryId, marketName })
  ctx.result = { spuList: result }
}

/**
 * Shop 页初始化接口（合并 categories + 第一个分类的商品列表）
 */
async function shopInit(ctx) {
  const marketName = ctx.auth?.boundMarketName || null

  const categoriesList = await getCategoriesList(marketName)

  let firstSpuList = []
  if (categoriesList.length > 0) {
    const firstCategoryId = categoriesList[0].category_id
    firstSpuList = await getProductListByCategory({ categoryId: firstCategoryId, marketName })
  }

  ctx.result = {
    categories: categoriesList,
    spuList: firstSpuList
  }
}

/**
 * SKU 详情
 */
async function skuDetail(ctx) {
  const { skuId } = ctx.event.payload || {}

  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  const rows = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order, sk.is_shengmei,
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
 * 热门推荐列表
 */
async function hotList(ctx) {
  const { limit = 6 } = ctx.event.payload || {}
  const marketName = ctx.auth?.boundMarketName || null

  const params = [limit]
  let marketFilter
  if (marketName) {
    params.push(marketName)
    marketFilter = `AND (p.market_scope IS NULL OR p.market_scope = $${params.length})`
  } else {
    marketFilter = 'AND p.market_scope IS NULL'
  }

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.sort_order,
      p.price, p.special_price
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    WHERE ${PRODUCT_VALID_FILTER}
      ${marketFilter}
      AND EXISTS (
        SELECT 1 FROM mall_product_skus mps
        JOIN product_skus sk ON mps.sku_id = sk.sku_id
        WHERE mps.product_id = p.product_id AND ${SKU_VALID_FILTER}
      )
    ORDER BY p.sort_order ASC
    LIMIT $1
  `, params)

  // 批量查询 SKU（取最低价）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT mps.product_id, sk.sku_id, sk.price, sk.special_price, mps.bundle_price
      FROM mall_product_skus mps
      JOIN product_skus sk ON mps.sku_id = sk.sku_id
      WHERE mps.product_id = ANY($1) AND ${SKU_VALID_FILTER}
      ORDER BY mps.sort_order ASC
    `, [productIds])
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  const result = productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const prices = skus.map(s => Number(s.bundle_price || s.special_price || s.price || 0))
    return {
      ...product,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null
    }
  })

  ctx.result = { spuList: result }
}

/**
 * 商品详情（含 SKU 列表）
 */
async function spuDetail(ctx) {
  const { spuId, productId: inputProductId } = ctx.event.payload || {}
  const marketName = ctx.auth?.boundMarketName || null
  const productId = inputProductId || spuId

  if (!productId) {
    throw new Error('INVALID_PARAMS: 缺少 productId 参数')
  }

  const params = [productId]
  let marketFilter
  if (marketName) {
    params.push(marketName)
    marketFilter = `AND (p.market_scope IS NULL OR p.market_scope = $${params.length})`
  } else {
    marketFilter = 'AND p.market_scope IS NULL'
  }

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      mc.category_name,
      p.cover_image, p.detail_images, p.description, p.sort_order,
      p.price, p.special_price, p.is_bundle
    FROM products p
    JOIN mall_categories mc ON p.category_id = mc.category_id
    WHERE p.product_id = $1 ${marketFilter}
  `, params)

  if (productRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const product = productRows[0]

  const skuList = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order, sk.is_shengmei,
      mps.bundle_price, mps.sort_order AS display_order,
      mps.bundle_group_id,
      bg.group_name, bg.pick_count AS group_pick_count
    FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    LEFT JOIN mall_bundle_groups bg ON mps.bundle_group_id = bg.id
    WHERE mps.product_id = $1
      AND ${SKU_VALID_FILTER}
    ORDER BY COALESCE(bg.sort_order, 0) ASC, mps.sort_order ASC
  `, [productId])

  const prices = skuList.map(s => Number(s.bundle_price || s.special_price || s.price || 0))

  // 构建分组信息（套餐商品）
  let bundleGroups = null
  if (product.is_bundle) {
    const groupRows = await pg.query(`
      SELECT id, group_name, pick_count, sort_order
      FROM mall_bundle_groups
      WHERE product_id = $1
      ORDER BY sort_order ASC
    `, [productId])

    bundleGroups = groupRows.map(g => ({
      id: g.id,
      groupName: g.group_name,
      pickCount: g.pick_count,
      skuIds: skuList.filter(s => s.bundle_group_id === g.id).map(s => s.sku_id),
    }))
  }

  ctx.result = {
    spu: {
      ...product,
      skuList,
      bundleGroups,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null
    }
  }
}

module.exports = {
  categories,
  spuList,
  skuDetail,
  spuDetail,
  hotList,
  shopInit
}
