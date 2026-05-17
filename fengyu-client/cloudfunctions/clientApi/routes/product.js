/**
 * 商品模块路由（客户端/商城管理）
 * 数据从 PG mall_categories / products / mall_product_skus / product_skus 查询
 */

const pg = require('../db/pg')

/**
 * 有效性过滤条件（商城商品层 + SKU 层叠加）
 *
 * 2026-04-26 capability 化：商城常规通道默认排除两类特殊卡：
 *   - sk.is_experience = true：体验卡（仅 client 体验卡入口可见）
 *   - sk.is_recharge_card = true：充值卡（仅 card-recharge 入口走单一虚拟 SKU）
 * 两类 capability 列互斥（CHECK chk_sku_not_both_capabilities）。
 */
const PRODUCT_VALID_FILTER = `p.is_enabled = true AND p.is_visible = true`
const SKU_VALID_FILTER = `sk.is_enabled = true AND NOT (sk.is_experience OR sk.is_recharge_card)`

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
      mc.category_group,
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
 * 内部函数：获取一级分组列表（category_group IS NULL）
 * 仅返回下属二级分类中含有效商品的分组
 */
async function getCategoryGroups(marketName) {
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
      mg.category_id,
      mg.category_name,
      mg.sort_order
    FROM mall_categories mg
    WHERE mg.category_group IS NULL
      AND EXISTS (
        SELECT 1 FROM mall_categories mc
        WHERE mc.category_group = mg.category_name
          AND EXISTS (
            SELECT 1 FROM products p
            JOIN mall_product_skus mps ON mps.product_id = p.product_id
            JOIN product_skus sk ON mps.sku_id = sk.sku_id
            WHERE p.category_id = mc.category_id
              AND ${PRODUCT_VALID_FILTER}
              AND ${SKU_VALID_FILTER}
              ${marketFilter}
          )
      )
    ORDER BY mg.sort_order ASC
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
  // PR-D：附带 product_kind + kind_display_color（一级行 display_color），
  // 用于客户端购物车 tag 颜色渲染（DB 驱动）
  const productIds = productRows.map(p => p.product_id)
  let allSkus = []
  if (productIds.length > 0) {
    allSkus = await pg.query(`
      SELECT
        mps.product_id, sk.sku_id, sk.product_type, sk.spec_name,
        sk.price, sk.special_price, sk.session_count,
        sk.service_fee, mps.sort_order AS display_order,
        mps.bundle_price, mps.bundle_group_id,
        bg.group_name, bg.pick_count AS group_pick_count,
        pc.product_kind,
        parent_pc.display_color AS kind_display_color
      FROM mall_product_skus mps
      JOIN product_skus sk ON mps.sku_id = sk.sku_id
      LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
      LEFT JOIN product_categories parent_pc
        ON parent_pc.product_kind IS NULL
       AND parent_pc.category_name = pc.product_kind
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

  const [groups, categoriesList] = await Promise.all([
    getCategoryGroups(marketName),
    getCategoriesList(marketName),
  ])

  // 找第一个 group 下的第一个二级分类，加载其商品
  let firstSpuList = []
  if (groups.length > 0 && categoriesList.length > 0) {
    const firstChild = categoriesList.find(c => c.category_group === groups[0].category_name)
    if (firstChild) {
      firstSpuList = await getProductListByCategory({ categoryId: firstChild.category_id, marketName })
    }
  } else if (categoriesList.length > 0) {
    // 降级：无分组时取第一个分类
    firstSpuList = await getProductListByCategory({ categoryId: categoriesList[0].category_id, marketName })
  }

  ctx.result = {
    groups,
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

  // PR-D：JOIN product_categories pc → parent_pc，带出 product_kind + kind_display_color
  const skuList = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order, sk.is_shengmei,
      mps.bundle_price, mps.sort_order AS display_order,
      mps.bundle_group_id,
      bg.group_name, bg.pick_count AS group_pick_count,
      pc.product_kind,
      parent_pc.display_color AS kind_display_color
    FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
    LEFT JOIN product_categories parent_pc
      ON parent_pc.product_kind IS NULL
     AND parent_pc.category_name = pc.product_kind
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

/**
 * 体验卡 SKU 列表（client 体验卡入口专用）
 *
 * 与商城常规通道（spuList / shopInit / hotList）互斥：
 *   - 商城通道用 SKU_VALID_FILTER，默认排除 is_experience = true
 *   - 本入口反向只取 is_experience = true 的 SKU
 *
 * 返回顺序按 sortOrder ASC（admin 配置项 C5），同 sortOrder 时按 sku_id 兜底稳定排序。
 * 一并返回所属商品名 / 封面图（mall_product_skus → products JOIN），便于列表卡片直接渲染。
 *
 * 不做 marketName 过滤：体验卡是拉新工具，所有市场可见（如未来需限制可加 p.market_scope 校验）。
 */
async function experienceCardList(ctx) {
  const rows = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.service_fee, sk.sort_order,
      p.product_id, p.name AS product_name,
      p.cover_image, p.description
    FROM product_skus sk
    LEFT JOIN mall_product_skus mps ON mps.sku_id = sk.sku_id
    LEFT JOIN products p ON p.product_id = mps.product_id
    WHERE sk.is_experience = true
      AND sk.is_enabled = true
    ORDER BY sk.sort_order ASC, sk.sku_id ASC
  `)

  ctx.result = { skuList: rows }
}

/**
 * 卡类一级 kind 名单（与 staffApi product.cardKinds 行为对齐）
 *
 * 从 `product_categories` 一级行（productKind IS NULL）取 `is_card_kind=true` 的
 * `category_name` 列表，供小程序前端"普通商品 vs 卡类"过滤使用。
 * 返回 `{ names: string[] }`：按 sort_order 升序；DB 异常时返回空数组（前端兜底）。
 *
 * 与 staffApi 副本独立维护（用户决策：避免跨项目运维），
 * 一致性靠 staffApi __tests__/routes/cross-end-sql-snapshot.test.js 风格的测试守护。
 */
async function cardKinds(ctx) {
  try {
    const rows = await pg.query(`
      SELECT category_name
      FROM product_categories
      WHERE product_kind IS NULL
        AND is_card_kind = true
        AND is_valid = true
      ORDER BY sort_order ASC
    `)
    ctx.result = { names: rows.map((r) => r.category_name) }
  } catch (err) {
    ctx.result = { names: [] }
  }
}

module.exports = {
  categories,
  spuList,
  skuDetail,
  spuDetail,
  hotList,
  shopInit,
  experienceCardList,
  cardKinds,
}
