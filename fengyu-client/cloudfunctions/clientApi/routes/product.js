/**
 * 商品模块路由
 * SPU 从 PG 查询,SKU 价格/次数从 WorkFine 实时读取
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')

/**
 * 品项分类列表
 * 从 product_spu 动态派生,仅显示含有效 SKU 的分类
 */
async function categories(ctx) {
  // 查询有效分类(生美/非生美)
  const categoriesResult = await pg.query(`
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
    GROUP BY p.category, p.big_category
    ORDER BY MIN(p.sort_order) ASC
  `)

  // 查询院装产品分类
  const inStoreResult = await pg.query(`
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
  `)

  ctx.result = {
    categories: [...categoriesResult, ...inStoreResult]
  }
}

/**
 * SPU 列表
 * PG 查询 SPU + WorkFine 实时读取 SKU 价格
 */
async function spuList(ctx) {
  const { category, bigCategory } = ctx.event.payload || {}

  let whereClause = 'WHERE EXISTS (SELECT 1 FROM product_spu_sku_map m WHERE m.spu_id = p.spu_id AND m.is_active = true)'
  const params = []

  if (category) {
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
    const skuList = await pg.query(`
      SELECT
        sku_id,
        workfine_item_id,
        workfine_source,
        product_type,
        sku_display_name,
        sort_order
      FROM product_spu_sku_map
      WHERE spu_id = $1 AND is_active = true
      ORDER BY sort_order ASC
    `, [spu.spu_id])

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
 * 从 WorkFine 读取 SKU 价格/次数信息
 */
async function enrichSkuWithWorkfinePrice(skuList) {
  const result = []

  for (const sku of skuList) {
    let workfineData = null

    // 根据数据源查询 WorkFine
    if (sku.workfine_source === 'UDT_M_1281') {
      // 全国可售项目
      const sql = `
        SELECT
          UDF_M_14503 AS item_id,
          UDF_M_14505 AS item_name,
          UDF_M_14506 AS session_count,
          UDF_M_14508 AS original_price,
          UDF_M_17783 AS is_shengmei
        FROM UDT_M_1281
        WHERE UDF_M_14503 = '${sku.workfine_item_id}'
      `
      const rows = await mssql.query(sql)
      if (rows.length > 0) {
        workfineData = {
          itemName: rows[0].item_name,
          sessionCount: rows[0].session_count,
          originalPrice: rows[0].original_price,
          isShengmei: rows[0].is_shengmei
        }
      }
    } else if (sku.workfine_source === 'UDT_M_1383') {
      // 门店自定义项目
      const sql = `
        SELECT
          UDF_M_14503 AS item_id,
          UDF_M_14505 AS item_name,
          UDF_M_14506 AS session_count,
          UDF_M_14508 AS original_price,
          UDF_M_17784 AS is_shengmei
        FROM UDT_M_1383
        WHERE UDF_M_14503 = '${sku.workfine_item_id}'
      `
      const rows = await mssql.query(sql)
      if (rows.length > 0) {
        workfineData = {
          itemName: rows[0].item_name,
          sessionCount: rows[0].session_count,
          originalPrice: rows[0].original_price,
          isShengmei: rows[0].is_shengmei
        }
      }
    } else if (sku.workfine_source === 'UDT_M_341') {
      // 院装产品
      const sql = `
        SELECT
          UDF_M_1870 AS item_id,
          UDF_M_1871 AS item_name,
          UDF_M_1872 AS specification,
          UDF_M_1875 AS retail_price
        FROM UDT_M_341
        WHERE UDF_M_1870 = '${sku.workfine_item_id}'
      `
      const rows = await mssql.query(sql)
      if (rows.length > 0) {
        workfineData = {
          itemName: rows[0].item_name,
          specification: rows[0].specification,
          originalPrice: rows[0].retail_price,
          sessionCount: null // 院装产品无次数概念
        }
      }
    }

    result.push({
      ...sku,
      ...workfineData
    })
  }

  return result
}

module.exports = {
  categories,
  spuList,
  skuDetail
}
