/**
 * 商品模块路由
 * 所有数据从 PG products / product_skus / product_categories 查询
 */

const pg = require('../db/pg')

/**
 * 有效性过滤条件（商品层 + SKU 层叠加）
 * valid_start/valid_end 替代 is_active
 */
const PRODUCT_VALID_FILTER = `(p.valid_start IS NULL OR p.valid_start <= CURRENT_DATE) AND (p.valid_end IS NULL OR p.valid_end >= CURRENT_DATE)`
const SKU_VALID_FILTER = `(sk.valid_start IS NULL OR sk.valid_start <= CURRENT_DATE) AND (sk.valid_end IS NULL OR sk.valid_end >= CURRENT_DATE)`

/**
 * 内部函数：获取分类列表
 * @param {string|null} marketName - 用户绑定市场名，用于 market_scope 过滤
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
      c.category_id,
      c.category_name,
      c.product_kind,
      c.sort_order AS category_order
    FROM product_categories c
    WHERE c.is_valid = true
      AND EXISTS (
        SELECT 1 FROM products p
        JOIN product_skus sk ON sk.product_id = p.product_id
        WHERE p.category_id = c.category_id
          AND ${PRODUCT_VALID_FILTER}
          AND ${SKU_VALID_FILTER}
          ${marketFilter}
      )
    ORDER BY c.sort_order ASC
  `

  return pg.query(sql, params)
}

/**
 * 品项分类列表
 * 从 product_categories 查询，仅显示含有效商品的分类
 */
async function categories(ctx) {
  const marketName = ctx.auth?.boundMarketName || null
  const categoriesList = await getCategoriesList(marketName)
  ctx.result = { categories: categoriesList }
}

/**
 * 内部函数：按分类获取商品列表（含 SKU）
 * @param {string|null} marketName - 用户绑定市场名，用于 market_scope 过滤
 */
async function getProductListByCategory({ categoryId, productKind, marketName }) {
  const params = []

  // 构建 market_scope 过滤条件
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

  if (productKind) {
    params.push(productKind)
    whereClause += ` AND c.product_kind = $${params.length}`
  }

  // 仅返回有有效 SKU 的商品
  whereClause += ` AND EXISTS (
    SELECT 1 FROM product_skus sk
    WHERE sk.product_id = p.product_id
      AND ${SKU_VALID_FILTER}
  )`

  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      c.category_name, c.product_kind,
      p.cover_image, p.description, p.sort_order,
      p.price, p.special_price, p.is_shengmei, p.is_bundle
    FROM products p
    JOIN product_categories c ON p.category_id = c.category_id
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 批量查询所有商品的 SKU（消除 N+1）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT
        sk.product_id, sk.sku_id, sk.product_type, sk.spec_name,
        sk.price, sk.special_price, sk.session_count,
        sk.service_fee, sk.sort_order
      FROM product_skus sk
      WHERE sk.product_id = ANY($1)
        AND ${SKU_VALID_FILTER}
      ORDER BY sk.sort_order ASC
    `, [productIds])
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  return productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const prices = skus.map(s => Number(s.special_price || s.price || 0))
    return {
      ...product,
      skuList: skus,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null
    }
  })
}

/**
 * 商品列表
 * PG 查询商品 + SKU 信息
 */
async function spuList(ctx) {
  const { categoryId, productKind } = ctx.event.payload || {}
  const marketName = ctx.auth?.boundMarketName || null
  const result = await getProductListByCategory({ categoryId, productKind, marketName })
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
 * 从 PG 读取商品 + SKU 信息
 */
async function skuDetail(ctx) {
  const { skuId } = ctx.event.payload || {}

  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  const skuList = await pg.query(`
    SELECT
      sk.sku_id, sk.product_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order,
      p.name AS product_name,
      p.category_id,
      c.category_name, c.product_kind,
      p.description
    FROM product_skus sk
    JOIN products p ON sk.product_id = p.product_id
    JOIN product_categories c ON p.category_id = c.category_id
    WHERE sk.sku_id = $1
  `, [skuId])

  if (skuList.length === 0) {
    throw new Error('INVALID_PARAMS: SKU 不存在')
  }

  ctx.result = { sku: skuList[0] }
}

/**
 * 热门推荐列表
 * 返回 sort_order 最小的 N 个商品（排除院装产品）
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
      c.category_name, c.product_kind,
      p.cover_image, p.sort_order,
      p.price, p.special_price
    FROM products p
    JOIN product_categories c ON p.category_id = c.category_id
    WHERE ${PRODUCT_VALID_FILTER}
      ${marketFilter}
      AND c.product_kind NOT IN ('福利活动')
      AND EXISTS (
        SELECT 1 FROM product_skus sk
        WHERE sk.product_id = p.product_id AND ${SKU_VALID_FILTER}
      )
    ORDER BY p.sort_order ASC
    LIMIT $1
  `, params)

  // 批量查询 SKU（取最低价）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT product_id, sku_id, price, special_price, sort_order
      FROM product_skus sk
      WHERE product_id = ANY($1) AND ${SKU_VALID_FILTER}
      ORDER BY sort_order ASC
    `, [productIds])
  }

  const skuByProduct = {}
  for (const sku of allSkus) {
    if (!skuByProduct[sku.product_id]) skuByProduct[sku.product_id] = []
    skuByProduct[sku.product_id].push(sku)
  }

  const result = productRows.map(product => {
    const skus = skuByProduct[product.product_id] || []
    const prices = skus.map(s => Number(s.special_price || s.price || 0))
    return {
      ...product,
      priceFrom: prices.length > 0 ? Math.min(...prices) : null
    }
  })

  ctx.result = { spuList: result }
}

/**
 * 商品详情（含 SKU 列表）
 * 根据 productId 查询单个商品及其 SKU 信息
 */
async function spuDetail(ctx) {
  const { spuId, productId: inputProductId } = ctx.event.payload || {}
  const marketName = ctx.auth?.boundMarketName || null
  const productId = inputProductId || spuId

  if (!productId) {
    throw new Error('INVALID_PARAMS: 缺少 productId 参数')
  }

  // 查询商品
  const productRows = await pg.query(`
    SELECT
      p.product_id, p.name, p.category_id,
      c.category_name, c.product_kind,
      p.cover_image, p.detail_images, p.description, p.sort_order,
      p.price, p.special_price, p.is_shengmei, p.is_bundle,
      p.sales_category
    FROM products p
    JOIN product_categories c ON p.category_id = c.category_id
    WHERE p.product_id = $1
  `, [productId])

  if (productRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const product = productRows[0]

  // 查询该商品的 SKU 列表
  const skuList = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order, sk.is_bundle_sku
    FROM product_skus sk
    WHERE sk.product_id = $1
      AND ${SKU_VALID_FILTER}
    ORDER BY sk.sort_order ASC
  `, [productId])

  const prices = skuList.map(s => Number(s.special_price || s.price || 0))

  ctx.result = {
    spu: {
      ...product,
      skuList,
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
