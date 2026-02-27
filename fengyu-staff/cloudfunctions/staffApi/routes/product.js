/**
 * 商品模块路由（员工端）
 * product.categories — 品项分类列表
 * product.spuList — SPU 列表（含 SKU 价格）
 * product.skuDetail — SKU 详情
 * product.promotionList — 促销方案列表
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireStaffBound } = require('../middleware/auth')

// WorkFine 价格缓存（模块级，云函数实例回收时自动清除）
const PRICE_CACHE_TTL = 5 * 60 * 1000 // 5 分钟
const priceCache = new Map()

/**
 * 品项分类列表
 * 从 product_spu 动态派生（含有效 SKU 的分类）
 */
async function categories(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const rows = await pg.query(`
    SELECT
      p.category,
      p.big_category,
      MIN(p.sort_order) AS category_order
    FROM product_spu p
    WHERE p.big_category != '促销方案'
      AND EXISTS (
        SELECT 1 FROM product_spu_sku_map m
        WHERE m.spu_id = p.spu_id AND m.is_active = true
      )
    GROUP BY p.category, p.big_category
    ORDER BY MIN(p.sort_order) ASC
  `)

  ctx.result = { categories: rows }
}

/**
 * SPU 列表（按品项分类），含 WorkFine 实时价格
 */
async function spuList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { category, bigCategory } = ctx.event.payload || {}

  const params = []
  let whereClause = `
    WHERE EXISTS (
      SELECT 1 FROM product_spu_sku_map m
      WHERE m.spu_id = p.spu_id AND m.is_active = true
    )
    AND p.big_category != '促销方案'
  `

  if (category) {
    params.push(category)
    whereClause += ` AND p.category = $${params.length}`
  }

  if (bigCategory) {
    params.push(bigCategory)
    whereClause += ` AND p.big_category = $${params.length}`
  }

  const spuRows = await pg.query(`
    SELECT spu_id, name, category, big_category, cover_image, description, sort_order
    FROM product_spu p
    ${whereClause}
    ORDER BY p.sort_order ASC
  `, params)

  // 批量查询所有 SPU 的 SKU
  const spuIds = spuRows.map(s => s.spu_id)
  let allSkus = []
  if (spuIds.length > 0) {
    allSkus = await pg.query(`
      SELECT spu_id, sku_id, workfine_item_id, workfine_source, product_type,
             sku_display_name, sort_order
      FROM product_spu_sku_map
      WHERE spu_id = ANY($1) AND is_active = true
      ORDER BY sort_order ASC
    `, [spuIds])
  }

  const allSkusWithPrice = await enrichSkuWithWorkfinePrice(allSkus)

  const skuBySpu = {}
  for (const sku of allSkusWithPrice) {
    if (!skuBySpu[sku.spu_id]) skuBySpu[sku.spu_id] = []
    skuBySpu[sku.spu_id].push(sku)
  }

  ctx.result = {
    spuList: spuRows.map(spu => {
      const skus = skuBySpu[spu.spu_id] || []
      return {
        ...spu,
        skuList: skus,
        priceFrom: skus.length > 0 ? Math.min(...skus.map(s => Number(s.originalPrice) || 0)) : null
      }
    })
  }
}

/**
 * SKU 详情
 * 含 WorkFine 实时价格/次数
 */
async function skuDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { skuId } = ctx.event.payload || {}
  if (!skuId) {
    throw new Error('INVALID_PARAMS: 缺少 skuId 参数')
  }

  const skuList = await pg.query(`
    SELECT
      m.sku_id, m.spu_id, m.workfine_item_id, m.workfine_source,
      m.product_type, m.sku_display_name, m.sort_order,
      p.name AS spu_name, p.category, p.big_category, p.description
    FROM product_spu_sku_map m
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE m.sku_id = $1
  `, [skuId])

  if (skuList.length === 0) {
    throw new Error('INVALID_PARAMS: SKU 不存在')
  }

  const enriched = await enrichSkuWithWorkfinePrice([skuList[0]])
  ctx.result = { sku: enriched[0] }
}

/**
 * 促销方案列表
 * 从 WorkFine UDT_S_1459 查询有效促销方案
 * 包含方案内所有项目（UDT_M_1460）
 */
async function promotionList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeName } = ctx.event.payload || {}
  const targetStore = storeName || ctx.auth.storeName || ''
  const marketName = ctx.auth.marketName || ''

  const today = new Date().toISOString().slice(0, 10)

  const esc = (v) => String(v).replace(/'/g, "''")

  // 查询有效促销方案（按门店/市场过滤或全局方案）
  const schemeRows = await mssql.query(`
    SELECT
      UDF_S_17159 AS scheme_id,
      UDF_S_17175 AS scheme_name,
      UDF_S_17157 AS start_date,
      UDF_S_17158 AS end_date,
      UDF_S_17193 AS total_price,
      UDF_S_17793 AS scope
    FROM UDT_S_1459
    WHERE (UDF_S_17158 IS NULL OR UDF_S_17158 >= '${today}')
      AND (UDF_S_17157 IS NULL OR UDF_S_17157 <= '${today}')
    ORDER BY UDF_S_17159 DESC
  `)

  if (schemeRows.length === 0) {
    ctx.result = { schemes: [] }
    return
  }

  // 过滤促销范围：空=全部适用；有范围=匹配门店或市场
  const validSchemes = schemeRows.filter(s => {
    if (!s.scope) return true
    const scope = s.scope.trim()
    if (!scope) return true
    return scope.includes(targetStore) || scope.includes(marketName)
  })

  if (validSchemes.length === 0) {
    ctx.result = { schemes: [] }
    return
  }

  // 查询每个方案的明细（UDT_M_1460 通过 RID 关联 UDT_S_1459）
  const schemeIds = validSchemes.map(s => `'${esc(s.scheme_id)}'`).join(',')
  const itemRows = await mssql.query(`
    SELECT
      s.UDF_S_17159 AS scheme_id,
      m.UDF_M_17162 AS product_type,
      m.UDF_M_17163 AS workfine_item_id,
      m.UDF_M_17164 AS category,
      m.UDF_M_17165 AS item_name,
      m.UDF_M_17167 AS session_count,
      m.UDF_M_17168 AS list_price,
      m.UDF_M_17171 AS promo_price,
      m.UDF_M_17174 AS is_gift
    FROM UDT_S_1459 s
    INNER JOIN UDT_M_1460 m ON m.RID = s.RID
    WHERE s.UDF_S_17159 IN (${schemeIds})
    ORDER BY s.UDF_S_17159, m.OBYID
  `)

  // 查询对应 SKU 映射（用于开单）
  const wfItemIds = [...new Set(itemRows.map(r => r.workfine_item_id).filter(Boolean))]
  let skuMap = {}
  if (wfItemIds.length > 0) {
    const skuRows = await pg.query(`
      SELECT sku_id, workfine_item_id, workfine_source, product_type, sku_display_name
      FROM product_spu_sku_map
      WHERE workfine_item_id = ANY($1)
        AND workfine_source = 'UDT_M_1460'
        AND is_active = true
    `, [wfItemIds])
    for (const r of skuRows) {
      skuMap[r.workfine_item_id] = r
    }
  }

  // 按方案分组
  const schemeMap = {}
  for (const r of itemRows) {
    if (!schemeMap[r.scheme_id]) schemeMap[r.scheme_id] = []
    schemeMap[r.scheme_id].push({
      workfineItemId: r.workfine_item_id,
      productType: r.product_type,
      category: r.category,
      itemName: r.item_name,
      sessionCount: r.session_count,
      listPrice: r.list_price,
      promoPrice: r.is_gift === '是' ? 0 : (r.promo_price || 0),
      isGift: r.is_gift === '是',
      skuId: skuMap[r.workfine_item_id]?.sku_id || null
    })
  }

  ctx.result = {
    schemes: validSchemes.map(s => ({
      schemeId: s.scheme_id,
      schemeName: s.scheme_name,
      totalPrice: s.total_price,
      startDate: s.start_date,
      endDate: s.end_date,
      items: schemeMap[s.scheme_id] || []
    }))
  }
}

/**
 * 从 WorkFine 批量读取 SKU 价格/次数信息
 * 按 workfine_source 分组，每组一次查询
 * 带模块级缓存，TTL 5 分钟
 */
async function enrichSkuWithWorkfinePrice(skuList) {
  if (skuList.length === 0) return []

  const now = Date.now()
  const workfineMap = {}
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

  if (uncachedSkus.length > 0) {
    const groups = {}
    for (const sku of uncachedSkus) {
      const src = sku.workfine_source
      if (!groups[src]) groups[src] = []
      groups[src].push(sku)
    }

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

    if (groups['UDT_M_1460']) {
      const ids = groups['UDT_M_1460'].map(s => `'${esc(s.workfine_item_id)}'`).join(',')
      queries.push(
        mssql.query(`
          SELECT UDF_M_17163 AS item_id, UDF_M_17165 AS item_name,
                 UDF_M_17167 AS session_count, UDF_M_17168 AS original_price,
                 UDF_M_17171 AS promo_price
          FROM UDT_M_1460 WHERE UDF_M_17163 IN (${ids})
        `).then(rows => {
          for (const r of rows) {
            const data = {
              itemName: r.item_name, sessionCount: r.session_count,
              originalPrice: r.promo_price, listPrice: r.original_price
            }
            workfineMap[r.item_id] = data
            priceCache.set(`UDT_M_1460:${r.item_id}`, { data, ts: now })
          }
        })
      )
    }

    await Promise.all(queries)
  }

  return skuList.map(sku => ({
    ...sku,
    ...(workfineMap[sku.workfine_item_id] || {})
  }))
}

module.exports = { categories, spuList, skuDetail, promotionList }
