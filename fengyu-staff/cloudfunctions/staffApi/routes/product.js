

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')




async function _queryCategoryRows(opts = {}) {
  const { kindIn, kindNotIn, withParentJoin } = opts || {}
  const params = []
  const conditions = ['child.is_valid = true']

  if (Array.isArray(kindIn) && kindIn.length > 0) {
    params.push(kindIn)
    conditions.push(`child.product_kind = ANY($${params.length})`)
    conditions.push('child.product_kind IS NOT NULL')
  }
  if (Array.isArray(kindNotIn) && kindNotIn.length > 0) {
    params.push(kindNotIn)
    conditions.push(`child.product_kind <> ALL($${params.length})`)
    conditions.push('child.product_kind IS NOT NULL')
  }

  if (withParentJoin) {
    
    if (!conditions.includes('child.product_kind IS NOT NULL')) {
      conditions.push('child.product_kind IS NOT NULL')
    }
    const whereClause = conditions.join(' AND ')
    return pg.query(
      `
      SELECT
        child.category_id, child.category_name, child.product_kind,
        child.sales_category, child.sort_order,
        parent.category_name AS kind_name,
        parent.sort_order    AS kind_sort_order
      FROM product_categories child
      JOIN product_categories parent
        ON parent.product_kind IS NULL
       AND parent.category_name = child.product_kind
       AND parent.is_valid = true
      WHERE ${whereClause}
      ORDER BY parent.sort_order ASC, child.sort_order ASC
    `,
      params
    )
  }

  const whereClause = conditions.join(' AND ')
  return pg.query(
    `
    SELECT child.category_id, child.category_name, child.product_kind,
           child.sales_category, child.sort_order
    FROM product_categories child
    WHERE ${whereClause}
    ORDER BY child.sort_order ASC
  `,
    params
  )
}


function _formatCategory(r) {
  return {
    id: r.category_id,
    name: r.category_name,
    productKind: r.product_kind,
    salesCategory: r.sales_category,
    sortOrder: r.sort_order
  }
}


function _formatSkuRow(sk) {
  return {
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
    isExperience: !!sk.is_experience,
    isManagerSpecial: !!sk.is_manager_special,
    isBundle: !!sk.is_bundle,
  }
}


async function _queryFormattedSkuList(categoryId, productKind, opts = {}) {
  const { excludeCards = false } = opts || {}
  const params = []
  const conditions = [
    `sk.is_enabled = true`,
    `sk.deleted_at IS NULL`
  ]

  if (categoryId) {
    params.push(categoryId)
    conditions.push(`sk.category_id = $${params.length}`)
  }

  if (productKind) {
    params.push(productKind)
    conditions.push(`pc.product_kind = $${params.length}`)
  }

  if (excludeCards) {
    conditions.push(`NOT sk.is_experience`)
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ')

  const skuRows = await pg.query(`
    SELECT sk.sku_id, sk.category_id, sk.product_type, sk.spec_name,
           sk.price, sk.special_price, sk.session_count, sk.sort_order,
           sk.service_fee, sk.is_shengmei,
           sk.is_experience, sk.is_manager_special,
           pc.category_name, pc.product_kind, pc.sales_category,
           COALESCE((
             SELECT bool_or(p.is_bundle)
             FROM mall_product_skus mps
             JOIN products p ON mps.product_id = p.product_id
             WHERE mps.sku_id = sk.sku_id
           ), false) AS is_bundle
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    ${whereClause}
    ORDER BY sk.sort_order ASC
  `, params)

  return skuRows.map(_formatSkuRow)
}


async function _queryExperienceSkus() {
  const rows = await pg.query(`
    SELECT sk.sku_id, sk.category_id, sk.product_type, sk.spec_name,
           sk.price, sk.special_price, sk.session_count, sk.sort_order,
           sk.service_fee, sk.is_shengmei,
           sk.is_experience, sk.is_manager_special,
           pc.category_name, pc.product_kind, pc.sales_category,
           false AS is_bundle
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.is_experience = true
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
    ORDER BY sk.sort_order ASC
  `)
  return rows.map(_formatSkuRow)
}


async function _queryMallBundleGroups() {
  const productRows = await pg.query(`
    SELECT p.product_id, p.name, p.cover_image, p.description,
           p.price, p.special_price, p.sort_order
    FROM products p
    WHERE p.is_bundle = true
      AND p.deleted_at IS NULL
      AND p.is_visible = true
    ORDER BY p.sort_order ASC
  `)

  if (productRows.length === 0) return []

  const productIds = productRows.map(r => r.product_id)
  const groupRows = await pg.query(`
    SELECT id, product_id, group_name, pick_count, sort_order
    FROM mall_bundle_groups
    WHERE product_id = ANY($1)
    ORDER BY sort_order ASC
  `, [productIds])

  const skuLinkRows = await pg.query(`
    SELECT mps.product_id, mps.sku_id, mps.bundle_group_id,
           mps.bundle_price, mps.bundle_list_price, mps.sort_order,
           sk.spec_name, sk.session_count,
           sk.product_type, sk.is_shengmei,
           sk.price AS list_price, sk.special_price AS list_special_price
    FROM mall_product_skus mps
    JOIN product_skus sk ON mps.sku_id = sk.sku_id
    WHERE mps.product_id = ANY($1)
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
    ORDER BY mps.sort_order ASC
  `, [productIds])

  return productRows.map(p => {
    const groups = groupRows
      .filter(g => g.product_id === p.product_id)
      .map(g => ({
        id: g.id,
        groupName: g.group_name,
        pickCount: g.pick_count,
        skus: skuLinkRows
          .filter(s => s.product_id === p.product_id && s.bundle_group_id === g.id)
          .map(s => ({
            skuId: s.sku_id,
            specName: s.spec_name,
            sessionCount: s.session_count,
            productType: s.product_type,
            isShengmei: !!s.is_shengmei,
            
            bundlePrice: s.bundle_price != null ? Number(s.bundle_price)
              : (s.bundle_list_price != null ? Number(s.bundle_list_price) : (Number(s.list_price) || 0)),
            listPrice: s.bundle_list_price != null ? Number(s.bundle_list_price) : (Number(s.list_price) || 0),
            listSpecialPrice: s.list_special_price != null ? Number(s.list_special_price) : null,
            sortOrder: s.sort_order,
          })),
      }))
    return {
      productId: p.product_id,
      name: p.name,
      coverImage: p.cover_image,
      description: p.description,
      price: Number(p.price) || 0,
      specialPrice: p.special_price ? Number(p.special_price) : null,
      groups,
    }
  })
}




async function shopInit(ctx) {
  await requireStaffBound()(ctx, async () => {})

  
  const rawRows = await _queryCategoryRows({
    withParentJoin: true,
  })

  
  
  
  let catRows = rawRows
  if (rawRows.length > 0) {
    const categoryIds = rawRows.map((r) => r.category_id)
    const nonEmptyRows = await pg.query(
      `
      SELECT DISTINCT sk.category_id
      FROM product_skus sk
      WHERE sk.category_id = ANY($1)
        AND sk.is_enabled = true
        AND sk.deleted_at IS NULL
        AND NOT sk.is_experience
      `,
      [categoryIds]
    )
    const nonEmptySet = new Set(nonEmptyRows.map((r) => r.category_id))
    catRows = rawRows.filter((r) => nonEmptySet.has(r.category_id))
  }

  const categories = catRows.map(_formatCategory)

  
  const groupMap = new Map()
  for (const r of catRows) {
    const key = r.product_kind
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        productKind: key,
        kindSortOrder: r.kind_sort_order != null ? Number(r.kind_sort_order) : 0,
        items: [],
      })
    }
    groupMap.get(key).items.push(_formatCategory(r))
  }
  const groupedCategories = Array.from(groupMap.values())

  let skuList = []
  if (categories.length > 0) {
    skuList = await _queryFormattedSkuList(categories[0].id, null, { excludeCards: true })
  }

  const mallBundleGroups = await _queryMallBundleGroups()

  
  
  const experienceSkus = await _queryExperienceSkus()

  ctx.result = { categories, groupedCategories, skuList, mallBundleGroups, experienceSkus }
}


async function categories(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const payload = (ctx.event && ctx.event.payload) || {}
  const kindNotIn = Array.isArray(payload.kindNotIn) && payload.kindNotIn.length > 0 ? payload.kindNotIn : null
  const rows = await _queryCategoryRows(kindNotIn ? { kindNotIn } : {})
  ctx.result = rows.map(_formatCategory)
}


async function skuList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { categoryId, productKind, excludeCards } = ctx.event.payload || {}
  ctx.result = await _queryFormattedSkuList(categoryId, productKind, { excludeCards: !!excludeCards })
}


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
    WHERE sk.sku_id = $1 AND sk.deleted_at IS NULL
  `, [skuId])

  if (rows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
  }

  ctx.result = { sku: rows[0] }
}


async function promotionList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  ctx.result = { schemes: [] }
}

async function promotionPlans(ctx) {
  await requireStaffBound()(ctx, async () => {})
  ctx.result = []
}

module.exports = { shopInit, categories, skuList, skuDetail, promotionList, promotionPlans }



Object.defineProperty(module.exports, '__testables__', {
  enumerable: false,
  value: { _queryCategoryRows },
})
