/**
 * 商品模块路由
 * SPU 从 PG 查询,SKU 价格/次数从 WorkFine 实时读取
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')

/**
 * 品项分类列表
 * 从 product_spu 动态派生,仅显示含有效 SKU 的分类
 * @param {string} storeName - 门店名称（可选），未绑定时只显示通用产品分类
 */
async function categories(ctx) {
  const { storeName } = ctx.event.payload || {}

  // 门店专供产品的 SKU 来源是 UDT_M_1383
  // 通用产品的 SKU 来源是 UDT_M_1281 或 UDT_M_341

  // 生美/非生美分类（排除院装产品）
  let categoriesSql = `
    SELECT
      p.category,
      p.big_category,
      MIN(p.sort_order) AS category_order
    FROM product_spu p
    WHERE p.big_category != '院装产品'
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id AND m.is_active = true
      )
  `

  // 未绑定门店时，过滤掉只有门店专供 SKU 的 SPU
  if (!storeName) {
    categoriesSql += `
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id
          AND m.is_active = true
          AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341')
      )
    `
  }

  categoriesSql += `
    GROUP BY p.category, p.big_category
    ORDER BY MIN(p.sort_order) ASC
  `

  const categoriesResult = await pg.query(categoriesSql)

  // 院装产品分类
  let inStoreSql = `
    SELECT
      '院装产品' AS category,
      '院装产品' AS big_category,
      MIN(p.sort_order) AS category_order
    FROM product_spu p
    WHERE p.big_category = '院装产品'
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id AND m.is_active = true
      )
  `

  // 未绑定门店时，院装产品也只显示通用的
  if (!storeName) {
    inStoreSql += `
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id
          AND m.is_active = true
          AND m.workfine_source = 'UDT_M_341'
      )
    `
  }

  const inStoreResult = await pg.query(inStoreSql)

  ctx.result = {
    categories: [...categoriesResult, ...inStoreResult]
  }
}

/**
 * SPU 列表
 * PG 查询 SPU + WorkFine 实时读取 SKU 价格
 * @param {string} storeName - 门店名称（可选），未绑定时只显示通用产品
 */
async function spuList(ctx) {
  const { category, bigCategory, storeName } = ctx.event.payload || {}

  let whereClause = 'WHERE EXISTS (SELECT 1 FROM product_spu_sku_map m WHERE m.spu_id = p.spu_id AND m.is_active = true)'
  const params = []

  // 未绑定门店时，过滤掉门店专供产品（UDT_M_1383）
  if (!storeName) {
    whereClause += `
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id
          AND m.is_active = true
          AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341')
      )
    `
  }

  // 院装产品特殊处理：category 参数传入 "院装产品" 时，改为按 big_category 查询
  if (category === '院装产品') {
    whereClause += ` AND p.big_category = '院装产品'`
  } else if (category) {
    params.push(category)
    whereClause += ` AND p.category = $${params.length}`
  }

  if (bigCategory) {
    params.push(bigCategory)
    whereClause += ` AND p.big_category = $${params.length}`
  }

  // 查询 SPU 列表
  const spuList = await pg.query(`
    SELECT
      p.spu_id,
      p.name,
      p.category,
      p.big_category,
      p.cover_image,
      p.description,
      p.sort_order
    FROM product_spu p
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 查询每个 SPU 的 SKU 列表
  const result = []
  for (const spu of spuList) {
    // 未绑定门店时，只查询通用产品的 SKU
    let skuFilterSql = 'WHERE spu_id = $1 AND is_active = true'
    const skuParams = [spu.spu_id]

    if (!storeName) {
      skuFilterSql += ` AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')`
    }

    const skuList = await pg.query(`
      SELECT
        sku_id,
        workfine_item_id,
        workfine_source,
        product_type,
        sku_display_name,
        sort_order
      FROM product_spu_sku_map
      ${skuFilterSql}
      ORDER BY sort_order ASC
    `, skuParams)

    // 从 WorkFine 读取价格信息
    const skuWithPrice = await enrichSkuWithWorkfinePrice(skuList)

    result.push({
      ...spu,
      skuList: skuWithPrice,
      // 价格起步(最小价格)
      priceFrom: skuWithPrice.length > 0 ? Math.min(...skuWithPrice.map(s => s.originalPrice || 0)) : null
    })
  }

  ctx.result = {
    spuList: result
  }
}

/**
 * SKU 详情
 * 实时从 WorkFine 读取价格/次数
 */
async function skuDetail(ctx) {
  const { skuId } = ctx.event.payload || {}

  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  // 查询 SKU 映射信息
  const skuList = await pg.query(`
    SELECT
      m.sku_id,
      m.spu_id,
      m.workfine_item_id,
      m.workfine_source,
      m.product_type,
      m.sku_display_name,
      m.sort_order,
      p.name AS spu_name,
      p.category,
      p.big_category,
      p.description
    FROM product_spu_sku_map m
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE m.sku_id = $1
  `, [skuId])

  if (skuList.length === 0) {
    throw new Error('INVALID_PARAMS: SKU 不存在')
  }

  const sku = skuList[0]

  // 从 WorkFine 读取价格/次数
  const enriched = await enrichSkuWithWorkfinePrice([sku])

  ctx.result = {
    sku: enriched[0]
  }
}

/**
 * 从 WorkFine 批量读取 SKU 价格/次数信息
 * 按 workfine_source 分组，每组一次查询（最多 3 次远程查询）
 */
async function enrichSkuWithWorkfinePrice(skuList) {
  if (skuList.length === 0) return []

  // 按 workfine_source 分组
  const groups = {}
  for (const sku of skuList) {
    const src = sku.workfine_source
    if (!groups[src]) groups[src] = []
    groups[src].push(sku)
  }

  // 转义单引号防注入
  const esc = (v) => String(v).replace(/'/g, "''")

  // 按分组并发查询 WorkFine
  const workfineMap = {} // item_id -> workfineData
  const queries = []

  if (groups['UDT_M_1281']) {
    const ids = groups['UDT_M_1281'].map(s => `'${esc(s.workfine_item_id)}'`).join(',')
    queries.push(
      mssql.query(`
        SELECT UDF_M_14503 AS item_id, UDF_M_14505 AS item_name,
               UDF_M_14506 AS session_count, UDF_M_14508 AS original_price,
               UDF_M_17783 AS is_shengmei
        FROM UDT_M_1281 WHERE UDF_M_14503 IN (${ids})
      `).then(rows => {
        for (const r of rows) {
          workfineMap[r.item_id] = {
            itemName: r.item_name, sessionCount: r.session_count,
            originalPrice: r.original_price, isShengmei: r.is_shengmei
          }
        }
      })
    )
  }

  if (groups['UDT_M_1383']) {
    const ids = groups['UDT_M_1383'].map(s => `'${esc(s.workfine_item_id)}'`).join(',')
    queries.push(
      mssql.query(`
        SELECT UDF_M_14503 AS item_id, UDF_M_14505 AS item_name,
               UDF_M_14506 AS session_count, UDF_M_14508 AS original_price,
               UDF_M_17784 AS is_shengmei
        FROM UDT_M_1383 WHERE UDF_M_14503 IN (${ids})
      `).then(rows => {
        for (const r of rows) {
          workfineMap[r.item_id] = {
            itemName: r.item_name, sessionCount: r.session_count,
            originalPrice: r.original_price, isShengmei: r.is_shengmei
          }
        }
      })
    )
  }

  if (groups['UDT_M_341']) {
    const ids = groups['UDT_M_341'].map(s => `'${esc(s.workfine_item_id)}'`).join(',')
    queries.push(
      mssql.query(`
        SELECT UDF_M_1870 AS item_id, UDF_M_1871 AS item_name,
               UDF_M_1872 AS specification, UDF_M_1875 AS retail_price
        FROM UDT_M_341 WHERE UDF_M_1870 IN (${ids})
      `).then(rows => {
        for (const r of rows) {
          workfineMap[r.item_id] = {
            itemName: r.item_name, specification: r.specification,
            originalPrice: r.retail_price, sessionCount: null
          }
        }
      })
    )
  }

  await Promise.all(queries)

  // 将 WorkFine 数据合并回 SKU 列表
  return skuList.map(sku => ({
    ...sku,
    ...(workfineMap[sku.workfine_item_id] || {})
  }))
}

/**
 * 热门推荐列表
 * 返回 sort_order 最小的 N 个 SPU（排除院装产品）
 */
async function hotList(ctx) {
  const { storeName, limit = 6 } = ctx.event.payload || {}

  let whereClause = `WHERE p.big_category != '院装产品'
    AND EXISTS (
      SELECT 1 FROM product_spu_sku_map m
      WHERE m.spu_id = p.spu_id AND m.is_active = true
    )`

  if (!storeName) {
    whereClause += `
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id
          AND m.is_active = true
          AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341')
      )
    `
  }

  const spuListResult = await pg.query(`
    SELECT p.spu_id, p.name, p.category, p.big_category, p.cover_image, p.sort_order
    FROM product_spu p
    ${whereClause}
    ORDER BY p.sort_order ASC
    LIMIT $1
  `, [limit])

  const result = []
  for (const spu of spuListResult) {
    let skuFilterSql = 'WHERE spu_id = $1 AND is_active = true'
    const skuParams = [spu.spu_id]

    if (!storeName) {
      skuFilterSql += ` AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')`
    }

    const skuList = await pg.query(`
      SELECT sku_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order
      FROM product_spu_sku_map
      ${skuFilterSql}
      ORDER BY sort_order ASC
    `, skuParams)

    const skuWithPrice = await enrichSkuWithWorkfinePrice(skuList)

    result.push({
      ...spu,
      priceFrom: skuWithPrice.length > 0 ? Math.min(...skuWithPrice.map(s => s.originalPrice || 0)) : null
    })
  }

  ctx.result = { spuList: result }
}

/**
 * SPU 详情（含 SKU 列表）
 * 根据 spuId 查询单个 SPU 及其 SKU 价格信息
 * @param {string} spuId - SPU ID
 * @param {string} storeName - 门店名称（可选）
 */
async function spuDetail(ctx) {
  const { spuId, storeName } = ctx.event.payload || {}

  if (!spuId) {
    throw new Error('INVALID_PARAMS: 缺少 spuId 参数')
  }

  // 查询单个 SPU
  const spuRows = await pg.query(`
    SELECT spu_id, name, category, big_category, cover_image, description, sort_order
    FROM product_spu
    WHERE spu_id = $1
  `, [spuId])

  if (spuRows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  const spu = spuRows[0]

  // 查询该 SPU 的 SKU 列表
  let skuFilterSql = 'WHERE spu_id = $1 AND is_active = true'
  const skuParams = [spuId]

  if (!storeName) {
    skuFilterSql += ` AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')`
  }

  const skuList = await pg.query(`
    SELECT sku_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order
    FROM product_spu_sku_map
    ${skuFilterSql}
    ORDER BY sort_order ASC
  `, skuParams)

  // 从 WorkFine 读取价格信息
  const skuWithPrice = await enrichSkuWithWorkfinePrice(skuList)

  ctx.result = {
    spu: {
      ...spu,
      skuList: skuWithPrice,
      priceFrom: skuWithPrice.length > 0 ? Math.min(...skuWithPrice.map(s => s.originalPrice || 0)) : null
    }
  }
}

module.exports = {
  categories,
  spuList,
  skuDetail,
  spuDetail,
  hotList
}
