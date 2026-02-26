/**
 * 商品模块路由
 * SPU 从 PG 查询,SKU 价格/次数从 WorkFine 实时读取
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')

// WorkFine 价格缓存（模块级，云函数实例回收时自动清除）
// key: `${workfine_source}:${workfine_item_id}`, value: { data, ts }
const PRICE_CACHE_TTL = 5 * 60 * 1000 // 5 分钟
const priceCache = new Map()

/**
 * 内部函数：获取分类列表（合并为一条 SQL）
 */
async function getCategoriesList(storeName) {
  let sql = `
    SELECT
      p.category,
      p.big_category,
      MIN(p.sort_order) AS category_order
    FROM product_spu p
    WHERE EXISTS (
      SELECT 1 FROM product_spu_sku_map m
      WHERE m.spu_id = p.spu_id AND m.is_active = true
    )
  `

  if (!storeName) {
    // 未绑定门店：生美/非生美只显示通用 SKU，院装产品只显示 UDT_M_341，组合套餐只显示 UDT_M_1460
    sql += `
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id
          AND m.is_active = true
          AND (
            (p.big_category NOT IN ('院装产品', '组合套餐') AND m.workfine_source IN ('UDT_M_1281', 'UDT_M_341'))
            OR
            (p.big_category = '院装产品' AND m.workfine_source = 'UDT_M_341')
            OR
            (p.big_category = '组合套餐' AND m.workfine_source = 'UDT_M_1460')
          )
      )
    `
  }

  sql += `
    GROUP BY p.category, p.big_category
    ORDER BY MIN(p.sort_order) ASC
  `

  return pg.query(sql)
}

/**
 * 品项分类列表
 * 从 product_spu 动态派生,仅显示含有效 SKU 的分类
 * @param {string} storeName - 门店名称（可选），未绑定时只显示通用产品分类
 */
async function categories(ctx) {
  const { storeName } = ctx.event.payload || {}
  const categoriesList = await getCategoriesList(storeName)
  ctx.result = { categories: categoriesList }
}

/**
 * 内部函数：按分类获取 SPU 列表（含 SKU 价格）
 */
async function getSpuListByCategory({ category, bigCategory, storeName }) {
  let whereClause = 'WHERE EXISTS (SELECT 1 FROM product_spu_sku_map m WHERE m.spu_id = p.spu_id AND m.is_active = true)'
  const params = []

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

  if (category) {
    params.push(category)
    whereClause += ` AND p.category = $${params.length}`
  }

  if (bigCategory) {
    params.push(bigCategory)
    whereClause += ` AND p.big_category = $${params.length}`
  }

  const spuRows = await pg.query(`
    SELECT
      p.spu_id, p.name, p.category, p.big_category,
      p.cover_image, p.description, p.sort_order
    FROM product_spu p
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 批量查询所有 SPU 的 SKU（消除 N+1）
  const spuIds = spuRows.map(s => s.spu_id)
  let allSkus = []
  if (spuIds.length > 0) {
    let skuFilterSql = 'WHERE spu_id = ANY($1) AND is_active = true'
    if (!storeName) {
      skuFilterSql += ` AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')`
    }
    allSkus = await pg.query(`
      SELECT spu_id, sku_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order
      FROM product_spu_sku_map
      ${skuFilterSql}
      ORDER BY sort_order ASC
    `, [spuIds])
  }

  const allSkusWithPrice = await enrichSkuWithWorkfinePrice(allSkus)

  const skuBySpu = {}
  for (const sku of allSkusWithPrice) {
    if (!skuBySpu[sku.spu_id]) skuBySpu[sku.spu_id] = []
    skuBySpu[sku.spu_id].push(sku)
  }

  return spuRows.map(spu => {
    const skus = skuBySpu[spu.spu_id] || []
    return {
      ...spu,
      skuList: skus,
      priceFrom: skus.length > 0 ? Math.min(...skus.map(s => s.originalPrice || 0)) : null
    }
  })
}

/**
 * SPU 列表
 * PG 查询 SPU + WorkFine 实时读取 SKU 价格
 * @param {string} storeName - 门店名称（可选），未绑定时只显示通用产品
 */
async function spuList(ctx) {
  const { category, bigCategory, storeName } = ctx.event.payload || {}
  const result = await getSpuListByCategory({ category, bigCategory, storeName })
  ctx.result = { spuList: result }
}

/**
 * Shop 页初始化接口（合并 categories + 第一个分类的 spuList）
 * 一次云函数调用返回所有初始数据
 */
async function shopInit(ctx) {
  const { storeName } = ctx.event.payload || {}

  const categoriesList = await getCategoriesList(storeName)

  let firstSpuList = []
  if (categoriesList.length > 0) {
    const firstCategory = categoriesList[0].category
    firstSpuList = await getSpuListByCategory({ category: firstCategory, storeName })
  }

  ctx.result = {
    categories: categoriesList,
    spuList: firstSpuList
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
 * 带模块级缓存，TTL 5 分钟
 */
async function enrichSkuWithWorkfinePrice(skuList) {
  if (skuList.length === 0) return []

  const now = Date.now()

  // 分离缓存命中与未命中的 SKU
  const workfineMap = {} // item_id -> workfineData
  const uncachedSkus = []

  for (const sku of skuList) {
    const cacheKey = `${sku.workfine_source}:${sku.workfine_item_id}`
    const cached = priceCache.get(cacheKey)
    if (cached && (now - cached.ts) < PRICE_CACHE_TTL) {
      workfineMap[sku.workfine_item_id] = cached.data
    } else {
      uncachedSkus.push(sku)
    }
  }

  // 仅对未命中的 SKU 发起 MSSQL 查询
  if (uncachedSkus.length > 0) {
    // 按 workfine_source 分组
    const groups = {}
    for (const sku of uncachedSkus) {
      const src = sku.workfine_source
      if (!groups[src]) groups[src] = []
      groups[src].push(sku)
    }

    // 转义单引号防注入
    const esc = (v) => String(v).replace(/'/g, "''")

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
            const data = {
              itemName: r.item_name, sessionCount: r.session_count,
              originalPrice: r.original_price, isShengmei: r.is_shengmei
            }
            workfineMap[r.item_id] = data
            priceCache.set(`UDT_M_1281:${r.item_id}`, { data, ts: now })
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
            const data = {
              itemName: r.item_name, sessionCount: r.session_count,
              originalPrice: r.original_price, isShengmei: r.is_shengmei
            }
            workfineMap[r.item_id] = data
            priceCache.set(`UDT_M_1383:${r.item_id}`, { data, ts: now })
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
            const data = {
              itemName: r.item_name, specification: r.specification,
              originalPrice: r.retail_price, sessionCount: null
            }
            workfineMap[r.item_id] = data
            priceCache.set(`UDT_M_341:${r.item_id}`, { data, ts: now })
          }
        })
      )
    }

    await Promise.all(queries)
  }

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

  let whereClause = `WHERE p.big_category NOT IN ('院装产品', '组合套餐')
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

  // 批量查询所有 SPU 的 SKU（消除 N+1）
  const spuIds = spuListResult.map(s => s.spu_id)
  let allSkus = []
  if (spuIds.length > 0) {
    let skuFilterSql = 'WHERE spu_id = ANY($1) AND is_active = true'
    if (!storeName) {
      skuFilterSql += ` AND workfine_source IN ('UDT_M_1281', 'UDT_M_341')`
    }
    allSkus = await pg.query(`
      SELECT spu_id, sku_id, workfine_item_id, workfine_source, product_type, sku_display_name, sort_order
      FROM product_spu_sku_map
      ${skuFilterSql}
      ORDER BY sort_order ASC
    `, [spuIds])
  }

  const allSkusWithPrice = await enrichSkuWithWorkfinePrice(allSkus)

  // 按 spu_id 分组，只取 priceFrom
  const skuBySpu = {}
  for (const sku of allSkusWithPrice) {
    if (!skuBySpu[sku.spu_id]) skuBySpu[sku.spu_id] = []
    skuBySpu[sku.spu_id].push(sku)
  }

  const result = spuListResult.map(spu => {
    const skus = skuBySpu[spu.spu_id] || []
    return {
      ...spu,
      priceFrom: skus.length > 0 ? Math.min(...skus.map(s => s.originalPrice || 0)) : null
    }
  })

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
  hotList,
  shopInit
}
