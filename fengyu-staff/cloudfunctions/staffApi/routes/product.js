/**
 * 商品模块路由（员工端）
 * product.shopInit — 开单页初始化（合并接口）
 * product.categories — 品项分类列表
 * product.skuList — SKU 列表（按品项分类）
 * product.skuDetail — SKU 详情
 *
 * SKU 直接绑定品项分类（product_skus → product_categories），无 products 中间层。
 * 商城商品查询通过 products → mall_product_skus → product_skus。
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

// ===== 公共查询辅助 =====

function marketScopeValues(scopeExpr) {
  return `string_to_array(replace(${scopeExpr}, ' ', ''), ',')`
}

/**
 * SKU 可见范围过滤（product_skus.market_scope）。
 *
 * admin 保存的是逗号分隔的市场 org_nodes.id；历史数据可能是市场名。
 * staff 门店模式优先使用 effectiveStoreId；管理层模式用 scopeStoreIds 展开的门店集合。
 *
 * 语义约定（2026-08-06 修复）：
 * - NULL = 全部市场可见
 * - '' (空字符串) = 不可见于任何市场
 * - 'id1,id2' = 仅指定市场可见
 */
function buildSkuMarketScopeFilter(auth, params, skuAlias = 'sk') {
  const scopeExpr = `${skuAlias}.market_scope`
  const valuesExpr = marketScopeValues(scopeExpr)
  const globalExpr = `${scopeExpr} IS NULL`
  const storeIds = []

  if (auth?.effectiveStoreId) {
    storeIds.push(auth.effectiveStoreId)
  } else if (Array.isArray(auth?.scopeStoreIds)) {
    storeIds.push(...auth.scopeStoreIds.filter(Boolean))
  } else if (auth?.storeId) {
    storeIds.push(auth.storeId)
  }

  const uniqueStoreIds = [...new Set(storeIds)]
  const marketName = auth?.marketName || null

  if (uniqueStoreIds.length > 0) {
    params.push(uniqueStoreIds)
    const storeParam = `$${params.length}`
    return `AND (
      ${globalExpr}
      OR EXISTS (
        SELECT 1
        FROM stores s
        JOIN org_nodes sn ON s.org_node_id = sn.id
        JOIN org_nodes pm ON sn.parent_id = pm.id
        WHERE s.store_id = ANY(${storeParam})
          AND (
            pm.id = ANY(${valuesExpr})
            OR replace(pm.name, ' ', '') = ANY(${valuesExpr})
          )
      )
    )`
  }

  if (marketName) {
    params.push(marketName)
    return `AND (${globalExpr} OR replace($${params.length}, ' ', '') = ANY(${valuesExpr}))`
  }

  return `AND ${globalExpr}`
}

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

/** 行映射：DB row → 前端 SKU 形状。
 *
 * 抽出独立 helper 以便 shopInit 的 experienceSkus 查询直接复用同一字段映射，
 * 避免两处字符串字面量漂移。
 */
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
    purchaseLimit: sk.purchase_limit != null ? Number(sk.purchase_limit) : null,
    productType: sk.product_type,
    serviceFee: Number(sk.service_fee) || 0,
    isShengmei: sk.is_shengmei,
    isExperience: !!sk.is_experience,
    isManagerSpecial: !!sk.is_manager_special,
  }
}

/** 查询 SKU 列表并格式化为前端格式（直接查 product_skus JOIN product_categories）
 * 卡类 capability 列下发：is_experience 透传给前端，"普通商品"过滤按 SKU capability 判定。
 * 充值卡已剥离 SKU 化（2026-05-20），不再用 is_recharge_card 过滤。
 *
 * @param {string|null} categoryId
 * @param {string|null} productKind
 * @param {Object} [opts]
 * @param {boolean} [opts.excludeCards=false] true 时 WHERE 排除 is_experience SKU（体验卡）
 */
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
           sk.service_fee, sk.is_shengmei, sk.purchase_limit,
           sk.is_experience, sk.is_manager_special,
           pc.category_name, pc.product_kind, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    ${whereClause}
    ORDER BY sk.sort_order ASC
  `, params)

  return skuRows.map(_formatSkuRow)
}

/** 全量启用的体验卡 SKU 列表（不受 shopInit 分类 EXISTS 过滤影响）
 *
 * staff 开单页"体验卡 Tab"展示用：admin 端 getProductsByKind('体验卡') 走
 * SKU 级 capability eq(is_experience,true) 直查；staff 端原先把体验卡硬塞进
 * "分类侧边栏 + SKU"通用容器导致空列表（shopInit 的 NOT is_experience
 * EXISTS 过滤会把仅含体验卡 SKU 的分类整行过滤掉）。
 *
 * 体验卡按业务约定不会出现在 bundle 组合里。
 */
async function _queryExperienceSkus(auth) {
  const params = []
  const marketScopeFilter = buildSkuMarketScopeFilter(auth, params)

  const rows = await pg.query(`
    SELECT sk.sku_id, sk.category_id, sk.product_type, sk.spec_name,
           sk.price, sk.special_price, sk.session_count, sk.sort_order,
           sk.service_fee, sk.is_shengmei, sk.purchase_limit,
           sk.is_experience, sk.is_manager_special,
           pc.category_name, pc.product_kind, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.is_experience = true
      AND sk.is_enabled = true
      AND sk.deleted_at IS NULL
      ${marketScopeFilter}
    ORDER BY sk.sort_order ASC
  `, params)
  return rows.map(_formatSkuRow)
}

/**
 * 查询套餐商品（bundle SPU）及其 N 选 M 分组
 *
 * 返回结构（每个 group 内嵌完整 SKU 详情，前端无需外部 skuMap 查询）：
 *   [{ productId, name, coverImage, price, specialPrice, description,
 *      groups: [{ id, groupName, pickCount,
 *                 skus: [{ skuId, specName, sessionCount, productType,
 *                          isShengmei, bundlePrice, listPrice, listSpecialPrice,
 *                          sortOrder }] }] }]
 *
 * 供前端 BundlePicker 子视图使用（Step 1 选"组合套餐"商品类型时）。
 * 与 client `product.spuDetail`、admin `getProductsByKind('__bundle__')` 数据形态对齐。
 */
async function _queryMallBundleGroups() {
  const productRows = await pg.query(`
    SELECT p.product_id, p.name, p.cover_image, p.description,
           p.price, p.special_price, p.sort_order
    FROM products p
    WHERE p.is_bundle = true
      AND p.deleted_at IS NULL
      -- 开单页无视 is_visible（客户端展示开关只应影响 client 商城，开单端与普通商品/体验卡口径一致）
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
           sk.spec_name, sk.session_count, sk.purchase_limit,
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
            purchaseLimit: s.purchase_limit != null ? Number(s.purchase_limit) : null,
            productType: s.product_type,
            isShengmei: !!s.is_shengmei,
            // 成交价（组会员价 ?? 标价）/ 标价单价（划线）：套餐下沉副本优先，缺失回退 SKU 原价
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

// ===== 路由处理器 =====

/**
 * 开单页初始化（合并接口）
 * 一次返回 categories + 第一个分类的 skuList + 套餐分组 + groupedCategories
 *
 * PR-B：
 *   - 侧边栏分类只下发"非卡类"，体验卡在前端有独立 Tab 流；充值卡已剥离商品域（2026-05-20）
 *   - 卡类判定走 SKU 级 `product_skus.is_experience` capability 列；
 *     即一个分类只要存在非体验卡（NOT is_experience）的可售非 bundle SKU 就保留
 *   - EXISTS 过滤：分类下必须存在 is_enabled=true 且非 bundle 的非体验卡 SKU，避免出现空分类
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

  // EXISTS 过滤：分类下必须存在 is_enabled=true 的非卡类 SKU
  // 注：不再因「SKU 进过套餐」而排除——SKU 既可单卖也可进套餐，二者互不影响
  // （2026-05-26 决策：彻底取消套餐排除）。仅含套餐 SKU 的分类也会出现在普通侧边栏。
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
    skuList = await _queryFormattedSkuList(categories[0].id, null, { excludeCards: true })
  }

  const mallBundleGroups = await _queryMallBundleGroups()

  // 体验卡 Tab 走扁平 SKU 列表，不依赖分类元数据；
  // 与 admin getProductsByKind('体验卡') 用 SKU 级 capability 判定保持一致。
  const experienceSkus = await _queryExperienceSkus(ctx.auth)

  ctx.result = { categories, groupedCategories, skuList, mallBundleGroups, experienceSkus }
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
 *
 * payload.excludeCards 透传到底层查询：true 时排除 is_experience SKU（体验卡）。
 * 默认 false 以保持向后兼容（其他调用方未传则行为不变）。
 */
async function skuList(ctx) {
  await requireStaffBound()(ctx, async () => {})
  const { categoryId, productKind, excludeCards } = ctx.event.payload || {}
  ctx.result = await _queryFormattedSkuList(categoryId, productKind, { excludeCards: !!excludeCards })
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
      sk.service_fee, sk.is_shengmei, sk.market_scope, sk.purchase_limit,
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

module.exports = { shopInit, categories, skuList, skuDetail, promotionList, promotionPlans }

// 测试专用导出：用 Object.defineProperty 以非枚举挂载，避免被 index.test.js 的
// "路由完整性" 扫描（Object.keys）检出为未注册路由。
Object.defineProperty(module.exports, '__testables__', {
  enumerable: false,
  value: { _queryCategoryRows },
})
