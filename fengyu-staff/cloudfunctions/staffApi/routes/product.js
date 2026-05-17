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

/**
 * 查询品项分类列表
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.kindIn]       仅返回 product_kind ∈ kindIn 的二级行
 * @param {string[]} [opts.kindNotIn]    仅返回 product_kind ∉ kindNotIn 的二级行
 * @param {boolean}  [opts.withParentJoin=false]
 *                                        为 true 时 JOIN 一级行（`parent.product_kind IS NULL
 *                                        AND parent.category_name = child.product_kind`）附带出
 *                                        `kind_name` 与 `kind_sort_order`；按
 *                                        (parent.sort_order, child.sort_order) 排序。
 *                                        同时强制只返回二级行（`child.product_kind IS NOT NULL`）。
 *
 * 无参调用保留"全量行为"（含一级行+二级行，按 sort_order 排序），
 * 保持 `categories` action 的历史契约向后兼容。
 *
 * 任何"取二级分类"语义的调用都应显式传 `kindIn` / `kindNotIn` 或 `withParentJoin=true`，
 * 避免把一级行误当作二级分类下发给客户端。
 */
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
    // 显式仅返回二级行（parent.product_kind IS NULL 限定一级行）
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

/** 查询 SKU 列表并格式化为前端格式（直接查 product_skus JOIN product_categories）
 *
 * isBundle 字段说明：SKU 本身不持有 is_bundle，bundle 信息属于 products 层。
 * 通过 mall_product_skus → products 反查是否有任一关联商品 is_bundle=true，
 * 有则标记该 SKU isBundle=true 供前端 BundlePicker 过滤使用。
 */
async function _queryFormattedSkuList(categoryId, productKind) {
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

  const whereClause = 'WHERE ' + conditions.join(' AND ')

  const skuRows = await pg.query(`
    SELECT sk.sku_id, sk.category_id, sk.product_type, sk.spec_name,
           sk.price, sk.special_price, sk.session_count, sk.sort_order,
           sk.service_fee, sk.is_shengmei,
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
    isBundle: !!sk.is_bundle,
  }))
}

/**
 * 查询套餐商品（bundle SPU）及其 N 选 M 分组
 *
 * 返回结构：
 *   [{ productId, name, coverImage, price, specialPrice, description,
 *      groups: [{ id, groupName, pickCount, skuIds:[...] }] }]
 *
 * 供前端 BundlePicker 子视图使用（Step 1 选"组合套餐"商品类型时）。
 */
async function _queryMallBundleGroups() {
  const productRows = await pg.query(`
    SELECT p.product_id, p.name, p.cover_image, p.description,
           p.price, p.special_price, p.sort_order
    FROM products p
    WHERE p.is_bundle = true
      AND p.is_enabled = true
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
    SELECT product_id, sku_id, bundle_group_id, bundle_price, sort_order
    FROM mall_product_skus
    WHERE product_id = ANY($1)
    ORDER BY sort_order ASC
  `, [productIds])

  return productRows.map(p => {
    const groups = groupRows
      .filter(g => g.product_id === p.product_id)
      .map(g => ({
        id: g.id,
        groupName: g.group_name,
        pickCount: g.pick_count,
        skuIds: skuLinkRows
          .filter(s => s.product_id === p.product_id && s.bundle_group_id === g.id)
          .map(s => s.sku_id),
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

// ===== 路由处理器 =====

/**
 * 开单页初始化（合并接口）
 * 一次返回 categories + 第一个分类的 skuList + 套餐分组 + groupedCategories
 *
 * PR-B：
 *   - 侧边栏分类只下发"非卡类"，卡类（充值卡/体验卡）在前端有独立 Tab 流
 *   - 2026-04-26 重构：卡类判定从 product_kind 字面量切换到
 *     `product_skus.is_recharge_card` / `product_skus.is_experience` capability 列；
 *     即一个分类只要存在非卡类（NOT (is_recharge_card OR is_experience)）的可售非 bundle SKU 就保留
 *   - EXISTS 过滤：分类下必须存在 is_enabled=true 且非 bundle 的非卡类 SKU，避免出现空分类
 *   - 额外返回 `groupedCategories: [{ productKind, kindSortOrder, items: Category[] }]`
 *     （按一级行 sortOrder 排序；同组内按二级 sortOrder 排序）
 *   - 保留老字段 `categories`（平铺数组）以兼容旧前端 / 其他调用方
 */
async function shopInit(ctx) {
  await requireStaffBound()(ctx, async () => {})

  // 取全部二级分类 + 一级行 JOIN（用于 groupedCategories）；卡类过滤下沉到 SKU EXISTS
  const rawRows = await _queryCategoryRows({
    withParentJoin: true,
  })

  // EXISTS 过滤：分类下必须存在 is_enabled=true 的非 bundle、非卡类 SKU
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
        AND NOT (sk.is_recharge_card OR sk.is_experience)
        AND NOT EXISTS (
          SELECT 1
          FROM mall_product_skus mps
          JOIN products p ON p.product_id = mps.product_id
          WHERE mps.sku_id = sk.sku_id AND p.is_bundle = true
        )
      `,
      [categoryIds]
    )
    const nonEmptySet = new Set(nonEmptyRows.map((r) => r.category_id))
    catRows = rawRows.filter((r) => nonEmptySet.has(r.category_id))
  }

  const categories = catRows.map(_formatCategory)

  // 分组：按 productKind 聚合（rawRows 已按 parent.sort_order, child.sort_order 排序）
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
    skuList = await _queryFormattedSkuList(categories[0].id, null)
  }

  const mallBundleGroups = await _queryMallBundleGroups()

  ctx.result = { categories, groupedCategories, skuList, mallBundleGroups }
}

/**
 * 品项分类列表
 *
 * 无参调用：保持全量行为（与历史契约一致，含一级+二级行）。
 * 可选 payload.kindNotIn：二级行且 product_kind ∉ kindNotIn；会自动带上 product_kind IS NOT NULL。
 */
async function categories(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const payload = (ctx.event && ctx.event.payload) || {}
  const kindNotIn = Array.isArray(payload.kindNotIn) && payload.kindNotIn.length > 0 ? payload.kindNotIn : null
  const rows = await _queryCategoryRows(kindNotIn ? { kindNotIn } : {})
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
    WHERE sk.sku_id = $1 AND sk.deleted_at IS NULL
  `, [skuId])

  if (rows.length === 0) {
    throw new Error('INVALID_PARAMS: 商品不存在')
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

  // PR-D：JOIN product_categories pc → 一级行 parent_pc，带出 product_kind / kind_display_color
  // 供前端 product-detail 顶部 tag 渲染（颜色 DB 驱动）
  const skuList = await pg.query(`
    SELECT sk.sku_id, sk.product_type, sk.spec_name, sk.price, sk.special_price,
           sk.session_count, sk.sort_order, sk.service_fee,
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
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
    ORDER BY COALESCE(bg.sort_order, 0) ASC, mps.sort_order ASC
  `, [spuId])

  // PR-D：从 SKU 行聚合出 spu 级 productKind / kindDisplayColor
  // 取首个非空 product_kind 作为该 SPU 的 kind 标签（一个 SPU 通常只属一个 kind）
  const firstKindSku = skuList.find(s => s.product_kind)
  const productKind = firstKindSku ? firstKindSku.product_kind : null
  const kindDisplayColor = firstKindSku ? (firstKindSku.kind_display_color || null) : null

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
      productKind,
      kindDisplayColor,
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

// 测试专用导出：用 Object.defineProperty 以非枚举挂载，避免被 index.test.js 的
// "路由完整性" 扫描（Object.keys）检出为未注册路由。
Object.defineProperty(module.exports, '__testables__', {
  enumerable: false,
  value: { _queryCategoryRows },
})
